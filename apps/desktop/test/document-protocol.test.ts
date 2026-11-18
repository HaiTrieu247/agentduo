// The "Mở" contract (shared/documents.ts, shared/protocol.ts): what a link says and where it points, the ids main grants,
// the registry of formats, and how every document request is checked. The renderer is untrusted for paths: it never
// names one, only ids main handed out.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { TimelineItem } from "@agentduo/host/viewState";
import {
  DOCUMENT_FORMATS, DocumentLinkTable, MAX_DOCUMENT_CHARS, MAX_LINKS_PER_VIEW, decodeOnce, decodeUtf8Strict, documentError, documentLinkSites, encodeUtf8, extensionOf,
  formatById, formatForPath, isWritableText, linkFormat, linkParts, linkTarget, markdownLinks, splitHref, type DocumentFormat, type DocumentLinkSite,
} from "../src/shared/documents.js";
import { parseDesktopRequest, trustedSender, type SenderInfo } from "../src/shared/protocol.js";
import { Dispatcher, type DispatcherOptions } from "../src/main/ipc.js";

const project = "0123456789abcdef";
const conversation = "20261031-120000-tab-abcd1234";
const target = (href: string, workspace: string | null = "/work/app") => {
  const t = linkTarget(href, { workspace });
  if (!t.ok) throw new Error(`${href}: ${t.error.message}`);
  return t.value;
};
const refused = (href: string, workspace: string | null = "/work/app") => {
  const t = linkTarget(href, { workspace });
  if (t.ok) throw new Error(`${href} resolved to ${t.value.path}`);
  return t.error;
};

