// What the sidebar shows, as plain data. The extension host keeps one copy (so a hidden or reloaded view gets a
// snapshot) and the webview another, both driven by the same actions through `reduce`. No DOM here.
import type { ChatStatus } from "../../../src/chat.js";
import type { Attachment } from "../../../src/core/attachment-types.js";
import { AGENT_NAMES, CLAUDE_EFFORTS, CLAUDE_MODELS, CODEX_EFFORTS, type Backend } from "../../../src/core/commands.js";
import type { CodexCatalog } from "../../../src/core/models.js";
import type { SettingsView } from "../../../src/core/settings.js";
import type { UsageReport } from "../../../src/core/usage.js";
import type {
  Activity, Agent, DiscussionPlace, DiscussionStatus, DuoEvent, HistoryEntry, HumanReview, Message, ModelIdentity, ModelMap, Party, PermissionAnswer, PermissionRequest,
  Phase, Role, RoundInfo, TurnStatus, Verdict,
} from "../../../src/events.js";
import { answerActivities, resumeHint, withObserved } from "../../../src/ui/format.js";
import type { ArtifactName, DecisionChoice, PipelineStep, Problem, UiUpdate } from "../src/protocol.js";

/** Kept in the view; older items stay in the run's files (events.jsonl, report.md, logs/). */
export const MAX_TIMELINE = 400;
export const MAX_ACTIVITIES = 150;
/**
 * The answers' text the view keeps, apart from MAX_TIMELINE: past it the oldest turns go, whole, but never the latest
 * answer and its question, however long (no answer is ever cut). The conversation's logs keep every answer in full.
 */
export const MAX_ANSWER_CHARS = 2_000_000;

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

/** A question of the chat and its answer; `model` is fixed when it starts, and only this call's own stream confirms it. */
export interface TurnCard {
  turnId: string;
  backend: Agent;
  model: ModelIdentity;
  startedAt: number;
  activities: Activity[];
  dropped: number;
  status?: TurnStatus;
  answer?: string | null;
  error?: string | null;
  durationSec?: number;
  costUsd?: number;
  tokens?: number;
  /** A /discuss turn: its step, and a review's verdict. */
  discussion?: DiscussionPlace & { verdict?: Verdict | null };
}

/** A /discuss: its turns as they finish, then how it ended and its answer (Codex's synthesis, or the latest version). */
export interface DiscussionCard {
  id: string;
  question: string;
  answerer: Agent;
  critic: Agent;
  maxRounds: number;
  startedAt: number;
  turns: TurnCard[];
  status?: DiscussionStatus;
  rounds?: number;
  answer?: string | null;
  /** Who wrote `answer`; absent (a card saved before synthesis): the answerer. */
  answerBackend?: Agent;
  error?: string | null;
  durationSec?: number;
  costUsd?: number;
  tokens?: number;
}

export type TimelineItem = { id: string } & (
  /** `to`: the agent the message went to as a question; `pipeline`: sent as a task with the Pipeline button; `discuss`: a question to discuss. */
  | { kind: "user"; text: string; to?: Backend; pipeline?: boolean; discuss?: boolean; attachments?: Attachment[] }
  | { kind: "info"; text: string; tone: "info" | "error" }
  | { kind: "run"; runId: string; task: string }
  | { kind: "step"; step: StepCard }
  | { kind: "answer"; turn: TurnCard }
  | { kind: "discussion"; discussion: DiscussionCard }
  | { kind: "warning"; text: string }
  | { kind: "permission"; agent: Party; role?: Role; label: string; rules: string[]; answer: PermissionAnswer }
  | { kind: "review"; review: HumanReview }
  | { kind: "finish"; phase: string; runId: string; summary?: string }
);

/** A file of the composer: being stored, waiting to go with the next message, or one that could not be attached. */
export interface AttachmentChip {
  /** The tab's name for it: its upload's key, or the attachment's id when the worker named it first (/attach). */
  key: string;
  status: "uploading" | "ready" | "error";
  name: string;
  /** What the worker stored; null until then. */
  attachment: Attachment | null;
  error: string | null;
}

