// A team run (docs/superpowers/specs/2026-11-12-agentduo-team-design.md): the PM talks with the user, the techlead plans
// and assigns, the members work in parallel in worktrees of their own, the testers check every task, and the result is
// written into the workspace once the user accepts it. Everything the user decides comes through the decider (the
// chat's broker); everything an agent says to the user is the PM's (`team.message`).
import { rmSync } from "node:fs";
import { join } from "node:path";
import { AgentRunner, type CallBudget } from "../agents/runner.js";
import type { SchemaName } from "../agents/schema.js";
import {
  answerText, ledgerAnswer, ledgerClose, ledgerOpen, parseQuestions, type ClarificationAnswer, type ClarificationQuestion, type ClarificationRequest,
  type ClarificationResponse,
} from "../clarification/clarification.js";
import { configFromSaved, type ConfigData } from "../config/config.js";
import { implementerPermissionArgs } from "../config/settings.js";
import type { ClarificationDecider, EventBus, PermissionDecider } from "../events.js";
import type { Git } from "../git/git.js";
import { prepareRunGit, RunGitError } from "../git/run-git.js";
import type { Attachment } from "../inputs/attachment-types.js";
import { AttachmentStore, attachmentFile } from "../inputs/attachments.js";
import { dataRoot } from "../paths.js";
import { describeGates, requiredPassed, runGates } from "../quality/gates.js";
import { configLimits, describeLimit, reachedLimits, type BudgetUsage } from "../workflow/budget.js";
import { relativeInside } from "../workflow/workflow.js";
import {
  blocks, boardJobs, checksComplete, failureKey, finished, jobKey, leadOf, madeProgress, newTask, ownJob, planProblems, testsWritten, type Job,
} from "./board.js";
import { headPm, memberProfile, teamGroups, teamId, teamMembers, type Member, type TeamGroup } from "./config.js";
import { identityDirs, memberIdentity, teamIdentities, type TeamIdentities } from "./identity.js";
import type { TeamTaskView } from "./model.js";
import {
  answerDirection, APPROVE_OPTION, askDirection, assessException, callScope, beginLesson, completeLesson, declineException, declineLesson, decideException, decisionFromAnswer,
  deliverDecision, governanceWork, heldTaskIds, holdsWork, issueOccurrence, planningUnit, presentException, recordIncident, repointRequest, REJECT_OPTION,
  requestException, resolveIncident, RUN_UNIT, unitHeld, type ExceptionScope, type GovernanceReport, type GovernedState, type Incident, type IncidentInput,
  type RuleException, type ScopeUnitKind, type WorkRef,
} from "./rule-governance.js";
import { ruleInputProblem, TeamRules, teamRulesDir, workspaceKey, RulesError, type RuleEntry } from "./rules.js";
import {
  answerPrompt, applyWork, areaPmPrompt, authored, checkPrompt, filesSection, integrationCheckPrompt, integrationTriagePrompt, integrationWork, planningWork, planPrompt, pmActions, pmPrompt,
  resolvePrompt, reviewPrompt, testsPrompt, triagePrompt, workPrompt, type PmOccasion, type ReviewChange, type SessionPrompt, type SessionView,
} from "./prompts.js";
import {
  approvedBrief, currentAreas, groupKey, latestBrief, latestPlan, nextSeq, nowIso, planSignature, sessionKey, TeamStore, type Area, type SessionPurpose, type Brief, type CheckFailure,
  type Escalation, type PlanTask, type ReviewFinding, type TaskCheck, type TaskState, type TeamPlan, type TeamState,
} from "./state.js";
import { TeamGit } from "./worktrees.js";

export type TeamOutcome = "done" | "waiting" | "stopped" | "aborted" | "error";

export interface TeamRunOptions {
  store: TeamStore;
  state: TeamState;
  /** The run's configuration, as it started (config.json). */
  cfg: ConfigData;
  workspace: string;
  bus: EventBus;
  /** Who answers the approvals and the PM's questions; absent when nobody can (the run stops when it needs you). */
  decider?: ClarificationDecider;
  permissions?: PermissionDecider;
  runner?: AgentRunner;
  env?: NodeJS.ProcessEnv;
  /** At least this long between two report turns of the PM (default REPORT_INTERVAL_MS). */
  reportIntervalMs?: number;
}

/** At most one report turn of the PM per minute: milestones close together become one update. */
export const REPORT_INTERVAL_MS = 60_000;

const APPROVE = "approve";
/** What a message of files alone says, as the chat's question about files does. */
const FILES_ALONE = "Look at the attached file(s).";
const CHANGE = "change";

type PmOutput = {
  message: string | null;
  action:
    | { kind: "none" }
    | { kind: "questions"; questions: Array<{ header: string; question: string; multi_select: boolean; options: Array<{ label: string; description: string }> }> }
    | { kind: "brief"; brief: Omit<Brief, "version"> }
    | { kind: "plan_review"; approve: boolean; issues: Array<{ id: string; issue: string; group: string | null }>; summary: string | null }
    | { kind: "lead_note"; note: string; group: string | null }
    | { kind: "team_answer"; question_id: string; answer: string }
    | { kind: "rule_lesson"; lessons: LessonAnswer[] }
    | {
      kind: "exception_proposal"; exception_id: string; rule_ids: string[]; reason: string; alternative: string; task_ids: string[];
      unit: { kind: ScopeUnitKind; id: string } | null; summary: string;
    }
    | { kind: "exception_decline"; exception_id: string; reason: string }
    | {
      kind: "rule_question"; incident_id: string | null; exception_id: string | null;
      questions: Array<{ header: string; question: string; multi_select: boolean; options: Array<{ label: string; description: string }> }>;
    }
    | { kind: "escalate"; question_id: string; question: string }
    | { kind: "areas"; areas: Array<{ group: string; area: string; criteria: string[] }> }
    | { kind: "change_request"; brief: Omit<Brief, "version"> }
    | { kind: "acceptance"; criteria: Array<{ id: string; status: string; evidence: string }>; summary: string };
};
type PlanOutput = { summary: string; tasks: PlanTask[]; risks: string[]; report: string };
type WorkOutput = { status: "done" | "blocked"; summary: string; files_changed: string[]; question: string | null; notes: string[] };
type ReviewOutput = { verdict: "approve" | "changes"; summary: string; findings: ReviewFinding[] };
type TestsOutput = { summary: string; test_files: string[]; cases: unknown[]; how_to_run: string | null };
type CheckOutput = { verdict: "pass" | "fail"; summary: string; results: unknown[]; failures: CheckFailure[]; added_tests: string[] };
type TriageOutput = { action: "retry" | "reassign" | "fix_tests" | "add_tasks" | "escalate"; assignee: string | null; guidance: string; question: string | null; tasks: PlanTask[]; report: string };
type AnswerOutput = { answer: string | null; escalate: string | null; report: string | null };
/** The PM's lesson for one settled incident: a rule to append, or null and why none is needed. */
type LessonAnswer = { incident_id: string; rule: string | null; rationale: string };

class Interrupted extends Error {}

/**
 * A member's call asked for an exception to the team's rules: the request is saved and the work it is about waits for the
 * decision, so the rest of the call's result is not used (an exception request never completes the work). Not a failure.
 */
class Held extends Error {}

/** A scope as the user and the PMs read it: the tasks (with their titles) or the unit of work. */
const scopeWords = (scope: ExceptionScope, tasks: readonly TaskState[]): string =>
  scope.unit
    ? `the ${scope.unit.kind}${scope.unit.id === RUN_UNIT ? "" : ` of ${scope.unit.id}`} (${scope.unit.occurrence})`
    : scope.taskIds.map((id) => `task ${id}${tasks.find((t) => t.id === id) ? ` (${tasks.find((t) => t.id === id)!.title})` : ""}`).join(", ");

/** Which team's rules a run uses: its configuration's team id and the key of its workspace. */
const rulesIdentity = (cfg: ConfigData, workspace: string): NonNullable<TeamState["rulesStore"]> => ({ teamId: teamId(cfg.team), workspaceKey: workspaceKey(workspace) });

/** The operation that adds an incident's rule to RULES.md: the run's and the incident's, so the rule is added once however often it is tried. */
const lessonOp = (runId: string, incidentId: string): string => `lesson:${runId}:${incidentId}`;

/** The line RULES.md shows under a rule: where it came from (never agentduo's own marker, whatever an agent wrote). */
const lessonSource = (runId: string, i: Incident): string =>
  `run ${runId}, ${i.id} (${i.kind}): ${i.summary}`.replace(/\s+/g, " ").replaceAll("<!-- agentduo-rule", "<!-- agentduo rule").slice(0, 500);

const taskView = (t: TaskState): TeamTaskView => ({
  id: t.id, title: t.title, status: t.status, assignee: t.assignee, testers: [...t.testers], attempt: t.attempt, dependsOn: [...t.depends_on],
  group: t.group ?? null,
});

/** The worktree agentduo runs the gates in: not a member's name (those start with a letter or a digit). */
const GATES = "_gates";

export class TeamRun {
  readonly members: Member[];
  /** The team's groups (one, named null, in a team without groups), and the head PM, who talks with you. */
  readonly groups: TeamGroup[];
  readonly head: Member;
  private identities: TeamIdentities | null = null;
  private readonly runner: AgentRunner;
  private tg: TeamGit | null = null;
  private git: Git | null = null;
  private readonly running = new Map<string, Promise<void>>();
  private readonly busy = new Set<string>();
  private wakeUp: (() => void) | null = null;
  private woken = false;
  private stopRequested = false;
  private abortRequested = false;
  private abort = new AbortController();
  /** Requests open with the decider now (approvals, the PM's questions), by id. */
  private readonly open = new Set<string>();
  /** Requests the decider put off in this process: asked again only by a later run. */
  private readonly deferred = new Set<string>();
  /** Failed attempts of a job in this process, by key: the second failure stops it and asks the user. */
  private readonly failures = new Map<string, number>();
  /** Why nothing more may start in this process: a budget limit reached, or the PM failing again and again. */
  private budgetReached: string | null = null;
  private reportTimer: NodeJS.Timeout | null = null;
  private readonly env: NodeJS.ProcessEnv;
  /** The team's RULES.md, opened by the first call or step that needs it (`rulesStore`). */
  private rules: TeamRules | null = null;
  /** The rules a prompt being built is given: read once per call, so a full prompt and a continued one carry the same (`call`, `parts`). */
  private promptRules: readonly RuleEntry[] | null = null;
  /** PM turns for a lesson in this process that left no incident settled: after two, none is offered again until a later run. */
  private lessonStalled = 0;
  /** When lessons first became due while members worked, in this process (null: none due); `lessonOwed` waits from there. */
  private lessonsOwedSince: number | null = null;
  private lessonTimer: NodeJS.Timeout | null = null;
  /** Requests about the rules shown (or offered to nobody) in this process: a reopened run asks each once. */
  private readonly announced = new Set<string>();

  constructor(private readonly o: TeamRunOptions) {
    this.env = o.env ?? process.env;
    // A run from before the rules takes the team its configuration names (saved with the run's next write).
    o.state.rulesStore ??= rulesIdentity(o.cfg, o.workspace);
    this.members = teamMembers(o.cfg.team);
    this.groups = teamGroups(this.members);
    this.head = headPm(this.members);
    this.runner = o.runner ?? new AgentRunner(o.cfg, o.workspace, join(o.store.dir, "logs"), o.bus, { permissions: o.permissions, runsDir: o.store.runsDir });
  }

  /**
   * A new team run in `runsDir` for the user's `request`: its state, the configuration and the identities it keeps.
   * `attachments` (kept elsewhere in `runsDir`, a conversation's) go with the request: the run keeps copies of its own.
   */
  static create(o: Omit<TeamRunOptions, "store" | "state"> & { runsDir: string; request: string; attachments?: Attachment[]; conversationId?: string }): TeamRun {
    // The run's rules are its team's (RULES.md outside the run), named in its state from the start. A team that has none gets
    // its file now, before any run exists: a team whose rules cannot be kept does not start (and leaves no run behind).
    const identity = rulesIdentity(o.cfg, o.workspace);
    new TeamRules(teamRulesDir(o.env ?? process.env, o.workspace, identity.teamId)).init();
    const { store, state } = TeamStore.create(o.runsDir, o.request);
    state.rulesStore = identity;
    if (o.conversationId) state.conversationId = o.conversationId;
    store.save(state);
    if (o.attachments?.length) {
      const files = new AttachmentStore(o.runsDir, store.dir);
      try {
        state.messages[0]!.attachments = o.attachments.map((a) => files.adopt(a));
      } catch (e) {
        // No run is left behind for /resume to find: the request was not taken.
        rmSync(store.dir, { recursive: true, force: true });
        throw e;
      }
      store.save(state);
    }
    store.writeJson("config.json", o.cfg);
    return new TeamRun({ ...o, store, state });
  }

  /** A team run of `runsDir` again (by id, or "latest"), with the configuration it started with. */
  static resume(o: Omit<TeamRunOptions, "store" | "state" | "cfg"> & { runsDir: string; id: string; cfg?: ConfigData }): TeamRun {
    const store = TeamStore.open(o.runsDir, o.id);
    const state = store.load();
    const cfg = o.cfg ?? configFromSaved(store.readJson("config.json"));
    return new TeamRun({ ...o, store, state, cfg });
  }

  get state(): TeamState {
    return this.o.state;
  }

  get id(): string {
    return this.state.id;
  }

  private get interactive(): boolean {
    return !!this.o.decider;
  }

  // ------------------------------------------------------------------ the user's side

  /**
   * A message from the user: for the PM, whatever the team is doing. Its `attachments` (kept elsewhere in the runs
   * directory, a conversation's) are copied into the run first (an AttachmentError leaves the run as it was); every
   * member's next call is given them.
   */
  message(text: string, attachments: Attachment[] = []): void {
    const trimmed = text.trim() || (attachments.length ? FILES_ALONE : "");
    if (!trimmed) return;
    const files = new AttachmentStore(this.o.store.runsDir, this.o.store.dir);
    const copies = attachments.map((a) => files.adopt(a));
    const seq = nextSeq(this.state);
    this.state.messages.push({ seq, at: nowIso(), from: "user", text: trimmed, ...(copies.length ? { attachments: copies } : {}) });
    this.o.bus.emit({ type: "team.message", runId: this.id, from: "user", text: trimmed, seq });
    this.save();
    this.wake();
  }

  /** Esc: the running calls stop; the run returns "stopped" and a later run continues it. */
  stop(): void {
    this.stopRequested = true;
    this.abort.abort();
    this.wake();
  }

  /** Ends the run for good. */
  abortRun(): void {
    this.abortRequested = true;
    this.stop();
  }

  /** A reached budget limit raised by one more allowance (the user decided to go on). */
  raiseBudget(): string[] {
    const budget = this.state.budget;
    if (!budget) return [];
    const used = this.used();
    const allowance = configLimits(this.o.cfg);
    const changes: string[] = [];
    for (const key of reachedLimits(budget, used)) {
      const add = allowance[key];
      budget.limits[key] = add === null ? null : Math.ceil((used[key] + add) * (key === "cost" ? 100 : 1)) / (key === "cost" ? 100 : 1);
      changes.push(add === null ? `${key}: no limit` : `${key} limit raised to ${budget.limits[key]}`);
    }
    this.save();
    return changes;
  }

  // ------------------------------------------------------------------ the loop

