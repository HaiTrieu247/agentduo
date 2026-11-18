// "Mở" (Open): the contract between the desktop's renderer and main for opening a document from a link in the chat.
// Design: docs/superpowers/specs/2026-11-18-desktop-open-markdown-design.md. No Node and no DOM, since the renderer and
// main both import it (protocol.ts, main/documents.ts, renderer/documents.ts), and it is tested as it is.
//
// The rules this file makes true:
//  - A link in the chat names a file only inside main. Main finds the links in the chat text it owns and hands each one
//    an id (`DocumentLinkTable`); the renderer sends that id back and never a path to read or write.
//  - A link's target is exactly what it says (`splitHref`, `resolveLink`): an absolute path or file URL keeps its
//    target, a relative path is read from the conversation's workspace, and nothing searches for a file by its label
//    or name, nor swaps it for a file of the workspace.
//  - What opens a file of a given type is picked by its extension from `DOCUMENT_FORMATS`; a new type is one more entry
//    here, a codec in main and a viewer in the renderer, and no change to the click on a link.
import type { TimelineItem } from "@agentduo/host/viewState";
import { parseMarkdown, type Block, type Inline } from "@agentduo/webview/markdown";

// ------------------------------------------------------------------ ids
/** A link id main granted: `k` and a counter. Unforgeable by being looked up, never by its shape. */
export const DOCUMENT_LINK_ID = /^k[0-9]{1,9}$/;
/** A document session's id: `d` and a counter. */
export const DOCUMENT_ID = /^d[0-9]{1,9}$/;
/** A request main made to the renderer to settle documents before it closes something: `q` and a counter. */
export const DOCUMENT_REQUEST_ID = /^q[0-9]{1,9}$/;
/** What a file's content was when it was read or written (an opaque hex digest main computes). */
export const DOCUMENT_REVISION = /^[a-f0-9]{16,64}$/;

// ------------------------------------------------------------------ formats (the extension point)
export interface DocumentFormat {
  /** Names the format in the registries of main (its codec) and the renderer (its viewer): lowercase, stable. */
  readonly id: string;
  readonly label: string;
  /** Lowercase, with the dot. A file belongs to the format its (resolved) name ends with. */
  readonly extensions: readonly string[];
  /** A larger file is refused when it is opened (bytes). */
  readonly maxBytes: number;
}

export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

/**
 * Every type "Mở" opens. A new type is added here (and gets a codec in main and a viewer in the renderer, both keyed
 * by `id`); the link click, `document.open` and the session protocol do not change.
 */
export const DOCUMENT_FORMATS: readonly DocumentFormat[] = [
  { id: "markdown", label: "Markdown", extensions: [".md"], maxBytes: MAX_MARKDOWN_BYTES },
];

/** The most characters a save may carry: the largest format's byte limit (a character is at least one byte). */
export const MAX_DOCUMENT_CHARS = Math.max(...DOCUMENT_FORMATS.map((f) => f.maxBytes));

/** The last file name's extension, lowercase with its dot ("a/b.MD" → ".md"); "" for none (a dotfile has none). */
export function extensionOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot).toLowerCase() : "";
}

export function formatForPath(path: string, formats: readonly DocumentFormat[] = DOCUMENT_FORMATS): DocumentFormat | null {
  const ext = extensionOf(path);
  return ext ? formats.find((f) => f.extensions.includes(ext)) ?? null : null;
}

export const formatById = (id: string, formats: readonly DocumentFormat[] = DOCUMENT_FORMATS): DocumentFormat | null => formats.find((f) => f.id === id) ?? null;

