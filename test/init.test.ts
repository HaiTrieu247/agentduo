import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { detectGates, initRepo, renderConfigYaml } from "../src/core/init.js";
import { userConfigEnv } from "./helpers/config.js";
import { git, makeRepo } from "./helpers/repo.js";
import { tempDir } from "./helpers/tmp.js";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (dirs.length) dirs.pop()!.cleanup();
});
function tmp(): string {
  const t = tempDir();
  dirs.push(t);
  return t.path;
}

describe("detectGates", () => {
  it("finds package scripts and uses the project's package manager", () => {
    const dir = tmp();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run", lint: "eslint .", "type-check": "tsc" } }));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    expect(detectGates(dir).map((g) => [g.name, g.command])).toEqual([["test", "pnpm run test"], ["lint", "pnpm run lint"], ["typecheck", "pnpm run type-check"]]);
  });

  it("skips npm's placeholder test script and detects other ecosystems", () => {
    const dir = tmp();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(detectGates(dir)).toEqual([]);
    for (const name of ["pyproject.toml", "go.mod", "Cargo.toml"]) writeFileSync(join(dir, name), "");
    writeFileSync(join(dir, "Makefile"), "build:\n\techo build\ntest:\n\techo ok\n");
    expect(detectGates(dir).map((g) => g.name)).toEqual(["pytest", "go-test", "cargo-test", "make-test"]);
  });
});

describe("initRepo", () => {
  it("suggests detected gates as comments, ignores run data, and is idempotent", () => {
    const parent = tmp();
    const repo = makeRepo(parent, { ignoreRuns: false });
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    expect(initRepo(repo)).toMatchObject({ created: true, ignoreCreated: true, gates: [{ name: "test", command: "npm run test" }] });
    const yaml = readFileSync(join(repo, ".agentduo", "config.yaml"), "utf8");
    expect(yaml).toContain('#     command: "npm run test"');
    expect(yaml).toContain("uncomment");
    expect(yaml).toContain("role_args");
    expect(loadConfig({ dir: repo, env: userConfigEnv(join(parent, "xdg")) }).data.gates).toEqual([]);
    expect(initRepo(repo)).toMatchObject({ created: false, ignoreCreated: false });
    expect(readFileSync(join(repo, ".agentduo", ".gitignore"), "utf8")).toBe("runs/\n");
    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
    expect(git(repo, "check-ignore", ".agentduo/runs/x")).toBe(".agentduo/runs/x");
  });

  it("renders a valid config when nothing is detected", () => {
    expect(renderConfigYaml([])).toContain('#     command: "npm test"');
  });
});
