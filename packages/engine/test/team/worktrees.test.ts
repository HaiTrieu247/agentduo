import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Git } from "../../src/git/git.js";
import { prepareRunGit } from "../../src/git/run-git.js";
import { TeamGit } from "../../src/team/worktrees.js";
import { userDataEnv } from "../helpers/config.js";
import { git, makeRepo } from "../helpers/repo.js";
import { tempDir } from "../helpers/tmp.js";

let t: { path: string; cleanup(): void };
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

const read = (path: string) => readFileSync(path, "utf8");

function team(workspace: string, over: Partial<ConstructorParameters<typeof TeamGit>[0]> = {}, repoGit = new Git(workspace)): TeamGit {
  return new TeamGit({
    git: repoGit, workspace, runId: "r1", root: join(t.path, "data", "teams", "r1"), exclude: [".agentduo/runs"], setup: [], link: [], ...over,
  });
}

/** A member's turn: it edits files in its worktree, and the worktree is snapshotted onto the task's ref. */
async function work(tg: TeamGit, member: string, task: string, files: Record<string, string>, start?: string) {
  const cwd = await tg.checkout(member, start ?? await tg.integrationHead());
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(cwd, path, ".."), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  return tg.snapshot(member, tg.refs.task(task, member), `${task} by ${member}`);
}

