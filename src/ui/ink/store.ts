import type {
  Activity, Agent, DiscussionPlace, DiscussionStatus, DuoEvent, HistoryEntry, HumanReview, Message, ModelIdentity, Party, PermissionAnswer, Phase, Role, RoundInfo, TurnStatus,
  Verdict,
} from "../../events.js";
import { answerActivities, PROVIDERS, withObserved } from "../format.js";
import type { PermissionAsk } from "./PermissionPrompt.js";

/** A question of the chat and its answer: live while the agent works, then printed once, whole. */
export interface TurnView {
  turnId: string;
  backend: Agent;
  /** Fixed when the turn starts; only the agent's own stream for this call may confirm it. */
  model: ModelIdentity;
  activities: Activity[];
  startedAt: number;
  verbose: boolean;
  status?: TurnStatus;
  answer?: string | null;
  error?: string | null;
  durationSec?: number;
  costUsd?: number;
  tokens?: number;
  /** A /discuss turn: its step, and a review's verdict. */
  discussion?: DiscussionPlace & { verdict?: Verdict | null };
}

/** A /discuss once it is over: how it ended, and its answer (Codex's synthesis, or the latest version), printed whole. */
export interface DiscussionView {
  status: DiscussionStatus;
  answerer: Agent;
  critic: Agent;
  rounds: number;
  answer: string | null;
  /** Who wrote `answer`; absent: the answerer. */
  answerBackend?: Agent;
  error: string | null;
  durationSec: number;
  costUsd?: number;
  tokens?: number;
}

export interface StepView {
  phase: Phase;
  round: number;
  role?: Role;
  agent?: Party;
  activities: Activity[];
  message?: Message;
  entry?: HistoryEntry;
  durationSec?: number;
  costUsd?: number;
  tokens?: number;
  startedAt: number;
  verbose: boolean;
}

type StaticContent =
  | { kind: "header"; runId: string; repo: string; version: string; chat?: boolean }
  /** Chat mode: what the user typed, and agentduo's own lines (command output, hints). */
  | { kind: "user"; text: string }
  | { kind: "info"; text: string }
  | { kind: "step"; step: StepView }
  | { kind: "note"; text: string }
  | { kind: "artifact"; title: string; body: string }
  | { kind: "finish"; phase: string; runId: string; reportPath: string; summary?: string; chat?: boolean }
  | { kind: "review"; review: HumanReview }
  | { kind: "answer"; turn: TurnView }
  | { kind: "discussion"; discussion: DiscussionView }
  | { kind: "permission"; agent: Party; role?: Role; label: string; rules: string[]; answer: PermissionAnswer };
export type StaticItem = { id: string } & StaticContent;

export interface ViewState {
  version: string;
  items: StaticItem[];
  current: StepView | null;
  /** The chat question being answered now. */
  turn: TurnView | null;
  /** The /discuss under way, whose turns come one after another. */
  discussion: { id: string; answerer: Agent; critic: Agent; maxRounds: number } | null;
  planning: RoundInfo;
  impl: RoundInfo;
  reached: Phase[];
  totals: { costUsd: number; tokens: number };
  live: { costUsd: number; tokens: number };
  humanReview: HumanReview | null;
  /** Permission prompts waiting for an answer, oldest first (an agent may ask for several tools at once). */
  permissions: PermissionAsk[];
  finished: { phase: string; reportPath: string; exitCode: number } | null;
  verbose: boolean;
  stopping: boolean;
  seq: number;
  /** One chat session hosts many runs: one header, a separator per run, chat-style finish lines. */
  chat: boolean;
}

export type ViewAction =
  | { type: "event"; event: DuoEvent; now: number }
  | { type: "toggleVerbose" }
  | { type: "stopping" }
  | { type: "artifact"; title: string; body: string }
  | { type: "chat"; kind: "user" | "info"; text: string };

export function initialView(version: string, verbose = false, chat?: { workspace: string }): ViewState {
  const s: ViewState = {
    version, items: [], current: null, turn: null, discussion: null, planning: { round: 1, limit: 0 }, impl: { round: 0, limit: 0 }, reached: [],
    totals: { costUsd: 0, tokens: 0 }, live: { costUsd: 0, tokens: 0 }, humanReview: null, permissions: [], finished: null, verbose, stopping: false, seq: 0,
    chat: !!chat,
  };
  return chat ? push(s, { kind: "header", runId: "", repo: chat.workspace, version, chat: true }) : s;
}

function push(s: ViewState, item: StaticContent): ViewState {
  return { ...s, items: [...s.items, { ...item, id: `${item.kind}-${s.seq}` } as StaticItem], seq: s.seq + 1 };
}

function newStep(s: ViewState, phase: Phase, round: number, now: number, role?: Role, agent?: Party): StepView {
  return { phase, round, role, agent, activities: [], startedAt: now, verbose: s.verbose };
}

function upsert(list: Activity[], activity: Activity): Activity[] {
  const i = list.findIndex((a) => a.id === activity.id);
  if (i === -1) return [...list, activity];
  const copy = list.slice();
  copy[i] = activity;
  return copy;
}

function withActivity(s: ViewState, activity: Activity): ViewState {
  return s.current ? { ...s, current: { ...s.current, activities: upsert(s.current.activities, activity) } } : s;
}

export function reduce(s: ViewState, action: ViewAction): ViewState {
  switch (action.type) {
    case "toggleVerbose":
      return { ...s, verbose: !s.verbose };
    case "stopping":
      return { ...s, stopping: true };
    case "artifact":
      return push(s, { kind: "artifact", title: action.title, body: action.body });
    case "chat":
      return push(s, { kind: action.kind, text: action.text });
    case "event":
      return onEvent(s, action.event, action.now);
  }
}

