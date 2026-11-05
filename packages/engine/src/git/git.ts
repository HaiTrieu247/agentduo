import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readdir, rename, rm } from "node:fs/promises";
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

/** A bare repository of agentduo's own that holds a workspace's snapshots (a folder with no git repository). */
export interface InternalRepo {
  gitDir: string;
}

/** Where an internal repository keeps the index its snapshots start from: their stat cache, rebuilt when missing. */
export const INDEX_CACHE = "agentduo-index";

/**
 * Never part of a snapshot: Claude's personal settings, where "Always allow" at a permission prompt saves its rule.
 * Anchored at the repository root (`top`), so it holds for both the workspace and the whole-repository scope.
 */
const ALWAYS_EXCLUDED = [":(exclude,glob,top)**/.claude/settings.local.json"];

const IDENTITY = {
  GIT_AUTHOR_NAME: "agentduo", GIT_AUTHOR_EMAIL: "agentduo@localhost",
  GIT_COMMITTER_NAME: "agentduo", GIT_COMMITTER_EMAIL: "agentduo@localhost",
};

let localVars: Promise<string[]> | undefined;

/**
 * The variables that point git at another repository, index or object store (GIT_DIR, GIT_INDEX_FILE,
 * GIT_OBJECT_DIRECTORY…), as git itself lists them, with every GIT_CONFIG_* override: an internal repository's commands
 * run without them, so nothing inherited (a hook, a wrapper) aims them elsewhere.
 */
async function cleanEnv(base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  localVars ??= new Promise((resolvePromise) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    execFile("git", ["rev-parse", "--local-env-vars"], { env, encoding: "utf8" }, (error, stdout) => {
      resolvePromise(error ? [] : stdout.split("\n").map((v) => v.trim()).filter(Boolean));
    });
  });
  const drop = new Set([...(await localVars), "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR", "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    const name = process.platform === "win32" ? key.toUpperCase() : key;
    if (drop.has(name) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)) continue;
    env[key] = value;
  }
  return env;
}

/** Runs git with no repository of its own (`git init`, a version check), never one an inherited variable names. */
export async function gitOutside(args: string[], cwd: string): Promise<string> {
  const env = await cleanEnv(process.env);
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, { cwd, env, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new GitError(typeof error.code === "string" ? `cannot run git: ${error.message}` : `git ${args.join(" ")} failed: ${(stderr || stdout).trim()}`));
      else resolvePromise(stdout);
    });
  });
}

const zList = (paths: string[]) => paths.map((p) => `${p}\0`).join("");

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
 *
 * With `internal`, the repository is a bare one of agentduo's own, outside the workspace: every command names it and
 * the workspace (--git-dir, --work-tree), without the inherited variables that could point elsewhere. Its snapshots
 * cover the workspace alone, with no HEAD, branch or outside of their own.
 */
export class Git {
  constructor(readonly dir: string, readonly internal: InternalRepo | null = null) {}

