// The workspace lock between processes (`duo`, the extension's and the desktop's workers): one holder at a time,
// however many race for it, a lock left by a process that is gone taken over by exactly one of them, and a process's
// lease of it held while any of its work runs.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { conversationBusy, conversationHolder, conversationLockPath, WorkspaceLease } from "../../src/workflow/lease.js";
import { acquireLockFile, acquireWorkspaceLock, LockError, workspaceLockHolder } from "../../src/workflow/state.js";
import { tempDir } from "../helpers/tmp.js";

/** The engine's lock, as the child imports it (forward slashes: a bundler takes them on Windows too). */
const STATE = fileURLToPath(new URL("../../src/workflow/state.ts", import.meta.url)).replace(/\\/g, "/");

/** A process that takes the workspace lock at an agreed moment, holds it a while, and says what happened (and when). */
const CHILD = `
import { appendFileSync } from "node:fs";
import { acquireWorkspaceLock, LockError } from ${JSON.stringify(STATE)};
const [runsDir, log, holdMs, start] = process.argv.slice(2);
while (Date.now() < Number(start)) {}
try {
  const release = acquireWorkspaceLock(runsDir);
  appendFileSync(log, "in " + process.pid + " " + Date.now() + "\\n");
  const until = Date.now() + Number(holdMs);
  while (Date.now() < until) {}
  appendFileSync(log, "out " + process.pid + " " + Date.now() + "\\n");
  release();
  process.stdout.write("took");
} catch (e) {
  if (!(e instanceof LockError)) throw e;
  process.stdout.write("busy: " + e.message);
}
`;

let child: { dir: string; cleanup(): void; script: string };
const dirs: Array<{ cleanup(): void }> = [];
beforeAll(async () => {
  const t = tempDir();
  writeFileSync(join(t.path, "lock-child.ts"), CHILD);
  await build({ entry: [join(t.path, "lock-child.ts")], outDir: join(t.path, "out"), format: ["esm"], platform: "node", target: "node22", bundle: true, silent: true, config: false });
  const out = join(t.path, "out");
  child = { dir: t.path, cleanup: t.cleanup, script: join(out, readdirSync(out).find((f) => f.startsWith("lock-child"))!) };
}, 60_000);
afterAll(() => child.cleanup());
afterEach(() => {
  while (dirs.length) dirs.pop()!.cleanup();
});

function runsDir(): string {
  const t = tempDir();
  dirs.push(t);
  return join(t.path, "runs");
}

function run(script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`child exited ${code}: ${err}`))));
  });
}

/** `n` processes race for the lock at the same moment; their outcomes, and whether two ever held it at once. */
async function race(dir: string, n: number, holdMs = 400) {
  const log = join(dir, "..", "holders.log");
  writeFileSync(log, "");
  const start = Date.now() + 1500;
  const outcomes = await Promise.all(Array.from({ length: n }, () => run(child.script, [dir, log, String(holdMs), String(start)])));
  const lines = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(" "));
  let holding = 0;
  let overlap = false;
  for (const [what] of lines.sort((a, b) => Number(a[2]) - Number(b[2]) || (a[0] === "out" ? -1 : 1))) {
    holding += what === "in" ? 1 : -1;
    if (holding > 1) overlap = true;
  }
  return { took: outcomes.filter((o) => o === "took").length, busy: outcomes.filter((o) => o.startsWith("busy")), overlap };
}

describe("the workspace lock between processes", () => {
  it("is held by one process at a time when several race for it; the others are told who holds it", async () => {
    const dir = runsDir();
    const { took, busy, overlap } = await race(dir, 6);
    expect(overlap).toBe(false);
    expect(took).toBeGreaterThanOrEqual(1);
    expect(took + busy.length).toBe(6);
    for (const b of busy) expect(b).toMatch(/another agentduo (is working in this workspace \(pid \d+\)|is starting work in this workspace)/);
    expect(existsSync(join(dir, ".lock"))).toBe(false);
  }, 30_000);

  it("is taken over from a process that is gone by exactly one of those racing for it, never by two at once", async () => {
    const dir = runsDir();
    acquireWorkspaceLock(dir)();
    writeFileSync(join(dir, ".lock"), "999999999");
    const { took, overlap } = await race(dir, 6);
    expect(overlap).toBe(false);
    expect(took).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(dir, ".lock"))).toBe(false);
  }, 30_000);

  it("waits briefly for a lock whose pid is being written, and takes over one left half written long ago", () => {
    const dir = runsDir();
    acquireWorkspaceLock(dir)();
    const lock = join(dir, ".lock");
    writeFileSync(lock, "");
    const started = Date.now();
    expect(() => acquireWorkspaceLock(dir)).toThrow("another agentduo is starting work in this workspace");
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const release = acquireWorkspaceLock(dir);
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
    release();
  });

  it("is given back only by the process it names: one taken over meanwhile stays", () => {
    const dir = runsDir();
    const release = acquireWorkspaceLock(dir);
    writeFileSync(join(dir, ".lock"), String(process.ppid));
    release();
    expect(workspaceLockHolder(dir)).toBe(process.ppid);
  });
});

describe("WorkspaceLease", () => {
  it("holds the lock once for all of a process's work, and gives it back with the last of it", () => {
    const dir = runsDir();
    const changes: boolean[] = [];
    const lease = new WorkspaceLease(dir, (held) => changes.push(held));
    const a = lease.take("conv-a");
    const b = lease.take("conv-b");
    const again = lease.take("conv-a");
    expect([lease.held, lease.holds("conv-a"), lease.holds("conv-b")]).toEqual([true, true, true]);
    expect([workspaceLockHolder(dir), conversationHolder(dir, "conv-a"), conversationHolder(dir, "conv-b")]).toEqual([process.pid, process.pid, process.pid]);
    a();
    a(); // idempotent
    expect(lease.holds("conv-a")).toBe(true);
    again();
    expect([lease.holds("conv-a"), existsSync(conversationLockPath(dir, "conv-a"))]).toEqual([false, false]);
    expect(lease.held).toBe(true);
    b();
    expect([lease.held, existsSync(join(dir, ".lock"))]).toEqual([false, false]);
    expect(changes).toEqual([true, false]);
  });

  it("refuses work while another holds the workspace or the conversation, and then holds nothing", () => {
    const dir = runsDir();
    const other = new WorkspaceLease(dir);
    const mine = new WorkspaceLease(dir);
    const release = other.take("conv-a");
    expect(mine.holder()).toBe(process.pid);
    expect(() => mine.take("conv-b")).toThrow(LockError);
    release();
    // Only the conversation is held (by a process working in it without the workspace: an older agentduo).
    const conversation = acquireLockFile(conversationLockPath(dir, "conv-a"), conversationBusy);
    expect(() => mine.take("conv-a")).toThrow(/this conversation is in use by another agentduo/);
    expect([mine.held, existsSync(join(dir, ".lock"))]).toEqual([false, false]);
    conversation();
    mine.take("conv-a")();
    expect(mine.holder()).toBeNull();
  });
});
