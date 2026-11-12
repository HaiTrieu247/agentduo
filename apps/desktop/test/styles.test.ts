// Task T1 of the desktop UI redesign: the design spec, the split stylesheets, the build that ships them under the page's
// CSP, the saved theme/font settings, the contrast of the colour tokens, and that the new CSS is the desktop's only.
// Written from the acceptance criteria, not the implementation: it reads the CSS the way a browser would (the cascade
// of custom properties) and never names a rule of the new design beyond the token names the old stylesheet already had.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyAppearance, clampFontSize, FONT_RANGE } from "../src/renderer/theme.js";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(desktop, "..", "..");
const renderer = join(desktop, "src", "renderer");
const stylesDir = join(renderer, "styles");
const read = (p: string) => readFileSync(p, "utf8");

const SPLIT = ["tokens.css", "shell.css", "chat.css", "settings.css", "work.css"] as const;
const SPEC = join(root, "docs", "superpowers", "specs", "2026-11-12-desktop-ui-redesign.md");

// ---------- a small CSS reader ----------

type Rule = { selectors: string[]; decls: Map<string, string> };

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every style rule at any depth (inside @media too), with its selectors and declarations, in source order. */
function parseRules(css: string): Rule[] {
  const text = stripComments(css);
  const rules: Rule[] = [];
  const walk = (src: string) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf("{", i);
      if (open < 0) break;
      const head = src.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < src.length && depth) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") depth--;
        j++;
      }
      const body = src.slice(open + 1, j - 1);
      if (head.startsWith("@")) {
        if (/^@(media|supports|layer)/.test(head)) walk(body);
      } else {
        const decls = new Map<string, string>();
        for (const part of body.split(";")) {
          const k = part.indexOf(":");
          if (k > 0) decls.set(part.slice(0, k).trim(), part.slice(k + 1).trim());
        }
        rules.push({ selectors: head.split(",").map((s) => s.trim().replace(/\s+/g, " ")), decls });
      }
      i = j;
    }
  };
  walk(text);
  return rules;
}

/** The desktop stylesheet as one text, in the order the page loads it: styles.css, with its @import files in place. */
function allCss(): string {
  const entry = read(join(renderer, "styles.css"));
  const parts: string[] = [];
  const seen = new Set<string>();
  const include = (file: string, text: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of text.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?[^;]*;/g)) {
      const target = resolve(dirname(file), m[1]);
      if (existsSync(target)) include(target, read(target));
    }
    parts.push(text);
  };
  include(join(renderer, "styles.css"), entry);
  // Split files not imported by styles.css still count as the page's CSS when index.html links them.
  for (const m of read(join(renderer, "index.html")).matchAll(/<link[^>]+href="([^"]+\.css)"/g)) {
    const target = resolve(renderer, m[1]);
    if (existsSync(target)) include(target, read(target));
  }
  return parts.join("\n");
}

/** The value of custom property `name` in a theme ("light" | "dark"), following var() the way the cascade does. */
function themeScope(css: string, theme: "light" | "dark") {
  const rules = parseRules(css);
  const props = new Map<string, string>();
  for (const r of rules) {
    const applies = r.selectors.some((s) => s === ":root" || s === ":root[data-theme]" || s === `:root[data-theme="${theme}"]` || s === `[data-theme="${theme}"]` || s === `html[data-theme="${theme}"]`);
    if (applies) for (const [k, v] of r.decls) if (k.startsWith("--")) props.set(k, v);
  }
  const resolveValue = (v: string, depth = 0): string => {
    if (depth > 12) throw new Error(`var() loop in ${v}`);
    return v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_m, name: string, fallback?: string) => {
      const got = props.get(name);
      if (got !== undefined) return resolveValue(got, depth + 1);
      if (fallback !== undefined) return resolveValue(fallback.trim(), depth + 1);
      throw new Error(`${name} is not defined for the ${theme} theme`);
    });
  };
  return {
    has: (name: string) => props.has(name),
    names: () => [...props.keys()],
    get: (name: string) => {
      const v = props.get(name);
      if (v === undefined) throw new Error(`${name} is not defined for the ${theme} theme`);
      return resolveValue(v);
    },
  };
}

