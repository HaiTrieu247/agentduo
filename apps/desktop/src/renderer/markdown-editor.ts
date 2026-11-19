// "Mở": the Markdown viewer, edited in place on the formatted text (design docs/superpowers/specs/2026-11-18-desktop-
// open-markdown-design.md, sections 5 and 7). The file's text is the truth: it opens as T2's model
// (`parseMarkdownDocument`), each top-level block is drawn from its tree (`structure`), and an edit gives the block's
// tree back with only the changed nodes altered (`replaceNodes`), so every byte the user did not touch is written as it
// was read. `serialize()` decides whether the text can be written; this file never builds the file's text itself.
//
// How it is drawn and edited:
//  - Each run of text the user can type in (a paragraph, a heading, a list item's paragraph, a code block's content) is
//    a "field" of its own: an element with `contenteditable`, its path in its block's tree, and its node. Typing reads the
//    field back into nodes (`readInlines`) and copies what did not change from the node it was drawn from
//    (`reconcileInlines`: a node keeps its `source`, which is how the model writes it exactly as it was).
//  - What the editor cannot rewrite (raw HTML, a table, front matter, an image, a footnote…) is shown as its source, not
//    editable, and written back unchanged. Nothing of the document is ever markup: text goes in as text nodes, a link is
//    a span (never followed, never loaded), and no image or other resource the document names is fetched.
//  - Enter, Backspace at the start, Delete at the end, the marks (bold, italic, code), links, the block type and lists
//    change the tree (pure functions below, tested in test/document-view.test.ts) and draw the block again. Undo and
//    redo are the editor's own (snapshots of the model), since the browser's would not know the trees.
//  - Paste and drop insert plain text only; an IME's composition (Vietnamese Telex, for one) is left to the browser and
//    read back when it changes the text.
import type { DocumentInfo, LinkPosition } from "../shared/documents.js";
import { parseMarkdownDocument, type EditableMarkdownDocument, type MdBlock, type MdInline, type MdListItem } from "../shared/markdown-document.js";

// ------------------------------------------------------------------ paths in a block's tree
/**
 * Where a node is in a block's tree: its index in the top list, then, for each container on the way, a list's item and
 * the child of that item (two numbers) or a quote's child (one number).
 */
export type Path = readonly number[];

export function nodeAt(tree: readonly MdBlock[], path: Path): MdBlock | null {
  let list: readonly MdBlock[] = tree;
  let k = 0;
  for (;;) {
    const n = list[path[k]!];
    if (!n) return null;
    k++;
    if (k === path.length) return n;
    if (n.type === "list") {
      const item = n.items[path[k]!];
      if (!item) return null;
      list = item.children;
      k++;
      if (k === path.length) return null;
    } else if (n.type === "quote") list = n.children;
    else return null;
  }
}

/** The tree with the node at `path` replaced by `nodes` (none removes it, several insert them in its place). */
export function replaceAt(tree: readonly MdBlock[], path: Path, nodes: readonly MdBlock[]): MdBlock[] {
  const [i, ...rest] = path;
  const n = tree[i!];
  if (!n) throw new Error("no node at that path");
  if (rest.length === 0) return [...tree.slice(0, i), ...nodes, ...tree.slice(i! + 1)];
  let next: MdBlock;
  if (n.type === "list") {
    const [j, ...more] = rest;
    const item = n.items[j!];
    if (!item || more.length === 0) throw new Error("no node at that path");
    const items = n.items.slice();
    items[j!] = { ...item, children: replaceAt(item.children, more, nodes) };
    next = { ...n, items };
  } else if (n.type === "quote") next = { ...n, children: replaceAt(n.children, rest, nodes) };
  else throw new Error("no node at that path");
  return [...tree.slice(0, i), next, ...tree.slice(i! + 1)];
}

/** What holds the node at `path`: the block's top list, a quote, or a list's item (with the list's path and the item). */
export type Container = { kind: "top" | "quote"; index: number } | { kind: "item"; listPath: Path; item: number; index: number };

export function containerOf(path: Path, tree: readonly MdBlock[]): Container {
  if (path.length === 1) return { kind: "top", index: path[0]! };
  const index = path[path.length - 1]!;
  const parentPath = path.slice(0, -1);
  const parent = nodeAt(tree, parentPath);
  if (parent?.type === "quote") return { kind: "quote", index };
  return { kind: "item", listPath: path.slice(0, -2), item: path[path.length - 2]!, index };
}

/** The tree without the node at `path`, and without the item, list or quote that this left empty. */
export function removeAt(tree: readonly MdBlock[], path: Path): MdBlock[] {
  const out = replaceAt(tree, path, []);
  const c = containerOf(path, tree);
  if (c.kind === "item") {
    const list = nodeAt(out, c.listPath);
    if (list?.type === "list" && list.items[c.item]!.children.length === 0) {
      const items = list.items.filter((_, k) => k !== c.item);
      // An emptied list goes too, and so on up: an emptied quote around it is not kept either.
      return items.length ? replaceAt(out, c.listPath, [{ ...list, items }]) : removeAt(out, c.listPath);
    }
  } else if (c.kind === "quote") {
    const quotePath = path.slice(0, -1);
    const quote = nodeAt(out, quotePath);
    if (quote?.type === "quote" && quote.children.length === 0) return removeAt(out, quotePath);
  }
  return out;
}

// ------------------------------------------------------------------ inlines: keeping what did not change
const KEYED = new Set(["text", "code", "softbreak", "break", "emphasis", "strong", "link", "raw"]);

/** The same node, read the same way, whatever its source: what the user sees did not change. */
export function sameInline(a: MdInline, b: MdInline): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "text":
    case "code":
      return a.value === (b as typeof a).value;
    case "break":
    case "softbreak":
      return true;
    case "raw":
      return a.source === (b as typeof a).source;
    case "emphasis":
    case "strong":
      return sameInlines(a.children, (b as typeof a).children);
    case "link": {
      const l = b as typeof a;
      return a.destination === l.destination && a.title === l.title && sameInlines(a.children, l.children);
    }
  }
}

export const sameInlines = (a: readonly MdInline[], b: readonly MdInline[]): boolean => a.length === b.length && a.every((n, k) => sameInline(n, b[k]!));

/** `next` (read from the page) with what it has of `old` (the nodes it was drawn from) taken from `old`: the sources stay. */
function carry(old: MdInline, next: MdInline): MdInline {
  if (sameInline(old, next)) return old;
  if (old.type !== next.type || !KEYED.has(next.type)) return next;
  switch (next.type) {
    case "text":
    case "code":
      return old.source === undefined ? next : { ...(old as typeof next), value: next.value };
    case "emphasis":
    case "strong":
      return { ...(old as typeof next), children: reconcileInlines((old as typeof next).children, next.children) };
    case "link":
      return { ...(old as typeof next), destination: next.destination, title: next.title, children: reconcileInlines((old as typeof next).children, next.children) };
    default:
      return next;
  }
}

/**
 * The nodes the user now has (`next`), with each one that lines up with a node it was drawn from (`old`) carrying that
 * node's source: the same start and end of the list are matched first, then what lies between pairs up by position
 * when the kind is the same. The model writes a node that did not change from its source as it was, and the unchanged
 * ends of a changed text with their escapes; a node with no counterpart is written fresh.
 */
export function reconcileInlines(old: readonly MdInline[], next: readonly MdInline[]): MdInline[] {
  const out: MdInline[] = new Array(next.length);
  let head = 0;
  while (head < old.length && head < next.length && sameInline(old[head]!, next[head]!)) {
    out[head] = old[head]!;
    head++;
  }
  let tail = 0;
  while (tail < old.length - head && tail < next.length - head && sameInline(old[old.length - 1 - tail]!, next[next.length - 1 - tail]!)) {
    out[next.length - 1 - tail] = old[old.length - 1 - tail]!;
    tail++;
  }
  for (let k = head; k < next.length - tail; k++) {
    const o = old[k] && k < old.length - tail ? old[k]! : undefined;
    out[k] = o ? carry(o, next[k]!) : next[k]!;
  }
  return out;
}

