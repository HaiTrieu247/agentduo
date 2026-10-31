// Release notes as published on GitHub, shown as text: everything is escaped, Markdown emphasis markers are dropped,
// and only links into this repository on github.com become links. Nothing in the notes can add markup to the page.
import { REPOSITORY } from "./release-data.mjs";
import { esc } from "./render.mjs";

const REPO_URL = new RegExp(`https://github\\.com/${REPOSITORY.replace("/", "\\/")}/[A-Za-z0-9._~/%-]+`, "g");

export function releaseNotesHtml(notes) {
  const lines = String(notes ?? "").replace(/\r\n/g, "\n").trim().split("\n");
  if (!lines.join("").trim()) return "<p>(no notes)</p>";
  return lines.filter((l) => l.trim()).map((line) => {
    const text = line.replace(/\*\*|__/g, "").replace(/^#+\s*/, "").replace(/^[-*]\s+/, "• ");
    let out = "";
    let last = 0;
    for (const m of text.matchAll(REPO_URL)) {
      out += esc(text.slice(last, m.index));
      out += `<a href="${esc(m[0])}" rel="noopener">${esc(m[0].replace("https://github.com/", ""))}</a>`;
      last = m.index + m[0].length;
    }
    return `<p>${out + esc(text.slice(last))}</p>`;
  }).join("");
}

/** The tag a "compare/vA...vB" link in the notes starts from, when no public release has that tag; else null. */
export function untaggedBase(release, publicReleases) {
  const m = /\/compare\/(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+?)?)\.\.\./.exec(release.notes ?? "");
  if (!m) return null;
  return publicReleases.some((r) => r.tag === m[1]) ? null : m[1];
}
