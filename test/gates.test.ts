import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeGates, GatesInterrupted, requiredPassed, runGates } from "../src/core/gates.js";
import { EventBus, type DuoEvent } from "../src/events.js";
import { tempDir } from "./helpers/tmp.js";

const node = `"${process.execPath}"`;
let t: { path: string; cleanup(): void };
let bus: EventBus;
let events: DuoEvent[];
beforeEach(() => {
  t = tempDir();
  bus = new EventBus();
  events = [];
  bus.on((e) => events.push(e));
});
afterEach(() => t.cleanup());
const run = (gates: Array<{ name: string; command: string; required?: boolean; timeout_sec?: number }>, extra: { maxOutputChars?: number; signal?: AbortSignal } = {}) =>
  runGates({ gates, repo: t.path, logDir: join(t.path, "gates"), label: "r1", defaultTimeoutSec: 30, maxOutputChars: extra.maxOutputChars ?? 1000, bus, signal: extra.signal });

describe("runGates", () => {
  it("runs each gate and reports results", async () => {
    const results = await run([
      { name: "ok", command: `${node} -e "console.log('fine')"` },
      { name: "bad", command: `${node} -e "console.error('broken'); process.exit(2)"`, required: false },
    ]);
    expect(results.map((r) => [r.name, r.passed, r.exitCode, r.required])).toEqual([["ok", true, 0, true], ["bad", false, 2, false]]);
    expect(results[1]!.outputTail).toContain("broken");
    expect(readFileSync(results[1]!.log, "utf8")).toContain("[exit code: 2]");
    expect(requiredPassed(results)).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["gate.started", "gate.completed", "gate.started", "gate.completed"]);
    expect(describeGates(results)).toContain("- [FAIL] bad (optional)");
    expect(describeGates(results)).toContain("broken");
    expect(describeGates(results, false)).not.toContain("```");
    expect(describeGates([])).toBe("(no quality gates configured)");
  });

  it("times out and truncates long output", async () => {
    const [slow] = await run([{ name: "slow", command: `${node} -e "setInterval(() => {}, 1000)"`, timeout_sec: 1 }]);
    expect(slow).toMatchObject({ timedOut: true, exitCode: null, passed: false });
    expect(describeGates([slow!])).toContain("[TIMEOUT]");
    const [loud] = await run([{ name: "loud", command: `${node} -e "console.log('x'.repeat(100))"` }], { maxOutputChars: 10 });
    expect(loud!.outputTail.startsWith("...[truncated]...")).toBe(true);
  });

  it("throws GatesInterrupted when aborted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expect(run([{ name: "slow", command: `${node} -e "setInterval(() => {}, 1000)"` }], { signal: controller.signal })).rejects.toThrow(GatesInterrupted);
  });
});