describe("where a link points", () => {
  it("keeps an absolute path or a file URL exactly, outside the workspace too (a worktree, an attachment folder)", () => {
    expect(target("/Users/me/.local/share/agentduo/teams/t1/dev-1/docs/a.md").path).toBe("/Users/me/.local/share/agentduo/teams/t1/dev-1/docs/a.md");
    expect(target("file:///tmp/attachments/c1/notes.md").path).toBe("/tmp/attachments/c1/notes.md");
    expect(target("file:/tmp/x.md").path).toBe("/tmp/x.md");
    expect(target("file://localhost/tmp/x.md").path).toBe("/tmp/x.md");
    // The workspace plays no part in an absolute target, even when a file of the same name is in it.
    expect(target("/tmp/other/README.md", "/work/app").path).toBe("/tmp/other/README.md");
    expect(target("/tmp/other/README.md", null).path).toBe("/tmp/other/README.md");
  });

  it("reads a relative path from the conversation's workspace, and nowhere else", () => {
    expect(target("docs/a.md").path).toBe("/work/app/docs/a.md");
    expect(target("./docs/./a.md").path).toBe("/work/app/docs/a.md");
    // A POSIX path keeps its `..` as written: only the file system can say where `docs/..` leads (a symlink).
    expect(target("docs/../README.md").path).toBe("/work/app/docs/../README.md");
    expect(target("../other/a.md").path).toBe("/work/app/../other/a.md");
    expect(target("/a/link/../b.md").path).toBe("/a/link/../b.md");
    expect(refused("/a/b/..").code).toBe("link-invalid");
    expect(refused("docs/..").code).toBe("link-invalid");
    expect(refused("..").code).toBe("link-invalid");
    // The workspace's trailing slash changes nothing.
    expect(target("a.md", "/work/app/").path).toBe("/work/app/a.md");
    // No label or name search: a bare name is the workspace's own path, even if the file is elsewhere.
    expect(target("README.md").path).toBe("/work/app/README.md");
  });

  it("says plainly when the context cannot tell the file, and guesses nothing", () => {
    expect(refused("docs/a.md", null).code).toBe("link-unresolved");
    expect(refused("docs/a.md", null).message).toContain("no workspace folder");
    expect(refused("docs/a.md", "relative/work").code).toBe("link-unresolved");
    expect(refused("~/notes.md").code).toBe("link-unresolved");
    expect(refused("C:notes.md").code).toBe("link-unresolved");
    expect(refused("https://example.com/a.md").code).toBe("link-not-file");
    expect(refused("mailto:a@b.c").code).toBe("link-not-file");
    expect(refused("").code).toBe("link-invalid");
    expect(refused("   ").code).toBe("link-invalid");
    expect(refused("docs/").code).toBe("link-invalid");
    expect(refused("a%00.md").code).toBe("link-invalid");
    expect(refused("a%0A.md").code).toBe("link-invalid");
    expect(refused(`${"a/".repeat(3000)}x.md`).code).toBe("link-invalid");
    expect(refused("file:").code).toBe("link-invalid");
    expect(refused("file:relative.md").code).toBe("link-invalid");
    expect(refused("/").code).toBe("link-invalid");
  });

  it("tells a position or an anchor from the file's name", () => {
    expect(target("/a/b.md:12").position).toEqual({ line: 12, column: null });
    expect(target("/a/b.md:12:5").position).toEqual({ line: 12, column: 5 });
    expect(target("/a/b.md:12:5").path).toBe("/a/b.md");
    expect(target("/a/b.md#L7").position).toEqual({ line: 7, column: null });
    expect(target("/a/b.md#L7C3").position).toEqual({ line: 7, column: 3 });
    expect(target("/a/b.md#L7-L20").position).toEqual({ line: 7, column: null });
    expect(target("/a/b.md#L7C3-L9C1").position).toEqual({ line: 7, column: 3 });
    expect(target("/a/b.md#Install-steps")).toMatchObject({ path: "/a/b.md", position: null, anchor: "Install-steps" });
    expect(target("/a/b.md#caf%C3%A9").anchor).toBe("café");
    expect(target("/a/b.md").anchor).toBeNull();
    expect(target("/a/b.md#").anchor).toBeNull();
    // A suffix wins over a fragment's position; a line of 0 is refused.
    expect(target("/a/b.md:3#L9").position).toEqual({ line: 3, column: null });
    expect(refused("/a/b.md:0").code).toBe("link-invalid");
    expect(refused("/a/b.md#L0").code).toBe("link-invalid");
    // A number that is part of a name is a name; an encoded colon is never a position.
    expect(target("/a/v1.2").path).toBe("/a/v1.2");
    expect(target("/a/b.md%3A12").path).toBe("/a/b.md:12");
    expect(target("/a/b.md%3A12").position).toBeNull();
    // A query is dropped from a file URL only.
    expect(target("file:///a/b.md?x=1").path).toBe("/a/b.md");
    expect(target("/a/b?.md").path).toBe("/a/b?.md");
    // `<…>` around the link is dropped.
    expect(target("</a/b c.md>").path).toBe("/a/b c.md");
  });

  it("decodes percent-encoding once", () => {
    expect(target("/a/my%20notes.md").path).toBe("/a/my notes.md");
    expect(target("docs/my%20notes.md").path).toBe("/work/app/docs/my notes.md");
    expect(target("file:///a/%E2%82%AC.md").path).toBe("/a/€.md");
    // Twice-encoded stays encoded once decoded.
    expect(target("/a/x%2520y.md").path).toBe("/a/x%20y.md");
    // A hash in a name is written %23; an encoded slash is a slash of the name's path.
    expect(target("/a/c%231.md").path).toBe("/a/c#1.md");
    // An escape that is not valid leaves the text as written (a file named 100%.md).
    expect(target("/a/100%.md").path).toBe("/a/100%.md");
    expect(target("/a/%zz.md").path).toBe("/a/%zz.md");
    expect(decodeOnce("%E0%A4%A")).toBe("%E0%A4%A");
    expect(decodeOnce("a%20b")).toBe("a b");
    // `..` hidden by encoding is still resolved once, as the path that was written.
    expect(target("docs/%2E%2E/a.md").path).toBe("/work/app/docs/../a.md");
  });

  it("handles Windows paths: drives, both separators, UNC shares, file URLs, and a Windows workspace", () => {
    expect(target("C:\\Users\\me\\a.md", null)).toMatchObject({ path: "C:\\Users\\me\\a.md", style: "windows" });
    expect(target("c:/Users/me/a.md", null).path).toBe("C:\\Users\\me\\a.md");
    expect(target("C:\\Users\\me\\..\\a.md:4:2", null)).toMatchObject({ path: "C:\\Users\\a.md", position: { line: 4, column: 2 } });
    expect(target("file:///C:/Users/me/my%20a.md", null)).toMatchObject({ path: "C:\\Users\\me\\my a.md", style: "windows" });
    expect(target("file:///c:/a.md", null).path).toBe("C:\\a.md");
    expect(target("file://C:/a.md", null).path).toBe("C:\\a.md");
    expect(target("\\\\server\\share\\docs\\a.md", null)).toMatchObject({ path: "\\\\server\\share\\docs\\a.md", style: "windows" });
    expect(target("file://server/share/docs/a.md", null)).toMatchObject({ path: "\\\\server\\share\\docs\\a.md", style: "windows" });
    expect(refused("file://server/a.md", null).code).toBe("link-invalid");
    // `..` stops at a drive's or share's root.
    expect(target("C:\\..\\..\\a.md", null).path).toBe("C:\\a.md");
    // A relative path in a Windows workspace takes both separators, and the workspace's style.
    expect(target("docs/a.md", "C:\\work\\app")).toMatchObject({ path: "C:\\work\\app\\docs\\a.md", style: "windows" });
    expect(target("docs\\sub\\a.md", "C:\\work\\app").path).toBe("C:\\work\\app\\docs\\sub\\a.md");
    expect(target("..\\a.md", "C:\\work\\app").path).toBe("C:\\work\\a.md");
    // In a POSIX workspace a backslash is a letter of the name, not a separator.
    expect(target("docs\\a.md").path).toBe("/work/app/docs\\a.md");
    // A Windows path on a POSIX machine is still parsed (and then simply not found).
    expect(target("D:/x/a.md", "/work/app").style).toBe("windows");
  });

  it("splits a link without the platform or the workspace", () => {
    const s = splitHref("file:///a/b.md#L3");
    expect(s).toEqual({ ok: true, value: { kind: "file-url", raw: "file:///a/b.md", position: { line: 3, column: null }, anchor: null } });
    expect(splitHref("a/b.md#intro")).toEqual({ ok: true, value: { kind: "path", raw: "a/b.md", position: null, anchor: "intro" } });
  });
});

