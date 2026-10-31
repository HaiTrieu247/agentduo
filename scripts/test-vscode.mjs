// Builds the VS Code extension and runs extensions/vscode/test/smoke.ts in an Extension Development Host (downloaded
// into .vscode-test/), opened on a scratch git repository whose config points at the fake CLIs (test/fake-agent.mjs,
// scripted through FAKE_SCENARIO); then again with no folder open, where agentduo works in the home folder (a scratch
// HOME whose config points at the same fake CLIs). On Linux, run it under xvfb-run. VSCODE_TEST_VERSION picks the VS Code version (default: stable; "1.95.0" is the baseline).
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const ext = join(root, "extensions", "vscode");
const { runTests } = createRequire(import.meta.url)("@vscode/test-electron");
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts });

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "agentduo-vscode-test-")));
let code = 0;
try {
  run(process.execPath, [join(root, "scripts", "build-vscode.mjs")], { cwd: root, stdio: "inherit" });
  run(process.execPath, [join(root, "scripts", "build-vscode.mjs"), "--out", join(tmp, "smoke"), "--only", "smoke"], { cwd: root, stdio: "inherit" });

  const bin = join(tmp, "bin");
  mkdirSync(bin);
  for (const name of ["codex", "claude"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${join(root, "test", "fake-agent.mjs")}" ${name} "$@"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const repo = join(tmp, "repo");
  mkdirSync(join(repo, ".agentduo"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "x\n");
  writeFileSync(join(repo, ".gitignore"), ".agentduo/runs/\n");
  // One review round, so a run with changes requested stops at a decision between its two implementation rounds.
  writeFileSync(join(repo, ".agentduo", "config.yaml"),
    `codex:\n  bin: ${JSON.stringify(join(bin, "codex"))}\nclaude:\n  bin: ${JSON.stringify(join(bin, "claude"))}\nlimits:\n  max_review_rounds: 1\n`);
  run("git", ["init", "-q", "-b", "main"], { cwd: repo });
  run("git", ["add", "-A"], { cwd: repo });
  run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });

  // The worker runs on this Node, whatever PATH the test host gets.
  const userDir = (name) => {
    const dir = join(tmp, name);
    mkdirSync(join(dir, "User"), { recursive: true });
    writeFileSync(join(dir, "User", "settings.json"), JSON.stringify({ "agentduo.nodePath": process.execPath, "workbench.startupEditor": "none" }));
    return dir;
  };
  const host = (folder, user, env = {}) => runTests({
    version: process.env.VSCODE_TEST_VERSION || "stable",
    extensionDevelopmentPath: ext,
    extensionTestsPath: join(tmp, "smoke", "test", "smoke.cjs"),
    // The fake CLIs' script (the smoke test writes the scenario), call counts and log; the worker inherits them.
    extensionTestsEnv: { FAKE_SCENARIO: join(tmp, "scenario.json"), FAKE_COUNTS: join(tmp, "counts.json"), FAKE_LOG: join(tmp, "calls.jsonl"), ...env },
    // No keychain: the test build is not the app the login keychain's "Code Safe Storage" trusts, so macOS would ask for
    // it at every start. VS Code keeps its secrets in memory, and Chromium gets a mock keychain.
    launchArgs: [...folder, "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes",
      "--use-inmemory-secretstorage", "--use-mock-keychain", `--user-data-dir=${user}`],
  });
  await host([repo], userDir("user"));

  // No folder open: the home folder is a scratch one, whose own .agentduo/config.yaml names the fake CLIs.
  const home = join(tmp, "home");
  mkdirSync(join(home, ".agentduo"), { recursive: true });
  writeFileSync(join(home, ".agentduo", "config.yaml"), `codex:\n  bin: ${JSON.stringify(join(bin, "codex"))}\nclaude:\n  bin: ${JSON.stringify(join(bin, "claude"))}\n`);
  writeFileSync(join(tmp, "scenario.json"), "{}");
  // A short name: VS Code's IPC socket goes in the user data directory, whose path macOS caps at 103 bytes.
  await host([], userDir("uh"), { HOME: home });
} catch (e) {
  console.error(`vscode smoke failed: ${e instanceof Error ? e.message : e}`);
  code = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(code);
