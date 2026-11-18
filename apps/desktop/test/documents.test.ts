// The file service of "Mở" (main/documents.ts) on real files: opening the right target, saving only on request into the
// file that was opened, and every refusal keeping the session. Failures of the file system are injected through
// `FileOps`, so they are the same on every OS.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@agentduo/engine/testing/tmp";
import type { TimelineItem } from "@agentduo/host/viewState";
import { DocumentService, type FileOps, type FormatCodec } from "../src/main/documents.js";
import type { DocumentInfo, DocumentOpened } from "../src/shared/documents.js";
import type { DesktopEvent } from "../src/shared/protocol.js";

const P = "0123456789abcdef";
const C = "20261031-120000-tab-abcd1234";
const posix = process.platform !== "win32";

let t: { path: string; cleanup(): void };
let root: string;
let events: DesktopEvent[];
beforeEach(() => {
  t = tempDir();
  root = realpathSync(t.path);
  events = [];
});
afterEach(() => t.cleanup());

const service = (ops?: Partial<FileOps>, extra: Partial<ConstructorParameters<typeof DocumentService>[0]> = {}) => new DocumentService({ post: (e) => events.push(e), ops, ...extra });
const pm = (id: string, text: string): TimelineItem => ({ id, kind: "pm", text }) as TimelineItem;

/** Grants the links of one PM message and returns the id of each. */
function grant(s: DocumentService, ...hrefs: string[]): string[] {
  s.syncLinks(P, C, 1, [pm("i1", hrefs.map((h, n) => `[l${n}](<${h}>)`).join(" "))], true);
  const ev = events.filter((e) => e.type === "documentLinks").at(-1) as Extract<DesktopEvent, { type: "documentLinks" }>;
  return ev.links.sort((a, b) => a.ordinal - b.ordinal).map((l) => l.linkId);
}
const openLink = (s: DocumentService, href: string, workspace: string | null = root, view = 1) => {
  const [linkId] = grant(s, href);
  return s.open({ projectId: P, conversationId: C, view, linkId: linkId!, workspace });
};
const doc = (r: DocumentOpened): DocumentInfo => {
  if (!r.ok) throw new Error(r.error.message);
  return r.document;
};
const file = (rel: string, text: string): string => {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  return p;
};
const tmpLeft = (dir = root) => readdirSync(dir).filter((n) => n.includes("agentduo-tmp"));

