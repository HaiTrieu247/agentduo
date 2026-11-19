// Independent T3 acceptance tests. QA owns this file; dev owns documents.test.ts and document-links.test.ts (R19).
// These tests exercise the public service API and actual file bytes; OS errors are injected, never inferred from chmod.
import { existsSync, lstatSync, mkdirSync, promises as fs, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@agentduo/engine/testing/tmp";
import type { TimelineItem } from "@agentduo/host/viewState";
import { DocumentService, type FileOps, type FormatCodec } from "../src/main/documents.js";
import { DOCUMENT_REVISION, type DocumentInfo, type DocumentOpened, type DocumentErrorCode } from "../src/shared/documents.js";
import type { DesktopEvent } from "../src/shared/protocol.js";

const P = "0123456789abcdef";
const C = "20261118-120000-tab-abcd1234";
const OTHER = "20261118-120001-tab-abcd5678";
type Links = Extract<DesktopEvent, { type: "documentLinks" }>;
let scratch: ReturnType<typeof tempDir>;
let root: string;
let events: DesktopEvent[];
beforeEach(() => {
  scratch = tempDir();
  root = realpathSync.native(scratch.path);
  events = [];
});
afterEach(() => scratch.cleanup());

function file(name: string, bytes: string | Buffer): string {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}
const service = (ops: Partial<FileOps> = {}, extra: Partial<ConstructorParameters<typeof DocumentService>[0]> = {}) =>
  new DocumentService({ post: (e) => events.push(e), ops, ...extra });
const pm = (text: string): TimelineItem => ({ id: "pm-qa", kind: "pm", text });
function sync(s: DocumentService, text: string, view = 1, conversationId = C, fresh = true): Links {
  const start = events.length;
  s.syncLinks(P, conversationId, view, [pm(text)], fresh);
  const result = events.slice(start).find((e): e is Links => e.type === "documentLinks");
  expect(result, "a fresh snapshot grants a desktop link mapping").toBeDefined();
  return result!;
}
function open(s: DocumentService, href: string, workspace: string | null = root): Promise<DocumentOpened> {
  const { links } = sync(s, `[open](<${href}>)`);
  expect(links, `registered link: ${href}`).toHaveLength(1);
  return s.open({ projectId: P, conversationId: C, view: 1, linkId: links[0]!.linkId, workspace });
}
function document(result: DocumentOpened): DocumentInfo {
  expect(result, result.ok ? "the registered file opens" : result.error.message).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.error.message);
  expect(result.document.revision).toMatch(DOCUMENT_REVISION);
  return result.document;
}
function error(result: { ok: boolean; error?: { message: string } }, code: DocumentErrorCode): void {
  expect(result).toMatchObject({ ok: false, error: { code, message: expect.any(String) } });
  expect(result.error!.message.trim().length).toBeGreaterThan(10);
}
const ioError = (code: string) => Object.assign(new Error(`QA injected ${code}`), { code });

