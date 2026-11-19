// "Mở" in the page (T4): the editor's edits on T2's trees keep every byte nobody touched and write what was edited so it
// reads back the same; the controller's decisions (open, unsaved, save, leave, main's close requests) with a fake main
// and a fake viewer; the chat's link ids; and the chat drawing its links with the ordinals main counts. The DOM of the
// editor itself is exercised by the Electron E2E (test/e2e).
import { describe, expect, it, vi } from "vitest";
import { markdownLinkRefs, type DocumentInfo } from "../src/shared/documents.js";
import { parseMarkdownDocument, type MdBlock, type MdInline } from "../src/shared/markdown-document.js";
import {
  caretLength, containerOf, nodeAt, prune, reconcileInlines, removeAt, replaceAt, setTextKind, slug, splitAt, tidyInlines, toggleList, type DocumentViewer, type ViewerContext,
} from "../src/renderer/markdown-editor.js";
import { DocumentController, leaveQuestion, type ControllerDeps, type LeaveChoice } from "../src/renderer/documents.js";
import { applyGrants, markLink, siteKey } from "../src/renderer/chat.js";

// ------------------------------------------------------------------ helpers
const text = (value: string): MdInline => ({ type: "text", value });

/** The document after the block `id`'s tree is changed by `edit`, serialized. */
function edit(source: string, index: number, change: (tree: MdBlock[]) => MdBlock[]): { text: string; ok: boolean; reasons: string[] } {
  const doc = parseMarkdownDocument(source);
  const id = doc.blocks[index]!.id;
  const next = doc.replaceNodes(id, prune(change(doc.structure(id))));
  const r = next.serialize();
  return r.ok ? { ok: true, text: r.text, reasons: [] } : { ok: false, text: "", reasons: r.blocks.map((b) => b.message) };
}

/** The text of a paragraph or heading at `path`, changed by `f` (as typing does: what is read back, reconciled). */
const retext = (tree: MdBlock[], path: number[], f: (inlines: MdInline[]) => MdInline[]): MdBlock[] => {
  const node = nodeAt(tree, path) as Extract<MdBlock, { type: "paragraph" }>;
  return replaceAt(tree, path, [{ ...node, inlines: reconcileInlines(node.inlines, tidyInlines(f(node.inlines.map(strip)))) }]);
};

/** A node as the page reads it back: no source. */
function strip(n: MdInline): MdInline {
  const { source: _source, ...rest } = n as MdInline & { source?: string };
  if (rest.type === "emphasis" || rest.type === "strong" || rest.type === "link") return { ...rest, children: rest.children.map(strip) } as MdInline;
  return rest as MdInline;
}

