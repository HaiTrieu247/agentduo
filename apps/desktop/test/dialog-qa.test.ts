// Task T2 of the desktop UI redesign, the parts that need no window: the dialog helper's contract (renderer/dialog.ts),
// that the three confirmations of main.ts go through it with their conditions and texts unchanged, the sidebar's width
// limits, and the drag regions' rules. There is no DOM library in the repo, so the helper is checked as the page's code
// reads it; test/e2e/shell.test.ts drives the real thing (focus, Tab, Escape, sizes) in Electron.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sidebarWidth } from "../src/renderer/resizer.js";
import { restartQuestion } from "../src/renderer/update.js";
import { SIDEBAR_WIDTHS } from "../src/shared/protocol.js";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const renderer = join(desktop, "src", "renderer");
// Windows checks files out with CRLF line endings: the patterns below read LF.
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const dialogPath = join(renderer, "dialog.ts");
const dialogSrc = () => (existsSync(dialogPath) ? strip(read(dialogPath)) : "");
const mainSrc = () => read(join(renderer, "main.ts"));

describe("the dialog helper (renderer/dialog.ts)", () => {
  it("exists, runs in the browser only (no Node, no electron) and imports relative files with .js", () => {
    expect(existsSync(dialogPath)).toBe(true);
    const src = dialogSrc();
    expect(src).not.toMatch(/from ["'](node:|electron)/);
    expect(src).not.toMatch(/\brequire\(/);
    for (const m of src.matchAll(/from ["'](\.[^"']+)["']/g)) expect(m[1], `relative import ${m[1]} ends in .js`).toMatch(/\.js$/);
  });

  it("is a real dialog for assistive technology: a role, modal, and a name", () => {
    const src = dialogSrc();
    expect(src).toMatch(/["'](alert)?dialog["']/);
    expect(src).toMatch(/aria-modal/);
    expect(src, "named by aria-label or aria-labelledby").toMatch(/aria-label(ledby)?/);
  });

  it("takes the focus when it opens, keeps it inside on Tab and Shift+Tab, closes on Escape, and gives the focus back", () => {
    const src = dialogSrc();
    expect(src, "remembers what had the focus").toMatch(/activeElement/);
    expect(src, "moves the focus in").toMatch(/\.focus\(/);
    expect(src, "handles Tab").toMatch(/["']Tab["']/);
    expect(src, "handles Shift+Tab").toMatch(/shiftKey/);
    expect(src, "handles Escape").toMatch(/["']Escape["']/);
    // Focus is returned after the dialog is removed or hidden: a focus() call on the saved element exists besides the first one.
    expect((src.match(/\.focus\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(src, "removes itself").toMatch(/\.remove\(|removeChild|hidden\s*=/);
  });

  it("is themed with the desktop's tokens, not colours of its own", () => {
    expect(dialogSrc()).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    const css = existsSync(join(renderer, "styles", "shell.css")) ? read(join(renderer, "styles", "shell.css")) : "";
    // Some rule styles the dialog from the tokens (var(--…)) in shell.css.
    expect(css).toMatch(/dialog[^{]*\{[^}]*var\(--/i);
  });

  it("answers with a promise or a callback (not blocking), so the page's other work is not frozen", () => {
    expect(dialogSrc()).toMatch(/Promise|new Promise|=>\s*void|async /);
  });
});

describe("main.ts uses the helper for its three confirmations and the native confirm no more", () => {
  const src = () => mainSrc();

  it("has no window.confirm / confirm( left", () => {
    expect(strip(src())).not.toMatch(/(^|[^\w.])(window\.)?confirm\(/m);
    expect(strip(src())).not.toMatch(/\balert\(|\bprompt\(/);
  });

  it("imports the helper from ./dialog.js", () => {
    expect(src()).toMatch(/from ["']\.\/dialog\.js["']/);
  });

  it("keeps the three questions and their conditions", () => {
    const s = src();
    // The app's dialog asks as a title and a message: the same question, the same warning.
    expect(s).toMatch(/title: `Remove «\$\{name\}» from the list\?`/);
    expect(s).toContain("Its files and conversations stay where they are.");
    expect(s).toMatch(/title: `Delete «\$\{c\.title\}»\?`/);
    expect(s).toContain("Its logs and attached files are deleted with it. This cannot be undone.");
    // The restart question is still asked only when agents run: restartQuestion(0) is null.
    expect(s).toMatch(/restartQuestion\(running\)/);
    expect(restartQuestion(0)).toBeNull();
    expect(restartQuestion(2)).toEqual(expect.any(String));
  });

  it("does nothing until the user accepts: the actions are not called before the answer", () => {
    const s = src();
    // The forget, delete and install calls are still there, and each comes after the helper's use in the same handler.
    for (const [ask, act] of [
      [/forgetProject:/, /method: "project\.forget"/],
      [/deleteConversation:\s*\(c\)/, /deleteConversation\(c\.id\)/],
      [/function installUpdate/, /method: "update\.install"/],
    ] as const) {
      const a = s.search(ask);
      expect(a, `${ask} exists`).toBeGreaterThanOrEqual(0);
      const rest = s.slice(a);
      const helperAt = rest.search(/\bawait\b|\.then\(|confirm|ask|dialog/i);
      const actAt = rest.search(act);
      expect(actAt, `${act} still exists after ${ask}`).toBeGreaterThanOrEqual(0);
      expect(helperAt, "the question comes first").toBeLessThan(actAt);
    }
  });
});

describe("the sidebar's width limits (T2 keeps the draggable sidebar and its preference)", () => {
  it("keeps the minimum and the maximum at both window sizes the app supports (1360 and 720 wide)", () => {
    expect(sidebarWidth(0, 1360)).toBe(SIDEBAR_WIDTHS.min);
    expect(sidebarWidth(9999, 1360)).toBe(SIDEBAR_WIDTHS.max);
    expect(sidebarWidth(SIDEBAR_WIDTHS.default, 1360)).toBe(SIDEBAR_WIDTHS.default);
    expect(sidebarWidth(0, 720)).toBe(SIDEBAR_WIDTHS.min);
    // At the smallest window the chat keeps at least 360px.
    expect(720 - sidebarWidth(9999, 720)).toBeGreaterThanOrEqual(360);
    expect(sidebarWidth(9999, 720)).toBeGreaterThanOrEqual(SIDEBAR_WIDTHS.min);
  });

  it("never goes below the minimum even in a window narrower than the minimum supports, and ignores junk", () => {
    expect(sidebarWidth(300, 400)).toBe(SIDEBAR_WIDTHS.min);
    expect(sidebarWidth(Number.NaN, 1360)).toBe(SIDEBAR_WIDTHS.default);
    expect(sidebarWidth(Number.POSITIVE_INFINITY, 1360)).toBe(SIDEBAR_WIDTHS.default);
  });

  it("main's window minimum is 720×480 and the design relies on it", () => {
    const w = read(join(desktop, "src", "main", "window.ts"));
    expect(w).toMatch(/minWidth:\s*720/);
    expect(w).toMatch(/minHeight:\s*480/);
  });
});

describe("window drag regions", () => {
  const css = ["shell.css", "settings.css", "base.css"].map((f) => (existsSync(join(renderer, "styles", f)) ? strip(read(join(renderer, "styles", f))) : "")).join("\n");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim().split(",").map((s) => s.trim()), body: m[2] }));
  const dragSelectors = rules.filter((r) => /-webkit-app-region:\s*drag/.test(r.body)).flatMap((r) => r.sel);
  const noDrag = rules.filter((r) => /-webkit-app-region:\s*no-drag/.test(r.body)).flatMap((r) => r.sel);

  it("has a drag region (the title bar and brand) and keeps it", () => {
    expect(dragSelectors.length).toBeGreaterThan(0);
    expect(dragSelectors.some((s) => /topbar/.test(s))).toBe(true);
  });

  it("makes every button, input, link and select inside a drag region no-drag, so no control sits in the window-drag area", () => {
    const missing: string[] = [];
    for (const d of dragSelectors) {
      if (/^body\./.test(d) && /settings-drag/.test(d)) continue; // an empty strip
      for (const tag of ["button", "input", "select", "a"]) {
        const covered = noDrag.some((n) => n === `${d} ${tag}` || n === `${d} ${tag}:not(:disabled)` || n === `${d} *` || n === `${d} :is(button, input, select, a)`);
        // A drag region with nothing but text may skip it; the topbar and the settings head hold buttons.
        if (!covered && /topbar|settings-head|titlebar/.test(d) && tag === "button") missing.push(`${d} ${tag}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps the sidebar's resize edge and the dialog out of the drag area", () => {
    expect(noDrag.some((s) => /sidebar-edge/.test(s))).toBe(true);
    // A dialog or its backdrop never drags the window.
    const dialogRule = rules.find((r) => r.sel.some((s) => /dialog|modal|overlay/.test(s)) && /-webkit-app-region/.test(r.body));
    if (dialogRule) expect(dialogRule.body).not.toMatch(/-webkit-app-region:\s*drag/);
  });
});

describe("the shell copes with long titles and a narrow window (static)", () => {
  const shell = existsSync(join(renderer, "styles", "shell.css")) ? strip(read(join(renderer, "styles", "shell.css"))) : "";
  const work = existsSync(join(renderer, "styles", "work.css")) ? strip(read(join(renderer, "styles", "work.css"))) : "";

  it("shortens a long title with an ellipsis instead of pushing the controls out", () => {
    expect(shell).toMatch(/\.top-title[^{]*\{[^}]*text-overflow:\s*ellipsis/);
    expect(shell).toMatch(/\.nav-title[^{]*\{[^}]*text-overflow:\s*ellipsis|\.nav-text[^{]*\{[^}]*min-width:\s*0/);
  });

  it("keeps the narrow-window inspector as an overlay that leaves the chat its room", () => {
    expect(shell + work).toMatch(/body\.narrow\s+\.inspector/);
  });
});
