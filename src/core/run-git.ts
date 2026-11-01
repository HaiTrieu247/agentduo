import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalPath, dataRoot, isHomeFolder, isWithin } from "../paths.js";
import { Git, GitError, gitOutside } from "./git.js";
import { atomicWrite, type RunGit, type RunState } from "./state.js";

/**
 * A run's snapshots cannot be set up or opened: Git is missing, the folder cannot have an internal repository, or the
 * one recorded is gone or is not the run's. The run is left as it was, to resume once the cause is fixed.
 */
export class RunGitError extends Error {
  override name = "RunGitError";
}

export const GIT_MISSING = "Git is not installed (or not on PATH): a pipeline run needs it to snapshot and diff the workspace. " +
  "Install Git, then try again; questions and /discuss work without it.";

/** Beside an internal repository's own files: who it belongs to, checked before any git command runs in it. */
export const MARKER = "agentduo-repository.json";

/** Settings of an internal repository: its bytes as they are, no hooks, no fsmonitor, no automatic gc. */
const INTERNAL_CONFIG = (gitDir: string): Array<[string, string]> => [
  ["core.autocrlf", "false"], ["core.fsmonitor", "false"], ["gc.auto", "0"], ["core.hooksPath", join(gitDir, "hooks")],
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What a new run in a workspace would keep its snapshots in, or why a run cannot start there. */
export type SnapshotPreflight =
  | { mode: "native" }
  | { mode: "internal"; repositories: string }
  | { mode: null; problem: { kind: "git" | "not_repo"; message: string } };

/** Where internal repositories go: <data root>/repositories; null when there is no data root (Windows without its variables). */
export function repositoriesRoot(env: NodeJS.ProcessEnv): string | null {
  const root = dataRoot(env);
  return root ? join(root, "repositories") : null;
}

type Discovery = "repo" | "none" | "missing" | { error: string };

/** Whether `workspace` is in a git repository, as git finds one from there (what native snapshots use). */
function discover(workspace: string, env: NodeJS.ProcessEnv): Promise<Discovery> {
  return new Promise((resolvePromise) => {
    execFile("git", ["rev-parse", "--is-inside-work-tree"], { cwd: workspace, env, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && typeof error.code === "string") {
        resolvePromise(error.code === "ENOENT" ? "missing" : { error: `cannot run git in ${workspace}: ${error.message}` });
      } else if (!error) {
        resolvePromise(stdout.trim() === "true" ? "repo" : { error: `${workspace} is inside a git directory, not in a working tree` });
      } else if (/not a git repository/i.test(stderr)) {
        resolvePromise("none");
      } else {
        // Not "no repository": a repository git cannot use (dubious ownership, damage). An internal one would hide it.
        resolvePromise({ error: `git cannot use the repository of ${workspace}: ${(stderr || stdout).trim()}` });
      }
    });
  });
}

/** Why agentduo cannot create repositories under `root`, or null when it can (as far as looking tells). */
function unusable(root: string): string | null {
  let dir = resolve(root);
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return "no folder of it exists";
    dir = parent;
  }
  if (!statSync(dir).isDirectory()) return `${dir} is not a folder`;
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    return `${dir} is not writable`;
  }
  return null;
}

const refused = (kind: "git" | "not_repo", message: string): SnapshotPreflight => ({ mode: null, problem: { kind, message } });

/**
 * Where a new run in `workspace` would keep its snapshots, without writing anything: its git repository, or an
 * internal one under agentduo's data root. Refused: no Git; a repository git cannot use; the home folder (a pipeline
 * belongs in a project folder); a data root inside the workspace (the snapshots would hold themselves).
 */