/** Adjacent texts joined, empty texts and empty marks gone, trailing line breaks gone (they could not be written). */
export function tidyInlines(nodes: readonly MdInline[]): MdInline[] {
  const out: MdInline[] = [];
  for (const n of nodes) {
    if (n.type === "text") {
      if (n.value === "") continue;
      const last = out[out.length - 1];
      if (last?.type === "text") {
        out[out.length - 1] = { type: "text", value: last.value + n.value };
        continue;
      }
      out.push({ type: "text", value: n.value });
    } else if (n.type === "emphasis" || n.type === "strong") {
      const children = tidyInlines(n.children);
      if (children.length === 0) continue;
      const last = out[out.length - 1];
      if (last?.type === n.type) out[out.length - 1] = { type: n.type, children: tidyInlines([...last.children, ...children]) };
      else out.push({ type: n.type, children });
    } else if (n.type === "link") {
      out.push({ ...n, children: tidyInlines(n.children) });
    } else out.push(n);
  }
  while (out.length && out[out.length - 1]!.type === "break") out.pop();
  return out;
}

// ------------------------------------------------------------------ structural edits on a block's tree
const paragraph = (inlines: MdInline[]): MdBlock => ({ type: "paragraph", inlines });

/** An inline field's node: a paragraph or a heading. */
type TextBlock = Extract<MdBlock, { type: "paragraph" | "heading" }>;

const isText = (n: MdBlock | null): n is TextBlock => n?.type === "paragraph" || n?.type === "heading";

/**
 * Enter in an inline field at `path`, with its text cut in two at the caret (`before`, `after`, already reconciled).
 * A paragraph becomes two; a heading keeps its text before the caret and a paragraph takes the rest (Enter at its
 * start puts an empty paragraph before it); in a list item the rest goes to a new item after it, and an empty last
 * item leaves the list (a paragraph after it). Returns the tree and where the caret goes (the start of that field).
 */
export function splitAt(tree: readonly MdBlock[], path: Path, before: MdInline[], after: MdInline[]): { tree: MdBlock[]; focus: Path } {
  const node = nodeAt(tree, path);
  if (!isText(node)) throw new Error("not a text block");
  const c = containerOf(path, tree);
  if (c.kind === "item") {
    const list = nodeAt(tree, c.listPath) as Extract<MdBlock, { type: "list" }>;
    const item = list.items[c.item]!;
    const empty = before.length === 0 && after.length === 0 && item.children.length === 1;
    if (empty && c.item === list.items.length - 1) {
      // Enter in an empty last item: the item goes, and a paragraph follows the list.
      const items = list.items.slice(0, -1);
      const replaced: MdBlock[] = items.length ? [{ ...list, items }, paragraph([])] : [paragraph([])];
      const out = replaceAt(tree, c.listPath, replaced);
      const at = c.listPath.slice(0, -1);
      return { tree: out, focus: [...at, c.listPath[c.listPath.length - 1]! + (items.length ? 1 : 0)] };
    }
    const first: MdListItem = { ...item, children: [...item.children.slice(0, c.index), { ...node, inlines: before }] };
    const second: MdListItem = { checked: item.checked === null ? null : false, children: [{ type: "paragraph", inlines: after }, ...item.children.slice(c.index + 1)] };
    const items = [...list.items.slice(0, c.item), first, second, ...list.items.slice(c.item + 1)];
    return { tree: replaceAt(tree, c.listPath, [{ ...list, items }]), focus: [...c.listPath, c.item + 1, 0] };
  }
  const at = path.slice(0, -1);
  const i = path[path.length - 1]!;
  if (node.type === "heading" && before.length === 0) {
    return { tree: replaceAt(tree, path, [paragraph([]), { ...node, inlines: after }]), focus: [...at, i + 1] };
  }
  const second: MdBlock = node.type === "heading" ? paragraph(after) : { type: "paragraph", inlines: after };
  return { tree: replaceAt(tree, path, [{ ...node, inlines: before }, second]), focus: [...at, i + 1] };
}

/** A paragraph or heading becomes the other kind (or another level), keeping its text and its nodes' sources. */
export function setTextKind(tree: readonly MdBlock[], path: Path, kind: { type: "paragraph" } | { type: "heading"; level: number }): MdBlock[] {
  const node = nodeAt(tree, path);
  if (!isText(node)) throw new Error("not a text block");
  if (kind.type === node.type && (kind.type === "paragraph" || (node.type === "heading" && node.level === kind.level))) return tree.slice();
  const next: MdBlock = kind.type === "paragraph" ? { type: "paragraph", inlines: node.inlines } : { type: "heading", level: kind.level, inlines: node.inlines };
  return replaceAt(tree, path, [next]);
}

/**
 * The list button: a paragraph out of a list becomes a list of one item; in a list of the other kind, the list changes
 * kind; in a list of that kind, the item leaves it (the list is cut around it). Returns where the paragraph is now.
 */
export function toggleList(tree: readonly MdBlock[], path: Path, ordered: boolean): { tree: MdBlock[]; focus: Path } {
  const node = nodeAt(tree, path);
  if (node?.type !== "paragraph") throw new Error("not a paragraph");
  const c = containerOf(path, tree);
  if (c.kind === "item") {
    const list = nodeAt(tree, c.listPath) as Extract<MdBlock, { type: "list" }>;
    if (list.ordered !== ordered) {
      const changed: MdBlock = { type: "list", ordered, start: 1, marker: ordered ? "." : "-", tight: list.tight, items: list.items };
      return { tree: replaceAt(tree, c.listPath, [changed]), focus: path };
    }
    const beforeItems = list.items.slice(0, c.item);
    const afterItems = list.items.slice(c.item + 1);
    const lifted = list.items[c.item]!.children;
    const parts: MdBlock[] = [];
    if (beforeItems.length) parts.push({ ...list, items: beforeItems });
    parts.push(...lifted);
    if (afterItems.length) parts.push({ type: "list", ordered: list.ordered, start: list.start + c.item + 1, marker: list.marker, tight: list.tight, items: afterItems });
    const at = c.listPath.slice(0, -1);
    const base = c.listPath[c.listPath.length - 1]!;
    return { tree: replaceAt(tree, c.listPath, parts), focus: [...at, base + (beforeItems.length ? 1 : 0) + c.index] };
  }
  const list: MdBlock = { type: "list", ordered, start: 1, marker: ordered ? "." : "-", tight: true, items: [{ checked: null, children: [node] }] };
  return { tree: replaceAt(tree, path, [list]), focus: [...path, 0, 0] };
}

/** What the model is given: the tree without list items left empty (an item with no text cannot be written back as one). */
export function prune(tree: readonly MdBlock[]): MdBlock[] {
  const out: MdBlock[] = [];
  for (const n of tree) {
    if (n.type === "list") {
      const items = n.items.map((it) => ({ ...it, children: prune(it.children) })).filter((it) => it.children.some((c) => !(isText(c) && c.inlines.length === 0)));
      if (items.length === 0) continue;
      const same = items.length === n.items.length && items.every((it, k) => sameBlocks(it.children, n.items[k]!.children));
      out.push(same ? n : { ...n, items: items.map((it, k) => (sameBlocks(it.children, n.items[k]?.children ?? []) ? n.items[k]! : it)) });
    } else if (n.type === "quote") {
      const children = prune(n.children);
      out.push(sameBlocks(children, n.children) ? n : { ...n, children });
    } else out.push(n);
  }
  return out;
}