describe("a link through a symlink, with `..`", () => {
  // workspace/link -> outside/child, so `workspace/link/../note.md` is outside/note.md (the kernel resolves `..` after the link),
  // while collapsing it first would read workspace/note.md: another file, which a save would then overwrite.
  it.skipIf(process.platform === "win32")("points at the file the kernel opens, never at the one a collapsed path names", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "duo-link-")));
    try {
      const workspace = join(root, "workspace");
      mkdirSync(workspace);
      mkdirSync(join(root, "outside", "child"), { recursive: true });
      writeFileSync(join(root, "outside", "note.md"), "outside\n");
      writeFileSync(join(workspace, "note.md"), "workspace\n");
      symlinkSync(join(root, "outside", "child"), join(workspace, "link"));
      const read = (p: string) => readFileSync(realpathSync.native(p), "utf8");

      const relative = target("link/../note.md", workspace);
      expect(relative.path).toBe(`${workspace}/link/../note.md`);
      expect(read(relative.path)).toBe("outside\n");
      const absolute = target(`${workspace}/link/../note.md`, null);
      expect(read(absolute.path)).toBe("outside\n");
      const fileUrl = target(`file://${workspace}/link/../note.md`, null);
      expect(read(fileUrl.path)).toBe("outside\n");
      // The trap: what a lexical collapse names is the other file.
      expect(read(resolve(relative.path))).toBe("workspace\n");
      expect(realpathSync.native(relative.path)).toBe(join(root, "outside", "note.md"));
      expect(realpathSync.native(relative.path)).not.toBe(realpathSync.native(resolve(relative.path)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the registry of formats", () => {
  it("opens Markdown by its extension, whatever the case, and nothing else yet", () => {
    expect(DOCUMENT_FORMATS.map((f) => f.id)).toEqual(["markdown"]);
    expect(formatForPath("/a/README.md")?.id).toBe("markdown");
    expect(formatForPath("C:\\a\\README.MD")?.id).toBe("markdown");
    expect(formatForPath("/a/b.txt")).toBeNull();
    expect(formatForPath("/a/b.md.txt")).toBeNull();
    expect(formatForPath("/a/b.markdown")).toBeNull();
    expect(formatForPath("/a/.md")).toBeNull();
    expect(formatForPath("/a/md")).toBeNull();
    expect(formatForPath("/a.md/b")).toBeNull();
    expect(extensionOf("/a/b.TAR.gz")).toBe(".gz");
    expect(formatById("markdown")?.label).toBe("Markdown");
    expect(formatById("pdf")).toBeNull();
  });

  it("takes another format without any change to links: the same click, the new type picked by extension", () => {
    const formats: readonly DocumentFormat[] = [...DOCUMENT_FORMATS, { id: "text", label: "Text", extensions: [".txt"], maxBytes: 1000 }];
    expect(linkFormat("/a/b.txt")).toBeNull();
    expect(linkFormat("/a/b.txt", formats)?.id).toBe("text");
    expect(linkFormat("docs/b.TXT#L2", formats)?.id).toBe("text");
    expect(linkFormat("/a/b.md", formats)?.id).toBe("markdown");
    // The same table and the same request serve both: a link of either type gets an id and opens by `document.open`.
    const items = [pm("pm-1", "See [notes](/a/n.txt) and [plan](/a/p.md).")];
    expect(documentLinkSites(items, formats).map((s) => s.href)).toEqual(["/a/n.txt", "/a/p.md"]);
    expect(documentLinkSites(items).map((s) => s.href)).toEqual(["/a/p.md"]);
  });

  it("knows a link's format from what it names, not its scheme, query or anchor", () => {
    expect(linkFormat("file:///a/b.md?x=1#top")?.id).toBe("markdown");
    expect(linkFormat("a/my%20file.md:4")?.id).toBe("markdown");
    expect(linkFormat("https://example.com/a.md")).toBeNull();
    expect(linkFormat("")).toBeNull();
  });
});

const pm = (id: string, text: string): TimelineItem => ({ id, kind: "pm", text });

describe("links in the chat's text", () => {
  it("numbers links in document order, not those in code, and reads nested and table links", () => {
    const text = [
      "# Plan [head](/a/h.md)", "",
      "Intro with **[bold](/a/b.md)** and `[code](/a/c.md)`.", "",
      "```", "[fenced](/a/f.md)", "```", "",
      "- item [one](/a/1.md)", "- item [two](/a/2.md)", "",
      "> quote [q](/a/q.md)", "",
      "| H [th](/a/th.md) |", "| --- |", "| [td](/a/td.md) |",
    ].join("\n");
    expect(markdownLinks(text)).toEqual(["/a/h.md", "/a/b.md", "/a/1.md", "/a/2.md", "/a/q.md", "/a/th.md", "/a/td.md"]);
  });

  it("takes links only from the Markdown the chat draws, and only to files it can open", () => {
    const items: TimelineItem[] = [
      { id: "user-1", kind: "user", text: "open [x](/a/user.md)" },
      pm("pm-2", "Here: [brief](/a/brief.md), [site](https://example.com), [code](/a/main.ts), [plan](docs/plan.md#L3)."),
      { id: "document-3", kind: "document", docKind: "plan", title: "Plan", text: "[nope](/a/doc.md)" },
      { id: "info-4", kind: "info", text: "[nope](/a/info.md)", tone: "info" },
    ];
    expect(documentLinkSites(items)).toEqual([
      { itemId: "pm-2", part: "text", ordinal: 0, href: "/a/brief.md" },
      { itemId: "pm-2", part: "text", ordinal: 3, href: "docs/plan.md#L3" },
    ]);
    expect(linkParts(items[0]!)).toEqual([]);
  });

  it("names the parts of answers and discussions", () => {
    const turn = (answer: string | null, status: "success" | "error" = "success") => ({
      turnId: "t", backend: "claude", model: { id: "m" }, startedAt: 0, activities: [], dropped: 0, status, answer,
    }) as never;
    const answer: TimelineItem = { id: "answer-5", kind: "answer", turn: turn("See [a](/a/a.md)") };
    const failed: TimelineItem = { id: "answer-6", kind: "answer", turn: turn("[b](/a/b.md)", "error") };
    const discussion: TimelineItem = {
      id: "discussion-7", kind: "discussion",
      discussion: { id: "d", question: "q", answerer: "claude", critic: "codex", maxRounds: 2, startedAt: 0, turns: [turn("[t0](/a/t0.md)"), turn(null)], answer: "[final](/a/final.md)" },
    } as never;
    expect(linkParts(answer)).toEqual([{ part: "answer", text: "See [a](/a/a.md)" }]);
    expect(linkParts(failed)).toEqual([]);
    expect(linkParts(discussion).map((p) => p.part)).toEqual(["answer", "turn.0"]);
    expect(documentLinkSites([answer, discussion]).map((s) => `${s.itemId}/${s.part}/${s.ordinal}`)).toEqual(["answer-5/answer/0", "discussion-7/answer/0", "discussion-7/turn.0/0"]);
  });
});

const site = (itemId: string, ordinal: number, href: string, part = "text"): DocumentLinkSite => ({ itemId, part, ordinal, href });
const A = `${project}/${conversation}`;

describe("the ids granted to links", () => {
  it("grants one id per link, without sending the target, and keeps it while the chat grows", () => {
    const t = new DocumentLinkTable();
    const first = t.sync(A, 1, [site("pm-1", 0, "/a/x.md")]);
    expect(first.grants).toEqual([{ linkId: "k1", itemId: "pm-1", part: "text", ordinal: 0 }]);
    expect(JSON.stringify(first.grants)).not.toContain("/a/x.md");
    const more = t.sync(A, 1, [site("pm-1", 0, "/a/x.md"), site("pm-1", 1, "/a/y.md"), site("pm-2", 0, "/a/z.md")]);
    expect(more.grants.map((g) => g.linkId)).toEqual(["k2", "k3"]);
    expect(more.revoked).toEqual([]);
    expect(t.href(A, 1, "k1")).toBe("/a/x.md");
    expect(t.href(A, 1, "k3")).toBe("/a/z.md");
    // A fresh page (a snapshot) is told every live id again.
    expect(t.sync(A, 1, [site("pm-1", 0, "/a/x.md"), site("pm-1", 1, "/a/y.md"), site("pm-2", 0, "/a/z.md")], true).grants.map((g) => g.linkId).sort()).toEqual(["k1", "k2", "k3"]);
  });

  it("revokes the ids of an earlier view, of another view, and of a conversation that is gone", () => {
    const t = new DocumentLinkTable();
    t.sync(A, 1, [site("pm-1", 0, "/a/x.md")]);
    expect(t.href(A, 2, "k1")).toBeNull();
    const reopened = t.sync(A, 2, [site("pm-1", 0, "/a/x.md")]);
    expect(reopened.revoked).toEqual(["k1"]);
    expect(reopened.grants).toEqual([{ linkId: "k2", itemId: "pm-1", part: "text", ordinal: 0 }]);
    expect(t.href(A, 1, "k1")).toBeNull();
    expect(t.href(A, 2, "k1")).toBeNull();
    expect(t.href(A, 2, "k2")).toBe("/a/x.md");
    // Another conversation's id does not open here.
    const B = `${project}/20261031-130000-tab-ffff0000`;
    t.sync(B, 3, [site("pm-1", 0, "/b/x.md")]);
    expect(t.href(B, 3, "k2")).toBeNull();
    expect(t.href(A, 2, "k3")).toBeNull();
    expect(t.href(A, 2, "k99")).toBeNull();
    expect(t.revoke(A)).toEqual(["k2"]);
    expect(t.href(A, 2, "k2")).toBeNull();
    expect(t.size).toBe(1);
    expect(t.revokeProject(project)).toEqual(["k3"]);
    expect(t.size).toBe(0);
    expect(t.revoke(A)).toEqual([]);
  });

  it("revokes a link whose text is gone or whose target changed at the same place, and never lets an old id reach a new target", () => {
    const t = new DocumentLinkTable();
    t.sync(A, 1, [site("pm-1", 0, "/a/x.md"), site("pm-2", 0, "/a/y.md")]);
    const next = t.sync(A, 1, [site("pm-1", 0, "/a/other.md")]);
    expect(next.revoked.sort()).toEqual(["k1", "k2"]);
    expect(next.grants).toEqual([{ linkId: "k3", itemId: "pm-1", part: "text", ordinal: 0 }]);
    expect(t.href(A, 1, "k1")).toBeNull();
    expect(t.href(A, 1, "k3")).toBe("/a/other.md");
  });

  it("keeps the latest links of a view when there are too many", () => {
    const t = new DocumentLinkTable();
    const sites = Array.from({ length: MAX_LINKS_PER_VIEW + 5 }, (_, i) => site(`pm-${i}`, 0, `/a/${i}.md`));
    const { grants } = t.sync(A, 1, sites);
    expect(grants).toHaveLength(MAX_LINKS_PER_VIEW);
    expect(grants[0]!.itemId).toBe("pm-5");
    expect(t.size).toBe(MAX_LINKS_PER_VIEW);
  });
});

describe("text and errors", () => {
  it("reads UTF-8 exactly: BOM and line endings stay, invalid bytes and NUL are not text", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0xe2, 0x82, 0xac]);
    const text = decodeUtf8Strict(bytes)!;
    expect(text).toBe("\ufeffa\r\n€");
    expect(Array.from(encodeUtf8(text))).toEqual(Array.from(bytes));
    expect(decodeUtf8Strict(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull();
    expect(decodeUtf8Strict(new Uint8Array([0x61, 0x00, 0x62]))).toBeNull();
    expect(decodeUtf8Strict(new Uint8Array())).toBe("");
  });

  it("refuses text that would change when written", () => {
    expect(isWritableText("plain € 😀 text")).toBe(true);
    expect(isWritableText("a\u0000b")).toBe(false);
    expect(isWritableText("a\ud83d")).toBe(false);
    expect(isWritableText("\ude00a")).toBe(false);
    expect(isWritableText("")).toBe(true);
  });

  it("says each error in words that name the file and what to do", () => {
    expect(documentError("not-found", "plan.md").message).toBe("plan.md does not exist.");
    expect(documentError("save-failed", "plan.md", "EACCES").message).toContain("Your edits are kept");
    expect(documentError("save-failed", "plan.md").retryable).toBe(true);
    expect(documentError("changed-on-disk", "plan.md").message).toContain("Nothing was saved");
    expect(documentError("format-unsupported", "a.pdf").message).toContain("Markdown (.md)");
    expect(documentError("unsafe-to-save", "plan.md", " (a footnote would be rewritten)").code).toBe("unsafe-to-save");
    expect(documentError("link-stale", "").retryable).toBe(false);
  });
});

