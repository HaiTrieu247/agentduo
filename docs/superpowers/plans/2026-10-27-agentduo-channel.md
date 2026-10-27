# agentduo v2 (pure channel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn agentduo into a pure channel between Codex CLI and Claude Code. It enforces no permissions and no guards, and it scopes each run to the directory it is called from. The same plan fixes every Minor finding and every set-aside point from the v1 review.

**Architecture:**
- **Removed:** the permission flags, `guards.ts`, the dirty-tree refusal and the prompt "hard rules".
- **What stays:** the state machine, the JSON contracts, streaming and the UI.
- **Git:** every call runs with `cwd` = the workspace, so the pathspec `.` means "this workspace" and `:/` means "the whole repo".
- **Warnings instead of escalations:** files changed outside the workspace, and files changed by a read-only role, produce warnings that land in the UI and in the report.
- **Gates** become optional.

**Tech Stack:** unchanged (Node ≥ 22.12, TypeScript 7, Ink 8, commander 15, yaml, ajv, vitest 5).

**Spec:** [docs/superpowers/specs/2026-10-27-agentduo-channel-design.md](../specs/2026-10-27-agentduo-channel-design.md). The v1 spec and plan still describe everything this spec does not replace.

## Global Constraints

- Agent invocations contain only the protocol flags of spec §4 plus `<backend>.args` and `<backend>.role_args[role]`. There is no `--sandbox`, `--tools`, `--allowedTools`, `--disallowedTools` or `--permission-mode` unless the user put it in `args`/`role_args`.
- Nothing stops a run except the loop's own reasons (spec §5). Unexpected file changes are `warning` events, which are also stored in `state.warnings` and the report.
- The workspace is `--dir` or the cwd; agentduo never walks up to the repository root.
- Runtime dependencies stay `ink`, `react`, `commander`, `yaml` and `ajv`.
- Every fix has a test seen failing first. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work continues on branch `feat/agentduo`.

## Review Focus

1. **A workspace subdirectory whose name has a space and non-ASCII characters** (`gói pkg/`). Pathspecs, `--relative` diffs and the runs dir must all work. Pinned in Task 1 (workspace e2e test).
2. **A config file written for v1** (`permissions:`, `safety.protected_paths`, `claude.extra_args`). It loads with warnings (a rename hint for `extra_args`) and never crashes. Pinned in Task 1 (config test).
3. **Claude without edit permission in non-interactive mode.** The run does not hang, and the denials surface with the configuration hint. Pinned in Task 1 (denial-hint e2e test).
4. **An agent that is legitimately silent for a long time** (a long test run inside Claude). It is not killed below `agent_idle_timeout_sec`, and `0` disables the check. Pinned in Task 2 (process test).
5. **Resuming a run created before v2** (no `config.json`). It falls back to the current config. Pinned in Task 1 (cli test).

---

### Task 1: Channel core and CLI

**Files:**
- Rewrite: `src/core/config.ts`, `src/core/git.ts`, `src/core/prompts.ts`, `src/core/workflow.ts`, `src/cli.ts`, `src/core/init.ts`, `src/core/doctor.ts`
- Modify: `src/agents/types.ts`, `src/agents/codex.ts`, `src/agents/claude.ts`, `src/agents/runner.ts`, `src/core/state.ts`, `src/core/render.ts`, `test/fake-agent.mjs`, `test/git.test.ts`, `test/state.test.ts`, `test/workflow.test.ts`
- Rewrite tests: `test/config.test.ts`, `test/backends.test.ts`, `test/prompts.test.ts`, `test/cli.test.ts`, `test/init.test.ts`, `test/doctor.test.ts`
- Delete: `src/core/guards.ts`, `test/guards.test.ts`

**Interfaces (produced, used by Tasks 2–4):**
- `config.ts`:
  - `ConfigData` without `permissions`, `safety` is `{ pause_before_implement }`, `codex: { bin, model, args, role_args }`, `claude: { bin, model, max_budget_usd, args, role_args }`, plus `limits.agent_idle_timeout_sec`;
  - `type RoleArgs = Partial<Record<AgentRole, string[]>>`;
  - `loadConfig({ dir, configPath?, env?, platform?, validate? })`;
  - `configFromSaved(raw): ConfigData` (merges a saved `config.json` over the defaults);
  - `validateConfig(cfg, source?)`.
  - Removed: `permissionFor`, `READ_ONLY_ROLES`, `Permission`.
- `types.ts`: `BuildArgs = { schemaName; lastMessageFile; role: AgentRole }`.
- `git.ts`: `Git(dir)` has `prefix()`, `worktreeTree(exclude?, scope?: "." | ":/")`, `snapshot(exclude?, ref?, message?)`, `nameStatus(a, b)` (inside the workspace, relative paths), `outsideChanges(a, b)` (repo-root paths), `diff(a, b)` and `diffStat(a, b)` (inside the workspace). `statusPorcelain`, `ignoredMatching` and `metadataFiles` are removed.
- `state.ts`:
  - `RunState.warnings: string[]`;
  - `base: Snapshot & { head; branch }`;
  - `acquireWorkspaceLock(runsDir): () => void`;
  - `roundPre` is removed.
- `prompts.ts`:
  - `PromptContext` gains `agents: Record<AgentRole, Backend>`;
  - the signature is `implementer(ctx, round, planMd, findings, review, failedGates, previousReport)`;
  - `READONLY_RULES` is removed and `OUTPUT_RULES` is added;
  - `fenceFor(text)` is new.
- `workflow.ts`: `WorkflowOptions = { cfg, repo /* workspace dir */, store, state, bus, decider, runner? }`.
- `cli.ts`:
  - new: `isBackgroundFromPs(out)`, `applyColorPreference(opts, env)`;
  - `CliIO` gains `ask?` and `isBackground?`;
  - flags: `--dir` replaces `--repo`; `resume --reload-config`; `--allow-dirty` is removed.
- `doctor.ts`: `runDoctor({ dir, cfg, sources, configError?, env?, runsDir })`.
- `fake-agent.mjs` response keys added:
  - `denials: [{tool_name, tool_use_id}]` (Claude's `permission_denials`);
  - `noLastMessage: true` (Codex skips the `-o` file);
  - activities are emitted before `sleep`;
  - Claude assistant events carry `message.usage` (`{input_tokens: 10, output_tokens: 5}`, one message id `m`).

- [ ] **Step 1: Update the fake agent (test infrastructure; no product behavior)**

```python file=.superpowers/patches/t1-fake-agent.py
p = "test/fake-agent.mjs"
s = open(p).read()
def rep(old, new):
    global s
    assert old in s, old[:60]
    s = s.replace(old, new, 1)
rep('''  if (resp.sleep) await new Promise((r) => setTimeout(r, resp.sleep));

  let text;''', '''  let text;''')
rep('''  if (backend === "codex") {
    emit({ type: "thread.started", thread_id: "fake" });
    emit({ type: "turn.started" });
    activities.forEach((a, i) => {
      const item = { id: `item_${i}`, type: "command_execution", command: `/bin/zsh -lc '${a.command}'`, aggregated_output: "", exit_code: null, status: "in_progress" };
      emit({ type: "item.started", item });
      emit({ type: "item.completed", item: { ...item, exit_code: a.exit ?? 0, status: "completed" } });
    });
    emit({ type: "item.completed", item: { id: "item_final", type: "agent_message", text } });
    emit({ type: "turn.completed", usage: { input_tokens: 1000, output_tokens: 234 } });
    writeFileSync(args[args.indexOf("--output-last-message") + 1], text);
  } else {
    emit({ type: "system", subtype: "init", session_id: "fake" });
    activities.forEach((a, i) => {
      emit({ type: "assistant", uuid: `u${i}`, message: { id: "m", content: [{ type: "tool_use", id: `t${i}`, name: a.tool, input: a.input ?? {} }] } });
      emit({ type: "user", uuid: `r${i}`, message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, content: a.result ?? "ok", is_error: a.error ?? false }] } });
    });
    const envelope = { type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0.01, session_id: "fake", num_turns: 1, permission_denials: [] };''', '''  const sleep = () => (resp.sleep ? new Promise((r) => setTimeout(r, resp.sleep)) : Promise.resolve());
  if (backend === "codex") {
    emit({ type: "thread.started", thread_id: "fake" });
    emit({ type: "turn.started" });
    activities.forEach((a, i) => {
      const item = { id: `item_${i}`, type: "command_execution", command: `/bin/zsh -lc '${a.command}'`, aggregated_output: "", exit_code: null, status: "in_progress" };
      emit({ type: "item.started", item });
      emit({ type: "item.completed", item: { ...item, exit_code: a.exit ?? 0, status: "completed" } });
    });
    await sleep();
    emit({ type: "item.completed", item: { id: "item_final", type: "agent_message", text } });
    emit({ type: "turn.completed", usage: { input_tokens: 1000, output_tokens: 234 } });
    if (!resp.noLastMessage) writeFileSync(args[args.indexOf("--output-last-message") + 1], text);
  } else {
    emit({ type: "system", subtype: "init", session_id: "fake" });
    const usage = { input_tokens: 10, output_tokens: 5 };
    activities.forEach((a, i) => {
      emit({ type: "assistant", uuid: `u${i}`, message: { id: "m", usage, content: [{ type: "tool_use", id: `t${i}`, name: a.tool, input: a.input ?? {} }] } });
      emit({ type: "user", uuid: `r${i}`, message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, content: a.result ?? "ok", is_error: a.error ?? false }] } });
    });
    await sleep();
    const envelope = { type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0.01, session_id: "fake", num_turns: 1, permission_denials: resp.denials ?? [] };''')
open(p, "w").write(s)
```

Run: `mkdir -p .superpowers/patches && python3 .superpowers/patches/t1-fake-agent.py && npx vitest run test/runner.test.ts test/workflow.test.ts`
Expected: the same tests pass as before (infrastructure only).

- [ ] **Step 2: Write the new/rewritten tests (RED)**

```ts file=test/config.test.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configFromSaved, ConfigError, defaultConfig, loadConfig, userConfigPath } from "../src/core/config.js";
import { tempDir } from "./helpers/tmp.js";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (dirs.length) dirs.pop()!.cleanup();
});

function setup(dirYaml?: string, userYaml?: string) {
  const t = tempDir();
  dirs.push(t);
  const dir = join(t.path, "ws");
  const xdg = join(t.path, "xdg");
  mkdirSync(join(dir, ".agentduo"), { recursive: true });
  if (dirYaml !== undefined) writeFileSync(join(dir, ".agentduo", "config.yaml"), dirYaml);
  if (userYaml !== undefined) {
    mkdirSync(join(xdg, "agentduo"), { recursive: true });
    writeFileSync(join(xdg, "agentduo", "config.yaml"), userYaml);
  }
  return { dir, env: { XDG_CONFIG_HOME: xdg, HOME: t.path } as NodeJS.ProcessEnv };
}

describe("loadConfig", () => {
  it("layers defaults, user config and workspace config; gates are optional", () => {
    const { dir, env } = setup("codex:\n  model: gpt-ws\n", "codex:\n  model: gpt-user\nclaude:\n  model: opus\n");
    const { data, sources, warnings } = loadConfig({ dir, env });
    expect(data.codex.model).toBe("gpt-ws");
    expect(data.claude.model).toBe("opus");
    expect(data.gates).toEqual([]);
    expect(data.limits.agent_idle_timeout_sec).toBe(900);
    expect(data.codex.args).toEqual(["--ephemeral"]);
    expect(data.claude.args).toEqual(["--no-session-persistence"]);
    expect(data.paths.runs_dir).toBe(".agentduo/runs");
    expect(sources).toHaveLength(2);
    expect(warnings).toEqual([]);
  });

  it("loads a v1 config with warnings only", () => {
    const { dir, env } = setup("permissions:\n  codex: read-only\nsafety:\n  protected_paths: [.env]\n  allow_dirty_worktree: true\nclaude:\n  extra_args: [--x]\n  read_only_tools: [Read]\n");
    const { warnings } = loadConfig({ dir, env });
    const text = warnings.join("\n");
    expect(text).toContain("unknown config key 'permissions' (ignored)");
    expect(text).toContain("unknown config key 'safety.protected_paths' (ignored)");
    expect(text).toContain("config key 'claude.extra_args' was renamed to 'claude.args' (ignored)");
    expect(text).toContain("unknown config key 'claude.read_only_tools' (ignored)");
  });

  it("accepts role_args per role and rejects unknown roles or non-string args", () => {
    const ok = setup("claude:\n  role_args:\n    implementer: [--permission-mode, acceptEdits]\n");
    expect(loadConfig({ dir: ok.dir, env: ok.env }).data.claude.role_args).toEqual({ implementer: ["--permission-mode", "acceptEdits"] });
    const badRole = setup("codex:\n  role_args:\n    hacker: [--x]\n");
    expect(() => loadConfig({ dir: badRole.dir, env: badRole.env })).toThrow("codex.role_args: unknown role 'hacker'");
    const badArgs = setup("claude:\n  role_args:\n    implementer: --x\n");
    expect(() => loadConfig({ dir: badArgs.dir, env: badArgs.env })).toThrow("claude.role_args.implementer must be a list of strings");
  });

  it("keeps defaults when a section or list is present but empty", () => {
    const { dir, env } = setup("codex:\nclaude:\n  args:\ngates:\n");
    const { data } = loadConfig({ dir, env });
    expect(data.codex.bin).toBe("codex");
    expect(data.claude.args).toEqual(["--no-session-persistence"]);
    expect(data.gates).toEqual([]);
  });

  it("type-checks values and names every config file in errors", () => {
    const cases: Array<[string, string]> = [
      ["gates: npm test\n", "gates must be a list"],
      ["limits: 5\n", "'limits' must be a mapping"],
      ["- a\n- b\n", "top level must be a mapping"],
      ["a: [1\n", "config.yaml"],
      ["codex:\n  bin: 5\n", "codex.bin must be a non-empty string"],
      ["safety:\n  pause_before_implement: no\n", "safety.pause_before_implement must be true or false"],
      ["quality_gates:\n  require_tests_pass: yes\n", "quality_gates.require_tests_pass must be true or false"],
      ["claude:\n  max_budget_usd: lots\n", "claude.max_budget_usd must be a positive number or null"],
      ["codex:\n  args: [1]\n", "codex.args must be a list of strings"],
      ["limits:\n  agent_idle_timeout_sec: -1\n", "limits.agent_idle_timeout_sec must be an integer >= 0"],
      ["limits:\n  max_review_rounds: 0\n", "limits.max_review_rounds must be a positive integer"],
      ["agents:\n  implementer: gemini\n", "agents.implementer must be one of codex, claude"],
      ["gates: [npm test]\n", "gates[0] needs 'name' and 'command'"],
    ];
    for (const [yaml, expected] of cases) {
      const { dir, env } = setup(yaml);
      expect(() => loadConfig({ dir, env }), yaml).toThrow(expected);
    }
    const both = setup("", "limits:\n  max_retries: -1\n");
    expect(() => loadConfig({ dir: both.dir, env: both.env })).toThrow(/xdg\/agentduo\/config\.yaml/);
  });

  it("lets any backend take any role", () => {
    const { dir, env } = setup("agents:\n  implementer: codex\n  plan_reviewer: codex\n");
    expect(loadConfig({ dir, env }).data.agents.implementer).toBe("codex");
  });

  it("errors when --config points to a missing file", () => {
    const { dir, env } = setup();
    expect(() => loadConfig({ dir, env, configPath: join(dir, "missing.yaml") })).toThrow("config file not found");
  });
});

describe("saved configs and paths", () => {
  it("merges a saved config over the defaults", () => {
    const saved = defaultConfig() as unknown as Record<string, unknown>;
    delete (saved.limits as Record<string, unknown>).agent_idle_timeout_sec;
    (saved.codex as Record<string, unknown>).model = "gpt-saved";
    const cfg = configFromSaved(saved);
    expect(cfg.codex.model).toBe("gpt-saved");
    expect(cfg.limits.agent_idle_timeout_sec).toBe(900);
    expect(() => configFromSaved("nope")).toThrow(ConfigError);
  });

  it("finds the user config file per platform", () => {
    expect(userConfigPath({ XDG_CONFIG_HOME: "/x" }, "linux")).toBe(join("/x", "agentduo", "config.yaml"));
    expect(userConfigPath({ HOME: "/h" }, "darwin")).toBe(join("/h", ".config", "agentduo", "config.yaml"));
    expect(userConfigPath({ APPDATA: "C:\\AppData" }, "win32")).toContain("agentduo");
  });
});
```

```ts file=test/backends.test.ts
import { writeFileSync } from "node:fs";
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
```

```ts file=test/prompts.test.ts
import { describe, expect, it } from "vitest";
import type { GateResult } from "../src/core/gates.js";
import * as prompts from "../src/core/prompts.js";
import { critique, finding, impl, issue, plan, review } from "./helpers/builders.js";

const agents = { planner: "codex", plan_reviewer: "claude", implementer: "claude", code_reviewer: "codex" } as const;
const ctx: prompts.PromptContext = {
  repo: "/ws", taskId: "t1", task: "Sửa app.txt cho đúng", agents,
  gates: [{ name: "tests", command: "npm test", required: true }, { name: "lint", command: "npm run lint", required: false }],
  notes: [{ at: "2026-10-27T13:00:00+07:00", phase: "PLAN_REVIEW", note: "use redis" }],
};
const noGates: prompts.PromptContext = { ...ctx, gates: [] };
const failedGate: GateResult = { name: "tests", command: "npm test", required: true, exitCode: 1, timedOut: false, passed: false, durationSec: 1, log: "/x", outputTail: "check failed: boom" };
const RULE_WORDS = ["READ-ONLY", "Hard rules", "protected paths", "Chained commands", "Never commit", "byte-for-byte"];

describe("prompts", () => {
  it("describe roles and the output contract, with no rules of agentduo's own", () => {
    const all = [
      prompts.planner(ctx, 1, 1, null, null),
      prompts.planReviewer(ctx, 1, 1, "# Plan", null),
      prompts.planFinalizer(ctx, 1, 1, "# Plan", critique(true)),
      prompts.implementer(ctx, 1, "# Plan", [], null, [], null),
      prompts.codeReviewer(ctx, 1, "# Plan", "a".repeat(40), "b".repeat(40), [], "", "", false, [], impl()),
    ];
    for (const p of all) {
      for (const word of RULE_WORDS) expect(p).not.toContain(word);
      expect(p).toContain("Follow your own configuration and the repository's instructions");
      expect(p).toContain("implementer: Claude Code");
      expect(p).toContain("single JSON object");
    }
  });

  it("planner v1 states the task, notes and the gates when there are any", () => {
    const p = prompts.planner(ctx, 1, 1, null, null);
    expect(p.startsWith("[orchestrator-role: planner]")).toBe(true);
    for (const s of ["Sửa app.txt cho đúng", "use redis", "- `npm test` (tests, required)", "- `npm run lint` (lint, optional)", "return `feedback_resolution` as an empty list"]) {
      expect(p).toContain(s);
    }
    expect(prompts.planner(noGates, 1, 1, null, null)).not.toContain("npm test");
  });

  it("planner revisions include the previous plan and the feedback", () => {
    const c = { ...critique(false, [issue("C1", "high", "missing migration")]), proposed_changes: ["add a migration step"] };
    const p = prompts.planner(ctx, 2, 2, plan("Old plan"), { critique: c });
    for (const s of ["## Previous plan (v1) as JSON", "Old plan", "`C1` [high] missing migration", "add a migration step", "one entry per issue id"]) expect(p).toContain(s);
  });

  it("plan reviewer and finalizer see the plan and previous issues", () => {
    const r = prompts.planReviewer(ctx, 2, 2, "# Plan v2", critique(false, [issue("C1")]));
    expect(r).toContain("[orchestrator-role: plan_reviewer]");
    expect(r).toContain("Your critique from the previous round");
    const f = prompts.planFinalizer(ctx, 2, 2, "# Plan v2", critique(true, [issue("C2", "low")]));
    expect(f).toContain("`C2` [low]");
    expect(f).toContain("`A1`");
  });

  it("implementer prompts for the first round and fix rounds", () => {
    const first = prompts.implementer(ctx, 1, "# Final plan", [], null, [], null);
    expect(first).toContain("Implement the plan now");
    expect(first).toContain("After your turn agentduo runs these commands");
    expect(prompts.implementer(noGates, 1, "# Final plan", [], null, [], null)).toContain("Run the project's checks yourself");
    const fix = prompts.implementer(ctx, 2, "# Final plan", [finding("F1")], review(false, [finding("F1")], [], "a".repeat(40)), [failedGate], { summary: "did the thing" });
    for (const s of ["This is a fix round", "reviewed revision `aaaaaaaaaaaa`", "`F1` [high] `app.txt:1`", "Failing quality gates", "check failed: boom", "did the thing"]) {
      expect(fix).toContain(s);
    }
  });

  it("code reviewer sees the revision, gates, diff and previous findings, fenced safely", () => {
    const sha = "b".repeat(40);
    const diff = "+```js\n+code\n+```";
    const p = prompts.codeReviewer(ctx, 2, "# Final plan", "a".repeat(40), sha, [failedGate], " app.txt | 1 +", diff, true, [finding("F1")], impl("completed", ["F1"]));
    for (const s of [`Revision under review: \`${sha}\``, "[FAIL] tests", "TRUNCATED", "Implementer: fixed", `\`reviewed_commit\` must be exactly \`${sha}\``, "````diff\n+```js"]) {
      expect(p).toContain(s);
    }
    expect(prompts.fenceFor("no backticks")).toBe("```");
    expect(prompts.fenceFor("a ````` b")).toBe("``````");
  });
});
```

```ts file=test/init.test.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { detectGates, initRepo, renderConfigYaml } from "../src/core/init.js";
import { git, makeRepo } from "./helpers/repo.js";
import { tempDir } from "./helpers/tmp.js";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (dirs.length) dirs.pop()!.cleanup();
});
function tmp(): string {
  const t = tempDir();
  dirs.push(t);
  return t.path;
}

describe("detectGates", () => {
  it("finds package scripts and uses the project's package manager", () => {
    const dir = tmp();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run", lint: "eslint .", "type-check": "tsc" } }));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    expect(detectGates(dir).map((g) => [g.name, g.command])).toEqual([["test", "pnpm run test"], ["lint", "pnpm run lint"], ["typecheck", "pnpm run type-check"]]);
  });

  it("skips npm's placeholder test script and detects other ecosystems", () => {
    const dir = tmp();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(detectGates(dir)).toEqual([]);
    for (const name of ["pyproject.toml", "go.mod", "Cargo.toml"]) writeFileSync(join(dir, name), "");
    writeFileSync(join(dir, "Makefile"), "build:\n\techo build\ntest:\n\techo ok\n");
    expect(detectGates(dir).map((g) => g.name)).toEqual(["pytest", "go-test", "cargo-test", "make-test"]);
  });
});

