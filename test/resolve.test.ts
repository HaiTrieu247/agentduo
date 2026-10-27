import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBinary } from "../src/agents/resolve.js";
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
function file(path: string, executable = true): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n");
  if (executable) chmodSync(path, 0o755);
  return path;
}

describe.skipIf(process.platform === "win32")("resolveBinary", () => {
  it("searches PATH", () => {
    const home = tmp();
    const bin = file(join(home, "bin", "codex"));
    expect(resolveBinary("codex", "codex", { PATH: `/nonexistent:${join(home, "bin")}`, HOME: home })).toBe(bin);
  });

  it("accepts explicit and ~ paths", () => {
    const home = tmp();
    const bin = file(join(home, "tools", "claude"));
    expect(resolveBinary(bin, "claude", { PATH: "", HOME: home })).toBe(bin);
    expect(resolveBinary("~/tools/claude", "claude", { PATH: "", HOME: home })).toBe(bin);
    expect(resolveBinary(join(home, "nope"), "claude", { PATH: "", HOME: home })).toBeNull();
  });

  it("falls back to the newest IDE-bundled Claude", () => {
    const home = tmp();
    for (const v of ["2.1.9", "2.1.310"]) {
      file(join(home, ".vscode", "extensions", `anthropic.claude-code-${v}-darwin-arm64`, "resources", "native-binary", "claude"));
    }
    expect(resolveBinary("claude", "claude", { PATH: "/nonexistent", HOME: home })).toContain("anthropic.claude-code-2.1.310");
    expect(resolveBinary("codex", "codex", { PATH: "/nonexistent", HOME: home })).toBeNull();
  });

  it("skips files that are not executable", () => {
    const home = tmp();
    file(join(home, "bin", "codex"), false);
    expect(resolveBinary("codex", "codex", { PATH: join(home, "bin"), HOME: home })).toBeNull();
  });
});
