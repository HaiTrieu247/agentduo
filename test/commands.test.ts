import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMANDS, complete, helpText, parseInput, parsePathArg, tokenize } from "../src/core/commands.js";

describe("commands: reading a line", () => {
  it("sends plain text to the recipient, and /claude or /codex with words to that agent", () => {
    expect(parseInput("   ")).toEqual({ kind: "empty" });
    expect(parseInput("what does this repo do?")).toEqual({ kind: "message", text: "what does this repo do?" });
    expect(parseInput("/claude explain src/chat.ts")).toEqual({ kind: "ask", backend: "claude", text: "explain src/chat.ts", hint: null });
    expect(parseInput("/codex")).toEqual({ kind: "recipient", backend: "codex" });
    expect(parseInput("/claude")).toEqual({ kind: "recipient", backend: "claude" });
  });

  it("takes questions that start with a setting's name as questions, word for word, flags included", () => {
    for (const [line, backend, text] of [
      ["/claude model nào phù hợp nhất cho repo này?", "claude", "model nào phù hợp nhất cho repo này?"],
      ["/claude effort là gì?", "claude", "effort là gì?"],
      ["/claude permissions nào cần?", "claude", "permissions nào cần?"],
      ["/codex model nào tốt hơn?", "codex", "model nào tốt hơn?"],
      ["/codex model which is better for refactoring?", "codex", "model which is better for refactoring?"],
      ["/claude model should I pick --save", "claude", "model should I pick --save"],
      ["/codex permissions what does --yes do", "codex", "permissions what does --yes do"],
    ] as const) {
      const parsed = parseInput(line);
      expect(parsed, line).toMatchObject({ kind: "ask", backend, text });
      expect(parsed.kind === "ask" && parsed.hint, line).toContain("/settings");
    }
  });

  it("forces a question with --", () => {
    expect(parseInput("/claude -- model opus")).toEqual({ kind: "ask", backend: "claude", text: "model opus", hint: null });
    expect(parseInput("/codex -- permissions auto")).toEqual({ kind: "ask", backend: "codex", text: "permissions auto", hint: null });
  });

  it("keeps the shortcuts whose words fit a setting exactly", () => {
    expect(parseInput("/claude model opus")).toEqual({ kind: "setting", setting: { target: "claude.model", model: "opus" }, save: false, yes: false });
    expect(parseInput("/claude model default --save")).toEqual({ kind: "setting", setting: { target: "claude.model", model: null }, save: true, yes: false });
    expect(parseInput("/claude model")).toMatchObject({ kind: "setting", setting: { target: "claude.model" } });
    expect(parseInput("/claude effort high")).toMatchObject({ kind: "setting", setting: { target: "claude.effort", effort: "high" } });
    expect(parseInput("/claude permissions allow Bash(npm test:*)")).toMatchObject({
      kind: "setting", setting: { target: "claude.permissions", rule: { kind: "allow", rule: "Bash(npm test:*)" } },
    });
    expect(parseInput('/claude add-dir "/tmp/my dir"')).toMatchObject({ kind: "setting", setting: { target: "claude.add-dir", dir: "/tmp/my dir" } });
    expect(parseInput("/codex model gpt-5.5 high")).toMatchObject({ kind: "setting", setting: { target: "codex.model", model: "gpt-5.5", effort: "high" } });
    expect(parseInput("/codex model gpt-5.5")).toMatchObject({ kind: "setting", setting: { target: "codex.model", model: "gpt-5.5", effort: null } });
    expect(parseInput("/codex permissions full-access --yes")).toEqual({ kind: "setting", setting: { target: "codex.permissions", preset: "full-access" }, save: false, yes: true });
  });

  it("gives /settings, the canonical form, a usage instead of a question when it does not fit", () => {
    expect(parseInput("/settings claude model opus")).toMatchObject({ kind: "setting", setting: { target: "claude.model", model: "opus" } });
    expect(parseInput("/settings codex permissions auto --save")).toMatchObject({ kind: "setting", save: true });
    expect(parseInput("/settings mode auto")).toMatchObject({ kind: "setting", setting: { target: "mode", mode: "auto" } });
    expect(parseInput("/settings claude effort extreme")).toEqual({ kind: "usage", text: expect.stringContaining("/settings claude effort") });
    expect(parseInput("/settings codex nope")).toEqual({ kind: "usage", text: expect.stringContaining("/settings codex model|permissions") });
    expect(parseInput("/settings gemini model x")).toMatchObject({ kind: "usage" });
    expect(parseInput("/settings")).toEqual({ kind: "command", name: "config", arg: "" });
  });

  it("asks for a task after /pipeline, and knows the chat's own commands", () => {
    expect(parseInput("/pipeline Add JWT auth")).toEqual({ kind: "pipeline", task: "Add JWT auth" });
    expect(parseInput("/pipeline")).toMatchObject({ kind: "usage" });
    expect(parseInput("/discuss Redis or Postgres for the queue?")).toEqual({ kind: "discuss", question: "Redis or Postgres for the queue?" });
    expect(parseInput("/discuss")).toMatchObject({ kind: "usage" });
    expect(parseInput("/resume keep it short")).toEqual({ kind: "command", name: "resume", arg: "keep it short" });
    expect(parseInput("/exit")).toEqual({ kind: "command", name: "quit", arg: "" });
    expect(parseInput("/frobnicate")).toEqual({ kind: "unknown", name: "/frobnicate" });
    expect(parseInput("/mode acceptEdits --save")).toEqual({ kind: "setting", setting: { target: "mode", mode: "acceptEdits" }, save: true, yes: false });
    expect(parseInput("/mode")).toEqual({ kind: "setting", setting: { target: "mode" }, save: false, yes: false });
    expect(parseInput("/mode plan")).toEqual({ kind: "usage", text: "usage: /mode manual|acceptEdits|auto" });
    // /edits auto meant acceptEdits; it is gone rather than taken as the broader auto.
    expect(parseInput("/edits auto")).toEqual({ kind: "unknown", name: "/edits" });
  });

  it("keeps a quoted path in one word", () => {
    expect(tokenize(`add-dir "a b" 'c d' e`).map((t) => t.text)).toEqual(["add-dir", "a b", "c d", "e"]);
  });
});

