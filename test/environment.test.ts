import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, defaultConfig } from "../src/core/config.js";
import { diagnose, EnvironmentError, expandHome, prepareEnvironment, runnableProblem } from "../src/core/environment.js";
import { GIT_MISSING } from "../src/core/run-git.js";
import { testConfig, userConfigEnv, userDataEnv } from "./helpers/config.js";
import { FakeClis } from "./helpers/fake-clis.js";
import { makeRepo } from "./helpers/repo.js";
import { tempDir } from "./helpers/tmp.js";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (dirs.length) dirs.pop()!.cleanup();
});

function setup() {
  const t = tempDir();
  dirs.push(t);
  const repo = makeRepo(t.path);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(t.path, "home"), ...userConfigEnv(join(t.path, "xdg")), ...userDataEnv(join(t.path, "data")) };
  const writeConfig = (dir: string, yaml: string) => {
    mkdirSync(join(dir, ".agentduo"), { recursive: true });
    writeFileSync(join(dir, ".agentduo", "config.yaml"), yaml);
  };
  return { t, repo, env, writeConfig };
}

describe("prepareEnvironment", () => {
  it("uses the given directory as the workspace, never the repository root above it", async () => {
    const { repo, env } = setup();
    const ws = join(repo, "gói pkg");
    mkdirSync(ws);
    const e = await prepareEnvironment({ cwd: repo, dir: "gói pkg", env });
    expect([e.workspace, e.isRepo, e.runsDir, e.configFile]).toEqual([ws, true, join(ws, ".agentduo", "runs"), join(ws, ".agentduo", "config.yaml")]);
    expect((await prepareEnvironment({ cwd: ws, env })).workspace).toBe(ws);
    expect(e.sources).toEqual([]);
  });

  it("resolves runs_dir relative to the workspace, absolute as is, and ~ against HOME", async () => {
    const { t, repo, env, writeConfig } = setup();
    writeConfig(repo, "paths:\n  runs_dir: build/runs\n");
    expect((await prepareEnvironment({ cwd: repo, env })).runsDir).toBe(join(repo, "build", "runs"));
    writeConfig(repo, `paths:\n  runs_dir: ${JSON.stringify(join(t.path, "shared"))}\n`);
    expect((await prepareEnvironment({ cwd: repo, env })).runsDir).toBe(join(t.path, "shared"));
    writeConfig(repo, "paths:\n  runs_dir: ~/agentduo-runs\n");
    expect((await prepareEnvironment({ cwd: repo, env })).runsDir).toBe(join(t.path, "home", "agentduo-runs"));
    writeConfig(repo, "paths:\n  runs_dir:\n");
    expect((await prepareEnvironment({ cwd: repo, env })).runsDir).toBe(join(repo, ".agentduo", "runs"));
    expect(expandHome("~", { HOME: "/h" })).toBe(join("/h"));
    expect(expandHome("~user/x", { HOME: "/h" })).toBe("~user/x");
    // ~\ is the home directory on Windows only, where \ separates folders.
    expect(expandHome("~\\runs", { HOME: "/h" })).toBe(process.platform === "win32" ? join("/h", "runs") : "~\\runs");
  });

  it("layers the user config under the workspace one, or reads --config (relative to cwd) instead", async () => {
    const { t, repo, env, writeConfig } = setup();
    mkdirSync(join(t.path, "xdg", "agentduo"), { recursive: true });
    writeFileSync(join(t.path, "xdg", "agentduo", "config.yaml"), "claude:\n  model: opus\ncodex:\n  model: user\n");
    writeConfig(repo, "codex:\n  model: ws\n");
    const layered = await prepareEnvironment({ cwd: repo, env });
    expect([layered.cfg.claude.model, layered.cfg.codex.model, layered.sources.length]).toEqual(["opus", "ws", 2]);
    writeFileSync(join(t.path, "other.yaml"), "codex:\n  model: other\n");
    const explicit = await prepareEnvironment({ cwd: t.path, dir: "repo", configPath: "other.yaml", env });
    expect([explicit.cfg.codex.model, explicit.configFile]).toEqual(["other", join(t.path, "other.yaml")]);
    await expect(prepareEnvironment({ cwd: repo, configPath: "missing.yaml", env })).rejects.toBeInstanceOf(ConfigError);
  });

  it("returns warnings as data, loads an invalid config unvalidated, and refuses a bad directory", async () => {
    const { t, repo, env, writeConfig } = setup();
    writeConfig(repo, "codex:\n  extra_args: [x]\n  bin: 5\n");
    const e = await prepareEnvironment({ cwd: repo, env });
    expect(e.warnings).toEqual([expect.stringContaining("'codex.extra_args' was renamed to 'codex.args'")]);
    expect(e.cfg.codex.bin).toBe(5);
    await expect(prepareEnvironment({ cwd: t.path, dir: "nope", env })).rejects.toThrow(new EnvironmentError(`no such directory: ${join(t.path, "nope")}`));
    writeFileSync(join(t.path, "file"), "x");
    await expect(prepareEnvironment({ cwd: t.path, dir: "file", env })).rejects.toThrow(`not a directory: ${join(t.path, "file")}`);
    expect((await prepareEnvironment({ cwd: t.path, env })).isRepo).toBe(false);
  });

  it("says where a new run would keep its snapshots: the repository, or agentduo's own outside a folder with none", async () => {
    const { t, repo, env } = setup();
    expect((await prepareEnvironment({ cwd: repo, env })).snapshots).toEqual({ mode: "native" });
    mkdirSync(join(t.path, "plain"));
    const plain = await prepareEnvironment({ cwd: join(t.path, "plain"), env });
    expect([plain.isRepo, plain.snapshots]).toEqual([false, { mode: "internal", repositories: join(t.path, "data", "agentduo", "repositories") }]);
    // Never where the snapshots would take in themselves.
    expect((await prepareEnvironment({ cwd: t.path, env })).snapshots).toMatchObject({ mode: null, problem: { kind: "git" } });
    // Only looks: nothing is created yet.
    expect(existsSync(join(t.path, "data"))).toBe(false);
  });
});

