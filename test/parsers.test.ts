import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeParser } from "../src/agents/claude.js";
import { CodexParser, unwrapShell } from "../src/agents/codex.js";
import { extractJson, type ParsedEvent, type StreamParser } from "../src/agents/types.js";
import { tempDir } from "./helpers/tmp.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").split("\n").filter(Boolean);
const feedAll = (p: StreamParser, lines: string[]) => lines.flatMap((l) => p.feed(l));
const summary = (events: ParsedEvent[]) => events.map((e) =>
  e.type === "activity" ? `${e.activity.kind}:${e.activity.status}:${e.activity.label}` : `usage:${e.costUsd ?? ""}:${e.tokens ?? ""}`);

describe("CodexParser", () => {
  it("turns a real codex exec --json stream into activities", () => {
    const p = new CodexParser();
    expect(summary(feedAll(p, fixture("codex-stream.jsonl")))).toEqual([
      "say:ok:I’ll read `a.txt`, then run `ls`.",
      "command:running:exec  cat a.txt",
      "command:ok:exec  cat a.txt",
      "command:running:exec  ls",
      "command:ok:exec  ls",
      "submit:ok:submitting result",
      "usage::30295",
    ]);
    expect(p.lastAgentMessage).toBe('{"answer":"hello\\n","n":2}');
  });

  it("marks failed commands, records errors and ignores noise", () => {
    const p = new CodexParser();
    const events = feedAll(p, [
      "not json", "", "[1,2]", "null",
      JSON.stringify({ type: "item.completed", item: { id: "x", type: "command_execution", command: "bash -lc 'npm test'", exit_code: 1, status: "failed" } }),
      JSON.stringify({ type: "turn.failed", error: { message: "boom" } }),
    ]);
    expect(summary(events)).toEqual(["command:error:exec  npm test"]);
    expect(events[0]).toMatchObject({ activity: { exitCode: 1 } });
    expect(p.error).toBe("boom");
  });

  it("unwraps shell wrappers", () => {
    expect(unwrapShell("/bin/zsh -lc 'cat a.txt'")).toBe("cat a.txt");
    expect(unwrapShell("/bin/zsh -lc ls")).toBe("ls");
    expect(unwrapShell("bash -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'");
    expect(unwrapShell("git status")).toBe("git status");
  });
});

describe("ClaudeParser", () => {
  it("turns a real stream-json stream into activities", () => {
    const p = new ClaudeParser("/repo");
    expect(summary(feedAll(p, fixture("claude-stream.jsonl")))).toEqual([
      "think:ok:thinking",
      "read:running:Read  a.txt",
      "command:running:Bash  ls",
      "read:ok:Read  a.txt",
      "command:ok:Bash  ls",
      "submit:running:submitting result",
      "submit:ok:submitting result",
      "usage:0.0847458:",
    ]);
    expect(p.result?.structured_output).toEqual({ answer: "hello", n: 2 });
  });

  it("counts edited lines, marks denials and errors, and ignores noise", () => {
    const p = new ClaudeParser("/repo");
    const events = feedAll(p, [
      "Warning: something printed on stdout", "{broken",
      JSON.stringify({ type: "assistant", uuid: "a", message: { id: "m", content: [
        { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/repo/src/x.ts", old_string: "a\nb", new_string: "a\nb\nc" } },
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "git push\nmore" } },
        { type: "text", text: "Done.\nDetails" },
      ] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true,
        content: "Claude requested permissions to use Bash, but you haven't granted it yet." }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "String not found in file" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.5, permission_denials: [{ tool_name: "Bash", tool_use_id: "t2" }] }),
    ]);
    expect(summary(events)).toEqual([
      "edit:running:Edit  src/x.ts", "command:running:Bash  git push", "say:ok:Done.",
      "command:denied:Bash  git push", "edit:error:Edit  src/x.ts", "usage:0.5:",
    ]);
    expect(events[0]).toMatchObject({ activity: { added: 3, removed: 2 } });
  });
  it("shows repo-relative paths through symlinks and ignores the trailing newline when counting lines", () => {
    const t = tempDir();
    try {
      const real = join(t.path, "real");
      mkdirSync(join(real, "src"), { recursive: true });
      symlinkSync(real, join(t.path, "link"));
      const p = new ClaudeParser(real);
      const events = p.feed(JSON.stringify({ type: "assistant", uuid: "a", message: { content: [
        { type: "tool_use", id: "w", name: "Write", input: { file_path: join(t.path, "link", "src", "new.ts"), content: "a\nb\n" } },
      ] } }));
      expect(events[0]).toMatchObject({ activity: { label: "Write src/new.ts", added: 2 } });
    } finally {
      t.cleanup();
    }
  });
});

describe("extractJson", () => {
  it("handles fences and surrounding prose", () => {
    expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here: {"a": {"b": 2}} done')).toEqual({ a: { b: 2 } });
    expect(() => extractJson("no json here")).toThrow("not valid JSON");
  });
});
