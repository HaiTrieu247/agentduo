// Independent QA controller cases (AC3–AC7). QA owns this file, separate from document-view.test.ts (R19).
// No browser needed: a controlled viewer represents user edits and deferred promises represent main's responses.
import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@agentduo/engine/testing/tmp";
import { DocumentService } from "../src/main/documents.js";
import { DocumentController, type ControllerDeps, type LeaveChoice, type OpenLink } from "../src/renderer/documents.js";
import type { DocumentViewer, ViewerContext } from "../src/renderer/markdown-editor.js";
import type { DocumentInfo, DocumentOpened, DocumentSaved } from "../src/shared/documents.js";
import type { DesktopEvent, DesktopRequest } from "../src/shared/protocol.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const info = (id: string, text = `# ${id}\n`, revision = "a".repeat(16)): DocumentInfo => ({
  documentId: id, format: "markdown", name: `${id}.md`, location: `/repo/${id}.md`, text, revision,
  position: null, anchor: null, save: { allowed: true }, origin: { projectId: "p1", conversationId: "c1" },
});
const opened = (document: DocumentInfo): DocumentOpened => ({ ok: true, document, existing: false });
const link = (n: number): OpenLink => ({ projectId: "p1", conversationId: "c1", view: 1, linkId: `k${n}`, label: `document ${n}` });

class UserDraft implements DocumentViewer {
  readonly element = {} as HTMLElement;
  private changed = false;
  value: string;
  unsafe = false;
  destroyed = false;
  constructor(private readonly context: ViewerContext) { this.value = context.info.text; }
  type(value: string): void { this.value = value; this.changed = true; this.context.changed(); }
  edited = () => this.changed;
  text = () => this.unsafe ? { ok: false as const, reasons: ["Unsupported edit would lose the original structure"] }
    : { ok: true as const, text: this.value };
  notices = () => [];
  reveal() {}
  focus() {}
  destroy() { this.destroyed = true; }
}

function setup(choice: LeaveChoice = "keep") {
  const requests: DesktopRequest[] = [];
  const drafts: UserDraft[] = [];
  const reads = new Map<string, Promise<DocumentOpened>>();
  const saves: Array<Promise<DocumentSaved>> = [];
  let reload = Promise.resolve(opened(info("d1", "# Reloaded\n", "c".repeat(16))));
  const request: ControllerDeps["request"] = (async (r: DesktopRequest): Promise<unknown> => {
    requests.push(r);
    switch (r.method) {
      case "document.open": return reads.get(r.linkId) ?? opened(info(`d${r.linkId.slice(1)}`));
      case "document.save": return saves.shift() ?? { ok: true, revision: "b".repeat(16) };
      case "document.reload": return reload;
      case "document.dirty": return { recorded: true };
      case "document.close": return { closed: true };
      case "document.closeResponse": return { accepted: true };
      default: throw new Error(`Unexpected request: ${r.method}`);
    }
  }) as ControllerDeps["request"];
  const controller = new DocumentController({ request, ask: async () => choice, confirm: async () => true,
    viewers: { markdown: (context) => { const draft = new UserDraft(context); drafts.push(draft); return draft; } } });
  return { controller, requests, drafts, reads, saves, reloadWith: (value: Promise<DocumentOpened>) => { reload = value; } };
}

