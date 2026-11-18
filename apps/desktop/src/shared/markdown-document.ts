// "Mở": the Markdown model (T2). A Markdown file as a list of top-level blocks that keep their place in the source, so a
// save writes only what was edited and every other byte stays (AC5). Design: docs/superpowers/specs/2026-11-18-desktop-open-markdown-design.md
// section 7; the API it implements is `MarkdownDocument` in `shared/documents.ts`.
//
// Pure TypeScript with no import but types: the renderer (the editor) and main both load it, and it is tested as it is.
// It does not use the chat's parser (`packages/webview/src/markdown.ts`): that one normalizes and drops source detail,
// which is right for drawing and wrong for writing back.
//
// How it stays faithful:
//  - The source is cut into blocks by lines (`scan`); what lies between them (blank lines), the BOM and the final newline
//    belong to no block and are never touched. Unedited, `serialize()` is the source itself.
//  - A block the editor cannot rewrite safely (raw HTML, a table, front matter, a definition, a footnote) is `editable:
//    false`: it is kept whole, and an edit in it is refused with the reason.
//  - A block the editor can rewrite is given as a tree (`MdBlock`, from `parseBlocks`). Every node read from the file
//    keeps its `source`; `renderBlocks` writes a node that is unchanged from its `source` (compared by structure), so only
//    the changed part is written again, and what is new is escaped (`escapeText`), with a delimiter or fence that cannot
//    clash with its content.
//  - Before `serialize()` gives text, the result is read again: the blocks it should hold (the unedited ones byte for byte,
//    the edited ones as what the editor wrote) must be exactly what a new parse finds, and an edit made from a tree must
//    read back as that tree. If not, there is no text (`roundtrip-mismatch`).
//
// For the editor (T4):
//  - `parseMarkdownDocument(text)` opens a file. `blocks` lists the top-level blocks; draw `structure(id)` (a tree) for an
//    editable one and `blockSource(id)` (LF line endings) for the rest, with `notices` shown when the file opens.
//  - To save a change, give back the block's tree with only the changed nodes altered: copy a node with `{ ...node, value }`
//    (keep its `source`: it is how a node that did not change is written exactly as it was, and how the unchanged ends of a
//    changed text keep their escapes) and call `replaceNodes(id, nodes)`; `insertNodes` adds blocks. A node made from
//    scratch has no `source` and is written fresh and escaped. `raw` marks and `raw` blocks must be passed on as they are.
//    `replace(id, markdown)` / `insert(afterId, markdown)` take Markdown text instead, for what the editor writes itself.
//  - `edited` is the unsaved mark. `serialize()` is `ok: false` with the reasons (`SaveBlock`) when the text cannot be written
//    safely: nothing is written then, and the edits stay in the document.
//  - The writers are exported too (`renderBlocks`, `escapeText`, `renderCodeSpan`, `renderFence`, `renderDestination`,
//    `renderTitle`) for an editor that wants to preview what it would write.
import type { MarkdownBlockInfo, MarkdownDocument, SaveBlock, SerializeResult } from "./documents.js";

// ------------------------------------------------------------------ the tree the editor works on
export type MdInline =
  | { type: "text"; value: string; source?: string }
  | { type: "code"; value: string; source?: string }
  | { type: "emphasis" | "strong"; children: MdInline[]; source?: string }
  | { type: "link"; children: MdInline[]; destination: string; title: string | null; source?: string }
  /** A hard line break. */
  | { type: "break"; source?: string }
  /** A line break inside a paragraph. */
  | { type: "softbreak"; source?: string }
  /** A construct the editor does not edit (an image, inline HTML, a reference link, an autolink, a footnote reference, ~~strikethrough~~): written back as it was. */
  | { type: "raw"; construct: string; source: string };

export interface MdListItem {
  /** A task list item: `true`/`false` for `[x]`/`[ ]`, `null` for a plain item. */
  checked: boolean | null;
  children: MdBlock[];
  source?: string;
}

export type MdBlock =
  | { type: "paragraph"; inlines: MdInline[]; source?: string }
  | { type: "heading"; level: number; inlines: MdInline[]; source?: string }
  /** `fence`: the fence as written (```` ``` ````, `~~~`), `null` for an indented block. */
  | { type: "code"; value: string; info: string; fence: string | null; source?: string }
  | { type: "rule"; source?: string }
  /** `marker`: the bullet (`-`, `+`, `*`) or, for an ordered list, its delimiter (`.` or `)`). */
  | { type: "list"; ordered: boolean; start: number; marker: string; tight: boolean; items: MdListItem[]; source?: string }
  | { type: "quote"; children: MdBlock[]; source?: string }
  /** What the editor shows and writes back as it is: HTML, a table, front matter, a definition, a footnote. */
  | { type: "raw"; construct: string; source: string };

/** A document the editor can change by tree as well as by text. */
export interface EditableMarkdownDocument extends MarkdownDocument {
  /** The tree of the block's current text (an edited block may read as several blocks, or none). */
  structure(blockId: string): MdBlock[];
  /** The block becomes these nodes, written by `renderBlocks`; `serialize()` refuses unless they read back as the same tree. */
  replaceNodes(blockId: string, nodes: readonly MdBlock[]): EditableMarkdownDocument;
  insertNodes(afterBlockId: string | null, nodes: readonly MdBlock[]): EditableMarkdownDocument;
  /** The reference-definition labels of the file: links to them are kept as they are. */
  readonly labels: ReadonlySet<string>;
  replace(blockId: string, markdown: string): EditableMarkdownDocument;
  insert(afterBlockId: string | null, markdown: string): EditableMarkdownDocument;
}

