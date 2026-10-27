import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { AgentRunner, type AgentResult } from "../agents/runner.js";
import type { SchemaName } from "../agents/schema.js";
import type { Decider, DuoEvent, EventBus, HistoryEntry, Message, Party, Phase, Role } from "../events.js";
import type { AgentRole, ConfigData } from "./config.js";
import { GatesInterrupted, requiredPassed, runGates, type GateResult } from "./gates.js";
import { Git } from "./git.js";
import { checkChanges, checkGitPosition } from "./guards.js";
import type { Approval, Critique, Finding, Implementation, Issue, Plan, Review } from "./outputs.js";
import * as prompts from "./prompts.js";
import * as render from "./render.js";
import { nowIso, type RunState, type RunStore } from "./state.js";

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
const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

class Interrupted extends Error {}

export class DecisionError extends Error {
  override name = "DecisionError";
}

export interface WorkflowOptions {
  cfg: ConfigData;
  repo: string;
  store: RunStore;
  state: RunState;
  bus: EventBus;
  decider: Decider;
  allowDirty?: boolean;
  runner?: AgentRunner;
}

function relativeInside(path: string, root: string): string | null {
  const rel = relative(resolve(root), resolve(path));
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split("\\").join("/") : null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const planHash = (plan: Plan) => createHash("sha256").update(stableStringify(plan)).digest("hex");

function consistentStatus(d: { approved: boolean; status: string }): string[] {
  return d.approved !== (d.status === "approved") ? [`'approved' (${d.approved}) contradicts 'status' ('${d.status}')`] : [];
}

const bySeverity = <T extends { severity: string }>(xs: T[]) =>
  [...xs].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
const issueItems = (issues: Issue[]) => bySeverity(issues).map((i) => `[${i.severity}] ${i.id} ${i.description}`);
const findingItems = (findings: Finding[]) =>
  bySeverity(findings).map((f) => `[${f.severity}] ${f.id} ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} ` : ""}${f.issue}`);

function lastLine(text: string): string {
  const line = text.trim().split("\n").filter((l) => l.trim()).at(-1) ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

export class Workflow {
  private readonly git: Git;
  private readonly runner: AgentRunner;
  private readonly snapshotExclude: string[];
  private readonly dirtyExclude: string[];
  private readonly allowDirty: boolean;
  private readonly abort = new AbortController();
  private stopRequested = false;
  private phaseStartedAt = Date.now();

  constructor(private readonly o: WorkflowOptions) {
    this.git = new Git(o.repo);
    this.runner = o.runner ?? new AgentRunner(o.cfg, o.repo, o.store.path("logs"), o.bus);
    const runsRel = relativeInside(o.store.runsDir, o.repo);
    this.snapshotExclude = runsRel ? [runsRel] : [];
    this.dirtyExclude = [".agentduo", ...this.snapshotExclude.filter((p) => !p.startsWith(".agentduo"))];
    this.allowDirty = !!o.allowDirty || o.cfg.safety.allow_dirty_worktree;
  }

  get state(): RunState {
    return this.o.state;
  }

  /** Stop cleanly after the step that is running now; the run stays resumable. */
  requestStop(): void {
    this.stopRequested = true;
  }

  /** Kill the running agent or gate now; that step re-runs on resume. */
  interrupt(): void {
    this.abort.abort();
  }

  // ------------------------------------------------------------------ loop
  async run(): Promise<number> {
    const st = this.state;
    this.emit({ type: "run.started", runId: st.taskId, task: st.task, repo: this.o.repo, runDir: this.o.store.dir });
    if (st.inProgress) this.emit({ type: "warning", text: `previous run was interrupted during ${st.inProgress.phase}; re-running it` });
    for (;;) {
      const phase = st.phase;
      if (phase === "DONE") return this.finish("DONE", EXIT.DONE);
      if (phase === "ABORTED") return this.finish("ABORTED", EXIT.ABORTED);
      if (phase === "HUMAN_REVIEW") {
        st.inProgress = null;
        this.save();
        await this.writeReport();
        const review = st.humanReview!;
        this.emit({ type: "human.required", runId: st.taskId, review });
        const answer = await this.o.decider.decide(review);
        if (answer === "defer") return this.finish("HUMAN_REVIEW", EXIT.HUMAN_REVIEW);
        await this.applyDecision(answer.decision, answer.note);
        continue;
      }
      if (this.stopRequested) return this.finish("INTERRUPTED", EXIT.INTERRUPTED);
      st.inProgress = { phase, startedAt: nowIso() };
      this.save();
      this.phaseStartedAt = Date.now();
      this.emitPhaseStarted(phase);
      try {
        await this.handler(phase)();
      } catch (err) {
        if (err instanceof Interrupted || this.abort.signal.aborted) return this.finish("INTERRUPTED", EXIT.INTERRUPTED);
        const e = err as Error;
        this.o.store.writeText(`logs/error-step${String(st.step + 1).padStart(3, "0")}.txt`, e.stack ?? String(e));
        this.escalate("orchestrator_error", `${e.name}: ${e.message}`, phase);
      }
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
    this.emit({ type: "run.finished", runId: this.state.taskId, phase, reportPath, exitCode });
    return exitCode;
  }

  // --------------------------------------------------------------- helpers
  private emit(event: DuoEvent): void {
    this.o.bus.emit(event);
  }

  private save(): void {
    this.o.store.saveState(this.state);
  }

  private ctx(): prompts.PromptContext {
    const st = this.state;
    return { repo: this.o.repo, taskId: st.taskId, task: st.task, gates: this.o.cfg.gates, notes: st.humanNotes };
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

  private emitPhaseStarted(phase: Phase): void {
    const st = this.state;
    const info = PHASE_ROLES[phase];
    this.emit({
      type: "phase.started", step: st.step + 1, phase,
      round: IMPL_PHASES.includes(phase) ? Math.max(st.implRound, 1) : st.planningRound,
      role: info?.role, agent: phase === "VERIFY" ? "gates" : info ? this.party(info.agentRole) : undefined,
      planning: { round: st.planningRound, limit: st.limits.planningRounds },
      impl: { round: st.implRound, limit: st.limits.reviewRounds },
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

  private escalate(reason: string, message: string, resumePhase: Phase, details: string[] = []): void {
    const st = this.state;
    const fromPhase = st.phase;
    st.humanReview = { reason, message, fromPhase, resumePhase, details, at: nowIso() };
    st.phase = "HUMAN_REVIEW";
    this.record("HUMAN_REVIEW", IMPL_PHASES.includes(fromPhase) ? st.implRound : st.planningRound, "orchestrator", reason, message, "warn");
  }

  private async envelope(role: Role, round: number, r: AgentResult, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const st = this.state;
    return {
      task_id: st.taskId, role, agent: r.backend, round, timestamp: nowIso(), git_sha: await this.git.head(),
      plan_version: st.planVersion, attempts: r.attempts, duration_sec: Math.round(r.durationSec * 10) / 10,
      cost_usd: r.costUsd, tokens: r.tokens, meta: r.meta, ...extra, output: r.data,
    };
  }

  private addUsage(r: AgentResult): void {
    const st = this.state;
    if (r.costUsd) st.costUsd = Math.round((st.costUsd + r.costUsd) * 10000) / 10000;
    if (r.tokens) st.tokens += r.tokens;
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
   * Run a read-only role and verify, independently of the agent's own sandbox, that the working tree and
   * git position did not change.
   */
  private async readonlyCall<T>(role: Role, agentRole: AgentRole, label: string, prompt: string, schemaName: SchemaName,
    round: number, check?: (data: T) => string[]): Promise<AgentResult | null> {
    const beforeTree = await this.tree();
    const beforePos = await this.git.position();
    const r = await this.runner.call({ role, agentRole, prompt, schemaName, logPrefix: this.logPrefix(label, round), check, signal: this.abort.signal });
    this.addUsage(r);
    if (r.interrupted) throw new Interrupted();
    const afterTree = await this.tree();
    const violations = checkGitPosition(beforePos, await this.git.position());
    if (afterTree !== beforeTree) {
      const changed = await this.git.nameStatus(beforeTree, afterTree);
      violations.unshift(`working tree changed during a read-only step: ${changed.slice(0, 20).map(([s, p]) => `${s} ${p}`).join(", ")}`);
    }
    const who = `${role} (${r.backend})`;
    if (violations.length) {
      this.escalate("readonly_violation", `${who} changed the repository although it must be read-only. Inspect and revert the changes, then resume to re-run this step.`,
        this.state.phase, violations);
      return null;
    }
    if (!r.ok) {
      this.escalate("agent_error", `${who} failed after ${r.attempts} attempt(s): ${r.error}`, this.state.phase);
      return null;
    }
    return r;
  }

  // -------------------------------------------------------------- planning
  private async stepPlan(): Promise<void> {
    const st = this.state;
    const { store } = this.o;
    const r = st.planningRound;
    const v = st.planVersion + 1;
    const previous = v > 1 ? store.readJson<{ output: Plan }>(`plan.v${v - 1}.json`).output : null;
    const prompt = prompts.planner(this.ctx(), r, v, previous, st.planFeedback);
    const check = (p: Plan) => (["goals", "scope_in", "steps", "acceptance_criteria"] as const).filter((k) => p[k].length === 0).map((k) => `'${k}' must not be empty`);
    const res = await this.readonlyCall<Plan>("planner", "planner", "plan", prompt, "plan", r, check);
    if (!res) return;
    const plan = res.data as Plan;
    store.writeJson(`plan.v${v}.json`, await this.envelope("planner", r, res, { plan_version: v }));
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
    st.phase = "PLAN_REVIEW";
  }

  private async stepPlanReview(): Promise<void> {
    const st = this.state;
    const { store, cfg } = this.o;
    const r = st.planningRound;
    const v = st.planVersion;
    const prompt = prompts.planReviewer(this.ctx(), r, v, store.readText(`plan.v${v}.md`), this.lastCritique(r));
    const res = await this.readonlyCall<Critique>("plan_reviewer", "plan_reviewer", "plan_review", prompt, "plan_critique", r, consistentStatus);
    if (!res) return;
    const critique = res.data as Critique;
    store.writeJson(`critique.r${r}.json`, await this.envelope("plan_reviewer", r, res));
    store.appendText("plan-feedback.md", render.critiqueMarkdown(critique, r, v, this.agentName("plan_reviewer")));
    const blocking = this.blocking(critique.issues);
    const approved = critique.approved && blocking.length === 0;
    if (critique.approved && blocking.length) this.emit({ type: "warning", text: "the critic approved but raised blocking issues; treating as changes requested" });
    this.message({
      from: this.party("plan_reviewer"), to: this.party("planner"), kind: "critique",
      headline: approved ? `approved${critique.issues.length ? ` · ${critique.issues.length} suggestion(s)` : ""}` : `changes requested · ${blocking.length} blocking`,
      items: issueItems(critique.issues), artifact: `critique.r${r}.json`,
    });
    this.record("PLAN_REVIEW", r, this.agentName("plan_reviewer"), approved ? "approved" : "changes requested",
      `${critique.issues.length} issue(s), ${blocking.length} blocking`, approved ? "ok" : "warn", `critique.r${r}.json`, res);
    if (!approved) {
      st.planFeedback = { critique };
      this.nextPlanningRound();
    } else if (cfg.quality_gates.require_plan_approval) {
      st.phase = "PLAN_FINALIZE";
    } else {
      this.freezePlan(v);
    }
  }

  private async stepPlanFinalize(): Promise<void> {
    const st = this.state;
    const { store } = this.o;
    const r = st.planningRound;
    const v = st.planVersion;
    const critique = store.readJson<{ output: Critique }>(`critique.r${r}.json`).output;
    const prompt = prompts.planFinalizer(this.ctx(), r, v, store.readText(`plan.v${v}.md`), critique);
    const res = await this.readonlyCall<Approval>("plan_finalizer", "planner", "plan_finalize", prompt, "plan_approval", r, consistentStatus);
    if (!res) return;
    const approval = res.data as Approval;
    store.writeJson(`approval.r${r}.json`, await this.envelope("plan_finalizer", r, res));
    store.appendText("plan-feedback.md", render.approvalMarkdown(approval, r, v, this.agentName("planner")));
    const blocking = this.blocking(approval.issues);
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
      // Re-planned after implementation started: continue in a new round.
      st.implRound += 1;
      st.openFindings = [];
      this.ensureReviewBudget();
    }
    if (cfg.safety.pause_before_implement && !byHuman) {
      this.escalate("plan_ready", `final plan v${version} is ready for your review (${store.path("plan.final.md")}). Resume to start implementation.`, "IMPLEMENT");
      return;
    }
    st.phase = "IMPLEMENT";
  }

  // -------------------------------------------------------- implementation
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
      const dirty = await this.git.statusPorcelain(this.dirtyExclude);
      if (dirty.length && !this.allowDirty) {
        this.escalate("dirty_worktree",
          `the working tree has ${dirty.length} uncommitted change(s). Commit or stash them, then resume (or resume with --allow-dirty ` +
          "to let the implementer work on top of them).", "IMPLEMENT", dirty.slice(0, 20));
        return;
      }
      const base = await this.git.snapshot(this.snapshotExclude, this.ref("base"), `agentduo ${st.taskId}: base`);
      st.base = { commit: base.commit, tree: base.tree, head: await this.git.head(), branch: await this.git.branch(), dirty: dirty.length > 0 };
      st.implRound = Math.max(st.implRound, 1);
    }
    const k = st.implRound;
    const protectedPaths = [...cfg.safety.protected_paths];
    const pre = await this.git.snapshot(this.snapshotExclude, this.ref(`impl-r${k}-pre`), `agentduo ${st.taskId}: before implementation round ${k}`);
    const beforePos = await this.git.position();
    const review = store.exists("review.json") ? store.readJson<{ output: Review }>("review.json").output : null;
    const failed = k > 1 ? (st.lastGates ?? []).filter((g) => !g.passed) : [];
    const prompt = prompts.implementer(this.ctx(), k, store.readText("plan.final.md"), protectedPaths, st.openFindings, review, failed, st.lastImplementation);
    const check = (rep: Implementation) =>
      rep.status === "blocked" && !(rep.blocking_reason ?? "").trim() ? ["status is 'blocked' but blocking_reason is empty"] : [];
    const res = await this.runner.call({
      role: "implementer", agentRole: "implementer", prompt, schemaName: "implementation", logPrefix: this.logPrefix("implement", k),
      check, extraAllowed: cfg.gates.map((g) => `Bash(${g.command}*)`), signal: this.abort.signal,
    });
    this.addUsage(res);
    const post = await this.git.snapshot(this.snapshotExclude, this.ref(`impl-r${k}`), `agentduo ${st.taskId}: implementation round ${k}`);
    st.lastSnapshot = { commit: post.commit, tree: post.tree };
    if (res.interrupted) throw new Interrupted();
    const changes = await this.git.nameStatus(pre.tree, post.tree);
    const violations = [...checkGitPosition(beforePos, await this.git.position()), ...checkChanges(changes, protectedPaths, cfg.safety.max_deleted_files)];
    const denials = res.meta.permissionDenials ?? [];
    const report = res.data as Implementation | null;
    const answered = new Set((report?.addressed_findings ?? []).map((a) => a.finding_id));
    const missing = report ? st.openFindings.filter((f) => !answered.has(f.id)).map((f) => f.id) : [];
    store.writeJson(`implementation.r${k}.json`, await this.envelope("implementer", k, res, {
      pre_snapshot: pre.commit, snapshot: post.commit, changes: changes.map(([status, path]) => ({ status, path })),
      violations, unanswered_findings: missing,
    }));
    st.lastImplementation = { round: k, summary: report?.summary ?? null, status: report?.status ?? null, permissionDenials: denials };
    if (!res.ok || !report) {
      this.escalate("agent_error", `implementer (${res.backend}) failed after ${res.attempts} attempt(s): ${res.error}`, "IMPLEMENT");
      return;
    }
    if (violations.length) {
      this.escalate("guard_violation",
        `the implementer broke a safety rule. Inspect the working tree; the state before this round is pinned at ${this.ref(`impl-r${k}-pre`)} ` +
        `(${pre.commit.slice(0, 12)}). Resume to accept the changes and continue with the quality gates, or abort.`, "VERIFY", violations);
      return;
    }
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
    if (missing.length) this.emit({ type: "warning", text: `implementer did not respond to finding(s): ${missing.join(", ")}` });
    if (denials.length) this.emit({ type: "warning", text: `${denials.length} tool call(s) were denied by permissions (see implementation.r${k}.json)` });
    if (report.status === "blocked") {
      this.escalate("implementer_blocked", report.blocking_reason ?? "implementer reported blocked", "IMPLEMENT");
      return;
    }
    st.phase = "VERIFY";
  }

  private async stepVerify(): Promise<void> {
    const st = this.state;
    const { store, cfg } = this.o;
    const k = st.implRound;
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
    if (tree !== st.lastSnapshot!.tree) {
      const changed = await this.git.nameStatus(st.lastSnapshot!.tree, tree);
      this.emit({ type: "warning", text: `quality gates modified the working tree: ${changed.slice(0, 10).map(([s, p]) => `${s} ${p}`).join(", ")} (re-snapshotting)` });
      const snap = await this.git.snapshot(this.snapshotExclude, this.ref(`impl-r${k}`), `agentduo ${st.taskId}: round ${k} after gates`);
      st.lastSnapshot = { commit: snap.commit, tree: snap.tree };
    }
    store.writeJson(`gates.r${k}.json`, { round: k, snapshot: st.lastSnapshot!.commit, timestamp: nowIso(), results });
    st.lastGates = results;
    const passed = requiredPassed(results);
    st.consecutiveGateFailures = passed ? 0 : st.consecutiveGateFailures + 1;
    const enforce = cfg.quality_gates.require_tests_pass;
    const toReviewer = passed || !enforce || cfg.quality_gates.review_on_gate_failure;
    this.message({
      from: "gates", to: toReviewer ? this.party("code_reviewer") : this.party("implementer"), kind: "gates",
      headline: results.map((g) => (g.passed ? `${g.name} ✓` : `${g.name} ✗ (${g.timedOut ? "timeout" : `exit ${g.exitCode}`})`)).join(" · ") || "no gates",
      items: results.filter((g) => !g.passed).map((g) => `${g.name}: ${lastLine(g.outputTail)}`), artifact: `gates.r${k}.json`,
    });
    this.record("VERIFY", k, "gates", passed ? "passed" : "failed", results.map((g) => `${g.name} ${g.passed ? "PASS" : "FAIL"}`).join(", ") || "no gates",
      passed ? "ok" : "warn", `gates.r${k}.json`);
    if (!passed && enforce) {
      const limit = cfg.limits.max_consecutive_gate_failures;
      if (st.consecutiveGateFailures >= limit) {
        this.escalate("gates_failing", `required quality gates failed ${limit} round(s) in a row. Check the logs under gates/, then resume (optionally with a --note) or abort.`, "IMPLEMENT");
        return;
      }
      if (!cfg.quality_gates.review_on_gate_failure) {
        this.nextImplRound(); // back to the implementer without spending a review
        return;
      }
    }
    st.phase = "CODE_REVIEW";
  }

  private async stepCodeReview(): Promise<void> {
    const st = this.state;
    const { store, cfg } = this.o;
    const k = st.implRound;
    const base = st.base!.commit;
    const snap = st.lastSnapshot!.commit;
    const diff = await this.git.diff(base, snap);
    const maxChars = cfg.limits.max_diff_chars;
    const implReport = store.readJson<{ output: Implementation }>(`implementation.r${k}.json`).output;
    const prompt = prompts.codeReviewer(this.ctx(), k, store.readText("plan.final.md"), base, snap, st.lastGates ?? [],
      await this.git.diffStat(base, snap), diff.slice(0, maxChars), diff.length > maxChars, st.openFindings, implReport);
    const check = (rv: Review) => {
      const errors = consistentStatus(rv);
      if (rv.reviewed_commit !== snap) errors.push(`reviewed_commit is '${rv.reviewed_commit}', expected '${snap}'`);
      return errors;
    };
    const res = await this.readonlyCall<Review>("code_reviewer", "code_reviewer", "code_review", prompt, "review", k, check);
    if (!res) return;
    const review = res.data as Review;
    const envelope = await this.envelope("code_reviewer", k, res, { base, snapshot: snap });
    store.writeJson(`review.r${k}.json`, envelope);
    store.writeJson("review.json", envelope);
    st.openFindings = review.findings;
    const blocking = this.blocking(review.findings);
    const critical = review.findings.filter((f) => f.severity === "critical");
    const gatesOk = requiredPassed(st.lastGates ?? []) || !cfg.quality_gates.require_tests_pass;
    const approved = review.approved || !cfg.quality_gates.require_codex_approval;
    const done = approved && blocking.length === 0 && gatesOk;
    if (review.approved && blocking.length) this.emit({ type: "warning", text: "the reviewer approved but reported blocking findings; continuing with a fix round" });
    this.message({
      from: this.party("code_reviewer"), to: this.party("implementer"), kind: "review",
      headline: done
        ? `approved${review.findings.length ? ` · ${review.findings.length} non-blocking finding(s)` : ""}`
        : `${review.findings.length} finding(s) · ${blocking.length} blocking${gatesOk ? "" : " · required gates failing"}`,
      items: findingItems(review.findings), artifact: `review.r${k}.json`,
    });
    this.record("CODE_REVIEW", k, this.agentName("code_reviewer"), done ? "approved" : "changes requested",
      `${review.findings.length} finding(s), ${blocking.length} blocking${gatesOk ? "" : ", required gates failing"}`, done ? "ok" : "warn", `review.r${k}.json`, res);
    if (done) {
      st.phase = "DONE";
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

  // ---------------------------------------------------------- human review
  async applyDecision(decision: "resume" | "revise" | "abort", note?: string): Promise<void> {
    const st = this.state;
    if (st.phase !== "HUMAN_REVIEW" || !st.humanReview) throw new DecisionError(`run ${st.taskId} is not waiting for a decision (phase ${st.phase})`);
    const hr = st.humanReview;
    if (note) st.humanNotes.push({ at: nowIso(), phase: hr.fromPhase, note });
    if (decision === "abort") {
      st.phase = "ABORTED";
    } else if (decision === "revise") {
      if (IMPL_PHASES.includes(hr.fromPhase)) st.planFeedback = null; // planning-era critique is stale; the note drives the revision
      st.finalPlanVersion = null;
      st.finalPlanHash = null;
      st.planningRound += 1;
      st.limits.planningRounds = Math.max(st.limits.planningRounds, st.planningRound + this.o.cfg.limits.max_planning_rounds - 1);
      st.phase = "PLAN";
    } else {
      const target = hr.resumePhase;
      if (target === "IMPLEMENT" && st.finalPlanVersion === null) {
        if (!st.planVersion) throw new DecisionError("there is no plan yet; use --decision revise");
        this.freezePlan(st.planVersion, true);
      } else if (target === "IMPLEMENT" && NEW_ROUND_FROM.includes(hr.fromPhase)) {
        st.implRound += 1;
        this.ensureReviewBudget();
      }
      st.consecutiveGateFailures = 0;
      st.phase = target;
    }
    st.humanReview = null;
    this.message({ from: "human", to: "orchestrator", kind: "decision", headline: `${decision}${note ? ` · "${note}"` : ""}`, items: [] });
    this.record("HUMAN_REVIEW", st.implRound || st.planningRound, "human", decision, note || `after ${hr.reason}`);
    this.save();
  }

  // ---------------------------------------------------------------- report
  async writeReport(): Promise<string> {
    const st = this.state;
    const { store } = this.o;
    const lastReview = store.exists("review.json") ? store.readJson<{ output: Review }>("review.json").output : null;
    let diffStat = "";
    if (st.base && st.lastSnapshot) {
      try {
        diffStat = await this.git.diffStat(st.base.commit, st.lastSnapshot.commit);
      } catch {
        diffStat = "";
      }
    }
    return store.writeText("report.md", render.reportMarkdown(st, diffStat, lastReview, this.lastCritique(st.planningRound + 1), store.dir));
  }
}
