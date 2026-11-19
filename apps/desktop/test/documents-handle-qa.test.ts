// QA owns this file (R19). Independent AC7/R30/R31 checks of write handles and rollback boundaries.
// FileOps injects exact filesystem results, so the failure cases do not depend on OS permission bits or timing.
import { promises as fs, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@agentduo/engine/testing/tmp";
import { DocumentService, type FileOps } from "../src/main/documents.js";
import type { DocumentInfo } from "../src/shared/documents.js";
import type { DesktopEvent } from "../src/shared/protocol.js";

const P = "0123456789abcdef";
const C = "20261118-120000-tab-abcd1234";
let scratch: ReturnType<typeof tempDir>;
let root: string;
beforeEach(() => {
  scratch = tempDir();
  root = realpathSync.native(scratch.path);
});
afterEach(() => scratch.cleanup());
const ioError = (code: string) => Object.assign(new Error(`QA injected ${code}`), { code });
function file(name: string, text: string): string {
  const path = join(root, name);
  writeFileSync(path, text);
  return path;
}
function service(ops: Partial<FileOps>, maxBytes = 1024) {
  const events: DesktopEvent[] = [];
  const s = new DocumentService({
    ops, post: (e) => events.push(e),
    formats: [{ id: "markdown", label: "Markdown", extensions: [".md"], maxBytes }],
  });
  return {
    s,
    async open(path: string): Promise<DocumentInfo> {
      s.syncLinks(P, C, 1, [{ id: "pm-handle", kind: "pm", text: `[open](<${path}>)` }], true);
      const mapping = events.find((e) => e.type === "documentLinks");
      if (mapping?.type !== "documentLinks") throw new Error("missing main link mapping");
      const result = await s.open({ projectId: P, conversationId: C, view: 1, linkId: mapping.links[0]!.linkId, workspace: root });
      if (!result.ok) throw new Error(result.error.message);
      return result.document;
    },
  };
}

describe("T3 QA — the exact handle used for an in-place write (AC7, R31)", () => {
  it.each([false, true])("refuses a detached handle without writing even with overwrite=%s", async (overwrite) => {
    const target = file("target.md", "ORIGINAL");
    const detached = file("detached.md", overwrite ? "DETACHED" : "ORIGINAL");
    const targetBefore = readFileSync(target);
    const detachedBefore = readFileSync(detached);
    let writes = 0;
    let suppliedDetached = false;
    const h = service({
      open: async (path, flags, mode) => {
        if (flags === "wx") throw ioError("EACCES");
        // Model an open that obtained the file before another process moved it away.
        // The returned handle is a real second file, while stat(path) still sees target.md.
        const fh = await fs.open(flags === "r+" ? detached : path, flags, mode);
        if (flags === "r+") {
          suppliedDetached = true;
          const write = fh.write.bind(fh);
          fh.write = (async (b: Buffer, off: number, len: number, pos: number) => {
            writes++;
            return write(b, off, len, pos);
          }) as typeof fh.write;
        }
        return fh;
      },
    });
    const d = await h.open(target);
    h.s.setDirty(d.documentId, true);
    expect(await h.s.save(d.documentId, d.revision, "MY EDITS", overwrite)).toMatchObject({ ok: false, error: { code: "changed-on-disk" } });
    expect(suppliedDetached).toBe(true);
    expect(writes).toBe(0);
    expect(readFileSync(target)).toEqual(targetBefore);
    expect(readFileSync(detached)).toEqual(detachedBefore);
    expect(h.s.ids()).toEqual([d.documentId]);
    expect(h.s.isDirty(d.documentId)).toBe(true);
  });

  it("refuses a non-regular write handle before its first byte", async () => {
    const target = file("target.md", "ORIGINAL");
    let writes = 0;
    const h = service({
      open: async (path, flags, mode) => {
        if (flags === "wx") throw ioError("EACCES");
        const fh = await fs.open(path, flags, mode);
        if (flags === "r+") {
          const stat = fh.stat.bind(fh);
          fh.stat = (async () => Object.assign(Object.create(await stat()), { isFile: () => false })) as typeof fh.stat;
          const write = fh.write.bind(fh);
          fh.write = (async (b: Buffer, off: number, len: number, pos: number) => {
            writes++;
            return write(b, off, len, pos);
          }) as typeof fh.write;
        }
        return fh;
      },
    });
    const d = await h.open(target);
    expect(await h.s.save(d.documentId, d.revision, "MY EDITS", true)).toMatchObject({ ok: false, error: { code: "not-a-file" } });
    expect(writes).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("ORIGINAL");
  });

  it("a read error on the actual write handle closes it, writes nothing and permits retry", async () => {
    const target = file("target.md", "ORIGINAL");
    let fail = true;
    let writes = 0;
    let closed = 0;
    const h = service({
      open: async (path, flags, mode) => {
        if (flags === "wx") throw ioError("EACCES");
        const fh = await fs.open(path, flags, mode);
        if (flags === "r+") {
          if (fail) fh.read = (async () => { throw ioError("EIO"); }) as typeof fh.read;
          const close = fh.close.bind(fh);
          fh.close = async () => { closed++; return close(); };
          const write = fh.write.bind(fh);
          fh.write = (async (b: Buffer, off: number, len: number, pos: number) => {
            writes++;
            return write(b, off, len, pos);
          }) as typeof fh.write;
        }
        return fh;
      },
    });
    const d = await h.open(target);
    expect(await h.s.save(d.documentId, d.revision, "MY EDITS", false)).toMatchObject({ ok: false, error: { code: "unreadable" } });
    expect(writes).toBe(0);
    expect(closed).toBe(1);
    expect(readFileSync(target, "utf8")).toBe("ORIGINAL");
    fail = false;
    expect(await h.s.save(d.documentId, d.revision, "MY EDITS", false)).toMatchObject({ ok: true });
    expect(readFileSync(target, "utf8")).toBe("MY EDITS");
  });

  it("rollback restores bytes read from the write handle rather than the old session text", async () => {
    const target = file("target.md", "SESSION BASE");
    let changed = false;
    let failed = false;
    const h = service({
      open: async (path, flags, mode) => {
        if (flags === "wx") throw ioError("EACCES");
        const fh = await fs.open(path, flags, mode);
        if (flags === "r+") {
          writeFileSync(target, "EXTERNAL CURRENT CONTENT");
          changed = true;
          const write = fh.write.bind(fh);
          fh.write = (async (b: Buffer, off: number, len: number, pos: number) => {
            if (!failed) {
              failed = true;
              await write(b, off, Math.min(2, len), pos);
              throw ioError("ENOSPC");
            }
            return write(b, off, len, pos);
          }) as typeof fh.write;
        }
        return fh;
      },
    });
    const d = await h.open(target);
    expect(await h.s.save(d.documentId, d.revision, "MY EDITS", true)).toMatchObject({ ok: false, error: { code: "save-failed" } });
    expect(changed && failed).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("EXTERNAL CURRENT CONTENT");
    expect(h.s.ids()).toEqual([d.documentId]);
  });

  it("does not corrupt an oversized external file when an explicit overwrite fails in place", async () => {
    const target = file("target.md", "BASE");
    const outside = "EXTERNAL CONTENT LONGER THAN THE LIMIT";
    let failed = false;
    const h = service({
      open: async (path, flags, mode) => {
        if (flags === "wx") throw ioError("EACCES");
        const fh = await fs.open(path, flags, mode);
        if (flags === "r+") {
          const write = fh.write.bind(fh);
          fh.write = (async (b: Buffer, off: number, len: number, pos: number) => {
            if (!failed) {
              failed = true;
              await write(b, off, Math.min(2, len), pos);
              throw ioError("ENOSPC");
            }
            return write(b, off, len, pos);
          }) as typeof fh.write;
        }
        return fh;
      },
    }, 8);
    const d = await h.open(target);
    writeFileSync(target, outside);
    // Safe refusal before writing is also acceptable if a bounded backup cannot be made.
    const result = await h.s.save(d.documentId, d.revision, "EDIT", true);
    expect(result).toMatchObject({ ok: false, error: { message: expect.any(String) } });
    expect(readFileSync(target, "utf8")).toBe(outside);
    expect(h.s.ids()).toEqual([d.documentId]);
  });
});

describe("T3 QA — complete writes before atomic replacement (AC4, AC7, R30)", () => {
  it.each(["short", "zero"] as const)("handles a %s temporary-file write safely", async (kind) => {
    const target = file("target.md", "ORIGINAL");
    let calls = 0;
    const h = service({
      open: async (path, flags, mode) => {
        const fh = await fs.open(path, flags, mode);
        if (flags === "wx") {
          const write = fh.write.bind(fh);
          fh.write = (async (b: Buffer, off: number, len: number, pos: number) => {
            calls++;
            if (kind === "zero") return { bytesWritten: 0, buffer: b };
            return write(b, off, Math.min(2, len), pos);
          }) as typeof fh.write;
        }
        return fh;
      },
    });
    const d = await h.open(target);
    const before = readdirSync(root).sort();
    const result = await h.s.save(d.documentId, d.revision, "MY COMPLETE EDIT", false);
    expect(calls).toBeGreaterThan(0);
    if (kind === "short") {
      expect(result).toMatchObject({ ok: true });
      expect(readFileSync(target, "utf8")).toBe("MY COMPLETE EDIT");
    } else {
      expect(result).toMatchObject({ ok: false, error: { code: "save-failed" } });
      expect(readFileSync(target, "utf8")).toBe("ORIGINAL");
    }
    expect(readdirSync(root).sort()).toEqual(before);
  });
});
