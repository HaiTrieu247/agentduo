// A lock file on Windows: a name another process just deleted stays taken until the handle that deleted it (or, with
// older semantics, every handle on it) is closed, and opening, reading or deleting it meanwhile fails with EPERM. Seen
// on CI when several processes took over a stale workspace lock, and when several wrote a team's RULES.md. The fs is
// the real one, except for the failures a test asks for.
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireWorkspaceLock, LockError } from "../../src/workflow/state.js";
import { tempDir } from "../helpers/tmp.js";

/** How many more times each fs call fails with `code` on a path ending in `.lock` (Infinity: always). */
const failing: Record<string, { code: string; times: number }> = {};

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const wrap = <F extends (...a: never[]) => unknown>(name: string, f: F): F => ((...a: Parameters<F>) => {
    const fail = failing[name];
    if (fail && fail.times > 0 && String(a[0]).endsWith(".lock")) {
      fail.times--;
      throw Object.assign(new Error(`${fail.code}: operation not permitted, ${name} '${String(a[0])}'`), { code: fail.code });
    }
    return f(...a);
  }) as F;
  return { ...real, openSync: wrap("openSync", real.openSync), readFileSync: wrap("readFileSync", real.readFileSync) };
});

const platform = process.platform;
function onPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p });
}

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform });
  for (const k of Object.keys(failing)) delete failing[k];
  while (dirs.length) dirs.pop()!.cleanup();
});

function runsDir(): string {
  const t = tempDir();
  dirs.push(t);
  return join(t.path, "runs");
}

describe("a lock file on Windows", () => {
  it("is taken once the name of one another process deleted is free again", () => {
    onPlatform("win32");
    const dir = runsDir();
    failing.openSync = { code: "EPERM", times: 3 };
    const release = acquireWorkspaceLock(dir);
    expect(fs.readFileSync(join(dir, ".lock"), "utf8")).toBe(String(process.pid));
    release();
  });

  it("is taken over from a process that is gone while another process is deleting it too", () => {
    onPlatform("win32");
    const dir = runsDir();
    acquireWorkspaceLock(dir)();
    fs.writeFileSync(join(dir, ".lock"), "999999999");
    failing.readFileSync = { code: "EPERM", times: 2 };
    failing.openSync = { code: "EPERM", times: 2 };
    const release = acquireWorkspaceLock(dir);
    expect(fs.readFileSync(join(dir, ".lock"), "utf8")).toBe(String(process.pid));
    release();
  });

  it("says what a permission problem that lasts is, once the lock had time to settle", () => {
    onPlatform("win32");
    const dir = runsDir();
    failing.openSync = { code: "EPERM", times: Infinity };
    const started = Date.now();
    let thrown: unknown;
    try {
      acquireWorkspaceLock(dir);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeInstanceOf(LockError);
    expect(thrown).toMatchObject({ code: "EPERM" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("is not waited for elsewhere: EPERM there is a permission problem", () => {
    onPlatform("linux");
    const dir = runsDir();
    failing.openSync = { code: "EPERM", times: 1 };
    const started = Date.now();
    expect(() => acquireWorkspaceLock(dir)).toThrow(expect.objectContaining({ code: "EPERM" }));
    expect(Date.now() - started).toBeLessThan(500);
  });
});
