import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageRoot, packageVersion, setPackageRoot } from "../src/paths.js";

describe("paths", () => {
  it("finds the package root and version", () => {
    const root = packageRoot();
    expect(existsSync(join(root, "schemas", "plan.schema.json"))).toBe(true);
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("uses the package root it is given, for code bundled away from the package (the desktop's main process)", () => {
    const own = packageRoot();
    const dir = mkdtempSync(join(tmpdir(), "agentduo-root-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "agentduo", version: "9.8.7" }));
      setPackageRoot(dir);
      expect(packageRoot()).toBe(dir);
      expect(packageVersion()).toBe("9.8.7");
    } finally {
      setPackageRoot(own);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps README.md the only README at the package root, so npm shows the English one", () => {
    // npm takes the first match of {README,README.*} in the root, in no fixed order.
    expect(readdirSync(packageRoot()).filter((f) => /^readme(\..*)?$/i.test(f))).toEqual(["README.md"]);
  });
});
