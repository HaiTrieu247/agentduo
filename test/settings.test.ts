import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { ClaudeBackend } from "../src/agents/claude.js";
import { CodexBackend } from "../src/agents/codex.js";
import { modeLabel, nextMode } from "../src/core/commands.js";
import { describeSettings, permissionMode, saveSettings, settings } from "../src/core/settings.js";
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
});