describe("initRepo", () => {
  it("suggests detected gates as comments, ignores run data, and is idempotent", () => {
    const parent = tmp();
    const repo = makeRepo(parent, { ignoreRuns: false });
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    expect(initRepo(repo)).toMatchObject({ created: true, ignoreCreated: true, gates: [{ name: "test", command: "npm run test" }] });
    const yaml = readFileSync(join(repo, ".agentduo", "config.yaml"), "utf8");
    expect(yaml).toContain('#     command: "npm run test"');
    expect(yaml).toContain("uncomment");
    expect(yaml).toContain("role_args");
    expect(loadConfig({ dir: repo, env: { XDG_CONFIG_HOME: join(parent, "xdg") } }).data.gates).toEqual([]);
    expect(initRepo(repo)).toMatchObject({ created: false, ignoreCreated: false });
    expect(readFileSync(join(repo, ".agentduo", ".gitignore"), "utf8")).toBe("runs/\n");
    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
    expect(git(repo, "check-ignore", ".agentduo/runs/x")).toBe(".agentduo/runs/x");
  });

  it("renders a valid config when nothing is detected", () => {
    expect(renderConfigYaml([])).toContain('#     command: "npm test"');
  });
});
```

```ts file=test/doctor.test.ts
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/core/doctor.js";
import { testConfig } from "./helpers/config.js";
import { FakeClis } from "./helpers/fake-clis.js";
import { makeRepo } from "./helpers/repo.js";
import { tempDir } from "./helpers/tmp.js";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (dirs.length) dirs.pop()!.cleanup();
});

describe("runDoctor", () => {
  it("passes with working CLIs and notes where Claude's edit permission comes from", async () => {
    const t = tempDir();
    dirs.push(t);
    const repo = makeRepo(t.path);
    const checks = await runDoctor({ dir: repo, cfg: testConfig(new FakeClis(t.path)), sources: ["ws.yaml"], runsDir: join(repo, ".agentduo", "runs") });
    expect(checks.filter((c) => !c.ok && c.required)).toEqual([]);
    const text = checks.map((c) => c.message).join("\n");
    for (const s of ["codex CLI:", "codex-fake 1.0.0", "claude supports --output-format, --verbose, --json-schema, --permission-prompts", "schema review",
      ".agentduo/runs/ is git-ignored", "config: ws.yaml", "implementer edits rely on your Claude Code permission settings"]) {
      expect(text).toContain(s);
    }
    const cfg = testConfig(new FakeClis(join(t.path, "b")));
    cfg.claude.role_args = { implementer: ["--permission-mode", "acceptEdits"] };
    const quiet = await runDoctor({ dir: repo, cfg, sources: [], runsDir: join(repo, ".agentduo", "runs") });
    expect(quiet.map((c) => c.message).join("\n")).not.toContain("implementer edits rely on");
  });

  it("reports missing CLIs, missing flags and config errors, and skips the ignore check outside the workspace", async () => {
    const t = tempDir();
    dirs.push(t);
    const repo = makeRepo(t.path);
    const cfg = testConfig(new FakeClis(t.path));
    cfg.codex.bin = join(t.path, "missing");
    const oldClaude = join(t.path, "old-claude");
    writeFileSync(oldClaude, "#!/bin/sh\necho claude 0.1\n");
    chmodSync(oldClaude, 0o755);
    cfg.claude.bin = oldClaude;
    const checks = await runDoctor({ dir: repo, cfg, sources: [], configError: "bad gates", runsDir: join(t.path, "elsewhere") });
    expect(checks.find((c) => c.message.startsWith("codex CLI not found"))?.ok).toBe(false);
    expect(checks.find((c) => c.message.startsWith("claude supports"))?.message).toContain("missing: --output-format");
    expect(checks.find((c) => c.message.startsWith("config:"))).toMatchObject({ ok: false, message: "config: bad gates" });
    expect(checks.some((c) => c.message.includes("git-ignored"))).toBe(false);
  });
});
```

```ts file=test/cli.test.ts
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyColorPreference, isBackgroundFromPs, main, type CliIO } from "../src/cli.js";
import { RunStore } from "../src/core/state.js";
import { approval, critique, finding, impl, plan, review } from "./helpers/builders.js";
import { testConfig, type ConfigOverrides } from "./helpers/config.js";
import { FakeClis } from "./helpers/fake-clis.js";
import { git, makeRepo } from "./helpers/repo.js";
import { tempDir } from "./helpers/tmp.js";

let t: { path: string; cleanup(): void };
let fake: FakeClis;
let repo: string;

beforeEach(() => {
  t = tempDir();
  repo = makeRepo(t.path);
  fake = new FakeClis(t.path).install();
});
afterEach(() => {
  fake.restore();
  t.cleanup();
});

function writeConfig(dir: string, overrides: ConfigOverrides = {}): void {
  mkdirSync(join(dir, ".agentduo"), { recursive: true });
  writeFileSync(join(dir, ".agentduo", "config.yaml"), YAML.stringify(testConfig(fake, overrides)));
}

async function cli(args: string[], cwd = repo, extra: Partial<CliIO> = {}): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io: CliIO = {
    stdout: { write: (s: string) => { out += s; } },
    stderr: { write: (s: string) => { err += s; } },
    stdin: {},
    env: { ...process.env, XDG_CONFIG_HOME: join(t.path, "xdg"), CI: "" },
    cwd,
    ...extra,
  };
  const code = await main(args, io);
  return { code, out, err };
}

const happy = () => ({
  planner: [{ output: plan() }],
  plan_reviewer: [{ output: critique(true) }],
  plan_finalizer: [{ output: approval(true) }],
  implementer: [{ write: { "app.txt": "fixed\n" }, output: impl() }],
  code_reviewer: [{ output: review(true) }],
});

describe("cli", () => {
  it("prints the version", async () => {
    const r = await cli(["--version"]);
    expect([r.code, r.out.trim()]).toEqual([0, "0.1.0"]);
  });

  it("runs a task in the current directory, on a dirty tree, with plain output", async () => {
    writeConfig(repo);
    writeFileSync(join(repo, "README.md"), "local edit\n");
    fake.setScenario(happy());
    const r = await cli(["Make app.txt fixed"]);
    expect(r.code, r.err).toBe(0);
    for (const s of ["agentduo 0.1.0 · run", "▶ planner", "Codex → Claude  Plan v1", "Claude → Codex  approved", "✓ gate check", "[DONE]"]) expect(r.out).toContain(s);
    expect((await cli(["list"])).out).toContain("DONE");
    expect((await cli(["status"])).out).toMatch(/Run \S+ — DONE/);
  });

  it("treats a subdirectory (or --dir) as the workspace", async () => {
    const ws = join(repo, "gói pkg");
    mkdirSync(ws);
    writeFileSync(join(ws, "check.mjs"), 'import { existsSync, readFileSync } from "node:fs";\nprocess.exit(existsSync("app.txt") && readFileSync("app.txt", "utf8").includes("fixed") ? 0 : 1);\n');
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "add pkg");
    writeConfig(ws);
    fake.setScenario(happy());
    const r = await cli(["Make app.txt fixed", "--dir", ws], t.path);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(ws, "app.txt"))).toBe(true);
    expect(existsSync(join(repo, "app.txt"))).toBe(false);
    expect(RunStore.list(join(ws, ".agentduo", "runs"))).toHaveLength(1);
    expect(existsSync(join(repo, ".agentduo", "runs"))).toBe(false);
  });

  it("refuses bad starts before calling any agent", async () => {
    writeConfig(repo);
    fake.setScenario(happy());
    expect((await cli([])).err).toContain("a task description is required");
    const outside = join(t.path, "plain folder");
    mkdirSync(outside);
    const notGit = await cli(["Fix"], outside);
    expect([notGit.code, notGit.err.includes("is not inside a git repository (run 'git init' here, or 'duo init' to be asked)")]).toEqual([1, true]);
    const missingFile = await cli(["--task-file", join(t.path, "nope.md")]);
    expect([missingFile.code, missingFile.err.includes("cannot read task file")]).toEqual([1, true]);
    expect((await cli(["stauts"])).err).toContain("did you mean 'status'");
    writeConfig(repo, { codex: { bin: join(t.path, "missing") } });
    expect((await cli(["Fix"])).err).toContain("CLI not found: codex");
    expect(fake.calls()).toEqual([]);
  });

  it("accepts a task that starts with a dash after --", async () => {
    writeConfig(repo);
    fake.setScenario(happy());
    const r = await cli(["--", "-fix app.txt"]);
    expect(r.code, r.err).toBe(0);
    expect(fake.calls("planner")[0]!.prompt).toContain("-fix app.txt");
  });

  it("resumes with the run's saved config unless --reload-config", async () => {
    writeConfig(repo, { limits: { max_review_rounds: 1 } });
    fake.setScenario({ ...happy(), code_reviewer: [{ output: review(false, [finding("F1")]) }] });
    const first = await cli(["Make app.txt fixed"]);
    expect(first.code).toBe(2);
    expect(first.out).toContain("HUMAN_REVIEW needed (max_review_rounds)");
    writeConfig(repo, { codex: { bin: join(t.path, "missing") } });
    expect((await cli(["resume", "--reload-config", "--decision", "resume"])).err).toContain("CLI not found: codex");
    writeConfig(repo, { limits: { max_review_rounds: 1 } });
    const store = RunStore.open(join(repo, ".agentduo", "runs"));
    writeFileSync(store.path("config.json"), JSON.stringify(testConfig(fake, { limits: { max_review_rounds: 1 } })));
    writeConfig(repo, { codex: { bin: join(t.path, "missing") } });
    expect((await cli(["resume", "--decision", "resume"])).code).toBe(2);
    expect((await cli(["resume", "--note", "x"])).err).toContain("--note is only accepted together with --decision");
    unlinkSync(store.path("config.json"));
    writeConfig(repo, { limits: { max_review_rounds: 1 } });
    expect((await cli(["resume", "--decision", "abort"])).code).toBe(3);
    expect(existsSync(store.path("config.json"))).toBe(true);
  });

  it("init writes the config, and offers git init outside a repository", async () => {
    const other = join(t.path, "new project");
    mkdirSync(other);
    const asked: string[] = [];
    const r = await cli(["init"], other, { stdin: { isTTY: true }, ask: async (q) => { asked.push(q); return "y"; } });
    expect(r.code).toBe(0);
    expect(asked[0]).toContain("Run 'git init' here?");
    expect(existsSync(join(other, ".git"))).toBe(true);
    expect(existsSync(join(other, ".agentduo", "config.yaml"))).toBe(true);
    const third = join(t.path, "third");
    mkdirSync(third);
    const quiet = await cli(["init"], third);
    expect(quiet.out).toContain("run 'git init' here before 'duo run'");
    expect(existsSync(join(third, ".git"))).toBe(false);
  });

  it("runs doctor, also with a broken config", async () => {
    writeConfig(repo);
    const ok = await cli(["doctor"]);
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toContain("✓ codex CLI:");
    writeFileSync(join(repo, ".agentduo", "config.yaml"), "codex:\n  bin: 5\n");
    const bad = await cli(["doctor"]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("codex.bin must be a non-empty string");
  });

  it("detects background runs and colour preferences", () => {
    expect(isBackgroundFromPs(" 4242  4242\n")).toBe(false);
    expect(isBackgroundFromPs(" 4242  5151\n")).toBe(true);
    expect(isBackgroundFromPs(" 4242  -1\n")).toBe(false);
    const env: NodeJS.ProcessEnv = {};
    applyColorPreference({ color: false }, env);
    expect(env.FORCE_COLOR).toBe("0");
    const env2: NodeJS.ProcessEnv = { NO_COLOR: "1" };
    applyColorPreference({}, env2);
    expect(env2.FORCE_COLOR).toBe("0");
    const env3: NodeJS.ProcessEnv = {};
    applyColorPreference({}, env3);
    expect(env3.FORCE_COLOR).toBeUndefined();
  });

  it("uses the plain renderer when running in the background", async () => {
    writeConfig(repo);
    fake.setScenario(happy());
    const r = await cli(["Make app.txt fixed"], repo, { stdout: { write: () => true, isTTY: true }, isBackground: () => true });
    expect(r.code).toBe(0);
  });
});
```

- [ ] **Step 3: Patch the existing tests for the new behavior**

```python file=.superpowers/patches/t1-tests.py
import re
def drop_test(path, name):
    s = open(path).read()
    start = s.index(f'  it("{name}"')
    nxt = [i for i in (s.find("\n  it(", start + 5), s.find("\n  it.skipIf(", start + 5), s.find("\n});", start)) if i != -1]
    end = min(nxt)
    s = s[:start] + s[end + 1:]
    open(path, "w").write(s)
def add_before(path, anchor, text):
    s = open(path).read(); assert anchor in s, anchor[:50]; open(path, "w").write(s.replace(anchor, text + anchor, 1))
def rep(path, old, new):
    s = open(path).read(); assert old in s, old[:60]; open(path, "w").write(s.replace(old, new, 1))

W = "test/workflow.test.ts"
for name in [
    "runs each role with its CLI permissions",
    "escalates when a read-only agent writes, and re-runs the step after a revert",
    "treats protected paths and commits by the implementer as guard violations",
    "refuses to implement on a dirty tree unless allowed",
    "guards an implementation round even when the implementer then fails",
    "keeps the round's pre-snapshot across an interrupt, so the re-run still sees earlier changes",
    "checks changes made by the quality gates",
    "sees git-ignored protected files, git hooks and the run's own files",
]:
    drop_test(W, name)
rep(W, 'import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";', 'import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";')
add_before(W, '  it("rejects decisions when none is pending", async () => {', r'''  it("passes only protocol flags plus the configured args", async () => {
    await start(happy(), { codex: { args: ["--ephemeral", "-c", "x=1"] }, claude: { role_args: { implementer: ["--permission-mode", "acceptEdits"] } } });
    for (const role of ["planner", "plan_finalizer", "code_reviewer"]) {
      const args = fake.calls(role)[0]!.args;
      expect(args).not.toContain("--sandbox");
      expect(args).toContain("x=1");
    }
    expect(fake.calls("plan_reviewer")[0]!.args).not.toContain("--tools");
    expect(fake.calls("plan_reviewer")[0]!.args).not.toContain("--permission-mode");
    expect(fake.calls("implementer")[0]!.args.slice(-2)).toEqual(["--permission-mode", "acceptEdits"]);
  });

  it("reports files changed by a read-only agent and keeps going", async () => {
    expect(await start({ ...happy(), planner: [{ write: { "sneaky.txt": "x" }, output: plan() }] })).toBe(0);
    const warnings = h.events.flatMap((e) => (e.type === "warning" ? [e.text] : []));
    expect(warnings.some((w) => w.includes("Codex (planner) changed files") && w.includes("sneaky.txt"))).toBe(true);
    expect(readRun("report.md")).toContain("sneaky.txt");
  });

  it("starts and implements on a dirty tree", async () => {
    writeFileSync(join(h.repo, "README.md"), "local edit\n");
    expect(await start(happy())).toBe(0);
  });

  it("warns when the quality gates change files", async () => {
    const touchy = 'import { writeFileSync } from "node:fs";\nwriteFileSync("gate-output.txt", "x");\nprocess.exit(0);\n';
    expect(await start({ ...happy(), implementer: [{ write: { "app.txt": "fixed\n", "check.mjs": touchy }, output: impl() }] })).toBe(0);
    expect(h.events.some((e) => e.type === "warning" && e.text.includes("quality gates modified the working tree") && e.text.includes("gate-output.txt"))).toBe(true);
  });

  it("skips VERIFY when no gates are configured and finishes on Codex approval", async () => {
    expect(await start(happy(), { gates: [] })).toBe(0);
    const st = stateOf(h);
    expect(st.history.map((x) => x.phase)).not.toContain("VERIFY");
    expect(messages().some((m) => m.kind === "gates")).toBe(false);
    expect(fake.calls("implementer")[0]!.prompt).toContain("Run the project's checks yourself");
  });

  it("clears stale gate results when re-planning", async () => {
    expect(await start({ ...happy(), implementer: [{ write: { "app.txt": "broken\n" }, output: impl() }] }, { limits: { max_consecutive_gate_failures: 1 } })).toBe(2);
    expect(stateOf(h).lastGates).not.toBeNull();
    const { wf } = resumedWorkflow(h);
    await wf.applyDecision("revise", "simpler approach");
    const st = stateOf(h);
    expect([st.lastGates, st.consecutiveGateFailures, st.phase]).toEqual([null, 0, "PLAN"]);
  });

  it("surfaces permission denials with a configuration hint", async () => {
    expect(await start({ ...happy(), implementer: [{ write: { "app.txt": "fixed\n" }, denials: [{ tool_name: "Edit", tool_use_id: "t0" }], output: impl() }] })).toBe(0);
    const hint = h.events.find((e) => e.type === "warning" && e.text.includes("was denied 1 tool call(s)"));
    expect(hint && hint.type === "warning" && hint.text).toContain('permissions.defaultMode "acceptEdits"');
  });

  it("works in a subdirectory workspace and warns about changes outside it", async () => {
    const ws = join(h.repo, "gói pkg");
    mkdirSync(ws);
    writeFileSync(join(ws, "check.mjs"), readFileSync(join(h.repo, "check.mjs"), "utf8"));
    git(h.repo, "add", "-A");
    git(h.repo, "commit", "-q", "-m", "add workspace");
    const sub = makeHarness(ws, testConfig(fake));
    fake.setScenario({ ...happy(), implementer: [{ write: { "app.txt": "fixed\n", "../outside.txt": "x\n" }, output: impl() }] });
    expect(await newWorkflow(sub, "Make app.txt fixed").wf.run()).toBe(0);
    expect(existsSync(join(ws, ".agentduo", "runs"))).toBe(true);
    expect(sub.events.some((e) => e.type === "warning" && e.text.includes("outside the workspace changed during IMPLEMENT") && e.text.includes("outside.txt"))).toBe(true);
    const reviewPrompt = fake.calls("code_reviewer")[0]!.prompt;
    expect(reviewPrompt).toContain("app.txt");
    expect(reviewPrompt).not.toContain("outside.txt");
    expect(readFileSync(join(runDirOf(sub), "report.md"), "utf8")).toContain("outside.txt");
  });

''')

G = "test/git.test.ts"
rep(G, '      expect(await g.statusPorcelain(EXCLUDE)).toContain("?? new.txt");\n', '')
add_before(G, '  it("knows HEAD, branch and whether a path is a repo or ignored", async () => {', '''  it("keeps names with tabs and quotes intact", async () => {
    const { repo } = newRepo();
    const g = new Git(repo);
    const before = await g.worktreeTree();
    writeFileSync(join(repo, "a\\tb.txt"), "x\\n");
    writeFileSync(join(repo, 'q"x.txt'), "y\\n");
    expect((await g.nameStatus(before, await g.worktreeTree())).sort()).toEqual([["A", "a\\tb.txt"], ["A", 'q"x.txt']]);
  });

  it("scopes snapshots and diffs to a workspace subdirectory", async () => {
    const { repo } = newRepo();
    const ws = join(repo, "gói pkg");
    mkdirSync(ws);
    writeFileSync(join(ws, "a.txt"), "a\\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "ws");
    const g = new Git(ws);
    expect(await g.prefix()).toBe("gói pkg");
    expect(await new Git(repo).prefix()).toBe("");
    const base = await g.snapshot();
    const wholeBefore = await g.worktreeTree([], ":/");
    writeFileSync(join(ws, "a.txt"), "a2\\n");
    writeFileSync(join(repo, "outside.txt"), "o\\n");
    const snap = await g.snapshot();
    expect(await g.nameStatus(base.tree, snap.tree)).toEqual([["M", "a.txt"]]);
    expect(await g.diffStat(base.commit, snap.commit)).toContain("a.txt");
    expect(await g.diff(base.commit, snap.commit)).not.toContain("outside.txt");
    const wholeAfter = await g.worktreeTree([], ":/");
    expect(await g.outsideChanges(wholeBefore, wholeAfter)).toEqual([["A", "outside.txt"]]);
  });

''')

S = "test/state.test.ts"
rep(S, 'import { acquireRepoLock, LockError, nowIso, RunStore, slugify } from "../src/core/state.js";', 'import { acquireWorkspaceLock, LockError, nowIso, RunStore, slugify } from "../src/core/state.js";')
rep(S, '''  it("allows only one active run per repository", () => {
    const dir = runsDir();
    const release = acquireRepoLock(dir);
    expect(() => acquireRepoLock(dir)).toThrow(LockError);
    release();
    acquireRepoLock(dir)();
  });''', '''  it("allows only one active run per workspace", () => {
    const dir = runsDir();
    const release = acquireWorkspaceLock(dir);
    expect(() => acquireWorkspaceLock(dir)).toThrow(LockError);
    release();
    acquireWorkspaceLock(dir)();
  });''')
```

Run: `python3 .superpowers/patches/t1-tests.py && git rm -q test/guards.test.ts && npx vitest run 2>&1 | grep -E "Test Files|Tests "`
Expected: FAIL. Many tests fail to load or fail, for example: `loadConfig` is called with `dir`, `fenceFor` and `configFromSaved` are missing, `--dir` is unknown, `acquireWorkspaceLock` is missing, and the new workflow scenarios fail.

- [ ] **Step 4: Implement: config, types, backends, runner**

```ts file=src/core/config.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";

export type Backend = "codex" | "claude";
export type AgentRole = "planner" | "plan_reviewer" | "implementer" | "code_reviewer";
export type RoleArgs = Partial<Record<AgentRole, string[]>>;

export const AGENT_ROLES: AgentRole[] = ["planner", "plan_reviewer", "implementer", "code_reviewer"];
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;

export interface GateConfig {
  name: string;
  command: string;
  required?: boolean;
  timeout_sec?: number;
}

/**
 * agentduo's own settings: who plays which role, loop limits, optional gates, and extra CLI arguments.
 * Permissions are deliberately absent; each CLI takes them from its own configuration.
 */
export interface ConfigData {
  agents: Record<AgentRole, Backend>;
  limits: {
    max_planning_rounds: number;
    max_review_rounds: number;
    max_retries: number;
    max_consecutive_gate_failures: number;
    agent_timeout_sec: number;
    agent_idle_timeout_sec: number;
    gate_timeout_sec: number;
    max_diff_chars: number;
    max_gate_output_chars: number;
  };
  quality_gates: {
    require_plan_approval: boolean;
    require_tests_pass: boolean;
    require_codex_approval: boolean;
    stop_on_critical_issue: boolean;
    blocking_severities: string[];
    review_on_gate_failure: boolean;
  };
  gates: GateConfig[];
  safety: { pause_before_implement: boolean };
  codex: { bin: string; model: string | null; args: string[]; role_args: RoleArgs };
  claude: { bin: string; model: string | null; max_budget_usd: number | null; args: string[]; role_args: RoleArgs };
  paths: { runs_dir: string };
}

