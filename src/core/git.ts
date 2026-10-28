import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

export class GitError extends Error {
  override name = "GitError";
}

export interface Snapshot {
  commit: string;
  tree: string;
}

export type Change = [status: string, path: string];

/**
 * Never part of a snapshot: Claude's personal settings, where "Always allow" at a permission prompt saves its rule.
 * Anchored at the repository root (`top`), so it holds for both the workspace and the whole-repository scope.
 */
const ALWAYS_EXCLUDED = [":(exclude,glob,top)**/.claude/settings.local.json"];

const IDENTITY = {
  GIT_AUTHOR_NAME: "agentduo", GIT_AUTHOR_EMAIL: "agentduo@localhost",
  GIT_COMMITTER_NAME: "agentduo", GIT_COMMITTER_EMAIL: "agentduo@localhost",
};

function parseNameStatusZ(out: string): Change[] {
  const parts = out.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i + 1 < parts.length && parts[i]; i += 2) changes.push([parts[i]!, parts[i + 1]!]);
  return changes;
}

/**
 * Git helpers for one workspace directory: every command runs with cwd = that directory, so the pathspec "."
 * means "this workspace" and ":/" the whole repository. Snapshots stage the working tree into a temporary
 * index and write an unreferenced commit; the user's index, HEAD and branches are never touched.
 */
export class Git {
  constructor(readonly dir: string) {}

  run(args: string[], opts: { env?: Record<string, string>; check?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      execFile("git", args, { cwd: this.dir, env: { ...process.env, ...opts.env }, maxBuffer: 512 * 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (error && typeof error.code === "string") {
            reject(new GitError(`cannot run git in ${this.dir}: ${error.message}`));
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

  /** The workspace's path relative to the repository root ("" at the root). */
  async prefix(): Promise<string> {
    return (await this.run(["rev-parse", "--show-prefix"])).stdout.trim().replace(/\/$/, "");
  }

  async head(): Promise<string | null> {
    return (await this.run(["rev-parse", "--verify", "-q", "HEAD"], { check: false })).stdout.trim() || null;
  }

  async branch(): Promise<string | null> {
    return (await this.run(["symbolic-ref", "-q", "--short", "HEAD"], { check: false })).stdout.trim() || null;
  }

  async isIgnored(path: string): Promise<boolean> {
    for (const candidate of [path, `${path.replace(/\/+$/, "")}/probe`]) {
      if ((await this.run(["check-ignore", "-q", candidate], { check: false })).code === 0) return true;
    }
    return false;
  }

  /** `git add` fails when an exclude pathspec names an already-ignored path, and ignored paths are skipped anyway. */
  private async pathspec(exclude: string[], scope: "." | ":/"): Promise<string[]> {
    const kept: string[] = [];
    for (const p of exclude) if (!(await this.isIgnored(p))) kept.push(`:(exclude)${p}`);
    return ["--", scope, ...kept, ...ALWAYS_EXCLUDED];
  }

  /** Tree hash of the working tree: the workspace (".") or the whole repository (":/"). */
  async worktreeTree(exclude: string[] = [], scope: "." | ":/" = "."): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "agentduo-index-"));
    const index = join(dir, "index");
    const env = { GIT_INDEX_FILE: index };
    try {
      // Seeding from the real index keeps its stat data, so `git add -A` only rehashes files that changed.
      const real = join((await this.run(["rev-parse", "--absolute-git-dir"])).stdout.trim(), "index");
      if (existsSync(real)) await copyFile(real, index);
      // An unmerged path outside the scope would survive `git add` and make write-tree fail, so start from HEAD then.
      if (!existsSync(real) || (await this.run(["ls-files", "-u", "--", ":/"], { env })).stdout) {
        const head = await this.head();
        await this.run(head ? ["read-tree", head] : ["read-tree", "--empty"], { env });
      }
      await this.run(["add", "-A", ...(await this.pathspec(exclude, scope))], { env });
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

  /** The snapshot a ref points at, or null when the ref does not exist. */
  async readRef(ref: string): Promise<Snapshot | null> {
    const commit = (await this.run(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { check: false })).stdout.trim();
    if (!commit) return null;
    return { commit, tree: (await this.run(["rev-parse", `${commit}^{tree}`])).stdout.trim() };
  }

  /** Changes inside the workspace, with paths relative to it. */
  async nameStatus(a: string, b: string): Promise<Change[]> {
    return parseNameStatusZ((await this.run(["diff", "--no-renames", "--relative", "--name-status", "-z", a, b, "--", "."])).stdout);
  }

  /** Changes outside the workspace, with paths relative to it ("../shared/x.ts"). */
  async outsideChanges(a: string, b: string): Promise<Change[]> {
    const prefix = await this.prefix();
    const changes = parseNameStatusZ((await this.run(["diff", "--no-renames", "--name-status", "-z", a, b, "--", ":/", ":(exclude)."])).stdout);
    return changes.map(([status, path]) => [status, posix.relative(prefix, path)]);
  }

  /**
   * A file's content in a snapshot tree, by its path relative to the workspace (as nameStatus reports it);
   * null when the tree has no such file. Snapshot trees cover the whole repository, hence the prefix.
   */
  async readBlob(tree: string, path: string): Promise<Buffer | null> {
    const prefix = await this.prefix();
    const spec = `${tree}:${prefix ? `${prefix}/` : ""}${path}`;
    if ((await this.run(["cat-file", "-e", spec], { check: false })).code !== 0) return null;
    if ((await this.run(["cat-file", "-t", spec])).stdout.trim() !== "blob") return null;
    return new Promise((resolvePromise, reject) => {
      execFile("git", ["cat-file", "blob", spec], { cwd: this.dir, encoding: "buffer", maxBuffer: 512 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new GitError(`git cat-file blob ${spec} failed: ${stderr.toString().trim() || error.message}`));
        else resolvePromise(stdout);
      });
    });
  }

  async diff(a: string, b: string): Promise<string> {
    return (await this.run(["diff", "--no-color", "--relative", a, b, "--", "."])).stdout;
  }

  async diffStat(a: string, b: string): Promise<string> {
    return (await this.run(["diff", "--no-color", "--stat", "--relative", a, b, "--", "."])).stdout;
  }
}