// ------------------------------------------------------------------ characters
const ASCII_PUNCT = /^[!-/:-@[-`{-~]$/;
const isPunct = (c: string): boolean => c !== "" && /^[\p{P}\p{S}]$/u.test(c);
const isSpace = (c: string): boolean => c === "" || /^\s$/u.test(c);
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "©", reg: "®", hellip: "…", mdash: "—", ndash: "–",
  laquo: "«", raquo: "»", middot: "·", times: "×",
};
const ENTITY = /^&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/;

function decodeEntity(body: string): string | null {
  if (body[0] === "#") {
    const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "\ufffd";
    return String.fromCodePoint(cp);
  }
  return NAMED_ENTITIES[body] ?? null;
}

/** A backslash escape or an entity resolved; the rest as it is. */
function unescapeString(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; ) {
    const c = raw[i]!;
    if (c === "\\" && ASCII_PUNCT.test(raw[i + 1] ?? "")) {
      out += raw[i + 1];
      i += 2;
      continue;
    }
    if (c === "&") {
      const m = ENTITY.exec(raw.slice(i, i + 40));
      const decoded = m ? decodeEntity(m[1]!) : null;
      if (m && decoded !== null) {
        out += decoded;
        i += m[0].length;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

const normalizeLabel = (label: string): string => label.trim().replace(/\s+/g, " ").toLowerCase();

// ------------------------------------------------------------------ inline parser
type NodeItem = { t: "node"; node: MdInline; start: number; end: number };
type Delim = { t: "delim"; ch: string; count: number; orig: number; canOpen: boolean; canClose: boolean; start: number };
type Bracket = { t: "bracket"; image: boolean; start: number; active: boolean };
type Item = NodeItem | Delim | Bracket;

const AUTOLINK = /^<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/;
const ATTR = String.raw`(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>\`]+|'[^']*'|"[^"]*"))?)`;
const INLINE_HTML = new RegExp(
  String.raw`^(?:<[A-Za-z][A-Za-z0-9-]*${ATTR}*\s*/?>|</[A-Za-z][A-Za-z0-9-]*\s*>|<!--(?:[^]*?)-->|<\?(?:[^]*?)\?>|<![A-Za-z][^>]*>|<!\[CDATA\[(?:[^]*?)\]\]>)`,
);

const lastIndexOf = <T>(items: T[], pred: (x: T) => boolean): number => {
  for (let i = items.length - 1; i >= 0; i--) if (pred(items[i]!)) return i;
  return -1;
};

/** `(destination "title")` starting at `(`: where it ends and what it says, or null when it is not a link tail. */
function parseLinkTail(s: string, at: number): { end: number; destination: string; title: string | null } | null {
  if (s[at] !== "(") return null;
  const skipWs = (p: number): number => {
    let seenNewline = false;
    while (p < s.length) {
      const c = s[p]!;
      if (c === " " || c === "\t") p++;
      else if (c === "\n" && !seenNewline) {
        seenNewline = true;
        p++;
      } else break;
    }
    return p;
  };
  let p = skipWs(at + 1);
  const afterOpen = p;
  let destination = "";
  if (s[p] === "<") {
    let q = p + 1;
    for (; q < s.length; q++) {
      const c = s[q]!;
      if (c === "\n" || c === "<") return null;
      if (c === ">") break;
      if (c === "\\" && ASCII_PUNCT.test(s[q + 1] ?? "")) q++;
    }
    if (s[q] !== ">") return null;
    destination = unescapeString(s.slice(p + 1, q));
    p = q + 1;
  } else {
    let q = p;
    let depth = 0;
    for (; q < s.length; q++) {
      const c = s[q]!;
      if (c === "\\" && ASCII_PUNCT.test(s[q + 1] ?? "")) {
        q++;
        continue;
      }
      if (c === " " || c === "\t" || c === "\n" || c < " " || c === "\u007f") break;
      if (c === "(") depth++;
      else if (c === ")") {
        if (depth === 0) break;
        depth--;
      }
    }
    if (depth !== 0) return null;
    destination = unescapeString(s.slice(p, q));
    p = q;
  }
  const beforeTitle = p;
  p = skipWs(p);
  let title: string | null = null;
  const open = s[p];
  if ((open === '"' || open === "'" || open === "(") && p > beforeTitle) {
    const close = open === "(" ? ")" : open;
    let q = p + 1;
    for (; q < s.length; q++) {
      const c = s[q]!;
      if (c === "\\" && ASCII_PUNCT.test(s[q + 1] ?? "")) {
        q++;
        continue;
      }
      if (c === close) break;
      if (open === "(" && c === "(") return null;
    }
    if (s[q] !== close) return null;
    const raw = s.slice(p + 1, q);
    if (/\n[ \t]*\n/.test(raw)) return null;
    title = unescapeString(raw);
    p = skipWs(q + 1);
  }
  void afterOpen;
  if (s[p] !== ")") return null;
  return { end: p + 1, destination, title };
}

const textItem = (value: string, source: string, start: number, end: number): NodeItem => ({ t: "node", node: { type: "text", value, source }, start, end });

/** Emphasis by CommonMark's delimiter rules over a list of items; leaves delimiters that matched nothing in place. */
function processEmphasis(text: string, items: Item[]): void {
  const bottoms = new Map<string, Item>();
  let ci = 0;
  while (ci < items.length) {
    const c = items[ci]!;
    if (c.t !== "delim" || !c.canClose) {
      ci++;
      continue;
    }
    const key = `${c.ch}${c.canOpen ? 1 : 0}${c.orig % 3}`;
    const bottomItem = bottoms.get(key);
    const bottom = bottomItem ? items.indexOf(bottomItem) : -1;
    let found = -1;
    for (let oi = ci - 1; oi > bottom && oi >= 0; oi--) {
      const o = items[oi]!;
      if (o.t === "delim" && o.canOpen && o.ch === c.ch) {
        const sum = o.orig + c.orig;
        const oddMatch = (o.canClose || c.canOpen) && sum % 3 === 0 && !(o.orig % 3 === 0 && c.orig % 3 === 0);
        if (!oddMatch) {
          found = oi;
          break;
        }
      }
    }
    if (found < 0) {
      if (ci > 0) bottoms.set(key, items[ci - 1]!);
      ci++;
      continue;
    }
    const o = items[found] as Delim;
    const use = o.count >= 2 && c.count >= 2 ? 2 : 1;
    const inner = items.slice(found + 1, ci);
    const nodeStart = o.start + o.count - use;
    const nodeEnd = c.start + use;
    const children = finishItems(text, inner);
    const node: MdInline = { type: use === 2 ? "strong" : "emphasis", children, source: text.slice(nodeStart, nodeEnd) };
    o.count -= use;
    c.start += use;
    c.count -= use;
    items.splice(found + 1, ci - found - 1, { t: "node", node, start: nodeStart, end: nodeEnd });
    ci = found + 2;
    if (o.count === 0) {
      items.splice(found, 1);
      ci--;
    }
    if (c.count === 0) items.splice(ci, 1);
  }
}

/** The items as nodes: emphasis resolved, what did not match becomes text, neighbouring text joined. */
function finishItems(text: string, items: Item[]): MdInline[] {
  processEmphasis(text, items);
  const out: MdInline[] = [];
  const push = (n: MdInline): void => {
    const last = out[out.length - 1];
    if (n.type === "text" && last?.type === "text") {
      last.value += n.value;
      last.source = (last.source ?? "") + (n.source ?? "");
    } else out.push(n.type === "text" ? { ...n } : n);
  };
  for (const it of items) {
    if (it.t === "node") push(it.node);
    else if (it.t === "delim") push({ type: "text", value: it.ch.repeat(it.count), source: it.ch.repeat(it.count) });
    else push({ type: "text", value: it.image ? "![" : "[", source: it.image ? "![" : "[" });
  }
  return out;
}

/** The inline content of a paragraph or heading (its lines without the indentation, joined with `\n`). */
export function parseInlines(text: string, labels: ReadonlySet<string> = new Set()): MdInline[] {
  const items: Item[] = [];
  let buf = { value: "", source: "", start: 0 };
  const flush = (end: number): void => {
    if (buf.source !== "") items.push(textItem(buf.value, buf.source, buf.start, end));
    buf = { value: "", source: "", start: end };
  };
  const add = (value: string, source: string): void => {
    buf.value += value;
    buf.source += source;
  };
  const before = (i: number): string => {
    const s = text.slice(Math.max(0, i - 2), i);
    const cps = Array.from(s);
    const last = cps[cps.length - 1] ?? "";
    return last;
  };
  const after = (i: number): string => Array.from(text.slice(i, i + 2))[0] ?? "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\") {
      const n = text[i + 1] ?? "";
      if (ASCII_PUNCT.test(n)) {
        add(n, c + n);
        i += 2;
      } else if (n === "\n") {
        flush(i);
        items.push({ t: "node", node: { type: "break", source: "\\\n" }, start: i, end: i + 2 });
        i += 2;
        buf.start = i;
      } else {
        add("\\", "\\");
        i++;
      }
      continue;
    }
    if (c === "`") {
      let j = i;
      while (text[j] === "`") j++;
      const run = j - i;
      let k = j;
      let end = -1;
      while (k < text.length) {
        if (text[k] === "`") {
          let m = k;
          while (text[m] === "`") m++;
          if (m - k === run) {
            end = k;
            break;
          }
          k = m;
        } else k++;
      }
      if (end < 0) {
        add("`".repeat(run), "`".repeat(run));
        i = j;
        continue;
      }
      flush(i);
      let value = text.slice(j, end).replace(/\n/g, " ");
      if (value.length >= 2 && value.startsWith(" ") && value.endsWith(" ") && value.trim() !== "") value = value.slice(1, -1);
      const stop = end + run;
      items.push({ t: "node", node: { type: "code", value, source: text.slice(i, stop) }, start: i, end: stop });
      i = stop;
      buf.start = i;
      continue;
    }
    if (c === "~" && text[i + 1] === "~") {
      const m = /^~~(?=[^\s~])(?:[^~\n]|~(?!~))*?(?<=[^\s~])~~(?!~)/.exec(text.slice(i));
      if (m) {
        flush(i);
        items.push({ t: "node", node: { type: "raw", construct: "strikethrough", source: m[0] }, start: i, end: i + m[0].length });
        i += m[0].length;
        buf.start = i;
        continue;
      }
    }
    if (c === "&") {
      const m = ENTITY.exec(text.slice(i, i + 40));
      const decoded = m ? decodeEntity(m[1]!) : null;
      if (m && decoded !== null) {
        add(decoded, m[0]);
        i += m[0].length;
      } else {
        add("&", "&");
        i++;
      }
      continue;
    }
    if (c === "<") {
      const rest = text.slice(i);
      const m = AUTOLINK.exec(rest) ?? INLINE_HTML.exec(rest);
      if (m) {
        flush(i);
        const construct = AUTOLINK.test(rest) ? "autolink" : "inline html";
        items.push({ t: "node", node: { type: "raw", construct, source: m[0] }, start: i, end: i + m[0].length });
        i += m[0].length;
        buf.start = i;
      } else {
        add("<", "<");
        i++;
      }
      continue;
    }
    if (c === "*" || c === "_") {
      let j = i;
      while (text[j] === c) j++;
      const b = before(i);
      const a = after(j);
      const left = !isSpace(a) && (!isPunct(a) || isSpace(b) || isPunct(b));
      const right = !isSpace(b) && (!isPunct(b) || isSpace(a) || isPunct(a));
      const canOpen = c === "*" ? left : left && (!right || isPunct(b));
      const canClose = c === "*" ? right : right && (!left || isPunct(a));
      flush(i);
      items.push({ t: "delim", ch: c, count: j - i, orig: j - i, canOpen, canClose, start: i });
      i = j;
      buf.start = i;
      continue;
    }
    if (c === "[" || (c === "!" && text[i + 1] === "[")) {
      flush(i);
      const image = c === "!";
      items.push({ t: "bracket", image, start: i, active: true });
      i += image ? 2 : 1;
      buf.start = i;
      continue;
    }
    if (c === "]") {
      flush(i);
      const bi = lastIndexOf(items, (x) => x.t === "bracket");
      if (bi < 0) {
        add("]", "]");
        i++;
        continue;
      }
      const br = items[bi] as Bracket;
      const asText = (): void => {
        items[bi] = textItem(br.image ? "![" : "[", br.image ? "![" : "[", br.start, br.start + (br.image ? 2 : 1));
        add("]", "]");
        i++;
      };
      if (!br.active) {
        asText();
        continue;
      }
      const innerStart = br.start + (br.image ? 2 : 1);
      const inner = text.slice(innerStart, i);
      let end = -1;
      let node: MdInline | null = null;
      const tail = parseLinkTail(text, i + 1);
      if (tail) {
        end = tail.end;
        if (br.image) node = { type: "raw", construct: "image", source: text.slice(br.start, end) };
        else {
          const kids = items.splice(bi + 1);
          node = { type: "link", children: finishItems(text, kids), destination: tail.destination, title: tail.title, source: text.slice(br.start, end) };
        }
      } else if (!br.image && /^\^[^\s\]]+$/.test(inner)) {
        end = i + 1;
        node = { type: "raw", construct: "footnote reference", source: text.slice(br.start, end) };
      } else {
        let labelEnd = -1;
        let label = inner;
        if (text[i + 1] === "[") {
          let q = i + 2;
          for (; q < text.length && q < i + 1002; q++) {
            if (text[q] === "\\" && ASCII_PUNCT.test(text[q + 1] ?? "")) q++;
            else if (text[q] === "[") break;
            else if (text[q] === "]") {
              labelEnd = q;
              break;
            }
          }
          if (labelEnd >= 0) label = labelEnd === i + 2 ? inner : text.slice(i + 2, labelEnd);
        }
        if (labelEnd >= 0 && labels.has(normalizeLabel(label))) {
          end = labelEnd + 1;
          node = { type: "raw", construct: br.image ? "image" : "reference link", source: text.slice(br.start, end) };
        } else if (labelEnd < 0 && inner.trim() !== "" && labels.has(normalizeLabel(inner)) && text[i + 1] !== "(") {
          end = i + 1;
          node = { type: "raw", construct: br.image ? "image" : "reference link", source: text.slice(br.start, end) };
        }
      }
      if (!node) {
        asText();
        continue;
      }
      items.splice(bi);
      items.push({ t: "node", node, start: br.start, end });
      if (!br.image) for (const it of items) if (it.t === "bracket" && !it.image) it.active = false;
      i = end;
      buf.start = i;
      continue;
    }
    if (c === "\n") {
      const m = /( *)$/.exec(buf.source)!;
      const spaces = m[1]!.length;
      if (spaces > 0) {
        buf.value = buf.value.slice(0, buf.value.length - spaces);
        buf.source = buf.source.slice(0, buf.source.length - spaces);
      }
      flush(i - spaces);
      items.push({ t: "node", node: spaces >= 2 ? { type: "break", source: " ".repeat(spaces) + "\n" } : { type: "softbreak", source: " ".repeat(spaces) + "\n" }, start: i - spaces, end: i + 1 });
      i++;
      buf.start = i;
      continue;
    }
    add(c, c);
    i++;
  }
  flush(i);
  return normalizeInlines(finishItems(text, items), true);
}

