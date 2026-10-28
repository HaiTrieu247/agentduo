import { resolve } from "node:path";
import { killAllActive } from "../../../src/agents/process.js";
import { Chat, resumeHint, type ChatUi } from "../../../src/chat.js";
import { ConfigError, type ConfigData } from "../../../src/core/config.js";
import type { Check } from "../../../src/core/doctor.js";
import { diagnose, EnvironmentError, prepareEnvironment, runnableProblem, type WorkspaceEnv } from "../../../src/core/environment.js";
import type { Review } from "../../../src/core/outputs.js";
import { findingsMarkdown } from "../../../src/core/render.js";
import { editMode } from "../../../src/core/settings.js";
import { acquireWorkspaceLock, LockError, RunStore, workspaceBusy, workspaceLockHolder, type RunState } from "../../../src/core/state.js";
import { EventBus, type DuoEvent, type HumanReview, type PermissionAnswer } from "../../../src/events.js";
import { packageVersion } from "../../../src/paths.js";
import { PIPELINE } from "../../../src/ui/format.js";
import { DecisionBroker, PermissionBroker } from "./decisionBroker.js";
import type {
  ArtifactContent, ArtifactName, ChangeList, DecisionAnswer, FocusedRun, InitializeResult, PipelineStep, Problem, SnapshotFile, SnapshotSide,
  UiUpdate, WorkerErrorCode,
} from "./protocol.js";

/** After a shutdown asks the agents to stop, give them this long before they are killed outright. */
export const HARD_KILL_MS = 1500;
/** Snapshot files larger than this get no text diff. */
const MAX_DIFF_BYTES = 5 * 1024 * 1024;

export class SessionError extends Error {
  constructor(readonly code: WorkerErrorCode, message: string) {
    super(message);
  }
}

export interface RuntimeSink {
  event(event: DuoEvent): void;
  ui(update: UiUpdate): void;
  decisionOpened(requestId: string, review: HumanReview, views: ArtifactName[]): void;
  decisionClosed(requestId: string): void;
}

type Run = { store: RunStore; state: RunState };

/** The flow the config sets up, with who plays each phase (VERIFY only with gates, sign-off only when required). */
export function pipelineOf(cfg: ConfigData): PipelineStep[] {
  const steps: PipelineStep[] = [];
  const label = (phase: PipelineStep["phase"]) => PIPELINE.find((p) => p.phase === phase)?.label ?? phase;
  const add = (phase: PipelineStep["phase"], role: PipelineStep["role"], agent: PipelineStep["agent"]) => steps.push({ phase, label: label(phase), role, agent });
  const agents = cfg.agents ?? {};
  add("PLAN", "planner", agents.planner ?? null);
  add("PLAN_REVIEW", "plan_reviewer", agents.plan_reviewer ?? null);
  if (cfg.quality_gates?.require_plan_approval !== false) add("PLAN_FINALIZE", "plan_finalizer", agents.planner ?? null);
  add("IMPLEMENT", "implementer", agents.implementer ?? null);
  if (Array.isArray(cfg.gates) && cfg.gates.length) add("VERIFY", null, "gates");
  add("CODE_REVIEW", "code_reviewer", agents.code_reviewer ?? null);
  return steps;
}

/** An unvalidated config may hold anything; the edit mode is only shown. */
function safeEditMode(cfg: ConfigData): string {
  try {
    return editMode(cfg);
  } catch {
    return "ask";
  }
}

const isBinary = (data: Buffer) => data.subarray(0, 8000).includes(0);

/**
 * The engine side of the sidebar, in the worker: the CLI's Chat, the workspace lock, and the brokers that carry
 * decisions and permission prompts to the user. Opening the sidebar only reads; the lock is taken when the user
 * first acts (as `duo` does when its chat opens) and held until /quit or shutdown.
 */
export class RuntimeSession {
  private env: WorkspaceEnv | null = null;
  private chat: Chat | null = null;
  private release: (() => void) | null = null;
  private readonly bus = new EventBus();
  private readonly decisions: DecisionBroker;
  private readonly permissions = new PermissionBroker();
  private chain: Promise<unknown> = Promise.resolve();
  /** Snapshots this worker has listed ("runId commit" → tree), so a diff of an earlier round stays readable. */
  private readonly listed = new Map<string, string>();
  private closing = false;
  private stopped: Promise<void> | null = null;
  private readonly ui: ChatUi;