const DEFAULTS: ConfigData = {
  agents: { planner: "codex", plan_reviewer: "claude", implementer: "claude", code_reviewer: "codex" },
  limits: {
    max_planning_rounds: 4,
    max_review_rounds: 5,
    max_retries: 1,
    max_consecutive_gate_failures: 3,
    agent_timeout_sec: 1800,
    agent_idle_timeout_sec: 900,
    gate_timeout_sec: 900,
    max_diff_chars: 120000,
    max_gate_output_chars: 6000,
  },
  quality_gates: {
    require_plan_approval: true,
    require_tests_pass: true,
    require_codex_approval: true,
    stop_on_critical_issue: true,
    blocking_severities: ["critical", "high"],
    review_on_gate_failure: false,
  },
  gates: [],
  safety: { pause_before_implement: false },
  codex: { bin: "codex", model: null, args: ["--ephemeral"], role_args: {} },
  claude: { bin: "claude", model: null, max_budget_usd: null, args: ["--no-session-persistence"], role_args: {} },
  paths: { runs_dir: ".agentduo/runs" },
};

/** Keys from agentduo v1 that kept their meaning under a new name. */
const RENAMED: Record<string, string> = { "codex.extra_args": "codex.args", "claude.extra_args": "claude.args" };
/** Mappings whose keys are user-chosen (validated later) rather than fixed by the defaults. */
const OPEN_MAPPINGS = new Set(["codex.role_args", "claude.role_args"]);

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface LoadedConfig {
  data: ConfigData;
  sources: string[];
  warnings: string[];
}

export function defaultConfig(): ConfigData {
  return structuredClone(DEFAULTS);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function mergeInto(base: Record<string, unknown>, override: Record<string, unknown>, where: string, warnings: string[]): Record<string, unknown> {
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    const path = where ? `${where}.${key}` : key;
    if (!(key in base)) {
      warnings.push(RENAMED[path] ? `config key '${path}' was renamed to '${RENAMED[path]}' (ignored)` : `unknown config key '${path}' (ignored)`);
      continue;
    }
    const current = base[key];
    if ((isPlainObject(current) || Array.isArray(current)) && (value === null || value === undefined)) continue; // "codex:" / "gates:" with no body keep the defaults
    if (OPEN_MAPPINGS.has(path)) {
      out[key] = value;
      continue;
    }
    if (isPlainObject(current)) {
      if (!isPlainObject(value)) throw new ConfigError(`'${path}' must be a mapping`);
      out[key] = mergeInto(current, value, path, warnings);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32" && env.APPDATA) return join(env.APPDATA, "agentduo", "config.yaml");
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "agentduo", "config.yaml");
}

function readYaml(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = YAML.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`${path}: ${(err as Error).message}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isPlainObject(parsed)) throw new ConfigError(`${path}: top level must be a mapping`);
  return parsed;
}

/** Defaults ← user config ← `<dir>/.agentduo/config.yaml` (or --config). */
export function loadConfig(opts: { dir: string; configPath?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; validate?: boolean }): LoadedConfig {
  const warnings: string[] = [];
  const sources: string[] = [];
  let data = defaultConfig() as unknown as Record<string, unknown>;
  const dirPath = opts.configPath ? resolve(opts.configPath) : join(opts.dir, ".agentduo", "config.yaml");
  if (opts.configPath && !existsSync(dirPath)) throw new ConfigError(`config file not found: ${dirPath}`);
  const userPath = userConfigPath(opts.env ?? process.env, opts.platform ?? process.platform);
  for (const path of userPath === dirPath ? [dirPath] : [userPath, dirPath]) {
    if (!existsSync(path)) continue;
    const fileWarnings: string[] = [];
    try {
      data = mergeInto(data, readYaml(path), "", fileWarnings);
    } catch (err) {
      if (err instanceof ConfigError && !err.message.startsWith(path)) throw new ConfigError(`${path}: ${err.message}`);
      throw err;
    }
    warnings.push(...fileWarnings.map((w) => `${path}: ${w}`));
    sources.push(path);
  }
  const cfg = data as unknown as ConfigData;
  if (opts.validate !== false) validateConfig(cfg, sources.join(", ") || undefined);
  return { data: cfg, sources, warnings };
}

/** A run's saved config.json, merged over today's defaults so keys added later get their default value. */
export function configFromSaved(raw: unknown): ConfigData {
  if (!isPlainObject(raw)) throw new ConfigError("saved run config is not a mapping");
  return mergeInto(defaultConfig() as unknown as Record<string, unknown>, raw, "", []) as unknown as ConfigData;
}

const isPosInt = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 1;
const isNonNegInt = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0;
const isStringList = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");

export function validateConfig(cfg: ConfigData, source?: string): void {
  const errors: string[] = [];
  for (const role of AGENT_ROLES) {
    if (cfg.agents[role] !== "codex" && cfg.agents[role] !== "claude") errors.push(`agents.${role} must be one of codex, claude`);
  }
  for (const key of ["max_planning_rounds", "max_review_rounds", "max_consecutive_gate_failures", "agent_timeout_sec",
    "gate_timeout_sec", "max_diff_chars", "max_gate_output_chars"] as const) {
    if (!isPosInt(cfg.limits[key])) errors.push(`limits.${key} must be a positive integer`);
  }
  if (!isNonNegInt(cfg.limits.max_retries)) errors.push("limits.max_retries must be an integer >= 0");
  if (!isNonNegInt(cfg.limits.agent_idle_timeout_sec)) errors.push("limits.agent_idle_timeout_sec must be an integer >= 0");
  if (!Array.isArray(cfg.quality_gates.blocking_severities)) {
    errors.push("quality_gates.blocking_severities must be a list");
  } else {
    for (const s of cfg.quality_gates.blocking_severities) {
      if (!(SEVERITIES as readonly string[]).includes(s)) errors.push(`quality_gates.blocking_severities: unknown severity '${s}'`);
    }
  }
  if (!Array.isArray(cfg.gates)) {
    errors.push("gates must be a list");
  } else {
    const names = new Set<string>();
    cfg.gates.forEach((gate, i) => {
      const g = gate as unknown;
      if (!isPlainObject(g) || typeof g.name !== "string" || !g.name || typeof g.command !== "string" || !g.command) {
        errors.push(`gates[${i}] needs 'name' and 'command'`);
        return;
      }
      if (names.has(g.name)) errors.push(`gates[${i}]: duplicate name '${g.name}'`);
      names.add(g.name);
      const unknown = Object.keys(g).filter((k) => !["name", "command", "required", "timeout_sec"].includes(k));
      if (unknown.length) errors.push(`gates[${i}]: unknown keys ${unknown.sort().join(", ")}`);
      if (g.required !== undefined && typeof g.required !== "boolean") errors.push(`gates[${i}].required must be true or false`);
      if (g.timeout_sec !== undefined && !isPosInt(g.timeout_sec)) errors.push(`gates[${i}].timeout_sec must be a positive integer`);
    });
  }
  // YAML 1.2 reads `no`/`yes` as strings; a string flag must not be mistaken for false.
  const flags: Array<[string, unknown]> = [
    ...(["require_plan_approval", "require_tests_pass", "require_codex_approval", "stop_on_critical_issue", "review_on_gate_failure"] as const)
      .map((k): [string, unknown] => [`quality_gates.${k}`, cfg.quality_gates[k]]),
    ["safety.pause_before_implement", cfg.safety.pause_before_implement],
  ];
  for (const [name, value] of flags) if (typeof value !== "boolean") errors.push(`${name} must be true or false`);
  const strings: Array<[string, unknown]> = [["codex.bin", cfg.codex.bin], ["claude.bin", cfg.claude.bin], ["paths.runs_dir", cfg.paths.runs_dir]];
  for (const [name, value] of strings) if (typeof value !== "string" || !value) errors.push(`${name} must be a non-empty string`);
  for (const [name, value] of [["codex.model", cfg.codex.model], ["claude.model", cfg.claude.model]] as const) {
    if (value !== null && typeof value !== "string") errors.push(`${name} must be a string or null`);
  }
  const budget = cfg.claude.max_budget_usd;
  if (budget !== null && !(typeof budget === "number" && budget > 0)) errors.push("claude.max_budget_usd must be a positive number or null");
  for (const backend of ["codex", "claude"] as const) {
    if (!isStringList(cfg[backend].args)) errors.push(`${backend}.args must be a list of strings`);
    const roleArgs = cfg[backend].role_args as unknown;
    if (!isPlainObject(roleArgs)) {
      errors.push(`${backend}.role_args must be a mapping of role to a list of strings`);
      continue;
    }
    for (const [role, args] of Object.entries(roleArgs)) {
      if (!(AGENT_ROLES as string[]).includes(role)) errors.push(`${backend}.role_args: unknown role '${role}' (roles: ${AGENT_ROLES.join(", ")})`);
      else if (!isStringList(args)) errors.push(`${backend}.role_args.${role} must be a list of strings`);
    }
  }
  if (errors.length) {
    throw new ConfigError(`invalid configuration${source ? ` (${source})` : ""}:\n  - ${errors.join("\n  - ")}`);
  }
}
```

```python file=.superpowers/patches/t1-agents.py
def rep(path, old, new):
    s = open(path).read(); assert old in s, (path, old[:60]); open(path, "w").write(s.replace(old, new, 1))
# types: BuildArgs carries the role instead of a permission
rep("src/agents/types.ts", 'import type { Permission } from "../core/config.js";', 'import type { AgentRole } from "../core/config.js";')
rep("src/agents/types.ts", '''export interface BuildArgs {
  schemaName: SchemaName;
  permission: Permission;
  lastMessageFile: string;
  extraAllowed: string[];
}''', '''export interface BuildArgs {
  schemaName: SchemaName;
  lastMessageFile: string;
  /** Config role of the call (plan sign-off uses "planner"); selects <backend>.role_args. */
  role: AgentRole;
}''')
# codex: protocol flags + args + role_args
rep("src/agents/codex.ts", '''  buildArgs({ schemaName, permission, lastMessageFile }: BuildArgs): string[] {
    return [
      "exec", "--json",
      "--sandbox", permission,
      "--color", "never",''', '''  buildArgs({ schemaName, lastMessageFile, role }: BuildArgs): string[] {
    return [
      "exec", "--json",
      "--color", "never",''')
rep("src/agents/codex.ts", '''      ...this.cfg.extra_args.map(String),
      "-", // read the prompt from stdin''', '''      ...this.cfg.args,
      ...(this.cfg.role_args[role] ?? []),
      "-", // read the prompt from stdin''')
# claude: protocol flags + args + role_args
rep("src/agents/claude.ts", '''  buildArgs({ schemaName, permission, extraAllowed }: BuildArgs): string[] {
    const write = permission === "workspace-write";
    const tools = write ? this.cfg.implementation_tools : this.cfg.read_only_tools;
    const allowed = write ? [...this.cfg.implementation_allowed_tools, ...extraAllowed] : [...tools];
    const disallowed = write ? this.cfg.implementation_disallowed_tools : [];
    return [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--json-schema", JSON.stringify(loadSchema(schemaName)),
      "--permission-mode", write ? "acceptEdits" : "dontAsk",
      "--permission-prompts", "none",
      "--tools", tools.join(","),
      "--allowedTools", ...allowed,
      ...(disallowed.length ? ["--disallowedTools", ...disallowed] : []),
      ...(this.cfg.model ? ["--model", this.cfg.model] : []),
      ...(this.cfg.max_budget_usd ? ["--max-budget-usd", String(this.cfg.max_budget_usd)] : []),
      ...this.cfg.extra_args.map(String),
    ];
  }''', '''  /** Protocol flags only; what Claude may do comes from the user's Claude Code settings plus args/role_args. */
  buildArgs({ schemaName, role }: BuildArgs): string[] {
    return [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--json-schema", JSON.stringify(loadSchema(schemaName)),
      "--permission-prompts", "none", // nobody can answer a prompt in -p mode; this grants nothing
      ...(this.cfg.model ? ["--model", this.cfg.model] : []),
      ...(this.cfg.max_budget_usd ? ["--max-budget-usd", String(this.cfg.max_budget_usd)] : []),
      ...this.cfg.args,
      ...(this.cfg.role_args[role] ?? []),
    ];
  }''')
# runner: no permission lookup, no extra allowlist
rep("src/agents/runner.ts", 'import { permissionFor, type AgentRole, type ConfigData } from "../core/config.js";', 'import type { AgentRole, ConfigData } from "../core/config.js";')
rep("src/agents/runner.ts", '''  check?: (data: any) => string[];
  extraAllowed?: string[];
  signal?: AbortSignal;''', '''  check?: (data: any) => string[];
  signal?: AbortSignal;''')
rep("src/agents/runner.ts", '''    const permission = permissionFor(this.cfg, o.agentRole);
''', '')
rep("src/agents/runner.ts", '''        args = backend.buildArgs({ schemaName: o.schemaName, permission, lastMessageFile, extraAllowed: o.extraAllowed ?? [] });''',
    '''        args = backend.buildArgs({ schemaName: o.schemaName, lastMessageFile, role: o.agentRole });''')
```

Run: `python3 .superpowers/patches/t1-agents.py && npx vitest run test/config.test.ts test/backends.test.ts`
Expected: config and backends tests PASS. Other files may still fail to compile until Step 6.

- [ ] **Step 5: Implement: git, state, render, prompts**

```ts file=src/core/git.ts
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class GitError extends Error {
  override name = "GitError";
}

export interface Snapshot {
  commit: string;
  tree: string;
}

export type Change = [status: string, path: string];

const IDENTITY = {
  GIT_AUTHOR_NAME: "agentduo", GIT_AUTHOR_EMAIL: "agentduo@localhost",
  GIT_COMMITTER_NAME: "agentduo", GIT_COMMITTER_EMAIL: "agentduo@localhost",
};

function parseNameStatusZ(out: string): Change[] {
  const parts = out.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i + 1 < parts.length && parts[i]; i += 2) changes.push([parts[i]!, parts[i + 1]!]);
  return changes;
}

/**
 * Git helpers for one workspace directory: every command runs with cwd = that directory, so the pathspec "."
 * means "this workspace" and ":/" the whole repository. Snapshots stage the working tree into a temporary
 * index and write an unreferenced commit; the user's index, HEAD and branches are never touched.
 */
export class Git {
  constructor(readonly dir: string) {}

  run(args: string[], opts: { env?: Record<string, string>; check?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      execFile("git", args, { cwd: this.dir, env: { ...process.env, ...opts.env }, maxBuffer: 512 * 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (error && typeof error.code === "string") {
            reject(new GitError(`cannot run git in ${this.dir}: ${error.message}`));
            return;
          }
          const code = error ? Number(error.code ?? 1) : 0;
          if (opts.check !== false && code !== 0) {
            reject(new GitError(`git ${args.join(" ")} failed: ${(stderr || stdout).trim()}`));
            return;
          }
          resolvePromise({ code, stdout, stderr });
        });
    });
  }

  async isRepo(): Promise<boolean> {
    try {
      return (await this.run(["rev-parse", "--is-inside-work-tree"], { check: false })).stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  async toplevel(): Promise<string> {
    return (await this.run(["rev-parse", "--show-toplevel"])).stdout.trim();
  }

  /** The workspace's path relative to the repository root ("" at the root). */
  async prefix(): Promise<string> {
    return (await this.run(["rev-parse", "--show-prefix"])).stdout.trim().replace(/\/$/, "");
  }

  async head(): Promise<string | null> {
    return (await this.run(["rev-parse", "--verify", "-q", "HEAD"], { check: false })).stdout.trim() || null;
  }

  async branch(): Promise<string | null> {
    return (await this.run(["symbolic-ref", "-q", "--short", "HEAD"], { check: false })).stdout.trim() || null;
  }

  async isIgnored(path: string): Promise<boolean> {
    for (const candidate of [path, `${path.replace(/\/+$/, "")}/probe`]) {
      if ((await this.run(["check-ignore", "-q", candidate], { check: false })).code === 0) return true;
    }
    return false;
  }

  /** `git add` fails when an exclude pathspec names an already-ignored path, and ignored paths are skipped anyway. */
  private async pathspec(exclude: string[], scope: "." | ":/"): Promise<string[]> {
    const kept: string[] = [];
    for (const p of exclude) if (!(await this.isIgnored(p))) kept.push(`:(exclude)${p}`);
    return ["--", scope, ...kept];
  }

  /** Tree hash of the working tree: the workspace (".") or the whole repository (":/"). */
  async worktreeTree(exclude: string[] = [], scope: "." | ":/" = "."): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "agentduo-index-"));
    const index = join(dir, "index");
    const env = { GIT_INDEX_FILE: index };
    try {
      // Seeding from the real index keeps its stat data, so `git add -A` only rehashes files that changed.
      const real = join((await this.run(["rev-parse", "--absolute-git-dir"])).stdout.trim(), "index");
      if (existsSync(real)) {
        await copyFile(real, index);
      } else {
        const head = await this.head();
        if (head) await this.run(["read-tree", head], { env });
      }
      await this.run(["add", "-A", ...(await this.pathspec(exclude, scope))], { env });
      return (await this.run(["write-tree"], { env })).stdout.trim();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async snapshot(exclude: string[] = [], ref?: string, message = "agentduo snapshot"): Promise<Snapshot> {
    const tree = await this.worktreeTree(exclude);
    const head = await this.head();
    const commit = (await this.run(["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", message], { env: IDENTITY })).stdout.trim();
    if (ref) await this.run(["update-ref", ref, commit]);
    return { commit, tree };
  }

  /** Changes inside the workspace, with paths relative to it. */
  async nameStatus(a: string, b: string): Promise<Change[]> {
    return parseNameStatusZ((await this.run(["diff", "--no-renames", "--relative", "--name-status", "-z", a, b, "--", "."])).stdout);
  }

  /** Changes outside the workspace, with paths relative to the repository root. */
  async outsideChanges(a: string, b: string): Promise<Change[]> {
    return parseNameStatusZ((await this.run(["diff", "--no-renames", "--name-status", "-z", a, b, "--", ":/", ":(exclude)."])).stdout);
  }

  async diff(a: string, b: string): Promise<string> {
    return (await this.run(["diff", "--no-color", "--relative", a, b, "--", "."])).stdout;
  }

  async diffStat(a: string, b: string): Promise<string> {
    return (await this.run(["diff", "--no-color", "--stat", "--relative", a, b, "--", "."])).stdout;
  }
}
```

```python file=.superpowers/patches/t1-state-render.py
def rep(path, old, new):
    s = open(path).read(); assert old in s, (path, old[:60]); open(path, "w").write(s.replace(old, new, 1))
P = "src/core/state.ts"
rep(P, '''  base: (Snapshot & { head: string | null; branch: string | null; dirty: boolean }) | null;
  lastSnapshot: Snapshot | null;
  /** The pre-implementation snapshot of the current round, reused when the round re-runs (resume after a failure). */
  roundPre: (Snapshot & { round: number; head: string | null; branch: string | null; protected: Record<string, string> }) | null;''',
'''  base: (Snapshot & { head: string | null; branch: string | null }) | null;
  lastSnapshot: Snapshot | null;''')
rep(P, '''  humanNotes: HumanNote[];
  costUsd: number;''', '''  humanNotes: HumanNote[];
  /** Notable things the run saw but did not act on (files changed outside the workspace, permission denials…). */
  warnings: string[];
  costUsd: number;''')
rep(P, "implRound: 0, base: null, lastSnapshot: null, roundPre: null,", "implRound: 0, base: null, lastSnapshot: null,")
rep(P, "lastImplementation: null, humanReview: null, humanNotes: [], costUsd: 0,", "lastImplementation: null, humanReview: null, humanNotes: [], warnings: [], costUsd: 0,")
rep(P, '''/** One active run per repository: concurrent runs would see each other's edits as their own. */
export function acquireRepoLock(runsDir: string): () => void {
  mkdirSync(runsDir, { recursive: true });
  const path = join(runsDir, ".lock");
  acquireLock(path, (pid) => `another agentduo run is active in this repository (pid ${pid}); wait for it to finish or stop it first`);''',
'''/** One active run per workspace: concurrent runs in one directory would review each other's edits. */
export function acquireWorkspaceLock(runsDir: string): () => void {
  mkdirSync(runsDir, { recursive: true });
  const path = join(runsDir, ".lock");
  acquireLock(path, (pid) => `another agentduo run is active in this workspace (pid ${pid}); wait for it to finish or stop it first`);''')
R = "src/core/render.ts"
rep(R, "    `- **Claude cost (reported):** $${(st.costUsd ?? 0).toFixed(2)} · **Codex tokens:** ${st.tokens ?? 0}`,",
       "    `- **Claude cost (reported):** $${(st.costUsd ?? 0).toFixed(2)} · **Tokens:** ${st.tokens ?? 0}`,")
rep(R, '''  lines.push("\\n## Unresolved issues\\n" + bullets(unresolved));''', '''  lines.push("\\n## Unresolved issues\\n" + bullets(unresolved));
  if (st.warnings?.length) lines.push("\\n## Warnings\\n" + bullets(st.warnings));''')
```

```ts file=src/core/prompts.ts
import type { AgentRole, Backend, GateConfig } from "./config.js";
import { describeGates, type GateResult } from "./gates.js";
import type { Approval, Critique, Finding, Implementation, Plan, Review } from "./outputs.js";
import { findingsMarkdown, issuesMarkdown } from "./render.js";
import type { HumanNote } from "./state.js";

export interface PromptContext {
  repo: string;
  taskId: string;
  task: string;
  agents: Record<AgentRole, Backend>;
  gates: GateConfig[];
  notes: HumanNote[];
}

export interface PlanFeedback {
  critique?: Critique;
  approval?: Approval;
}

export const SEVERITY_GUIDE = [
  "Severity scale:",
  "- critical: the work cannot succeed as written, or it would cause damage (data loss, security hole, broken build for everyone).",
  "- high: a significant gap or defect that must be fixed before moving on.",
  "- medium: should be fixed, but does not block.",
  "- low: minor improvement or nit.",
].join("\n");

export const OUTPUT_RULES = "## Output\nYour final message must be a single JSON object matching the provided output schema. No prose outside the JSON.\n";

const NAMES: Record<Backend, string> = { codex: "Codex", claude: "Claude Code" };

/** A markdown fence longer than any backtick run inside `text`, so the text cannot close it early. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function header(role: string, title: string, ctx: PromptContext): string {
  const a = ctx.agents;
  return "[orchestrator-role: " + role + "]\n" +
    "You are the **" + title + "** in a two-agent software workflow. agentduo only relays structured messages between the agents.\n" +
    "Roles: planner and plan sign-off: " + NAMES[a.planner] + "; plan critic: " + NAMES[a.plan_reviewer] + "; implementer: " +
    NAMES[a.implementer] + "; code reviewer: " + NAMES[a.code_reviewer] + ".\n" +
    "Follow your own configuration and the repository's instructions (AGENTS.md / CLAUDE.md).\n\n" +
    "- Workspace: `" + ctx.repo + "`\n" +
    "- Task ID: `" + ctx.taskId + "`\n";
}

function gateList(gates: GateConfig[]): string {
  return gates.map((g) => "- `" + g.command + "` (" + g.name + ", " + (g.required === false ? "optional" : "required") + ")").join("\n");
}

function notes(list: HumanNote[]): string {
  if (!list.length) return "";
  return "\n## Notes from the human operator (highest priority)\n" + list.map((n) => `- (${n.at}, during ${n.phase}) ${n.note}`).join("\n") + "\n";
}

function feedbackSection(feedback: PlanFeedback | null): string {
  if (!feedback) return "";
  const parts = ["\n## Feedback to address"];
  const { critique, approval } = feedback;
  if (critique) {
    parts.push(`### Plan critique (status: ${critique.status})\n${critique.summary}\n\n` + issuesMarkdown(critique.issues));
    if (critique.proposed_changes.length) parts.push("Proposed changes:\n" + critique.proposed_changes.map((c) => `- ${c}`).join("\n"));
    if (critique.disputed.length) parts.push("Critic still disputes:\n" + critique.disputed.map((c) => `- ${c}`).join("\n"));
  }
  if (approval) parts.push(`### Final-approval review (status: ${approval.status})\n${approval.summary}\n\n` + issuesMarkdown(approval.issues));
  return parts.join("\n\n") + "\n";
}

