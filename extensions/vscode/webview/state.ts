// What the sidebar shows, as plain data. The extension host keeps one copy (so a hidden or reloaded view gets a
// snapshot) and the webview another, both driven by the same actions through `reduce`. No DOM here.
import type { ChatStatus } from "../../../src/chat.js";
import type { Activity, DuoEvent, HistoryEntry, HumanReview, Message, Party, PermissionAnswer, PermissionRequest, Phase, Role, RoundInfo } from "../../../src/events.js";
import { resumeHint } from "../../../src/ui/format.js";
import type { ArtifactName, DecisionChoice, PipelineStep, Problem, UiUpdate } from "../src/protocol.js";

/** Kept in the view; older items stay in the run's files (events.jsonl, report.md, logs/). */
export const MAX_TIMELINE = 400;
export const MAX_ACTIVITIES = 150;

/**
 * no-folder / choose-folder: nothing to run in yet; starting: the worker is coming up; dormant: ready, no lock held;
 * active: a chat session holds the workspace lock; ended: /quit gave it back; stopped: the worker is gone.
 */
export type SessionState = "no-folder" | "choose-folder" | "starting" | "dormant" | "active" | "ended" | "stopped";

export interface StepCard {
  phase: Phase;
  round: number;
  role?: Role;
  agent?: Party;
  startedAt: number;
  activities: Activity[];
  /** Activities dropped from the view to keep it light (the run's logs keep them all). */
  dropped: number;
  message?: Message;
  entry?: HistoryEntry;
  durationSec?: number;
  costUsd?: number;
  tokens?: number;
}

export type TimelineItem = { id: string } & (
  | { kind: "user"; text: string }
  | { kind: "info"; text: string; tone: "info" | "error" }
  | { kind: "run"; runId: string; task: string }
  | { kind: "step"; step: StepCard }
  | { kind: "warning"; text: string }
  | { kind: "permission"; agent: Party; role: Role; label: string; rules: string[]; answer: PermissionAnswer }
  | { kind: "review"; review: HumanReview }
  | { kind: "finish"; phase: string; runId: string; summary?: string }
);

export interface PendingPermission {
  role: Role;
  agent: Party;
  request: PermissionRequest;
}

export interface PendingDecision {
  id: string;
  review: HumanReview;
  views: ArtifactName[];
}

export interface ViewState {
  /** The worker the pending questions belong to; answers carry it back so a stale one is refused. */
  generation: number;
  session: SessionState;
  workspace: string | null;
  version: string | null;
  pipeline: PipelineStep[];
  status: ChatStatus;
  edits: string;
  problem: Problem | null;
  run: { id: string; task: string } | null;
  current: StepCard | null;
  reached: Phase[];
  /** The phase whose step was stopped (Esc, /stop): reached, but not done. */
  stopped: Phase | null;
  planning: RoundInfo;
  impl: RoundInfo;
  totals: { costUsd: number; tokens: number };
  live: { costUsd: number; tokens: number };
  decision: PendingDecision | null;
  permissions: PendingPermission[];
  timeline: TimelineItem[];
  /** Timeline items dropped from the front. */
  dropped: number;
  seq: number;
}

export type ViewAction =
  | { type: "event"; event: DuoEvent; now: number }
  | { type: "ui"; update: UiUpdate }
  | { type: "user"; text: string }
  | { type: "note"; text: string; tone: "info" | "error" }
  | { type: "workspace"; session: SessionState; workspace: string | null; generation: number }
  | { type: "initialized"; version: string; workspace: string; pipeline: PipelineStep[]; edits: string }
  | { type: "problem"; problem: Problem | null }
  | { type: "decision.open"; id: string; review: HumanReview; views: ArtifactName[] }
  | { type: "decision.closed"; id: string };

export function initialState(session: SessionState = "starting", workspace: string | null = null, generation = 0): ViewState {
  return {
    generation, session, workspace, version: null, pipeline: [], status: "idle", edits: "ask", problem: null, run: null, current: null, reached: [], stopped: null,
    planning: { round: 1, limit: 0 }, impl: { round: 0, limit: 0 }, totals: { costUsd: 0, tokens: 0 }, live: { costUsd: 0, tokens: 0 },
    decision: null, permissions: [], timeline: [], dropped: 0, seq: 0,
  };
}

type ItemContent = TimelineItem extends infer T ? (T extends { id: string } ? Omit<T, "id"> : never) : never;

function push(s: ViewState, item: ItemContent): ViewState {
  const timeline = [...s.timeline, { ...item, id: `${item.kind}-${s.seq}` } as TimelineItem];
  const over = Math.max(0, timeline.length - MAX_TIMELINE);
  return { ...s, timeline: over ? timeline.slice(over) : timeline, dropped: s.dropped + over, seq: s.seq + 1 };
}

