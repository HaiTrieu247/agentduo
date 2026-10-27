import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, type CliIO } from "../src/cli.js";
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

function writeRepoConfig(overrides: ConfigOverrides = {}): void {
  mkdirSync(join(repo, ".agentduo"), { recursive: true });
  writeFileSync(join(repo, ".agentduo", "config.yaml"), YAML.stringify(testConfig(fake, overrides)));
}

async function cli(args: string[], cwd = repo): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io: CliIO = {
    stdout: { write: (s: string) => { out += s; } },
    stderr: { write: (s: string) => { err += s; } },
    stdin: {},
    env: { ...process.env, XDG_CONFIG_HOME: join(t.path, "xdg"), CI: "" },
    cwd,
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

  it("init detects gates and ignores run data", async () => {
    const other = makeRepo(join(t.path, "other"), { ignoreRuns: false });
    writeFileSync(join(other, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const r = await cli(["init"], other);
    expect(r.code).toBe(0);
    for (const s of ["created", "gate test: npm run test", "added .agentduo/runs/ to .gitignore"]) expect(r.out).toContain(s);
    expect(existsSync(join(other, ".agentduo", "config.yaml"))).toBe(true);
  });

  it("runs a task end to end from a subdirectory with plain output", async () => {
    writeRepoConfig();
    fake.setScenario(happy());
    mkdirSync(join(repo, "sub"));
    const r = await cli(["Make app.txt fixed"], join(repo, "sub"));
    expect(r.code, r.err).toBe(0);
    for (const s of ["agentduo 0.1.0 · run", "▶ planner", "Codex → Claude  Plan v1", "Claude → Codex  approved", "✓ gate check", "[DONE]"]) {
      expect(r.out).toContain(s);
    }
    expect((await cli(["list"])).out).toContain("DONE");
    expect((await cli(["status"])).out).toMatch(/Run \S+ — DONE/);
  });

  it("refuses bad starts before calling any agent", async () => {
    writeRepoConfig();
    fake.setScenario(happy());
    expect((await cli([])).err).toContain("a task description is required");
    writeFileSync(join(repo, "README.md"), "local edit\n");
    const dirty = await cli(["Fix"]);
    expect([dirty.code, dirty.err.includes("uncommitted")]).toEqual([1, true]);
    git(repo, "checkout", "README.md");
    const outside = await cli(["Fix", "--repo", join(t.path, "nowhere")]);
    expect([outside.code, outside.err.includes("not a git repository")]).toEqual([1, true]);
    writeRepoConfig({ codex: { bin: join(t.path, "missing") } });
    expect((await cli(["Fix"])).err).toContain("CLI not found: codex");
    expect(fake.calls()).toEqual([]);
  });

  it("waits for a decision in plain mode and resumes with flags", async () => {
    writeRepoConfig({ limits: { max_review_rounds: 1 } });
    fake.setScenario({ ...happy(), code_reviewer: [{ output: review(false, [finding("F1")]) }] });
    const first = await cli(["Make app.txt fixed"]);
    expect(first.code).toBe(2);
    expect(first.out).toContain("HUMAN_REVIEW needed (max_review_rounds)");
    expect(first.out).toContain("duo resume");
    expect((await cli(["resume", "--note", "x"])).err).toContain("--note is only accepted together with --decision");
    expect((await cli(["resume", "--decision", "bogus"])).code).toBe(1);
    expect((await cli(["resume", "--decision", "abort"])).code).toBe(3);
    const again = await cli(["resume", "--decision", "resume"]);
    expect([again.code, again.err.includes("not waiting for a decision")]).toEqual([1, true]);
  });

  it("runs doctor", async () => {
    writeRepoConfig();
    const ok = await cli(["doctor"]);
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toContain("✓ codex CLI:");
    expect(ok.out).toContain("doctor: ready");
    writeRepoConfig({ claude: { bin: join(t.path, "missing") } });
    const bad = await cli(["doctor"]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("✗ claude CLI not found");
  });
});
