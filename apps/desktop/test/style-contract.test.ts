// The design's own rules for the renderer's stylesheet, beside QA's acceptance tests (styles.test.ts): styles.css is
// only the areas' imports, each once, in cascade order; the page links the stylesheets in order; the areas draw with
// tokens only, every variable they read is defined, and no token takes a name of the shared chat styles; and text
// keeps 4.5:1 (WCAG 2) on the surfaces styles.test.ts does not measure: the raised surface, the selection and hover
// overlays, and the semantic tints. Design: docs/superpowers/specs/2026-11-12-desktop-ui-redesign.md.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const root = join(desktop, "..", "..");
const renderer = join(desktop, "src", "renderer");
const read = (...p: string[]) => readFileSync(join(renderer, ...p), "utf8");
const AREAS = ["tokens", "base", "shell", "chat", "work", "settings"];
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the first block whose selector is exactly `selector`. */
function block(css: string, selector: string): Map<string, string> {
  const body = withoutComments(css).split(`${selector} {`)[1]?.split("}")[0];
  if (body === undefined) throw new Error(`no ${selector} block`);
  return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

type Rgb = [number, number, number];
function color(value: string, under?: Rgb): Rgb {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) as Rgb;
  const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(value);
  if (!rgba || !under) throw new Error(`cannot read the colour ${value}`);
  const a = Number(rgba[4]);
  return [1, 2, 3].map((i, k) => Math.round(Number(rgba[i]) * a + under[k]! * (1 - a))) as Rgb;
}
const channel = (c: number) => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a: Rgb, b: Rgb) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };

describe("the stylesheet's files", () => {
  it("styles.css imports every area exactly once, in cascade order, and holds no rule of its own", () => {
    const entry = withoutComments(read("styles.css")).trim();
    const imports = [...entry.matchAll(/@import url\("styles\/([\w-]+)\.css"\);/g)].map((m) => m[1]);
    expect(imports).toEqual(AREAS);
    expect(entry.replace(/@import url\("[^"]+"\);/g, "").trim()).toBe("");
    expect(readdirSync(join(renderer, "styles")).filter((f) => f.endsWith(".css")).sort()).toEqual(AREAS.map((a) => `${a}.css`).sort());
  });

  it("the page links the icons, the shared chat styles, then the desktop's, in that order", () => {
    const links = [...read("index.html").matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
    expect(links).toEqual(["codicon.css", "webview.css", "styles.css"]);
  });
});

describe("tokens", () => {
  const tokens = read("styles", "tokens.css");

  it("every variable the areas read is defined by one of them", () => {
    const all = AREAS.map((a) => read("styles", `${a}.css`)).join("\n");
    const defined = new Set([...withoutComments(all).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...all.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
    expect([...used].filter((v) => !defined.has(v))).toEqual([]);
  });

  it("takes none of the names the shared chat styles define for themselves", () => {
    const webview = readFileSync(join(root, "packages", "webview", "src", "styles.css"), "utf8");
    const theirs = new Set([...withoutComments(webview).matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]));
    const ours = [...withoutComments(tokens).matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]).filter((v) => !v!.startsWith("--vscode-"));
    expect(ours.filter((v) => theirs.has(v))).toEqual([]);
  });

  it("the areas draw with tokens only: no colour of their own", () => {
    for (const a of AREAS.filter((x) => x !== "tokens")) {
      const css = withoutComments(read("styles", `${a}.css`));
      expect(css.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/gi), a).toBeNull();
    }
  });

  describe.each([["light"], ["dark"]] as const)("%s", (theme) => {
    const t = block(tokens, `:root[data-theme="${theme}"]`);
    const v = (name: string) => { const x = t.get(name); if (!x) throw new Error(`no ${name}`); return x; };
    const bg = color(v("--bg"));
    const side = color(v("--bg-side"));
    // The surfaces styles.test.ts does not measure: overlays as they sit on the sidebar and the chat, the raised one.
    const surfaces: Record<string, Rgb> = {
      "--bg-raised": color(v("--bg-raised")),
      "--select-bg on --bg-side": color(v("--select-bg"), side),
      "--select-bg on --bg": color(v("--select-bg"), bg),
      "--hover-bg on --bg-side": color(v("--hover-bg"), side),
      "--hover-bg on --bg": color(v("--hover-bg"), bg),
      "--ok-bg on --bg": color(v("--ok-bg"), bg),
      "--warn-bg on --bg": color(v("--warn-bg"), bg),
      "--err-bg on --bg": color(v("--err-bg"), bg),
    };

    it.each(["--fg", "--fg-muted", "--accent-c", "--ok-c", "--warn-c", "--err-c"])("%s reads at 4.5:1 or more on the raised surface, the overlays and the tints", (fg) => {
      const low = Object.entries(surfaces).map(([s, under]) => [s, contrast(color(v(fg)), under).toFixed(2)] as const).filter(([, r]) => Number(r) < 4.5);
      expect(low).toEqual([]);
    });

    it("the placeholder reads at 4.5:1 in the composer (raised) and on the page", () => {
      for (const under of [surfaces["--bg-raised"]!, bg]) expect(contrast(color(v("--fg-placeholder")), under)).toBeGreaterThanOrEqual(4.5);
    });

    it("the focus ring stands out at 3:1 on the raised surface and the overlays", () => {
      for (const under of Object.values(surfaces)) expect(contrast(color(v("--focus-c")), under)).toBeGreaterThanOrEqual(3);
    });
  });
});
