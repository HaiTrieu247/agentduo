// @ mentions as text: the word being typed, how a path is written into the message, what a message mentions, and the
// ranking of workspace paths for what was typed. No Node: the webview bundles it (src/core/mentions.ts finds the paths).

export type PathKind = "file" | "folder";

/** A path of the workspace a mention can name: relative, with `/` between its parts; a folder's ends with `/`. */
export interface PathEntry {
  path: string;
  kind: PathKind;
}

export const MENTION_LIMITS = {
  /** The longest query the hosts pass on (what follows the @). */
  query: 200,
  /** The most suggestions one query gets. */
  results: 50,
};

export interface MentionRange {
  /** Where its @ is. */
  start: number;
  /** Where the word ends (after the caret, its rest still counts). */
  end: number;
  /** What follows the @, without an opening quote: the path typed so far. */
  query: string;
}

/** The mention being typed: an @ at the start or after a space, then a path, unquoted or after a quote not yet closed. */
const TYPING = /(?:^|\s)@("[^"\n]*|[^\s"]*)$/;
/** Every mention of a text: `@path` or `@"a path with spaces"`. */
const MENTION = /(?:^|(?<=\s))@(?:"([^"\n]+)"|([^\s"]+))/g;

/** The mention the caret is in, or null when it is in none. */
export function mentionAt(text: string, caret = text.length): MentionRange | null {
  const before = text.slice(0, caret);
  const m = TYPING.exec(before);
  if (!m) return null;
  const word = m[1]!;
  const quoted = word.startsWith('"');
  const rest = text.slice(caret);
  const tail = (quoted ? /^[^"\n]*"?/ : /^[^\s"]*/).exec(rest)![0];
  return { start: caret - word.length - 1, end: caret + tail.length, query: quoted ? word.slice(1) : word };
}

/** How `entry` is written in a message: `@src/a.ts`, quoted when it has a space; `open`: a folder left open to type into. */
export function mentionText(entry: PathEntry, open = false): string {
  if (!/\s/.test(entry.path)) return `@${entry.path}`;
  return open ? `@"${entry.path}` : `@"${entry.path}"`;
}

/**
 * `text` with the mention at `range` replaced by `entry`'s, and where the caret goes. A picked path is followed by a
 * space (the one there, or a new one); an opened folder is not, so typing goes on inside it.
 */
export function insertMention(text: string, range: Pick<MentionRange, "start" | "end">, entry: PathEntry, open: boolean): { text: string; caret: number } {
  const keepOpen = open && entry.kind === "folder";
  const written = mentionText(entry, keepOpen);
  const after = text.slice(range.end);
  const space = keepOpen || after.startsWith(" ") ? "" : " ";
  return { text: text.slice(0, range.start) + written + space + after, caret: range.start + written.length + (keepOpen ? 0 : 1) };
}

/** The paths a text mentions, as written (without quotes), each once, in the order they come. */
export function mentionedPaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION)) {
    const path = m[1] ?? m[2]!;
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

// ------------------------------------------------------------------ ranking
// The scores of fzy (github.com/jhawthorn/fzy): letters in order, a match at the start of a name or a word worth more,
// a run of letters more still, and every letter between or around them a little less.
const GAP_LEADING = -0.005;
const GAP_TRAILING = -0.005;
const GAP_INNER = -0.01;
const CONSECUTIVE = 1;
const AFTER_SLASH = 0.9;
const AFTER_WORD = 0.8;
const CAPITAL = 0.7;
const AFTER_DOT = 0.6;
const EXACT = 1e9;

function startBonus(prev: string, ch: string): number {
  if (prev === "/") return AFTER_SLASH;
  if (prev === "-" || prev === "_" || prev === " ") return AFTER_WORD;
  if (prev === ".") return AFTER_DOT;
  if (prev >= "a" && prev <= "z" && ch >= "A" && ch <= "Z") return CAPITAL;
  return 0;
}

/** How well `query` matches `path` (higher is better), or null when its letters are not all in it, in order. Case is ignored. */
export function fuzzyScore(query: string, path: string): number | null {
  const n = query.length;
  const m = path.length;
  if (!n) return 0;
  if (n > m) return null;
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  let k = 0;
  for (let j = 0; j < m && k < n; j++) if (p[j] === q[k]) k++;
  if (k < n) return null;
  if (n === m) return EXACT;
  const bonus = new Float64Array(m);
  for (let j = 0; j < m; j++) bonus[j] = startBonus(j ? path[j - 1]! : "/", path[j]!);
  // d[j]: the best score with q[i] matched at p[j]; best[j]: the best with q[..i] matched within p[..j].
  let d = new Float64Array(m);
  let best = new Float64Array(m);
  for (let i = 0; i < n; i++) {
    const nd = new Float64Array(m);
    const nbest = new Float64Array(m);
    const gap = i === n - 1 ? GAP_TRAILING : GAP_INNER;
    let running = -Infinity;
    for (let j = 0; j < m; j++) {
      if (q[i] === p[j]) {
        let score = -Infinity;
        if (i === 0) score = j * GAP_LEADING + bonus[j]!;
        else if (j > 0) score = Math.max(best[j - 1]! + bonus[j]!, d[j - 1]! + CONSECUTIVE);
        nd[j] = score;
        running = Math.max(score, running + gap);
      } else {
        nd[j] = -Infinity;
        running += gap;
      }
      nbest[j] = running;
    }
    d = nd;
    best = nbest;
  }
  return best[m - 1]!;
}

const byName = (a: PathEntry, b: PathEntry) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()) || a.path.localeCompare(b.path);
/** Folders, then files, each by name. */
const listing = (a: PathEntry, b: PathEntry) => (a.kind === b.kind ? byName(a, b) : a.kind === "folder" ? -1 : 1);

/** The entries directly in `folder` (a path ending in `/`, or "" for the workspace's top level). */
function children(folder: string, entries: readonly PathEntry[]): PathEntry[] {
  const dir = folder.toLowerCase();
  return entries.filter((e) => {
    const path = e.path.toLowerCase();
    if (!path.startsWith(dir) || path === dir) return false;
    const rest = path.slice(dir.length);
    const slash = rest.indexOf("/");
    return slash === -1 || slash === rest.length - 1;
  });
}

/**
 * The entries to suggest for `query`, best first: the top level for nothing typed, a folder's own entries once its
 * path (with its `/`) is typed, and otherwise the paths that have its letters in order.
 */
export function rankPaths(query: string, entries: readonly PathEntry[], limit = MENTION_LIMITS.results): PathEntry[] {
  const q = query.replace(/^(\.\/)+/, "").slice(0, MENTION_LIMITS.query);
  if (!q) return children("", entries).sort(listing).slice(0, limit);
  if (q.endsWith("/") && entries.some((e) => e.kind === "folder" && e.path.toLowerCase() === q.toLowerCase())) {
    return children(q, entries).sort(listing).slice(0, limit);
  }
  const scored: Array<{ entry: PathEntry; score: number }> = [];
  for (const entry of entries) {
    const score = fuzzyScore(q, entry.path);
    if (score !== null) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.path.length - b.entry.path.length || byName(a.entry, b.entry));
  return scored.slice(0, limit).map((s) => s.entry);
}
