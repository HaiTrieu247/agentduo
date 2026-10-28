// The Markdown the agents write, read into plain data that render.ts turns into elements and text nodes. A safe
// subset of CommonMark and GFM: headings, paragraphs, fenced code, lists, quotes, rules, tables, and code spans,
// strong, emphasis, strikethrough and links inline. HTML is never markup here: it stays text. No DOM in this file.

export type Inline =
  | { type: "text"; text: string }
  | { type: "break" }
  | { type: "code"; text: string }
  | { type: "strong" | "em" | "del"; children: Inline[] }
  /** The target is only shown (as a tooltip), never opened: the webview opens nothing an agent names. */
  | { type: "link"; href: string; children: Inline[] };

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; start: number; items: Block[][] }
  | { type: "quote"; children: Block[] }
  | { type: "rule" }
  | { type: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] };

/** Deeper quotes, lists or emphasis than this stay text: nobody writes them, and they would only cost stack. */
const MAX_DEPTH = 16;

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

export function parseMarkdown(src: string): Block[] {
  return blocks(src.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"), 0);
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const blank = (line: string | undefined) => line !== undefined && !line.trim();

function closesFence(line: string, fence: string): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!m && m[1]![0] === fence[0] && m[1]!.length >= fence.length;
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i]!;
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line) || tableStart(lines, i);
}

function blocks(lines: string[], depth: number): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (depth >= MAX_DEPTH) {
      out.push({ type: "paragraph", children: parseInline(lines.slice(i).map((l) => l.trim()).filter(Boolean).join("\n")) });
      break;
    }
    const fence = FENCE.exec(line);
    if (fence && !(fence[2]![0] === "`" && fence[3]!.includes("`"))) {
      const strip = fence[1]!.length;
      const body: string[] = [];
      i++;
      while (i < lines.length && !closesFence(lines[i]!, fence[2]!)) body.push(lines[i++]!.replace(new RegExp(`^ {0,${strip}}`), ""));
      i++; // the closing fence, or past the end
      out.push({ type: "code", lang: fence[3]!.trim().split(/\s+/)[0] ?? "", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const text = (heading[2] ?? "").replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trim();
      out.push({ type: "heading", level: heading[1]!.length, children: parseInline(text) });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push({ type: "rule" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(lines[i++]!.replace(QUOTE, ""));
      out.push({ type: "quote", children: blocks(body, depth + 1) });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      i = list(lines, i, out, depth);
      continue;
    }
    if (tableStart(lines, i)) {
      i = table(lines, i, out);
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i]!.trim() && !startsBlock(lines, i)) para.push(lines[i++]!.trim());
    out.push({ type: "paragraph", children: parseInline(para.join("\n")) });
  }
  return out;
}

/** A list from line `i`: its items, each read as blocks of its own. Returns the line after it. */
function list(lines: string[], i: number, out: Block[], depth: number): number {
  const first = LIST_ITEM.exec(lines[i]!)!;
  const indent = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const items: Block[][] = [];
  const sibling = (line: string | undefined) => {
    const m = line === undefined ? null : LIST_ITEM.exec(line);
    return !!m && m[1]!.length === indent && /\d/.test(m[2]!) === ordered && !RULE.test(line!);
  };
  while (i < lines.length && sibling(lines[i])) {
    const m = LIST_ITEM.exec(lines[i]!)!;
    const content = indent + m[2]!.length + (m[3]!.length && m[3]!.length <= 4 ? m[3]!.length : 1);
    const body = [m[4]!];
    i++;
    while (i < lines.length) {
      const line = lines[i]!;
      if (!line.trim()) {
        let k = i;
        while (blank(lines[k])) k++;
        const next = lines[k];
        if (next === undefined || indentOf(next) < content) break;
        while (i < k) body.push(lines[i++]!.trim());
        continue;
      }
      const marker = LIST_ITEM.exec(line);
      if (marker && marker[1]!.length <= indent) break;
      if (marker || indentOf(line) >= content) {
        body.push(line.slice(Math.min(indentOf(line), content)));
      } else if (body.at(-1)?.trim() && !startsBlock(lines, i)) {
        body.push(line.trim()); // a lazy continuation of the item's paragraph
      } else break;
      i++;
    }
    items.push(blocks(body, depth + 1));
    let k = i;
    while (blank(lines[k])) k++;
    if (sibling(lines[k])) i = k;
  }
  out.push({ type: "list", ordered, start: ordered ? Number.parseInt(first[2]!, 10) : 1, items });
  return i;
}

/** The cells of a table row: split on unescaped pipes, without the outer ones; `\|` is a pipe in the cell. */
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out: string[] = [];
  let cell = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (s[i] === "|") {
      out.push(cell.trim());
      cell = "";
    } else cell += s[i];
  }
  out.push(cell.trim());
  return out;
}

function tableStart(lines: string[], i: number): boolean {
  const head = lines[i]!;
  const delimiter = lines[i + 1];
  if (!head.includes("|") || delimiter === undefined || !TABLE_DELIMITER.test(delimiter)) return false;
  if (!delimiter.includes("|") && !head.trim().startsWith("|")) return false;
  return cells(head).length === cells(delimiter).length;
}

