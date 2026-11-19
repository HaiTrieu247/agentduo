// The team's QA wrote this file and fixtures/open-markdown-main.ts. These are behavioral tests of the page against the
// real renderer, chat, preload and file service. The fixture supplies PM host messages and controls response delivery;
// it does not test ProjectManager, a real PM agent, or main's quit and window close (open-lifecycle.test.ts does).
// Run from repo root, rebuilding first (test-electron otherwise reuses dist):
// npm --prefix apps/desktop run build
// npm --prefix apps/desktop run test:e2e -- open-markdown-qa
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";
import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@agentduo/engine/testing/tmp";
import { userConfigEnv, userDataEnv } from "@agentduo/engine/testing/config";
import type { DesktopRequest } from "../../src/shared/protocol.js";
import type { OpenMarkdownQa } from "./fixtures/open-markdown-main.js";

const desktop = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CHAT = ".chat-mount:not([hidden])";
const SAVE = /^(Lưu|Save)$/i;
const DISCARD = /^(Bỏ thay đổi|Discard|Discard changes)$/i;
const KEEP = /^(Tiếp tục chỉnh sửa|Keep editing|Continue editing)$/i;
const CLOSE = /^(Đóng|Đóng tài liệu|Close|Close document)$/i;
const DIRTY = /chưa lưu|unsaved/i;
const SAVED = /đã lưu|saved/i;
const modal = () => page.locator('[role="alertdialog"]:visible');
const saveButton = () => page.getByRole("button", { name: SAVE, exact: true });
// User-facing formatted content, never a Markdown textarea. No dependency on T4's private component names.
const editable = () => page.locator(':is([contenteditable="true"],[contenteditable="plaintext-only"]):visible');

let buildDir: ReturnType<typeof tempDir>;
let scratch: ReturnType<typeof tempDir>;
let fixture: string;
let legacyRenderer: string;
let app: ElectronApplication | undefined;
let page: Page;
let workspace: string;
let target: string;
let decoy: string;
let source: string;
let log: string[];
let nativeDialogs: string[];

const richSource = ["# Heading original", "", "Paragraph original.", "", "- First item", "- Second item", "",
  "**Bold original** and *Italic original* with [Label original](<docs/target (old).md>).", "",
  "```ts", 'const original = "Việt";', "```", ""].join("\n");

async function control<T>(fn: (qa: OpenMarkdownQa) => T): Promise<T> {
  return app!.evaluate((_electron, body) => {
    // evaluate serializes the function, so no closure values are used by callers below.
    const qa = (globalThis as typeof globalThis & { openMarkdownQa: OpenMarkdownQa }).openMarkdownQa;
    return (0, eval)(`(${body})`)(qa) as T;
  }, fn.toString());
}
const requests = () => control((qa) => qa.requests);
const saves = async () => (await requests()).filter((r) => r.method === "document.save");
const dirtyIds = () => control((qa) => qa.dirtyIds());

async function openLink(label = "QA primary", throughCoveredChat = false): Promise<void> {
  const link = page.locator(`${CHAT} .md-link`).filter({ hasText: label });
  if (throughCoveredChat) await link.dispatchEvent("click");
  else await link.click();
  await saveButton().waitFor({ timeout: 2000 });
  await expect.poll(() => editable().count(), { timeout: 2000 }).toBeGreaterThan(0);
}

/** Replace one visible text node using real keyboard selection and input, preserving its surrounding formatting. */
async function replaceVisible(before: string, after: string, waitForDirty = true): Promise<void> {
  const selected = await page.evaluate((needle) => {
    const nodes = document.querySelectorAll<HTMLElement>('[contenteditable="true"],[contenteditable="plaintext-only"]');
    for (const root of nodes) {
      if (!root.getBoundingClientRect().height) continue;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const start = node.textContent?.indexOf(needle) ?? -1;
        if (start < 0) continue;
        root.focus();
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + needle.length);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      }
    }
    return false;
  }, before);
  expect(selected, `formatted text ${JSON.stringify(before)} must be directly editable`).toBe(true);
  await page.keyboard.insertText(after);
  if (waitForDirty) await expect.poll(dirtyIds, { timeout: 2000 }).not.toEqual([]);
}