// ------------------------------------------------------------------ the editor's edits (AC2, AC5)
describe("editing on the formatted text keeps what was not edited, byte for byte", () => {
  const FILE = "\ufeff# Tiêu đề\r\n\r\nMột đoạn có **đậm**, *nghiêng*, [liên kết](a.md \"t\") và `mã`.\r\n\r\n- một\r\n- hai\r\n\r\n```ts\r\nconst a = 1;\r\n```\r\n\r\n<div>html</div>\r\n\r\nCuối";

  it("changing one word of a paragraph rewrites that word only: the marks, the link, the BOM and CRLF stay", () => {
    const r = edit(FILE, 1, (t) => retext(t, [0], (ins) => ins.map((n) => (n.type === "text" && n.value.startsWith("Một đoạn") ? text("Một câu có ") : n))));
    expect(r.ok).toBe(true);
    expect(r.text).toBe(FILE.replace("Một đoạn có", "Một câu có"));
  });

  it("a heading's text and its level", () => {
    const a = edit(FILE, 0, (t) => retext(t, [0], () => [text("Tiêu đề mới")]));
    expect(a.text).toBe(FILE.replace("# Tiêu đề", "# Tiêu đề mới"));
    const b = edit(FILE, 0, (t) => setTextKind(t, [0], { type: "heading", level: 2 }));
    expect(b.text).toBe(FILE.replace("# Tiêu đề", "## Tiêu đề"));
    const c = edit(FILE, 0, (t) => setTextKind(t, [0], { type: "paragraph" }));
    expect(c.text).toBe(FILE.replace("# Tiêu đề", "Tiêu đề"));
  });

  it("bold and italic added around part of a text, and taken off", () => {
    const on = edit(FILE, 5, (t) => retext(t, [0], () => [{ type: "strong", children: [text("Cu")] }, text("ối")]));
    expect(on.text).toBe(FILE.replace(/Cuối$/, "**Cu**ối"));
    const off = edit(FILE, 1, (t) => retext(t, [0], (ins) => ins.flatMap((n) => (n.type === "strong" ? n.children : n.type === "emphasis" ? [{ type: "emphasis", children: n.children }] as MdInline[] : [n]))));
    expect(off.ok).toBe(true);
    expect(off.text).toBe(FILE.replace("**đậm**", "đậm"));
  });

  it("a link's label and its target, also a target with spaces, parentheses and a backslash (written so it reads back the same)", () => {
    const label = edit(FILE, 1, (t) => retext(t, [0], (ins) => ins.map((n) => (n.type === "link" ? { ...n, children: [text("nhãn mới")] } : n))));
    expect(label.text).toBe(FILE.replace("[liên kết](a.md \"t\")", "[nhãn mới](a.md \"t\")"));
    for (const dest of ["docs/my notes.md", "docs/plan (1).md", "C:\\x\\a b.md", "a)b.md"]) {
      const r = edit(FILE, 1, (t) => retext(t, [0], (ins) => ins.map((n) => (n.type === "link" ? { ...n, destination: dest } : n))));
      expect(r.ok, dest).toBe(true);
      const reread = parseMarkdownDocument(r.text);
      const link = (reread.structure(reread.blocks[1]!.id)[0] as Extract<MdBlock, { type: "paragraph" }>).inlines.find((n) => n.type === "link") as Extract<MdInline, { type: "link" }>;
      expect(link.destination, dest).toBe(dest);
      expect(link.title).toBe("t");
    }
  });

  it("a code block's content, with a fence line inside it (the fence grows so the content stays code)", () => {
    const r = edit(FILE, 3, (t) => [{ ...(t[0] as Extract<MdBlock, { type: "code" }>), value: "const a = 2;\n```\nstill code" }]);
    expect(r.ok).toBe(true);
    const reread = parseMarkdownDocument(r.text);
    const code = reread.structure(reread.blocks[3]!.id)[0] as Extract<MdBlock, { type: "code" }>;
    expect(code.value).toBe("const a = 2;\n```\nstill code");
    expect(r.text.startsWith(FILE.slice(0, FILE.indexOf("```ts")))).toBe(true);
    expect(r.text.endsWith(FILE.slice(FILE.indexOf("\r\n\r\n<div>")))).toBe(true);
  });

  it("Enter in a list item makes the next item; Enter in an empty last item leaves the list", () => {
    const doc = parseMarkdownDocument(FILE);
    const id = doc.blocks[2]!.id;
    const tree = doc.structure(id);
    const item = nodeAt(tree, [0, 1, 0]) as Extract<MdBlock, { type: "paragraph" }>;
    const split = splitAt(tree, [0, 1, 0], reconcileInlines(item.inlines, [text("h")]), reconcileInlines(item.inlines, [text("ai")]));
    expect(split.focus).toEqual([0, 2, 0]);
    const r = doc.replaceNodes(id, prune(split.tree)).serialize();
    expect(r.ok && r.text).toBe(FILE.replace("- hai", "- h\r\n- ai"));
    // A new empty item at the end is not written (it cannot be read back as an item); Enter in it leaves the list.
    const added = splitAt(split.tree, [0, 2, 0], [text("ai")], []);
    expect(doc.replaceNodes(id, prune(added.tree)).serialize()).toEqual(r);
    const left = splitAt(added.tree, added.focus, [], []);
    expect(left.focus).toEqual([1]);
    expect(nodeAt(left.tree, [1])).toEqual({ type: "paragraph", inlines: [] });
  });

  it("Enter in a paragraph or a heading splits it", () => {
    const tree: MdBlock[] = [{ type: "heading", level: 2, inlines: [text("ab")] }];
    expect(splitAt(tree, [0], [text("a")], [text("b")]).tree).toEqual([{ type: "heading", level: 2, inlines: [text("a")] }, { type: "paragraph", inlines: [text("b")] }]);
    expect(splitAt(tree, [0], [], [text("ab")])).toEqual({ tree: [{ type: "paragraph", inlines: [] }, { type: "heading", level: 2, inlines: [text("ab")] }], focus: [1] });
    const r = edit("one two\n\nnext\n", 0, (t) => splitAt(t, [0], [text("one")], [text("two")]).tree);
    expect(r.text).toBe("one\n\ntwo\n\nnext\n");
  });

  it("the list buttons: a paragraph becomes a list, a list changes kind, an item leaves its list", () => {
    const made = toggleList([{ type: "paragraph", inlines: [text("x")] }], [0], false);
    expect(made.focus).toEqual([0, 0, 0]);
    expect(edit("x\n", 0, (t) => toggleList(t, [0], false).tree).text).toBe("- x\n");
    expect(edit("- a\n- b\n", 0, (t) => toggleList(t, [0, 1, 0], true).tree).text).toBe("1. a\n2. b\n");
    const out = edit("- a\n- b\n- c\n", 0, (t) => toggleList(t, [0, 1, 0], false).tree);
    expect(out.ok).toBe(true);
    expect(parseMarkdownDocument(out.text).blocks.map((b) => b.kind)).toEqual(["list", "paragraph", "list"]);
  });

  it("paths: a node in a quote and in a list item, replaced and removed (an emptied item and list go)", () => {
    const tree = parseMarkdownDocument("> - a\n>   b\n").structure("b1");
    expect(nodeAt(tree, [0, 0, 0, 0])).toMatchObject({ type: "paragraph" });
    expect(containerOf([0, 0, 0, 0], tree)).toEqual({ kind: "item", listPath: [0, 0], item: 0, index: 0 });
    expect(containerOf([0, 0], tree)).toEqual({ kind: "quote", index: 0 });
    expect(removeAt(tree, [0, 0, 0, 0])).toEqual([]);
    expect(() => replaceAt(tree, [3], [])).toThrow();
  });

  it("a construct the editor cannot rewrite is kept: a document with one opens and saves unchanged", () => {
    const doc = parseMarkdownDocument(FILE);
    expect(doc.blocks.find((b) => !b.editable)?.construct).toBe("html block");
    expect(doc.notices.length).toBe(1);
    expect(doc.serialize()).toEqual({ ok: true, text: FILE });
  });

  it("typing a text back to what it was leaves nothing to save", () => {
    const doc = parseMarkdownDocument(FILE);
    const id = doc.blocks[5]!.id;
    const changed = doc.replaceNodes(id, retext(doc.structure(id), [0], () => [text("Cuối!")]));
    expect(changed.edited).toBe(true);
    const back = changed.replaceNodes(id, retext(changed.structure(id), [0], () => [text("Cuối")]));
    expect(back.edited).toBe(false);
  });

  it("reconciling keeps the sources of the unchanged ends (escapes stay as written)", () => {
    const doc = parseMarkdownDocument("a \\* b and \\_c\\_ end\n");
    const tree = doc.structure("b1");
    const r = edit("a \\* b and \\_c\\_ end\n", 0, () => retext(tree, [0], (ins) => ins.map((n) => (n.type === "text" ? text(n.value.replace(" and ", " or ")) : n))));
    expect(r.text).toBe("a \\* b or \\_c\\_ end\n");
  });

  it("the caret's count: text, a line break as one, a raw part as its text, and a fragment as its children (not 0)", () => {
    type N = { nodeType: number; data?: string; tagName?: string; dataset?: Record<string, string>; textContent?: string; childNodes: N[] };
    const t = (data: string): N => ({ nodeType: 3, data, childNodes: [] });
    const elem = (tagName: string, childNodes: N[], dataset: Record<string, string> = {}): N =>
      ({ nodeType: 1, tagName, dataset, childNodes, textContent: childNodes.map((c) => c.data ?? c.textContent ?? "").join("") });
    const node = (n: N) => n as unknown as Node;
    // What `Range.cloneContents()` gives for a caret after "Hel" in "Hello": a fragment (nodeType 11).
    expect(caretLength(node({ nodeType: 11, childNodes: [t("Hel")] }))).toBe(3);
    expect(caretLength(node({ nodeType: 11, childNodes: [t("a "), elem("STRONG", [t("bc")]), elem("BR", []), elem("SPAN", [t("<x>")], { raw: "0" })] }))).toBe(8);
    expect(caretLength(node({ nodeType: 11, childNodes: [] }))).toBe(0);
    expect(caretLength(node(elem("EM", [t("ab"), elem("A", [t("cd")])])))).toBe(4);
    expect(caretLength(node({ nodeType: 8, childNodes: [] }))).toBe(0);
  });

  it("anchors are matched as GitHub writes them", () => {
    expect(slug("Tiêu đề: Một (hai)")).toBe("tiêu-đề-một-hai");
    expect(slug("API v2_x")).toBe("api-v2_x");
  });
});

