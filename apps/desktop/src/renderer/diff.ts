// A line diff for the inspector's Changes tab: what a run changed in one file, line by line, with both sides' line
// numbers. Pure (no DOM), so it is tested as is. Bounded: a file too long, or a change too big to compare in the
// renderer's time, is said to be too large, and the inspector shows its two sides instead.

export interface DiffRow {
  kind: "same" | "add" | "del";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface LineDiff {
  rows: DiffRow[];
  /** More rows than are shown: the rest was cut. */
  truncated: boolean;
  /** Not compared at all (too many lines, or too big a changed middle): show before and after instead. */
  tooLarge: boolean;
}

export interface DiffLimits {
  /** Lines on either side beyond which nothing is compared. */
  maxLines?: number;
  /** Cells of the comparison table (changed lines before × after) beyond which nothing is compared. */
  maxCells?: number;
  /** Rows shown at most. */
  maxRows?: number;
}

export const DIFF_LIMITS = { maxLines: 20_000, maxCells: 4_000_000, maxRows: 10_000 } as const;

/** A file's lines: a last newline ends the last line, it does not start an empty one. */
export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function lineDiff(before: string, after: string, o: DiffLimits = {}): LineDiff {
  const maxLines = o.maxLines ?? DIFF_LIMITS.maxLines;
  const maxCells = o.maxCells ?? DIFF_LIMITS.maxCells;
  const maxRows = o.maxRows ?? DIFF_LIMITS.maxRows;
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > maxLines || b.length > maxLines) return { rows: [], truncated: false, tooLarge: true };

  // What both sides share at their start and at their end is not compared, only the middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n * m > maxCells) return { rows: [], truncated: false, tooLarge: true };

  const rows: DiffRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  const same = (text: string) => rows.push({ kind: "same", oldNo: oldNo++, newNo: newNo++, text });
  const del = (text: string) => rows.push({ kind: "del", oldNo: oldNo++, newNo: null, text });
  const add = (text: string) => rows.push({ kind: "add", oldNo: null, newNo: newNo++, text });

  for (let i = 0; i < start; i++) same(a[i]!);

  if (n === 0) for (let j = 0; j < m; j++) add(b[start + j]!);
  else if (m === 0) for (let i = 0; i < n; i++) del(a[start + i]!);
  else {
    // Longest common subsequence of the middle, from the end, so the walk below goes forward.
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] = a[start + i] === b[start + j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        same(a[start + i]!);
        i++;
        j++;
      } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) del(a[start + i++]!);
      else add(b[start + j++]!);
    }
    while (i < n) del(a[start + i++]!);
    while (j < m) add(b[start + j++]!);
  }

  for (let i = endA; i < a.length; i++) same(a[i]!);

  const truncated = rows.length > maxRows;
  return { rows: truncated ? rows.slice(0, maxRows) : rows, truncated, tooLarge: false };
}

/** How many lines were added and removed. */
export function diffStats(d: LineDiff): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of d.rows) {
    if (r.kind === "add") added++;
    else if (r.kind === "del") removed++;
  }
  return { added, removed };
}
