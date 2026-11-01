import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GIT_MISSING, MARKER, openRunGit, preflightSnapshots, prepareRunGit, RunGitError } from "../src/core/run-git.js";
import { newState, type RunGit, type RunState } from "../src/core/state.js";
import { canonicalPath } from "../src/paths.js";
import { userDataEnv } from "./helpers/config.js";
import { git, makeRepo } from "./helpers/repo.js";
import { tempDir } from "./helpers/tmp.js";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (dirs.length) dirs.pop()!.cleanup();
});

const LIMITS = { max_planning_rounds: 3, max_review_rounds: 3 };

function setup() {
  const t = tempDir();
  dirs.push(t);
  const ws = join(t.path, "plain project");
  mkdirSync(ws);
  writeFileSync(join(ws, "a.txt"), "a\n");
  const data = join(t.path, "data");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(t.path, "home"), ...userDataEnv(data) };
  return { tmp: t.path, ws, data, env, repositories: join(data, "agentduo", "repositories") };
}

const state = (taskId = "20261101-000000-task"): RunState => newState(taskId, "task", LIMITS);
const internal = (st: RunState) => st.git as Extract<RunGit, { mode: "internal" }>;

/** `env` with a PATH that has no git on it. */
function withoutGit(env: NodeJS.ProcessEnv, tmp: string): NodeJS.ProcessEnv {
  const empty = join(tmp, "no-git-bin");
  mkdirSync(empty, { recursive: true });
  return { ...Object.fromEntries(Object.entries(env).filter(([k]) => k.toUpperCase() !== "PATH")), PATH: empty };
}

/** A run whose internal repository prepareRunGit created, as Workflow.prepare records it. */
async function prepared(ws: string, env: NodeJS.ProcessEnv, taskId?: string): Promise<RunState> {
  const st = state(taskId);
  st.git = (await prepareRunGit(st, ws, env)).meta;
  return st;
}

describe("preflightSnapshots", () => {
  it("chooses the repository the workspace is in, at its root or below, and writes nothing", async () => {
    const { tmp, env, data } = setup();
    const repo = makeRepo(tmp);
    mkdirSync(join(repo, "pkg"));
    expect(await preflightSnapshots(repo, env)).toEqual({ mode: "native" });
    expect(await preflightSnapshots(join(repo, "pkg"), env)).toEqual({ mode: "native" });
    expect(existsSync(data)).toBe(false);
  });

  it("chooses agentduo's own repository for a folder with none, without creating it", async () => {
    const { ws, env, data, repositories } = setup();
    expect(await preflightSnapshots(ws, env)).toEqual({ mode: "internal", repositories });
    expect(existsSync(data)).toBe(false);
    expect(readdirSync(ws)).toEqual(["a.txt"]);
  });

  it("refuses the home folder, a data root inside the workspace, and a machine without Git", async () => {
    const { tmp, ws, env } = setup();
    expect(await preflightSnapshots(ws, { ...env, HOME: ws })).toEqual({
      mode: null, problem: { kind: "not_repo", message: `${ws} is your home folder: run the pipeline from a project folder (it needs no git repository)` },
    });
    // "..data" is a folder's name, inside the workspace like any other.
    for (const inside of [ws, join(ws, "data"), join(ws, "..data")]) {
      expect(await preflightSnapshots(ws, { ...env, ...userDataEnv(inside) })).toMatchObject({ mode: null, problem: { kind: "git", message: expect.stringContaining(`which is inside ${ws}`) } });
    }
    expect(await preflightSnapshots(ws, withoutGit(env, tmp))).toEqual({ mode: null, problem: { kind: "git", message: GIT_MISSING } });
    expect(readdirSync(ws)).toEqual(["a.txt"]);
  });

  it.skipIf(process.platform === "win32")("sees a data root inside the workspace through a symlink", async () => {
    const { tmp, ws, env } = setup();
    mkdirSync(join(ws, "real data"));
    symlinkSync(join(ws, "real data"), join(tmp, "data link"));
    expect(await preflightSnapshots(ws, { ...env, ...userDataEnv(join(tmp, "data link")) })).toMatchObject({ mode: null, problem: { kind: "git" } });
  });

  it("refuses a data root it cannot write to", async () => {
    const { tmp, ws, env } = setup();
    writeFileSync(join(tmp, "a file"), "x");
    expect(await preflightSnapshots(ws, { ...env, ...userDataEnv(join(tmp, "a file")) })).toMatchObject({
      mode: null, problem: { kind: "git", message: expect.stringContaining("is not a folder") },
    });
  });
});

