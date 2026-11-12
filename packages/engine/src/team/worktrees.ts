// A team run's code (packages/engine/src/team): the base snapshot of the workspace, the integration branch, one git
// worktree per member under agentduo's data root, each task's refs, the merges, and writing the result into the
// workspace once the user accepts it (with a backup to undo it). The workspace is read for the base and written only by
// `apply` and `undo`.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { Git, GitError, type Snapshot } from "../git/git.js";

/** The paths of a team run's refs, under refs/agentduo/team/<run>/. */
export function teamRefs(runId: string) {
  const root = `refs/agentduo/team/${runId}`;
  return {
    base: `${root}/base`,
    integration: `${root}/integration`,
    /** The workspace as it was just before the result was written into it. */
    backup: `${root}/backup`,
    /** The workspace as the result made it. */
    applied: `${root}/applied`,
    /** A member's work on a task (code, tests). */
    task: (task: string, member: string) => `${root}/task/${task}/${member}`,
    /** A task's code and tests merged, as its testers ran them. */
    candidate: (task: string) => `${root}/task/${task}/candidate`,
  };
}

export interface TeamGitOptions {
  /** The run's repository, opened on the workspace (its own, or agentduo's internal one). */
  git: Git;
  workspace: string;
  runId: string;
  /** Where the members' worktrees go: <data root>/teams/<run>. */
  root: string;
  /** Paths inside the workspace no snapshot takes (the runs folder). */
  exclude: string[];
  /** Commands run once in each new worktree, in its copy of the workspace. */
  setup: string[];
  /** Folders of the workspace shared with each worktree by a symlink. */
  link: string[];
  /** Each setup command's output, for the run's log. */
  onSetup?: (member: string, command: string, ok: boolean, output: string) => void;
}

/** What writing the result into the workspace takes. */
export type ApplyPlan =
  /** The workspace is as the base was: the result goes in as it is. */
  | { kind: "direct"; current: Snapshot; tree: string }
  /**
   * The workspace changed since the base and merges cleanly with the result: a tree nobody tested yet. `ours`: the
   * workspace as a commit after the base, which a commit of the merged tree names as a parent.
   */
  | { kind: "merged"; current: Snapshot; tree: string; ours: string }
  /** `tree`: the merge with conflict markers in `files`. */
  | { kind: "conflicts"; current: Snapshot; tree: string; ours: string; files: string[] };

/** Claude's personal settings, where "always allow" saves its rules: the workspace's file, linked into each worktree. */
const CLAUDE_LOCAL = ".claude/settings.local.json";

const exec = (cmd: string, args: string[], cwd: string, shell = false) => new Promise<{ code: number; out: string }>((resolvePromise) => {
  execFile(cmd, args, { cwd, shell, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolvePromise({ code: error ? Number(error.code ?? 1) || 1 : 0, out: `${stdout}${stderr}` });
  });
});

/** A path of a tree as a path inside `dir`; null when it would leave it or enter a .git. */
function inside(dir: string, path: string): string | null {
  const parts = path.split("/");
  if (!path || parts.some((p) => p === ".." || p === "" || p === ".git")) return null;
  return join(dir, ...parts);
}

