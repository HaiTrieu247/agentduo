// The fake CLIs the tests run, as POSIX scripts and as Windows .cmd shims, and how agentduo finds and starts such
// shims: PATH/Path and PATHEXT as Windows reads them, quoting, and arguments with spaces and Unicode.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runProcess, windowsShimCommand } from "../src/agents/process.js";
import { envValue, resolveBinary } from "../src/agents/resolve.js";
import { FakeClis, fakeShim } from "./helpers/fake-clis.js";
import { tempDir } from "./helpers/tmp.js";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (dirs.length) dirs.pop()!.cleanup();
});
const tmp = () => {
  const t = tempDir();
  dirs.push(t);
  return t.path;
};

describe("fake CLI shims", () => {
  it("are .cmd files on Windows that pass every argument and the runtime's environment", () => {
    const shim = fakeShim("codex", { exec: "C:\\Program Files\\agentduo\\agentduo.exe", env: { ELECTRON_RUN_AS_NODE: "1" } }, "win32", "C:\\fake agent.mjs");
    expect(shim.file).toBe("codex.cmd");
    expect(shim.text).toBe('@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"C:\\Program Files\\agentduo\\agentduo.exe" "C:\\fake agent.mjs" codex %*\r\n');
  });

  it("are shell scripts elsewhere, with the runtime named explicitly, never left to process.execPath", () => {
    const shim = fakeShim("claude", { exec: "/Applications/agentduo.app/Contents/MacOS/agentduo", env: { ELECTRON_RUN_AS_NODE: "1", X: "it's" } }, "darwin", "/f.mjs");
    expect(shim).toEqual({ file: "claude", text: `#!/bin/sh\nELECTRON_RUN_AS_NODE='1' X='it'\\''s' exec "/Applications/agentduo.app/Contents/MacOS/agentduo" "/f.mjs" claude "$@"\n` });
  });

  it.skipIf(process.platform === "win32")("run the fake agent with arguments holding spaces, quotes and Unicode, unchanged", async () => {
    const dir = tmp();
    const fake = new FakeClis(dir).install();
    try {
      const args = ["--version", "Dự án mẫu", "a b", `it's "quoted"`];
      const r = await runProcess(fake.path("codex"), args, { cwd: dir, timeoutMs: 15_000 });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("codex-fake 1.0.0");
    } finally {
      fake.restore();
    }
  });
});

describe("Windows: finding and starting CLI shims", () => {
  it("reads PATH and PATHEXT whatever their case, as Windows does", () => {
    expect(envValue({ Path: "C:\\bin" }, "PATH", "win32")).toBe("C:\\bin");
    expect(envValue({ PATH: "C:\\a", Path: "C:\\b" }, "PATH", "win32")).toBe("C:\\a");
    expect(envValue({ Path: "x" }, "PATH", "darwin")).toBeUndefined();
  });

  it("finds codex.cmd on a Path, and never the bare shell script npm puts beside it", () => {
    const dir = join(tmp(), "npm");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "codex"), "#!/bin/sh\n");
    writeFileSync(join(dir, "codex.cmd"), "@echo off\r\n");
    writeFileSync(join(dir, "claude.exe"), "");
    const env = { Path: `C:\\none;${dir}`, PATHEXT: ".COM;.EXE;.BAT;.CMD", USERPROFILE: dir };
    expect(resolveBinary("codex", "codex", env, "win32")).toBe(join(dir, "codex.cmd"));
    expect(resolveBinary("claude.exe", "claude", env, "win32")).toBe(join(dir, "claude.exe"));
    expect(resolveBinary("claude", "claude", env, "win32")).toBe(join(dir, "claude.exe"));
  });

  it("quotes the shim's command line for cmd.exe: spaces, quotes and shell characters stay one word each", () => {
    expect(windowsShimCommand("C:\\Users\\Mai Anh\\AppData\\Roaming\\npm\\codex.cmd", ["exec", "--cd", "C:\\Dự án\\x", 'say "hi"', "a&b", "plain"]))
      .toBe('"C:\\Users\\Mai Anh\\AppData\\Roaming\\npm\\codex.cmd" exec --cd "C:\\Dự án\\x" "say ""hi""" "a&b" plain');
  });
});