describe("commands: completion", () => {
  it("lists every command for /, filtered as it is typed, each with what it does", () => {
    expect(complete("/").map((c) => c.insert)).toEqual(COMMANDS.map((c) => `${c.name}${c.args ? " " : ""}`));
    for (const c of complete("/")) expect(c.description.length, c.label).toBeGreaterThan(5);
    expect(complete("/p").map((c) => c.insert)).toEqual(["/pipeline ", "/plan"]);
    expect(complete("/cl").map((c) => c.insert)).toEqual(["/claude "]);
    expect(complete("/di").map((c) => c.insert)).toEqual(["/discuss ", "/diff"]);
    expect(complete("hello")).toEqual([]);
    expect(complete("/zzz")).toEqual([]);
  });

  it("suggests an agent's settings, saying a shortcut is a setting only when its words fit", () => {
    const words = complete("/claude ");
    expect(words[0]).toMatchObject({ insert: null, label: "<question>" });
    expect(words.map((c) => c.label)).toEqual(expect.arrayContaining(["--", "model", "effort", "permissions", "add-dir"]));
    expect(words.find((c) => c.label === "model")!.description).toContain("fit it exactly");
    expect(complete("/settings claude e").map((c) => c.insert)).toEqual(["/settings claude effort "]);
    expect(complete("/settings claude effort ").map((c) => c.label)).toEqual(["low", "medium", "high", "xhigh", "max", "default"]);
    expect(complete("/codex model gpt-5.5 h").map((c) => c.insert)).toEqual(["/codex model gpt-5.5 high"]);
    expect(complete("/codex permissions ").map((c) => c.label)).toEqual(["read-only", "auto", "full-access", "default"]);
    expect(complete("/mode ").map((c) => c.label)).toEqual(["manual", "acceptEdits", "auto"]);
    expect(complete("/mode ")[1]!.description).toContain("Edit automatically");
    expect(complete("/settings mode a").map((c) => c.insert)).toEqual(["/settings mode acceptEdits", "/settings mode auto"]);
    expect(complete("/claude model nào ")).toEqual([]);
  });

  it("puts every usage and its description on one line in /help", () => {
    for (const line of helpText().split("\n").filter((l) => l.trimStart().startsWith("/"))) expect(line.trim(), line).toMatch(/^\S+(?: \S+)*\s{2,}\S/);
  });
});

