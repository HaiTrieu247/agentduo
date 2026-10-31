// Builds the website into dist/: every page in every language from content/, the shared assets, a search index per
// language, robots.txt, the sitemap (only with a public origin) and Netlify's _headers and _redirects. Reads only
// local files (the committed release snapshots included), so it needs no network.
//
//   node scripts/build.mjs            SITE_URL=https://example.org node scripts/build.mjs
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import site from "../site.config.mjs";
import { PAGES, pageById } from "../content/navigation.mjs";
import { createHelpers } from "../lib/content.mjs";
import { createDownloads } from "../lib/downloads.mjs";
import { renderPage } from "../lib/layout.mjs";
import { downloadsOf, latestStable, readJson, validateChannels, validateReleases } from "../lib/release-data.mjs";
import { assertId, idsIn, textOf } from "../lib/render.mjs";
import { buildIndex } from "../lib/search.mjs";
import { DEFAULT_LOCALE, LOCALES, absoluteUrl, localizedRoute, outputFile, resolveOrigin } from "../lib/urls.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The site's data, the same for every language. */
export function loadData() {
  const releases = validateReleases(readJson(join(root, "data", "releases.json")));
  const channels = validateChannels(readJson(join(root, "data", "channels.json")));
  const signing = readJson(join(root, "data", "signing.json"));
  const release = latestStable(releases);
  const pkg = join(root, "..", "package.json");
  const sourceVersion = existsSync(pkg) ? JSON.parse(readFileSync(pkg, "utf8")).version : null;
  return {
    releases, channels, release, downloads: downloadsOf(release), sourceVersion, site,
    signing: release ? signing.releases?.[release.tag] ?? null : null,
  };
}

export function checkPage(mod, where) {
  for (const key of ["title", "description"]) if (typeof mod[key] !== "string" || !mod[key].trim()) throw new Error(`${where}: ${key} is missing`);
  const description = textOf(mod.description);
  if (description.length < 50 || description.length > 220) throw new Error(`${where}: the description is ${description.length} characters; keep it between 50 and 220`);
  if (!Array.isArray(mod.sections)) throw new Error(`${where}: sections is not a list`);
  const ids = new Set();
  for (const s of mod.sections) {
    assertId(s.id, where);
    if (!s.title || typeof s.html !== "string" || !textOf(s.html)) throw new Error(`${where}#${s.id}: a section needs a title and content`);
    for (const id of [s.id, ...idsIn(s.html)]) {
      if (ids.has(id)) throw new Error(`${where}: id '${id}' is used twice`);
      ids.add(id);
    }
  }
  const all = [mod.title, mod.description, mod.lead, mod.top, mod.next, mod.actions, mod.visual, ...mod.sections.flatMap((s) => [s.title, s.html])].filter(Boolean).join("\n");
  if (/lorem ipsum|\bTODO\b|\bTBD\b|\bFIXME\b|href="#"|href=""/i.test(all)) throw new Error(`${where}: placeholder text or an empty link`);
}

/** Loads every language's content and checks that each has the same pages, sections and sub-headings. */
export async function loadContent(data) {
  const bundles = {};
  for (const locale of LOCALES) {
    const L = (await import(pathToFileURL(join(root, "content", locale, "index.mjs")).href)).default;
    const missing = PAGES.filter((p) => typeof L.pages[p.id] !== "function").map((p) => p.id);
    const extra = Object.keys(L.pages).filter((id) => !pageById.has(id));
    if (missing.length || extra.length) throw new Error(`content/${locale}: missing ${missing.join(", ") || "none"}; unknown ${extra.join(", ") || "none"}`);
    const routeOf = (id) => (pageById.has(id) ? localizedRoute(pageById.get(id).path, locale) : null);
    const h = createHelpers({ routeOf, examplesDir: join(root, "examples"), strings: L.strings, locale });
    const dl = createDownloads({ release: data.release, downloads: data.downloads, t: L.strings.downloads });
    // Twice: the first pass gives every page's title, which pages that list others (search, 404) then use.
    const titles = Object.fromEntries(PAGES.map((page) => [page.id, textOf(L.pages[page.id](h, { ...data, dl, locale, titles: {} }).title)]));
    const mods = {};
    for (const page of PAGES) {
      const mod = L.pages[page.id](h, { ...data, dl, locale, titles });
      checkPage(mod, `content/${locale} ${page.id}`);
      mods[page.id] = mod;
    }
    bundles[locale] = { L, mods, routeOf };
  }
  // Every language has the same sections and sub-headings, so a link to a part of a page works in each.
  for (const page of PAGES) {
    const shape = (locale) => bundles[locale].mods[page.id].sections.map((s) => [s.id, ...idsIn(s.html)].join(",")).join("|");
    const base = shape(DEFAULT_LOCALE);
    for (const locale of LOCALES) {
      if (shape(locale) !== base) throw new Error(`${page.id}: the ${locale} page has other sections or headings than the ${DEFAULT_LOCALE} one`);
    }
  }
  return bundles;
}

