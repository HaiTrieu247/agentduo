// Shows the live UI with scripted fake agents (no model calls, no cost): npm run demo:ui
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "agentduo-demo-"));
const repo = join(dir, "repo");
mkdirSync(join(repo, ".agentduo"), { recursive: true });
const git = (...args) => execFileSync("git", args, { cwd: repo });
git("init", "-q", "-b", "main");
writeFileSync(join(repo, "check.mjs"), 'import { readFileSync } from "node:fs";\nprocess.exit(readFileSync("app.txt", "utf8").includes("fixed") ? 0 : 1);\n');
writeFileSync(join(repo, ".gitignore"), ".agentduo/runs/\n");
git("add", "-A");
git("-c", "user.email=demo@example.com", "-c", "user.name=demo", "commit", "-qm", "init");
for (const name of ["codex", "claude"]) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${join(root, "test", "fake-agent.mjs")}" ${name} "$@"\n`);
  chmodSync(path, 0o755);
}
writeFileSync(join(repo, ".agentduo", "config.yaml"), [
  `codex:\n  bin: ${JSON.stringify(join(dir, "codex"))}`,
  `claude:\n  bin: ${JSON.stringify(join(dir, "claude"))}`,
  `gates:\n  - name: check\n    command: ${JSON.stringify(`"${process.execPath}" check.mjs`)}`,
].join("\n") + "\n");
const plan = { title: "Make app.txt fixed", summary: "Write app.txt.", goals: ["app.txt says fixed"], scope_in: ["app.txt"], scope_out: [],
  architecture: "single file", steps: [{ id: "S1", description: "write app.txt", files: ["app.txt"] }], acceptance_criteria: ["check.mjs exits 0"],
  risks: [{ risk: "none", mitigation: "n/a" }], test_strategy: "run check.mjs", open_questions: [], feedback_resolution: [] };
const verdict = (approved, issues = []) => ({ status: approved ? "approved" : "changes_requested", approved, summary: approved ? "looks good" : "needs work", issues });
const issue = { id: "C1", severity: "high", description: "no test strategy for edge cases", suggestion: "add one" };
writeFileSync(join(dir, "scenario.json"), JSON.stringify({
  planner: [{ activities: [{ command: "ls" }, { command: "cat check.mjs" }], sleep: 1500, output: plan }],
  plan_reviewer: [
    { activities: [{ tool: "Read", input: { file_path: join(repo, "check.mjs") } }], sleep: 1500, output: { ...verdict(false, [issue]), accepted: [], disputed: [], proposed_changes: ["add an edge-case test"] } },
    { sleep: 1000, output: { ...verdict(true), accepted: ["C1"], disputed: [], proposed_changes: [] } },
  ],
  plan_finalizer: [{ sleep: 800, output: verdict(true) }],
  implementer: [{ activities: [{ tool: "Write", input: { file_path: join(repo, "app.txt"), content: "fixed\n" } }, { tool: "Bash", input: { command: "node check.mjs" } }],
    sleep: 2000, write: { "app.txt": "fixed\n" },
    output: { status: "completed", summary: "wrote app.txt", files_changed: ["app.txt"], tests_run: [{ command: "node check.mjs", passed: true, notes: "" }], addressed_findings: [], blocking_reason: null } }],
  code_reviewer: [{ activities: [{ command: "git diff" }], sleep: 1500, output: { status: "approved", approved: true, reviewed_commit: "$SNAPSHOT", summary: "good", findings: [], resolved_findings: [] } }],
}));
const env = { ...process.env, FAKE_SCENARIO: join(dir, "scenario.json"), FAKE_COUNTS: join(dir, "counts.json"), FAKE_LOG: join(dir, "calls.jsonl") };
const result = spawnSync(process.execPath, [join(root, "dist", "cli.js"), "Make app.txt fixed", "--repo", repo, ...process.argv.slice(2)], { stdio: "inherit", env });
process.exitCode = result.status ?? 1;
