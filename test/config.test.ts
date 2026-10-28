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
    expect(data.limits.max_discussion_rounds).toBe(3);
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

  it("asks the user about Claude's permission prompts by default, and accepts deny", () => {
    const { dir, env } = setup();
    expect(loadConfig({ dir, env }).data.claude.permission_prompts).toBe("ask");
    const deny = setup("claude:\n  permission_prompts: deny\n");
    expect(loadConfig({ dir: deny.dir, env: deny.env }).data.claude.permission_prompts).toBe("deny");
    const bad = setup("claude:\n  permission_prompts: maybe\n");
    expect(() => loadConfig({ dir: bad.dir, env: bad.env })).toThrow("claude.permission_prompts must be 'ask' or 'deny'");
  });

  it("merges role_args from several files role by role", () => {
    const { dir, env } = setup("claude:\n  role_args:\n    plan_reviewer: [--model, haiku]\n", "claude:\n  role_args:\n    implementer: [--permission-mode, acceptEdits]\n");
    expect(loadConfig({ dir, env }).data.claude.role_args).toEqual({
      implementer: ["--permission-mode", "acceptEdits"], plan_reviewer: ["--model", "haiku"],
    });
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
      ["limits:\n  max_discussion_rounds: 0\n", "limits.max_discussion_rounds must be a positive integer"],
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