  /** The command line and environment of `git <args>` for this workspace. */
  private async invocation(args: string[], extra?: Record<string, string>): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
    if (!this.internal) return { args, env: { ...process.env, ...extra } };
    return { args: [`--git-dir=${this.internal.gitDir}`, `--work-tree=${this.dir}`, ...args], env: { ...(await cleanEnv(process.env)), ...extra } };
  }

  async run(args: string[], opts: { env?: Record<string, string>; check?: boolean; input?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    const call = await this.invocation(args, opts.env);
    return new Promise((resolvePromise, reject) => {
      const child = execFile("git", call.args, { cwd: this.dir, env: call.env, maxBuffer: 512 * 1024 * 1024, encoding: "utf8" },
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
      if (opts.input !== undefined) {
        child.stdin?.on("error", () => undefined); // git may exit before reading it all; its exit code says why
        child.stdin?.end(opts.input);
      }
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

  /** The workspace's path relative to the repository root ("" at the root, and always in an internal repository). */
  async prefix(): Promise<string> {
    if (this.internal) return "";
    return (await this.run(["rev-parse", "--show-prefix"])).stdout.trim().replace(/\/$/, "");
  }

  /** The project's HEAD; an internal repository is no project's, so it has none. */
  async head(): Promise<string | null> {
    if (this.internal) return null;
    return (await this.run(["rev-parse", "--verify", "-q", "HEAD"], { check: false })).stdout.trim() || null;
  }

  async branch(): Promise<string | null> {
    if (this.internal) return null;
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
    if (this.internal) return this.internalTree(this.internal, exclude);
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

  /**
   * An internal repository's tree of the workspace. `git add` of a folder would record a nested repository as a gitlink
   * (or fail on one with no commit), so the files are listed here instead, nested repositories' files as plain files,
   * every `.git` left out, and staged with update-index into a copy of the cached index (whose stat data spares the
   * files that did not change from being hashed again). Ignore rules are the workspace's .gitignore files, by path.
   */
  private async internalTree(repo: InternalRepo, exclude: string[]): Promise<string> {
    const files = await this.listFiles(exclude);
    const cache = join(repo.gitDir, INDEX_CACHE);
    // Beside the cache, so it replaces the cache in one rename once the tree is written.
    const index = join(repo.gitDir, `${INDEX_CACHE}.${process.pid}.${randomUUID()}.tmp`);
    const env = { GIT_INDEX_FILE: index };
    try {
      let gone: string[] = [];
      let seeded = false;
      if (existsSync(cache)) {
        await copyFile(cache, index);
        const listed = await this.run(["ls-files", "-z", "--stage"], { env, check: false });
        if (listed.code === 0) {
          seeded = true;
          // "<mode> <sha> <stage>\t<path>": entries no longer wanted (deleted, now ignored or excluded) and any gitlink go.
          const wanted = new Set(files);
          gone = listed.stdout.split("\0").filter(Boolean).flatMap((line) => {
            const path = line.slice(line.indexOf("\t") + 1);
            return line.startsWith("160000 ") || !wanted.has(path) ? [path] : [];
          });
        }
      }
      // A damaged cache only makes a slower snapshot: start from an empty index.
      if (!seeded) await this.run(["read-tree", "--empty"], { env });
      if (gone.length) await this.run(["update-index", "--force-remove", "-z", "--stdin"], { env, input: zList(gone) });
      if (files.length) await this.run(["update-index", "--add", "--remove", "--replace", "-z", "--stdin"], { env, input: zList(files) });
      const tree = (await this.run(["write-tree"], { env })).stdout.trim();
      await rename(index, cache);
      return tree;
    } finally {
      await rm(index, { force: true });
    }
  }

  /**
   * The workspace's files (and symlinks), as slash-separated paths relative to it: level by level, each level's entries
   * asked of `git check-ignore` at once, so an ignored folder is never entered. `.git` (a folder or a file) is metadata,
   * never content; `exclude` and the always-excluded files are left out as they are in a native snapshot.
   */
  private async listFiles(exclude: string[]): Promise<string[]> {
    const excluded = (path: string) => exclude.some((e) => path === e || path.startsWith(`${e}/`)) || /(^|\/)\.claude\/settings\.local\.json$/.test(path);
    const files: string[] = [];
    let level = [""];
    while (level.length) {
      const entries: Array<{ path: string; dir: boolean }> = [];
      for (const dir of level) {
        let items;
        try {
          items = await readdir(dir ? join(this.dir, ...dir.split("/")) : this.dir, { withFileTypes: true });
        } catch (e) {
          // A folder removed while it is listed has nothing to snapshot; any other error is the snapshot's.
          if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw e;
        }
        for (const item of items) {
          if (item.name === ".git") continue;
          const path = dir ? `${dir}/${item.name}` : item.name;
          if (excluded(path)) continue;
          // A symlink, also one to a folder, is content of its own; it is never followed.
          if (item.isDirectory()) entries.push({ path, dir: true });
          else if (item.isFile() || item.isSymbolicLink()) entries.push({ path, dir: false });
        }
      }
      const ignored = await this.ignored(entries.map((e) => e.path));
      level = [];
      for (const entry of entries) {
        if (ignored.has(entry.path)) continue;
        if (entry.dir) level.push(entry.path);
        else files.push(entry.path);
      }
    }
    return files.sort();
  }

  /** Which of `paths` the workspace's ignore rules ignore; the index plays no part (--no-index). */
  private async ignored(paths: string[]): Promise<Set<string>> {
    if (!paths.length) return new Set();
    const r = await this.run(["check-ignore", "--no-index", "-z", "--stdin"], { input: zList(paths), check: false });
    if (r.code > 1) throw new GitError(`git check-ignore failed: ${r.stderr.trim()}`);
    return new Set(r.stdout.split("\0").filter(Boolean));
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

  /** Changes outside the workspace, with paths relative to it ("../shared/x.ts"); an internal repository has no outside. */
  async outsideChanges(a: string, b: string): Promise<Change[]> {
    if (this.internal) return [];
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
    const call = await this.invocation(["cat-file", "blob", spec]);
    return new Promise((resolvePromise, reject) => {
      execFile("git", call.args, { cwd: this.dir, env: call.env, encoding: "buffer", maxBuffer: 512 * 1024 * 1024 }, (error, stdout, stderr) => {
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
