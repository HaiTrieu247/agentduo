import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { EventBus, type Activity, type DuoEvent, type HistoryEntry, type PermissionAnswer, type PermissionRequest, type Phase, type Role } from "../src/events.js";
import { App } from "../src/ui/ink/App.js";
import { ChatApp, ChatChannel } from "../src/ui/ink/ChatApp.js";
import { HumanReviewPrompt } from "../src/ui/ink/HumanReviewPrompt.js";
import { PermissionPrompt } from "../src/ui/ink/PermissionPrompt.js";
import { StaticItemView } from "../src/ui/ink/App.js";
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
const ask = (id: string, rules = ["Bash(npm test:*)"]): PermissionRequest =>
  ({ id, tool: "Bash", label: "Bash  npm test", description: "Run the test suite", blockedPath: null, rules });
const requested = (request: PermissionRequest): DuoEvent => ({ type: "permission.requested", role: "implementer", agent: "claude", request });
const answered = (id: string, answer: PermissionAnswer): DuoEvent => ({ type: "permission.answered", role: "implementer", agent: "claude", id, answer });

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
      [{ type: "run.finished", runId: "r1", phase: "DONE", reportPath: "/runs/r1/report.md", exitCode: 0, summary: "the review approved; no quality gates configured" },
        ["DONE the review approved; no quality gates configured. Report: /runs/r1/report.md"]],
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

  it("queues permission prompts and keeps each answer in scrollback", () => {
    let s = play([requested(ask("p1")), requested(ask("p2"))]);
    expect(s.permissions.map((x) => x.request.id)).toEqual(["p1", "p2"]);
    s = play([answered("p1", { decision: "always" })], s);
    expect(s.permissions.map((x) => x.request.id)).toEqual(["p2"]);
    expect(s.items.at(-1)).toMatchObject({ kind: "permission", label: "Bash  npm test", answer: { decision: "always" }, rules: ["Bash(npm test:*)"] });
    s = play([{ type: "run.finished", runId: "r1", phase: "INTERRUPTED", reportPath: "/r", exitCode: 130 }], s);
    expect(s.permissions).toEqual([]);
  });

  it("asks for permission with once, always (with the rule) and deny, optionally with a message", async () => {
    const answers: unknown[] = [];
    const ui = render(<PermissionPrompt ask={{ role: "implementer", agent: "claude", request: { ...ask("p1"), blockedPath: "build/out.js" } }} onAnswer={(a) => answers.push(a)} />);
    const frame = ui.lastFrame()!;
    for (const text of ["Claude (implementer) asks to use Bash", "Bash  npm test", "Run the test suite", "build/out.js", "❯ Allow once",
      "Always allow Bash(npm test:*)", ".claude/settings.local.json", "Deny", "Deny with a message"]) expect(frame).toContain(text);
    await wait();
    ui.stdin.write("\u001B[B");
    await wait();
    ui.stdin.write("\r");
    await wait();
    expect(answers).toEqual([{ decision: "always" }]);
    const quiet = render(<PermissionPrompt ask={{ role: "plan_reviewer", agent: "claude", request: ask("p2", []) }} onAnswer={(a) => answers.push(a)} />);
    expect(quiet.lastFrame()).not.toContain("Always allow");
    await wait();
    for (const key of ["\u001B[B", "\u001B[B", "\r"]) {
      quiet.stdin.write(key);
      await wait();
    }
    quiet.stdin.write("use the npm script");
    await wait();
    quiet.stdin.write("\r");
    await wait();
    expect(answers.at(-1)).toEqual({ decision: "deny", message: "use the npm script" });
  });

  it("shows the oldest pending permission prompt and passes the answer on", async () => {
    const bus = new EventBus();
    const given: Array<[string, PermissionAnswer]> = [];
    const app = render(<App bus={bus} version="0.1.0" verbose={false} interactive onStop={noop} onInterrupt={noop} onDecision={noop}
      onPermission={(id, a) => given.push([id, a])} views={() => []} readView={async () => null} />);
    bus.emit(phase("IMPLEMENT", "implementer", "claude"));
    bus.emit(requested(ask("p1")));
    bus.emit(requested({ ...ask("p2"), label: "Bash  rm -rf build" }));
    await wait();
    expect(app.lastFrame()).toContain("Bash  npm test");
    expect(app.lastFrame()).not.toContain("rm -rf build");
    app.stdin.write("\r");
    await wait();
    expect(given).toEqual([["p1", { decision: "once" }]]);
    app.unmount();
  });

  it("chat: sends what you type on Enter, shows your lines and agentduo's, and Esc stops a running step", async () => {
    const bus = new EventBus();
    const channel = new ChatChannel();
    const sent: string[] = [];
    let escapes = 0;
    let ctrlC = 0;
    const app = render(<ChatApp bus={bus} channel={channel} version="0.2.0" workspace="/ws" verbose={false} onSubmit={(text) => sent.push(text)}
      onEscape={() => { escapes += 1; }} onCtrlC={() => { ctrlC += 1; }} onDecision={noop} onPermission={noop} views={() => []} readView={async () => null} />);
    await wait();
    expect(app.lastFrame()).toContain("agentduo 0.2.0 · chat");
    expect(app.lastFrame()).toContain("Ask Codex");
    app.stdin.write("Add JWT auth");
    await wait();
    expect(app.lastFrame()).toContain("› Add JWT auth");
    app.stdin.write("\r");
    await wait();
    expect(sent).toEqual(["Add JWT auth"]);
    channel.user("Add JWT auth");
    channel.status("running");
    bus.emit({ type: "run.started", runId: "r1", task: "Add JWT auth", repo: "/ws", runDir: "/d" });
    bus.emit(phase("PLAN", "planner", "codex"));
    await wait();
    const running = app.lastFrame()!;
    for (const text of ["› Add JWT auth", "── run r1 ──", "Codex (planner)", "next step", "Esc stops"]) expect(running).toContain(text);
    app.stdin.write("\u001B");
    await wait();
    expect(escapes).toBe(1);
    channel.info("Stopped PLAN. Type what to change");
    channel.status("paused");
    await wait();
    expect(app.lastFrame()).toContain("Stopped PLAN. Type what to change");
    app.stdin.write("\u0003");
    await wait();
    expect(ctrlC).toBe(1);
    app.unmount();
  });

  it("chat: Shift+Tab switches the edit mode, which the hint line shows", async () => {
    const channel = new ChatChannel();
    let cycles = 0;
    const app = render(<ChatApp bus={new EventBus()} channel={channel} version="0.3.0" workspace="/ws" verbose={false} onSubmit={noop} onEscape={noop}
      onCtrlC={noop} onCycleEdits={() => { cycles += 1; }} onDecision={noop} onPermission={noop} views={() => []} readView={async () => null} />);
    channel.edits("ask");
    await wait();
    expect(app.lastFrame()).toContain("edits: ask (Shift+Tab)");
    app.stdin.write("\u001B[Z");
    await wait();
    expect(cycles).toBe(1);
    channel.edits("auto");
    await wait();
    expect(app.lastFrame()).toContain("edits: auto (Shift+Tab)");
    app.unmount();
  });

  it("chat: a pasted line that ends with Enter is sent, and pasted line breaks stay in the message", async () => {
    const sent: string[] = [];
    const app = render(<ChatApp bus={new EventBus()} channel={new ChatChannel()} version="0.2.0" workspace="/ws" verbose={false} onSubmit={(text) => sent.push(text)}
      onEscape={noop} onCtrlC={noop} onDecision={noop} onPermission={noop} views={() => []} readView={async () => null} />);
    await wait();
    app.stdin.write("Add JWT auth\r");
    await wait();
    app.stdin.write("line one\rline two");
    await wait();
    app.stdin.write("\r");
    await wait();
    expect(sent).toEqual(["Add JWT auth", "line one\nline two"]);
    app.unmount();
  });

  it("chat: a permission prompt or a decision takes the place of the input line", async () => {
    const bus = new EventBus();
    const given: string[] = [];
    const app = render(<ChatApp bus={bus} channel={new ChatChannel()} version="0.2.0" workspace="/ws" verbose={false} onSubmit={noop} onEscape={noop} onCtrlC={noop}
      onDecision={noop} onPermission={(id) => given.push(id)} views={() => []} readView={async () => null} />);
    bus.emit(requested(ask("p1")));
    await wait();
    expect(app.lastFrame()).toContain("asks to use Bash");
    expect(app.lastFrame()).not.toContain("Type a task…"); // the input line's placeholder
    app.stdin.write("\r");
    await wait();
    expect(given).toEqual(["p1"]);
    bus.emit(answered("p1", { decision: "once" }));
    bus.emit({ type: "human.required", runId: "r1", review });
    await wait();
    expect(app.lastFrame()).toContain("Your decision is needed");
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

  it("chat: a discussion shows each turn by its step and verdict, then the final answer whole", () => {
    const model = { backend: "codex", requested: null, configured: null, resolved: "gpt-x", source: "doctor", isDefault: true, status: "resolved", reason: null } as const;
    const started = (id: string, backend: "codex" | "claude", step: "answer" | "critique", round: number): DuoEvent =>
      ({ type: "turn.started", conversationId: "c", turnId: id, backend, question: "Q?", model: { ...model, backend }, discussion: { id: "d", step, round } });
    const finished = (id: string, backend: "codex" | "claude", step: "answer" | "critique", round: number, answer: string, verdict?: "agree"): DuoEvent =>
      ({ type: "turn.finished", conversationId: "c", turnId: id, backend, status: "success", answer, error: null, model: { ...model, backend }, durationSec: 2, logDir: "/l", discussion: { id: "d", step, round, ...(verdict ? { verdict } : {}) } });
    let s = play([{ type: "discussion.started", conversationId: "c", discussionId: "d", question: "Q?", answerer: "codex", critic: "claude", maxRounds: 3 }, started("t1", "codex", "answer", 1)],
      initialView("0.1.0", false, { workspace: "/repo" }));
    expect(s.discussion).toMatchObject({ answerer: "codex", critic: "claude", maxRounds: 3 });
    expect(s.turn?.discussion).toMatchObject({ step: "answer", round: 1 });
    s = play([finished("t1", "codex", "answer", 1, "Use Postgres."), started("t2", "claude", "critique", 1), finished("t2", "claude", "critique", 1, "Right.", "agree"),
      { type: "discussion.finished", conversationId: "c", discussionId: "d", status: "agreed", answerer: "codex", critic: "claude", rounds: 1, answer: "Use Postgres.", error: null, durationSec: 4, costUsd: 0.2, logDir: "/l" }], s);
    expect(s.discussion).toBeNull();
    const frames = s.items.filter((i) => i.kind === "answer" || i.kind === "discussion").map((item) => render(<StaticItemView item={item} />).lastFrame() ?? "");
    expect(frames).toHaveLength(3);
    expect(frames[1]).toContain("review of version 1");
    expect(frames[1]).toContain("AGREE");
    expect(frames[2]).toContain("Discussion: Claude agreed after 1 review");
    expect(frames[2]).toContain("Use Postgres.");
    // The turns' usage counts once: the discussion's total is not added again.
    expect(s.totals.costUsd).toBe(0);
  });
});
