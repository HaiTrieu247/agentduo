import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listWorkspacePaths, taggedPaths, workspaceExcludes, WorkspacePaths } from "../src/core/mentions.js";
import { git, makeRepo } from "./helpers/repo.js";
import { tempDir } from "./helpers/tmp.js";

let t: { path: string; cleanup(): void };
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

const write = (root: string, rel: string, text = "x\n") => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const listed = async (dir: string, o?: Parameters<typeof listWorkspacePaths>[1]) => (await listWorkspacePaths(dir, o)).entries.map((e) => e.path).sort();

describe("listWorkspacePaths in a git repository", () => {
  it("lists tracked and untracked files and their folders, as .gitignore leaves them", async () => {
    const repo = makeRepo(t.path);
    write(repo, "src/core/a.ts");
    write(repo, "src/b.ts");
    write(repo, "dist/out.js");
    write(repo, ".gitignore", ".agentduo/runs/\ndist/\n");
    git(repo, "add", "src/core/a.ts");
    expect(await listed(repo)).toEqual([".gitignore", "README.md", "check.mjs", "src/", "src/b.ts", "src/core/", "src/core/a.ts"]);
  });

  it("leaves out a tracked file that was deleted, and the excluded folders", async () => {
    const repo = makeRepo(t.path, { ignoreRuns: false });
    write(repo, ".agentduo/runs/r1/state.json");
    write(repo, ".agentduo/config.yaml");
    rmSync(join(repo, "check.mjs"));
    expect(await listed(repo, { exclude: [".agentduo/runs"] })).toEqual([".agentduo/", ".agentduo/config.yaml", "README.md"]);
  });

  it("lists only the workspace's part of the repository, relative to it", async () => {
    const repo = makeRepo(t.path);
    write(repo, "pkg/app/main.ts");
    write(repo, "other/x.ts");
    expect(await listed(join(repo, "pkg"))).toEqual(["app/", "app/main.ts"]);
  });
});

describe("listWorkspacePaths in a folder with no repository", () => {
  it("walks the folder, without .git, node_modules or the excluded folders", async () => {
    const dir = join(t.path, "plain");
    write(dir, "notes.md");
    write(dir, "docs/guide.md");
    write(dir, "node_modules/x/index.js");
    write(dir, ".git/HEAD");
    write(dir, ".agentduo/runs/r1/state.json");
    expect(await listed(dir, { exclude: [".agentduo/runs"] })).toEqual([".agentduo/", "docs/", "docs/guide.md", "notes.md"]);
  });

  it("stops at `max` entries, the top level first, and says so", async () => {
    const dir = join(t.path, "plain");
    for (let i = 0; i < 5; i++) write(dir, `deep/f${i}.txt`);
    write(dir, "top.txt");
    const listing = await listWorkspacePaths(dir, { max: 3 });
    expect(listing.truncated).toBe(true);
    expect(listing.entries.map((e) => e.path)).toEqual(["deep/", "top.txt", "deep/f0.txt"]);
  });
});

describe("workspaceExcludes", () => {
  it("names the folders inside the workspace relative to it, and leaves out the others", () => {
    const ws = join(t.path, "ws");
    expect(workspaceExcludes(ws, [join(ws, ".agentduo", "runs"), join(t.path, "elsewhere"), ws])).toEqual([".agentduo/runs"]);
  });
});

describe("WorkspacePaths", () => {
  it("ranks the listed paths for a query and lists again once its list is older than maxAgeMs", async () => {
    const dir = join(t.path, "plain");
    write(dir, "alpha.ts");
    let now = 0;
    const paths = new WorkspacePaths(dir, { maxAgeMs: 1000, now: () => now });
    expect((await paths.find("alp")).map((e) => e.path)).toEqual(["alpha.ts"]);
    write(dir, "alpine.ts");
    now = 500;
    expect((await paths.find("alp")).map((e) => e.path)).toEqual(["alpha.ts"]);
    now = 1500;
    expect((await paths.find("alp")).map((e) => e.path)).toEqual(["alpha.ts", "alpine.ts"]);
  });
});

describe("taggedPaths", () => {
  it("gives the mentioned files and folders that exist in the workspace, each once", () => {
    const dir = join(t.path, "ws");
    write(dir, "src/a.ts");
    write(dir, "my docs/b.md");
    expect(taggedPaths('see @src/a.ts, @src and @"my docs/b.md"; again @src/a.ts', dir)).toEqual([
      { path: "src/a.ts", kind: "file" }, { path: "src/", kind: "folder" }, { path: "my docs/b.md", kind: "file" },
    ]);
  });

  it("leaves out a path that is missing, outside the workspace, or the workspace itself", () => {
    const dir = join(t.path, "ws");
    write(dir, "a.ts");
    write(t.path, "secret.txt");
    expect(taggedPaths("@missing.ts @../secret.txt @. @a.ts", dir)).toEqual([{ path: "a.ts", kind: "file" }]);
  });
});