describe("runnableProblem", () => {
  it("names the first reason agents cannot run, with the CLI's own messages", async () => {
    const { t, repo, env } = setup();
    const fake = new FakeClis(t.path);
    const ok = testConfig(fake);
    const ws = { snapshots: { mode: "native" } as const };
    expect(runnableProblem(ws, ok, "", env)).toBeNull();
    // A folder with no git repository needs none: the run keeps its snapshots in agentduo's own.
    expect(runnableProblem({ snapshots: { mode: "internal", repositories: "/data" } }, ok, "", env)).toBeNull();
    const home = { mode: null, problem: { kind: "not_repo", message: "/x is your home folder" } } as const;
    expect(runnableProblem({ snapshots: home }, ok, "", env)).toEqual({ kind: "not_repo", message: "/x is your home folder" });
    const noGit = { mode: null, problem: { kind: "git", message: GIT_MISSING } } as const;
    expect(runnableProblem({ snapshots: noGit }, ok, "", env)).toEqual({ kind: "git", message: GIT_MISSING });
    // The chat opens anywhere, also without Git; a run checks where its snapshots go itself.
    expect(runnableProblem({ snapshots: noGit }, ok, "", env, { repo: false })).toBeNull();
    const bad = { ...ok, limits: { ...ok.limits, max_retries: -1 } };
    expect(runnableProblem(ws, bad, "ws.yaml", env)).toMatchObject({ kind: "config", message: expect.stringContaining("invalid configuration (ws.yaml)") });
    const missing = { ...ok, codex: { ...ok.codex, bin: join(t.path, "missing") } };
    expect(runnableProblem(ws, missing, "", env)?.message).toBe("CLI not found: codex. Install it or set '<backend>.bin' in the config; run 'duo doctor' for details.");
    expect(runnableProblem(ws, missing, "", env, { saved: true })?.message).toContain("pass --reload-config");
    expect(runnableProblem(ws, missing, "", env, { backends: ["claude"] })).toBeNull();
    const claudeOnly = { ...missing, agents: { planner: "claude", plan_reviewer: "claude", implementer: "claude", code_reviewer: "claude" } as const };
    expect(runnableProblem(ws, claudeOnly, "", env)).toBeNull();
  });
});

describe("diagnose", () => {
  it("reports a config that does not validate and checks the rest with the defaults", async () => {
    const { repo, env, writeConfig } = setup();
    writeConfig(repo, "codex:\n  bin: 5\n");
    const checks = await diagnose(await prepareEnvironment({ cwd: repo, env }), env);
    expect(checks.find((c) => c.message.startsWith("config:"))).toMatchObject({ ok: false, message: expect.stringContaining("codex.bin must be a non-empty string") });
    expect(checks.some((c) => c.message === `workspace inside a git repository: ${repo} (pipeline snapshots go in it)`)).toBe(true);
    expect(defaultConfig().codex.bin).toBe("codex");
  });
});