export async function preflightSnapshots(workspace: string, env: NodeJS.ProcessEnv): Promise<SnapshotPreflight> {
  const found = await discover(workspace, env);
  if (found === "missing") return refused("git", GIT_MISSING);
  if (found === "repo") return { mode: "native" };
  if (typeof found === "object") return refused("git", found.error);
  if (isHomeFolder(workspace, env)) {
    return refused("not_repo", `${workspace} is your home folder: run the pipeline from a project folder (it needs no git repository)`);
  }
  const root = repositoriesRoot(env);
  if (!root) return refused("git", "neither LOCALAPPDATA nor APPDATA is set, so agentduo has no place to keep the snapshots of a folder with no git repository");
  if (isWithin(root, workspace)) {
    return refused("git", `agentduo keeps the snapshots of a folder with no git repository in ${root}, which is inside ${workspace}: ` +
      "run the pipeline from a project folder (or set XDG_DATA_HOME, LOCALAPPDATA on Windows, to a folder outside it)");
  }
  const why = unusable(root);
  if (why) return refused("git", `agentduo cannot keep snapshots in ${root}: ${why}`);
  return { mode: "internal", repositories: root };
}

/** What a run says when its snapshots go to an internal repository. */
export function internalNotice(meta: Extract<RunGit, { mode: "internal" }>): string {
  return `This run keeps its snapshots in agentduo's own Git repository, ${meta.gitDir}, outside the workspace (no .git is created in it).`;
}

interface Marker {
  repositoryId: string;
  taskId: string;
  workspace: string;
}

