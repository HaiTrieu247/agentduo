import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, defaultConfig } from "../src/core/config.js";
import { ClaudeBackend } from "../src/agents/claude.js";
import { CodexBackend } from "../src/agents/codex.js";
import { modeLabel, nextMode } from "../src/core/commands.js";
import {
  changeFor, checkSettingValue, clearSettings, describeSettings, permissionMode, saveGlobalSetting, saveSettings, SETTING_KEYS, settingKey, settings, supersedes,
  withChange,
} from "../src/core/settings.js";
import { tempDir } from "./helpers/tmp.js";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (dirs.length) dirs.pop()!.cleanup();
});

const claudeArgs = (cfg = defaultConfig(), role: "implementer" | "plan_reviewer" = "implementer") =>
  new ClaudeBackend(cfg.claude, "/ws").buildArgs({ schemaName: "implementation", lastMessageFile: "", role });
const codexArgs = (cfg = defaultConfig()) => new CodexBackend(cfg.codex, "/ws").buildArgs({ schemaName: "plan", lastMessageFile: "/x", role: "planner" });
const valueOf = (args: string[], flag: string) => args[args.lastIndexOf(flag) + 1];

describe("settings", () => {
  it("switches the implementer between Claude Code's modes: manual, acceptEdits and auto", () => {
    const cfg = defaultConfig();
    expect(permissionMode(cfg)).toBe("manual");
    settings.mode("acceptEdits").apply(cfg);
    expect(permissionMode(cfg)).toBe("acceptEdits");
    expect(valueOf(claudeArgs(cfg), "--permission-mode")).toBe("acceptEdits");
    expect(claudeArgs(cfg, "plan_reviewer")).not.toContain("--permission-mode");
    settings.mode("auto").apply(cfg);
    settings.mode("auto").apply(cfg);
    expect(permissionMode(cfg)).toBe("auto");
    expect(claudeArgs(cfg).filter((a) => a === "--permission-mode")).toHaveLength(1);
    expect(valueOf(claudeArgs(cfg), "--permission-mode")).toBe("auto");
    settings.mode("manual").apply(cfg);
    expect(claudeArgs(cfg)).not.toContain("--permission-mode");
    // A mode set for every Claude call still has to give way to manual for the implementer.
    cfg.claude.args = ["--permission-mode=acceptEdits"];
    expect(permissionMode(cfg)).toBe("acceptEdits");
    settings.mode("manual").apply(cfg);
    expect(permissionMode(cfg)).toBe("manual");
    // "default", Claude Code's older name for manual, which the versions agentduo supports all take.
    expect(valueOf(claudeArgs(cfg), "--permission-mode")).toBe("default");
    // A mode the chat does not offer is shown as Claude Code names it.
    cfg.claude.role_args.implementer = ["--permission-mode", "plan"];
    expect(permissionMode(cfg)).toBe("plan");
    cfg.claude.role_args.implementer = ["--permission-mode", "manual"];
    expect(permissionMode(cfg)).toBe("manual");
  });

  it("cycles the modes as Shift+Tab does in Claude Code, from any mode back to manual", () => {
    expect(nextMode("manual")).toBe("acceptEdits");
    expect(nextMode("acceptEdits")).toBe("auto");
    expect(nextMode("auto")).toBe("manual");
    expect(nextMode("plan")).toBe("manual");
    expect(modeLabel("acceptEdits")).toBe("Edit automatically");
    expect(modeLabel("bypassPermissions")).toBe("bypassPermissions");
  });

  it("sets Claude's model and effort, its allow and deny rules, and extra directories", () => {
    const cfg = defaultConfig();
    settings.claudeModel("opus").apply(cfg);
    settings.claudeEffort("high").apply(cfg);
    settings.claudeEffort("max").apply(cfg);
    settings.claudeRule("allow", "Bash(npm test:*)").apply(cfg);
    settings.claudeRule("allow", "Bash(npm test:*)").apply(cfg);
    settings.claudeRule("deny", "Bash(git push:*)").apply(cfg);
    settings.claudeAddDir("../shared").apply(cfg);
    const args = claudeArgs(cfg, "plan_reviewer");
    expect(valueOf(args, "--model")).toBe("opus");
    expect(args.filter((a) => a === "--effort")).toHaveLength(1);
    expect(valueOf(args, "--effort")).toBe("max");
    expect(args.filter((a) => a === "Bash(npm test:*)")).toHaveLength(1);
    expect(valueOf(args, "--allowedTools")).toBe("Bash(npm test:*)");
    expect(valueOf(args, "--disallowedTools")).toBe("Bash(git push:*)");
    expect(valueOf(args, "--add-dir")).toBe("../shared");
    settings.claudeRemoveRule("Bash(npm test:*)").apply(cfg);
    expect(claudeArgs(cfg)).not.toContain("Bash(npm test:*)");
    settings.claudeModel(null).apply(cfg);
    settings.claudeEffort(null).apply(cfg);
    expect(claudeArgs(cfg)).not.toContain("--effort");
    expect(cfg.claude.model).toBeNull();
    expect(cfg.claude.args).toContain("--no-session-persistence");
  });

  it("sets Codex's model, reasoning effort and permission preset", () => {
    const cfg = defaultConfig();
    settings.codexModel("gpt-5.5", "high").apply(cfg);
    settings.codexModel("gpt-5.5", "xhigh").apply(cfg);
    settings.codexPermissions("auto").apply(cfg);
    let args = codexArgs(cfg);
    expect(valueOf(args, "--model")).toBe("gpt-5.5");
    expect(args.filter((a) => a.startsWith("model_reasoning_effort="))).toEqual(["model_reasoning_effort=xhigh"]);
    expect(valueOf(args, "--sandbox")).toBe("workspace-write");
    settings.codexPermissions("read-only").apply(cfg);
    settings.codexPermissions("full-access").apply(cfg);
    args = codexArgs(cfg);
    expect(args.filter((a) => a === "--sandbox")).toHaveLength(1);
    expect(valueOf(args, "--sandbox")).toBe("danger-full-access");
    settings.codexPermissions("default").apply(cfg);
    expect(codexArgs(cfg)).not.toContain("--sandbox");
    expect(cfg.codex.args).toContain("--ephemeral");
  });

  it("describes the settings both agents run with", () => {
    const cfg = defaultConfig();
    settings.mode("auto").apply(cfg);
    settings.claudeRule("allow", "Bash(npm test:*)").apply(cfg);
    settings.codexModel("gpt-5.5", "high").apply(cfg);
    const text = describeSettings(cfg);
    for (const s of ["Claude", "model: default", "mode: auto", "allow: Bash(npm test:*)", "Codex", "model: gpt-5.5", "effort: high",
      "permissions: default", "planner: codex"]) expect(text).toContain(s);
  });

  it("saves only the keys a setting touches, and keeps the comments of the file", () => {
    const t = tempDir();
    dirs.push(t);
    const file = join(t.path, "ws", ".agentduo", "config.yaml");
    mkdirSync(join(t.path, "ws", ".agentduo"), { recursive: true });
    writeFileSync(file, "# my notes\ngates:\n  - name: tests # keep me\n    command: npm test\n");
    const cfg = defaultConfig();
    const change = settings.mode("acceptEdits");
    change.apply(cfg);
    saveSettings(file, cfg, change.paths);
    const model = settings.codexModel("gpt-5.5", null);
    model.apply(cfg);
    saveSettings(file, cfg, model.paths);
    const text = readFileSync(file, "utf8");
    for (const s of ["# my notes", "# keep me", "implementer:", "acceptEdits", "model: gpt-5.5"]) expect(text).toContain(s);
    expect(text).not.toContain("max_planning_rounds");
    const fresh = join(t.path, "other", ".agentduo", "config.yaml");
    saveSettings(fresh, cfg, settings.claudeModel("opus").paths);
    expect(readFileSync(fresh, "utf8")).toContain("claude:");
  });

  it("saves a --global change to what the user config says, and names the keys the workspace config overrides", () => {
    const t = tempDir();
    dirs.push(t);
    const user = join(t.path, "xdg", "agentduo", "config.yaml");
    const ws = join(t.path, "ws", ".agentduo", "config.yaml");
    mkdirSync(join(t.path, "ws", ".agentduo"), { recursive: true });
    writeFileSync(ws, "claude:\n  args: [--no-session-persistence, --verbose]\n  role_args:\n    plan_reviewer: [--max-turns, '3']\ncodex:\n  model: o3\n");
    expect(saveGlobalSetting(user, ws, settings.claudeEffort("high"))).toEqual(["claude.args"]);
    let text = readFileSync(user, "utf8");
    expect(text).toContain("--effort");
    expect(text).not.toContain("--verbose");
    expect(saveGlobalSetting(user, ws, settings.claudeModel("opus"))).toEqual([]);
    // Per role: the workspace's plan_reviewer flags leave the user's implementer mode in force.
    expect(saveGlobalSetting(user, ws, settings.mode("auto"))).toEqual([]);
    expect(saveGlobalSetting(user, ws, settings.codexModel("gpt-5.5", "high"))).toEqual(["codex.model"]);
    text = readFileSync(user, "utf8");
    for (const s of ["model: opus", "auto", "model: gpt-5.5", "model_reasoning_effort=high"]) expect(text).toContain(s);
    expect(text).not.toContain("plan_reviewer");
    writeFileSync(ws, "claude:\n  role_args:\n    implementer: [--permission-mode, acceptEdits]\n");
    expect(saveGlobalSetting(user, ws, settings.mode("auto"))).toEqual(["claude.role_args.implementer"]);
    // The same file both ways (duo --config on the user config): nothing hides it.
    expect(saveGlobalSetting(user, user, settings.claudeModel("haiku"))).toEqual([]);
  });

  it("says when each change reaches work that is going: agent options from the next call, roles and limits from the next run", () => {
    const now = [settings.mode("auto"), settings.claudeModel("opus"), settings.claudeEffort("high"), settings.claudeRule("allow", "Read"), settings.claudeRemoveRule("Read"),
      settings.claudeAddDir("/x"), settings.codexModel("gpt-5.5", null), settings.codexPermissions("auto")];
    expect(now.map((c) => c.live)).toEqual(Array(now.length).fill("next-call"));
    const live = Object.fromEntries(SETTING_KEYS.map((k) => [k.key, k.live]));
    for (const key of ["claude.bin", "codex.bin", "claude.model", "codex.args", "claude.role_args.implementer", "codex.role_args.code_reviewer", "claude.max_budget_usd",
      "claude.permission_prompts"]) expect(live[key], key).toBe("next-call");
    for (const key of ["agents.planner", "agents.implementer", "limits.max_retries", "limits.agent_timeout_sec", "limits.max_consecutive_gate_failures",
      "limits.max_discussion_rounds", "limits.max_planning_rounds"]) expect(live[key], key).toBe("next-run");
    // The workspace lock lives in the runs directory: Settings never moves it.
    expect(settingKey("paths.runs_dir")).toBeNull();
    expect(SETTING_KEYS.filter((k) => k.key.startsWith("limits."))).toHaveLength(Object.keys(defaultConfig().limits).length);
  });

  it("sets a key whole, in place, and checks its value as the config does", () => {
    const cfg = defaultConfig();
    const claude = cfg.claude;
    const roles = cfg.claude.role_args;
    settings.value("claude.bin", "/opt/claude").apply(cfg);
    settings.value("claude.args", ["--verbose"]).apply(cfg);
    settings.value("claude.role_args.plan_reviewer", ["--max-turns", "3"]).apply(cfg);
    settings.value("agents.implementer", "codex").apply(cfg);
    settings.value("limits.max_retries", 0).apply(cfg);
    settings.value("claude.max_budget_usd", 2.5).apply(cfg);
    // The backends hold cfg.claude and its role_args: they keep their identity.
    expect(cfg.claude).toBe(claude);
    expect(cfg.claude.role_args).toBe(roles);
    expect(cfg.claude).toMatchObject({ bin: "/opt/claude", args: ["--verbose"], max_budget_usd: 2.5, role_args: { plan_reviewer: ["--max-turns", "3"] } });
    expect([cfg.agents.implementer, cfg.limits.max_retries]).toEqual(["codex", 0]);
    settings.value("claude.role_args.plan_reviewer", undefined).apply(cfg);
    expect(cfg.claude.role_args).toEqual({});
    const args = ["--a"];
    settings.value("codex.args", args).apply(cfg);
    args.push("--b");
    expect(cfg.codex.args).toEqual(["--a"]);
    for (const [key, value] of [["limits.max_retries", -1], ["limits.agent_timeout_sec", 0], ["limits.max_review_rounds", 1.5], ["agents.planner", "gemini"],
      ["claude.args", "--x"], ["claude.args", [1]], ["claude.bin", ""], ["claude.permission_prompts", "maybe"], ["claude.max_budget_usd", -2], ["codex.model", "two words"]] as const) {
      expect(() => settings.value(key, value), `${key}=${JSON.stringify(value)}`).toThrow(ConfigError);
    }
    expect(() => settings.value("paths.runs_dir", "/elsewhere")).toThrow("not a setting");
    expect(() => settings.value("claude.bin", undefined)).toThrow("cannot be removed");
    expect(checkSettingValue(settingKey("limits.agent_idle_timeout_sec")!, 0)).toBeNull();
    expect(checkSettingValue(settingKey("claude.model")!, null)).toBeNull();
  });

  it("drops an earlier change once a later one sets the same keys whole, so a replay never brings it back", () => {
    const rule = settings.claudeRule("allow", "Read");
    const whole = settings.value("claude.args", ["--x"]);
    expect(supersedes(whole, rule)).toBe(true);
    expect(supersedes(rule, whole)).toBe(false);
    // codexModel also sets codex.model: a change of codex.args alone leaves it.
    expect(supersedes(settings.value("codex.args", []), settings.codexModel("o3", "high"))).toBe(false);
    expect(supersedes(settings.value("claude.role_args.implementer", ["--y"]), settings.mode("auto"))).toBe(true);
    const list = withChange(withChange(withChange([], rule), settings.claudeModel("opus")), whole);
    expect(list).toEqual([expect.objectContaining({ paths: [["claude", "model"]] }), whole]);
    const cfg = defaultConfig();
    for (const c of [...list, ...list]) c.apply(cfg);
    expect(cfg.claude.args).toEqual(["--x"]);
    expect(changeFor({ target: "claude.model" })).toBeNull();
    expect(changeFor({ target: "codex.permissions", preset: "read-only" })?.paths).toEqual([["codex", "args"]]);
  });

  it("removes a key from a config file to inherit again, with its comments kept and no null left behind", () => {
    const t = tempDir();
    dirs.push(t);
    const file = join(t.path, "ws", ".agentduo", "config.yaml");
    mkdirSync(join(t.path, "ws", ".agentduo"), { recursive: true });
    writeFileSync(file, "# mine\nclaude:\n  model: opus # keep\n  role_args:\n    implementer: [--permission-mode, auto]\nlimits:\n  max_retries: 2\n");
    expect(clearSettings(file, [["claude", "role_args", "implementer"]])).toBe(true);
    let text = readFileSync(file, "utf8");
    expect(text).not.toContain("role_args");
    expect(text).not.toContain("null");
    for (const s of ["# mine", "model: opus # keep", "max_retries: 2"]) expect(text).toContain(s);
    expect(clearSettings(file, [["claude", "model"], ["limits", "max_retries"]])).toBe(true);
    text = readFileSync(file, "utf8");
    expect(text).not.toMatch(/claude:|limits:|null/);
    expect(clearSettings(file, [["codex", "model"]])).toBe(false);
    expect(clearSettings(join(t.path, "none.yaml"), [["codex", "model"]])).toBe(false);
    // A mode removed for the implementer is removed from the file, never written as null.
    const cfg = defaultConfig();
    writeFileSync(file, "claude:\n  role_args:\n    implementer: [--permission-mode, auto]\n    planner: [--x]\n");
    const manual = settings.mode("manual");
    cfg.claude.role_args = { implementer: ["--permission-mode", "auto"], planner: ["--x"] };
    manual.apply(cfg);
    saveSettings(file, cfg, manual.paths);
    text = readFileSync(file, "utf8");
    expect(text).not.toContain("implementer");
    expect(text).toContain("planner");
    writeFileSync(file, "claude: [unclosed\n");
    expect(() => clearSettings(file, [["claude", "model"]])).toThrow(ConfigError);
    expect(readFileSync(file, "utf8")).toBe("claude: [unclosed\n");
  });
});
