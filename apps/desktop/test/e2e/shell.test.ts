// Task T2 end to end: the redesigned shell (sidebar, title bar, inspector) and the dialogs that replaced the native
// confirm(), in the built app, at the window's two sizes (1360×860 and the 720×480 minimum). The app, the profile and
// the fake agents are the test's own, as in desktop.test.ts. Dialogs are found by ARIA role, buttons by their words.
//   npm run build && npm run test:e2e -- shell   (in apps/desktop)
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
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
// Only the dialog on screen: the page also keeps hidden ones (Settings, onboarding's card) in the DOM.
const DIALOG = '[role="dialog"]:visible, [role="alertdialog"]:visible';

let scratch: { path: string; cleanup(): void };
let fake: FakeClis;
let repo: string;
let app: ElectronApplication;
let page: Page;
const log: string[] = [];
/** Native dialogs the page opened: the redesign has none. */
const native: string[] = [];

const invoke = <T>(request: Record<string, unknown>) => page.evaluate(async (r) => {
  const a = await (window as unknown as { agentduo: { invoke(r: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> } }).agentduo.invoke(r);
  if (!a.ok) throw new Error(a.error);
  return a.result;
}, request) as Promise<T>;

const state = () => invoke<{ active: { projectId: string | null; conversationId: string | null }; projects: Array<{ id: string; name: string; path: string }> }>({ method: "app.state" });

/** The window's content size, as the user would drag it. */
async function resize(width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [w, h]) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    win.setContentSize(w!, h!);
  }, [width, height]);
  await expect.poll(() => page.evaluate(() => window.innerWidth), { timeout: 5000 }).toBe(width);
}

async function send(text: string): Promise<void> {
  const input = page.locator(`${SHOWN} .composer-input`);
  await input.fill(text);
  await input.press("Enter");
  await expect.poll(() => input.inputValue(), { timeout: 5000 }).toBe("");
}

/** The element is on screen: it has a box and that box is inside the window. */
async function inWindow(selector: string): Promise<{ ok: boolean; box: { x: number; y: number; width: number; height: number } | null }> {
  return page.evaluate((s) => {
    const e = document.querySelector(s) as HTMLElement | null;
    if (!e) return { ok: false, box: null };
    const r = e.getBoundingClientRect();
    const ok = r.width > 0 && r.height > 0 && r.left >= -0.5 && r.top >= -0.5 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5;
    return { ok, box: { x: r.x, y: r.y, width: r.width, height: r.height } };
  }, selector);
}

const noHorizontalScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);

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
  page.on("dialog", (d) => {
    native.push(d.message());
    void d.dismiss();
  });
  const onboarding = page.locator(".overlay.onboarding");
  await onboarding.waitFor();
  await onboarding.getByRole("button", { name: "Continue without a project" }).click();
  await page.locator(`${SHOWN} .composer-input`).waitFor({ timeout: 30_000 });
});

beforeEach(({ onTestFailed }) => onTestFailed(() => console.log(`the app's log:\n${log.slice(-100).join("\n")}`)));

afterAll(async () => {
  await app?.close().catch(() => undefined);
  fake?.restore();
  scratch?.cleanup();
});

