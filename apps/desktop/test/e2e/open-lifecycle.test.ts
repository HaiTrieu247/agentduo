// "Mở" in the whole app (design section 8): the built app (main, preload, renderer, the engine worker), an agent's
// answer with a link to a Markdown file outside any project, the document edited in place, and then quitting and
// closing the window with those edits unsaved. Each asks first; Keep editing and a save that fails stay; each close
// asks anew; only Save writes the file.
//   npm run build && npm run test:e2e -- open-lifecycle   (in apps/desktop)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { userConfigPath } from "@agentduo/engine/config/config";
import { userDataEnv } from "@agentduo/engine/testing/config";
import { FakeClis } from "@agentduo/engine/testing/fake-clis";
import { tempDir } from "@agentduo/engine/testing/tmp";

const desktop = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SHOWN = ".chat-mount:not([hidden])";
const SOURCE = "# Notes\n\nFirst line.\n\n- an item\n";

let scratch: { path: string; cleanup(): void };
let fake: FakeClis;
let env: Record<string, string>;
let notes: string;
let app: ElectronApplication | null = null;
let page: Page;
const log: string[] = [];

async function launch(): Promise<void> {
  const electronPath = createRequire(join(desktop, "package.json"))("electron") as unknown as string;
  app = await electron.launch({ executablePath: electronPath, args: [desktop, ...(process.env.AGENTDUO_E2E_NO_SANDBOX ? ["--no-sandbox"] : [])], env, timeout: 60_000 });
  const keep = (d: Buffer) => log.push(...String(d).split("\n").filter(Boolean));
  app.process().stdout?.on("data", keep);
  app.process().stderr?.on("data", keep);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
}

/** Resolves when the app's process has exited (the listener is set before what makes it exit). */
function exited(a: ElectronApplication): Promise<void> {
  return new Promise((r) => (a.process().exitCode !== null ? r() : a.process().once("exit", () => r())));
}

const modal = () => page.locator('[role="alertdialog"]:visible');
const choose = (label: string) => modal().getByRole("button", { name: label, exact: true }).click();
const link = () => page.locator(`${SHOWN} .md-link`).filter({ hasText: "the notes" });
const editorText = () => page.locator('[contenteditable="true"]:visible').allTextContents().then((t) => t.join("\n"));
const windows = () => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

async function openNotes(): Promise<void> {
  await link().click();
  await page.getByRole("button", { name: "Lưu", exact: true }).waitFor({ timeout: 10_000 });
}

/** Replaces visible text in the formatted document as the user types over a selection. */
async function replaceText(before: string, after: string): Promise<void> {
  const selected = await page.evaluate((needle) => {
    for (const root of document.querySelectorAll<HTMLElement>('[contenteditable="true"]')) {
      if (!root.getBoundingClientRect().height) continue;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const start = node.textContent?.indexOf(needle) ?? -1;
        if (start < 0) continue;
        root.focus();
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + needle.length);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        return true;
      }
    }
    return false;
  }, before);
  expect(selected).toBe(true);
  await page.keyboard.insertText(after);
  await expect.poll(() => page.locator("body").innerText(), { timeout: 5000 }).toMatch(/chưa lưu/i);
}

beforeAll(async () => {
  scratch = tempDir();
  fake = new FakeClis(scratch.path).install();
  // A file outside every project, as a team worktree's is: the link names it by its absolute path.
  mkdirSync(join(scratch.path, "outside"));
  notes = join(scratch.path, "outside", "notes.md");
  writeFileSync(notes, SOURCE);
  const config = join(scratch.path, "config");
  env = Object.fromEntries(Object.entries({
    ...process.env, AGENTDUO_DESKTOP_USER_DATA: join(scratch.path, "profile"), AGENTDUO_DESKTOP_LOG: "1",
    HOME: join(scratch.path, "home"), USERPROFILE: join(scratch.path, "home"), XDG_CONFIG_HOME: config, APPDATA: config,
    ...userDataEnv(join(scratch.path, "data")),
  }).filter((e): e is [string, string] => typeof e[1] === "string" && e[0] !== "ELECTRON_RUN_AS_NODE"));
  mkdirSync(env.HOME!, { recursive: true });
  const user = userConfigPath(env);
  mkdirSync(join(user, ".."), { recursive: true });
  writeFileSync(user, YAML.stringify({ claude: { bin: fake.path("claude") }, codex: { bin: fake.path("codex") } }));
  await launch();
  const onboarding = page.locator(".overlay.onboarding");
  await onboarding.getByRole("button", { name: "Continue without a project" }).click();
  await page.locator(`${SHOWN} .composer-input`).waitFor({ timeout: 30_000 });
  fake.setScenario({ chat_codex: [{ answer: `I wrote [the notes](<${notes}>) for you.` }] });
  const input = page.locator(`${SHOWN} .composer-input`);
  await input.fill("Write the notes");
  await input.press("Enter");
  await link().waitFor({ timeout: 30_000 });
});

