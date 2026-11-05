import { createHash, randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";
import { AgentRunner, type AgentResult, type CallBudget } from "../agents/runner.js";
import type { SchemaName } from "../agents/schema.js";
import type { PermissionDenial } from "../agents/types.js";
import type { Attachment } from "./attachment-types.js";
import { attachmentFile } from "./attachments.js";
import type { ClarificationDecider, Decider, DuoEvent, EventBus, HistoryEntry, HumanReview, Message, Party, PermissionDecider, Phase, Role } from "../events.js";
import { budgetView, costLeft, ensureBudget, exhaustedMessage, newWarnings, raiseReached, reachedLimits, usageOf } from "./budget.js";
import type { AgentRole, Backend, ConfigData } from "./config.js";
import {
  answeredEntries, answerSummary, MAX_PLANNER_ASKS, ledgerAnswer, ledgerClose, ledgerOpen, parseAnswersFile, parseQuestions, pendingEntry,
  type ClarificationAnswer, type ClarificationEntry, type ClarificationRequest,
} from "./clarification.js";
import { acceptRepoNotes, addRepoNotes, planTurn, rememberSession, sessionSlot, type Turn } from "./context.js";
import { GatesInterrupted, runGates, type GateResult } from "./gates.js";
import type { Change, Git } from "./git.js";
import { taggedPaths } from "./mentions.js";
import type { Approval, Critique, Finding, Implementation, Issue, Plan, PlannerOutput, PlannerQuestion, RepoNoteOutput, Review } from "./outputs.js";
import * as prompts from "./prompts.js";
import * as render from "./render.js";
import {
  acceptedIds, acceptedText, acceptPending, attributionErrors, baselineFailures, conflictReview, gateVerdicts, gatesToAttribute, missingBaselineEntries,
  outOfScopeGates, preexistingFailures, preexistingReview, requirementConflicts, splitFindings,
} from "./acceptance.js";
import { lateFindingErrors, ledgerOf, recordResponses, reviewFindings, setFindings, trackReview, unanswered, type ReviewFindings } from "./findings.js";
import {
  addedCriteria, adoptedSuggestions, criteriaErrors, criterionIds, expansionReview, issueRefusalErrors, keptIds, outOfScopeBlockers, reviewScopeErrors,
  scopeReview, taskIssues,
} from "./scope.js";
import {
  answersDigest, blockedReview, changedParts, cycleProgress, findingsDigest, heldReview, implementerSettings, nextBlocker, nextStall, planAnswer, planProgress,
  planStallReview, stallHeldReview, stallReview, trackCritique,
} from "./progress.js";
import {
  escalate, LIGHTWEIGHT, newProfile, planTooLarge, profileOf, profileText, reviewsOnGateFailure, signsOff, unplannedFiles, type EscalationSignal,
} from "./profiles.js";
import { internalNotice, openRunGit, prepareRunGit } from "./run-git.js";
import { leavesBase } from "../paths.js";
import {
  nowIso, type FindingResponse, type FindingsSource, type GateSpec, type PlanCycle, type ProgressMark, type ReviewApproval, type ReviewCycle, type RunState,
  type RunStore,
} from "./state.js";
import { configDigest, doneText, FINAL_REFRESHES, finalProblems, finalVerification, gateSpecs, gatesStale, nextFinalCheck, staleReview } from "./verification.js";

export const EXIT = { DONE: 0, ERROR: 1, HUMAN_REVIEW: 2, ABORTED: 3, INTERRUPTED: 130 } as const;

// "--decision resume" after an escalation raised in these phases starts a new implementation round;
// from anywhere else it re-runs the same round.
const NEW_ROUND_FROM: Phase[] = ["VERIFY", "CODE_REVIEW"];
const IMPL_PHASES: Phase[] = ["IMPLEMENT", "VERIFY", "CODE_REVIEW"];
const PHASE_ROLES: Partial<Record<Phase, { role: Role; agentRole: AgentRole }>> = {
  PLAN: { role: "planner", agentRole: "planner" },
  PLAN_REVIEW: { role: "plan_reviewer", agentRole: "plan_reviewer" },
  PLAN_FINALIZE: { role: "plan_finalizer", agentRole: "planner" },
  IMPLEMENT: { role: "implementer", agentRole: "implementer" },
  CODE_REVIEW: { role: "code_reviewer", agentRole: "code_reviewer" },
};
const ROLE_NAMES: Record<Role, string> = {
  planner: "planner", plan_reviewer: "plan critic", plan_finalizer: "plan sign-off", implementer: "implementer", code_reviewer: "code reviewer",
};
const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const MAX_WARNINGS = 50;
/** The review cycles and the rejected answers a run keeps, for the report. */
const MAX_CYCLES = 50;
const MAX_REJECTED = 30;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Names what was denied and where to allow it; edits and other tools are allowed in different ways. */
export function denialHint(backend: Backend, denials: PermissionDenial[]): string {
  const counts = new Map<string, number>();
  for (const d of denials) counts.set(d.tool_name || "unknown tool", (counts.get(d.tool_name || "unknown tool") ?? 0) + 1);
  const tools = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(", ");
  const head = `${backend === "claude" ? "Claude" : "Codex"} was denied ${denials.length} tool call(s) (${tools})`;
  const reload = "a resumed run picks up config changes only with --reload-config";
  if (backend !== "claude") return `${head}; allow them in your Codex configuration or via codex.role_args.implementer (${reload})`;
  const names = [...counts.keys()];
  const others = names.filter((n) => !EDIT_TOOLS.has(n));
  const ways: string[] = [];
  if (names.some((n) => EDIT_TOOLS.has(n))) ways.push('permissions.defaultMode "acceptEdits" for edits');
  if (others.length) ways.push(`permissions.allow rules for ${others.join(", ")}${others.includes("Bash") ? ' (e.g. "Bash(npm test:*)")' : ""}`);
  return `${head}; allow them in your Claude Code settings (${ways.join("; ")}) or via claude.role_args.implementer (${reload})`;
}

/** One agent call of the pipeline, as callAgent makes it. */
interface AgentTurn<T> {
  role: Role;
  agentRole: AgentRole;
  label: string;
  schemaName: SchemaName;
  round: number;
  check?: (data: T) => string[];
  /** The prompt for a context: the fresh one, and the continued one when the role's session goes on. */
  build: (ctx: prompts.PromptContext) => string | Promise<string>;
  /**
   * about: the plan the turn is about, which a continued session may already have (null: it gets it whole, or writes
   * one); after: the plan its session has once the turn is done; file: where `about` is, to point a session at.
   */
  plan: { about: string | null; after: (data: T) => string | null; file?: string };
  /** Where the answer's `repo_notes` are, when the answer wraps its content (the planner's `result`); absent: the answer itself. */
  notesIn?: (data: T) => unknown;
  /** Code reviewer: the revision it reviews, which its next turn's diff starts from. */
  reviewed?: string;
  /**
   * The role's own answers, by key (answerKey), for a session the plan critic and the implementer share: previous, the
   * one its prompt refers to (null: none); of, this turn's. A session that does not hold `previous` is given it again.
   */
  answer?: { previous: string | null; of: (data: T) => string };
}

/** A short key of an answer, to tell whether a shared session holds it. */
const answerKey = (value: unknown) => createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);

class Interrupted extends Error {}

/** implementation.r<k>.json, as far as a re-run of the round reads it back. */
interface ImplementationRecord {
  snapshot: string;
  output: Implementation | null;
  attempt_changes?: Array<{ status: string; path: string }>;
  changes: Array<{ status: string; path: string }>;
  earlier_attempts?: unknown[];
}

/** An earlier attempt of a round, as the round's record keeps it once a later attempt replaces it. */
function attemptOf(r: ImplementationRecord): Record<string, unknown> {
  return {
    snapshot: r.snapshot, status: r.output?.status ?? null, summary: r.output?.summary ?? null, blocking_reason: r.output?.blocking_reason ?? null,
    addressed_findings: r.output?.addressed_findings ?? [], changes: r.attempt_changes ?? r.changes,
  };
}

export class DecisionError extends Error {
  override name = "DecisionError";
}

export interface WorkflowOptions {
  cfg: ConfigData;
  /** The workspace directory: agents run here and snapshots/diffs are limited to it. */
  repo: string;
  store: RunStore;
  state: RunState;
  bus: EventBus;
  decider: Decider;
  /** Answers Claude's permission prompts; absent when nobody can (CI, background), so the CLI denies them. */
  permissions?: PermissionDecider;
  /** Answers the agents' structured questions; absent when nobody can (CI, background): a planner's question then waits, saved, for `--answers`. */
  clarifier?: ClarificationDecider;
  runner?: AgentRunner;
  /** Where agentduo's data root is read from (and HOME): default, this process's environment. */
  env?: NodeJS.ProcessEnv;
}

function relativeInside(path: string, root: string): string | null {
  const rel = relative(resolve(root), resolve(path));
  return rel && !leavesBase(rel) ? rel.split("\\").join("/") : null;
}

/**
 * The workspace's tree as the run's snapshots take it (its runs folder left out), for `duo status` to compare with the
 * tree the run's evidence is about. Throws when the run's snapshots cannot be opened.
 */
