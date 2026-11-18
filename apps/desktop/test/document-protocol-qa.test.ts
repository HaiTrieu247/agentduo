// Independent T1 acceptance checks. QA owns this file; dev owns document-protocol.test.ts (R19).
// These exercise the public contract, not filesystem IO (T3) or the Markdown editor (T2/T4).
import { describe, expect, it, vi } from "vitest";
import type { TimelineItem } from "@agentduo/host/viewState";
import {
  DOCUMENT_FORMATS, DocumentLinkTable, MAX_DOCUMENT_CHARS, decodeUtf8Strict, documentError, documentLinkSites,
  encodeUtf8, formatForPath, linkTarget, type DocumentFormat, type DocumentLinkSite,
} from "../src/shared/documents.js";
import { parseDesktopRequest, ProtocolError, type SenderInfo } from "../src/shared/protocol.js";
import { Dispatcher, type DispatcherOptions } from "../src/main/ipc.js";

const projectId = "1234567890abcdef";
const conversationId = "20261118-140000-open-1234abcd";
const owner = `${projectId}/${conversationId}`;
const context = { projectId, conversationId, view: 7 };
const revision = "a".repeat(32);
const open = { method: "document.open", ...context, linkId: "k17" };
const save = { method: "document.save", documentId: "d17", revision, text: "# Original\n", overwrite: false };
const sender: SenderInfo = { senderId: 11, windowId: 11, mainFrame: true, url: "agentduo://app/index.html" };

function site(href: string, ordinal = 0, itemId = "pm-acceptance"): DocumentLinkSite {
  return { href, ordinal, itemId, part: "text" };
}

describe("T1 QA · AC1: the linked file is the original, independent of the app's OS", () => {
  it.each([
    ["/worktrees/dev-1/plan.md", "/workspace/app", "/worktrees/dev-1/plan.md", "posix"],
    ["file:///attachments/run-1/plan.md", "/workspace/app", "/attachments/run-1/plan.md", "posix"],
    ["file://localhost/attachments/plan.md", null, "/attachments/plan.md", "posix"],
    ["docs/plan.md", "/workspace/app", "/workspace/app/docs/plan.md", "posix"],
    // Main resolves POSIX symlinks: collapsing .. here could silently choose a different original file.
    ["../worktree/plan.md", "/workspace/app", "/workspace/app/../worktree/plan.md", "posix"],
    ["/workspace/linked-folder/../plan.md", "/other", "/workspace/linked-folder/../plan.md", "posix"],
    ["file:///workspace/linked-folder/%2E%2E/plan.md", null, "/workspace/linked-folder/../plan.md", "posix"],
    ["plan.md", "/workspace/app", "/workspace/app/plan.md", "posix"],
    ["D:\\worktrees\\dev-1\\plan.md", "C:\\workspace", "D:\\worktrees\\dev-1\\plan.md", "windows"],
    ["file:///d:/attachments/plan.md", "C:\\workspace", "D:\\attachments\\plan.md", "windows"],
    ["docs\\plan.md", "C:\\workspace", "C:\\workspace\\docs\\plan.md", "windows"],
    ["file://server/share/notes/../plan.md", null, "\\\\server\\share\\plan.md", "windows"],
    ["\\\\server\\share\\..\\plan.md", null, "\\\\server\\share\\plan.md", "windows"],
  ] as const)("resolves %s with workspace %s to its stated target", (href, workspace, path, style) => {
    expect(linkTarget(href, { workspace })).toEqual({ ok: true, value: { path, style, position: null, anchor: null } });
  });

  it.each([
    ["plan.md", null, "link-unresolved"],
    ["plan.md", "relative-workspace", "link-unresolved"],
    ["~/plan.md", "/workspace/app", "link-unresolved"],
    ["D:plan.md", "C:\\workspace", "link-unresolved"],
    ["https://example.test/plan.md", "/workspace/app", "link-not-file"],
    ["", "/workspace/app", "link-invalid"],
    ["docs/plan.md%00", "/workspace/app", "link-invalid"],
    ["/attachments/plan.md/", "/workspace/app", "link-invalid"],
  ] as const)("reports an explicit error for %s instead of choosing another file", (href, workspace, code) => {
    expect(linkTarget(href, { workspace })).toMatchObject({ ok: false, error: { code, message: expect.any(String) } });
  });

  it.each([
    ["docs/a%20b.md#L12C4", "/workspace/docs/a b.md", { line: 12, column: 4 }, null],
    ["docs/a%2520b.md#intro%2520one", "/workspace/docs/a%20b.md", null, "intro%20one"],
    ["docs/part%23one.md#heading", "/workspace/docs/part#one.md", null, "heading"],
    ["docs/part%3A12.md:9:2", "/workspace/docs/part:12.md", { line: 9, column: 2 }, null],
    ["file:///attachments/a%2523b.md?download=1#L8-L10", "/attachments/a%23b.md", { line: 8, column: null }, null],
    ["docs/100%.md", "/workspace/docs/100%.md", null, null],
  ] as const)("separates location and encoding from the filename: %s", (href, path, position, anchor) => {
    expect(linkTarget(href, { workspace: "/workspace" })).toEqual({ ok: true, value: { path, style: "posix", position, anchor } });
  });

  it("takes the target from the Markdown href, irrespective of its label or identical basenames", () => {
    const timeline: TimelineItem[] = [{ kind: "pm", id: "pm-acceptance", text:
      "[plan.md](/worktrees/dev-1/actual.md) [plan.md](file:///attachments/plan.md) [plan.md](docs/plan.md)" }];
    const sites = documentLinkSites(timeline);
    const table = new DocumentLinkTable();
    const { grants } = table.sync(owner, context.view, sites);
    const targets = grants.map((grant) => {
      const href = table.href(owner, context.view, grant.linkId)!;
      const result = linkTarget(href, { workspace: "/workspace" });
      if (!result.ok) throw new Error(result.error.message);
      return result.value.path;
    });
    expect(targets).toEqual(["/worktrees/dev-1/actual.md", "/attachments/plan.md", "/workspace/docs/plan.md"]);
    expect(new Set(grants.map((grant) => grant.linkId)).size).toBe(3);
  });
});

