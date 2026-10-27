import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { EventBus, type Activity, type DuoEvent, type HistoryEntry, type Phase, type Role } from "../src/events.js";
import { App } from "../src/ui/ink/App.js";
import { HumanReviewPrompt } from "../src/ui/ink/HumanReviewPrompt.js";
import { StepBlock } from "../src/ui/ink/StepBlock.js";
import { initialView, reduce, type StepView, type ViewState } from "../src/ui/ink/store.js";

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const phase = (p: Phase, role: Role, agent: "codex" | "claude", round = 1): DuoEvent =>
  ({ type: "phase.started", step: 1, phase: p, round, role, agent, planning: { round: 1, limit: 4 }, impl: { round, limit: 5 } });
const act = (id: string, label: string, status: Activity["status"], extra: Partial<Activity> = {}): DuoEvent =>
  ({ type: "agent.activity", role: "implementer", agent: "claude", activity: { id, kind: "edit", label, status, ...extra } });
const entry = (p: Phase, status: string, summary: string, kind: HistoryEntry["kind"] = "ok"): HistoryEntry =>
  ({ step: 1, phase: p, round: 1, agent: "Claude", status, summary, kind, at: "x", artifact: null });
const review = { reason: "max_review_rounds", message: "not approved after 5 rounds", fromPhase: "CODE_REVIEW" as const,
  resumePhase: "IMPLEMENT" as const, details: ["F3 [high] src/auth.ts:42"], at: "x" };
const play = (events: DuoEvent[], s: ViewState = initialView("0.1.0")) => events.reduce((acc, event) => reduce(acc, { type: "event", event, now: 0 }), s);
const lastStep = (s: ViewState): StepView => {
  const item = s.items.at(-1)!;
  if (item.kind !== "step") throw new Error("last item is not a step");
  return item.step;
};
const noop = () => undefined;

describe("view reducer", () => {
  it("collects activities into the current step and finalizes it", () => {
    const s = play([
      { type: "run.started", runId: "r1", task: "t", repo: "/repo", runDir: "/d" },
      phase("IMPLEMENT", "implementer", "claude"),
      act("a", "Edit  src/x.ts", "running"),
      act("a", "Edit  src/x.ts", "ok", { added: 4, removed: 0 }),
      { type: "agent.usage", agent: "claude", costUsd: 0.2 },
      { type: "message", message: { from: "claude", to: "codex", kind: "implementation", headline: "completed · 1 file(s) changed", items: [] } },
      { type: "step.completed", entry: entry("IMPLEMENT", "completed", "1 file(s) changed"), durationSec: 12, costUsd: 0.2 },
    ]);
    expect(s.items.map((i) => i.kind)).toEqual(["header", "step"]);
    expect(lastStep(s).activities).toEqual([{ id: "a", kind: "edit", label: "Edit  src/x.ts", status: "ok", added: 4, removed: 0 }]);
    expect(s.totals.costUsd).toBeCloseTo(0.2);
    expect([s.current, s.reached]).toEqual([null, ["IMPLEMENT"]]);
  });

  it("tracks human review and clears it on a decision", () => {
    let s = play([{ type: "human.required", runId: "r1", review }]);
    expect(s.humanReview?.reason).toBe("max_review_rounds");
    s = play([
      { type: "message", message: { from: "human", to: "orchestrator", kind: "decision", headline: "resume", items: [] } },
      { type: "step.completed", entry: { ...entry("HUMAN_REVIEW", "resume", "after max_review_rounds", "info"), agent: "human", round: 3 }, durationSec: 0 },
    ], s);
    expect(s.humanReview).toBeNull();
    const step = lastStep(s);
    expect([step.phase, step.round, step.agent]).toEqual(["HUMAN_REVIEW", 3, "human"]);
  });
});

describe("view reducer additions", () => {
  it("shows retries as activities and keeps the review details when a decision is deferred", () => {
    const s = play([
      phase("PLAN", "planner", "codex"),
      { type: "agent.retry", role: "planner", agent: "codex", attempt: 2, max: 2, reason: "output is not valid JSON\nmore" },
    ]);
    expect(s.current!.activities.map((a) => a.label)).toEqual(["↻ retry 2/2: output is not valid JSON"]);
    const deferred = play([
      { type: "human.required", runId: "r1", review },
      { type: "run.finished", runId: "r1", phase: "HUMAN_REVIEW", reportPath: "/r", exitCode: 2 },
    ]);
    expect(deferred.items.map((i) => i.kind)).toEqual(["review", "finish"]);
  });
});