  constructor(private readonly o: { workspace: string; configPath: string | null; env: NodeJS.ProcessEnv; sink: RuntimeSink }) {
    this.bus.on((event) => o.sink.event(event));
    this.decisions = new DecisionBroker({
      opened: (id, review) => o.sink.decisionOpened(id, review, this.artifactsOf(this.focus())),
      closed: (id) => o.sink.decisionClosed(id),
    });
    this.ui = {
      info: (text) => o.sink.ui({ type: "info", text }),
      setStatus: (status) => o.sink.ui({ type: "status", status }),
      setEdits: (mode) => o.sink.ui({ type: "edits", mode }),
      // /quit: leave the chat as `duo` does, which here means giving the workspace back.
      exit: () => void this.serial(() => this.endSession()),
    };
  }

  get active(): boolean {
    return !!this.chat;
  }

  private async prepare(): Promise<WorkspaceEnv> {
    this.env = await prepareEnvironment({ cwd: this.o.workspace, configPath: this.o.configPath ?? undefined, env: this.o.env });
    return this.env;
  }

  /** Only looks: loads the config, checks that agents could run, and finds a run to offer; takes no lock, writes nothing. */
  async initialize(): Promise<InitializeResult> {
    const result: InitializeResult = {
      version: packageVersion(), node: process.versions.node, workspace: resolve(this.o.workspace), runsDir: null, configFile: null, configSources: [],
      pipeline: [], edits: "ask", warnings: [], problem: null, hint: null,
    };
    let env: WorkspaceEnv;
    try {
      env = await this.prepare();
    } catch (e) {
      if (e instanceof EnvironmentError) return { ...result, problem: { kind: "environment", message: e.message } };
      if (e instanceof ConfigError) return { ...result, problem: { kind: "config", message: e.message } };
      throw e;
    }
    const holder = workspaceLockHolder(env.runsDir);
    const locked: Problem | null = holder && holder !== process.pid ? { kind: "locked", message: workspaceBusy(holder) } : null;
    return {
      ...result, workspace: env.workspace, runsDir: env.runsDir, configFile: env.configFile, configSources: env.sources,
      pipeline: pipelineOf(env.cfg), edits: safeEditMode(env.cfg), warnings: env.warnings,
      problem: runnableProblem(env, env.cfg, env.sources.join(", "), this.o.env) ?? locked,
      hint: resumeHint(env.runsDir, env.workspace),
    };
  }