beforeEach(({ onTestFailed }) => onTestFailed(() => console.log(`the app's log:\n${log.slice(-120).join("\n")}`)));

afterAll(async () => {
  // A failed test may leave unsaved edits behind, whose question nobody answers: the test's app goes regardless.
  if (app) {
    const a = app;
    const gone = exited(a);
    await a.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await gone;
  }
  fake.restore();
  scratch.cleanup();
});

describe("Mở: unsaved edits when the app quits or the window closes", () => {
  it("asks before quitting; Keep editing stays with the edits, and nothing is written", async () => {
    await openNotes();
    await replaceText("First line.", "Edited line.");
    await app!.evaluate(({ app }) => app.quit());
    await modal().waitFor();
    expect(await modal().innerText()).toMatch(/notes\.md[\s\S]*trước khi thoát AgentDuo/);
    await choose("Tiếp tục chỉnh sửa");
    await expect.poll(() => modal().count()).toBe(0);
    // Still running, the edits still there, the file as it was.
    expect(await windows()).toBe(1);
    expect(await editorText()).toContain("Edited line.");
    expect(readFileSync(notes, "utf8")).toBe(SOURCE);
  });

  it("asks again on the next quit (the earlier answer covers nothing), and Save writes the file before the app goes", async () => {
    const a = app!;
    const gone = exited(a);
    await a.evaluate(({ app }) => app.quit());
    await modal().waitFor();
    await choose("Lưu");
    await gone;
    app = null;
    expect(readFileSync(notes, "utf8")).toBe(SOURCE.replace("First line.", "Edited line."));
  });

  it("stays when the save asked for at quit fails, and keeps the edits to try again", async () => {
    await launch();
    await link().waitFor({ timeout: 30_000 });
    await openNotes();
    expect(await editorText()).toContain("Edited line.");
    await replaceText("Edited line.", "Edited again.");
    // The file goes away under the editor: saving it fails (this feature never creates a file).
    rmSync(notes);
    await app!.evaluate(({ app }) => app.quit());
    await modal().waitFor();
    await choose("Lưu");
    await expect.poll(() => modal().count(), { timeout: 5000 }).toBe(0);
    expect(await windows()).toBe(1);
    expect(await editorText()).toContain("Edited again.");
    expect(existsSync(notes)).toBe(false);
  });

  it("asks before closing the window, each time anew; Discard closes it and writes nothing", async () => {
    const close = () => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await close();
    await modal().waitFor();
    expect(await modal().innerText()).toMatch(/trước khi đóng cửa sổ/);
    await choose("Tiếp tục chỉnh sửa");
    await expect.poll(() => modal().count()).toBe(0);
    expect(await windows()).toBe(1);

    const a = app!;
    // Elsewhere than on a Mac, the last window closing quits the app.
    const gone = process.platform === "darwin" ? null : exited(a);
    await close();
    await modal().waitFor();
    await choose("Bỏ thay đổi");
    if (gone) {
      await gone;
      app = null;
    } else {
      await expect.poll(() => windows(), { timeout: 10_000 }).toBe(0);
      // With the window gone the app holds no edits: quitting asks nothing.
      const quitGone = exited(a);
      await a.evaluate(({ app }) => app.quit());
      await quitGone;
      app = null;
    }
    expect(existsSync(notes)).toBe(false);
  });
});