describe("T1 QA · AC1/AC8: main grants scoped IDs; the click carries no path", () => {
  it("rejects syntactically plausible but ungranted IDs and isolates project, conversation and view", () => {
    const table = new DocumentLinkTable();
    const first = table.sync(owner, 7, [site("/worktrees/a.md")]).grants[0]!;
    expect(parseDesktopRequest({ ...open, linkId: first.linkId })).toEqual({ ...open, linkId: first.linkId });
    expect(table.href(owner, 7, "k999999999")).toBeNull();
    expect(table.href(`abcdef1234567890/${conversationId}`, 7, first.linkId)).toBeNull();
    expect(table.href(`${projectId}/20261118-140001-other-1234abcd`, 7, first.linkId)).toBeNull();
    expect(table.href(owner, 8, first.linkId)).toBeNull();
    expect(table.href(owner, 7, first.linkId)).toBe("/worktrees/a.md");
    expect(Object.keys(first).sort()).toEqual(["itemId", "linkId", "ordinal", "part"]);
  });

  it("revokes changed or removed targets, gives fresh IDs on reattach and never reassigns an old ID", () => {
    const table = new DocumentLinkTable();
    const first = table.sync(owner, 7, [site("/worktrees/a.md")]).grants[0]!;
    const changed = table.sync(owner, 7, [site("/attachments/a.md")]);
    expect(changed.revoked).toContain(first.linkId);
    expect(table.href(owner, 7, first.linkId)).toBeNull();
    const second = changed.grants[0]!;
    expect(second.linkId).not.toBe(first.linkId);
    const reopened = table.sync(owner, 8, [site("/attachments/a.md")]);
    expect(reopened.revoked).toContain(second.linkId);
    expect(table.href(owner, 7, second.linkId)).toBeNull();
    const third = reopened.grants[0]!;
    expect(new Set([first.linkId, second.linkId, third.linkId]).size).toBe(3);
    expect(table.sync(owner, 8, []).revoked).toContain(third.linkId);
    expect(table.href(owner, 8, third.linkId)).toBeNull();
  });

  it("keeps IDs for unchanged links and replays them on a fresh snapshot", () => {
    const table = new DocumentLinkTable();
    const sites = [site("/worktrees/a.md")];
    const initial = table.sync(owner, 7, sites);
    expect(table.sync(owner, 7, sites)).toEqual({ grants: [], revoked: [] });
    expect(table.sync(owner, 7, sites, true)).toEqual(initial);
  });

  it("revokes only the selected project and leaves another project's links usable", () => {
    const table = new DocumentLinkTable();
    const first = table.sync(owner, 7, [site("/a.md")]).grants[0]!;
    const otherOwner = `abcdef1234567890/${conversationId}`;
    const other = table.sync(otherOwner, 7, [site("/b.md")]).grants[0]!;
    expect(table.revokeProject(projectId)).toContain(first.linkId);
    expect(table.href(owner, 7, first.linkId)).toBeNull();
    expect(table.href(otherOwner, 7, other.linkId)).toBe("/b.md");
    expect(table.revoke(otherOwner)).toContain(other.linkId);
    expect(table.href(otherOwner, 7, other.linkId)).toBeNull();
    expect(table.revoke(otherOwner)).toEqual([]);
  });

  it("adds a format through the registry while using the same grants and document.open request", () => {
    const timeline: TimelineItem[] = [{ kind: "pm", id: "pm-formats", text:
      "[web](https://example.test) [text](/files/notes.txt) [markdown](/files/notes.md#L2)" }];
    expect(documentLinkSites(timeline).map((s) => s.ordinal)).toEqual([2]);
    expect(formatForPath("/files/notes.txt")).toBeNull();
    const formats: readonly DocumentFormat[] = [...DOCUMENT_FORMATS,
      { id: "qa-text", label: "QA text", extensions: [".txt"], maxBytes: 1024 }];
    const sites = documentLinkSites(timeline, formats);
    expect(sites.map((s) => s.ordinal)).toEqual([1, 2]);
    expect(formatForPath("/files/NOTES.TXT", formats)?.id).toBe("qa-text");
    const grants = new DocumentLinkTable().sync(owner, 7, sites).grants;
    for (const grant of grants) expect(parseDesktopRequest({ ...open, linkId: grant.linkId })).toEqual({ ...open, linkId: grant.linkId });
    // The extension used by this test does not add product support for .txt.
    expect(documentLinkSites(timeline).map((s) => s.ordinal)).toEqual([2]);
  });
});