  async run(): Promise<TeamOutcome> {
    this.prepareIdentities();
    this.o.bus.emit({
      type: "team.started", runId: this.id, request: this.state.request, runDir: this.o.store.dir,
      members: this.members.map((m) => ({ name: m.name, role: m.role, kind: m.kind, level: m.level, backend: m.backend })),
    });
    this.o.bus.emit({ type: "team.phase", runId: this.id, phase: this.state.phase });
    for (const t of this.state.tasks) this.o.bus.emit({ type: "team.task", task: taskView(t) });
    try {
      this.prepareRules();
      for (;;) {
        if (this.abortRequested) {
          await this.settle();
          return this.finish("aborted");
        }
        if (this.state.phase === "DONE" && !this.lessonsPending()) return this.finish("done");
        if (this.stopRequested) {
          await this.settle();
          return this.finish("stopped");
        }
        if (await this.advance()) continue;
        this.schedule();
        if (!this.running.size) {
          // A lesson the PM has not recorded (and does not, turn after turn) keeps the result from being written and the run from ending.
          if (this.lessonsStuck()) {
            this.o.bus.emit({ type: "warning", text: `The team stopped: the PM has not recorded a lesson for ${this.pendingLessons().map((i) => i.id).join(", ")}. /resume asks it again.` });
            return this.finish("waiting");
          }
          if (this.budgetReached) {
            this.o.bus.emit({ type: "warning", text: `The team stopped: ${this.budgetReached}. /resume goes on${this.state.budget && reachedLimits(this.state.budget, this.used()).length ? " (and raises the limit)" : ""}.` });
            return this.finish("waiting");
          }
          if (!this.interactive || this.waitsOnDeferred()) return this.finish("waiting");
        }
        await this.nextWake();
      }
    } catch (e) {
      this.abort.abort();
      await this.settle();
      if (e instanceof Interrupted) return this.finish("stopped");
      const message = e instanceof RunGitError || e instanceof RulesError ? e.message : (e as Error).stack ?? String(e);
      this.o.bus.emit({ type: "warning", text: `The team run failed: ${message}` });
      this.state.warnings.push(message.split("\n")[0]!);
      return this.finish("error");
    } finally {
      if (this.reportTimer) clearTimeout(this.reportTimer);
      if (this.lessonTimer) clearTimeout(this.lessonTimer);
    }
  }

  /** Every request the run waits on (the approval, exceptions shown and not decided, the PM's questions about the rules) was put off, and none is open. */
  private waitsOnDeferred(): boolean {
    const ids = this.waitingRequests();
    return ids.length > 0 && ids.every((id) => this.deferred.has(id));
  }

  private waitingRequests(): string[] {
    const w = this.state.waiting;
    const work = governanceWork(this.state);
    return [...(w ? [w.requestId] : []), ...work.pending.map((e) => e.decision!.requestId!), ...work.questions.map((q) => q.requestId)];
  }

  private async settle(): Promise<void> {
    if (this.reportTimer) clearTimeout(this.reportTimer);
    if (this.lessonTimer) clearTimeout(this.lessonTimer);
    await Promise.allSettled([...this.running.values()]);
  }

  private async finish(outcome: TeamOutcome): Promise<TeamOutcome> {
    if (outcome === "aborted") this.setPhase("ABORTED");
    this.save();
    if ((outcome === "done" || outcome === "aborted") && this.tg) await this.tg.remove().catch(() => undefined);
    this.o.bus.emit({ type: "team.finished", runId: this.id, phase: this.state.phase, outcome, summary: this.state.summary });
    // A later run in this process starts with a fresh signal.
    this.abort = new AbortController();
    this.stopRequested = false;
    return outcome;
  }

  private wake(): void {
    this.woken = true;
    this.wakeUp?.();
  }

