import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyColorPreference, chatAvailable, isBackgroundFromPs, main, pinTerminalSize, type CliIO } from "../src/cli.js";
import { acquireWorkspaceLock, RunStore } from "../src/core/state.js";
import { packageVersion } from "../src/paths.js";
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
    expect([r.code, r.out.trim()]).toEqual([0, packageVersion()]);
  });

  it("runs a task in the current directory, on a dirty tree, with plain output", async () => {
    writeConfig(repo);
    writeFileSync(join(repo, "README.md"), "local edit\n");
    fake.setScenario(happy());
    const r = await cli(["Make app.txt fixed"]);
    expect(r.code, r.err).toBe(0);
    for (const s of [`agentduo ${packageVersion()} · run`, "▶ planner", "Codex → Claude  Plan v1", "Claude → Codex  approved", "✓ gate check", "[DONE]"]) expect(r.out).toContain(s);
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

  it("accepts the common options before a subcommand too", async () => {
    const init = await cli(["--dir", repo, "init"], t.path);
    expect(init.code, init.err).toBe(0);
    expect(existsSync(join(repo, ".agentduo", "config.yaml"))).toBe(true);
    expect(existsSync(join(t.path, ".agentduo"))).toBe(false);
    expect((await cli(["--dir", repo, "list"], t.path)).out).toContain(`no runs in ${join(repo, ".agentduo", "runs")}`);
  });

  it("falls back to the default runs dir when paths.runs_dir is empty", async () => {
    mkdirSync(join(repo, ".agentduo"), { recursive: true });
    writeFileSync(join(repo, ".agentduo", "config.yaml"), "paths:\n  runs_dir:\n");
    expect((await cli(["list"])).out).toContain(`no runs in ${join(repo, ".agentduo", "runs")}`);
    expect((await cli(["Fix"])).err).toContain("paths.runs_dir must be a non-empty string");
  });

  it("keeps run data out of git even without duo init", async () => {
    const other = makeRepo(join(t.path, "bare"), { ignoreRuns: false });
    writeConfig(other);
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "config");
    fake.setScenario(happy());
    const r = await cli(["Make app.txt fixed"], other);
    expect(r.code, r.err).toBe(0);
    expect(git(other, "status", "--porcelain", "-uall")).toBe("?? app.txt");
  });

  it("leaves no run behind when another run holds the workspace", async () => {
    writeConfig(repo, { limits: { max_review_rounds: 1 } });
    fake.setScenario({ ...happy(), code_reviewer: [{ output: review(false, [finding("F1")]) }] });
    expect((await cli(["Make app.txt fixed"])).code).toBe(2);
    const runsDir = join(repo, ".agentduo", "runs");
    const latest = readFileSync(join(runsDir, "LATEST"), "utf8");
    const store = RunStore.open(runsDir);
    const saved = readFileSync(store.path("config.json"), "utf8");
    const release = acquireWorkspaceLock(runsDir);
    try {
      const busy = await cli(["Another task"]);
      expect([busy.code, busy.err.includes("another agentduo run is active")]).toEqual([1, true]);
      writeConfig(repo, { limits: { max_review_rounds: 3 } });
      expect((await cli(["resume", "--reload-config", "--decision", "resume"])).code).toBe(1);
    } finally {
      release();
    }
    expect(RunStore.list(runsDir)).toHaveLength(1);
    expect(readFileSync(join(runsDir, "LATEST"), "utf8")).toBe(latest);
    expect(readFileSync(store.path("config.json"), "utf8")).toBe(saved);
  });

  it("refuses to resume a run from another workspace", async () => {
    const shared = join(t.path, "shared-runs");
    writeConfig(repo, { limits: { max_review_rounds: 1 }, paths: { runs_dir: shared } });
    fake.setScenario({ ...happy(), code_reviewer: [{ output: review(false, [finding("F1")]) }] });
    expect((await cli(["Make app.txt fixed"])).code).toBe(2);
    const ws = join(repo, "pkg");
    mkdirSync(ws);
    writeConfig(ws, { paths: { runs_dir: shared } });
    const r = await cli(["resume", "--decision", "abort"], ws);
    expect([r.code, r.err.includes(`belongs to the workspace ${repo}`)]).toEqual([1, true]);
  });

  it("refuses bad starts before calling any agent", async () => {
    writeConfig(repo);
    fake.setScenario(happy());
    const bare = await cli([]);
    expect(bare.err).toContain("a task description is required");
    expect(bare.err).toContain("in a terminal, `duo` alone opens a chat");
    const outside = join(t.path, "plain folder");
    mkdirSync(outside);
    const notGit = await cli(["Fix"], outside);
    expect([notGit.code, notGit.err.includes("is not inside a git repository (run 'git init' here, or 'duo init' to be asked)")]).toEqual([1, true]);
    const missingFile = await cli(["--task-file", join(t.path, "nope.md")]);
    expect([missingFile.code, missingFile.err.includes("cannot read task file")]).toEqual([1, true]);
    expect((await cli(["stauts"])).err).toContain("did you mean 'status'");
    writeConfig(repo, { codex: { bin: join(t.path, "missing") } });
    expect((await cli(["Fix"])).err).toContain("CLI not found: codex");
    writeFileSync(join(t.path, "a-file"), "x\n");
    expect((await cli(["Fix", "--dir", join(t.path, "a-file")])).err).toContain("not a directory");
    expect(fake.calls()).toEqual([]);
  });

  it("lets the implementer edit without asking with --accept-edits", async () => {
    writeConfig(repo);
    fake.setScenario(happy());
    const r = await cli(["--accept-edits", "Make app.txt fixed"]);
    expect(r.code, r.err).toBe(0);
    const args = fake.calls("implementer")[0]!.args;
    expect(args.slice(-2)).toEqual(["--permission-mode", "acceptEdits"]);
    expect(fake.calls("plan_reviewer")[0]!.args).not.toContain("--permission-mode");
    const before = await cli(["--accept-edits", "run", "Make app.txt fixed"]);
    expect(before.code, before.err).toBe(0);
    expect(fake.calls("implementer").at(-1)!.args.slice(-2)).toEqual(["--permission-mode", "acceptEdits"]);
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
    writeFileSync(store.path("config.json"), JSON.stringify(testConfig(fake, { codex: { bin: join(t.path, "missing") } })));
    writeConfig(repo, { limits: { max_review_rounds: 1 } });
    const stale = await cli(["resume", "--decision", "resume"]);
    expect([stale.err.includes("CLI not found: codex"), stale.err.includes("--reload-config")]).toEqual([true, true]);
    writeFileSync(store.path("config.json"), JSON.stringify(testConfig(fake, { limits: { max_review_rounds: 1 } })));
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

  it("opens the chat only for `duo` alone on an interactive terminal", () => {
    const io = (over: Partial<CliIO> = {}): CliIO => ({ stdout: { write: () => true, isTTY: true }, stderr: { write: () => true }, stdin: { isTTY: true }, env: {}, cwd: repo, ...over });
    expect(chatAvailable(io(), {})).toBe(true);
    expect(chatAvailable(io(), { plain: true })).toBe(false);
    expect(chatAvailable(io({ env: { CI: "true" } }), {})).toBe(false);
    expect(chatAvailable(io({ stdin: {} }), {})).toBe(false);
    expect(chatAvailable(io({ stdout: { write: () => true } }), {})).toBe(false);
    expect(chatAvailable(io({ isBackground: () => true }), {})).toBe(false);
  });

  it("gives a terminal that reports no size a fixed one, so Ink never falls back to probing /dev/tty", () => {
    const sized: NodeJS.ProcessEnv = {};
    pinTerminalSize({ isTTY: true, columns: 120, rows: 40 }, sized);
    expect(sized).toEqual({});
    const zero: NodeJS.ProcessEnv = {};
    pinTerminalSize({ isTTY: true, columns: 0, rows: 0 }, zero);
    expect(zero).toEqual({ COLUMNS: "80", LINES: "24" });
    const mine: NodeJS.ProcessEnv = { COLUMNS: "100", LINES: "30" };
    pinTerminalSize({ isTTY: true, columns: 0, rows: 0 }, mine);
    expect(mine).toEqual({ COLUMNS: "100", LINES: "30" });
    const piped: NodeJS.ProcessEnv = {};
    pinTerminalSize({}, piped);
    expect(piped).toEqual({});
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

  it("asks permission questions on a terminal in plain mode, and lets Claude deny them without one", async () => {
    writeConfig(repo);
    const asking = { ...happy(), implementer: [{ write: { "app.txt": "fixed\n" }, permissions: [{ tool: "Bash", input: { command: "npm test" }, rules: [] }], output: impl() }] };
    fake.setScenario(asking);
    const questions: string[] = [];
    let shown = "";
    const tty = await cli(["--plain", "Make app.txt fixed"], repo, {
      stdin: { isTTY: true }, stdout: { write: (s: string) => { shown += s; }, isTTY: true },
      ask: async (q) => { questions.push(q); return "o"; },
    });
    expect(tty.code, tty.err).toBe(0);
    expect(questions).toHaveLength(1);
    expect(shown).toContain("⚠ asks to use Bash: Bash  npm test");
    expect(fake.permissionAnswers().map((a) => a.behavior)).toEqual(["allow"]);
    const piped = await cli(["Make app.txt fixed"]);
    expect(piped.code, piped.err).toBe(0);
    const last = fake.calls("implementer").at(-1)!.args;
    expect(last[last.indexOf("--permission-prompts") + 1]).toBe("none");
  });

  it("uses the plain renderer when running in the background", async () => {
    writeConfig(repo);
    fake.setScenario(happy());
    let shown = "";
    const r = await cli(["Make app.txt fixed"], repo, { stdout: { write: (s: string) => { shown += s; }, isTTY: true }, isBackground: () => true });
    expect(r.code).toBe(0);
    expect(shown).toContain("[DONE]");
  });
});
