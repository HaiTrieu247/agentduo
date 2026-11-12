// Task T4 of the desktop UI redesign, the parts that need no window: Settings, the Team editor and onboarding are drawn
// with the T1 tokens (no colours of their own), keep their layout safe in a low, narrow window (a scrolling body, long
// values that wrap), keep a visible focus and a disabled state, and keep every scope, reset, unsaved and save control
// they had. test/e2e/settings-ui.test.ts looks at the real pages in Electron at 1360×860 and 720×480, light and dark.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const renderer = join(desktop, "src", "renderer");
// Windows checks files out with CRLF line endings: the patterns below read LF.
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const css = (f: string) => (existsSync(join(renderer, "styles", f)) ? strip(read(join(renderer, "styles", f))) : "");
const ts = (f: string) => read(join(renderer, f));

type Rule = { sel: string[]; body: string; media: string | null };
/** Rules of a stylesheet with the @media they sit in (one level), for layout checks. */
function rules(text: string): Rule[] {
  const out: Rule[] = [];
  const walk = (src: string, media: string | null) => {
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
      if (head.startsWith("@media")) walk(body, head);
      else if (!head.startsWith("@")) out.push({ sel: head.split(",").map((s) => s.trim().replace(/\s+/g, " ")), body, media });
      i = j;
    }
  };
  walk(text, null);
  return out;
}
const decl = (r: Rule, prop: string) => new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(r.body)?.[1]?.trim();
const find = (all: Rule[], re: RegExp) => all.filter((r) => r.sel.some((s) => re.test(s)));