/** A new internal repository for the run, created whole before anything names it. */
async function createInternal(state: RunState, workspace: string, root: string): Promise<Extract<RunGit, { mode: "internal" }>> {
  const repositoryId = randomUUID();
  const gitDir = join(root, `${repositoryId}.git`);
  try {
    mkdirSync(root, { recursive: true });
    await gitOutside(["init", "--bare", "--template=", "-q", gitDir], root);
    for (const [key, value] of INTERNAL_CONFIG(gitDir)) await gitOutside([`--git-dir=${gitDir}`, "config", key, value], root);
    const marker: Marker = { repositoryId, taskId: state.taskId, workspace: canonicalPath(workspace) };
    atomicWrite(join(gitDir, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
  } catch (e) {
    rmSync(gitDir, { recursive: true, force: true });
    throw new RunGitError(`cannot create the snapshot repository ${gitDir}: ${(e as Error).message}`);
  }
  return { mode: "internal", repositoryId, workspace: resolve(workspace), gitDir };
}

/**
 * The run's internal repository, after checking it is the one agentduo made for this run and workspace: where its id
 * says it is under the data root (whatever `gitDir` the state names), outside the workspace, a bare repository, with
 * a marker naming the run, its workspace and the id. Nothing runs in it before that.
 */
function openInternal(meta: Extract<RunGit, { mode: "internal" }>, state: RunState, workspace: string, env: NodeJS.ProcessEnv): Git {
  const id = meta.repositoryId;
  const bad = (why: string) => new RunGitError(`run ${state.taskId} cannot use its snapshot repository ${meta.gitDir}: ${why}`);
  if (typeof id !== "string" || !UUID.test(id)) throw bad("the run names no valid repository id");
  const root = repositoriesRoot(env);
  if (!root) throw bad("neither LOCALAPPDATA nor APPDATA is set, so agentduo cannot tell where its repositories are");
  const gitDir = join(root, `${id}.git`);
  if (typeof meta.gitDir !== "string" || canonicalPath(meta.gitDir) !== canonicalPath(gitDir)) throw bad(`agentduo keeps that repository in ${gitDir}`);
  if (typeof meta.workspace !== "string" || canonicalPath(meta.workspace) !== canonicalPath(workspace)) throw bad(`it belongs to the workspace ${meta.workspace}`);
  if (isWithin(gitDir, workspace)) throw bad("it is inside the workspace");
  let stat;
  try {
    stat = lstatSync(gitDir);
  } catch {
    throw bad("it is missing (deleted or moved); the run cannot go on without its snapshots. Abort it, or start a new run");
  }
  if (!stat.isDirectory()) throw bad("it is not a folder");
  if (!["HEAD", "config", "objects"].every((name) => existsSync(join(gitDir, name)))) throw bad("it is not a git repository");
  let marker: Partial<Marker>;
  try {
    marker = JSON.parse(readFileSync(join(gitDir, MARKER), "utf8")) as Partial<Marker>;
  } catch {
    throw bad(`it has no readable ${MARKER}`);
  }
  if (marker.repositoryId !== id || marker.taskId !== state.taskId || typeof marker.workspace !== "string" || canonicalPath(marker.workspace) !== canonicalPath(workspace)) {
    throw bad(`its ${MARKER} names another run or workspace`);
  }
  return new Git(resolve(workspace), { gitDir });
}

/**
 * The snapshots a run refers to are whole in its internal repository: the state's commits and those its refs keep (a
 * round re-run starts from one), with every tree and file in them. A diff would fail on a missing one only later.
 */
async function checkSnapshots(git: Git, state: RunState): Promise<void> {
  const where = git.internal?.gitDir ?? git.dir;
  const commits = [state.base, state.lastSnapshot].flatMap((snap) => (snap ? [snap.commit] : []));
  for (const commit of commits) {
    const found = await git.run(["cat-file", "-e", `${commit}^{commit}`], { check: false });
    if (found.code !== 0) throw new RunGitError(`snapshot ${commit.slice(0, 12)} of run ${state.taskId} is missing from ${where}`);
  }
  // Internal snapshots have no parent, so this reads each one's tree and nothing more.
  const whole = await git.run(["rev-list", "--objects", "--quiet", "--all", ...commits, "--"], { check: false });
  if (whole.code !== 0) {
    const why = whole.stderr.trim().split("\n").at(-1)?.replace(/^fatal: /, "") || `git rev-list exited with ${whole.code}`;
    throw new RunGitError(`the snapshots of run ${state.taskId} in ${where} are damaged (${why}); the run cannot go on without them. Abort it, or start a new run`);
  }
}

/**
 * Workflow.prepare: where the run keeps its snapshots, set up the first time (the caller records `meta` in the state
 * before any agent runs). A run that recorded one keeps it, whatever the workspace looks like now; an older run with
 * snapshots and no record is native, as every run was then. Throws RunGitError, having changed nothing the run uses.
 */
export async function prepareRunGit(state: RunState, workspace: string, env: NodeJS.ProcessEnv): Promise<{ git: Git; meta: RunGit }> {
  let meta = state.git;
  try {
    if (!meta && (state.base || state.lastSnapshot)) meta = { mode: "native" };
    if (!meta) {
      const plan = await preflightSnapshots(workspace, env);
      if (plan.mode === null) throw new RunGitError(plan.problem.message);
      meta = plan.mode === "native" ? { mode: "native" } : await createInternal(state, workspace, plan.repositories);
    } else if (meta.mode === "native") {
      const found = await discover(workspace, env);
      if (found === "missing") throw new RunGitError(GIT_MISSING);
      if (found === "none") throw new RunGitError(`run ${state.taskId} keeps its snapshots in the git repository of ${workspace}, and the folder is not in one any more`);
      if (typeof found === "object") throw new RunGitError(found.error);
    }
    const git = meta.mode === "internal" ? openInternal(meta, state, workspace, env) : new Git(workspace);
    if (meta.mode === "internal") await checkSnapshots(git, state);
    return { git, meta };
  } catch (e) {
    if (e instanceof GitError) throw new RunGitError(/cannot run git/.test(e.message) ? GIT_MISSING : e.message);
    throw e;
  }
}

/**
 * The Git a run's snapshots are read from (Changes, /diff, the report's diff stat): the internal repository it
 * recorded, checked, or the workspace's. Creates and records nothing, and never falls back to another repository.
 */
export function openRunGit(state: RunState, workspace: string, env: NodeJS.ProcessEnv): Git {
  return state.git?.mode === "internal" ? openInternal(state.git, state, workspace, env) : new Git(workspace);
}