async function saved(): Promise<void> {
  await saveButton().click();
  await expect.poll(dirtyIds, { timeout: 3000 }).toEqual([]);
  expect(await page.locator("body").innerText()).toMatch(SAVED);
}
async function closeDocument(): Promise<void> {
  await page.getByRole("button", { name: CLOSE, exact: true }).click();
}
async function seeError(pattern: RegExp): Promise<void> {
  await expect.poll(() => page.locator("body").innerText(), { timeout: 2000 }).toMatch(pattern);
}
async function visibleText(locator: Locator): Promise<string> { return locator.innerText(); }

beforeAll(async () => {
  buildDir = tempDir();
  fixture = join(buildDir.path, "main.cjs");
  await build({ entryPoints: [join(desktop, "test/e2e/fixtures/open-markdown-main.ts")], outfile: fixture,
    bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"], logLevel: "silent" });
  // A host that supplies no optional link hook (as VS Code does). Run the actual webview renderer in a real DOM.
  legacyRenderer = join(buildDir.path, "legacy");
  mkdirSync(legacyRenderer);
  const legacyJs = join(legacyRenderer, "main.js");
  await build({ stdin: { contents: `
    import { createUi } from "@agentduo/webview/render";
    import { initialState } from "@agentduo/host/viewState";
    const noop = () => {};
    const actions = Object.fromEntries(["submit", "attach", "upload", "removeFile", "recipient", "setting", "interrupt", "cycleMode", "usage", "decide", "permit", "answerQuestion", "command", "copy", "draft", "findFiles"].map(k => [k, noop]));
    createUi(document.getElementById("root"), actions).update({ ...initialState("active", null), timeline: [{ id: "pm", kind: "pm", text: "[legacy file](notes.md) and [legacy web](https://example.test/)" }] });
  `, resolveDir: resolve(desktop, "../.."), loader: "ts" }, outfile: legacyJs,
    bundle: true, platform: "browser", format: "iife", target: "es2022", logLevel: "silent" });
  writeFileSync(join(legacyRenderer, "index.html"), '<!doctype html><div id="root"></div><script src="main.js"></script>');
});

beforeEach(async ({ onTestFailed }) => {
  scratch = tempDir();
  workspace = join(scratch.path, "workspace");
  mkdirSync(workspace);
  mkdirSync(join(workspace, "other"));
  const worktree = join(scratch.path, "team worktree");
  mkdirSync(worktree);
  target = join(worktree, "notes (Việt).md");
  decoy = join(workspace, "notes (Việt).md");
  source = richSource;
  writeFileSync(target, source);
  writeFileSync(decoy, "WORKSPACE DECOY — must stay untouched\n");
  writeFileSync(join(workspace, "second.md"), "# Second document\n\nSecond body.\n");
  mkdirSync(join(workspace, "docs"));
  writeFileSync(join(workspace, "docs", "a(1).md"), richSource);
  writeFileSync(join(workspace, "image.png"), "non-Markdown file");
  const message = [
    "[web before file](https://example.test/)", `[QA primary](<${target}>)`,
    "[QA second](second.md)", "[QA missing](missing.md)", "[QA non-markdown](image.png)",
    `[QA url](${pathToFileURL(target).href})`, `[QA titled](<${target}> "Notes title")`,
    "[QA balanced](docs/a(1).md)", "[QA escaped](docs/a\\(1\\).md)",
    "`[code is not a link](second.md)`",
  ].join("\n\n");
  log = [];
  nativeDialogs = [];
  onTestFailed(() => console.log(`T4 renderer fixture stderr/stdout:\n${log.join("\n")}`));
  const env = Object.fromEntries(Object.entries({ ...process.env,
    AGENTDUO_DESKTOP_USER_DATA: join(scratch.path, "profile"),
    AGENTDUO_OPEN_QA_WORKSPACE: workspace, AGENTDUO_OPEN_QA_MESSAGE: message,
    AGENTDUO_OPEN_QA_RENDERER: join(desktop, "dist/renderer"), AGENTDUO_OPEN_QA_PRELOAD: join(desktop, "dist/preload/index.cjs"),
    HOME: scratch.path, USERPROFILE: scratch.path, ...userConfigEnv(join(scratch.path, "config")),
    ...userDataEnv(join(scratch.path, "data")),
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[0] !== "ELECTRON_RUN_AS_NODE"));
  try {
    app = await electron.launch({ executablePath: createRequire(join(desktop, "package.json"))("electron") as string,
      args: [fixture, ...(process.env.AGENTDUO_E2E_NO_SANDBOX ? ["--no-sandbox"] : [])], env, timeout: 20_000 });
  } catch (error) {
    // If launch fails Playwright exposes its call log, but no child stdout/stderr streams. Preserve that distinction.
    log.push(`Launch failed before streams were available: ${String(error)}`);
    throw error;
  }
  const keep = (data: Buffer) => log.push(String(data));
  app.process().stdout?.on("data", keep);
  app.process().stderr?.on("data", keep);
  page = await app.firstWindow();
  page.setDefaultTimeout(3000);
  page.on("dialog", (d) => { nativeDialogs.push(d.message()); void d.dismiss(); });
  await page.locator(`${CHAT} .md-link`).filter({ hasText: "QA primary" }).waitFor();
});
afterEach(async () => {
  if (app) {
    // The test owns this app; force teardown even when the test intentionally left an unsaved-changes modal open.
    await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await app.close().catch(() => undefined);
    app = undefined;
  }
  scratch?.cleanup();
});
afterAll(() => buildDir?.cleanup());

describe("T4 QA — PM link → formatted editing → explicit save (AC1–AC5)", () => {
  it("C1 opens the exact external worktree file by mouse, identifies Mở/name/location, and never saves on opening", async () => {
    await openLink();
    expect(await page.locator("body").innerText()).toMatch(/Mở/);
    expect(await page.getByText("notes (Việt).md", { exact: true }).count()).toBeGreaterThan(0);
    const locationShown = await page.getByText(target, { exact: false }).count();
    const locationInTitle = await page.locator("[title]").evaluateAll((els, path) => els.some((e) => e.getAttribute("title")?.includes(path)), target);
    expect(locationShown > 0 || locationInTitle, "the actual destination must be identifiable").toBe(true);
    expect(await page.locator("h1,h2,h3,h4,h5,h6").filter({ hasText: "Heading original" }).count()).toBeGreaterThan(0);
    expect(await page.locator("strong").filter({ hasText: "Bold original" }).count()).toBe(1);
    expect(await page.locator("em").filter({ hasText: "Italic original" }).count()).toBe(1);
    expect(await page.locator("textarea:visible").count(), "no source editor replaces the preview").toBeLessThanOrEqual(1); // chat composer only
    expect(readFileSync(target, "utf8")).toBe(source);
    expect(await saves()).toEqual([]);
    const opened = (await requests()).find((r) => r.method === "document.open");
    expect(opened).toMatchObject({ linkId: expect.stringMatching(/^k\d+$/) });
    expect(opened).not.toHaveProperty("path");
    expect(opened).not.toHaveProperty("href");
  });

  it.each([
    ["Heading original", "Tiêu đề mới", "h1,h2,h3,h4,h5,h6"],
    ["Paragraph original.", "Đoạn văn mới e\u0301 😀.", "p"],
    ["First item", "Mục mới", "li"],
    ["Bold original", "Đậm mới", "strong"],
    ["Italic original", "Nghiêng mới", "em"],
    ["Label original", "Nhãn mới", ".doc-link"],
    ['const original = "Việt";', 'const mới = "``` không đóng khối";', "pre code,pre"],
  ])("C2 directly edits %s, keeps its formatting, writes only on Save, and reopens it", async (before, after, selector) => {
    await openLink();
    await replaceVisible(before, after);
    expect(await page.locator("body").innerText()).toMatch(DIRTY);
    expect(readFileSync(target, "utf8")).toBe(source);
    expect(await saves()).toEqual([]);
    await saved();
    const disk = readFileSync(target, "utf8");
    expect(disk).toContain(after);
    expect(readFileSync(decoy, "utf8")).toBe("WORKSPACE DECOY — must stay untouched\n");
    await closeDocument();
    await openLink();
    expect(await page.locator(selector).filter({ hasText: after }).count()).toBeGreaterThan(0);
    expect(await dirtyIds()).toEqual([]);
  });

  it("C3 edits a link's destination through its preview controls and reopens the changed target", async () => {
    await openLink();
    // Preview links deliberately do not navigate: select the rendered span to expose its destination control.
    await page.locator(".doc-link").filter({ hasText: "Label original" }).click();
    const destination = page.getByRole("textbox", { name: /đích|địa chỉ|destination|url|target/i });
    await destination.fill("docs/new target (Việt).md");
    // The destination edits live. Enter returns focus to its label; no separate Apply action is required by AC2.
    await destination.press("Enter");
    expect(readFileSync(target, "utf8")).toBe(source);
    await saved();
    expect(readFileSync(target, "utf8")).toContain("docs/new target (Việt).md");
    await closeDocument();
    await openLink();
    const link = page.locator(".doc-link").filter({ hasText: "Label original" });
    expect((await link.getAttribute("href")) ?? (await link.getAttribute("title"))).toContain("docs/new target (Việt).md");
  });

  it("C4 preserves all untouched bytes around a local edit, including BOM, mixed EOL, HTML, references and an unclosed fence", async () => {
    source = '\ufeff---\r\ntitle: Keep\r\n---\r\n\r\n<div data-original="yes">KEEP HTML</div>\r\n\r\n[ref]: <target.md> "Keep title"\r\n\r\nParagraph original.\r\n\r\n```text\r\nKEEP fence\nlast line\r\n';
    writeFileSync(target, source);
    await openLink();
    await replaceVisible("Paragraph original.", "Paragraph changed.");
    await saved();
    expect(readFileSync(target)).toEqual(Buffer.from(source.replace("Paragraph original.", "Paragraph changed.")));
  });

  it("C5 displays preserved unsupported structures and prevents editing them into a lossy save", async () => {
    writeFileSync(target, "<div>KEEP raw HTML</div>\n\nParagraph original.\n");
    await openLink();
    await seeError(/html|giữ nguyên|preserv|unsupported|chưa hỗ trợ/i);
    const unsafeEditable = await editable().evaluateAll((roots) => roots.some((root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.includes("KEEP raw HTML") && node.parentElement?.isContentEditable) return true;
      }
      return false;
    }));
    expect(unsafeEditable, "unsupported HTML must remain immutable (or report an unsafe save rather than write)").toBe(false);
    expect(await saves()).toEqual([]);
    expect(readFileSync(target, "utf8")).toBe("<div>KEEP raw HTML</div>\n\nParagraph original.\n");
  });
});

describe("T4 QA — errors, delayed responses and retained drafts (AC3, AC4, AC7)", () => {
  it.each(["missing", "unreadable"])("C6 clearly reports an %s open without substituting a same-name file", async (kind) => {
    if (kind === "unreadable") await control((qa) => qa.fault("unreadable"));
    await page.locator(`${CHAT} .md-link`).filter({ hasText: kind === "missing" ? "QA missing" : "QA primary" }).click();
    await seeError(kind === "missing" ? /not found|not exist|không tồn tại/i : /read|đọc/i);
    expect(await saves()).toEqual([]);
    expect(readFileSync(decoy, "utf8")).toContain("WORKSPACE DECOY");
  });

  it("C7 retains a failed save's draft and dirty state, and a retry saves it", async () => {
    await openLink();
    await replaceVisible("Paragraph original.", "Draft survives failure.");
    await control((qa) => qa.fault("save"));
    await saveButton().click();
    await seeError(/controlled disk write failure|save.*fail|lưu.*lỗi|không.*lưu/i);
    expect(await dirtyIds()).not.toEqual([]);
    expect(await visibleText(editable().filter({ hasText: "Draft survives failure." }).first())).toContain("Draft survives failure.");
    expect(readFileSync(target, "utf8")).toBe(source);
    await control((qa) => qa.fault(null));
    await saved();
    expect(readFileSync(target, "utf8")).toContain("Draft survives failure.");
  });

  it("C8 keeps a later edit dirty after the earlier save completes, then saves against the returned revision", async () => {
    await openLink();
    await replaceVisible("Paragraph original.", "First save draft.");
    await control((qa) => qa.hold("save", true));
    await saveButton().click();
    await expect.poll(() => control((qa) => qa.waiting("save"))).toBe(true);
    expect(await page.locator("body").innerText()).toMatch(/đang lưu|saving/i);
    await replaceVisible("First save draft.", "Newer unsaved draft.");
    await control((qa) => qa.release("save"));
    await expect.poll(() => readFileSync(target, "utf8")).toContain("First save draft.");
    expect(await dirtyIds()).not.toEqual([]);
    expect(await page.locator("body").innerText()).toMatch(DIRTY);
    expect(await editable().allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining("Newer unsaved draft.")]));
    await saved();
    expect(readFileSync(target, "utf8")).toContain("Newer unsaved draft.");
    const sent = await saves();
    expect(sent).toHaveLength(2);
    if (sent[0]?.method !== "document.save" || sent[1]?.method !== "document.save") throw new Error("Expected two saves");
    expect(sent[1].revision).not.toBe(sent[0].revision);
  });

  it("C9 a late open response cannot replace edits in a newer document", async () => {
    await control((qa) => qa.hold("open", true));
    await page.locator(`${CHAT} .md-link`).filter({ hasText: "QA primary" }).click();
    await expect.poll(() => control((qa) => qa.waiting("open"))).toBe(true);
    // Stop holding future opens, but retain the already pending result until explicitly released.
    await control((qa) => qa.hold("open", false));
    await openLink("QA second", true);
    await replaceVisible("Second body.", "Second draft retained.");
    await control((qa) => qa.release("open"));
    // Wait for the stale result's session cleanup, rather than guessing how many animation frames IPC will take.
    await expect.poll(() => control((qa) => qa.sessions().length)).toBe(1);
    expect(await editable().allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining("Second draft retained.")]));
    await saved();
    expect(readFileSync(join(workspace, "second.md"), "utf8")).toContain("Second draft retained.");
    expect(readFileSync(target, "utf8")).toBe(source);
  });

  it("C10 refuses a changed-on-disk save, keeps the local draft and never silently overwrites", async () => {
    await openLink();
    await replaceVisible("Paragraph original.", "Local draft.");
    const external = source.replace("Paragraph original.", "External change.");
    writeFileSync(target, external);
    await saveButton().click();
    await seeError(/changed|disk|conflict|thay đổi|xung đột/i);
    expect(readFileSync(target, "utf8")).toBe(external);
    expect(await dirtyIds()).not.toEqual([]);
    expect(await editable().allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining("Local draft.")]));
    expect((await saves()).every((r) => r.method === "document.save" && r.overwrite === false)).toBe(true);
  });
});

