// How a team's rules grow and bend (packages/engine/src/team): the incidents a team learns from, and the exceptions to its
// rules that members ask for. Pure: no Node, no files, no agents. Every function changes the state it is given and says
// what it did; the run saves it (state.governance) and the rules store (rules.ts) writes RULES.md.
//
// Two things must never be confused:
//  - A lesson is a rule appended after an incident was resolved. The state records that it was asked for and that the
//    store wrote it (`recording` → `recorded`), never what the rule says it replaces: nothing here deletes a rule.
//  - An exception is a decision with an exact scope: this run, these tasks (or one named unit of work outside a task),
//    these rules. It is granted only by the user's answer to the very request that showed it (`decideException`), never by
//    an agent's output, a note, a question's answer or an approval of something else; refused, unanswered, repeated or
//    stale requests grant nothing, and an approved one opens nothing beyond its scope.
import type { TaskState, TeamState } from "./state.js";

/** The part of a team run's state these functions read and write. */
export type GovernedState = Pick<TeamState, "id" | "tasks"> & OccurrenceState & {
  governance?: RuleGovernance;
  escalations?: TeamState["escalations"];
  messages?: TeamState["messages"];
  waiting?: TeamState["waiting"];
};

/** What identifies the occurrence of work outside a task (`unitOccurrence`): the parts of a run's state it is read from. */
export type OccurrenceState = Partial<Pick<TeamState, "integration" | "verifiedTree" | "plans" | "approvedBrief">>;

/** An outcome: what happened, or why nothing did (said so that its caller can correct exactly it). */
export type Outcome<T> = { ok: true; value: T; changed: boolean } | { ok: false; reason: string };

const done = <T>(value: T, changed: boolean): Outcome<T> => ({ ok: true, value, changed });
const refuse = <T = never>(reason: string): Outcome<T> => ({ ok: false, reason });

// ─── Scope ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Work outside a task that an exception can be about, by what the prompts call it. */
export const SCOPE_UNIT_KINDS = ["planning", "integration", "apply", "acceptance"] as const;
export type ScopeUnitKind = (typeof SCOPE_UNIT_KINDS)[number];

/** The id of a unit that is the whole run's (integration, apply, acceptance), and of the planning of a team without groups. */
export const RUN_UNIT = "run";

/** The id of the planning of a team without groups. It is no group's: a group's planning is `planningUnit(name)`, `group:<name>`, so no group name (even "run") can be taken for it. */
export const UNGROUPED_PLANNING = "ungrouped";
const GROUP_PREFIX = "group:";

/** The planning unit of a group (null: a team without groups). */
export const planningUnit = (group: string | null): UnitRef => ({ kind: "planning", id: group === null ? UNGROUPED_PLANNING : `${GROUP_PREFIX}${group}` });

/** The kind of work outside a task, and whose it is: `planningUnit(group)` for a planning, `RUN_UNIT` for the run's own work. */
export interface UnitRef {
  kind: ScopeUnitKind;
  id: string;
}

/**
 * One occurrence of work outside a task. `occurrence` is read from the run's state when the request is made and kept with
 * it (`unitOccurrence`): the integration head commit, the tree to apply, the plan a group is about to write. Work that
 * replaces it (a new integration result, a new tree, a new plan) has another occurrence, so an exception decided for one
 * never covers the next: it needs its own decision.
 */
export interface ScopeUnit extends UnitRef {
  occurrence: string;
}

/**
 * The occurrence of a unit as the run stands now, or null when there is none (no integration yet, nothing verified to
 * apply, no approved brief to plan). It is agentduo's, derived from state, never taken from an agent.
 *  - planning: the approved brief and how many plans the group (or the team without groups) has written for it, the plan about to be written;
 *  - integration: the integration head's commit; apply: the verified tree; acceptance: both.
 */
export function unitOccurrence(state: OccurrenceState, unit: UnitRef): string | null {
  switch (unit.kind) {
    case "planning": {
      if (state.approvedBrief == null) return null;
      const group = unit.id === UNGROUPED_PLANNING ? null : unit.id.startsWith(GROUP_PREFIX) && unit.id.length > GROUP_PREFIX.length ? unit.id.slice(GROUP_PREFIX.length) : undefined;
      if (group === undefined) return null;
      const written = (state.plans ?? []).filter((p) => p.group === group && p.briefVersion === state.approvedBrief).length;
      return `brief${state.approvedBrief}.plan${written}`;
    }
    case "integration": return unit.id !== RUN_UNIT ? null : state.integration?.commit ? `commit:${state.integration.commit}` : null;
    case "apply": return unit.id !== RUN_UNIT ? null : state.verifiedTree ? `tree:${state.verifiedTree}` : null;
    case "acceptance": return unit.id !== RUN_UNIT ? null : state.integration?.commit || state.verifiedTree ? `commit:${state.integration?.commit ?? "-"}/tree:${state.verifiedTree ?? "-"}` : null;
  }
}

/** A unit with the occurrence it has now, or null. */
export function resolveUnit(state: OccurrenceState, unit: UnitRef): ScopeUnit | null {
  const occurrence = unitOccurrence(state, unit);
  return occurrence === null ? null : { kind: unit.kind, id: unit.id, occurrence };
}

