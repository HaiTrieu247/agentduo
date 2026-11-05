import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Git, INDEX_CACHE } from "../../src/git/git.js";
import { git, makeRepo } from "../helpers/repo.js";
import { tempDir } from "../helpers/tmp.js";

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

  // Windows allows neither a tab nor a " in a file name.
  it.skipIf(process.platform === "win32")("keeps names with tabs and quotes intact", async () => {
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
    expect(await g.outsideChanges(wholeBefore, wholeAfter)).toEqual([["A", "../outside.txt"]]);
  });

  it("snapshots a subdirectory while a path elsewhere in the repository is unmerged", async () => {
    const { repo } = newRepo();
    mkdirSync(join(repo, "pkg"));
    writeFileSync(join(repo, "pkg", "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "pkg");
    git(repo, "checkout", "-q", "-b", "other");
    writeFileSync(join(repo, "README.md"), "other\n");
    git(repo, "commit", "-q", "-am", "other");
    git(repo, "checkout", "-q", "main");
    writeFileSync(join(repo, "README.md"), "main\n");
    git(repo, "commit", "-q", "-am", "main");
    expect(() => git(repo, "merge", "-q", "other")).toThrow();
    expect(git(repo, "ls-files", "-u")).toContain("README.md");
    const g = new Git(join(repo, "pkg"));
    const base = await g.snapshot();
    writeFileSync(join(repo, "pkg", "a.txt"), "a2\n");
    expect(await g.nameStatus(base.tree, (await g.snapshot()).tree)).toEqual([["M", "a.txt"]]);
    expect(git(repo, "ls-files", "-u")).toContain("README.md");
  });

  it("reads a file from a snapshot by its workspace path, without a shell", async () => {
    const { repo } = newRepo();
    const ws = join(repo, "gói pkg");
    mkdirSync(join(ws, "sub dir"), { recursive: true });
    writeFileSync(join(ws, "tệp $(touch pwned).txt"), "unicode\n");
    writeFileSync(join(ws, "sub dir", "bin.dat"), Buffer.from([0, 1, 2, 255]));
    const g = new Git(ws);
    const snap = await g.snapshot();
    expect((await g.readBlob(snap.tree, "tệp $(touch pwned).txt"))?.toString()).toBe("unicode\n");
    expect(await g.readBlob(snap.tree, "sub dir/bin.dat")).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(await g.readBlob(snap.tree, "missing.txt")).toBeNull();
    expect(await g.readBlob(snap.tree, "sub dir")).toBeNull(); // a directory is not a file
    // Snapshot trees cover the whole repository; a workspace path is read below the workspace's prefix.
    expect(await g.readBlob(snap.tree, "README.md")).toBeNull();
    expect((await new Git(repo).readBlob(snap.tree, "README.md"))?.toString()).toBe("demo\n");
    expect(existsSync(join(ws, "pwned"))).toBe(false);
  });

  it("reads snapshots of a repository with no commit yet", async () => {
    const t = tempDir();
    dirs.push(t);
    git(t.path, "init", "-q", "-b", "main");
    writeFileSync(join(t.path, "a.txt"), "a\n");
    const g = new Git(t.path);
    expect(await g.head()).toBeNull();
    const snap = await g.snapshot();
    expect((await g.readBlob(snap.tree, "a.txt"))?.toString()).toBe("a\n");
  });

  it("knows HEAD, branch and whether a path is a repo or ignored", async () => {
    const { tmp, repo } = newRepo();
    const g = new Git(repo);
    expect(await g.isRepo()).toBe(true);
    // Git names it its own way on Windows (C:/Users/runneradmin/… for C:\Users\RUNNER~1\…): the same folder.
    expect(realpathSync.native(await g.toplevel())).toBe(realpathSync.native(repo));
    expect([await g.head(), await g.branch()]).toEqual([git(repo, "rev-parse", "HEAD"), "main"]);
    expect(await g.isIgnored(".agentduo/runs")).toBe(true);
    expect(await g.isIgnored("src")).toBe(false);
    expect(await new Git(tmp).isRepo()).toBe(false);
    expect(await new Git(join(tmp, "missing")).isRepo()).toBe(false);
  });

  it("snapshots a linked worktree, whose refs live in the main repository", async () => {
    const { tmp, repo } = newRepo();
    const wt = join(tmp, "linked wt");
    git(repo, "worktree", "add", "-q", "-b", "feature", wt);
    const g = new Git(wt);
    const base = await g.snapshot(EXCLUDE, "refs/agentduo/t/base");
    writeFileSync(join(wt, "x.txt"), "x\n");
    const snap = await g.snapshot(EXCLUDE);
    expect(await g.nameStatus(base.tree, snap.tree)).toEqual([["A", "x.txt"]]);
    expect(await g.branch()).toBe("feature");
    expect(git(repo, "rev-parse", "refs/agentduo/t/base")).toBe(base.commit);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });
});

