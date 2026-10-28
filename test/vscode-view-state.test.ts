import { describe, expect, it } from "vitest";
import type { PipelineStep } from "../extensions/vscode/src/protocol.js";
import {
  activityParts, canSubmit, decisionChoices, effortOptions, initialState, MAX_ACTIVITIES, MAX_ANSWER_CHARS, MAX_TIMELINE, modelOptions, permissionChoices, pipelineView,
  placeholder, reduce, runInProgress, type TimelineItem, type ViewAction, type ViewState,
} from "../extensions/vscode/webview/state.js";
import type { Activity, DuoEvent, HistoryEntry, HumanReview, ModelIdentity, PermissionRequest } from "../src/events.js";
import { CLAUDE_MODELS } from "../src/core/commands.js";
import type { SettingsView } from "../src/core/settings.js";

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
const model: ModelIdentity = {
  backend: "codex", requested: null, configured: null, resolved: "gpt-fake", source: "doctor", isDefault: true, status: "resolved", reason: null,
};
/** A question of the chat (its turn id is its text) and Codex's answer. */
const ask = (s: ViewState, q: string, answer: string) => run(s, { type: "user", text: q },
  ev({ type: "turn.started", conversationId: "c", turnId: q, backend: "codex", question: q, model }),
  ev({ type: "turn.finished", conversationId: "c", turnId: q, backend: "codex", status: "success", answer, error: null, model, durationSec: 1, logDir: "/logs" }));
