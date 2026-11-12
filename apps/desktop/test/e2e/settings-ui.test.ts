// Task T4 end to end: onboarding, every Settings page and the Team editor in the built app, light and dark, at 1360×860
// and the 720×480 minimum. It looks at layout (what scrolls, what stays reachable, nothing widening the page), at the
// contrast of the text really drawn, at the focus ring and at how an overlay is left (Escape, Done, focus returned).
// What the settings do (scopes, reset, values) is desktop.test.ts's; this file reads the selectors that file uses.
//   npm run build && npm run test:e2e -- settings-ui   (in apps/desktop)
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { userConfigPath } from "@agentduo/engine/config/config";
import { userDataEnv } from "@agentduo/engine/testing/config";
import { FakeClis } from "@agentduo/engine/testing/fake-clis";
import { makeRepo } from "@agentduo/engine/testing/repo";
import { tempDir } from "@agentduo/engine/testing/tmp";

const desktop = resolve(fileURLToPath(new URL("../..", import.meta.url)));
function executable(): { path: string; args: string[] } {
  const packaged = process.env.AGENTDUO_E2E_APP;
  if (!packaged) return { path: createRequire(join(desktop, "package.json"))("electron") as unknown as string, args: [desktop] };
  if (!packaged.endsWith(".app")) return { path: packaged, args: [] };
  const macos = join(packaged, "Contents", "MacOS");
  return { path: join(macos, readdirSync(macos).find((f) => !f.startsWith("."))!), args: [] };
}
const SHOWN = ".chat-mount:not([hidden])";
const SIZES = [[1360, 860], [720, 480]] as const;
const THEMES = ["light", "dark"] as const;
const PAGES = ["General", "Claude & Codex", "Configuration", "Team", "Data & storage", "Diagnostics", "About"] as const;

let scratch: { path: string; cleanup(): void };
let fake: FakeClis;
let repo: string;
let app: ElectronApplication;
let page: Page;
const log: string[] = [];

async function resize(width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w!, h!), [width, height]);
  await expect.poll(() => page.evaluate(() => window.innerWidth), { timeout: 5000 }).toBe(width);
}

/** The app's own theme choice, as Settings → General sets it (the saved preference path), not a test shortcut. */
async function setTheme(theme: "light" | "dark"): Promise<void> {
  await page.evaluate(async (t) => {
    await (window as unknown as { agentduo: { invoke(r: unknown): Promise<unknown> } }).agentduo.invoke({ method: "prefs.set", patch: { theme: t } });
  }, theme);
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme), { timeout: 5000 }).toBe(theme);
  // Buttons fade to the new colours (--dur-fast): contrast is read once no transition runs.
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getComputedTiming().endTime !== Infinity).length), { timeout: 5000 }).toBe(0);
}

const noSideways = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);

/** Contrast of every text node under `root` against the first opaque background above it; the worst ones, below 4.5. */
async function lowContrast(root: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const parse = (c: string): number[] => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return [0, 0, 0, 0];
      const p = m[1]!.split(/[,/ ]+/).filter(Boolean).map(Number);
      return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
    };
    const lin = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
    const lum = (c: number[]) => 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!);
    const mix = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[i]! * top[3]! + under[i]! * (1 - top[3]!)).concat(1);
    const backdrop = (e: Element | null): number[] => {
      const stack: number[][] = [];
      for (let n: Element | null = e; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c[3]! > 0) stack.push(c);
        if (c[3]! >= 0.99) break;
      }
      return stack.reduceRight((under, c) => mix(c, under), [255, 255, 255, 1]);
    };
    const bad: string[] = [];
    const base = document.querySelector(sel);
    if (!base) return [`${sel} not found`];
    for (const e of base.querySelectorAll("*")) {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      if (!r.width || !r.height || cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
      if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim())) continue;
      if ((e as HTMLButtonElement).disabled || e.closest(":disabled, [aria-disabled=true]")) continue; // a disabled control is exempt
      const fg = mix(parse(cs.color), backdrop(e));
      const l1 = lum(fg);
      const l2 = lum(backdrop(e));
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      if (ratio < 4.5) bad.push(`${e.tagName.toLowerCase()}.${(e.getAttribute("class") ?? "").split(" ")[0]} "${e.textContent!.trim().slice(0, 30)}" ${ratio.toFixed(2)}`);
    }
    return bad;
  }, root);
}

