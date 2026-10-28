import { describe, expect, it } from "vitest";
import type { PipelineStep } from "../extensions/vscode/src/protocol.js";
import {
  canSubmit, decisionChoices, initialState, MAX_ACTIVITIES, MAX_TIMELINE, permissionChoices, pipelineView, placeholder, reduce, type ViewAction,
  type ViewState,
} from "../extensions/vscode/webview/state.js";
import type { Activity, DuoEvent, HistoryEntry, HumanReview, PermissionRequest } from "../src/events.js";

const ev = (event: DuoEvent): ViewAction => ({ type: "event", event, now: 1000 });
const run = (s: ViewState, ...actions: ViewAction[]) => actions.reduce(reduce, s);
const phase = (p: "PLAN" | "IMPLEMENT" | "VERIFY" | "CODE_REVIEW", step = 1): DuoEvent => ({
  type: "phase.started", step, phase: p, round: 1, role: p === "PLAN" ? "planner" : "implementer", agent: p === "VERIFY" ? "gates" : "claude",
  planning: { round: 1, limit: 4 }, impl: { round: 1, limit: 5 },
});
const act = (id: string, status: Activity["status"] = "running"): DuoEvent => ({ type: "agent.activity", role: "implementer", agent: "claude", activity: { id, kind: "read", label: `Read  ${id}`, status } });
const entry = (p: HistoryEntry["phase"], step: number): HistoryEntry => ({ step, phase: p, round: 1, agent: "Claude", status: "completed", summary: "s", kind: "ok", at: "t", artifact: null });
const review: HumanReview = { reason: "plan_ready", message: "ready", fromPhase: "PLAN_FINALIZE", resumePhase: "IMPLEMENT", details: [], at: "t" };
const request = (id: string, rules: string[] = []): PermissionRequest => ({ id, tool: "Bash", label: "Bash  npm test", description: null, blockedPath: null, rules });
const PIPELINE: PipelineStep[] = [
  { phase: "PLAN", label: "PLAN", role: "planner", agent: "codex" },
  { phase: "IMPLEMENT", label: "IMPLEMENT", role: "implementer", agent: "claude" },
  { phase: "CODE_REVIEW", label: "REVIEW", role: "code_reviewer", agent: "codex" },
];