// ------------------------------------------------------------------ errors
export type DocumentErrorCode =
  /** The link id is not (or no longer) one main granted for that view. */
  | "link-stale"
  /** The link is not a usable file reference (empty, control characters, too long). */
  | "link-invalid"
  /** The link points elsewhere than a file (http:, mailto:…). */
  | "link-not-file"
  /** Where the link points cannot be told from what main knows (a relative path with no workspace, `~`, `C:x`). */
  | "link-unresolved"
  | "format-unsupported"
  | "not-found"
  | "not-a-file"
  | "unreadable"
  | "too-large"
  | "not-text"
  | "session-unknown"
  /** The file on disk is not what the session read (changed or replaced since): nothing was written. */
  | "changed-on-disk"
  | "save-failed"
  /** The model cannot write the edit without losing something (AC5): decided in the renderer, never sent to main. */
  | "unsafe-to-save";

export interface DocumentError {
  code: DocumentErrorCode;
  /** What the user reads, complete: it names the file or link and what to do. */
  message: string;
  /** The same request may succeed later or after the user acts (a save: yes; a link that does not exist: no). */
  retryable: boolean;
}

/** Said in the user's words; `subject` is the file name or link text it is about, `detail` what the system said. */
export function documentError(code: DocumentErrorCode, subject: string, detail?: string): DocumentError {
  const d = detail ? `: ${detail}` : "";
  const known = DOCUMENT_FORMATS.map((f) => `${f.label} (${f.extensions.join(", ")})`).join(", ");
  switch (code) {
    case "link-stale":
      return { code, retryable: false, message: "This link is no longer available. Open the conversation again, then click the link once more." };
    case "link-invalid":
      return { code, retryable: false, message: `“${subject}” is not a link to a file${d}.` };
    case "link-not-file":
      return { code, retryable: false, message: `“${subject}” does not point to a file on this computer${d}.` };
    case "link-unresolved":
      return { code, retryable: false, message: `Cannot tell which file “${subject}” points to${d}.` };
    case "format-unsupported":
      return { code, retryable: false, message: `“${subject}” cannot be opened here. It opens: ${known}.` };
    case "not-found":
      return { code, retryable: true, message: `${subject} does not exist${d}.` };
    case "not-a-file":
      return { code, retryable: false, message: `${subject} is not a regular file${d}.` };
    case "unreadable":
      return { code, retryable: true, message: `Could not read ${subject}${d}.` };
    case "too-large":
      return { code, retryable: false, message: `${subject} is too large to open${d}.` };
    case "not-text":
      return { code, retryable: false, message: `${subject} is not valid UTF-8 text, so it is not opened (nothing was changed).` };
    case "session-unknown":
      return { code, retryable: false, message: `${subject} is no longer open. Open its link again.` };
    case "changed-on-disk":
      return { code, retryable: true, message: `${subject} changed on disk after you opened it. Nothing was saved: reload it, or save again to replace what is there.` };
    case "save-failed":
      return { code, retryable: true, message: `Could not save ${subject}${d}. Your edits are kept: try again.` };
    case "unsafe-to-save":
      return { code, retryable: false, message: `${subject} was not saved: saving would change or lose content${d}. The file is untouched and your edits are kept.` };
  }
}

// ------------------------------------------------------------------ text
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** UTF-8 text exactly as stored: a BOM stays as U+FEFF, line endings stay; null when the bytes are not valid UTF-8 or hold NUL. */
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    const text = utf8.decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Text that can be written as UTF-8 without a character changing into U+FFFD, and without NUL. */
export const isWritableText = (text: string): boolean => !text.includes("\u0000") && !LONE_SURROGATE.test(text);

/** The text's exact bytes (no BOM added, no line ending changed). */
export const encodeUtf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

// ------------------------------------------------------------------ links: what a link says
export interface LinkPosition {
  /** 1-based. */
  line: number;
  column: number | null;
}

export type LinkKind = "file-url" | "path";

/** A link's text taken apart, with nothing about the workspace or the platform yet. */
export interface SplitLink {
  kind: LinkKind;
  /** The path as written, still percent-encoded: for a file URL, what follows `file:`. */
  raw: string;
  position: LinkPosition | null;
  /** A fragment that is not a line position (a heading's id), decoded once. */
  anchor: string | null;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: DocumentError };

