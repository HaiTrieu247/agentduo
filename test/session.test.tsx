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
});
