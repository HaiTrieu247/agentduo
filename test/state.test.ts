import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LockError, nowIso, RunStore, slugify } from "../src/core/state.js";
import { tempDir } from "./helpers/tmp.js";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (dirs.length) dirs.pop()!.cleanup();
});
function runsDir(): string {
  const t = tempDir();
  dirs.push(t);
  return join(t.path, "runs");
}
const LIMITS = { max_planning_rounds: 4, max_review_rounds: 5 };

describe("slugify and nowIso", () => {
  it("makes ASCII slugs from any text", () => {
    expect(slugify("Thêm đăng nhập bằng JWT")).toBe("them-dang-nhap-bang-jwt");
    expect(slugify("Implement JWT authentication with refresh tokens")).toBe("implement-jwt-authentication-with-refres");
    expect(slugify("!!! ???")).toBe("task");
    expect(slugify("a".repeat(60))).toHaveLength(40);
  });

  it("formats local time with an offset", () => {
    expect(nowIso()).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  });
});

describe("RunStore", () => {
  it("creates runs with unique ids and a LATEST pointer", () => {
    const dir = runsDir();
    const now = new Date(2026, 9, 27, 13, 20, 0);
    const a = RunStore.create(dir, "Fix it", LIMITS, now);
    const b = RunStore.create(dir, "Fix it", LIMITS, now);
    expect(a.store.taskId).toBe("20261027-132000-fix-it");
    expect(b.store.taskId).toBe("20261027-132000-fix-it-2");
    expect(existsSync(join(b.store.dir, "logs"))).toBe(true);
    expect(RunStore.open(dir).taskId).toBe(b.store.taskId);
    expect(RunStore.open(dir, a.store.taskId).loadState()).toMatchObject({ task: "Fix it", phase: "PLAN", planningRound: 1, limits: { planningRounds: 4, reviewRounds: 5 } });
    expect(RunStore.list(dir).map((s) => s.taskId)).toEqual([a.store.taskId, b.store.taskId]);
  });

  it("errors for unknown runs", () => {
    const dir = runsDir();
    expect(() => RunStore.open(dir)).toThrow("no runs found");
    RunStore.create(dir, "x", LIMITS);
    expect(() => RunStore.open(dir, "nope")).toThrow("run 'nope' not found");
    expect(RunStore.list(join(dir, "missing"))).toEqual([]);
  });

  it("locks, refuses a second lock and reclaims stale locks", () => {
    const { store } = RunStore.create(runsDir(), "x", LIMITS);
    store.lock();
    expect(() => new RunStore(store.runsDir, store.taskId).lock()).toThrow(LockError);
    store.unlock();
    writeFileSync(store.path("lock"), "999999999");
    const again = new RunStore(store.runsDir, store.taskId);
    again.lock();
    again.unlock();
    expect(existsSync(store.path("lock"))).toBe(false);
  });

  it("writes atomically and updates timestamps", () => {
    const { store, state } = RunStore.create(runsDir(), "x", LIMITS);
    state.updatedAt = "old";
    store.saveState(state);
    expect(store.loadState().updatedAt).not.toBe("old");
    store.writeJson("a/b.json", { ok: 1 });
    expect(store.readJson("a/b.json")).toEqual({ ok: 1 });
    store.appendEvent({ type: "x" });
    expect(store.readText("events.jsonl")).toContain('"type":"x"');
    expect(readdirSync(store.dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});