export interface PendingPermission {
  /** Absent when Claude asks while answering a question of the chat. */
  role?: Role;
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
  /** Claude's permission mode: manual, acceptEdits, auto, or another one Claude Code has. */
  mode: string;
  /** Who a plain message goes to. */
  recipient: Backend;
  /** Null until the worker has said (a new worker starts over). */
  models: ModelMap | null;
  settings: SettingsView | null;
  /** The models Codex offers, for the settings' picker; null until the worker has read them. */
  catalog: { codex: CodexCatalog } | null;
  /** The tab's latest /usage, for its usage panel (which the webview opens for a new report); null until there is one. */
  usage: UsageReport | null;
  problem: Problem | null;
  run: { id: string; task: string } | null;
  /** The phase the run finished in (DONE, ABORTED, HUMAN_REVIEW, INTERRUPTED); null while it runs. */
  ended: string | null;
  current: StepCard | null;
  /** The question being answered now (in a discussion, its turn under way). */
  turn: TurnCard | null;
  /** The /discuss under way. */
  discussion: DiscussionCard | null;
  /** Where the conversation's logs (every answer in full) are, once there is one. */
  logs: string | null;
  reached: Phase[];
  /** The phase whose step was stopped (Esc, /stop): reached, but not done. */
  stopped: Phase | null;
  planning: RoundInfo;
  impl: RoundInfo;
  totals: { costUsd: number; tokens: number };
  live: { costUsd: number; tokens: number };
  decision: PendingDecision | null;
  permissions: PendingPermission[];
  /** The composer's files: the worker's waiting ones, those being stored, and those that failed. */
  attachments: AttachmentChip[];
  timeline: TimelineItem[];
  /** Timeline items dropped from the front. */
  dropped: number;
  seq: number;
}

export type ViewAction =
  | { type: "event"; event: DuoEvent; now: number }
  | { type: "ui"; update: UiUpdate }
  | { type: "user"; text: string; pipeline?: boolean; discuss?: boolean }
  | { type: "note"; text: string; tone: "info" | "error" }
  | { type: "workspace"; session: SessionState; workspace: string | null; generation: number }
  | {
    type: "initialized"; version: string; workspace: string; pipeline: PipelineStep[]; mode: string; recipient?: Backend; models?: ModelMap;
    settings?: SettingsView | null;
  }
  | { type: "problem"; problem: Problem | null }
  | { type: "decision.open"; id: string; review: HumanReview; views: ArtifactName[] }
  | { type: "decision.closed"; id: string }
  /** A file of the composer goes to the worker (key: the upload's), is stored, fails, or is let go. */
  | { type: "attachment.uploading"; key: string; name: string }
  | { type: "attachment.ready"; key: string; attachment: Attachment }
  | { type: "attachment.failed"; key: string; name: string; error: string }
  | { type: "attachment.dismissed"; key: string };

export function initialState(session: SessionState = "starting", workspace: string | null = null, generation = 0): ViewState {
  return {
    generation, session, workspace, version: null, pipeline: [], status: "idle", mode: "manual", recipient: "codex", models: null, settings: null, catalog: null, usage: null, problem: null,
    run: null, ended: null, current: null, turn: null, discussion: null, logs: null, reached: [], stopped: null,
    planning: { round: 1, limit: 0 }, impl: { round: 0, limit: 0 }, totals: { costUsd: 0, tokens: 0 }, live: { costUsd: 0, tokens: 0 },
    decision: null, permissions: [], attachments: [], timeline: [], dropped: 0, seq: 0,
  };
}

/**
 * The worker's waiting files, as the composer shows them: a stored file stays only while it waits; one the worker has
 * that the tab did not store (an /attach typed in it) is added; files being stored, and failed ones, stay as they are.
 */
