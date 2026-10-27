import { describe, expect, it, vi } from "vitest";
import { killAllActive, runProcess, type ChildIO } from "../src/agents/process.js";

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

  it("kills a silent process after the idle timeout, but not a chatty one", async () => {
    const silent = await runProcess(node, ["-e", "setInterval(() => {}, 1000)"], { cwd, timeoutMs: 10_000, idleTimeoutMs: 300, killGraceMs: 100 });
    expect(silent).toMatchObject({ idle: true, timedOut: false, code: null });
    const chatty = await runProcess(node, ["-e", "let n = 0; const t = setInterval(() => { process.stdout.write('.'); if (++n === 6) { clearInterval(t); } }, 100)"],
      { cwd, timeoutMs: 10_000, idleTimeoutMs: 400 });
    expect(chatty).toMatchObject({ idle: false, code: 0 });
    const off = await runProcess(node, ["-e", "setTimeout(() => {}, 500)"], { cwd, timeoutMs: 10_000, idleTimeoutMs: 0 });
    expect(off).toMatchObject({ idle: false, code: 0 });
  });

  it("holds stdin open for a conversation and pauses both timeouts while the caller is waiting", async () => {
    // Answers every stdin line, then says bye when stdin closes; silent in between.
    const echo = "process.stdin.setEncoding('utf8'); let b = ''; process.stdin.on('data', (c) => { b += c; let i; " +
      "while ((i = b.indexOf('\\n')) >= 0) { process.stdout.write('got ' + b.slice(0, i) + '\\n'); b = b.slice(i + 1); } }); " +
      "process.stdin.on('end', () => process.stdout.write('bye\\n'));";
    const lines: string[] = [];
    let io: ChildIO | undefined;
    const r = await runProcess(node, ["-e", echo], {
      cwd, input: "first\n", holdStdin: true, timeoutMs: 700, idleTimeoutMs: 300, killGraceMs: 100,
      onSpawn: (child) => { io = child; },
      onStdoutLine: (line) => {
        lines.push(line);
        if (line === "got first") {
          io!.pause(); // longer than both timeouts: a human thinking must not count as a hang
          setTimeout(() => { io!.write("second\n"); io!.resume(); }, 900);
        } else if (line === "got second") io!.end();
      },
    });
    expect(lines).toEqual(["got first", "got second", "bye"]);
    expect(r).toMatchObject({ code: 0, timedOut: false, idle: false });
    const held = await runProcess(node, ["-e", echo], { cwd, input: "x\n", holdStdin: true, timeoutMs: 10_000, idleTimeoutMs: 300, killGraceMs: 100 });
    expect(held).toMatchObject({ idle: true, code: null });
  });

  it("keeps only the tail of very large output but still reports every line", async () => {
    let lines = 0;
    const r = await runProcess(node, ["-e", "for (let i = 0; i < 1000; i++) console.log('line ' + i)"],
      { cwd, timeoutMs: 10_000, maxBufferChars: 100, onStdoutLine: () => { lines += 1; } });
    expect(lines).toBe(1000);
    expect(r.stdout.length).toBeLessThanOrEqual(100);
    expect(r.stdout).toContain("line 999");
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