const items = (s: ViewState) => s.timeline.map((i) => (i.kind === "user" ? `user:${i.text}` : i.kind === "answer" ? `answer:${i.turn.turnId}` : i.kind));
/** A /discuss turn of discussion "d": started and finished, Codex answering and Claude reviewing. */
const discussTurn = (id: string, step: "answer" | "critique" | "revise", round: number, answer: string, o: { verdict?: "agree" | "revise"; costUsd?: number } = {}): ViewAction[] => {
  const backend = step === "critique" ? "claude" : "codex";
  const m = { ...model, backend } as const;
  return [
    ev({ type: "turn.started", conversationId: "c", turnId: id, backend, question: "Which queue?", model: m, discussion: { id: "d", step, round } }),
    ev({
      type: "turn.finished", conversationId: "c", turnId: id, backend, status: "success", answer, error: null, model: m, durationSec: 1, costUsd: o.costUsd, logDir: "/logs",
      discussion: { id: "d", step, round, ...(o.verdict ? { verdict: o.verdict } : {}) },
    }),
  ];
};
const discussStarted = ev({ type: "discussion.started", conversationId: "c", discussionId: "d", question: "Which queue?", answerer: "codex", critic: "claude", maxRounds: 3 });
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

  it("drops older turns whole past the answer budget, and keeps the latest answer and its question however long", () => {
    let s = ask(initialState("active"), "q1", "a".repeat(1_500_000));
    s = ask(s, "q2", "b".repeat(MAX_ANSWER_CHARS + 10));
    expect(items(s)).toEqual(["user:q2", "answer:q2"]);
    expect(s.dropped).toBe(2);
    expect((s.timeline[1] as Extract<TimelineItem, { kind: "answer" }>).turn.answer).toHaveLength(MAX_ANSWER_CHARS + 10);
    // Notices after an oversized answer are kept: they hold no answer text.
    s = run(s, { type: "note", text: "n", tone: "info" });
    expect(items(s)).toEqual(["user:q2", "answer:q2", "info"]);
    s = ask(s, "q3", "c");
    expect(items(s)).toEqual(["user:q3", "answer:q3"]);
  });

  it("keeps the latest question and answer when notices after it fill the timeline", () => {
    let s = ask(initialState("active"), "q", "a");
    for (let i = 0; i < MAX_TIMELINE + 50; i++) s = reduce(s, { type: "note", text: `n${i}`, tone: "info" });
    expect(s.timeline).toHaveLength(MAX_TIMELINE);
    expect(items(s).slice(0, 3)).toEqual(["user:q", "answer:q", "info"]);
    expect(s.timeline.at(-1)).toMatchObject({ kind: "info", text: `n${MAX_TIMELINE + 49}` });
    expect(s.dropped).toBe(52);
  });

  it("drops a whole older turn, never half of it, when the items run over", () => {
    let s = ask(ask(initialState("active"), "q1", "a1"), "q2", "a2");
    for (let i = 0; i < MAX_TIMELINE - 4; i++) s = reduce(s, { type: "note", text: `n${i}`, tone: "info" });
    expect(s.timeline).toHaveLength(MAX_TIMELINE);
    s = reduce(s, { type: "note", text: "over", tone: "info" });
    expect(items(s).slice(0, 2)).toEqual(["user:q2", "answer:q2"]);
    expect([s.timeline.length, s.dropped]).toEqual([MAX_TIMELINE - 1, 2]);
  });

  it("goes on from a snapshot exactly as the host does, trimming the same items", () => {
    let host = ask(initialState("active"), "q1", "a".repeat(1_200_000));
    for (let i = 0; i < MAX_TIMELINE - 10; i++) host = reduce(host, { type: "note", text: `n${i}`, tone: "info" });
    let view: ViewState = JSON.parse(JSON.stringify(host));
    const next = (s: ViewState) => {
      s = ask(s, "q2", "b".repeat(1_200_000));
      for (let i = 0; i < 20; i++) s = reduce(s, { type: "note", text: `m${i}`, tone: "info" });
      return s;
    };
    host = next(host);
    view = next(view);
    expect(view).toEqual(host);
    expect(items(view).slice(0, 2)).toEqual(["user:q2", "answer:q2"]);
    expect(view.timeline.length).toBeLessThanOrEqual(MAX_TIMELINE);
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
    expect(placeholder({ ...initialState("active"), status: "idle" })).toMatch(/^Ask Codex…/);
    expect(placeholder({ ...initialState("active"), status: "running" })).toContain("next step");
    expect(placeholder({ ...initialState("active"), status: "paused" })).toContain("/resume continues the stopped run");
    expect(placeholder(initialState("no-folder"))).toContain("Open a folder");
    expect(placeholder({ ...initialState("active"), status: "idle" }, "pipeline")).toMatch(/^A task for the pipeline/);
    expect(placeholder({ ...initialState("active"), status: "running" }, "pipeline")).toContain("next step");
    expect(placeholder({ ...initialState("active"), status: "idle" }, "discuss")).toMatch(/^A question to discuss: Codex answers, Claude reviews/);
    expect([canSubmit(initialState("choose-folder")), canSubmit(initialState("dormant"))]).toEqual([false, true]);
  });

  it("shows the pipeline's progress while a run is under way or waiting for you, not once it is over", () => {
    const started = run({ ...initialState("active"), pipeline: PIPELINE }, ev({ type: "run.started", runId: "r", task: "t", repo: "/repo", runDir: "/repo/.agentduo/runs/r" }), ev(phase("PLAN")));
    expect(runInProgress(initialState("active"))).toBe(false);
    expect(runInProgress(started)).toBe(true);
    const finish = (p: string): DuoEvent => ({ type: "run.finished", runId: "r", phase: p as "DONE", reportPath: "x", exitCode: 0 });
    expect(runInProgress(run(started, ev(finish("HUMAN_REVIEW"))))).toBe(true);
    expect(runInProgress(run(started, ev(finish("INTERRUPTED"))))).toBe(true);
    const done = run(started, ev(finish("DONE")));
    expect(runInProgress(done)).toBe(false);
    expect(runInProgress(run(done, ev({ type: "run.started", runId: "r", task: "t", repo: "/repo", runDir: "/repo/.agentduo/runs/r" })))).toBe(true);
  });

  it("names the tool of an activity apart from what it worked on", () => {
    const a = (kind: Activity["kind"], label: string, more: Partial<Activity> = {}): Activity => ({ id: "a", kind, label, status: "ok", ...more });
    expect(activityParts(a("command", "Bash  npm test"))).toEqual({ tool: "Bash", text: "npm test", diff: null });
    expect(activityParts(a("command", "exec  rg -n foo", { status: "error", exitCode: 1 }))).toEqual({ tool: "Run", text: "rg -n foo (exit 1)", diff: null });
    expect(activityParts(a("edit", "Write src/a.ts", { added: 3, removed: 0 }))).toEqual({ tool: "Write", text: "src/a.ts", diff: { added: 3, removed: 0 } });
    expect(activityParts(a("edit", "edit  src/a.ts", { status: "denied" }))).toEqual({ tool: "Edit", text: "src/a.ts denied", diff: null });
    expect(activityParts(a("command", "gate  test: npm test"))).toEqual({ tool: "Gate", text: "test: npm test", diff: null });
    expect(activityParts(a("say", "Looking at  the code"))).toEqual({ tool: null, text: "Looking at  the code", diff: null });
    expect(activityParts(a("other", "↻ retry 1/3: timeout", { status: "error" }))).toEqual({ tool: null, text: "↻ retry 1/3: timeout", diff: null });
  });

  const settings = (o: { claudeModel?: string | null; codexModel?: string | null; codexEffort?: string | null } = {}): ViewAction => ({
    type: "ui", update: {
      type: "settings", settings: {
        claude: { model: o.claudeModel ?? null, effort: null, edits: "ask", allow: [], deny: [], addDirs: [] },
        codex: { model: o.codexModel ?? null, effort: o.codexEffort ?? null, permissions: "default" },
      } satisfies SettingsView,
    },
  });
  const catalog: ViewAction = {
    type: "ui", update: {
      type: "catalog", codex: {
        models: [
          { id: "gpt-one", label: "One", description: "first", efforts: ["low", "high", "ultra"], defaultEffort: "low" },
          { id: "gpt-two", label: "Two", description: "second", efforts: null, defaultEffort: null },
        ], reason: null,
      },
    },
  };

  it("lists the models each agent offers for the settings' picker, and the one set even when it is not among them", () => {
    const s = run(initialState("active"), settings({ claudeModel: "claude-opus-5-5", codexModel: "gpt-two" }), { type: "ui", update: { type: "models", models: { claude: { ...model, backend: "claude" }, codex: model } } });
    const claude = modelOptions(s, "claude");
    expect(claude.value).toBe("claude-opus-5-5");
    expect(claude.options.map((o) => o.value)).toEqual(["default", "claude-opus-5-5", ...CLAUDE_MODELS.map((m) => m.id)]);
    expect(claude.options[0]!.detail).toContain("gpt-fake");
    // Codex's own list comes from its catalog; until then the picker says so and keeps what is set.
    expect(modelOptions(s, "codex")).toMatchObject({ value: "gpt-two", note: expect.stringContaining("Reading") });
    expect(modelOptions(s, "codex").options.map((o) => o.value)).toEqual(["default", "gpt-two"]);
    const listed = modelOptions(reduce(s, catalog), "codex");
    expect(listed.note).toBeNull();
    expect(listed.options.map((o) => `${o.value}:${o.label}`)).toEqual(["default:Default", "gpt-one:One", "gpt-two:Two"]);
    const failed = reduce(s, { type: "ui", update: { type: "catalog", codex: { models: [], reason: "codex debug models failed (exit code 1)" } } });
    expect(modelOptions(failed, "codex").note).toContain("exit code 1");
  });

  it("offers the reasoning efforts the Codex model takes that agentduo can set, and Default only while none is set", () => {
    const s = reduce(run(initialState("active"), settings({ codexModel: "gpt-one" })), catalog);
    expect(effortOptions(s, "codex")).toMatchObject({ value: "default" });
    expect(effortOptions(s, "codex").options.map((o) => o.value)).toEqual(["default", "low", "high"]);
    // /codex model keeps an effort once set: Default would not clear it, so it is not offered then.
    const set = reduce(s, settings({ codexModel: "gpt-one", codexEffort: "high" }));
    expect(effortOptions(set, "codex")).toMatchObject({ value: "high" });
    expect(effortOptions(set, "codex").options.map((o) => o.value)).toEqual(["low", "high"]);
    // A model the catalog does not describe takes every effort agentduo knows.
    expect(effortOptions(reduce(s, settings({ codexModel: "gpt-two" })), "codex").options.map((o) => o.value)).toEqual(["default", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(effortOptions(s, "claude").options.map((o) => o.value)).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
  });

  it("gathers a discussion's turns into one item, live until it is over, each turn's usage counted once", () => {
    let s = run(initialState("active"), { type: "user", text: "Which queue?", discuss: true }, discussStarted, discussTurn("t1", "answer", 1, "v1", { costUsd: 0.1 })[0]!);
    expect(s.discussion).toMatchObject({ id: "d", answerer: "codex", critic: "claude", maxRounds: 3, turns: [] });
    expect(s.turn?.discussion).toMatchObject({ step: "answer", round: 1 });
    s = run(s, discussTurn("t1", "answer", 1, "v1", { costUsd: 0.1 })[1]!, ...discussTurn("t2", "critique", 1, "Right.", { verdict: "agree", costUsd: 0.2 }));
    expect(s.discussion!.turns.map((t) => `${t.discussion?.step}:${t.answer}`)).toEqual(["answer:v1", "critique:Right."]);
    expect(s.timeline.map((i) => i.kind)).toEqual(["user"]);
    s = reduce(s, ev({
      type: "discussion.finished", conversationId: "c", discussionId: "d", status: "agreed", answerer: "codex", critic: "claude", rounds: 1, answer: "v1", error: null,
      durationSec: 2, costUsd: 0.3, logDir: "/logs",
    }));
    expect([s.discussion, s.turn]).toEqual([null, null]);
    expect(items(s)).toEqual(["user:Which queue?", "discussion"]);
    const item = s.timeline.at(-1)!;
    expect(item.kind === "discussion" && item.discussion).toMatchObject({ status: "agreed", rounds: 1, answer: "v1", turns: [expect.objectContaining({ answer: "v1" }), expect.objectContaining({ answer: "Right." })] });
    expect(s.totals.costUsd).toBeCloseTo(0.3);
    expect(s.timeline[0]).toMatchObject({ kind: "user", discuss: true });
  });

  it("says the agents are discussing while a discussion goes on", () => {
    const s = run({ ...initialState("active"), status: "answering" }, discussStarted);
    expect(placeholder(s)).toBe("Codex and Claude are discussing… (Esc stops it)");
  });

  it("marks a typed /discuss as one, as the Discuss route does", () => {
    const s = run(initialState("active"), { type: "user", text: "/discuss Which queue?" }, discussStarted);
    expect(s.timeline[0]).toMatchObject({ kind: "user", text: "/discuss Which queue?", discuss: true });
  });

  it("counts a discussion's text toward the answers kept, and keeps the latest discussion with its question", () => {
    let s = ask(initialState("active"), "q1", "a".repeat(MAX_ANSWER_CHARS));
    s = run(s, { type: "user", text: "Which queue?", discuss: true }, discussStarted, ...discussTurn("t1", "answer", 1, "v1"), ...discussTurn("t2", "critique", 1, "ok", { verdict: "agree" }));
    expect(items(s)).toEqual(["user:q1", "answer:q1", "user:Which queue?"]);
    s = reduce(s, ev({ type: "discussion.finished", conversationId: "c", discussionId: "d", status: "agreed", answerer: "codex", critic: "claude", rounds: 1, answer: "v1", error: null, durationSec: 2, logDir: "/l" }));
    expect(items(s)).toEqual(["user:Which queue?", "discussion"]);
  });
});