function reconcile(chips: AttachmentChip[], files: Attachment[]): AttachmentChip[] {
  const kept = chips.filter((c) => c.status !== "ready" || files.some((f) => f.id === c.attachment?.id));
  const known = new Set(kept.flatMap((c) => (c.attachment ? [c.attachment.id] : [])));
  return [...kept, ...files.filter((f) => !known.has(f.id)).map((f): AttachmentChip => ({ key: f.id, status: "ready", name: f.name, attachment: f, error: null }))];
}

/** The files that went with the message just sent join it, its last message in the timeline. */
function sentWith(s: ViewState, files: Attachment[]): ViewState {
  const i = s.timeline.findLastIndex((x) => x.kind === "user");
  const item = s.timeline[i];
  if (!item || item.kind !== "user" || !files.length) return s;
  const timeline = s.timeline.slice();
  timeline[i] = { ...item, attachments: files };
  return { ...s, timeline };
}

function onAttachment(s: ViewState, a: Extract<ViewAction, { type: `attachment.${string}` }>): ViewState {
  const chips = s.attachments;
  switch (a.type) {
    case "attachment.uploading":
      return chips.some((c) => c.key === a.key) ? s : { ...s, attachments: [...chips, { key: a.key, status: "uploading", name: a.name, attachment: null, error: null }] };
    case "attachment.ready":
      // The worker may have said first (its list of waiting files): that chip gives way to the tab's own.
      if (!chips.some((c) => c.key === a.key)) return s;
      return {
        ...s, attachments: chips.filter((c) => c.key === a.key || c.attachment?.id !== a.attachment.id)
          .map((c) => (c.key === a.key ? { ...c, status: "ready", name: a.attachment.name, attachment: a.attachment, error: null } : c)),
      };
    case "attachment.failed": {
      const chip: AttachmentChip = { key: a.key, status: "error", name: a.name, attachment: null, error: a.error };
      return { ...s, attachments: chips.some((c) => c.key === a.key) ? chips.map((c) => (c.key === a.key ? chip : c)) : [...chips, chip] };
    }
    case "attachment.dismissed":
      return { ...s, attachments: chips.filter((c) => c.key !== a.key) };
  }
}

type ItemContent = TimelineItem extends infer T ? (T extends { id: string } ? Omit<T, "id"> : never) : never;

const answerChars = (item: TimelineItem) => item.kind === "answer" ? item.turn.answer?.length ?? 0
  : item.kind === "discussion" ? item.discussion.turns.reduce((n, t) => n + (t.answer?.length ?? 0), item.discussion.answer?.length ?? 0) : 0;

/** The items the view never drops: the latest answer (or discussion) and the message it answers. */
function keptItems(timeline: TimelineItem[]): Set<number> {
  const answer = timeline.findLastIndex((i) => i.kind === "answer" || i.kind === "discussion");
  if (answer < 0) return new Set();
  const question = timeline.findLastIndex((i, n) => n < answer && i.kind === "user");
  return new Set(question < 0 ? [answer] : [question, answer]);
}

/**
 * Appends, then keeps the view within MAX_TIMELINE items and MAX_ANSWER_CHARS of answers. Each message of the user
 * starts a turn: the oldest turns go whole, but never the last one nor the one holding the latest answer, which stays
 * with its question whatever its size. Only if that is not enough do single items go, oldest first.
 */