  private nextWake(): Promise<void> {
    if (this.woken) {
      this.woken = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.wakeUp = () => {
        this.wakeUp = null;
        this.woken = false;
        resolve();
      };
    });
  }

  private save(): void {
    this.o.store.save(this.state);
  }

  private setPhase(phase: TeamState["phase"]): void {
    if (this.state.phase === phase) return;
    this.state.phase = phase;
    this.o.bus.emit({ type: "team.phase", runId: this.id, phase });
  }

  private emitTask(t: TaskState): void {
    this.o.bus.emit({ type: "team.task", task: taskView(t) });
  }

  private log(t: TaskState, text: string): void {
    t.history.push({ at: nowIso(), text });
  }

  private report(from: string, text: string): void {
    this.state.reports.push({ seq: nextSeq(this.state), at: nowIso(), from, text });
  }

  private member(name: string): Member {
    const m = this.members.find((x) => x.name === name);
    if (!m) throw new Error(`no member '${name}' in this team`);
    return m;
  }

  private task(id: string): TaskState {
    const t = this.state.tasks.find((x) => x.id === id);
    if (!t) throw new Error(`no task '${id}' in this run`);
    return t;
  }

  private prepareIdentities(): void {
    if (this.identities) return;
    try {
      this.identities = this.o.store.readJson<TeamIdentities>("identities.json");
    } catch {
      this.identities = teamIdentities(this.o.cfg.team, this.members, identityDirs(this.o.workspace, this.env));
      this.o.store.writeJson("identities.json", this.identities);
      for (const w of this.identities.warnings) this.o.bus.emit({ type: "warning", text: w });
    }
  }

  /** The run's repository and worktrees, set up the first time (before any member works in a worktree). */
  private async teamGit(): Promise<TeamGit> {
    if (this.tg) return this.tg;
    const owner = {
      taskId: this.id, git: this.state.git, base: this.state.base ? { ...this.state.base, head: null, branch: null } : null, lastSnapshot: null,
    };
    const { git, meta } = await prepareRunGit(owner, this.o.workspace, this.env);
    if (!this.state.git) {
      this.state.git = meta;
      this.save();
    }
    const root = dataRoot(this.env);
    if (!root) throw new RunGitError("agentduo has no data folder for the team's worktrees (set LOCALAPPDATA on Windows)");
    const runsRel = relativeInside(this.o.store.runsDir, this.o.workspace);
    this.git = git;
    this.tg = new TeamGit({
      git, workspace: this.o.workspace, runId: this.id, root: join(root, "teams", this.id), exclude: runsRel ? [runsRel] : [],
      setup: this.o.cfg.team.worktree.setup, link: this.o.cfg.team.worktree.link,
      onSetup: (member, command, ok, output) => {
        if (!ok) this.o.bus.emit({ type: "warning", text: `${member}'s worktree: '${command}' failed: ${output.trim().split("\n").at(-1) ?? ""}` });
      },
    });
    return this.tg;
  }

  // ------------------------------------------------------------------ deterministic steps

  /** One step agentduo takes by itself (a phase change, a candidate, an approval to ask); true when it took one. */
  private async advance(): Promise<boolean> {
    const s = this.state;
    // What the run has settled becomes a lesson to learn (the PM's turn), and a lesson the PM wrote is finished before anything else.
    const settled = this.settleIncidents();
    if (this.finishLessons() || settled) {
      this.save();
      return true;
    }
    // A decision about an exception is released to the work it held only once it is saved; a proposal is shown to the user once it is saved.
    if (this.deliverDecisions() || this.presentAssessed()) return true;
    const brief = latestBrief(s);
    // A brief the PM wrote and the user has not decided on yet (the first, or a change of scope later).
    if (brief && !brief.declined && s.approvedBrief !== brief.version && !s.waiting) return this.ask("brief");
    switch (s.phase) {
      case "PLANNING": {
        if (!s.base) {
          const tg = await this.teamGit();
          s.base = await tg.createBase(`agentduo team ${this.id}: base`);
          this.save();
          return true;
        }
        const set = this.planSet();
        if (set && s.planPresented === planSignature(set) && s.approvedPlan !== planSignature(set) && !s.waiting) return this.ask("plan");
        return false;
      }
      case "EXECUTION": {
        let changed = false;
        // A task an exception request holds does not move (no candidate, no verdict) until the request is decided and delivered.
        const held = heldTaskIds(s);
        for (const t of s.tasks) {
          if (held.has(t.id)) continue;
          if (t.status === "testing" && !t.candidate && testsWritten(t) && !this.runningFor(t.id)) {
            await this.makeCandidate(t);
            changed = true;
          } else if (t.status === "testing" && t.candidate && checksComplete(t, this.o.cfg.gates.length > 0)) {
            this.judge(t);
            changed = true;
          }
        }
        if (changed) {
          this.save();
          return true;
        }
        if (s.tasks.length && s.tasks.every(finished) && !this.running.size) {
          const tg = await this.teamGit();
          s.integration = { commit: await tg.integrationHead(), checks: [], triage: false, trouble: null, triageGroups: [] };
          this.setPhase("INTEGRATION");
          this.save();
          return true;
        }
        return false;
      }
      case "INTEGRATION": {
        const ig = s.integration;
        if (!ig || ig.triage || this.heldRunUnit()) return false;
        const testers = new Set(s.tasks.flatMap((t) => t.testers));
        const by = new Set(ig.checks.map((c) => c.by));
        const complete = [...testers].every((t) => by.has(t)) && (!this.o.cfg.gates.length || by.has("gates"));
        if (!complete) return false;
        if (ig.checks.every((c) => c.verdict === "pass")) {
          s.verifiedTree = (await this.git!.run(["rev-parse", `${ig.commit}^{tree}`])).stdout.trim();
          this.report("agentduo", "every test and check of the whole result passes");
          this.setPhase(s.accepted ? "APPLY" : "ACCEPTANCE");
        } else {
          s.integrationRounds += 1;
          // The whole result failing is a mistake to learn from once the checks pass (the occurrence is this head's round).
          this.note({
            kind: "deviation", source: { kind: "member_report", member: "agentduo", task: null, occurrence: `integration:r${s.integrationRounds}:${ig.commit}` }, reportedBy: ig.checks.find((c) => c.verdict === "fail")!.by,
            summary: `The check of the whole result failed: ${ig.checks.filter((c) => c.verdict === "fail").map((c) => `${c.by}: ${c.summary}`).join("; ")}`,
          });
          if (s.integrationRounds > this.o.cfg.team.limits.max_task_attempts) {
            this.escalate(null, "integration_limit", `The whole result still fails its checks after ${s.integrationRounds - 1} round(s) of fixes: ` +
              ig.checks.filter((c) => c.verdict === "fail").map((c) => `${c.by}: ${c.summary}`).join("; "));
          } else {
            ig.triage = true;
            ig.trouble = "The check of the whole result (every task merged) failed.";
            ig.triageGroups = this.failingGroups(ig.checks);
          }
        }
        this.save();
        return true;
      }
      case "ACCEPTANCE":
        if (s.acceptance && !s.accepted && !s.waiting && !s.integration?.triage && !this.heldRunUnit()) return this.ask("acceptance");
        return false;
      case "APPLY":
        // The PM learns from what was settled before the result is written and the run ends.
        if (this.lessonsPending() || this.heldRunUnit()) return false;
        if (s.applyConflict) {
          if (!s.applyConflict.resolving && !s.waiting) return this.ask("apply_conflict");
          return false;
        }
        return this.apply();
      default:
        return false;
    }
  }

  private runningFor(task: string): boolean {
    return [...this.running.keys()].some((k) => k.endsWith(`:${task}`));
  }

  private async makeCandidate(t: TaskState): Promise<void> {
    const tg = await this.teamGit();
    const commits = [t.code!, ...t.testers.map((n) => t.tests[n]?.commit).filter((c): c is string => !!c)];
    const merged = await tg.merge(commits, `agentduo team ${this.id}: ${t.id} candidate`);
    if ("conflicts" in merged) {
      t.status = "triage";
      t.trouble = `the code and the tests conflict in ${merged.conflicts.join(", ")}`;
      this.log(t, t.trouble);
    } else {
      t.candidate = merged.commit;
      t.checks = [];
      await this.git!.run(["update-ref", tg.refs.candidate(t.id), merged.commit]);
      this.log(t, "code and tests merged for testing");
    }
    this.emitTask(t);
  }

  /** Every check of a candidate is in: it is merged, or the techlead decides (or, after two rounds without progress, you). */
  private judge(t: TaskState): void {
    const failing = t.checks.filter((c) => c.verdict === "fail");
    if (!failing.length) {
      t.status = "merging";
      this.log(t, `attempt ${t.attempt} passes every check`);
      this.emitTask(t);
      return;
    }
    const failures = failing.flatMap((c) => c.failures);
    const keys = failures.map(failureKey);
    t.stalls = madeProgress(t.lastFailureKeys, keys) ? 0 : t.stalls + 1;
    t.lastFailureKeys = keys;
    t.trouble = `the check of attempt ${t.attempt} failed: ${failing.map((c) => `${c.by}: ${c.summary}`).join("; ")}`;
    this.log(t, t.trouble);
    this.note({
      kind: "deviation", source: { kind: "check", task: t.id, occurrence: `a${t.attempt}r${t.reviewRound}` }, reportedBy: failing[0]!.by,
      summary: `Task ${t.id} (${t.title}): ${t.trouble}`,
    });
    if (t.stalls >= 2) {
      this.escalate(t, "review_stalled", `Task ${t.id} (${t.title}) fails the same way after two rounds of fixes: ${failures.map((f) => f.title).join("; ")}`);
    } else t.status = "triage";
    this.emitTask(t);
  }

  private escalate(t: TaskState | null, reason: Escalation["reason"], text: string, group?: string | null): void {
    // A stable id: the task's (T1-E1, T1-E2…) or the run's (E1, E2…), which the PM answers by.
    const n = this.state.escalations.filter((x) => x.task === (t?.id ?? null)).length + 1;
    // The group's own PM answers first, when it has one; the head PM otherwise (and asks you what it cannot answer).
    const owner = t ? t.group : group ?? null;
    const to = (t || group !== undefined ? this.group(owner).pm : null) ?? this.head;
    const e: Escalation = {
      id: t ? `${t.id}-E${n}` : `E${n}`, task: t?.id ?? null, ...(group !== undefined ? { group } : {}), reason, text, to: to.name, told: false, answer: null,
    };
    this.state.escalations.push(e);
    if (t) {
      t.status = reason === "question" && t.status === "blocked" ? "blocked" : "escalated";
      this.log(t, `waiting for the PM: ${text}`);
      this.emitTask(t);
    }
    this.report(this.group(owner).lead.name, text);
  }

  /** A group of the team by name (null: the one group of a team without groups). */
  private group(name: string | null): TeamGroup {
    return this.groups.find((g) => g.name === name) ?? this.groups[0]!;
  }

  private get grouped(): boolean {
    return this.groups[0]!.name !== null;
  }

  /** The groups that plan now: every group the first time; after a change of the brief, those with criteria no task serves yet. */
  private planningGroups(): TeamGroup[] {
    const s = this.state;
    if (!this.grouped) return this.groups;
    const areas = currentAreas(s);
    const served = new Set(s.tasks.filter((t) => t.status !== "cancelled").flatMap((t) => t.criteria));
    return this.groups.filter((g) => areas.some((a) => a.group === g.name && (s.replanning ? a.criteria.some((c) => !served.has(c)) : a.criteria.length > 0)));
  }

  /** The criteria a group's plan must serve now. */
  private requiredCriteria(g: TeamGroup): true | string[] {
    const s = this.state;
    const served = new Set(s.tasks.filter((t) => t.status !== "cancelled").flatMap((t) => t.criteria));
    const own = this.grouped ? currentAreas(s).find((a) => a.group === g.name)?.criteria ?? [] : this.brief().criteria.map((c) => c.id);
    return s.replanning ? own.filter((c) => !served.has(c)) : this.grouped ? own : true;
  }

  /** The plan of every group that plans now, when each has one its own PM approved (or none has to); else null. */
  private planSet(): TeamPlan[] | null {
    const plans: TeamPlan[] = [];
    for (const g of this.planningGroups()) {
      const plan = latestPlan(this.state, g.name);
      if (!plan || plan.declined || (g.pm && plan.areaApproved !== true)) return null;
      plans.push(plan);
    }
    return plans.length ? plans : null;
  }

  /** The plans you approved last (one per group), for the PM to know what the team works to. */
  private approvedSet(): TeamPlan[] {
    const s = this.state;
    if (!s.approvedPlan) return [];
    const wanted = new Set(s.approvedPlan.split(","));
    return s.plans.filter((p) => wanted.has(`${p.group ?? ""}:${p.version}`));
  }

  /** The groups an integration failure is for: those answering for its criteria, else the first. */
  private failingGroups(checks: TaskCheck[]): string[] {
    if (!this.grouped) return [""];
    const areas = currentAreas(this.state);
    const keys = new Set<string>();
    for (const f of checks.filter((c) => c.verdict === "fail").flatMap((c) => c.failures)) {
      const owners = areas.filter((a) => f.criteria.some((c) => a.criteria.includes(c))).map((a) => a.group);
      for (const o of owners.length ? owners : [this.groups[0]!.name!]) keys.add(o);
    }
    return keys.size ? [...keys] : [this.groups[0]!.name!];
  }

  /** Writes the accepted result into the workspace, once the tree going in is the one the last whole check passed. */
  private async apply(): Promise<boolean> {
    const s = this.state;
    const tg = await this.teamGit();
    const head = await tg.integrationHead();
    const plan = await tg.planApply(head, `agentduo team ${this.id}`);
    if (plan.kind === "conflicts") {
      s.applyConflict = { ours: plan.ours, tree: plan.tree, files: plan.files, resolving: false };
      this.save();
      return true;
    }
    if (plan.tree !== s.verifiedTree) {
      // Your edits merged with the result make a tree nobody checked: it is checked as a whole first.
      const commit = await this.git!.commitTree(plan.tree, plan.kind === "merged" ? [head, plan.ours] : [head], `agentduo team ${this.id}: with the workspace's changes`);
      await this.git!.run(["update-ref", tg.refs.integration, commit, head]);
      s.integration = { commit, checks: [], triage: false, trouble: null, triageGroups: [] };
      this.report("agentduo", "the folder changed while the team worked; the result is checked again together with those changes");
      this.setPhase("INTEGRATION");
      this.save();
      return true;
    }
    const files = await tg.write(plan.current.tree, plan.tree);
    await tg.recordApplied(`agentduo team ${this.id}: applied`);
    s.applied = { tree: plan.tree, files, at: nowIso() };
    s.summary = `The team's result is in your folder: ${files.length} file(s) changed, nothing committed. \`duo team undo ${this.id}\` puts the folder back as it was.`;
    this.setPhase("DONE");
    this.save();
    return true;
  }

  // ------------------------------------------------------------------ approvals and questions

  private request(kind: "brief" | "plan" | "acceptance" | "apply_conflict" | "questions" | "exception" | "direction", questions: ClarificationQuestion[]): ClarificationRequest {
    const pm = this.head;
    return {
      id: `tq-${this.id.slice(-6)}-${nextSeq(this.state)}`, source: "team", callId: `${this.id}:${kind}:${this.state.seq}`, agent: pm.backend,
      teamRunId: this.id, member: pm.name, questions, at: nowIso(),
    };
  }

  private approvalQuestion(kind: "brief" | "plan" | "acceptance" | "apply_conflict"): ClarificationQuestion {
    const s = this.state;
    const option = (id: string, label: string, description: string) => ({ id, label, description });
    switch (kind) {
      case "brief": {
        const b = latestBrief(s)!;
        return {
          id: "decision", header: "Brief", multiSelect: false,
          question: `Approve the PM's brief v${b.version} ("${b.title}")? ${s.plans.length ? "The techlead then plans what it adds." : "The techlead then plans the work."}`,
          options: [option(APPROVE, "Approve", "Hand it to the techlead"), option(CHANGE, "Ask for changes", "Tell the PM what to change, in your own words")],
        };
      }
      case "plan": {
        const set = this.planSet() ?? [];
        const tasks = set.reduce((n, p) => n + p.tasks.length, 0);
        return {
          id: "decision", header: "Plan", multiSelect: false,
          question: `Approve the plan (${tasks} task(s)${this.grouped ? ` in ${set.length} group(s)` : ""})? The team starts working once you do.`,
          options: [option(APPROVE, "Approve", "The team starts"), option(CHANGE, "Ask for changes", "Tell the PM what to change, in your own words")],
        };
      }
      case "acceptance":
        return {
          id: "decision", header: "Acceptance", multiSelect: false,
          question: "Accept the team's result? It is then written into your folder (nothing is committed, and it can be undone).",
          options: [option(APPROVE, "Accept", "Write it into my folder"), option(CHANGE, "Ask for changes", "Tell the PM what to change, in your own words")],
        };
      case "apply_conflict":
        return {
          id: "decision", header: "Conflicts", multiSelect: false,
          question: `Your folder changed while the team worked, and the result conflicts with it in ${s.applyConflict!.files.join(", ")}. What now?`,
          options: [option(APPROVE, "Let the techlead resolve it", "On top of your changes; checked again before it is written"),
            option(CHANGE, "Write it with conflict markers", "You resolve the markers yourself")],
        };
    }
  }

  /** Opens an approval with the decider; its answer comes back through `decided`. */
  private ask(kind: "brief" | "plan" | "acceptance" | "apply_conflict"): boolean {
    const request = this.request(kind, [this.approvalQuestion(kind)]);
    ledgerOpen(this.state.clarifications, request);
    this.state.waiting = { kind, requestId: request.id };
    this.save();
    this.listen(request, (response) => this.decided(kind, request, response));
    return true;
  }

  /** Sends a request to the decider (when there is one); an answer wakes the loop. */
  private listen(request: ClarificationRequest, done: (response: ClarificationResponse) => void): void {
    this.announced.add(request.id);
    this.o.bus.emit({ type: "clarification.requested", request });
    if (!this.o.decider) return;
    this.open.add(request.id);
    this.o.decider.askClarification({ request }).then((response) => {
      this.open.delete(request.id);
      if (response.kind === "defer") {
        this.deferred.add(request.id);
        this.o.bus.emit({ type: "clarification.closed", id: request.id, callId: request.callId, status: "deferred" });
      } else done(response);
      this.wake();
    }, () => {
      this.open.delete(request.id);
      this.deferred.add(request.id);
      this.wake();
    });
  }

  /** Reopens what this run asked and nobody answered yet (a run that continues an earlier one). */
  private reopen(): void {
    this.reopenGovernance();
    const w = this.state.waiting;
    if (!w || this.open.has(w.requestId) || this.deferred.has(w.requestId)) return;
    const entry = this.state.clarifications.find((c) => c.id === w.requestId && c.status === "pending");
    if (!entry) return;
    const { seq: _seq, status: _status, ...request } = entry;
    this.listen(request, (response) => this.decided(w.kind, request, response));
  }

  private decided(kind: "brief" | "plan" | "acceptance" | "apply_conflict", request: ClarificationRequest, response: ClarificationResponse): void {
    const s = this.state;
    if (response.kind !== "answered") {
      ledgerClose(s.clarifications, request.id, "cancelled", nowIso(), request.callId);
      this.deferred.add(request.id);
      this.save();
      return;
    }
    ledgerAnswer(s.clarifications, request.id, request.callId, response.answers, nowIso());
    this.o.bus.emit({ type: "clarification.answered", id: request.id, callId: request.callId, answers: response.answers });
    const a = response.answers[0]!;
    const approve = a.optionIds.includes(APPROVE);
    const words = a.otherText?.trim() || null;
    s.waiting = null;
    switch (kind) {
      case "brief": {
        const b = latestBrief(s)!;
        if (approve) {
          s.approvedBrief = b.version;
          if (s.plans.length) s.replanning = true;
          this.setPhase("PLANNING");
          if (words) s.leadNotes.push({ group: null, text: `The user, approving the brief: ${words}` });
          this.settleUser("brief");
        } else {
          b.declined = true;
          this.userChanges(`(about brief v${b.version}) ${words ?? "Please change the brief."}`);
        }
        break;
      }
      case "plan": {
        const set = this.planSet() ?? [];
        if (approve) {
          this.startPlan(set, words);
          this.settleUser("plan");
        } else {
          // Every techlead of the set reads your words; one whose part they do not concern may plan the same again.
          for (const p of set) {
            p.declined = true;
            s.planFeedback[groupKey(p.group)] = `The user asked for changes (through the PM): ${words ?? "(no details)"}`;
          }
          this.userChanges(`(about the plan) ${words ?? "Please change the plan."}`);
        }
        break;
      }
      case "acceptance":
        if (approve) {
          s.accepted = true;
          this.setPhase("APPLY");
          this.settleUser("acceptance");
        } else {
          s.acceptance = null;
          this.userChanges(`(about the result) ${words ?? "Please change it."}`);
        }
        break;
      case "apply_conflict":
        if (approve) s.applyConflict!.resolving = true;
        else void this.writeWithMarkers();
        break;
    }
    this.save();
  }

  /** What the user wrote with a decision goes into the conversation, for the PM. */
  private userWords(text: string): number {
    const seq = nextSeq(this.state);
    this.state.messages.push({ seq, at: nowIso(), from: "user", text });
    this.o.bus.emit({ type: "team.message", runId: this.id, from: "user", text, seq });
    return seq;
  }

  /** The user asked for changes instead of approving: the result differed from what they wanted, an incident to learn from once they approve. */
  private userChanges(text: string): void {
    const seq = this.userWords(text);
    this.note({ kind: "deviation", source: { kind: "user_message", seq }, reportedBy: "agentduo", summary: text });
  }

  private startPlan(set: TeamPlan[], words: string | null): void {
    const s = this.state;
    s.approvedPlan = planSignature(set);
    for (const p of set) {
      for (const t of p.tasks) {
        const task = newTask(t, p.group);
        s.tasks.push(task);
        this.emitTask(task);
      }
    }
    s.replanning = false;
    s.planFeedback = {};
    if (words) s.leadNotes.push({ group: null, text: `The user, approving the plan: ${words}` });
    if (s.integration?.triage) s.integration = null;
    s.accepted = false;
    s.acceptance = null;
    this.setPhase("EXECUTION");
  }

  private async writeWithMarkers(): Promise<void> {
    const s = this.state;
    const tg = await this.teamGit();
    const plan = await tg.planApply(await tg.integrationHead(), `agentduo team ${this.id}`);
    const files = plan.kind === "conflicts" ? plan.files : [];
    const written = await tg.write(plan.current.tree, plan.tree);
    await tg.recordApplied(`agentduo team ${this.id}: applied with conflicts`);
    s.applied = { tree: plan.tree, files: written, at: nowIso() };
    s.applyConflict = null;
    s.summary = `The team's result is in your folder with conflict markers in ${files.join(", ")}: resolve them there. Nothing is committed.`;
    this.setPhase("DONE");
    this.save();
    this.wake();
  }

  // ------------------------------------------------------------------ scheduling

  private used(extra: Partial<BudgetUsage> = {}): BudgetUsage {
    const u = this.state.usage;
    return {
      tokens: u.tokens + (extra.tokens ?? 0), cost: u.costUsd + (extra.cost ?? 0), calls: u.calls + (extra.calls ?? 0),
      minutes: (u.workSec + (extra.minutes ?? 0) * 60) / 60,
    };
  }

  private budgetStop(extra: Partial<BudgetUsage> = {}): string | null {
    const s = this.state;
    s.budget ??= { limits: configLimits(this.o.cfg), warned: [] };
    const used = this.used(extra);
    const reached = reachedLimits(s.budget, used);
    return reached.length ? reached.map((k) => describeLimit(k, used[k], s.budget!.limits[k]!)).join("; ") : null;
  }

  private callBudget(): CallBudget {
    return {
      stop: (call) => this.budgetStop({ tokens: call.tokens, cost: call.costUsd, calls: call.calls }),
      costCap: () => null,
    };
  }

  /** The PM's next turn, if it has one now. */
  private pmOccasion(): PmOccasion | null {
    const s = this.state;
    if (s.phase === "ABORTED") return null;
    // The result is written; the run ends once the PM has learned from what was settled.
    if (s.phase === "DONE") return this.lessonOwed() ? { kind: "rule_lesson" } : null;
    if (s.phase === "ACCEPTANCE" && !s.acceptance && !s.integration?.triage && s.messages.length <= s.pmSeen) return { kind: "acceptance" };
    if (s.phase === "PLANNING" && s.base && this.grouped && !currentAreas(s).length) return { kind: "areas" };
    const set = s.phase === "PLANNING" ? this.planSet() : null;
    if (set && s.planReviewed !== planSignature(set)) return { kind: "plan_review" };
    if (s.messages.length > s.pmSeen && s.messages.at(-1)!.from === "user") return { kind: "conversation" };
    if (s.escalations.some((e) => !e.told && e.answer === null && e.to === this.head.name && !e.exceptionId && !this.escalationHeld(e))) return { kind: "escalation" };
    if (this.exceptionsToAssess().length) return { kind: "rule_exception" };
    if (this.lessonOwed()) return { kind: "rule_lesson" };
    if ((s.phase === "EXECUTION" || s.phase === "INTEGRATION") && s.reports.length > s.reportsSeen) {
      const wait = s.lastReportAt ? (this.o.reportIntervalMs ?? REPORT_INTERVAL_MS) - (Date.now() - Date.parse(s.lastReportAt)) : 0;
      if (wait <= 0) return { kind: "reports" };
      if (!this.reportTimer) {
        this.reportTimer = setTimeout(() => {
          this.reportTimer = null;
          this.wake();
        }, wait);
        this.reportTimer.unref?.();
      }
    }
    return null;
  }

  /** The groups whose techlead must plan now: no plan of the approved brief yet, or theirs was sent back. */
  private groupsToPlan(): TeamGroup[] {
    const s = this.state;
    if (s.phase !== "PLANNING" || !s.base || s.waiting || (this.grouped && !currentAreas(s).length)) return [];
    return this.planningGroups().filter((g) => {
      // A group whose planning waits for the decision on an exception request does not plan.
      if (unitHeld(s, planningUnit(g.name))) return false;
      const plan = latestPlan(s, g.name);
      return !plan || plan.declined;
    });
  }

  /** A group's own PM's next turn: its techlead's question waiting, or its group's plan to check. */
  private areaOccasion(g: TeamGroup): PmOccasion | null {
    const s = this.state;
    if (!g.pm) return null;
    if (s.escalations.some((e) => e.to === g.pm!.name && e.answer === null && !this.escalationHeld(e))) return { kind: "area_escalation" };
    const plan = s.phase === "PLANNING" ? latestPlan(s, g.name) : null;
    if (plan && !plan.declined && plan.areaApproved == null && this.planningGroups().includes(g)) return { kind: "area_review" };
    return null;
  }

  private schedule(): void {
    this.reopen();
    if (this.budgetReached) return;
    let lesson = false;
    if (!this.busy.has(this.head.name)) {
      const occasion = this.pmOccasion();
      // A lesson turn is decided once the jobs that can start now have started: then the team is not idle, and the
      // incidents that settle meanwhile are learned from in the same turn (`lessonOwed`).
      if (occasion?.kind === "rule_lesson") lesson = true;
      else if (occasion) this.start({ kind: "pm" }, () => this.pmTurn(occasion));
    }
    // The PMs' turns do not count against max_parallel: you (or the team) wait for them.
    const agents = () => [...this.running.keys()].filter((k) => !/^(pm|area_pm|gates|merge):/.test(k)).length;
    for (const g of this.groups) {
      const occasion = this.areaOccasion(g);
      if (occasion && !this.busy.has(g.pm!.name)) this.start({ kind: "area_pm", member: g.pm!.name }, () => this.areaTurn(g, occasion));
    }
    const max = this.o.cfg.team.max_parallel;
    for (const g of this.groupsToPlan()) {
      if (!this.busy.has(g.lead.name) && agents() < max) this.start({ kind: "plan", member: g.lead.name }, () => this.planTurn(g));
    }
    const jobs = boardJobs(this.state, {
      members: this.members, groups: this.groups, busy: this.busy, running: new Set(this.running.keys()), gates: this.o.cfg.gates.length > 0,
    });
    for (const job of jobs) {
      if ((this.failures.get(jobKey(job)) ?? 0) >= 2) continue;
      if (!ownJob(job) && agents() >= max) continue;
      if ("member" in job && this.busy.has(job.member)) continue;
      this.start(job, () => this.execute(job));
    }
    if (lesson && !this.busy.has(this.head.name) && this.lessonOwed()) this.start({ kind: "pm" }, () => this.pmTurn({ kind: "rule_lesson" }));
  }

  private start(job: Job, work: () => Promise<void>): void {
    const key = jobKey(job);
    if (this.running.has(key)) return;
    const member = "member" in job ? job.member : job.kind === "pm" ? this.head.name : null;
    if (member) {
      this.busy.add(member);
      this.o.bus.emit({ type: "team.member", member, state: "busy", job: job.kind, task: "task" in job ? job.task ?? null : null });
    }
    const p = (async () => {
      try {
        await work();
        this.failures.delete(key);
      } catch (e) {
        if (e instanceof Held) {
          this.failures.delete(key);
          return;
        }
        if (e instanceof Interrupted) return;
        const n = (this.failures.get(key) ?? 0) + 1;
        this.failures.set(key, n);
        const text = (e as Error).message;
        this.o.bus.emit({ type: "warning", text: `${member ?? "agentduo"} (${job.kind}${"task" in job && job.task ? ` ${job.task}` : ""}) failed: ${text}` });
        if (n >= 2 && job.kind === "pm") {
          // Nobody else can talk to you: the team stops, and says why, rather than wait for a PM that keeps failing.
          this.budgetReached = `the PM failed twice (${text.split("\n")[0]})`;
        } else if (n >= 2) {
          const t = "task" in job && job.task ? this.state.tasks.find((x) => x.id === job.task) ?? null : null;
          this.escalate(t, "agent_error", `${member ?? "agentduo"} could not do its ${job.kind} job${t ? ` on ${t.id}` : ""}: ${text.split("\n")[0]}`);
          this.save();
        }
      } finally {
        this.running.delete(key);
        if (member) {
          this.busy.delete(member);
          this.o.bus.emit({ type: "team.member", member, state: "idle", job: null, task: null });
        }
        this.wake();
      }
    })();
    this.running.set(key, p);
  }

  private execute(job: Job): Promise<void> {
    switch (job.kind) {
      case "work": return this.workTurn(job.member, job.task);
      case "tests": return this.testsTurn(job.member, job.task);
      case "review": return this.reviewTurn(job.member, job.task);
      case "check": return this.checkTurn(job.member, job.task);
      case "triage": return this.triageTurn(job.task);
      case "answer": return this.answerTurn(job.task);
      case "resolve": return this.resolveTurn(job.task);
      case "gates": return this.gatesRun(job.task);
      case "merge": return this.mergeTask(job.task);
      case "integration_check": return this.integrationCheckTurn(job.member);
      case "integration_triage": return this.integrationTriageTurn(job.member);
      case "resolve_apply": return this.resolveApplyTurn();
      default: return Promise.resolve();
    }
  }

  // ------------------------------------------------------------------ member calls

  /**
   * One call of a member, in its session: the result's data, or an error (thrown). `build` makes the prompt for a fresh
   * session (every part, the identity) and for one that goes on (`since`: what its earlier turns were given; it gets only
   * what changed). The fresh one says what the session holds once the turn succeeded (`view`), kept in `MemberSession.seen`.
   */
  private async call<T>(m: Member, kind: string, schemaName: SchemaName, build: (session: SessionPrompt) => string,
    o: { task: string | null; cwd: string; check?: (data: T) => string[]; work?: WorkRef | null; purpose?: SessionPurpose }): Promise<T> {
    const s = this.state;
    const backend = this.runner.backends[m.backend];
    const keep = backend.keepsSessions(undefined, m.args);
    // A member's session holds one task (its work, its fixes, its tests and checks, a review of it) or, for a turn of no
    // task, the member's own thread (the PM's conversation, the techlead's plan): never another task's history.
    const key = sessionKey(m, o.task, o.purpose ?? null);
    const session = s.sessions[key];
    const continued = keep && session && session.backend === m.backend ? session : null;
    // A techlead reads the PM's notes for its group (and those for every techlead): all of them in a fresh session,
    // the ones its session has not read yet in one that goes on (an older run counted them per member).
    const leadNotes = (from: number) => {
      const read = m.kind === "lead" ? s.leadNotes.slice(from).filter((n) => n.group === null || n.group === m.group) : [];
      return read.length ? `\n\n## Notes from the PM\n${read.map((n) => `- ${n.text}`).join("\n")}` : "";
    };
    const notesSeen = s.leadNotes.length;
    // The user's files: every one for a fresh session, the ones it was not given for a session that goes on.
    const files = this.files();
    const given = new Set(continued?.files ?? []);
    const unseen = files.filter((a) => !given.has(a.id));
    const locate = (a: Attachment) => attachmentFile(this.o.store.runsDir, a);
    const listed = (list: Attachment[], next: boolean) => {
      const text = filesSection(list, locate, next);
      return text ? `\n\n${text}` : "";
    };
    // The team's rules as RULES.md holds them now, read for this call: the full prompt, the continued one and the fresh
    // session a failed resume falls back to are all built from this one reading (the prompts take them from `parts`).
    const rules = this.rulesStore().rules();
    this.promptRules = rules;
    let full: string;
    let resume: { id: string; prompt: string; attachments: Attachment[] } | undefined;
    // What the whole prompt gives, part by part: what a session holds after this turn, whichever prompt it got.
    const view: SessionView = {};
    try {
      full = build({ identity: memberIdentity(this.identities!, m), view }) + leadNotes(0) + listed(files, false);
      resume = continued
        ? {
          id: continued.id, attachments: unseen,
          prompt: build({ identity: null, since: continued.seen ?? null }) + leadNotes(continued.notes ?? s.leadNotesSeen[m.name] ?? 0) + listed(unseen, true),
        }
        : undefined;
    } finally {
      this.promptRules = null;
    }
    // Claude's permission mode as you set it (/mode, Shift+Tab, --accept-edits) holds for its members as for the
    // implementer and the chat; a member's own args come after it and win.
    const profile = memberProfile(m);
    if (m.backend === "claude") profile.args = [...implementerPermissionArgs(this.o.cfg.claude), ...profile.args];
    const callId = `${String(nextSeq(s)).padStart(3, "0")}-${kind}-${m.name}${o.task ? `-${o.task}` : ""}`;
    // What the call is about: a request for an exception made in it covers exactly this work, and no other.
    const work = o.work !== undefined ? o.work : o.task ? { task: o.task } : null;
    // A result that asks for an exception (and will be held) is not a result: the ordinary checks of what completes the work do not apply to it.
    const check = (data: T): string[] => {
      const asked = this.exceptionVerdict(m, work, data, rules);
      return asked.holds ? [] : [...(o.check?.(data) ?? []), ...asked.problems];
    };
    const res = await this.runner.call({
      member: { name: m.name, task: o.task, backend: m.backend, profile, cwd: o.cwd },
      prompt: full, schemaName, logPrefix: callId,
      check: check as (data: unknown) => string[], signal: this.abort.signal, session: { keep, ...(resume ? { resume } : {}) },
      budget: this.callBudget(), attachments: files,
    });
    s.usage.calls += res.calls;
    s.usage.unpricedCalls += res.unpricedCalls;
    s.usage.costUsd += res.costUsd ?? 0;
    s.usage.tokens += res.tokens ?? 0;
    s.usage.workSec += Math.max(0, res.durationSec - res.waitedSec);
    const by = (s.usage.byMember[m.name] ??= { calls: 0, costUsd: 0, tokens: 0 });
    by.calls += res.calls;
    by.costUsd += res.costUsd ?? 0;
    by.tokens += res.tokens ?? 0;
    if (res.interrupted) throw new Interrupted();
    if (res.budgetStop) {
      this.budgetReached = res.budgetStop;
      this.save();
      throw new Interrupted();
    }
    if (!res.ok) {
      this.save();
      throw new Error(res.error ?? "the call failed");
    }
    if (keep && res.sessionId) {
      // A session that went on still holds what its earlier turns were given that this prompt has no part for; a fresh one
      // (a new session, or the one a lost resume fell back to) holds this prompt's parts only.
      const seen = res.resumed && continued ? { ...(continued.seen ?? {}), ...view } : view;
      s.sessions[key] = {
        backend: m.backend, id: res.sessionId, ...(files.length ? { files: files.map((a) => a.id) } : {}), ...(m.kind === "lead" ? { notes: notesSeen } : {}), seen,
      };
    }
    const report = (res.data as { governance?: GovernanceReport | null }).governance ?? null;
    this.noteIssues(m, o.task, callId, report, rules);
    // A result that asks for an exception does not complete the work: the request is saved, and the work waits for the decision.
    this.holdForException(m, work, report, rules);
    this.save();
    return res.data as T;
  }

  /**
   * What a member's turn wrote that its later prompts would show (the PM's brief and the groups' parts, a techlead's plan):
   * its session has it, as its own answer, and is not sent it back. A session agentduo keeps no record of is left alone.
   */
  private knows(m: Member, task: string | null, wrote: SessionView): void {
    const session = this.state.sessions[sessionKey(m, task)];
    if (session?.seen) Object.assign(session.seen, wrote);
  }

  // ------------------------------------------------------------------ the team's rules

  /** The team's RULES.md: the folder is the team's (`state.rulesStore`), apart from this run, its worktrees and its cleanup. */
  private rulesStore(): TeamRules {
    if (this.rules) return this.rules;
    const id = this.state.rulesStore!;
    const store = new TeamRules(teamRulesDir(this.env, this.o.workspace, id.teamId));
    store.init();
    this.rules = store;
    return store;
  }

  /** Opens the team's rules when the run starts (RULES.md is created when the team has none) and checks it is the run's own team's. */
  private prepareRules(): void {
    const id = this.state.rulesStore!;
    const key = workspaceKey(this.o.workspace);
    if (id.workspaceKey !== key) {
      this.o.bus.emit({ type: "warning", text: `This run was started in another folder: it now uses the rules of team '${id.teamId}' of this folder.` });
      id.workspaceKey = key;
      this.save();
    }
    this.rulesStore();
  }

  /** Records an incident of this run (the same occurrence twice is one); a refusal is a warning, never a stop of the run. */
  private note(input: IncidentInput): Incident | null {
    const made = recordIncident(this.state, input);
    if (!made.ok) {
      this.o.bus.emit({ type: "warning", text: `An incident was not recorded: ${made.reason}` });
      return null;
    }
    return made.value;
  }

  /** The disagreements and deviations a member reported in its result (`governance.issues`); the rules they name must be the team's. */
  private noteIssues(m: Member, task: string | null, callId: string, report: GovernanceReport | null, rules: readonly RuleEntry[]): void {
    const known = new Set(rules.map((r) => r.id));
    (report?.issues ?? []).forEach((issue, index) => {
      this.note({
        kind: issue.kind, source: { kind: "member_report", member: m.name, task, occurrence: issueOccurrence(callId, index) }, reportedBy: m.name,
        ruleIds: issue.rule_ids.filter((id) => known.has(id)), summary: issue.summary,
      });
    });
  }

  /** Why a reported incident is settled by what the run did since, or null when it is not yet (a pure reading of the state). */
  private settledBy(i: Incident): string | null {
    const s = this.state;
    const task = (id: string) => s.tasks.find((x) => x.id === id);
    const taskEnd = (id: string) => {
      const t = task(id);
      return t && (t.status === "merged" || t.status === "cancelled") ? `task ${id} was ${t.status}` : null;
    };
    const src = i.source;
    const accepted = s.phase === "APPLY" || s.phase === "DONE" ? "the user accepted the result" : null;
    switch (src.kind) {
      case "review":
        return (task(src.task)?.review?.verdict === "approve" ? `the review of ${src.task} approved it after the changes` : null) ?? taskEnd(src.task) ?? accepted;
      case "check":
        return taskEnd(src.task) ?? accepted;
      case "member_report": {
        if (src.task) return taskEnd(src.task) ?? accepted;
        const plan = /^plan:(.*):v(\d+)$/.exec(src.occurrence);
        // The whole result failed its checks: settled once it passes them (the run is past the integration).
        if (src.occurrence.startsWith("integration:")) return s.phase === "ACCEPTANCE" || s.phase === "APPLY" || s.phase === "DONE" ? "the whole result passes its checks" : null;
        if (plan) {
          const later = (s.approvedPlan ?? "").split(",").some((e) => e.slice(0, e.lastIndexOf(":")) === plan[1] && Number(e.slice(e.lastIndexOf(":") + 1)) > Number(plan[2]));
          return later ? "the techlead revised the plan and the plan was approved" : accepted;
        }
        return accepted;
      }
      case "user_message": return accepted;
      case "escalation": return null;
    }
  }

  /** Marks the reported incidents the run has settled; true when one changed. Idempotent. */
  private settleIncidents(): boolean {
    let changed = false;
    for (const i of this.state.governance.incidents) {
      if (i.status !== "reported") continue;
      const why = this.settledBy(i);
      if (why && resolveIncident(this.state, i.id, why).ok) changed = true;
    }
    return changed;
  }

  /** What the user's message (by its seq) was about, as `decided` words it. */
  private userTopic(seq: number): "brief" | "plan" | "acceptance" | null {
    const text = this.state.messages.find((m) => m.seq === seq)?.text ?? "";
    return text.startsWith("(about brief") ? "brief" : text.startsWith("(about the plan)") ? "plan" : text.startsWith("(about the result)") ? "acceptance" : null;
  }

  /** The user approved what they had asked to change: the incidents of that request are settled. */
  private settleUser(topic: "brief" | "plan" | "acceptance"): void {
    for (const i of this.state.governance.incidents) {
      if (i.status === "reported" && i.source.kind === "user_message" && this.userTopic(i.source.seq) === topic) resolveIncident(this.state, i.id, `the user approved the ${topic} after the change`);
    }
  }

  /** Lessons the PM wrote that RULES.md may not hold yet (a run stopped between its two writes): finished here, without the PM. */
  private finishLessons(): boolean {
    const recording = this.state.governance.incidents.filter((i) => i.status === "recording" && i.lesson);
    for (const i of recording) this.appendLesson(i);
    return recording.length > 0;
  }

  /**
   * Appends an incident's lesson to RULES.md and records the rule's id in the run. The operation id is the run's and the
   * incident's, so a second attempt (the run stopped after the file was written and before the state was) adds nothing.
   */
  private appendLesson(i: Incident): void {
    const added = this.rulesStore().append({ opId: lessonOp(this.id, i.id), text: i.lesson!.text, incident: lessonSource(this.id, i) });
    const done = completeLesson(this.state, i.id, added.rule.id);
    if (!done.ok) throw new Error(done.reason);
    this.save();
  }

  /**
   * The PM's structured `rule_lesson`, for every incident it answered in the turn: a rule (the only way a rule is added), or
   * the decision that none is needed. Every rule is saved as `recording` before RULES.md is written, so a stop between the
   * two is finished by the next run (`finishLessons`), and each is appended once (its own operation id).
   */
  private pmLessons(lessons: readonly LessonAnswer[]): void {
    const begun: Incident[] = [];
    for (const a of lessons) {
      const text = a.rule?.trim();
      if (!text) {
        declineLesson(this.state, a.incident_id, a.rationale);
        continue;
      }
      const made = beginLesson(this.state, a.incident_id, text);
      if (!made.ok) {
        this.o.bus.emit({ type: "warning", text: `The PM's rule for ${a.incident_id} was not recorded: ${made.reason}` });
        continue;
      }
      begun.push(made.value);
    }
    this.save();
    for (const i of begun) this.appendLesson(i);
  }

  /** The settled incidents the PM has not decided on yet: an obligation of the run, whether or not the PM can be asked now. */
  private pendingLessons(): Incident[] {
    return governanceWork(this.state).lessons.filter((i) => i.status === "resolved");
  }

  private lessonsPending(): boolean {
    return this.pendingLessons().length > 0;
  }

  /** The settled incidents the PM is to decide on now: one it asked the user about waits for the answer (the run still owes it). */
  private lessonsDue(): Incident[] {
    return this.pendingLessons().filter((i) => !i.direction || i.direction.answer !== null);
  }

  private lessonsOwedNow(): number {
    return this.lessonsDue().length;
  }

  /**
   * Whether the PM is asked for its lessons now: some are due, and its lesson turns in this process have not stalled (backoff,
   * not release). While other members work (execution, integration), more incidents may settle, so the turn waits for the
   * team to be idle, or for the report interval since the first was due, and learns from all of them at once; elsewhere (the
   * result about to be written, or written) it is now.
   */
  private lessonOwed(): boolean {
    if (this.lessonStalled >= 2 || !this.lessonsOwedNow()) {
      this.lessonsOwedSince = null;
      return false;
    }
    const s = this.state;
    if (s.phase !== "EXECUTION" && s.phase !== "INTEGRATION") return true;
    if (![...this.running.keys()].some((k) => !k.startsWith("pm:"))) return true;
    const now = Date.now();
    this.lessonsOwedSince ??= now;
    const wait = (this.o.reportIntervalMs ?? REPORT_INTERVAL_MS) - (now - this.lessonsOwedSince);
    if (wait <= 0) return true;
    if (!this.lessonTimer) {
      this.lessonTimer = setTimeout(() => {
        this.lessonTimer = null;
        this.wake();
      }, wait);
      this.lessonTimer.unref?.();
    }
    return false;
  }

  /** A lesson is pending where it holds the run (the result is being written, or has been) and the PM is no longer asked in this process. */
  private lessonsStuck(): boolean {
    return (this.state.phase === "APPLY" || this.state.phase === "DONE") && this.lessonsPending() && this.lessonStalled >= 2;
  }

  // ------------------------------------------------------------------ exceptions to the rules
  //
  // A member asks for an exception in its result (`governance.exception`). agentduo records the request for the work of that
  // call (rule-governance.ts), and that work waits: its jobs do not start (board.ts), a result already given is not used, and
  // no answer, merge, acceptance or apply goes past it. The PM who answers for the work assesses the request (a group's own PM
  // may refuse or pass it up; only the head PM proposes it to the user, or asks the user what it cannot tell). The user's
  // answer to the very request that showed the proposal is the only thing that approves it; the member is told only after
  // the request, the assessment and the decision are saved.

  /**
   * What the exception a member asks for comes to: what is wrong with it (it is retried with that), or that it can be recorded and
   * will hold the work (`holds`: its result is not used, so the checks of a completed result are not made), or neither (none asked,
   * or one already decided and delivered: the result is judged as any other).
   */
  private exceptionVerdict(m: Member, work: WorkRef | null, data: unknown, rules: readonly RuleEntry[]): { problems: string[]; holds: boolean } {
    const asked = (data as { governance?: GovernanceReport | null }).governance?.exception ?? null;
    if (!asked || m.kind === "pm") return { problems: [], holds: false };
    if (!work) return { problems: ["no exception can be asked for in this call: leave governance.exception null and do only what the rules allow"], holds: false };
    // Tried on a copy: the request is recorded once the answer is accepted.
    const trial: GovernedState = { ...this.state, governance: structuredClone(this.state.governance) };
    const made = requestException(trial, {
      from: m.name, ruleIds: asked.rule_ids, reason: asked.reason, alternative: asked.alternative, work, known: new Set(rules.map((r) => r.id)),
    });
    return made.ok
      ? { problems: [], holds: holdsWork(made.value) }
      : { problems: [`${made.reason}; if no exception is possible, leave governance.exception null and do only what the rules allow`], holds: false };
  }

  /** Records a member's request for an exception and stops its call's result there (Held); the same request again changes nothing. */
  private holdForException(m: Member, work: WorkRef | null, report: GovernanceReport | null, rules: readonly RuleEntry[]): void {
    const asked = report?.exception;
    if (!asked || m.kind === "pm" || !work) return;
    const made = requestException(this.state, {
      from: m.name, ruleIds: asked.rule_ids, reason: asked.reason, alternative: asked.alternative, work, known: new Set(rules.map((r) => r.id)),
    });
    // Not recorded: the result is not used either (it asked for something that is not a result).
    if (!made.ok) throw new Error(`the exception request was not recorded: ${made.reason}`);
    const ex = made.value;
    // Decided and delivered before (the member asks for what it was already given or refused): the result stands as it is.
    if (!holdsWork(ex)) return;
    if (made.changed) this.routeException(ex);
    this.save();
    throw new Held();
  }

  /** The PM who answers for the work of a request: the group's own PM when its work is a group's and the group has one, else the head PM. */
  private exceptionOwner(ex: RuleException): Member {
    const taskId = ex.requested.taskIds[0];
    const unit = ex.requested.unit;
    const group = taskId ? this.state.tasks.find((t) => t.id === taskId)?.group ?? null : unit?.kind === "planning" && unit.id.startsWith("group:") ? unit.id.slice("group:".length) : null;
    return (group === null ? null : this.groups.find((g) => g.name === group)?.pm) ?? this.head;
  }

  /** A new request is announced in the run's reports, and sent to its group's PM first when there is one (the head PM otherwise sees it at once). */
  private routeException(ex: RuleException): void {
    const s = this.state;
    const scope = scopeWords(ex.requested, s.tasks);
    this.report("agentduo", `${ex.from} asks for an exception to ${ex.ruleIds.join(", ")} for ${scope}. That work waits for the user's decision.`);
    this.logException(ex, `${ex.from} asked for an exception to ${ex.ruleIds.join(", ")} (${ex.id}): ${ex.reason}; the task waits for the decision`);
    const owner = this.exceptionOwner(ex);
    if (owner.name === this.head.name) return;
    const unit = ex.requested.unit;
    s.escalations.push({
      id: `${ex.id}-E1`, task: ex.requested.taskIds.length === 1 ? ex.requested.taskIds[0]! : null,
      ...(unit?.kind === "planning" ? { group: unit.id.slice("group:".length) } : {}), reason: "rule_exception", exceptionId: ex.id, to: owner.name, told: false, answer: null,
      text: `${ex.from} asks for an exception to the team's rules ${ex.ruleIds.join(", ")} for ${scope} (${ex.id}).\nReason: ${ex.reason}` +
        `${ex.alternative ? `\nInstead it would: ${ex.alternative}` : ""}\nThe work waits. Refuse it yourself (team_answer: say why the rules stand), or pass it up (escalate) ` +
        `so that ${this.head.name} can propose it to the user. You never approve it.`,
    });
  }

  /** A line in the history of the task a request is about (and the screen's view of it). */
  private logException(ex: RuleException, text: string): void {
    for (const id of ex.requested.taskIds) {
      const t = this.state.tasks.find((x) => x.id === id);
      if (!t) continue;
      this.log(t, text);
      this.emitTask(t);
    }
  }

  /** Requests that wait for the head PM's assessment: not with a group's PM, who answers or passes them up first. */
  private exceptionsToAssess(): RuleException[] {
    const s = this.state;
    return governanceWork(s).assess.filter((ex) => !s.escalations.some((e) => e.exceptionId === ex.id && e.answer === null && e.to !== this.head.name));
  }

  /** The head PM took the request (proposed, declined or asked about it): what a group's PM was holding for it is closed. */
  private closeExceptionEscalations(id: string, note: string): void {
    for (const e of this.state.escalations) if (e.exceptionId === id && e.answer === null) e.answer = note;
  }

  /** A group's own PM answers a request for an exception: the rules stand. It grants nothing and cannot approve; the member is told once it is saved. */
  private refuseByGroupPm(e: Escalation, answer: string): void {
    const ex = this.state.governance.exceptions.find((x) => x.id === e.exceptionId);
    e.answer = answer;
    if (!ex) return;
    const made = declineException(this.state, ex.id);
    if (!made.ok) {
      this.o.bus.emit({ type: "warning", text: `${e.to}'s refusal of ${ex.id} was not recorded: ${made.reason}` });
      return;
    }
    this.logException(ex, `${e.to} refused the exception ${ex.id}: ${answer}`);
  }

  /** The tasks and units an unanswered request or question holds, as `heldTaskIds` and `unitHeld` read them. */
  private heldRunUnit(): boolean {
    return (["integration", "apply", "acceptance"] as const).some((kind) => unitHeld(this.state, { kind, id: RUN_UNIT }));
  }

  /** Whether the work behind a question to the PM waits for a decision about an exception: no answer of the PM's releases it. */
  private escalationHeld(e: Escalation): boolean {
    if (e.exceptionId) return false;
    const s = this.state;
    if (e.task) return heldTaskIds(s).has(e.task);
    if (e.reason === "planning") return unitHeld(s, planningUnit(e.group ?? null));
    return unitHeld(s, { kind: "integration", id: RUN_UNIT }) || unitHeld(s, { kind: "apply", id: RUN_UNIT });
  }

  private rulesKnown(): Set<string> {
    return new Set(this.rulesStore().rules().map((r) => r.id));
  }

  private pmProposal(a: Extract<PmOutput["action"], { kind: "exception_proposal" }>): void {
    const made = assessException(this.state, a.exception_id, {
      by: this.head.name, ruleIds: a.rule_ids, reason: a.reason, alternative: a.alternative, taskIds: a.task_ids, unit: a.unit, summary: a.summary, known: this.rulesKnown(),
    });
    if (!made.ok) {
      this.o.bus.emit({ type: "warning", text: `The PM's proposal for ${a.exception_id} was not recorded: ${made.reason}` });
      return;
    }
    this.closeExceptionEscalations(a.exception_id, `${this.head.name} proposed it to the user`);
    this.logException(made.value, `${this.head.name} assessed the exception ${a.exception_id}; it goes to the user`);
    this.save();
  }

  private pmDecline(a: Extract<PmOutput["action"], { kind: "exception_decline" }>): void {
    const made = declineException(this.state, a.exception_id);
    if (!made.ok) {
      this.o.bus.emit({ type: "warning", text: `The PM's refusal of ${a.exception_id} was not recorded: ${made.reason}` });
      return;
    }
    this.closeExceptionEscalations(a.exception_id, `${this.head.name} declined it: ${a.reason}`);
    this.logException(made.value, `${this.head.name} declined the exception ${a.exception_id}: ${a.reason}`);
    this.save();
  }

  /**
   * The work that waits for the user's answer about an incident: its source's task, or for what had none the unit it was about (the
   * escalation's group planning, the integration, the apply; a plan's group). Null when nothing is running there now: nothing waits.
   */
  private incidentWork(id: string): WorkRef | null {
    const s = this.state;
    const i = s.governance.incidents.find((x) => x.id === id);
    if (!i) return null;
    const src = i.source;
    let ref: WorkRef | null = null;
    if (src.kind === "escalation") {
      const e = s.escalations.find((x) => x.id === src.escalationId);
      if (e) ref = e.task ? { task: e.task } : e.reason === "planning" ? planningWork(e.group ?? null) : e.reason === "merge_conflict" ? applyWork() : integrationWork();
    } else if ("task" in src && src.task) ref = { task: src.task };
    else if (src.kind === "member_report") {
      const plan = /^plan:(.*):v\d+$/.exec(src.occurrence);
      if (src.occurrence.startsWith("integration:")) ref = integrationWork();
      else if (plan) ref = planningWork(plan[1] === "" ? null : plan[1]!);
    }
    return ref && callScope(s, ref).ok ? ref : null;
  }

  /** The PM cannot decide and asks the user (through the broker): the work that depends on it waits, and the answer is information, never an approval. */
  private pmRuleQuestion(a: Extract<PmOutput["action"], { kind: "rule_question" }>): void {
    const parsed = parseQuestions(a.questions.map((q) => ({ header: q.header, question: q.question, multiSelect: q.multi_select, options: q.options })));
    if ("error" in parsed) return;
    const request = this.request("direction", parsed.questions);
    ledgerOpen(this.state.clarifications, request);
    const target = a.exception_id !== null ? { exceptionId: a.exception_id } : { incidentId: a.incident_id! };
    const asked = askDirection(this.state, target, request.id, a.exception_id === null ? this.incidentWork(a.incident_id!) : undefined);
    if (!asked.ok) {
      ledgerClose(this.state.clarifications, request.id, "cancelled", nowIso(), request.callId);
      this.o.bus.emit({ type: "warning", text: `The PM's question about the rules was not asked: ${asked.reason}` });
      return;
    }
    if (a.exception_id !== null) this.closeExceptionEscalations(a.exception_id, `${this.head.name} asked the user`);
    this.save();
    this.listen(request, (response) => this.directionAnswered(request, response));
  }

  /**
   * A request about the rules the user closed without answering is put off like one they deferred: it stays pending, as it was
   * (the same request, the same words), and the run asks it again when it is reopened. Nothing is decided by it.
   */
  private putOff(request: ClarificationRequest): void {
    this.deferred.add(request.id);
    this.o.bus.emit({ type: "clarification.closed", id: request.id, callId: request.callId, status: "deferred" });
    this.save();
  }

  private directionAnswered(request: ClarificationRequest, response: ClarificationResponse): void {
    const s = this.state;
    if (response.kind !== "answered") return this.putOff(request);
    if (!ledgerAnswer(s.clarifications, request.id, request.callId, response.answers, nowIso())) {
      this.deferred.add(request.id);
      return;
    }
    this.o.bus.emit({ type: "clarification.answered", id: request.id, callId: request.callId, answers: response.answers });
    // The answer is the PM's information: it decides nothing and approves nothing.
    const made = answerDirection(s, request.id, answersText(request.questions, response.answers));
    if (!made.ok) this.o.bus.emit({ type: "warning", text: `The user's answer was not recorded: ${made.reason}` });
    this.save();
  }

  private proposalProblems(a: Extract<PmOutput["action"], { kind: "exception_proposal" }>): string[] {
    const waiting = this.exceptionsToAssess();
    if (!waiting.some((x) => x.id === a.exception_id)) return [`'${a.exception_id}' is not an exception request waiting for you (${waiting.map((x) => x.id).join(", ") || "none"})`];
    const trial: GovernedState = { ...this.state, governance: structuredClone(this.state.governance) };
    const made = assessException(trial, a.exception_id, {
      by: this.head.name, ruleIds: a.rule_ids, reason: a.reason, alternative: a.alternative, taskIds: a.task_ids, unit: a.unit, summary: a.summary, known: this.rulesKnown(),
    });
    return made.ok ? [] : [made.reason];
  }

  private declineProblems(a: Extract<PmOutput["action"], { kind: "exception_decline" }>): string[] {
    const waiting = this.exceptionsToAssess();
    if (!waiting.some((x) => x.id === a.exception_id)) return [`'${a.exception_id}' is not an exception request waiting for you (${waiting.map((x) => x.id).join(", ") || "none"})`];
    return a.reason.trim() ? [] : ["say why the rules stand, for the member who asked"];
  }

  private questionProblems(a: Extract<PmOutput["action"], { kind: "rule_question" }>): string[] {
    if ((a.exception_id === null) === (a.incident_id === null)) return ["ask about one thing: an exception request (exception_id) or an incident (incident_id), the other null"];
    const parsed = parseQuestions(a.questions.map((q) => ({ header: q.header, question: q.question, multiSelect: q.multi_select, options: q.options })));
    if ("error" in parsed) return [`your questions cannot be shown: ${parsed.error}`];
    if (a.exception_id !== null && !this.exceptionsToAssess().some((x) => x.id === a.exception_id)) return [`'${a.exception_id}' is not an exception request waiting for you`];
    if (a.incident_id !== null && !governanceWork(this.state).lessons.some((i) => i.id === a.incident_id && i.status === "resolved")) return [`'${a.incident_id}' is not a settled incident waiting for you`];
    const trial: GovernedState = { ...this.state, governance: structuredClone(this.state.governance) };
    const made = askDirection(trial, a.exception_id !== null ? { exceptionId: a.exception_id } : { incidentId: a.incident_id! }, "trial", a.exception_id === null ? this.incidentWork(a.incident_id!) : undefined);
    return made.ok ? [] : [made.reason];
  }

  /** What the user reads when an assessed request is shown: the rules, the reason, the alternative and the work it covers, to approve or refuse. */
  private exceptionQuestion(ex: RuleException): ClarificationQuestion {
    const a = ex.assessment!;
    const rules = this.rulesStore().rules();
    const named = a.ruleIds.map((id) => { const r = rules.find((x) => x.id === id); return r ? `${id} (${r.text})` : id; }).join("; ");
    return {
      id: "decision", header: "Exception", multiSelect: false,
      question: `${ex.from} asks to depart from ${named} for ${scopeWords(a.scope, this.state.tasks)} only.\nReason: ${a.reason}\nInstead: ${a.alternative}\n${a.summary}\n` +
        "Approve this exception for that work only? The rules stay in force everywhere else, and refusing keeps the work under the rules as written.",
      options: [
        { id: APPROVE_OPTION, label: "Approve for this work only", description: "The team departs from the rules as proposed, for that work and nothing else" },
        { id: REJECT_OPTION, label: "Refuse", description: "The rules stand; the work goes on as the rules say" },
      ],
    };
  }

  /** Shows the proposals the PM assessed and the user has not seen yet. Saved before the user is asked; true when it showed one. */
  private presentAssessed(): boolean {
    const ex = governanceWork(this.state).present[0];
    if (!ex) return false;
    const request = this.request("exception", [this.exceptionQuestion(ex)]);
    ledgerOpen(this.state.clarifications, request);
    const shown = presentException(this.state, ex.id, request.id);
    if (!shown.ok) {
      ledgerClose(this.state.clarifications, request.id, "cancelled", nowIso(), request.callId);
      throw new Error(`the exception ${ex.id} could not be shown to the user: ${shown.reason}`);
    }
    this.save();
    this.listen(request, (response) => this.exceptionAnswered(request, response));
    return true;
  }

  /** The user's response to a request that showed an exception. Only the approve or the refuse option decides; anything else is words for the PM. */
  private exceptionAnswered(request: ClarificationRequest, response: ClarificationResponse): void {
    const s = this.state;
    if (response.kind !== "answered") return this.putOff(request);
    // A request that is closed already (a replaced one, a repeated answer) is refused by the ledger: it decides nothing.
    if (!ledgerAnswer(s.clarifications, request.id, request.callId, response.answers, nowIso())) {
      this.deferred.add(request.id);
      return;
    }
    this.o.bus.emit({ type: "clarification.answered", id: request.id, callId: request.callId, answers: response.answers });
    const answer = response.answers[0]!;
    const verdict = decisionFromAnswer(answer);
    const ex = s.governance.exceptions.find((x) => x.decision?.requestId === request.id);
    if (verdict === null) {
      if (!ex) return;
      // Words, or no clear choice: guidance for the PM, never an approval. The same proposal is shown again under a new request.
      this.userWords(`(about exception ${ex.id}) ${answer.otherText?.trim() || "No decision yet."}`);
      this.askExceptionAgain(ex);
      return;
    }
    const decided = decideException(s, { requestId: request.id, source: "user", approved: verdict === "approved" });
    if (!decided.ok) {
      this.o.bus.emit({ type: "warning", text: `The user's answer decides nothing: ${decided.reason}` });
      this.save();
      return;
    }
    this.logException(decided.value, `the user ${verdict === "approved" ? "approved" : "refused"} the exception ${decided.value.id}`);
    this.save();
  }

  /** A shown request nobody decided (closed unanswered, or answered in words) is shown again, under a new id; the old id decides nothing. */
  private askExceptionAgain(ex: RuleException): void {
    const old = ex.decision!.requestId!;
    const request = this.request("exception", [this.exceptionQuestion(ex)]);
    ledgerOpen(this.state.clarifications, request);
    const moved = repointRequest(this.state, old, request.id);
    if (!moved.ok) {
      ledgerClose(this.state.clarifications, request.id, "cancelled", nowIso(), request.callId);
      this.o.bus.emit({ type: "warning", text: `The exception ${ex.id} could not be asked again: ${moved.reason}` });
      return;
    }
    ledgerClose(this.state.clarifications, old, "cancelled", nowIso());
    this.save();
    this.listen(request, (response) => this.exceptionAnswered(request, response));
  }

  /** Asks again the requests about the rules that nobody answered (a reopened run): the same request when it is still pending, a new one otherwise. */
  private reopenGovernance(): void {
    const s = this.state;
    const work = governanceWork(s);
    const free = (id: string) => !this.open.has(id) && !this.deferred.has(id) && !this.announced.has(id);
    for (const ex of work.pending) {
      const id = ex.decision!.requestId!;
      if (!free(id)) continue;
      const entry = s.clarifications.find((c) => c.id === id);
      if (entry?.status === "pending") {
        const { seq: _seq, status: _status, ...request } = entry;
        this.listen(request, (response) => this.exceptionAnswered(request, response));
      } else if (this.o.decider) this.askExceptionAgain(ex);
    }
    for (const q of work.questions) {
      if (!free(q.requestId)) continue;
      const entry = s.clarifications.find((c) => c.id === q.requestId);
      if (!entry) continue;
      if (entry.status === "pending") {
        const { seq: _seq, status: _status, ...request } = entry;
        this.listen(request, (response) => this.directionAnswered(request, response));
        continue;
      }
      if (!this.o.decider) continue;
      const request = this.request("direction", entry.questions);
      ledgerOpen(s.clarifications, request);
      if (!repointRequest(s, q.requestId, request.id).ok) {
        ledgerClose(s.clarifications, request.id, "cancelled", nowIso(), request.callId);
        continue;
      }
      this.save();
      this.listen(request, (response) => this.directionAnswered(request, response));
    }
  }

  /** Releases decided requests to the work they held: the member's next prompt carries the decision. Saved before the work wakes. */
  private deliverDecisions(): boolean {
    let changed = false;
    for (const ex of governanceWork(this.state).undelivered) {
      const done = deliverDecision(this.state, ex.id);
      if (!done.ok || !done.changed) continue;
      changed = true;
      const approved = ex.decision!.status === "approved";
      const text = approved
        ? `The user approved the exception ${ex.id} (${ex.assessment!.ruleIds.join(", ")}) for ${scopeWords(ex.assessment!.scope, this.state.tasks)} only; the rules stand everywhere else.`
        : `${ex.decision!.by === "pm" ? "The PM declined" : "The user refused"} the exception ${ex.id}; the work goes on under the rules as written.`;
      this.report("agentduo", text);
      this.logException(ex, text);
    }
    if (changed) this.save();
    return changed;
  }

  /** The files the user attached to the request and to messages since, oldest first: every member is given them. */
  private files(): Attachment[] {
    const all = this.state.messages.flatMap((m) => (m.from === "user" ? m.attachments ?? [] : []));
    return all.filter((a, i) => all.findIndex((b) => b.id === a.id) === i);
  }

  private parts(m: Member) {
    if (!this.promptRules) throw new Error("a prompt is built inside a call, which reads the team's rules first");
    return { member: m, members: this.members, state: this.state, rules: this.promptRules };
  }

  private brief(): Brief {
    return approvedBrief(this.state) ?? latestBrief(this.state)!;
  }

  // ------------------------------------------------------------------ the PM

  private async pmTurn(occasion: PmOccasion): Promise<void> {
    const s = this.state;
    const pm = this.head;
    const seenMessages = s.pmSeen;
    const messagesNow = s.messages.length;
    const reports = s.reports.slice(s.reportsSeen);
    const reportsNow = s.reports.length;
    const open = s.escalations.filter((e) => e.answer === null && e.to === pm.name && !e.exceptionId && !this.escalationHeld(e));
    const set = this.planSet() ?? [];
    const shown = occasion.kind === "plan_review" ? set : this.approvedSet();
    const actions = pmActions(s, occasion);
    const owedBefore = this.lessonsOwedNow();
    // A lesson turn answers every incident owed now (the prompt lists them all), so that one turn learns from all of them.
    const due = occasion.kind === "rule_lesson" ? this.lessonsDue().map((i) => i.id) : [];
    if (occasion.kind === "rule_lesson") this.lessonsOwedSince = null;
    let cwd = this.o.workspace;
    if (s.base) {
      const tg = await this.teamGit();
      cwd = await tg.checkout(pm.name, await tg.integrationHead());
    }
    const out = await this.call<PmOutput>(pm, "pm", "team_pm", (session) => pmPrompt({
      ...this.parts(pm), ...session, occasion, seenMessages: session.identity ? 0 : seenMessages, reports, openEscalations: open, groups: this.groups, plans: shown,
      areas: currentAreas(s),
    }), { task: null, cwd, check: (d) => this.pmProblems(d, actions, open, due) });
    s.pmSeen = Math.max(s.pmSeen, messagesNow);
    s.reportsSeen = Math.max(s.reportsSeen, reportsNow);
    if (reports.length) s.lastReportAt = nowIso();
    for (const e of open) e.told = true;
    if (out.message?.trim()) {
      const seq = nextSeq(s);
      s.messages.push({ seq, at: nowIso(), from: "pm", text: out.message.trim() });
      s.pmSeen = s.messages.length;
      this.o.bus.emit({ type: "team.message", runId: this.id, from: "pm", text: out.message.trim(), seq });
    }
    const a = out.action;
    switch (a.kind) {
      case "questions": this.pmQuestions(a.questions); break;
      case "brief": case "change_request":
        this.newBrief(a.brief);
        this.knows(pm, null, authored.brief(latestBrief(s)!));
        break;
      case "plan_review": {
        if (!set.length) break;
        const signature = planSignature(set);
        s.planReviewed = signature;
        if (a.approve) {
          for (const p of set) p.pmApproved = true;
          s.planPresented = signature;
          if (a.summary) this.document("plan", this.grouped ? `The plan (${set.length} groups)` : `Plan v${set[0]!.version}`, a.summary);
        } else {
          // Each issue goes to its group's techlead; one for no group goes to every techlead of the set.
          for (const p of set) {
            const mine = a.issues.filter((i) => i.group === null || i.group === p.group);
            if (!mine.length) continue;
            p.declined = true;
            p.pmApproved = false;
            s.planFeedback[groupKey(p.group)] = `The PM sent it back:\n${mine.map((i) => `- ${i.id}: ${i.issue}`).join("\n")}`;
            this.planSentBack(pm, p, mine.map((i) => i.issue));
          }
        }
        break;
      }
      case "areas": {
        const version = s.approvedBrief!;
        s.areas = s.areas.filter((x) => x.briefVersion !== version);
        for (const x of a.areas) s.areas.push({ briefVersion: version, group: x.group, area: x.area, criteria: [...x.criteria] });
        this.knows(pm, null, authored.areas(currentAreas(s)));
        this.document("plan", "The groups' parts", a.areas.map((x) => `- ${x.group}: ${x.area} (${x.criteria.join(", ")})`).join("\n"));
        break;
      }
      case "lead_note":
        if (s.phase === "ACCEPTANCE") {
          const tg = await this.teamGit();
          s.integration = {
            commit: await tg.integrationHead(), checks: [], triage: true, trouble: `The user asked for changes (through the PM): ${a.note}`,
            triageGroups: a.group ? [a.group] : this.groups.map((g) => groupKey(g.name)),
          };
        } else s.leadNotes.push({ group: a.group, text: a.note });
        break;
      case "team_answer": this.answerEscalation(a.question_id, a.answer); break;
      case "rule_lesson": this.pmLessons(a.lessons); break;
      case "exception_proposal": this.pmProposal(a); break;
      case "exception_decline": this.pmDecline(a); break;
      case "rule_question": this.pmRuleQuestion(a); break;
      case "acceptance":
        s.acceptance = { criteria: a.criteria, summary: a.summary };
        this.document("acceptance", "Acceptance report", [a.summary, ...a.criteria.map((c) => `- ${c.id}: ${c.status} — ${c.evidence}`)].join("\n"));
        break;
      default:
        break;
    }
    if (occasion.kind === "rule_lesson") {
      this.lessonStalled = this.lessonsOwedNow() < owedBefore ? 0 : this.lessonStalled + 1;
    }
    this.save();
  }

  /** What is wrong with the PM's answer; `due`: the incidents its lesson turn must answer (those it was shown that wait for nothing). */
  private pmProblems(d: PmOutput, actions: string[], open: Escalation[], due: readonly string[] = []): string[] {
    const a = d.action;
    if (!actions.includes(a.kind)) return [`the action '${a.kind}' is not allowed now; allowed: ${actions.join(", ")}`];
    if (a.kind === "questions") {
      const parsed = parseQuestions(a.questions.map((q) => ({ header: q.header, question: q.question, multiSelect: q.multi_select, options: q.options })));
      if ("error" in parsed) return [`your questions cannot be shown: ${parsed.error}`];
    }
    if (a.kind === "brief" || a.kind === "change_request") {
      const b = a.brief;
      const ids = b.criteria.map((c) => c.id);
      if (!b.criteria.length) return ["the brief needs at least one acceptance criterion"];
      if (new Set(ids).size !== ids.length) return [`acceptance criteria ids must be unique (${ids.join(", ")})`];
      if (b.criteria.some((c) => !c.criterion.trim())) return ["every acceptance criterion needs its text"];
    }
    const groupNames = this.groups.flatMap((g) => (g.name ? [g.name] : []));
    if (a.kind === "areas") {
      const named = a.areas.map((x) => x.group);
      const problems: string[] = [];
      for (const g of named) if (!groupNames.includes(g)) problems.push(`'${g}' is not a group (${groupNames.join(", ")})`);
      for (const g of groupNames) if (named.filter((n) => n === g).length !== 1) problems.push(`give group '${g}' exactly one part`);
      const ids = this.brief().criteria.map((c) => c.id);
      for (const x of a.areas) for (const c of x.criteria) if (!ids.includes(c)) problems.push(`'${c}' (in ${x.group}'s part) is not an acceptance criterion (${ids.join(", ")})`);
      for (const c of ids) if (!a.areas.some((x) => x.criteria.includes(c))) problems.push(`acceptance criterion ${c} is no group's`);
      return problems;
    }
    if ((a.kind === "plan_review" && a.issues.some((i) => i.group !== null && !groupNames.includes(i.group))) || (a.kind === "lead_note" && a.group !== null && !groupNames.includes(a.group))) {
      return [`name a group of the team (${groupNames.join(", ") || "it has none: use null"}), or null`];
    }
    if (a.kind === "team_answer" && !open.some((e) => e.id === a.question_id)) {
      return [`'${a.question_id}' is not an open question of the team (${open.map((e) => e.id).join(", ") || "none"})`];
    }
    if (a.kind === "rule_lesson") return this.lessonProblems(a.lessons, due);
    if (a.kind === "exception_proposal") return this.proposalProblems(a);
    if (a.kind === "exception_decline") return this.declineProblems(a);
    if (a.kind === "rule_question") return this.questionProblems(a);
    if (a.kind === "plan_review" && a.approve && !a.summary?.trim()) return ["an approved plan needs your summary of it for the user"];
    if (a.kind === "plan_review" && !a.approve && !a.issues.length) return ["say which issues send the plan back"];
    if (a.kind === "acceptance") {
      const missing = this.brief().criteria.filter((c) => !a.criteria.some((x) => x.id === c.id)).map((c) => c.id);
      if (missing.length) return [`report every acceptance criterion of the brief; missing: ${missing.join(", ")}`];
    }
    return [];
  }

  /**
   * What is wrong with the PM's lessons, each said for its incident: an entry that is no incident waiting for one, a rule
   * RULES.md would refuse, another text for one being recorded, an incident answered twice, the same rule twice (it is
   * written once: the other entry says null and names it), or an incident of `due` left out (one turn answers them all).
   */
  private lessonProblems(lessons: readonly LessonAnswer[], due: readonly string[]): string[] {
    const owed = governanceWork(this.state).lessons;
    const problems: string[] = [];
    const answered = new Set<string>();
    const rules = new Map<string, string>();
    for (const a of lessons) {
      if (answered.has(a.incident_id)) {
        problems.push(`${a.incident_id} is answered twice: give one entry per incident`);
        continue;
      }
      answered.add(a.incident_id);
      const i = owed.find((x) => x.id === a.incident_id);
      if (!i) {
        problems.push(`'${a.incident_id}' is not an incident waiting for a lesson (${owed.map((x) => x.id).join(", ") || "none"})`);
        continue;
      }
      const text = a.rule?.trim();
      if (!text) {
        if (!a.rationale.trim()) problems.push(`${i.id}: say in rationale why no new rule is needed`);
        continue;
      }
      if (i.status === "recording" && i.lesson?.text !== text) {
        problems.push(`the rule for ${i.id} is being recorded; give exactly this text: ${i.lesson?.text}`);
        continue;
      }
      const problem = ruleInputProblem({ text, incident: lessonSource(this.id, i) });
      if (problem) problems.push(`${i.id}: ${problem}`);
      const same = rules.get(text);
      if (same) problems.push(`${i.id} repeats the rule of ${same}: write it once, and give ${i.id} rule null with a rationale that names it`);
      else rules.set(text, i.id);
    }
    const missing = due.filter((id) => !answered.has(id) && owed.some((x) => x.id === id && x.status === "resolved"));
    if (missing.length) {
      problems.push(`answer every settled incident in this one turn: ${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} no entry ` +
        "(rule null and why, when no new rule is needed)");
    } else if (!lessons.length) problems.push("give a lesson for each settled incident listed");
    return problems;
  }

  /** A PM objected to a plan: a disagreement with its techlead, settled once a later plan of the group is approved. */
  private planSentBack(pm: Member, plan: TeamPlan, issues: string[]): void {
    this.note({
      kind: "disagreement", source: { kind: "member_report", member: pm.name, task: null, occurrence: `plan:${groupKey(plan.group)}:v${plan.version}` }, reportedBy: pm.name,
      summary: `${pm.name} sent ${plan.group ? `group ${plan.group}'s ` : "the "}plan v${plan.version} back: ${issues.join("; ")}`,
    });
  }

  private newBrief(b: Omit<Brief, "version">): void {
    const s = this.state;
    const version = (latestBrief(s)?.version ?? 0) + 1;
    s.briefs.push({ ...b, version });
    this.document("brief", `Brief v${version}: ${b.title}`, [b.goal, ...b.criteria.map((c) => `- ${c.id}: ${c.criterion}`)].join("\n"));
  }

  private document(kind: "brief" | "plan" | "acceptance", title: string, text: string): void {
    this.o.bus.emit({ type: "team.document", runId: this.id, kind, title, text });
  }

  private pmQuestions(raw: Array<{ header: string; question: string; multi_select: boolean; options: Array<{ label: string; description: string }> }>): void {
    const parsed = parseQuestions(raw.map((q) => ({ header: q.header, question: q.question, multiSelect: q.multi_select, options: q.options })));
    if ("error" in parsed) return;
    const request = this.request("questions", parsed.questions);
    ledgerOpen(this.state.clarifications, request);
    this.listen(request, (response) => {
      if (response.kind !== "answered") {
        ledgerClose(this.state.clarifications, request.id, "cancelled", nowIso(), request.callId);
        this.save();
        return;
      }
      ledgerAnswer(this.state.clarifications, request.id, request.callId, response.answers, nowIso());
      this.o.bus.emit({ type: "clarification.answered", id: request.id, callId: request.callId, answers: response.answers });
      this.userWords(answersText(request.questions, response.answers));
      this.save();
    });
  }

  private answerEscalation(id: string, answer: string): void {
    const s = this.state;
    const e = s.escalations.find((x) => x.id === id);
    if (!e || e.answer !== null) return;
    // A request for an exception is not a question that an answer settles: its PM refuses it (the rules stand), nothing more.
    if (e.exceptionId) return this.refuseByGroupPm(e, answer);
    // The work behind an exception request that waits is not released by an answer to something else.
    if (this.escalationHeld(e)) return;
    e.answer = answer;
    // What the PM had to settle because the team could not (planning, fixes or the integration that did not converge) is an incident to learn from.
    if (e.reason === "planning" || e.reason === "review_stalled" || e.reason === "task_limit" || e.reason === "integration_limit") {
      this.note({ kind: e.reason === "planning" ? "disagreement" : "deviation", source: { kind: "escalation", escalationId: e.id }, reportedBy: "agentduo", summary: e.text });
    }
    // The jobs that failed on it may run again: the answer is something new.
    for (const key of [...this.failures.keys()]) if (!e.task || key.endsWith(`:${e.task}`)) this.failures.delete(key);
    if (e.task) {
      const t = this.task(e.task);
      if (t.status === "blocked" && t.question?.escalated) {
        t.question.answer = answer;
        t.status = "coding";
      } else {
        if (e.reason === "task_limit" || e.reason === "review_stalled") {
          t.attempt = 1;
          t.stalls = 0;
          t.lastFailureKeys = [];
        }
        t.status = "triage";
        t.trouble = `${t.trouble ?? ""}\nThe PM answered (${e.reason}): ${answer}`.trim();
      }
      this.log(t, `the PM answered: ${answer}`);
      this.emitTask(t);
    } else if (e.reason === "planning") {
      const key = groupKey(e.group ?? null);
      s.planningExtra[key] = (s.planningExtra[key] ?? 0) + this.o.cfg.limits.max_planning_rounds;
      s.planFeedback[key] = `${s.planFeedback[key] ?? ""}\nThe PM answered: ${answer}`.trim();
    } else if (e.reason === "integration_limit" || e.reason === "question") {
      s.integrationRounds = 0;
      if (s.integration) {
        s.integration.triage = true;
        s.integration.trouble = `${s.integration.trouble ?? ""}\nThe PM answered: ${answer}`.trim();
        const keys = e.group !== undefined ? [groupKey(e.group ?? null)] : this.failingGroups(s.integration.checks);
        s.integration.triageGroups = [...new Set([...s.integration.triageGroups, ...keys])];
      }
    }
  }

  /** A group PM passes a question up: the head PM answers it now (or asks you). */
  private passUp(id: string, question: string, from: Member): void {
    const e = this.state.escalations.find((x) => x.id === id);
    if (!e || e.answer !== null) return;
    e.to = this.head.name;
    e.told = false;
    e.text = `${e.text}\n${from.name} (the group's PM): ${question}`;
  }

  /** A group's own PM: checks its techlead's plan, or answers (or passes up) its techlead's question. Never talks to you. */
  private async areaTurn(g: TeamGroup, occasion: PmOccasion): Promise<void> {
    const s = this.state;
    const pm = g.pm!;
    const open = s.escalations.filter((e) => e.answer === null && e.to === pm.name && !this.escalationHeld(e));
    const plan = latestPlan(s, g.name);
    const area = currentAreas(s).find((a) => a.group === g.name) ?? null;
    const actions = pmActions(s, occasion);
    let cwd = this.o.workspace;
    if (s.base) {
      const tg = await this.teamGit();
      cwd = await tg.checkout(pm.name, await tg.integrationHead());
    }
    const out = await this.call<PmOutput>(pm, "pm", "team_pm", (session) => areaPmPrompt({
      ...this.parts(pm), ...session, occasion, brief: this.brief(), group: g, area, plan: occasion.kind === "area_review" ? plan : null, openEscalations: open, head: this.head,
    }), {
      task: null, cwd, check: (d) => {
        const a = d.action;
        if (!actions.includes(a.kind)) return [`the action '${a.kind}' is not allowed now; allowed: ${actions.join(", ")}`];
        if ((a.kind === "team_answer" || a.kind === "escalate") && !open.some((e) => e.id === a.question_id)) {
          return [`'${a.question_id}' is not an open question of your group (${open.map((e) => e.id).join(", ") || "none"})`];
        }
        if (a.kind === "plan_review" && !a.approve && !a.issues.length) return ["say which issues send the plan back"];
        return [];
      },
    });
    const a = out.action;
    if (a.kind === "plan_review" && plan && latestPlan(s, g.name) === plan) {
      plan.areaApproved = a.approve;
      if (!a.approve) {
        plan.declined = true;
        s.planFeedback[groupKey(g.name)] = `${pm.name} (your group's PM) sent it back:\n${a.issues.map((i) => `- ${i.id}: ${i.issue}`).join("\n")}`;
        this.planSentBack(pm, plan, a.issues.map((i) => i.issue));
      }
      this.report(pm.name, a.approve ? `${g.name}'s plan v${plan.version} is right for its part` : `${g.name}'s plan v${plan.version} goes back to ${g.lead.name}`);
    } else if (a.kind === "team_answer") this.answerEscalation(a.question_id, a.answer);
    else if (a.kind === "escalate") this.passUp(a.question_id, a.question, pm);
    this.save();
  }

  // ------------------------------------------------------------------ the techlead

  /** A group's techlead plans its part (the whole work, in a team without groups). */
  private async planTurn(g: TeamGroup): Promise<void> {
    const s = this.state;
    const techlead = g.lead;
    const key = groupKey(g.name);
    const max = this.o.cfg.limits.max_planning_rounds + (s.planningExtra[key] ?? 0);
    const rounds = s.plans.filter((p) => p.group === g.name && p.briefVersion === s.approvedBrief).length;
    if (rounds >= max) {
      if (!s.escalations.some((e) => e.reason === "planning" && e.answer === null && (e.group ?? null) === g.name)) {
        this.escalate(null, "planning", `${g.name ? `Group ${g.name}'s planning` : "Planning"} did not converge in ${max} round(s): ${s.planFeedback[key] ?? ""}`, g.name);
        this.save();
      }
      return;
    }
    const tg = await this.teamGit();
    const cwd = await tg.checkout(techlead.name, await tg.integrationHead());
    const brief = this.brief();
    const additions = s.replanning;
    const existing = s.tasks.filter((t) => t.status !== "cancelled");
    const area = currentAreas(s).find((a) => a.group === g.name) ?? null;
    const previous = latestPlan(s, g.name) ?? s.plans.filter((p) => p.group === g.name).at(-1) ?? null;
    const required = this.requiredCriteria(g);
    const out = await this.call<PlanOutput>(techlead, "plan", "team_plan", (session) => planPrompt({
      ...this.parts(techlead), ...session, brief, feedback: s.planFeedback[key] ?? null, previous, existing: additions ? existing : [], additions,
      area: this.grouped ? area : null, group: this.grouped ? g : null,
    }), {
      task: null, cwd, work: planningWork(g.name), check: (d) => planProblems(d.tasks, [...g.members, techlead], brief, additions ? s.tasks : [], required),
    });
    s.planningRounds += 1;
    const version = s.plans.filter((p) => p.group === g.name).reduce((n, p) => Math.max(n, p.version), 0) + 1;
    const plan: TeamPlan = {
      version, group: g.name, briefVersion: s.approvedBrief!, ...(g.pm ? { areaApproved: null } : {}), summary: out.summary, tasks: out.tasks, risks: out.risks,
      pmApproved: null, additions,
    };
    s.plans.push(plan);
    this.knows(techlead, null, authored.plan(plan));
    delete s.planFeedback[key];
    this.report(techlead.name, out.report);
    this.save();
  }

  private async triageTurn(id: string): Promise<void> {
    const s = this.state;
    const t = this.task(id);
    const g = this.group(t.group);
    const techlead = g.lead;
    const tg = await this.teamGit();
    const cwd = await tg.checkout(techlead.name, t.code ?? await tg.integrationHead());
    // A task stays in its group: its techlead hands it to one of the group's workers.
    const workers = g.members.filter((m) => m.kind === "worker");
    const max = this.o.cfg.team.limits.max_task_attempts;
    const out = await this.call<TriageOutput>(techlead, "triage", "team_triage", (session) => triagePrompt({
      ...this.parts(techlead), ...session, task: t, brief: this.brief(), maxAttempts: max, workers,
    }), {
      task: t.id, cwd, check: (d) => {
        if (d.action === "add_tasks") return ["add_tasks is for the whole result, not a task: retry, reassign, fix_tests or escalate"];
        if (d.action === "reassign" && !workers.some((w) => w.name === d.assignee)) return [`reassign names a member who takes tasks (${workers.map((w) => w.name).join(", ")})`];
        if (d.action === "escalate" && !d.question?.trim()) return ["escalate needs the question for the PM"];
        if (d.action === "fix_tests" && !t.checks.some((c) => c.verdict === "fail" && c.by !== "gates")) return ["fix_tests needs a failing tester's check; none failed"];
        return [];
      },
    });
    if (t.status !== "triage") return;
    this.report(techlead.name, out.report);
    t.guidance = out.guidance;
    if (out.action === "escalate") {
      t.question = { id: `${t.id}-q${nextSeq(s)}`, from: techlead.name, text: out.question!, escalated: true, answer: null };
      this.escalate(t, "question", `${t.id}: ${out.question}`);
      this.save();
      return;
    }
    t.attempt += 1;
    if (t.attempt > max) {
      this.escalate(t, "task_limit", `Task ${t.id} (${t.title}) still fails after ${max} attempt(s): ${t.trouble ?? ""}`);
      this.save();
      return;
    }
    t.reviewRound = 0;
    t.candidate = null;
    if (out.action === "fix_tests") {
      // The failing checks stay for the testers to read; the code and its review stand.
      for (const tester of t.testers) t.tests[tester]!.status = "fixing";
      t.status = "testing";
      this.log(t, `attempt ${t.attempt}: the techlead says the tests are wrong`);
    } else {
      t.review = null;
      t.reviewer = null;
      t.checks = [];
      if (out.action === "reassign") t.assignee = out.assignee!;
      t.status = "coding";
      this.log(t, `attempt ${t.attempt}: ${out.action}${out.action === "reassign" ? ` to ${t.assignee}` : ""}`);
    }
    this.emitTask(t);
    this.save();
  }

  private async answerTurn(id: string): Promise<void> {
    const t = this.task(id);
    const techlead = this.group(t.group).lead;
    const tg = await this.teamGit();
    const cwd = await tg.checkout(techlead.name, t.code ?? t.base!);
    const out = await this.call<AnswerOutput>(techlead, "answer", "team_answer", (session) => answerPrompt({ ...this.parts(techlead), ...session, task: t, brief: this.brief() }), {
      task: t.id, cwd, check: (d) => (!d.answer?.trim() && !d.escalate?.trim() ? ["give an answer, or escalate with the question for the PM"] : []),
    });
    if (t.status !== "blocked" || !t.question) return;
    if (out.report) this.report(techlead.name, out.report);
    if (out.answer?.trim()) {
      t.question.answer = out.answer;
      t.status = "coding";
      this.log(t, `the techlead answered: ${out.answer}`);
    } else {
      t.question.escalated = true;
      this.escalate(t, "question", `${t.id}: ${out.escalate}`);
    }
    this.emitTask(t);
    this.save();
  }

  private async resolveTurn(id: string): Promise<void> {
    const t = this.task(id);
    const techlead = this.group(t.group).lead;
    const tg = await this.teamGit();
    const head = await tg.integrationHead();
    const files = await tg.startResolve(techlead.name, t.candidate!);
    const cwd = await tg.cwd(techlead.name);
    await this.call<WorkOutput>(techlead, "resolve", "team_work", (session) => resolvePrompt({ ...this.parts(techlead), ...session, task: t, brief: this.brief(), cwd, files }), { task: t.id, cwd });
    const done = await tg.finishResolve(techlead.name, t.candidate!, head, `agentduo team ${this.id}: merge ${t.id} (resolved)`);
    if ("problem" in done) {
      this.escalate(t, "merge_conflict", `Task ${t.id} cannot be merged: ${done.problem}`);
    } else {
      t.status = "merged";
      this.log(t, `merged after the techlead resolved conflicts in ${files.join(", ")}`);
      this.report("agentduo", `${t.id} (${t.title}) is merged (conflicts resolved by the techlead)`);
    }
    this.emitTask(t);
    this.save();
  }

  /** A group's techlead adds the tasks that fix its share of what the whole result failed (or of what you asked to change). */
  private async integrationTriageTurn(name: string): Promise<void> {
    const s = this.state;
    const ig = s.integration!;
    const techlead = this.member(name);
    const g = this.group(techlead.group);
    const key = groupKey(g.name);
    if (!ig.triageGroups.includes(key)) return;
    const tg = await this.teamGit();
    const cwd = await tg.checkout(techlead.name, await tg.integrationHead());
    const brief = this.brief();
    // In a team with groups, a group sees the failures of its criteria (the first group, those of none).
    const own = currentAreas(s).find((a) => a.group === g.name)?.criteria;
    const first = g === this.groups[0];
    const checks = ig.checks.filter((c) => c.verdict === "fail").map((c) => ({
      ...c, failures: !this.grouped ? c.failures : c.failures.filter((f) => f.criteria.some((x) => own?.includes(x)) || (first && !f.criteria.length)),
    })).filter((c) => !this.grouped || c.failures.length || c.by === "gates");
    const out = await this.call<TriageOutput>(techlead, "integration-triage", "team_triage", (session) => integrationTriagePrompt({
      ...this.parts(techlead), ...session, brief, trouble: ig.trouble ?? "", checks,
    }), {
      task: null, cwd, work: integrationWork(), check: (d) => {
        if (d.action === "escalate") return d.question?.trim() ? [] : ["escalate needs the question for the PM"];
        if (d.action !== "add_tasks") return ["add the tasks that fix it (add_tasks), or escalate"];
        return planProblems(d.tasks, [...g.members, techlead], brief, s.tasks, null);
      },
    });
    const now = s.integration;
    if (!now?.triage || !now.triageGroups.includes(key)) return;
    this.report(techlead.name, out.report);
    now.triageGroups = now.triageGroups.filter((k) => k !== key);
    if (out.action === "escalate") this.escalate(null, "question", out.question!, g.name);
    else {
      for (const t of out.tasks) {
        const task = newTask(t, g.name);
        s.tasks.push(task);
        this.emitTask(task);
      }
    }
    // Once every group has answered for its share: back to work if any added a task; otherwise the team waits for the answers.
    if (!now.triageGroups.length && s.tasks.some((t) => !finished(t))) {
      s.integration = null;
      s.accepted = false;
      s.acceptance = null;
      this.setPhase("EXECUTION");
    }
    this.save();
  }

  private async resolveApplyTurn(): Promise<void> {
    const s = this.state;
    const conflict = s.applyConflict!;
    const techlead = this.groups[0]!.lead;
    const tg = await this.teamGit();
    const head = await tg.integrationHead();
    const files = await tg.startResolve(techlead.name, conflict.ours);
    const cwd = await tg.cwd(techlead.name);
    await this.call<WorkOutput>(techlead, "resolve", "team_work", (session) => resolvePrompt({ ...this.parts(techlead), ...session, task: null, brief: this.brief(), cwd, files }), { task: null, cwd, work: applyWork() });
    const done = await tg.finishResolve(techlead.name, conflict.ours, head, `agentduo team ${this.id}: the workspace's changes merged`);
    if ("problem" in done) {
      s.applyConflict!.resolving = false;
      this.escalate(null, "merge_conflict", `The result cannot be merged with your folder's changes: ${done.problem}`);
    } else {
      s.applyConflict = null;
      s.integration = { commit: done.head, checks: [], triage: false, trouble: null, triageGroups: [] };
      this.setPhase("INTEGRATION");
    }
    this.save();
  }

  // ------------------------------------------------------------------ workers and testers

  private async workTurn(name: string, id: string): Promise<void> {
    const t = this.task(id);
    const m = this.member(name);
    const tg = await this.teamGit();
    if (t.status === "pending") {
      t.status = "coding";
      t.base = await tg.integrationHead();
      this.log(t, `${m.name} started it`);
      this.emitTask(t);
      this.save();
    }
    if (t.status !== "coding" || t.assignee !== m.name) return;
    const cwd = await tg.checkout(m.name, t.code ?? t.base!);
    const out = await this.call<WorkOutput>(m, "work", "team_work", (session) => workPrompt({
      ...this.parts(m), ...session, task: t, brief: this.brief(), others: this.state.tasks, cwd,
    }), { task: t.id, cwd, check: (d) => (d.status === "blocked" && !d.question?.trim() ? ["a blocked result needs your question for the techlead"] : []) });
    if (t.status !== "coding" || t.assignee !== m.name) return;
    const snap = await tg.snapshot(m.name, tg.refs.task(t.id, m.name), `agentduo team ${this.id}: ${t.id} by ${m.name}`);
    t.code = snap.commit;
    t.codeSummary = out.summary;
    t.notes = out.notes;
    if (out.status === "blocked") {
      t.status = "blocked";
      t.question = { id: `${t.id}-q${nextSeq(this.state)}`, from: m.name, text: out.question!, escalated: false, answer: null };
      this.log(t, `${m.name} asks: ${out.question}`);
    } else {
      t.status = "review";
      t.reviewer = null;
      t.question = null;
      this.log(t, `${m.name}: ${out.summary}`);
    }
    this.emitTask(t);
    this.save();
  }

  private async testsTurn(name: string, id: string): Promise<void> {
    const t = this.task(id);
    const m = this.member(name);
    const tests = t.tests[m.name];
    if (!tests || tests.status === "written") return;
    const tg = await this.teamGit();
    const cwd = await tg.checkout(m.name, tests.commit ?? t.base ?? await tg.integrationHead());
    const failures = t.checks.length ? t.checks : [];
    const out = await this.call<TestsOutput>(m, "tests", "team_tests", (session) => testsPrompt({
      ...this.parts(m), ...session, task: t, brief: this.brief(), cwd, failures,
    }), { task: t.id, cwd });
    const snap = await tg.snapshot(m.name, tg.refs.task(t.id, m.name), `agentduo team ${this.id}: ${t.id} tests by ${m.name}`);
    tests.commit = snap.commit;
    tests.status = "written";
    tests.summary = out.summary;
    tests.howToRun = out.how_to_run;
    this.log(t, `${m.name} wrote tests: ${out.summary}`);
    this.save();
  }

  private async reviewTurn(name: string, id: string): Promise<void> {
    const t = this.task(id);
    const m = this.member(name);
    if (t.status !== "review" || !t.code) return;
    t.reviewer = m.name;
    const tg = await this.teamGit();
    const cwd = await tg.checkout(m.name, t.code);
    const max = this.o.cfg.limits.max_diff_chars;
    const diff = (await this.git!.diff(t.base!, t.code)).slice(0, max);
    // A worker reviews in a session of its own for the task, never in the one where it may have built it before (a
    // reassigned task): its own reasoning would be in the review, and the whole implementation in its context. The
    // techlead never builds a task; its review stays with its triage and answers of it.
    const purpose: SessionPurpose | undefined = m.kind === "lead" ? undefined : "review";
    const change = await this.reviewChange(m, t, purpose);
    const blocking = this.o.cfg.quality_gates.blocking_severities;
    const criteria = new Set(this.brief().criteria.map((c) => c.id));
    const out = await this.call<ReviewOutput>(m, "review", "team_review", (session) => reviewPrompt({
      ...this.parts(m), ...session, task: t, brief: this.brief(), diff, blocking, change,
    }), {
      task: t.id, cwd, purpose, check: (d) => d.findings.flatMap((f) => f.criteria.filter((c) => !criteria.has(c)).map((c) => `finding '${f.id}' cites '${c}', which is not an acceptance criterion (${[...criteria].join(", ")})`)),
    });
    if (t.status !== "review") return;
    const blockers = out.findings.filter((f) => blocks(f, blocking));
    if (out.verdict === "changes" && blockers.length) {
      t.review = { reviewer: m.name, verdict: "changes", summary: out.summary, findings: out.findings };
      t.reviewRound += 1;
      this.log(t, `${m.name} asks for changes: ${blockers.map((f) => f.title).join("; ")}`);
      this.note({
        kind: "disagreement", source: { kind: "review", task: t.id, occurrence: `a${t.attempt}r${t.reviewRound}` }, reportedBy: m.name,
        summary: `${m.name} asked for changes to ${t.id} (${t.title}) by ${t.assignee}: ${blockers.map((f) => f.title).join("; ")}`,
      });
      if (t.reviewRound >= this.o.cfg.team.limits.max_review_rounds) {
        t.status = "triage";
        t.trouble = `the review still asks for changes after ${t.reviewRound} round(s): ${blockers.map((f) => f.title).join("; ")}`;
      } else t.status = "coding";
    } else {
      t.review = { reviewer: m.name, verdict: "approve", summary: out.summary, findings: out.findings };
      t.status = "testing";
      t.candidate = null;
      t.checks = [];
      this.log(t, `${m.name} approves${out.findings.length ? ` (${out.findings.length} suggestion(s))` : ""}`);
    }
    this.emitTask(t);
    this.save();
  }

  /**
   * The change a review is about, for a reviewer's session that goes on: the diff since the commit it reviewed last (its
   * view's `change`), with the whole change's stat. No earlier review in the session, or a commit git cannot diff any more:
   * no `previous`, and the session is given the whole diff.
   */
  private async reviewChange(m: Member, t: TaskState, purpose: SessionPurpose | undefined): Promise<ReviewChange> {
    const max = this.o.cfg.limits.max_diff_chars;
    const reviewed = this.state.sessions[sessionKey(m, t.id, purpose ?? null)]?.seen?.change;
    const stat = await this.git!.diffStat(t.base!, t.code!).catch(() => "");
    let previous: ReviewChange["previous"] = null;
    if (reviewed && reviewed !== t.code) {
      const since = await this.git!.diff(reviewed, t.code!).catch(() => null);
      if (since !== null) previous = { from: reviewed, diff: since.slice(0, max) };
    }
    return { head: t.code!, base: t.base!, stat, previous };
  }

  private async checkTurn(name: string, id: string): Promise<void> {
    const t = this.task(id);
    const m = this.member(name);
    if (t.status !== "testing" || !t.candidate) return;
    const candidate = t.candidate;
    const tg = await this.teamGit();
    const cwd = await tg.checkout(m.name, candidate);
    const out = await this.call<CheckOutput>(m, "check", "team_check", (session) => checkPrompt({ ...this.parts(m), ...session, task: t, brief: this.brief(), cwd }), {
      task: t.id, cwd, check: (d) => (d.verdict === "fail" && !d.failures.length ? ["a failing check lists its failures"] : []),
    });
    if (t.candidate !== candidate) return;
    const snap = await tg.snapshot(m.name, tg.refs.task(t.id, `${m.name}-check`), `agentduo team ${this.id}: ${t.id} checked by ${m.name}`);
    const candidateTree = (await this.git!.run(["rev-parse", `${candidate}^{tree}`])).stdout.trim();
    t.checks = t.checks.filter((c) => c.by !== m.name);
    t.checks.push({ by: m.name, verdict: out.verdict, summary: out.summary, failures: out.failures, commit: snap.tree !== candidateTree ? snap.commit : null });
    this.log(t, `${m.name}: ${out.verdict} (${out.summary})`);
    this.save();
  }

  private async integrationCheckTurn(name: string): Promise<void> {
    const s = this.state;
    const ig = s.integration;
    if (!ig) return;
    const m = this.member(name);
    const commit = ig.commit;
    const tg = await this.teamGit();
    const cwd = await tg.checkout(m.name, commit);
    const out = await this.call<CheckOutput>(m, "integration-check", "team_check", (session) => integrationCheckPrompt({ ...this.parts(m), ...session, brief: this.brief(), cwd }), {
      task: null, cwd, work: integrationWork(), check: (d) => (d.verdict === "fail" && !d.failures.length ? ["a failing check lists its failures"] : []),
    });
    if (s.integration?.commit !== commit) return;
    s.integration.checks = s.integration.checks.filter((c) => c.by !== m.name);
    s.integration.checks.push({ by: m.name, verdict: out.verdict, summary: out.summary, failures: out.failures });
    this.save();
  }

  /** The configured gates on a task's candidate (or the integration head), as one more check. */
  private async gatesRun(id: string | null): Promise<void> {
    const s = this.state;
    const t = id ? this.task(id) : null;
    const commit = t ? t.candidate : s.integration?.commit;
    if (!commit) return;
    const tg = await this.teamGit();
    const cwd = await tg.checkout(GATES, commit);
    const results = await runGates({
      gates: this.o.cfg.gates, repo: cwd, logDir: join(this.o.store.dir, "logs"), label: `${String(nextSeq(s)).padStart(3, "0")}-${id ?? "integration"}`,
      defaultTimeoutSec: this.o.cfg.limits.gate_timeout_sec, maxOutputChars: this.o.cfg.limits.max_gate_output_chars, bus: this.o.bus, signal: this.abort.signal,
    }).catch((e) => {
      if (this.abort.signal.aborted) throw new Interrupted();
      throw e;
    });
    const passed = requiredPassed(results);
    const check: TaskCheck = {
      by: "gates", verdict: passed ? "pass" : "fail", summary: describeGates(results, false),
      failures: results.filter((r) => !r.passed && r.required).map((r) => ({
        id: `G-${r.name}`, title: `gate '${r.name}' fails`, detail: r.outputTail, reproduction: r.command, expected: "exit code 0",
        actual: r.timedOut ? "timed out" : `exit code ${r.exitCode}`, criteria: [], suspect: "code" as const,
      })),
    };
    if (t) {
      if (t.candidate !== commit) return;
      t.checks = t.checks.filter((c) => c.by !== "gates");
      t.checks.push(check);
      this.log(t, `gates: ${check.verdict}`);
    } else if (s.integration?.commit === commit) {
      s.integration.checks = s.integration.checks.filter((c) => c.by !== "gates");
      s.integration.checks.push(check);
    }
    this.save();
  }

  private async mergeTask(id: string): Promise<void> {
    const t = this.task(id);
    if (t.status !== "merging" || !t.candidate || heldTaskIds(this.state).has(t.id)) return;
    const tg = await this.teamGit();
    const extras = t.checks.map((c) => c.commit).filter((c): c is string => !!c);
    const whole = await tg.merge([t.candidate, ...extras], `agentduo team ${this.id}: ${t.id} with the tests added while checking`);
    const commit = "commit" in whole ? whole.commit : t.candidate;
    const merged = await tg.mergeIntoIntegration(commit, `agentduo team ${this.id}: merge ${t.id} ${t.title}`);
    if ("conflicts" in merged) {
      t.candidate = commit;
      t.conflicts = merged.conflicts;
      t.status = "resolving";
      this.log(t, `merging conflicts in ${merged.conflicts.join(", ")}`);
    } else {
      t.status = "merged";
      this.log(t, "merged into the integration branch");
      this.report("agentduo", `${t.id} (${t.title}) is done and merged`);
    }
    this.emitTask(t);
    this.save();
  }
}