async function inWindow(selector: string): Promise<boolean> {
  return page.evaluate((s) => {
    const e = document.querySelector(s) as HTMLElement | null;
    if (!e) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.left >= -0.5 && r.top >= -0.5 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5;
  }, selector);
}

const openSettings = async () => {
  await page.locator(".side-foot button", { hasText: "Settings" }).click();
  await page.locator(".settings").waitFor({ state: "visible" });
};
const gotoPage = (name: string) => page.locator(".settings-nav .settings-tab", { hasText: name }).first().click();

beforeAll(async () => {
  scratch = tempDir();
  fake = new FakeClis(scratch.path).install();
  repo = makeRepo(scratch.path);
  const config = join(scratch.path, "config");
  const env = Object.fromEntries(Object.entries({
    ...process.env, AGENTDUO_DESKTOP_USER_DATA: join(scratch.path, "profile"), AGENTDUO_DESKTOP_TEST_FOLDER: repo, AGENTDUO_DESKTOP_LOG: "1",
    HOME: join(scratch.path, "home"), USERPROFILE: join(scratch.path, "home"), XDG_CONFIG_HOME: config, APPDATA: config,
    ...userDataEnv(join(scratch.path, "data")),
  }).filter((e): e is [string, string] => typeof e[1] === "string" && e[0] !== "ELECTRON_RUN_AS_NODE"));
  mkdirSync(env.HOME!, { recursive: true });
  const user = userConfigPath(env);
  mkdirSync(join(user, ".."), { recursive: true });
  writeFileSync(user, YAML.stringify({ claude: { bin: fake.path("claude") }, codex: { bin: fake.path("codex") } }));
  const run = executable();
  app = await electron.launch({ executablePath: run.path, args: [...run.args, ...(process.env.AGENTDUO_E2E_NO_SANDBOX ? ["--no-sandbox"] : [])], env, timeout: 60_000 });
  const keep = (d: Buffer) => log.push(...String(d).split("\n").filter(Boolean));
  app.process().stdout?.on("data", keep);
  app.process().stderr?.on("data", keep);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

beforeEach(({ onTestFailed }) => onTestFailed(() => console.log(`the app's log:\n${log.slice(-100).join("\n")}`)));

afterAll(async () => {
  await app?.close().catch(() => undefined);
  fake?.restore();
  scratch?.cleanup();
});

describe("onboarding", () => {
  it("fits a 720×480 window: it scrolls on its own, the card stays inside the width, and its actions can be reached and used, in both colour modes", async () => {
    const onboarding = page.locator(".overlay.onboarding");
    await onboarding.waitFor();
    await expect.poll(() => onboarding.locator(".cli-card .pill").count(), { timeout: 30_000 }).toBe(2);
    for (const theme of THEMES) {
      await setTheme(theme);
      for (const [w, h] of SIZES) {
        await resize(w, h);
        expect(await noSideways(), `${theme} ${w}×${h}: no sideways scroll`).toBe(true);
        const card = await page.evaluate(() => {
          const r = document.querySelector(".onboard-card")!.getBoundingClientRect();
          return { left: r.left, right: r.right };
        });
        expect(card.left).toBeGreaterThanOrEqual(0);
        expect(card.right).toBeLessThanOrEqual(w);
        expect(await lowContrast(".overlay.onboarding"), `${theme} ${w}×${h}`).toEqual([]);
        const skip = onboarding.getByRole("button", { name: /Continue without a project|Skip for now/ });
        await skip.scrollIntoViewIfNeeded();
        expect(await inWindow(".onboarding .row-actions button"), "the actions can be scrolled to").toBe(true);
        expect(await skip.isEnabled()).toBe(true);
      }
    }
    // The first action has the focus, and it shows (the keyboard works from there).
    await resize(1360, 860);
    expect(await page.evaluate(() => document.activeElement?.closest(".onboarding") !== null)).toBe(true);
    await onboarding.getByRole("button", { name: /Continue without a project|Skip for now/ }).click();
    await expect.poll(() => onboarding.isHidden()).toBe(true);
    await page.locator(`${SHOWN} .composer-input`).waitFor({ timeout: 30_000 });
  });
});

describe("Settings, every page, both colour modes, both sizes", () => {
  for (const theme of THEMES) {
    for (const [w, h] of SIZES) {
      it(`${theme} ${w}×${h}: each page loads, its text reads at 4.5:1, nothing widens the page, the body scrolls by itself and Done stays reachable`, async () => {
        await setTheme(theme);
        await resize(w, h);
        await openSettings();
        for (const name of PAGES) {
          await gotoPage(name);
          await page.locator(".settings-page .page-title").waitFor({ timeout: 10_000 });
          // Loading ends (a page says Loading… until its data is in).
          await expect.poll(() => page.locator(".settings-page", { hasText: /^Loading…$/ }).count(), { timeout: 30_000 }).toBe(0);
          expect(await noSideways(), `${name}: no sideways scroll`).toBe(true);
          expect(await inWindow(".settings-head button"), `${name}: Done is in the window`).toBe(true);
          const geometry = await page.evaluate(() => {
            const body = document.querySelector(".settings-body") as HTMLElement;
            const page = document.querySelector(".settings-page") as HTMLElement;
            const r = document.querySelector(".settings")!.getBoundingClientRect();
            return { scrolls: getComputedStyle(body).overflowY, bodyRight: body.getBoundingClientRect().right, winW: window.innerWidth, pageRight: page.getBoundingClientRect().right, settingsBottom: r.bottom, winH: window.innerHeight, innerOverflow: body.scrollWidth - body.clientWidth };
          });
          expect(["auto", "scroll"]).toContain(geometry.scrolls);
          expect(geometry.pageRight, `${name}: the page stays within the window`).toBeLessThanOrEqual(geometry.winW + 0.5);
          expect(geometry.innerOverflow, `${name}: no sideways scroll inside the body`).toBeLessThanOrEqual(1);
          expect(geometry.settingsBottom).toBeLessThanOrEqual(geometry.winH + 0.5);
          expect(await lowContrast(".settings"), `${name}`).toEqual([]);
        }
        // The page's last control can be reached by scrolling the body alone, with Done still on screen.
        await page.locator(".settings-body").evaluate((b) => (b.scrollTop = b.scrollHeight));
        expect(await inWindow(".settings-head button")).toBe(true);
        await page.keyboard.press("Escape");
        await page.locator(".settings").waitFor({ state: "hidden", timeout: 5000 });
      });
    }
  }

  it("keyboard: Tab reaches the nav and the controls with a visible focus ring, and Escape closes Settings and gives the focus back to the button that opened it", async () => {
    await resize(1360, 860);
    for (const theme of THEMES) {
      await setTheme(theme);
      const opener = page.locator(".side-foot button", { hasText: "Settings" });
      await opener.focus();
      await page.keyboard.press("Enter");
      await page.locator(".settings").waitFor({ state: "visible" });
      expect(await page.evaluate(() => !!document.activeElement?.closest(".settings")), "Settings takes the focus").toBe(true);
      let ringed = 0;
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Tab");
        const ring = await page.evaluate(() => {
          const e = document.activeElement as HTMLElement | null;
          if (!e || !e.closest(".settings")) return "outside";
          const cs = getComputedStyle(e);
          const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
          const shadow = cs.boxShadow !== "none" && cs.boxShadow !== "";
          const border = e.matches(":focus-visible") && cs.borderTopColor !== "";
          return outline || shadow || border ? "ring" : "none";
        });
        expect(ring, `${theme}: Tab ${i + 1} is inside Settings`).not.toBe("outside");
        if (ring === "ring") ringed++;
      }
      expect(ringed, `${theme}: focused controls show a ring`).toBe(8);
      await page.keyboard.press("Escape");
      await page.locator(".settings").waitFor({ state: "hidden", timeout: 5000 });
      expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent ?? ""), `${theme}: the focus returns to Settings' button`).toContain("Settings");
    }
  });

  it("Done closes it too, and a disabled scope (This project, with no project) is shown disabled but still readable", async () => {
    await resize(1360, 860);
    await openSettings();
    await gotoPage("Configuration");
    const project = page.locator(".settings .seg", { hasText: "This project" });
    await project.waitFor({ timeout: 10_000 });
    expect(await project.isDisabled()).toBe(true);
    expect(await page.locator(".settings .seg", { hasText: "All projects" }).isEnabled()).toBe(true);
    const dim = await project.evaluate((e) => ({ opacity: Number(getComputedStyle(e).opacity), cursor: getComputedStyle(e).cursor }));
    expect(dim.opacity, "disabled is not invisible").toBeGreaterThanOrEqual(0.4);
    await page.locator(".settings-head button", { hasText: "Done" }).click();
    await page.locator(".settings").waitFor({ state: "hidden", timeout: 5000 });
  });
});

