import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class GitError extends Error {
  override name = "GitError";
}

export interface Snapshot {
  commit: string;
  tree: string;
}

export type Change = [status: string, path: string];

const IDENTITY = {
  GIT_AUTHOR_NAME: "agentduo", GIT_AUTHOR_EMAIL: "agentduo@localhost",
  GIT_COMMITTER_NAME: "agentduo", GIT_COMMITTER_EMAIL: "agentduo@localhost",
};

/**
 * Git helpers. Snapshots stage the whole working tree (tracked + untracked, honouring .gitignore) into a
 * temporary index and write an unreferenced commit, so the user's index, HEAD and branches are never touched.
 */
export class Git {
  constructor(readonly repo: string) {}

  run(args: string[], opts: { env?: Record<string, string>; check?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      execFile("git", args, { cwd: this.repo, env: { ...process.env, ...opts.env }, maxBuffer: 512 * 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (error && typeof error.code === "string") {
            reject(new GitError(`cannot run git in ${this.repo}: ${error.message}`));
            return;
          }
          const code = error ? Number(error.code ?? 1) : 0;
          if (opts.check !== false && code !== 0) {
            reject(new GitError(`git ${args.join(" ")} failed: ${(stderr || stdout).trim()}`));
            return;
          }
          resolvePromise({ code, stdout, stderr });
        });
    });
  }

  async isRepo(): Promise<boolean> {
    try {
      return (await this.run(["rev-parse", "--is-inside-work-tree"], { check: false })).stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  async toplevel(): Promise<string> {
    return (await this.run(["rev-parse", "--show-toplevel"])).stdout.trim();
  }

  async head(): Promise<string | null> {
    return (await this.run(["rev-parse", "--verify", "-q", "HEAD"], { check: false })).stdout.trim() || null;
  }

  async branch(): Promise<string | null> {
    return (await this.run(["symbolic-ref", "-q", "--short", "HEAD"], { check: false })).stdout.trim() || null;
  }

  async position(): Promise<[string | null, string | null]> {
    return [await this.head(), await this.branch()];
  }

  async isIgnored(path: string): Promise<boolean> {
    for (const candidate of [path, `${path.replace(/\/+$/, "")}/probe`]) {
      if ((await this.run(["check-ignore", "-q", candidate], { check: false })).code === 0) return true;
    }
    return false;
  }

  /** `git add` fails when an exclude pathspec names an already-ignored path, and ignored paths are skipped anyway. */
  private async pathspec(exclude: string[]): Promise<string[]> {
    const kept: string[] = [];
    for (const p of exclude) if (!(await this.isIgnored(p))) kept.push(`:(exclude)${p}`);
    return ["--", ".", ...kept];
  }

  async statusPorcelain(exclude: string[] = []): Promise<string[]> {
    const out = await this.run(["-c", "core.quotePath=false", "status", "--porcelain", "--untracked-files=all", ...(await this.pathspec(exclude))]);
    return out.stdout.split("\n").filter((line) => line.trim());
  }

  async worktreeTree(exclude: string[] = []): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "agentduo-index-"));
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    try {
      const head = await this.head();
      if (head) await this.run(["read-tree", head], { env });
      await this.run(["add", "-A", ...(await this.pathspec(exclude))], { env });
      return (await this.run(["write-tree"], { env })).stdout.trim();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async snapshot(exclude: string[] = [], ref?: string, message = "agentduo snapshot"): Promise<Snapshot> {
    const tree = await this.worktreeTree(exclude);
    const head = await this.head();
    const commit = (await this.run(["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", message], { env: IDENTITY })).stdout.trim();
    if (ref) await this.run(["update-ref", ref, commit]);
    return { commit, tree };
  }

  async nameStatus(a: string, b: string): Promise<Change[]> {
    const out = (await this.run(["-c", "core.quotePath=false", "diff", "--no-renames", "--name-status", a, b])).stdout;
    return out.split("\n").filter((line) => line.trim()).map((line) => {
      const [status, ...rest] = line.split("\t");
      return [status!.trim(), rest.join("\t").trim()] as Change;
    });
  }

  async diff(a: string, b: string): Promise<string> {
    return (await this.run(["diff", "--no-color", a, b])).stdout;
  }

  async diffStat(a: string, b: string): Promise<string> {
    return (await this.run(["diff", "--no-color", "--stat", a, b])).stdout;
  }
}