const sameBlocks = (a: readonly MdBlock[], b: readonly MdBlock[]): boolean => a.length === b.length && a.every((n, k) => n === b[k]);

// ------------------------------------------------------------------ the viewer's contract (documents.ts picks it by format)
export interface ViewerContext {
  info: DocumentInfo;
  /** The file cannot be written: it is shown to read, and nothing can be typed. */
  readOnly: boolean;
  /** The user changed something (or undid it). */
  changed(): void;
  doc?: Document;
}

/** What a format's viewer gives the "Mở" layer (documents.ts); a new format registers one in `VIEWERS` there. */
export interface DocumentViewer {
  readonly element: HTMLElement;
  /** The page holds edits that the text it was opened with does not have. */
  edited(): boolean;
  /** The whole text to write, or why it cannot be written without loss (nothing is written then). */
  text(): { ok: true; text: string } | { ok: false; reasons: string[] };
  /** What is shown as it is (kept unchanged when saved), told when the file opens. */
  notices(): string[];
  /** Brings what the link pointed at into view: a line, or a heading's anchor. */
  reveal(position: LinkPosition | null, anchor: string | null): void;
  focus(): void;
  destroy(): void;
}

// ------------------------------------------------------------------ the caret's count
/**
 * The length of a node as the caret counts it: text, a line break as one, an uneditable part (`data-raw`) as its text,
 * and an element or a fragment as the sum of its children. A fragment counts too: the caret's offset is measured on
 * `Range.cloneContents()`, which is one, so a fragment counted as 0 would put every caret at the start of its field
 * (and Backspace in the middle of a heading would turn it into a paragraph, in a paragraph join it to the one before).
 */
export function caretLength(n: Node): number {
  if (n.nodeType === 3) return (n as Text).data.length;
  if (n.nodeType === 11) {
    let len = 0;
    n.childNodes.forEach((c) => (len += caretLength(c)));
    return len;
  }
  if (n.nodeType !== 1) return 0;
  const e = n as HTMLElement;
  if (e.tagName === "BR") return 1;
  if (e.dataset.raw !== undefined) return (e.textContent ?? "").length;
  let len = 0;
  e.childNodes.forEach((c) => (len += caretLength(c)));
  return len;
}

// ------------------------------------------------------------------ the viewer
interface Field {
  blockId: string;
  path: Path;
  kind: "inline" | "code";
  /** The raw inline nodes drawn in it, by the index its span carries. */
  raws: MdInline[];
}

interface Snapshot {
  model: EditableMarkdownDocument;
  trees: Map<string, MdBlock[]>;
  caret: { blockId: string; path: Path; offset: number } | null;
}

const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;
/** How long typing goes into one undo step. */
const UNDO_MS = 900;
const UNDO_MAX = 200;

/** A heading's anchor as GitHub writes it: lowercase, punctuation dropped, spaces as dashes. */
export function slug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}

const plainText = (nodes: readonly MdInline[]): string =>
  nodes.map((n) => (n.type === "text" || n.type === "code" ? n.value : n.type === "softbreak" || n.type === "break" ? " " : n.type === "raw" ? n.source : plainText(n.children))).join("");

