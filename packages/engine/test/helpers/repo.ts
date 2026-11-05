import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

/** Gate script used by e2e tests: passes once app.txt says "fixed". */
export const CHECK_SCRIPT = `import { existsSync, readFileSync } from "node:fs";
const ok = existsSync("app.txt") && readFileSync("app.txt", "utf8").includes("fixed");
console.log(ok ? "check ok" : "check failed: app.txt is not fixed");
process.exit(ok ? 0 : 1);
`;

export function makeRepo(parent: string, opts: { ignoreRuns?: boolean } = {}): string {
  const repo = join(parent, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "demo\n");
  if (opts.ignoreRuns !== false) writeFileSync(join(repo, ".gitignore"), ".agentduo/runs/\n");
  writeFileSync(join(repo, "check.mjs"), CHECK_SCRIPT);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}
