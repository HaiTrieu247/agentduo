// The published package (apps/cli): what npm shows and what it installs.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const cli = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(cli, "package.json"), "utf8"));

describe("the agentduo package", () => {
  it("keeps README.md the only README at the package root, so npm shows the English one", () => {
    // npm takes the first match of {README,README.*} in the root, in no fixed order. prepack copies the repository's
    // README.md there, and the Vietnamese one under docs/.
    expect(readdirSync(cli).filter((f) => /^readme(\..*)?$/i.test(f) && f !== "README.md")).toEqual([]);
    expect(pkg.files).toEqual(["dist", "schemas", "README.md", "docs/README.vi.md", "LICENSE"]);
  });

  it("has the five runtime dependencies, and bundles the engine rather than install it", () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["ajv", "commander", "ink", "react", "yaml"]);
    // Workspace packages, never on npm: the engine is bundled, the host only runs in the tests.
    expect(Object.keys(pkg.devDependencies).filter((d) => d.startsWith("@agentduo/"))).toEqual(["@agentduo/engine", "@agentduo/host"]);
  });

  it("installs duo and agentduo", () => {
    expect(pkg.bin).toEqual({ agentduo: "dist/cli.js", duo: "dist/cli.js" });
  });
});