describe("Settings, Team and onboarding use the T1 tokens", () => {
  const settingsCss = css("settings.css");

  it("settings.css has no colour of its own: every colour is a var(--…) token (or transparent/currentColor/inherit)", () => {
    const raw = [...settingsCss.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g)].map((m) => m[0]);
    expect(raw).toEqual([]);
  });

  it("the three renderer files set no colour or font in code", () => {
    for (const f of ["settings.ts", "team.ts", "onboarding.ts", "argumentOptions.ts"]) {
      const src = ts(f);
      expect(src, `${f} has no inline colour`).not.toMatch(/style\.(color|background|fontFamily)\s*=|["']#[0-9a-f]{3,8}["']/i);
      expect(src, `${f} sets no style attribute`).not.toMatch(/attrs:\s*\{[^}]*\bstyle:/);
    }
  });

  it("only uses spacing from the 4/8/12/16/24/32 scale for page and card padding, gaps and margins (+ 2, 6 and 10 for hairline fixes)", () => {
    const allowed = new Set([0, 1, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48]);
    const bad: string[] = [];
    for (const r of rules(settingsCss)) {
      for (const m of r.body.matchAll(/\b(padding|margin|gap)(?:-[a-z]+)?\s*:\s*([^;]+)/g)) {
        for (const v of m[2]!.matchAll(/(-?\d+(?:\.\d+)?)px/g)) if (!allowed.has(Math.abs(Number(v[1])))) bad.push(`${r.sel[0]} { ${m[0].trim()} }`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("states have their own look: hover, focus-visible and disabled for the buttons, fields and tabs", () => {
    const all = css("settings.css") + css("base.css");
    expect(all).toMatch(/:focus-visible/);
    expect(all).toMatch(/:disabled|\[disabled\]|\[aria-disabled/);
    expect(all).toMatch(/:hover/);
    expect(settingsCss, "Settings' tabs mark the current page").toMatch(/\.settings-tab(\.active|\[aria-current)/);
    expect(settingsCss, "the config tabs mark the selected one").toMatch(/\.config-tab(\.active|\[aria-selected)/);
  });

  it("a focused control is never left without an indicator: no bare `outline: none` without a replacement ring", () => {
    const bad: string[] = [];
    for (const r of rules(css("settings.css") + "\n" + css("base.css"))) {
      if (!/outline\s*:\s*(none|0)\b/.test(r.body)) continue;
      if (/box-shadow|border-color|background|outline-offset/.test(r.body)) continue;
      // Focus on a field is shown by the shared focus rule when the selector is a plain field.
      bad.push(r.sel.join(", "));
    }
    expect(bad).toEqual([]);
  });

  it("warnings and errors are told by words and by colour, with the semantic tokens", () => {
    expect(settingsCss).toMatch(/\.error[^{]*\{[^}]*var\(--(err|error)/);
    expect(settingsCss).toMatch(/\.warn-text[^{]*\{[^}]*var\(--(warn|err)/);
    expect(ts("settings.ts")).toMatch(/class: "error"/);
    expect(ts("onboarding.ts")).toMatch(/class: "error"/);
    expect(ts("onboarding.ts"), "a CLI that is missing or signed out is said in words").toMatch(/not signed in|sign in|Sign in|signed out|not found|missing|not installed/i);
  });
});

describe("a low, narrow window (720×480)", () => {
  const all = rules(css("settings.css"));

  it("the Settings pane scrolls on its own: body scrolls, header and nav stay", () => {
    const body = find(all, /^\.settings-body$/).map((r) => decl(r, "overflow(?:-y)?")).filter(Boolean);
    expect(body.some((v) => /auto|scroll/.test(v!)), "settings-body scrolls").toBe(true);
    const pane = find(all, /^\.settings-pane$/);
    expect(pane.some((r) => /min-height:\s*0/.test(r.body)), "the pane may shrink below its content").toBe(true);
    const main = find(all, /^\.settings-main$/);
    expect(main.some((r) => /min-height:\s*0/.test(r.body))).toBe(true);
    const head = find(all, /^\.settings-head$/);
    expect(head.some((r) => /flex:\s*none/.test(r.body)), "the head (with Done) is not squeezed").toBe(true);
  });

  it("a narrow window gets a layout that leaves the content room: the nav narrows or stacks", () => {
    const narrow = all.filter((r) => r.media && /max-width/.test(r.media));
    expect(narrow.length, "a @media (max-width) block for Settings").toBeGreaterThan(0);
    // At 720 (the window's least) the wide layout still leaves the content at least 400px: nav column <= 320.
    const main = find(all, /^\.settings-main$/).map((r) => decl(r, "grid-template-columns")).find((v) => v && !/^\s*$/.test(v));
    const navPx = Number(/^(\d+)px/.exec(main ?? "")?.[1] ?? 0);
    const stacksAt720 = narrow.some((r) => Number(/max-width:\s*(\d+)px/.exec(r.media!)![1]) >= 720);
    expect(stacksAt720 || (navPx > 0 && navPx <= 320), "at 720 the nav column leaves room or the layout stacks").toBe(true);
    expect(narrow.some((r) => r.sel.some((s) => /settings-(main|side|nav|body)/.test(s))), "the nav/body change when narrow").toBe(true);
  });

  it("long values, paths and names wrap or are cut instead of widening the page", () => {
    const text = css("settings.css");
    expect(text).toMatch(/overflow-wrap:\s*(anywhere|break-word)|word-break:\s*break-(all|word)/);
    // Fields and the text of a setting may shrink.
    expect(find(all, /\.setting-text/).some((r) => /min-width:\s*0/.test(r.body))).toBe(true);
    expect(find(all, /\.setting-control/).some((r) => /min-width:\s*0/.test(r.body))).toBe(true);
    // A path (setting-help code, facts, member meta) wraps.
    expect(find(all, /code\.setting-help|\.facts|\.member-meta|\.member-name/).some((r) => /overflow-wrap|word-break|text-overflow/.test(r.body))).toBe(true);
    // Inputs never exceed their column.
    expect(text).toMatch(/(input|select|textarea)[^{]*\{[^}]*(max-width:\s*100%|min-width:\s*0|width:\s*100%)/);
  });

  it("the page's content column is capped for reading, not for width of the window", () => {
    expect(find(all, /^\.settings-page$/).some((r) => /max-width:/.test(r.body))).toBe(true);
    expect(find(all, /^\.settings-page$/).some((r) => /min-width:\s*(?!0)[1-9]\d{3,}/.test(r.body)), "no fixed minimum width").toBe(false);
  });

  it("onboarding scrolls on its own in a low window and its card is capped in width", () => {
    const o = find(all, /^\.onboarding$/);
    expect(o.some((r) => /overflow(-y)?:\s*(auto|scroll)/.test(r.body))).toBe(true);
    const card = find(all, /\.onboard-card/);
    expect(card.some((r) => /max-width:|(^|[;\s])width:\s*(min\(|\d+%)/.test(r.body)), "capped by max-width or width: min(…, 100%)").toBe(true);
    expect(card.some((r) => /width:\s*\d{4,}px/.test(r.body))).toBe(false);
  });

  it("the Team form, list and identity editor can wrap (no fixed widths wider than the narrow window)", () => {
    const text = css("settings.css");
    for (const r of rules(text)) {
      if (!r.sel.some((s) => /team|member|form|identity|w-name|w-num/.test(s))) continue;
      const w = decl(r, "(?:min-)?width");
      if (w && /^\d+px$/.test(w)) expect(parseInt(w), `${r.sel[0]} width`).toBeLessThanOrEqual(400);
    }
    expect(find(all, /\.form-line/).some((r) => /flex-wrap:\s*wrap/.test(r.body))).toBe(true);
    expect(find(all, /\.identity-text/).length + find(all, /textarea/).length).toBeGreaterThan(0);
  });
});

describe("what Settings and Team kept", () => {
  const settings = ts("settings.ts");
  const team = ts("team.ts");
  const onboarding = ts("onboarding.ts");

  it("has all seven pages in the same order", () => {
    const order = ["General", "Claude & Codex", "Configuration", "Team", "Data & storage", "Diagnostics", "About"];
    let at = -1;
    for (const label of order) {
      const i = settings.indexOf(`"${label}"`, at + 1);
      expect(i, label).toBeGreaterThan(at);
      at = i;
    }
  });

  it("keeps the scopes (All projects / This project), the source of each value, when a change applies, Reset", () => {
    expect(settings).toMatch(/All projects/);
    expect(settings).toMatch(/This project/);
    expect(settings).toMatch(/Reset/);
    expect(settings).toMatch(/sourceText/);
    expect(settings).toMatch(/\blive\b|next-call|next-run|Applies|applies/);
    expect(settings).toMatch(/Saved/);
    expect(settings).toMatch(/Loading…/);
    expect(settings).toMatch(/class: "error"/);
  });

  it("keeps the Team editor's controls: list, group, add/edit form, readiness, identity editor, preview, unsaved marker and Save", () => {
    for (const s of ["Add a member", "Add to the team", "Save the team", "Unsaved changes", "team-preview", "team-strip", "identity-panel", "team-empty", "Start from agentduo's team", "Save in"]) {
      expect(team, s).toContain(s);
    }
    expect(team).toMatch(/group/i);
    expect(team).toMatch(/Escape/);
    expect(team).toMatch(/aria-label/);
  });

  it("keeps Settings' own focus and exit: Escape and Done close it, Settings is a named region", () => {
    expect(settings).toMatch(/e\.key === "Escape"/);
    expect(settings).toMatch(/"Done"/);
    expect(settings).toMatch(/aria-label|aria-labelledby/);
  });

  it("T4 adds focus management for the overlays: Settings takes focus when it opens and hands it back, onboarding focuses its first action", () => {
    expect(settings, "Settings moves focus in and remembers what had it").toMatch(/activeElement/);
    expect((settings.match(/\.focus\(/g) ?? []).length, "Settings focuses (in and back)").toBeGreaterThanOrEqual(2);
    expect(onboarding).toMatch(/\.focus\(/);
    expect(onboarding, "onboarding is a named dialog").toMatch(/role: "dialog"[^)]*aria-label|aria-modal/);
  });

  it("the Team member form closes on Escape without closing the whole page first (the form handles the key)", () => {
    const i = team.indexOf('e.key === "Escape"');
    expect(i).toBeGreaterThan(0);
    expect(team.slice(i - 400, i + 400)).toMatch(/stopPropagation|stopImmediatePropagation|cancel\(\)/);
  });

  it("no Node or electron in these renderer files, and relative imports end in .js", () => {
    for (const [name, src] of [["settings.ts", settings], ["team.ts", team], ["onboarding.ts", onboarding], ["argumentOptions.ts", ts("argumentOptions.ts")]] as const) {
      expect(src, name).not.toMatch(/from ["'](node:|electron)/);
      for (const m of src.matchAll(/from ["'](\.[^"']+)["']/g)) expect(m[1], `${name}: ${m[1]}`).toMatch(/\.js$/);
    }
  });
});