describe("view state", () => {
  it("updates an activity in place by id instead of appending it twice, and keeps only the latest ones", () => {
    let s = run(initialState("active"), ev(phase("IMPLEMENT")), ev(act("a")), ev(act("a", "ok")));
    expect(s.current!.activities).toEqual([expect.objectContaining({ id: "a", status: "ok" })]);
    for (let i = 0; i < MAX_ACTIVITIES + 5; i++) s = reduce(s, ev(act(`x${i}`, "ok")));
    expect(s.current!.activities).toHaveLength(MAX_ACTIVITIES);
    expect(s.current!.dropped).toBe(6);
    expect(s.current!.activities.at(-1)!.id).toBe(`x${MAX_ACTIVITIES + 4}`);
  });

  it("adds live usage of the running call to the totals once, when its step completes", () => {
    let s = run(initialState("active"), ev(phase("PLAN")), ev({ type: "agent.usage", agent: "codex", costUsd: 0.01, tokens: 500 }),
      ev({ type: "agent.usage", agent: "codex", tokens: 900 }));
    expect([s.live, s.totals]).toEqual([{ costUsd: 0.01, tokens: 900 }, { costUsd: 0, tokens: 0 }]);
    s = reduce(s, ev({ type: "step.completed", entry: entry("PLAN", 1), durationSec: 2, costUsd: 0.02, tokens: 1234 }));
    expect([s.live, s.totals, s.current]).toEqual([{ costUsd: 0, tokens: 0 }, { costUsd: 0.02, tokens: 1234 }, null]);
    expect(s.timeline.at(-1)).toMatchObject({ kind: "step", step: { phase: "PLAN", tokens: 1234 } });
  });

  it("tracks gates, retries, permission prompts and their answers", () => {
    let s = run(initialState("active"), ev(phase("VERIFY")), ev({ type: "gate.started", name: "test", command: "npm test" }),
      ev({ type: "gate.completed", name: "test", command: "npm test", passed: false, exitCode: 1 }),
      ev({ type: "agent.retry", role: "implementer", agent: "claude", attempt: 2, max: 2, reason: "bad json\nmore" }));
    expect(s.current!.activities.map((a) => [a.id, a.status])).toEqual([["gate-test", "error"], ["retry-implementer-2", "error"]]);
    s = run(s, ev({ type: "permission.requested", role: "implementer", agent: "claude", request: request("p1") }),
      ev({ type: "permission.requested", role: "implementer", agent: "claude", request: request("p1") }));
    expect(s.permissions).toHaveLength(1);
    s = reduce(s, ev({ type: "permission.answered", role: "implementer", agent: "claude", id: "p1", answer: { decision: "deny", message: "no" } }));
    expect(s.permissions).toEqual([]);
    expect(s.timeline.at(-1)).toMatchObject({ kind: "permission", answer: { decision: "deny", message: "no" } });
  });

  it("opens and closes a decision by id, keeps a deferred one in the timeline, and clears questions when a run ends", () => {
    let s = run(initialState("active"), { type: "decision.open", id: "d1", review, views: ["plan"] }, { type: "decision.closed", id: "d0" });
    expect(s.decision?.id).toBe("d1");
    s = run(s, ev({ type: "permission.requested", role: "implementer", agent: "claude", request: request("p1") }),
      ev({ type: "run.finished", runId: "r", phase: "HUMAN_REVIEW", reportPath: "/r", exitCode: 2 }));
    expect([s.decision, s.permissions]).toEqual([null, []]);
    expect(s.timeline.slice(-2).map((i) => i.kind)).toEqual(["review", "finish"]);
  });

  it("forgets the questions of a worker that is gone, and starts over for another folder", () => {
    const s = run(initialState("active", "/ws", 1), { type: "decision.open", id: "d1", review, views: [] }, { type: "user", text: "hi" });
    const restarted = reduce(s, { type: "workspace", session: "starting", workspace: "/ws", generation: 2 });
    expect([restarted.decision, restarted.generation, restarted.timeline.length]).toEqual([null, 2, 1]);
    const other = reduce(s, { type: "workspace", session: "starting", workspace: "/other", generation: 3 });
    expect([other.workspace, other.timeline.length]).toEqual(["/other", 0]);
  });

  it("keeps the timeline bounded", () => {
    let s = initialState("active");
    for (let i = 0; i < MAX_TIMELINE + 10; i++) s = reduce(s, { type: "note", text: `n${i}`, tone: "info" });
    expect(s.timeline).toHaveLength(MAX_TIMELINE);
    expect(s.dropped).toBe(10);
    expect(new Set(s.timeline.map((i) => i.id)).size).toBe(MAX_TIMELINE);
  });

  it("shows VERIFY only when the config has gates or the run reached it", () => {
    const s = { ...initialState("active"), pipeline: PIPELINE };
    expect(pipelineView(s).map((p) => p.phase)).toEqual(["PLAN", "IMPLEMENT", "CODE_REVIEW"]);
    const reached = run(s, ev(phase("PLAN")), ev({ type: "step.completed", entry: entry("PLAN", 1), durationSec: 1 }), ev(phase("IMPLEMENT", 2)),
      ev({ type: "step.completed", entry: entry("IMPLEMENT", 2), durationSec: 1 }), ev(phase("VERIFY", 3)));
    expect(pipelineView(reached).map((p) => `${p.label}:${p.status}`)).toEqual(["PLAN:done", "IMPLEMENT:done", "VERIFY:active", "REVIEW:pending"]);
  });

  it("marks the phase a run was stopped in as stopped, not done, until a step starts again", () => {
    const s = { ...initialState("active"), pipeline: PIPELINE };
    const stopped = run(s, ev({ type: "run.started", runId: "r", task: "t", repo: "/repo", runDir: "/repo/.agentduo/runs/r" }), ev(phase("PLAN")), ev({ type: "step.completed", entry: entry("PLAN", 1), durationSec: 1 }),
      ev(phase("IMPLEMENT", 2)), ev({ type: "run.finished", runId: "r", phase: "INTERRUPTED", reportPath: "x", exitCode: 130 }));
    expect(pipelineView(stopped).map((p) => `${p.label}:${p.status}`)).toEqual(["PLAN:done", "IMPLEMENT:stopped", "REVIEW:pending"]);
    expect(pipelineView(run(stopped, ev(phase("IMPLEMENT", 2)))).map((p) => p.status)).toEqual(["done", "active", "pending"]);
    const finished = run(s, ev(phase("PLAN")), ev({ type: "run.finished", runId: "r", phase: "HUMAN_REVIEW", reportPath: "x", exitCode: 3 }));
    expect(finished.stopped).toBeNull();
  });

  it("offers the CLI's choices: Always allow only with a rule to save, resume hints by reason", () => {
    expect(permissionChoices(request("p")).map((c) => c.key)).toEqual(["once", "deny"]);
    expect(permissionChoices(request("p", ["Bash(npm test:*)"])).map((c) => c.label)).toEqual(["Allow once", "Always allow Bash(npm test:*)", "Deny"]);
    expect(decisionChoices(review).map((c) => c.key)).toEqual(["resume", "revise", "abort", "defer"]);
    expect(decisionChoices(review)[0]!.hint).toBe("start implementation");
  });

  it("says what a message does in each state", () => {
    expect(placeholder({ ...initialState("active"), status: "idle" })).toMatch(/^Type a task/);
    expect(placeholder({ ...initialState("active"), status: "running" })).toContain("next step");
    expect(placeholder({ ...initialState("active"), status: "paused" })).toContain("re-runs the stopped step");
    expect(placeholder(initialState("no-folder"))).toContain("Open a folder");
    expect([canSubmit(initialState("choose-folder")), canSubmit(initialState("dormant"))]).toEqual([false, true]);
  });
});