export function planner(ctx: PromptContext, round: number, version: number, previousPlan: Plan | null, feedback: PlanFeedback | null): string {
  const out = [
    header("planner", "Planner / Architect", ctx),
    `- Planning round: ${round} · Producing plan version: v${version}\n`,
    "## Task\n" + ctx.task + "\n",
    notes(ctx.notes),
    "## Your job\n" +
      "Study the repository and produce an implementation plan that the implementer can execute without further clarification.\n" +
      "- Goals and explicit scope (in / out). Keep the scope to what the task needs.\n" +
      "- Architecture / design decisions that fit the existing code and conventions.\n" +
      "- Ordered, concrete steps; list the files each step creates or changes.\n" +
      "- Acceptance criteria that are objective and testable.\n" +
      "- Risks with mitigations, and a test strategy (which tests to add or update).\n" +
      "- Open questions only for things that truly cannot be decided from the repository; state the assumption you made for each.\n" +
      (ctx.gates.length ? "\nAfter implementation agentduo runs these commands and shows their results to the code reviewer:\n" + gateList(ctx.gates) + "\n" : ""),
  ];
  if (!previousPlan) {
    out.push("\nThis is the first version: return `feedback_resolution` as an empty list.\n");
  } else {
    out.push(`\n## Previous plan (v${version - 1}) as JSON\n` + "```json\n" + JSON.stringify(previousPlan, null, 2) + "\n```\n");
    out.push(feedbackSection(feedback));
    out.push("\nRevise the plan to address the feedback. In `feedback_resolution`, add one entry per issue id " +
      "above with decision `accepted`, `partially_accepted` or `disputed` and a rationale. Dispute only " +
      "with a concrete technical reason; disputed critical/high issues will go back to the critic.\n");
  }
  out.push(OUTPUT_RULES);
  return out.join("\n");
}

export function planReviewer(ctx: PromptContext, round: number, version: number, planMd: string, previousCritique: Critique | null): string {
  const out = [
    header("plan_reviewer", "Plan Critic", ctx),
    `- Planning round: ${round} · Plan under review: v${version}\n`,
    "## Task\n" + ctx.task + "\n",
    notes(ctx.notes),
    "## Plan under review\n" + planMd + "\n",
    "## Your job\n" +
      "Judge whether this plan is feasible in THIS codebase; the implementer must be able to execute it without guessing:\n" +
      "- Do the files, modules, APIs and commands it relies on actually exist and work as assumed?\n" +
      "- Missing steps, wrong ordering, hidden dependencies, migration or compatibility concerns.\n" +
      "- Are the acceptance criteria objective and testable?\n" +
      "- Risks the planner missed; unnecessary scope; ambiguity that would force guessing.\n" +
      (ctx.gates.length ? "\nCommands agentduo runs after implementation:\n" + gateList(ctx.gates) + "\n" : "") + "\n" +
      SEVERITY_GUIDE + "\n\n" +
      "Decision rules:\n" +
      "- Set `approved: true` and `status: \"approved\"` only if no critical or high issue remains. " +
      "Medium/low issues may accompany an approval as suggestions.\n" +
      "- Give each issue a stable id (`C1`, `C2`, ...). Reuse the same id when you re-raise an issue from a previous round.\n" +
      "- `accepted`: planner responses (by issue id and short reason) you now agree with. `disputed`: planner responses you " +
      "still disagree with, with your reasoning; re-raise any still-blocking one in `issues`.\n" +
      "- `proposed_changes`: concrete edits to the plan you recommend.\n",
  ];
  if (previousCritique) {
    out.push("\n## Your critique from the previous round\n" + issuesMarkdown(previousCritique.issues) +
      "\n\nCheck how the new plan version addressed each of these (see its 'Response to feedback' section).\n");
  }
  out.push(OUTPUT_RULES);
  return out.join("\n");
}

export function planFinalizer(ctx: PromptContext, round: number, version: number, planMd: string, critique: Critique): string {
  return [
    header("plan_finalizer", "Planner / Architect (final plan sign-off)", ctx),
    `- Planning round: ${round} · Plan up for sign-off: v${version}\n`,
    "## Task\n" + ctx.task + "\n",
    notes(ctx.notes),
    "## Plan\n" + planMd + "\n",
    "## The critic approved this version\n" + critique.summary + "\n\nRemaining suggestions:\n" + issuesMarkdown(critique.issues) + "\n",
    "## Your job\n" +
      "Confirm whether this exact plan version is final and ready for implementation. Approve " +
      "(`approved: true`, `status: \"approved\"`) unless you find a critical or high problem; then return " +
      "`changes_requested` with issues (ids `A1`, `A2`, ...) and the plan goes through another revision " +
      "round. Do not request changes for style or wording alone.\n\n" + SEVERITY_GUIDE + "\n",
    OUTPUT_RULES,
  ].join("\n");
}

export function implementer(ctx: PromptContext, round: number, planMd: string, findings: Finding[], review: Review | null,
  failedGates: GateResult[], previousReport: { summary: string | null } | null): string {
  const out = [
    header("implementer", "Implementer", ctx),
    `- Implementation round: ${round}\n`,
    "## Task\n" + ctx.task + "\n",
    notes(ctx.notes),
    "## Final approved plan\n" + planMd + "\n",
    "## How to work\n" +
      "- Implement the plan and stay within its scope.\n" +
      (ctx.gates.length
        ? "- After your turn agentduo runs these commands and shows the results to the code reviewer; make them pass:\n" + gateList(ctx.gates) + "\n"
        : "- Run the project's checks yourself, as your configuration and the repository's instructions describe.\n") +
      "- If you cannot proceed (missing information, contradictory requirements, missing permissions), stop and return " +
      "`status: \"blocked\"` with a precise `blocking_reason`.\n",
  ];
  if (round === 1 && !findings.length && !failedGates.length) {
    out.push("\nImplement the plan now. `addressed_findings` should be an empty list.\n");
  } else {
    out.push("\n## This is a fix round\nYour previous implementation is already in the working tree. " +
      "Address the problems below without redoing unrelated work.\n");
    if (findings.length) {
      const sha = review ? review.reviewed_commit.slice(0, 12) : "?";
      out.push("### Code review findings (reviewed revision `" + sha + "`)\n" + (review ? review.summary + "\n\n" : "") +
        findingsMarkdown(findings) + "\n\nFor every finding id, add an entry to `addressed_findings`: `fixed`, " +
        "`not_applicable`, or `disputed` with a concrete technical justification.\n");
    }
    if (failedGates.length) out.push("### Failing quality gates (run by agentduo)\n" + describeGates(failedGates) + "\n");
    if (previousReport?.summary) out.push("### Your previous report\n" + previousReport.summary + "\n");
  }
  out.push("## Output\nYour final message must be a single JSON object matching the output schema: summary, files_changed, " +
    "tests_run (what you actually ran and whether it passed) and addressed_findings.\n");
  return out.join("\n");
}

export function codeReviewer(ctx: PromptContext, round: number, planMd: string, base: string, snapshot: string, gateResults: GateResult[],
  diffStat: string, diff: string, truncated: boolean, previousFindings: Finding[], implReport: Implementation): string {
  const tests = implReport.tests_run.map((t) => "- `" + t.command + "` passed=" + t.passed + " " + t.notes).join("\n") || "_(none)_";
  const fence = fenceFor(diff);
  const out = [
    header("code_reviewer", "Code Reviewer", ctx),
    `- Review round: ${round}\n` +
      "- Revision under review: `" + snapshot + "` (agentduo snapshot of the workspace)\n" +
      "- Base revision: `" + base + "`\n",
    "## Task\n" + ctx.task + "\n",
    notes(ctx.notes),
    "## Final approved plan\n" + planMd + "\n",
    "## Quality gate results (run by agentduo on this revision)\n" + describeGates(gateResults) + "\n",
    "## Implementer's report\n" + implReport.summary + "\n\nTests the implementer says it ran:\n" + tests + "\n",
    "## Diff stat (base → revision)\n```\n" + (diffStat.trimEnd() || "(no changes)") + "\n```\n",
    "## Diff" + (truncated ? " (TRUNCATED: run `git diff " + base + " " + snapshot + " -- .` for the full diff)" : "") + "\n" +
      fence + "diff\n" + diff + "\n" + fence + "\n",
  ];
  if (previousFindings.length) {
    const responses = new Map(implReport.addressed_findings.map((a) => [a.finding_id, a]));
    const lines = previousFindings.map((f) => {
      const r = responses.get(f.id);
      const reply = r ? `${r.resolution}: ${r.notes}` : "no response";
      return "- `" + f.id + "` [" + f.severity + "] " + f.file + " — " + f.issue + "  \n  Implementer: " + reply;
    });
    out.push("## Findings from the previous review and the implementer's responses\n" + lines.join("\n") +
      "\n\nVerify each one against the new revision. List ids that are now resolved in `resolved_findings`; " +
      "re-raise unresolved ones in `findings` with the same id. Accept a dispute only if the justification is technically sound.\n");
  }
  out.push(
    "## Your job\n" +
    "Review the change against the plan and its acceptance criteria: correctness, edge cases, error " +
    "handling, security, test adequacy, scope creep, and consistency with the codebase's conventions. " +
    "The workspace currently equals the revision under review, so you may read files directly.\n\n" +
    SEVERITY_GUIDE + "\n\n" +
    "Decision rules:\n" +
    "- Approve (`approved: true`, `status: \"approved\"`) only if there is no critical or high finding and the acceptance " +
    "criteria are met" + (ctx.gates.length ? ", and the required quality gates pass" : "") + ".\n" +
    "- `reviewed_commit` must be exactly `" + snapshot + "`.\n" +
    "- New finding ids continue the sequence `F1`, `F2`, ...; `file` is workspace-relative (empty string if " +
    "general) and `line` may be null.\n",
    OUTPUT_RULES);
  return out.join("\n");
}
```

Run: `python3 .superpowers/patches/t1-state-render.py && npx vitest run test/prompts.test.ts test/git.test.ts test/state.test.ts`
Expected: PASS.

- [ ] **Step 6: Implement: workflow**

```ts file=src/core/workflow.ts
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { AgentRunner, type AgentResult } from "../agents/runner.js";
import type { SchemaName } from "../agents/schema.js";
import type { Decider, DuoEvent, EventBus, HistoryEntry, Message, Party, Phase, Role } from "../events.js";
import type { AgentRole, ConfigData } from "./config.js";
import { GatesInterrupted, requiredPassed, runGates, type GateResult } from "./gates.js";
import { Git, type Change } from "./git.js";
import type { Approval, Critique, Finding, Implementation, Issue, Plan, Review } from "./outputs.js";
import * as prompts from "./prompts.js";
import * as render from "./render.js";
import { nowIso, type RunState, type RunStore } from "./state.js";

export const EXIT = { DONE: 0, ERROR: 1, HUMAN_REVIEW: 2, ABORTED: 3, INTERRUPTED: 130 } as const;

// "--decision resume" after an escalation raised in these phases starts a new implementation round;
// from anywhere else it re-runs the same round.
const NEW_ROUND_FROM: Phase[] = ["VERIFY", "CODE_REVIEW"];
const IMPL_PHASES: Phase[] = ["IMPLEMENT", "VERIFY", "CODE_REVIEW"];
const PHASE_ROLES: Partial<Record<Phase, { role: Role; agentRole: AgentRole }>> = {
  PLAN: { role: "planner", agentRole: "planner" },
  PLAN_REVIEW: { role: "plan_reviewer", agentRole: "plan_reviewer" },
  PLAN_FINALIZE: { role: "plan_finalizer", agentRole: "planner" },
  IMPLEMENT: { role: "implementer", agentRole: "implementer" },
  CODE_REVIEW: { role: "code_reviewer", agentRole: "code_reviewer" },
};
const ROLE_NAMES: Record<Role, string> = {
  planner: "planner", plan_reviewer: "plan critic", plan_finalizer: "plan sign-off", implementer: "implementer", code_reviewer: "code reviewer",
};
const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const MAX_WARNINGS = 50;

class Interrupted extends Error {}

export class DecisionError extends Error {
  override name = "DecisionError";
}

export interface WorkflowOptions {
  cfg: ConfigData;
  /** The workspace directory: agents run here and snapshots/diffs are limited to it. */
  repo: string;
  store: RunStore;
  state: RunState;
  bus: EventBus;
  decider: Decider;
  runner?: AgentRunner;
}

