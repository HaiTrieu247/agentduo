// The helpers a content module gets: authored HTML stays HTML, while code, tables, notes and links go through these
// so that code is escaped, tables scroll in their own box, and every internal link names a page id the build checks.
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { highlight } from "./highlight.mjs";
import { esc } from "./render.mjs";

const LANGS = { ".yaml": "yaml", ".yml": "yaml", ".js": "js", ".mjs": "js", ".json": "json", ".sh": "sh", ".md": "md" };

/**
 * Helpers for one language. `routeOf(id)` gives a page's route in this language (or null); `examplesDir` holds the
 * shared example files; `strings` the language's interface words.
 */
export function createHelpers({ routeOf, examplesDir, strings, locale = "en" }) {
  const c = (text) => `<code>${esc(text)}</code>`;
  const kbd = (text) => `<kbd>${esc(text)}</kbd>`;

  /**
   * A code block; `label` names it (a file name, "Terminal", "PowerShell"). `lang` picks its highlighting (lib/highlight.mjs);
   * without one, chat input lines are highlighted and anything else stays plain. The copy button comes with JavaScript.
   */
  const code = (text, { lang = "", label = "" } = {}) => {
    const body = String(text).replace(/^\n+|\s+$/g, "");
    const caption = label ? `<p class="code-label">${esc(label)}</p>` : "";
    return `<div class="code"${lang ? ` data-lang="${esc(lang)}"` : ""}>${caption}<pre tabindex="0"><code>${highlight(body, lang)}</code></pre></div>`;
  };

  /** A shared example file (website/examples/…) as a code block, labelled with its name unless told otherwise. */
  const ex = (rel, { label, lang } = {}) => {
    const text = readFileSync(join(examplesDir, rel), "utf8");
    return code(text, { lang: lang ?? LANGS[extname(rel)] ?? "", label: label ?? rel.split("/").at(-1) });
  };

  /** A link to a page of this site in this language: "docs/cli", "docs/cli#options", "home". */
  const link = (target, label) => {
    const [id, fragment] = target.split("#");
    const route = routeOf(id);
    if (!route) throw new Error(`link to unknown page '${id}'`);
    return `<a href="${route}${fragment ? `#${fragment}` : ""}">${label}</a>`;
  };

  /** A page link styled as a button. */
  const btn = (target, label, primary = false) => link(target, label).replace("<a ", `<a class="button${primary ? " button-primary" : ""}" `);

  /** A link to another site; the label is HTML. */
  const ext = (url, label) => {
    if (!/^https:\/\//.test(url)) throw new Error(`external links use https: ${url}`);
    return `<a href="${esc(url)}" rel="noopener">${label}</a>`;
  };

  /** A table in a scrolling region of its own; cells are HTML. */
  const table = ({ caption, head, rows, className = "" }) => {
    const label = caption ? ` aria-label="${esc(caption)}"` : "";
    const cap = caption ? `<caption>${esc(caption)}</caption>` : "";
    const thead = `<thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead>`;
    const tbody = `<tbody>${rows.map((r) => `<tr>${r.map((cell, i) => (i === 0 ? `<th scope="row">${cell}</th>` : `<td>${cell}</td>`)).join("")}</tr>`).join("")}</tbody>`;
    return `<div class="table-wrap" role="region" tabindex="0"${label}><table${className ? ` class="${className}"` : ""}>${cap}${thead}${tbody}</table></div>`;
  };

  /** A note or a warning set apart from the text. */
  const note = (html, kind = "note") => {
    if (!["note", "warning", "tip"].includes(kind)) throw new Error(`unknown note kind '${kind}'`);
    return `<div class="callout callout-${kind}"><p class="callout-title">${esc(strings.callout[kind])}</p>${html}</div>`;
  };

  /** A date as words in this language ("31 October 2026"), in UTC so every build writes the same. */
  const date = (iso) => `<time datetime="${esc(iso)}">${new Intl.DateTimeFormat(locale === "vi" ? "vi-VN" : "en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(iso))}</time>`;

  const p = (html) => `<p>${html}</p>`;
  const ul = (items) => `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
  const ol = (items) => `<ol>${items.map((i) => `<li>${i}</li>`).join("")}</ol>`;
  /** Numbered steps, each a title and its HTML. */
  const steps = (items) => `<ol class="steps">${items.map(([title, html]) => `<li><p class="step-title">${title}</p>${html}</li>`).join("")}</ol>`;
  /** A definition list: [term, description] pairs. */
  const dl = (items) => `<dl class="defs">${items.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join("")}</dl>`;
  /** A sub-heading inside a section, with an id of its own so it can be linked. */
  const h3 = (id, html) => `<h3 id="${esc(id)}"><a class="heading-link" href="#${esc(id)}">${html}</a></h3>`;

  return { c, kbd, code, ex, link, btn, ext, date, table, note, p, ul, ol, steps, dl, h3, esc };
}