function onEvent(s: ViewState, e: DuoEvent, now: number): ViewState {
  switch (e.type) {
    case "run.started": {
      const next = { ...s, finished: null, stopping: false, reached: s.chat ? [] : s.reached };
      if (s.chat) return push(next, { kind: "info", text: `── run ${e.runId} ──` });
      return s.items.some((i) => i.kind === "header") ? next : push(next, { kind: "header", runId: e.runId, repo: e.repo, version: s.version });
    }
    case "phase.started":
      return {
        ...s, current: newStep(s, e.phase, e.round, now, e.role, e.agent), planning: e.planning, impl: e.impl,
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
      return withActivity(s, { id: `gate-${e.name}`, kind: "command", label: `gate  ${e.name}: ${e.command}`, status: e.passed ? "ok" : "error", exitCode: e.exitCode ?? undefined });
    case "message": {
      const current = s.current ?? newStep(s, "HUMAN_REVIEW", 0, now, undefined, e.message.from);
      return { ...s, current: { ...current, message: e.message }, humanReview: e.message.kind === "decision" ? null : s.humanReview };
    }
    case "step.completed": {
      const base = s.current ?? newStep(s, e.entry.phase, e.entry.round, now);
      const step: StepView = { ...base, round: base.round || e.entry.round, entry: e.entry, durationSec: e.durationSec, costUsd: e.costUsd, tokens: e.tokens, verbose: s.verbose };
      return {
        ...push({ ...s, current: null }, { kind: "step", step }),
        totals: { costUsd: s.totals.costUsd + (e.costUsd ?? 0), tokens: s.totals.tokens + (e.tokens ?? 0) },
        live: { costUsd: 0, tokens: 0 },
      };
    }
    case "warning":
      return push(s, { kind: "note", text: e.text });
    case "human.required":
      return { ...s, humanReview: e.review, current: null };
    case "turn.started":
      return {
        ...s, turn: { turnId: e.turnId, backend: e.backend, model: e.model, activities: [], startedAt: now, verbose: s.verbose, ...(e.discussion ? { discussion: e.discussion } : {}) },
        live: { costUsd: 0, tokens: 0 },
      };
    case "turn.activity":
      return s.turn?.turnId === e.turnId ? { ...s, turn: { ...s.turn, activities: upsert(s.turn.activities, e.activity) } } : s;
    case "turn.usage":
      return s.turn?.turnId === e.turnId ? { ...s, live: { costUsd: e.costUsd ?? s.live.costUsd, tokens: e.tokens ?? s.live.tokens } } : s;
    case "turn.model":
      return s.turn?.turnId === e.turnId ? { ...s, turn: { ...s.turn, model: withObserved(s.turn.model, e.model) } } : s;
    case "turn.finished": {
      const base = s.turn?.turnId === e.turnId ? s.turn : { turnId: e.turnId, backend: e.backend, model: e.model, activities: [], startedAt: now, verbose: s.verbose };
      const turn: TurnView = {
        ...base, model: e.model, activities: answerActivities(base.activities, e.answer), status: e.status, answer: e.answer, error: e.error,
        durationSec: e.durationSec, costUsd: e.costUsd, tokens: e.tokens, verbose: s.verbose, ...(e.discussion ? { discussion: e.discussion } : {}),
      };
      return {
        ...push({ ...s, turn: s.turn?.turnId === e.turnId ? null : s.turn }, { kind: "answer", turn }),
        totals: { costUsd: s.totals.costUsd + (e.costUsd ?? 0), tokens: s.totals.tokens + (e.tokens ?? 0) }, live: { costUsd: 0, tokens: 0 },
      };
    }
    case "discussion.started":
      return {
        ...push(s, { kind: "info", text: `── discussion: ${PROVIDERS[e.answerer].agent} answers, ${PROVIDERS[e.critic].agent} reviews (at most ${e.maxRounds} review${e.maxRounds === 1 ? "" : "s"}) ──` }),
        discussion: { id: e.discussionId, answerer: e.answerer, critic: e.critic, maxRounds: e.maxRounds },
      };
    case "discussion.finished": {
      // Its turns have counted their usage already.
      const { status, answerer, critic, rounds, answer, answerBackend, error, durationSec, costUsd, tokens } = e;
      const view: DiscussionView = { status, answerer, critic, rounds, answer, ...(answerBackend ? { answerBackend } : {}), error, durationSec, costUsd, tokens };
      return { ...push(s, { kind: "discussion", discussion: view }), discussion: null };
    }
    case "permission.requested":
      return { ...s, permissions: [...s.permissions, { role: e.role, agent: e.agent, request: e.request }] };
    case "permission.answered": {
      const ask = s.permissions.find((p) => p.request.id === e.id);
      const rest = { ...s, permissions: s.permissions.filter((p) => p.request.id !== e.id) };
      return ask ? push(rest, { kind: "permission", agent: ask.agent, role: ask.role, label: ask.request.label, rules: ask.request.rules, answer: e.answer }) : rest;
    }
    case "run.finished": {
      // A deferred decision (non-interactive, or "Decide later") keeps the reason in scrollback.
      const withReview = e.phase === "HUMAN_REVIEW" && s.humanReview ? push(s, { kind: "review", review: s.humanReview }) : s;
      return {
        ...push(withReview, { kind: "finish", phase: e.phase, runId: e.runId, reportPath: e.reportPath, summary: e.summary, chat: s.chat }),
        finished: { phase: e.phase, reportPath: e.reportPath, exitCode: e.exitCode }, current: null, humanReview: null, permissions: [],
      };
    }
    default:
      return s;
  }
}
