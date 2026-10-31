// Checks a built site (dist/ by default) the way a visitor would meet it: every local link, image, script and
// stylesheet leads to a file; every #fragment, on the same page or another, names an element; ids are unique; each
// page has its language, title, description and language links; the search index points at real sections; every
// installer the download page offers is in the release snapshot; and the hosting files have no SPA fallback.
//
//   node scripts/check.mjs [dist]          exits 1 and lists every problem it found
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { downloadsOf, latestStable, readJson } from "../lib/release-data.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const LOOPBACK = /\b(?:https?:)?\/\/(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(?::\d+)?/i;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** The file a root-relative URL path is served from, or null. */
function fileFor(dist, pathname) {
  const clean = decodeURIComponent(pathname);
  const candidates = clean.endsWith("/") ? [join(dist, clean, "index.html")] : [join(dist, clean), join(dist, clean, "index.html")];
  return candidates.find((f) => existsSync(f) && statSync(f).isFile()) ?? null;
}

const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
const decode = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** Strips code blocks, where a tutorial may legitimately mention a local server. */
const withoutCode = (html) => html.replace(/<pre[\s\S]*?<\/pre>/g, "").replace(/<code>[\s\S]*?<\/code>/g, "");

export function checkSite(dist = join(root, "dist")) {
  const problems = [];
  const fail = (where, msg) => problems.push(`${where}: ${msg}`);
  if (!existsSync(join(dist, "index.html"))) return { problems: [`${dist}: no index.html (run npm run build)`], pages: 0 };
  const files = walk(dist);
  const html = files.filter((f) => f.endsWith(".html"));
  const ids = new Map();
  const pages = new Map();
  for (const file of html) {
    const text = readFileSync(file, "utf8");
    const route = "/" + relative(dist, file).split(sep).join("/").replace(/index\.html$/, "");
    pages.set(file, { text, route });
    const found = new Set();
    for (const m of text.matchAll(/\sid="([^"]+)"/g)) {
      if (found.has(m[1])) fail(route, `id '${m[1]}' is used twice`);
      found.add(m[1]);
    }
    ids.set(file, found);
  }

  const release = latestStable(readJson(join(root, "data", "releases.json")));
  const installerUrls = new Set(downloadsOf(release).installers.map((i) => i.url));
  const allAssetUrls = new Set((release?.assets ?? []).map((a) => a.url));
  const offered = new Set();

  for (const [file, { text, route }] of pages) {
    const is404 = /404\.html$/.test(file);
    if (!/^<!doctype html>/i.test(text)) fail(route, "no doctype");
    const lang = /<html lang="([^"]+)"/.exec(text)?.[1];
    if (!lang) fail(route, "no lang on <html>");
    else if (route.startsWith("/vi/") !== (lang === "vi")) fail(route, `lang="${lang}" does not match the route`);
    const title = /<title>([^<]+)<\/title>/.exec(text)?.[1];
    if (!title?.trim()) fail(route, "no <title>");
    const desc = /<meta name="description" content="([^"]*)"/.exec(text)?.[1];
    if (!desc || desc.length < 50) fail(route, "no useful meta description");
    if (!/<link rel="icon"/.test(text)) fail(route, "no favicon link");
    if (!/<a class="skip-link"|class="skip/.test(text)) fail(route, "no skip link");
    if (!/<main id="main"/.test(text)) fail(route, "no <main id=main>");
    if (!is404 && !/hreflang|lang="(en|vi)"[^>]*href=|data-lang-switch|class="lang/.test(text)) fail(route, "no language link");
    if (LOOPBACK.test(withoutCode(text))) fail(route, "a site URL names localhost or a loopback address");
    if (/href="#"|href=""/.test(text)) fail(route, "an empty link");
    if (/lorem ipsum|STUB-FOR-BUILD|Stub content/i.test(text)) fail(route, "placeholder text");
    const index = /data-index="([^"]+)"/.exec(text)?.[1];
    if (index && index !== (lang === "en" ? "/search-index.json" : `/${lang}/search-index.json`)) fail(route, `search loads ${index}, not this language's index`);

    for (const m of text.matchAll(/<(a|link|script|img|source|form)\b[^>]*>/g)) {
      const tag = m[0];
      for (const name of ["href", "src", "action", "srcset"]) {
        let value = attr(tag, name);
        if (value === null) continue;
        value = decode(value);
        const urls = name === "srcset" ? value.split(",").map((s) => s.trim().split(/\s+/)[0]) : [value];
        for (const url of urls) {
          if (/^(https?:|mailto:|data:)/.test(url)) {
            if (/^https:\/\/github\.com\/HaiTrieu247\/agentduo\/releases\/download\//.test(url)) {
              offered.add(url);
              if (!allAssetUrls.has(url)) fail(route, `download link not in the release snapshot: ${url}`);
            }
            continue;
          }
          if (url.startsWith("#")) {
            if (!ids.get(file).has(decodeURIComponent(url.slice(1)))) fail(route, `#${url.slice(1)} names no element on this page`);
            continue;
          }
          if (!url.startsWith("/")) {
            fail(route, `relative URL '${url}' (every site URL is root-relative, so 404.html works at any depth)`);
            continue;
          }
          const [path, fragment] = url.split("#");
          const pathname = path.split("?")[0];
          const target = fileFor(dist, pathname);
          if (!target) {
            fail(route, `${name}="${url}" leads to no file`);
            continue;
          }
          if (fragment && target.endsWith(".html") && !ids.get(target)?.has(decodeURIComponent(fragment))) fail(route, `${url}: #${fragment} names no element there`);
          if (tag.startsWith("<a") && pathname !== "/" && !pathname.endsWith("/") && !/\.[a-z0-9]+$/i.test(pathname)) fail(route, `${url} should end with '/'`);
        }
      }
    }
  }

  for (const url of installerUrls) if (![...offered].includes(url)) fail("download", `installer not offered anywhere: ${url}`);
  for (const url of offered) {
    if (!installerUrls.has(url) && /(\.blockmap|\.yml|\.zip)$/.test(url)) fail("download", `update file offered as a download: ${url}`);
  }

  for (const index of files.filter((f) => f.endsWith("search-index.json"))) {
    const records = JSON.parse(readFileSync(index, "utf8"));
    const where = relative(dist, index);
    if (!Array.isArray(records) || records.length < 50) fail(where, "too few records");
    for (const r of records) {
      const [path, fragment] = r.u.split("#");
      const target = fileFor(dist, path);
      if (!target) fail(where, `${r.u} leads to no page`);
      else if (fragment && !ids.get(target)?.has(fragment)) fail(where, `${r.u}: no such section`);
      if (!r.p || typeof r.x !== "string") fail(where, `${r.u}: no title or text`);
    }
  }

  for (const required of ["404.html", "vi/404.html", "robots.txt", "_headers", "_redirects", "search-index.json", "vi/search-index.json"]) {
    if (!existsSync(join(dist, required))) fail(required, "missing");
  }
  const redirects = existsSync(join(dist, "_redirects")) ? readFileSync(join(dist, "_redirects"), "utf8") : "";
  for (const line of redirects.split("\n").filter((l) => l.trim() && !l.startsWith("#"))) {
    const status = line.trim().split(/\s+/)[2];
    if (status === "200" || status === "200!") fail("_redirects", `a rewrite with 200 (an SPA fallback): ${line}`);
  }
  const robots = existsSync(join(dist, "robots.txt")) ? readFileSync(join(dist, "robots.txt"), "utf8") : "";
  const sitemap = existsSync(join(dist, "sitemap.xml"));
  if (/Sitemap:/.test(robots) !== sitemap) fail("robots.txt", "names a sitemap only when sitemap.xml exists");
  if (sitemap && LOOPBACK.test(readFileSync(join(dist, "sitemap.xml"), "utf8"))) fail("sitemap.xml", "names a loopback address");
  return { problems, pages: html.length };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dist = process.argv[2] ?? join(root, "dist");
  const { problems, pages } = checkSite(dist);
  for (const p of problems) console.log(`✗ ${p}`);
  console.log(problems.length ? `check: ${problems.length} problem(s) in ${pages} pages` : `check: ${pages} pages, links, anchors, assets, search index and downloads are fine`);
  process.exit(problems.length ? 1 : 0);
}
