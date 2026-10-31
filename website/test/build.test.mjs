// The build as a whole: with and without a public origin, what the SEO files say, that no preview or loopback origin
// leaks into a page, that a missing path deep down still gets a working 404 page, and that the result passes the
// same output check as `npm run check`.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { build } from "../scripts/build.mjs";
import { checkSite } from "../scripts/check.mjs";
import { OriginError, resolveOrigin } from "../lib/urls.mjs";

const temps = [];
const out = () => {
  const dir = mkdtempSync(join(tmpdir(), "agentduo-site-"));
  temps.push(dir);
  return join(dir, "dist");
};
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

let plain, withOrigin;
before(async () => {
  plain = await build({ outDir: out(), env: {}, log: () => {} });
  withOrigin = await build({ outDir: out(), env: { SITE_URL: "https://agentduo.example/", DEPLOY_PRIME_URL: "https://deploy-preview-1--x.netlify.app" }, log: () => {} });
});
const read = (b, rel) => readFileSync(join(b.outDir, rel), "utf8");

test("the origin comes from SITE_URL, then Netlify's URL, never DEPLOY_PRIME_URL", () => {
  assert.deepEqual(resolveOrigin({ SITE_URL: "https://a.example", URL: "https://b.example" }), { origin: "https://a.example", source: "SITE_URL" });
  assert.deepEqual(resolveOrigin({ URL: "https://b.netlify.app" }), { origin: "https://b.netlify.app", source: "URL" });
  assert.deepEqual(resolveOrigin({ DEPLOY_PRIME_URL: "https://c.netlify.app" }), { origin: null, source: null });
  for (const bad of ["https://a.example/docs", "http://localhost:4173", "https://127.0.0.1", "https://u:p@a.example", "ftp://a.example", "https://a.example/?q=1", "not a url"]) {
    assert.throws(() => resolveOrigin({ SITE_URL: bad }), OriginError, bad);
  }
});

test("without an origin: no absolute SEO URLs, no sitemap, robots without Sitemap, and a warning", () => {
  assert.match(plain.warnings.join("\n"), /no public origin: set SITE_URL/);
  assert.equal(existsSync(join(plain.outDir, "sitemap.xml")), false);
  assert.doesNotMatch(read(plain, "robots.txt"), /Sitemap/);
  const home = read(plain, "index.html");
  assert.doesNotMatch(home, /rel="canonical"|property="og:url"|hreflang="x-default"|property="og:image"/);
});

test("with an origin: canonical, alternates and the sitemap use it, and only it", () => {
  const page = read(withOrigin, "docs/cli/index.html");
  assert.match(page, /<link rel="canonical" href="https:\/\/agentduo\.example\/docs\/cli\/">/);
  assert.match(page, /hreflang="vi" href="https:\/\/agentduo\.example\/vi\/docs\/cli\/"/);
  assert.match(read(withOrigin, "vi/docs/cli/index.html"), /<link rel="canonical" href="https:\/\/agentduo\.example\/vi\/docs\/cli\/">/);
  const sitemap = read(withOrigin, "sitemap.xml");
  assert.match(sitemap, /<loc>https:\/\/agentduo\.example\/vi\/download\/<\/loc>/);
  assert.doesNotMatch(sitemap, /search\/|404|netlify\.app/);
  assert.match(read(withOrigin, "robots.txt"), /Sitemap: https:\/\/agentduo\.example\/sitemap\.xml/);
  for (const b of [plain, withOrigin]) for (const f of b.files) assert.doesNotMatch(read(b, f), /deploy-preview|netlify\.app/, f);
});

test("every page exists in both languages with the right lang", () => {
  const en = plain.files.filter((f) => !f.startsWith("vi/"));
  const vi = plain.files.filter((f) => f.startsWith("vi/"));
  assert.equal(en.length, vi.length);
  for (const f of en) {
    assert.ok(vi.includes(`vi/${f}`), `vi/${f}`);
    assert.match(read(plain, f), /<html lang="en">/, f);
    assert.match(read(plain, `vi/${f}`), /<html lang="vi">/, `vi/${f}`);
  }
});

test("404 pages use root-relative assets and links only, so they work at any depth", () => {
  for (const f of ["404.html", "vi/404.html"]) {
    const page = read(plain, f);
    assert.match(page, /href="\/assets\/styles\.css/);
    assert.doesNotMatch(page, /(?:href|src)="(?!\/|https:|#|mailto:)/, f);
  }
  assert.match(read(plain, "_redirects"), /^\/vi\/\*\s+\/vi\/404\.html\s+404$/m);
  assert.doesNotMatch(read(plain, "_redirects"), /\s200!?\s*$/m);
});

test("the built site passes the output check", () => {
  for (const b of [plain, withOrigin]) {
    const { problems, pages } = checkSite(b.outDir);
    assert.deepEqual(problems, []);
    assert.ok(pages >= 60);
  }
});