const MAX_LINK = 4096;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** `…ext:12` or `…ext:12:3` after an extension: an editor's position, never part of the name (an encoded `%3A` is). */
const POSITION_SUFFIX = /^(.*\.[^\\/.:#?]+):(\d{1,9})(?::(\d{1,9}))?$/s;
/** `#L12`, `#L12C3`, `#L12-L20`, `#L12C3-L20C8`: the start is the position, the range's end is ignored. */
const POSITION_FRAGMENT = /^L(\d{1,9})(?:C(\d{1,9}))?(?:-L?\d{1,9}(?:C\d{1,9})?)?$/;
const DRIVE_SLASH = /^[A-Za-z]:[\\/]/;
const DRIVE_ONLY = /^[A-Za-z]:(?![\\/])/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]+:/;

/** Percent-decoding, once. An escape that is not valid (`%zz`, a cut UTF-8 sequence) leaves the whole text as it is. */
export function decodeOnce(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function position(line: string, column: string | undefined, subject: string): Result<LinkPosition> {
  const l = Number(line);
  if (l < 1) return { ok: false, error: documentError("link-invalid", subject, "a line number starts at 1") };
  return { ok: true, value: { line: l, column: column === undefined ? null : Math.max(1, Number(column)) } };
}

/**
 * What a link's text says, without the platform or the workspace: its kind, its path as written, the line it points
 * to and the anchor. The fragment starts at the first `#` (a `#` in a file name is written `%23`); in a file URL a
 * query is dropped, in a plain path `?` is part of the name. `<…>` around the whole link is dropped.
 */
export function splitHref(href: string): Result<SplitLink> {
  let text = href.trim();
  if (text.startsWith("<") && text.endsWith(">")) text = text.slice(1, -1).trim();
  if (!text) return { ok: false, error: documentError("link-invalid", href, "it is empty") };
  if (text.length > MAX_LINK) return { ok: false, error: documentError("link-invalid", `${text.slice(0, 60)}…`, "it is too long") };
  if (CONTROL.test(text)) return { ok: false, error: documentError("link-invalid", text.replace(CONTROL, "?"), "it holds control characters") };

  let fragment: string | null = null;
  const hash = text.indexOf("#");
  if (hash >= 0) {
    fragment = text.slice(hash + 1) || null;
    text = text.slice(0, hash);
  }
  const isFileUrl = /^file:/i.test(text);
  if (isFileUrl) {
    const query = text.indexOf("?");
    if (query >= 0) text = text.slice(0, query);
  } else if (!DRIVE_SLASH.test(text) && SCHEME.test(text)) {
    return { ok: false, error: documentError("link-not-file", href, `it is a ${text.slice(0, text.indexOf(":") + 1)} link`) };
  } else if (DRIVE_ONLY.test(text)) {
    return { ok: false, error: documentError("link-unresolved", href, "a path with a drive letter but no folder is relative to a drive's current folder") };
  }
  if (!text || text === "file:") return { ok: false, error: documentError("link-invalid", href, "it names no file") };

  let pos: LinkPosition | null = null;
  const suffix = POSITION_SUFFIX.exec(text);
  if (suffix) {
    const p = position(suffix[2]!, suffix[3], href);
    if (!p.ok) return p;
    pos = p.value;
    text = suffix[1]!;
  }
  let anchor: string | null = null;
  if (fragment !== null) {
    const f = POSITION_FRAGMENT.exec(fragment);
    if (f) {
      if (!pos) {
        const p = position(f[1]!, f[2], href);
        if (!p.ok) return p;
        pos = p.value;
      }
    } else {
      anchor = decodeOnce(fragment);
    }
  }
  return { ok: true, value: { kind: isFileUrl ? "file-url" : "path", raw: text, position: pos, anchor } };
}

/** The format a link opens with, from the extension of the file it names; null for a type "Mở" does not open. */
export function linkFormat(href: string, formats: readonly DocumentFormat[] = DOCUMENT_FORMATS): DocumentFormat | null {
  const split = splitHref(href);
  return split.ok ? formatForPath(decodeOnce(split.value.raw), formats) : null;
}

// ------------------------------------------------------------------ links: where a link points
export type PathStyle = "posix" | "windows";

export interface LinkContext {
  /** The conversation's workspace folder, absolute; null when it has none. */
  workspace: string | null;
}

export interface LinkTarget {
  /**
   * Absolute, with separators of its style, empty and `.` segments dropped, a Windows drive letter in capitals.
   * **A POSIX path keeps every `..` as written**: the kernel resolves `a/link/..` through the symlink's real folder, so
   * collapsing it here (`a/link/..` → `a`) would point at another file. Only the file system can resolve it: main
   * opens the path with `fs.realpath.native` (never `path.resolve`, `path.normalize`, `new URL` or the JS `realpathSync`,
   * which collapse `..` first). A Windows path has its `..` resolved here because Windows does exactly that, before it
   * looks at any link.
   */
  path: string;
  style: PathStyle;
  position: LinkPosition | null;
  anchor: string | null;
}

const isWindowsAbsolute = (p: string): boolean => DRIVE_SLASH.test(p) || /^\\\\[^\\/]/.test(p);
const isAbsolute = (p: string): boolean => p.startsWith("/") || isWindowsAbsolute(p);

/**
 * An absolute path's root and its segments: empty and `.` segments are dropped (they change nothing, links or not). On
 * Windows `..` is resolved (never above the drive or share); on POSIX it stays, for the file system to resolve.
 */
function normalize(path: string, style: PathStyle): { root: string; segments: string[] } | null {
  let root = "";
  let rest = path;
  if (style === "windows") {
    const drive = /^([A-Za-z]):[\\/]*/.exec(path);
    const unc = /^\\\\([^\\/]+)[\\/]+([^\\/]+)/.exec(path);
    if (drive) {
      root = `${drive[1]!.toUpperCase()}:\\`;
      rest = path.slice(drive[0].length);
    } else if (unc) {
      root = `\\\\${unc[1]}\\${unc[2]}\\`;
      rest = path.slice(unc[0].length);
    } else {
      return null;
    }
  } else {
    root = "/";
  }
  const segments: string[] = [];
  for (const s of rest.split(style === "windows" ? /[\\/]+/ : /\/+/)) {
    if (!s || s === ".") continue;
    if (s === ".." && style === "windows") segments.pop();
    else segments.push(s);
  }
  return { root, segments };
}

const join = (n: { root: string; segments: string[] }, style: PathStyle): string => n.root + n.segments.join(style === "windows" ? "\\" : "/");

/** Decoded path text that names a file (not a folder, no control character); an error otherwise. */
function checked(decoded: string, shown: string): Result<string> {
  if (CONTROL.test(decoded)) return { ok: false, error: documentError("link-invalid", shown, "it holds control characters") };
  if (/[\\/]$/.test(decoded) || /(^|[\\/])\.\.?$/.test(decoded)) return { ok: false, error: documentError("link-invalid", shown, "it names a folder") };
  return { ok: true, value: decoded };
}

function fileUrlPath(raw: string, shown: string): Result<{ path: string; style: PathStyle }> {
  // file:///p, file:/p, file://localhost/p, file:///C:/p, file://C:/p (written so), file://server/share/p (a network share).
  const rest = raw.slice("file:".length);
  let authority = "";
  let path = rest;
  if (rest.startsWith("//")) {
    const slash = rest.indexOf("/", 2);
    authority = slash < 0 ? rest.slice(2) : rest.slice(2, slash);
    path = slash < 0 ? "" : rest.slice(slash);
  }
  if (!path.startsWith("/") && !/^[A-Za-z]:$/.test(authority)) return { ok: false, error: documentError("link-invalid", shown, "a file URL needs an absolute path") };
  const decodedAuthority = decodeOnce(authority);
  const decoded = decodeOnce(path);
  if (/^[A-Za-z]:$/.test(decodedAuthority)) return { ok: true, value: { path: `${decodedAuthority}${decoded || "\\"}`, style: "windows" } };
  if (decodedAuthority && decodedAuthority.toLowerCase() !== "localhost") {
    if (!/^\/[^/]+/.test(decoded)) return { ok: false, error: documentError("link-invalid", shown, "a network path needs a share") };
    return { ok: true, value: { path: `\\\\${decodedAuthority}${decoded.replace(/\//g, "\\")}`, style: "windows" } };
  }
  if (/^\/[A-Za-z]:(\/|$)/.test(decoded)) return { ok: true, value: { path: decoded.slice(1), style: "windows" } };
  return { ok: true, value: { path: decoded, style: "posix" } };
}

/**
 * The file a link points to. An absolute path or a file URL keeps its target, wherever it is (a worktree, an attachment
 * folder outside the workspace); a relative path is read from the conversation's workspace (`..` may leave it: that is
 * what the link says, and a POSIX path keeps it unresolved, see `LinkTarget.path`); `~`, a drive-relative `C:x`, or a relative path with no workspace cannot be told, so it is an
 * error and nothing is guessed. Never looks a file up by its name or label. Percent-decoding happens once.
 */
export function resolveLink(link: SplitLink, ctx: LinkContext, shown: string = link.raw): Result<LinkTarget> {
  let path: string;
  let style: PathStyle;
  if (link.kind === "file-url") {
    const f = fileUrlPath(link.raw, shown);
    if (!f.ok) return f;
    ({ path, style } = f.value);
  } else {
    path = decodeOnce(link.raw);
    style = isWindowsAbsolute(path) ? "windows" : "posix";
  }
  const named = checked(path, shown);
  if (!named.ok) return named;
  if (link.kind === "path" && !isAbsolute(path)) {
    if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) {
      return { ok: false, error: documentError("link-unresolved", shown, "a path in the home folder is not expanded; the link needs a full path") };
    }
    const workspace = ctx.workspace;
    if (!workspace) return { ok: false, error: documentError("link-unresolved", shown, "it is relative, and this conversation has no workspace folder to read it from") };
    if (!isAbsolute(workspace)) return { ok: false, error: documentError("link-unresolved", shown, "the conversation's workspace is not an absolute path") };
    style = isWindowsAbsolute(workspace) ? "windows" : "posix";
    // On a Windows workspace both separators separate; on a POSIX one a backslash is a letter of the name.
    path = `${workspace}${style === "windows" ? "\\" : "/"}${path}`;
  }
  const n = normalize(path, style);
  if (!n || !n.segments.some((x) => x !== "..")) return { ok: false, error: documentError("link-invalid", shown, "it names no file") };
  return { ok: true, value: { path: join(n, style), style, position: link.position, anchor: link.anchor } };
}

/** `splitHref` then `resolveLink`: the target of a link's text in a conversation's context. */
export function linkTarget(href: string, ctx: LinkContext): Result<LinkTarget> {
  const split = splitHref(href);
  return split.ok ? resolveLink(split.value, ctx, href) : split;
}

// ------------------------------------------------------------------ links in the chat's text
/** Where in an item of the chat a link was written: the item's id, the part of it that is Markdown, and the link's number in that text. */
export interface DocumentLinkSite {
  itemId: string;
  part: string;
  /** 0-based, in the order `markdownLinks` finds links in the part's text. */
  ordinal: number;
  /** The link's target exactly as written. Only main keeps it; the renderer is never sent it. */
  href: string;
}

/** What the renderer is told: which link of which text has an id. The text itself, it has already. */
export interface DocumentLinkGrant {
  linkId: string;
  itemId: string;
  part: string;
  ordinal: number;
}

/**
 * The links of a Markdown text in document order: a paragraph's or heading's inline links, then the next block; a list's
 * items in order; a quote's blocks; a table's head cells, then its rows' cells row by row. Links in code are not links.
 * The renderer numbers the links it draws in this same order, so a link's ordinal is the same on both sides.
 */
export function markdownLinks(text: string): string[] {
  const out: string[] = [];
  const inline = (list: readonly Inline[]): void => {
    for (const n of list) {
      if (n.type === "link") out.push(n.href);
      if (n.type === "link" || n.type === "strong" || n.type === "em" || n.type === "del") inline(n.children);
    }
  };
  const block = (b: Block): void => {
    switch (b.type) {
      case "paragraph":
      case "heading":
        inline(b.children);
        break;
      case "list":
        for (const item of b.items) item.forEach(block);
        break;
      case "quote":
        b.children.forEach(block);
        break;
      case "table":
        b.head.forEach(inline);
        for (const row of b.rows) row.forEach(inline);
        break;
      case "code":
      case "rule":
        break;
    }
  };
  parseMarkdown(text).forEach(block);
  return out;
}

/**
 * The Markdown the chat shows, by item and part (the renderer draws exactly these with its Markdown renderer, so only
 * their links can be clicked): the PM's message (`text`), an agent's answer (`answer`), a discussion's final answer
 * (`answer`) and each of its turns' answers (`turn.<n>`). The user's own messages and the text drawn as plain text are
 * not sources. A new source is one more case here and the same part name in the renderer.
 */
export function linkParts(item: TimelineItem): Array<{ part: string; text: string }> {
  switch (item.kind) {
    case "pm":
      return [{ part: "text", text: item.text }];
    case "answer":
      return item.turn.status === "success" && typeof item.turn.answer === "string" ? [{ part: "answer", text: item.turn.answer }] : [];
    case "discussion": {
      const parts: Array<{ part: string; text: string }> = [];
      if (typeof item.discussion.answer === "string") parts.push({ part: "answer", text: item.discussion.answer });
      item.discussion.turns.forEach((t, n) => {
        if (t.status === "success" && typeof t.answer === "string") parts.push({ part: `turn.${n}`, text: t.answer });
      });
      return parts;
    }
    default:
      return [];
  }
}

/** Every link of the timeline that points to a file "Mở" can open (by its extension), in order. */
export function documentLinkSites(timeline: readonly TimelineItem[], formats: readonly DocumentFormat[] = DOCUMENT_FORMATS): DocumentLinkSite[] {
  const sites: DocumentLinkSite[] = [];
  for (const item of timeline) {
    for (const { part, text } of linkParts(item)) {
      markdownLinks(text).forEach((href, ordinal) => {
        if (linkFormat(href, formats)) sites.push({ itemId: item.id, part, ordinal, href });
      });
    }
  }
  return sites;
}

/** The most links one conversation view keeps ids for (the latest ones). */
export const MAX_LINKS_PER_VIEW = 500;

interface Held {
  id: string;
  site: DocumentLinkSite;
}

/**
 * The ids main granted to the links of conversations' views, and what each one points to. One table per main process.
 *  - An owner (`<project>/<conversation>`) has the ids of one view: attaching it again (a new view number) revokes all
 *    the ids of the earlier view, and a request that names the old view finds nothing.
 *  - The same link (same item, part, ordinal and target) keeps its id while the chat grows; a link whose target at that
 *    place changed is revoked and gets a new id; a link whose text is gone (the item was dropped) is revoked.
 *  - Closing a conversation, restarting or forgetting a project revokes (`revoke`, `revokeProject`).
 * A document session does not depend on these ids: revoking one never closes a document being edited.
 */
export class DocumentLinkTable {
  private counter = 0;
  private readonly views = new Map<string, { view: number; links: Map<string, Held> }>();

  private static key(s: DocumentLinkSite): string {
    return `${s.itemId}|${s.part}|${s.ordinal}`;
  }

  /**
   * Brings the owner's ids in line with the sites of the chat now. `grants` are the ids to tell the renderer about (the
   * new ones; with `fresh`, every live one, for a page that was just given the whole state) and `revoked` the ids that
   * are no longer valid.
   */
  sync(owner: string, view: number, sites: readonly DocumentLinkSite[], fresh = false): { grants: DocumentLinkGrant[]; revoked: string[] } {
    const revoked: string[] = [];
    let held = this.views.get(owner);
    if (held && held.view !== view) {
      for (const h of held.links.values()) revoked.push(h.id);
      held = undefined;
    }
    if (!held) {
      held = { view, links: new Map() };
      this.views.set(owner, held);
    }
    const wanted = new Map<string, DocumentLinkSite>();
    for (const s of sites.slice(-MAX_LINKS_PER_VIEW)) wanted.set(DocumentLinkTable.key(s), s);
    const grants: DocumentLinkGrant[] = [];
    for (const [key, h] of held.links) {
      const s = wanted.get(key);
      if (!s || s.href !== h.site.href) {
        revoked.push(h.id);
        held.links.delete(key);
      } else if (fresh) {
        grants.push({ linkId: h.id, itemId: s.itemId, part: s.part, ordinal: s.ordinal });
      }
    }
    for (const [key, s] of wanted) {
      if (held.links.has(key)) continue;
      const id = `k${++this.counter}`;
      held.links.set(key, { id, site: s });
      grants.push({ linkId: id, itemId: s.itemId, part: s.part, ordinal: s.ordinal });
    }
    return { grants, revoked };
  }

  /** The target text of a link id, only for the view it was granted for; null for an id that is unknown, revoked, or of another view or owner. */
  href(owner: string, view: number, linkId: string): string | null {
    const held = this.views.get(owner);
    if (!held || held.view !== view) return null;
    for (const h of held.links.values()) if (h.id === linkId) return h.site.href;
    return null;
  }

  /** Every id of an owner (its view went: closed, archived, deleted, its worker restarted). Returns the ids revoked. */
  revoke(owner: string): string[] {
    const held = this.views.get(owner);
    this.views.delete(owner);
    return held ? [...held.links.values()].map((h) => h.id) : [];
  }

  /** Every id of a project's conversations. */
  revokeProject(projectId: string): string[] {
    const ids: string[] = [];
    for (const owner of [...this.views.keys()]) if (owner.startsWith(`${projectId}/`)) ids.push(...this.revoke(owner));
    return ids;
  }

  get size(): number {
    let n = 0;
    for (const v of this.views.values()) n += v.links.size;
    return n;
  }
}

// ------------------------------------------------------------------ sessions
/** What opening a document gives the renderer. The text is the file as it was read; `revision` names that content. */
export interface DocumentInfo {
  documentId: string;
  /** `DocumentFormat.id`: the renderer picks its viewer by it. */
  format: string;
  /** The file's name, for titles and messages. */
  name: string;
  /** Where the file is (the resolved path), shown to the user and never sent back. */
  location: string;
  revision: string;
  text: string;
  /** Where the link pointed in the file, to scroll to. */
  position: LinkPosition | null;
  anchor: string | null;
  /** `allowed: false` when the file is known not to be writable: it opens to read, and says why. */
  save: { allowed: true } | { allowed: false; reason: string };
  /** The conversation whose link opened it. */
  origin: { projectId: string; conversationId: string };
}

/** The answer of a request about a document: its value, or an error the user reads (the content they typed stays with them). */
export type DocumentResult<T> = ({ ok: true } & T) | { ok: false; error: DocumentError };

export type DocumentOpened = DocumentResult<{ document: DocumentInfo; existing: boolean }>;
export type DocumentSaved = DocumentResult<{ revision: string }>;

/** Main asks the renderer to settle unsaved documents before it quits or closes the window. */
export const DOCUMENT_CLOSE_REASONS = ["quit", "window"] as const;
export type DocumentCloseReason = (typeof DOCUMENT_CLOSE_REASONS)[number];
/** `settled`: every document of the request was saved or discarded; `cancelled`: the user kept editing. */
export const DOCUMENT_CLOSE_OUTCOMES = ["settled", "cancelled"] as const;
export type DocumentCloseOutcome = (typeof DOCUMENT_CLOSE_OUTCOMES)[number];

// ------------------------------------------------------------------ the Markdown model (implemented by shared/markdown-document.ts)
/** Why an edit cannot be written as it stands (AC5). Shown to the user whole; nothing is written while one stands. */
export interface SaveBlock {
  code:
    /** The edit lies in a block with a construct the editor cannot rewrite (raw HTML, a footnote, a definition…). */
    | "unsupported-construct"
    /** The edited block, written out and read again, is not what the editor showed. */
    | "roundtrip-mismatch"
    /** The text holds NUL or half a surrogate pair: it would change when written. */
    | "unwritable-text";
  construct: string | null;
  /** 1-based line in the file as it was read, when there is one. */
  line: number | null;
  message: string;
}

export type SerializeResult = { ok: true; text: string } | { ok: false; blocks: readonly SaveBlock[] };

export interface MarkdownBlockInfo {
  /** Stable across edits of other blocks. */
  id: string;
  /** "paragraph", "heading", "list", "quote", "code", "rule", "table", or "other" for what the model keeps whole. */
  kind: string;
  /** Where the block was in the source as read: [start, end) in UTF-16 units. A block added by an edit has none. */
  span: { start: number; end: number } | null;
  /** Its text was changed by an edit: only edited blocks are written from the editor's content. */
  edited: boolean;
  /** The editor can change it and write it back. `false`: shown, kept byte for byte, and edits to it are refused. */
  editable: boolean;
  /** The construct that makes it not editable ("html block", "footnote definition"…), else null. */
  construct: string | null;
}

/**
 * A Markdown file as a list of blocks, each with its place in the source. The model is immutable: an edit returns a new
 * one. Its guarantees (tested with fixtures, and what AC5 rests on):
 *  1. Unedited, `serialize()` returns the source byte for byte: BOM, CRLF or LF, a missing final newline, front matter,
 *     HTML, tables, reference definitions, anything the editor cannot show included.
 *  2. An edit replaces only the source of the blocks it names; every other byte stays. The replacement's line endings
 *     follow the source's.
 *  3. When an edit cannot be written without loss (it lies in a block that is not `editable`, it does not read back as
 *     the blocks it should, or its text cannot be written as UTF-8), `serialize()` is `ok: false` with the reasons and no
 *     text, so no caller has a lossy conversion to write. The user is told (`documentError("unsafe-to-save", …)`).
 *  4. `notices` lists the constructs kept as they are, to be shown when the document opens: saving is allowed.
 */
export interface MarkdownDocument {
  /** The file's text as read. */
  readonly source: string;
  readonly blocks: readonly MarkdownBlockInfo[];
  readonly notices: readonly SaveBlock[];
  /** Some block was edited (the Save button and the "unsaved" mark follow it; the renderer also compares with the source). */
  readonly edited: boolean;
  /** The block's Markdown source (its text now, edited or not). */
  blockSource(blockId: string): string;
  /** The block becomes this Markdown (it may read as none, one or several blocks: empty removes it). */
  replace(blockId: string, markdown: string): MarkdownDocument;
  /** New Markdown after a block (`null`: at the start). */
  insert(afterBlockId: string | null, markdown: string): MarkdownDocument;
  serialize(): SerializeResult;
}