describe("/attach, /attachments, /detach", () => {
  it("read one path as a shell reads one word, with no expansion of its own", () => {
    const path = (s: string) => parsePathArg(s);
    expect(path("screenshots/bug.png")).toEqual({ path: "screenshots/bug.png", home: false });
    expect(path("'My notes.pdf'")).toEqual({ path: "My notes.pdf", home: false });
    expect(path('"My notes.pdf"')).toEqual({ path: "My notes.pdf", home: false });
    expect(path("My\\ notes.pdf")).toEqual({ path: "My notes.pdf", home: false });
    expect(path("/Users/me/Screen\\ Shot\\ 2026-10-29\\ at\\ 10.00.png")).toEqual({ path: "/Users/me/Screen Shot 2026-10-29 at 10.00.png", home: false });
    // A literal ' : in double quotes, or the shell's '\'' ; 'it''s' is two quoted parts, as in a shell.
    expect(path(`"it's.txt"`)).toEqual({ path: "it's.txt", home: false });
    expect(path(`'it'\\''s.txt'`)).toEqual({ path: "it's.txt", home: false });
    expect(path(`'it''s.txt'`)).toEqual({ path: "its.txt", home: false });
    expect(path(`"a \\"b\\" \\$HOME \\\\ \\x.txt"`)).toEqual({ path: 'a "b" $HOME \\ \\x.txt', home: false });
    expect(path(`'C:\\Users\\me\\a.txt'`)).toEqual({ path: "C:\\Users\\me\\a.txt", home: false });
    expect(path("~/Desktop/a.png")).toEqual({ path: "/Desktop/a.png", home: true });
    expect(path("~")).toEqual({ path: "", home: true });
    // Unlike a shell, ~/ is home inside quotes too, as people write it; \~ and ./~ name a folder called ~.
    expect(path('"~/Desktop/My notes.pdf"')).toEqual({ path: "/Desktop/My notes.pdf", home: true });
    expect(path("'~/a.png'")).toEqual({ path: "/a.png", home: true });
    expect(path('~/Desktop/"My notes.pdf"')).toEqual({ path: "/Desktop/My notes.pdf", home: true });
    expect(path("\\~/a.png")).toEqual({ path: "~/a.png", home: false });
    expect(path("./~/a.png")).toEqual({ path: "./~/a.png", home: false });
    expect(path("~user/a.png")).toEqual({ path: "~user/a.png", home: false });
    expect(path("''")).toEqual({ error: "no path" });
    expect(path("$HOME/*.png")).toEqual({ path: "$HOME/*.png", home: false });
    // Unicode as typed: an NFD name stays NFD.
    const nfd = "Ca\u0301ch du\u0300ng.pdf";
    expect(path(`"${nfd}"`)).toEqual({ path: nfd, home: false });
    expect(path("a.png b.png")).toEqual({ error: expect.stringMatching(/one path at a time/) });
    expect(path("'open")).toEqual({ error: "a ' is not closed" });
    expect(path('"open')).toEqual({ error: 'a " is not closed' });
  });

  it("parse as commands, leaving the settings' words as they were", () => {
    expect(parseInput("/attach 'a b.png'")).toEqual({ kind: "attach", path: "a b.png", home: false });
    expect(parseInput("/attach")).toEqual({ kind: "usage", text: expect.stringMatching(/^usage: \/attach <path>/) });
    expect(parseInput("/attach a b")).toEqual({ kind: "usage", text: expect.stringMatching(/^one path at a time/) });
    expect(parseInput("/attachments")).toEqual({ kind: "command", name: "attachments", arg: "" });
    expect(parseInput("/detach 2")).toEqual({ kind: "detach", target: "2" });
    expect(parseInput("/detach all")).toEqual({ kind: "detach", target: "all" });
    expect(parseInput("/detach")).toEqual({ kind: "usage", text: expect.stringMatching(/^usage: \/detach/) });
    expect(parseInput('/claude add-dir "My Dir"')).toEqual({ kind: "setting", setting: { target: "claude.add-dir", dir: "My Dir" }, save: false, yes: false });
    expect(tokenize(`it's "a b"`).map((t) => t.text)).toEqual(["it's", "a b"]);
    expect(complete("/att").map((c) => c.insert)).toEqual(["/attach ", "/attachments"]);
    expect(complete("/detach ").map((c) => c.label)).toEqual(["<n>", "all"]);
  });

  it("read every example the usage line and the READMEs give as the file they name", () => {
    const usageLine = parseInput("/attach");
    if (usageLine.kind !== "usage") throw new Error("no usage line");
    const readme = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    // A word: quoted, or up to a space that is not escaped (or the end of a code span, or a comma).
    const examples = (text: string) => [...text.matchAll(/\/attach (?:"[^"]*"|(?:\\ |[^\s`,])+)/g)].map((m) => m[0]).filter((e) => !e.includes("<"));
    const fromUsage = examples(usageLine.text);
    expect(fromUsage).toEqual(["/attach screenshots/bug.png", '/attach "~/Desktop/My notes.pdf"']);
    const fromDocs = [...examples(readme("README.md")), ...examples(readme("docs/README.vi.md"))];
    expect(fromDocs).toEqual(['/attach "~/Desktop/My notes.pdf"', "/attach shots/bug\\ 2.png", '/attach "~/Desktop/Ghi chú.pdf"', "/attach shots/loi\\ 2.png"]);
    const read = Object.fromEntries([...fromUsage, ...fromDocs].map((e) => [e, parseInput(e)]));
    expect(read).toEqual({
      "/attach screenshots/bug.png": { kind: "attach", path: "screenshots/bug.png", home: false },
      '/attach "~/Desktop/My notes.pdf"': { kind: "attach", path: "/Desktop/My notes.pdf", home: true },
      "/attach shots/bug\\ 2.png": { kind: "attach", path: "shots/bug 2.png", home: false },
      '/attach "~/Desktop/Ghi chú.pdf"': { kind: "attach", path: "/Desktop/Ghi chú.pdf", home: true },
      "/attach shots/loi\\ 2.png": { kind: "attach", path: "shots/loi 2.png", home: false },
    });
  });
});