describe("document requests", () => {
  const revision = "0123456789abcdef0123456789abcdef";
  const open = { method: "document.open", projectId: project, conversationId: conversation, view: 3, linkId: "k12" };

  it("accepts each request, with ids, and drops anything else it carries (never a path)", () => {
    expect(parseDesktopRequest({ ...open, path: "/etc/passwd", href: "/etc/passwd", file: "/etc/passwd" })).toEqual(open);
    expect(parseDesktopRequest({ method: "document.reload", documentId: "d4", path: "/x" })).toEqual({ method: "document.reload", documentId: "d4" });
    expect(parseDesktopRequest({ method: "document.close", documentId: "d4" })).toEqual({ method: "document.close", documentId: "d4" });
    expect(parseDesktopRequest({ method: "document.dirty", documentId: "d4", dirty: true })).toEqual({ method: "document.dirty", documentId: "d4", dirty: true });
    expect(parseDesktopRequest({ method: "document.closeResponse", requestId: "q2", outcome: "settled" })).toEqual({ method: "document.closeResponse", requestId: "q2", outcome: "settled" });
    expect(parseDesktopRequest({ method: "document.closeResponse", requestId: "q2", outcome: "cancelled" }).method).toBe("document.closeResponse");
    expect(parseDesktopRequest({ method: "document.save", documentId: "d4", revision, text: "# Hi\n", path: "/x" }))
      .toEqual({ method: "document.save", documentId: "d4", revision, text: "# Hi\n", overwrite: false });
    expect(parseDesktopRequest({ method: "document.save", documentId: "d4", revision, text: "", overwrite: true }))
      .toEqual({ method: "document.save", documentId: "d4", revision, text: "", overwrite: true });
    // The text is kept exactly: BOM, CRLF, no final newline.
    const exact = "\ufeff# Hi\r\n\r\ntext";
    expect(parseDesktopRequest({ method: "document.save", documentId: "d4", revision, text: exact })).toMatchObject({ text: exact });
  });

  it("refuses a request of the wrong shape, a forged id, a missing revision, and text that cannot be written", () => {
    const save = { method: "document.save", documentId: "d4", revision, text: "x" };
    const bad: unknown[] = [
      { ...open, linkId: undefined },
      { ...open, linkId: "../../etc/passwd" },
      { ...open, linkId: "/etc/passwd" },
      { ...open, linkId: "k" },
      { ...open, linkId: "k1234567890" },
      { ...open, linkId: 12 },
      { ...open, view: "3" },
      { ...open, view: -1 },
      { ...open, view: 1.5 },
      { ...open, projectId: "../x" },
      { ...open, conversationId: "../x" },
      { ...open, projectId: undefined },
      { ...open, conversationId: null },
      { method: "document.reload" },
      { method: "document.reload", documentId: "/etc/passwd" },
      { method: "document.reload", documentId: "d" },
      { method: "document.reload", documentId: 4 },
      { method: "document.close", documentId: "k4" },
      { method: "document.close", documentId: "d4 " },
      { method: "document.dirty", documentId: "d4" },
      { method: "document.dirty", documentId: "d4", dirty: "yes" },
      { method: "document.closeResponse", requestId: "d4", outcome: "settled" },
      { method: "document.closeResponse", requestId: "q2", outcome: "yes" },
      { method: "document.closeResponse", requestId: "q2" },
      { ...save, revision: undefined },
      { ...save, revision: "" },
      { ...save, revision: "latest" },
      { ...save, revision: "ABCDEF0123456789" },
      { ...save, revision: "0123" },
      { ...save, revision: `${revision}${revision}0` },
      { ...save, documentId: undefined },
      { ...save, documentId: "x4" },
      { ...save, text: undefined },
      { ...save, text: 12 },
      { ...save, text: { toString: () => "x" } },
      { ...save, text: "a\u0000b" },
      { ...save, text: "broken \ud83d surrogate" },
      { ...save, text: "x".repeat(MAX_DOCUMENT_CHARS + 1) },
      { ...save, overwrite: "true" },
      { ...save, overwrite: 1 },
      { method: "document.write", documentId: "d4", text: "x" },
      { method: "fs.writeFile", path: "/etc/passwd", text: "x" },
      { method: "document.open", path: "/etc/passwd" },
      "document.open",
      null,
    ];
    for (const request of bad) expect(() => parseDesktopRequest(request), JSON.stringify(request)?.slice(0, 120)).toThrow();
    expect(() => parseDesktopRequest({ ...save, text: "x".repeat(MAX_DOCUMENT_CHARS) })).not.toThrow();
  });
});

