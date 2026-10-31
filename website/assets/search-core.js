// Search over the static index, shared by the browser (assets/search.js) and the tests. Matching ignores case and
// accents, so "dang nhap" finds "đăng nhập": text is decomposed (NFD), combining marks are dropped and đ becomes d.
// A position in the folded text maps back to the original text, so a snippet shows the words as written.

/** One character folded for matching: lowercase, without accents. */
function foldChar(ch) {
  if (ch === "đ" || ch === "Đ") return "d";
  return ch.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** The folded text and, for each of its characters, the index of the original character it came from. */
export function fold(text) {
  let out = "";
  const map = [];
  let i = 0;
  for (const ch of String(text)) {
    const f = foldChar(ch);
    for (let k = 0; k < f.length; k++) map.push(i);
    out += f;
    i += ch.length;
  }
  map.push(i);
  return { text: out, map };
}

export const normalize = (text) => fold(text).text;

/** The words of a query, folded; quotes and punctuation that split words are ignored. */
export function terms(query) {
  return [...new Set(normalize(query).split(/[\s,;:!?()[\]{}"'“”‘’]+/).filter((t) => t.length > 0))].slice(0, 8);
}

function count(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1 && n < 20; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * Records that contain every term (in the page title, the section heading or the text), best first: a term in a
 * title counts most, then in a heading, then each time it appears in the text.
 */
export function search(records, query, limit = 50) {
  const words = terms(query);
  if (!words.length) return [];
  const results = [];
  for (const r of records) {
    const page = r.pf ?? (r.pf = normalize(r.p));
    const heading = r.sf ?? (r.sf = normalize(r.s));
    const text = r.xf ?? (r.xf = fold(r.x));
    let score = 0;
    let all = true;
    for (const w of words) {
      const inPage = page.includes(w);
      const inHeading = heading.includes(w);
      const inText = count(text.text, w);
      if (!inPage && !inHeading && !inText) {
        all = false;
        break;
      }
      score += (inPage ? 12 : 0) + (inHeading ? 8 : 0) + Math.min(inText, 6);
    }
    if (!all) continue;
    if (r.top) score += 2; // a page's introduction answers a match in its title better than a section deep inside
    results.push({ record: r, score });
  }
  results.sort((a, b) => b.score - a.score || a.record.u.localeCompare(b.record.u));
  return results.slice(0, limit).map((x) => x.record);
}

/**
 * A short passage of the record's text around the first term found, as parts to render: { text, match }. Matches
 * keep the original letters (accents included).
 */
export function snippet(record, query, width = 180) {
  const words = terms(query);
  const original = record.x;
  const folded = record.xf ?? (record.xf = fold(original));
  let at = -1;
  for (const w of words) {
    const i = folded.text.indexOf(w);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const startFolded = at === -1 ? 0 : Math.max(0, at - Math.floor(width / 3));
  let start = folded.map[startFolded];
  let end = Math.min(original.length, start + width);
  if (start > 0) {
    const space = original.indexOf(" ", start);
    if (space !== -1 && space < start + 20) start = space + 1;
  }
  if (end < original.length) {
    const space = original.lastIndexOf(" ", end);
    if (space > start + 40) end = space;
  }
  const passage = original.slice(start, end);
  const pf = fold(passage);
  const marks = [];
  for (const w of words) {
    for (let i = pf.text.indexOf(w); i !== -1; i = pf.text.indexOf(w, i + w.length)) marks.push([pf.map[i], pf.map[i + w.length]]);
  }
  marks.sort((a, b) => a[0] - b[0]);
  const parts = [];
  let pos = 0;
  for (const [a, b] of marks) {
    if (a < pos) continue;
    if (a > pos) parts.push({ text: passage.slice(pos, a), match: false });
    parts.push({ text: passage.slice(a, b), match: true });
    pos = b;
  }
  if (pos < passage.length) parts.push({ text: passage.slice(pos), match: false });
  if (start > 0) parts.unshift({ text: "…", match: false });
  if (end < original.length) parts.push({ text: "…", match: false });
  return parts;
}
