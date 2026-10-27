import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/events.js";
import { startInk } from "../src/ui/ink/session.js";

class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 30;
  output = "";
  write(chunk: string, callback?: unknown): boolean {
    this.output += chunk;
    if (typeof callback === "function") callback();
    return true;
  }
}

const noop = () => undefined;

describe("startInk", () => {
  it("flushes the finish line before closing, and defers decisions when not interactive", async () => {
    const stdout = new FakeStdout();
    const bus = new EventBus();
    const session = startInk({
      bus, version: "0.1.0", verbose: false, interactive: false, onStop: noop, onInterrupt: noop,
      views: () => [], readView: async () => null, stdout: stdout as unknown as NodeJS.WriteStream,
    });
    expect(await session.decider.decide({ reason: "x", message: "m", fromPhase: "PLAN", resumePhase: "PLAN", details: [], at: "t" })).toBe("defer");
    bus.emit({ type: "run.finished", runId: "r1", phase: "DONE", reportPath: "/r/report.md", exitCode: 0 });
    await session.close();
    expect(stdout.output).toContain("DONE");
    expect(stdout.output).toContain("/r/report.md");
  });
  it("denies a pending permission prompt when the agent is interrupted, and every prompt when nobody can answer", async () => {
    const request = { id: "p1", tool: "Bash", label: "Bash  npm test", description: null, blockedPath: null, rules: [] };
    const make = (interactive: boolean) => startInk({
      bus: new EventBus(), version: "0.1.0", verbose: false, interactive, onStop: noop, onInterrupt: noop,
      views: () => [], readView: async () => null, stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
    });
    const quiet = make(false);
    expect(await quiet.permissions.askPermission({ role: "implementer", agent: "claude", request })).toEqual({ decision: "deny" });
    await quiet.close();
    const live = make(true);
    const controller = new AbortController();
    const pending = live.permissions.askPermission({ role: "implementer", agent: "claude", request }, controller.signal);
    controller.abort();
    expect(await pending).toEqual({ decision: "deny" });
    await live.close();
  });

  it("closes promptly after the finish line, and within a second without one", async () => {
    const bus = new EventBus();
    const session = startInk({
      bus, version: "0.1.0", verbose: false, interactive: false, onStop: noop, onInterrupt: noop,
      views: () => [], readView: async () => null, stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
    });
    bus.emit({ type: "run.finished", runId: "r1", phase: "DONE", reportPath: "/r", exitCode: 0 });
    let started = Date.now();
    await session.close();
    expect(Date.now() - started).toBeLessThan(500);
    const idle = startInk({
      bus: new EventBus(), version: "0.1.0", verbose: false, interactive: false, onStop: noop, onInterrupt: noop,
      views: () => [], readView: async () => null, stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
    });
    started = Date.now();
    await idle.close();
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });
});
