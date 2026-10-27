import { describe, expect, it } from "vitest";
import { checkChanges, checkGitPosition, matchProtected } from "../src/core/guards.js";

describe("guards", () => {
  it("matches protected globs like the Python version", () => {
    const patterns = [".agentduo/**", ".env", ".env.*", "**/*.pem", "**/secrets/**"];
    for (const path of [".agentduo/config.yaml", ".env", ".env.local", "key.pem", "a/b/key.pem", "secrets/x", "app/secrets/y.txt"]) {
      expect(matchProtected(path, patterns), path).not.toBeNull();
    }
    for (const path of ["src/env.ts", "README.md", "pem.txt", "src/.envrc.md", "agentduo/x"]) {
      expect(matchProtected(path, patterns), path).toBeNull();
    }
  });

  it("checks protected paths and mass deletion", () => {
    const changes: Array<[string, string]> = [["M", "src/a.ts"], ["A", ".env"], ["D", "f0"], ["D", "f1"], ["D", "f2"]];
    const violations = checkChanges(changes, [".env"], 2);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain("modified protected path '.env' (A, rule '.env')");
    expect(violations[1]).toContain("deleted 3 files (limit 2)");
    expect(checkChanges(changes.slice(0, 1), [".env"], 2)).toEqual([]);
  });

  it("detects HEAD and branch moves", () => {
    expect(checkGitPosition(["a", "main"], ["a", "main"])).toEqual([]);
    const v = checkGitPosition(["a", "main"], ["b", "other"]);
    expect(v[0]).toContain("HEAD moved from a to b");
    expect(v[1]).toContain("branch changed from main to other");
  });
});
