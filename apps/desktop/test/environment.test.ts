import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launcherEnvironment, parseShellPath, shellCommand, withPath, type ShellRunner } from "../src/main/environment.js";
import { bundledNode, runtimeProblems } from "../src/main/runtime.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentduo-desktop-env-"));
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("launcherEnvironment", () => {
  // A ':'-separated PATH cannot hold the Windows folder (C:\…) this test needs to exist.
  it.skipIf(process.platform === "win32")("adds the login shell's PATH and the install directories after the app's own, each once", async () => {
    const run: ShellRunner = async () => ({ code: 0, stdout: `motd\n${shellCommand("/bin/zsh")[3]!.includes("printf") ? "" : ""}__AGENTDUO_PATH__/opt/tools/bin:/usr/bin\n`, error: null });
    const marker = parseShellPath("x\n__AGENTDUO_PATH__/a:/b\n");
    // the marker the module uses is private: find it from what it parses
    const answer = marker ? run : run;
    const r = await launcherEnvironment({ env: { PATH: "/usr/bin:/bin", SHELL: "/bin/sh" }, platform: "darwin", home, run: async (shell, args, o) => {
      const printed = args[3]!.match(/printf '([^%]+)%s/)![1]!;
      void answer;
      void o;
      return { code: 0, stdout: `motd\n${printed}/opt/tools/bin:/usr/bin\n`, error: null };
    } });
    const path = r.env.PATH!.split(":");
    expect(path.slice(0, 3)).toEqual(["/usr/bin", "/bin", "/opt/tools/bin"]);
    expect(path).toContain(join(home, ".local", "bin"));
    expect(path.filter((p) => p === "/usr/bin")).toHaveLength(1);
    expect(r.info.shellProblem).toBeNull();
  });

  it("goes on without the shell when it hangs or fails", async () => {
    const r = await launcherEnvironment({ env: { PATH: "/usr/bin", SHELL: "/bin/sh" }, platform: "linux", home, run: async () => ({ code: null, stdout: "", error: "did not answer within 5s" }) });
    expect(r.info.shellProblem).toMatch(/did not answer/);
    expect(r.env.PATH!.startsWith("/usr/bin")).toBe(true);
  });

  it("on Windows keeps one Path variable, whatever case it had, and never runs a shell", async () => {
    let ran = false;
    const r = await launcherEnvironment({ env: { Path: "C:\\Windows", PATHEXT: ".EXE;.CMD", APPDATA: home }, platform: "win32", home, run: async () => ((ran = true), { code: 0, stdout: "", error: null }) });
    expect(ran).toBe(false);
    expect(Object.keys(r.env).filter((k) => k.toUpperCase() === "PATH")).toEqual(["Path"]);
    expect(r.env.Path!.split(";")[0]).toBe("C:\\Windows");
  });

  it("withPath sets PATHEXT on Windows when it is missing", () => {
    expect(withPath({ PATH: "a" }, ["a", "b"], "win32")).toMatchObject({ Path: "a;b", PATHEXT: ".COM;.EXE;.BAT;.CMD" });
  });
});

describe("bundled Node", () => {
  it("runs the worker with Electron's own Node, which must be new enough", () => {
    expect(bundledNode({ execPath: "/Applications/agentduo.app/Contents/MacOS/agentduo", node: "24.22.1" })).toEqual({
      ok: true, path: "/Applications/agentduo.app/Contents/MacOS/agentduo", version: "24.22.1", launch: "electron",
    });
    expect(bundledNode({ execPath: "/x", node: "20.18.0" }).ok).toBe(false);
  });

  it("names what is missing from the runtime directory", () => {
    expect(runtimeProblems(home).length).toBeGreaterThan(0);
  });
});