// ------------------------------------------------------------------ normal form of inlines (for comparing and writing)
const trimStart = (s: string): string => s.replace(/^[ \t]+/, "");
const trimEnd = (s: string): string => s.replace(/[ \t]+$/, "");

/**
 * The inlines as the reader would find them back: text joined, empty text gone, the blanks at the edges of a line gone,
 * the blanks inside the edge of emphasis moved out of it (they could not open it). `top`: a paragraph's or heading's own
 * list, whose lines start and end where breaks and the ends of the list are.
 */
export function normalizeInlines(nodes: readonly MdInline[], top = false): MdInline[] {
  const out: MdInline[] = [];
  const pushText = (value: string, source?: string): void => {
    if (value === "") return;
    const last = out[out.length - 1];
    if (last?.type === "text") {
      last.source = last.source !== undefined && source !== undefined ? last.source + source : undefined;
      if (last.source === undefined) delete last.source;
      last.value += value;
    } else out.push(source === undefined ? { type: "text", value } : { type: "text", value, source });
  };
  for (const n of nodes) {
    if (n.type === "text" && n.value.includes("\n")) {
      // a line break inside a text value is a soft break
      n.value.split("\n").forEach((part, k) => {
        if (k > 0) out.push({ type: "softbreak" });
        pushText(part);
      });
    } else if (n.type === "text") pushText(n.value, n.source);
    else if (n.type === "emphasis" || n.type === "strong") {
      const kids = normalizeInlines(n.children);
      const first = kids[0];
      const lastKid = kids[kids.length - 1];
      let lead = "";
      let trail = "";
      if (first?.type === "text") {
        lead = /^\s*/.exec(first.value)![0];
        if (lead !== "") {
          first.value = first.value.slice(lead.length);
        }
      }
      const l2 = kids[kids.length - 1];
      if (l2?.type === "text" && l2 === lastKid) {
        trail = /\s*$/.exec(l2.value)![0];
        if (trail !== "") l2.value = l2.value.slice(0, l2.value.length - trail.length);
      }
      const kept = kids.filter((k) => !(k.type === "text" && k.value === ""));
      pushText(lead);
      if (kept.length > 0) out.push({ ...n, children: kept });
      pushText(trail);
    } else if (n.type === "link") out.push({ ...n, children: normalizeInlines(n.children) });
    else out.push({ ...n });
  }
  if (!top) return out;
  const res: MdInline[] = [];
  let lineStart = true;
  for (let k = 0; k < out.length; k++) {
    const n = out[k]!;
    const next = out[k + 1];
    if (n.type === "text") {
      let v = n.value;
      if (lineStart) v = trimStart(v);
      if (!next || next.type === "softbreak" || next.type === "break") v = trimEnd(v);
      if (v === "") continue;
      res.push(v === n.value ? n : { type: "text", value: v, ...(n.source !== undefined ? { source: n.source } : {}) });
      lineStart = false;
    } else if (n.type === "softbreak" || n.type === "break") {
      if (res.length === 0) continue;
      res.push(n);
      lineStart = true;
    } else {
      res.push(n);
      lineStart = false;
    }
  }
  while (res.length > 0 && (res[res.length - 1]!.type === "softbreak" || res[res.length - 1]!.type === "break")) res.pop();
  return res;
}

// ------------------------------------------------------------------ the shape of a tree (what "the same" means)
type Shape = string | number | boolean | null | Shape[];

function inlineShape(n: MdInline): Shape {
  switch (n.type) {
    case "text":
      return ["t", n.value];
    case "code":
      return ["c", n.value];
    case "emphasis":
    case "strong":
      return [n.type, n.children.map(inlineShape)];
    case "link":
      return ["a", n.destination, n.title, n.children.map(inlineShape)];
    case "break":
    case "softbreak":
      return n.type;
    case "raw":
      return ["raw", n.source];
  }
}

function blockShape(b: MdBlock): Shape {
  switch (b.type) {
    case "paragraph":
      return ["p", normalizeInlines(b.inlines, true).map(inlineShape)];
    case "heading":
      return ["h", b.level, normalizeInlines(headingInlines(b.inlines), true).map(inlineShape)];
    case "code":
      return ["code", b.info, b.value];
    case "rule":
      return ["rule"];
    case "quote":
      return ["q", b.children.map(blockShape).filter(notEmpty)];
    case "list":
      return ["l", b.ordered, b.ordered ? b.start : 0, b.items.map(itemShape)];
    case "raw":
      return ["raw", b.construct, b.source];
  }
}
const notEmpty = (s: Shape): boolean => !(Array.isArray(s) && (s[0] === "p" || s[0] === "h") && (s[s.length - 1] as Shape[]).length === 0);
const itemShape = (it: MdListItem): Shape => [it.checked, it.children.map(blockShape).filter(notEmpty)];

