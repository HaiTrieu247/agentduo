import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeBackend, ClaudeParser } from "../src/agents/claude.js";
import { CodexBackend, CodexParser } from "../src/agents/codex.js";
import { loadSchema, schemaPath } from "../src/agents/schema.js";
import { AgentFailure } from "../src/agents/types.js";
import { defaultConfig } from "../src/core/config.js";
import { tempDir } from "./helpers/tmp.js";

const PERMISSION_FLAGS = ["--sandbox", "--tools", "--allowedTools", "--disallowedTools", "--permission-mode", "--dangerously-skip-permissions"];

describe("ClaudeBackend", () => {
  it("passes only protocol flags, then args and the role's args", () => {
    const cfg = defaultConfig();
    cfg.claude.model = "opus";
    cfg.claude.max_budget_usd = 2;
    cfg.claude.role_args = { implementer: ["--permission-mode", "acceptEdits"] };
    const backend = new ClaudeBackend(cfg.claude, "/ws");
    const critic = backend.buildArgs({ schemaName: "plan_critique", lastMessageFile: "/tmp/x", role: "plan_reviewer" });
    expect(critic.slice(0, 5)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--json-schema"]);
    expect(JSON.parse(critic[5]!)).toEqual(loadSchema("plan_critique"));
    expect(critic.slice(6)).toEqual(["--permission-prompts", "none", "--model", "opus", "--max-budget-usd", "2", "--no-session-persistence"]);
    for (const flag of PERMISSION_FLAGS) expect(critic).not.toContain(flag);
    const impl = backend.buildArgs({ schemaName: "implementation", lastMessageFile: "/tmp/x", role: "implementer" });
    expect(impl.slice(-3)).toEqual(["--no-session-persistence", "--permission-mode", "acceptEdits"]);
  });

  it("reads stream-json input whenever it gets images, without changing who answers permission prompts", () => {
    const t = tempDir();
    try {
      const file = join(t.path, "a.png");
      writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const backend = new ClaudeBackend(defaultConfig().claude, "/ws");
      const images = [{ file, mediaType: "image/png" }];
      const quiet = backend.buildArgs({ mode: "text", lastMessageFile: "", images });
      expect(quiet).toEqual(expect.arrayContaining(["--input-format", "stream-json"]));
      expect(quiet[quiet.indexOf("--permission-prompts") + 1]).toBe("none");
      expect(quiet).not.toContain("--permission-prompt-tool");
      const host = backend.buildArgs({ mode: "text", lastMessageFile: "", images, askPermissions: true });
      expect(host.filter((a) => a === "--input-format")).toHaveLength(1);
      expect(host[host.indexOf("--permission-prompts") + 1]).toBe("host");
      // The images first, then the prompt; the same message shape Claude Code 2.1.311 answered (test/fixtures/claude-attachment-stream.jsonl).
      expect(JSON.parse(backend.hostInput("What colour?", images))).toEqual({
        type: "user", parent_tool_use_id: null, session_id: "",
        message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw==" } }, { type: "text", text: "What colour?" }] },
      });
    } finally {
      t.cleanup();
    }
  });

  it("parses the stream of a real call that had an image", () => {
    const p = new ClaudeParser("/repo");
    for (const line of readFileSync(join(import.meta.dirname, "fixtures", "claude-attachment-stream.jsonl"), "utf8").split("\n").filter(Boolean)) p.feed(line);
    expect(new ClaudeBackend(defaultConfig().claude, "/repo").finalize(p, "", "", "text").data).toBe("red");
    const c = new CodexParser();
    for (const line of readFileSync(join(import.meta.dirname, "fixtures", "codex-attachment-stream.jsonl"), "utf8").split("\n").filter(Boolean)) c.feed(line);
    expect(c.lastAgentMessage).toBe("red, blue");
  });

  it("speaks the host protocol when permission prompts go to the user", () => {
    const backend = new ClaudeBackend(defaultConfig().claude, "/ws");
    const host = backend.buildArgs({ schemaName: "plan", lastMessageFile: "", role: "plan_reviewer", askPermissions: true });
    expect(host).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--permission-prompt-tool", "stdio"]));
    expect(host[host.indexOf("--permission-prompts") + 1]).toBe("host");
    const quiet = backend.buildArgs({ schemaName: "plan", lastMessageFile: "", role: "plan_reviewer" });
    expect(quiet[quiet.indexOf("--permission-prompts") + 1]).toBe("none");
    expect(quiet).not.toContain("--input-format");
    expect(JSON.parse(backend.hostInput("hi"))).toEqual({ type: "user", message: { role: "user", content: "hi" }, parent_tool_use_id: null, session_id: "" });
    const raw = { request_id: "r1", input: { command: "npm test" }, suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "localSettings" }] };
    const reply = (answer: Parameters<typeof backend.permissionReply>[1]) => JSON.parse(backend.permissionReply(raw, answer));
    expect(reply({ decision: "once" })).toEqual({ type: "control_response", response: { subtype: "success", request_id: "r1", response: { behavior: "allow", updatedInput: { command: "npm test" } } } });
    expect(reply({ decision: "always" }).response.response.updatedPermissions).toEqual(raw.suggestions);
    expect(reply({ decision: "deny", message: "use the npm script" }).response.response).toEqual({ behavior: "deny", message: "use the npm script" });
    expect(reply({ decision: "deny" }).response.response.message).toContain("denied");
    expect(backend.hostInput("x").endsWith("\n")).toBe(true);
  });

  it("finalizes from the result envelope and keeps the cost on errors", () => {
    const backend = new ClaudeBackend(defaultConfig().claude, "/ws");
    const p = new ClaudeParser("/ws");
    p.feed(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: '{"a":1}', structured_output: { a: 2 }, total_cost_usd: 0.5, permission_denials: [] }));
    expect(backend.finalize(p, "", "")).toMatchObject({ data: { a: 2 }, meta: { costUsd: 0.5 } });
    const q = new ClaudeParser("/ws");
    q.feed(JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 0.7 }));
    let failure: unknown;
    try {
      backend.finalize(q, "", "");
    } catch (e) {
      failure = e;
    }
    expect((failure as AgentFailure).meta.costUsd).toBe(0.7);
    expect(() => backend.finalize(new ClaudeParser("/ws"), "garbage", "")).toThrow("did not return a result envelope");
    const r = new ClaudeParser("/ws");
    r.feed(JSON.stringify({ type: "assistant", message: { id: "m1", usage: { input_tokens: 10, output_tokens: 5 }, content: [] } }));
    let crashed: unknown;
    try {
      backend.finalize(r, "garbage", "");
    } catch (e) {
      crashed = e;
    }
    expect((crashed as AgentFailure).meta.tokens).toBe(15);
  });
});