  /** Session mutations run one at a time; decisions and permission answers never wait for them. */
  private serial<T>(op: () => Promise<T>): Promise<T> {
    const next = this.chain.then(op);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** The chat session, started on first use: the config is read again, then the workspace lock is taken. */
  private async ensureSession(): Promise<Chat> {
    if (this.closing) throw new SessionError("shutting_down", "agentduo is shutting down");
    if (this.chat) return this.chat;
    let env: WorkspaceEnv;
    try {
      env = await this.prepare();
    } catch (e) {
      if (e instanceof EnvironmentError) throw new SessionError("environment", e.message);
      if (e instanceof ConfigError) throw new SessionError("config", e.message);
      throw e;
    }
    for (const warning of env.warnings) this.ui.info(`warning: ${warning}`);
    const problem = runnableProblem(env, env.cfg, env.sources.join(", "), this.o.env);
    if (problem) throw new SessionError(problem.kind, problem.message);
    let release: () => void;
    try {
      release = acquireWorkspaceLock(env.runsDir);
    } catch (e) {
      if (e instanceof LockError) throw new SessionError("locked", e.message);
      throw e;
    }
    if (this.closing) {
      release();
      throw new SessionError("shutting_down", "agentduo is shutting down");
    }
    this.release = release;
    this.chat = new Chat({
      cfg: env.cfg, workspace: env.workspace, runsDir: env.runsDir, configFile: env.configFile, bus: this.bus,
      decider: this.decisions, permissions: this.permissions, ui: this.ui,
    });
    this.o.sink.ui({ type: "pipeline", pipeline: pipelineOf(env.cfg) });
    this.o.sink.ui({ type: "edits", mode: editMode(env.cfg) });
    this.o.sink.ui({ type: "session", session: "active" });
    return this.chat;
  }

  submit(text: string): Promise<void> {
    return this.serial(async () => {
      if (!this.chat && /^\/(quit|exit)\b/.test(text.trim())) {
        this.ui.info("No session is open; the workspace is not locked.");
        return;
      }
      await (await this.ensureSession()).submit(text);
    });
  }

  toggleEdits(): Promise<void> {
    return this.serial(async () => (await this.ensureSession()).toggleEdits());
  }

  /** Esc: stops the running step; the next message re-runs it. */
  interrupt(): Promise<void> {
    return this.serial(async () => this.chat?.escape());
  }

  answerDecision(requestId: string, answer: DecisionAnswer): void {
    if (!this.decisions.answer(requestId, answer)) throw new SessionError("stale", "this decision was already answered or is no longer pending");
  }

  answerPermission(requestId: string, answer: PermissionAnswer): void {
    if (!this.permissions.answer(requestId, answer)) throw new SessionError("stale", "this permission prompt was already answered or is no longer pending");
  }

  /**
   * Denies every open permission prompt and waits (briefly) until the runner has written each answer to the agent:
   * a control_request must always get its control_response, even when the agent is stopped right after.
   */
  private async denyPermissions(close: boolean): Promise<void> {
    const open = new Set(this.permissions.pending());
    const written = new Promise<void>((resolve) => {
      if (!open.size) return resolve();
      const timer = setTimeout(done, 500);
      const off = this.bus.on((e) => {
        if (e.type === "permission.answered" && open.delete(e.id) && !open.size) done();
      });
      function done() {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
    this.permissions.denyAll(close);
    await written;
  }

  /** /quit: a running run stops at its step and stays resumable; the lock goes back. */
  private async endSession(): Promise<void> {
    const chat = this.chat;
    if (!chat) return;
    this.decisions.deferAll();
    await this.denyPermissions(false);
    await chat.stop();
    this.chat = null;
    this.release?.();
    this.release = null;
    this.o.sink.ui({ type: "status", status: "idle" });
    this.o.sink.ui({ type: "session", session: "ended" });
    this.ui.info("Session ended: the workspace is free for `duo` again. Type a task to start a new session.");
  }

  /**
   * Leaves nothing behind: waiting decisions are deferred and permission prompts denied (interrupting a run does
   * not settle them), the run stops at its step and stays resumable, and agents still alive after HARD_KILL_MS die.
   */
  shutdown(): Promise<void> {
    this.stopped ??= (async () => {
      this.closing = true;
      this.decisions.deferAll(true);
      const hard = setTimeout(() => killAllActive(), HARD_KILL_MS);
      await this.denyPermissions(true);
      try {
        await this.chat?.stop();
      } finally {
        clearTimeout(hard);
        this.chat = null;
        this.release?.();
        this.release = null;
      }
    })();
    return this.stopped;
  }

  // ------------------------------------------------------------ run artifacts
  private sameWorkspace(st: RunState): boolean {
    return !st.workspace || resolve(st.workspace) === resolve(this.env?.workspace ?? this.o.workspace);
  }

  /** The run the sidebar talks about: the chat's, or else the workspace's latest (after a reload). */
  private focus(): Run | null {
    const focused = this.chat?.focused();
    if (focused) return focused;
    if (!this.env) return null;
    try {
      const store = RunStore.open(this.env.runsDir);
      const state = store.loadState();
      return this.sameWorkspace(state) ? { store, state } : null;
    } catch {
      return null;
    }
  }

  private runById(runId: string): Run | null {
    const focused = this.focus();
    if (focused?.store.taskId === runId) return focused;
    if (!this.env) return null;
    try {
      const store = RunStore.open(this.env.runsDir, runId);
      const state = store.loadState();
      return this.sameWorkspace(state) ? { store, state } : null;
    } catch {
      return null;
    }
  }

  private artifactsOf(run: Run | null): ArtifactName[] {
    if (!run) return [];
    const { store } = run;
    const out: ArtifactName[] = [];
    if (store.exists("plan.final.md") || store.exists("plan.md")) out.push("plan");
    if (store.exists("review.json")) out.push("review");
    if (store.exists("plan-feedback.md")) out.push("feedback");
    if (store.exists("report.md")) out.push("report");
    return out;
  }

  inspectFocusedRun(): FocusedRun | null {
    const run = this.focus();
    if (!run) return null;
    const st = run.state;
    return { runId: st.taskId, task: st.task, phase: st.phase, artifacts: this.artifactsOf(run), hasSnapshots: !!(st.base && st.lastSnapshot) };
  }

  readArtifact(artifact: ArtifactName): ArtifactContent {
    const run = this.focus();
    if (!run) throw new SessionError("no_run", "There is no run yet. Type a task to start one.");
    const { store } = run;
    const runId = store.taskId;
    const missing = (what: string) => new SessionError("not_found", `Run ${runId} has no ${what} yet.`);
    switch (artifact) {
      case "plan": {
        const name = store.exists("plan.final.md") ? "plan.final.md" : store.exists("plan.md") ? "plan.md" : null;
        if (!name) throw missing("plan");
        return { runId, artifact, text: store.readText(name) };
      }
      case "review": {
        if (!store.exists("review.json")) throw missing("code review");
        const envelope = store.readJson<{ output: Review }>("review.json");
        const r = envelope.output;
        return { runId, artifact, text: `# Code review: ${r.status}\n\nReviewed commit \`${r.reviewed_commit}\`\n\n${r.summary}\n\n## Findings\n\n${findingsMarkdown(r.findings)}\n` };
      }
      case "feedback":
        if (!store.exists("plan-feedback.md")) throw missing("plan feedback");
        return { runId, artifact, text: store.readText("plan-feedback.md") };
      case "report":
        if (!store.exists("report.md")) throw missing("report");
        return { runId, artifact, text: store.readText("report.md") };
    }
  }

  /** What the run changed: its base snapshot against its last one, never HEAD (the workspace may have been dirty). */
  async listChanges(): Promise<ChangeList> {
    const run = this.focus();
    if (!run || !this.env) throw new SessionError("no_run", "There is no run yet. Type a task to start one.");
    const st = run.state;
    if (!st.base || !st.lastSnapshot) return { runId: st.taskId, hasSnapshots: false, base: null, snapshot: null, changes: [] };
    const changes = await this.env.git.nameStatus(st.base.tree, st.lastSnapshot.tree);
    this.listed.set(`${st.taskId} ${st.lastSnapshot.commit}`, st.lastSnapshot.tree);
    return {
      runId: st.taskId, hasSnapshots: true, base: st.base.commit, snapshot: st.lastSnapshot.commit,
      changes: changes.map(([status, path]) => ({ status, path })),
    };
  }

  /**
   * One side of one changed file, between the snapshots a change list named (not whatever is latest now): the run's
   * base and its last snapshot, or one this worker listed earlier. Only files changed between the two can be read.
   */
  async readSnapshotFile(runId: string, pair: { base: string; snapshot: string }, side: SnapshotSide, path: string): Promise<SnapshotFile> {
    const run = this.runById(runId);
    if (!run || !this.env) throw new SessionError("not_found", `run ${runId} is not a run of this workspace`);
    const st = run.state;
    if (!st.base || !st.lastSnapshot) throw new SessionError("not_found", `run ${runId} has no snapshots yet`);
    if (pair.base !== st.base.commit) throw new SessionError("not_found", `${pair.base.slice(0, 12)} is not the base snapshot of run ${runId}`);
    const tree = pair.snapshot === st.lastSnapshot.commit ? st.lastSnapshot.tree : this.listed.get(`${runId} ${pair.snapshot}`);
    if (!tree) throw new SessionError("not_found", `${pair.snapshot.slice(0, 12)} is not a snapshot of run ${runId} listed here: open the changes again`);
    const changes = await this.env.git.nameStatus(st.base.tree, tree);
    if (!changes.some(([, p]) => p === path)) throw new SessionError("not_found", `${path} is not among the changes of run ${runId}`);
    const blob = await this.env.git.readBlob(side === "base" ? st.base.tree : tree, path);
    if (!blob) return { missing: true, binary: false, tooLarge: false, text: null };
    if (blob.length > MAX_DIFF_BYTES) return { missing: false, binary: false, tooLarge: true, text: null };
    if (isBinary(blob)) return { missing: false, binary: true, tooLarge: false, text: null };
    return { missing: false, binary: false, tooLarge: false, text: blob.toString("utf8") };
  }

  async doctor(): Promise<Check[]> {
    try {
      return await diagnose(await this.prepare(), this.o.env);
    } catch (e) {
      if (e instanceof EnvironmentError || e instanceof ConfigError) return [{ ok: false, required: true, message: e.message.replace(/\n\s*/g, " ") }];
      throw e;
    }
  }
}