/** A heading is one line: its breaks are blanks. */
function headingInlines(inlines: readonly MdInline[]): MdInline[] {
  return inlines.map((n): MdInline => (n.type === "softbreak" || n.type === "break" ? { type: "text", value: " " } : n));
}

// ------------------------------------------------------------------ block scanner: where blocks start and end
type Seg = {
  kind: "paragraph" | "heading" | "code" | "rule" | "list" | "quote" | "raw";
  from: number;
  to: number;
  construct?: string;
  level?: number;
  fence?: { open: string; ch: string; len: number; indent: number; info: string; closed: boolean };
  /** A quote's lines without the `>`; its children's `from`/`to` index into them. */
  lines?: string[];
  children?: Seg[];
  list?: { ordered: boolean; start: number; marker: string; tight: boolean; items: ItemSeg[] };
};
interface ItemSeg {
  from: number;
  to: number;
  lines: string[];
  children: Seg[];
  checked: boolean | null;
}
interface ScanCtx {
  labels: Set<string>;
}

const isBlank = (l: string): boolean => /^[ \t]*$/.test(l);
function indentOf(line: string): number {
  let col = 0;
  for (const ch of line) {
    if (ch === " ") col++;
    else if (ch === "\t") col += 4 - (col % 4);
    else break;
  }
  return col;
}
function stripIndent(line: string, n: number): string {
  let col = 0;
  let i = 0;
  while (i < line.length && col < n) {
    const ch = line[i]!;
    if (ch === " ") {
      col++;
      i++;
    } else if (ch === "\t") {
      const w = 4 - (col % 4);
      if (col + w > n) return " ".repeat(col + w - n) + line.slice(i + 1);
      col += w;
      i++;
    } else break;
  }
  return line.slice(i);
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const FOOTNOTE_DEF = /^ {0,3}\[\^[^\]\s]+\]:/;
const LINK_DEF = /^ {0,3}\[(?!\^)((?:[^\]\\]|\\.)+)\]:[ \t]*(<[^>\n]*>|\S+)(?:[ \t]+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^)\\]|\\.)*\)))?[ \t]*$/;
const TITLE_LINE = /^[ \t]*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^)\\]|\\.)*\))[ \t]*$/;
const BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const HTML_TYPE6 = new RegExp(`^<\\/?(?:${BLOCK_TAGS})(?:[ \\t]|\\/?>|$)`, "i");
const HTML_TYPE7 = new RegExp(
  String.raw`^(?:<[A-Za-z][A-Za-z0-9-]*${ATTR}*\s*/?>|</[A-Za-z][A-Za-z0-9-]*\s*>)\s*$`,
);

function parseAtx(line: string): { level: number; content: string } | null {
  const m = ATX.exec(line);
  if (!m) return null;
  let content = (m[2] ?? "").replace(/[ \t]+$/, "");
  content = content.replace(/(^|[ \t]+)#+$/, "");
  return { level: m[1]!.length, content: content.trim() };
}

function parseFenceOpen(line: string): { ch: string; len: number; indent: number; info: string; open: string } | null {
  const m = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*?)[ \t]*$/.exec(line);
  if (!m) return null;
  const ch = m[2]![0]!;
  if (ch === "`" && m[3]!.includes("`")) return null;
  return { ch, len: m[2]!.length, indent: m[1]!.length, info: m[3]!, open: m[2]! };
}

interface Marker {
  indent: number;
  ordered: boolean;
  start: number;
  /** the bullet character, or the delimiter of an ordered marker */
  marker: string;
  /** column of the item's content */
  width: number;
  empty: boolean;
  first: string;
}
function listMarker(line: string): Marker | null {
  const m = /^( {0,3})([-+*]|(\d{1,9})([.)]))(?=[ \t]|$)/.exec(line);
  if (!m) return null;
  const rest = line.slice(m[0].length);
  const markerLen = m[2]!.length;
  const base: Omit<Marker, "width" | "empty" | "first"> = { indent: m[1]!.length, ordered: m[3] !== undefined, start: m[3] !== undefined ? parseInt(m[3], 10) : 0, marker: m[4] ?? m[2]! };
  if (isBlank(rest)) return { ...base, width: base.indent + markerLen + 1, empty: true, first: "" };
  const spaces = indentOf(rest);
  const cols = spaces >= 5 ? 1 : spaces;
  return { ...base, width: base.indent + markerLen + cols, empty: false, first: stripIndent(rest, cols) };
}

function htmlStart(line: string): { type: number; end: RegExp | null } | null {
  if (indentOf(line) >= 4) return null;
  const l = line.replace(/^ {0,3}/, "");
  if (/^<(?:script|pre|style|textarea)(?:[ \t>]|$)/i.test(l)) return { type: 1, end: /<\/(?:script|pre|style|textarea)>/i };
  if (l.startsWith("<!--")) return { type: 2, end: /-->/ };
  if (l.startsWith("<?")) return { type: 3, end: /\?>/ };
  if (/^<!\[CDATA\[/.test(l)) return { type: 5, end: /\]\]>/ };
  if (/^<![A-Za-z]/.test(l)) return { type: 4, end: />/ };
  if (HTML_TYPE6.test(l)) return { type: 6, end: null };
  if (HTML_TYPE7.test(l)) return { type: 7, end: null };
  return null;
}

function tableCells(line: string): string[] | null {
  let t = line.trim();
  if (!t.includes("|")) return null;
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/);
}
const isDelimRow = (line: string): boolean => {
  const cells = tableCells(line);
  return cells !== null && cells.every((c) => /^[ \t]*:?-+:?[ \t]*$/.test(c));
};
const tableAt = (lines: string[], i: number): boolean => {
  if (i + 1 >= lines.length || indentOf(lines[i]!) >= 4) return false;
  const head = tableCells(lines[i]!);
  const delim = tableCells(lines[i + 1]!);
  return head !== null && delim !== null && isDelimRow(lines[i + 1]!) && head.length === delim.length;
};

/** A line that may end a paragraph (and so cannot continue one). */
function startsBlock(l: string): boolean {
  if (indentOf(l) >= 4) return false;
  if (ATX.test(l) || parseFenceOpen(l) || HR.test(l) || QUOTE.test(l)) return true;
  const mk = listMarker(l);
  if (mk && !mk.empty && (!mk.ordered || mk.start === 1)) return true;
  const h = htmlStart(l);
  return h !== null && h.type <= 6;
}

const inOpenFence = (lines: string[]): boolean => {
  let open: { ch: string; len: number } | null = null;
  for (const l of lines) {
    if (open) {
      const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
      if (m && m[1]![0] === open.ch && m[1]!.length >= open.len) open = null;
    } else {
      const f = parseFenceOpen(l);
      if (f) open = f;
    }
  }
  return open !== null;
};

/** May `l` continue the paragraph that `content` ends with (a lazy continuation line)? */
function lazyOk(content: string[], l: string): boolean {
  const prev = content[content.length - 1];
  if (prev === undefined || isBlank(prev) || isBlank(l)) return false;
  if (startsBlock(l) || tableAt([prev, l], 0)) return false;
  if (inOpenFence(content) || ATX.test(prev) || HR.test(prev)) return false;
  return true;
}

function frontMatter(lines: string[]): number {
  const first = lines[0];
  if (first === undefined) return 0;
  const m = /^(---|\+\+\+)[ \t]*$/.exec(first);
  if (!m) return 0;
  for (let k = 1; k < lines.length; k++) {
    const l = lines[k]!;
    if (m[1] === "---" ? /^(?:---|\.\.\.)[ \t]*$/.test(l) : /^\+\+\+[ \t]*$/.test(l)) return k + 1;
  }
  return 0;
}