const HEADERS = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'

/*.json
  Cache-Control: public, max-age=300
`;

/** Missing pages under a language's prefix get that language's 404 page, with the 404 status (never a 200 rewrite). */
function redirects() {
  return LOCALES.filter((l) => l !== DEFAULT_LOCALE).map((l) => `/${l}/*  /${l}/404.html  404`).join("\n") + "\n";
}

function sitemap(origin, bundles) {
  const urls = [];
  for (const page of PAGES) {
    if (page.noindex) continue;
    for (const locale of LOCALES) {
      const loc = absoluteUrl(origin, localizedRoute(page.path, locale));
      const alts = LOCALES.map((l) => `<xhtml:link rel="alternate" hreflang="${site.htmlLang[l]}" href="${absoluteUrl(origin, localizedRoute(page.path, l))}"/>`).join("");
      urls.push(`<url><loc>${loc}</loc>${alts}</url>`);
    }
  }
  void bundles;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join("\n")}\n</urlset>\n`;
}

function write(out, rel, text) {
  const path = join(out, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Builds into `outDir` (cleaned first). Returns what it wrote and the warnings it printed. */
export async function build({ outDir = join(root, "dist"), env = process.env, log = console.log } = {}) {
  const { origin, source } = resolveOrigin(env);
  const warnings = [];
  if (!origin) {
    warnings.push("no public origin: set SITE_URL (e.g. SITE_URL=https://agentduo.example) for canonical URLs, social previews, hreflang links and sitemap.xml; this build leaves them out");
  }
  const data = loadData();
  if (!data.release) warnings.push("no public stable release in data/releases.json: the download page offers no installer");
  else if (!data.signing) warnings.push(`data/signing.json has no entry for ${data.release.tag}: the download page says its signing was not checked`);
  const bundles = await loadContent(data);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const files = [];
  for (const locale of LOCALES) {
    const { L, mods, routeOf } = bundles[locale];
    const titleOf = (id) => textOf(mods[id].title);
    const indexed = [];
    for (const page of PAGES) {
      const route = localizedRoute(page.path, locale);
      const alternates = new Map(LOCALES.map((l) => [l, localizedRoute(page.path, l)]));
      const mod = mods[page.id];
      const html = renderPage({ page, mod, locale, L, route, routeOf, titleOf, origin, alternates, data, scripts: mod.scripts });
      write(outDir, outputFile(route), html);
      files.push(outputFile(route));
      indexed.push({ page, mod, route });
    }
    const index = buildIndex(indexed);
    write(outDir, outputFile(localizedRoute("/search-index.json", locale)), JSON.stringify(index));
  }
  cpSync(join(root, "assets"), join(outDir, "assets"), { recursive: true });
  write(outDir, "robots.txt", `User-agent: *\nAllow: /\n${origin ? `\nSitemap: ${origin}/sitemap.xml\n` : ""}`);
  if (origin) write(outDir, "sitemap.xml", sitemap(origin, bundles));
  write(outDir, "_headers", HEADERS);
  write(outDir, "_redirects", redirects());

  for (const w of warnings) log(`warning: ${w}`);
  log(`built ${files.length} pages (${LOCALES.join(", ")}) into ${outDir}${origin ? ` for ${origin} (from ${source})` : ""}`);
  return { outDir, origin, files, warnings, assets: readdirSync(join(outDir, "assets")) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  build().catch((e) => {
    console.error(`build failed: ${e.message}`);
    process.exit(1);
  });
}
