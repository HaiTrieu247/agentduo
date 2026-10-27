import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Git } from "../src/core/git.js";
import { git, makeRepo } from "./helpers/repo.js";
import { tempDir } from "./helpers/tmp.js";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (dirs.length) dirs.pop()!.cleanup();
});
function newRepo(ignoreRuns = true) {
  const t = tempDir();
  dirs.push(t);
  return { tmp: t.path, repo: makeRepo(t.path, { ignoreRuns }) };
}
const EXCLUDE = [".agentduo/runs"];

describe("Git", () => {
  for (const ignoreRuns of [true, false]) {
    it(`snapshots the whole worktree without touching index or HEAD (runs ignored: ${ignoreRuns})`, async () => {
      const { repo } = newRepo(ignoreRuns);
      const g = new Git(repo);
      const head = await g.head();
      const index = readFileSync(join(repo, ".git", "index"));
      const base = await g.snapshot(EXCLUDE);
      writeFileSync(join(repo, "new.txt"), "n\n");
      rmSync(join(repo, "README.md"));
      mkdirSync(join(repo, ".agentduo", "runs"), { recursive: true });
      writeFileSync(join(repo, ".agentduo", "runs", "log.txt"), "excluded\n");
      const snap = await g.snapshot(EXCLUDE, "refs/agentduo/t/r1");
      expect((await g.nameStatus(base.tree, snap.tree)).sort()).toEqual([["A", "new.txt"], ["D", "README.md"]]);
      expect(await g.worktreeTree(EXCLUDE)).toBe(snap.tree);
      expect(await g.head()).toBe(head);
      expect(readFileSync(join(repo, ".git", "index")).equals(index)).toBe(true);
      expect(git(repo, "rev-parse", "refs/agentduo/t/r1")).toBe(snap.commit);
      expect(await g.diffStat(base.commit, snap.commit)).toContain("new.txt");
      expect(await g.diff(base.commit, snap.commit)).toContain("+n");
    });
  }

  it("reports non-ASCII paths unquoted", async () => {
    const { repo } = newRepo();
    const g = new Git(repo);
    const before = await g.worktreeTree();
    writeFileSync(join(repo, "tệp.txt"), "x\n");
    expect(await g.nameStatus(before, await g.worktreeTree())).toEqual([["A", "tệp.txt"]]);
  });

  it("keeps names with tabs and quotes intact", async () => {
    const { repo } = newRepo();
    const g = new Git(repo);
    const before = await g.worktreeTree();
    writeFileSync(join(repo, "a\tb.txt"), "x\n");
    writeFileSync(join(repo, 'q"x.txt'), "y\n");
    expect((await g.nameStatus(before, await g.worktreeTree())).sort()).toEqual([["A", "a\tb.txt"], ["A", 'q"x.txt']]);
  });

  it("scopes snapshots and diffs to a workspace subdirectory", async () => {
    const { repo } = newRepo();
    const ws = join(repo, "gói pkg");
    mkdirSync(ws);
    writeFileSync(join(ws, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "ws");
    const g = new Git(ws);
    expect(await g.prefix()).toBe("gói pkg");
    expect(await new Git(repo).prefix()).toBe("");
    const base = await g.snapshot();
    const wholeBefore = await g.worktreeTree([], ":/");
    writeFileSync(join(ws, "a.txt"), "a2\n");
    writeFileSync(join(repo, "outside.txt"), "o\n");
    const snap = await g.snapshot();
    expect(await g.nameStatus(base.tree, snap.tree)).toEqual([["M", "a.txt"]]);
    expect(await g.diffStat(base.commit, snap.commit)).toContain("a.txt");
    expect(await g.diff(base.commit, snap.commit)).not.toContain("outside.txt");
    const wholeAfter = await g.worktreeTree([], ":/");
    expect(await g.outsideChanges(wholeBefore, wholeAfter)).toEqual([["A", "outside.txt"]]);
  });

  it("knows HEAD, branch and whether a path is a repo or ignored", async () => {
    const { tmp, repo } = newRepo();
    const g = new Git(repo);
    expect(await g.isRepo()).toBe(true);
    expect(await g.toplevel()).toBe(repo);
    expect([await g.head(), await g.branch()]).toEqual([git(repo, "rev-parse", "HEAD"), "main"]);
    expect(await g.isIgnored(".agentduo/runs")).toBe(true);
    expect(await g.isIgnored("src")).toBe(false);
    expect(await new Git(tmp).isRepo()).toBe(false);
    expect(await new Git(join(tmp, "missing")).isRepo()).toBe(false);
  });
});