describe("T4 independent QA — late reads cannot undo a completed leave (AC6, AC7)", () => {
  it.each(["clean", "dirty-discard", "dirty-save"])("does not reopen a document after %s navigation completed", async (mode) => {
    const h = setup(mode === "dirty-save" ? "save" : "discard");
    await h.controller.openLink(link(1));
    const draft = h.drafts[0]!;
    if (mode !== "clean") draft.type("# User's pending edit\n");
    const read = deferred<DocumentOpened>();
    h.reads.set("k2", read.promise);
    const opening = h.controller.openLink(link(2));
    expect(h.requests.at(-1)).toMatchObject({ method: "document.open", linkId: "k2" });
    // This is what main.ts awaits before switching project/conversation or covering the document with Settings.
    expect(await h.controller.leave("leave")).toBe(true);
    expect(h.controller.document).toBeNull();
    read.resolve(opened(info("d2")));
    await opening;
    expect(h.controller.document, "a response from before leaving must not show a document in the new context").toBeNull();
    expect(h.controller.shown).toBe(false);
    expect(h.requests).toContainEqual({ method: "document.close", documentId: "d2" });
    expect(draft.destroyed).toBe(true);
  });

  it("keeps the winner's text when an earlier open answers after a newer document is edited", async () => {
    const h = setup();
    const read = deferred<DocumentOpened>();
    h.reads.set("k1", read.promise);
    const earlier = h.controller.openLink(link(1));
    await h.controller.openLink(link(2));
    const winner = h.drafts[0]!;
    winner.type("# New document draft\n");
    read.resolve(opened(info("d1")));
    await earlier;
    expect(h.controller.document?.documentId).toBe("d2");
    expect(h.controller.viewer).toBe(winner);
    expect(winner.value).toBe("# New document draft\n");
    expect(h.controller.dirty()).toBe(true);
    expect(h.requests).toContainEqual({ method: "document.close", documentId: "d1" });
  });

  it("deduplicated reopening of the same file retains the actual unsaved draft", async () => {
    const h = setup();
    await h.controller.openLink(link(1));
    const draft = h.drafts[0]!;
    draft.type("# Keep my draft\n");
    h.reads.set("k2", Promise.resolve({ ...opened(info("d1", "# Old disk text\n")), existing: true }));
    await h.controller.openLink(link(2));
    expect(h.controller.viewer).toBe(draft);
    expect(draft.value).toBe("# Keep my draft\n");
    expect(h.controller.dirty()).toBe(true);
    expect(draft.destroyed).toBe(false);
  });
});

