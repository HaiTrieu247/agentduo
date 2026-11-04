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

  it("gives a pipeline role its own model and effort, under the role's args; other roles and conversation turns keep Claude's", () => {
    const cfg = defaultConfig();
    cfg.claude.model = "sonnet";
    cfg.claude.args = ["--effort", "low"];
    cfg.claude.role_models = { plan_reviewer: "opus", implementer: null };
    cfg.claude.role_efforts = { plan_reviewer: "high" };
    const backend = new ClaudeBackend(cfg.claude, "/ws");
    const flag = (args: string[], name: string) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
    const critic = backend.buildArgs({ schemaName: "plan_critique", lastMessageFile: "", role: "plan_reviewer" });
    expect(flag(critic, "--model")).toEqual(["opus"]);
    // The role's effort comes after the args every call gets, so it wins over theirs.
    expect(critic.slice(-4)).toEqual(["--effort", "low", "--effort", "high"]);
    // null: the implementer runs with Claude's model again.
    const impl = backend.buildArgs({ schemaName: "implementation", lastMessageFile: "", role: "implementer" });
    expect([flag(impl, "--model"), flag(impl, "--effort")]).toEqual([["sonnet"], ["low"]]);
    const turn = backend.buildArgs({ mode: "text", lastMessageFile: "" });
    expect([flag(turn, "--model"), flag(turn, "--effort")]).toEqual([["sonnet"], ["low"]]);
    // The role's own flags come last: a --model or --effort there still wins, as it always did.
    cfg.claude.role_args = { plan_reviewer: ["--model", "haiku", "--effort", "max"] };
    const own = backend.buildArgs({ schemaName: "plan_critique", lastMessageFile: "", role: "plan_reviewer" });
    expect([flag(own, "--model").at(-1), flag(own, "--effort").at(-1)]).toEqual(["haiku", "max"]);
    // Read at each call: a change reaches the next one.
    cfg.claude.role_models.plan_reviewer = "fable";
    expect(flag(backend.buildArgs({ schemaName: "plan_critique", lastMessageFile: "", role: "plan_reviewer" }), "--model")[0]).toBe("fable");
  });

  it("keeps a pipeline role's session and continues it with --resume; every other call keeps none, without repeating the user's flag", () => {
    const cfg = defaultConfig();
    const backend = new ClaudeBackend(cfg.claude, "/ws");
    const call = (session?: { keep: boolean; resume?: string }) =>
      backend.buildArgs({ schemaName: "implementation", lastMessageFile: "", role: "implementer", ...(session ? { session } : {}) });
    expect(call()).toContain("--no-session-persistence");
    expect(call({ keep: true })).not.toContain("--no-session-persistence");
    const resumed = call({ keep: true, resume: "s-1" });
    expect(resumed[resumed.indexOf("--resume") + 1]).toBe("s-1");
    expect(resumed).not.toContain("--no-session-persistence");
    expect(call({ keep: false })).not.toContain("--resume");
    // A conversation turn is never continued: its session is never kept.
    expect(backend.buildArgs({ mode: "text", lastMessageFile: "" })).toContain("--no-session-persistence");
    expect(backend.keepsSessions("implementer")).toBe(true);
    // The user's own flag turns sessions off for every role it reaches, and is passed once.
    cfg.claude.role_args = { implementer: ["--no-session-persistence"] };
    expect(backend.keepsSessions("implementer")).toBe(false);
    expect(backend.keepsSessions("plan_reviewer")).toBe(true);
    expect(call().filter((a) => a === "--no-session-persistence")).toHaveLength(1);
    cfg.claude.args = ["--no-session-persistence"];
    cfg.claude.role_args = {};
    expect(backend.keepsSessions("plan_reviewer")).toBe(false);
    expect(backend.buildArgs({ mode: "text", lastMessageFile: "" }).filter((a) => a === "--no-session-persistence")).toHaveLength(1);
  });

  it("caps a call's cost at the lower of the per-call budget and what the run's budget has left", () => {
    const cfg = defaultConfig();
    const backend = new ClaudeBackend(cfg.claude, "/ws");
    const cap = (costCap?: number) => {
      const args = backend.buildArgs({ schemaName: "plan_critique", lastMessageFile: "", role: "plan_reviewer", ...(costCap !== undefined ? { costCap } : {}) });
      return args.includes("--max-budget-usd") ? args[args.indexOf("--max-budget-usd") + 1] : null;
    };
    expect(cap()).toBeNull();
    expect(cap(0.75)).toBe("0.75");
    cfg.claude.max_budget_usd = 2;
    expect(cap()).toBe("2");
    expect(cap(0.75)).toBe("0.75");
    expect(cap(3)).toBe("2");
    expect(backend.buildArgs({ mode: "text", lastMessageFile: "" }).filter((a) => a === "--max-budget-usd")).toHaveLength(1);
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
    expect([...planner, ...reviewer]).not.toContain("--skip-git-repo-check");
  });

  it("gives a pipeline role its own model and reasoning effort, under the role's args; conversation turns keep Codex's", () => {
    const cfg = defaultConfig();
    cfg.codex.model = "gpt-5.5";
    cfg.codex.args = ["-c", "model_reasoning_effort=low"];
    cfg.codex.role_models = { planner: "gpt-5.5-pro" };
    cfg.codex.role_efforts = { planner: "high", code_reviewer: null };
    cfg.codex.role_args = { code_reviewer: ["--sandbox", "read-only"] };
    const backend = new CodexBackend(cfg.codex, "/ws");
    const planner = backend.buildArgs({ schemaName: "plan", lastMessageFile: "/tmp/l.json", role: "planner" });
    expect(planner).toEqual(["exec", "--json", "--color", "never", "--output-schema", schemaPath("plan"), "--output-last-message", "/tmp/l.json",
      "--cd", "/ws", "--model", "gpt-5.5-pro", "--ephemeral", "-c", "model_reasoning_effort=low", "-c", "model_reasoning_effort=high", "-"]);
    const reviewer = backend.buildArgs({ schemaName: "review", lastMessageFile: "/tmp/l.json", role: "code_reviewer" });
    expect(reviewer.slice(-8)).toEqual(["--model", "gpt-5.5", "--ephemeral", "-c", "model_reasoning_effort=low", "--sandbox", "read-only", "-"]);
    const turn = backend.buildArgs({ mode: "text", lastMessageFile: "/tmp/l.md" });
    expect(turn).toContain("gpt-5.5");
    expect(turn).not.toContain("gpt-5.5-pro");
    expect(turn).not.toContain("model_reasoning_effort=high");
  });

  it("lets a run with agentduo's own snapshot repository start outside a git repository, and nothing else", () => {
    const backend = new CodexBackend(defaultConfig().codex, "/ws");
    const args = backend.buildArgs({ schemaName: "review", lastMessageFile: "/tmp/last.json", role: "code_reviewer", skipGitRepoCheck: true });
    expect(args).toEqual(["exec", "--json", "--color", "never", "--skip-git-repo-check", "--output-schema", schemaPath("review"), "--output-last-message",
      "/tmp/last.json", "--cd", "/ws", "--ephemeral", "-"]);
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

  it("continues a role's session as `codex exec <options> resume <id> -`, and keeps no other session", () => {
    const cfg = defaultConfig();
    cfg.codex.role_args = { implementer: ["--sandbox", "workspace-write"] };
    const backend = new CodexBackend(cfg.codex, "/ws");
    const images = [{ file: "/ws/a.png", mediaType: "image/png" }];
    const resumed = backend.buildArgs({ schemaName: "implementation", lastMessageFile: "/tmp/l.json", role: "implementer", images, session: { keep: true, resume: "t-1" } });
    // exec's own options (schema, last message, workspace, role args) come before the subcommand; the images are the resumed prompt's.
    expect(resumed.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(resumed.slice(-6)).toEqual(["--sandbox", "workspace-write", "resume", "t-1", "--image=/ws/a.png", "-"]);
    expect(resumed.indexOf("--output-schema")).toBeLessThan(resumed.indexOf("resume"));
    expect(resumed).not.toContain("--ephemeral");
    const kept = backend.buildArgs({ schemaName: "plan", lastMessageFile: "/tmp/l.json", role: "planner", session: { keep: true } });
    expect(kept).not.toContain("--ephemeral");
    expect(kept).not.toContain("resume");
    expect(backend.buildArgs({ schemaName: "plan", lastMessageFile: "/tmp/l.json", role: "planner" })).toContain("--ephemeral");
    expect(backend.buildArgs({ mode: "text", lastMessageFile: "/tmp/l.md" })).toContain("--ephemeral");
    cfg.codex.args = ["--ephemeral"];
    expect(backend.keepsSessions("planner")).toBe(false);
    expect(backend.buildArgs({ mode: "text", lastMessageFile: "/tmp/l.md" }).filter((a) => a === "--ephemeral")).toHaveLength(1);
  });

  it("names the thread a call ran in, which a later call resumes", () => {
    const p = new CodexParser();
    for (const line of readFileSync(join(import.meta.dirname, "fixtures", "codex-stream.jsonl"), "utf8").split("\n").filter(Boolean)) p.feed(line);
    const t = tempDir();
    try {
      expect(new CodexBackend(defaultConfig().codex, "/repo").finalize(p, "", join(t.path, "none"), "text").meta.sessionId).toBe("01a17c13-e50d-7603-8538-a3f4ebfe421d");
    } finally {
      t.cleanup();
    }
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