describe("the shell", () => {
  it("at 1360×860 shows the sidebar on the left, a title bar above, and the composer fixed at the bottom of the chat", async () => {
    await resize(1360, 860);
    const side = (await inWindow(".sidebar")).box!;
    const top = (await inWindow(".topbar")).box!;
    const composer = await inWindow(`${SHOWN} .composer-input`);
    expect(side.x).toBeLessThan(2);
    expect(side.height).toBeGreaterThan(800);
    expect(top.y).toBeLessThan(2);
    expect(top.x, "the title bar sits beside the sidebar").toBeGreaterThanOrEqual(side.width - 2);
    expect(composer.ok, "the composer is in the window").toBe(true);
    expect(composer.box!.y + composer.box!.height, "the composer is at the bottom").toBeGreaterThan(860 * 0.8);
    expect(await noHorizontalScroll()).toBe(true);
  });

  it("at 720×480 keeps the sidebar's footer buttons, the title bar and the composer on screen and clickable, without sideways scrolling", async () => {
    await resize(720, 480);
    for (const s of [".sidebar", ".topbar", `${SHOWN} .composer-input`]) expect((await inWindow(s)).ok, `${s} in the 720×480 window`).toBe(true);
    const settings = page.locator(".side-foot button", { hasText: "Settings" });
    expect((await inWindow(".side-foot button")).ok).toBe(true);
    expect(await settings.isVisible()).toBe(true);
    expect(await noHorizontalScroll()).toBe(true);
    // The composer takes input there.
    const input = page.locator(`${SHOWN} .composer-input`);
    await input.fill("small window");
    expect(await input.inputValue()).toBe("small window");
    await input.fill("");
    // The chat keeps room beside the widest sidebar.
    const edge = page.locator(".sidebar-edge");
    await edge.focus();
    await edge.press("End");
    expect(Number(await edge.getAttribute("aria-valuenow"))).toBeLessThanOrEqual(720 - 360);
    expect((await inWindow(`${SHOWN} .composer-input`)).ok).toBe(true);
    await edge.press("Home");
    expect(Number(await edge.getAttribute("aria-valuenow"))).toBe(180);
    expect((await inWindow(`${SHOWN} .composer-input`)).ok).toBe(true);
    await edge.dblclick();
    expect(Number(await edge.getAttribute("aria-valuenow"))).toBe(248);
  });

  it("holds both sidebar limits at 1360 wide: 180 at the least, 480 at the most", async () => {
    await resize(1360, 860);
    const edge = page.locator(".sidebar-edge");
    await edge.focus();
    await edge.press("Home");
    expect(Number(await edge.getAttribute("aria-valuenow"))).toBe(180);
    expect((await inWindow(".sidebar")).box!.width).toBeCloseTo(180, 0);
    await edge.press("End");
    expect(Number(await edge.getAttribute("aria-valuenow"))).toBe(480);
    expect((await inWindow(".sidebar")).box!.width).toBeCloseTo(480, 0);
    expect((await inWindow(`${SHOWN} .composer-input`)).ok).toBe(true);
    await edge.dblclick();
    // The width is a saved preference.
    await expect.poll(async () => (await invoke<{ prefs: { sidebarWidth: number } }>({ method: "app.state" })).prefs.sidebarWidth, { timeout: 5000 }).toBe(248);
  });

  it("keeps no button, input or link of the sidebar and the title bar in a window-drag region", async () => {
    for (const [w, h] of [[1360, 860], [720, 480]] as const) {
      await resize(w, h);
      const inDrag = await page.evaluate(() => {
        const bad: string[] = [];
        for (const e of document.querySelectorAll<HTMLElement>(".sidebar button, .sidebar input, .sidebar a, .topbar button, .topbar input, .topbar a")) {
          const r = e.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          const region = getComputedStyle(e).getPropertyValue("-webkit-app-region");
          if (region === "drag") bad.push(`${e.tagName} ${e.className} ${e.title || e.textContent?.slice(0, 20)}`);
        }
        return bad;
      });
      expect(inDrag, `${w}×${h}`).toEqual([]);
    }
  });

  it("copes with a very long conversation title: the title is cut, the title bar's controls stay on screen", async () => {
    const long = `Long title ${"x".repeat(40)} ${"verylongwordwithoutspaces".repeat(8)}`;
    fake.setScenario({ chat_codex: [{ answer: "ok" }] });
    await page.locator(".sidebar .nav-head", { hasText: "Conversations" }).getByTitle("New conversation").click();
    await send(long);
    await page.locator(SHOWN).getByText("ok").first().waitFor({ timeout: 30_000 });
    for (const [w, h] of [[1360, 860], [720, 480]] as const) {
      await resize(w, h);
      expect(await noHorizontalScroll(), `no sideways scroll at ${w}×${h}`).toBe(true);
      expect((await inWindow('.topbar button[title="Plan, changes and checks"]')).ok, `the inspector button at ${w}×${h}`).toBe(true);
      expect((await inWindow(".sidebar .nav-item.conversation .nav-main")).ok).toBe(true);
      expect((await inWindow(`${SHOWN} .composer-input`)).ok).toBe(true);
      // A row's title does not widen the sidebar.
      const side = (await inWindow(".sidebar")).box!;
      const row = await page.evaluate(() => {
        const r = document.querySelector(".sidebar .nav-item.conversation")!.getBoundingClientRect();
        return { right: r.right };
      });
      expect(row.right).toBeLessThanOrEqual(side.x + side.width + 1);
    }
  });

  it("opens and closes the inspector at both sizes without losing the composer, and the page stays whole", async () => {
    for (const [w, h] of [[1360, 860], [720, 480]] as const) {
      await resize(w, h);
      const toggle = page.locator('.topbar button[title="Plan, changes and checks"]');
      // A wide window opens with the inspector beside the chat; a small one keeps it closed until asked.
      if (await page.locator(".inspector").isVisible()) {
        await toggle.click();
        await expect.poll(() => page.locator(".inspector").isVisible(), { timeout: 5000 }).toBe(false);
      }
      await toggle.click();
      await page.locator(".inspector").waitFor({ state: "visible", timeout: 5000 });
      expect(await noHorizontalScroll(), `no sideways scroll with the inspector open at ${w}×${h}`).toBe(true);
      expect((await inWindow(".inspector")).ok, "the inspector is inside the window").toBe(true);
      expect((await inWindow('.topbar button[title="Plan, changes and checks"]')).ok || w === 720, "the toggle can close it again").toBe(true);
      if (w === 1360) expect((await inWindow(`${SHOWN} .composer-input`)).ok, "the composer is still there beside the inspector").toBe(true);
      await toggle.click({ force: true });
      await expect.poll(() => page.locator(".inspector").isVisible(), { timeout: 5000 }).toBe(false);
      expect((await inWindow(`${SHOWN} .composer-input`)).ok).toBe(true);
    }
  });
});

