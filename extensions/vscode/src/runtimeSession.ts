import { resolve } from "node:path";
import { killAllActive } from "../../../src/agents/process.js";
import { Chat, resumeHint, type ChatUi } from "../../../src/chat.js";
import { parseInput, type Backend } from "../../../src/core/commands.js";
import { ConfigError, type ConfigData } from "../../../src/core/config.js";
import type { Check } from "../../../src/core/doctor.js";
import { diagnose, EnvironmentError, prepareEnvironment, runnableProblem, type WorkspaceEnv } from "../../../src/core/environment.js";
import { ModelRegistry, resolvingModels } from "../../../src/core/models.js";
import type { Review } from "../../../src/core/outputs.js";
import { findingsMarkdown } from "../../../src/core/render.js";
import { editMode, settingsView, type SettingsView } from "../../../src/core/settings.js";
import { acquireWorkspaceLock, LockError, RunStore, workspaceBusy, workspaceLockHolder, type RunState } from "../../../src/core/state.js";
import { EventBus, type DuoEvent, type HumanReview, type ModelMap, type PermissionAnswer } from "../../../src/events.js";
import { packageVersion } from "../../../src/paths.js";
import { PIPELINE } from "../../../src/ui/format.js";
import { DecisionBroker, PermissionBroker } from "./decisionBroker.js";
import type {
  ArtifactContent, ArtifactName, ChangeList, DecisionAnswer, FocusedRun, InitializeResult, PipelineStep, Problem, Route, SettingRequest, SnapshotFile,
  SnapshotSide, UiUpdate, WorkerErrorCode,
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

function safeSettings(cfg: ConfigData): SettingsView | null {
  try {
    return settingsView(cfg);
  } catch {
    return null;
  }
}

const unknownModels = (reason: string): ModelMap => {
  const m = resolvingModels();
  return { codex: { ...m.codex, status: "unresolved", reason }, claude: { ...m.claude, status: "unresolved", reason } };
};

/** The agents `text` would call, sent with `route`: the pipeline's, both for a discussion, the one asked, or none (a command, a setting). */
function agentsFor(text: string, route: Route, cfg: ConfigData, recipient: Backend): readonly Backend[] {
  const input = parseInput(text);
  if (input.kind === "pipeline" || (route === "pipeline" && input.kind === "message")) return Object.values(cfg.agents);
  if (input.kind === "discuss" || (route === "discuss" && input.kind === "message")) return ["codex", "claude"];
  if (input.kind === "ask") return [input.backend];
  return input.kind === "message" ? [recipient] : [];
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
  /** Model lookups, from initialize on; the chat shares them once it exists. */
  private models: ModelRegistry | null = null;
  /** Who a plain message goes to; kept here too, so the choice made before the session starts is not lost. */
  private recipient: Backend = "codex";

  constructor(private readonly o: { workspace: string; configPath: string | null; env: NodeJS.ProcessEnv; sink: RuntimeSink }) {
    this.bus.on((event) => o.sink.event(event));
    this.decisions = new DecisionBroker({
      opened: (id, review) => o.sink.decisionOpened(id, review, this.artifactsOf(this.focus())),
      closed: (id) => o.sink.decisionClosed(id),
    });
    this.ui = {
      info: (text, tone) => o.sink.ui({ type: "info", text, ...(tone === "error" ? { tone } : {}) }),
      setStatus: (status) => o.sink.ui({ type: "status", status }),
      setEdits: (mode) => o.sink.ui({ type: "edits", mode }),
      setRecipient: (backend) => {
        this.recipient = backend;
        o.sink.ui({ type: "recipient", backend });
      },
      setModels: (models) => o.sink.ui({ type: "models", models }),
      setSettings: (settings) => o.sink.ui({ type: "settings", settings }),
      // /quit: leave the chat as `duo` does, which here means giving the workspace back.
      exit: () => void this.serial(() => this.endSession()),
    };
  }

  /** Looks the models up for this workspace's config (the chat's, once it exists): never waited for, never blocking a request. */
  private modelsFor(env: WorkspaceEnv): ModelRegistry {
    this.models ??= new ModelRegistry({
      cfg: () => this.chat?.config ?? this.env?.cfg ?? null, workspace: env.workspace, env: this.o.env, onChange: (m) => this.ui.setModels(m),
      onCatalog: (codex) => this.o.sink.ui({ type: "catalog", codex }),
    });
    return this.models;
  }

  /** After initialize has answered: start looking the models up; their identities follow as `models` updates. */
  startDiscovery(): void {
    if (!this.closing) this.models?.refresh();
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
      pipeline: [], edits: "ask", recipient: this.recipient, models: unknownModels("the configuration could not be loaded"), settings: null, warnings: [],
      problem: null, hint: null,
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
      pipeline: pipelineOf(env.cfg), edits: safeEditMode(env.cfg), models: this.modelsFor(env).current(), settings: safeSettings(env.cfg), warnings: env.warnings,
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

  /**
   * The chat session, started on first use: the config is read again, then the workspace lock is taken. `needs` names
   * the agents the work that opens it calls, so a missing CLI is refused before the lock is taken for nothing.
   */
  private async ensureSession(needs: (cfg: ConfigData) => readonly Backend[] = () => []): Promise<Chat> {
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
    // As `duo` opens its chat: a git repository and a valid config; each question checks its own agent's CLI.
    const problem = runnableProblem(env, env.cfg, env.sources.join(", "), this.o.env, false, needs(env.cfg));
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
    const models = this.modelsFor(env);
    const chat = new Chat({
      cfg: env.cfg, workspace: env.workspace, runsDir: env.runsDir, configFile: env.configFile, bus: this.bus,
      decider: this.decisions, permissions: this.permissions, ui: this.ui, env: this.o.env, models,
    });
    chat.selectRecipient(this.recipient);
    this.chat = chat;
    models.refresh();
    this.o.sink.ui({ type: "pipeline", pipeline: pipelineOf(env.cfg) });
    this.o.sink.ui({ type: "edits", mode: editMode(env.cfg) });
    this.o.sink.ui({ type: "settings", settings: settingsView(env.cfg) });
    this.o.sink.ui({ type: "recipient", backend: chat.to });
    this.o.sink.ui({ type: "session", session: "active" });
    return chat;
  }

  /**
   * A message (to the recipient, or a slash command) or, with the Pipeline route, a task for the pipeline. Resolves
   * once the work has started: an answer or a run is never waited for, so interrupt is never held up behind it.
   */
  submit(text: string, route: Route = "message"): Promise<void> {
    return this.serial(async () => {
      if (!this.chat && /^\/(quit|exit)\b/.test(text.trim())) {
        this.ui.info("No session is open; the workspace is not locked.");
        return;
      }
      const chat = await this.ensureSession((cfg) => agentsFor(text, route, cfg, this.recipient));
      await (route === "pipeline" ? chat.submitPipeline(text) : route === "discuss" ? chat.submitDiscuss(text) : chat.submit(text));
    });
  }

  /** Who plain messages go to; chosen before the session starts, it waits for it (no lock is taken just for this). */
  selectRecipient(backend: Backend): Promise<void> {
    return this.serial(async () => {
      if (this.chat) this.chat.selectRecipient(backend);
      else this.ui.setRecipient(backend);
    });
  }

  /** A setting from the sidebar's controls, applied as the chat's own command would apply it. */
  applySetting(request: SettingRequest): Promise<void> {
    return this.serial(async () => (await this.ensureSession()).applySetting(request.setting, { save: request.save, yes: request.yes }));
  }

  toggleEdits(): Promise<void> {
    return this.serial(async () => (await this.ensureSession()).toggleEdits());
  }

  /** Esc: stops the answer, or the running step (/resume re-runs it). */
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
    this.ui.info("Session ended: the workspace is free for `duo` again. Send a message to start a new session.");
  }

  /**
   * Leaves nothing behind: waiting decisions are deferred and permission prompts denied (interrupting a run does
   * not settle them), the run stops at its step and stays resumable, and agents still alive after HARD_KILL_MS die.
   */
  shutdown(): Promise<void> {
    this.stopped ??= (async () => {
      this.closing = true;
      this.models?.close();
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
