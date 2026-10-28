import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, makeNonce, webviewHtml } from "../extensions/vscode/src/webviewHtml.js";

const ext = fileURLToPath(new URL("../extensions/vscode/", import.meta.url));
const source = (path: string) => readFileSync(join(ext, path), "utf8");

describe("webview page", () => {
  it("allows only the bundled script by nonce and the bundled stylesheet", () => {
    const nonce = makeNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9]{24,}$/);
    expect(makeNonce()).not.toBe(nonce);
    const csp = contentSecurityPolicy("https://file+.vscode-resource.vscode-cdn.net", nonce);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`script-src 'nonce-${nonce}'`);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:\/\/(?!file\+)/);
    const html = webviewHtml({ cspSource: "vscode-resource:", scriptUri: "vscode-resource:/main.js", styleUri: "vscode-resource:/styles.css", iconsUri: "vscode-resource:/codicon.css", nonce });
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain(`<script nonce="${nonce}" src="vscode-resource:/main.js"></script>`);
    expect(html).not.toMatch(/<script[^>]*>[^<]+<\/script>/); // no inline code
    expect(html).not.toMatch(/https?:\/\//);
    // The icon font's stylesheet comes first, so the sidebar's own rules win.
    expect(html.indexOf('href="vscode-resource:/codicon.css"')).toBeGreaterThan(0);
    expect(html.indexOf('href="vscode-resource:/codicon.css"')).toBeLessThan(html.indexOf('href="vscode-resource:/styles.css"'));
  });

  it("escapes what it puts in attributes", () => {
    const html = webviewHtml({ cspSource: "x", scriptUri: 'a"><script>alert(1)</script>', styleUri: "s", iconsUri: "i", nonce: "n" });
    expect(html).not.toContain("<script>alert(1)");
  });
});

describe("webview sources", () => {
  const files = ["webview/main.ts", "webview/render.ts", "webview/state.ts", "webview/markdown.ts"];

  it("never turns text into markup or code", () => {
    for (const file of files) {
      const text = source(file);
      for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "setAttribute(\"on", "javascript:"]) {
        expect(text.includes(sink), `${file} uses ${sink}`).toBe(false);
      }
    }
    expect(source("webview/render.ts")).toContain("document.createTextNode");
  });

  it("loads nothing from the network", () => {
    for (const file of [...files, "webview/styles.css"]) expect(source(file).replaceAll('"http://www.w3.org/2000/svg"', ""), file).not.toMatch(/https?:\/\/|@import|url\(/);
  });

  it("takes its colours from the theme and covers high contrast and reduced motion", () => {
    const css = source("webview/styles.css");
    for (const token of ["--vscode-foreground", "--vscode-focusBorder", "--vscode-textLink-foreground", "--vscode-testing-iconPassed", "--vscode-editorError-foreground",
      "--vscode-sideBar-background", "--vscode-button-background", "--vscode-input-background"]) {
      expect(css, token).toContain(token);
    }
    expect(css).toContain("vscode-high-contrast");
    expect(css).toContain("prefers-reduced-motion");
    // Colour literals only as fallbacks inside var(…).
    for (const line of css.split("\n").filter((l) => /#[0-9a-f]{3,6}\b|rgba?\(/i.test(l))) expect(line, line).toMatch(/var\(--vscode-[^,]+,[^)]*(#|rgba?\()/i);
  });

  it("keeps the composer usable with a keyboard and an IME", () => {
    const render = source("webview/render.ts");
    for (const s of ["compositionstart", "compositionend", "isComposing", "e.shiftKey", '"Escape"', "aria-label", "aria-live"]) expect(render, s).toContain(s);
  });
});