function push(s: ViewState, item: ItemContent): ViewState {
  const timeline = [...s.timeline, { ...item, id: `${item.kind}-${s.seq}` } as TimelineItem];
  const kept = keptItems(timeline);
  const gone = new Set<number>();
  let count = timeline.length;
  let chars = timeline.reduce((n, i) => n + answerChars(i), 0);
  // Answer text that dropping can give back: a kept answer over the budget alone drops nothing.
  let loose = timeline.reduce((n, it, i) => n + (kept.has(i) ? 0 : answerChars(it)), 0);
  const over = () => count > MAX_TIMELINE || (chars > MAX_ANSWER_CHARS && loose > 0);
  const drop = (i: number) => {
    gone.add(i);
    count--;
    chars -= answerChars(timeline[i]!);
    loose -= answerChars(timeline[i]!);
  };
  const starts = timeline.flatMap((it, i) => (i === 0 || it.kind === "user" ? [i] : []));
  for (let t = 0; t + 1 < starts.length && over(); t++) {
    const [from, to] = [starts[t]!, starts[t + 1]!];
    if ([...kept].some((k) => k >= from && k < to)) continue;
    for (let i = from; i < to; i++) drop(i);
  }
  for (let i = 0; i < timeline.length && over(); i++) if (!gone.has(i) && !kept.has(i)) drop(i);
  return { ...s, timeline: gone.size ? timeline.filter((_, i) => !gone.has(i)) : timeline, dropped: s.dropped + gone.size, seq: s.seq + 1 };
}

function newTurn(e: Extract<DuoEvent, { type: "turn.started" | "turn.finished" }>, now: number): TurnCard {
  return { turnId: e.turnId, backend: e.backend, model: e.model, startedAt: now, activities: [], dropped: 0, ...(e.discussion ? { discussion: e.discussion } : {}) };
}

/** The message a discussion answers is one to discuss: typed as /discuss, or sent with the Discuss route. */
function discussed(s: ViewState, question: string): ViewState {
  const i = s.timeline.findLastIndex((x) => x.kind === "user");
  const item = s.timeline[i];
  if (!item || item.kind !== "user" || item.discuss || item.text.replace(/^\/discuss\s+/, "").trim() !== question.trim()) return s;
  const timeline = s.timeline.slice();
  timeline[i] = { ...item, discuss: true };
  return { ...s, timeline };
}

/** The turn's activities, updated in place by id (as a step's are), keeping only the latest ones. */
function turnActivity(t: TurnCard, activity: Activity): TurnCard {
  const i = t.activities.findIndex((a) => a.id === activity.id);
  if (i >= 0) {
    const activities = t.activities.slice();
    activities[i] = activity;
    return { ...t, activities };
  }
  const activities = [...t.activities, activity];
  const over = Math.max(0, activities.length - MAX_ACTIVITIES);
  return { ...t, activities: over ? activities.slice(over) : activities, dropped: t.dropped + over };
}

