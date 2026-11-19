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

  it("does not open a path of the other OS's shape (a Windows path on POSIX, a POSIX path on Windows)", async () => {
    // The opposite platform to the real one, with a path in that platform's own shape.
    const other = service(undefined, { platform: posix ? "win32" : "linux" });
    const r = await openLink(other, posix ? "C:\\Users\\me\\a.md" : "/home/me/a.md", posix ? null : "/home/me");
    expect(r.ok ? "ok" : r.error.code).toBe("not-found");
    // And with the real platform, a path of its own shape opens.
    expect((await openLink(service(), file("a.md", "x\n"))).ok).toBe(true);
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
        if (flags === "wx") fh.write = (() => Promise.reject(Object.assign(new Error("ENOSPC: no space"), { code: "ENOSPC" }))) as typeof fh.write;
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

describe("a write that takes fewer bytes, and a file that changes while it is being replaced", () => {
  const real = () => import("node:fs").then((m) => m.promises);
  /** An open() whose handles take at most `n` bytes per write. */
  const shortWrites = async (n: number, only: string): Promise<FileOps["open"]> => {
    const fsp = await real();
    return (async (p: string, flags: string, mode?: number) => {
      const fh = await fsp.open(p, flags, mode);
      if (flags === only) {
        const w = fh.write.bind(fh) as (...a: unknown[]) => Promise<{ bytesWritten: number }>;
        fh.write = ((b: Buffer, off: number, len: number, pos: number) => w(b, off, Math.min(len, n), pos)) as typeof fh.write;
      }
      return fh;
    }) as FileOps["open"];
  };
  const noTmp = (inner: FileOps["open"]): FileOps["open"] => ((p: string, flags: string, mode?: number) =>
    flags === "wx" ? Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" })) : inner(p, flags, mode)) as FileOps["open"];

  it("in place: writes every byte even when each write takes two, then reports success", async () => {
    const f = file("a.md", "ORIGINAL-CONTENT");
    const s = service({ open: noTmp(await shortWrites(2, "r+")) });
    const d = doc(await openLink(s, f));
    const r = await s.save(d.documentId, d.revision, "NEW-TEXT", false);
    expect(r.ok).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("NEW-TEXT");
  });

  it("in place: a write that makes no progress is a failure, and the old bytes are put back whole", async () => {
    const f = file("a.md", "ORIGINAL-CONTENT");
    const fsp = await real();
    let calls = 0;
    const open = noTmp((async (p: string, flags: string, mode?: number) => {
      const fh = await fsp.open(p, flags, mode);
      if (flags === "r+") {
        const w = fh.write.bind(fh) as (...a: unknown[]) => Promise<{ bytesWritten: number }>;
        // Two bytes land, then nothing: the restore (also in 2-byte writes) then goes through.
        fh.write = ((b: Buffer, off: number, len: number, pos: number) => (++calls === 2 ? Promise.resolve({ bytesWritten: 0 }) : w(b, off, Math.min(len, 2), pos))) as typeof fh.write;
      }
      return fh;
    }) as FileOps["open"]);
    const s = service({ open });
    const d = doc(await openLink(s, f));
    const r = await s.save(d.documentId, d.revision, "NEW-TEXT-LONGER", false);
    expect(r.ok ? "ok" : r.error.code).toBe("save-failed");
    expect(readFileSync(f, "utf8")).toBe("ORIGINAL-CONTENT");
    expect(s.ids()).toEqual([d.documentId]);
  });

  it("replacing: an outside change while the temporary file is flushed is not overwritten", async () => {
    const f = file("a.md", "one\n");
    const fsp = await real();
    const open = (async (p: string, flags: string, mode?: number) => {
      const fh = await fsp.open(p, flags, mode);
      if (flags === "wx") {
        const sync = fh.sync.bind(fh);
        fh.sync = (async () => {
          writeFileSync(f, "outside\n");
          return sync();
        }) as typeof fh.sync;
      }
      return fh;
    }) as FileOps["open"];
    const s = service({ open });
    const d = doc(await openLink(s, f));
    const r = await s.save(d.documentId, d.revision, "mine\n", false);
    expect(r.ok ? "ok" : r.error.code).toBe("changed-on-disk");
    expect(readFileSync(f, "utf8")).toBe("outside\n");
    expect(tmpLeft()).toEqual([]);
    expect(s.ids()).toEqual([d.documentId]);
  });

  it("replacing: a file removed while the temporary file is flushed is not created again", async () => {
    const f = file("a.md", "one\n");
    const fsp = await real();
    const open = (async (p: string, flags: string, mode?: number) => {
      const fh = await fsp.open(p, flags, mode);
      if (flags === "wx") {
        const sync = fh.sync.bind(fh);
        fh.sync = (async () => {
          (await import("node:fs")).rmSync(f);
          return sync();
        }) as typeof fh.sync;
      }
      return fh;
    }) as FileOps["open"];
    const s = service({ open });
    const d = doc(await openLink(s, f));
    // Even with the user's choice to overwrite: a file that is gone is not made again.
    const r = await s.save(d.documentId, d.revision, "mine\n", true);
    expect(r.ok ? "ok" : r.error.code).toBe("not-found");
    expect(existsSync(f)).toBe(false);
    expect(tmpLeft()).toEqual([]);
  });

  it("in place: an outside change after the file was opened for writing is not overwritten", async () => {
    const f = file("a.md", "one\n");
    const fsp = await real();
    const open = noTmp((async (p: string, flags: string, mode?: number) => {
      const fh = await fsp.open(p, flags, mode);
      if (flags === "r+") writeFileSync(f, "outside\n");
      return fh;
    }) as FileOps["open"]);
    const s = service({ open });
    const d = doc(await openLink(s, f));
    const r = await s.save(d.documentId, d.revision, "mine\n", false);
    expect(r.ok ? "ok" : r.error.code).toBe("changed-on-disk");
    expect(readFileSync(f, "utf8")).toBe("outside\n");
    expect(s.ids()).toEqual([d.documentId]);
  });

  it("in place: a file moved away and replaced after the handle was opened is not written through the old handle", async () => {
    if (!posix) return;
    const fsp = await real();
    for (const overwrite of [false, true]) {
      const f = file(`r${overwrite}.md`, "ORIGINAL");
      const old = join(root, `old${overwrite}.md`);
      const open = noTmp((async (p: string, flags: string, mode?: number) => {
        const fh = await fsp.open(p, flags, mode);
        if (flags === "r+") {
          (await import("node:fs")).renameSync(f, old);
          writeFileSync(f, overwrite ? "DIFFERENT" : "ORIGINAL");
        }
        return fh;
      }) as FileOps["open"]);
      const s = service({ open });
      const d = doc(await openLink(s, f));
      const r = await s.save(d.documentId, d.revision, "MY-EDITS", overwrite);
      expect(r.ok ? "ok" : r.error.code).toBe("changed-on-disk");
      expect(readFileSync(old, "utf8")).toBe("ORIGINAL");
      expect(readFileSync(f, "utf8")).toBe(overwrite ? "DIFFERENT" : "ORIGINAL");
      expect(s.ids()).toEqual([d.documentId]);
    }
  });
});

describe("the identity of the opened file, concurrent opens and the in-place backup", () => {
  const fs = () => import("node:fs");
  const noTmp = (): FileOps["open"] => (async (p: string, flags: string, mode?: number) => {
    if (flags === "wx") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    return (await fs()).promises.open(p, flags, mode);
  }) as FileOps["open"];

  it("refuses a replacement file with the same bytes, keeps the session, and a reload takes the new file as the one", async () => {
    const f = file("same.md", "same\n");
    const other = file("other.md", "same\n");
    const s = service();
    const d = doc(await openLink(s, f));
    (await fs()).renameSync(f, join(root, "gone.md"));
    (await fs()).renameSync(other, f);
    for (const overwrite of [false, true]) {
      const r = await s.save(d.documentId, d.revision, "mine\n", overwrite);
      expect(r.ok ? "ok" : r.error.code).toBe("changed-on-disk");
    }
    expect(readFileSync(f, "utf8")).toBe("same\n");
    expect(tmpLeft()).toEqual([]);
    const again = doc(await s.reload(d.documentId));
    expect(again.documentId).toBe(d.documentId);
    expect(await s.save(d.documentId, again.revision, "mine\n", false)).toMatchObject({ ok: true });
    expect(readFileSync(f, "utf8")).toBe("mine\n");
  });

  it("a successful save keeps the session usable: the next save passes the identity check (replace and in place)", async () => {
    for (const inPlace of [false, true]) {
      const f = file(`again-${inPlace}.md`, "v0");
      const s = service(inPlace ? { open: noTmp() } : undefined);
      const d = doc(await openLink(s, f));
      const a = await s.save(d.documentId, d.revision, "v1", false);
      expect(a.ok).toBe(true);
      const b = await s.save(d.documentId, a.ok ? a.revision : "", "v2", false);
      expect(b).toMatchObject({ ok: true });
      expect(readFileSync(f, "utf8")).toBe("v2");
    }
  });

  it("a swap in the instant of the rename: the session follows the file that was written and verified, and saves again", async () => {
    if (!posix) return;
    const f = file("race.md", "same");
    const m = await fs();
    let swapped = false;
    const s = service({
      rename: (async (from: string, to: string) => {
        if (!swapped) {
          swapped = true;
          m.renameSync(f, join(root, "gone.md"));
          writeFileSync(f, "same");
        }
        return m.promises.rename(from, to);
      }) as FileOps["rename"],
    });
    const d = doc(await openLink(s, f));
    const first = await s.save(d.documentId, d.revision, "mine", false);
    // The swap happened after the last check (nothing can close that window); the identity is taken from the file read back.
    expect(first.ok).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("mine");
    expect(await s.save(d.documentId, first.ok ? first.revision : "", "mine2", false)).toMatchObject({ ok: true });
  });

  it("two opens of one file at once give one session: the same id, one new and one existing, owners of both", async () => {
    const f = file("both.md", "base");
    const s = service();
    s.syncLinks(P, C, 1, [pm("a", `[x](<${f}>)`)], true);
    s.syncLinks(P, "other-conversation", 1, [pm("b", `[x](<${f}>)`)], true);
    const links = events.filter((e): e is Extract<DesktopEvent, { type: "documentLinks" }> => e.type === "documentLinks");
    const idOf = (cid: string) => links.find((e) => e.conversationId === cid)!.links[0]!.linkId;
    const [a, b] = await Promise.all([
      s.open({ projectId: P, conversationId: C, view: 1, linkId: idOf(C), workspace: root }),
      s.open({ projectId: P, conversationId: "other-conversation", view: 1, linkId: idOf("other-conversation"), workspace: root }),
    ]);
    expect(doc(a).documentId).toBe(doc(b).documentId);
    expect([a.ok && a.existing, b.ok && b.existing].sort()).toEqual([false, true]);
    expect(s.ids()).toHaveLength(1);
    // the project is forgotten: both owners are of it, so the session ends
    expect(s.closeProject(P)).toEqual([doc(a).documentId]);
  });

  it("a failed open leaves no session and a later open of the same file succeeds", async () => {
    const f = file("retry.md", "base");
    let fail = true;
    const m = await fs();
    const s = service({
      open: (async (p: string, flags: string, mode?: number) => {
        if (fail && flags === "r") throw Object.assign(new Error("EIO"), { code: "EIO" });
        return m.promises.open(p, flags, mode);
      }) as FileOps["open"],
    });
    const [linkId] = grant(s, f);
    const request = { projectId: P, conversationId: C, view: 1, linkId: linkId!, workspace: root };
    const [x, y] = await Promise.all([s.open(request), s.open(request)]);
    expect(x.ok || y.ok).toBe(false);
    expect(s.ids()).toEqual([]);
    fail = false;
    expect(doc(await s.open(request)).text).toBe("base");
  });

  it("in place: a file longer than the limit is refused before the first byte, with overwrite too, and stays whole", async () => {
    const f = file("big.md", "BASE");
    const outside = "x".repeat(40);
    const m = await fs();
    let writes = 0;
    const open = (async (p: string, flags: string, mode?: number) => {
      if (flags === "wx") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      const fh = await m.promises.open(p, flags, mode);
      if (flags === "r+") {
        const w = fh.write.bind(fh) as (...a: unknown[]) => Promise<{ bytesWritten: number }>;
        fh.write = ((...a: unknown[]) => (writes++, w(...a))) as typeof fh.write;
      }
      return fh;
    }) as FileOps["open"];
    const s = service({ open }, { formats: [{ id: "markdown", label: "Markdown", extensions: [".md"], maxBytes: 16 }] });
    const d = doc(await openLink(s, f));
    writeFileSync(f, outside);
    for (const overwrite of [false, true]) {
      const r = await s.save(d.documentId, d.revision, "EDIT", overwrite);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe(overwrite ? "save-failed" : "changed-on-disk");
    }
    expect(writes).toBe(0);
    expect(readFileSync(f, "utf8")).toBe(outside);
    expect(s.ids()).toEqual([d.documentId]);
  });
});
