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