describe("T4 independent QA — save/reload boundaries (AC3–AC7)", () => {
  it("two concurrent opens of the same file leave the winning session usable for an explicit save", async () => {
    const scratch = tempDir();
    const target = join(scratch.path, "notes.md");
    writeFileSync(target, "# Original\n");
    const events: DesktopEvent[] = [];
    const service = new DocumentService({ post: (event) => events.push(event) });
    try {
      const projectId = "1111111111111111";
      const conversationId = "20261118-120000-qa";
      service.syncLinks(projectId, conversationId, 1, [{ id: "pm1", kind: "pm", text: "[first](notes.md) [again](notes.md)" }], true);
      const grants = events.find((event) => event.type === "documentLinks");
      if (!grants || grants.type !== "documentLinks") throw new Error("Expected real service link grants");
      const first = { ready: deferred<DocumentOpened>(), delivery: deferred<void>() };
      const second = { ready: deferred<DocumentOpened>(), delivery: deferred<void>() };
      const deliveries = new Map([[grants.links[0]!.linkId, first], [grants.links[1]!.linkId, second]]);
      let draft: UserDraft | undefined;
      const request: ControllerDeps["request"] = (async (r: DesktopRequest): Promise<unknown> => {
        switch (r.method) {
          case "document.open": {
            const result = await service.open({ ...r, workspace: scratch.path });
            const gate = deliveries.get(r.linkId)!;
            gate.ready.resolve(result);
            await gate.delivery.promise;
            return result;
          }
          case "document.close": service.close(r.documentId); return { closed: true };
          case "document.dirty": service.setDirty(r.documentId, r.dirty); return { recorded: true };
          case "document.save": return service.save(r.documentId, r.revision, r.text, r.overwrite);
          default: throw new Error(`Unexpected ${r.method}`);
        }
      }) as ControllerDeps["request"];
      const controller = new DocumentController({ request, ask: async () => "keep", confirm: async () => true,
        viewers: { markdown: (ctx) => { draft = new UserDraft(ctx); return draft; } } });
      const oldOpen = controller.openLink({ ...link(1), projectId, conversationId, linkId: grants.links[0]!.linkId });
      const winningOpen = controller.openLink({ ...link(2), projectId, conversationId, linkId: grants.links[1]!.linkId });
      const [a, b] = await Promise.all([first.ready.promise, second.ready.promise]);
      expect(a.ok && b.ok && a.document.documentId === b.document.documentId, "R39: main returns one shared session").toBe(true);
      first.delivery.resolve();
      await oldOpen;
      second.delivery.resolve();
      await winningOpen;
      expect(controller.document).not.toBeNull();
      draft!.type("# Edited winner\n");
      const saved = await controller.save();
      expect({ saved, error: controller.problem?.error.code }, "discarding an old result must not close the winning shared session")
        .toEqual({ saved: true, error: undefined });
      expect(readFileSync(target, "utf8")).toBe("# Edited winner\n");
    } finally {
      service.dispose();
      scratch.cleanup();
    }
  });

  it("a successful save of an earlier draft keeps newer typing dirty and uses the returned revision next time", async () => {
    const h = setup();
    await h.controller.openLink(link(1));
    const draft = h.drafts[0]!;
    draft.type("# First\n");
    const write = deferred<DocumentSaved>();
    h.saves.push(write.promise);
    const saving = h.controller.save();
    draft.type("# Later\n");
    write.resolve({ ok: true, revision: "e".repeat(16) });
    expect(await saving).toBe(true);
    expect(h.controller.dirty()).toBe(true);
    expect(h.controller.status).toBe("dirty");
    expect(await h.controller.save()).toBe(true);
    expect(h.requests.filter((r) => r.method === "document.save")).toEqual([
      { method: "document.save", documentId: "d1", revision: "a".repeat(16), text: "# First\n", overwrite: false },
      { method: "document.save", documentId: "d1", revision: "e".repeat(16), text: "# Later\n", overwrite: false },
    ]);
    expect(h.controller.dirty()).toBe(false);
  });

  it("refuses an unsafe conversion without sending any text to main", async () => {
    const h = setup();
    await h.controller.openLink(link(1));
    h.drafts[0]!.type("# Unsafe edit\n");
    h.drafts[0]!.unsafe = true;
    expect(await h.controller.save()).toBe(false);
    expect(h.controller.problem?.error.code).toBe("unsafe-to-save");
    expect(h.controller.dirty()).toBe(true);
    expect(h.requests.some((r) => r.method === "document.save")).toBe(false);
  });

  it("failed native-close Save cancels closing and preserves the viewer for retry", async () => {
    const h = setup("save");
    await h.controller.openLink(link(1));
    const draft = h.drafts[0]!;
    draft.type("# Retry this\n");
    h.saves.push(Promise.resolve({ ok: false, error: { code: "save-failed", retryable: true, message: "Controlled failure" } }));
    await h.controller.closeRequest({ type: "documentCloseRequest", requestId: "q9", reason: "quit", documentIds: ["d1"] });
    expect(h.requests.at(-1)).toEqual({ method: "document.closeResponse", requestId: "q9", outcome: "cancelled" });
    expect(h.controller.viewer).toBe(draft);
    expect(draft.value).toBe("# Retry this\n");
    expect(h.controller.dirty()).toBe(true);
    expect(draft.destroyed).toBe(false);
    expect(await h.controller.save()).toBe(true);
  });

  it("a reload answered after new typing retains the draft and its original revision", async () => {
    const h = setup();
    await h.controller.openLink(link(1));
    const draft = h.drafts[0]!;
    draft.type("# Before reload\n");
    const read = deferred<DocumentOpened>();
    h.reloadWith(read.promise);
    const reloading = h.controller.reload();
    // Await the controller's confirmation, so the reload is actually in flight before the next keystroke.
    await Promise.resolve();
    expect(h.requests.at(-1)?.method).toBe("document.reload");
    draft.type("# Typed while reading\n");
    read.resolve(opened(info("d1", "# From disk\n", "f".repeat(16))));
    expect(await reloading).toBe(false);
    expect(h.controller.viewer).toBe(draft);
    expect(h.controller.problem?.error.code).toBe("reload-superseded");
    expect(h.controller.dirty()).toBe(true);
    await h.controller.save();
    expect(h.requests.filter((r) => r.method === "document.save")).toEqual([
      { method: "document.save", documentId: "d1", revision: "a".repeat(16), text: "# Typed while reading\n", overwrite: false },
    ]);
  });
});