function relativeInside(path: string, root: string): string | null {
  const rel = relative(resolve(root), resolve(path));
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split("\\").join("/") : null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const planHash = (plan: Plan) => createHash("sha256").update(stableStringify(plan)).digest("hex");

function consistentStatus(d: { approved: boolean; status: string }): string[] {
  return d.approved !== (d.status === "approved") ? [`'approved' (${d.approved}) contradicts 'status' ('${d.status}')`] : [];
}

const bySeverity = <T extends { severity: string }>(xs: T[]) =>
  [...xs].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
const issueItems = (issues: Issue[]) => bySeverity(issues).map((i) => `[${i.severity}] ${i.id} ${i.description}`);
const findingItems = (findings: Finding[]) =>
  bySeverity(findings).map((f) => `[${f.severity}] ${f.id} ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} ` : ""}${f.issue}`);
const listChanges = (changes: Change[], max = 10) =>
  changes.slice(0, max).map(([s, p]) => `${s} ${p}`).join(", ") + (changes.length > max ? `, … (${changes.length - max} more)` : "");

function lastLine(text: string): string {
  const line = text.trim().split("\n").filter((l) => l.trim()).at(-1) ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

export class Workflow {
  private readonly git: Git;
  private readonly runner: AgentRunner;
  private readonly snapshotExclude: string[];
  private readonly abort = new AbortController();
  private stopRequested = false;
  private phaseStartedAt = Date.now();
  private inSubdir: boolean | null = null;

  constructor(private readonly o: WorkflowOptions) {
    this.git = new Git(o.repo);
    this.runner = o.runner ?? new AgentRunner(o.cfg, o.repo, o.store.path("logs"), o.bus);
    const runsRel = relativeInside(o.store.runsDir, o.repo);
    this.snapshotExclude = runsRel ? [runsRel] : [];
  }

  get state(): RunState {
    return this.o.state;
  }

  /** Stop cleanly after the step that is running now; the run stays resumable. */
  requestStop(): void {
    this.stopRequested = true;
  }

  /** Kill the running agent or gate now; that step re-runs on resume. */
  interrupt(): void {
    this.abort.abort();
  }

  // ------------------------------------------------------------------ loop
  async run(): Promise<number> {
    const st = this.state;
    this.emit({ type: "run.started", runId: st.taskId, task: st.task, repo: this.o.repo, runDir: this.o.store.dir });
    if (st.inProgress) this.warn(`previous run was interrupted during ${st.inProgress.phase}; re-running it`);
    for (;;) {
      const phase = st.phase;
      if (phase === "DONE") return this.finish("DONE", EXIT.DONE);
      if (phase === "ABORTED") return this.finish("ABORTED", EXIT.ABORTED);
      if (phase === "HUMAN_REVIEW") {
        st.inProgress = null;
        this.save();
        await this.writeReport();
        const review = st.humanReview!;
        this.emit({ type: "human.required", runId: st.taskId, review });
        const answer = await this.o.decider.decide(review);
        if (answer === "defer") return this.finish("HUMAN_REVIEW", EXIT.HUMAN_REVIEW);
        await this.applyDecision(answer.decision, answer.note);
        continue;
      }
      if (this.stopRequested) return this.finish("INTERRUPTED", EXIT.INTERRUPTED);
      st.inProgress = { phase, startedAt: nowIso() };
      this.save();
      this.phaseStartedAt = Date.now();
      this.emitPhaseStarted(phase);
      try {
        await this.handler(phase)();
      } catch (err) {
        if (err instanceof Interrupted || this.abort.signal.aborted) return this.finish("INTERRUPTED", EXIT.INTERRUPTED);
        const e = err as Error;
        this.o.store.writeText(`logs/error-step${String(st.step + 1).padStart(3, "0")}.txt`, e.stack ?? String(e));
        this.escalate("orchestrator_error", `${e.name}: ${e.message}`, phase);
      }
      st.inProgress = null;
      this.save();
    }
  }

  private handler(phase: Phase): () => Promise<void> {
    switch (phase) {
      case "PLAN": return () => this.stepPlan();
      case "PLAN_REVIEW": return () => this.stepPlanReview();
      case "PLAN_FINALIZE": return () => this.stepPlanFinalize();
      case "IMPLEMENT": return () => this.stepImplement();
      case "VERIFY": return () => this.stepVerify();
      case "CODE_REVIEW": return () => this.stepCodeReview();
      default: throw new Error(`no handler for phase ${phase}`);
    }
  }

  private async finish(phase: "DONE" | "ABORTED" | "HUMAN_REVIEW" | "INTERRUPTED", exitCode: number): Promise<number> {
    if (phase !== "INTERRUPTED") this.state.inProgress = null;
    this.save();
    const reportPath = await this.writeReport();
    this.emit({ type: "run.finished", runId: this.state.taskId, phase, reportPath, exitCode });
    return exitCode;
  }

  // --------------------------------------------------------------- helpers
  private emit(event: DuoEvent): void {
    this.o.bus.emit(event);
  }

  /** Shown on screen and kept for the report; warnings never stop the run. */
  private warn(text: string): void {
    const st = this.state;
    st.warnings ??= [];
    if (st.warnings.length < MAX_WARNINGS) st.warnings.push(text);
    this.emit({ type: "warning", text });
  }

  private save(): void {
    this.o.store.saveState(this.state);
  }

  private ctx(): prompts.PromptContext {
    const st = this.state;
    return { repo: this.o.repo, taskId: st.taskId, task: st.task, agents: this.o.cfg.agents, gates: this.o.cfg.gates, notes: st.humanNotes };
  }

  private party(role: AgentRole): Party {
    return this.o.cfg.agents[role];
  }

  private agentName(role: AgentRole): string {
    return this.o.cfg.agents[role] === "codex" ? "Codex" : "Claude";
  }

  private logPrefix(label: string, round: number): string {
    return `${String(this.state.step + 1).padStart(3, "0")}-${label}-r${round}`;
  }

  private ref(name: string): string {
    return `refs/agentduo/${this.state.taskId}/${name}`;
  }

  private tree(): Promise<string> {
    return this.git.worktreeTree(this.snapshotExclude);
  }

  /** Whole-repository tree; only computed when the workspace is a subdirectory, to notice edits outside it. */
  private async outsideTree(): Promise<string | null> {
    if (this.inSubdir === null) this.inSubdir = (await this.git.prefix()) !== "";
    return this.inSubdir ? this.git.worktreeTree(this.snapshotExclude, ":/") : null;
  }

  private async warnOutside(before: string | null, phase: Phase): Promise<void> {
    if (!before) return;
    const after = await this.outsideTree();
    if (!after || after === before) return;
    const changes = await this.git.outsideChanges(before, after);
    if (changes.length) this.warn(`${changes.length} file(s) outside the workspace changed during ${phase}: ${listChanges(changes)}`);
  }

  private emitPhaseStarted(phase: Phase): void {
    const st = this.state;
    const info = PHASE_ROLES[phase];
    this.emit({
      type: "phase.started", step: st.step + 1, phase,
      round: IMPL_PHASES.includes(phase) ? Math.max(st.implRound, 1) : st.planningRound,
      role: info?.role, agent: phase === "VERIFY" ? "gates" : info ? this.party(info.agentRole) : undefined,
      planning: { round: st.planningRound, limit: st.limits.planningRounds },
      impl: { round: st.implRound, limit: st.limits.reviewRounds },
    });
  }

  private record(phase: Phase, round: number, agent: string, status: string, summary: string,
    kind: HistoryEntry["kind"] = "info", artifact: string | null = null, usage?: AgentResult): void {
    const st = this.state;
    st.step += 1;
    const entry: HistoryEntry = { step: st.step, phase, round, agent, status, summary, kind, at: nowIso(), artifact };
    st.history.push(entry);
    this.o.store.appendEvent({ type: "step", ...entry });
    this.emit({
      type: "step.completed", entry, durationSec: (Date.now() - this.phaseStartedAt) / 1000,
      costUsd: usage?.costUsd ?? undefined, tokens: usage?.tokens ?? undefined,
    });
  }

  private message(m: Message): void {
    this.emit({ type: "message", message: m });
  }

  private escalate(reason: string, message: string, resumePhase: Phase, details: string[] = []): void {
    const st = this.state;
    const fromPhase = st.phase;
    st.humanReview = { reason, message, fromPhase, resumePhase, details, at: nowIso() };
    st.phase = "HUMAN_REVIEW";
    this.record("HUMAN_REVIEW", IMPL_PHASES.includes(fromPhase) ? st.implRound : st.planningRound, "orchestrator", reason, message, "warn");
  }

  private async envelope(role: Role, round: number, r: AgentResult, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const st = this.state;
    return {
      task_id: st.taskId, role, agent: r.backend, round, timestamp: nowIso(), git_sha: await this.git.head(),
      plan_version: st.planVersion, attempts: r.attempts, duration_sec: Math.round(r.durationSec * 10) / 10,
      cost_usd: r.costUsd, tokens: r.tokens, meta: r.meta, ...extra, output: r.data,
    };
  }

  private addUsage(r: AgentResult): void {
    const st = this.state;
    if (r.costUsd) st.costUsd = Math.round((st.costUsd + r.costUsd) * 10000) / 10000;
    if (r.tokens) st.tokens += r.tokens;
  }

  private blocking<T extends { severity: string }>(issues: T[]): T[] {
    const severities = new Set(this.o.cfg.quality_gates.blocking_severities);
    return issues.filter((i) => severities.has(i.severity));
  }

  private lastCritique(beforeRound: number): Critique | null {
    for (let r = beforeRound - 1; r >= 1; r--) {
      const name = `critique.r${r}.json`;
      if (this.o.store.exists(name)) return this.o.store.readJson<{ output: Critique }>(name).output;
    }
    return null;
  }

  /** Planner, plan critic, plan sign-off and code reviewer. Files they change are reported, never blocked. */
  private async callReviewer<T>(role: Role, agentRole: AgentRole, label: string, prompt: string, schemaName: SchemaName,
    round: number, check?: (data: T) => string[]): Promise<AgentResult | null> {
    const beforeTree = await this.tree();
    const beforeOutside = await this.outsideTree();
    const r = await this.runner.call({ role, agentRole, prompt, schemaName, logPrefix: this.logPrefix(label, round), check, signal: this.abort.signal });
    this.addUsage(r);
    if (r.interrupted) throw new Interrupted();
    const afterTree = await this.tree();
    if (afterTree !== beforeTree) {
      const changed = await this.git.nameStatus(beforeTree, afterTree);
      if (changed.length) this.warn(`${this.agentName(agentRole)} (${ROLE_NAMES[role]}) changed files: ${listChanges(changed)}`);
    }
    await this.warnOutside(beforeOutside, this.state.phase);
    if (!r.ok) {
      this.escalate("agent_error", `${role} (${r.backend}) failed after ${r.attempts} attempt(s): ${r.error}`, this.state.phase);
      return null;
    }
    return r;
  }

  // -------------------------------------------------------------- planning
  private async stepPlan(): Promise<void> {
    const st = this.state;
    const { store } = this.o;
    const r = st.planningRound;
    const v = st.planVersion + 1;
    const previous = v > 1 ? store.readJson<{ output: Plan }>(`plan.v${v - 1}.json`).output : null;
    const prompt = prompts.planner(this.ctx(), r, v, previous, st.planFeedback);
    const check = (p: Plan) => (["goals", "scope_in", "steps", "acceptance_criteria"] as const).filter((k) => p[k].length === 0).map((k) => `'${k}' must not be empty`);
    const res = await this.callReviewer<Plan>("planner", "planner", "plan", prompt, "plan", r, check);
    if (!res) return;
    const plan = res.data as Plan;
    store.writeJson(`plan.v${v}.json`, await this.envelope("planner", r, res, { plan_version: v }));
    const md = render.planMarkdown(plan, v);
    store.writeText(`plan.v${v}.md`, md);
    store.writeText("plan.md", md);
    st.planVersion = v;
    st.planHash = planHash(plan);
    this.message({
      from: this.party("planner"), to: this.party("plan_reviewer"), kind: "plan",
      headline: `Plan v${v} "${plan.title}" · ${plan.steps.length} steps · ${plan.acceptance_criteria.length} criteria · ${plan.risks.length} risks`,
      items: plan.feedback_resolution.map((f) => `${f.issue_id} ${f.decision}: ${f.rationale}`), artifact: `plan.v${v}.md`,
    });
    this.record("PLAN", r, this.agentName("planner"), v === 1 ? "plan created" : "plan revised",
      `v${v} '${plan.title}' (${plan.steps.length} steps, ${plan.acceptance_criteria.length} acceptance criteria, ${plan.risks.length} risks)`,
      "info", `plan.v${v}.md`, res);
    st.phase = "PLAN_REVIEW";
  }

  private async stepPlanReview(): Promise<void> {
    const st = this.state;
    const { store, cfg } = this.o;
    const r = st.planningRound;
    const v = st.planVersion;
    const prompt = prompts.planReviewer(this.ctx(), r, v, store.readText(`plan.v${v}.md`), this.lastCritique(r));
    const res = await this.callReviewer<Critique>("plan_reviewer", "plan_reviewer", "plan_review", prompt, "plan_critique", r, consistentStatus);
    if (!res) return;
    const critique = res.data as Critique;
    store.writeJson(`critique.r${r}.json`, await this.envelope("plan_reviewer", r, res));
    store.appendText("plan-feedback.md", render.critiqueMarkdown(critique, r, v, this.agentName("plan_reviewer")));
    const blocking = this.blocking(critique.issues);
    const approved = critique.approved && blocking.length === 0;
    if (critique.approved && blocking.length) this.warn("the critic approved but raised blocking issues; treating as changes requested");
    this.message({
      from: this.party("plan_reviewer"), to: this.party("planner"), kind: "critique",
      headline: approved ? `approved${critique.issues.length ? ` · ${critique.issues.length} suggestion(s)` : ""}` : `changes requested · ${blocking.length} blocking`,
      items: issueItems(critique.issues), artifact: `critique.r${r}.json`,
    });
    this.record("PLAN_REVIEW", r, this.agentName("plan_reviewer"), approved ? "approved" : "changes requested",
      `${critique.issues.length} issue(s), ${blocking.length} blocking`, approved ? "ok" : "warn", `critique.r${r}.json`, res);
    if (!approved) {
      st.planFeedback = { critique };
      this.nextPlanningRound();
    } else if (cfg.quality_gates.require_plan_approval) {
      st.phase = "PLAN_FINALIZE";
    } else {
      this.freezePlan(v);
    }
  }

  private async stepPlanFinalize(): Promise<void> {
    const st = this.state;
    const { store } = this.o;
    const r = st.planningRound;
    const v = st.planVersion;
    const critique = store.readJson<{ output: Critique }>(`critique.r${r}.json`).output;
    const prompt = prompts.planFinalizer(this.ctx(), r, v, store.readText(`plan.v${v}.md`), critique);
    const res = await this.callReviewer<Approval>("plan_finalizer", "planner", "plan_finalize", prompt, "plan_approval", r, consistentStatus);
    if (!res) return;
    const approval = res.data as Approval;
    store.writeJson(`approval.r${r}.json`, await this.envelope("plan_finalizer", r, res));
    store.appendText("plan-feedback.md", render.approvalMarkdown(approval, r, v, this.agentName("planner")));
    const blocking = this.blocking(approval.issues);
    const approved = approval.approved && blocking.length === 0;
    this.message({
      from: this.party("planner"), to: this.party("implementer"), kind: "approval",
      headline: approved ? `plan finalized v${v}` : `changes requested · ${blocking.length} blocking`,
      items: issueItems(approval.issues), artifact: `approval.r${r}.json`,
    });
    this.record("PLAN_FINALIZE", r, this.agentName("planner"), approved ? "plan finalized" : "changes requested",
      `v${v}: ${approval.summary.slice(0, 120)}`, approved ? "ok" : "warn", `approval.r${r}.json`, res);
    if (approved) {
      this.freezePlan(v);
    } else {
      st.planFeedback = { critique, approval };
      this.nextPlanningRound();
    }
  }

  private nextPlanningRound(): void {
    const st = this.state;
    if (st.planningRound >= st.limits.planningRounds) {
      this.escalate("max_planning_rounds",
        `no agreed plan after ${st.planningRound} planning round(s). Read plan.md and plan-feedback.md, then 'resume' to implement ` +
        "the latest plan as-is, or 'revise' with a --note that settles the disagreement.", "IMPLEMENT");
      return;
    }
    st.planningRound += 1;
    st.phase = "PLAN";
  }

  private freezePlan(version: number, byHuman = false): void {
    const st = this.state;
    const { store, cfg } = this.o;
    st.finalPlanVersion = version;
    st.finalPlanHash = st.planHash;
    const header = `<!-- final plan v${version}, sha256 ${st.planHash}${byHuman ? ", accepted by the human operator" : ""} -->\n`;
    store.writeText("plan.final.md", header + store.readText(`plan.v${version}.md`));
    if (st.base !== null) {
      // Re-planned after implementation started: continue in a new round, with no stale review or gate results.
      st.implRound += 1;
      st.openFindings = [];
      st.lastGates = null;
      st.consecutiveGateFailures = 0;
      this.ensureReviewBudget();
    }
    if (cfg.safety.pause_before_implement && !byHuman) {
      this.escalate("plan_ready", `final plan v${version} is ready for your review (${store.path("plan.final.md")}). Resume to start implementation.`, "IMPLEMENT");
      return;
    }
    st.phase = "IMPLEMENT";
  }

  // -------------------------------------------------------- implementation
  private ensureReviewBudget(): void {
    const st = this.state;
    if (st.implRound > st.limits.reviewRounds) st.limits.reviewRounds = st.implRound + this.o.cfg.limits.max_review_rounds - 1;
  }

  private nextImplRound(): void {
    const st = this.state;
    if (st.implRound >= st.limits.reviewRounds) {
      this.escalate("max_review_rounds",
        `not approved after ${st.implRound} implementation round(s). Inspect review.json and the working tree, then 'resume' for ` +
        "more fix rounds (optionally with a --note), 'revise' to re-plan, or 'abort'.", "IMPLEMENT");
      return;
    }
    st.implRound += 1;
    st.phase = "IMPLEMENT";
  }

  private async stepImplement(): Promise<void> {
    const st = this.state;
    const { store, cfg } = this.o;
    if (st.base === null) {
      const base = await this.git.snapshot(this.snapshotExclude, this.ref("base"), `agentduo ${st.taskId}: base`);
      st.base = { commit: base.commit, tree: base.tree, head: await this.git.head(), branch: await this.git.branch() };
      st.implRound = Math.max(st.implRound, 1);
    }
    const k = st.implRound;
    const pre = await this.git.snapshot(this.snapshotExclude, this.ref(`impl-r${k}-pre`), `agentduo ${st.taskId}: before implementation round ${k}`);
    const beforeOutside = await this.outsideTree();
    const review = store.exists("review.json") ? store.readJson<{ output: Review }>("review.json").output : null;
    const failed = k > 1 ? (st.lastGates ?? []).filter((g) => !g.passed) : [];
    const prompt = prompts.implementer(this.ctx(), k, store.readText("plan.final.md"), st.openFindings, review, failed, st.lastImplementation);
    const check = (rep: Implementation) =>
      rep.status === "blocked" && !(rep.blocking_reason ?? "").trim() ? ["status is 'blocked' but blocking_reason is empty"] : [];
    const res = await this.runner.call({
      role: "implementer", agentRole: "implementer", prompt, schemaName: "implementation", logPrefix: this.logPrefix("implement", k),
      check, signal: this.abort.signal,
    });
    this.addUsage(res);
    const post = await this.git.snapshot(this.snapshotExclude, this.ref(`impl-r${k}`), `agentduo ${st.taskId}: implementation round ${k}`);
    st.lastSnapshot = { commit: post.commit, tree: post.tree };
    if (res.interrupted) throw new Interrupted();
    const changes = await this.git.nameStatus(pre.tree, post.tree);
    await this.warnOutside(beforeOutside, "IMPLEMENT");
    const denials = res.meta.permissionDenials ?? [];
    const report = res.data as Implementation | null;
    const answered = new Set((report?.addressed_findings ?? []).map((a) => a.finding_id));
    const missing = report ? st.openFindings.filter((f) => !answered.has(f.id)).map((f) => f.id) : [];
    store.writeJson(`implementation.r${k}.json`, await this.envelope("implementer", k, res, {
      pre_snapshot: pre.commit, snapshot: post.commit, changes: changes.map(([status, path]) => ({ status, path })), unanswered_findings: missing,
    }));
    st.lastImplementation = { round: k, summary: report?.summary ?? null, status: report?.status ?? null, permissionDenials: denials };
    if (denials.length) {
      this.warn(cfg.agents.implementer === "claude"
        ? `Claude was denied ${denials.length} tool call(s); allow them in your Claude Code settings (e.g. permissions.defaultMode "acceptEdits" or allow rules) or via claude.role_args.implementer`
        : `Codex was denied ${denials.length} tool call(s); allow them in your Codex configuration or via codex.role_args.implementer`);
    }
    if (!res.ok || !report) {
      this.escalate("agent_error", `implementer (${res.backend}) failed after ${res.attempts} attempt(s): ${res.error}`, "IMPLEMENT");
      return;
    }
    this.message({
      from: this.party("implementer"), to: this.party("code_reviewer"), kind: "implementation",
      headline: report.status === "blocked" ? `blocked: ${report.blocking_reason}` : `completed · ${changes.length} file(s) changed`,
      items: [
        ...report.addressed_findings.map((a) => `${a.finding_id} ${a.resolution}${a.notes ? `: ${a.notes}` : ""}`),
        ...changes.slice(0, 10).map(([s, p]) => `${s} ${p}`),
      ],
      artifact: `implementation.r${k}.json`,
    });
    this.record("IMPLEMENT", k, this.agentName("implementer"), report.status, `${changes.length} file(s) changed; ${report.summary.slice(0, 140)}`,
      report.status === "completed" ? "ok" : "warn", `implementation.r${k}.json`, res);
    if (missing.length) this.warn(`implementer did not respond to finding(s): ${missing.join(", ")}`);
    if (report.status === "blocked") {
      this.escalate("implementer_blocked", report.blocking_reason ?? "implementer reported blocked", "IMPLEMENT");
      return;
    }
    st.phase = cfg.gates.length ? "VERIFY" : "CODE_REVIEW";
  }

  private async stepVerify(): Promise<void> {
    const st = this.state;
    const { store, cfg } = this.o;
    const k = st.implRound;
    const beforeOutside = await this.outsideTree();
    let results: GateResult[];
    try {
      results = await runGates({
        gates: cfg.gates, repo: this.o.repo, logDir: store.path("gates"), label: `r${k}`, defaultTimeoutSec: cfg.limits.gate_timeout_sec,
        maxOutputChars: cfg.limits.max_gate_output_chars, bus: this.o.bus, signal: this.abort.signal,
      });
    } catch (e) {
      if (e instanceof GatesInterrupted) throw new Interrupted();
      throw e;
    }
    const tree = await this.tree();
    if (tree !== st.lastSnapshot!.tree) {
      const changed = await this.git.nameStatus(st.lastSnapshot!.tree, tree);
      if (changed.length) this.warn(`quality gates modified the working tree: ${listChanges(changed)} (re-snapshotting)`);
      const snap = await this.git.snapshot(this.snapshotExclude, this.ref(`impl-r${k}`), `agentduo ${st.taskId}: round ${k} after gates`);
      st.lastSnapshot = { commit: snap.commit, tree: snap.tree };
    }
    await this.warnOutside(beforeOutside, "VERIFY");
    store.writeJson(`gates.r${k}.json`, { round: k, snapshot: st.lastSnapshot!.commit, timestamp: nowIso(), results });
    st.lastGates = results;
    const passed = requiredPassed(results);
    st.consecutiveGateFailures = passed ? 0 : st.consecutiveGateFailures + 1;
    const enforce = cfg.quality_gates.require_tests_pass;
    const toReviewer = passed || !enforce || cfg.quality_gates.review_on_gate_failure;
    this.message({
      from: "gates", to: toReviewer ? this.party("code_reviewer") : this.party("implementer"), kind: "gates",
      headline: results.map((g) => (g.passed ? `${g.name} ✓` : `${g.name} ✗ (${g.timedOut ? "timeout" : `exit ${g.exitCode}`})`)).join(" · ") || "no gates",
      items: results.filter((g) => !g.passed).map((g) => `${g.name}: ${lastLine(g.outputTail)}`), artifact: `gates.r${k}.json`,
    });
    this.record("VERIFY", k, "gates", passed ? "passed" : "failed", results.map((g) => `${g.name} ${g.passed ? "PASS" : "FAIL"}`).join(", ") || "no gates",
      passed ? "ok" : "warn", `gates.r${k}.json`);
    if (!passed && enforce) {
      const limit = cfg.limits.max_consecutive_gate_failures;
      if (st.consecutiveGateFailures >= limit) {
        this.escalate("gates_failing", `required quality gates failed ${limit} round(s) in a row. Check the logs under gates/, then resume (optionally with a --note) or abort.`, "IMPLEMENT");
        return;
      }
      if (!cfg.quality_gates.review_on_gate_failure) {
        this.nextImplRound(); // back to the implementer without spending a review
        return;
      }
    }
    st.phase = "CODE_REVIEW";
  }

  private async stepCodeReview(): Promise<void> {
    const st = this.state;
    const { store, cfg } = this.o;
    const k = st.implRound;
    const base = st.base!.commit;
    const snap = st.lastSnapshot!.commit;
    const diff = await this.git.diff(base, snap);
    const maxChars = cfg.limits.max_diff_chars;
    const implReport = store.readJson<{ output: Implementation }>(`implementation.r${k}.json`).output;
    const prompt = prompts.codeReviewer(this.ctx(), k, store.readText("plan.final.md"), base, snap, st.lastGates ?? [],
      await this.git.diffStat(base, snap), diff.slice(0, maxChars), diff.length > maxChars, st.openFindings, implReport);
    const check = (rv: Review) => {
      const errors = consistentStatus(rv);
      if (rv.reviewed_commit !== snap) errors.push(`reviewed_commit is '${rv.reviewed_commit}', expected '${snap}'`);
      return errors;
    };
    const res = await this.callReviewer<Review>("code_reviewer", "code_reviewer", "code_review", prompt, "review", k, check);
    if (!res) return;
    const review = res.data as Review;
    const envelope = await this.envelope("code_reviewer", k, res, { base, snapshot: snap });
    store.writeJson(`review.r${k}.json`, envelope);
    store.writeJson("review.json", envelope);
    st.openFindings = review.findings;
    const blocking = this.blocking(review.findings);
    const critical = review.findings.filter((f) => f.severity === "critical");
    const gatesOk = !cfg.gates.length || !cfg.quality_gates.require_tests_pass || requiredPassed(st.lastGates ?? []);
    const approved = review.approved || !cfg.quality_gates.require_codex_approval;
    const done = approved && blocking.length === 0 && gatesOk;
    if (review.approved && blocking.length) this.warn("the reviewer approved but reported blocking findings; continuing with a fix round");
    this.message({
      from: this.party("code_reviewer"), to: this.party("implementer"), kind: "review",
      headline: done
        ? `approved${review.findings.length ? ` · ${review.findings.length} non-blocking finding(s)` : ""}`
        : `${review.findings.length} finding(s) · ${blocking.length} blocking${gatesOk ? "" : " · required gates failing"}`,
      items: findingItems(review.findings), artifact: `review.r${k}.json`,
    });
    this.record("CODE_REVIEW", k, this.agentName("code_reviewer"), done ? "approved" : "changes requested",
      `${review.findings.length} finding(s), ${blocking.length} blocking${gatesOk ? "" : ", required gates failing"}`, done ? "ok" : "warn", `review.r${k}.json`, res);
    if (done) {
      st.phase = "DONE";
      return;
    }
    if (critical.length && cfg.quality_gates.stop_on_critical_issue) {
      this.escalate("critical_finding",
        `the reviewer reported critical finding(s): ${critical.map((f) => `${f.id} ${f.issue}`).join("; ")}. Inspect them, then resume to let the ` +
        "implementer fix them, revise, or abort.", "IMPLEMENT");
      return;
    }
    this.nextImplRound();
  }

  // ---------------------------------------------------------- human review
  async applyDecision(decision: "resume" | "revise" | "abort", note?: string): Promise<void> {
    const st = this.state;
    if (st.phase !== "HUMAN_REVIEW" || !st.humanReview) throw new DecisionError(`run ${st.taskId} is not waiting for a decision (phase ${st.phase})`);
    const hr = st.humanReview;
    if (note) st.humanNotes.push({ at: nowIso(), phase: hr.fromPhase, note });
    if (decision === "abort") {
      st.phase = "ABORTED";
    } else if (decision === "revise") {
      if (IMPL_PHASES.includes(hr.fromPhase)) st.planFeedback = null; // planning-era critique is stale; the note drives the revision
      st.finalPlanVersion = null;
      st.finalPlanHash = null;
      st.lastGates = null;
      st.consecutiveGateFailures = 0;
      st.planningRound += 1;
      st.limits.planningRounds = Math.max(st.limits.planningRounds, st.planningRound + this.o.cfg.limits.max_planning_rounds - 1);
      st.phase = "PLAN";
    } else {
      const target = hr.resumePhase;
      if (target === "IMPLEMENT" && st.finalPlanVersion === null) {
        if (!st.planVersion) throw new DecisionError("there is no plan yet; use --decision revise");
        this.freezePlan(st.planVersion, true);
      } else if (target === "IMPLEMENT" && NEW_ROUND_FROM.includes(hr.fromPhase)) {
        st.implRound += 1;
        this.ensureReviewBudget();
      }
      st.consecutiveGateFailures = 0;
      st.phase = target;
    }
    st.humanReview = null;
    this.message({ from: "human", to: "orchestrator", kind: "decision", headline: `${decision}${note ? ` · "${note}"` : ""}`, items: [] });
    this.record("HUMAN_REVIEW", st.implRound || st.planningRound, "human", decision, note || `after ${hr.reason}`);
    this.save();
  }

  // ---------------------------------------------------------------- report
  async writeReport(): Promise<string> {
    const st = this.state;
    const { store } = this.o;
    const lastReview = store.exists("review.json") ? store.readJson<{ output: Review }>("review.json").output : null;
    let diffStat = "";
    if (st.base && st.lastSnapshot) {
      try {
        diffStat = await this.git.diffStat(st.base.commit, st.lastSnapshot.commit);
      } catch {
        diffStat = "";
      }
    }
    return store.writeText("report.md", render.reportMarkdown(st, diffStat, lastReview, this.lastCritique(st.planningRound + 1), store.dir));
  }
}
```

Run: `git rm -q src/core/guards.ts && npx vitest run test/workflow.test.ts test/runner.test.ts`
Expected: workflow and runner tests PASS.

- [ ] **Step 7: Implement: CLI, init, doctor**

```ts file=src/core/init.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DetectedGate {
  name: string;
  command: string;
  reason: string;
}

export interface InitResult {
  configPath: string;
  created: boolean;
  /** True when .agentduo/.gitignore was written (it ignores runs/ without touching the root .gitignore). */
  ignoreCreated: boolean;
  gates: DetectedGate[];
}

const read = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);

function packageManager(dir: string): "npm" | "pnpm" | "yarn" | "bun" {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
  return "npm";
}

export function detectGates(dir: string): DetectedGate[] {
  const gates: DetectedGate[] = [];
  const pkg = read(join(dir, "package.json"));
  if (pkg) {
    let scripts: Record<string, unknown> = {};
    try {
      scripts = JSON.parse(pkg).scripts ?? {};
    } catch {
      // unreadable package.json: no script gates
    }
    const pm = packageManager(dir);
    const wanted: Array<[string, string[]]> = [["test", ["test"]], ["lint", ["lint"]], ["typecheck", ["typecheck", "type-check"]]];
    for (const [name, candidates] of wanted) {
      const script = candidates.find((c) => typeof scripts[c] === "string");
      if (!script) continue;
      if (script === "test" && /no test specified/.test(String(scripts.test))) continue;
      gates.push({ name, command: `${pm} run ${script}`, reason: `package.json script "${script}"` });
    }
  }
  if (existsSync(join(dir, "pyproject.toml")) || existsSync(join(dir, "pytest.ini")) || (read(join(dir, "setup.cfg"))?.includes("[tool:pytest]") ?? false)) {
    gates.push({ name: "pytest", command: "python3 -m pytest", reason: "Python project (pyproject.toml / pytest.ini / setup.cfg)" });
  }
  if (existsSync(join(dir, "go.mod"))) gates.push({ name: "go-test", command: "go test ./...", reason: "go.mod" });
  if (existsSync(join(dir, "Cargo.toml"))) gates.push({ name: "cargo-test", command: "cargo test", reason: "Cargo.toml" });
  const makefile = read(join(dir, "Makefile"));
  if (makefile && /^test\s*:/m.test(makefile)) gates.push({ name: "make-test", command: "make test", reason: "Makefile target 'test'" });
  return gates;
}

/** Everything is commented out: agentduo's defaults apply until the user opts in. */
export function renderConfigYaml(gates: DetectedGate[]): string {
  const lines = [
    "# agentduo configuration for this workspace. Every key is optional (run `duo doctor` to check the setup).",
    "# Permissions are not set here: Codex and Claude Code use their own configuration.",
    "",
    "# Quality gates (optional): commands agentduo runs after every implementation round and shows to the code reviewer.",
  ];
  if (gates.length) {
    lines.push("# Detected for this project; uncomment to have agentduo run them after every implementation round:", "# gates:");
    for (const g of gates) lines.push(`#   - name: ${g.name}`, `#     command: ${JSON.stringify(g.command)}   # ${g.reason}`, "#     required: true");
  } else {
    lines.push("# gates:", "#   - name: tests", '#     command: "npm test"', "#     required: true");
  }
  lines.push(
    "",
    "# Extra CLI arguments, for every call or per role (planner, plan_reviewer, implementer, code_reviewer):",
    "# claude:",
    "#   role_args:",
    "#     implementer: [--permission-mode, acceptEdits]",
    "# codex:",
    "#   args: [--ephemeral]",
    "",
    "# limits:",
    "#   max_planning_rounds: 4",
    "#   max_review_rounds: 5",
    "#   agent_idle_timeout_sec: 900",
    "",
  );
  return lines.join("\n");
}