/** A folder with no git repository, and a bare repository elsewhere for its snapshots (as agentduo makes for a run). */
function internal() {
  const t = tempDir();
  dirs.push(t);
  const ws = join(t.path, "plain folder");
  mkdirSync(ws);
  const gitDir = join(t.path, "data", "r.git");
  mkdirSync(gitDir, { recursive: true });
  git(gitDir, "init", "--bare", "-q");
  return { tmp: t.path, ws, gitDir, g: new Git(ws, { gitDir }) };
}
const treeEntries = (gitDir: string, tree: string) => git(gitDir, "ls-tree", "-r", "-z", tree).split("\0").filter(Boolean).map((line) => {
  const [meta, path] = line.split("\t");
  return { mode: meta!.split(" ")[0], type: meta!.split(" ")[1], path: path! };
});
const treePaths = (gitDir: string, tree: string) => treeEntries(gitDir, tree).map((e) => e.path).sort();

describe("Git with an internal repository", () => {
  const SPACED = "tệp có dấu cách.txt";

  it("snapshots a folder with no repository: added, changed and deleted files, without writing to it", async () => {
    const { ws, gitDir, g } = internal();
    writeFileSync(join(ws, "README.md"), "demo\n");
    writeFileSync(join(ws, "old.txt"), "old\n");
    writeFileSync(join(ws, SPACED), "before\n");
    const base = await g.snapshot(EXCLUDE, "refs/agentduo/t/base");
    writeFileSync(join(ws, "README.md"), "changed\n");
    rmSync(join(ws, "old.txt"));
    writeFileSync(join(ws, SPACED), "after\n");
    mkdirSync(join(ws, "bin"));
    writeFileSync(join(ws, "bin", "logo.bin"), Buffer.from([0, 1, 2, 255]));
    // Run data and Claude's personal rules are never content, as in a repository.
    mkdirSync(join(ws, ".agentduo", "runs"), { recursive: true });
    writeFileSync(join(ws, ".agentduo", "runs", "log.txt"), "excluded\n");
    mkdirSync(join(ws, ".claude"));
    writeFileSync(join(ws, ".claude", "settings.local.json"), "{}\n");
    const snap = await g.snapshot(EXCLUDE, "refs/agentduo/t/r1");
    expect((await g.nameStatus(base.tree, snap.tree)).sort()).toEqual([["A", "bin/logo.bin"], ["D", "old.txt"], ["M", "README.md"], ["M", SPACED]]);
    expect(await g.worktreeTree(EXCLUDE)).toBe(snap.tree);
    expect(await g.diff(base.commit, snap.commit)).toContain("+changed");
    expect(await g.diffStat(base.commit, snap.commit)).toContain("README.md");
    expect((await g.readBlob(snap.tree, SPACED))?.toString()).toBe("after\n");
    expect(await g.readBlob(snap.tree, "bin/logo.bin")).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(await g.readBlob(base.tree, "bin/logo.bin")).toBeNull();
    // No project state of its own: no HEAD, branch, prefix or outside; refs and the stat cache are in the bare repository.
    expect([await g.head(), await g.branch(), await g.prefix(), await g.outsideChanges(base.tree, snap.tree)]).toEqual([null, null, "", []]);
    expect(git(gitDir, "rev-parse", "refs/agentduo/t/r1")).toBe(snap.commit);
    expect(existsSync(join(gitDir, INDEX_CACHE))).toBe(true);
    expect(existsSync(join(ws, ".git"))).toBe(false);
  });

  it("snapshots nested repositories' files as plain files, committed or not, and leaves those repositories as they were", async () => {
    const { ws, gitDir, g } = internal();
    const lib = join(ws, "lib");
    mkdirSync(lib);
    git(lib, "init", "-q", "-b", "main");
    git(lib, "config", "user.email", "t@example.com");
    git(lib, "config", "user.name", "T");
    git(lib, "config", "commit.gpgsign", "false");
    writeFileSync(join(lib, "x.txt"), "one\n");
    git(lib, "add", "-A");
    git(lib, "commit", "-q", "-m", "x");
    const fresh = join(ws, "fresh");
    mkdirSync(fresh);
    git(fresh, "init", "-q"); // no commit yet
    writeFileSync(join(fresh, "y.txt"), "one\n");
    // A linked worktree or submodule checkout has a .git file: metadata too.
    mkdirSync(join(ws, "linked"));
    writeFileSync(join(ws, "linked", ".git"), "gitdir: /elsewhere\n");
    writeFileSync(join(ws, "linked", "z.txt"), "z\n");
    const libHead = git(lib, "rev-parse", "HEAD");
    const libIndex = readFileSync(join(lib, ".git", "index"));
    const base = await g.snapshot(EXCLUDE);
    writeFileSync(join(lib, "x.txt"), "two\n");
    writeFileSync(join(fresh, "y.txt"), "two\n");
    const snap = await g.snapshot(EXCLUDE);
    expect((await g.nameStatus(base.tree, snap.tree)).sort()).toEqual([["M", "fresh/y.txt"], ["M", "lib/x.txt"]]);
    expect(await g.diff(base.commit, snap.commit)).toContain("+two");
    const entries = treeEntries(gitDir, snap.tree);
    expect(entries.map((e) => e.path).sort()).toEqual(["fresh/y.txt", "lib/x.txt", "linked/z.txt"]);
    expect(entries.every((e) => e.type === "blob" && e.mode !== "160000")).toBe(true);
    expect([git(lib, "rev-parse", "HEAD"), readFileSync(join(lib, ".git", "index")).equals(libIndex)]).toEqual([libHead, true]);
    expect(git(lib, "status", "--porcelain")).toBe("M x.txt");
    expect(existsSync(join(fresh, ".git", "index"))).toBe(false);
  });

  it("follows the workspace's .gitignore files, nested ones too, and a rule added after a snapshot", async () => {
    const { ws, gitDir, g } = internal();
    writeFileSync(join(ws, ".gitignore"), "*.log\nbuild/\n");
    writeFileSync(join(ws, "a.log"), "x\n");
    mkdirSync(join(ws, "build", "deep"), { recursive: true });
    writeFileSync(join(ws, "build", "deep", "out.js"), "x\n");
    mkdirSync(join(ws, "sub"));
    writeFileSync(join(ws, "sub", ".gitignore"), "secret.txt\n");
    writeFileSync(join(ws, "sub", "secret.txt"), "x\n");
    writeFileSync(join(ws, "sub", "keep.txt"), "x\n");
    // A nested repository's .gitignore counts as the folder's; its own info/exclude does not.
    const lib = join(ws, "lib");
    mkdirSync(lib);
    git(lib, "init", "-q");
    writeFileSync(join(lib, ".gitignore"), "*.tmp\n");
    writeFileSync(join(lib, "a.tmp"), "x\n");
    writeFileSync(join(lib, ".git", "info", "exclude"), "kept.txt\n");
    writeFileSync(join(lib, "kept.txt"), "x\n");
    const first = await g.snapshot(EXCLUDE);
    expect(treePaths(gitDir, first.tree)).toEqual([".gitignore", "lib/.gitignore", "lib/kept.txt", "sub/.gitignore", "sub/keep.txt"]);
    writeFileSync(join(ws, ".gitignore"), "*.log\nbuild/\nsub/keep.txt\n");
    const second = await g.snapshot(EXCLUDE);
    expect(await g.nameStatus(first.tree, second.tree)).toEqual([["M", ".gitignore"], ["D", "sub/keep.txt"]]);
  });

  it.skipIf(process.platform === "win32")("keeps symlinks as links, never following them, and executable bits", async () => {
    const { ws, gitDir, g } = internal();
    mkdirSync(join(ws, "sub"));
    writeFileSync(join(ws, "sub", "a.txt"), "a\n");
    symlinkSync("sub/a.txt", join(ws, "link.txt"));
    symlinkSync("sub", join(ws, "linkdir"));
    writeFileSync(join(ws, "run.sh"), "#!/bin/sh\n");
    chmodSync(join(ws, "run.sh"), 0o755);
    const snap = await g.snapshot(EXCLUDE);
    const modes = Object.fromEntries(treeEntries(gitDir, snap.tree).map((e) => [e.path, e.mode]));
    expect(modes).toEqual({ "link.txt": "120000", linkdir: "120000", "run.sh": "100755", "sub/a.txt": "100644" });
  });

  it("starts again from an empty index when its cache is damaged", async () => {
    const { ws, gitDir, g } = internal();
    writeFileSync(join(ws, "a.txt"), "a\n");
    const first = await g.worktreeTree(EXCLUDE);
    writeFileSync(join(gitDir, INDEX_CACHE), "not an index");
    expect(await g.worktreeTree(EXCLUDE)).toBe(first);
    rmSync(join(gitDir, INDEX_CACHE));
    expect(await g.worktreeTree(EXCLUDE)).toBe(first);
  });

  it("takes no direction from inherited git variables", async () => {
    const { tmp, ws, gitDir, g } = internal();
    writeFileSync(join(ws, "a.txt"), "a\n");
    const decoy = join(tmp, "decoy");
    mkdirSync(decoy);
    git(decoy, "init", "-q");
    writeFileSync(join(tmp, "ignore-all"), "*.txt\n");
    const vars: Record<string, string> = {
      GIT_DIR: join(decoy, ".git"), GIT_WORK_TREE: decoy, GIT_INDEX_FILE: join(decoy, ".git", "index"), GIT_OBJECT_DIRECTORY: join(decoy, ".git", "objects"),
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.excludesFile", GIT_CONFIG_VALUE_0: join(tmp, "ignore-all"),
    };
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    let snap;
    try {
      snap = await g.snapshot(EXCLUDE, "refs/agentduo/t/r1");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(treePaths(gitDir, snap.tree)).toEqual(["a.txt"]);
    expect(git(gitDir, "rev-parse", "refs/agentduo/t/r1")).toBe(snap.commit);
    expect(git(decoy, "count-objects")).toBe("0 objects, 0 kilobytes");
    expect(existsSync(join(decoy, ".git", "index"))).toBe(false);
  });
});