function scan(lines: string[], top: boolean, ctx: ScanCtx): Seg[] {
  const segs: Seg[] = [];
  const n = lines.length;
  let i = 0;
  if (top) {
    const fm = frontMatter(lines);
    if (fm > 0) {
      segs.push({ kind: "raw", from: 0, to: fm, construct: "front matter" });
      i = fm;
    }
  }
  while (i < n) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (indentOf(line) >= 4) {
      let j = i;
      let last = i;
      while (j < n) {
        if (isBlank(lines[j]!)) j++;
        else if (indentOf(lines[j]!) >= 4) {
          last = j;
          j++;
        } else break;
      }
      segs.push({ kind: "code", from: i, to: last + 1 });
      i = last + 1;
      continue;
    }
    const fence = parseFenceOpen(line);
    if (fence) {
      let j = i + 1;
      let closed = false;
      for (; j < n; j++) {
        const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[j]!);
        if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.len) {
          closed = true;
          break;
        }
      }
      const to = closed ? j + 1 : n;
      segs.push({ kind: "code", from: i, to, fence: { ...fence, closed } });
      i = to;
      continue;
    }
    const atx = parseAtx(line);
    if (atx) {
      segs.push({ kind: "heading", from: i, to: i + 1, level: atx.level });
      i++;
      continue;
    }
    if (HR.test(line)) {
      segs.push({ kind: "rule", from: i, to: i + 1 });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const content: string[] = [];
      let j = i;
      while (j < n) {
        const l = lines[j]!;
        if (QUOTE.test(l)) content.push(l.replace(/^ {0,3}> ?/, ""));
        else if (lazyOk(content, l)) content.push(l);
        else break;
        j++;
      }
      segs.push({ kind: "quote", from: i, to: j, lines: content, children: scan(content, false, ctx) });
      i = j;
      continue;
    }
    const mk = listMarker(line);
    if (mk) {
      const seg = scanList(lines, i, mk, ctx);
      segs.push(seg);
      i = seg.to;
      continue;
    }
    const html = htmlStart(line);
    if (html) {
      let j = i;
      if (html.end) {
        while (j < n && !html.end.test(lines[j]!)) j++;
        j = Math.min(j + 1, n);
      } else {
        while (j < n && !isBlank(lines[j]!)) j++;
      }
      segs.push({ kind: "raw", from: i, to: j, construct: "html block" });
      i = j;
      continue;
    }
    if (FOOTNOTE_DEF.test(line)) {
      let j = i + 1;
      while (j < n) {
        const l = lines[j]!;
        if (isBlank(l)) {
          let p = j;
          while (p < n && isBlank(lines[p]!)) p++;
          if (p < n && indentOf(lines[p]!) >= 4) {
            j = p + 1;
            continue;
          }
          break;
        }
        if (indentOf(l) >= 4 || !(startsBlock(l) || FOOTNOTE_DEF.test(l))) j++;
        else break;
      }
      segs.push({ kind: "raw", from: i, to: j, construct: "footnote definition" });
      i = j;
      continue;
    }
    const def = LINK_DEF.exec(line);
    if (def) {
      ctx.labels.add(normalizeLabel(def[1]!));
      segs.push({ kind: "raw", from: i, to: i + 1, construct: "link reference definition" });
      i++;
      continue;
    }
    if (tableAt(lines, i)) {
      let j = i + 2;
      while (j < n && !isBlank(lines[j]!) && !startsBlock(lines[j]!)) j++;
      segs.push({ kind: "raw", from: i, to: j, construct: "table" });
      i = j;
      continue;
    }
    // a paragraph, or a setext heading
    let j = i + 1;
    let seg: Seg | null = null;
    while (j < n) {
      const l = lines[j]!;
      if (isBlank(l)) break;
      if (SETEXT.test(l)) {
        seg = { kind: "heading", from: i, to: j + 1, level: l.trim()[0] === "=" ? 1 : 2 };
        break;
      }
      if (startsBlock(l)) break;
      if (j - 1 > i && tableAt(lines, j - 1)) {
        j--;
        break;
      }
      j++;
    }
    segs.push(seg ?? { kind: "paragraph", from: i, to: j });
    i = seg ? seg.to : j;
  }
  return segs;
}

function scanList(lines: string[], start: number, first: Marker, ctx: ScanCtx): Seg {
  const n = lines.length;
  const items: ItemSeg[] = [];
  let j = start;
  let loose = false;
  const sameList = (m: Marker): boolean => m.ordered === first.ordered && m.marker === first.marker;
  for (;;) {
    const mk = listMarker(lines[j]!)!;
    const content: string[] = [mk.first];
    let k = j + 1;
    while (k < n) {
      const l = lines[k]!;
      if (isBlank(l)) {
        let p = k;
        while (p < n && isBlank(lines[p]!)) p++;
        if (mk.empty && k === j + 1) break;
        if (p < n && indentOf(lines[p]!) >= mk.width) {
          while (k < p) {
            content.push("");
            k++;
          }
          continue;
        }
        break;
      }
      if (indentOf(l) >= mk.width) {
        content.push(stripIndent(l, mk.width));
        k++;
      } else if (!listMarker(l) && lazyOk(content, l)) {
        content.push(l);
        k++;
      } else break;
    }
    while (content.length > 1 && isBlank(content[content.length - 1]!)) {
      content.pop();
      k--;
    }
    while (k > j + 1 && isBlank(lines[k - 1]!)) k--;
    let checked: boolean | null = null;
    const task = /^\[([ xX])\](?:[ \t]+|$)/.exec(content[0]!);
    if (task) {
      checked = task[1] !== " ";
      content[0] = content[0]!.slice(task[0].length);
    }
    const children = scan(content, false, ctx);
    for (let c = 1; c < children.length; c++) {
      if (content.slice(children[c - 1]!.to, children[c]!.from).some(isBlank)) loose = true;
    }
    items.push({ from: j, to: k, lines: content, children, checked });
    let p = k;
    while (p < n && isBlank(lines[p]!)) p++;
    const next = p < n ? listMarker(lines[p]!) : null;
    if (next && sameList(next) && !HR.test(lines[p]!)) {
      if (p > k) loose = true;
      j = p;
      continue;
    }
    j = k;
    break;
  }
  return { kind: "list", from: start, to: j, list: { ordered: first.ordered, start: first.start, marker: first.marker, tight: !loose, items } };
}

/** The first construct in a seg's content that the editor cannot rewrite, if any. */
function findRaw(seg: Seg): string | null {
  if (seg.kind === "raw") return seg.construct ?? "other";
  for (const c of seg.children ?? []) {
    const r = findRaw(c);
    if (r) return r;
  }
  for (const it of seg.list?.items ?? []) {
    for (const c of it.children) {
      const r = findRaw(c);
      if (r) return r;
    }
  }
  return null;
}

// ------------------------------------------------------------------ segs to nodes
function paragraphText(lines: string[]): string {
  return lines.map((l) => l.replace(/^[ \t]+/, "")).join("\n").replace(/[ \t]+$/, "");
}

function buildBlock(lines: string[], seg: Seg, labels: ReadonlySet<string>): MdBlock {
  const slice = lines.slice(seg.from, seg.to);
  const source = slice.join("\n");
  switch (seg.kind) {
    case "paragraph":
      return { type: "paragraph", inlines: parseInlines(paragraphText(slice), labels), source };
    case "heading": {
      if (slice.length === 1 && parseAtx(slice[0]!)) return { type: "heading", level: seg.level!, inlines: parseInlines(parseAtx(slice[0]!)!.content, labels), source };
      return { type: "heading", level: seg.level!, inlines: parseInlines(paragraphText(slice.slice(0, -1)), labels), source };
    }
    case "code": {
      if (seg.fence) {
        const body = slice.slice(1, seg.fence.closed ? -1 : undefined).map((l) => stripUpTo(l, seg.fence!.indent));
        return { type: "code", value: body.join("\n"), info: unescapeString(seg.fence.info), fence: seg.fence.open, source };
      }
      const body = slice.map((l) => stripIndent(l, 4));
      return { type: "code", value: body.join("\n"), info: "", fence: null, source };
    }
    case "rule":
      return { type: "rule", source };
    case "quote":
      return { type: "quote", children: seg.children!.map((c) => buildBlock(seg.lines!, c, labels)), source };
    case "list": {
      const l = seg.list!;
      return {
        type: "list",
        ordered: l.ordered,
        start: l.start,
        marker: l.marker,
        tight: l.tight,
        items: l.items.map((it) => ({ checked: it.checked, children: it.children.map((c) => buildBlock(it.lines, c, labels)), source: lines.slice(it.from, it.to).join("\n") })),
        source,
      };
    }
    case "raw":
      return { type: "raw", construct: seg.construct ?? "other", source };
  }
}
const stripUpTo = (line: string, n: number): string => line.replace(new RegExp(`^ {0,${n}}`), "");