/** The user's message the turn answers learns where it went (the worker decided, not the view). */
function addressed(s: ViewState, question: string, to: Backend): ViewState {
  const i = s.timeline.findLastIndex((x) => x.kind === "user");
  const item = s.timeline[i];
  if (!item || item.kind !== "user" || item.to || item.pipeline || item.text.replace(/^\/(claude|codex)(\s+--)?\s+/, "").trim() !== question.trim()) return s;
  const timeline = s.timeline.slice();
  timeline[i] = { ...item, to };
  return { ...s, timeline };
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
      return push({ ...s, run: { id: e.runId, task: e.task }, ended: null, reached: [], stopped: null, current: null }, { kind: "run", runId: e.runId, task: e.task });
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
    case "turn.started":
      return { ...(e.discussion ? s : addressed(s, e.question, e.backend)), turn: newTurn(e, now), live: { costUsd: 0, tokens: 0 } };
    case "turn.activity":
      return s.turn?.turnId === e.turnId ? { ...s, turn: turnActivity(s.turn, e.activity) } : s;
    case "turn.usage":
      return s.turn?.turnId === e.turnId ? { ...s, live: { costUsd: e.costUsd ?? s.live.costUsd, tokens: e.tokens ?? s.live.tokens } } : s;
    case "turn.model":
      return s.turn?.turnId === e.turnId ? { ...s, turn: { ...s.turn, model: withObserved(s.turn.model, e.model) } } : s;
    case "turn.finished": {
      const mine = s.turn?.turnId === e.turnId;
      const base = mine ? s.turn! : newTurn(e, now);
      const turn: TurnCard = {
        ...base, model: e.model, activities: answerActivities(base.activities, e.answer), status: e.status, answer: e.answer, error: e.error,
        durationSec: e.durationSec, costUsd: e.costUsd, tokens: e.tokens, ...(e.discussion ? { discussion: e.discussion } : {}),
      };
      const totals = { costUsd: s.totals.costUsd + (e.costUsd ?? 0), tokens: s.totals.tokens + (e.tokens ?? 0) };
      // A discussion's turn joins it; the discussion reaches the timeline whole, once it is over.
      if (e.discussion && s.discussion?.id === e.discussion.id) {
        return { ...s, turn: mine ? null : s.turn, logs: e.logDir, discussion: { ...s.discussion, turns: [...s.discussion.turns, turn] }, totals, live: { costUsd: 0, tokens: 0 } };
      }
      return {
        ...push({ ...s, turn: mine ? null : s.turn, logs: e.logDir }, { kind: "answer", turn }),
        // The final usage of the call is its total; the live figures were running totals of the same call.
        totals: { costUsd: s.totals.costUsd + (e.costUsd ?? 0), tokens: s.totals.tokens + (e.tokens ?? 0) }, live: { costUsd: 0, tokens: 0 },
      };
    }
    case "discussion.started":
      return {
        ...discussed(s, e.question),
        discussion: { id: e.discussionId, question: e.question, answerer: e.answerer, critic: e.critic, maxRounds: e.maxRounds, startedAt: now, turns: [] },
      };
    case "discussion.finished": {
      const base = s.discussion?.id === e.discussionId ? s.discussion
        : { id: e.discussionId, question: "", answerer: e.answerer, critic: e.critic, maxRounds: e.rounds, startedAt: now, turns: [] };
      const discussion: DiscussionCard = {
        ...base, status: e.status, rounds: e.rounds, answer: e.answer, ...(e.answerBackend ? { answerBackend: e.answerBackend } : {}), error: e.error,
        durationSec: e.durationSec, costUsd: e.costUsd, tokens: e.tokens,
      };
      // Its turns have counted their usage already.
      return push({ ...s, discussion: null, logs: e.logDir }, { kind: "discussion", discussion });
    }
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
        ended: e.phase,
      };
    }
    default:
      return s;
  }
}

function onUi(s: ViewState, u: UiUpdate): ViewState {
  switch (u.type) {
    case "info":
      return push(s, { kind: "info", text: u.text, tone: u.tone ?? "info" });
    case "status":
      return { ...s, status: u.status };
    case "mode":
      return { ...s, mode: u.mode };
    case "recipient":
      return { ...s, recipient: u.backend };
    case "models":
      return { ...s, models: u.models };
    case "settings":
      return { ...s, settings: u.settings, mode: u.settings.claude.mode };
    case "catalog":
      return { ...s, catalog: { codex: u.codex } };
    case "usage":
      return { ...s, usage: u.report };
    case "attachments":
      return { ...s, attachments: reconcile(s.attachments, u.files) };
    case "sent":
      return sentWith(s, u.files);
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
      return push(s, { kind: "user", text: a.text, ...(a.pipeline ? { pipeline: true } : {}), ...(a.discuss ? { discuss: true } : {}) });
    case "note":
      return push(s, { kind: "info", text: a.text, tone: a.tone });
    case "workspace": {
      // A new worker: whatever the old one was asking or answering is gone, and it says again what it knows.
      // Its files waiting to be sent went with it; a file still on its way goes to the new one.
      const attachments = a.generation === s.generation ? s.attachments : s.attachments.filter((c) => c.status === "uploading");
      const next = { ...s, session: a.session, generation: a.generation, decision: null, permissions: [], current: null, turn: null, discussion: null, models: null, attachments };
      if (a.workspace === s.workspace) return a.session === "stopped" ? { ...next, status: "idle" } : next;
      return initialState(a.session, a.workspace, a.generation);
    }
    case "initialized":
      // A models update can overtake the initialize answer it follows; the newer one stays.
      return {
        ...s, session: "dormant", version: a.version, workspace: a.workspace, pipeline: a.pipeline, mode: a.mode, recipient: a.recipient ?? s.recipient,
        models: s.models ?? a.models ?? null, settings: a.settings ?? s.settings,
      };
    case "problem":
      return { ...s, problem: a.problem };
    case "decision.open":
      return { ...s, decision: { id: a.id, review: a.review, views: a.views } };
    case "decision.closed":
      return s.decision?.id === a.id ? { ...s, decision: null } : s;
    case "attachment.uploading":
    case "attachment.ready":
    case "attachment.failed":
    case "attachment.dismissed":
      return onAttachment(s, a);
  }
}