describe("who may send a document request", () => {
  const good: SenderInfo = { senderId: 3, windowId: 3, mainFrame: true, url: "agentduo://app/index.html" };
  const dispatcher = () => new Dispatcher({
    projects: { path() { throw new Error("reached projects"); } } as never,
    prefs: {} as never,
    shell: {} as never,
    logs: { add() {} } as never,
    env: () => ({}),
    launcher: () => null,
    snapshot: () => { throw new Error("reached snapshot"); },
    userData: "",
    logsDir: "",
  } satisfies DispatcherOptions);
  const request = { method: "document.save", documentId: "d4", revision: "0123456789abcdef", text: "x", overwrite: false };

  it("refuses a sender that is not the app's own window, its top frame, on the app's origin, before it looks at the request", async () => {
    const senders: SenderInfo[] = [
      { ...good, senderId: 9 },
      { ...good, windowId: null },
      { ...good, mainFrame: false },
      { ...good, url: "https://evil.example/index.html" },
      { ...good, url: "agentduo://resource/abc" },
      { ...good, url: "file:///tmp/evil.html" },
      { ...good, url: "not a url" },
    ];
    for (const sender of senders) {
      expect(trustedSender(sender)).toBe(false);
      expect(await dispatcher().handle(sender, request)).toEqual({ ok: false, error: "refused: not the app's window" });
      expect(await dispatcher().handle(sender, { method: "document.open", projectId: project, conversationId: conversation, view: 1, linkId: "k1" }))
        .toEqual({ ok: false, error: "refused: not the app's window" });
    }
  });

  it("answers a malformed document request from the right sender as an error, not an exception", async () => {
    for (const bad of [{ ...request, revision: undefined }, { ...request, documentId: "../x" }, { method: "document.open", linkId: "/etc/passwd" }]) {
      const answer = await dispatcher().handle(good, bad);
      expect(answer.ok).toBe(false);
      expect((answer as { error: string }).error).toMatch(/revision|document id|project|link id/);
    }
  });
});
