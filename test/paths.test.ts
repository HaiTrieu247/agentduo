import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageRoot, packageVersion } from "../src/paths.js";

describe("paths", () => {
  it("finds the package root and version", () => {
    const root = packageRoot();
    expect(existsSync(join(root, "schemas", "plan.schema.json"))).toBe(true);
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