/** The attached images the tab shows (in its messages and its composer), whose copies it needs URIs for. */
export function shownImages(s: ViewState): Attachment[] {
  const all = [...s.timeline.flatMap((i) => (i.kind === "user" ? i.attachments ?? [] : [])), ...s.attachments.flatMap((c) => (c.attachment ? [c.attachment] : []))];
  return all.filter((a, i) => a.image && all.findIndex((b) => b.id === a.id) === i);
}

/** Files are still being stored: the message waits for them. */
export const uploading = (s: ViewState): boolean => s.attachments.some((c) => c.status === "uploading");

/** The ids of the files a message sent now takes: those stored and waiting. */
export const readyAttachments = (s: ViewState): string[] => s.attachments.flatMap((c) => (c.status === "ready" && c.attachment ? [c.attachment.id] : []));

// ------------------------------------------------------------------ view model (pure, shared by render.ts and tests)
/** `next`: the composer's next message is a task for the pipeline, or a question to discuss (picked in its recipient menu). */
export function placeholder(s: ViewState, next: "pipeline" | "discuss" | null = null): string {
  if (s.session === "no-folder") return "Open a folder to give agentduo a workspace";
  if (s.session === "choose-folder") return "Choose a workspace folder first";
  const name = AGENT_NAMES[s.recipient];
  if (next === "pipeline" && s.status !== "running") return "A task for the pipeline: Codex plans and reviews, Claude critiques and implements";
  if (next === "discuss" && s.status !== "running") {
    return `A question to discuss: ${name} answers, ${AGENT_NAMES[s.recipient === "codex" ? "claude" : "codex"]} reviews, until they agree`;
  }
  switch (s.status) {
    case "idle":
      return `Ask ${name}… (/ for commands)`;
    case "running":
      return "A note for the agents: they get it from the next step";
    case "answering":
      return s.discussion
        ? `${AGENT_NAMES[s.discussion.answerer]} and ${AGENT_NAMES[s.discussion.critic]} are discussing… (Esc stops it)`
        : `${name} is answering… (Esc stops it)`;
    case "paused":
      return `Ask ${name}… (/resume continues the stopped run)`;
  }
}

/** Something runs that Esc or Stop can stop: a pipeline step, or an answer. */
export const isBusy = (s: ViewState): boolean => s.status === "running" || s.status === "answering";

/**
 * The send control stops what runs instead of sending: something runs, and the composer has nothing for it, neither
 * text nor files (waiting, or still being read or attached), which Enter would send as a note or wait for.
 * `reading`: the files the webview is still reading or handing to the host.
 */