const sameUnit = (a: ScopeUnit, b: ScopeUnit): boolean => a.kind === b.kind && a.id === b.id && a.occurrence === b.occurrence;

/**
 * What an exception covers: this run, and either its tasks or one unit of work. The run's id is agentduo's, never an
 * agent's. A scope is a key: matching is by identity (`scopeCovers`), and no text takes part in it.
 */
export interface ExceptionScope {
  runId: string;
  taskIds: string[];
  unit: ScopeUnit | null;
}

const ID = /^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,49}$/u;
const isUnitRef = (u: unknown): u is UnitRef =>
  !!u && typeof u === "object" && (SCOPE_UNIT_KINDS as readonly string[]).includes((u as UnitRef).kind) && typeof (u as UnitRef).id === "string" && ID.test((u as UnitRef).id);
const isUnit = (u: unknown): u is ScopeUnit => isUnitRef(u) && typeof (u as ScopeUnit).occurrence === "string" && (u as ScopeUnit).occurrence.trim() !== "";

/** What a call is about: a task, or a unit of work outside one (its occurrence is the run's current one). */
export type WorkRef = { task: string; unit?: undefined } | { unit: UnitRef; task?: undefined };
/** A work reference once its unit has an occurrence. */
type ResolvedWork = { task: string; unit?: undefined } | { unit: ScopeUnit; task?: undefined };

/** A work reference with the unit's occurrence read from the run now; null when the unit has none. */
function resolveWork(state: OccurrenceState, work: WorkRef): ResolvedWork | null {
  if (work.task !== undefined) return { task: work.task };
  const unit = isUnitRef(work.unit) ? resolveUnit(state, work.unit) : null;
  return unit ? { unit } : null;
}

/** The scope of a request made in a call: exactly the task (or unit) the call is about, in this run. */
export function callScope(state: GovernedState, ref: WorkRef): Outcome<ExceptionScope> {
  if (ref.task !== undefined) {
    if (!state.tasks.some((t) => t.id === ref.task)) return refuse(`'${ref.task}' is not a task of this run`);
    return done({ runId: state.id, taskIds: [ref.task], unit: null }, false);
  }
  if (!isUnitRef(ref.unit)) return refuse(`a unit of work is one of ${SCOPE_UNIT_KINDS.join(", ")} with an id`);
  const unit = resolveUnit(state, ref.unit);
  if (!unit) return refuse(`the run has no ${ref.unit.kind} '${ref.unit.id}' to ask about now`);
  return done({ runId: state.id, taskIds: [], unit }, false);
}

/** Whether a scope is well formed for this run: it is this run's, names tasks it has, or one unit, never both nor none. */
export function scopeProblems(state: GovernedState, scope: ExceptionScope): string[] {
  const problems: string[] = [];
  if (scope.runId !== state.id) problems.push(`the scope is of run '${scope.runId}', not this run`);
  const ids = new Set(scope.taskIds);
  if (ids.size !== scope.taskIds.length) problems.push("a task is named twice in the scope");
  for (const id of scope.taskIds) if (!state.tasks.some((t) => t.id === id)) problems.push(`'${id}' is not a task of this run`);
  if (scope.taskIds.length && scope.unit) problems.push("a scope is tasks or one unit of work, not both");
  else if (!scope.taskIds.length && !scope.unit) problems.push("a scope names tasks or one unit of work");
  if (scope.unit && !isUnit(scope.unit)) problems.push(`a unit of work is one of ${SCOPE_UNIT_KINDS.join(", ")} with an id`);
  return problems;
}

/** Whether `inner` is inside `outer`: the same run, and no task or unit that `outer` lacks. */
export function scopeWithin(inner: ExceptionScope, outer: ExceptionScope): boolean {
  if (inner.runId !== outer.runId) return false;
  if (inner.unit) return !!outer.unit && sameUnit(inner.unit, outer.unit);
  return inner.taskIds.every((id) => outer.taskIds.includes(id));
}

/** Whether a scope covers a piece of work of the run it is asked in. */
export function scopeCovers(scope: ExceptionScope, runId: string, ref: ResolvedWork): boolean {
  if (scope.runId !== runId) return false;
  if (ref.task !== undefined) return scope.taskIds.includes(ref.task);
  return !!scope.unit && !!ref.unit && sameUnit(scope.unit, ref.unit);
}

const sameScope = (a: ExceptionScope, b: ExceptionScope): boolean => scopeWithin(a, b) && scopeWithin(b, a);