describe("Ink components", () => {
  it("renders a finished step block", () => {
    const s = play([
      phase("PLAN_REVIEW", "plan_reviewer", "claude"),
      { type: "agent.activity", role: "plan_reviewer", agent: "claude", activity: { id: "r", kind: "read", label: "Read  calc.py", status: "ok" } },
      { type: "message", message: { from: "claude", to: "codex", kind: "critique", headline: "approved · 2 suggestion(s)", items: ["[low] C1 add a negative test", "[low] C2 docstring"] } },
      { type: "step.completed", entry: entry("PLAN_REVIEW", "approved", "2 issue(s), 0 blocking"), durationSec: 48, costUsd: 0.17 },
    ]);
    const frame = render(<StepBlock step={lastStep(s)} />).lastFrame()!;
    for (const text of ["PLAN_REVIEW r1", "Claude (plan critic)", "48s · $0.17", "Read  calc.py ✓", "Claude → Codex  approved · 2 suggestion(s)", "[low] C1 add a negative test"]) {
      expect(frame).toContain(text);
    }
  });

  it("truncates long lines in a narrow terminal", () => {
    const s = play([
      phase("IMPLEMENT", "implementer", "claude"),
      act("x", `Edit  ${"very/long/path/".repeat(10)}file.ts`, "ok"),
      { type: "step.completed", entry: entry("IMPLEMENT", "completed", "x".repeat(200), "warn"), durationSec: 1 },
    ]);
    const frame = render(<Box width={40}><StepBlock step={lastStep(s)} /></Box>).lastFrame()!;
    for (const line of frame.split("\n")) expect([...line].length).toBeLessThanOrEqual(40);
  });

  it("right-aligns the step header to the full width even when every line is short", () => {
    const s = play([
      phase("PLAN_REVIEW", "plan_reviewer", "claude"),
      { type: "message", message: { from: "claude", to: "codex", kind: "critique", headline: "approved", items: [] } },
      { type: "step.completed", entry: entry("PLAN_REVIEW", "approved", "0 issue(s)"), durationSec: 1, costUsd: 0.01 },
    ]);
    const header = render(<Box width={60}><StepBlock step={lastStep(s)} /></Box>).lastFrame()!.split("\n")[0]!;
    expect([...header].length).toBe(60);
    expect(header.endsWith("1s · $0.01")).toBe(true);
  });

  it("prints finished steps across the full terminal width", async () => {
    const bus = new EventBus();
    const app = render(<App bus={bus} version="0.1.0" verbose={false} interactive={false} onStop={noop} onInterrupt={noop} onDecision={noop} views={() => []} readView={async () => null} />);
    bus.emit(phase("PLAN_REVIEW", "plan_reviewer", "claude"));
    bus.emit({ type: "message", message: { from: "claude", to: "codex", kind: "critique", headline: "approved", items: [] } });
    bus.emit({ type: "step.completed", entry: entry("PLAN_REVIEW", "approved", "0 issue(s)"), durationSec: 1, costUsd: 0.01 });
    await wait();
    const header = app.frames.join("\n").split("\n").find((l) => l.includes("PLAN_REVIEW r1"))!;
    expect(header.endsWith("1s · $0.01")).toBe(true);
    expect([...header].length).toBe(100);
    app.unmount();
  });

  it("ends with a line that says how the run finished and what to do next", async () => {
    const cases: Array<[DuoEvent, string[]]> = [
      [{ type: "run.finished", runId: "r1", phase: "DONE", reportPath: "/runs/r1/report.md", exitCode: 0 }, ["DONE", "/runs/r1/report.md"]],
      [{ type: "run.finished", runId: "r1", phase: "INTERRUPTED", reportPath: "/x", exitCode: 130 }, ["Stopped", "duo resume r1"]],
      [{ type: "run.finished", runId: "r1", phase: "HUMAN_REVIEW", reportPath: "/x", exitCode: 2 }, ["duo resume r1 --decision resume|revise|abort"]],
      [{ type: "run.finished", runId: "r1", phase: "ABORTED", reportPath: "/x", exitCode: 3 }, ["Aborted"]],
    ];
    for (const [event, texts] of cases) {
      const bus = new EventBus();
      const app = render(<App bus={bus} version="0.1.0" verbose={false} interactive={false} onStop={noop} onInterrupt={noop} onDecision={noop} views={() => []} readView={async () => null} />);
      bus.emit(event);
      await wait();
      const output = app.frames.join("\n");
      for (const text of texts) expect(output, `${event.type === "run.finished" ? event.phase : ""}: ${text}`).toContain(text);
      app.unmount();
    }
  });

  it("shows the live footer with pipeline, agent, activities and cost", async () => {
    const bus = new EventBus();
    const app = render(<App bus={bus} version="0.1.0" verbose={false} interactive={false} onStop={noop} onInterrupt={noop} onDecision={noop} views={() => []} readView={async () => null} />);
    bus.emit({ type: "run.started", runId: "r1", task: "t", repo: "/repo", runDir: "/d" });
    bus.emit(phase("PLAN", "planner", "codex"));
    bus.emit({ type: "step.completed", entry: entry("PLAN", "plan created", "v1"), durationSec: 3 });
    bus.emit(phase("IMPLEMENT", "implementer", "claude", 2));
    bus.emit(act("a", "Bash  npm test", "running"));
    bus.emit({ type: "agent.usage", agent: "claude", costUsd: 0.41 });
    await wait();
    const frame = app.lastFrame()!;
    for (const text of ["PLAN ✓", "IMPLEMENT ● r2", "plan 1/4 · impl 2/5", "Claude (implementer)", "Bash  npm test", "$0.41"]) expect(frame).toContain(text);
    app.unmount();
  });

  it("lets the user pick a decision and type a note", async () => {
    const decisions: unknown[] = [];
    const ui = render(<HumanReviewPrompt review={review} views={["plan"]} onDecision={(d) => decisions.push(d)} onView={noop} />);
    expect(ui.lastFrame()).toContain("❯ Resume");
    await wait();
    ui.stdin.write("\u001B[B");
    await wait();
    expect(ui.lastFrame()).toContain("❯ Revise");
    ui.stdin.write("\r");
    await wait();
    ui.stdin.write("use redis");
    await wait();
    expect(ui.lastFrame()).toContain("use redis");
    ui.stdin.write("\r");
    await wait();
    expect(decisions).toEqual([{ decision: "revise", note: "use redis" }]);
  });

  it("offers artifact views and deferring", async () => {
    const views: string[] = [];
    const decisions: unknown[] = [];
    const ui = render(<HumanReviewPrompt review={review} views={["plan", "review"]} onDecision={(d) => decisions.push(d)} onView={(k) => views.push(k)} />);
    expect(ui.lastFrame()).toContain("View final plan");
    await wait();
    for (const key of ["\u001B[B", "\u001B[B", "\r"]) {
      ui.stdin.write(key);
      await wait();
    }
    expect(views).toEqual(["plan"]);
    for (const key of ["\u001B[A", "\u001B[A", "\u001B[A", "\r"]) {
      ui.stdin.write(key);
      await wait();
    }
    expect(decisions).toEqual(["defer"]);
  });

  it("prints the review reason and details when nobody can answer", async () => {
    const bus = new EventBus();
    const app = render(<App bus={bus} version="0.1.0" verbose={false} interactive={false} onStop={noop} onInterrupt={noop} onDecision={noop} views={() => []} readView={async () => null} />);
    bus.emit({ type: "human.required", runId: "r1", review });
    bus.emit({ type: "run.finished", runId: "r1", phase: "HUMAN_REVIEW", reportPath: "/r", exitCode: 2 });
    await wait();
    const output = app.frames.join("\n");
    for (const s of ["max_review_rounds", "not approved after 5 rounds", "F3 [high] src/auth.ts:42", "duo resume r1 --decision"]) expect(output).toContain(s);
    app.unmount();
  });

  it("treats Ctrl-C at the decision prompt as 'decide later'", async () => {
    const decisions: unknown[] = [];
    let interrupts = 0;
    const bus = new EventBus();
    const app = render(<App bus={bus} version="0.1.0" verbose={false} interactive onStop={noop} onInterrupt={() => { interrupts += 1; }}
      onDecision={(d) => decisions.push(d)} views={() => []} readView={async () => null} />);
    bus.emit({ type: "human.required", runId: "r1", review });
    await wait();
    app.stdin.write("\u0003");
    await wait();
    expect([decisions, interrupts]).toEqual([["defer"], 0]);
    app.unmount();
  });

  it("reports when the finish line has rendered", async () => {
    let settled = 0;
    const bus = new EventBus();
    const app = render(<App bus={bus} version="0.1.0" verbose={false} interactive={false} onStop={noop} onInterrupt={noop} onDecision={noop}
      views={() => []} readView={async () => null} onSettled={() => { settled += 1; }} />);
    await wait();
    expect(settled).toBe(0);
    bus.emit({ type: "run.finished", runId: "r1", phase: "DONE", reportPath: "/r", exitCode: 0 });
    await wait();
    expect(settled).toBe(1);
    app.unmount();
  });

  it("handles q when interactive", async () => {
    let stops = 0;
    const bus = new EventBus();
    const app = render(<App bus={bus} version="0.1.0" verbose={false} interactive onStop={() => { stops += 1; }} onInterrupt={noop} onDecision={noop} views={() => []} readView={async () => null} />);
    bus.emit(phase("PLAN", "planner", "codex"));
    await wait();
    app.stdin.write("q");
    await wait();
    expect(stops).toBe(1);
    expect(app.lastFrame()).toContain("stopping after this step");
    app.unmount();
  });
});
