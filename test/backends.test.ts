import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeBackend, ClaudeParser } from "../src/agents/claude.js";
import { CodexBackend, CodexParser } from "../src/agents/codex.js";
import { loadSchema, schemaPath } from "../src/agents/schema.js";
import { AgentFailure } from "../src/agents/types.js";
import { defaultConfig } from "../src/core/config.js";
import { tempDir } from "./helpers/tmp.js";

const cfg = defaultConfig();

describe("ClaudeBackend", () => {
  const backend = new ClaudeBackend(cfg.claude, "/repo");

  it("builds read-only and implementer command lines", () => {
    const ro = backend.buildArgs({ schemaName: "plan_critique", permission: "read-only", lastMessageFile: "/tmp/x", extraAllowed: [] });
    expect(ro.slice(0, 5)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--json-schema"]);
    expect(JSON.parse(ro[5]!)).toEqual(loadSchema("plan_critique"));
    expect(ro[ro.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(ro[ro.indexOf("--permission-prompts") + 1]).toBe("none");
    expect(ro[ro.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(ro).not.toContain("--disallowedTools");
    const rw = backend.buildArgs({ schemaName: "implementation", permission: "workspace-write", lastMessageFile: "/tmp/x", extraAllowed: ["Bash(npm test*)"] });
    expect(rw[rw.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(rw[rw.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,Edit,Write,Bash");
    expect(rw.slice(rw.indexOf("--allowedTools"), rw.indexOf("--disallowedTools"))).toContain("Bash(npm test*)");
    expect(rw.slice(rw.indexOf("--disallowedTools"))).toContain("Bash(git push*)");
    expect(rw).toContain("--strict-mcp-config");
  });

  it("finalizes from the result envelope", () => {
    const p = new ClaudeParser("/repo");
    p.feed(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: '{"a":1}', structured_output: { a: 2 }, total_cost_usd: 0.5, permission_denials: [] }));
    expect(backend.finalize(p, "", "")).toMatchObject({ data: { a: 2 }, meta: { costUsd: 0.5 } });
    const q = new ClaudeParser("/repo");
    q.feed(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: '{"a":1}' }));
    expect(backend.finalize(q, "", "").data).toEqual({ a: 1 });
  });

  it("keeps the cost when the envelope reports an error", () => {
    const p = new ClaudeParser("/repo");
    p.feed(JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 0.7 }));
    let failure: unknown;
    try {
      backend.finalize(p, "", "");
    } catch (e) {
      failure = e;
    }
    expect(failure).toBeInstanceOf(AgentFailure);
    expect((failure as AgentFailure).meta.costUsd).toBe(0.7);
    expect(() => backend.finalize(new ClaudeParser("/repo"), "garbage", "")).toThrow("did not return a result envelope");
  });
});

describe("CodexBackend", () => {
  const backend = new CodexBackend(cfg.codex, "/repo");

  it("builds the command line", () => {
    const args = backend.buildArgs({ schemaName: "review", permission: "read-only", lastMessageFile: "/tmp/last.json", extraAllowed: [] });
    expect(args.slice(0, 4)).toEqual(["exec", "--json", "--sandbox", "read-only"]);
    expect(args[args.indexOf("--output-schema") + 1]).toBe(schemaPath("review"));
    expect(args[args.indexOf("--output-last-message") + 1]).toBe("/tmp/last.json");
    expect(args[args.indexOf("--cd") + 1]).toBe("/repo");
    expect(args).toContain("--ephemeral");
    expect(args.at(-1)).toBe("-");
  });

  it("finalizes from the last-message file, then from the stream", () => {
    const t = tempDir();
    try {
      const file = join(t.path, "last.json");
      writeFileSync(file, '{"a":1}');
      const p = new CodexParser();
      p.feed(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }));
      expect(backend.finalize(p, "", file)).toMatchObject({ data: { a: 1 }, meta: { tokens: 15 } });
      const q = new CodexParser();
      q.feed(JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text: '{"b":2}' } }));
      expect(backend.finalize(q, "", join(t.path, "missing.json")).data).toEqual({ b: 2 });
      const r = new CodexParser();
      r.feed(JSON.stringify({ type: "turn.failed", error: { message: "rate limited" } }));
      expect(() => backend.finalize(r, "", join(t.path, "missing.json"))).toThrow("codex failed: rate limited");
    } finally {
      t.cleanup();
    }
  });
});