export class TeamGit {
  readonly refs: ReturnType<typeof teamRefs>;
  /** The workspace's path inside its repository ("" at the root): a worktree's copy of the workspace is there. */
  private prefix: string | null = null;
  /** `git worktree add` changes the repository's worktree list: one at a time. */
  private adding: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: TeamGitOptions) {
    this.refs = teamRefs(o.runId);
  }

  private async workspacePrefix(): Promise<string> {
    this.prefix ??= await this.o.git.prefix();
    return this.prefix;
  }

  /** A member's worktree (the whole repository's files). */
  worktree(member: string): string {
    return join(this.o.root, member);
  }

  /** Where a member works: its worktree's copy of the workspace. */
  async cwd(member: string): Promise<string> {
    const prefix = await this.workspacePrefix();
    return prefix ? join(this.worktree(member), ...prefix.split("/")) : this.worktree(member);
  }

  /** A member's worktree as a repository of its own, on its copy of the workspace. */
  private async memberGit(member: string): Promise<Git> {
    return new Git(await this.cwd(member));
  }

  /** The workspace now, as the base of the run: integration starts there. */
  async createBase(message: string): Promise<Snapshot> {
    const snap = await this.o.git.snapshot(this.o.exclude, this.refs.base, message);
    await this.o.git.run(["update-ref", this.refs.integration, snap.commit]);
    return snap;
  }

  async read(ref: string): Promise<Snapshot | null> {
    return this.o.git.readRef(ref);
  }

  async integrationHead(): Promise<string> {
    const head = await this.o.git.readRef(this.refs.integration);
    if (!head) throw new GitError(`the team run ${this.o.runId} has no integration branch (${this.refs.integration})`);
    return head.commit;
  }

  /**
   * The member's worktree at `commit`, created the first time (then its setup commands run), else checked out there with
   * whatever the member left removed; the workspace's shared folders and Claude's settings are linked in again.
   */
  async checkout(member: string, commit: string): Promise<string> {
    const wt = this.worktree(member);
    if (!existsSync(join(wt, ".git"))) {
      const add = this.adding.then(async () => {
        rmSync(wt, { recursive: true, force: true });
        mkdirSync(dirname(wt), { recursive: true });
        await this.o.git.run(["worktree", "prune"]);
        await this.o.git.run(["worktree", "add", "--detach", "--force", wt, commit]);
      });
      this.adding = add.catch(() => undefined);
      await add;
      await this.links(member);
      const cwd = await this.cwd(member);
      for (const command of this.o.setup) {
        const r = await exec(command, [], cwd, true);
        this.o.onSetup?.(member, command, r.code === 0, r.out);
      }
    } else {
      const git = new Git(wt);
      // A merge left half done (a conflict the member resolved, or did not) goes first.
      await git.run(["merge", "--abort"], { check: false });
      await git.run(["checkout", "--detach", "--force", commit]);
      await git.run(["clean", "-fd", ...this.keep().flatMap((p) => ["-e", p])]);
      await this.links(member);
    }
    return this.cwd(member);
  }

  /** What a worktree keeps across checkouts and never snapshots: the links into the workspace. */
  private keep(): string[] {
    return [...this.o.link, CLAUDE_LOCAL];
  }

  private async links(member: string): Promise<void> {
    const cwd = await this.cwd(member);
    for (const path of [...this.o.link, CLAUDE_LOCAL]) {
      const source = inside(this.o.workspace, path);
      const target = inside(cwd, path);
      if (!source || !target || !existsSync(source)) continue;
      let present = false;
      try {
        present = lstatSync(target).isSymbolicLink();
      } catch {
        // not there yet
      }
      if (present) continue;
      rmSync(target, { recursive: true, force: true });
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(source, target, lstatSync(source).isDirectory() ? "junction" : "file");
    }
  }

  /** The member's worktree as a commit on `ref`, whose parent is the commit the worktree was checked out at. */
  async snapshot(member: string, ref: string, message: string): Promise<Snapshot> {
    const git = await this.memberGit(member);
    const snap = await git.snapshot(this.keep(), undefined, message);
    await this.o.git.run(["update-ref", ref, snap.commit]);
    return snap;
  }

  /** The commits merged into one, in order; the first conflict stops it. */
  async merge(commits: string[], message: string): Promise<{ commit: string } | { conflicts: string[] }> {
    let commit = commits[0]!;
    for (const next of commits.slice(1)) {
      const merged = await this.o.git.mergeTree(commit, next);
      if (merged.conflicts.length) return { conflicts: merged.conflicts };
      commit = await this.o.git.commitTree(merged.tree, [commit, next], message);
    }
    return { commit };
  }

  /**
   * `commit` merged into the integration branch, which may have moved since the task started from it. A conflict
   * changes nothing and names the files.
   */
  async mergeIntoIntegration(commit: string, message: string): Promise<{ head: string } | { conflicts: string[] }> {
    const head = await this.integrationHead();
    const merged = await this.o.git.mergeTree(head, commit);
    if (merged.conflicts.length) return { conflicts: merged.conflicts };
    const next = await this.o.git.commitTree(merged.tree, [head, commit], message);
    await this.o.git.run(["update-ref", this.refs.integration, next, head]);
    return { head: next };
  }

  /**
   * The member's worktree at the integration head with `commit` merged in and the conflicts left as markers, for the
   * member to resolve; the files that conflict.
   */
  async startResolve(member: string, commit: string): Promise<string[]> {
    const head = await this.integrationHead();
    await this.checkout(member, head);
    const git = new Git(this.worktree(member));
    await git.run(["merge", "--no-ff", "--no-commit", commit], { check: false, env: IDENTITY });
    const files = (await git.run(["diff", "--name-only", "--diff-filter=U", "-z"])).stdout.split("\0").filter(Boolean);
    const prefix = await this.workspacePrefix();
    return files.map((f) => (prefix ? posix.relative(prefix, f) : f));
  }

  /**
   * The member's resolution as the merge of `commit` into the integration branch. Refused (and nothing changes) when a
   * file still has conflict markers, or when the integration branch moved since the merge started.
   */
  async finishResolve(member: string, commit: string, expectedHead: string, message: string): Promise<{ head: string } | { problem: string }> {
    const cwd = await this.cwd(member);
    const git = new Git(this.worktree(member));
    const unmerged = (await git.run(["diff", "--name-only", "--diff-filter=U", "-z"])).stdout.split("\0").filter(Boolean);
    const marked = unmerged.filter((f) => {
      const path = join(this.worktree(member), ...f.split("/"));
      return existsSync(path) && /^(<{7}|>{7})( |$)/m.test(readFileSync(path, "utf8"));
    });
    if (marked.length) return { problem: `conflict markers are still in ${marked.join(", ")}` };
    const head = await this.integrationHead();
    if (head !== expectedHead) return { problem: "the integration branch moved while the conflict was being resolved" };
    const tree = await new Git(cwd).worktreeTree(this.keep());
    const next = await this.o.git.commitTree(tree, [head, commit], message);
    await this.o.git.run(["update-ref", this.refs.integration, next, head]);
    await git.run(["merge", "--abort"], { check: false });
    return { head: next };
  }

  /** How `commit` would go into the workspace now. */
  async planApply(commit: string, message: string): Promise<ApplyPlan> {
    const base = await this.read(this.refs.base);
    if (!base) throw new GitError(`the team run ${this.o.runId} has no base snapshot`);
    const current = await this.o.git.snapshot(this.o.exclude, this.refs.backup, `${message} (the workspace before)`);
    const tree = (await this.o.git.run(["rev-parse", `${commit}^{tree}`])).stdout.trim();
    if (current.tree === base.tree) return { kind: "direct", current, tree };
    // The workspace as a child of the base, so the merge's base is the run's base whatever the workspace's own history.
    const ours = await this.o.git.commitTree(current.tree, [base.commit], `${message} (the workspace)`);
    const merged = await this.o.git.mergeTree(ours, commit);
    if (merged.conflicts.length) return { kind: "conflicts", current, tree: merged.tree, ours, files: merged.conflicts };
    return { kind: "merged", current, tree: merged.tree, ours };
  }

  /**
   * Writes `to` into the workspace over `from` (what the workspace holds now): the files that differ are written,
   * created or deleted, with their modes; nothing is committed, and the workspace's git index is not touched.
   */
  async write(from: string, to: string): Promise<string[]> {
    const written: string[] = [];
    for (const change of await this.o.git.rawChanges(from, to)) {
      const path = inside(this.o.workspace, change.path);
      if (!path) continue;
      const gone = change.dstMode === "000000";
      if (gone || change.status === "T" || existsSync(path)) {
        try {
          if (lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink()) rmSync(path, { recursive: true, force: true });
          else unlinkSync(path);
        } catch {
          // already gone
        }
      }
      if (gone) {
        written.push(change.path);
        continue;
      }
      if (change.dstMode === "160000") continue; // a submodule's commit: nothing to write
      mkdirSync(dirname(path), { recursive: true });
      const bytes = await this.o.git.blob(change.dstBlob);
      if (change.dstMode === "120000") symlinkSync(bytes.toString("utf8"), path);
      else {
        writeFileSync(path, bytes);
        if (process.platform !== "win32") chmodSync(path, change.dstMode === "100755" ? 0o755 : 0o644);
      }
      written.push(change.path);
    }
    return written;
  }

  /** Records what the workspace is after the result went in, so undo can tell whether it changed since. */
  async recordApplied(message: string): Promise<Snapshot> {
    return this.o.git.snapshot(this.o.exclude, this.refs.applied, message);
  }

  /**
   * The workspace as it was before the result was written into it. Refused when it changed since (your edits would be
   * lost): the files are named instead.
   */
  async undo(message: string): Promise<{ restored: string[] } | { problem: string }> {
    const backup = await this.read(this.refs.backup);
    const applied = await this.read(this.refs.applied);
    if (!backup || !applied) return { problem: "this team run's result was never written into the workspace" };
    const now = await this.o.git.worktreeTree(this.o.exclude);
    if (now !== applied.tree) {
      const changed = (await this.o.git.rawChanges(applied.tree, now)).map((c) => c.path);
      return { problem: `the workspace changed since the result was written into it (${changed.slice(0, 10).join(", ")}${changed.length > 10 ? ", …" : ""})` };
    }
    const restored = await this.write(applied.tree, backup.tree);
    await this.o.git.snapshot(this.o.exclude, this.refs.applied, message);
    return { restored };
  }

  /** Every member's worktree removed (the refs stay). */
  async remove(): Promise<void> {
    await this.adding;
    if (existsSync(this.o.root)) {
      for (const wt of listDirs(this.o.root)) await this.o.git.run(["worktree", "remove", "--force", wt], { check: false });
    }
    rmSync(this.o.root, { recursive: true, force: true });
    await this.o.git.run(["worktree", "prune"], { check: false });
  }
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "agentduo", GIT_AUTHOR_EMAIL: "agentduo@localhost",
  GIT_COMMITTER_NAME: "agentduo", GIT_COMMITTER_EMAIL: "agentduo@localhost",
};

function listDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => resolve(root, d.name));
  } catch {
    return [];
  }
}