describe("prepareRunGit and openRunGit", () => {
  it("creates the run's own bare repository under the data root, named by a fresh id and marked with the run", async () => {
    const { ws, env, repositories } = setup();
    const st = await prepared(ws, env);
    const meta = internal(st);
    expect(meta.repositoryId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect([meta.gitDir, meta.workspace]).toEqual([join(repositories, `${meta.repositoryId}.git`), ws]);
    expect(git(meta.gitDir, "rev-parse", "--is-bare-repository")).toBe("true");
    expect(JSON.parse(readFileSync(join(meta.gitDir, MARKER), "utf8"))).toEqual({ repositoryId: meta.repositoryId, taskId: st.taskId, workspace: canonicalPath(ws) });
    expect(existsSync(join(ws, ".git"))).toBe(false);
    // Opened again as recorded, also once the folder has a repository of its own.
    git(ws, "init", "-q");
    const again = await prepareRunGit(st, ws, env);
    expect([again.meta, again.git.internal?.gitDir]).toEqual([st.git, meta.gitDir]);
    expect(openRunGit(st, ws, env).internal?.gitDir).toBe(meta.gitDir);
    // A second run gets a repository of its own.
    expect(internal(await prepared(join(ws), env, "20261101-000001-other")).gitDir).not.toBe(meta.gitDir);
  });

  it("keeps a native run native, and opens an older run with snapshots and no record as native", async () => {
    const { tmp, env, data } = setup();
    const repo = makeRepo(tmp);
    expect((await prepareRunGit(state(), repo, env)).meta).toEqual({ mode: "native" });
    const old = state();
    old.base = { commit: "a".repeat(40), tree: "b".repeat(40), head: null, branch: null };
    const opened = await prepareRunGit(old, repo, env);
    expect([opened.meta, opened.git.internal]).toEqual([{ mode: "native" }, null]);
    // A native run whose repository went away is not moved to agentduo's own.
    const gone = join(tmp, "plain");
    mkdirSync(gone);
    await expect(prepareRunGit({ ...old, git: { mode: "native" } }, gone, env)).rejects.toThrow("is not in one any more");
    await expect(prepareRunGit(old, gone, env)).rejects.toThrow(RunGitError);
    expect(existsSync(data)).toBe(false);
  });

  it("refuses a recorded repository that is not where agentduo keeps the run's, or not the run's, before running git in it", async () => {
    const { tmp, ws, env } = setup();
    const st = await prepared(ws, env);
    const meta = internal(st);
    const other = await prepared(ws, env, "20261101-000001-other");
    const refuse = (git: Partial<Extract<RunGit, { mode: "internal" }>>, why: string) => {
      const forged = { ...st, git: { ...meta, ...git } };
      expect(() => openRunGit(forged, ws, env)).toThrow(why);
      return expect(prepareRunGit(forged, ws, env)).rejects.toThrow(why);
    };
    // Into the workspace, or another run's repository, or out of the repositories folder.
    mkdirSync(join(ws, "x.git"));
    await refuse({ gitDir: join(ws, "x.git") }, "agentduo keeps that repository in");
    await refuse({ gitDir: internal(other).gitDir }, "agentduo keeps that repository in");
    await refuse({ repositoryId: "../../escape", gitDir: join(tmp, "escape") }, "no valid repository id");
    // The other run's id with its path: the marker names the other run.
    await refuse({ repositoryId: internal(other).repositoryId, gitDir: internal(other).gitDir }, `its ${MARKER} names another run or workspace`);
    await refuse({ workspace: tmp }, `it belongs to the workspace ${tmp}`);
    // Another workspace using this run's state and repository.
    const elsewhere = join(tmp, "elsewhere");
    mkdirSync(elsewhere);
    expect(() => openRunGit(st, elsewhere, env)).toThrow("it belongs to the workspace");
    // A repository without its marker, or one replaced by a plain folder.
    rmSync(join(meta.gitDir, MARKER));
    await refuse({}, `it has no readable ${MARKER}`);
    rmSync(meta.gitDir, { recursive: true });
    mkdirSync(meta.gitDir);
    await refuse({}, "it is not a git repository");
  });

  it("says a missing repository or snapshot is missing, and never stands another in for it", async () => {
    const { tmp, ws, env, repositories } = setup();
    const st = await prepared(ws, env);
    const { git: g } = await prepareRunGit(st, ws, env);
    const snap = await g.snapshot([], "refs/agentduo/t/base");
    st.base = { ...snap, head: null, branch: null };
    st.lastSnapshot = snap;
    expect((await prepareRunGit(st, ws, env)).git.internal?.gitDir).toBe(internal(st).gitDir);
    // A copy of the repository without the snapshot's objects.
    const meta = internal(st);
    const backup = join(tmp, "backup.git");
    cpSync(meta.gitDir, backup, { recursive: true });
    rmSync(join(meta.gitDir, "objects"), { recursive: true });
    mkdirSync(join(meta.gitDir, "objects"));
    await expect(prepareRunGit(st, ws, env)).rejects.toThrow(`snapshot ${snap.commit.slice(0, 12)} of run ${st.taskId} is missing`);
    rmSync(meta.gitDir, { recursive: true });
    git(ws, "init", "-q");
    await expect(prepareRunGit(st, ws, env)).rejects.toThrow("it is missing (deleted or moved)");
    expect(() => openRunGit(st, ws, env)).toThrow("it is missing (deleted or moved)");
    expect(readdirSync(repositories).filter((n) => n !== `${meta.repositoryId}.git`)).toEqual([]);
    // Back where it was, it is the run's again.
    cpSync(backup, meta.gitDir, { recursive: true });
    expect((await prepareRunGit(st, ws, env)).git.internal?.gitDir).toBe(meta.gitDir);
  });

  it("says the snapshots are damaged when a tree or file they hold is missing, their commits being there", async () => {
    const { ws, env } = setup();
    mkdirSync(join(ws, "src"));
    writeFileSync(join(ws, "src", "b.txt"), "b\n");
    const st = await prepared(ws, env);
    const { git: g } = await prepareRunGit(st, ws, env);
    const snap = await g.snapshot([], `refs/agentduo/${st.taskId}/base`);
    st.base = { ...snap, head: null, branch: null };
    st.lastSnapshot = snap;
    // A round's starting point, which only a ref keeps.
    writeFileSync(join(ws, "new.txt"), "new\n");
    const pre = await g.snapshot([], `refs/agentduo/${st.taskId}/impl-r1-pre`);
    const { gitDir } = internal(st);
    const damaged = `the snapshots of run ${st.taskId} in ${gitDir} are damaged`;
    for (const spec of [`${snap.commit}:src/b.txt`, `${snap.commit}:src`, snap.tree, `${pre.commit}:new.txt`]) {
      // Snapshot objects are loose: no gc runs in an internal repository.
      const oid = git(gitDir, "rev-parse", spec);
      const file = join(gitDir, "objects", oid.slice(0, 2), oid.slice(2));
      const bytes = readFileSync(file);
      chmodSync(file, 0o644);
      rmSync(file);
      await expect(prepareRunGit(st, ws, env)).rejects.toThrow(damaged);
      writeFileSync(file, bytes);
    }
    expect((await prepareRunGit(st, ws, env)).git.internal?.gitDir).toBe(gitDir);
  });

  it("refuses to set one up where the preflight would, and says Git is missing", async () => {
    const { tmp, ws, env } = setup();
    await expect(prepareRunGit(state(), ws, { ...env, HOME: ws })).rejects.toThrow("is your home folder");
    await expect(prepareRunGit(state(), ws, withoutGit(env, tmp))).rejects.toThrow(GIT_MISSING);
  });
});