function table(lines: string[], i: number, out: Block[]): number {
  const head = cells(lines[i]!);
  const align = cells(lines[i + 1]!).map((d): Align => (d.startsWith(":") && d.endsWith(":") ? "center" : d.endsWith(":") ? "right" : d.startsWith(":") ? "left" : null));
  const row = (texts: string[]) => head.map((_, n) => (texts[n] ? parseInline(texts[n]!) : []));
  const rows: Inline[][][] = [];
  i += 2;
  while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|") && !FENCE.test(lines[i]!) && !QUOTE.test(lines[i]!)) rows.push(row(cells(lines[i++]!)));
  out.push({ type: "table", align, head: head.map((h) => (h ? parseInline(h) : [])), rows });
  return i;
}

// ------------------------------------------------------------------ inline
const PUNCTUATION = /[!-/:-@[-`{-~]/;
const SPACE = /\s/;
const WORD = /[\p{L}\p{N}]/u;

/**
 * Where a search for a closing delimiter found none: from a position at or before any later one, up to `to`. A later
 * search for the same delimiter that ends no further cannot find one either, so unmatched delimiters cost one scan.
 */
type Misses = Map<string, number>;

export function parseInline(src: string): Inline[] {
  return inline(src, 0, src.length, new Map(), 0);
}

function missed(misses: Misses, key: string, to: number): boolean {
  return (misses.get(key) ?? -1) >= to;
}

/** A run of exactly `n` backticks in [from, to). */
function backticks(src: string, n: number, from: number, to: number): number {
  for (let i = src.indexOf("`", from); i >= 0 && i < to; i = src.indexOf("`", i)) {
    let end = i;
    while (src[end] === "`") end++;
    if (end - i === n && end <= to) return i;
    i = end;
  }
  return -1;
}

/** A closing `delim` in [from, to): after a non-space, and for a single `*` or `_` not part of a longer run. */
function closer(src: string, delim: string, from: number, to: number): number {
  for (let i = src.indexOf(delim, from); i >= 0 && i + delim.length <= to; i = src.indexOf(delim, i + 1)) {
    let end = i;
    while (src[end] === delim[0]) end++;
    let start = i;
    while (start > from && src[start - 1] === delim[0]) start--;
    if (start < i) continue; // inside a run that started earlier
    if (delim.length === 1 && end - i > 1) {
      i = end - 1;
      continue;
    }
    if (SPACE.test(src[i - 1] ?? " ")) continue;
    if (delim[0] === "_" && WORD.test(src[i + delim.length] ?? "")) continue;
    return i;
  }
  return -1;
}

function inline(src: string, from: number, to: number, misses: Misses, depth: number): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ type: "text", text: buf });
    buf = "";
  };
  let i = from;
  while (i < to) {
    const c = src[i]!;
    if (c === "\\" && i + 1 < to && PUNCTUATION.test(src[i + 1]!)) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (c === "\n") {
      flush();
      out.push({ type: "break" });
      i++;
      continue;
    }
    if (c === "`") {
      let n = 1;
      while (src[i + n] === "`") n++;
      const key = `\`${n}`;
      const end = missed(misses, key, to) ? -1 : backticks(src, n, i + n, to);
      if (end < 0) {
        misses.set(key, to);
        buf += src.slice(i, i + n);
        i += n;
        continue;
      }
      let code = src.slice(i + n, end).replace(/\n/g, " ");
      if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
      flush();
      out.push({ type: "code", text: code });
      i = end + n;
      continue;
    }
    if (c === "[" && depth < MAX_DEPTH) {
      const close = missed(misses, "]", to) ? -1 : src.indexOf("]", i + 1);
      if (close < 0 || close >= to) misses.set("]", to);
      else if (src[close + 1] === "(") {
        const paren = src.indexOf(")", close + 2);
        const href = paren >= 0 && paren < to ? src.slice(close + 2, paren).trim().split(/\s+/)[0] ?? "" : "";
        if (href && !src.slice(close + 2, paren).includes("\n")) {
          flush();
          out.push({ type: "link", href, children: inline(src, i + 1, close, misses, depth + 1) });
          i = paren + 1;
          continue;
        }
      }
    }
    if ((c === "*" || c === "_" || c === "~") && depth < MAX_DEPTH) {
      const double = src[i + 1] === c;
      const delim = double ? c + c : c;
      const after = src[i + delim.length];
      const opens = c !== "~" || double;
      const leftOk = c !== "_" || !WORD.test(src[i - 1] ?? "");
      if (opens && leftOk && after !== undefined && !SPACE.test(after) && after !== c) {
        const key = delim;
        const end = missed(misses, key, to) ? -1 : closer(src, delim, i + delim.length + 1, to);
        if (end < 0) misses.set(key, to);
        else {
          flush();
          const type = c === "~" ? "del" : double ? "strong" : "em";
          out.push({ type, children: inline(src, i + delim.length, end, misses, depth + 1) });
          i = end + delim.length;
          continue;
        }
      }
      buf += delim;
      i += delim.length;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}
