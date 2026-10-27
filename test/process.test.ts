import { describe, expect, it, vi } from "vitest";
import { killAllActive, runProcess } from "../src/agents/process.js";

const node = process.execPath;
const cwd = process.cwd();

describe("runProcess", () => {
  it("passes stdin and collects stdout, stderr and the exit code", async () => {
    const r = await runProcess(node, ["-e", "process.stdin.pipe(process.stdout); process.stderr.write('warn'); process.stdin.on('end', () => { process.exitCode = 3; })"],
      { cwd, input: "hello", timeoutMs: 10_000 });
    expect(r).toMatchObject({ code: 3, stdout: "hello", stderr: "warn", timedOut: false, aborted: false });
  });

  it("splits stdout into lines across chunks, CRLF and blank lines", async () => {
    const lines: string[] = [];
    await runProcess(node, ["-e", "process.stdout.write('one\\r\\ntw'); setTimeout(() => process.stdout.write('o\\n\\nthree'), 50)"],
      { cwd, timeoutMs: 10_000, onStdoutLine: (l) => lines.push(l) });
    expect(lines).toEqual(["one", "two", "three"]);
  });

  it.skipIf(process.platform === "win32")("kills the whole process tree on timeout", async () => {
    const code = "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000);";
    const r = await runProcess(node, ["-e", code], { cwd, timeoutMs: 500, killGraceMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
    const grandchild = Number(r.stdout.trim());
    await new Promise((res) => setTimeout(res, 500));
    expect(() => process.kill(grandchild, 0)).toThrow();
  });

  it("stops when the abort signal fires", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const r = await runProcess(node, ["-e", "setInterval(() => {}, 1000)"], { cwd, timeoutMs: 10_000, signal: controller.signal, killGraceMs: 200 });
    expect(r.aborted).toBe(true);
    expect(r.code).toBeNull();
  });

  it.skipIf(process.platform === "win32")("killAllActive sends SIGKILL immediately (the process is about to exit)", async () => {
    const running = runProcess(node, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { cwd, timeoutMs: 10_000 });
    await new Promise((res) => setTimeout(res, 200));
    const kill = vi.spyOn(process, "kill");
    killAllActive();
    const signals = kill.mock.calls.map((c) => c[1]);
    kill.mockRestore();
    expect(signals).toEqual(["SIGKILL"]);
    await running;
  });

  it("rejects when the binary does not exist", async () => {
    await expect(runProcess("/nonexistent/agentduo-bin", [], { cwd, timeoutMs: 1000 })).rejects.toThrow(/ENOENT/);
  });

  it("runs shell commands", async () => {
    const r = await runProcess("echo hi && exit 4", [], { cwd, timeoutMs: 10_000, shell: true });
    expect(r.code).toBe(4);
    expect(r.stdout.trim()).toBe("hi");
  });
});