export async function workspaceTree(state: RunState, repo: string, runsDir: string, env: NodeJS.ProcessEnv): Promise<string> {
  const runsRel = relativeInside(runsDir, repo);
  return openRunGit(state, repo, env).worktreeTree(runsRel ? [runsRel] : []);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The planner's questions as the shared question model takes them (src/core/clarification.ts parseQuestions). */
const askedQuestions = (list: PlannerQuestion[]) =>
  list.map((q) => ({ header: q.header, question: q.question, multiSelect: q.multi_select, options: q.options }));

const planHash = (plan: Plan) => createHash("sha256").update(stableStringify(plan)).digest("hex");

function consistentStatus(d: { approved: boolean; status: string }): string[] {
  return d.approved !== (d.status === "approved") ? [`'approved' (${d.approved}) contradicts 'status' ('${d.status}')`] : [];
}

const bySeverity = <T extends { severity: string }>(xs: T[]) =>
  [...xs].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
const issueItems = (issues: Issue[]) =>
  bySeverity(issues).map((i) => `[${i.severity}] ${i.id} ${i.description}${i.scope === "out_of_scope" ? " (outside the task's scope)" : ""}`);
const findingItems = (findings: Finding[]) => bySeverity(findings).map((f) =>
  `[${f.severity}] ${f.id} ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} ` : ""}${f.issue}${f.origin === "out_of_scope" ? " (outside the task's scope)" : ""}`);
const listChanges = (changes: Change[], max = 10) =>
  changes.slice(0, max).map(([s, p]) => `${s} ${p}`).join(", ") + (changes.length > max ? `, … (${changes.length - max} more)` : "");

function lastLine(text: string): string {
  const line = text.trim().split("\n").filter((l) => l.trim()).at(-1) ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

export class Workflow {
  /** Where the run's snapshots are, once prepare() found or set it up. */
  private snapshots: Git | null = null;
  private readonly runner: AgentRunner;
  private readonly snapshotExclude: string[];
  private readonly abort = new AbortController();
  private stopRequested = false;
  private phaseStartedAt = Date.now();
  /** Seconds of the step under way spent waiting for the user (permission prompts, questions): not work, so not the budget's minutes. */
  private waitedInStep = 0;
  private inSubdir: boolean | null = null;

  constructor(private readonly o: WorkflowOptions) {
    this.runner = o.runner ?? new AgentRunner(o.cfg, o.repo, o.store.path("logs"), o.bus, { permissions: o.permissions, clarifications: o.clarifier, runsDir: o.store.runsDir });
    const runsRel = relativeInside(o.store.runsDir, o.repo);
    this.snapshotExclude = runsRel ? [runsRel] : [];
  }

  get state(): RunState {
    return this.o.state;
  }

  private get git(): Git {
    if (!this.snapshots) throw new Error("the run's snapshots are not prepared");
    return this.snapshots;
  }

  /** The run keeps its snapshots in agentduo's own repository: its Codex calls start outside any git repository. */
  private get internal(): boolean {
    return this.state.git?.mode === "internal";
  }

  /**
   * Finds where the run keeps its snapshots, setting it up on the first call (an internal repository for a folder with
   * no git repository), and records that before any agent runs. Called before every agent step and before a decision
   * other than abort; idempotent. Throws RunGitError and changes nothing then: the run waits, resumable, for the cause
   * to be fixed.
   */
  async prepare(): Promise<void> {
    if (this.snapshots) return;
    const st = this.state;
    const { git, meta } = await prepareRunGit(st, this.o.repo, this.o.env ?? process.env);
    this.snapshots = git;
    if (!st.git) {
      st.git = meta;
      this.save();
    }
    if (meta.mode === "internal") this.emit({ type: "warning", text: internalNotice(meta) });
  }

  /** Stop cleanly after the step that is running now; the run stays resumable. */
  requestStop(): void {
    this.stopRequested = true;
  }

  /** Kill the running agent or gate now; that step re-runs on resume. */
  interrupt(): void {
    this.abort.abort();
  }

  /**
   * A note from the user while the run goes on: the prompts of every later step carry it (a running agent does not see
   * it), with its files, which must already be copies of this run (RunStore attachments).
   */
  addNote(note: string, attachments: Attachment[] = []): void {
    const st = this.state;
    st.humanNotes.push({ at: nowIso(), phase: st.phase, note, ...(attachments.length ? { attachments } : {}) });
    this.save();
  }

  // ------------------------------------------------------------------ loop
  async run(): Promise<number> {
    const st = this.state;
    const configured = this.o.cfg.pipeline?.profile ?? "standard";
    if (!st.profile) {
      // A new run takes the config's profile; an older run, which had none, goes on as it always did (standard).
      st.profile = newProfile(st.step === 0 ? configured : "standard");
      this.save();
    }
    this.emit({ type: "run.started", runId: st.taskId, task: st.task, repo: this.o.repo, runDir: this.o.store.dir, profile: st.profile.name });
    if (configured !== st.profile.initial) {
      // Never changed on resume: the run keeps the review policy it started with (escalations aside).
      this.emit({ type: "warning", text: `this run keeps its pipeline profile, ${profileText(st.profile)}; pipeline.profile '${configured}' applies to new runs` });
    }
    // A question of Claude that an earlier process left open: asked again before anything runs (see holdLeftQuestion).
    this.holdLeftQuestion();
    if (st.inProgress) this.warn(`previous run was interrupted during ${st.inProgress.phase}; re-running it`);
    const budget = ensureBudget(st, this.o.cfg);
    if (budget?.limits.cost != null && Object.values(this.o.cfg.agents).includes("codex")) {
      // Said every time the run starts, never stored: a fact about the setup, not about this run's work.
      this.emit({ type: "warning", text: "limits.max_run_cost_usd counts the cost the CLIs report: Codex reports none, so the cost of its calls " +
        "is not in it (limits.max_run_tokens and max_run_agent_calls bound them)" });
    }
    // The questions agents ask in a call are saved the moment they are asked and answered, before the call reports back.
    const off = this.o.bus.on((e) => this.recordClarification(e));
    try {
      return await this.loop();
    } finally {
      off();
    }
  }

  private async loop(): Promise<number> {
    const st = this.state;
    for (;;) {
      const phase = st.phase;
      if (phase === "DONE") return this.finish("DONE", EXIT.DONE);
      if (phase === "ABORTED") return this.finish("ABORTED", EXIT.ABORTED);
      if (phase === "HUMAN_REVIEW") {
        st.inProgress = null;
        this.save();
        await this.writeReport();
        const review = st.humanReview!;
        if (review.reason === "clarification_required") {
          // The planner's questions: answered through the clarification decider, never through a generic decision.
          const ended = await this.askPending();
          if (ended !== null) return ended;
          continue;
        }
        this.emit({ type: "human.required", runId: st.taskId, review });
        const answer = await this.o.decider.decide(review);
        if (answer === "defer") return this.finish("HUMAN_REVIEW", EXIT.HUMAN_REVIEW);
        await this.applyDecision(answer.decision, answer.note);
        continue;
      }
      if (this.stopRequested) return this.finish("INTERRUPTED", EXIT.INTERRUPTED);
      // No step starts once the run's budget is reached: it waits, with everything it did kept, for your decision.
      this.startClock();
      if (this.budgetExhausted(phase)) {
        this.save();
        continue;
      }
      // Outside the step's error handling: a run whose snapshots cannot be set up stays where it is, with no escalation.
      await this.prepare();
      st.inProgress = { phase, startedAt: nowIso() };
      this.save();
      this.startClock();
      this.emitPhaseStarted(phase);
      let interrupted = false;
      try {
        await this.handler(phase)();
      } catch (err) {
        if (err instanceof Interrupted || this.abort.signal.aborted) {
          interrupted = true;
        } else {
          const e = err as Error;
          this.o.store.writeText(`logs/error-step${String(st.step + 1).padStart(3, "0")}.txt`, e.stack ?? String(e));
          this.escalate("orchestrator_error", `${e.name}: ${e.message}`, phase);
        }
      }
      // Work time, the budget's minutes: the step's, interrupted or not (before finish saves); never a wait for a decision.
      st.activeSec = (st.activeSec ?? 0) + this.workedSec();
      for (const text of newWarnings(st)) this.warn(text);
      // A question of Claude nobody answered: owed when the step was stopped on it, else its call is simply gone.
      const owed = this.settleQuestions(interrupted);
      if (interrupted && owed) {
        // Answer later, a closed app, or Esc on the question: the run waits for the answer instead of re-running the step without it.
        this.holdQuestion(owed, phase);
        this.save();
        return this.finish(this.abort.signal.aborted ? "INTERRUPTED" : "HUMAN_REVIEW", this.abort.signal.aborted ? EXIT.INTERRUPTED : EXIT.HUMAN_REVIEW);
      }
      if (interrupted) return this.finish("INTERRUPTED", EXIT.INTERRUPTED);
      st.inProgress = null;
      this.save();
    }
  }

  private handler(phase: Phase): () => Promise<void> {
    switch (phase) {
      case "PLAN": return () => this.stepPlan();
      case "PLAN_REVIEW": return () => this.stepPlanReview();
      case "PLAN_FINALIZE": return () => this.stepPlanFinalize();
      case "IMPLEMENT": return () => this.stepImplement();
      case "VERIFY": return () => this.stepVerify();
      case "CODE_REVIEW": return () => this.stepCodeReview();
      default: throw new Error(`no handler for phase ${phase}`);
    }
  }

  private async finish(phase: "DONE" | "ABORTED" | "HUMAN_REVIEW" | "INTERRUPTED", exitCode: number): Promise<number> {
    if (phase !== "INTERRUPTED") this.state.inProgress = null;
    this.save();
    const reportPath = await this.writeReport();
    this.emit({ type: "run.finished", runId: this.state.taskId, phase, reportPath, exitCode, ...(phase === "DONE" ? { summary: this.doneSummary() } : {}) });
    return exitCode;
  }

  /**
   * What DONE rests on, from the final check's record (src/core/verification.ts): with no gates, with failures you
   * accepted, or with approval not required, "quality gates passed and the review approved" would overclaim.
   */
  private doneSummary(): string {
    const st = this.state;
    if (st.verification) return doneText(st.verification, acceptedText(st.accepted));
    // A run that ended DONE before agentduo checked its final code: said as it was then.
    const { cfg, store } = this.o;
    const approved = store.exists("review.json") && store.readJson<{ output: Review }>("review.json").output.approved;
    const review = approved ? "the review approved" : "the review did not approve (require_codex_approval is off)";
    if (!cfg.gates.length) return `${review}; no quality gates configured`;
    const earlier = st.gatesTree != null && st.lastSnapshot != null && st.gatesTree !== st.lastSnapshot.tree ? " on an earlier revision" : "";
    const failing = (st.lastGates ?? []).filter((g) => g.required && !g.passed);
    const accepted = acceptedIds(st.accepted, "gate");
    const gates = failing.some((g) => !accepted.has(g.name)) ? `required gates failing${earlier} (require_tests_pass is off)`
      : failing.length ? `quality gates passed${earlier}, except ${failing.map((g) => `'${g.name}'`).join(", ")}, failing as before the task`
        : `quality gates passed${earlier}`;
    // Never a DONE that hides what you accepted.
    const yours = acceptedText(st.accepted);
    return `${gates} and ${review}${yours ? `; ${yours}` : ""}`;
  }

  // --------------------------------------------------------------- helpers
  private emit(event: DuoEvent): void {
    this.o.bus.emit(event);
  }

  /** Shown on screen and kept for the report; warnings never stop the run. */
  private warn(text: string): void {
    const st = this.state;
    st.warnings ??= [];
    if (st.warnings.length < MAX_WARNINGS - 1) {
      st.warnings.push(text);
    } else {
      // The last slot counts what did not fit; every warning still reaches the screen.
      const counted = st.warnings.length === MAX_WARNINGS ? /^… (\d+) more/.exec(st.warnings[MAX_WARNINGS - 1]!) : null;
      const dropped = st.warnings.length === MAX_WARNINGS ? (counted ? Number(counted[1]) : 1) : 0;
      st.warnings[MAX_WARNINGS - 1] = `… ${dropped + 1} more warning(s) not stored`;
    }
    this.emit({ type: "warning", text });
  }

  private save(): void {
    this.o.store.saveState(this.state);
  }

  private ctx(): prompts.PromptContext {
    const st = this.state;
    return {
      repo: this.o.repo, taskId: st.taskId, task: st.task, agents: this.o.cfg.agents, gates: this.o.cfg.gates, notes: st.humanNotes, earlier: st.earlier,
      conversation: st.conversationContext, attachments: st.attachments, locate: (a) => attachmentFile(this.o.store.runsDir, a),
      tagged: (text) => taggedPaths(text, this.o.repo), internalSnapshots: this.internal, baseline: st.baseline?.results ?? null, profile: st.profile,
      clarifications: answeredEntries(st.clarifications), mayAsk: this.mayAsk(),
      canAskNow: !!this.o.clarifier && this.o.cfg.clarification?.enabled !== false,
    };
  }

  /**
   * The files every agent call of the run gets: the task's, then the notes' so far. Each call is a CLI run of its own,
   * so each sends the images again (within the backend's budget for one call).
   */
  private files(): Attachment[] {
    const st = this.state;
    const all = [...(st.attachments ?? []), ...st.humanNotes.flatMap((n) => n.attachments ?? [])];
    return all.filter((a, i) => all.findIndex((b) => b.id === a.id) === i);
  }

  private party(role: AgentRole): Party {
    return this.o.cfg.agents[role];
  }

  private agentName(role: AgentRole): string {
    return this.o.cfg.agents[role] === "codex" ? "Codex" : "Claude";
  }

  private logPrefix(label: string, round: number): string {
    return `${String(this.state.step + 1).padStart(3, "0")}-${label}-r${round}`;
  }

  private ref(name: string): string {
    return `refs/agentduo/${this.state.taskId}/${name}`;
  }

  private tree(): Promise<string> {
    return this.git.worktreeTree(this.snapshotExclude);
  }

  /** Whole-repository tree; only computed when the workspace is a subdirectory, to notice edits outside it. */
  private async outsideTree(): Promise<string | null> {
    if (this.inSubdir === null) this.inSubdir = (await this.git.prefix()) !== "";
    return this.inSubdir ? this.git.worktreeTree(this.snapshotExclude, ":/") : null;
  }

  private async warnOutside(before: string | null, phase: Phase): Promise<void> {
    if (!before) return;
    const after = await this.outsideTree();
    if (!after || after === before) return;
    const changes = await this.git.outsideChanges(before, after);
    if (changes.length) this.warn(`${changes.length} file(s) outside the workspace changed during ${phase}: ${listChanges(changes)}`);
  }

  private emitPhaseStarted(phase: Phase): void {
    const st = this.state;
    // The first plan's step starts with the gates before any change, a step of their own.
    const gates = phase === "VERIFY" || (phase === "PLAN" && this.baselinePending());
    const info = gates ? undefined : PHASE_ROLES[phase];
    this.emit({
      type: "phase.started", step: st.step + 1, phase,
      round: IMPL_PHASES.includes(phase) ? Math.max(st.implRound, 1) : st.planningRound,
      role: info?.role, agent: gates ? "gates" : info ? this.party(info.agentRole) : undefined,
      planning: { round: st.planningRound, limit: st.limits.planningRounds },
      impl: { round: st.implRound, limit: st.limits.reviewRounds },
      ...(budgetView(st) ? { budget: budgetView(st)! } : {}), profile: profileOf(st),
    });
  }

  private record(phase: Phase, round: number, agent: string, status: string, summary: string,
    kind: HistoryEntry["kind"] = "info", artifact: string | null = null, usage?: AgentResult): void {
    const st = this.state;
    st.step += 1;
    const entry: HistoryEntry = { step: st.step, phase, round, agent, status, summary, kind, at: nowIso(), artifact };
    st.history.push(entry);
    this.o.store.appendEvent({ type: "step", ...entry });
    this.emit({
      type: "step.completed", entry, durationSec: (Date.now() - this.phaseStartedAt) / 1000,
      costUsd: usage?.costUsd ?? undefined, tokens: usage?.tokens ?? undefined,
    });
  }

  private message(m: Message): void {
    this.emit({ type: "message", message: m });
  }

  /**
   * A deterministic signal that the task needs more than the run's profile gives (src/core/profiles.ts): a lightweight
   * run moves to standard, recorded in the timeline and the report, keeping everything it did; nothing is run again,
   * approved or waived for it. Other profiles stay as they are.
   */
  private escalateProfile(signal: EscalationSignal, reason: string, phase: Phase = this.state.phase): void {
    const st = this.state;
    if (!st.profile) return;
    const round = IMPL_PHASES.includes(phase) ? st.implRound : st.planningRound;
    const change = escalate(st.profile, { signal, reason, phase, round, at: nowIso() });
    if (change) this.record(phase, round, "orchestrator", "profile escalated", `${change.from} → ${change.to}: ${reason}`, "warn");
  }

  /**
   * The planning loop's circuit breaker (src/core/progress.ts), after a critique of `round` that sent `plan` back:
   * records the cycle and, when the critiques stopped making progress, stops for your decision. Returns whether it did.
   */
  private planningStalled(round: number, plan: Plan, tracked: { keys: Record<string, string>; resolved: string[] }, blocking: string[]): boolean {
    const resolved = tracked.resolved;
    const st = this.state;
    const prev = st.planCycles?.at(-2);
    const cycle = st.planCycles!.at(-1)!;
    const progress = planProgress(prev, blocking, resolved);
    cycle.progress = progress;
    const stuck = (prev?.blocking ?? []).filter((k) => blocking.includes(k));
    const { stall, stop } = nextStall(st.planStall, { round, progress, keys: stuck }, !!prev && prev.plan === cycle.plan);
    st.planStall = stall;
    if (!stop) return false;
    const ledger = st.planIssues ?? [];
    const items = stall!.keys.map((key) => {
      const e = ledger.find((x) => x.key === key);
      if (!e) return key;
      // The id this critique gave it, which may not be the one it was first raised with.
      const id = Object.entries(tracked.keys).find(([, k]) => k === key)?.[0] ?? e.ids.at(-1)!;
      return `${key}${id !== key ? ` (${id} in this critique)` : ""} [${e.severity}] ${e.issue} — raised in rounds ${e.seen.map((x) => x.round).join(", ")}; ` +
        `the plan answered: ${planAnswer(plan, e.ids)}`;
    });
    const { message, details } = planStallReview(stall!, items);
    this.escalate("planning_stalled", message, "IMPLEMENT", details);
    return true;
  }

  private escalate(reason: string, message: string, resumePhase: Phase, details: string[] = [], fromPhase: Phase = this.state.phase): void {
    const st = this.state;
    st.humanReview = { reason, message, fromPhase, resumePhase, details, at: nowIso() };
    st.phase = "HUMAN_REVIEW";
    this.record("HUMAN_REVIEW", IMPL_PHASES.includes(fromPhase) ? st.implRound : st.planningRound, "orchestrator", reason, message, "warn");
  }

  private async envelope(role: Role, round: number, r: AgentResult, extra: Record<string, unknown> = {}, output: unknown = r.data): Promise<Record<string, unknown>> {
    const st = this.state;
    return {
      task_id: st.taskId, role, agent: r.backend, round, timestamp: nowIso(), git_sha: await this.git.head(),
      plan_version: st.planVersion, attempts: r.attempts, duration_sec: Math.round(r.durationSec * 10) / 10,
      cost_usd: r.costUsd, tokens: r.tokens, meta: r.meta, resumed_session: r.resumed, ...extra, output,
    };
  }

  private addUsage(r: AgentResult, role: Role): void {
    const st = this.state;
    this.waitedInStep += r.waitedSec ?? 0;
    // By role too: what each profile spends where (the report's metrics).
    const by = st.usageByRole?.[role] ?? { calls: 0, tokens: 0, costUsd: 0, unpricedCalls: 0 };
    st.usageByRole = {
      ...st.usageByRole,
      [role]: { calls: by.calls + r.calls, tokens: by.tokens + (r.tokens ?? 0), costUsd: Math.round((by.costUsd + (r.costUsd ?? 0)) * 10000) / 10000, unpricedCalls: by.unpricedCalls + r.unpricedCalls },
    };
    if (r.costUsd) st.costUsd = Math.round((st.costUsd + r.costUsd) * 10000) / 10000;
    if (r.tokens) st.tokens += r.tokens;
    st.agentCalls = (st.agentCalls ?? 0) + r.calls;
    st.unpricedCalls = (st.unpricedCalls ?? 0) + r.unpricedCalls;
    for (const text of newWarnings(st)) this.warn(text);
  }

  /** Keeps what agentduo rejected of a call's answers, for the report (each retry was told why). */
  private noteRejections(role: Role, round: number, r: AgentResult): void {
    if (!r.rejections?.length) return;
    const st = this.state;
    const entry = { role, round, count: r.rejections.length, errors: r.rejections.at(-1)!.errors, outcome: r.ok ? "corrected" as const : "failed" as const };
    st.rejected = [...st.rejected ?? [], entry].slice(-MAX_REJECTED);
  }

  /** Minutes of the step under way, which the run's minutes do not include until it ends: work, not the time spent waiting for the user. */
  private stepMinutes(): number {
    return this.workedSec() / 60;
  }

  private startClock(): void {
    this.phaseStartedAt = Date.now();
    this.waitedInStep = 0;
  }

  /** Seconds the step under way has worked: its time less what it waited for the user. */
  private workedSec(): number {
    return Math.max(0, (Date.now() - this.phaseStartedAt) / 1000 - this.waitedInStep);
  }

  /**
   * What the implementer is given now, for the circuit breaker (src/core/progress.ts); `tree` and `notes` name what an
   * attempt that already ran was given instead.
   */
  private async progressMark(tree?: string, notes?: number): Promise<ProgressMark> {
    const st = this.state;
    return {
      tree: tree ?? await this.tree(), notes: notes ?? st.humanNotes.length, plan: st.finalPlanHash, findings: findingsDigest(st.openFindings),
      settings: implementerSettings(this.o.cfg, this.o.repo, this.o.env ?? process.env), answers: answersDigest(st.clarifications),
    };
  }

  /** The run's budget as an agent call consults it before each attempt; absent when the run has none. */
  private callBudget(): CallBudget | undefined {
    const st = this.state;
    if (!st.budget) return undefined;
    return {
      stop: (call) => {
        const used = usageOf(st, { tokens: call.tokens, cost: call.costUsd, calls: call.calls, minutes: Math.max(0, this.stepMinutes() - call.waitedSec / 60) });
        const reached = reachedLimits(st.budget, used);
        return reached.length ? exhaustedMessage(st, reached, used).message : null;
      },
      costCap: (callCost) => costLeft(st, callCost),
    };
  }

  /**
   * Waits for your decision when the budget is reached (before a step, with `phase` the step to run on resume; or
   * after a call that stopped on it or failed once it was reached). Returns whether it did.
   */
  private budgetExhausted(phase: Phase): boolean {
    const st = this.state;
    const used = usageOf(st);
    const reached = reachedLimits(st.budget, used);
    if (!reached.length) return false;
    const { message, details } = exhaustedMessage(st, reached, used);
    this.escalate("budget_exhausted", message, phase, details);
    return true;
  }

  private blocking<T extends { severity: string }>(issues: T[]): T[] {
    const severities = new Set(this.o.cfg.quality_gates.blocking_severities);
    return issues.filter((i) => severities.has(i.severity));
  }

  private lastCritique(beforeRound: number): Critique | null {
    for (let r = beforeRound - 1; r >= 1; r--) {
      const name = `critique.r${r}.json`;
      if (this.o.store.exists(name)) return this.o.store.readJson<{ output: Critique }>(name).output;
    }
    return null;
  }

  /**
   * One agent turn against the workspace as it is now (`tree`): the prompt for a fresh session, with the repository
   * notes the role may have, and, when the role's own session goes on, the prompt that gives it only what is new (and
   * the files of the notes it has not seen). The runner falls back to the fresh prompt if that session is gone.
   */
  private async callAgent<T>(o: AgentTurn<T>, tree: string): Promise<{ res: AgentResult; turn: Turn }> {
    const { agents } = this.o.cfg;
    const backend = agents[o.agentRole];
    const keep = this.runner.backends[backend].keepsSessions(o.agentRole);
    const turn = await planTurn({
      state: this.state, role: o.agentRole, backend, keep, slot: sessionSlot(o.agentRole, agents, keep), tree, planHash: o.plan.about,
      answer: o.answer?.previous ?? null, changes: (a, b) => this.git.nameStatus(a, b),
    });
    const ctx: prompts.PromptContext = { ...this.ctx(), planFile: o.plan.file };
    const prompt = await o.build({ ...ctx, repoNotes: turn.repoNotes });
    const c = turn.continuation;
    const resume = c
      ? {
        id: c.session.id, attachments: c.attachments,
        prompt: await o.build({
          ...ctx, notes: c.notes, repoNotes: c.repoNotes, clarifications: c.clarifications,
          continued: { changed: c.changed, knowsPlan: c.knowsPlan, knowsAnswer: c.knowsAnswer, ...(c.from ? { from: c.from } : {}) },
        }),
      }
      : undefined;
    const res = await this.runner.call({
      role: o.role, agentRole: o.agentRole, prompt, schemaName: o.schemaName, logPrefix: this.logPrefix(o.label, o.round), check: o.check,
      signal: this.abort.signal, attachments: this.files(), skipGitRepoCheck: this.internal, session: { keep: turn.keep, ...(resume ? { resume } : {}) },
      budget: this.callBudget(),
    });
    return { res, turn };
  }

  /** After a turn that succeeded: what it recorded about the repository, then its session (which knows those notes). */
  private afterTurn<T>(o: AgentTurn<T>, res: AgentResult, turn: Turn, tree: string): void {
    const notes = acceptRepoNotes(((o.notesIn ? o.notesIn(res.data as T) : res.data) as { repo_notes?: RepoNoteOutput[] } | null)?.repo_notes, this.o.repo);
    addRepoNotes(this.state, { role: o.agentRole, backend: res.backend, round: o.round, tree }, notes);
    rememberSession(this.state, o.agentRole, res, turn, {
      tree, planHash: o.plan.after(res.data as T), reviewed: o.reviewed, answer: o.answer?.of(res.data as T) ?? null,
    });
  }

  /** Planner, plan critic, plan sign-off and code reviewer. Files they change are reported, never blocked. */
  private async callReviewer<T>(o: AgentTurn<T>): Promise<AgentResult | null> {
    const beforeTree = await this.tree();
    const beforeOutside = await this.outsideTree();
    const { res: r, turn } = await this.callAgent(o, beforeTree);
    this.addUsage(r, o.role);
    this.noteRejections(o.role, o.round, r);
    if (r.interrupted) throw new Interrupted();
    const afterTree = await this.tree();
    if (afterTree !== beforeTree) {
      const changed = await this.git.nameStatus(beforeTree, afterTree);
      if (changed.length) this.warn(`${this.agentName(o.agentRole)} (${ROLE_NAMES[o.role]}) changed files: ${listChanges(changed)}`);
    }
    await this.warnOutside(beforeOutside, this.state.phase);
    if (!r.ok) {
      // Stopped by the budget, or failed once it was reached (a Claude call cut at the cost left): the budget's decision.
      if (!this.budgetExhausted(this.state.phase)) {
        // The reasons its last answer was rejected, if it was: what you can act on.
        this.escalate("agent_error", `${o.role} (${r.backend}) failed after ${r.attempts} attempt(s): ${r.error}`, this.state.phase,
          r.rejections?.at(-1)?.errors ?? []);
      }
      return null;
    }
    this.afterTurn(o, r, turn, afterTree);
    return r;
  }

  // -------------------------------------------------------------- planning
  /**
   * The quality gates before any change, once, before the first plan: what fails then is not the task's doing, and a
   * plan that leaves a required one failing is a contradiction to settle before any implementation.
   */
  private async runBaseline(round: number): Promise<void> {
    const st = this.state;
    const { cfg, store } = this.o;
    if (!this.baselinePending()) {
      // An older run, or one past its first plan, has none: its failures count as the task's, as they always did.
      if (st.baseline === undefined && !cfg.gates.length && st.planVersion === 0) st.baseline = null;
      return;
    }
    let results: GateResult[];
    try {
      results = await runGates({
        gates: cfg.gates, repo: this.o.repo, logDir: store.path("gates"), label: "baseline", defaultTimeoutSec: cfg.limits.gate_timeout_sec,
        maxOutputChars: cfg.limits.max_gate_output_chars, bus: this.o.bus, signal: this.abort.signal,
      });
    } catch (e) {
      if (e instanceof GatesInterrupted) throw new Interrupted();
      throw e;
    }
    const tree = await this.tree();
    st.baseline = { tree, results };
    store.writeJson("gates.baseline.json", { tree, timestamp: nowIso(), results });
    const failing = baselineFailures(results);
    this.message({
      from: "gates", to: this.party("planner"), kind: "gates",
      headline: `before any change: ${results.map((g) => `${g.name} ${g.passed ? "✓" : "✗"}`).join(" · ")}`,
      items: failing.map((g) => `${g.name}: ${lastLine(g.outputTail)}`), artifact: "gates.baseline.json",
    });
    this.record("PLAN", round, "gates", failing.length ? "baseline failing" : "baseline passed",
      `before any change: ${results.map((g) => `${g.name} ${g.passed ? "PASS" : "FAIL"}`).join(", ")}`, failing.length ? "warn" : "ok", "gates.baseline.json");
    // A step of its own: its time is work done (the budget's minutes), and the planner's turn starts a step after it.
    st.activeSec = (st.activeSec ?? 0) + this.workedSec();
    this.startClock();
    this.save();
    this.emitPhaseStarted(st.phase);
  }

  /** The baseline gates are to run before the first plan: there are gates, and neither a plan nor a baseline yet. */
  private baselinePending(): boolean {
    const st = this.state;
    return st.baseline === undefined && st.planVersion === 0 && st.base === null && this.o.cfg.gates.length > 0;
  }

  /** The final plan the run implements; null before there is one. */
  private finalPlan(): Plan | null {
    const v = this.state.finalPlanVersion;
    return v ? this.o.store.readJson<{ output: Plan }>(`plan.v${v}.json`).output : null;
  }

  /** The required gates the final plan leaves failing, as they failed before any change. */
  private outOfScope(): Set<string> {
    return outOfScopeGates(this.finalPlan(), this.state.baseline?.results);
  }

  /** The planner may stop to ask: the setting allows it, and it has not asked its limit in this run (then it plans on assumptions). */
  private mayAsk(): boolean {
    const asked = (this.state.clarifications ?? []).filter((e) => e.source === "planner").length;
    return this.o.cfg.clarification?.enabled !== false && asked < MAX_PLANNER_ASKS;
  }

  private async stepPlan(): Promise<void> {
    const st = this.state;
    const { store } = this.o;
    const r = st.planningRound;
    const v = st.planVersion + 1;
    const previous = v > 1 ? store.readJson<{ output: Plan }>(`plan.v${v - 1}.json`).output : null;
    const feedback = st.planFeedback;
    await this.runBaseline(r);
    const planChecks = (p: Plan) => [
      ...(["goals", "scope_in", "steps", "acceptance_criteria"] as const).filter((k) => p[k].length === 0).map((k) => `'${k}' must not be empty`),
      ...criteriaErrors(p),
      ...missingBaselineEntries(p, st.baseline?.results),
    ];
    // Questions or the plan: each answer is checked as what it claims to be, so a plan's checks never run on a question.
    const check = (out: PlannerOutput) => {
      if (out.result.kind === "plan") return planChecks(out.result.plan);
      if (!this.mayAsk()) {
        return [this.o.cfg.clarification?.enabled === false
          ? "asking the user is turned off in this run (clarification.enabled: false): return `result.kind` `plan`, with each assumption in `open_questions`"
          : `you have already asked ${MAX_PLANNER_ASKS} times in this run: return \`result.kind\` \`plan\`, with each assumption you made in \`open_questions\``];
      }
      const parsed = parseQuestions(askedQuestions(out.result.questions));
      return "error" in parsed ? [`questions: ${parsed.error}`] : [];
    };
    const res = await this.callReviewer<PlannerOutput>({
      role: "planner", agentRole: "planner", label: "plan", schemaName: "planner", round: r, check,
      build: (ctx) => prompts.planner(ctx, r, v, previous, feedback),
      // A turn that asks leaves its session with the plan it had before (none, for a first plan).
      plan: {
        about: previous ? st.planHash : null, file: previous ? store.path(`plan.v${v - 1}.md`) : undefined,
        after: (out) => (out.result.kind === "plan" ? planHash(out.result.plan) : previous ? st.planHash : null),
      },
      notesIn: (out) => (out.result.kind === "plan" ? out.result.plan : null),
    });
    if (!res) return;
    const answer = (res.data as PlannerOutput).result;
    if (answer.kind === "needs_clarification") return this.planAsks(res, answer.questions, r);
    const plan = answer.plan;
    store.writeJson(`plan.v${v}.json`, await this.envelope("planner", r, res, { plan_version: v }, plan));
    const md = render.planMarkdown(plan, v);
    store.writeText(`plan.v${v}.md`, md);
    store.writeText("plan.md", md);
    st.planVersion = v;
    st.planHash = planHash(plan);
    this.message({
      from: this.party("planner"), to: this.party("plan_reviewer"), kind: "plan",
      headline: `Plan v${v} "${plan.title}" · ${plan.steps.length} steps · ${plan.acceptance_criteria.length} criteria · ${plan.risks.length} risks`,
      items: plan.feedback_resolution.map((f) => `${f.issue_id} ${f.decision}: ${f.rationale}`), artifact: `plan.v${v}.md`,
    });
    this.record("PLAN", r, this.agentName("planner"), v === 1 ? "plan created" : "plan revised",
      `v${v} '${plan.title}' (${plan.steps.length} steps, ${plan.acceptance_criteria.length} acceptance criteria, ${plan.risks.length} risks)`,
      "info", `plan.v${v}.md`, res);
    // The reviewers' suggestions beyond the task widen it only with your approval: asked before the critic spends a turn on them.
    const adopted = adoptedSuggestions(plan, feedback, st.accepted);
    if (adopted.length) {
      st.scopePending = adopted;
      this.escalateProfile("scope", `the revised plan adopts ${adopted.length} suggestion(s) outside the task's scope`);
      const { message, details } = expansionReview(adopted, addedCriteria(previous, plan), v);
      this.escalate("scope_expansion", message, "PLAN_REVIEW", details);
      return;
    }
    // More than a small task: the critic's approval no longer ends planning on its own (a sign-off follows).
    const large = profileOf(st) === "lightweight" ? planTooLarge(plan) : null;
    if (large) this.escalateProfile("plan_size", large);
    st.phase = "PLAN_REVIEW";
  }

  // ----------------------------------------------------- the user's answers to questions
  /**
   * The planner answered with questions instead of a plan: they are saved (pending) before anyone is asked, and the run waits
   * for the answers in HUMAN_REVIEW. It is not a planning round: the round, the plan version and the planning cycles stay as
   * they were, so the planner is called again for the same plan once the answers are in.
   */
  private planAsks(res: AgentResult, asked: PlannerQuestion[], round: number): void {
    const st = this.state;
    const { store } = this.o;
    const parsed = parseQuestions(askedQuestions(asked));
    if ("error" in parsed) throw new Error(`the planner's questions passed their check but do not parse: ${parsed.error}`);
    const request: ClarificationRequest = {
      id: `clq-${randomUUID().replaceAll("-", "").slice(0, 12)}`, source: "planner", callId: this.logPrefix("plan", round), agent: res.backend, role: "planner",
      questions: parsed.questions, at: nowIso(),
    };
    const entry = ledgerOpen((st.clarifications ??= []), request);
    const artifact = `clarification.${entry.seq}.json`;
    store.writeJson(artifact, { request, attempts: res.attempts, tokens: res.tokens, cost_usd: res.costUsd });
    const headers = entry.questions.map((q) => q.header || q.question).join(", ");
    this.record("PLAN", round, this.agentName("planner"), "questions asked", `${entry.questions.length} question(s) for you: ${headers}`, "info", artifact, res);
    const details = entry.questions.map((q) => `${q.header ? `[${q.header}] ` : ""}${q.question} — ${q.options.map((o) => o.label).join(" / ")}${q.multiSelect ? " (several may apply)" : ""}`);
    this.escalate("clarification_required", `the planner needs your answers before it can plan (${entry.questions.length} question${entry.questions.length === 1 ? "" : "s"}). ` +
      "Nothing goes on until they are answered; choose an option or write your own answer. Answer where you run agentduo (the chat or the terminal asks), or with " +
      "`duo resume --answers <file>`; `abort` ends the run.", "PLAN", details);
  }

  /**
   * HUMAN_REVIEW for the planner's questions: asks the user when someone can answer, or leaves the run waiting with the
   * questions saved. Returns the exit code when the run ends here, null when it goes on (the answers are in).
   */
  private async askPending(): Promise<number | null> {
    const st = this.state;
    const review = st.humanReview!;
    const entry = pendingEntry(st.clarifications);
    if (!entry) {
      // Nothing waits any more (it was answered or closed elsewhere): the step that asked goes on.
      st.humanReview = null;
      st.phase = review.resumePhase;
      this.save();
      return null;
    }
    this.emit({ type: "human.required", runId: st.taskId, review });
    if (!this.o.clarifier) return this.finish("HUMAN_REVIEW", EXIT.HUMAN_REVIEW);
    const { seq: _seq, status: _status, answers: _answers, closedAt: _closedAt, settled: _settled, ...asked } = entry;
    // Claude's question outlived its call: it can only be answered or put off now, never dismissed to the agent that is gone.
    const request: ClarificationRequest = entry.source === "claude" ? { ...asked, held: true } : asked;
    this.emit({ type: "clarification.requested", request });
    let response;
    try {
      response = await this.o.clarifier.askClarification({ request }, this.abort.signal);
    } catch {
      response = { kind: "defer" as const };
    }
    if (response.kind !== "answered" || !this.commitAnswers(entry, response.answers)) {
      // Not answered (later, dismissed, or stopped): it stays pending, and only its form goes away.
      this.emit({ type: "clarification.closed", id: entry.id, callId: entry.callId, status: "deferred" });
      return this.finish("HUMAN_REVIEW", EXIT.HUMAN_REVIEW);
    }
    return null;
  }

  /**
   * Records the answers of the pending request and sends the run back to the step that asked (the planner, for the same
   * round and plan version; a step whose Claude call was stopped on a question, which runs again with the answers in its
   * prompt). False (nothing changes) when they are not a complete answer to that request: an old or foreign answer is refused.
   * It is information for the agent; it decides nothing about the scope, the gates or the budget.
   */
  private commitAnswers(entry: ClarificationEntry, answers: ClarificationAnswer[]): boolean {
    const st = this.state;
    const review = st.humanReview;
    if (!review || review.reason !== "clarification_required") return false;
    if (!ledgerAnswer(st.clarifications ?? [], entry.id, entry.callId, answers, nowIso())) return false;
    const done = st.clarifications!.find((e) => e.id === entry.id)!;
    this.o.store.writeJson(`clarification.${done.seq}.json`, { request: { ...done, answers: undefined, status: undefined, closedAt: undefined }, answers: done.answers, answeredAt: done.closedAt });
    this.emit({ type: "clarification.answered", id: done.id, callId: done.callId, answers: done.answers! });
    const role: AgentRole = done.role === undefined || done.role === "plan_finalizer" ? "planner" : done.role;
    this.message({
      from: "human", to: this.party(role), kind: "decision", headline: `answered ${done.source === "planner" ? "the planner's" : "Claude's"} ${done.questions.length === 1 ? "question" : `${done.questions.length} questions`}`,
      items: done.questions.map((q) => answerSummary({ questions: [q], answers: done.answers, status: "answered" })),
    });
    this.record("HUMAN_REVIEW", IMPL_PHASES.includes(review.fromPhase) ? st.implRound : st.planningRound, "human", "questions answered", answerSummary(done), "ok", `clarification.${done.seq}.json`);
    st.humanReview = null;
    st.phase = review.resumePhase;
    st.inProgress = null;
    this.save();
    return true;
  }

  /**
   * `duo resume --answers <file>`: the answers the file gives for the pending request (the planner's, or Claude's). Refused, with the reasons,
   * when the run does not wait for answers, or the file names another request or does not answer every question.
   */
  applyAnswers(file: unknown): void {
    const st = this.state;
    // A run that a crash left in the middle of a step, with Claude's question open, waits for the answer already: put it where run() would
    // before anything else, so the answers can be given straight away (the caller holds the workspace lock; no agent is called here).
    this.holdLeftQuestion();
    const entry = st.phase === "HUMAN_REVIEW" && st.humanReview?.reason === "clarification_required" ? pendingEntry(st.clarifications) : null;
    if (!entry) throw new DecisionError(`run ${st.taskId} is not waiting for answers to questions`);
    const parsed = parseAnswersFile(file, entry);
    if ("errors" in parsed) throw new DecisionError(`the answers do not fit the questions:\n- ${parsed.errors.join("\n- ")}`);
    if (!this.commitAnswers(entry, parsed.answers)) throw new DecisionError("the answers could not be recorded");
  }

  /**
   * After a step: a question of Claude that nobody answered is owed when the step was stopped on it (answer later, a closed
   * app, Esc), and stays pending; otherwise its call is gone and it is closed as interrupted. Returns the owed one, if any.
   */
  private settleQuestions(stopped: boolean): ClarificationEntry | null {
    const st = this.state;
    const open = (st.clarifications ?? []).filter((e) => e.status === "pending" && e.source === "claude");
    const owed = stopped ? open.at(-1) ?? null : null;
    for (const e of open) if (e !== owed) ledgerClose(st.clarifications!, e.id, "interrupted", nowIso());
    return owed;
  }

  /**
   * The run waits for the answer to a question Claude asked while `phase` ran. The tool call of the process that asked is gone
   * (agentduo never keeps one alive), so the answer is not sent to it: the step runs again afterwards, with the question and
   * the answer in its prompt. Until then no agent is called and `resume` does not go past it.
   */
  private holdQuestion(entry: ClarificationEntry, phase: Phase): void {
    const st = this.state;
    st.inProgress = null;
    const details = entry.questions.map((q) => `${q.header ? `[${q.header}] ` : ""}${q.question} — ${q.options.map((o) => o.label).join(" / ")}${q.multiSelect ? " (several may apply)" : ""}`);
    this.escalate("clarification_required", `Claude asked you ${entry.questions.length === 1 ? "a question" : `${entry.questions.length} questions`} during ${phase} and the step stopped before ` +
      "you answered. Nothing goes on until you do: the step then runs again with your answer in its prompt (the tool call that asked is gone). Answer where you run " +
      "agentduo (the chat or the terminal asks), or with `duo resume --answers <file>`; `abort` ends the run.", phase, details, phase);
  }

  /**
   * A run starting up: a question of Claude that an earlier process left open (killed, crashed, closed) belongs to a call that
   * is gone and can never be answered into. The user still owes the answer, so the run holds on it before the step runs again.
   * A run that is over, or waits for something else, has no use for it.
   */
  private holdLeftQuestion(): void {
    const st = this.state;
    const open = (st.clarifications ?? []).filter((e) => e.status === "pending" && e.source === "claude");
    if (!open.length) return;
    const waiting = st.phase === "HUMAN_REVIEW" && st.humanReview?.reason === "clarification_required";
    const live = st.phase !== "DONE" && st.phase !== "ABORTED" && st.phase !== "HUMAN_REVIEW";
    const owed = waiting || live ? open.at(-1)! : null;
    for (const e of open) if (e !== owed) ledgerClose(st.clarifications!, e.id, "interrupted", nowIso());
    if (owed && live) this.holdQuestion(owed, st.phase);
    this.save();
  }

  /**
   * Keeps what the agents ask the user, and what the user answers, in the run, the moment it happens (the runner reports
   * a question of a call as it is asked and answered). Idempotent; a request of another call than the one it names is
   * refused (ledgerAnswer), so an answer that comes late never lands on a newer request.
   */
  private recordClarification(e: DuoEvent): void {
    const st = this.state;
    if (e.type === "clarification.requested") {
      if (e.request.role === undefined || e.request.source !== "claude") return;
      // One call asks at a time: a question still open from an earlier call is for a call that is gone.
      for (const old of st.clarifications ?? []) if (old.id !== e.request.id && old.status === "pending" && old.source === "claude") ledgerClose(st.clarifications!, old.id, "interrupted", nowIso());
      ledgerOpen((st.clarifications ??= []), e.request);
    } else if (e.type === "clarification.answered") {
      if (st.clarifications && ledgerAnswer(st.clarifications, e.id, e.callId, e.answers, nowIso())) this.save();
      return;
    } else if (e.type === "clarification.closed") {
      // Put off, or its call ended with no answer: it stays pending, and the end of the step says whether it is still owed
      // (settleQuestions). Only a dismissal closes it for good.
      if (e.status === "deferred" || e.status === "interrupted") return;
      if (st.clarifications) ledgerClose(st.clarifications, e.id, e.status, nowIso(), e.callId);
    } else {
      return;
    }
    this.save();
  }

  private async stepPlanReview(): Promise<void> {
    const st = this.state;
    const { store, cfg } = this.o;
    const r = st.planningRound;
    const v = st.planVersion;
    const planMd = store.readText(`plan.v${v}.md`);
    const previous = this.lastCritique(r);
    const res = await this.callReviewer<Critique>({
      role: "plan_reviewer", agentRole: "plan_reviewer", label: "plan_review", schemaName: "plan_critique", round: r,
      check: (c) => [...consistentStatus(c), ...issueRefusalErrors(c)],
      build: (ctx) => prompts.planReviewer(ctx, r, v, planMd, previous, (st.accepted?.scope ?? []).filter((i) => i.kind === "suggestion")),
      plan: { about: null, after: () => st.planHash },
      answer: { previous: previous ? answerKey(previous) : null, of: (c) => answerKey(c) },
    });
    if (!res) return;
    const critique = res.data as Critique;
    store.writeJson(`critique.r${r}.json`, await this.envelope("plan_reviewer", r, res));
    store.appendText("plan-feedback.md", render.critiqueMarkdown(critique, r, v, this.agentName("plan_reviewer")));
    // Suggestions outside the task's scope never hold the plan back.
    const blocking = this.blocking(taskIssues(critique.issues));
    const approved = critique.approved && blocking.length === 0;
    // The critic's issues by identity across critiques (renumbered or reworded, one issue stays one): the planning cycle.
    const tracked = trackCritique(st.planIssues ?? [], critique.issues, { round: r, plan: st.planHash });
    st.planIssues = tracked.ledger;
    const blockingKeys = approved ? [] : blocking.map((i) => tracked.keys[i.id] ?? i.id);
    const cycle: PlanCycle = { round: r, plan: st.planHash, blocking: blockingKeys, progress: null };
    st.planCycles = [...st.planCycles ?? [], cycle].slice(-MAX_CYCLES);
    if (critique.approved && blocking.length) this.warn("the critic approved but raised blocking issues; treating as changes requested");
    this.message({
      from: this.party("plan_reviewer"), to: this.party("planner"), kind: "critique",
      headline: approved ? `approved${critique.issues.length ? ` · ${critique.issues.length} suggestion(s)` : ""}` : `changes requested · ${blocking.length} blocking`,
      items: issueItems(critique.issues), artifact: `critique.r${r}.json`,
    });
    this.record("PLAN_REVIEW", r, this.agentName("plan_reviewer"), approved ? "approved" : "changes requested",
      `${critique.issues.length} issue(s), ${blocking.length} blocking${critique.conflicts.length ? `, ${critique.conflicts.length} conflict(s)` : ""}`,
      approved ? "ok" : "warn", `critique.r${r}.json`, res);
    // A contradiction only you can settle: another planning round could not, and implementing it could only loop.
    const plan = store.readJson<{ output: Plan }>(`plan.v${v}.json`).output;
    const conflicts = requirementConflicts({ plan, critique, baseline: st.baseline?.results, requireTestsPass: cfg.quality_gates.require_tests_pass && cfg.gates.length > 0 });
    if (conflicts.length) {
      st.planFeedback = { critique };
      st.conflicts = conflicts;
      this.escalateProfile("requirements_conflict", `${conflicts.length} contradiction(s) in the requirements, which you settle`);
      const { message, details } = conflictReview(conflicts);
      this.escalate("requirements_conflict", message, "IMPLEMENT", details);
      return;
    }
    if (!approved) {
      st.planFeedback = { critique };
      this.escalateProfile("plan_blocking", blocking.length
        ? `the plan critic raised ${blocking.length} blocking issue(s) (${blocking.map((i) => i.id).join(", ")})` : "the plan critic requested changes");
      // Critiques that keep blocking on the same issues stop the loop before it spends every planning round.
      if (this.planningStalled(r, plan, tracked, blockingKeys)) return;
      this.nextPlanningRound();
      return;
    }
    st.planStall = null;
    // The profile decides whether the planner signs off what the critic approved (lightweight: no; thorough: always).
    if (signsOff(profileOf(st), cfg)) st.phase = "PLAN_FINALIZE";
    else this.freezePlan(v);
  }

  private async stepPlanFinalize(): Promise<void> {
    const st = this.state;
    const { store } = this.o;
    const r = st.planningRound;
    const v = st.planVersion;
    const critique = store.readJson<{ output: Critique }>(`critique.r${r}.json`).output;
    const planMd = store.readText(`plan.v${v}.md`);
    const res = await this.callReviewer<Approval>({
      role: "plan_finalizer", agentRole: "planner", label: "plan_finalize", schemaName: "plan_approval", round: r,
      check: (a) => [...consistentStatus(a), ...issueRefusalErrors(a)],
      build: (ctx) => prompts.planFinalizer(ctx, r, v, planMd, critique),
      plan: { about: st.planHash, after: () => st.planHash, file: store.path(`plan.v${v}.md`) },
    });
    if (!res) return;
    const approval = res.data as Approval;
    store.writeJson(`approval.r${r}.json`, await this.envelope("plan_finalizer", r, res));
    store.appendText("plan-feedback.md", render.approvalMarkdown(approval, r, v, this.agentName("planner")));
    const blocking = this.blocking(taskIssues(approval.issues));
    const approved = approval.approved && blocking.length === 0;
    this.message({
      from: this.party("planner"), to: this.party("implementer"), kind: "approval",
      headline: approved ? `plan finalized v${v}` : `changes requested · ${blocking.length} blocking`,
      items: issueItems(approval.issues), artifact: `approval.r${r}.json`,
    });
    this.record("PLAN_FINALIZE", r, this.agentName("planner"), approved ? "plan finalized" : "changes requested",
      `v${v}: ${approval.summary.slice(0, 120)}`, approved ? "ok" : "warn", `approval.r${r}.json`, res);
    if (approved) {
      this.freezePlan(v);
    } else {
      st.planFeedback = { critique, approval };
      this.nextPlanningRound();
    }
  }

  /**
   * How the final plan became final, for an implementer that goes on in the plan critic's session: the sign-off of
   * the round it was frozen in, or the human operator's acceptance (freezePlan's header says so), and what the user
   * accepted about its contract.
   */
  private planHandoff(finalMd: string): prompts.PlanHandoff {
    const st = this.state;
    const { store } = this.o;
    const name = `approval.r${st.planningRound}.json`;
    const approval = store.exists(name) ? store.readJson<{ output: Approval | null }>(name).output : null;
    const byHuman = /^<!-- final plan [^\n]*accepted by the human operator/.test(finalMd);
    return {
      version: st.finalPlanVersion, byHuman, signOff: !byHuman && approval?.approved ? approval.summary : null,
      ...(st.accepted ? { accepted: { conflicts: st.accepted.conflicts, scope: st.accepted.scope ?? [] } } : {}),
    };
  }

  private nextPlanningRound(): void {
    const st = this.state;
    if (st.planningRound >= st.limits.planningRounds) {
      this.escalate("max_planning_rounds",
        `no agreed plan after ${st.planningRound} planning round(s). Read plan.md and plan-feedback.md, then 'resume' to implement ` +
        "the latest plan as-is, or 'revise' with a --note that settles the disagreement.", "IMPLEMENT");
      return;
    }
    st.planningRound += 1;
    st.phase = "PLAN";
  }

  private freezePlan(version: number, byHuman = false): void {
    const st = this.state;
    const { store, cfg } = this.o;
    st.finalPlanVersion = version;
    st.finalPlanHash = st.planHash;
    const header = `<!-- final plan v${version}, sha256 ${st.planHash}${byHuman ? ", accepted by the human operator" : ""} -->\n`;
    store.writeText("plan.final.md", header + store.readText(`plan.v${version}.md`));
    if (st.base !== null) {
      // Re-planned after implementation started: continue in a new round, with no stale review or gate results.
      st.implRound += 1;
      setFindings(st, [], null);
      this.clearEvidence();
      this.ensureReviewBudget();
    }
    if (cfg.safety.pause_before_implement && !byHuman) {
      this.escalate("plan_ready", `final plan v${version} is ready for your review (${store.path("plan.final.md")}). Resume to start implementation.`, "IMPLEMENT");
      return;
    }
    st.phase = "IMPLEMENT";
  }

  // -------------------------------------------------------- implementation
  /** The review the open findings come from; an older run's is in review.json. Null while there are none. */
  private findingsSource(): FindingsSource | null {
    const st = this.state;
    if (st.findingsSource !== undefined || !st.openFindings.length) return st.findingsSource ?? null;
    if (!this.o.store.exists("review.json")) return null;
    const r = this.o.store.readJson<{ round: number; output: Review }>("review.json");
    return { round: r.round, revision: r.output.reviewed_commit };
  }

  /** The open findings as they stand against `tree`: what was answered since their review, and which files changed since its revision. */
  private async findingsAt(tree: string): Promise<ReviewFindings | null> {
    const st = this.state;
    if (!st.openFindings.length) return null;
    const source = this.findingsSource();
    let changedSince: Change[] | null = null;
    try {
      changedSince = source ? await this.git.nameStatus(source.revision, tree) : null;
    } catch {
      // that revision is gone (pruned, or another repository): the findings go without what changed since
    }
    const store = this.o.store;
    const summary = store.exists("review.json") ? store.readJson<{ output: Review }>("review.json").output.summary : "";
    return reviewFindings({ state: st, source, summary, changedSince, workspace: this.o.repo });
  }

  /**
   * Brings the round's snapshot up to the workspace, when files changed after it was taken by something other than the
   * step that took it (you, another process, while the run waited or ran): the step that comes next must judge the code
   * that is there, not an older revision of it.
   */
  private async catchUp(phase: Phase): Promise<void> {
    const st = this.state;
    const k = st.implRound;
    const tree = await this.tree();
    if (tree === st.lastSnapshot!.tree) return;
    const changed = await this.git.nameStatus(st.lastSnapshot!.tree, tree);
    const snap = await this.git.snapshot(this.snapshotExclude, this.ref(`impl-r${k}`), `agentduo ${st.taskId}: round ${k} before ${phase}`);
    st.lastSnapshot = { commit: snap.commit, tree: snap.tree };
    if (changed.length) this.warn(`${changed.length} file(s) changed after the last snapshot, not by the run's last step: ${listChanges(changed)}; ${phase} takes the workspace as it is now`);
  }

  /** Re-planning: no gate result, approval or final check of the old plan's code is evidence for the new one. */
  private clearEvidence(): void {
    const st = this.state;
    st.lastGates = null;
    st.gatesTree = null;
    st.gatesConfig = null;
    st.gatesAt = null;
    st.reviewApproval = null;
    st.finalCheck = null;
    st.consecutiveGateFailures = 0;
  }

  /** The gates as the run's config sets them now, as far as their outcome can depend on it. */
  private gateSpecs(): GateSpec[] {
    return gateSpecs(this.o.cfg.gates, this.o.cfg.limits.gate_timeout_sec);
  }

  /** The latest review's approval covers `tree` under the final plan: gates that pass on it need no review again. */
  private approvalCovers(tree: string): boolean {
    const a = this.state.reviewApproval;
    return !!a && a.tree === tree && a.plan === this.state.finalPlanHash;
  }

  /**
   * The approval DONE would rest on: the latest review's; in an older run (which kept none), review.json's when it
   * approved the run's last snapshot.
   */
  private approvalRecord(): ReviewApproval | null {
    const st = this.state;
    if (st.reviewApproval !== undefined) return st.reviewApproval;
    if (!st.lastSnapshot || !this.o.store.exists("review.json")) return null;
    const r = this.o.store.readJson<{ round: number; output: Review }>("review.json");
    const approved = r.output.approved || !this.o.cfg.quality_gates.require_codex_approval;
    return approved && r.output.reviewed_commit === st.lastSnapshot.commit
      ? { round: r.round, revision: r.output.reviewed_commit, tree: st.lastSnapshot.tree, plan: st.finalPlanHash, approved: r.output.approved }
      : null;
  }

  /**
   * The final verification checkpoint, wherever the run would end DONE (src/core/verification.ts): DONE only when the
   * evidence holds for the workspace as it is now (dirty, untracked and deleted files included) and the gates as they
   * are configured now: the latest review approved this very code under the final plan, the gates ran on it with this
   * configuration, every required gate passed or failed only where you accepted it, and nothing waits for your
   * decision. It runs no gate and no agent: out of date, the run goes back to the gates (keeping the approval when the
   * code is the same) or to a review, at most FINAL_REFRESHES times in a row, then stops (`verification_stale`).
   * `phase`: the step (or decision) it ends.
   */
  private async finalCheck(phase: Phase): Promise<void> {
    const st = this.state;
    const { cfg, store } = this.o;
    const k = st.implRound;
    const approval = this.approvalRecord();
    // An older run's approval, once found: the gates it may need again then need no review again.
    if (st.reviewApproval === undefined) st.reviewApproval = approval;
    // The workspace as it is now, whoever changed it since the last snapshot (the reviewer, you, another tool).
    const tree = await this.tree();
    if (tree !== st.lastSnapshot!.tree) {
      const snap = await this.git.snapshot(this.snapshotExclude, this.ref(`impl-r${k}`), `agentduo ${st.taskId}: round ${k} at the final check`);
      st.lastSnapshot = { commit: snap.commit, tree: snap.tree };
    }
    const changesTo = async (from: string | null | undefined): Promise<Change[] | null> => {
      if (!from || from === tree) return null;
      try {
        return await this.git.nameStatus(from, tree);
      } catch {
        return null; // that tree is gone: what changed cannot be told, but that it changed can
      }
    };
    const specs = this.gateSpecs();
    const review = store.exists("review.json") ? store.readJson<{ output: Review }>("review.json").output : null;
    // The approving review's attributions: an accepted gate holds only while that review finds it failing as before.
    const approving = review && approval && review.reviewed_commit === approval.revision ? review : null;
    const acceptedGates = acceptedIds(st.accepted, "gate");
    const verdicts = specs.length
      ? gateVerdicts({ results: st.lastGates ?? [], baseline: st.baseline?.results, outOfScope: this.outOfScope(), attributions: approving?.gate_failures ?? null, accepted: acceptedGates })
      : [];
    const problems = finalProblems({
      tree, plan: st.finalPlanHash, approval, changedSinceApproval: await changesTo(approval?.tree), gates: specs,
      ran: { tree: st.gatesTree, config: st.gatesConfig, results: st.lastGates }, changedSinceGates: await changesTo(st.gatesTree),
      blockingGates: specs.length && cfg.quality_gates.require_tests_pass ? verdicts.map((v) => v.gate.name) : [],
      pending: (st.conflicts?.length ?? 0) + (st.preexisting?.length ?? 0) + (st.scopePending?.length ?? 0),
    });
    if (!problems.length) {
      const failing = new Set(verdicts.map((v) => v.gate.name));
      const decided = new Set([...acceptedIds(st.accepted, "finding"), ...keptIds(st.accepted)]);
      st.verification = finalVerification({
        snapshot: st.lastSnapshot!, gates: specs, results: st.lastGates ?? [], acceptedGates: new Set([...acceptedGates].filter((g) => !failing.has(g))),
        gatesAt: st.gatesAt ?? null, approval: approval!, findings: (approving?.findings ?? []).filter((f) => decided.has(f.id)).map((f) => `finding ${f.id}`), at: nowIso(),
      });
      store.writeJson("verification.json", st.verification);
      st.finalCheck = null;
      st.phase = "DONE";
      return;
    }
    // Never DONE on evidence about other code. Same code with gates out of date: the gates again, and the approval
    // stands. Code the approval does not cover: the gates and a review. Anything else: a review, which decides afresh.
    const blocked = problems.some((p) => p.kind === "blocked");
    const next: Phase = !blocked && problems.some((p) => p.kind === "gates") ? "VERIFY" : "CODE_REVIEW";
    st.finalCheck = nextFinalCheck(st.finalCheck, problems.map((p) => `round ${k}: ${p.text}`));
    if (blocked) st.reviewApproval = null;
    if (st.finalCheck.refreshes > FINAL_REFRESHES) {
      const { message, details } = staleReview(st.finalCheck, specs.length > 0);
      this.escalate("verification_stale", message, next, details, phase);
      return;
    }
    const again = next === "VERIFY" ? (problems.every((p) => p.kind === "gates") ? "running the quality gates again" : "running the quality gates, then the review, again")
      : "reviewing again";
    this.record(phase, k, "orchestrator", "not verified", `${problems.map((p) => p.text).join("; ")}; ${again}`, "warn");
    st.phase = next;
  }

  private ensureReviewBudget(): void {
    const st = this.state;
    if (st.implRound > st.limits.reviewRounds) st.limits.reviewRounds = st.implRound + this.o.cfg.limits.max_review_rounds - 1;
  }

  private nextImplRound(): void {
    const st = this.state;
    if (st.implRound >= st.limits.reviewRounds) {
      this.escalate("max_review_rounds",
        `not approved after ${st.implRound} implementation round(s). Inspect review.json and the working tree, then 'resume' for ` +
        "more fix rounds (optionally with a --note), 'revise' to re-plan, or 'abort'.", "IMPLEMENT");
      return;
    }
    st.implRound += 1;
    st.phase = "IMPLEMENT";
  }

  private async stepImplement(): Promise<void> {
    const st = this.state;
    const { store, cfg } = this.o;
    if (st.base === null) {
      const base = await this.git.snapshot(this.snapshotExclude, this.ref("base"), `agentduo ${st.taskId}: base`);
      st.base = { commit: base.commit, tree: base.tree, head: await this.git.head(), branch: await this.git.branch() };
      st.implRound = Math.max(st.implRound, 1);
    }
    const k = st.implRound;
    // A round re-run after an error or interrupt keeps its first starting point, so its record covers every attempt.
    const preRef = this.ref(`impl-r${k}-pre`);
    const started = await this.git.readRef(preRef);
    const pre = started ?? await this.git.snapshot(this.snapshotExclude, preRef, `agentduo ${st.taskId}: before implementation round ${k}`);
    // A re-run round keeps its first starting point, but the turn is told about the workspace as it is now.
    const now = started ? await this.tree() : pre.tree;
    const beforeOutside = await this.outsideTree();
    // The findings as they stand against the workspace now, which the round's earlier attempts may have changed.
    const findings = await this.findingsAt(now);
    const last = st.lastImplementation?.round === k ? st.lastImplementation : null;
    // A re-run of the round is told what its earlier attempt left in the working tree, so that it goes on from there.
    const rerun: prompts.EarlierAttempt | null = started
      ? { status: last?.status ?? null, summary: last?.summary ?? null, blockingReason: last?.blockingReason ?? null, changes: await this.git.nameStatus(pre.tree, now) }
      : null;
    const failed = k > 1 ? (st.lastGates ?? []).filter((g) => !g.passed) : [];
    const planMd = store.readText("plan.final.md");
    const check = (rep: Implementation) =>
      rep.status === "blocked" && !(rep.blocking_reason ?? "").trim() ? ["status is 'blocked' but blocking_reason is empty"] : [];
    const lastReport = st.lastImplementation;
    const turnSpec: AgentTurn<Implementation> = {
      role: "implementer", agentRole: "implementer", label: "implement", schemaName: "implementation", round: k, check,
      build: (ctx) => prompts.implementer(ctx, k, planMd, findings, failed, { summary: lastReport?.summary ?? null, rerun },
        ctx.continued?.from === "plan_reviewer" ? this.planHandoff(planMd) : null),
      plan: { about: st.finalPlanHash, after: () => st.finalPlanHash, file: store.path("plan.final.md") },
      answer: {
        previous: lastReport?.summary ? answerKey({ round: lastReport.round, summary: lastReport.summary }) : null,
        of: (rep) => answerKey({ round: k, summary: rep.summary }),
      },
    };
    // The notes this attempt is given: one added while it runs reaches only the next.
    const notesGiven = st.humanNotes.length;
    const { res, turn } = await this.callAgent(turnSpec, now);
    this.addUsage(res, "implementer");
    this.noteRejections("implementer", k, res);
    const post = await this.git.snapshot(this.snapshotExclude, this.ref(`impl-r${k}`), `agentduo ${st.taskId}: implementation round ${k}`);
    st.lastSnapshot = { commit: post.commit, tree: post.tree };
    if (res.interrupted) throw new Interrupted();
    const changes = await this.git.nameStatus(pre.tree, post.tree);
    await this.warnOutside(beforeOutside, "IMPLEMENT");
    const denials = res.meta.permissionDenials ?? [];
    const report = res.data as Implementation | null;
    // Its answers hold until the next review, also from an attempt that ended blocked: no later attempt is asked again.
    if (report) recordResponses(st, report, k);
    const missing = report ? unanswered(st).map((f) => f.id) : [];
    // The round's record covers all its attempts: each one's own changes, and the earlier ones' outcomes, which a re-run keeps.
    const recordName = `implementation.r${k}.json`;
    const earlier = started && store.exists(recordName) ? store.readJson<ImplementationRecord>(recordName) : null;
    store.writeJson(recordName, await this.envelope("implementer", k, res, {
      pre_snapshot: pre.commit, snapshot: post.commit, changes: changes.map(([status, path]) => ({ status, path })),
      attempt_changes: (now === post.tree ? [] : await this.git.nameStatus(now, post.tree)).map(([status, path]) => ({ status, path })),
      unanswered_findings: missing, earlier_attempts: earlier ? [...(earlier.earlier_attempts ?? []), attemptOf(earlier)] : [],
    }));
    st.lastImplementation = {
      round: k, summary: report?.summary ?? null, status: report?.status ?? null, blockingReason: report?.blocking_reason ?? null, permissionDenials: denials,
    };
    if (denials.length) this.warn(denialHint(cfg.agents.implementer, denials));
    if (!res.ok || !report) {
      if (!this.budgetExhausted("IMPLEMENT")) {
        this.escalate("agent_error", `implementer (${res.backend}) failed after ${res.attempts} attempt(s): ${res.error}`, "IMPLEMENT",
          res.rejections?.at(-1)?.errors ?? []);
      }
      return;
    }
    this.afterTurn(turnSpec, res, turn, post.tree);
    this.message({
      from: this.party("implementer"), to: this.party("code_reviewer"), kind: "implementation",
      headline: report.status === "blocked" ? `blocked: ${report.blocking_reason}` : `completed · ${changes.length} file(s) changed`,
      items: [
        ...report.addressed_findings.map((a) => `${a.finding_id} ${a.resolution}${a.notes ? `: ${a.notes}` : ""}`),
        ...changes.slice(0, 10).map(([s, p]) => `${s} ${p}`),
      ],
      artifact: `implementation.r${k}.json`,
    });
    this.record("IMPLEMENT", k, this.agentName("implementer"), report.status, `${changes.length} file(s) changed; ${report.summary.slice(0, 140)}`,
      report.status === "completed" ? "ok" : "warn", `implementation.r${k}.json`, res);
    // A blocked attempt stops before some findings by its nature; the round's next attempt answers them.
    if (missing.length && report.status !== "blocked") this.warn(`implementer did not respond to finding(s): ${missing.join(", ")}`);
    const plan = profileOf(st) === "lightweight" ? this.finalPlan() : null;
    const unplanned = plan ? unplannedFiles(plan, changes, this.o.repo) : [];
    if (unplanned.length >= LIGHTWEIGHT.unplannedFiles) {
      this.escalateProfile("unplanned_files", `round ${k} changed ${unplanned.length} file(s) no step of the plan names ` +
        `(${unplanned.slice(0, 5).join(", ")}${unplanned.length > 5 ? ", …" : ""})`, "IMPLEMENT");
    }
    if (report.status === "blocked") {
      this.escalateProfile("implementer_blocked", `the implementer is blocked: ${report.blocking_reason ?? "no reason given"}`, "IMPLEMENT");
      // A blocker needs something from you: until something the implementer is given changes, resume does not run it.
      const mark = await this.progressMark(post.tree, notesGiven);
      st.blocker = nextBlocker(st.blocker, report.blocking_reason ?? "implementer reported blocked", k, mark, post.tree !== now);
      const { message, details } = blockedReview(st.blocker);
      this.escalate("implementer_blocked", message, "IMPLEMENT", details);
      return;
    }
    st.blocker = null;
    // New code: the final check's count starts anew once it is reviewed.
    st.finalCheck = null;
    st.phase = cfg.gates.length ? "VERIFY" : "CODE_REVIEW";
  }

  private async stepVerify(): Promise<void> {
    const st = this.state;
    const { store, cfg } = this.o;
    const k = st.implRound;
    // Gates judge the code that is there; what changed since the implementation is not theirs.
    await this.catchUp("VERIFY");
    // Their results are evidence about the files they start on, under this configuration: a change while they run (their
    // own or anyone's) is not verified by them.
    const ranOn = st.lastSnapshot!;
    const specs = this.gateSpecs();
    const beforeOutside = await this.outsideTree();
    let results: GateResult[];
    try {
      results = await runGates({
        gates: cfg.gates, repo: this.o.repo, logDir: store.path("gates"), label: `r${k}`, defaultTimeoutSec: cfg.limits.gate_timeout_sec,
        maxOutputChars: cfg.limits.max_gate_output_chars, bus: this.o.bus, signal: this.abort.signal,
      });
    } catch (e) {
      if (e instanceof GatesInterrupted) throw new Interrupted();
      throw e;
    }
    const tree = await this.tree();
    let changed: Change[] = [];
    if (tree !== ranOn.tree) {
      changed = await this.git.nameStatus(ranOn.tree, tree);
      if (changed.length) {
        this.warn(`quality gates modified the working tree: ${listChanges(changed)} (re-snapshotting; their results hold for the files before these changes)`);
      }
      const snap = await this.git.snapshot(this.snapshotExclude, this.ref(`impl-r${k}`), `agentduo ${st.taskId}: round ${k} after gates`);
      st.lastSnapshot = { commit: snap.commit, tree: snap.tree };
    }
    await this.warnOutside(beforeOutside, "VERIFY");
    const at = nowIso();
    store.writeJson(`gates.r${k}.json`, {
      round: k, snapshot: ranOn.commit, tree: ranOn.tree, config: configDigest(specs), timestamp: at, results,
      changed_while_running: changed.map(([status, path]) => ({ status, path })),
    });
    st.lastGates = results;
    st.gatesTree = ranOn.tree;
    st.gatesConfig = specs;
    st.gatesAt = at;
    // A required gate that failed before any change, and that the plan leaves out of scope, is not the implementer's to
    // fix: it goes to the reviewer, who says whether the change made it worse. The task's own failures go back as before.
    const verdicts = gateVerdicts({
      results, baseline: st.baseline?.results, outOfScope: this.outOfScope(), attributions: null, accepted: acceptedIds(st.accepted, "gate"),
    });
    const fixable = verdicts.filter((v) => v.kind !== "pre_existing");
    const passed = verdicts.length === 0;
    st.consecutiveGateFailures = fixable.length ? st.consecutiveGateFailures + 1 : 0;
    const enforce = cfg.quality_gates.require_tests_pass;
    // The profile may spend a review on failing gates too (thorough), so the findings come with each round.
    const reviewAnyway = reviewsOnGateFailure(profileOf(st), cfg);
    const toReviewer = !fixable.length || !enforce || reviewAnyway;
    this.message({
      from: "gates", to: toReviewer ? this.party("code_reviewer") : this.party("implementer"), kind: "gates",
      headline: results.map((g) => (g.passed ? `${g.name} ✓` : `${g.name} ✗ (${g.timedOut ? "timeout" : `exit ${g.exitCode}`})`)).join(" · ") || "no gates",
      items: results.filter((g) => !g.passed).map((g) => `${g.name}: ${lastLine(g.outputTail)}`), artifact: `gates.r${k}.json`,
    });
    this.record("VERIFY", k, "gates", passed ? "passed" : fixable.length ? "failed" : "failing as before the task",
      results.map((g) => `${g.name} ${g.passed ? "PASS" : "FAIL"}`).join(", ") || "no gates", passed ? "ok" : "warn", `gates.r${k}.json`);
    if (fixable.length && st.consecutiveGateFailures >= LIGHTWEIGHT.gateFailures) {
      this.escalateProfile("gates_failing", `required quality gates failed ${st.consecutiveGateFailures} rounds in a row`, "VERIFY");
    }
    if (fixable.length && enforce) {
      const limit = cfg.limits.max_consecutive_gate_failures;
      if (st.consecutiveGateFailures >= limit) {
        this.escalate("gates_failing", `required quality gates failed ${limit} round(s) in a row. Check the logs under gates/, then resume (optionally with a --note) or abort.`, "IMPLEMENT");
        return;
      }
      if (!reviewAnyway) {
        this.nextImplRound(); // back to the implementer without spending a review
        return;
      }
    }
    // The gates passed on code the latest review approved (they ran again for the final check): no review again.
    if (passed && this.approvalCovers(ranOn.tree)) {
      await this.finalCheck("VERIFY");
      return;
    }
    st.phase = "CODE_REVIEW";
  }

  private async stepCodeReview(): Promise<void> {
    const st = this.state;
    const { store, cfg } = this.o;
    const k = st.implRound;
    const base = st.base!.commit;
    // Review the code that is there now; gates that ran on an earlier revision, or with another configuration, run once more first.
    const gatedBefore = st.gatesTree === undefined ? st.lastSnapshot!.tree : st.gatesTree;
    await this.catchUp("CODE_REVIEW");
    const outdated = gatesStale({ tree: gatedBefore, config: st.gatesConfig, results: st.lastGates }, st.lastSnapshot!.tree, this.gateSpecs());
    if (outdated.length) {
      if (st.reverifiedRound !== k) {
        st.reverifiedRound = k; // once a round: files that never stop changing must not keep the run from its review
        this.record("CODE_REVIEW", k, "orchestrator", "gates out of date", `${outdated.join("; ")}: running them on this revision before the review`, "warn");
        st.phase = "VERIFY";
        return;
      }
      // The review goes on; DONE does not, until gates ran on the code it ends with (finalCheck).
      this.warn(`the quality gates' results are out of date again (${outdated.join("; ")}): the review gets them as they are, and the run ` +
        "ends only once the gates ran on the code it ends with");
    }
    const snap = st.lastSnapshot!.commit;
    const diff = await this.git.diff(base, snap);
    // The whole diff, for a review that gets it cut short (and for the report): readable without any repository.
    const fullDiff = store.writeText(`diff.r${k}.patch`, diff);
    const maxChars = cfg.limits.max_diff_chars;
    const implReport = store.readJson<{ output: Implementation }>(`implementation.r${k}.json`).output;
    const planMd = store.readText("plan.final.md");
    const diffStat = await this.git.diffStat(base, snap);
    const gates = st.lastGates ?? [];
    // The previous findings with every answer since their review (from any attempt), and which files changed since their revision.
    const findings = await this.findingsAt(st.lastSnapshot!.tree);
    // The required gates that fail as they did before any change, out of the plan's scope: the reviewer attributes them.
    const enforceGates = cfg.gates.length > 0 && cfg.quality_gates.require_tests_pass;
    const outOfScope = this.outOfScope();
    const acceptedGates = acceptedIds(st.accepted, "gate");
    // Those you accepted too: an acceptance holds only while the review of the code finds them failing as before.
    const attribute = enforceGates ? gatesToAttribute({ results: gates, baseline: st.baseline?.results, outOfScope }) : [];
    const kept = keptIds(st.accepted);
    const contract: prompts.ReviewContract = {
      attribute, accepted: st.accepted?.failures ?? [], kept: (st.accepted?.scope ?? []).filter((i) => i.kind === "finding"),
    };
    // The task's acceptance contract: the final plan's criteria, which a finding the task must fix names.
    const criteria = criterionIds(this.finalPlan());
    // The findings you already decided on (accepted as pre-existing, or kept out of the scope) no longer hold anything back.
    const decided = new Set([...acceptedIds(st.accepted, "finding"), ...kept]);
    const gatesFailing = enforceGates && gates.some((g) => g.required && !g.passed && !acceptedGates.has(g.name));
    // The findings raised so far, by identity, and the review before this one under the same plan: what changed since
    // tells a finding new on untouched code (which must say why it comes late) and whether the cycle made progress. After
    // a re-plan, or in an older run with no cycle recorded, there is none to compare with.
    const ledger = ledgerOf(st);
    const prevCycle = st.cycles?.at(-1);
    const samePlan = prevCycle && prevCycle.plan === st.finalPlanHash ? prevCycle : undefined;
    let changedSincePrev: Change[] | null = null;
    try {
      changedSincePrev = samePlan ? await this.git.nameStatus(samePlan.revision, snap) : null;
    } catch {
      // that revision is gone: what changed cannot be told
    }
    const since = samePlan ? { round: samePlan.round, changed: changedSincePrev } : null;
    // What the reviewer's session last reviewed: a continued review gets the changes since then instead of the whole diff.
    const reviewed = st.sessions?.code_reviewer?.reviewed ?? null;
    const build = async (ctx: prompts.PromptContext): Promise<string> => {
      if (ctx.continued && reviewed) {
        try {
          const since = await this.git.diff(reviewed, snap);
          const sinceReviewed = { from: reviewed, stat: await this.git.diffStat(reviewed, snap), diff: since.slice(0, maxChars), truncated: since.length > maxChars };
          ctx = { ...ctx, continued: { ...ctx.continued, sinceReviewed } };
        } catch {
          // that revision is gone: the whole diff, as a fresh review gets it
        }
      }
      return prompts.codeReviewer(ctx, k, planMd, base, snap, gates, diffStat, diff.slice(0, maxChars), diff.length > maxChars, findings, implReport, fullDiff,
        { ...contract, resolved: ledger.filter((e) => e.status === "resolved") });
    };
    const check = (rv: Review) => {
      const errors = consistentStatus(rv);
      if (rv.reviewed_commit !== snap) errors.push(`reviewed_commit is '${rv.reviewed_commit}', expected '${snap}'`);
      return [
        ...errors, ...attributionErrors(rv, cfg.quality_gates.blocking_severities, attribute),
        ...reviewScopeErrors({
          review: rv, criteria, blockingSeverities: cfg.quality_gates.blocking_severities, requireApproval: cfg.quality_gates.require_codex_approval,
          gatesFailing, decided,
        }),
        ...lateFindingErrors({ review: rv, ledger, since, blockingSeverities: cfg.quality_gates.blocking_severities, workspace: this.o.repo }),
      ];
    };
    const res = await this.callReviewer<Review>({
      role: "code_reviewer", agentRole: "code_reviewer", label: "code_review", schemaName: "review", round: k, check, build,
      plan: { about: st.finalPlanHash, after: () => st.finalPlanHash, file: store.path("plan.final.md") }, reviewed: snap,
    });
    if (!res) return;
    const review = res.data as Review;
    // Each finding's identity across the reviews: new, still open or reopened; the open ones it left out, resolved by it.
    const { ledger: tracked, tracking } = trackReview(ledger, review.findings, { round: k, revision: snap });
    st.trackedFindings = tracked;
    const envelope = await this.envelope("code_reviewer", k, res, { base, snapshot: snap, tracking });
    store.writeJson(`review.r${k}.json`, envelope);
    store.writeJson("review.json", envelope);
    // The implementer's answers since the last review, which the stall's details name; this review replaces them.
    const answers = st.findingResponses ?? [];
    // Fresh evidence: the findings of this revision replace the open ones and every answer to them.
    setFindings(st, review.findings, { round: k, revision: snap });
    // What still blocks: the task's to fix (its regressions, what its scope includes, what the reviewer cannot place), and
    // what was there before outside its scope, which no fix round can settle. Nothing you did not accept is left out.
    // Beyond the task's scope nothing blocks, except a critical problem, which only you can add to the task.
    const blocking = this.blocking(review.findings);
    const { fixable, preexisting } = splitFindings(blocking, acceptedIds(st.accepted, "finding"));
    const scope = outOfScopeBlockers(review.findings, kept);
    const verdicts = enforceGates
      ? gateVerdicts({ results: st.lastGates ?? [], baseline: st.baseline?.results, outOfScope, attributions: review.gate_failures, accepted: acceptedGates })
      : [];
    const fixableGates = verdicts.filter((v) => v.kind !== "pre_existing");
    const pre = preexistingFailures(preexisting, verdicts.filter((v) => v.kind === "pre_existing"));
    const gatesOk = verdicts.length === 0;
    const critical = fixable.filter((f) => f.severity === "critical");
    const approved = review.approved || !cfg.quality_gates.require_codex_approval;
    const done = approved && !fixable.length && !pre.length && !scope.length && gatesOk;
    // The code this review approved, while it leaves nothing for the task to fix: what DONE may rest on (finalCheck).
    st.reviewApproval = approved && !fixable.length && !fixableGates.length
      ? { round: k, revision: snap, tree: st.lastSnapshot!.tree, plan: st.finalPlanHash, approved: review.approved }
      : null;
    if (review.approved && fixable.length) this.warn("the reviewer approved but reported blocking findings; continuing with a fix round");
    // The cycle this review closes: what still blocks, and what moved since the review before it (same plan).
    const keyOf = (f: Finding) => tracking.findings[f.id]?.key ?? f.id;
    const now = { plan: st.finalPlanHash, tree: st.lastSnapshot!.tree, blocking: fixable.map((f) => ({ key: keyOf(f), file: f.file })), failingGates: fixableGates.map((v) => v.gate.name) };
    const progress = cycleProgress(samePlan, now, { resolved: tracking.resolved, changed: changedSincePrev, workspace: this.o.repo });
    const statuses = Object.values(tracking.findings).map((t) => t.status);
    const cycle: ReviewCycle = {
      round: k, revision: snap, ...now, progress,
      counts: { new: statuses.filter((x) => x === "new").length, open: statuses.filter((x) => x === "open").length, reopened: statuses.filter((x) => x === "reopened").length, resolved: tracking.resolved.length },
    };
    st.cycles = [...st.cycles ?? [], cycle].slice(-MAX_CYCLES);
    // What kept blocking through the cycle: the findings and required gates of the review before that are still there.
    const stuck = [...(samePlan?.blocking ?? []).map((b) => b.key).filter((key) => now.blocking.some((b) => b.key === key)),
      ...(samePlan?.failingGates ?? []).filter((g) => now.failingGates.includes(g)).map((g) => `gate '${g}'`)];
    const stalled = nextStall(st.stall, { round: k, progress, keys: stuck }, samePlan?.tree === cycle.tree);
    st.stall = done ? null : stalled.stall;
    const held = [pre.length ? `${pre.length} pre-existing` : "", scope.length ? `${scope.length} outside the task's scope` : ""].filter(Boolean);
    const counts = `${fixable.length + preexisting.length + scope.length} blocking${held.length ? ` (${held.join(", ")})` : ""}`;
    this.message({
      from: this.party("code_reviewer"), to: this.party("implementer"), kind: "review",
      headline: done
        ? `approved${review.findings.length ? ` · ${review.findings.length} non-blocking finding(s)` : ""}`
        : `${review.findings.length} finding(s) · ${counts}${gatesOk ? "" : " · required gates failing"}`,
      items: findingItems(review.findings), artifact: `review.r${k}.json`,
    });
    this.record("CODE_REVIEW", k, this.agentName("code_reviewer"), done ? "approved" : "changes requested",
      `${review.findings.length} finding(s), ${counts}${gatesOk ? "" : ", required gates failing"}`, done ? "ok" : "warn", `review.r${k}.json`, res);
    if (done) {
      await this.finalCheck("CODE_REVIEW");
      return;
    }
    // More than a lightweight task: the first signal that says so, before whatever this review leads to.
    const signal: [EscalationSignal, string] | null = scope.length ? ["scope", `the reviewer raised ${scope.length} critical problem(s) outside the task's scope`]
      : stalled.stop ? ["review_stalled", `round ${k}'s review blocks on the same finding(s) as the review before it`]
        : critical.length && cfg.quality_gates.stop_on_critical_issue ? ["critical_finding", `the reviewer reported ${critical.length} critical finding(s)`]
          : fixable.length && k >= LIGHTWEIGHT.reviewRound ? ["review_rounds", `round ${k}'s review still blocks on ${fixable.length} finding(s) after ${k - 1} fix round(s)`]
            : null;
    if (signal) this.escalateProfile(signal[0], signal[1], "CODE_REVIEW");
    if (!fixable.length && !fixableGates.length && (pre.length || scope.length)) {
      // Nothing left the task can fix: another round would loop on an impossible contract, or widen the task. You decide.
      st.preexisting = pre.length ? pre : null;
      const { message, details } = preexistingReview(pre, approved);
      if (scope.length) {
        st.scopePending = scope;
        const next = approved ? "DONE" : "CODE_REVIEW";
        const asked = scopeReview(scope, pre.length ? details : [], next);
        this.escalate("out_of_scope_critical", asked.message, next, asked.details);
        return;
      }
      this.escalate("preexisting_failures", message, approved ? "DONE" : "CODE_REVIEW", details);
      return;
    }
    if (scope.length) {
      // A critical problem outside the task: before a fix round, you decide whether the task takes it on (by re-planning).
      st.scopePending = scope;
      const { message, details } = scopeReview(scope, [], "IMPLEMENT");
      this.escalate("out_of_scope_critical", message, "IMPLEMENT", details);
      return;
    }
    if (stalled.stop) {
      // Fix rounds that move nothing: another one would repeat the same work. You decide; nothing is waived.
      st.stall!.mark = await this.progressMark();
      const { message, details } = stallReview(st.stall!, this.stallItems(cycle, samePlan!, answers, implReport, changedSincePrev));
      this.escalate("review_stalled", message, "IMPLEMENT", details);
      return;
    }
    if (critical.length && cfg.quality_gates.stop_on_critical_issue) {
      this.escalate("critical_finding",
        `the reviewer reported critical finding(s): ${critical.map((f) => `${f.id} ${f.issue}`).join("; ")}. Inspect them, then resume to let the ` +
        "implementer fix them, revise, or abort.", "IMPLEMENT");
      return;
    }
    this.nextImplRound();
  }

  /**
   * What holds a stalled review loop, line by line: each finding that keeps blocking (its identity, the id this review
   * gave it, where it was raised, and the implementer's answer to it), then what the implementer did in the cycle.
   */
  private stallItems(cycle: ReviewCycle, prev: ReviewCycle, answers: FindingResponse[], report: Implementation, changed: Change[] | null): string[] {
    const ledger = this.state.trackedFindings ?? [];
    const items = this.state.stall!.keys.map((key) => {
      const e = ledger.find((x) => x.key === key);
      if (!e) return `required ${key} still fails`;
      const id = e.ids.at(-1)!;
      const answer = answers.find((a) => e.ids.includes(a.id));
      const revisions = [...new Set(e.seen.map((x) => x.revision).filter(Boolean))].map((r) => "`" + r.slice(0, 12) + "`").join(", ");
      return `${key}${id !== key ? ` (${id} in this review)` : ""} [${e.severity}] ${e.file ? `${e.file}: ` : ""}${e.issue} — open since round ` +
        `${e.seen[0]!.round}, raised in rounds ${e.seen.map((x) => x.round).join(", ")}${revisions ? ` on ${revisions}` : ""}; the implementer answered: ` +
        (answer ? `${answer.resolution}${answer.notes ? ` (${answer.notes})` : ""} (round ${answer.round})` : "nothing");
    });
    const files = prev.tree === cycle.tree ? "changed no file"
      : changed?.length ? `changed only ${changed.slice(0, 10).map(([, p]) => p).join(", ")}${changed.length > 10 ? ", …" : ""} (none of these findings' files)`
        : "changed files outside these findings";
    return [...items, `round ${cycle.round}: the implementer reported ${report.status} and ${files}`];
  }

  // ---------------------------------------------------------- human review
  async applyDecision(decision: "resume" | "revise" | "abort", note?: string): Promise<void> {
    const st = this.state;
    if (st.phase !== "HUMAN_REVIEW" || !st.humanReview) throw new DecisionError(`run ${st.taskId} is not waiting for a decision (phase ${st.phase})`);
    // An agent's questions are answered, not decided: a resume or a revise would go on without what it asked for.
    const asked = st.humanReview.reason === "clarification_required" ? pendingEntry(st.clarifications) : null;
    if (asked && decision !== "abort") {
      throw new DecisionError(`run ${st.taskId} waits for your answers to ${asked.source === "planner" ? "the planner's" : "Claude's"} questions: answer them (in the chat or terminal, or with ` +
        "`duo resume --answers <file>`), or abort the run; 'resume' and 'revise' do not answer them");
    }
    if (asked) ledgerClose(st.clarifications!, asked.id, "cancelled", nowIso());
    // Before anything changes: a run whose snapshots are unusable keeps waiting for its decision. Abort needs none.
    if (decision !== "abort") await this.prepare();
    const hr = st.humanReview;
    if (note) st.humanNotes.push({ at: nowIso(), phase: hr.fromPhase, note });
    // Going on after the budget stopped the run is your authorization: one more allowance of each limit it reached.
    const raised = hr.reason === "budget_exhausted" && decision !== "abort" ? raiseReached(st, this.o.cfg) : [];
    // A blocked implementer, or a stalled review loop, runs again only on something new; a resume with nothing new keeps the run waiting.
    const held = decision === "resume" && (await this.blockerHolds(hr) || await this.stallHolds(hr));
    // Going on after a contradiction or pre-existing failures is your acceptance of them, which the run records and says.
    const accepted = decision === "resume" ? acceptPending(st) : [];
    if (decision === "abort") {
      st.phase = "ABORTED";
    } else if (decision === "revise") {
      if (IMPL_PHASES.includes(hr.fromPhase)) st.planFeedback = null; // planning-era critique is stale; the note drives the revision
      st.blocker = null;
      st.stall = null;
      st.planStall = null;
      // Re-planning settles the contract anew: nothing accepted so far, and nothing pending, carries over.
      st.conflicts = null;
      st.preexisting = null;
      st.scopePending = null;
      delete st.accepted;
      st.finalPlanVersion = null;
      st.finalPlanHash = null;
      this.clearEvidence();
      st.planningRound += 1;
      st.limits.planningRounds = Math.max(st.limits.planningRounds, st.planningRound + this.o.cfg.limits.max_planning_rounds - 1);
      st.phase = "PLAN";
    } else if (!held) {
      // Your decision lets the final check try again as often as before, and the planning loop's count start anew.
      st.finalCheck = null;
      st.planStall = null;
      const target = hr.resumePhase;
      if (target === "IMPLEMENT" && st.finalPlanVersion === null) {
        if (!st.planVersion) throw new DecisionError("there is no plan yet; use --decision revise");
        this.freezePlan(st.planVersion, true);
      } else if (target === "IMPLEMENT" && NEW_ROUND_FROM.includes(hr.fromPhase)) {
        st.implRound += 1;
        this.ensureReviewBudget();
      }
      st.consecutiveGateFailures = 0;
      // Never DONE straight from a decision: the files may have changed while the run waited.
      if (target !== "DONE") st.phase = target;
    }
    st.humanReview = null;
    this.message({ from: "human", to: "orchestrator", kind: "decision", headline: `${decision}${note ? ` · "${note}"` : ""}`, items: [...raised, ...accepted] });
    this.record("HUMAN_REVIEW", st.implRound || st.planningRound, "human", decision, note || `after ${hr.reason}`);
    if (decision === "resume" && !held && hr.resumePhase === "DONE") {
      try {
        await this.finalCheck(hr.fromPhase);
      } catch (e) {
        // The check could not look at the files: the review step checks them again, with the step's error handling.
        this.warn(`could not check the final code (${(e as Error).message}): reviewing it again`);
        st.phase = "CODE_REVIEW";
      }
    }
    if (held) {
      // Nothing ran and nothing changed: the run waits again, now saying why.
      const stalled = hr.reason === "review_stalled";
      const { message, details } = stalled ? stallHeldReview(st.stall!) : heldReview(st.blocker!);
      this.escalate(stalled ? "review_stalled" : "no_progress", message, hr.resumePhase, details, hr.fromPhase);
    }
    this.save();
  }

  /**
   * The implementer's blocker holds for a resume into its round: nothing it is given changed since it reported it
   * (src/core/progress.ts), so running it would repeat the same call.
   */
  private async blockerHolds(hr: HumanReview): Promise<boolean> {
    const st = this.state;
    const b = st.blocker;
    if (!b || hr.resumePhase !== "IMPLEMENT" || b.round !== st.implRound || NEW_ROUND_FROM.includes(hr.fromPhase)) return false;
    return changedParts(b.mark, await this.progressMark()).length === 0;
  }

  /**
   * The review loop stalled and nothing the implementer is given changed since (src/core/progress.ts): another fix round
   * would repeat the same work. A note always counts as new: your explicit override, recorded with your decision.
   */
  private async stallHolds(hr: HumanReview): Promise<boolean> {
    const s = this.state.stall;
    if (hr.reason !== "review_stalled" || !s?.mark) return false;
    return changedParts(s.mark, await this.progressMark()).length === 0;
  }

  // ---------------------------------------------------------------- report
  async writeReport(): Promise<string> {
    const st = this.state;
    const { store } = this.o;
    const lastReview = store.exists("review.json") ? store.readJson<{ output: Review }>("review.json").output : null;
    let diffStat = "";
    if (st.base && st.lastSnapshot) {
      try {
        // An aborted or finished run may never have prepared its snapshots, or they may be gone: the report goes without.
        const git = this.snapshots ?? openRunGit(st, this.o.repo, this.o.env ?? process.env);
        diffStat = await git.diffStat(st.base.commit, st.lastSnapshot.commit);
      } catch {
        diffStat = "";
      }
    }
    // What the run spent and where, for comparing profiles (also in the report).
    store.writeJson("metrics.json", render.runMetrics(st));
    return store.writeText("report.md", render.reportMarkdown(st, diffStat, lastReview, this.lastCritique(st.planningRound + 1), store.dir));
  }
}