describe("T4 QA — shared unsaved-changes decision (AC6, AC7)", () => {
  const leave = async (route: string) => {
    switch (route) {
      case "close": return closeDocument();
      // Exercise the existing rendered link's handler even if a document layer covers the chat. The initial open
      // tests above require a real user click; this guard test makes no extra requirement about the panel's layout.
      case "another document": return page.locator(".chat-mount .md-link").filter({ hasText: "QA second" }).dispatchEvent("click");
      case "conversation": return page.locator(".sidebar .nav-item.conversation").filter({ hasText: "Other conversation" }).locator(".nav-main").click();
      case "project": return page.getByRole("button", { name: "Other project", exact: true }).click();
      case "settings": return page.locator(".side-foot button", { hasText: "Settings" }).click();
      default: throw new Error(route);
    }
  };
  for (const route of ["close", "another document", "conversation", "project", "settings"]) {
    for (const choice of ["keep", "discard", "save"]) {
      it(`C11 ${route}: ${choice} settles the same three-choice dialog`, async () => {
        await openLink();
        await replaceVisible("Paragraph original.", "Unsaved choice draft.");
        await leave(route);
        const dialog = modal();
        await dialog.waitFor();
        for (const name of [SAVE, DISCARD, KEEP]) expect(await dialog.getByRole("button", { name, exact: true }).count()).toBe(1);
        await dialog.getByRole("button", { name: choice === "keep" ? KEEP : choice === "discard" ? DISCARD : SAVE, exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        if (choice === "keep") {
          expect(await dirtyIds()).not.toEqual([]);
          expect(await editable().allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining("Unsaved choice draft.")]));
          expect(readFileSync(target, "utf8")).toBe(source);
          expect(await saves()).toEqual([]);
          if (route === "project") expect((await requests()).some((r) => r.method === "project.select")).toBe(false);
          if (route === "conversation") expect((await requests()).some((r) => r.method === "conversation.open" && r.conversationId.includes("other-qa"))).toBe(false);
        } else {
          await expect.poll(dirtyIds).toEqual([]);
          expect(readFileSync(target, "utf8")).toBe(choice === "save" ? source.replace("Paragraph original.", "Unsaved choice draft.") : source);
          if (choice === "discard") expect(await saves()).toEqual([]);
          if (route === "another document") await page.getByText("Second document", { exact: true }).waitFor();
          else if (route === "settings") await page.locator(".overlay.settings").waitFor();
          else if (route === "close") await expect.poll(() => editable().count()).toBe(0);
          else await expect.poll(async () => (await requests()).some((r) => route === "project" ? r.method === "project.select" : r.method === "conversation.open" && r.conversationId.includes("other-qa"))).toBe(true);
        }
        expect(nativeDialogs).toEqual([]);
      });
    }
  }

  it("C12 Save on leaving fails: the original document, draft and dirty state remain visible", async () => {
    await openLink();
    await replaceVisible("Paragraph original.", "Stay here after save failure.");
    await control((qa) => qa.fault("save"));
    await closeDocument();
    await modal().getByRole("button", { name: SAVE, exact: true }).click();
    await seeError(/controlled disk write failure|save.*fail|không.*lưu/i);
    expect(await dirtyIds()).not.toEqual([]);
    expect(await editable().allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining("Stay here after save failure.")]));
    expect(readFileSync(target, "utf8")).toBe(source);
  });

  for (const reason of ["window", "quit"] as const) {
    it.each(["keep", "discard", "save"])(`C13 renderer answers a ${reason} close request only after %s`, async (choice) => {
      await openLink();
      await replaceVisible("Paragraph original.", "Pending native close.");
      const ids = await control((qa) => qa.sessions());
      await app!.evaluate((_electron, event) => (globalThis as typeof globalThis & { openMarkdownQa: OpenMarkdownQa }).openMarkdownQa.post(event),
        { type: "documentCloseRequest" as const, requestId: "q17", reason, documentIds: ids });
      await modal().waitFor();
      expect((await requests()).filter((r) => r.method === "document.closeResponse")).toEqual([]);
      await modal().getByRole("button", { name: choice === "keep" ? KEEP : choice === "discard" ? DISCARD : SAVE, exact: true }).click();
      await expect.poll(async () => (await requests()).filter((r) => r.method === "document.closeResponse"))
        .toEqual([{ method: "document.closeResponse", requestId: "q17", outcome: choice === "keep" ? "cancelled" : "settled" }]);
      expect(readFileSync(target, "utf8")).toBe(choice === "save" ? source.replace("Paragraph original.", "Pending native close.") : source);
      if (choice === "keep") expect(await dirtyIds()).not.toEqual([]);
      else expect(await dirtyIds()).toEqual([]);
    });
  }
});