describe("T3 QA — exact destination from chat to disk (AC1, AC3, AC4; R27–R29)", () => {
  it.each(["relative", "absolute", "file URL"] as const)("opens and saves the %s target while preserving both same-name decoys", async (kind) => {
    const workspace = file("workspace/notes.md", "workspace copy");
    const worktree = file("team/worktree/notes.md", "worktree copy");
    const attachment = file("attachments/notes.md", "attachment copy");
    const paths = [workspace, worktree, attachment];
    const index = kind === "relative" ? 0 : kind === "absolute" ? 1 : 2;
    const href = kind === "relative" ? "notes.md" : kind === "absolute" ? worktree : pathToFileURL(attachment).href;
    const before = paths.map((p) => readFileSync(p));
    const s = service();
    const d = document(await open(s, href, dirname(workspace)));
    expect(d.text).toBe(before[index]!.toString("utf8"));
    expect(d.location).toBe(realpathSync.native(paths[index]!));
    s.setDirty(d.documentId, true);
    expect(paths.map((p) => readFileSync(p))).toEqual(before);
    const saved = await s.save(d.documentId, d.revision, "# Saved\n\n**bold** and *italic*.\n", false);
    expect(saved).toMatchObject({ ok: true });
    paths.forEach((p, i) => expect(readFileSync(p)).toEqual(i === index ? Buffer.from("# Saved\n\n**bold** and *italic*.\n") : before[i]));
    s.close(d.documentId);
    expect(document(await open(s, href, dirname(workspace))).text).toBe("# Saved\n\n**bold** and *italic*.\n");
  });

  it.each([
    ["spaces", "my notes.md", "[open](<my notes.md>)"],
    ["Unicode", "Tài liệu ✓.md", "[open](<Tài liệu ✓.md>)"],
    ["encoded Unicode", "Tài liệu ✓.md", "[open](T%C3%A0i%20li%E1%BB%87u%20%E2%9C%93.md)"],
    ["balanced parentheses", "plan(1).md", "[open](plan(1).md)"],
    ["escaped parentheses", "plan(1).md", "[open](plan\\(1\\).md)"],
    ["one decoding", "a%20b.md", "[open](a%2520b.md)"],
    ["encoded hash", "section#one.md", "[open](section%23one.md#L9C2)"],
    ["literal percent", "100%.md", "[open](100%.md)"],
    ["link title", "title.md", '[open](title.md "a title")'],
  ])("registers the same target the user sees: %s", async (_label, name, markdown) => {
    const target = file(name, `# ${name}\n`);
    const s = service();
    // A web link comes first: the ordinal is among all rendered links, not just Markdown files.
    const mapping = sync(s, `[web](https://example.test) ${markdown} and \`[ignored](ignored.md)\``);
    expect(mapping.links).toEqual([{ linkId: expect.any(String), itemId: "pm-qa", part: "text", ordinal: 1 }]);
    expect(mapping.links[0]).not.toHaveProperty("href");
    const d = document(await s.open({ projectId: P, conversationId: C, view: 1, linkId: mapping.links[0]!.linkId, workspace: root }));
    expect(d.location).toBe(target);
    expect(d.text).toBe(`# ${name}\n`);
    if (name.includes("#")) expect(d.position).toEqual({ line: 9, column: 2 });
  });

  it("opens a URL with spaces, query and a heading fragment without treating those as filename text", async () => {
    const target = file("space dir/Đề xuất.md", "# Đề xuất\n");
    const d = document(await open(service(), `${pathToFileURL(target).href}?view=1#%C4%91%E1%BB%81-xu%E1%BA%A5t`));
    expect(d.location).toBe(target);
    expect(d.anchor).toBe("đề-xuất");
  });

  it("reports the missing absolute target instead of opening a same-name workspace file", async () => {
    file("workspace/missing.md", "must never open this");
    const missing = join(root, "worktree", "missing.md");
    const result = await open(service(), missing, join(root, "workspace"));
    error(result, "not-found");
    expect(readFileSync(join(root, "workspace", "missing.md"), "utf8")).toBe("must never open this");
  });

  it("does not guess a relative target when a conversation has no workspace", async () => {
    file("notes.md", "not a global default");
    error(await open(service(), "notes.md", null), "link-unresolved");
  });

  it.skipIf(process.platform === "win32")("resolves symlink/.. through the filesystem and preserves the symlink on save", async () => {
    const decoy = file("workspace/note.md", "workspace");
    const target = file("outside/note.md", "outside");
    mkdirSync(join(root, "outside", "child"));
    const link = join(root, "workspace", "branch");
    symlinkSync(join(root, "outside", "child"), link, "dir");
    const s = service();
    const d = document(await open(s, "branch/../note.md", dirname(decoy)));
    expect(d.location).toBe(target);
    expect(d.text).toBe("outside");
    expect(await s.save(d.documentId, d.revision, "outside edited", false)).toMatchObject({ ok: true });
    expect(readFileSync(target, "utf8")).toBe("outside edited");
    expect(readFileSync(decoy, "utf8")).toBe("workspace");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it.skipIf(process.platform === "win32")("keeps a file symlink intact and refuses a .md symlink to an unsupported type", async () => {
    const target = file("actual/notes.md", "original");
    const link = join(root, "linked.md");
    symlinkSync(target, link, "file");
    const s = service();
    const d = document(await open(s, link));
    expect(await s.save(d.documentId, d.revision, "edited", false)).toMatchObject({ ok: true });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("edited");
    symlinkSync(file("secret.txt", "private"), join(root, "disguised.md"), "file");
    error(await open(s, join(root, "disguised.md")), "format-unsupported");
  });

  it("handles a native Windows absolute path and file URL without a workspace fallback", async () => {
    const target = file("native notes.md", "native destination");
    const s = service();
    for (const href of [target, pathToFileURL(target).href]) expect(document(await open(s, href, null)).text).toBe("native destination");
    if (process.platform !== "win32") error(await open(s, "C:\\QA Files\\notes.md", null), "not-found");
  });
});

describe("T3 QA — lossless bytes, revisions and recoverable errors (AC3–AC5, AC7)", () => {
  it("opening, dirty notifications and reload cause no filesystem write", async () => {
    const target = file("source.md", "# original\r\n");
    const writes: string[] = [];
    const s = service({
      open: async (p, flags, mode) => {
        if (flags !== "r") writes.push(String(flags));
        return fs.open(p, flags, mode);
      },
      rename: async (...args) => { writes.push("rename"); return fs.rename(...args); },
      chmod: async (...args) => { writes.push("chmod"); return fs.chmod(...args); },
      rm: async (...args) => { writes.push("rm"); return fs.rm(...args); },
    });
    const d = document(await open(s, target));
    s.setDirty(d.documentId, true);
    document(await s.reload(d.documentId));
    s.setDirty(d.documentId, false);
    expect(writes).toEqual([]);
    expect(readFileSync(target, "utf8")).toBe("# original\r\n");
  });

  it("saves unchanged Markdown bytes exactly, including unknown constructs, BOM, CRLF and no final newline", async () => {
    const original = "\ufeff---\r\nname: sample\r\n---\r\n\r\n# Heading\r\n\r\n- **bold** *italic* [link](target.md)\r\n\r\n```ts\r\nconst a = 1;\r\n```\r\n\r\n<div>raw</div>\r\n\r\n[^x]: footnote\r\n\r\n[ref]: <a b.md>\r\n\r\n|a|b|\r\n|-|-|\r\n|1|2|";
    const target = file("exact.md", original);
    const before = readFileSync(target);
    const s = service();
    const d = document(await open(s, target));
    expect(d.text).toBe(original);
    expect(await s.save(d.documentId, d.revision, d.text, false)).toMatchObject({ ok: true, revision: d.revision });
    expect(readFileSync(target)).toEqual(before);
  });

  it("enforces the byte limit for multibyte edits and allows a same-session retry", async () => {
    const target = file("small.md", "base");
    const s = service({}, { formats: [{ id: "markdown", label: "Markdown", extensions: [".md"], maxBytes: 8 }] });
    const d = document(await open(s, target));
    error(await s.save(d.documentId, d.revision, "€€€", false), "save-failed");
    expect(readFileSync(target, "utf8")).toBe("base");
    expect(await s.save(d.documentId, d.revision, "€€ab", false)).toMatchObject({ ok: true });
    expect(readFileSync(target, "utf8")).toBe("€€ab");
  });

  it.each([Buffer.from([0xff, 0xfe]), Buffer.from("a\0b")])("refuses non-UTF-8 or NUL-containing input without changing its bytes (%j)", async (bytes) => {
    const target = file("invalid.md", bytes);
    error(await open(service(), target), "not-text");
    expect(readFileSync(target)).toEqual(bytes);
  });

  it("reports unreadable and read-only files deterministically on every OS", async () => {
    const target = file("locked.md", "kept");
    const unreadable = service({ open: async () => { throw ioError("EACCES"); } });
    error(await open(unreadable, target), "unreadable");
    const readonly = service({ access: async () => { throw ioError("EACCES"); } });
    const d = document(await open(readonly, target));
    expect(d.save).toMatchObject({ allowed: false, reason: expect.any(String) });
    error(await readonly.save(d.documentId, d.revision, "edit", false), "save-failed");
    expect(readFileSync(target, "utf8")).toBe("kept");
  });

  it("refuses a directory and an oversized input, including a multibyte boundary", async () => {
    const dir = join(root, "folder.md");
    mkdirSync(dir);
    const s = service({}, { formats: [{ id: "markdown", label: "Markdown", extensions: [".md"], maxBytes: 6 }] });
    error(await open(s, dir), "not-a-file");
    const exact = file("exact.md", "€€");
    const large = file("large.md", "€€a");
    expect(document(await open(s, exact)).text).toBe("€€");
    error(await open(s, large), "too-large");
    expect(readFileSync(large, "utf8")).toBe("€€a");
  });

  it("refuses an external edit, retains its session and revision, and permits retry after reload", async () => {
    const target = file("conflict.md", "base");
    const s = service();
    const d = document(await open(s, target));
    writeFileSync(target, "external");
    error(await s.save(d.documentId, d.revision, "my edit", false), "changed-on-disk");
    expect(readFileSync(target, "utf8")).toBe("external");
    const reloaded = document(await s.reload(d.documentId));
    expect(reloaded.documentId).toBe(d.documentId);
    expect(reloaded.revision).not.toBe(d.revision);
    expect(reloaded.text).toBe("external");
    error(await s.save(d.documentId, d.revision, "stale", false), "changed-on-disk");
    expect(await s.save(d.documentId, reloaded.revision, "my edit", false)).toMatchObject({ ok: true });
    expect(readFileSync(target, "utf8")).toBe("my edit");
  });

  it("refuses a replacement file even when its content matches the opened revision", async () => {
    const target = file("replaced.md", "same content");
    const replacement = file("replacement.md", "same content");
    const s = service();
    const d = document(await open(s, target));
    // Move the original away first: this is a real, distinct file identity on Windows too.
    renameSync(target, join(root, "original.md"));
    renameSync(replacement, target);
    error(await s.save(d.documentId, d.revision, "my edit", false), "changed-on-disk");
    expect(readFileSync(target, "utf8")).toBe("same content");
    expect(document(await s.reload(d.documentId)).documentId).toBe(d.documentId);
  });

  it("never recreates a deleted file, even on an explicit overwrite request", async () => {
    const target = file("gone.md", "base");
    const s = service();
    const d = document(await open(s, target));
    rmSync(target);
    error(await s.save(d.documentId, d.revision, "edit", true), "not-found");
    expect(existsSync(target)).toBe(false);
    // The failed save leaves the document session available; a restored original can be read again.
    writeFileSync(target, "base");
    expect(document(await s.reload(d.documentId)).documentId).toBe(d.documentId);
  });

  it.each(["partial-write", "flush", "rename"] as const)("a %s failure leaves the complete original and allows retry with the same document ID", async (stage) => {
    const target = file("failure.md", "ORIGINAL full contents\n");
    let fail = true;
    let injected = false;
    const s = service({
      open: async (path, flags, mode) => {
        const handle = await fs.open(path, flags, mode);
        if (flags === "wx" && fail && stage === "partial-write") {
          const write = handle.write.bind(handle);
          const partialFailure = async () => {
            await write(Buffer.from("PARTIAL"), 0, 7, 0);
            injected = true;
            throw ioError("ENOSPC");
          };
          handle.writeFile = partialFailure;
          handle.write = partialFailure;
        }
        if (flags === "wx" && fail && stage === "flush") handle.sync = async () => { injected = true; throw ioError("EIO"); };
        return handle;
      },
      rename: async (from, to) => {
        if (fail && stage === "rename") { injected = true; throw ioError("EBUSY"); }
        return fs.rename(from, to);
      },
    });
    const d = document(await open(s, target));
    const before = readdirSync(root).sort();
    error(await s.save(d.documentId, d.revision, "short", false), "save-failed");
    expect(injected).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("ORIGINAL full contents\n");
    expect(readdirSync(root).sort()).toEqual(before);
    fail = false;
    expect(await s.save(d.documentId, d.revision, "short", false)).toMatchObject({ ok: true });
    expect(readFileSync(target, "utf8")).toBe("short");
  });

  it("handles a successful short OS write in the in-place fallback without reporting a corrupt save as success", async () => {
    const target = file("short-write.md", "ORIGINAL old contents");
    let shortWrites = 0;
    const s = service({
      open: async (path, flags, mode) => {
        if (flags === "wx") throw ioError("EACCES");
        const handle = await fs.open(path, flags, mode);
        if (flags === "r+") {
          const write = handle.write.bind(handle);
          // A successful write may write fewer bytes than requested. Complete subsequent writes normally.
          handle.write = (async (buffer: Buffer, offset: number, length: number, position: number) => {
            if (shortWrites++ === 0) return write(buffer, offset, Math.min(2, length), position);
            return write(buffer, offset, length, position);
          }) as typeof handle.write;
        }
        return handle;
      },
    });
    const d = document(await open(s, target));
    const result = await s.save(d.documentId, d.revision, "replacement text", false);
    expect(shortWrites).toBeGreaterThan(0);
    if (result.ok) expect(readFileSync(target, "utf8")).toBe("replacement text");
    else {
      error(result, "save-failed");
      expect(readFileSync(target, "utf8")).toBe("ORIGINAL old contents");
    }
  });

  it("restores the whole original after a partial in-place write fails, then retries without reopening", async () => {
    const target = file("in-place.md", "ORIGINAL full contents");
    let fail = true;
    let injected = false;
    const s = service({
      open: async (path, flags, mode) => {
        if (flags === "wx") throw ioError("EACCES");
        const handle = await fs.open(path, flags, mode);
        if (flags === "r+" && fail) {
          const write = handle.write.bind(handle);
          handle.write = (async (buffer: Buffer, offset: number, length: number, position: number) => {
            if (!injected) {
              injected = true;
              await write(buffer, offset, Math.min(2, length), position);
              throw ioError("EIO");
            }
            return write(buffer, offset, length, position);
          }) as typeof handle.write;
        }
        return handle;
      },
    });
    const d = document(await open(s, target));
    error(await s.save(d.documentId, d.revision, "short", false), "save-failed");
    expect(injected).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("ORIGINAL full contents");
    fail = false;
    expect(await s.save(d.documentId, d.revision, "short", false)).toMatchObject({ ok: true });
    expect(readFileSync(target, "utf8")).toBe("short");
  });

  it("does not overwrite an external edit made after the save starts but before it publishes the temporary file", async () => {
    const target = file("racing-edit.md", "base");
    let changed = false;
    const s = service({
      open: async (path, flags, mode) => {
        const handle = await fs.open(path, flags, mode);
        if (flags === "wx") {
          const write = handle.write.bind(handle);
          handle.write = (async (buffer: Buffer, offset: number, length: number, position: number) => {
            const result = await write(buffer, offset, length, position);
            if (!changed) {
              changed = true;
              writeFileSync(target, "external during save");
            }
            return result;
          }) as typeof handle.write;
          const writeFile = handle.writeFile.bind(handle);
          handle.writeFile = async (...args) => {
            await writeFile(...args);
            if (!changed) {
              changed = true;
              writeFileSync(target, "external during save");
            }
          };
        }
        return handle;
      },
    });
    const d = document(await open(s, target));
    error(await s.save(d.documentId, d.revision, "my edit", false), "changed-on-disk");
    expect(changed).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("external during save");
    expect(document(await s.reload(d.documentId)).text).toBe("external during save");
  });
});

describe("T3 QA — grants, session lifetime and concurrent calls (AC1, AC4, AC7, AC8)", () => {
  it("rejects forged, other-conversation and previous-view link IDs and preserves an open session after revocation", async () => {
    const target = file("grants.md", "base");
    const s = service();
    const first = sync(s, `[open](<${target}>)`).links[0]!.linkId;
    const request = { projectId: P, conversationId: C, view: 1, linkId: first, workspace: root };
    for (const overrides of [{ linkId: "k999999" }, { conversationId: OTHER }, { projectId: "ffffffffffffffff" }, { view: 2 }]) {
      error(await s.open({ ...request, ...overrides }), "link-stale");
    }
    const d = document(await s.open(request));
    s.setDirty(d.documentId, true);
    s.revokeConversation(P, C);
    error(await s.open(request), "link-stale");
    expect(await s.save(d.documentId, d.revision, "still editing", false)).toMatchObject({ ok: true });
    s.close(d.documentId);
    error(await s.save(d.documentId, d.revision, "closed", true), "session-unknown");
    error(await s.reload(d.documentId), "session-unknown");
    error(await s.save("d999999", d.revision, "forged", true), "session-unknown");
    expect(readFileSync(target, "utf8")).toBe("still editing");
  });

  it("keeps only one session when two clicks open the same real file concurrently", async () => {
    const target = file("double-click.md", "base");
    const s = service();
    const linkId = sync(s, `[open](<${target}>)`).links[0]!.linkId;
    const request = { projectId: P, conversationId: C, view: 1, linkId, workspace: root };
    const [a, b] = await Promise.all([s.open(request), s.open(request)]);
    expect(document(a).documentId).toBe(document(b).documentId);
    expect([a.ok && a.existing, b.ok && b.existing].sort()).toEqual([false, true]);
  });

  it("serializes simultaneous saves so exactly one edit based on the same revision succeeds", async () => {
    const target = file("two-saves.md", "base");
    const s = service();
    const d = document(await open(s, target));
    const results = await Promise.all([
      s.save(d.documentId, d.revision, "first edit", false),
      s.save(d.documentId, d.revision, "second edit", false),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    error(results.find((r) => !r.ok)!, "changed-on-disk");
    const final = document(await s.reload(d.documentId));
    expect(final.text).toBe(readFileSync(target, "utf8"));
    expect(["first edit", "second edit"]).toContain(final.text);
  });

  it("uses an injected format codec through the same link/open/save requests", async () => {
    const codec: FormatCodec = {
      id: "qa-text",
      decode: (bytes) => Buffer.from(bytes).toString("utf8"),
      encode: (text) => Buffer.from(text, "utf8"),
    };
    const target = file("extension.qa", "first");
    const s = service({}, {
      formats: [{ id: "qa-text", label: "QA extension", extensions: [".qa"], maxBytes: 32 }], codecs: [codec],
    });
    const d = document(await open(s, target));
    expect(d.format).toBe("qa-text");
    expect(await s.save(d.documentId, d.revision, "second", false)).toMatchObject({ ok: true });
    expect(readFileSync(target, "utf8")).toBe("second");
  });
});
