// The static search index of one language: one record per page introduction and per section, with the page title,
// the section heading, the section's URL and its plain text. The browser fetches it only on the search page.
import { textOf } from "./render.mjs";

/** Records for every indexed page of a language. `pages`: [{ page, mod, route }]. */
export function buildIndex(pages) {
  const records = [];
  for (const { page, mod, route } of pages) {
    if (page.noindex) continue;
    const title = textOf(mod.title);
    records.push({ p: title, s: "", u: route, x: textOf(`${mod.description} ${mod.lead ?? ""}`), top: true });
    for (const s of mod.sections) {
      records.push({ p: title, s: textOf(s.title), u: `${route}#${s.id}`, x: textOf(s.html) });
    }
  }
  return records;
}
