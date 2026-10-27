import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageRoot, packageVersion } from "../src/paths.js";

describe("paths", () => {
  it("finds the package root and version", () => {
    const root = packageRoot();
    expect(existsSync(join(root, "schemas", "plan.schema.json"))).toBe(true);
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("keeps README.md the only README at the package root, so npm shows the English one", () => {
    // npm takes the first match of {README,README.*} in the root, in no fixed order.
    expect(readdirSync(packageRoot()).filter((f) => /^readme(\..*)?$/i.test(f))).toEqual(["README.md"]);
  });
});