describe("T1 QA · document request validation", () => {
  const requests = [open, save,
    { method: "document.reload", documentId: "d17" },
    { method: "document.close", documentId: "d17" },
    { method: "document.dirty", documentId: "d17", dirty: true },
    { method: "document.dirty", documentId: "d17", dirty: false },
    { method: "document.closeResponse", requestId: "q17", outcome: "settled" },
    { method: "document.closeResponse", requestId: "q17", outcome: "cancelled" },
  ];

  it.each(requests)("accepts $method and discards renderer-supplied filesystem targets", (request) => {
    expect(parseDesktopRequest({ ...request, path: "/wrong/plan.md", href: "file:///wrong/plan.md", location: "/wrong/plan.md", file: "plan.md" }))
      .toEqual(request);
  });

  it.each([
    ["missing link ID", { ...open, linkId: undefined }],
    ["path as link ID", { ...open, linkId: "/worktrees/plan.md" }],
    ["link ID from another namespace", { ...open, linkId: "d17" }],
    ["missing project", { ...open, projectId: undefined }],
    ["path as project", { ...open, projectId: "../project" }],
    ["missing conversation", { ...open, conversationId: null }],
    ["invalid conversation", { ...open, conversationId: "../conversation" }],
    ["missing view", { ...open, view: undefined }],
    ["negative view", { ...open, view: -1 }],
    ["fractional view", { ...open, view: 1.5 }],
    ["infinite view", { ...open, view: Infinity }],
    ["string view", { ...open, view: "7" }],
    ["missing revision", { ...save, revision: undefined }],
    ["missing revision with overwrite", { ...save, revision: undefined, overwrite: true }],
    ["null revision", { ...save, revision: null }],
    ["nonrevision string", { ...save, revision: "latest" }],
    ["short revision", { ...save, revision: "a".repeat(15) }],
    ["oversize revision", { ...save, revision: "a".repeat(65) }],
    ["path as session ID", { ...save, documentId: "/worktrees/plan.md" }],
    ["link as session ID", { ...save, documentId: "k17" }],
    ["missing text", { ...save, text: undefined }],
    ["nontext", { ...save, text: ["# text"] }],
    ["NUL in text", { ...save, text: "before\u0000after" }],
    ["unpaired surrogate", { ...save, text: "before\ud800after" }],
    ["oversize text", { ...save, text: "x".repeat(MAX_DOCUMENT_CHARS + 1) }],
    ["string overwrite", { ...save, overwrite: "true" }],
    ["missing dirty state", { method: "document.dirty", documentId: "d17" }],
    ["string dirty state", { method: "document.dirty", documentId: "d17", dirty: "false" }],
    ["missing reload session", { method: "document.reload" }],
    ["wrong close session", { method: "document.close", documentId: "q17" }],
    ["wrong close request namespace", { method: "document.closeResponse", requestId: "d17", outcome: "settled" }],
    ["missing close outcome", { method: "document.closeResponse", requestId: "q17" }],
    ["unknown close outcome", { method: "document.closeResponse", requestId: "q17", outcome: "save" }],
  ])("refuses %s with ProtocolError", (_label, request) => {
    expect(() => parseDesktopRequest(request)).toThrow(ProtocolError);
  });

  it("accepts boundary revisions, empty files and complete Unicode without altering the requested text", () => {
    for (const revision of ["a".repeat(16), "a".repeat(64)]) {
      for (const text of ["", "\ufeff# Tiếng Việt\r\n\r\n**đậm** 😀", "x".repeat(MAX_DOCUMENT_CHARS)]) {
        expect(parseDesktopRequest({ ...save, revision, text })).toEqual({ ...save, revision, text });
      }
    }
    const { overwrite: _overwrite, ...implicit } = save;
    expect(parseDesktopRequest(implicit)).toEqual(save);
    expect(parseDesktopRequest({ ...save, overwrite: true })).toEqual({ ...save, overwrite: true });
  });
});

