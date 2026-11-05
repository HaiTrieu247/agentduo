// The examples the pages show are run, not just printed: the first-task project fails its gate before the fix and
// passes after it, the setup script creates exactly those files, and every complete config example is one the
// repository's own `duo doctor` accepts (the built CLI, ../apps/cli/dist/cli.js, from `npm run build` at the repository root).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { FIRST_TASK_DIR, FIRST_TASK_FILES, firstTaskConfig, firstTaskFile, firstTaskScript } from "../lib/tutorial.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const examples = join(root, "examples");
const cli = join(root, "..", "apps", "cli", "dist", "cli.js");
const temps = [];
const temp = (name) => {
  const dir = mkdtempSync(join(tmpdir(), `agentduo-${name}-`));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

// NODE_TEST_CONTEXT would make the project's own `node --test` report to this runner instead of exiting with its result.
const { NODE_TEST_CONTEXT: _context, ...baseEnv } = process.env;
const run = (cmd, args, cwd, env = {}) => spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...baseEnv, ...env }, shell: process.platform === "win32" && cmd === "npm" });

function gitRepo(dir) {
  const git = (...args) => {
    const r = run("git", args, dir);
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q");
  git("-c", "user.name=Website Test", "-c", "user.email=website-test@example.invalid", "add", ".");
  git("-c", "user.name=Website Test", "-c", "user.email=website-test@example.invalid", "commit", "-q", "-m", "start");
}

test("the first-task gate fails on the starting project and passes on the solution", () => {
  for (const [variant, ok] of [["initial", false], ["solution", true]]) {
    const dir = join(temp(`first-task-${variant}`), FIRST_TASK_DIR);
    cpSync(join(examples, "first-task", variant), dir, { recursive: true });
    mkdirSync(join(dir, ".agentduo"));
    writeFileSync(join(dir, ".agentduo", "config.yaml"), firstTaskConfig());
    gitRepo(dir);
    // The exact gate command of examples/config/first-task.yaml.
    assert.match(firstTaskConfig(), /command: "npm test"/);
    const r = run("npm", ["test"], dir);
    assert.equal(r.status === 0, ok, `${variant}: npm test exited ${r.status}\n${r.stdout}${r.stderr}`);
    if (!ok) assert.match(r.stdout + r.stderr, /1h 62m 05s|1h 02m 05s/);
  }
});

test("the tutorial's setup script creates the starting project", { skip: process.platform === "win32" && "POSIX shell script" }, () => {
  const dir = temp("first-task-script");
  const r = run("sh", ["-c", firstTaskScript()], dir);
  assert.equal(r.status, 0, r.stderr);
  for (const rel of FIRST_TASK_FILES) assert.equal(readFileSync(join(dir, FIRST_TASK_DIR, rel), "utf8"), firstTaskFile("initial", rel));
  assert.equal(readFileSync(join(dir, FIRST_TASK_DIR, ".agentduo", "config.yaml"), "utf8"), firstTaskConfig());
});

const doctor = (config) => {
  const dir = temp("doctor");
  gitRepo((writeFileSync(join(dir, "README.md"), "x\n"), dir));
  const home = temp("doctor-config");
  // A user config folder of its own, on every OS, so the developer's real config never takes part.
  const r = run(process.execPath, [cli, "doctor", "--plain", "--dir", dir, "--config", config], dir, { XDG_CONFIG_HOME: home, APPDATA: home, NO_COLOR: "1" });
  const line = (r.stdout + r.stderr).split(/\r?\n/).find((l) => /config:/.test(l)) ?? "";
  return { line, out: r.stdout + r.stderr };
};

const configs = readdirSync(join(examples, "config")).filter((f) => f.endsWith(".yaml"));

test("every config example passes duo doctor's configuration check", { skip: !existsSync(cli) && "run npm run build at the repository root first" }, () => {
  assert.ok(configs.length >= 5);
  for (const f of configs) {
    const { line, out } = doctor(join(examples, "config", f));
    assert.match(line, /✓ config:/, `${f}:\n${out}`);
  }
});

test("a wrong gate is reported by the same check", { skip: !existsSync(cli) && "run npm run build at the repository root first" }, () => {
  const { line } = doctor(join(root, "test", "fixtures", "invalid-gate.yaml"));
  assert.match(line, /✗ config: invalid configuration/);
  assert.match(line, /gates\[0\] needs 'name' and 'command'/);
});