describe("opening: which file", () => {
  it("opens the file the link names, not a same-named file of the workspace (absolute path, file URL, relative)", async () => {
    const ws = join(root, "ws");
    file("ws/notes.md", "workspace copy\n");
    const worktree = file("team/dev-1/notes.md", "worktree copy\n");
    const attach = file("attachments/c1/notes.md", "attachment copy\n");
    const s = service();
    expect(doc(await openLink(s, worktree, ws)).text).toBe("worktree copy\n");
    expect(doc(await openLink(s, `file://${attach}`, ws)).text).toBe("attachment copy\n");
    const rel = doc(await openLink(s, "notes.md", ws));
    expect(rel.text).toBe("workspace copy\n");
    expect(rel.location).toBe(join(realpathSync(ws), "notes.md"));
    expect(new Set(s.ids()).size).toBe(3);
  });

  it("reads spaces, Unicode, percent-encoding, a fragment and a line", async () => {
    file("ws/my notes/Tài liệu ✓.md", "# xin chào\n");
    const s = service();
    const ws = join(root, "ws");
    for (const href of ["my notes/Tài liệu ✓.md", "my%20notes/T%C3%A0i%20li%E1%BB%87u%20%E2%9C%93.md"]) {
      const d = doc(await openLink(s, href, ws));
      expect(d.text).toBe("# xin chào\n");
      expect(d.name).toBe("Tài liệu ✓.md");
    }
    const d = doc(await openLink(s, "my notes/Tài liệu ✓.md#L7", ws));
    expect(d.position).toEqual({ line: 7, column: null });
    expect(doc(await openLink(s, "my notes/Tài liệu ✓.md#intro", ws)).anchor).toBe("intro");
  });

  it("opens the same file once: the second open is the same session and keeps its text", async () => {
    const f = file("a.md", "one\n");
    const s = service();
    const a = doc(await openLink(s, f));
    const again = await openLink(s, f);
    expect(again.ok && again.existing).toBe(true);
    expect(doc(again).documentId).toBe(a.documentId);
    writeFileSync(f, "changed elsewhere\n");
    expect(doc(await openLink(s, f)).text).toBe("one\n");
  });

  it("resolves `..` after the symlink, as the file system does (two files, one behind a link)", async () => {
    if (!posix) return;
    file("outside/note.md", "outside\n");
    file("ws/note.md", "inside\n");
    mkdirSync(join(root, "outside/child"), { recursive: true });
    symlinkSync(join(root, "outside/child"), join(root, "ws/link"));
    const s = service();
    const d = doc(await openLink(s, "link/../note.md", join(root, "ws")));
    expect(d.text).toBe("outside\n");
    expect(d.location).toBe(join(root, "outside/note.md"));
  });

  it("opens a symlinked .md through to its file and keeps the link when saving", async () => {
    if (!posix) return;
    const real = file("real/doc.md", "real\n");
    const link = join(root, "ws/doc.md");
    mkdirSync(join(root, "ws"));
    symlinkSync(real, link);
    const s = service();
    const d = doc(await openLink(s, link));
    expect(d.location).toBe(real);
    expect((await s.save(d.documentId, d.revision, "edited\n", false)).ok).toBe(true);
    expect(readFileSync(real, "utf8")).toBe("edited\n");
    const st = (await import("node:fs")).lstatSync(link);
    expect(st.isSymbolicLink()).toBe(true);
    expect(readFileSync(link, "utf8")).toBe("edited\n");
  });

  it("refuses a link by its id only: made-up, old view, other conversation, revoked", async () => {
    const f = file("a.md", "x\n");
    const s = service();
    const [id] = grant(s, f);
    const call = (over: object) => s.open({ projectId: P, conversationId: C, view: 1, linkId: id!, workspace: root, ...over });
    for (const bad of [{ linkId: "k999" }, { view: 2 }, { conversationId: "other-conversation" }, { projectId: "ffffffffffffffff" }]) {
      const r = await call(bad);
      expect(r.ok ? "opened" : r.error.code).toBe("link-stale");
    }
    s.revokeConversation(P, C);
    expect((await call({})).ok).toBe(false);
    expect(s.ids()).toEqual([]);
  });

  it.each([
    ["a missing file", "missing.md", "not-found"],
    ["a folder", "dir.md", "not-a-file"],
  ])("says plainly for %s and opens nothing", async (_n, name, want) => {
    mkdirSync(join(root, "dir.md"));
    const s = service();
    const r = await openLink(s, join(root, name));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(want);
      expect(r.error.message).toContain(name.replace(".md", ""));
    }
    expect(s.ids()).toEqual([]);
  });

  it("refuses bytes that are not text, a file over the limit, and a .md that is a link to another type", async () => {
    const bad = join(root, "bad.md");
    writeFileSync(bad, Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    const nul = join(root, "nul.md");
    writeFileSync(nul, "a\u0000b");
    const big = file("big.md", "x".repeat(100));
    const s = service(undefined, { formats: [{ id: "markdown", label: "Markdown", extensions: [".md"], maxBytes: 50 }] });
    const code = async (p: string) => {
      const r = await openLink(s, p);
      return r.ok ? "ok" : r.error.code;
    };
    expect(await code(bad)).toBe("not-text");
    expect(await code(nul)).toBe("not-text");
    expect(await code(big)).toBe("too-large");
    if (posix) {
      const key = file("secret.pem", "-----BEGIN-----");
      symlinkSync(key, join(root, "notes.md"));
      const small = service();
      const r = await openLink(small, join(root, "notes.md"));
      expect(r.ok ? "ok" : r.error.code).toBe("format-unsupported");
    }
  });

  it("does not open a Windows path on another OS, nor a POSIX one on Windows", async () => {
    const s = service();
    const r = await openLink(s, "C:\\Users\\me\\a.md", null);
    expect(r.ok ? "ok" : r.error.code).toBe("not-found");
    const w = service(undefined, { platform: "win32" });
    const r2 = await openLink(w, file("a.md", "x\n"));
    expect(r2.ok ? "ok" : r2.error.code).toBe("not-found");
  });

  it("unreadable and read errors are reported, not thrown", async () => {
    const f = file("a.md", "x\n");
    const err = Object.assign(new Error("EIO: boom"), { code: "EIO" });
    const s = service({ open: () => Promise.reject(err) });
    const r = await openLink(s, f);
    expect(r.ok ? "ok" : r.error.code).toBe("unreadable");
    const denied = service({ realpath: (() => Promise.reject(Object.assign(new Error("x"), { code: "EACCES" }))) as FileOps["realpath"] });
    const r2 = await openLink(denied, f);
    expect(r2.ok ? "ok" : r2.error.code).toBe("unreadable");
  });

  it("opens a read-only file for reading and says why it cannot be saved", async () => {
    if (!posix || process.getuid?.() === 0) return;
    const f = file("ro.md", "x\n");
    chmodSync(f, 0o444);
    const s = service();
    const d = doc(await openLink(s, f));
    expect(d.save.allowed).toBe(false);
    const r = await s.save(d.documentId, d.revision, "y\n", false);
    expect(r.ok ? "ok" : r.error.code).toBe("save-failed");
    expect(readFileSync(f, "utf8")).toBe("x\n");
  });

  it("keeps a BOM and CRLF exactly as read", async () => {
    const f = join(root, "b.md");
    writeFileSync(f, "\uFEFFa\r\nb\r\n");
    const s = service();
    expect(doc(await openLink(s, f)).text).toBe("\uFEFFa\r\nb\r\n");
  });

  it("uses a codec of its own for another format (the extension point)", async () => {
    const txt: FormatCodec = { id: "text", decode: (b) => Buffer.from(b).toString("utf8").toUpperCase(), encode: (x) => Buffer.from(x.toLowerCase()) };
    const f = file("a.txt", "hello");
    const s = service(undefined, {
      formats: [{ id: "text", label: "Text", extensions: [".txt"], maxBytes: 1000 }], codecs: [txt],
    });
    const d = doc(await openLink(s, f));
    expect(d.format).toBe("text");
    expect(d.text).toBe("HELLO");
    expect((await s.save(d.documentId, d.revision, "WORLD", false)).ok).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("world");
  });
});