export function sendStops(s: ViewState, text: string, reading: number): boolean {
  return isBusy(s) && !text.trim() && !reading && !uploading(s) && !readyAttachments(s).length;
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

/** The run's progress is worth showing: it runs, or it stopped or waits for you and can go on. */
export function runInProgress(s: ViewState): boolean {
  return !!s.run && (s.ended === null || s.ended === "HUMAN_REVIEW" || s.ended === "INTERRUPTED");
}

/** The words some tools go by in the agents' labels, as the sidebar names them. */
const TOOL_NAMES: Record<string, string> = { exec: "Run" };

/**
 * An activity as the sidebar shows it: the tool apart ("Bash", "Read", "Edit"…) when the label starts with it, as
 * the agents' parsers write them ("Bash  npm test"), then what it worked on, and an edit's line counts.
 */
export function activityParts(a: Activity): { tool: string | null; text: string; diff: { added: number; removed: number } | null } {
  const m = a.kind === "read" || a.kind === "search" || a.kind === "edit" || a.kind === "command" ? /^(\S+) {1,2}(\S[\s\S]*)$/.exec(a.label) : null;
  const tool = m ? TOOL_NAMES[m[1]!] ?? m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1) : null;
  const exit = a.status === "error" && a.exitCode !== undefined ? ` (exit ${a.exitCode})` : "";
  return {
    tool, text: `${m ? m[2]! : a.label}${exit}${a.status === "denied" ? " denied" : ""}`,
    diff: a.added !== undefined || a.removed !== undefined ? { added: a.added ?? 0, removed: a.removed ?? 0 } : null,
  };
}

/** One entry of a settings picker: the value it sets, and what it is. */
export interface PickOption {
  value: string;
  label: string;
  detail: string;
}

/** The model the agent runs with when its setting is "default", as far as agentduo knows it. */
function defaultModel(s: ViewState, backend: Backend): string | null {
  const m = s.models?.[backend];
  return m?.isDefault ? m.resolved ?? m.configured : null;
}

/**
 * The models the settings offer an agent: Default, then what its CLI lists (Codex's catalog, Claude Code's aliases),
 * with the model set now even when it is not among them. `note` says why Codex's list is missing.
 */
export function modelOptions(s: ViewState, backend: Backend): { value: string; options: PickOption[]; note: string | null } {
  const set = s.settings?.[backend].model ?? null;
  const known = defaultModel(s, backend);
  const own = backend === "claude" ? "Claude Code's own setting" : "Codex's own setting (~/.codex/config.toml)";
  const codex = s.catalog?.codex ?? null;
  const listed = backend === "claude" ? CLAUDE_MODELS : codex?.models ?? [];
  const options: PickOption[] = [
    { value: "default", label: "Default", detail: known ? `${own} · ${known}` : own },
    ...(set && !listed.some((m) => m.id === set) ? [{ value: set, label: set, detail: "set in the configuration" }] : []),
    ...listed.map((m) => ({ value: m.id, label: m.label, detail: m.description })),
  ];
  const note = backend === "claude" ? null : !codex ? "Reading Codex's models…" : codex.reason ? `Codex's models: ${codex.reason}` : null;
  return { value: set ?? "default", options, note };
}

/**
 * The efforts the settings offer: Claude's, or those the Codex model takes (its catalog says) that agentduo can set.
 * Codex keeps an effort once one is set (`/codex model` only replaces it), so Default is offered only while none is.
 */
export function effortOptions(s: ViewState, backend: Backend): { value: string; options: PickOption[] } {
  const set = s.settings?.[backend].effort ?? null;
  if (backend === "claude") {
    return { value: set ?? "default", options: [{ value: "default", label: "Default", detail: "Claude Code's own default" }, ...CLAUDE_EFFORTS.map((e) => ({ value: e, label: e, detail: "" }))] };
  }
  const model = s.settings?.codex.model ?? defaultModel(s, "codex");
  const entry = s.catalog?.codex.models.find((m) => m.id === model) ?? null;
  const efforts = (entry?.efforts ?? [...CODEX_EFFORTS]).filter((e) => (CODEX_EFFORTS as readonly string[]).includes(e));
  if (set && !efforts.includes(set)) efforts.push(set);
  const ownDefault = entry?.defaultEffort ? `${entry.label}'s default: ${entry.defaultEffort}` : "Codex's own setting";
  return {
    value: set ?? "default",
    options: [
      ...(set ? [] : [{ value: "default", label: "Default", detail: ownDefault }]),
      ...efforts.map((e) => ({ value: e, label: e, detail: e === entry?.defaultEffort ? "the model's default" : "" })),
    ],
  };
}

export function hasPending(s: ViewState): boolean {
  return !!s.decision || s.permissions.length > 0;
}