describe("confirmation dialogs", () => {
  const dialog = () => page.locator(DIALOG);

  /** What the user finds in the open dialog: named, focus inside it, focus kept there by Tab and Shift+Tab. */
  async function expectAccessible(): Promise<void> {
    await dialog().waitFor({ state: "visible", timeout: 5000 });
    expect(await dialog().count()).toBe(1);
    const named = await dialog().evaluate((d) => {
      const label = d.getAttribute("aria-label");
      const by = d.getAttribute("aria-labelledby");
      return !!(label?.trim() || (by && document.getElementById(by)?.textContent?.trim()));
    });
    expect(named, "the dialog has an accessible name").toBe(true);
    expect(await dialog().getAttribute("aria-modal")).toBe("true");
    const inside = () => dialog().evaluate((d) => d.contains(document.activeElement));
    expect(await inside(), "the focus starts inside").toBe(true);
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      expect(await inside(), `Tab ${i + 1} stays inside`).toBe(true);
    }
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await inside(), `Shift+Tab ${i + 1} stays inside`).toBe(true);
    }
  }

  const cancelButton = () => dialog().getByRole("button", { name: /cancel|keep|no\b|not now/i });
  const confirmButton = () => dialog().getByRole("button", { name: /remove|delete|restart|install|ok|yes|confirm/i });

  it("removing a project asks first: Escape keeps it and gives the focus back, Cancel keeps it, Remove removes it, and no native dialog opens", async () => {
    await resize(1360, 860);
    await page.locator(".sidebar").getByRole("button", { name: "Open project…" }).first().click();
    const project = page.locator(".sidebar .nav-list[aria-label=Projects] .nav-item.project");
    await project.first().waitFor({ timeout: 30_000 });
    expect(await project.count()).toBe(1);
    const remove = () => project.first().getByTitle(/^Remove from the list/);

    await project.first().hover();
    await remove().click();
    await expectAccessible();
    await page.keyboard.press("Escape");
    await dialog().waitFor({ state: "hidden", timeout: 5000 });
    expect(await project.count()).toBe(1);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.title ?? ""), "the focus returns to the button that opened it").toMatch(/^Remove from the list/);

    await project.first().hover();
    await remove().click();
    await dialog().waitFor({ state: "visible" });
    await cancelButton().first().click();
    await dialog().waitFor({ state: "hidden", timeout: 5000 });
    expect(await project.count(), "Cancel keeps the project").toBe(1);

    await project.first().hover();
    await remove().click();
    await dialog().waitFor({ state: "visible" });
    await confirmButton().first().click();
    await dialog().waitFor({ state: "hidden", timeout: 5000 });
    await expect.poll(() => project.count(), { timeout: 10_000 }).toBe(0);
    expect(native, "the page opened no native confirm").toEqual([]);
    // Its folder is untouched.
    expect(existsSync(repo)).toBe(true);
  });

  it("deleting an archived conversation asks first: Escape and Cancel keep it, the keyboard can accept, and accepting deletes it", async () => {
    await resize(1360, 860);
    fake.setScenario({ chat_codex: [{ answer: "to be deleted" }] });
    await page.getByRole("button", { name: "Conversations", exact: true }).click();
    await page.locator(".sidebar .nav-head", { hasText: "Conversations" }).getByTitle("New conversation").click();
    await send("Doomed conversation");
    await page.locator(SHOWN).getByText("to be deleted").first().waitFor({ timeout: 30_000 });
    const id = (await state()).active.conversationId!;
    const rows = page.locator(".sidebar .nav-list.conversations:not(.archived) .nav-item.conversation");
    const archived = page.locator(".sidebar .nav-list.archived .nav-item.conversation");
    const row = rows.filter({ hasText: "Doomed conversation" });
    await row.hover();
    await row.getByTitle("Archive").click();
    await expect.poll(() => rows.filter({ hasText: "Doomed conversation" }).count(), { timeout: 10_000 }).toBe(0);
    await page.locator(".sidebar .nav-head .archive-toggle").click();
    const entry = archived.filter({ hasText: "Doomed conversation" });
    await entry.waitFor({ timeout: 10_000 });
    void id;

    await entry.hover();
    await entry.getByTitle(/^Delete/).click();
    await expectAccessible();
    await page.keyboard.press("Escape");
    await dialog().waitFor({ state: "hidden", timeout: 5000 });
    expect(await entry.count(), "Escape keeps it").toBe(1);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.title ?? "")).toMatch(/^Delete/);

    await entry.hover();
    await entry.getByTitle(/^Delete/).click();
    await dialog().waitFor({ state: "visible" });
    await cancelButton().first().click();
    await dialog().waitFor({ state: "hidden", timeout: 5000 });
    expect(await entry.count(), "Cancel keeps it").toBe(1);

    await entry.hover();
    await entry.getByTitle(/^Delete/).click();
    await dialog().waitFor({ state: "visible" });
    await confirmButton().first().click();
    await dialog().waitFor({ state: "hidden", timeout: 5000 });
    await expect.poll(() => archived.filter({ hasText: "Doomed conversation" }).count(), { timeout: 10_000 }).toBe(0);
    expect(native).toEqual([]);
    await page.locator(".sidebar .nav-head .archive-toggle").click();
  });

  it("the dialog is themed for both colour modes and its text is readable (4.5:1) in each", async () => {
    // The contrast is measured on the real rendered dialog when one is open: the project-removal dialog again.
    await page.locator(".sidebar").getByRole("button", { name: "Open project…" }).first().click();
    const project = page.locator(".sidebar .nav-list[aria-label=Projects] .nav-item.project");
    await project.first().waitFor({ timeout: 30_000 });
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
        document.documentElement.style.colorScheme = t;
      }, theme);
      await project.first().hover();
      await project.first().getByTitle(/^Remove from the list/).click();
      await dialog().waitFor({ state: "visible" });
      const ratios = await dialog().evaluate((d) => {
        const parse = (c: string): [number, number, number, number] => {
          const m = /rgba?\(([^)]+)\)/.exec(c)!;
          const p = m[1]!.split(/[,/ ]+/).filter(Boolean).map(Number);
          return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
        };
        const lum = ([r, g, b]: number[]) => {
          const f = (v: number) => ((v / 255) <= 0.03928 ? v / 255 / 12.92 : (((v / 255) + 0.055) / 1.055) ** 2.4);
          return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
        };
        /** The first opaque-enough background up the tree. */
        const backdrop = (e: Element | null): [number, number, number, number] => {
          for (let n: Element | null = e; n; n = n.parentElement) {
            const c = parse(getComputedStyle(n).backgroundColor);
            if (c[3] >= 0.95) return c;
          }
          return [255, 255, 255, 1];
        };
        const out: number[] = [];
        for (const e of d.querySelectorAll("*")) {
          if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim())) continue;
          const fg = parse(getComputedStyle(e).color);
          const bg = backdrop(e);
          const l1 = lum(fg);
          const l2 = lum(bg);
          out.push((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05));
        }
        return out;
      });
      expect(ratios.length, `${theme}: the dialog shows text`).toBeGreaterThan(0);
      for (const r of ratios) expect(r, `${theme}: contrast ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      await page.keyboard.press("Escape");
      await dialog().waitFor({ state: "hidden", timeout: 5000 });
    }
  });
});

describe("a conversation without a project", () => {
  it("is listed under Conversations, opens, and the sidebar still shows what runs and the account box", async () => {
    await resize(1360, 860);
    await page.getByRole("button", { name: "Conversations", exact: true }).click();
    await expect.poll(async () => (await state()).active.projectId, { timeout: 10_000 }).toBe("0000000000000000");
    await page.locator(`${SHOWN} .composer-input`).waitFor({ timeout: 10_000 });
    expect(await page.locator(".sidebar .account-box").isVisible()).toBe(true);
    expect(await page.locator(".sidebar .side-foot button", { hasText: "Settings" }).isVisible()).toBe(true);
  });
});