const NO_LABELS: ReadonlySet<string> = new Set();

/** The blocks of a Markdown text as a tree (for an editor, and to read an edit back). */
export function parseBlocks(markdown: string, labels: ReadonlySet<string> = NO_LABELS): MdBlock[] {
  const lines = markdown.replace(/^\ufeff/, "").split(/\r\n|\r|\n/);
  const ctx: ScanCtx = { labels: new Set(labels) };
  return scan(lines, false, ctx).map((s) => buildBlock(lines, s, ctx.labels));
}

/** The top-level blocks of a text as sources and constructs, for comparing (no inline parsing). */
function topSegs(markdown: string, labels: ReadonlySet<string>, wholeFile = false): { source: string; raw: string | null; kind: string; line: number }[] {
  const lines = markdown.split("\n");
  const ctx: ScanCtx = { labels: new Set(labels) };
  return scan(lines, wholeFile, ctx).map((s) => ({ source: lines.slice(s.from, s.to).join("\n"), raw: findRaw(s), kind: kindOf(s), line: s.from + 1 }));
}

function kindOf(s: Seg): string {
  if (s.kind === "raw") return s.construct === "table" ? "table" : "other";
  return s.kind;
}

// ------------------------------------------------------------------ writing nodes as Markdown
/** Characters that need a backslash wherever they stand in text. */
export function escapeText(value: string, lineStart = true): string {
  const lines = value.split("\n");
  const tildes = (value.match(/~/g) ?? []).length > 1;
  return lines
    .map((line, idx) => {
      let out = "";
      const cps = Array.from(line);
      for (let i = 0; i < cps.length; i++) {
        const c = cps[i]!;
        const prev = cps[i - 1] ?? "";
        const next = cps[i + 1] ?? "";
        if (c === "\\" || c === "`" || c === "*" || c === "[" || c === "]" || c === "<") out += "\\" + c;
        else if (c === "_") out += /[\p{L}\p{N}]/u.test(prev) && /[\p{L}\p{N}]/u.test(next) ? c : "\\_";
        else if (c === "~" && tildes) out += "\\~";
        else if (c === "&" && ENTITY.test(cps.slice(i, i + 40).join(""))) out += "\\&";
        else out += c;
      }
      if (idx > 0 || lineStart) out = escapeLineStart(out);
      return out;
    })
    .join("\n");
}

/** A line that would start a block (heading, quote, list, rule, fence, table delimiter) gets its first mark escaped. */
function escapeLineStart(line: string): string {
  const m = /^([ \t]*)(.*)$/s.exec(line)!;
  const lead = m[1]!;
  const body = m[2]!;
  const esc = (s: string): string => lead + s;
  if (/^#{1,6}(?:[ \t]|$)/.test(body)) return esc("\\" + body);
  if (body.startsWith(">")) return esc("\\" + body);
  if (/^[-+](?:[ \t]|$)/.test(body)) return esc("\\" + body);
  if (/^\d{1,9}[.)](?:[ \t]|$)/.test(body)) return esc(body.replace(/^(\d{1,9})([.)])/, "$1\\$2"));
  if (/^[-=_][-=_ \t]*$/.test(body)) return esc("\\" + body);
  if (body.startsWith("~")) return esc("\\" + body);
  if (/^[|:\-\s]+$/.test(body) && body.includes("|")) return esc("\\" + body);
  return line;
}

const isOpaque = (n: MdInline): boolean => n.type === "raw";

function inlineUnchanged(n: MdInline, labels: ReadonlySet<string>): boolean {
  if (n.source === undefined) return false;
  const re = parseInlines(n.source, labels);
  return re.length === 1 && JSON.stringify(inlineShape(re[0]!)) === JSON.stringify(inlineShape(n));
}

/** The text pieces of a text node's source: a character, an escape or an entity each, with what they say. */
function piecesOf(source: string): { v: string; s: string }[] {
  const out: { v: string; s: string }[] = [];
  for (let i = 0; i < source.length; ) {
    const c = source[i]!;
    if (c === "\\" && ASCII_PUNCT.test(source[i + 1] ?? "")) {
      out.push({ v: source[i + 1]!, s: source.slice(i, i + 2) });
      i += 2;
      continue;
    }
    if (c === "&") {
      const m = ENTITY.exec(source.slice(i, i + 40));
      const d = m ? decodeEntity(m[1]!) : null;
      if (m && d !== null) {
        out.push({ v: d, s: m[0] });
        i += m[0].length;
        continue;
      }
    }
    const cp = source.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    out.push({ v: ch, s: ch });
    i += ch.length;
  }
  return out;
}

/** A text node: its source as it is when its value is unchanged, else the changed middle written fresh between the unchanged ends. */
function renderText(n: Extract<MdInline, { type: "text" }>, lineStart: boolean): string {
  if (n.source === undefined) return escapeText(n.value, lineStart);
  const pieces = piecesOf(n.source);
  const old = pieces.map((p) => p.v).join("");
  if (old === n.value) return n.source;
  let p = 0;
  let prefix = "";
  let pi = 0;
  while (pi < pieces.length && n.value.startsWith(pieces[pi]!.v, p) && p + pieces[pi]!.v.length <= n.value.length) {
    p += pieces[pi]!.v.length;
    prefix += pieces[pi]!.s;
    pi++;
  }
  let q = 0;
  let suffix = "";
  let si = pieces.length;
  while (si > pi && n.value.length - q - pieces[si - 1]!.v.length >= p && n.value.endsWith(pieces[si - 1]!.v, n.value.length - q)) {
    q += pieces[si - 1]!.v.length;
    suffix = pieces[si - 1]!.s + suffix;
    si--;
  }
  const middle = n.value.slice(p, n.value.length - q);
  return prefix + escapeText(middle, lineStart && prefix === "") + suffix;
}

