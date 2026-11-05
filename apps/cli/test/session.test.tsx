import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { parseQuestions, type ClarificationRequest } from "@agentduo/engine/clarification/clarification";
import { EventBus } from "@agentduo/engine/events";
import { startChatInk } from "../src/ui/ink/chat-session.js";
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

  const asking = (): ClarificationRequest => {
    const parsed = parseQuestions([{ question: "Which one?", header: "One", options: [{ label: "A", description: "" }, { label: "B", description: "" }] }]);
    return { id: "clq-1", source: "claude", callId: "c1", agent: "claude", role: "implementer", questions: "questions" in parsed ? parsed.questions : [], at: "t" };
  };

  it("puts every question off when nobody can answer, when the call is aborted, and when the screen closes", async () => {
    const make = (interactive: boolean) => startInk({
      bus: new EventBus(), version: "0.1.0", verbose: false, interactive, onStop: noop, onInterrupt: noop,
      views: () => [], readView: async () => null, stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
    });
    const quiet = make(false);
    expect(await quiet.clarifier.askClarification({ request: asking() })).toEqual({ kind: "defer" });
    await quiet.close();

    const live = make(true);
    const controller = new AbortController();
    const aborted = live.clarifier.askClarification({ request: asking() }, controller.signal);
    controller.abort();
    expect(await aborted).toEqual({ kind: "defer" });
    // Still open when the screen closes: put off, not left waiting for a screen that is gone.
    const open = live.clarifier.askClarification({ request: { ...asking(), id: "clq-2" } });
    await live.close();
    expect(await open).toEqual({ kind: "defer" });
    expect(await live.clarifier.askClarification({ request: { ...asking(), id: "clq-3" } })).toEqual({ kind: "defer" });
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

class FakeStdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  write(data: string): void {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  }
  read(): string | null {
    const data = this.data;
    this.data = null;
    return data;
  }
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
}

describe("startChatInk", () => {
  const start = (onSubmit: (text: string) => void = noop, onEscape: () => void = noop) => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const session = startChatInk({
      bus: new EventBus(), version: "0.2.0", verbose: false, workspace: "/ws", onSubmit, onEscape, views: () => [], readView: async () => null,
      stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
    });
    return { session, stdout, stdin };
  };
  const tick = () => new Promise((r) => setTimeout(r, 60));

  it("echoes what you send, stops a running step on the first Ctrl-C and leaves on the second", async () => {
    const sent: string[] = [];
    let escapes = 0;
    const { session, stdout, stdin } = start((text) => sent.push(text), () => { escapes += 1; });
    await tick();
    stdin.write("Add JWT auth");
    await tick();
    stdin.write("\r");
    await tick();
    expect(sent).toEqual(["Add JWT auth"]);
    session.ui.setStatus("running");
    let left = false;
    void session.exited.then(() => { left = true; });
    stdin.write("\u0003");
    await tick();
    expect([escapes, left]).toEqual([1, false]);
    expect(stdout.output).toContain("Press Ctrl-C again to quit");
    stdin.write("\u0003");
    await tick();
    expect(left).toBe(true);
    await session.close();
  });

  it("treats Ctrl-C at a decision as \"decide later\"", async () => {
    const { session, stdin } = start();
    await tick();
    const answer = session.decider.decide({ reason: "x", message: "m", fromPhase: "PLAN", resumePhase: "PLAN", details: [], at: "t" });
    stdin.write("\u0003");
    expect(await answer).toBe("defer");
    await session.close();
  });
  it("puts a question that waits off with the first Ctrl-C, as the decision prompt is, and when the chat closes", async () => {
    const { session, stdin } = start();
    await tick();
    const request = { id: "clq-1", source: "claude" as const, callId: "c1", agent: "claude" as const, role: "implementer" as const, at: "t",
      questions: [{ id: "q1", header: "One", question: "Which one?", multiSelect: false, options: [{ id: "q1o1", label: "A", description: "" }, { id: "q1o2", label: "B", description: "" }] }] };
    const waiting = session.clarifier.askClarification({ request });
    await tick();
    let left = false;
    void session.exited.then(() => { left = true; });
    stdin.write("\u0003");
    await tick();
    expect(await waiting).toEqual({ kind: "defer" });
    expect(left).toBe(false);
    const again = session.clarifier.askClarification({ request: { ...request, id: "clq-2" } });
    await session.close();
    expect(await again).toEqual({ kind: "defer" });
  });
});
