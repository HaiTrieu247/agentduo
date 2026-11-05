// Runs agentduo against the REAL Codex and Claude CLIs on a tiny demo repository.
// This spends real usage (roughly $0.5 with default models). Run manually: npm run smoke:real
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const repo = mkdtempSync(join(tmpdir(), "agentduo-smoke-"));
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
git("init", "-q", "-b", "main");
mkdirSync(join(repo, "test"));
writeFileSync(join(repo, "calc.mjs"), "export function add(a, b) {\n  return a + b;\n}\n");
writeFileSync(join(repo, "test", "calc.test.mjs"),
  'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../calc.mjs";\n\ntest("add", () => {\n  assert.equal(add(2, 3), 5);\n});\n');
writeFileSync(join(repo, ".gitignore"), ".agentduo/runs/\n");
mkdirSync(join(repo, ".agentduo"));
// The demo machine has no Claude Code edit permissions configured, so grant them for this run only.
writeFileSync(join(repo, ".agentduo", "config.yaml"),
  'gates:\n  - name: tests\n    command: "node --test"\n    required: true\nclaude:\n  role_args:\n    implementer: [--permission-mode, acceptEdits]\n');
git("add", "-A");
git("-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-qm", "init");

const task = "Add a subtract(a, b) function to calc.mjs, with a unit test in test/calc.test.mjs";
const result = spawnSync(process.execPath, [cli, "--plain", task, "--dir", repo], { stdio: "inherit" });
console.log(`\nexit code: ${result.status}\nrepo kept for inspection: ${repo}`);
console.log(git("diff", "--stat"));
process.exitCode = result.status === 0 ? 0 : 1;