function newStep(phase: Phase, round: number, now: number, role?: Role, agent?: Party): StepCard {
  return { phase, round, role, agent, startedAt: now, activities: [], dropped: 0 };
}

/** Activities are re-sent with the same id when their status changes: update in place, never append twice. */
function withActivity(s: ViewState, activity: Activity): ViewState {
  const cur = s.current;
  if (!cur) return s;
  const i = cur.activities.findIndex((a) => a.id === activity.id);
  let activities: Activity[];
  let dropped = cur.dropped;
  if (i >= 0) {
    activities = cur.activities.slice();
    activities[i] = activity;
  } else {
    activities = [...cur.activities, activity];
    if (activities.length > MAX_ACTIVITIES) {
      dropped += activities.length - MAX_ACTIVITIES;
      activities = activities.slice(-MAX_ACTIVITIES);
    }
  }
  return { ...s, current: { ...cur, activities, dropped } };
}

function onEvent(s: ViewState, e: DuoEvent, now: number): ViewState {
  switch (e.type) {
    case "run.started":
      return push({ ...s, run: { id: e.runId, task: e.task }, reached: [], stopped: null, current: null }, { kind: "run", runId: e.runId, task: e.task });
    case "phase.started":
      return {
        ...s, current: newStep(e.phase, e.round, now, e.role, e.agent), stopped: null, planning: e.planning, impl: e.impl,
        reached: s.reached.includes(e.phase) ? s.reached : [...s.reached, e.phase], live: { costUsd: 0, tokens: 0 },
      };
    case "agent.activity":
      return withActivity(s, e.activity);
    case "agent.retry":
      return withActivity(s, { id: `retry-${e.role}-${e.attempt}`, kind: "other", label: `↻ retry ${e.attempt}/${e.max}: ${e.reason.split("\n")[0]}`, status: "error" });
    case "agent.usage":
      return { ...s, live: { costUsd: e.costUsd ?? s.live.costUsd, tokens: e.tokens ?? s.live.tokens } };
    case "gate.started":
      return withActivity(s, { id: `gate-${e.name}`, kind: "command", label: `gate  ${e.name}: ${e.command}`, status: "running" });
    case "gate.completed":
      return withActivity(s, {
        id: `gate-${e.name}`, kind: "command", label: `gate  ${e.name}: ${e.command}`, status: e.passed ? "ok" : "error", exitCode: e.exitCode ?? undefined,
      });
    case "message": {
      const current = s.current ?? newStep("HUMAN_REVIEW", 0, now, undefined, e.message.from);
      return { ...s, current: { ...current, message: e.message } };
    }
    case "step.completed": {
      const base = s.current ?? newStep(e.entry.phase, e.entry.round, now);
      const step: StepCard = { ...base, round: base.round || e.entry.round, entry: e.entry, durationSec: e.durationSec, costUsd: e.costUsd, tokens: e.tokens };
      return {
        ...push({ ...s, current: null }, { kind: "step", step }),
        // Per-step usage is final for its agent call; the live figures were running totals of that same call.
        totals: { costUsd: s.totals.costUsd + (e.costUsd ?? 0), tokens: s.totals.tokens + (e.tokens ?? 0) },
        live: { costUsd: 0, tokens: 0 },
      };
    }
    case "warning":
      return push(s, { kind: "warning", text: e.text });
    case "human.required":
      return { ...s, current: null };
    case "permission.requested":
      if (s.permissions.some((p) => p.request.id === e.request.id)) return s;
      return { ...s, permissions: [...s.permissions, { role: e.role, agent: e.agent, request: e.request }] };
    case "permission.answered": {
      const ask = s.permissions.find((p) => p.request.id === e.id);
      const rest = { ...s, permissions: s.permissions.filter((p) => p.request.id !== e.id) };
      return ask ? push(rest, { kind: "permission", agent: ask.agent, role: ask.role, label: ask.request.label, rules: ask.request.rules, answer: e.answer }) : rest;
    }
    case "run.finished": {
      // A deferred decision keeps its reason in the timeline.
      const review = e.phase === "HUMAN_REVIEW" && s.decision ? push(s, { kind: "review", review: s.decision.review }) : s;
      return {
        ...push(review, { kind: "finish", phase: e.phase, runId: e.runId, summary: e.summary }),
        current: null, stopped: e.phase === "INTERRUPTED" ? s.current?.phase ?? null : null, permissions: [], decision: null, live: { costUsd: 0, tokens: 0 },
      };
    }
    default:
      return s;
  }
}