export function initRepo(dir: string): InitResult {
  const configPath = join(dir, ".agentduo", "config.yaml");
  const gates = detectGates(dir);
  let created = false;
  if (!existsSync(configPath)) {
    mkdirSync(join(dir, ".agentduo"), { recursive: true });
    writeFileSync(configPath, renderConfigYaml(gates));
    created = true;
  }
  const ignoreFile = join(dir, ".agentduo", ".gitignore");
  let ignoreCreated = false;
  if (!existsSync(ignoreFile)) {
    mkdirSync(join(dir, ".agentduo"), { recursive: true });
    writeFileSync(ignoreFile, "runs/\n");
    ignoreCreated = true;
  }
  return { configPath, created, ignoreCreated, gates };
}
```

```ts file=src/core/doctor.ts
import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { runProcess } from "../agents/process.js";
import { resolveBinary } from "../agents/resolve.js";
import { loadSchema, SCHEMA_NAMES, strictProblems } from "../agents/schema.js";
import type { ConfigData } from "./config.js";
import { Git } from "./git.js";

export interface Check {
  ok: boolean;
  required: boolean;
  message: string;
}

/** Flags agentduo itself needs (the protocol); permissions are the CLIs' own business. */
const PROTOCOL_FLAGS = {
  codex: { args: ["exec", "--help"], flags: ["--json", "--output-schema", "--output-last-message", "--cd"] },
  claude: { args: ["--help"], flags: ["--output-format", "--verbose", "--json-schema", "--permission-prompts"] },
} as const;
const EDIT_PERMISSION_FLAGS = ["--permission-mode", "--allowedTools", "--allowed-tools", "--dangerously-skip-permissions"];

async function probe(bin: string, args: readonly string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await runProcess(bin, [...args], { cwd, timeoutMs: 60_000 });
    return { ok: r.code === 0, out: r.stdout + r.stderr };
  } catch (e) {
    return { ok: false, out: (e as Error).message };
  }
}

function firstToken(command: string): string {
  const m = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
}

/** Environment checks for `duo doctor`. Never calls a model. */
export async function runDoctor(o: { dir: string; cfg: ConfigData; sources: string[]; configError?: string; env?: NodeJS.ProcessEnv; runsDir: string }): Promise<Check[]> {
  const env = o.env ?? process.env;
  const checks: Check[] = [];
  const add = (ok: boolean, message: string, required = true) => checks.push({ ok, required, message });

  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  add(major > 22 || (major === 22 && minor >= 12), `node ${process.versions.node} (>= 22.12)`);
  const gitVersion = await probe("git", ["--version"], o.dir);
  add(gitVersion.ok, gitVersion.ok ? gitVersion.out.trim() : "git is not installed");
  const git = new Git(o.dir);
  const isRepo = await git.isRepo();
  add(isRepo, `workspace inside a git repository: ${o.dir}`);
  add(!o.configError, o.configError ? `config: ${o.configError}` : `config: ${o.sources.length ? o.sources.join(", ") : "built-in defaults"}`);
  for (const name of SCHEMA_NAMES) {
    const problems = strictProblems(loadSchema(name));
    add(!problems.length, `schema ${name}${problems.length ? `: ${problems.join("; ")}` : ""}`);
  }
  for (const backend of ["codex", "claude"] as const) {
    if (!Object.values(o.cfg.agents).includes(backend)) continue;
    const bin = resolveBinary(o.cfg[backend].bin, backend, env);
    if (!bin) {
      add(false, `${backend} CLI not found (bin: '${o.cfg[backend].bin}')`);
      continue;
    }
    const version = await probe(bin, ["--version"], o.dir);
    add(version.ok, `${backend} CLI: ${bin} (${version.out.trim().split("\n")[0] || "?"})`);
    const spec = PROTOCOL_FLAGS[backend];
    const help = await probe(bin, spec.args, o.dir);
    const missing = spec.flags.filter((f) => !help.out.includes(f));
    add(help.ok && !missing.length, `${backend} supports ${spec.flags.join(", ")}${missing.length ? ` — missing: ${missing.join(", ")}` : ""}`);
  }
  if (o.cfg.agents.implementer === "claude") {
    const args = [...o.cfg.claude.args, ...(o.cfg.claude.role_args.implementer ?? [])];
    if (!args.some((a) => EDIT_PERMISSION_FLAGS.includes(a))) {
      add(false, 'implementer edits rely on your Claude Code permission settings (e.g. permissions.defaultMode "acceptEdits"); ' +
        "without them every edit is denied in non-interactive mode", false);
    }
  }
  for (const gate of o.cfg.gates) {
    const exe = firstToken(gate.command);
    const found = !!exe && (resolveBinary(exe, "codex", env) !== null || existsSync(join(o.dir, exe)));
    add(found, `gate '${gate.name}': ${gate.command}${found ? "" : ` — '${exe}' not found`}`, false);
  }
  if (isRepo) {
    const rel = relative(o.dir, o.runsDir);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
      const shown = rel.split("\\").join("/");
      add(await git.isIgnored(shown), `${shown}/ is git-ignored`, false);
    }
  }
  return checks;
}
```

```ts file=src/cli.ts
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command, CommanderError, Option } from "commander";
import { killAllActive } from "./agents/process.js";
import { resolveBinary } from "./agents/resolve.js";
import { configFromSaved, ConfigError, defaultConfig, loadConfig, validateConfig, type ConfigData } from "./core/config.js";
import { runDoctor } from "./core/doctor.js";
import { Git } from "./core/git.js";
import { initRepo } from "./core/init.js";
import type { Review } from "./core/outputs.js";
import { findingsMarkdown } from "./core/render.js";
import { acquireWorkspaceLock, LockError, RunStore, type RunState } from "./core/state.js";
import { DecisionError, EXIT, Workflow } from "./core/workflow.js";
import { EventBus, type Decider, type Decision } from "./events.js";
import { packageVersion } from "./paths.js";
import { formatCost, formatTokens } from "./ui/format.js";
import type { ViewKind } from "./ui/ink/HumanReviewPrompt.js";
import { attachPlainRenderer, deferDecider } from "./ui/plain.js";

export interface CliIO {
  stdout: { write(text: string): unknown; isTTY?: boolean };
  stderr: { write(text: string): unknown };
  stdin: { isTTY?: boolean };
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Subscribe to SIGINT/SIGTERM/SIGHUP; returns an unsubscribe function. */
  onSignal?: (handler: () => void) => () => void;
  /** Ask a question on the terminal; absent when nobody can answer. */
  ask?: (question: string) => Promise<string>;
  /** True when this process runs in the terminal's background process group (`duo &`). */
  isBackground?: () => boolean;
}

/** A reader that went away (`duo … | head`) must not crash the run; any other stream error still does. */
export function guardStream(stream: { on(event: "error", listener: (err: NodeJS.ErrnoException) => void): unknown }): void {
  stream.on("error", (err) => {
    if (err.code !== "EPIPE") throw err;
  });
}

/** `ps -o pgid=,tpgid=` output: background when the terminal's foreground group is another group. */
export function isBackgroundFromPs(out: string): boolean {
  const [pgid, tpgid] = out.trim().split(/\s+/).map(Number);
  return !!pgid && !!tpgid && tpgid > 0 && pgid !== tpgid;
}

/** Ink's colour support reads FORCE_COLOR when it is first imported; set it before that import. */
export function applyColorPreference(opts: { color?: boolean }, env: NodeJS.ProcessEnv): void {
  if (opts.color === false || env.NO_COLOR) env.FORCE_COLOR = "0";
}

let exitHookInstalled = false;
const STOP_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

export function processIO(): CliIO {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    guardStream(process.stdout);
    guardStream(process.stderr);
    // Agents run in their own process groups, so they do not die with us unless we kill them.
    process.once("exit", () => killAllActive());
  }
  return {
    stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, env: process.env, cwd: process.cwd(),
    onSignal: (handler) => {
      for (const signal of STOP_SIGNALS) process.on(signal, handler);
      return () => {
        for (const signal of STOP_SIGNALS) process.off(signal, handler);
      };
    },
    ask: process.stdin.isTTY
      ? async (question) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await rl.question(question);
        } finally {
          rl.close();
        }
      }
      : undefined,
    isBackground: () => {
      if (process.platform === "win32" || !process.stdout.isTTY) return false;
      const r = spawnSync("ps", ["-o", "pgid=,tpgid=", "-p", String(process.pid)], { encoding: "utf8" });
      return r.status === 0 && isBackgroundFromPs(r.stdout);
    },
  };
}

interface CommonOptions { dir?: string; config?: string; plain?: boolean; verbose?: boolean; color?: boolean }
interface RunOptions extends CommonOptions { taskFile?: string }
interface ResumeOptions extends CommonOptions { decision?: Decision["decision"]; note?: string; reloadConfig?: boolean }

class CliExit extends Error {
  constructor(readonly code: number, message = "") {
    super(message);
  }
}

interface Env { workspace: string; isRepo: boolean; git: Git; cfg: ConfigData; sources: string[]; runsDir: string }

function expandHome(path: string, env: NodeJS.ProcessEnv): string {
  return path === "~" || path.startsWith("~/") ? join(env.HOME || homedir(), path.slice(1)) : path;
}

/** The workspace is --dir or the current directory (never the repository root above it); config is loaded unvalidated. */
async function prepare(io: CliIO, opts: CommonOptions): Promise<Env> {
  const workspace = resolve(io.cwd, opts.dir ?? ".");
  if (!existsSync(workspace)) throw new CliExit(EXIT.ERROR, `no such directory: ${workspace}`);
  const git = new Git(workspace);
  const isRepo = await git.isRepo();
  const loaded = loadConfig({ dir: workspace, configPath: opts.config ? resolve(io.cwd, opts.config) : undefined, env: io.env, validate: false });
  for (const warning of loaded.warnings) io.stderr.write(`warning: ${warning}\n`);
  const runs = expandHome(String(loaded.data.paths.runs_dir), io.env);
  const runsDir = isAbsolute(runs) ? runs : join(workspace, runs);
  return { workspace, isRepo, git, cfg: loaded.data, sources: loaded.sources, runsDir };
}

function requireRunnable(env: Env, cfg: ConfigData, source: string, io: CliIO): void {
  if (!env.isRepo) throw new CliExit(EXIT.ERROR, `${env.workspace} is not inside a git repository (run 'git init' here, or 'duo init' to be asked)`);
  validateConfig(cfg, source || undefined);
  const missing = (["codex", "claude"] as const).filter((b) => Object.values(cfg.agents).includes(b) && !resolveBinary(cfg[b].bin, b, io.env));
  if (missing.length) {
    throw new CliExit(EXIT.ERROR, `CLI not found: ${missing.join(", ")}. Install it or set '<backend>.bin' in the config; run 'duo doctor' for details.`);
  }
}

function openStore(runsDir: string, runId?: string): RunStore {
  try {
    return RunStore.open(runsDir, runId);
  } catch (e) {
    throw new CliExit(EXIT.ERROR, (e as Error).message);
  }
}

function availableViews(store: RunStore, st: RunState): ViewKind[] {
  const views: ViewKind[] = [];
  if (store.exists("plan.final.md") || store.exists("plan.md")) views.push("plan");
  if (store.exists("review.json")) views.push("review");
  if (store.exists("plan-feedback.md")) views.push("feedback");
  if (st.base && st.lastSnapshot) views.push("diffstat");
  return views;
}

async function readView(kind: ViewKind, store: RunStore, st: RunState, git: Git): Promise<string | null> {
  switch (kind) {
    case "plan":
      return store.exists("plan.final.md") ? store.readText("plan.final.md") : store.exists("plan.md") ? store.readText("plan.md") : null;
    case "review": {
      if (!store.exists("review.json")) return null;
      const r = store.readJson<{ output: Review }>("review.json").output;
      return `${r.status}: ${r.summary}\n\n${findingsMarkdown(r.findings)}`;
    }
    case "feedback":
      return store.exists("plan-feedback.md") ? store.readText("plan-feedback.md") : null;
    case "diffstat":
      return st.base && st.lastSnapshot ? (await git.diffStat(st.base.commit, st.lastSnapshot.commit)) || "(no changes)" : null;
  }
}

async function execute(io: CliIO, env: Env, cfg: ConfigData, store: RunStore, state: RunState, opts: CommonOptions, decision?: Decision): Promise<number> {
  const bus = new EventBus();
  // A backgrounded process that touches the terminal's raw mode gets stopped by the shell, so it renders plain.
  const plain = !!opts.plain || io.env.CI === "true" || !io.stdout.isTTY || !!io.isBackground?.();
  const interactive = !plain && !!io.stdin.isTTY;
  const version = packageVersion();
  let workflow: Workflow | undefined;
  let presses = 0;
  const onInterrupt = () => {
    presses += 1;
    if (presses === 1) {
      workflow?.interrupt();
      return;
    }
    killAllActive();
    process.exit(EXIT.INTERRUPTED);
  };
  const onStop = () => workflow?.requestStop();
  let decider: Decider = deferDecider;
  let closeUi: () => Promise<void>;
  if (plain) {
    const detach = attachPlainRenderer(bus, io.stdout, { color: opts.color !== false && !io.env.NO_COLOR && !!io.stdout.isTTY, verbose: !!opts.verbose, version });
    closeUi = async () => detach();
  } else {
    applyColorPreference(opts, io.env);
    const { startInk } = await import("./ui/ink/session.js");
    const session = startInk({
      bus, version, verbose: !!opts.verbose, interactive, onStop, onInterrupt,
      views: () => availableViews(store, workflow?.state ?? state),
      readView: (kind) => readView(kind, store, workflow?.state ?? state, env.git),
      stdout: io.stdout as NodeJS.WriteStream, stdin: io.stdin as NodeJS.ReadStream,
    });
    decider = session.decider;
    closeUi = session.close;
  }
  workflow = new Workflow({ cfg, repo: env.workspace, store, state, bus, decider });
  const offSignal = io.onSignal?.(onInterrupt);
  let locked = false;
  let releaseWorkspace: (() => void) | undefined;
  try {
    releaseWorkspace = acquireWorkspaceLock(env.runsDir);
    store.lock();
    locked = true;
    if (decision) await workflow.applyDecision(decision.decision, decision.note);
    return await workflow.run();
  } catch (e) {
    if (e instanceof LockError || e instanceof DecisionError) throw new CliExit(EXIT.ERROR, e.message);
    throw e;
  } finally {
    if (locked) store.unlock();
    releaseWorkspace?.();
    offSignal?.();
    await closeUi();
  }
}

const COMMANDS = ["run", "resume", "status", "list", "doctor", "init"];

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

/** `duo stauts` would otherwise start a paid run with the task "stauts". */
function mistypedCommand(words: string[]): string | null {
  if (words.length !== 1 || /\s/.test(words[0]!)) return null;
  const word = words[0]!.toLowerCase();
  return COMMANDS.find((c) => editDistance(word, c) <= 2) ?? null;
}

async function runCommand(io: CliIO, words: string[], opts: RunOptions, explicit = false): Promise<number> {
  const near = explicit ? null : mistypedCommand(words);
  if (near) throw new CliExit(EXIT.ERROR, `unknown command '${words[0]}' — did you mean '${near}'? To start a run with this task, use: duo run ${words[0]}`);
  let task = words.join(" ").trim();
  if (opts.taskFile) {
    const path = resolve(io.cwd, opts.taskFile);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      throw new CliExit(EXIT.ERROR, `cannot read task file ${path}: ${(e as Error).message}`);
    }
    task = `${task}\n\n${text}`.trim();
  }
  if (!task) throw new CliExit(EXIT.ERROR, 'a task description is required, e.g. duo "Add JWT auth" (other commands: resume, status, list, doctor, init)');
  const env = await prepare(io, opts);
  requireRunnable(env, env.cfg, env.sources.join(", "), io);
  const { store, state } = RunStore.create(env.runsDir, task, env.cfg.limits);
  store.writeJson("config.json", env.cfg);
  return execute(io, env, env.cfg, store, state, opts);
}

async function resumeCommand(io: CliIO, runId: string | undefined, opts: ResumeOptions): Promise<number> {
  if (opts.note && !opts.decision) throw new CliExit(EXIT.ERROR, "--note is only accepted together with --decision");
  const env = await prepare(io, opts);
  if (!env.isRepo) requireRunnable(env, env.cfg, "", io);
  const store = openStore(env.runsDir, runId);
  // A run keeps the config it started with, unless asked to pick up the current one.
  const useSaved = !opts.reloadConfig && store.exists("config.json");
  const cfg = useSaved ? configFromSaved(store.readJson("config.json")) : env.cfg;
  requireRunnable(env, cfg, useSaved ? store.path("config.json") : env.sources.join(", "), io);
  if (!useSaved) store.writeJson("config.json", cfg);
  return execute(io, env, cfg, store, store.loadState(), opts, opts.decision ? { decision: opts.decision, note: opts.note } : undefined);
}

async function statusCommand(io: CliIO, runId: string | undefined, opts: CommonOptions): Promise<number> {
  const env = await prepare(io, opts);
  const store = openStore(env.runsDir, runId);
  const st = store.loadState();
  const out = (s: string) => io.stdout.write(`${s}\n`);
  out(`Run ${st.taskId} — ${st.phase}`);
  out(`  task: ${st.task.split("\n")[0]!.slice(0, 100)}`);
  out(`  planning round ${st.planningRound}/${st.limits.planningRounds}, plan v${st.planVersion}, final ${st.finalPlanVersion ? `v${st.finalPlanVersion}` : "—"}`);
  out(`  implementation round ${st.implRound}/${st.limits.reviewRounds}, open findings ${st.openFindings.length}`);
  out(`  usage: ${[formatCost(st.costUsd), formatTokens(st.tokens)].filter(Boolean).join(" · ") || "none"}`);
  if (st.inProgress) out(`  interrupted during ${st.inProgress.phase} (resume to re-run it)`);
  for (const h of st.history.slice(-12)) {
    out(`  [${String(h.step).padStart(2, "0")}] ${`${h.phase} r${h.round}`.padEnd(16)} ${h.agent.padEnd(12)} ${h.status}: ${h.summary}`);
  }
  if (st.warnings?.length) out(`  warnings: ${st.warnings.length} (see report.md)`);
  if (st.phase === "HUMAN_REVIEW" && st.humanReview) {
    out(`  waiting for a decision (${st.humanReview.reason}): ${st.humanReview.message}`);
    out(`  continue: duo resume ${st.taskId} --decision resume|revise|abort [--note "..."]`);
  }
  out(`  files: ${store.dir}`);
  return EXIT.DONE;
}

async function listCommand(io: CliIO, opts: CommonOptions): Promise<number> {
  const env = await prepare(io, opts);
  const runs = RunStore.list(env.runsDir);
  if (!runs.length) io.stdout.write(`no runs in ${env.runsDir}\n`);
  for (const st of runs) io.stdout.write(`${st.taskId}  ${st.phase.padEnd(13)} ${st.updatedAt}  ${st.task.split("\n")[0]!.slice(0, 60)}\n`);
  return EXIT.DONE;
}

async function doctorCommand(io: CliIO, opts: CommonOptions): Promise<number> {
  const env = await prepare(io, opts);
  let configError: string | undefined;
  try {
    validateConfig(env.cfg, env.sources.join(", ") || undefined);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    configError = e.message.replace(/\n\s*/g, " ");
  }
  // An invalid config cannot be trusted for the remaining checks; fall back to the defaults for those.
  const cfg = configError ? defaultConfig() : env.cfg;
  const checks = await runDoctor({ dir: env.workspace, cfg, sources: env.sources, configError, env: io.env, runsDir: env.runsDir });
  let failed = false;
  for (const c of checks) {
    if (c.ok) io.stdout.write(`  ✓ ${c.message}\n`);
    else if (c.required) {
      failed = true;
      io.stdout.write(`  ✗ ${c.message}\n`);
    } else io.stdout.write(`  ! ${c.message}\n`);
  }
  io.stdout.write(`doctor: ${failed ? "problems found" : "ready"}\n`);
  return failed ? EXIT.ERROR : EXIT.DONE;
}