// ------------------------------------------------------------------ the controller (AC3, AC4, AC6, AC7)
function info(over: Partial<DocumentInfo> = {}): DocumentInfo {
  return {
    documentId: "d1", format: "markdown", name: "notes.md", location: "/repo/docs/notes.md", revision: "a".repeat(16), text: "# Notes\n",
    position: null, anchor: null, save: { allowed: true }, origin: { projectId: "p1", conversationId: "c1" }, ...over,
  };
}

class FakeViewer implements DocumentViewer {
  element = {} as HTMLElement;
  editedNow = false;
  output: { ok: true; text: string } | { ok: false; reasons: string[] } = { ok: true, text: "# Notes edited\n" };
  destroyed = false;
  focused = 0;
  constructor(readonly ctx: ViewerContext) {}
  type(): void {
    this.editedNow = true;
    this.ctx.changed();
  }
  edited = () => this.editedNow;
  text = () => this.output;
  notices = () => [];
  reveal = vi.fn();
  focus = () => void this.focused++;
  destroy = () => void (this.destroyed = true);
}

interface Pending { resolve(v: unknown): void; reject(e: unknown): void }

function setup(o: { answers?: LeaveChoice[]; confirm?: boolean; opened?: DocumentInfo[] } = {}) {
  const requests: Array<Record<string, unknown>> = [];
  const viewers: FakeViewer[] = [];
  const answers = [...(o.answers ?? [])];
  const opened = [...(o.opened ?? [info()])];
  let held: Pending | null = null;
  let holdSave = false;
  let holdReload: ((v: unknown) => void) | null | false = null;
  const saveResults: unknown[] = [];
  const asked: Array<{ name: string; reason: string }> = [];
  const deps: ControllerDeps = {
    request: (async (r: Record<string, unknown>) => {
      requests.push(r);
      switch (r.method) {
        case "document.open": {
          const next = opened.shift();
          return next ? { ok: true, document: next, existing: false } : { ok: false, error: { code: "not-found", retryable: true, message: "docs/x.md does not exist." } };
        }
        case "document.reload":
          if (holdReload === false) return new Promise((resolve) => (holdReload = resolve as (v: unknown) => void));
          return { ok: true, document: info({ revision: "c".repeat(16), text: "# From disk\n" }), existing: true };
        case "document.save":
          if (holdSave) return new Promise((resolve, reject) => (held = { resolve, reject }));
          return saveResults.shift() ?? { ok: true, revision: "b".repeat(16) };
        case "document.dirty":
          return { recorded: true };
        case "document.close":
          return { closed: true };
        case "document.closeResponse":
          return { accepted: true };
      }
      throw new Error(`unexpected ${String(r.method)}`);
    }) as ControllerDeps["request"],
    ask: async (q) => {
      asked.push(q);
      return answers.shift() ?? "keep";
    },
    confirm: async () => o.confirm ?? true,
    viewers: {
      markdown: (ctx) => {
        const v = new FakeViewer(ctx);
        viewers.push(v);
        return v;
      },
    },
  };
  const c = new DocumentController(deps);
  const link = { projectId: "p1", conversationId: "c1", view: 3, linkId: "k7", label: "notes" };
  return {
    c, requests, viewers, asked, link, saveResults,
    methods: () => requests.map((r) => r.method),
    hold: () => (holdSave = true),
    /** The next reload is answered only by `answerReload`. */
    holdReload: () => (holdReload = false),
    answerReload: () => {
      const answer = holdReload as (v: unknown) => void;
      holdReload = null;
      answer({ ok: true, document: info({ revision: "c".repeat(16), text: "# From disk\n" }), existing: true });
    },
    release: (v: unknown) => {
      holdSave = false;
      held!.resolve(v);
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the document controller", () => {
  it("opens a link by its id only (no path), shows the document and where it pointed", async () => {
    const t = setup({ opened: [info({ position: { line: 4, column: null } })] });
    await t.c.openLink(t.link);
    expect(t.requests[0]).toEqual({ method: "document.open", projectId: "p1", conversationId: "c1", view: 3, linkId: "k7" });
    expect(t.c.document?.name).toBe("notes.md");
    expect(t.c.status).toBe("clean");
    expect(t.viewers[0]!.reveal).toHaveBeenCalledWith({ line: 4, column: null }, null);
    expect(t.viewers[0]!.ctx.readOnly).toBe(false);
  });

  it("shows why a link did not open, with a retry when it may work later, and keeps an open document as it is", async () => {
    const t = setup({ opened: [] });
    await t.c.openLink(t.link);
    expect(t.c.document).toBeNull();
    expect(t.c.shown).toBe(true);
    expect(t.c.openError?.error.message).toBe("docs/x.md does not exist.");
    expect(t.c.openError?.retry).toBeTypeOf("function");
    const u = setup({ opened: [info()] });
    await u.c.openLink(u.link);
    u.viewers[0]!.type();
    await u.c.openLink({ ...u.link, linkId: "k8" });
    expect(u.c.document?.documentId).toBe("d1");
    expect(u.c.problem?.context).toBe("open");
    expect(u.c.dirty()).toBe(true);
  });

  it("a second click on the same file keeps it and its edits", async () => {
    const t = setup({ opened: [info(), info()] });
    await t.c.openLink(t.link);
    t.viewers[0]!.type();
    await t.c.openLink(t.link);
    expect(t.viewers.length).toBe(1);
    expect(t.c.dirty()).toBe(true);
    expect(t.asked).toEqual([]);
  });

  it("an edit marks it unsaved and tells main once; the file is written only by Save", async () => {
    const t = setup();
    await t.c.openLink(t.link);
    t.viewers[0]!.type();
    t.viewers[0]!.type();
    expect(t.c.status).toBe("dirty");
    expect(t.requests.filter((r) => r.method === "document.dirty")).toEqual([{ method: "document.dirty", documentId: "d1", dirty: true }]);
    expect(t.methods()).not.toContain("document.save");
    expect(await t.c.save()).toBe(true);
    expect(t.requests.find((r) => r.method === "document.save")).toEqual({ method: "document.save", documentId: "d1", revision: "a".repeat(16), text: "# Notes edited\n", overwrite: false });
    expect(t.c.status).toBe("saved");
    expect(t.requests.filter((r) => r.method === "document.dirty").at(-1)).toEqual({ method: "document.dirty", documentId: "d1", dirty: false });
    // The next save names the revision the last one wrote.
    t.viewers[0]!.type();
    await t.c.save();
    expect(t.requests.filter((r) => r.method === "document.save")[1]!.revision).toBe("b".repeat(16));
  });

  it("typing while a save is on its way leaves the document unsaved after it", async () => {
    const t = setup();
    await t.c.openLink(t.link);
    t.viewers[0]!.type();
    t.hold();
    const saving = t.c.save();
    await flush();
    expect(t.c.status).toBe("saving");
    expect(t.c.canSave).toBe(false);
    t.viewers[0]!.type();
    t.release({ ok: true, revision: "b".repeat(16) });
    expect(await saving).toBe(true);
    expect(t.c.status).toBe("dirty");
    expect(t.c.dirty()).toBe(true);
  });

  it("a failed save keeps the edits and offers to try again; a file changed on disk offers reload or overwrite", async () => {
    const t = setup();
    await t.c.openLink(t.link);
    t.viewers[0]!.type();
    t.saveResults.push({ ok: false, error: { code: "save-failed", retryable: true, message: "Could not save notes.md: EACCES. Your edits are kept: try again." } });
    expect(await t.c.save()).toBe(false);
    expect(t.c.status).toBe("error");
    expect(t.c.problem).toMatchObject({ actions: ["retry"], context: "save" });
    expect(t.c.dirty()).toBe(true);
    expect(t.viewers[0]!.destroyed).toBe(false);
    t.saveResults.push({ ok: false, error: { code: "changed-on-disk", retryable: true, message: "changed" } });
    await t.c.save();
    expect(t.c.problem?.actions).toEqual(["reload", "overwrite"]);
    expect(await t.c.overwrite()).toBe(true);
    expect(t.requests.filter((r) => r.method === "document.save").at(-1)!.overwrite).toBe(true);
    expect(t.c.problem).toBeNull();
  });

  it("reload from disk asks over unsaved edits, then shows the file as it is now", async () => {
    const t = setup({ confirm: false });
    await t.c.openLink(t.link);
    t.viewers[0]!.type();
    expect(await t.c.reload()).toBe(false);
    expect(t.methods()).not.toContain("document.reload");
    const u = setup({ confirm: true });
    await u.c.openLink(u.link);
    u.viewers[0]!.type();
    expect(await u.c.reload()).toBe(true);
    expect(u.viewers[0]!.destroyed).toBe(true);
    expect(u.viewers[1]!.ctx.info.text).toBe("# From disk\n");
    expect(u.c.dirty()).toBe(false);
  });

  it("a reload answered after the user typed again keeps what they typed, unsaved, and lets them decide again", async () => {
    const t = setup({ confirm: true });
    await t.c.openLink(t.link);
    t.viewers[0]!.type();
    t.holdReload();
    const reloading = t.c.reload();
    await flush();
    expect(t.methods()).toContain("document.reload");
    // Typed while the file is read: the user agreed to drop the earlier edits, not these.
    t.viewers[0]!.type();
    t.answerReload();
    expect(await reloading).toBe(false);
    expect(t.viewers.length).toBe(1);
    expect(t.viewers[0]!.destroyed).toBe(false);
    expect(t.c.viewer).toBe(t.viewers[0]);
    expect(t.c.dirty()).toBe(true);
    expect(t.c.status).toBe("dirty");
    expect(t.c.canSave).toBe(true);
    expect(t.c.problem).toMatchObject({ context: "reload", actions: ["reload"], error: { code: "reload-superseded" } });
    expect(t.requests.filter((r) => r.method === "document.dirty").at(-1)).toEqual({ method: "document.dirty", documentId: "d1", dirty: true });
    // Saving now names the revision the page was opened at (main refuses it if the disk changed meanwhile).
    expect(await t.c.save()).toBe(true);
    expect(t.requests.find((r) => r.method === "document.save")).toMatchObject({ revision: "a".repeat(16) });
    // Reloading again with no typing meanwhile replaces the page.
    expect(await t.c.reload()).toBe(true);
    expect(t.viewers[1]!.ctx.info.text).toBe("# From disk\n");
  });

  it("a late reload answer with no typing meanwhile still replaces the page", async () => {
    const t = setup({ confirm: true });
    await t.c.openLink(t.link);
    t.viewers[0]!.type();
    t.holdReload();
    const reloading = t.c.reload();
    await flush();
    t.answerReload();
    expect(await reloading).toBe(true);
    expect(t.viewers[0]!.destroyed).toBe(true);
    expect(t.c.dirty()).toBe(false);
  });

  it("text the model cannot write safely is not sent: the reasons are shown and the edits stay (AC5)", async () => {
    const t = setup();
    await t.c.openLink(t.link);
    t.viewers[0]!.type();
    t.viewers[0]!.output = { ok: false, reasons: ["Line 3: html block cannot be edited here."] };
    expect(await t.c.save()).toBe(false);
    expect(t.methods()).not.toContain("document.save");
    expect(t.c.problem).toMatchObject({ error: { code: "unsafe-to-save" }, details: ["Line 3: html block cannot be edited here."] });
    expect(t.c.dirty()).toBe(true);
  });

  it("an answer that comes after the document was closed changes nothing", async () => {
    const t = setup({ answers: ["discard"] });
    await t.c.openLink(t.link);
    t.viewers[0]!.type();
    t.hold();
    const saving = t.c.save();
    await flush();
    // Leaving waits for the save on its way, then asks.
    const leaving = t.c.leave();
    t.release({ ok: false, error: { code: "save-failed", retryable: true, message: "late" } });
    await saving;
    expect(await leaving).toBe(true);
    expect(t.c.document).toBeNull();
    expect(t.c.problem).toBeNull();
  });

  it("read-only files open to read: no typing, no save", async () => {
    const t = setup({ opened: [info({ save: { allowed: false, reason: "the file is read-only" } })] });
    await t.c.openLink(t.link);
    expect(t.viewers[0]!.ctx.readOnly).toBe(true);
    expect(t.c.status).toBe("read-only");
    expect(t.c.canSave).toBe(false);
  });

  it("a format with no viewer is an error, never a blank page", async () => {
    const t = setup({ opened: [info({ format: "text" })] });
    await t.c.openLink(t.link);
    expect(t.c.unsupported).toBe(true);
    expect(t.c.problem?.error.code).toBe("format-unsupported");
    expect(t.c.viewer).toBeNull();
  });
});

describe("leaving a document (AC6): Save, Discard or Keep editing, the same for every way out", () => {
  it("a document without edits closes at once and its session ends", async () => {
    const t = setup();
    await t.c.openLink(t.link);
    expect(await t.c.leave()).toBe(true);
    expect(t.asked).toEqual([]);
    expect(t.requests.at(-1)).toEqual({ method: "document.close", documentId: "d1" });
    expect(t.viewers[0]!.destroyed).toBe(true);
    expect(t.c.shown).toBe(false);
  });

  it("Keep editing: it stays, with its edits", async () => {
    const t = setup({ answers: ["keep"] });
    await t.c.openLink(t.link);
    t.viewers[0]!.type();
    expect(await t.c.leave()).toBe(false);
    expect(t.asked).toEqual([{ name: "notes.md", reason: "leave" }]);
    expect(t.c.document).not.toBeNull();
    expect(t.c.dirty()).toBe(true);
    expect(t.viewers[0]!.focused).toBe(1);
    expect(t.methods()).not.toContain("document.close");
  });

  it("Discard: it closes without writing", async () => {
    const t = setup({ answers: ["discard"] });
    await t.c.openLink(t.link);
    t.viewers[0]!.type();
    expect(await t.c.leave()).toBe(true);
    expect(t.methods()).not.toContain("document.save");
    expect(t.methods()).toContain("document.close");
  });

  it("Save: it is written, then closes; a failed save keeps it open with the error", async () => {
    const t = setup({ answers: ["save", "save"] });
    await t.c.openLink(t.link);
    t.viewers[0]!.type();
    t.saveResults.push({ ok: false, error: { code: "not-found", retryable: true, message: "notes.md does not exist." } });
    expect(await t.c.leave()).toBe(false);
    expect(t.c.document).not.toBeNull();
    expect(t.c.problem?.error.code).toBe("not-found");
    expect(await t.c.leave()).toBe(true);
    expect(t.methods().filter((m) => m === "document.save").length).toBe(2);
    expect(t.c.document).toBeNull();
  });

  it("another document over one with edits asks first; Keep editing lets the new session go", async () => {
    const t = setup({ answers: ["keep"], opened: [info(), info({ documentId: "d2", name: "other.md" })] });
    await t.c.openLink(t.link);
    t.viewers[0]!.type();
    await t.c.openLink({ ...t.link, linkId: "k9" });
    expect(t.c.document?.documentId).toBe("d1");
    expect(t.requests.at(-1)).toEqual({ method: "document.close", documentId: "d2" });
    const u = setup({ answers: ["discard"], opened: [info(), info({ documentId: "d2", name: "other.md" })] });
    await u.c.openLink(u.link);
    u.viewers[0]!.type();
    await u.c.openLink({ ...u.link, linkId: "k9" });
    expect(u.c.document?.documentId).toBe("d2");
    expect(u.requests.some((r) => r.method === "document.close" && r.documentId === "d1")).toBe(true);
  });

  it("the question names the file and why it is asked", () => {
    expect(leaveQuestion("notes.md", "leave").title).toBe("Lưu thay đổi của notes.md?");
    expect(leaveQuestion("notes.md", "quit").message).toContain("trước khi thoát AgentDuo");
    expect(leaveQuestion("notes.md", "window").message).toContain("trước khi đóng cửa sổ");
  });
});

describe("main's close requests (quit, closing the window)", () => {
  const request = (documentIds: string[], reason: "quit" | "window" = "quit") => ({ type: "documentCloseRequest" as const, requestId: "q1", reason, documentIds });

  it("Discard: main is told the page holds no edits, then answered settled", async () => {
    const t = setup({ answers: ["discard"] });
    await t.c.openLink(t.link);
    t.viewers[0]!.type();
    await t.c.closeRequest(request(["d1"]));
    expect(t.asked.at(-1)).toEqual({ name: "notes.md", reason: "quit" });
    expect(t.requests.slice(-2)).toEqual([
      { method: "document.dirty", documentId: "d1", dirty: false },
      { method: "document.closeResponse", requestId: "q1", outcome: "settled" },
    ]);
  });

  it("Keep editing, or a failed save, cancels; Save that works settles", async () => {
    const keep = setup({ answers: ["keep"] });
    await keep.c.openLink(keep.link);
    keep.viewers[0]!.type();
    await keep.c.closeRequest(request(["d1"], "window"));
    expect(keep.requests.at(-1)).toEqual({ method: "document.closeResponse", requestId: "q1", outcome: "cancelled" });
    const failed = setup({ answers: ["save"] });
    await failed.c.openLink(failed.link);
    failed.viewers[0]!.type();
    failed.saveResults.push({ ok: false, error: { code: "save-failed", retryable: true, message: "disk full" } });
    await failed.c.closeRequest(request(["d1"]));
    expect(failed.requests.at(-1)!.outcome).toBe("cancelled");
    expect(failed.c.document).not.toBeNull();
    const saved = setup({ answers: ["save"] });
    await saved.c.openLink(saved.link);
    saved.viewers[0]!.type();
    await saved.c.closeRequest(request(["d1"]));
    expect(saved.methods()).toContain("document.save");
    expect(saved.requests.at(-1)!.outcome).toBe("settled");
  });

  it("documents the page does not hold are reported without edits, and nothing is asked", async () => {
    const t = setup();
    await t.c.closeRequest(request(["d5"]));
    expect(t.asked).toEqual([]);
    expect(t.requests).toEqual([
      { method: "document.dirty", documentId: "d5", dirty: false },
      { method: "document.closeResponse", requestId: "q1", outcome: "settled" },
    ]);
  });

  it("a session main ended leaves the page", async () => {
    const t = setup();
    await t.c.openLink(t.link);
    t.c.closedByMain("d9");
    expect(t.c.document).not.toBeNull();
    t.c.closedByMain("d1");
    expect(t.c.document).toBeNull();
    expect(t.viewers[0]!.destroyed).toBe(true);
  });
});

// ------------------------------------------------------------------ the chat's links (AC1)
describe("the chat's link ids", () => {
  const grant = (view: number, links: Array<[string, string, number, string]>, revoked: string[] = []) => ({
    type: "documentLinks" as const, projectId: "p1", conversationId: "c1", view, revoked,
    links: links.map(([linkId, itemId, ordinal, part]) => ({ linkId, itemId, part, ordinal })),
  });

  it("keeps the ids of the chat's view, drops revoked ones, and forgets an earlier view's", () => {
    const mount = { view: 2, links: { view: 0, ids: new Map<string, string>() } };
    expect(applyGrants(mount, grant(1, [["k1", "i1", 0, "text"]]))).toBe(false);
    expect(applyGrants(mount, grant(2, [["k2", "i1", 0, "text"], ["k3", "i2", 1, "answer"]]))).toBe(true);
    expect(mount.links.ids.get(siteKey({ itemId: "i2", part: "answer", ordinal: 1 }))).toBe("k3");
    applyGrants(mount, grant(2, [], ["k2"]));
    expect([...mount.links.ids.values()]).toEqual(["k3"]);
    applyGrants(mount, grant(3, [["k9", "i1", 0, "text"]]));
    expect(mount.links).toEqual({ view: 3, ids: new Map([["i1|text|0", "k9"]]) });
  });

  it("draws a link with an id as a link (reached with Tab, opened with Enter), and takes it back when revoked", () => {
    const attrs = new Map<string, string>();
    const classes = new Set<string>();
    const el = {
      dataset: {} as Record<string, string>,
      classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
    } as unknown as HTMLElement;
    markLink(el, "k4");
    expect(el.dataset.linkId).toBe("k4");
    expect(classes.has("md-link-open")).toBe(true);
    expect(Object.fromEntries(attrs)).toMatchObject({ role: "link", tabindex: "0" });
    markLink(el, undefined);
    expect(el.dataset.linkId).toBeUndefined();
    expect(classes.size).toBe(0);
    expect(attrs.size).toBe(0);
  });
});

// ------------------------------------------------------------------ the chat draws its links with main's ordinals
class El {
  children: Array<El | string> = [];
  attrs = new Map<string, string>();
  className = "";
  title = "";
  constructor(readonly tag: string) {}
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  append(...c: Array<El | string>) { this.children.push(...c); }
  addEventListener() {}
  get textContent(): string { return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
  set textContent(v: string) { this.children = [v]; }
}

describe("the chat's Markdown links and main's count", () => {
  it("each drawn link gets the ordinal markdownLinks gives it, in every kind of block; a host without the hook draws as before", async () => {
    const g = globalThis as unknown as { document?: unknown };
    const before = g.document;
    g.document = { createElement: (t: string) => new El(t), createTextNode: (t: string) => t };
    try {
      const { markdownBody } = await import("@agentduo/webview/render");
      const md = [
        "# [h](a.md) and [h2](<b c.md>)",
        "",
        "Text [**[x](nested.md)**](outer.md) then [p](docs/plan(1).md \"t\")",
        "",
        "- [one](1.md)",
        "  - [two](2.md)",
        "- [three](3.md)",
        "",
        "> [quoted](q.md)",
        "",
        "| [th](t.md) | b |",
        "| --- | --- |",
        "| [td](d.md) | [td2](e.md) |",
        "",
        "```",
        "[not](code.md)",
        "```",
        "`[not](span.md)` [last](z.md)",
      ].join("\n");
      const seen: Array<{ text: string; ordinal: number; title: string }> = [];
      const actions = { link: (el: HTMLElement, site: { itemId: string; part: string; ordinal: number }) => {
        expect(site.itemId).toBe("i1");
        expect(site.part).toBe("text");
        seen.push({ text: el.textContent ?? "", ordinal: site.ordinal, title: el.title });
      } } as unknown as Parameters<typeof markdownBody>[1];
      markdownBody(md, actions, { itemId: "i1", part: "text" });
      const refs = markdownLinkRefs(md);
      expect(seen.map((s) => s.ordinal).sort((a, b) => a - b)).toEqual(refs.map((_, k) => k));
      for (const s of seen) expect(s.title, s.text).toBe(refs[s.ordinal]!.href);
      // Without a hook (VS Code) or without a site, nothing is called and the links are drawn as they were.
      const plain = markdownBody(md, {} as Parameters<typeof markdownBody>[1], { itemId: "i1", part: "text" }) as unknown as El;
      const spans: El[] = [];
      const walk = (e: El) => e.children.forEach((c) => typeof c !== "string" && (c.className === "md-link" && spans.push(c), walk(c)));
      walk(plain);
      expect(spans.length).toBe(refs.length);
      expect(spans.every((s) => s.attrs.size === 0)).toBe(true);
    } finally {
      g.document = before;
    }
  });
});