describe("a team's worktrees", () => {
  it("start from the workspace as it is, uncommitted and untracked files included, without the runs folder", async () => {
    const repo = makeRepo(t.path);
    writeFileSync(join(repo, "README.md"), "edited, not committed\n");
    writeFileSync(join(repo, "new.txt"), "untracked\n");
    mkdirSync(join(repo, ".agentduo", "runs"), { recursive: true });
    writeFileSync(join(repo, ".agentduo", "runs", "state.json"), "{}");
    const tg = team(repo);
    const base = await tg.createBase("base");
    expect(await tg.integrationHead()).toBe(base.commit);
    const cwd = await tg.checkout("dev-1", base.commit);
    expect(read(join(cwd, "README.md"))).toBe("edited, not committed\n");
    expect(read(join(cwd, "new.txt"))).toBe("untracked\n");
    expect(existsSync(join(cwd, ".agentduo", "runs"))).toBe(false);
    // Nothing in the workspace changed, and its branch and index are its own.
    expect(git(repo, "status", "--porcelain")).toContain("README.md");
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("snapshot a member's work onto its task's ref, as a child of the commit it started from", async () => {
    const repo = makeRepo(t.path);
    const tg = team(repo);
    const base = await tg.createBase("base");
    const snap = await work(tg, "dev-1", "T1", { "src/a.ts": "export const a = 1;\n" });
    expect(git(repo, "rev-parse", `${snap.commit}^`)).toBe(base.commit);
    expect(git(repo, "show", `${tg.refs.task("T1", "dev-1")}:src/a.ts`)).toBe("export const a = 1;");
    // The next checkout starts clean: what the member left is gone.
    const cwd = await tg.checkout("dev-1", base.commit);
    expect(existsSync(join(cwd, "src", "a.ts"))).toBe(false);
  });

  it("merge code and tests into a candidate, and candidates into the integration branch", async () => {
    const repo = makeRepo(t.path);
    const tg = team(repo);
    await tg.createBase("base");
    const code = await work(tg, "dev-1", "T1", { "src/a.ts": "a\n" });
    const tests = await work(tg, "qa-1", "T1", { "test/a.test.ts": "test a\n" });
    const other = await work(tg, "dev-2", "T2", { "src/b.ts": "b\n" });
    const candidate = await tg.merge([code.commit, tests.commit], "T1 candidate");
    expect("commit" in candidate).toBe(true);
    const c = (candidate as { commit: string }).commit;
    expect(git(repo, "show", `${c}:src/a.ts`)).toBe("a");
    expect(git(repo, "show", `${c}:test/a.test.ts`)).toBe("test a");
    const first = await tg.mergeIntoIntegration(c, "merge T1");
    expect("head" in first).toBe(true);
    // T2 started from the old head: the merge still takes both.
    const second = await tg.mergeIntoIntegration(other.commit, "merge T2");
    expect("head" in second).toBe(true);
    const head = await tg.integrationHead();
    expect(git(repo, "show", `${head}:src/a.ts`)).toBe("a");
    expect(git(repo, "show", `${head}:src/b.ts`)).toBe("b");
  });

  it("name the files of a merge conflict, change nothing, and let a member resolve it", async () => {
    const repo = makeRepo(t.path);
    const tg = team(repo);
    await tg.createBase("base");
    const one = await work(tg, "dev-1", "T1", { "README.md": "one\n" });
    const two = await work(tg, "dev-2", "T2", { "README.md": "two\n" });
    await tg.mergeIntoIntegration(one.commit, "merge T1");
    const head = await tg.integrationHead();
    expect(await tg.mergeIntoIntegration(two.commit, "merge T2")).toEqual({ conflicts: ["README.md"] });
    expect(await tg.integrationHead()).toBe(head);
    expect(await tg.startResolve("techlead", two.commit)).toEqual(["README.md"]);
    const cwd = await tg.cwd("techlead");
    expect(read(join(cwd, "README.md"))).toContain("<<<<<<<");
    expect(await tg.finishResolve("techlead", two.commit, head, "resolve")).toEqual({ problem: "conflict markers are still in README.md" });
    writeFileSync(join(cwd, "README.md"), "one and two\n");
    const done = await tg.finishResolve("techlead", two.commit, head, "resolve");
    expect("head" in done).toBe(true);
    const merged = await tg.integrationHead();
    expect(git(repo, "show", `${merged}:README.md`)).toBe("one and two");
    expect(git(repo, "rev-list", "--parents", "-n", "1", merged).split(" ")).toEqual([merged, head, two.commit]);
  });

  it("write the result into an unchanged workspace, keep a backup, and undo it", async () => {
    const repo = makeRepo(t.path);
    writeFileSync(join(repo, "gone.txt"), "to delete\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "more");
    const tg = team(repo);
    await tg.createBase("base");
    const cwd = await tg.checkout("dev-1", await tg.integrationHead());
    writeFileSync(join(cwd, "README.md"), "changed by the team\n");
    writeFileSync(join(cwd, "run.sh"), "#!/bin/sh\necho hi\n");
    chmodSync(join(cwd, "run.sh"), 0o755);
    (await import("node:fs")).rmSync(join(cwd, "gone.txt"));
    const snap = await tg.snapshot("dev-1", tg.refs.task("T1", "dev-1"), "T1");
    await tg.mergeIntoIntegration(snap.commit, "merge T1");
    const plan = await tg.planApply(await tg.integrationHead(), "apply");
    expect(plan.kind).toBe("direct");
    const written = await tg.write(plan.current.tree, plan.kind === "conflicts" ? "" : plan.tree);
    expect(written.sort()).toEqual(["README.md", "gone.txt", "run.sh"]);
    expect(read(join(repo, "README.md"))).toBe("changed by the team\n");
    expect(existsSync(join(repo, "gone.txt"))).toBe(false);
    if (process.platform !== "win32") expect(statSync(join(repo, "run.sh")).mode & 0o111).not.toBe(0);
    // Nothing committed, the index untouched.
    expect(git(repo, "log", "--oneline").split("\n")).toHaveLength(2);
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
    await tg.recordApplied("applied");
    expect(await tg.undo("undone")).toEqual({ restored: expect.arrayContaining(["README.md", "gone.txt", "run.sh"]) });
    expect(read(join(repo, "README.md"))).toBe("demo\n");
    expect(read(join(repo, "gone.txt"))).toBe("to delete\n");
    expect(existsSync(join(repo, "run.sh"))).toBe(false);
  });

  it("merge with what you changed meanwhile, or name the conflicts; undo refuses once you edited the result", async () => {
    const repo = makeRepo(t.path);
    writeFileSync(join(repo, "notes.md"), "mine\n");
    const tg = team(repo);
    await tg.createBase("base");
    const snap = await work(tg, "dev-1", "T1", { "README.md": "team\n" });
    await tg.mergeIntoIntegration(snap.commit, "merge T1");
    const final = await tg.integrationHead();
    writeFileSync(join(repo, "notes.md"), "mine, edited while the team worked\n");
    const plan = await tg.planApply(final, "apply");
    expect(plan.kind).toBe("merged");
    if (plan.kind !== "merged") return;
    await tg.write(plan.current.tree, plan.tree);
    expect(read(join(repo, "README.md"))).toBe("team\n");
    expect(read(join(repo, "notes.md"))).toBe("mine, edited while the team worked\n");
    await tg.recordApplied("applied");
    writeFileSync(join(repo, "README.md"), "edited after\n");
    expect(await tg.undo("undo")).toEqual({ problem: expect.stringContaining("README.md") });
    writeFileSync(join(repo, "README.md"), "yours\n");
    expect(await tg.planApply(final, "apply again")).toMatchObject({ kind: "conflicts", files: ["README.md"] });
  });

  it("see a change of the same size made in the second of the checkout, however late the snapshot", async () => {
    const repo = makeRepo(t.path);
    const tg = team(repo);
    const base = await tg.createBase("base");
    // Start at the beginning of a second, so the checkout and the edit share it; snapshot in a later one.
    await new Promise((r) => setTimeout(r, 1000 - (Date.now() % 1000) + 20));
    const cwd = await tg.checkout("dev-1", base.commit);
    writeFileSync(join(cwd, "README.md"), "team\n"); // as long as "demo\n"
    await new Promise((r) => setTimeout(r, 1100));
    const snap = await tg.snapshot("dev-1", tg.refs.task("T1", "dev-1"), "T1");
    expect(git(repo, "show", `${snap.commit}:README.md`)).toBe("team");
  });

  it("link the workspace's shared folders and Claude's settings, never snapshot them, and run setup once", async () => {
    const repo = makeRepo(t.path);
    writeFileSync(join(repo, ".gitignore"), ".agentduo/runs/\nnode_modules/\n.claude/settings.local.json\n");
    mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "dep", "index.js"), "1");
    mkdirSync(join(repo, ".claude"));
    writeFileSync(join(repo, ".claude", "settings.local.json"), "{}");
    const setups: string[] = [];
    const tg = team(repo, { link: ["node_modules"], setup: [`"${process.execPath}" -e "require('fs').writeFileSync('setup.txt','ok')"`], onSetup: (m, c, ok) => setups.push(`${m}:${ok}`) });
    const base = await tg.createBase("base");
    const cwd = await tg.checkout("dev-1", base.commit);
    expect(lstatSync(join(cwd, "node_modules")).isSymbolicLink()).toBe(true);
    expect(read(join(cwd, "node_modules", "dep", "index.js"))).toBe("1");
    expect(lstatSync(join(cwd, ".claude", "settings.local.json")).isSymbolicLink()).toBe(true);
    expect(setups).toEqual(["dev-1:true"]);
    writeFileSync(join(cwd, "a.txt"), "a");
    const snap = await tg.snapshot("dev-1", tg.refs.task("T1", "dev-1"), "T1");
    const files = git(repo, "ls-tree", "-r", "--name-only", snap.commit).split("\n");
    expect(files).toContain("a.txt");
    expect(files).not.toContain("node_modules");
    expect(files.some((f) => f.startsWith(".claude"))).toBe(false);
    await tg.checkout("dev-1", base.commit);
    expect(setups).toEqual(["dev-1:true"]);
    expect(lstatSync(join(cwd, "node_modules")).isSymbolicLink()).toBe(true);
    await tg.remove();
    expect(existsSync(tg.worktree("dev-1"))).toBe(false);
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("work in a subfolder workspace: members work in the worktree's copy of it", async () => {
    const repo = makeRepo(t.path);
    mkdirSync(join(repo, "pkg"));
    writeFileSync(join(repo, "pkg", "x.txt"), "x\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "pkg");
    const ws = join(repo, "pkg");
    const tg = team(ws);
    await tg.createBase("base");
    const cwd = await tg.checkout("dev-1", await tg.integrationHead());
    expect(cwd).toBe(join(tg.worktree("dev-1"), "pkg"));
    writeFileSync(join(cwd, "x.txt"), "x by the team\n");
    const snap = await tg.snapshot("dev-1", tg.refs.task("T1", "dev-1"), "T1");
    await tg.mergeIntoIntegration(snap.commit, "merge");
    const plan = await tg.planApply(await tg.integrationHead(), "apply");
    expect(plan.kind).toBe("direct");
    if (plan.kind === "conflicts") return;
    expect(await tg.write(plan.current.tree, plan.tree)).toEqual(["x.txt"]);
    expect(read(join(ws, "x.txt"))).toBe("x by the team\n");
  });

  it("work in a folder with no git repository, through agentduo's own", async () => {
    const ws = join(t.path, "plain");
    mkdirSync(ws);
    writeFileSync(join(ws, "a.txt"), "a\n");
    const env = { ...process.env, ...userDataEnv(join(t.path, "data")) };
    const owner = { taskId: "team-r1", git: undefined, base: null, lastSnapshot: null };
    const { git: runGit } = await prepareRunGit(owner, ws, env);
    const tg = team(ws, {}, runGit);
    await tg.createBase("base");
    const snap = await work(tg, "dev-1", "T1", { "a.txt": "a by the team\n", "b.txt": "b\n" });
    await tg.mergeIntoIntegration(snap.commit, "merge");
    const plan = await tg.planApply(await tg.integrationHead(), "apply");
    expect(plan.kind).toBe("direct");
    if (plan.kind === "conflicts") return;
    expect((await tg.write(plan.current.tree, plan.tree)).sort()).toEqual(["a.txt", "b.txt"]);
    expect(read(join(ws, "a.txt"))).toBe("a by the team\n");
    expect(existsSync(join(ws, ".git"))).toBe(false);
  });
});