describe("saving", () => {
  it("writes nothing until a save is asked for, then exactly the text, into the opened file only", async () => {
    const f = file("a.md", "one\n");
    const other = file("ws/a.md", "other\n");
    const before = statSync(f).mtimeMs;
    const s = service();
    const d = doc(await openLink(s, f, join(root, "ws")));
    s.setDirty(d.documentId, true);
    expect(readFileSync(f, "utf8")).toBe("one\n");
    expect(statSync(f).mtimeMs).toBe(before);
    const r = await s.save(d.documentId, d.revision, "# two\r\nline", false);
    expect(r.ok).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("# two\r\nline");
    expect(readFileSync(other, "utf8")).toBe("other\n");
    expect(tmpLeft()).toEqual([]);
    if (r.ok) {
      expect(r.revision).not.toBe(d.revision);
      // The next save needs the new revision; reopening shows what was written.
      const again = doc(await openLink(s, f, join(root, "ws")));
      expect(again.text).toBe("# two\r\nline");
      expect(again.revision).toBe(r.revision);
      expect((await s.save(d.documentId, d.revision, "stale", false)).ok).toBe(false);
      expect((await s.save(d.documentId, r.revision, "three", false)).ok).toBe(true);
    }
  });

  it("keeps the file's mode", async () => {
    if (!posix) return;
    const f = file("a.md", "one\n");
    chmodSync(f, 0o640);
    const s = service();
    const d = doc(await openLink(s, f));
    await s.save(d.documentId, d.revision, "two\n", false);
    expect(statSync(f).mode & 0o777).toBe(0o640);
  });

  it("refuses a file changed, replaced or removed since it was opened, writes nothing and keeps the session", async () => {
    const f = file("a.md", "one\n");
    const s = service();
    const d = doc(await openLink(s, f));
    writeFileSync(f, "someone else\n");
    const r = await s.save(d.documentId, d.revision, "mine\n", false);
    expect(r.ok ? "ok" : r.error.code).toBe("changed-on-disk");
    expect(readFileSync(f, "utf8")).toBe("someone else\n");
    expect(s.ids()).toEqual([d.documentId]);
    // The user chooses to replace it.
    const o = await s.save(d.documentId, d.revision, "mine\n", true);
    expect(o.ok).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("mine\n");
    // Removed.
    (await import("node:fs")).rmSync(f);
    const gone = await s.save(d.documentId, (o as { revision: string }).revision, "again\n", false);
    expect(gone.ok ? "ok" : gone.error.code).toBe("not-found");
    expect(existsSync(f)).toBe(false);
    // Replaced by a folder.
    mkdirSync(f);
    const dir = await s.save(d.documentId, (o as { revision: string }).revision, "again\n", false);
    expect(dir.ok ? "ok" : dir.error.code).toBe("not-a-file");
  });

  it("refuses a file replaced by a symlink to another file", async () => {
    if (!posix) return;
    const f = file("a.md", "one\n");
    const elsewhere = file("elsewhere.md", "one\n");
    const s = service();
    const d = doc(await openLink(s, f));
    (await import("node:fs")).rmSync(f);
    symlinkSync(elsewhere, f);
    const r = await s.save(d.documentId, d.revision, "mine\n", true);
    expect(r.ok ? "ok" : r.error.code).toBe("changed-on-disk");
    expect(readFileSync(elsewhere, "utf8")).toBe("one\n");
  });

  it("takes only a document id it gave: unknown, closed or invented ids find nothing and write nothing", async () => {
    const f = file("a.md", "one\n");
    const s = service();
    const d = doc(await openLink(s, f));
    for (const id of ["d999", "d0"]) {
      const r = await s.save(id, d.revision, "x", true);
      expect(r.ok ? "ok" : r.error.code).toBe("session-unknown");
    }
    expect(s.close(d.documentId)).toBe(true);
    expect(s.close(d.documentId)).toBe(false);
    const closed = await s.save(d.documentId, d.revision, "x", true);
    expect(closed.ok ? "ok" : closed.error.code).toBe("session-unknown");
    expect((await s.reload(d.documentId)).ok).toBe(false);
    expect(readFileSync(f, "utf8")).toBe("one\n");
  });

  it("refuses text that cannot be written as it is, and text over the limit", async () => {
    const f = file("a.md", "one\n");
    const s = service(undefined, { formats: [{ id: "markdown", label: "Markdown", extensions: [".md"], maxBytes: 20 }] });
    const d = doc(await openLink(s, f));
    for (const text of ["a\u0000b", "bad \uD800", "x".repeat(21)]) {
      const r = await s.save(d.documentId, d.revision, text, false);
      expect(r.ok ? "ok" : r.error.code).toBe("save-failed");
    }
    expect(readFileSync(f, "utf8")).toBe("one\n");
  });

  it("a failed write leaves the old file whole, removes its temporary file and lets the user retry", async () => {
    const f = file("a.md", "one\n");
    let fail = true;
    const s = service({ rename: async (a, b) => (fail ? Promise.reject(Object.assign(new Error("EBUSY: locked"), { code: "EBUSY" })) : (await import("node:fs")).promises.rename(a, b)) });
    const d = doc(await openLink(s, f));
    const r = await s.save(d.documentId, d.revision, "two\n", false);
    expect(r.ok ? "ok" : r.error).toMatchObject({ code: "save-failed", retryable: true });
    expect(readFileSync(f, "utf8")).toBe("one\n");
    expect(tmpLeft()).toEqual([]);
    fail = false;
    const again = await s.save(d.documentId, d.revision, "two\n", false);
    expect(again.ok).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("two\n");
  });

  it("a failure while writing the temporary file never touches the file", async () => {
    const f = file("a.md", "one\n");
    const real = (await import("node:fs")).promises;
    const s = service({
      open: (async (p: string, flags: string, mode?: number) => {
        const fh = await real.open(p, flags, mode);
        if (flags === "wx") fh.writeFile = (() => Promise.reject(Object.assign(new Error("ENOSPC: no space"), { code: "ENOSPC" }))) as typeof fh.writeFile;
        return fh;
      }) as FileOps["open"],
    });
    const d = doc(await openLink(s, f));
    const r = await s.save(d.documentId, d.revision, "two\n", false);
    expect(r.ok ? "ok" : r.error.code).toBe("save-failed");
    expect(readFileSync(f, "utf8")).toBe("one\n");
    expect(tmpLeft()).toEqual([]);
  });

  it("writes in place when the folder takes no temporary file, and puts the old bytes back on a failure", async () => {
    const f = file("a.md", "one\n");
    const real = (await import("node:fs")).promises;
    const denyTmp = (failWrite: boolean) => service({
      open: (async (p: string, flags: string, mode?: number) => {
        if (flags === "wx") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        const fh = await real.open(p, flags, mode);
        if (failWrite && flags === "r+") {
          const w = fh.write.bind(fh);
          let first = true;
          fh.write = (async (...a: unknown[]) => {
            if (first) {
              first = false;
              await (w as (...x: unknown[]) => Promise<unknown>)(Buffer.from("par"), 0, 3, 0); // half of the new text lands
              throw Object.assign(new Error("EIO"), { code: "EIO" });
            }
            return (w as (...x: unknown[]) => Promise<unknown>)(...a);
          }) as typeof fh.write;
        }
        return fh;
      }) as FileOps["open"],
    });
    const ok = denyTmp(false);
    const d = doc(await openLink(ok, f));
    const r = await ok.save(d.documentId, d.revision, "two, longer\n", false);
    expect(r.ok).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("two, longer\n");
    const bad = denyTmp(true);
    const d2 = doc(await openLink(bad, f));
    const r2 = await bad.save(d2.documentId, d2.revision, "three three three\n", false);
    expect(r2.ok ? "ok" : r2.error.code).toBe("save-failed");
    expect(readFileSync(f, "utf8")).toBe("two, longer\n");
  });

  it("runs saves of one document one after the other", async () => {
    const f = file("a.md", "one\n");
    const s = service();
    const d = doc(await openLink(s, f));
    const [a, b] = await Promise.all([s.save(d.documentId, d.revision, "A\n", false), s.save(d.documentId, d.revision, "B\n", false)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(readFileSync(f, "utf8")).toBe(a.ok ? "A\n" : "B\n");
  });
});

describe("reload, dirty and the end of sessions", () => {
  it("reload reads what is on disk now with a new revision", async () => {
    const f = file("a.md", "one\n");
    const s = service();
    const d = doc(await openLink(s, f));
    writeFileSync(f, "two\n");
    const r = await s.reload(d.documentId);
    expect(r.ok && r.document.text).toBe("two\n");
    expect(r.ok && r.document.revision).not.toBe(d.revision);
    if (r.ok) expect((await s.save(d.documentId, r.document.revision, "three\n", false)).ok).toBe(true);
  });

  it("reload says when the file went and keeps the session", async () => {
    const f = file("a.md", "one\n");
    const s = service();
    const d = doc(await openLink(s, f));
    (await import("node:fs")).rmSync(f);
    const r = await s.reload(d.documentId);
    expect(r.ok ? "ok" : r.error.code).toBe("not-found");
    expect(s.ids()).toEqual([d.documentId]);
  });

  it("keeps the dirty flag and drops sessions of a forgotten project only", async () => {
    const a = file("a.md", "a\n");
    const b = file("b.md", "b\n");
    const s = service();
    const da = doc(await openLink(s, a));
    s.syncLinks("ffffffffffffffff", "c2", 1, [pm("i1", `[x](<${b}>)`)], true);
    const link = (events.at(-1) as Extract<DesktopEvent, { type: "documentLinks" }>).links[0]!.linkId;
    const db = doc(await s.open({ projectId: "ffffffffffffffff", conversationId: "c2", view: 1, linkId: link, workspace: root }));
    s.setDirty(da.documentId, true);
    expect(s.dirtyIds()).toEqual([da.documentId]);
    expect(s.closeProject("ffffffffffffffff")).toEqual([db.documentId]);
    expect(events.at(-1)).toEqual({ type: "documentClosed", documentId: db.documentId });
    expect(s.ids()).toEqual([da.documentId]);
    s.setDirty(da.documentId, false);
    expect(s.dirtyIds()).toEqual([]);
  });

  it("revoking links never ends a session being edited", async () => {
    const f = file("a.md", "a\n");
    const s = service();
    const d = doc(await openLink(s, f));
    s.revokeConversation(P, C);
    expect(s.ids()).toEqual([d.documentId]);
    expect((await s.save(d.documentId, d.revision, "b\n", false)).ok).toBe(true);
  });
});

describe("the dispatcher's document requests", () => {
  it("answers each document.* method through main's service, and refuses a path", async () => {
    const { Dispatcher } = await import("../src/main/ipc.js");
    const f = file("a.md", "one\n");
    const s = service();
    const [linkId] = grant(s, f);
    const projects = {
      documents: s,
      openDocument: (p: string, c: string, v: number, l: string) => s.open({ projectId: p, conversationId: c, view: v, linkId: l, workspace: root }),
    };
    const d = new Dispatcher({ projects, documentCloseResponse: (id: string) => id === "q1" } as never);
    const sender = { senderId: 3, windowId: 3, mainFrame: true, url: "agentduo://app/index.html" };
    const ask = async (m: object) => (await d.handle(sender, m)) as { ok: boolean; result: any; error?: string };
    const opened = await ask({ method: "document.open", projectId: P, conversationId: C, view: 1, linkId, path: "/etc/passwd" });
    expect(opened.result.document.location).toBe(f);
    const id = opened.result.document.documentId;
    expect((await ask({ method: "document.dirty", documentId: id, dirty: true })).result).toEqual({ recorded: true });
    expect(s.dirtyIds()).toEqual([id]);
    const saved = await ask({ method: "document.save", documentId: id, revision: opened.result.document.revision, text: "two\n", overwrite: false, path: "/etc/passwd" });
    expect(saved.result.ok).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("two\n");
    expect((await ask({ method: "document.save", documentId: id, text: "x" })).ok).toBe(false);
    expect((await ask({ method: "document.closeResponse", requestId: "q1", outcome: "settled" })).result).toEqual({ accepted: true });
    expect((await ask({ method: "document.closeResponse", requestId: "q2", outcome: "settled" })).result).toEqual({ accepted: false });
    expect((await ask({ method: "document.close", documentId: id })).result).toEqual({ closed: true });
    expect((await ask({ method: "document.reload", documentId: id })).result.ok).toBe(false);
  });
});
