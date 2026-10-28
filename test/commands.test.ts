import { describe, expect, it } from "vitest";
import { COMMANDS, complete, helpText, parseInput, tokenize } from "../src/core/commands.js";

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
    expect(parseInput("/settings edits auto")).toMatchObject({ kind: "setting", setting: { target: "edits", mode: "auto" } });
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
    expect(parseInput("/edits sometimes")).toMatchObject({ kind: "usage" });
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
    expect(complete("/edits ").map((c) => c.label)).toEqual(["auto", "ask"]);
    expect(complete("/claude model nào ")).toEqual([]);
  });

  it("puts every usage and its description on one line in /help", () => {
    for (const line of helpText().split("\n").filter((l) => l.trimStart().startsWith("/"))) expect(line.trim(), line).toMatch(/^\S+(?: \S+)*\s{2,}\S/);
  });
});