// ─── Incidents and lessons ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where an incident comes from. Every source is checked against the run when it is recorded, so a lesson rests on
 * something that happened in this team's flow, never on an agent's say-so alone.
 *  - member_report: a member's `governance.issues`, in a call about `task` (or none);
 *  - escalation: a question the team escalated, once answered (the answer is the resolution);
 *  - review: a task whose review asked for changes; check: a task a check failed;
 *  - user_message: something the user said to the PM (a message of the run).
 * `occurrence` is the identity of the event itself, given by the caller: a member's report is the call's id and the issue's
 * index (`issueOccurrence`), a review or a check is what tells that review from the next (the task's attempt and round).
 * Retrying the recording of one occurrence returns its incident; another occurrence is another incident, whatever the
 * member, task and kind. An escalation and a user's message are unique by their own id.
 */
export type IncidentSource =
  | { kind: "member_report"; member: string; task: string | null; occurrence: string }
  | { kind: "escalation"; escalationId: string }
  | { kind: "review"; task: string; occurrence: string }
  | { kind: "check"; task: string; occurrence: string }
  | { kind: "user_message"; seq: number };

/** The occurrence of the `index`th issue of a member's result in the call `callId`: stable when the same result is recorded again. */
export const issueOccurrence = (callId: string, index: number): string => `${callId}#${index}`;

export type IncidentKind = "disagreement" | "deviation";

/**
 * reported: seen, not resolved yet; resolved: settled in the team's flow, so the PM may learn from it; recording: the PM
 * wrote a lesson that the store has not confirmed yet (a crash here is finished on resume); recorded: the rule is in
 * RULES.md (`lesson.ruleId`); no_lesson: the PM decided no new rule is needed.
 */
export type IncidentStatus = "reported" | "resolved" | "recording" | "recorded" | "no_lesson";

/** A question the PM asked the user because it could not decide (through the broker; `requestId` is its link). */
export interface Direction {
  requestId: string;
  /**
   * The work that waits for the answer (persisted, so a reloaded run holds it too): tasks or one unit occurrence; null
   * when nothing waits on it (an exception's own question holds through the exception).
   */
  scope?: ExceptionScope | null;
  /** The user's reply, as information: it grants nothing. */
  answer: string | null;
}

export interface Lesson {
  text: string;
  /** The rule's id in the team's RULES.md, once the store wrote it. */
  ruleId: string | null;
  /** Why no rule: set only when the PM decided none is needed. */
  rationale: string | null;
}

export interface Incident {
  id: string;
  kind: IncidentKind;
  source: IncidentSource;
  /** Who reported it: a member's name, or "agentduo" for what the flow itself recorded. */
  reportedBy: string;
  ruleIds: string[];
  summary: string;
  status: IncidentStatus;
  resolution: string | null;
  lesson: Lesson | null;
  direction: Direction | null;
  at: string;
}

// ─── Exceptions ───────────────────────────────────────────────────────────────────────────────────────────────────

/** What the PM concluded about a request, and what it shows the user: the rules, the alternative and the exact scope. */
export interface ExceptionAssessment {
  by: string;
  ruleIds: string[];
  reason: string;
  alternative: string;
  /** Inside what was asked for; the only work the exception can ever cover. */
  scope: ExceptionScope;
  /** The proposal as the user reads it. */
  summary: string;
}

/**
 * The user's decision, linked to the request that showed the assessment. `pending`: shown, no decision. `approved` and
 * `rejected` come only from the user's answer to `requestId` (or, for `rejected`, from the PM declining before it showed
 * anything: `requestId` is null then). `delivered`: the member who asked was told, which releases its held work.
 */
export interface ExceptionDecision {
  status: "pending" | "approved" | "rejected";
  requestId: string | null;
  /** Requests that showed it before (interrupted, asked again): an answer to one of them decides nothing. */
  previousRequestIds: string[];
  by: "user" | "pm" | null;
  at: string | null;
  delivered: boolean;
}

export interface RuleException {
  id: string;
  /** The member who asked. */
  from: string;
  /** The rules it asked to depart from. */
  ruleIds: string[];
  reason: string;
  alternative: string | null;
  /** What it asked for: the call's own task or unit, set by agentduo. */
  requested: ExceptionScope;
  /** The incident it came with, if any. */
  incidentId: string | null;
  assessment: ExceptionAssessment | null;
  /** The PM's question to the user when it could not decide how to go on. */
  direction: Direction | null;
  /** null: not shown to the user yet. */
  decision: ExceptionDecision | null;
  at: string;
}

/** requested: waiting for the PM; assessed: the PM's proposal, not shown yet; pending: shown to the user; approved; rejected. */
export type ExceptionStatus = "requested" | "assessed" | "pending" | "approved" | "rejected";

export const exceptionStatus = (ex: RuleException): ExceptionStatus => ex.decision?.status ?? (ex.assessment ? "assessed" : "requested");

export interface RuleGovernance {
  incidents: Incident[];
  exceptions: RuleException[];
  /** Counters of the ids "I1", "X1": never reused, so a request is never taken for another. */
  nextIncident: number;
  nextException: number;
}

export const emptyGovernance = (): RuleGovernance => ({ incidents: [], exceptions: [], nextIncident: 1, nextException: 1 });

/** The run's governance state, created in a run from before it existed (the state stays compatible with older runs). */
export function governanceOf(state: GovernedState): RuleGovernance {
  const g = (state.governance ??= emptyGovernance());
  g.incidents ??= [];
  g.exceptions ??= [];
  g.nextIncident ??= g.incidents.length + 1;
  g.nextException ??= g.exceptions.length + 1;
  return g;
}

const now = () => new Date().toISOString();
const clean = (text: string) => text.trim();
const uniq = (ids: string[]) => [...new Set(ids.map(clean).filter(Boolean))];

/** Rule ids that name no rule (when the store's ids are given), each said so that the member can correct exactly it. */
function ruleProblems(ruleIds: string[], known: ReadonlySet<string> | undefined, required: boolean): string[] {
  const problems: string[] = [];
  if (required && !ruleIds.length) problems.push("name at least one rule id");
  if (known) for (const id of ruleIds) if (!known.has(id)) problems.push(`'${id}' is not a rule of this team (${[...known].join(", ") || "it has none"})`);
  return problems;
}

const sourceKey = (s: IncidentSource): string => {
  switch (s.kind) {
    case "member_report": return `member_report:${s.member}:${s.task ?? "-"}:${s.occurrence}`;
    case "escalation": return `escalation:${s.escalationId}`;
    case "review": return `review:${s.task}:${s.occurrence}`;
    case "check": return `check:${s.task}:${s.occurrence}`;
    case "user_message": return `user_message:${s.seq}`;
  }
};

/** What is wrong with an incident's source in this run (empty: it happened). */
export function sourceProblems(state: GovernedState, source: IncidentSource): string[] {
  const task = (id: string): TaskState | undefined => state.tasks.find((t) => t.id === id);
  if ("occurrence" in source && !String(source.occurrence ?? "").trim()) return [`a ${source.kind} names the occurrence it is about`];
  switch (source.kind) {
    case "member_report":
      if (!source.member.trim()) return ["a member's report names the member"];
      return source.task !== null && !task(source.task) ? [`'${source.task}' is not a task of this run`] : [];
    case "escalation": {
      const e = state.escalations?.find((x) => x.id === source.escalationId);
      if (!e) return [`'${source.escalationId}' is not an escalation of this run`];
      return e.answer === null ? [`escalation '${source.escalationId}' is not answered yet`] : [];
    }
    case "review": {
      const t = task(source.task);
      if (!t) return [`'${source.task}' is not a task of this run`];
      return t.review?.verdict === "changes" ? [] : [`task '${source.task}' has no review that asked for changes`];
    }
    case "check": {
      const t = task(source.task);
      if (!t) return [`'${source.task}' is not a task of this run`];
      return t.checks.some((c) => c.verdict === "fail") ? [] : [`task '${source.task}' has no failed check`];
    }
    case "user_message":
      return state.messages?.some((m) => m.seq === source.seq && m.from === "user") ? [] : [`message ${source.seq} is no message of the user in this run`];
  }
}

export interface IncidentInput {
  kind: IncidentKind;
  source: IncidentSource;
  reportedBy: string;
  ruleIds?: string[];
  summary: string;
  /** The ids of the team's rules, when known: the incident may name no other. */
  known?: ReadonlySet<string>;
}

/**
 * Records an incident. The same occurrence of the same source and kind again returns the incident already recorded (a
 * retried turn reports it twice, and nothing is counted twice); another occurrence is a new incident, never the old one. An escalation that was answered is resolved by its answer; any other begins
 * `reported` and is resolved by the flow (`resolveIncident`).
 */
export function recordIncident(state: GovernedState, input: IncidentInput): Outcome<Incident> {
  const g = governanceOf(state);
  const summary = clean(input.summary);
  if (!summary) return refuse("say what happened");
  const ruleIds = uniq(input.ruleIds ?? []);
  const problems = [...sourceProblems(state, input.source), ...ruleProblems(ruleIds, input.known, false)];
  if (problems.length) return refuse(problems.join("; "));
  const key = `${input.kind}|${sourceKey(input.source)}`;
  const same = g.incidents.find((i) => `${i.kind}|${sourceKey(i.source)}` === key);
  if (same) return done(same, false);
  const answered = input.source.kind === "escalation" ? state.escalations!.find((e) => e.id === (input.source as { escalationId: string }).escalationId)!.answer : null;
  const incident: Incident = {
    id: `I${g.nextIncident++}`, kind: input.kind, source: structuredClone(input.source), reportedBy: input.reportedBy, ruleIds, summary,
    status: answered !== null ? "resolved" : "reported", resolution: answered, lesson: null, direction: null, at: now(),
  };
  g.incidents.push(incident);
  return done(incident, true);
}

const incidentOf = (state: GovernedState, id: string): Incident | null => governanceOf(state).incidents.find((i) => i.id === id) ?? null;
const noIncident = (id: string) => refuse<never>(`'${id}' is not an incident of this run`);

/** The flow settled the incident (the disagreement was decided, the deviation corrected). Repeating it changes nothing. */
export function resolveIncident(state: GovernedState, id: string, resolution: string): Outcome<Incident> {
  const i = incidentOf(state, id);
  if (!i) return noIncident(id);
  if (i.status !== "reported") return done(i, false);
  const text = clean(resolution);
  if (!text) return refuse("say how it was resolved");
  i.status = "resolved";
  i.resolution = text;
  return done(i, true);
}

/**
 * The PM writes a lesson for a resolved incident: the text of the rule to append. It is `recording` until the store
 * confirms (`completeLesson`); the same text again returns it, and another text while one is recording is refused.
 */
export function beginLesson(state: GovernedState, id: string, text: string): Outcome<Incident> {
  const i = incidentOf(state, id);
  if (!i) return noIncident(id);
  const rule = clean(text);
  if (!rule) return refuse("write the rule");
  if (i.status === "recording" || i.status === "recorded") {
    return i.lesson?.text === rule ? done(i, false) : refuse(`incident ${id} already has a lesson (${i.status}); a rule is never replaced`);
  }
  if (i.status !== "resolved") return refuse(i.status === "no_lesson" ? `incident ${id} was closed without a lesson` : `incident ${id} is not resolved yet`);
  i.status = "recording";
  i.lesson = { text: rule, ruleId: null, rationale: null };
  return done(i, true);
}

/** The store wrote the rule: the lesson is recorded under the rule's id. The same id again changes nothing. */
export function completeLesson(state: GovernedState, id: string, ruleId: string): Outcome<Incident> {
  const i = incidentOf(state, id);
  if (!i) return noIncident(id);
  if (!clean(ruleId)) return refuse("name the rule the store wrote");
  if (i.status === "recorded") return i.lesson?.ruleId === ruleId ? done(i, false) : refuse(`incident ${id} is recorded as rule ${i.lesson?.ruleId}`);
  if (i.status !== "recording") return refuse(`incident ${id} has no lesson being recorded`);
  i.status = "recorded";
  i.lesson!.ruleId = ruleId;
  return done(i, true);
}

/** The PM decided a resolved incident needs no new rule. Nothing is removed; repeating it changes nothing. */
export function declineLesson(state: GovernedState, id: string, rationale: string): Outcome<Incident> {
  const i = incidentOf(state, id);
  if (!i) return noIncident(id);
  if (i.status === "no_lesson") return done(i, false);
  if (i.status !== "resolved") return refuse(i.status === "reported" ? `incident ${id} is not resolved yet` : `incident ${id} already has a lesson (${i.status})`);
  i.status = "no_lesson";
  i.lesson = { text: "", ruleId: null, rationale: clean(rationale) || null };
  return done(i, true);
}

// ─── Exception requests ───────────────────────────────────────────────────────────────────────────────────────────

export interface ExceptionInput {
  from: string;
  ruleIds: string[];
  reason: string;
  alternative?: string | null;
  /** The task or unit of the call the member made the request in: its scope is exactly this. */
  work: WorkRef;
  incidentId?: string | null;
  known?: ReadonlySet<string>;
}

const exceptionOf = (state: GovernedState, id: string): RuleException | null => governanceOf(state).exceptions.find((e) => e.id === id) ?? null;
const noException = (id: string) => refuse<never>(`'${id}' is not an exception request of this run`);
const sameRules = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/**
 * A member's request for an exception. Its scope is the call's own work, set here: the member cannot ask for another
 * task's. The same request again (same member, rules and work) returns the one made, so a retried turn adds none; once
 * the user refused it, asking again for the same work is refused, not a new request.
 */
export function requestException(state: GovernedState, input: ExceptionInput): Outcome<RuleException> {
  const g = governanceOf(state);
  const ruleIds = uniq(input.ruleIds);
  const reason = clean(input.reason);
  const problems = [...ruleProblems(ruleIds, input.known, true)];
  if (!reason) problems.push("say why the rules do not fit this work");
  const scope = callScope(state, input.work);
  if (!scope.ok) problems.push(scope.reason);
  const incidentId = input.incidentId ?? null;
  if (incidentId !== null && !incidentOf(state, incidentId)) problems.push(`'${incidentId}' is not an incident of this run`);
  if (problems.length || !scope.ok) return refuse(problems.join("; "));
  const same = g.exceptions.find((e) => e.from === input.from && sameRules(e.ruleIds, ruleIds) && sameScope(e.requested, scope.value));
  if (same) return exceptionStatus(same) === "rejected" ? refuse(`the exception for ${ruleIds.join(", ")} on this work was already refused`) : done(same, false);
  const ex: RuleException = {
    id: `X${g.nextException++}`, from: input.from, ruleIds, reason, alternative: clean(input.alternative ?? "") || null, requested: scope.value, incidentId,
    assessment: null, direction: null, decision: null, at: now(),
  };
  g.exceptions.push(ex);
  return done(ex, true);
}

export interface AssessmentInput {
  by: string;
  ruleIds: string[];
  reason: string;
  alternative: string;
  /** The exact work: tasks (some of the request's) or the request's unit. */
  taskIds: string[];
  /** Which unit: the request's own (its occurrence is the request's, never the PM's). */
  unit: UnitRef | null;
  summary: string;
  known?: ReadonlySet<string>;
}

/**
 * The PM's assessment: the rules, the reason, the alternative and the exact scope, which may narrow the request's and
 * never widens it. It can be replaced until it is shown to the user, and not after (what the user sees is what they
 * decide on).
 */
export function assessException(state: GovernedState, id: string, input: AssessmentInput): Outcome<RuleException> {
  const ex = exceptionOf(state, id);
  if (!ex) return noException(id);
  if (ex.decision) return refuse(`exception ${id} was already shown to the user; a new request is needed to change it`);
  const ruleIds = uniq(input.ruleIds);
  const problems = [...ruleProblems(ruleIds, input.known, true)];
  let unit: ScopeUnit | null = null;
  if (input.unit) {
    const asked = ex.requested.unit;
    if (asked && asked.kind === input.unit.kind && asked.id === input.unit.id) unit = { ...asked };
    else problems.push(`the unit is not the one asked for (${asked ? `${asked.kind} '${asked.id}'` : "tasks " + ex.requested.taskIds.join(", ")})`);
  }
  const scope: ExceptionScope = { runId: state.id, taskIds: uniq(input.taskIds), unit };
  const scoped = scopeProblems(state, scope);
  if (unit || !input.unit) problems.push(...scoped);
  for (const r of ruleIds) if (!ex.ruleIds.includes(r)) problems.push(`rule '${r}' was not in the request (${ex.ruleIds.join(", ")})`);
  if ((unit || !input.unit) && !scoped.length && !scopeWithin(scope, ex.requested)) problems.push("the scope goes beyond what was asked for; a request for other work is a request of its own");
  if (!clean(input.reason)) problems.push("give the reason the user reads");
  if (!clean(input.alternative)) problems.push("say what the team does instead");
  if (!clean(input.summary)) problems.push("write the proposal as the user reads it");
  if (problems.length) return refuse(problems.join("; "));
  ex.assessment = { by: input.by, ruleIds, reason: clean(input.reason), alternative: clean(input.alternative), scope, summary: clean(input.summary) };
  return done(ex, true);
}

/** Every request id in use: an id that links a user's answer to one request must belong to no other. */
function requestIds(state: GovernedState): Set<string> {
  const g = governanceOf(state);
  const ids = new Set<string>();
  for (const e of g.exceptions) {
    if (e.decision?.requestId) ids.add(e.decision.requestId);
    for (const p of e.decision?.previousRequestIds ?? []) ids.add(p);
    if (e.direction) ids.add(e.direction.requestId);
  }
  for (const i of g.incidents) if (i.direction) ids.add(i.direction.requestId);
  if (state.waiting) ids.add(state.waiting.requestId);
  return ids;
}

/** The PM's assessment is shown to the user in the request `requestId`: from here the decision is pending. The same id again changes nothing. */
export function presentException(state: GovernedState, id: string, requestId: string): Outcome<RuleException> {
  const ex = exceptionOf(state, id);
  if (!ex) return noException(id);
  if (!clean(requestId)) return refuse("the request that shows it has an id");
  if (ex.decision) {
    if (ex.decision.status === "pending" && ex.decision.requestId === requestId) return done(ex, false);
    return refuse(ex.decision.status === "pending" ? `exception ${id} is already shown in request ${ex.decision.requestId}` : `exception ${id} was already decided`);
  }
  if (!ex.assessment) return refuse(`exception ${id} has no assessment of the PM to show`);
  if (ex.direction && ex.direction.answer === null) return refuse(`exception ${id} waits for the user's answer to the PM's question`);
  if (requestIds(state).has(requestId)) return refuse(`request ${requestId} already stands for something else`);
  ex.decision = { status: "pending", requestId, previousRequestIds: [], by: null, at: null, delivered: false };
  return done(ex, true);
}

/** The PM turns down a request before showing it to the user (the rules stand): nothing is granted, and nobody was asked. */
export function declineException(state: GovernedState, id: string): Outcome<RuleException> {
  const ex = exceptionOf(state, id);
  if (!ex) return noException(id);
  if (ex.decision) return ex.decision.status === "rejected" ? done(ex, false) : refuse(`exception ${id} was already shown to the user`);
  ex.decision = { status: "rejected", requestId: null, previousRequestIds: [], by: "pm", at: now(), delivered: false };
  return done(ex, true);
}

/** An answer as the broker gives it, for the option ids this module's requests offer. */
export const APPROVE_OPTION = "approve";
export const REJECT_OPTION = "reject";

/**
 * What an answer to an exception request decides: approved only for exactly the approve option; rejected for exactly the
 * reject option; anything else (no option, both, another option, free text) is no decision: the request stays pending.
 */
export function decisionFromAnswer(answer: { optionIds: readonly string[]; otherText?: string | null }): "approved" | "rejected" | null {
  if (answer.otherText && answer.otherText.trim()) return null;
  if (answer.optionIds.length !== 1) return null;
  return answer.optionIds[0] === APPROVE_OPTION ? "approved" : answer.optionIds[0] === REJECT_OPTION ? "rejected" : null;
}

/** The user's decision on a request: the only way an exception becomes approved. */
export interface UserDecision {
  /** The request the user answered. */
  requestId: string;
  /** Always the user: nothing else decides. Checked at run time too. */
  source: "user";
  approved: boolean;
}

/**
 * Applies the user's decision. It needs the very request that showed the exception and is still pending; an unknown, old
 * or other request (a plan's approval, a question's answer, a replay) decides nothing. A decision made does not flip:
 * the same again changes nothing, the opposite is refused.
 */
export function decideException(state: GovernedState, decision: UserDecision): Outcome<RuleException> {
  if (decision.source !== "user") return refuse("only the user decides an exception");
  const g = governanceOf(state);
  const ex = g.exceptions.find((e) => e.decision?.requestId === decision.requestId);
  if (!ex || !ex.decision) {
    const old = g.exceptions.find((e) => e.decision?.previousRequestIds.includes(decision.requestId));
    return refuse(old ? `request ${decision.requestId} was replaced by a later one; it decides nothing` : `request ${decision.requestId} shows no exception`);
  }
  const wanted = decision.approved ? "approved" : "rejected";
  if (ex.decision.status !== "pending") return ex.decision.status === wanted ? done(ex, false) : refuse(`exception ${ex.id} was already ${ex.decision.status}`);
  ex.decision.status = wanted;
  ex.decision.by = "user";
  ex.decision.at = now();
  return done(ex, true);
}

/** The member who asked has been told the decision: its held work goes on (under the rules, or inside the approved scope). */
export function deliverDecision(state: GovernedState, id: string): Outcome<RuleException> {
  const ex = exceptionOf(state, id);
  if (!ex) return noException(id);
  if (!ex.decision || ex.decision.status === "pending") return refuse(`exception ${id} is not decided`);
  if (ex.decision.delivered) return done(ex, false);
  ex.decision.delivered = true;
  return done(ex, true);
}

// ─── The PM's questions to the user ───────────────────────────────────────────────────────────────────────────────

/** Where a question stands: an exception request or an incident. */
export type DirectionTarget = { exceptionId: string; incidentId?: undefined } | { incidentId: string; exceptionId?: undefined };

/**
 * The PM could not decide and asked the user (`requestId`): the work that depends on it stays held until the answer
 * (`work` for an incident: the task or unit that waits; by default its source's task, none when it has none). The answer is
 * information: it never approves anything. The same request again changes nothing.
 */
export function askDirection(state: GovernedState, target: DirectionTarget, requestId: string, work?: WorkRef | null): Outcome<Direction> {
  if (!clean(requestId)) return refuse("the question has a request id");
  const holder = target.exceptionId !== undefined ? exceptionOf(state, target.exceptionId) : incidentOf(state, target.incidentId);
  if (!holder) return refuse(`'${target.exceptionId ?? target.incidentId}' is not in this run`);
  if ("requested" in holder && holder.decision) return refuse(`exception ${holder.id} was already shown to the user`);
  if (holder.direction) {
    return holder.direction.requestId === requestId ? done(holder.direction, false) : refuse(`${holder.id} already has the question in request ${holder.direction.requestId}`);
  }
  if (requestIds(state).has(requestId)) return refuse(`request ${requestId} already stands for something else`);
  // What waits for the answer. An exception holds its own work; an incident holds the work named (default: its source's task).
  let scope: ExceptionScope | null = null;
  if ("source" in holder) {
    const src = holder.source;
    const ref: WorkRef | null = work === undefined ? ("task" in src && src.task ? { task: src.task } : null) : work;
    if (ref) {
      const made = callScope(state, ref);
      if (!made.ok) return refuse(made.reason);
      scope = made.value;
    }
  }
  holder.direction = { requestId, scope, answer: null };
  return done(holder.direction, true);
}

/** The user answered the PM's question (`requestId`). Any other id answers nothing. Never a grant. */
export function answerDirection(state: GovernedState, requestId: string, answer: string): Outcome<Direction> {
  const g = governanceOf(state);
  const d = [...g.exceptions, ...g.incidents].map((h) => h.direction).find((x) => x?.requestId === requestId);
  if (!d) return refuse(`request ${requestId} is no question of the PM's`);
  const text = clean(answer);
  if (!text) return refuse("an empty answer settles nothing");
  if (d.answer !== null) return d.answer === text ? done(d, false) : refuse(`request ${requestId} was already answered`);
  d.answer = text;
  return done(d, true);
}

/**
 * A request that never reached the user (the question was interrupted, the app closed) is asked again under a new id.
 * Only a request still waiting moves; the old id then decides and answers nothing.
 */
export function repointRequest(state: GovernedState, oldId: string, newId: string): Outcome<string> {
  if (!clean(newId)) return refuse("the new request has an id");
  if (oldId === newId) return done(newId, false);
  const g = governanceOf(state);
  if (requestIds(state).has(newId)) return refuse(`request ${newId} already stands for something else`);
  const ex = g.exceptions.find((e) => e.decision?.requestId === oldId);
  if (ex?.decision) {
    if (ex.decision.status !== "pending") return refuse(`exception ${ex.id} was already ${ex.decision.status}`);
    ex.decision.previousRequestIds.push(oldId);
    ex.decision.requestId = newId;
    return done(newId, true);
  }
  const d = [...g.exceptions, ...g.incidents].map((h) => h.direction).find((x) => x?.requestId === oldId);
  if (!d) return refuse(`request ${oldId} is not waiting for anything`);
  if (d.answer !== null) return refuse(`request ${oldId} was already answered`);
  d.requestId = newId;
  return done(newId, true);
}

// ─── What an approved exception allows, and what it holds ────────────────────────────────────────────────────────

/**
 * The approved exceptions that apply to a piece of work in this run: approved by the user, covering exactly this task
 * (or unit). For `ruleId`, only those naming that rule. A refused, pending or unanswered one never appears here, and
 * the rule stays in force as written.
 */
export function exceptionsFor(state: GovernedState, work: WorkRef, ruleId?: string): RuleException[] {
  const at = resolveWork(state, work);
  if (!at) return [];
  return governanceOf(state).exceptions.filter((e) =>
    e.decision?.status === "approved" && e.decision.by === "user" && !!e.assessment && scopeCovers(e.assessment.scope, state.id, at) &&
    (ruleId === undefined || e.assessment.ruleIds.includes(ruleId)));
}

/** The approved exception that lets a piece of work depart from a rule, or null: the rule stands. */
export const exceptionGrant = (state: GovernedState, work: WorkRef, ruleId: string): RuleException | null => exceptionsFor(state, work, ruleId)[0] ?? null;

/**
 * Whether an exception still holds the work in its request's scope: not decided yet (waiting for the PM, for the user's
 * answer to its question, or for the user's decision), or decided and the member not told yet.
 */
export function holdsWork(ex: RuleException): boolean {
  const status = exceptionStatus(ex);
  return status === "pending" || status === "requested" || status === "assessed" || !ex.decision!.delivered;
}

/** The scopes that hold work now: an open exception's request (whatever the assessment narrowed it to), and the work an unanswered question of the PM's about an incident waits on. */
function holdingScopes(state: { governance?: RuleGovernance }): ExceptionScope[] {
  const g = state.governance;
  const scopes: ExceptionScope[] = [];
  for (const e of g?.exceptions ?? []) if (holdsWork(e)) scopes.push(e.requested);
  for (const i of g?.incidents ?? []) if (i.direction && i.direction.answer === null && i.direction.scope) scopes.push(i.direction.scope);
  return scopes;
}

/** The tasks held by an open exception request or by an unanswered question about an incident. */
export function heldTaskIds(state: { governance?: RuleGovernance }): Set<string> {
  return new Set(holdingScopes(state).flatMap((s) => s.taskIds));
}

/**
 * Whether a unit of work outside a task is held in the same way, for the occurrence it has now (a group's planning, the
 * integration, the apply, the acceptance). A request about an earlier occurrence (replaced since) holds nothing.
 */
export function unitHeld(state: { governance?: RuleGovernance } & OccurrenceState, unit: UnitRef): boolean {
  const now = resolveUnit(state, unit);
  return !!now && holdingScopes(state).some((s) => !!s.unit && sameUnit(s.unit, now));
}

// ─── What the PM and the run have to do ──────────────────────────────────────────────────────────────────────────

export interface GovernanceWork {
  /** Resolved incidents the PM has not decided about (or whose lesson was being recorded when the run stopped). */
  lessons: Incident[];
  /** Requests waiting for the PM's assessment. */
  assess: RuleException[];
  /** Assessed requests to show to the user. */
  present: RuleException[];
  /** Shown, undecided: the requests to restore after a pause. */
  pending: RuleException[];
  /** The PM's questions to the user still unanswered. */
  questions: Array<{ requestId: string; exceptionId: string | null; incidentId: string | null }>;
  /** Decided, the member not told yet. */
  undelivered: RuleException[];
}

/** What is owed, in the order it was asked: a pure reading of the state, so a resumed run finds exactly what a paused one left. */
export function governanceWork(state: GovernedState): GovernanceWork {
  const g = governanceOf(state);
  const open = (e: RuleException) => !e.decision || e.decision.status === "pending";
  return {
    lessons: g.incidents.filter((i) => i.status === "resolved" || i.status === "recording"),
    assess: g.exceptions.filter((e) => !e.decision && !e.assessment && (!e.direction || e.direction.answer !== null)),
    present: g.exceptions.filter((e) => !e.decision && !!e.assessment && (!e.direction || e.direction.answer !== null)),
    pending: g.exceptions.filter((e) => e.decision?.status === "pending"),
    questions: [
      ...g.exceptions.filter((e) => open(e) && e.direction?.answer === null).map((e) => ({ requestId: e.direction!.requestId, exceptionId: e.id, incidentId: null })),
      ...g.incidents.filter((i) => i.direction?.answer === null).map((i) => ({ requestId: i.direction!.requestId, exceptionId: null, incidentId: i.id })),
    ],
    undelivered: g.exceptions.filter((e) => e.decision && e.decision.status !== "pending" && !e.decision.delivered),
  };
}

// ─── What members report ──────────────────────────────────────────────────────────────────────────────────────────

/** The `governance` field of a member's result (packages/engine/schemas/team_*.schema.json). */
export interface GovernanceReport {
  issues: Array<{ kind: IncidentKind; summary: string; rule_ids: string[] }>;
  exception: { rule_ids: string[]; reason: string; alternative: string | null } | null;
}

/**
 * A member's result split in two: the request (issues and exception) and the result itself. A result that asks for an
 * exception does not complete the work: it is not merged, approved or counted as done until the user decided.
 */
export function splitReport<T extends object>(output: T & { governance?: GovernanceReport | null }): { result: Omit<T, "governance">; report: GovernanceReport; completes: boolean } {
  const { governance, ...result } = output;
  const report: GovernanceReport = { issues: governance?.issues ?? [], exception: governance?.exception ?? null };
  return { result, report, completes: report.exception === null };
}