describe("T4 QA — accessibility, paste, themes, DOM safety and legacy host", () => {
  it.each(["QA url", "QA titled", "QA balanced", "QA escaped"])("C20 real PM link %s keeps the displayed target through open and save", async (label) => {
    await openLink(label);
    await replaceVisible("Paragraph original.", "Link roundtrip verified.");
    const intended = /balanced|escaped/.test(label) ? join(workspace, "docs", "a(1).md") : target;
    expect(readFileSync(intended, "utf8")).toBe(source);
    await saved();
    expect(readFileSync(intended, "utf8")).toContain("Link roundtrip verified.");
    expect(readFileSync(decoy, "utf8")).toBe("WORKSPACE DECOY — must stay untouched\n");
  });

  it("C14 opens by keyboard and traps all three dialog choices; Escape keeps edits and restores usable focus", async () => {
    const link = page.locator(`${CHAT} .md-link`).filter({ hasText: "QA primary" });
    await link.focus();
    await link.press("Enter");
    await saveButton().waitFor();
    await replaceVisible("Paragraph original.", "Keyboard draft.");
    await closeDocument();
    await modal().waitFor();
    const seen = new Set<string>();
    for (let i = 0; i < 7; i++) {
      seen.add(await page.evaluate(() => document.activeElement?.textContent?.trim() ?? ""));
      expect(await modal().evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Tab");
    }
    expect([...seen].some((name) => SAVE.test(name))).toBe(true);
    expect([...seen].some((name) => DISCARD.test(name))).toBe(true);
    expect([...seen].some((name) => KEEP.test(name))).toBe(true);
    await page.keyboard.press("Shift+Tab");
    expect(await modal().evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await modal().waitFor({ state: "hidden" });
    expect(await page.evaluate(() => document.activeElement !== document.body && !(document.activeElement as HTMLElement).closest("[inert]"))).toBe(true);
    expect(await dirtyIds()).not.toEqual([]);
    expect(nativeDialogs).toEqual([]);
  });

  it("C15 pastes plain Vietnamese text without treating its Markdown/HTML characters as executable markup", async () => {
    await openLink();
    const node = editable().filter({ hasText: "Paragraph original." }).first();
    await node.focus();
    // A synthetic ClipboardEvent never performs the browser's default paste. Exercise the browser's beforeinput
    // boundary instead: the editor prevents that default and performs the plain-text insertion itself. This leaves
    // the system clipboard untouched and supplies both hostile HTML and the plain text, like an actual paste.
    await node.evaluate((root) => {
      const selection = document.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      const data = new DataTransfer();
      const text = 'Tiếng Việt e\u0301 😀 <img src=x onerror="window.qaExecuted=1"> **literal**';
      data.setData("text/plain", text);
      data.setData("text/html", '<img src="https://example.test/tracker" onerror="window.qaExecuted=1"><b>foreign formatting</b>');
      root.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertFromPaste", dataTransfer: data, data: text, bubbles: true, cancelable: true }));
    });
    await expect.poll(dirtyIds).not.toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { qaExecuted?: number }).qaExecuted)).toBeUndefined();
    expect(await page.locator('[contenteditable="true"] img').count()).toBe(0);
    expect(readFileSync(target, "utf8")).toBe(source);
    await saved();
    expect(readFileSync(target, "utf8")).toContain("Tiếng Việt e\u0301 😀");
  });

  it("C21 keeps Vietnamese composition text through input and saves it without Unicode normalization", async () => {
    await openLink();
    // A handle, not a locator: a locator that filters by the old text no longer finds the field once it holds the new.
    const root = await editable().filter({ hasText: "Paragraph original." }).first().elementHandle();
    await root.dispatchEvent("compositionstart", { data: "" });
    const text = "Tiếng Việt e\u0301 😀 đang gõ";
    await replaceVisible("Paragraph original.", text, false);
    await root.dispatchEvent("compositionend", { data: text });
    await expect.poll(dirtyIds).not.toEqual([]);
    expect(readFileSync(target, "utf8")).toBe(source);
    await saved();
    expect(readFileSync(target, "utf8")).toContain(text);
    await closeDocument();
    await openLink();
    expect(await editable().allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining(text)]));
    // Synthetic browser composition events cover rerender handling. A real OS Vietnamese IME still needs manual QA.
  });

  it.each(["light", "dark"] as const)("C16 %s theme keeps Save/Close/focus accessible at 720×480", async (theme) => {
    await openLink();
    await app!.evaluate(({ BrowserWindow }, mode) => {
      BrowserWindow.getAllWindows()[0]!.setContentSize(720, 480);
      (globalThis as typeof globalThis & { openMarkdownQa: OpenMarkdownQa }).openMarkdownQa.post({ type: "theme", dark: mode === "dark" });
    }, theme);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(720);
    for (const control of [saveButton(), page.getByRole("button", { name: CLOSE, exact: true })]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(720);
      expect(box!.y + box!.height).toBeLessThanOrEqual(480);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await editable().first().focus();
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).isContentEditable)).toBe(true);
  });

  it("C17 displays hostile Markdown without loading document-specified resources or executing HTML", async () => {
    const localImage = pathToFileURL(join(workspace, "image.png")).href;
    writeFileSync(target, `# Safe heading\n\n<img src="https://example.test/tracker" onerror="window.qaExecuted=1">\n\n![remote](https://example.test/image.png)\n\n![local](${localImage})\n\n[evil](javascript:window.qaExecuted=1)\n\nParagraph original.\n`);
    const network: string[] = [];
    page.on("request", (request) => { if (/example\.test/.test(request.url()) || request.url() === localImage) network.push(request.url()); });
    await openLink();
    expect(await page.locator("script[src*='example.test'],iframe,object,embed,img[src*='example.test']").count()).toBe(0);
    const evil = page.getByRole("link", { name: "evil", exact: true });
    if (await evil.count()) await evil.click();
    expect(network).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { qaExecuted?: number }).qaExecuted)).toBeUndefined();
    expect(await saves()).toEqual([]);
  });

  it("C18 unregistered formats keep the host's existing inert link behavior", async () => {
    await page.locator(`${CHAT} .md-link`).filter({ hasText: "QA non-markdown" }).click();
    expect((await requests()).filter((r) => r.method === "document.open")).toEqual([]);
    expect(await editable().count()).toBe(0);
  });

  it("C19 a host with no optional link hook retains its existing inert links (VS Code regression)", async () => {
    // Same Electron DOM; a separate page runs createUi with the original Actions contract and no hook.
    await app!.evaluate(async ({ BrowserWindow }, url) => {
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      await win.loadURL(url);
    }, pathToFileURL(join(legacyRenderer, "index.html")).href);
    const legacy = (await app!.windows()).find((candidate) => candidate !== page)!;
    await legacy.locator(".md-link").first().waitFor();
    expect(await legacy.locator(".md-link").count()).toBe(2);
    const links = await legacy.locator(".md-link").evaluateAll((els) => els.map((e) => ({ tag: e.tagName, role: e.getAttribute("role"), href: e.getAttribute("href"), title: e.getAttribute("title") })));
    expect(links).toEqual([
      { tag: "SPAN", role: null, href: null, title: "notes.md" },
      { tag: "SPAN", role: null, href: null, title: "https://example.test/" },
    ]);
    const url = legacy.url();
    await legacy.locator(".md-link").first().click({ force: true });
    expect(legacy.url()).toBe(url);
    expect((await requests()).filter((r) => r.method === "document.open")).toEqual([]);
  });
});