describe("CodexBackend", () => {
  it("passes only protocol flags, then args and the role's args", () => {
    const cfg = defaultConfig();
    cfg.codex.args = ["--ephemeral", "-c", "model_reasoning_effort=high"];
    cfg.codex.role_args = { code_reviewer: ["--sandbox", "read-only"] };
    const backend = new CodexBackend(cfg.codex, "/ws");
    const planner = backend.buildArgs({ schemaName: "plan", lastMessageFile: "/tmp/last.json", role: "planner" });
    expect(planner).toEqual(["exec", "--json", "--color", "never", "--output-schema", schemaPath("plan"), "--output-last-message", "/tmp/last.json",
      "--cd", "/ws", "--ephemeral", "-c", "model_reasoning_effort=high", "-"]);
    for (const flag of PERMISSION_FLAGS) expect(planner).not.toContain(flag);
    const reviewer = backend.buildArgs({ schemaName: "review", lastMessageFile: "/tmp/last.json", role: "code_reviewer" });
    expect(reviewer.slice(-3)).toEqual(["--sandbox", "read-only", "-"]);
  });

  it("passes each image as one --image=<path> token, so the - that reads the prompt from stdin stays last", () => {
    const backend = new CodexBackend(defaultConfig().codex, "/ws");
    const images = [{ file: "/ws/.agentduo/runs/a/x.png", mediaType: "image/png" }, { file: "/ws/.agentduo/runs/b/y z.jpg", mediaType: "image/jpeg" }];
    const args = backend.buildArgs({ mode: "text", lastMessageFile: "/tmp/last.md", images });
    expect(args.slice(-3)).toEqual(["--image=/ws/.agentduo/runs/a/x.png", "--image=/ws/.agentduo/runs/b/y z.jpg", "-"]);
    expect(args).not.toContain("--image");
    expect(args).not.toContain("-i");
    expect(backend.buildArgs({ mode: "text", lastMessageFile: "/tmp/last.md" }).at(-1)).toBe("-");
  });

  it("lets a conversation turn run outside a git repository; the workflow's calls run inside one", () => {
    const backend = new CodexBackend(defaultConfig().codex, "/ws");
    expect(backend.buildArgs({ mode: "text", lastMessageFile: "/tmp/last.md" })).toContain("--skip-git-repo-check");
    expect(backend.buildArgs({ schemaName: "plan", lastMessageFile: "/tmp/last.json", role: "planner" })).not.toContain("--skip-git-repo-check");
  });

  it("finalizes from the last-message file, then from the stream", () => {
    const backend = new CodexBackend(defaultConfig().codex, "/ws");
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