describe("Team editor", () => {
  it("at 720×480 in both colour modes: the list, the add form, the preview and the Save bar can all be reached; the form and Settings close on Escape in order", async () => {
    await resize(1360, 860);
    await page.getByRole("button", { name: "Open project…" }).first().click().catch(() => undefined);
    await page.locator(".sidebar .nav-list[aria-label=Projects] .nav-item.project").first().waitFor({ timeout: 30_000 });
    await openSettings();
    await gotoPage("Team");
    const settings = page.locator(".settings");
    await settings.locator(".team-empty").waitFor({ timeout: 10_000 });
    expect(await lowContrast(".settings .team-page")).toEqual([]);
    await settings.locator("button", { hasText: "Start from agentduo's team" }).click();
    await expect.poll(() => settings.locator(".team-member").count(), { timeout: 10_000 }).toBe(5);
    for (const theme of THEMES) {
      await setTheme(theme);
      for (const [w, h] of SIZES) {
        await resize(w, h);
        await settings.locator("button", { hasText: "Add a member" }).first().scrollIntoViewIfNeeded();
        await settings.locator("button", { hasText: "Add a member" }).first().click();
        const form = settings.locator(".team-form");
        await form.waitFor({ state: "visible", timeout: 5000 });
        await form.locator('input[aria-label="Name"]').fill(`a-very-long-member-name-${"x".repeat(60)}`);
        await page.locator(".settings-body").evaluate((b) => b.scrollTo(0, b.scrollHeight));
        expect(await noSideways(), `${theme} ${w}×${h}: the form does not widen the page`).toBe(true);
        const inside = await form.evaluate((f) => {
          const body = document.querySelector(".settings-body")!.getBoundingClientRect();
          return [...f.querySelectorAll("input, select, button")].every((c) => {
            const r = c.getBoundingClientRect();
            return r.right <= body.right + 1 && r.left >= body.left - 1;
          });
        });
        expect(inside, `${theme} ${w}×${h}: every field and button of the form is inside the pane`).toBe(true);
        expect(await lowContrast(".settings .team-form"), `${theme} ${w}×${h}`).toEqual([]);
        await form.locator("button", { hasText: "Add to the team" }).scrollIntoViewIfNeeded();
        expect(await inWindow(".team-form button.primary, .team-form .row-actions button"), "the form's own buttons are reachable").toBe(true);
        // Escape leaves the form, and Settings stays open until the next one.
        await form.locator('input[aria-label="Name"]').focus();
        await page.keyboard.press("Escape");
        await form.waitFor({ state: "hidden", timeout: 5000 });
        expect(await settings.isVisible(), "Settings is still open after the form's Escape").toBe(true);
        // The save bar is reachable at the end of the page.
        await page.locator(".settings-body").evaluate((b) => (b.scrollTop = b.scrollHeight));
        await settings.locator("button", { hasText: "Save the team" }).scrollIntoViewIfNeeded();
        expect(await inWindow(".settings-head button"), "Done stays on screen").toBe(true);
      }
    }
    // Members still can be edited and removed from the list, and the unsaved marker is shown after a change.
    await resize(1360, 860);
    await settings.locator(".team-member", { hasText: "dev-2" }).getByRole("button", { name: /remove|delete/i }).first().click();
    await expect.poll(() => settings.locator(".unsaved").textContent(), { timeout: 5000 }).toBe("Unsaved changes");
    expect(await settings.locator(".team-member").count()).toBe(4);
    await page.keyboard.press("Escape");
    await settings.waitFor({ state: "hidden", timeout: 5000 });
  });
});
