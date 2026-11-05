// Drives the built site in a real browser engine: the Electron and Playwright the desktop app already installs
// (apps/desktop/node_modules, `npm ci --prefix apps/desktop`), resolved from there, so the website adds no dependency
// and downloads no browser. Electron runs test/browser-main.cjs, a bare window with an isolated profile; the
// AgentDuo desktop app itself is never started.
//
//   node scripts/browser-check.mjs              run the checks (builds first if there is no dist/)
//   node scripts/browser-check.mjs --shots DIR  also save screenshots to DIR
//   node scripts/browser-check.mjs --only-shots DIR route…   only screenshots of the given routes
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startPreview } from "./preview.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const desktopRequire = createRequire(join(root, "..", "apps", "desktop", "package.json"));

function tools() {
  try {
    const { _electron } = desktopRequire("playwright");
    const electronPath = desktopRequire("electron");
    return { _electron, electronPath };
  } catch (e) {
    throw new Error(`Playwright and Electron come from apps/desktop: run npm ci --prefix apps/desktop (${e.message})`);
  }
}

const WIDTHS = [375, 768, 1440];
const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  ✗ ${name}\n      ${e.message.split("\n").join("\n      ")}`);
  }
};

async function launch(base) {
  const { _electron, electronPath } = tools();
  const profile = mkdtempSync(join(tmpdir(), "agentduo-site-browser-"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [join(root, "test", "browser-main.cjs"), `--user-data-dir=${profile}`, base],
    env,
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page, profile };
}

async function close({ app, profile }) {
  const proc = app.process();
  const exited = new Promise((done) => (proc.exitCode !== null ? done() : proc.once("exit", done)));
  await app.close().catch(() => {});
  await Promise.race([exited, new Promise((done) => setTimeout(done, 10_000))]);
  rmSync(profile, { recursive: true, force: true });
}

/** Horizontal overflow of the page: the document wider than the viewport. */
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function shots(page, base, dir, routes) {
  mkdirSync(dir, { recursive: true });
  for (const route of routes) {
    for (const width of WIDTHS) {
      for (const scheme of ["light", "dark"]) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
        await page.goto(base + route);
        const name = `${route.replace(/\W+/g, "_") || "_"}-${width}-${scheme}.png`;
        await page.screenshot({ path: join(dir, name), fullPage: process.env.SHOT_FULL !== "0" && (width !== 1440 || route === "/") });
      }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const onlyShots = args[0] === "--only-shots";
  const shotDir = onlyShots ? args[1] : args[0] === "--shots" ? args[1] : null;
  const dist = join(root, "dist");
  if (!existsSync(join(dist, "index.html"))) {
    const { build } = await import("./build.mjs");
    await build({ log: () => {} });
  }
  const server = await startPreview({ dir: dist, port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  let session;
  try {
    session = await launch(`${base}/`);
    const { page, app } = session;
    if (onlyShots) {
      await shots(page, base, shotDir, args.slice(2));
      return;
    }
    await runChecks({ page, app, base });
    if (shotDir) await shots(page, base, shotDir, ["/", "/download/", "/docs/configuration/", "/vi/learn/first-task/", "/search/?q=resume", "/does/not/exist/"]);
  } finally {
    if (session) await close(session);
    server.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nbrowser checks: ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) process.exitCode = 1;
}

async function runChecks({ page, app, base }) {
  const routes = ["/", "/about/", "/download/", "/releases/", "/faq/", "/learn/", "/learn/first-task/", "/docs/", "/docs/configuration/", "/docs/cli/",
    "/docs/config-reference/", "/troubleshooting/", "/search/", "/vi/", "/vi/download/", "/vi/docs/pipeline/", "/vi/learn/first-task/"];

  await check("no page-wide horizontal overflow at 375, 768 and 1440 px (light and dark)", async () => {
    const bad = [];
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of routes) {
        await page.goto(base + route);
        const extra = await overflow(page);
        if (extra > 0) bad.push(`${route} at ${width}px: ${extra}px wider`);
      }
    }
    assert.deepEqual(bad, []);
  });

  await check("light, dark and system themes; the choice persists across pages and reloads", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`${base}/docs/`);
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(await bg(), "rgb(11, 17, 24)", "system dark");
    await page.selectOption("#theme-select", "light");
    assert.equal(await bg(), "rgb(243, 245, 248)", "light chosen");
    await page.goto(`${base}/vi/docs/`);
    assert.equal(await page.inputValue("#theme-select"), "light");
    assert.equal(await bg(), "rgb(243, 245, 248)", "light kept on another page");
    await page.selectOption("#theme-select", "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await page.reload();
    assert.equal(await bg(), "rgb(11, 17, 24)", "dark kept after reload");
    await page.selectOption("#theme-select", "system");
    assert.equal(await bg(), "rgb(243, 245, 248)", "system follows the light system setting");
    await page.emulateMedia({ colorScheme: "dark" });
    assert.equal(await bg(), "rgb(11, 17, 24)", "system follows a change of the system setting");
    await page.emulateMedia({ colorScheme: "light" });
  });

  await check("search finds English words and unaccented Vietnamese, shows snippets, handles no results", async () => {
    await page.goto(`${base}/search/?q=resume`);
    await page.waitForSelector("[data-search-results] li");
    const first = await page.locator("[data-search-results] li a").first().getAttribute("href");
    assert.ok(first.startsWith("/"), first);
    assert.ok(await page.locator("[data-search-results] mark").count() > 0, "a match is marked");
    await page.goto(`${base}/vi/search/?q=dang%20nhap`);
    await page.waitForSelector("[data-search-results] li");
    const text = await page.locator("[data-search-results] mark").first().textContent();
    assert.match(text.toLowerCase(), /đăng|nhập/);
    await page.fill("#search-page-input", "zzqqxxnotaword");
    await page.waitForFunction(() => /zzqqxxnotaword/.test(document.querySelector("[data-search-status]").textContent));
    assert.equal(await page.locator("[data-search-results] li").count(), 0);
  });

  const shortcut = process.platform === "darwin" ? "Meta+k" : "Control+k";
  const dialogOpen = () => page.evaluate(() => document.querySelector("[data-search-dialog]").open);
  const options = () => page.locator("[data-search-options] [role=option]");

  await check("search dialog: Ctrl/⌘+K opens it, results come as you type, ↓ and Enter open one, and the search is remembered", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/docs/`);
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    assert.equal(await page.isVisible("#site-search"), false, "the button replaces the header's form");
    await page.keyboard.press(shortcut);
    assert.equal(await dialogOpen(), true);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "search-dialog-input");
    assert.equal(await options().count(), 0, "nothing is listed before the first search");
    await page.keyboard.type("gates");
    await page.waitForSelector("[data-search-options] [role=option] a");
    assert.ok((await options().count()) <= 8, "at most 8 results");
    assert.equal(await options().first().getAttribute("aria-selected"), "true", "the first result is active");
    assert.equal(await page.getAttribute("[data-search-all]", "href"), "/search/?q=gates");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.getAttribute("#search-dialog-input", "aria-activedescendant"), await options().nth(1).getAttribute("id"));
    const href = await options().nth(1).locator("a").getAttribute("href");
    await Promise.all([page.waitForURL(new URL(href, base).href), page.keyboard.press("Enter")]);
    assert.equal(await dialogOpen(), false);
    await page.goto(`${base}/docs/`);
    await page.keyboard.press(shortcut);
    assert.equal(await options().first().textContent(), "gates", "the search is in the recent list");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    assert.equal(await page.inputValue("#search-dialog-input"), "gates", "a recent search fills the box");
    await page.fill("#search-dialog-input", "");
    await page.click("[data-search-recent-clear]");
    assert.equal(await options().count(), 0, "Clear empties the recent list");
    await page.keyboard.press("Escape");
  });

  await check("search dialog: the header button opens it, Esc closes it and gives focus back, and the page under it does not move; a linked heading lands below the header", async () => {
    // Without smooth scrolling a scroll happens at once, so reading scrollY after each key sees it.
    await page.emulateMedia({ reducedMotion: "reduce" });
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${base}/docs/config-reference/`);
      await page.evaluate(() => window.scrollTo(0, 2500));
      const y = () => page.evaluate(() => Math.round(window.scrollY));
      await page.click(".header-tools [data-search-open]");
      assert.equal(await dialogOpen(), true);
      for (const key of "gates") {
        await page.keyboard.type(key);
        assert.equal(await y(), 2500, `scrolled after typing "${key}"`);
      }
      await page.waitForSelector("[data-search-options] [role=option] a");
      for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowDown");
      assert.equal(await y(), 2500, "moving through the results scrolled the page");
      await page.keyboard.press("Escape");
      assert.equal(await dialogOpen(), false);
      assert.equal(await page.evaluate(() => document.activeElement?.matches(".header-tools [data-search-open]")), true, "focus is back on the button");
      assert.equal(await y(), 2500);
      await page.keyboard.press(shortcut);
      await page.mouse.click(30, 860);
      assert.equal(await dialogOpen(), false, "a click outside closes it");
      await page.goto(`${base}/docs/config-reference/#quality-gates`);
      const below = (sel) => page.evaluate((s) => document.querySelector(s).getBoundingClientRect().top - document.querySelector(".site-header").getBoundingClientRect().bottom, sel);
      const gap = await below("#quality-gates");
      assert.ok(gap >= 0, `the heading is ${-gap}px under the header`);
      // Typing in the search page's own box brings it into view below the header, not under it.
      await page.goto(`${base}/search/?q=config`);
      await page.waitForSelector("[data-search-results] li");
      await page.focus("#search-page-input");
      await page.evaluate(() => window.scrollTo(0, 1200));
      await page.keyboard.type("s");
      assert.ok((await below("#search-page-input")) >= 0, "the search page's box is under the header");
    } finally {
      await page.emulateMedia({ reducedMotion: null });
    }
  });

  await check("search dialog on a phone: the menu's search button opens it, unaccented Vietnamese finds accented words, Cancel gives focus to the menu button", async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    try {
      await page.goto(`${base}/vi/`);
      await page.click(".mobile-menu summary");
      await page.click(".mobile-menu-panel [data-search-open]");
      assert.equal(await dialogOpen(), true);
      assert.equal(await page.evaluate(() => document.querySelector("[data-mobile-menu]").open), false, "the menu closes behind the dialog");
      await page.keyboard.type("dang nhap");
      await page.waitForSelector("[data-search-options] mark");
      assert.match((await page.locator("[data-search-options] mark").first().textContent()).toLowerCase(), /đăng|nhập/);
      const all = await page.locator("[data-search-all]").boundingBox();
      assert.ok(all && all.y + all.height <= 800, "the footer's link is on screen");
      await page.click("[data-search-close]");
      assert.equal(await dialogOpen(), false);
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), "SUMMARY");
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  await check("copy buttons put the code on the clipboard", async () => {
    await page.goto(`${base}/learn/cli/`);
    const block = page.locator(".code").first();
    const expected = await block.locator("pre code").textContent();
    await block.locator(".copy-button").click();
    await page.waitForFunction(() => document.querySelector(".copy-button").textContent !== document.body.dataset.copy);
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
    assert.equal(clip, expected);
  });

  await check("mobile menu opens, closes with Escape and returns focus; links work", async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`${base}/`);
    assert.equal(await page.isVisible(".primary-nav"), false);
    await page.locator(".mobile-menu summary").focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.querySelector("[data-mobile-menu]").open), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => document.querySelector("[data-mobile-menu]").open), false);
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "SUMMARY");
    await page.locator(".mobile-menu summary").click();
    await Promise.all([page.waitForURL(/\/docs\/$/), page.locator(".mobile-nav-list a", { hasText: "Docs" }).click()]);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await check("language switch goes to the same page in the other language", async () => {
    await page.goto(`${base}/docs/pipeline/`);
    await Promise.all([page.waitForURL(/\/vi\/docs\/pipeline\/$/), page.locator(".header-tools .lang-link").click()]);
    assert.equal(await page.getAttribute("html", "lang"), "vi");
    await Promise.all([page.waitForURL(/\/docs\/pipeline\/$/), page.locator(".header-tools .lang-link").click()]);
    assert.equal(await page.getAttribute("html", "lang"), "en");
  });

  await check("keyboard: skip link first, focus is visible, Tab reaches the main content", async () => {
    await page.goto(`${base}/docs/cli/`);
    // Earlier checks leave the window's focus elsewhere (a menu, the clipboard); start from a focused, fresh page.
    await page.bringToFront();
    await page.evaluate(() => {
      window.focus();
      document.activeElement?.blur?.();
    });
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.className), "skip-link");
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
    assert.notEqual(outline, "none");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    assert.ok(await page.evaluate(() => !!document.activeElement?.closest("#main")), "focus moved into main");
  });

  await check("long code and tables scroll inside their own box on a phone", async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`${base}/docs/config-reference/`);
    const wide = await page.evaluate(() => [...document.querySelectorAll(".table-wrap, .code pre")].some((el) => el.scrollWidth > el.clientWidth));
    assert.ok(wide, "at least one table or code block is wider than its box");
    assert.equal(await overflow(page), 0);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await check("a deep missing path answers 404 with a working page in its language", async () => {
    const res = await page.goto(`${base}/no/such/page/at/all/`);
    assert.equal(res.status(), 404);
    assert.equal(await page.isVisible(".site-header .brand"), true);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).fontFamily.length > 0 && !!document.styleSheets.length), true);
    const vi = await page.goto(`${base}/vi/khong/co/trang/nay/`);
    assert.equal(vi.status(), 404);
    assert.equal(await page.getAttribute("html", "lang"), "vi");
  });

  await check("download page suggests an OS, can show all, and keeps real links", async () => {
    await page.goto(`${base}/download/`);
    assert.equal(await page.isVisible("[data-os-picker]"), true);
    await page.click('button[data-os="all"]');
    const visible = await page.locator("[data-os-panel]:visible").count();
    assert.equal(visible, 3);
    await page.click('button[data-os="linux"]');
    assert.equal(await page.locator("[data-os-panel]:visible").count(), 1);
    const hrefs = await page.locator(".installer a").evaluateAll((as) => as.map((a) => a.href));
    assert.ok(hrefs.length >= 5 && hrefs.every((h) => h.startsWith("https://github.com/HaiTrieu247/agentduo/releases/download/")), hrefs.join(" "));
  });

  await check("reduced motion turns off smooth scrolling", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${base}/docs/`);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), "auto");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto(`${base}/docs/`);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), "smooth");
  });

  await check("the workflow figure's dot runs the pipeline in order, pauses, and keeps still with reduced motion", async () => {
    const cycle = ["1", "2", "back", "1", "2", "3", "handoff", "4", "5", "6", "back", "4", "5", "6", "done"];
    // What the dot lights, in order: a step by its number, else the way back, the handoff or the done line.
    const record = () =>
      page.evaluate(() => {
        const fig = document.querySelector(".flow");
        const steps = [...fig.querySelectorAll(".flow-step")];
        const name = (el) => (steps.includes(el) ? String(steps.indexOf(el) + 1) : el.className.split(" ")[0].replace("flow-", ""));
        window.__flowLit = [];
        new MutationObserver((records) => {
          for (const r of records) if (r.target.classList.contains("is-active")) window.__flowLit.push(name(r.target));
        }).observe(fig, { subtree: true, attributes: true, attributeFilter: ["class"] });
      });
    const lit = () => page.evaluate(() => window.__flowLit);
    const inOrder = (seen) => ` ${[...cycle, ...cycle].join(" ")} `.includes(` ${seen.join(" ")} `);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    for (const [width, count] of [[375, 4], [1440, 8]]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${base}/`);
      await record();
      await page.waitForFunction((n) => window.__flowLit.length >= n, count, { timeout: 20_000 });
      const seen = await lit();
      assert.ok(inOrder(seen), `${width}px lit ${seen.join(" ")}`);
    }

    const button = page.locator(".flow .flow-motion");
    assert.equal(await button.getAttribute("aria-label"), "Pause the animation");
    await button.click();
    assert.equal(await button.getAttribute("aria-label"), "Play the animation");
    const token = page.locator(".flow .flow-token");
    const seen = (await lit()).length;
    const at = await token.evaluate((t) => t.style.transform);
    await page.waitForTimeout(2500);
    assert.equal((await lit()).length, seen, "nothing lights while paused");
    assert.equal(await token.evaluate((t) => t.style.transform), at, "the dot stays where it was");
    await page.reload();
    assert.equal(await button.getAttribute("aria-label"), "Play the animation", "the pause is remembered");
    await button.click();
    assert.equal(await page.evaluate(() => localStorage.getItem("agentduo-flow-motion")), null);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${base}/`);
    await page.waitForTimeout(1800);
    assert.equal(await page.locator(".flow-motion:visible, .flow-token:visible").count(), 0, "no dot or button");
    assert.equal(await page.locator(".flow .is-active").count(), 0, "no step lit");
    await page.emulateMedia({ reducedMotion: null });
  });

  await check("with JavaScript off: content, downloads and navigation work, and no dead controls show", async () => {
    const opened = app.waitForEvent("window");
    await app.evaluate(({ BrowserWindow }, url) => {
      const w = new BrowserWindow({ width: 1200, height: 900, show: false, webPreferences: { javascript: false, contextIsolation: true, sandbox: true } });
      w.loadURL(url);
    }, `${base}/download/`);
    const nojs = await opened;
    await nojs.waitForLoadState("domcontentloaded");
    assert.equal(await nojs.locator("[data-os-panel]:visible").count(), 3, "every system shows");
    assert.equal(await nojs.locator(".installer a").count() >= 5, true);
    assert.equal(await nojs.isVisible("[data-theme-control]"), false, "no theme control");
    assert.equal(await nojs.locator(".copy-button").count(), 0, "no copy buttons");
    assert.equal(await nojs.isVisible("[data-os-picker]"), false, "no OS picker");
    assert.equal(await nojs.isVisible(".header-tools .search-input"), true, "the header's search is a form");
    assert.equal(await nojs.locator("[data-search-open]:visible").count(), 0, "no search button");
    await nojs.goto(`${base}/search/?q=gates`);
    assert.ok((await nojs.textContent("main")).includes("JavaScript"), "search explains it needs JavaScript");
    assert.ok(await nojs.locator("main a[href='/docs/pipeline/']").count() > 0, "search lists pages to browse");
    await nojs.goto(`${base}/`);
    assert.equal(await nojs.locator(".flow-motion, .flow-token").count(), 0, "the workflow figure stays still, with no button");
    await nojs.setViewportSize({ width: 375, height: 800 });
    await nojs.goto(`${base}/docs/`);
    await nojs.locator(".mobile-menu summary").click();
    assert.equal(await nojs.isVisible(".mobile-nav-list"), true, "the menu opens without JavaScript");
    await nojs.close();
  });
}

main().catch((e) => {
  console.error(`browser-check: ${e.stack ?? e.message}`);
  process.exit(1);
});