export function createMarkdownViewer(ctx: ViewerContext): DocumentViewer {
  const doc = ctx.doc ?? document;
  const win = doc.defaultView ?? window;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const codicon = (name: string) => {
    const s = make("span", `codicon codicon-${name}`);
    s.setAttribute("aria-hidden", "true");
    return s;
  };

  let model = parseMarkdownDocument(ctx.info.text);
  const trees = new Map<string, MdBlock[]>();
  const fields = new WeakMap<HTMLElement, Field>();
  const blockEls = new Map<string, HTMLElement>();
  const undo: Snapshot[] = [];
  const redo: Snapshot[] = [];
  let lastPush = 0;
  /** The empty document's own paragraph: given to the model at the first character typed in it. */
  let insertedId: string | null = null;

  const treeOf = (id: string): MdBlock[] => {
    let t = trees.get(id);
    if (!t) {
      t = model.structure(id);
      trees.set(id, t);
    }
    return t;
  };

  // ---------------------------------------------------------------- the frame: toolbar, link bar, page
  const root = make("div", "md-editor");
  const page = make("article", "doc-page");
  page.setAttribute("aria-label", `Nội dung ${ctx.info.name}`);
  page.tabIndex = -1;
  const toolbar = make("div", "doc-toolbar");
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Định dạng");
  const kind = make("select", "doc-kind");
  kind.setAttribute("aria-label", "Kiểu khối");
  for (const [value, label] of [["p", "Đoạn văn"], ["1", "Tiêu đề 1"], ["2", "Tiêu đề 2"], ["3", "Tiêu đề 3"], ["4", "Tiêu đề 4"], ["5", "Tiêu đề 5"], ["6", "Tiêu đề 6"]] as const) {
    const o = make("option", undefined, label);
    o.value = value;
    kind.append(o);
  }
  const mod = /Mac/.test(win.navigator?.platform ?? "") ? "⌘" : "Ctrl+";
  const tool = (iconName: string, label: string, onClick: () => void) => {
    const b = make("button", "icon-btn doc-tool");
    b.type = "button";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.append(codicon(iconName));
    // The field keeps its selection: a press on a tool does not take the focus from the text.
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", onClick);
    return b;
  };
  const boldBtn = tool("bold", `Đậm (${mod}B)`, () => mark("strong"));
  const italicBtn = tool("italic", `Nghiêng (${mod}I)`, () => mark("em"));
  const codeBtn = tool("code", `Mã trong dòng (${mod}E)`, () => mark("code"));
  const linkBtn = tool("link", `Liên kết (${mod}K)`, () => linkCommand());
  const bulletBtn = tool("list-unordered", "Danh sách dấu đầu dòng", () => listCommand(false));
  const numberBtn = tool("list-ordered", "Danh sách đánh số", () => listCommand(true));
  const sep = make("span", "doc-tool-sep");
  sep.setAttribute("aria-hidden", "true");
  toolbar.append(kind, boldBtn, italicBtn, codeBtn, linkBtn, sep, bulletBtn, numberBtn);
  const tools: HTMLElement[] = [kind, boldBtn, italicBtn, codeBtn, linkBtn, bulletBtn, numberBtn];
  // One stop for the toolbar: arrows move inside it (the WAI-ARIA toolbar pattern).
  const rove = (to: HTMLElement) => {
    for (const t of tools) t.tabIndex = t === to ? 0 : -1;
    to.focus();
  };
  tools.forEach((t, k) => (t.tabIndex = k === 0 ? 0 : -1));
  toolbar.addEventListener("keydown", (e) => {
    const at = tools.indexOf(doc.activeElement as HTMLElement);
    if (at < 0) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      if (e.target === kind) return; // a select keeps its own arrows
      e.preventDefault();
      const enabled = tools.filter((t) => !(t as HTMLButtonElement).disabled);
      const k = enabled.indexOf(tools[at]!);
      rove(enabled[(k + (e.key === "ArrowRight" ? 1 : enabled.length - 1)) % enabled.length]!);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const enabled = tools.filter((t) => !(t as HTMLButtonElement).disabled);
      rove(enabled[e.key === "Home" ? 0 : enabled.length - 1]!);
    }
  });
  kind.addEventListener("change", () => kindCommand(kind.value));

  const linkBar = make("div", "doc-linkbar");
  linkBar.setAttribute("role", "group");
  linkBar.setAttribute("aria-label", "Liên kết");
  const linkLabel = make("label", "doc-linkbar-label");
  const linkInput = make("input", "doc-linkbar-input");
  linkInput.type = "text";
  linkInput.spellcheck = false;
  linkInput.id = `doc-link-${Math.random().toString(36).slice(2, 8)}`;
  linkLabel.htmlFor = linkInput.id;
  linkLabel.append(codicon("link"), make("span", undefined, "Đích liên kết"));
  const unlinkBtn = make("button", "btn small doc-unlink", "Bỏ liên kết");
  unlinkBtn.type = "button";
  const linkDone = make("button", "btn small doc-link-done", "Xong");
  linkDone.type = "button";
  linkBar.append(linkLabel, linkInput, unlinkBtn, linkDone);
  linkBar.hidden = true;

  // The toolbar and the link bar stay at the top while the page scrolls under them.
  const bar = make("div", "doc-tools");
  bar.append(toolbar, linkBar);
  root.append(bar, page);
  if (ctx.readOnly) {
    bar.hidden = true;
    root.classList.add("read-only");
  }

  // ---------------------------------------------------------------- drawing
  function drawInlines(target: HTMLElement | DocumentFragment, nodes: readonly MdInline[], raws: MdInline[]): void {
    for (const n of nodes) {
      switch (n.type) {
        case "text":
          target.append(doc.createTextNode(n.value));
          break;
        case "softbreak":
          target.append(doc.createTextNode("\n"));
          break;
        case "break":
          target.append(make("br"));
          break;
        case "code":
          target.append(make("code", "doc-code", n.value));
          break;
        case "emphasis":
        case "strong": {
          const e = make(n.type === "strong" ? "strong" : "em");
          drawInlines(e, n.children, raws);
          target.append(e);
          break;
        }
        case "link": {
          // A span, never an anchor: the editor follows and loads nothing a document names.
          const a = make("span", "doc-link");
          a.dataset.dest = n.destination;
          if (n.title !== null) a.dataset.title = n.title;
          a.title = n.destination;
          drawInlines(a, n.children, raws);
          target.append(a);
          break;
        }
        case "raw": {
          const r = make("span", "doc-raw", n.source);
          r.contentEditable = "false";
          r.dataset.raw = String(raws.length);
          r.title = `${n.construct}: giữ nguyên như trong file`;
          raws.push(n);
          target.append(r);
          break;
        }
      }
    }
  }

  function field<E extends HTMLElement>(el: E, f: Field, label: string): E {
    fields.set(el, f);
    el.classList.add("doc-field");
    if (!ctx.readOnly) el.contentEditable = f.kind === "code" ? "plaintext-only" : "true";
    el.setAttribute("role", "textbox");
    el.setAttribute("aria-multiline", "true");
    el.setAttribute("aria-label", label);
    if (ctx.readOnly) el.setAttribute("aria-readonly", "true");
    if (f.kind === "code") el.spellcheck = false;
    return el;
  }

  function drawNodes(blockId: string, nodes: readonly MdBlock[], base: Path, inItem: boolean): HTMLElement[] {
    return nodes.map((n, k): HTMLElement => {
      const path = [...base, k];
      switch (n.type) {
        case "paragraph": {
          const raws: MdInline[] = [];
          const p = field(make("p", "doc-p"), { blockId, path, kind: "inline", raws }, inItem ? "Mục danh sách" : "Đoạn văn");
          drawInlines(p, n.inlines, raws);
          return p;
        }
        case "heading": {
          const raws: MdInline[] = [];
          const level = Math.min(6, Math.max(1, n.level));
          const h = field(make(HEADING_TAGS[level - 1]!, `doc-h doc-h${level}`), { blockId, path, kind: "inline", raws }, `Tiêu đề ${level}`);
          drawInlines(h, n.inlines, raws);
          return h;
        }
        case "code": {
          const box = make("div", "doc-code-block");
          const info = make("div", "doc-code-info", n.info || "mã");
          info.setAttribute("aria-hidden", "true");
          const code = field(make("code", "doc-code-field", n.value), { blockId, path, kind: "code", raws: [] }, n.info ? `Khối mã ${n.info}` : "Khối mã");
          const pre = make("pre", "doc-pre");
          pre.append(code);
          box.append(info, pre);
          return box;
        }
        case "rule": {
          const hr = make("hr", "doc-rule");
          return hr;
        }
        case "list": {
          const list = make(n.ordered ? "ol" : "ul", "doc-list");
          if (n.ordered && n.start !== 1) list.setAttribute("start", String(n.start));
          n.items.forEach((item, j) => {
            const li = make("li", "doc-li");
            if (item.checked !== null) {
              const box = make("span", `doc-task${item.checked ? " done" : ""}`, item.checked ? "☑" : "☐");
              box.setAttribute("role", "img");
              box.setAttribute("aria-label", item.checked ? "đã xong" : "chưa xong");
              li.append(box);
            }
            li.append(...drawNodes(blockId, item.children, [...path, j], true));
            list.append(li);
          });
          return list;
        }
        case "quote": {
          const q = make("blockquote", "doc-quote");
          q.append(...drawNodes(blockId, n.children, path, false));
          return q;
        }
        case "raw":
          return kept(n.construct, n.source);
      }
    });
  }

  function kept(construct: string | null, source: string): HTMLElement {
    const box = make("div", "doc-kept");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", `${construct ?? "Phần"} được giữ nguyên`);
    const label = make("div", "doc-kept-label");
    label.append(codicon("lock"), make("span", undefined, `${construct ?? "Phần này"} · giữ nguyên, không sửa ở đây`));
    const pre = make("pre", "doc-kept-source", source);
    pre.tabIndex = 0;
    box.append(label, pre);
    return box;
  }

  function drawBlock(id: string): HTMLElement {
    const info = model.blocks.find((b) => b.id === id);
    const box = make("div", "doc-block");
    box.dataset.block = id;
    if (info && !info.editable) box.append(kept(info.construct, model.blockSource(id)));
    else box.append(...drawNodes(id, treeOf(id), [], false));
    return box;
  }

  function drawAll(): void {
    blockEls.clear();
    const els: HTMLElement[] = [];
    for (const b of model.blocks) {
      const e = drawBlock(b.id);
      blockEls.set(b.id, e);
      els.push(e);
    }
    if (model.blocks.length === 0 && !ctx.readOnly) {
      // An empty file: one empty paragraph to type in; it reaches the model with its first character.
      insertedId = null;
      const box = make("div", "doc-block");
      box.dataset.block = "";
      trees.set("", [paragraph([])]);
      box.append(...drawNodes("", [paragraph([])], [], false));
      blockEls.set("", box);
      els.push(box);
    }
    page.replaceChildren(...els);
  }

  function redrawBlock(id: string): void {
    const old = blockEls.get(id);
    const next = drawBlock(id);
    if (id === "" || (insertedId !== null && id === insertedId)) next.dataset.block = id;
    blockEls.set(id, next);
    old?.replaceWith(next);
  }

  // ---------------------------------------------------------------- reading the page back
  function readInlines(node: Node, raws: readonly MdInline[]): MdInline[] {
    const out: MdInline[] = [];
    node.childNodes.forEach((c) => {
      if (c.nodeType === 3) {
        (c as Text).data.split("\n").forEach((part, k) => {
          if (k > 0) out.push({ type: "softbreak" });
          if (part) out.push({ type: "text", value: part });
        });
        return;
      }
      if (c.nodeType !== 1) return;
      const e = c as HTMLElement;
      const tag = e.tagName;
      if (e.dataset.raw !== undefined) {
        const r = raws[Number(e.dataset.raw)];
        if (r) out.push(r);
      } else if (tag === "BR") out.push({ type: "break" });
      else if (tag === "STRONG" || tag === "B") out.push({ type: "strong", children: readInlines(e, raws) });
      else if (tag === "EM" || tag === "I") out.push({ type: "emphasis", children: readInlines(e, raws) });
      else if (tag === "CODE") out.push({ type: "code", value: (e.textContent ?? "").replace(/\n/g, " ") });
      else if (e.classList.contains("doc-link")) out.push({ type: "link", destination: e.dataset.dest ?? "", title: e.dataset.title ?? null, children: readInlines(e, raws) });
      else out.push(...readInlines(e, raws)); // anything else the browser made: its text
    });
    return out;
  }

  function readCode(el: HTMLElement): string {
    let s = "";
    const walk = (n: Node) =>
      n.childNodes.forEach((c) => {
        if (c.nodeType === 3) s += (c as Text).data;
        else if ((c as Element).tagName === "BR") s += "\n";
        else walk(c);
      });
    walk(el);
    return s;
  }

  const fieldOf = (n: Node | null): HTMLElement | null => {
    for (let e: Node | null = n; e && e !== page; e = e.parentNode) if (e.nodeType === 1 && fields.has(e as HTMLElement)) return e as HTMLElement;
    return null;
  };

  // ---------------------------------------------------------------- caret
  const lengthOf = caretLength;

  function caretIn(el: HTMLElement): number | null {
    const sel = doc.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0);
    if (!el.contains(r.endContainer)) return null;
    const pre = doc.createRange();
    pre.selectNodeContents(el);
    pre.setEnd(r.endContainer, r.endOffset);
    return lengthOf(pre.cloneContents());
  }

  function placeCaret(el: HTMLElement, offset: number): void {
    el.focus({ preventScroll: true });
    const sel = doc.getSelection();
    if (!sel) return;
    const r = doc.createRange();
    let left = Math.max(0, offset);
    const find = (n: Node): boolean => {
      for (const c of Array.from(n.childNodes)) {
        const len = lengthOf(c);
        if (c.nodeType === 3) {
          if (left <= len) {
            r.setStart(c, left);
            return true;
          }
        } else if ((c as HTMLElement).tagName === "BR" || (c as HTMLElement).dataset?.raw !== undefined) {
          if (left < len || (left === len && len > 0 && left === 0)) {
            r.setStartBefore(c);
            return true;
          }
        } else if (left <= len && find(c)) return true;
        left -= len;
      }
      return false;
    };
    if (!find(el)) {
      r.selectNodeContents(el);
      r.collapse(false);
    } else r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    (el.closest(".doc-block") as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" });
  }

  const fieldEl = (blockId: string, path: Path): HTMLElement | null => {
    const box = blockEls.get(blockId);
    if (!box) return null;
    for (const e of Array.from(box.querySelectorAll<HTMLElement>(".doc-field"))) {
      const f = fields.get(e);
      if (f && f.path.length === path.length && f.path.every((x, k) => x === path[k])) return e;
    }
    return null;
  };

  // ---------------------------------------------------------------- the model
  function snapshot(): Snapshot {
    const active = fieldOf(doc.activeElement);
    const f = active ? fields.get(active) : undefined;
    return { model, trees: new Map(trees), caret: f && active ? { blockId: f.blockId, path: f.path, offset: caretIn(active) ?? 0 } : null };
  }

  function remember(structural: boolean): void {
    const now = Date.now();
    if (structural || now - lastPush > UNDO_MS || undo.length === 0) {
      undo.push(snapshot());
      if (undo.length > UNDO_MAX) undo.shift();
    }
    lastPush = structural ? 0 : now;
    redo.length = 0;
  }

  /** The block's tree is now `tree`: the model gets it (pruned), and the page is told. */
  function commit(blockId: string, tree: MdBlock[]): void {
    trees.set(blockId, tree);
    if (blockId === "" || blockId === insertedId) {
      // The empty file's paragraph: inserted once, then replaced like any block.
      if (insertedId === null) {
        const pruned = prune(tree);
        if (pruned.every((n) => isText(n) && n.inlines.length === 0)) return ctx.changed();
        model = model.insertNodes(null, pruned);
        insertedId = model.blocks[model.blocks.length - 1]!.id;
        trees.set(insertedId, tree);
        const box = blockEls.get("");
        if (box) {
          blockEls.delete("");
          blockEls.set(insertedId, box);
          box.dataset.block = insertedId;
          for (const e of Array.from(box.querySelectorAll<HTMLElement>(".doc-field"))) {
            const f = fields.get(e);
            if (f) f.blockId = insertedId;
          }
        }
      } else model = model.replaceNodes(insertedId, prune(tree));
    } else model = model.replaceNodes(blockId, prune(tree));
    ctx.changed();
  }

  /** The field's text changed (typing, an IME, a deletion): its node is read back and the model gets it. */
  function sync(el: HTMLElement): void {
    const f = fields.get(el);
    if (!f) return;
    const tree = treeOf(f.blockId);
    const node = nodeAt(tree, f.path);
    if (!node) return;
    let next: MdBlock;
    if (f.kind === "code" && node.type === "code") {
      const value = readCode(el);
      if (value === node.value) return;
      next = { ...node, value };
    } else if (isText(node)) {
      let inlines = reconcileInlines(node.inlines, tidyInlines(readInlines(el, f.raws)));
      if (node.type === "heading") inlines = inlines.map((n) => (n.type === "softbreak" || n.type === "break" ? { type: "text", value: " " } : n));
      if (sameInlines(inlines, node.inlines) && inlines.every((n, k) => n === node.inlines[k])) return;
      next = { ...node, inlines };
    } else return;
    remember(false);
    commit(f.blockId, replaceAt(tree, f.path, [next]));
  }

  // ---------------------------------------------------------------- structural edits
  function split(el: HTMLElement): void {
    const f = fields.get(el)!;
    const sel = doc.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) range.deleteContents();
    const tree = treeOf(f.blockId);
    const node = nodeAt(tree, f.path);
    if (!isText(node)) return;
    const before = doc.createRange();
    before.selectNodeContents(el);
    before.setEnd(range.startContainer, range.startOffset);
    const after = doc.createRange();
    after.selectNodeContents(el);
    after.setStart(range.startContainer, range.startOffset);
    const a = reconcileInlines(node.inlines, tidyInlines(readInlines(before.cloneContents(), f.raws)));
    const b = reconcileInlines(node.inlines, tidyInlines(readInlines(after.cloneContents(), f.raws)));
    remember(true);
    const r = splitAt(tree, f.path, a, b);
    commit(f.blockId, r.tree);
    redrawBlock(f.blockId);
    const target = fieldEl(f.blockId, r.focus);
    if (target) placeCaret(target, 0);
  }

  /** Every field of the page and every stop between them (code, a rule, a kept part), in the page's order. */
  const sequence = (): HTMLElement[] => Array.from(page.querySelectorAll<HTMLElement>(".doc-field, .doc-rule, .doc-kept"));

  function neighbour(el: HTMLElement, step: 1 | -1): HTMLElement | null {
    const all = sequence();
    const k = all.indexOf(el);
    return all[k + step] ?? null;
  }

  /** `second`'s text joins the end of `first` (both inline fields); the caret goes to the join. */
  function join(first: HTMLElement, second: HTMLElement): void {
    const f1 = fields.get(first)!;
    const f2 = fields.get(second)!;
    const n1 = nodeAt(treeOf(f1.blockId), f1.path);
    const n2 = nodeAt(treeOf(f2.blockId), f2.path);
    if (!isText(n1) || !isText(n2)) return;
    const offset = lengthOf(first);
    remember(true);
    const joined = { ...n1, inlines: [...n1.inlines, ...n2.inlines] };
    if (f1.blockId === f2.blockId) {
      const t = replaceAt(treeOf(f1.blockId), f1.path, [joined]);
      commit(f1.blockId, removeAt(t, f2.path));
      redrawBlock(f1.blockId);
    } else {
      commit(f1.blockId, replaceAt(treeOf(f1.blockId), f1.path, [joined]));
      commit(f2.blockId, removeAt(treeOf(f2.blockId), f2.path));
      redrawBlock(f1.blockId);
      redrawBlock(f2.blockId);
    }
    const target = fieldEl(f1.blockId, f1.path);
    if (target) placeCaret(target, offset);
  }

  /** Backspace at the start of an inline field. */
  function backspaceAtStart(el: HTMLElement): boolean {
    const f = fields.get(el)!;
    const tree = treeOf(f.blockId);
    const node = nodeAt(tree, f.path);
    if (!isText(node)) return false;
    if (node.type === "heading") {
      remember(true);
      commit(f.blockId, setTextKind(tree, f.path, { type: "paragraph" }));
      redrawBlock(f.blockId);
      const t = fieldEl(f.blockId, f.path);
      if (t) placeCaret(t, 0);
      return true;
    }
    const c = containerOf(f.path, tree);
    if (c.kind === "item" && c.index === 0) {
      const list = nodeAt(tree, c.listPath) as Extract<MdBlock, { type: "list" }>;
      remember(true);
      let out: MdBlock[];
      let focus: Path;
      if (c.item > 0) {
        // The item joins the one before it: its first paragraph goes on the end of that item's last one.
        const prev = list.items[c.item - 1]!;
        const item = list.items[c.item]!;
        const last = prev.children[prev.children.length - 1];
        let children: MdBlock[];
        let offset = 0;
        if (isText(last ?? null)) {
          const lastPath = [...c.listPath, c.item - 1, prev.children.length - 1];
          const lastEl = fieldEl(f.blockId, lastPath);
          offset = lastEl ? lengthOf(lastEl) : 0;
          children = [...prev.children.slice(0, -1), { ...(last as TextBlock), inlines: [...(last as TextBlock).inlines, ...node.inlines] }, ...item.children.slice(1)];
          focus = lastPath;
        } else {
          children = [...prev.children, ...item.children];
          focus = [...c.listPath, c.item - 1, prev.children.length];
        }
        const items = [...list.items.slice(0, c.item - 1), { ...prev, children }, ...list.items.slice(c.item + 1)];
        out = replaceAt(tree, c.listPath, [{ ...list, items }]);
        commit(f.blockId, out);
        redrawBlock(f.blockId);
        const t = fieldEl(f.blockId, focus);
        if (t) placeCaret(t, offset);
        return true;
      }
      // The first item leaves the list, before it.
      const r = toggleList(tree, f.path, list.ordered);
      out = r.tree;
      focus = r.focus;
      commit(f.blockId, out);
      redrawBlock(f.blockId);
      const t = fieldEl(f.blockId, focus);
      if (t) placeCaret(t, 0);
      return true;
    }
    const prev = neighbour(el, -1);
    if (!prev) return false;
    const pf = fields.get(prev);
    if (pf?.kind === "inline") {
      join(prev, el);
      return true;
    }
    if (node.inlines.length === 0) {
      // An empty paragraph after a code block, a rule or a kept part: it goes.
      remember(true);
      commit(f.blockId, removeAt(tree, f.path));
      redrawBlock(f.blockId);
      if (pf) placeCaret(prev, lengthOf(prev));
      return true;
    }
    return false;
  }

  function deleteAtEnd(el: HTMLElement): boolean {
    const next = neighbour(el, 1);
    if (!next || fields.get(next)?.kind !== "inline") return false;
    join(el, next);
    return true;
  }

  // ---------------------------------------------------------------- marks and links
  /** The field the selection is in (both ends), and the range. */
  function selectionField(): { el: HTMLElement; range: Range } | null {
    const sel = doc.getSelection();
    if (!sel || sel.rangeCount === 0) {
      if (lastRange && fieldOf(lastRange.startContainer)) return { el: fieldOf(lastRange.startContainer)!, range: lastRange };
      return null;
    }
    const range = sel.getRangeAt(0);
    const a = fieldOf(range.startContainer);
    const b = fieldOf(range.endContainer);
    if (a && a === b) return { el: a, range };
    if (lastRange) {
      const c = fieldOf(lastRange.startContainer);
      if (c && c === fieldOf(lastRange.endContainer)) return { el: c, range: lastRange };
    }
    return null;
  }

  const ancestor = (n: Node, el: HTMLElement, test: (e: HTMLElement) => boolean): HTMLElement | null => {
    for (let e: Node | null = n; e && e !== el; e = e.parentNode) if (e.nodeType === 1 && test(e as HTMLElement)) return e as HTMLElement;
    return null;
  };
  const MARK_TAGS: Record<"strong" | "em" | "code", string[]> = { strong: ["STRONG", "B"], em: ["EM", "I"], code: ["CODE"] };

  /** Every piece of text the range covers is inside one of `tags`. */
  function allMarked(range: Range, el: HTMLElement, tags: string[]): boolean {
    const walker = doc.createTreeWalker(el, 4);
    let any = false;
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (!range.intersectsNode(t) || (t as Text).data === "") continue;
      if (t === range.endContainer && range.endOffset === 0) continue;
      if (t === range.startContainer && range.startOffset === (t as Text).data.length) continue;
      if (!ancestor(t, el, (e) => tags.includes(e.tagName))) return false;
      any = true;
    }
    return any;
  }

  /** Same marks side by side become one; empty ones go. */
  function tidyDom(el: HTMLElement): void {
    const walk = (n: Node) => {
      for (const c of Array.from(n.childNodes)) {
        if (c.nodeType !== 1) continue;
        const e = c as HTMLElement;
        if (e.dataset.raw !== undefined) continue;
        walk(e);
        if (e.tagName !== "BR" && (e.textContent ?? "") === "" && !e.querySelector("br,[data-raw]")) {
          e.remove();
          continue;
        }
        const prev = e.previousSibling as HTMLElement | null;
        if (prev && prev.nodeType === 1 && prev.tagName === e.tagName && prev.className === e.className && prev.dataset.dest === e.dataset.dest && prev.dataset.raw === undefined && e.tagName !== "BR") {
          prev.append(...Array.from(e.childNodes));
          e.remove();
        }
      }
    };
    walk(el);
    el.normalize();
  }

  function mark(which: "strong" | "em" | "code"): void {
    const s = selectionField();
    if (!s || fields.get(s.el)?.kind !== "inline" || s.range.collapsed) return;
    const { el, range } = s;
    const tags = MARK_TAGS[which];
    const inside = ancestor(range.commonAncestorContainer, el, (e) => tags.includes(e.tagName));
    let selected: Node[];
    if (!inside && allMarked(range, el, tags)) {
      // Off, over several marked runs: the selection comes out of them as plain text.
      const frag = range.extractContents();
      frag.querySelectorAll(tags.join(",").toLowerCase()).forEach((m) => m.replaceWith(...Array.from(m.childNodes)));
      selected = Array.from(frag.childNodes);
      range.insertNode(frag);
    } else if (inside) {
      // Off: the mark is cut around the selection.
      const after = doc.createRange();
      after.setStart(range.endContainer, range.endOffset);
      after.setEnd(inside, inside.childNodes.length);
      const tail = after.extractContents();
      const before = doc.createRange();
      before.setStart(inside, 0);
      before.setEnd(range.startContainer, range.startOffset);
      const head = before.extractContents();
      const a = inside.cloneNode(false) as HTMLElement;
      a.append(head);
      const b = inside.cloneNode(false) as HTMLElement;
      b.append(tail);
      selected = Array.from(inside.childNodes);
      inside.before(a, ...selected);
      inside.replaceWith(b);
    } else {
      // On: the selection goes in one mark (the same mark inside it is let go).
      const frag = range.extractContents();
      const wrap = doc.createElement(which);
      if (which === "code") {
        wrap.className = "doc-code";
        wrap.textContent = frag.textContent ?? "";
      } else {
        frag.querySelectorAll(tags.join(",").toLowerCase()).forEach((m) => m.replaceWith(...Array.from(m.childNodes)));
        wrap.append(frag);
      }
      range.insertNode(wrap);
      selected = [wrap];
    }
    tidyDom(el);
    afterDomEdit(el, selected);
  }

  /** After the editor changed a field's DOM itself: the model follows and the change is selected. */
  function afterDomEdit(el: HTMLElement, selected: Node[]): void {
    remember(true);
    lastPush = 0;
    const f = fields.get(el)!;
    const tree = treeOf(f.blockId);
    const node = nodeAt(tree, f.path);
    if (isText(node)) {
      const inlines = reconcileInlines(node.inlines, tidyInlines(readInlines(el, f.raws)));
      commit(f.blockId, replaceAt(tree, f.path, [{ ...node, inlines }]));
    }
    const live = selected.filter((n) => n.isConnected);
    el.focus({ preventScroll: true });
    const sel = doc.getSelection();
    if (sel && live.length) {
      const r = doc.createRange();
      r.setStartBefore(live[0]!);
      r.setEndAfter(live[live.length - 1]!);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    refreshTools();
  }

  let currentLink: HTMLElement | null = null;

  function linkCommand(): void {
    const s = selectionField();
    if (!s || fields.get(s.el)?.kind !== "inline") return;
    const existing = ancestor(s.range.commonAncestorContainer, s.el, (e) => e.classList.contains("doc-link"));
    if (existing) {
      showLinkBar(existing, true);
      return;
    }
    if (s.range.collapsed) return;
    const frag = s.range.extractContents();
    frag.querySelectorAll(".doc-link").forEach((m) => m.replaceWith(...Array.from(m.childNodes)));
    const a = doc.createElement("span");
    a.className = "doc-link";
    a.dataset.dest = "";
    a.append(frag);
    s.range.insertNode(a);
    tidyDom(s.el);
    afterDomEdit(s.el, [a]);
    showLinkBar(a, true);
  }

  function showLinkBar(link: HTMLElement | null, focusInput = false): void {
    currentLink = link;
    linkBar.hidden = !link || ctx.readOnly;
    if (!link) return;
    if (doc.activeElement !== linkInput) linkInput.value = link.dataset.dest ?? "";
    if (focusInput) {
      linkInput.focus();
      linkInput.select();
    }
  }

  function setDestination(value: string): void {
    const link = currentLink;
    if (!link || !link.isConnected) return;
    const el = fieldOf(link);
    if (!el || link.dataset.dest === value) return;
    link.dataset.dest = value;
    link.title = value;
    sync(el);
  }

  linkInput.addEventListener("input", () => setDestination(linkInput.value));
  const backToLink = () => {
    const link = currentLink;
    const el = link && fieldOf(link);
    if (!link || !el) return;
    el.focus({ preventScroll: true });
    const r = doc.createRange();
    r.selectNodeContents(link);
    r.collapse(false);
    const sel = doc.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  };
  linkInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      backToLink();
    }
  });
  linkDone.addEventListener("click", backToLink);
  unlinkBtn.addEventListener("click", () => {
    const link = currentLink;
    const el = link && fieldOf(link);
    if (!link || !el) return;
    const kids = Array.from(link.childNodes);
    link.replaceWith(...kids);
    tidyDom(el);
    showLinkBar(null);
    afterDomEdit(el, kids);
  });

  // ---------------------------------------------------------------- block commands
  function focusedField(): { el: HTMLElement; f: Field } | null {
    const s = selectionField();
    const el = s?.el ?? fieldOf(doc.activeElement);
    const f = el ? fields.get(el) : undefined;
    return el && f ? { el, f } : null;
  }

  function kindCommand(value: string): void {
    const at = focusedField();
    if (!at || at.f.kind !== "inline") return refreshTools();
    const offset = caretIn(at.el) ?? 0;
    const tree = treeOf(at.f.blockId);
    remember(true);
    commit(at.f.blockId, setTextKind(tree, at.f.path, value === "p" ? { type: "paragraph" } : { type: "heading", level: Number(value) }));
    redrawBlock(at.f.blockId);
    const t = fieldEl(at.f.blockId, at.f.path);
    if (t) placeCaret(t, offset);
    refreshTools();
  }

  function listCommand(ordered: boolean): void {
    const at = focusedField();
    if (!at || at.f.kind !== "inline") return;
    const node = nodeAt(treeOf(at.f.blockId), at.f.path);
    if (node?.type !== "paragraph") return;
    const offset = caretIn(at.el) ?? 0;
    remember(true);
    const r = toggleList(treeOf(at.f.blockId), at.f.path, ordered);
    commit(at.f.blockId, r.tree);
    redrawBlock(at.f.blockId);
    const t = fieldEl(at.f.blockId, r.focus);
    if (t) placeCaret(t, offset);
    refreshTools();
  }

  // ---------------------------------------------------------------- undo
  function restore(s: Snapshot): void {
    model = s.model;
    trees.clear();
    for (const [k, v] of s.trees) trees.set(k, v);
    drawAll();
    ctx.changed();
    if (s.caret) {
      const t = fieldEl(s.caret.blockId, s.caret.path);
      if (t) placeCaret(t, s.caret.offset);
    }
  }

  function history(back: boolean): void {
    const from = back ? undo : redo;
    const to = back ? redo : undo;
    const s = from.pop();
    if (!s) return;
    to.push(snapshot());
    lastPush = 0;
    restore(s);
  }

  // ---------------------------------------------------------------- plain-text insertion (paste, drop, line breaks)
  function insertAtCaret(el: HTMLElement, nodes: Node[], range?: Range): void {
    const sel = doc.getSelection();
    const r = range ?? (sel && sel.rangeCount ? sel.getRangeAt(0) : null);
    if (!r || !el.contains(r.startContainer)) return;
    r.deleteContents();
    const frag = doc.createDocumentFragment();
    frag.append(...nodes);
    const last = nodes[nodes.length - 1];
    r.insertNode(frag);
    if (last) {
      const after = doc.createRange();
      after.setStartAfter(last);
      after.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(after);
    }
  }

  function pasteText(el: HTMLElement, text: string, range?: Range): void {
    const f = fields.get(el)!;
    const node = nodeAt(treeOf(f.blockId), f.path);
    let clean = text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
    if (node?.type === "heading") clean = clean.replace(/\n+/g, " ");
    if (clean === "") return;
    remember(true);
    insertAtCaret(el, [doc.createTextNode(clean)], range);
    sync(el);
  }

  // ---------------------------------------------------------------- events
  page.addEventListener("beforeinput", (e) => {
    const el = fieldOf(e.target as Node);
    if (!el || ctx.readOnly) return;
    const f = fields.get(el)!;
    if (e.isComposing) return;
    switch (e.inputType) {
      case "historyUndo":
      case "historyRedo":
        e.preventDefault();
        return history(e.inputType === "historyUndo");
      case "insertParagraph":
        e.preventDefault();
        if (f.kind === "code") return pasteText(el, "\n");
        return split(el);
      case "insertLineBreak": {
        e.preventDefault();
        if (f.kind === "code") return pasteText(el, "\n");
        const node = nodeAt(treeOf(f.blockId), f.path);
        if (node?.type === "heading") return;
        remember(true);
        const atEnd = caretIn(el) === lengthOf(el);
        // At the end, a second break shows the new line (a break that ends a paragraph is not written).
        insertAtCaret(el, atEnd ? [doc.createElement("br"), doc.createElement("br")] : [doc.createElement("br")]);
        if (atEnd) {
          const sel = doc.getSelection();
          const r = sel?.getRangeAt(0);
          const lastBr = el.lastChild;
          if (r && lastBr) {
            r.setStartBefore(lastBr);
            r.collapse(true);
          }
        }
        return sync(el);
      }
      case "insertFromPaste":
      case "insertFromPasteAsQuotation":
      case "insertFromDrop":
      case "insertReplacementText":
      case "insertFromYank": {
        e.preventDefault();
        const text = e.dataTransfer?.getData("text/plain") ?? e.data ?? "";
        const target = e.getTargetRanges?.()[0];
        let range: Range | undefined;
        if (target) {
          range = doc.createRange();
          range.setStart(target.startContainer, target.startOffset);
          range.setEnd(target.endContainer, target.endOffset);
        }
        return pasteText(el, text, range);
      }
      case "formatBold":
        e.preventDefault();
        return mark("strong");
      case "formatItalic":
        e.preventDefault();
        return mark("em");
      case "deleteContentBackward": {
        const sel = doc.getSelection();
        if (f.kind === "inline" && sel?.isCollapsed && caretIn(el) === 0) {
          if (backspaceAtStart(el)) e.preventDefault();
        }
        return;
      }
      case "deleteContentForward": {
        const sel = doc.getSelection();
        if (f.kind === "inline" && sel?.isCollapsed && caretIn(el) === lengthOf(el)) {
          if (deleteAtEnd(el)) e.preventDefault();
        }
        return;
      }
      default:
        // Formats Markdown cannot write here (underline, colours, fonts…) are refused; text goes in as typed.
        if (e.inputType.startsWith("format")) e.preventDefault();
    }
  });

  page.addEventListener("input", (e) => {
    const el = fieldOf(e.target as Node);
    if (el) sync(el);
  });
  page.addEventListener("compositionend", (e) => {
    const el = fieldOf(e.target as Node);
    if (el) sync(el);
  });
  page.addEventListener("drop", (e) => {
    // Files dropped on the page are not inserted (the editor writes text only).
    if (e.dataTransfer?.files.length) e.preventDefault();
  });

  page.addEventListener("keydown", (e) => {
    const el = fieldOf(e.target as Node);
    if (!el) return;
    const k = e.key.toLowerCase();
    const cmd = e.metaKey || e.ctrlKey;
    if (cmd && !e.altKey && !e.shiftKey && !ctx.readOnly) {
      if (k === "b" || k === "i" || k === "e") {
        e.preventDefault();
        return mark(k === "b" ? "strong" : k === "i" ? "em" : "code");
      }
      if (k === "k") {
        e.preventDefault();
        return linkCommand();
      }
    }
    if (cmd && (k === "z" || k === "y") && !ctx.readOnly) {
      e.preventDefault();
      return history(!(k === "y" || e.shiftKey));
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !cmd && !e.altKey) {
      // From the first or last line of a field to the field before or after it.
      const sel = doc.getSelection();
      if (!sel?.isCollapsed || sel.rangeCount === 0) return;
      const rect = sel.getRangeAt(0).getClientRects()[0] ?? null;
      const box = el.getBoundingClientRect();
      const line = parseFloat(win.getComputedStyle(el).lineHeight) || 18;
      const up = e.key === "ArrowUp";
      const edge = rect ? (up ? rect.top - box.top < line * 0.8 : box.bottom - rect.bottom < line * 0.8) : (caretIn(el) ?? 0) === (up ? 0 : lengthOf(el));
      if (!edge) return;
      const fieldsOnly = sequence().filter((x) => fields.has(x));
      const target = fieldsOnly[fieldsOnly.indexOf(el) + (up ? -1 : 1)];
      if (!target) return;
      e.preventDefault();
      placeCaret(target, up ? lengthOf(target) : 0);
    }
  });

  // ---------------------------------------------------------------- the toolbar follows the caret
  let lastRange: Range | null = null;
  const onSelection = () => {
    const sel = doc.getSelection();
    if (sel && sel.rangeCount && fieldOf(sel.getRangeAt(0).startContainer)) lastRange = sel.getRangeAt(0).cloneRange();
    refreshTools();
  };
  doc.addEventListener("selectionchange", onSelection);

  function refreshTools(): void {
    const sel = doc.getSelection();
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : lastRange;
    const el = range ? fieldOf(range.startContainer) : null;
    const f = el ? fields.get(el) : undefined;
    const node = f ? nodeAt(treeOf(f.blockId), f.path) : null;
    const inline = f?.kind === "inline";
    kind.disabled = !inline;
    for (const b of [boldBtn, italicBtn, codeBtn, linkBtn]) b.disabled = !inline;
    bulletBtn.disabled = numberBtn.disabled = node?.type !== "paragraph";
    kind.value = node?.type === "heading" ? String(Math.min(6, Math.max(1, node.level))) : "p";
    const within = (tags: string[]) => !!(range && el && ancestor(range.startContainer, el, (e) => tags.includes(e.tagName)));
    boldBtn.setAttribute("aria-pressed", String(within(MARK_TAGS.strong)));
    italicBtn.setAttribute("aria-pressed", String(within(MARK_TAGS.em)));
    codeBtn.setAttribute("aria-pressed", String(within(MARK_TAGS.code)));
    const c = f && node && f.path.length > 1 ? containerOf(f.path, treeOf(f.blockId)) : null;
    const list = c?.kind === "item" ? nodeAt(treeOf(f!.blockId), c.listPath) : null;
    bulletBtn.setAttribute("aria-pressed", String(list?.type === "list" && !list.ordered));
    numberBtn.setAttribute("aria-pressed", String(list?.type === "list" && list.ordered));
    // The link bar shows while the caret is in a link (or while its field is being typed in).
    if (doc.activeElement === linkInput || linkBar.contains(doc.activeElement)) return;
    const link = range && el ? ancestor(range.startContainer, el, (e) => e.classList.contains("doc-link")) : null;
    showLinkBar(link);
  }

  // ---------------------------------------------------------------- start
  drawAll();
  refreshTools();

  return {
    element: root,
    edited: () => model.edited,
    text() {
      const r = model.serialize();
      if (r.ok) return { ok: true, text: r.text };
      return { ok: false, reasons: r.blocks.map((b) => b.message) };
    },
    notices: () => model.notices.map((n) => n.message),
    reveal(position, anchor) {
      let target: HTMLElement | null = null;
      if (position) {
        // The block that holds the line's start.
        const src = model.source;
        let offset = 0;
        for (let line = 1; line < position.line && offset >= 0; line++) {
          const nl = src.indexOf("\n", offset);
          offset = nl < 0 ? -1 : nl + 1;
        }
        if (offset >= 0) {
          let best: string | null = null;
          for (const b of model.blocks) if (b.span && b.span.start <= offset) best = b.id;
          if (best) target = blockEls.get(best) ?? null;
        }
      } else if (anchor) {
        const want = slug(anchor);
        for (const h of Array.from(page.querySelectorAll<HTMLElement>(".doc-h"))) {
          const f = fields.get(h);
          const node = f ? nodeAt(treeOf(f.blockId), f.path) : null;
          if (isText(node) && slug(plainText(node.inlines)) === want) {
            target = h;
            break;
          }
        }
      }
      if (!target) return;
      target.scrollIntoView({ block: "start" });
      target.classList.add("doc-target");
      win.setTimeout(() => target!.classList.remove("doc-target"), 2400);
    },
    focus() {
      const first = page.querySelector<HTMLElement>(".doc-field");
      if (first && !ctx.readOnly) placeCaret(first, 0);
      else page.focus();
    },
    destroy() {
      doc.removeEventListener("selectionchange", onSelection);
      root.remove();
    },
  };
}