async function initCommand(io: CliIO, opts: CommonOptions): Promise<number> {
  const env = await prepare(io, opts);
  if (!env.isRepo) {
    if (io.ask && io.stdin.isTTY) {
      const answer = (await io.ask("This folder is not a git repository. Run 'git init' here? [y/N] ")).trim().toLowerCase();
      if (answer === "y" || answer === "yes") {
        await env.git.run(["init", "-q"]);
        io.stdout.write(`initialized a git repository in ${env.workspace}\n`);
      } else {
        io.stdout.write("skipped; run 'git init' here before 'duo run'\n");
      }
    } else {
      io.stdout.write("note: this folder is not a git repository; run 'git init' here before 'duo run'\n");
    }
  }
  const r = initRepo(env.workspace);
  if (r.created) {
    io.stdout.write(`created ${r.configPath}\n`);
    for (const g of r.gates) io.stdout.write(`  suggested gate ${g.name}: ${g.command}  (${g.reason}; commented out)\n`);
  } else {
    io.stdout.write(`kept existing ${r.configPath}\n`);
  }
  io.stdout.write(r.ignoreCreated ? "created .agentduo/.gitignore (keeps run data out of git)\n" : ".agentduo/.gitignore already exists\n");
  return EXIT.DONE;
}

export async function main(argv: string[], io: CliIO = processIO()): Promise<number> {
  let exitCode: number = EXIT.DONE;
  const program = new Command()
    .name("duo")
    .description("A channel between Codex and Claude Code: Codex plans and reviews, Claude critiques and implements. Start a run with a task description.")
    .version(packageVersion(), "-V, --version")
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.stdout.write(s), writeErr: (s) => io.stderr.write(s) })
    .showHelpAfterError();
  const common = (cmd: Command) => cmd
    .option("--dir <path>", "workspace directory (default: the current directory)")
    .option("--config <path>", "config file (default: <dir>/.agentduo/config.yaml)")
    .option("--plain", "plain line output (default when stdout is not a TTY, in CI, or in the background)")
    .option("-v, --verbose", "show every agent activity, including thoughts")
    .option("--no-color", "disable colors");

  common(program.argument("[task...]", "task description for a new run (use -- before a task that starts with '-')").option("--task-file <file>", "read the task description from a file"))
    .action(async (words: string[], opts: RunOptions) => {
      exitCode = await runCommand(io, words, opts);
    });
  common(program.command("run").description("start a new run").argument("<task...>").option("--task-file <file>", "read the task description from a file"))
    .action(async (words: string[], opts: RunOptions) => {
      exitCode = await runCommand(io, words, opts, true);
    });
  common(program.command("resume").description("continue a run (default: the latest), optionally answering a pending decision").argument("[runId]")
    .addOption(new Option("--decision <decision>", "answer a run waiting in HUMAN_REVIEW").choices(["resume", "revise", "abort"]))
    .option("--note <text>", "instruction for the agents, recorded with the decision")
    .option("--reload-config", "use the current config instead of the one the run started with"))
    .action(async (runId: string | undefined, opts: ResumeOptions) => {
      exitCode = await resumeCommand(io, runId, opts);
    });
  common(program.command("status").description("show a run's state").argument("[runId]"))
    .action(async (runId: string | undefined, opts: CommonOptions) => {
      exitCode = await statusCommand(io, runId, opts);
    });
  common(program.command("list").description("list runs in this workspace"))
    .action(async (opts: CommonOptions) => {
      exitCode = await listCommand(io, opts);
    });
  common(program.command("doctor").description("check CLIs, config and workspace (no agent calls)"))
    .action(async (opts: CommonOptions) => {
      exitCode = await doctorCommand(io, opts);
    });
  common(program.command("init").description("create .agentduo/config.yaml (and offer git init)"))
    .action(async (opts: CommonOptions) => {
      exitCode = await initCommand(io, opts);
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return exitCode;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode === 0 ? EXIT.DONE : EXIT.ERROR;
    if (err instanceof CliExit) {
      if (err.message) io.stderr.write(`error: ${err.message}\n`);
      return err.code;
    }
    if (err instanceof ConfigError) {
      io.stderr.write(`error: ${err.message}\n`);
      return EXIT.ERROR;
    }
    throw err;
  }
}
```

- [ ] **Step 8: Run the whole suite and typecheck**

Run: `npm run typecheck && npx vitest run`
Expected: no type errors; all test files PASS (guards.test.ts is gone).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat!: make agentduo a pure channel scoped to the current directory

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Process and runner robustness

**Files:**
- Modify: `src/agents/process.ts`, `src/agents/types.ts`, `src/agents/codex.ts`, `src/agents/claude.ts`, `src/agents/runner.ts`
- Test: `test/process.test.ts`, `test/parsers.test.ts`, `test/runner.test.ts` (additions)

**Interfaces:**
- `RunOptions` gains `idleTimeoutMs?: number` (0 or absent means off) and `maxBufferChars?: number` (default 16 MiB). `RunResult` gains `idle: boolean`.
- `StreamParser` gains `usage(): { tokens?: number; costUsd?: number }`.
- `ClaudeParser` sums tokens from `message.usage`, deduplicated by message id.
- Runner:
  - log prefixes are unique per run, getting `-2`, `-3` when the files exist;
  - the stale `.last.json` is deleted before each attempt;
  - an idle attempt produces the error `<agent> produced no output for Ns`;
  - interrupted, timed-out and idle attempts still count their tokens.

- [ ] **Step 1: Write the failing tests**

```python file=.superpowers/patches/t2-tests.py
def add_before(path, anchor, text):
    s = open(path).read(); assert anchor in s, anchor[:50]; open(path, "w").write(s.replace(anchor, text + anchor, 1))
add_before("test/process.test.ts", '  it("rejects when the binary does not exist", async () => {', '''  it("kills a silent process after the idle timeout, but not a chatty one", async () => {
    const silent = await runProcess(node, ["-e", "setInterval(() => {}, 1000)"], { cwd, timeoutMs: 10_000, idleTimeoutMs: 300, killGraceMs: 100 });
    expect(silent).toMatchObject({ idle: true, timedOut: false, code: null });
    const chatty = await runProcess(node, ["-e", "let n = 0; const t = setInterval(() => { process.stdout.write('.'); if (++n === 6) { clearInterval(t); } }, 100)"],
      { cwd, timeoutMs: 10_000, idleTimeoutMs: 400 });
    expect(chatty).toMatchObject({ idle: false, code: 0 });
    const off = await runProcess(node, ["-e", "setTimeout(() => {}, 500)"], { cwd, timeoutMs: 10_000, idleTimeoutMs: 0 });
    expect(off).toMatchObject({ idle: false, code: 0 });
  });

  it("keeps only the tail of very large output but still reports every line", async () => {
    let lines = 0;
    const r = await runProcess(node, ["-e", "for (let i = 0; i < 1000; i++) console.log('line ' + i)"],
      { cwd, timeoutMs: 10_000, maxBufferChars: 100, onStdoutLine: () => { lines += 1; } });
    expect(lines).toBe(1000);
    expect(r.stdout.length).toBeLessThanOrEqual(100);
    expect(r.stdout).toContain("line 999");
  });

''')
add_before("test/parsers.test.ts", 'describe("extractJson", () => {', '''describe("token accounting", () => {
  it("sums Claude message usage once per message", () => {
    const p = new ClaudeParser("/repo");
    const usage = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5 };
    const events = feedAll(p, [
      JSON.stringify({ type: "assistant", uuid: "a", message: { id: "m1", usage, content: [{ type: "text", text: "one" }] } }),
      JSON.stringify({ type: "assistant", uuid: "b", message: { id: "m1", usage, content: [{ type: "text", text: "two" }] } }),
      JSON.stringify({ type: "assistant", uuid: "c", message: { id: "m2", usage: { input_tokens: 1, output_tokens: 1 }, content: [] } }),
    ]);
    expect(p.usage().tokens).toBe(1117);
    expect(events.filter((e) => e.type === "usage").map((e) => (e.type === "usage" ? e.tokens : 0))).toEqual([1115, 1117]);
    expect(new CodexParser().usage()).toEqual({ tokens: undefined });
  });
});

''')
add_before("test/runner.test.ts", '  it("stops on abort", async () => {', '''  it("gives every call its own log files and ignores a stale last message", async () => {
    fake.setScenario({ planner: [{ output: plan() }, { noLastMessage: true, raw: "not json" }] });
    const r = runner({ limits: { max_retries: 0 } });
    expect((await r.call({ role: "planner", agentRole: "planner", prompt: prompt("planner"), schemaName: "plan", logPrefix: "010-plan-r1" })).ok).toBe(true);
    const second = await r.call({ role: "planner", agentRole: "planner", prompt: prompt("planner"), schemaName: "plan", logPrefix: "010-plan-r1" });
    expect(second.ok).toBe(false);
    expect(existsSync(join(t.path, "logs", "010-plan-r1.a1.prompt.md"))).toBe(true);
    expect(existsSync(join(t.path, "logs", "010-plan-r1-2.a1.prompt.md"))).toBe(true);
  });

  it("treats a silent agent as hung", async () => {
    fake.setScenario({ planner: [{ output: plan(), sleep: 5000 }] });
    const r = await runner({ limits: { max_retries: 0, agent_idle_timeout_sec: 1 } }).call({ role: "planner", agentRole: "planner", prompt: prompt("planner"), schemaName: "plan", logPrefix: "011" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("codex produced no output for 1s");
  });

  it("counts Claude tokens, also for an interrupted attempt", async () => {
    fake.setScenario({ implementer: [{ activities: [{ tool: "Read", input: { file_path: "x" } }], sleep: 5000, output: {} }] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 600);
    const r = await runner().call({ role: "implementer", agentRole: "implementer", prompt: prompt("implementer"), schemaName: "implementation", logPrefix: "012", signal: controller.signal });
    expect(r).toMatchObject({ interrupted: true, tokens: 15 });
  });

''')
```

Run: `python3 .superpowers/patches/t2-tests.py && npx vitest run test/process.test.ts test/parsers.test.ts test/runner.test.ts 2>&1 | grep -E "×|Tests "`
Expected: FAIL. The new tests fail (idle not supported, `usage` not a function, log prefix reused, no idle error, tokens null).

- [ ] **Step 2: Implement**

```python file=.superpowers/patches/t2-impl.py
def rep(path, old, new):
    s = open(path).read(); assert old in s, (path, old[:60]); open(path, "w").write(s.replace(old, new, 1))
P = "src/agents/process.ts"
rep(P, 'import { spawn, type ChildProcess } from "node:child_process";', 'import { spawn, spawnSync, type ChildProcess } from "node:child_process";')
rep(P, '''  shell?: boolean;
  killGraceMs?: number;
}''', '''  shell?: boolean;
  killGraceMs?: number;
  /** Kill the process when it prints nothing (stdout or stderr) for this long; 0 or absent = off. */
  idleTimeoutMs?: number;
  /** Keep at most this many characters of each stream (the tail); line callbacks still see everything. */
  maxBufferChars?: number;
}''')
rep(P, '''  timedOut: boolean;
  aborted: boolean;
}''', '''  timedOut: boolean;
  aborted: boolean;
  idle: boolean;
}

const DEFAULT_MAX_BUFFER_CHARS = 16 * 1024 * 1024;''')
rep(P, '''export function killAllActive(): void {
  for (const child of active) killTree(child, 0);
}''', '''export function killAllActive(): void {
  for (const child of active) {
    if (isWindows && child.pid !== undefined) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else killTree(child, 0);
  }
}''')
rep(P, '''    let timedOut = false;
    let aborted = false;
    let settled = false;''', '''    let timedOut = false;
    let aborted = false;
    let idle = false;
    let settled = false;
    const cap = opts.maxBufferChars ?? DEFAULT_MAX_BUFFER_CHARS;
    const keepTail = (text: string) => (text.length > cap ? text.slice(-cap) : text);
    let idleTimer: NodeJS.Timeout | undefined;
    const touch = () => {
      if (!opts.idleTimeoutMs) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idle = true;
        killTree(child, opts.killGraceMs);
      }, opts.idleTimeoutMs);
    };
    touch();''')
rep(P, '''    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;''', '''    child.stdout!.on("data", (chunk: string) => {
      touch();
      stdout = keepTail(stdout + chunk);''')
rep(P, '''    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });''', '''    child.stderr!.on("data", (chunk: string) => {
      touch();
      stderr = keepTail(stderr + chunk);
    });''')
rep(P, '''    const cleanup = () => {
      clearTimeout(timer);''', '''    const cleanup = () => {
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);''')
rep(P, '''        resolvePromise({ code: timedOut || aborted ? null : code, stdout, stderr, timedOut, aborted });''',
       '''        resolvePromise({ code: timedOut || aborted || idle ? null : code, stdout, stderr, timedOut, aborted, idle });''')

T = "src/agents/types.ts"
rep(T, '''export interface StreamParser {
  feed(line: string): ParsedEvent[];
}''', '''export interface StreamParser {
  feed(line: string): ParsedEvent[];
  /** Usage seen so far in the stream (also for attempts that never finished). */
  usage(): { tokens?: number; costUsd?: number };
}''')

C = "src/agents/codex.ts"
rep(C, '''  lastAgentMessage: string | null = null;
  error: string | null = null;
''', '''  lastAgentMessage: string | null = null;
  error: string | null = null;

  usage(): { tokens?: number } {
    return { tokens: this.tokens || undefined };
  }
''')

L = "src/agents/claude.ts"
rep(L, '''  result: Record<string, any> | null = null;
  private readonly tools = new Map<string, Activity>();''', '''  result: Record<string, any> | null = null;
  private readonly tools = new Map<string, Activity>();
  private readonly messageTokens = new Map<string, number>();

  usage(): { tokens?: number; costUsd?: number } {
    const tokens = [...this.messageTokens.values()].reduce((a, b) => a + b, 0);
    const cost = this.result?.total_cost_usd;
    return { tokens: tokens || undefined, costUsd: typeof cost === "number" ? cost : undefined };
  }

  /** Assistant events repeat their message's usage once per content block; count each message once. */
  private trackUsage(message: Record<string, any>): ParsedEvent[] {
    const u = message?.usage;
    if (!u || typeof u !== "object" || !message.id) return [];
    const n = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"].reduce((sum, k) => sum + (Number(u[k]) || 0), 0);
    if (this.messageTokens.get(String(message.id)) === n) return [];
    this.messageTokens.set(String(message.id), n);
    return [{ type: "usage", tokens: this.usage().tokens }];
  }''')
rep(L, '''    const content = event.message?.content;
    if (!Array.isArray(content)) return [];
    const out: ParsedEvent[] = [];''', '''    const out: ParsedEvent[] = event.type === "assistant" ? this.trackUsage(event.message) : [];
    const content = event.message?.content;
    if (!Array.isArray(content)) return out;''')
rep(L, '''    const meta: AgentMeta = {
      costUsd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : undefined,''', '''    const meta: AgentMeta = {
      costUsd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : undefined,
      tokens: (parser as ClaudeParser).usage?.().tokens,''')

R = "src/agents/runner.ts"
rep(R, 'import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";', 'import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";')
rep(R, '''    const timeoutMs = this.cfg.limits.agent_timeout_sec * 1000;
    mkdirSync(this.logDir, { recursive: true });''', '''    const timeoutMs = this.cfg.limits.agent_timeout_sec * 1000;
    const idleTimeoutMs = this.cfg.limits.agent_idle_timeout_sec * 1000;
    mkdirSync(this.logDir, { recursive: true });
    // A step that re-runs (resume after an interrupt) keeps the earlier attempt's logs.
    let prefix = o.logPrefix;
    for (let n = 2; existsSync(join(this.logDir, `${prefix}.a1.prompt.md`)); n++) prefix = `${o.logPrefix}-${n}`;''')
rep(R, '''      const stem = join(this.logDir, `${o.logPrefix}.a${attempt}`);''', '''      const stem = join(this.logDir, `${prefix}.a${attempt}`);''')
rep(R, '''      writeFileSync(`${stem}.prompt.md`, prompt);''', '''      rmSync(lastMessageFile, { force: true }); // never let Codex's previous answer stand in for this one
      writeFileSync(`${stem}.prompt.md`, prompt);''')
rep(R, '''          cwd: this.repo, input: prompt, timeoutMs, signal: o.signal,''', '''          cwd: this.repo, input: prompt, timeoutMs, idleTimeoutMs, signal: o.signal,''')
rep(R, '''      writeFileSync(`${stem}.stderr.txt`, run.stderr);
      if (run.aborted) return finish(false, attempt, null, "interrupted", true);
      if (run.timedOut) {
        lastError = `${backend.name} timed out after ${this.cfg.limits.agent_timeout_sec}s`;
        continue;
      }''', '''      writeFileSync(`${stem}.stderr.txt`, run.stderr);
      if (run.aborted || run.timedOut || run.idle) {
        const seen = parser.usage().tokens;
        if (seen) {
          tokens += seen;
          tokensSeen = true;
        }
      }
      if (run.aborted) return finish(false, attempt, null, "interrupted", true);
      if (run.timedOut) {
        lastError = `${backend.name} timed out after ${this.cfg.limits.agent_timeout_sec}s`;
        continue;
      }
      if (run.idle) {
        lastError = `${backend.name} produced no output for ${this.cfg.limits.agent_idle_timeout_sec}s`;
        continue;
      }''')
```

Run: `python3 .superpowers/patches/t2-impl.py && npm run typecheck && npx vitest run`
Expected: no type errors; all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "fix: idle timeout, bounded buffers, unique logs and Claude token accounting

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: UI fixes

**Files:**
- Modify: `src/ui/ink/store.ts`, `src/ui/ink/App.tsx`, `src/ui/ink/session.tsx`, `src/ui/plain.ts`
- Test: `test/ink.test.tsx`, `test/session.test.tsx`, `test/plain.test.ts`

**Interfaces:**
- `StaticItem` gains `{ kind: "review"; review: HumanReview }`. It is pushed on `run.finished` with phase `HUMAN_REVIEW`.
- `AppProps` gains `onSettled?(): void`, called after the finish line has rendered.
- In `HumanReviewPrompt`, Ctrl-C now means "defer".
- The plain renderer's agent column is 12 characters wide, and items are indented 40 spaces.

- [ ] **Step 1: Write the failing tests**

```python file=.superpowers/patches/t3-tests.py
def add_before(path, anchor, text):
    s = open(path).read(); assert anchor in s, anchor[:50]; open(path, "w").write(s.replace(anchor, text + anchor, 1))
def rep(path, old, new):
    s = open(path).read(); assert old in s, old[:60]; open(path, "w").write(s.replace(old, new, 1))
I = "test/ink.test.tsx"
add_before(I, 'describe("Ink components", () => {', '''describe("view reducer additions", () => {
  it("shows retries as activities and keeps the review details when a decision is deferred", () => {
    const s = play([
      phase("PLAN", "planner", "codex"),
      { type: "agent.retry", role: "planner", agent: "codex", attempt: 2, max: 2, reason: "output is not valid JSON\\nmore" },
    ]);
    expect(s.current!.activities.map((a) => a.label)).toEqual(["↻ retry 2/2: output is not valid JSON"]);
    const deferred = play([
      { type: "human.required", runId: "r1", review },
      { type: "run.finished", runId: "r1", phase: "HUMAN_REVIEW", reportPath: "/r", exitCode: 2 },
    ]);
    expect(deferred.items.map((i) => i.kind)).toEqual(["review", "finish"]);
  });
});

''')
add_before(I, '  it("handles q when interactive", async () => {', '''  it("prints the review reason and details when nobody can answer", async () => {
    const bus = new EventBus();
    const app = render(<App bus={bus} version="0.1.0" verbose={false} interactive={false} onStop={noop} onInterrupt={noop} onDecision={noop} views={() => []} readView={async () => null} />);
    bus.emit({ type: "human.required", runId: "r1", review });
    bus.emit({ type: "run.finished", runId: "r1", phase: "HUMAN_REVIEW", reportPath: "/r", exitCode: 2 });
    await wait();
    const output = app.frames.join("\\n");
    for (const s of ["max_review_rounds", "not approved after 5 rounds", "F3 [high] src/auth.ts:42", "duo resume r1 --decision"]) expect(output).toContain(s);
    app.unmount();
  });

  it("treats Ctrl-C at the decision prompt as 'decide later'", async () => {
    const decisions: unknown[] = [];
    let interrupts = 0;
    const bus = new EventBus();
    const app = render(<App bus={bus} version="0.1.0" verbose={false} interactive onStop={noop} onInterrupt={() => { interrupts += 1; }}
      onDecision={(d) => decisions.push(d)} views={() => []} readView={async () => null} />);
    bus.emit({ type: "human.required", runId: "r1", review });
    await wait();
    app.stdin.write("\\u0003");
    await wait();
    expect([decisions, interrupts]).toEqual([["defer"], 0]);
    app.unmount();
  });

  it("reports when the finish line has rendered", async () => {
    let settled = 0;
    const bus = new EventBus();
    const app = render(<App bus={bus} version="0.1.0" verbose={false} interactive={false} onStop={noop} onInterrupt={noop} onDecision={noop}
      views={() => []} readView={async () => null} onSettled={() => { settled += 1; }} />);
    await wait();
    expect(settled).toBe(0);
    bus.emit({ type: "run.finished", runId: "r1", phase: "DONE", reportPath: "/r", exitCode: 0 });
    await wait();
    expect(settled).toBe(1);
    app.unmount();
  });

''')
P = "test/plain.test.ts"
rep(P, '    expect(text.split("\\n")).toContain("12:00:00  codex    PLAN r1          ▶ planner");',
       '    expect(text.split("\\n")).toContain("12:00:00  codex        PLAN r1          ▶ planner");\n    expect(text.split("\\n")).toContain(`${" ".repeat(40)}- [high] C1 problem`);')
S = "test/session.test.tsx"
def add_before_last(path, anchor, text):
    s = open(path).read(); i = s.rfind(anchor); assert i != -1, anchor; open(path, "w").write(s[:i] + text + s[i:])
add_before_last(S, '});\n', '''  it("closes promptly after the finish line, and within a second without one", async () => {
    const bus = new EventBus();
    const session = startInk({
      bus, version: "0.1.0", verbose: false, interactive: false, onStop: noop, onInterrupt: noop,
      views: () => [], readView: async () => null, stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
    });
    bus.emit({ type: "run.finished", runId: "r1", phase: "DONE", reportPath: "/r", exitCode: 0 });
    let started = Date.now();
    await session.close();
    expect(Date.now() - started).toBeLessThan(500);
    const idle = startInk({
      bus: new EventBus(), version: "0.1.0", verbose: false, interactive: false, onStop: noop, onInterrupt: noop,
      views: () => [], readView: async () => null, stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
    });
    started = Date.now();
    await idle.close();
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });
''')
```

Run: `python3 .superpowers/patches/t3-tests.py && npx vitest run test/ink.test.tsx test/session.test.tsx test/plain.test.ts 2>&1 | grep -E "×|Tests "`
Expected: FAIL for each new test: no retry activity, no review item, Ctrl-C calls onInterrupt, no onSettled, column width, and the session closing in 50 ms without the 1 s fallback.

- [ ] **Step 2: Implement**

```python file=.superpowers/patches/t3-impl.py
def rep(path, old, new):
    s = open(path).read(); assert old in s, (path, old[:60]); open(path, "w").write(s.replace(old, new, 1))