describe("T1 QA · renderer/main boundary", () => {
  function dispatcher() {
    const touched = vi.fn(() => { throw new Error("a refused request must not reach application services"); });
    const service = new Proxy({}, { get: touched });
    const d = new Dispatcher({
      projects: service as never, prefs: service as never, shell: service as never, logs: service as never,
      env: touched, launcher: touched, snapshot: touched, userData: "", logsDir: "",
    } satisfies DispatcherOptions);
    return { d, touched };
  }

  it.each([
    ["another window", { ...sender, senderId: 12 }],
    ["no window", { ...sender, windowId: null }],
    ["child frame", { ...sender, mainFrame: false }],
    ["web origin", { ...sender, url: "https://example.test/" }],
    ["local file page", { ...sender, url: "file:///tmp/index.html" }],
    ["resource origin", { ...sender, url: "agentduo://resource/token" }],
    ["similar host", { ...sender, url: "agentduo://app.example.test/index.html" }],
  ] as const)("refuses every document operation from %s before reading its payload", async (_label, badSender) => {
    const { d, touched } = dispatcher();
    for (const request of [open, save,
      { method: "document.reload", documentId: "d17" },
      { method: "document.dirty", documentId: "d17", dirty: false },
      { method: "document.close", documentId: "d17" },
      { method: "document.closeResponse", requestId: "q17", outcome: "settled" },
    ]) {
      const readPayload = vi.fn((target: object, key: string | symbol) => Reflect.get(target, key));
      expect(await d.handle(badSender, new Proxy(request, { get: readPayload })))
        .toEqual({ ok: false, error: "refused: not the app's window" });
      expect(readPayload).not.toHaveBeenCalled();
    }
    expect(touched).not.toHaveBeenCalled();
  });

  it("answers missing-revision requests as validation errors before reaching document services", async () => {
    const { d, touched } = dispatcher();
    expect(await d.handle(sender, { ...save, revision: undefined })).toEqual({ ok: false, error: expect.stringMatching(/revision/i) });
    expect(touched).not.toHaveBeenCalled();
  });
});

describe("T1 QA · AC5/AC6: lossless text and explicit refusal contracts", () => {
  it.each(["", "\ufeff# Heading\r\n\r\n---\r\nkey: value", "<aside>raw</aside>\n\n[^x]: note", "```ts\nconst x = '😀';\n```"])(
    "preserves UTF-8, BOM, line endings and unsupported Markdown as opaque source: %j", (source) => {
      const bytes = encodeUtf8(source);
      expect(decodeUtf8Strict(bytes)).toBe(source);
      expect(Array.from(encodeUtf8(decodeUtf8Strict(bytes)!))).toEqual(Array.from(bytes));
    });

  it.each([[0xff], [0xe2, 0x82], [0xc0, 0xaf], [0x61, 0x00, 0x62]])("refuses unreadable bytes instead of replacement characters: %j", (...bytes) => {
    expect(decodeUtf8Strict(new Uint8Array(bytes))).toBeNull();
  });

  it("provides a distinct unsafe-save error with the construct's reason and a retryable save failure", () => {
    const unsafe = documentError("unsafe-to-save", "plan.md", "footnote definition, line 8");
    expect(unsafe.code).toBe("unsafe-to-save");
    expect(unsafe.message).toContain("plan.md");
    expect(unsafe.message).toContain("footnote definition, line 8");
    expect(unsafe.message).toMatch(/untouched|nothing.*sav|not saved/i);
    expect(documentError("save-failed", "plan.md", "EACCES")).toMatchObject({
      code: "save-failed", retryable: true, message: expect.stringContaining("EACCES"),
    });
  });
});
