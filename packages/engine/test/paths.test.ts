import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalPath, dataRoot, isWithin, leavesBase, packageRoot, packageVersion, setPackageRoot } from "../src/paths.js";

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

  it("keeps agentduo's data where each OS keeps an app's data, never in a temporary folder", () => {
    expect(dataRoot({ LOCALAPPDATA: "L", APPDATA: "A" }, "win32")).toBe(join("L", "agentduo"));
    expect(dataRoot({ APPDATA: "A" }, "win32")).toBe(join("A", "agentduo"));
    expect(dataRoot({}, "win32")).toBeNull();
    expect(dataRoot({ XDG_DATA_HOME: "/xdg", HOME: "/h" }, "linux")).toBe(join("/xdg", "agentduo"));
    // The XDG spec has a relative XDG_DATA_HOME ignored.
    expect(dataRoot({ XDG_DATA_HOME: "rel", HOME: "/h" }, "darwin")).toBe(join("/h", ".local", "share", "agentduo"));
  });

  it("tells a relative path that leaves its base from a child named like `..data`", () => {
    for (const rel of ["..", join("..", "x"), resolve("abs")]) expect(leavesBase(rel)).toBe(true);
    for (const rel of ["", "..data", join("..data", "x"), join("a", "..b")]) expect(leavesBase(rel)).toBe(false);
  });

  it("compares paths as the files they name, also paths that do not exist yet", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentduo-paths-")));
    try {
      mkdirSync(join(dir, "ws"));
      expect(canonicalPath(join(dir, "ws", "not", "yet"))).toBe(join(canonicalPath(join(dir, "ws")), "not", "yet"));
      expect(isWithin(join(dir, "ws", "a", ".."), join(dir, "ws"))).toBe(true);
      expect(isWithin(join(dir, "ws"), join(dir, "ws"))).toBe(true);
      expect(isWithin(join(dir, "wsx"), join(dir, "ws"))).toBe(false);
      expect(isWithin(join(dir, "ws", "..data"), join(dir, "ws"))).toBe(true);
      expect(isWithin(join(dir, "ws", "..", "..data"), join(dir, "ws"))).toBe(false);
      expect(isWithin(dir, join(dir, "ws"))).toBe(false);
      if (process.platform !== "win32") {
        symlinkSync(join(dir, "ws"), join(dir, "link"));
        expect(isWithin(join(dir, "link", "data", "missing"), join(dir, "ws"))).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