type RGBA = [number, number, number, number];

function parseColor(value: string): RGBA {
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) throw new Error(`bad colour ${value}`);
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  }
  if (v === "transparent") return [0, 0, 0, 0];
  if (v === "white") return [255, 255, 255, 1];
  if (v === "black") return [0, 0, 0, 1];
  throw new Error(`cannot read colour ${value}`);
}

function over(top: RGBA, under: RGBA): RGBA {
  const a = top[3];
  return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
}

function luminance([r, g, b]: RGBA): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fg: RGBA, bg: RGBA): number {
  const l1 = luminance(over(fg, bg));
  const l2 = luminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = ["light", "dark"] as const;

// ---------- the design spec (AC1, AC2, AC3) ----------

describe("the design spec", () => {
  const spec = existsSync(SPEC) ? read(SPEC) : "";

  it("exists at docs/superpowers/specs/2026-11-12-desktop-ui-redesign.md and is not a stub", () => {
    expect(existsSync(SPEC)).toBe(true);
    expect(spec.length).toBeGreaterThan(3000);
  });

  it("has a layout diagram, a catalogue of screens and states, and a token table", () => {
    // A diagram: a fenced block with box-drawing or ASCII frame characters, or a mermaid block.
    const fences = [...spec.matchAll(/```([\w-]*)\n([\s\S]*?)```/g)];
    const hasDiagram = fences.some(([, lang, body]) => lang === "mermaid" || /[┌│└─+|]{3,}/.test(body) || /^\s*[+|].*[+|]\s*$/m.test(body));
    expect(hasDiagram, "a layout diagram in a fenced block").toBe(true);
    expect(/^#{1,4} .*(catalog|danh mục|screens|màn)/im.test(spec), "a catalogue heading").toBe(true);
    expect(/^#{1,4} .*(token)/im.test(spec), "a tokens heading").toBe(true);
    expect(/^\s*\|.*\|\s*$\n^\s*\|[\s:|-]+\|\s*$/m.test(spec), "a markdown table").toBe(true);
  });

  it("catalogues every desktop screen and component the brief names, with its states", () => {
    const text = spec.toLowerCase();
    const screens: Record<string, RegExp> = {
      sidebar: /sidebar|thanh bên/,
      "title bar": /title ?bar|thanh tiêu đề/,
      chat: /\bchat\b/,
      composer: /composer|ô soạn/,
      attachments: /attach|đính kèm/,
      "code block": /code block|khối mã/,
      team: /\bteam\b/,
      "task tracking / inspector": /inspector|theo dõi|run panel|work/,
      settings: /settings|cài đặt/,
      menu: /\bmenu\b/,
      dialog: /dialog|hộp thoại|modal/,
      "question / approval": /question|approval|câu hỏi|phê duyệt/,
      notification: /notice|notification|toast|banner|thông báo/,
      onboarding: /onboarding/,
      update: /update|cập nhật/,
    };
    for (const [name, re] of Object.entries(screens)) expect(re.test(text), `the spec covers ${name}`).toBe(true);
    const states: Record<string, RegExp> = {
      empty: /empty|trống/,
      loading: /loading|đang tải/,
      error: /error|lỗi/,
      hover: /hover/,
      focus: /focus/,
      disabled: /disabled|vô hiệu/,
      selected: /select|chọn/,
      warning: /warn|cảnh báo/,
    };
    for (const [name, re] of Object.entries(states)) expect(re.test(text), `the spec covers the ${name} state`).toBe(true);
  });

  it("names every renderer module that draws a screen", () => {
    const text = spec.toLowerCase();
    for (const mod of ["sidebar", "chat", "team", "settings", "inspector", "onboarding", "update", "usage"]) {
      expect(existsSync(join(renderer, `${mod}.ts`)), `${mod}.ts exists`).toBe(true);
      expect(text.includes(mod), `the spec mentions ${mod}`).toBe(true);
    }
  });

  it("fixes the scale, the reading width and the stylesheet split", () => {
    for (const n of [4, 8, 12, 16, 24, 32]) expect(new RegExp(`\\b${n}\\s*(px)?\\b`).test(spec), `spacing step ${n}`).toBe(true);
    expect(/7[2-8]\s*ch/.test(spec), "a reading width of 72–78ch").toBe(true);
    for (const f of SPLIT) expect(spec.includes(f), `the spec names ${f}`).toBe(true);
    expect(/#191919/i.test(spec) || /#1[789a-f]1[789a-f]1[789a-f]/i.test(spec), "the dark chat background near #191919").toBe(true);
    expect(/4[.,]5/.test(spec), "the 4.5:1 contrast rule").toBe(true);
    expect(/codicon/i.test(spec), "Codicon as the icon set").toBe(true);
  });

  it("lists in its token table every colour token the stylesheet defines", () => {
    const tokens = join(stylesDir, "tokens.css");
    expect(existsSync(tokens)).toBe(true);
    const css = read(tokens);
    const own = new Set<string>();
    for (const r of parseRules(css)) for (const k of r.decls.keys()) if (k.startsWith("--") && !k.startsWith("--vscode-")) own.add(k);
    expect(own.size).toBeGreaterThan(10);
    const missing = [...own].filter((t) => !spec.includes(t));
    expect(missing, "tokens defined in tokens.css but absent from the spec").toEqual([]);
  });
});

// ---------- the split (AC2, AC7) ----------

describe("the stylesheet split", () => {
  it("has styles/tokens.css, shell.css, chat.css, settings.css and work.css", () => {
    expect(existsSync(stylesDir)).toBe(true);
    const have = readdirSync(stylesDir);
    for (const f of SPLIT) expect(have, `styles/${f}`).toContain(f);
  });

  it("keeps in styles.css only the order of imports, the reset and the primitives", () => {
    const entry = read(join(renderer, "styles.css"));
    const imports = [...entry.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?/g)].map((m) => m[1].replace(/^\.\//, ""));
    for (const f of SPLIT) expect(imports.some((i) => i.endsWith(f)), `styles.css imports ${f}`).toBe(true);
    // Tokens come first, so every other file can read them.
    expect(imports.findIndex((i) => i.endsWith("tokens.css"))).toBe(0);
    // @import must precede every rule.
    const firstRule = stripComments(entry).search(/[^@\s][^{;]*\{/);
    const lastImport = Math.max(...[...stripComments(entry).matchAll(/@import[^;]*;/g)].map((m) => m.index! + m[0].length));
    expect(lastImport).toBeLessThanOrEqual(firstRule < 0 ? Infinity : firstRule);
    // The split is real: the entry no longer holds the regions' rules or the themes' tokens.
    expect(entry.split("\n").length).toBeLessThan(250);
    expect(/--bg-side\s*:/.test(entry)).toBe(false);
  });

  it("has no region file that is a stub, and no rule duplicated across files", () => {
    const seen = new Map<string, string>();
    for (const f of SPLIT) {
      const path = join(stylesDir, f);
      if (!existsSync(path)) continue;
      const css = read(path);
      expect(parseRules(css).length, `${f} has rules`).toBeGreaterThan(0);
      for (const r of parseRules(css)) {
        if (f === "tokens.css") continue;
        for (const s of r.selectors) {
          const key = `${s} ${[...r.decls.keys()].sort().join(",")}`;
          const where = seen.get(key);
          expect(where === undefined || where === f, `rule "${s}" appears in both ${where} and ${f}`).toBe(true);
          seen.set(key, f);
        }
      }
    }
  });

  it("still defines the tokens and mappings the reused chat page reads (--vscode-*)", () => {
    const css = allCss();
    for (const theme of THEMES) {
      const scope = themeScope(css, theme);
      for (const name of [
        "--vscode-font-family", "--vscode-font-size", "--vscode-editor-font-family", "--vscode-foreground", "--vscode-descriptionForeground",
        "--vscode-editor-background", "--vscode-widget-border", "--vscode-focusBorder", "--vscode-textLink-foreground", "--vscode-button-background",
        "--vscode-button-foreground", "--vscode-input-background", "--vscode-input-foreground", "--vscode-input-border", "--vscode-menu-background",
        "--vscode-menu-foreground", "--vscode-badge-background", "--vscode-list-activeSelectionBackground", "--vscode-editorError-foreground",
        "--vscode-editorWarning-foreground",
      ]) {
        expect(scope.has(name), `${name} in the ${theme} theme`).toBe(true);
        expect(() => scope.get(name), `${name} resolves in ${theme}`).not.toThrow();
      }
    }
  });

  it("keeps the layout hooks main.ts toggles (platform-darwin, narrow, resizing) and the saved font size", () => {
    const css = allCss();
    expect(/body\.platform-darwin/.test(css)).toBe(true);
    expect(/body\.narrow/.test(css)).toBe(true);
    expect(/body\.resizing/.test(css)).toBe(true);
    expect(/var\(\s*--font-size/.test(css), "text size follows --font-size, which the saved setting sets").toBe(true);
    for (const t of THEMES) expect(themeScope(css, t).get("--vscode-font-size")).toBe(themeScope(css, t).get("--font-size"));
  });

  it("uses only custom properties that some theme defines (no var(--x) with nothing behind it)", () => {
    const css = allCss();
    const defined = new Set<string>();
    for (const r of parseRules(css)) for (const k of r.decls.keys()) if (k.startsWith("--")) defined.add(k);
    const bad = new Set<string>();
    for (const m of stripComments(css).matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) if (!m[2] && !defined.has(m[1])) bad.add(m[1]);
    // Names the chat page (webview.css) or the code sets from outside are the VS Code ones and --font-size / sizes set by main.ts.
    const outside = [...bad].filter((n) => !n.startsWith("--vscode-") && !/^--(sidebar-w|inspector-w|font-size)$/.test(n));
    expect(outside).toEqual([]);
  });
});

// ---------- the build under the CSP (AC7) ----------

describe("the build", () => {
  it("ships every stylesheet the page loads, and the page loads them under its CSP", () => {
    execFileSync(process.execPath, [join(desktop, "scripts", "build.mjs"), "--only", "renderer"], { cwd: desktop, stdio: "pipe" });
    const out = join(desktop, "dist", "renderer");
    const html = read(join(out, "index.html"));
    const csp = /Content-Security-Policy"\s+content="([^"]+)"/.exec(html)![1];
    expect(csp).toContain("style-src 'self'");
    expect(csp, "the CSP is not loosened for the new styles").not.toMatch(/unsafe-inline|unsafe-eval|style-src[^;]*(https?:|\*)/);
    expect(html, "no inline <style> under style-src 'self'").not.toMatch(/<style[\s>]/i);
    expect(html, "no style attribute in the page").not.toMatch(/\sstyle="/i);

    const loaded = new Set<string>();
    const visit = (file: string) => {
      if (loaded.has(file)) return;
      expect(existsSync(file), `${file} is in dist/renderer`).toBe(true);
      loaded.add(file);
      const css = read(file);
      expect(css, `${file} points at no remote file`).not.toMatch(/url\(\s*["']?https?:|@import\s+(?:url\(\s*)?["']?https?:/i);
      for (const m of css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?/g)) visit(resolve(dirname(file), m[1]));
      for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
        if (/^(data:|#)/.test(m[1])) continue;
        expect(existsSync(resolve(dirname(file), m[1].split(/[?#]/)[0])), `${m[1]} (url() in ${file}) is shipped`).toBe(true);
      }
    };
    for (const m of html.matchAll(/<link[^>]+href="([^"]+)"/g)) visit(join(out, m[1]));
    for (const f of SPLIT) expect([...loaded].some((p) => p.endsWith(join("styles", f)) || p.endsWith(f)), `${f} is loaded by the page`).toBe(true);
  }, 120_000);

  it("keeps the build's own guards (no Node in the renderer)", () => {
    expect(read(join(desktop, "scripts", "build.mjs"))).toContain("the renderer bundle imports Node");
  });
});

// ---------- the saved theme and font size (AC3, AC5) ----------

describe("theme and font size", () => {
  function fakeDoc() {
    const classes = new Set<string>();
    const props: Record<string, string> = {};
    const doc = {
      documentElement: { dataset: {} as Record<string, string>, style: { setProperty: (k: string, v: string) => (props[k] = v), colorScheme: "" } },
      body: { classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) } },
    };
    return { doc: doc as unknown as Document, classes, props };
  }

  it("applies system, light and dark on the document, with the colour scheme and the VS Code class", () => {
    const cases = [
      { theme: "system", dark: true, want: "dark" },
      { theme: "system", dark: false, want: "light" },
      { theme: "light", dark: true, want: "light" },
      { theme: "dark", dark: false, want: "dark" },
    ] as const;
    for (const c of cases) {
      const { doc, classes } = fakeDoc();
      expect(applyAppearance({ theme: c.theme, dark: c.dark, fontSize: 13 }, doc)).toBe(c.want);
      expect(doc.documentElement.dataset.theme).toBe(c.want);
      expect(doc.documentElement.style.colorScheme).toBe(c.want);
      expect(classes.has("vscode-dark")).toBe(c.want === "dark");
      expect(classes.has("vscode-light")).toBe(c.want === "light");
    }
  });

  it("applies the saved font size, clamped to the supported range", () => {
    for (const [given, want] of [[13, 13], [16, 16], [1, FONT_RANGE.min], [99, FONT_RANGE.max], [Number.NaN, FONT_RANGE.default], ["big", FONT_RANGE.default], [14.6, 15]] as const) {
      const { doc, props } = fakeDoc();
      applyAppearance({ theme: "dark", dark: true, fontSize: given as number }, doc);
      expect(props["--font-size"]).toBe(`${want}px`);
      expect(clampFontSize(given)).toBe(want);
    }
  });

  it("is idempotent: applying the same appearance twice changes nothing", () => {
    const { doc, classes, props } = fakeDoc();
    applyAppearance({ theme: "light", dark: false, fontSize: 15 }, doc);
    const snapshot = JSON.stringify([...classes, props]);
    applyAppearance({ theme: "light", dark: false, fontSize: 15 }, doc);
    expect(JSON.stringify([...classes, props])).toBe(snapshot);
  });

  it("styles both themes through [data-theme], so every saved choice has its colours", () => {
    const css = allCss();
    for (const theme of THEMES) {
      const scope = themeScope(css, theme);
      for (const t of ["--bg", "--bg-side", "--fg", "--fg-muted", "--line"]) expect(scope.has(t), `${t} in ${theme}`).toBe(true);
    }
  });
});

// ---------- the palette (AC1, AC3) ----------

describe("the palette", () => {
  const css = allCss();

  it("defines the same colour tokens in the light and the dark theme", () => {
    const own = (theme: "light" | "dark") => {
      const names = new Set<string>();
      for (const r of parseRules(css)) {
        if (r.selectors.some((s) => s === `:root[data-theme="${theme}"]` || s === `[data-theme="${theme}"]` || s === `html[data-theme="${theme}"]`)) for (const k of r.decls.keys()) if (k.startsWith("--")) names.add(k);
      }
      return names;
    };
    const light = own("light");
    const dark = own("dark");
    expect([...light].filter((n) => !dark.has(n)), "only in light").toEqual([]);
    expect([...dark].filter((n) => !light.has(n)), "only in dark").toEqual([]);
  });

  it("follows the reference: a near-#191919 dark chat on a warm dark sidebar, a white light chat on a warm grey sidebar", () => {
    const dark = themeScope(css, "dark");
    const light = themeScope(css, "light");
    const [r, g, b] = parseColor(dark.get("--bg"));
    for (const c of [r, g, b]) expect(Math.abs(c - 0x19)).toBeLessThanOrEqual(12);
    const [sr, , sb] = parseColor(dark.get("--bg-side"));
    expect(luminance(parseColor(dark.get("--bg-side"))), "the dark sidebar differs from the chat").not.toBe(luminance([r, g, b, 1]));
    expect(sr, "the dark sidebar is warm (red ≥ blue)").toBeGreaterThanOrEqual(sb);
    expect(parseColor(light.get("--bg")).slice(0, 3)).toEqual([255, 255, 255]);
    const [lr, , lb] = parseColor(light.get("--bg-side"));
    expect(lr, "the light sidebar is warm (red ≥ blue)").toBeGreaterThanOrEqual(lb);
    expect(luminance(parseColor(light.get("--bg-side")))).toBeLessThan(1);
  });

  const SURFACES = ["--bg", "--bg-side", "--bg-elev", "--bg-input"];
  const TEXT = ["--fg", "--fg-muted", "--accent-c", "--ok-c", "--warn-c", "--err-c"];

  for (const theme of THEMES) {
    it(`gives normal text at least 4.5:1 on every surface in the ${theme} theme (primary, secondary, accent, ok, warning, error)`, () => {
      const scope = themeScope(css, theme);
      const failures: string[] = [];
      for (const surface of SURFACES) {
        const bg = over(parseColor(scope.get(surface)), parseColor(scope.get("--bg")));
        for (const t of TEXT) {
          const ratio = contrast(parseColor(scope.get(t)), bg);
          if (ratio < 4.5) failures.push(`${t} on ${surface}: ${ratio.toFixed(2)}:1`);
        }
      }
      expect(failures).toEqual([]);
    });

    it(`gives the buttons' text at least 4.5:1 on the button in the ${theme} theme (primary, secondary, hover) and the placeholders on inputs`, () => {
      const scope = themeScope(css, theme);
      const page = parseColor(scope.get("--bg"));
      const pairs: [string, string, string][] = [
        ["--vscode-button-foreground", "--vscode-button-background", "primary button"],
        ["--vscode-button-foreground", "--vscode-button-hoverBackground", "primary button on hover"],
        ["--vscode-button-secondaryForeground", "--vscode-button-secondaryBackground", "secondary button"],
        ["--vscode-button-secondaryForeground", "--vscode-button-secondaryHoverBackground", "secondary button on hover"],
        ["--vscode-input-foreground", "--vscode-input-background", "input text"],
        ["--vscode-input-placeholderForeground", "--vscode-input-background", "placeholder"],
        ["--vscode-menu-foreground", "--vscode-menu-background", "menu"],
        ["--vscode-menu-selectionForeground", "--vscode-menu-selectionBackground", "selected menu row"],
        ["--vscode-list-activeSelectionForeground", "--vscode-list-activeSelectionBackground", "selected list row"],
        ["--vscode-badge-foreground", "--vscode-badge-background", "badge"],
        ["--vscode-statusBarItem-errorForeground", "--vscode-statusBarItem-errorBackground", "error chip"],
        ["--vscode-textLink-foreground", "--vscode-editor-background", "link"],
        ["--vscode-descriptionForeground", "--vscode-editor-background", "description text"],
        ["--vscode-descriptionForeground", "--vscode-sideBar-background", "description text in the sidebar"],
        ["--vscode-editorError-foreground", "--vscode-editor-background", "error text"],
        ["--vscode-editorWarning-foreground", "--vscode-editor-background", "warning text"],
      ];
      const failures: string[] = [];
      for (const [fg, bg, label] of pairs) {
        if (!scope.has(fg) || !scope.has(bg)) continue;
        const under = over(parseColor(scope.get(bg)), page);
        const ratio = contrast(parseColor(scope.get(fg)), under);
        if (ratio < 4.5) failures.push(`${label}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
      }
      expect(failures).toEqual([]);
    });

    it(`keeps the focus ring and the separators visible against the surfaces in the ${theme} theme`, () => {
      const scope = themeScope(css, theme);
      const page = parseColor(scope.get("--bg"));
      // A focus indicator is a graphic: WCAG asks 3:1.
      for (const surface of ["--bg", "--bg-side", "--bg-input"]) {
        const bg = over(parseColor(scope.get(surface)), page);
        expect(contrast(parseColor(scope.get("--vscode-focusBorder")), bg), `focus ring on ${surface}`).toBeGreaterThanOrEqual(3);
      }
      // Separators stay gentle (the reference's light lines) yet are not the surface itself.
      const line = over(parseColor(scope.get("--line")), page);
      expect(contrast(line, page)).toBeGreaterThan(1.05);
      expect(contrast(line, page), "a separator is a light line, not a hard border").toBeLessThan(3);
    });
  }
});

// ---------- the new CSS is the desktop's only (AC2, constraint: not the CLI or the extension) ----------

describe("desktop-only", () => {
  const html = read(join(renderer, "index.html"));

  it("marks the desktop on body, in the page itself (so the CSS needs no script to know where it is)", () => {
    const body = /<body([^>]*)>/i.exec(html)![1];
    expect(/class="[^"]*\bdesktop\b[^"]*"|data-[\w-]*(app|shell|desktop)[\w-]*=|data-desktop/i.test(body), `a desktop marker on <body${body}>`).toBe(true);
  });

  it("is loaded by the desktop page alone: webview.css, the extension and the CLI do not touch styles/", () => {
    const webviewCss = read(join(root, "packages", "webview", "src", "styles.css"));
    for (const f of SPLIT) expect(webviewCss.includes(f)).toBe(false);
    expect(/body\.desktop|data-desktop/.test(webviewCss), "the shared chat styles do not know the desktop").toBe(false);
    const sharedRoots = [join(root, "apps", "vscode"), join(root, "apps", "cli", "src"), join(root, "packages", "webview", "src")];
    const offenders: string[] = [];
    const scan = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "dist" || e.name === "out") continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) scan(p);
        else if (/\.(ts|tsx|css|html|json|mjs)$/.test(e.name) && /apps[\\/]desktop[\\/]src[\\/]renderer[\\/]styles/.test(read(p))) offenders.push(p);
      }
    };
    for (const d of sharedRoots) if (existsSync(d)) scan(d);
    expect(offenders).toEqual([]);
  });

  it("does not restyle the chat page with unscoped element rules in the desktop's own files", () => {
    // Rules in the region files must be reachable only inside the desktop page; a bare `button {}` or `body {}` in
    // shell/chat/settings/work would change every reused component at once. Primitives belong to styles.css.
    const offenders: string[] = [];
    for (const f of ["shell.css", "chat.css", "settings.css", "work.css"]) {
      const path = join(stylesDir, f);
      if (!existsSync(path)) continue;
      for (const r of parseRules(read(path))) for (const s of r.selectors) if (/^(html|body|button|input|textarea|select|a|\*)$/i.test(s)) offenders.push(`${f}: ${s}`);
    }
    expect(offenders).toEqual([]);
  });
});