/** The user's answers to the PM's questions, as a message of the conversation. */
function answersText(questions: ClarificationQuestion[], answers: ClarificationAnswer[]): string {
  return ["My answers to your questions:", ...questions.map((q) => {
    const a = answers.find((x) => x.questionId === q.id);
    return `- ${q.question} → ${a ? answerText(q, a) : "(no answer)"}`;
  })].join("\n");
}

const TASK_WORDS: Record<TaskState["status"], string> = {
  pending: "waiting", coding: "coding", blocked: "asked a question", review: "in review", testing: "being tested", triage: "with the techlead",
  merging: "merging", resolving: "resolving a conflict", escalated: "waiting for the PM", merged: "merged", cancelled: "cancelled",
};

/** A team run as /team status shows it: its phase, each task and where it stands, its usage. */
export function teamStatusText(state: TeamState): string {
  const u = state.usage;
  const cost = u.costUsd ? `$${u.costUsd.toFixed(2)}` : "";
  const waiting = state.waiting
    ? ` (waiting for your ${state.waiting.kind === "apply_conflict" ? "decision on conflicts" : `approval of the ${state.waiting.kind}`})` : "";
  const exceptions = (state.governance?.exceptions ?? []).filter((e) => e.decision?.status === "pending").length;
  const lines = [`Team ${state.id} — ${state.phase}${waiting}${exceptions ? ` (${exceptions} exception request(s) wait for your decision)` : ""} · ${u.calls} call(s)${cost ? ` · ${cost}` : ""}${u.tokens ? ` · ${Math.round(u.tokens / 1000)}k tok` : ""}`];
  for (const t of state.tasks) lines.push(`  ${t.id} ${t.title} — ${t.assignee}, ${TASK_WORDS[t.status]}${t.attempt > 1 ? ` (attempt ${t.attempt})` : ""}`);
  if (!state.tasks.length) lines.push(state.phase === "INTAKE" ? "  The PM is working out what you need." : "  No task yet.");
  return lines.join("\n");
}