export function renderDestination(dest: string): string {
  if (dest === "") return "<>";
  const entityEsc = (s: string): string => s.replace(/&(?=#?[A-Za-z0-9]+;)/g, "\\&");
  if (/^[^\s\u0000-\u001f\u007f<>]+$/.test(dest)) return entityEsc(dest.replace(/[\\()]/g, "\\$&"));
  return "<" + entityEsc(dest.replace(/[\\<>]/g, "\\$&")) + ">";
}

export function renderTitle(title: string): string {
  const t = title.replace(/[\\"]/g, "\\$&").replace(/&(?=#?[A-Za-z0-9]+;)/g, "\\&");
  return `"${t}"`;
}

/** A code span with the shortest backtick run that its text does not contain. */
export function renderCodeSpan(value: string): string {
  const runs = new Set((value.match(/`+/g) ?? []).map((r) => r.length));
  let len = 1;
  while (runs.has(len)) len++;
  const fence = "`".repeat(len);
  const pad = value.startsWith("`") || value.endsWith("`") || (value.length > 0 && value.startsWith(" ") && value.endsWith(" ") && value.trim() !== "");
  return pad ? `${fence} ${value} ${fence}` : `${fence}${value}${fence}`;
}

interface RenderCtx {
  labels: ReadonlySet<string>;
}

function renderInlines(nodes: readonly MdInline[], lineStart: boolean, ctx: RenderCtx): string {
  let out = "";
  let ls = lineStart;
  for (const n of nodes) {
    if (n.type === "text") {
      out += renderText(n, ls);
      ls = false;
      continue;
    }
    if (n.type === "softbreak") {
      out += n.source ?? "\n";
      ls = true;
      continue;
    }
    if (n.type === "break") {
      out += n.source ?? "\\\n";
      ls = true;
      continue;
    }
    ls = false;
    if (isOpaque(n)) {
      out += (n as Extract<MdInline, { type: "raw" }>).source ?? "";
      continue;
    }
    if (inlineUnchanged(n, ctx.labels)) {
      out += n.source!;
      continue;
    }
    switch (n.type) {
      case "code":
        out += renderCodeSpan(n.value);
        break;
      case "emphasis":
        out += "*" + renderInlines(n.children, false, ctx) + "*";
        break;
      case "strong":
        out += "**" + renderInlines(n.children, false, ctx) + "**";
        break;
      case "link":
        out += "[" + renderInlines(n.children, false, ctx) + "](" + renderDestination(n.destination) + (n.title !== null ? " " + renderTitle(n.title) : "") + ")";
        break;
    }
  }
  return out;
}

function blockUnchanged(b: MdBlock, ctx: RenderCtx): boolean {
  if (b.source === undefined) return false;
  const re = parseBlocks(b.source, ctx.labels);
  return re.length === 1 && JSON.stringify(blockShape(re[0]!)) === JSON.stringify(blockShape(b));
}

function itemUnchanged(it: MdListItem, list: Extract<MdBlock, { type: "list" }>, ctx: RenderCtx): boolean {
  if (it.source === undefined) return false;
  const re = parseBlocks(it.source, ctx.labels);
  const l = re[0];
  return re.length === 1 && l?.type === "list" && l.items.length === 1 && l.ordered === list.ordered && l.marker === list.marker && JSON.stringify(itemShape(l.items[0]!)) === JSON.stringify(itemShape(it));
}

/** The longest run of `ch` in `s`. */
const longestRun = (s: string, ch: string): number => Math.max(0, ...(s.match(new RegExp(`\\${ch}+`, "g")) ?? []).map((r) => r.length));

export function renderFence(value: string, info: string): string {
  const cleanInfo = info.replace(/[\r\n]+/g, " ").trim();
  const ch = cleanInfo.includes("`") ? "~" : "`";
  const len = Math.max(3, longestRun(value, ch) + 1);
  const fence = ch.repeat(len);
  return `${fence}${cleanInfo}\n${value === "" ? "" : value + "\n"}${fence}`;
}

const indentLines = (text: string, first: string, rest: string): string =>
  text
    .split("\n")
    .map((l, i) => (i === 0 ? first + l : l === "" ? "" : rest + l))
    .join("\n");

function renderBlock(b: MdBlock, ctx: RenderCtx): string {
  if (b.type === "raw") return b.source;
  if (blockUnchanged(b, ctx)) return b.source!;
  switch (b.type) {
    case "paragraph":
      return renderInlines(normalizeInlines(b.inlines, true), true, ctx);
    case "heading": {
      const text = renderInlines(normalizeInlines(headingInlines(b.inlines), true), true, ctx).replace(/(^|[ \t])#+$/, "$1\\#").replace(/\n/g, " ");
      const level = Math.min(6, Math.max(1, b.level));
      return text === "" ? "#".repeat(level) : `${"#".repeat(level)} ${text}`;
    }
    case "code":
      return renderFence(b.value, b.info);
    case "rule":
      return "---";
    case "quote": {
      const inner = renderChildren(b.children, false, ctx);
      return inner === "" ? ">" : inner.split("\n").map((l) => (l === "" ? ">" : "> " + l)).join("\n");
    }
    case "list": {
      const parts = b.items.map((it, i) => {
        if (itemUnchanged(it, b, ctx)) return it.source!;
        const marker = b.ordered ? `${b.start + i}${b.marker}` : b.marker;
        const task = it.checked === null ? "" : it.checked ? "[x] " : "[ ] ";
        const body = renderChildren(it.children, b.tight, ctx);
        if (body === "" && task === "") return marker;
        return indentLines(task + body, marker + " ", " ".repeat(marker.length + 1));
      });
      return parts.join(b.tight ? "\n" : "\n\n");
    }
  }
}

function renderChildren(children: readonly MdBlock[], tight: boolean, ctx: RenderCtx): string {
  let out = "";
  let prev: MdBlock | null = null;
  for (const c of children) {
    const text = renderBlock(c, ctx);
    if (text === "") continue;
    if (prev) out += tight && c.type === "list" && (prev.type === "paragraph" || prev.type === "heading") ? "\n" : "\n\n";
    out += text;
    prev = c;
  }
  return out;
}

/** The nodes as Markdown: blocks apart by one blank line, what changed written fresh and escaped, the rest as it was read. */
export function renderBlocks(nodes: readonly MdBlock[], labels: ReadonlySet<string> = NO_LABELS): string {
  return renderChildren(nodes, false, { labels });
}

/** What the nodes must read back as (empty blocks vanish). */
function expectedShape(nodes: readonly MdBlock[]): string {
  return JSON.stringify(nodes.map(blockShape).filter(notEmpty));
}

// ------------------------------------------------------------------ the document
interface CoreBlock {
  id: string;
  start: number;
  end: number;
  line: number;
  kind: string;
  editable: boolean;
  construct: string | null;
  /** the text between this block's end and the next block's start (or the end of the file) */
  gapAfter: string;
  /** the block's text, lines joined with LF */
  lf: string;
  eol: string;
}
interface Core {
  source: string;
  bom: string;
  lead: string;
  blocks: CoreBlock[];
  labels: ReadonlySet<string>;
  eol: string;
}
interface Edit {
  md: string;
  expect: string | null;
}

const EOL_RE = /\r\n|\r|\n/;
const toLf = (s: string): string => s.replace(/\r\n|\r/g, "\n");

function wholeDocumentAsOne(source: string, bom: string, why: string): Core {
  const body = source.slice(bom.length);
  const eol = EOL_RE.exec(source)?.[0] ?? "\n";
  const lead = /^\s*/.exec(body)![0];
  const trimmed = body.slice(lead.length).replace(/\s+$/, "");
  const blocks: CoreBlock[] =
    trimmed === ""
      ? []
      : [{ id: "b1", start: bom.length + lead.length, end: bom.length + lead.length + trimmed.length, line: 1, kind: "other", editable: false, construct: why, gapAfter: body.slice(lead.length + trimmed.length), lf: toLf(trimmed), eol }];
  return { source, bom, lead, blocks, labels: new Set(), eol };
}

function readSource(source: string): Core {
  const bom = source.startsWith("\ufeff") ? "\ufeff" : "";
  const body = source.slice(bom.length);
  const lines: string[] = [];
  const starts: number[] = [];
  const eols: string[] = [];
  const re = /\r\n|\r|\n/g;
  let pos = 0;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    starts.push(pos);
    lines.push(body.slice(pos, m.index));
    eols.push(m[0]);
    pos = m.index + m[0].length;
  }
  starts.push(pos);
  lines.push(body.slice(pos));
  eols.push("");
  const eol = eols.find((e) => e !== "") ?? "\n";
  const ctx: ScanCtx = { labels: new Set() };
  const segs = scan(lines, true, ctx);
  const blocks: CoreBlock[] = [];
  let prevEnd = -1;
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k]!;
    const lastLine = s.to - 1;
    const start = bom.length + starts[s.from]!;
    const end = bom.length + starts[lastLine]! + lines[lastLine]!.length;
    if (start < prevEnd || end < start || end > source.length) return wholeDocumentAsOne(source, bom, "unreadable structure");
    const raw = findRaw(s);
    const kind = kindOf(s);
    blocks.push({
      id: `b${k + 1}`,
      start,
      end,
      line: s.from + 1,
      kind,
      editable: raw === null,
      construct: raw,
      gapAfter: "",
      lf: toLf(source.slice(start, end)),
      eol: EOL_RE.exec(source.slice(start, end))?.[0] ?? eols[lastLine] ?? eol,
    });
    prevEnd = end;
  }
  const lead = blocks.length ? source.slice(bom.length, blocks[0]!.start) : body;
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k]!;
    b.gapAfter = source.slice(b.end, blocks[k + 1]?.start ?? source.length);
    if (!/^\s*$/.test(b.gapAfter)) return wholeDocumentAsOne(source, bom, "unreadable structure");
    if (!EOL_RE.test(b.eol)) b.eol = EOL_RE.exec(b.gapAfter)?.[0] ?? eol;
  }
  if (!/^\s*$/.test(lead)) return wholeDocumentAsOne(source, bom, "unreadable structure");
  return { source, bom, lead, blocks, labels: ctx.labels, eol };
}

/** Open a Markdown text as a document (see `MarkdownDocument`). */
export function parseMarkdownDocument(source: string): EditableMarkdownDocument {
  return new Doc(readSource(source), new Map(), new Map(), 0);
}

interface OrderEntry {
  id: string;
  block: CoreBlock | null;
  edit: Edit | null;
}

class Doc implements EditableMarkdownDocument {
  constructor(
    private readonly core: Core,
    private readonly edits: ReadonlyMap<string, Edit>,
    /** inserted block ids after an anchor id ("" is the start of the file) */
    private readonly inserts: ReadonlyMap<string, readonly string[]>,
    private readonly counter: number,
  ) {}

  get source(): string {
    return this.core.source;
  }
  get labels(): ReadonlySet<string> {
    return this.core.labels;
  }
  get notices(): readonly SaveBlock[] {
    return this.core.blocks.filter((b) => !b.editable).map((b) => this.notice(b));
  }
  get edited(): boolean {
    return this.edits.size > 0;
  }

  private notice(b: CoreBlock): SaveBlock {
    return {
      code: "unsupported-construct",
      construct: b.construct,
      line: b.line,
      message: `Line ${b.line}: ${b.construct ?? "this part"} is shown as it is and cannot be edited here; it is saved unchanged.`,
    };
  }

  private order(): OrderEntry[] {
    const out: OrderEntry[] = [];
    const emit = (anchor: string): void => {
      for (const id of this.inserts.get(anchor) ?? []) {
        out.push({ id, block: null, edit: this.edits.get(id) ?? null });
        emit(id);
      }
    };
    emit("");
    for (const b of this.core.blocks) {
      out.push({ id: b.id, block: b, edit: this.edits.get(b.id) ?? null });
      emit(b.id);
    }
    return out;
  }

  get blocks(): readonly MarkdownBlockInfo[] {
    return this.order().map((e): MarkdownBlockInfo => {
      if (e.block && !e.edit) return { id: e.id, kind: e.block.kind, span: { start: e.block.start, end: e.block.end }, edited: false, editable: e.block.editable, construct: e.block.construct };
      const first = e.edit ? topSegs(e.edit.md, this.core.labels)[0] : undefined;
      return {
        id: e.id,
        kind: first?.kind ?? e.block?.kind ?? "paragraph",
        span: e.block ? { start: e.block.start, end: e.block.end } : null,
        edited: true,
        editable: e.block ? e.block.editable : true,
        construct: e.block ? e.block.construct : null,
      };
    });
  }

  private known(blockId: string): CoreBlock | null {
    const original = this.core.blocks.find((b) => b.id === blockId) ?? null;
    if (original) return original;
    let found = false;
    for (const ids of this.inserts.values()) if (ids.includes(blockId)) found = true;
    if (!found) throw new Error(`Unknown block ${blockId}`);
    return null;
  }

  blockSource(blockId: string): string {
    const original = this.known(blockId);
    const e = this.edits.get(blockId);
    if (e) return e.md;
    return original ? original.lf : "";
  }

  structure(blockId: string): MdBlock[] {
    return parseBlocks(this.blockSource(blockId), this.core.labels);
  }

  private withEdit(blockId: string, md: string, expect: string | null): Doc {
    const original = this.known(blockId);
    const clean = toLf(md).replace(/^\n+/, "").replace(/\n+$/, "");
    const edits = new Map(this.edits);
    if (original && clean === original.lf) edits.delete(blockId);
    else edits.set(blockId, { md: clean, expect });
    return new Doc(this.core, edits, this.inserts, this.counter);
  }

  replace(blockId: string, markdown: string): Doc {
    return this.withEdit(blockId, markdown, null);
  }

  replaceNodes(blockId: string, nodes: readonly MdBlock[]): Doc {
    return this.withEdit(blockId, renderBlocks(nodes, this.core.labels), expectedShape(nodes));
  }

  private withInsert(after: string | null, md: string, expect: string | null): Doc {
    if (after !== null) this.known(after);
    const id = `n${this.counter + 1}`;
    const anchor = after ?? "";
    const inserts = new Map(this.inserts);
    // a block inserted right after an anchor comes before the ones inserted there earlier
    inserts.set(anchor, [id, ...(inserts.get(anchor) ?? [])]);
    const edits = new Map(this.edits);
    edits.set(id, { md: toLf(md).replace(/^\n+/, "").replace(/\n+$/, ""), expect });
    return new Doc(this.core, edits, inserts, this.counter + 1);
  }

  insert(afterBlockId: string | null, markdown: string): Doc {
    return this.withInsert(afterBlockId, markdown, null);
  }

  insertNodes(afterBlockId: string | null, nodes: readonly MdBlock[]): Doc {
    return this.withInsert(afterBlockId, renderBlocks(nodes, this.core.labels), expectedShape(nodes));
  }

  serialize(): SerializeResult {
    if (!this.edited) return { ok: true, text: this.core.source };
    const core = this.core;
    const entries = this.order();
    const problems: SaveBlock[] = [];
    const lineOf = (e: OrderEntry): number | null => e.block?.line ?? null;
    const refuse = (code: SaveBlock["code"], construct: string | null, line: number | null, message: string): void => {
      problems.push({ code, construct, line, message: line ? `Line ${line}: ${message}` : message });
    };
    for (const e of entries) {
      if (!e.edit) continue;
      const line = lineOf(e);
      if (e.block && !e.block.editable) {
        refuse("unsupported-construct", e.block.construct, line, `${e.block.construct ?? "this part"} cannot be edited here, so the change is not saved. Undo the change in it, or edit the file in another editor.`);
        continue;
      }
      if (e.edit.md.includes("\u0000") || LONE_SURROGATE.test(e.edit.md)) {
        refuse("unwritable-text", null, line, "the text holds a NUL character or half of a surrogate pair, which would change when written as UTF-8.");
        continue;
      }
      const segs = topSegs(e.edit.md, core.labels);
      const bad = segs.find((s) => s.raw !== null);
      if (bad) {
        refuse("unsupported-construct", bad.raw, line, `the edit writes ${bad.raw}, which this editor does not write; it would not read back as what you edited.`);
        continue;
      }
      if (e.edit.expect !== null) {
        const nodes = parseBlocks(e.edit.md, core.labels);
        if (expectedShape(nodes) !== e.edit.expect) refuse("roundtrip-mismatch", null, line, "what was written does not read back as what the editor showed (a mark or a link could not be written safely).");
      }
    }
    if (problems.length > 0) return { ok: false, blocks: problems };

    // text: each kept block with the gap that follows it
    type Piece = { text: string; gap: string };
    const kept: Piece[] = [];
    const head: string[] = [];
    let anchorEol = core.eol;
    let lastOriginalRemoved = false;
    for (const e of entries) {
      const eol = e.block?.eol ?? anchorEol;
      const text = (e.edit ? e.edit.md : e.block!.lf).replace(/\n/g, eol);
      if (e.block) {
        anchorEol = e.block.eol;
        lastOriginalRemoved = text === "";
        if (text !== "") kept.push({ text, gap: e.block.gapAfter });
      } else if (text !== "") {
        const prev = kept[kept.length - 1];
        if (!prev) head.push(text);
        else {
          // the blank line goes between; the original gap moves to the end of the run
          kept.push({ text, gap: prev.gap });
          prev.gap = eol + eol;
        }
      }
    }
    const finalGap = core.blocks.length > 0 ? core.blocks[core.blocks.length - 1]!.gapAfter : "";
    if (lastOriginalRemoved && kept.length > 0) kept[kept.length - 1]!.gap = finalGap;
    let text = core.bom + core.lead;
    if (head.length > 0) text += head.join(core.eol + core.eol) + (kept.length > 0 ? core.eol + core.eol : core.eol);
    for (const p of kept) text += p.text + p.gap;

    // Read it again: the blocks must be exactly those that were meant.
    const expected: { source: string; line: number | null; edited: boolean }[] = [];
    for (const e of entries) {
      if (e.edit) for (const s of topSegs(e.edit.md, core.labels)) expected.push({ source: s.source, line: lineOf(e), edited: true });
      else expected.push({ source: e.block!.lf, line: lineOf(e), edited: false });
    }
    const got = topSegs(toLf(text.slice(core.bom.length)), core.labels, true);
    let diff = -1;
    if (got.length !== expected.length) diff = Math.min(got.length, expected.length);
    else for (let k = 0; k < got.length; k++) if (got[k]!.source !== expected[k]!.source) { diff = k; break; }
    if (diff >= 0) {
      // the edit that caused it: the nearest edited block at or before the first difference
      let line: number | null = null;
      for (let k = Math.min(diff, expected.length - 1); k >= 0 && line === null; k--) if (expected[k]!.edited || k === 0) line = expected[k]!.line;
      if (line === null) line = expected.find((x) => x.line !== null)?.line ?? null;
      return {
        ok: false,
        blocks: [
          {
            code: "roundtrip-mismatch",
            construct: null,
            line,
            message: `${line ? `Line ${line}: ` : ""}the edit would run into the text around it (for example an unclosed code fence, or a list that joins another), so the file would not read back as edited.`,
          },
        ],
      };
    }
    return { ok: true, text };
  }
}
