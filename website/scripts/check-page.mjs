// Checks some pages in every language without building the site: each module loads and renders, passes the build's
// page checks (title, description length, unique ids, no placeholders), links only to known pages, and has the same
// sections and sub-headings in every language. Useful while writing or translating a page.
//
//   node scripts/check-page.mjs docs/cli docs/slash-commands
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pageById } from "../content/navigation.mjs";
import { createHelpers } from "../lib/content.mjs";
import { createDownloads } from "../lib/downloads.mjs";
import { idsIn, textOf } from "../lib/render.mjs";
import { DEFAULT_LOCALE, LOCALES, localizedRoute } from "../lib/urls.mjs";
import { checkPage, loadData } from "./build.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const ids = process.argv.slice(2);
if (!ids.length) {
  console.error("usage: node scripts/check-page.mjs <page id>…");
  process.exit(2);
}
const data = loadData();
let failed = 0;
const shapes = {};
for (const locale of LOCALES) {
  const L = (await import(pathToFileURL(join(root, "content", locale, "index.mjs")).href)).default;
  const routeOf = (id) => (pageById.has(id) ? localizedRoute(pageById.get(id).path, locale) : null);
  const h = createHelpers({ routeOf, examplesDir: join(root, "examples"), strings: L.strings, locale });
  const dl = createDownloads({ release: data.release, downloads: data.downloads, t: L.strings.downloads });
  for (const id of ids) {
    try {
      if (typeof L.pages[id] !== "function") throw new Error("no module");
      const mod = L.pages[id](h, { ...data, dl, locale, titles: {} });
      checkPage(mod, `content/${locale} ${id}`);
      if (/STUB-FOR-BUILD|Stub content/.test(JSON.stringify(mod))) throw new Error("still a stub");
      (shapes[id] ??= {})[locale] = mod.sections.map((s) => [s.id, ...idsIn(s.html)].join(",")).join("|");
      console.log(`ok   ${locale} ${id}: ${textOf(mod.title)} (${mod.sections.length} sections)`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${locale} ${id}: ${e.message}`);
    }
  }
}
for (const id of ids) {
  const s = shapes[id] ?? {};
  for (const locale of LOCALES) {
    if (locale !== DEFAULT_LOCALE && s[locale] && s[DEFAULT_LOCALE] && s[locale] !== s[DEFAULT_LOCALE]) {
      failed++;
      console.log(`FAIL ${id}: ${locale} sections/headings differ from ${DEFAULT_LOCALE}\n  ${DEFAULT_LOCALE}: ${s[DEFAULT_LOCALE]}\n  ${locale}: ${s[locale]}`);
    }
  }
}
process.exit(failed ? 1 : 0);