S = "src/ui/ink/store.ts"
rep(S, '''  | { kind: "finish"; phase: string; runId: string; reportPath: string };''', '''  | { kind: "finish"; phase: string; runId: string; reportPath: string }
  | { kind: "review"; review: HumanReview };''')
rep(S, '''    case "agent.usage":''', '''    case "agent.retry":
      return withActivity(s, { id: `retry-${e.role}-${e.attempt}`, kind: "other", label: `↻ retry ${e.attempt}/${e.max}: ${e.reason.split("\\n")[0]}`, status: "error" });
    case "agent.usage":''')
rep(S, '''    case "run.finished":
      return {
        ...push(s, { kind: "finish", phase: e.phase, runId: e.runId, reportPath: e.reportPath }),''', '''    case "run.finished": {
      // A deferred decision (non-interactive, or "Decide later") keeps the reason in scrollback.
      const withReview = e.phase === "HUMAN_REVIEW" && s.humanReview ? push(s, { kind: "review", review: s.humanReview }) : s;
      return {
        ...push(withReview, { kind: "finish", phase: e.phase, runId: e.runId, reportPath: e.reportPath }),''')
rep(S, '''        finished: { phase: e.phase, reportPath: e.reportPath, exitCode: e.exitCode }, current: null, humanReview: null,
      };''', '''        finished: { phase: e.phase, reportPath: e.reportPath, exitCode: e.exitCode }, current: null, humanReview: null,
      };
    }''')

A = "src/ui/ink/App.tsx"
rep(A, '''  views(): ViewKind[];
  readView(kind: ViewKind): Promise<string | null>;
}''', '''  views(): ViewKind[];
  readView(kind: ViewKind): Promise<string | null>;
  /** Called once the finish line has been rendered, so the session can unmount without losing it. */
  onSettled?(): void;
}''')
rep(A, '''    case "finish":
      return <FinishLine phase={item.phase} runId={item.runId} reportPath={item.reportPath} />;''', '''    case "finish":
      return <FinishLine phase={item.phase} runId={item.runId} reportPath={item.reportPath} />;
    case "review":
      return (
        <Box flexDirection="column">
          <Text color="yellow" bold wrap="truncate-end">{`⚠ Your decision is needed: ${item.review.reason}`}</Text>
          <Text wrap="wrap">{item.review.message}</Text>
          {item.review.details.slice(0, 8).map((d, i) => (
            <Text key={i} dimColor wrap="truncate-end">{`  - ${d}`}</Text>
          ))}
        </Box>
      );''')
rep(A, '''  useInput((input, key) => {
    if (key.ctrl && input === "c") p.onInterrupt();
  }, { isActive: p.interactive });''', '''  useInput((input, key) => {
    if (!(key.ctrl && input === "c")) return;
    // At the decision prompt nothing is running, so Ctrl-C means "decide later".
    if (view.humanReview) p.onDecision("defer");
    else p.onInterrupt();
  }, { isActive: p.interactive });
  useEffect(() => {
    if (view.finished) p.onSettled?.();
  }, [view.finished]);''')

N = "src/ui/ink/session.tsx"
rep(N, '''  const options: RenderOptions = { exitOnCtrlC: false, patchConsole: false };''', '''  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const options: RenderOptions = { exitOnCtrlC: false, patchConsole: false };''')
rep(N, '''  const instance = render(<App {...o} onDecision={onDecision} />, options);''', '''  const instance = render(<App {...o} onDecision={onDecision} onSettled={() => settle()} />, options);''')
rep(N, '''      // Events emitted just before close (run.finished) are still pending in React; let them commit first.
      await new Promise((resolve) => setTimeout(resolve, 50));
      instance.unmount();''', '''      // Wait until the finish line has rendered; without a run.finished event (an error path) give up after a second.
      await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 1000))]);
      instance.unmount();''')

L = "src/ui/plain.ts"
rep(L, 'const INDENT = " ".repeat(36);', 'const AGENT_WIDTH = 12; // fits "orchestrator"\nconst INDENT = " ".repeat(8 + 2 + AGENT_WIDTH + 1 + 16 + 1);')
rep(L, '    out.write(`${paint("dim", clock())}  ${agent.padEnd(8)} ${where.padEnd(16)} ${text}\\n`);', '    out.write(`${paint("dim", clock())}  ${agent.padEnd(AGENT_WIDTH)} ${where.padEnd(16)} ${text}\\n`);')
```

Run: `python3 .superpowers/patches/t3-impl.py && npm run typecheck && npx vitest run`
Expected: no type errors; all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "fix: retries, deferred reviews, Ctrl-C at the prompt and a deterministic Ink close

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Docs, smoke test, final verification

**Files:**
- Rewrite: `README.md`, `README.vi.md`, `AGENTS.md`
- Modify: `scripts/smoke-real.mjs`, `docs/superpowers/specs/2026-10-27-agentduo-npm-cli-design.md` (§10 engines)

- [ ] **Step 1: Docs**

````markdown file=README.md
# agentduo

A channel between two coding agents. **Codex** plans and reviews; **Claude Code** critiques the plan and implements it. agentduo relays their structured messages, runs the loop, and shows in a live terminal UI what each agent is doing and what they hand each other.

agentduo adds no rules of its own: permissions, sandboxes and conventions come from each CLI's configuration and your repository's `AGENTS.md` / `CLAUDE.md`.

```text
● PLAN r1  Codex (planner)                                      32s · 33k tok
  │ exec  rg --files ✓
  └ Codex → Claude  Plan v1 "Add subtraction" · 3 steps · 6 criteria · 1 risks

● PLAN_REVIEW r1  Claude (plan critic)                          48s · $0.17
  │ Read  src/calc.ts ✓
  └ Claude → Codex  approved · 2 suggestion(s)
──────────────────────────────────────────────────────────────────────────────
 PLAN ✓ › CRITIQUE ✓ › FINALIZE ✓ › IMPLEMENT ● r1 › VERIFY › REVIEW    plan 1/4 · impl 1/5
 ⠋ Claude (implementer) · 0:21
   │ Edit  src/calc.ts  +4 −0 ✓
 $0.33 · 67k tok                  [v] details  [q] stop after this step  [ctrl-c] stop now
```

## How it works

1. **Plan and debate.** Codex writes a plan with goals, scope, steps, acceptance criteria and risks. Claude checks that it is feasible, Codex revises it, and Codex finally signs it off.
2. **Implement and review.** Claude implements the plan. Optional quality gates run, and their results go to the reviewer. Codex reviews the diff, and Claude fixes the findings, round after round, until the run reaches `DONE`.

A run reaches `DONE` when all of these hold:
- Codex approves;
- no blocking finding is left;
- if you configured gates, every required gate passes.

When a limit is reached, an agent fails or blocks, or a critical finding appears, the run asks you what to do.

## Requirements

- Node.js ≥ 22.12 and git. The workspace must be inside a git repository; `duo init` offers to run `git init`.
- [Codex CLI](https://developers.openai.com/codex/cli/): run `npm i -g @openai/codex`, then `codex login`.
- [Claude Code](https://code.claude.com/docs/en/overview): the `claude` command. If it is installed only through the VS Code, Cursor or Windsurf extension, agentduo finds the bundled binary.

## Install and quick start

```bash
npm i -g agentduo
cd my-project            # or any subdirectory: that directory is the workspace
duo init                 # .agentduo/config.yaml (everything optional) and .agentduo/.gitignore
duo doctor               # checks the CLIs and config; no model calls
duo "Add JWT authentication with refresh tokens"
```

`agentduo` is the same command as `duo`. Use `agentduo` if another tool already owns the name `duo`.

## The workspace

`duo` works in the directory you call it from, or in `--dir PATH`:

- both agents run there;
- `.agentduo/` (config and runs) lives there;
- the diff sent to the reviewer only contains changes inside it.

If an agent changes files outside the workspace (elsewhere in the same repository), agentduo warns on screen and in the report, but does not stop the run.

## Permissions and scope

agentduo passes only the flags its protocol needs: streaming JSON, the output schema, and the prompt on stdin. For Claude it also passes `--permission-prompts none`, because nobody can answer a prompt in non-interactive mode. That flag grants nothing.

What each agent may do is up to its own configuration:

- **Claude Code**: your settings (`~/.claude/settings.json`, `.claude/settings.json`). In non-interactive mode Claude can only edit files if your settings allow it. One way is `"permissions": { "defaultMode": "acceptEdits" }`; another is allow rules. Denied tool calls appear as `⊘ denied`, together with a hint.
- **Codex**: `~/.codex/config.toml` (for example `sandbox_mode`).
- **Per role, only for agentduo runs**, add flags in `.agentduo/config.yaml`:

```yaml
claude:
  role_args:
    implementer: [--permission-mode, acceptEdits]
    plan_reviewer: [--permission-mode, plan]
codex:
  role_args:
    code_reviewer: [--sandbox, read-only]
```

agentduo reports what the agents did; it does not block it. Two kinds of change produce a warning:
- files changed by a planning or reviewing agent;
- files changed outside the workspace.

Nothing is ever committed or pushed by agentduo: review the changes with `git diff` and commit them yourself.

## Commands

| Command | What it does |
|---|---|
| `duo "<task>"`, `duo run "<task>"` | Start a run (`--task-file F`; use `duo -- "-x …"` for a task that starts with `-`) |
| `duo resume [id]` | Continue the latest (or given) run with the config it started with (`--reload-config` to use today's); `--decision resume\|revise\|abort [--note "..."]` answers a pending decision |
| `duo status [id]`, `duo list` | Progress, history and where the files are |
| `duo doctor` | Check the CLIs and config without calling models |
| `duo init` | Create `.agentduo/config.yaml` and `.agentduo/.gitignore`, and offer `git init` |

Every command also takes `--dir PATH`, `--config PATH`, `--plain`, `-v/--verbose` and `--no-color`. The UI switches to plain timestamped lines with `--plain`, in CI, when stdout is not a terminal, or when the process runs in the background (`duo … &`).

## When a run needs you

In a terminal, agentduo shows the reason and a menu: Resume, Revise (with a note), view the plan, the review, the plan feedback or the diff stat, Abort, or Decide later. Ctrl-C at the menu also means Decide later. In plain mode the run exits with code 2, and you answer with `duo resume --decision …`.

| Reason | What `resume` does |
|---|---|
| `max_planning_rounds` | Implements the latest plan, recorded as accepted by you |
| `plan_ready` (with `safety.pause_before_implement`) | Starts implementing |
| `max_review_rounds`, `critical_finding`, `gates_failing` | Starts another fix round |
| `implementer_blocked` | Re-runs the implementation round |
| `agent_error`, `orchestrator_error` | Re-runs the failed step |

`revise` goes back to planning with your note. `abort` ends the run.

## Configuration

Settings are merged in this order, later sources winning: built-in defaults, then `~/.config/agentduo/config.yaml` (or `$XDG_CONFIG_HOME/agentduo/` or `%APPDATA%\agentduo\` on Windows), then `<workspace>/.agentduo/config.yaml` or `--config`. A misspelled key produces a warning. A value of the wrong type produces an error that names the file.

```yaml
agents: { planner: codex, plan_reviewer: claude, implementer: claude, code_reviewer: codex }
limits: { max_planning_rounds: 4, max_review_rounds: 5, agent_timeout_sec: 1800, agent_idle_timeout_sec: 900 }
gates:                       # optional
  - name: tests
    command: "npm test"
    required: true
codex:  { model: null, args: [--ephemeral], role_args: {} }
claude: { model: null, max_budget_usd: null, args: [--no-session-persistence], role_args: {} }
```

`agent_idle_timeout_sec` stops an agent that prints nothing for that long; set it to 0 to turn the check off.

## Run files

Everything about a run lives in `.agentduo/runs/<run-id>/`:

- `state.json`: makes the run resumable;
- `config.json`: the config the run started with;
- `report.md`: timeline, gates, diff stat, unresolved issues, warnings, cost and tokens;
- the plans, the critiques, and every agent's JSON (with task id, round, timestamp, git SHA and plan version);
- `logs/`: the prompt, the command line, the raw event stream and stderr of every CLI call.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | done |
| 1 | config or environment error |
| 2 | waiting for your decision |
| 3 | aborted |
| 130 | stopped (resumable) |

## Troubleshooting

- **Every edit is denied.** Allow edits in your Claude Code settings, or add `claude.role_args.implementer: [--permission-mode, acceptEdits]`.
- **The terminal behaves oddly after agentduo was killed with `kill -9`.** Run `reset`. A SIGKILL gives no process a chance to restore the terminal.
- **Costs.** `claude.args: [--strict-mcp-config, --no-session-persistence]` skips loading your MCP servers for agentduo runs, which makes each call noticeably cheaper. `claude.max_budget_usd` caps the cost of each call.
- **Windows** is experimental and not covered by CI.

## Development

```bash
npm install
npm test             # unit + end-to-end (fake agents) + UI tests
npm run typecheck
npm run test:pack    # build, pack, install into a temp prefix, run the binaries
npm run demo:ui      # watch the live UI with scripted fake agents (free)
npm run smoke:real   # REAL agents on a demo repo — costs money
```

## License

MIT
````

````markdown file=README.vi.md
# agentduo (tiếng Việt)

agentduo là kênh giao tiếp giữa hai agent lập trình. **Codex** lập kế hoạch và review. **Claude Code** phản biện kế hoạch rồi implement. agentduo chuyển các thông điệp có cấu trúc giữa hai bên, điều phối vòng lặp, và hiển thị live trên terminal từng hành động của mỗi agent cùng những gì hai agent chuyển cho nhau.

agentduo **không có luật riêng**. Quyền, sandbox và quy ước đều lấy từ config của từng CLI và từ `AGENTS.md`/`CLAUDE.md` của repo.

## Cài đặt và bắt đầu

```bash
npm i -g agentduo
cd my-project            # hoặc bất kỳ thư mục con nào: thư mục đó là workspace
duo init                 # tạo .agentduo/config.yaml (mọi mục đều tuỳ chọn) và .agentduo/.gitignore
duo doctor               # kiểm tra CLI và config, không gọi model
duo "Thêm xác thực JWT với refresh token"
```

Yêu cầu: Node.js ≥ 22.12, git, Codex CLI và Claude Code. Workspace phải nằm trong một git repo. Nếu chưa có, `duo init` sẽ hỏi có muốn `git init` không.

## Workspace

`duo` làm việc ở thư mục bạn gọi nó, hoặc ở `--dir PATH`:
- hai agent chạy ở đó;
- `.agentduo/` nằm ở đó;
- diff gửi cho reviewer chỉ gồm thay đổi trong thư mục đó.

Nếu agent sửa file ngoài workspace (trong cùng repo), agentduo cảnh báo trên màn hình và trong report, nhưng không dừng run.

## Quyền

agentduo chỉ truyền các flag giao thức. Với Claude, nó có thêm `--permission-prompts none`, flag này không cấp quyền gì.

- **Claude Code** lấy quyền từ settings của bạn. Khi chạy không tương tác, Claude chỉ sửa được file nếu settings cho phép, ví dụ `"permissions": { "defaultMode": "acceptEdits" }`.
- **Codex** lấy quyền từ `~/.codex/config.toml`.
- **Muốn đặt riêng cho từng vai trò** khi chạy qua agentduo, dùng `role_args`:

```yaml
claude:
  role_args:
    implementer: [--permission-mode, acceptEdits]
codex:
  role_args:
    code_reviewer: [--sandbox, read-only]
```

agentduo không chặn gì. Nó chỉ cảnh báo khi agent lập kế hoạch hoặc review sửa file, và khi có file ngoài workspace bị sửa. agentduo không bao giờ commit hay push.

## Lệnh

| Lệnh | Tác dụng |
|---|---|
| `duo "<task>"` | Tạo run mới (`--task-file`; task bắt đầu bằng `-` thì gõ `duo -- "-x …"`) |
| `duo resume [id]` | Chạy tiếp với config lúc run bắt đầu (thêm `--reload-config` để dùng config hiện tại); `--decision resume\|revise\|abort [--note "..."]` để trả lời quyết định đang chờ |
| `duo status`, `duo list` | Xem tiến độ |
| `duo doctor`, `duo init` | Kiểm tra môi trường, tạo config |

Giao diện:
- **Trong terminal:** giao diện live. Phím `v` bật/tắt chi tiết, `q` dừng sau bước hiện tại, `Ctrl-C` dừng ngay. Tại menu quyết định, `Ctrl-C` nghĩa là "Để sau".
- **Log dạng dòng:** khi có `--plain`, khi chạy trong CI, khi stdout không phải TTY, hoặc khi chạy nền (`duo … &`).

## Quality gates

Gate là tuỳ chọn. Mặc định không có gate: Claude tự chạy test theo config của nó, và run DONE khi Codex approve. Nếu bạn khai báo `gates`, agentduo chạy chúng sau mỗi vòng implement và chuyển kết quả cho Codex. `duo init` gợi ý sẵn các gate tìm được, dưới dạng comment.

## Exit code

| Code | Ý nghĩa |
|---|---|
| 0 | DONE |
| 1 | lỗi cấu hình hoặc môi trường |
| 2 | đang chờ bạn quyết định |
| 3 | đã huỷ |
| 130 | đã dừng (resume được) |

## Xử lý sự cố

- **Mọi lần sửa file đều bị từ chối:** cho phép sửa trong settings của Claude Code, hoặc thêm `claude.role_args.implementer: [--permission-mode, acceptEdits]`.
- **Terminal hiển thị lạ sau khi agentduo bị `kill -9`:** gõ `reset`.
- **Giảm chi phí:** đặt `claude.args: [--strict-mcp-config, --no-session-persistence]` để agentduo không nạp các MCP server của bạn.
- **Windows** ở mức thử nghiệm.
````

```markdown file=AGENTS.md
# AGENTS.md

agentduo is a TypeScript CLI (`src/`, published to npm as `agentduo` with bins `agentduo` and `duo`). It is a channel between Codex CLI (planner and code reviewer) and Claude Code CLI (plan critic and implementer). The design is in `docs/superpowers/specs/2026-10-27-agentduo-channel-design.md`, which amends `2026-10-27-agentduo-npm-cli-design.md`. User docs are in `README.md`.

## Orchestrated runs

A prompt that starts with `[orchestrator-role: <role>]` comes from agentduo. Its role description and output schema are authoritative for that turn. For everything else, follow your own configuration and this file.

## Conventions

- agentduo enforces nothing. It passes protocol flags only, plus the user's `args` and `role_args`. Unexpected changes become `warning` events, never blocks. Do not add permission flags, guards or rules to prompts; that belongs to each CLI's configuration.
- The workspace is the directory `duo` runs in. Every `Git` call runs there, so the pathspec `.` means "this workspace" and `:/` means "the whole repository".
- Node ≥ 22.12, ESM, TypeScript strict. Relative imports end in `.js`, including imports of `.ts`/`.tsx` files.
- Runtime dependencies are exactly `ink`, `react`, `commander`, `yaml` and `ajv`. Ask the user before adding another one.
- `src/core` and `src/agents` never import from `src/ui`. Everything that reaches the screen is an `EventBus` event (`src/events.ts`), and human decisions come back through the `Decider` interface.
- Tests: `npm test` (vitest). When you change a workflow transition, add a scenario to `test/workflow.test.ts`; those scenarios drive `test/fake-agent.mjs` through real subprocesses. When a CLI's stream format changes, refresh `test/fixtures/*.jsonl` from a real run, with personal paths replaced by `/repo`.

## Gotchas

- Agent output schemas (`schemas/`) must stay OpenAI-strict: every property is listed in `required`, and `additionalProperties` is `false`. Express an optional field as a nullable type. `test/schema.test.ts` enforces this, because Codex `--output-schema` rejects anything else.
- CLI flags and stream formats were verified against codex-cli 0.164 and Claude Code 2.1.31x. After a CLI upgrade, run `duo doctor` and the parser tests.
- `git add` fails when an `:(exclude)` pathspec names an already-ignored path, so `Git.pathspec` drops ignored excludes.
- Claude's `--permission-prompts none` must stay. Without it a non-interactive run can hang on a permission prompt that nobody answers.
```

```python file=.superpowers/patches/t4-misc.py
def rep(path, old, new):
    s = open(path).read(); assert old in s, (path, old[:60]); open(path, "w").write(s.replace(old, new, 1))
rep("docs/superpowers/specs/2026-10-27-agentduo-npm-cli-design.md", '`"engines": { "node": ">=20" }`', '`"engines": { "node": ">=22.12" }`')
rep("scripts/smoke-real.mjs", '''writeFileSync(join(repo, ".agentduo", "config.yaml"), 'gates:\\n  - name: tests\\n    command: "node --test"\\n    required: true\\n');''',
    '''// The demo machine has no Claude Code edit permissions configured, so grant them for this run only.
writeFileSync(join(repo, ".agentduo", "config.yaml"),
  'gates:\\n  - name: tests\\n    command: "node --test"\\n    required: true\\nclaude:\\n  role_args:\\n    implementer: [--permission-mode, acceptEdits]\\n');''')
```

Run: `python3 .superpowers/sdd/2026-10-27-agentduo-channel/extract.py docs/superpowers/plans/2026-10-27-agentduo-channel.md 4 README.md README.vi.md AGENTS.md && python3 .superpowers/patches/t4-misc.py`
Expected: files written; the patch script prints nothing and exits 0.

- [ ] **Step 2: Full verification**

Run: `npm run typecheck && npx vitest run && CI=true npx vitest run && npm run test:pack && npm publish --dry-run`
Expected: no type errors; all tests PASS twice; `pack smoke OK`; the dry run lists `dist/`, `schemas/`, the two READMEs, `LICENSE` and `package.json`.

Run: `npm run smoke:real`
Expected: the real Codex and Claude reach `[DONE]` with exit 0, and `calc.mjs` and `test/calc.test.mjs` are changed. This costs real usage.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: describe agentduo as a channel; smoke test grants edits via role_args

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** spec §1–§5 and §7 are covered by Task 1. Spec §6 items #1, #2, #3, #4, #7 and #11 are covered by Task 3; #5, #6, #9, #10, #12 (Task 4), #13, #16, #17, #18, #20, #22–#24 by Tasks 1 and 4; #8, #14, #15, #19 and #21 by Task 2. Spec §8 is Task 4, and spec §9 is the test steps of every task.
- **Rulings:**
  - Spec §6 #9 (index seeding) is a performance change with no observable behavior; existing snapshot tests pin that the behavior is unchanged.
  - Spec §6 #21 (Windows `taskkill` sync) is not exercised by CI.