function onUi(s: ViewState, u: UiUpdate): ViewState {
  switch (u.type) {
    case "info":
      return push(s, { kind: "info", text: u.text, tone: "info" });
    case "status":
      return { ...s, status: u.status };
    case "edits":
      return { ...s, edits: u.mode };
    case "pipeline":
      return { ...s, pipeline: u.pipeline };
    case "session":
      return { ...s, session: u.session, ...(u.session === "active" ? { problem: null } : {}) };
  }
}

export function reduce(s: ViewState, a: ViewAction): ViewState {
  switch (a.type) {
    case "event":
      return onEvent(s, a.event, a.now);
    case "ui":
      return onUi(s, a.update);
    case "user":
      return push(s, { kind: "user", text: a.text });
    case "note":
      return push(s, { kind: "info", text: a.text, tone: a.tone });
    case "workspace": {
      // A new worker: whatever the old one was asking can no longer be answered.
      const next = { ...s, session: a.session, generation: a.generation, decision: null, permissions: [], current: null };
      if (a.workspace === s.workspace) return a.session === "stopped" ? { ...next, status: "idle" } : next;
      return initialState(a.session, a.workspace, a.generation);
    }
    case "initialized":
      return { ...s, session: "dormant", version: a.version, workspace: a.workspace, pipeline: a.pipeline, edits: a.edits };
    case "problem":
      return { ...s, problem: a.problem };
    case "decision.open":
      return { ...s, decision: { id: a.id, review: a.review, views: a.views } };
    case "decision.closed":
      return s.decision?.id === a.id ? { ...s, decision: null } : s;
  }
}

// ------------------------------------------------------------------ view model (pure, shared by render.ts and tests)
const PLACEHOLDERS: Record<ChatStatus, string> = {
  idle: "Type a task… (/help lists the commands)",
  running: "A note for the agents: they get it from the next step",
  paused: "What should change? Enter re-runs the stopped step",
};

export function placeholder(s: ViewState): string {
  if (s.session === "no-folder") return "Open a folder to give agentduo a workspace";
  if (s.session === "choose-folder") return "Choose a workspace folder first";
  return PLACEHOLDERS[s.status];
}

export function canSubmit(s: ViewState): boolean {
  return s.session !== "no-folder" && s.session !== "choose-folder";
}

export interface Choice<K extends string> {
  key: K;
  label: string;
  hint: string;
}

export function decisionChoices(review: HumanReview): Array<Choice<DecisionChoice>> {
  return [
    { key: "resume", label: "Resume", hint: resumeHint(review.reason) },
    { key: "revise", label: "Revise", hint: "re-plan with your note" },
    { key: "abort", label: "Abort", hint: "end the run" },
    { key: "defer", label: "Decide later", hint: "/resume asks again" },
  ];
}

/** "Always allow" only when Claude suggested a rule to save; otherwise it would mean the same as "once". */
export function permissionChoices(request: PermissionRequest): Array<Choice<PermissionAnswer["decision"]>> {
  return [
    { key: "once", label: "Allow once", hint: "" },
    ...(request.rules.length
      ? [{ key: "always" as const, label: `Always allow ${request.rules.join(", ")}`, hint: "saved by Claude to .claude/settings.local.json" }]
      : []),
    { key: "deny", label: "Deny", hint: "the note below, if any, tells the agent what to do instead" },
  ];
}

export type StageStatus = "done" | "active" | "stopped" | "pending";

/** The configured flow plus any phase the run actually reached (a resumed run may have gates the config no longer has). */
export function pipelineView(s: ViewState): Array<PipelineStep & { status: StageStatus }> {
  const steps = [...s.pipeline];
  for (const phase of s.reached) {
    if (steps.some((p) => p.phase === phase) || phase === "HUMAN_REVIEW" || phase === "DONE" || phase === "ABORTED") continue;
    const at = phase === "VERIFY" ? steps.findIndex((p) => p.phase === "CODE_REVIEW") : -1;
    const step: PipelineStep = { phase, label: phase === "VERIFY" ? "VERIFY" : phase, role: null, agent: phase === "VERIFY" ? "gates" : null };
    if (at >= 0) steps.splice(at, 0, step);
    else steps.push(step);
  }
  const active = s.current?.phase;
  const status = (phase: Phase): StageStatus =>
    phase === active ? "active" : phase === s.stopped ? "stopped" : s.reached.includes(phase) ? "done" : "pending";
  return steps.map((p) => ({ ...p, status: status(p.phase) }));
}

export function hasPending(s: ViewState): boolean {
  return !!s.decision || s.permissions.length > 0;
}