/** The team as /team members shows it. */
export function teamRosterText(members: Member[]): string {
  return ["The team:", ...members.map((m) => `  ${m.name} — ${m.role} (${m.level}${m.canReview && m.kind === "worker" ? ", reviews" : ""}), ` +
    `${m.backend === "codex" ? "Codex" : "Claude"}${m.model ? ` ${m.model}` : ""}${m.effort ? ` · ${m.effort}` : ""}`)].join("\n");
}

/** The latest team run of `runsDir` that is not over (stopped, or waiting for you), or null. */
export function resumableTeam(runsDir: string): TeamState | null {
  const latest = TeamStore.list(runsDir).at(-1);
  return latest && latest.phase !== "DONE" && latest.phase !== "ABORTED" ? latest : null;
}

/** The latest team run conversation `conversationId` started that is not over, or null. */
export function conversationTeam(runsDir: string, conversationId: string): TeamState | null {
  return TeamStore.list(runsDir).filter((s) => s.conversationId === conversationId && s.phase !== "DONE" && s.phase !== "ABORTED").at(-1) ?? null;
}

/**
 * Takes the result of team run `id` back out of the workspace (the folder as it was before it went in). Refused when
 * the folder changed since, so nothing of yours is lost.
 */
export async function undoTeam(o: { runsDir: string; workspace: string; id: string; env?: NodeJS.ProcessEnv }): Promise<{ restored: string[] } | { problem: string }> {
  const env = o.env ?? process.env;
  const store = TeamStore.open(o.runsDir, o.id);
  const state = store.load();
  if (!state.applied) return { problem: `team run ${state.id} has no result in the folder to take back out` };
  const owner = { taskId: state.id, git: state.git, base: state.base ? { ...state.base, head: null, branch: null } : null, lastSnapshot: null };
  const { git } = await prepareRunGit(owner, o.workspace, env);
  const runsRel = relativeInside(o.runsDir, o.workspace);
  const tg = new TeamGit({
    git, workspace: o.workspace, runId: state.id, root: join(dataRoot(env) ?? o.workspace, "teams", state.id), exclude: runsRel ? [runsRel] : [], setup: [], link: [],
  });
  const undone = await tg.undo(`agentduo team ${state.id}: undone`);
  if ("restored" in undone) {
    state.applied = null;
    state.summary = `The result was taken back out of the folder (${undone.restored.length} file(s)).`;
    store.save(state);
  }
  return undone;
}

