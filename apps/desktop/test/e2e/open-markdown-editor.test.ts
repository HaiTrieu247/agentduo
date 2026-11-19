// "Mở"'s editor (renderer/markdown-editor.ts) in a real page: the keys whose handling depends on where the caret is.
// The viewer alone is bundled (esbuild, as the build does) into a bare Electron window: no app, no project, no main
// side, so it runs before the rest of "Mở" is wired. Keys go through Chromium's own input (Playwright), so the caret,
// the selection and `beforeinput` are the browser's, not a fake's.
//   npm run test:e2e -- open-markdown-editor   (in apps/desktop; no build needed)
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "@agentduo/engine/testing/tmp";

const desktop = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const root = join(desktop, "..", "..");
const require = createRequire(join(root, "package.json"));

let scratch: { path: string; cleanup(): void };
let app: ElectronApplication;
let page: Page;

beforeAll(async () => {
  scratch = tempDir();
  const esbuild = require("esbuild") as typeof import("esbuild");
  const bundle = await esbuild.build({
    stdin: {
      contents: `import { createMarkdownViewer } from ${JSON.stringify(join(desktop, "src", "renderer", "markdown-editor.ts"))};
        window.__open = (text) => {
          window.__viewer?.destroy();
          document.body.replaceChildren();
          const info = { documentId: "d1", format: "markdown", name: "a.md", location: "/repo/a.md", revision: "r".repeat(16), text,
            position: null, anchor: null, save: { allowed: true }, origin: { projectId: "p", conversationId: "c" } };
          window.__viewer = createMarkdownViewer({ info, readOnly: false, changed: () => {} });
          document.body.append(window.__viewer.element);
        };`,
      resolveDir: desktop,
      loader: "ts",
    },
    bundle: true, write: false, format: "iife", platform: "browser", target: "es2022", absWorkingDir: root, logLevel: "warning",
  });
  const main = join(scratch.path, "main.cjs");
  writeFileSync(main, `const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 900, height: 700, webPreferences: { sandbox: true, contextIsolation: true } });
  w.loadURL("data:text/html;charset=utf-8,<!doctype html><html><head><meta charset='utf-8'></head><body></body></html>");
});
app.on("window-all-closed", () => app.quit());
`);
  const executablePath = createRequire(join(desktop, "package.json"))("electron") as unknown as string;
  app = await electron.launch({ executablePath, args: [main, `--user-data-dir=${join(scratch.path, "profile")}`] });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
});

afterAll(async () => {
  await app?.close();
  scratch?.cleanup();
});

/** Opens `text`, puts the caret `offset` characters into the field that reads `field`, and presses `key`. */
async function press(text: string, field: string, offset: number, key: string): Promise<string> {
  await page.evaluate(([text, field, offset]) => {
    const w = window as unknown as { __open(t: string): void };
    w.__open(text);
    const el = Array.from(document.querySelectorAll<HTMLElement>(".doc-field")).find((e) => e.textContent === field);
    if (!el) throw new Error(`no field reads ${field}`);
    el.focus();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let left = offset;
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      if (left <= n.data.length) {
        const r = document.createRange();
        r.setStart(n, left);
        r.collapse(true);
        const sel = document.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(r);
        return;
      }
      left -= n.data.length;
    }
    throw new Error(`offset ${offset} is past ${field}`);
  }, [text, field, offset] as const);
  await page.keyboard.press(key);
  return written();
}

const written = () => page.evaluate(() => {
  const r = (window as unknown as { __viewer: { text(): { ok: boolean; text?: string } } }).__viewer.text();
  return r.ok ? r.text! : "(not writable)";
});

const FILE = "# Hello\n\nfirst\n\nsecond\n\n- one\n- item two\n";

describe("Backspace inside a field deletes one character (the caret's offset is counted, not taken as 0)", () => {
  it.each([
    ["in the middle of a heading", "Hello", 3, FILE.replace("# Hello", "# Helo")],
    ["at the end of a heading", "Hello", 5, FILE.replace("# Hello", "# Hell")],
    ["in the middle of a paragraph after another one", "second", 3, FILE.replace("second", "seond")],
    ["at the end of a paragraph after another one", "second", 6, FILE.replace("second", "secon")],
    ["in the middle of a list item", "item two", 4, FILE.replace("item two", "ite two")],
    ["at the end of a list item", "item two", 8, FILE.replace("item two", "item tw")],
  ])("%s", async (_, field, offset, expected) => {
    expect(await press(FILE, field, offset, "Backspace")).toBe(expected);
  });

  it("inside bold text, the offset counts the text before the mark", async () => {
    const text = "a **bold** z\n";
    // The caret after "bo" in the strong element: 4 characters into the field ("a " + "bo").
    await page.evaluate(() => (window as unknown as { __open(t: string): void }).__open("a **bold** z\n"));
    await page.evaluate(() => {
      const strong = document.querySelector(".doc-field strong")!.firstChild as Text;
      (strong.parentElement!.closest(".doc-field") as HTMLElement).focus();
      const r = document.createRange();
      r.setStart(strong, 2);
      r.collapse(true);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(r);
    });
    await page.keyboard.press("Backspace");
    expect(await written()).toBe(text.replace("**bold**", "**bld**"));
  });

  it("at the very start, a heading still becomes a paragraph (the start is still told apart)", async () => {
    expect(await press(FILE, "Hello", 0, "Backspace")).toBe(FILE.replace("# Hello", "Hello"));
  });

  it("Delete at the end of a field is told apart from Delete inside it", async () => {
    expect(await press(FILE, "Hello", 2, "Delete")).toBe(FILE.replace("# Hello", "# Helo"));
  });
});
