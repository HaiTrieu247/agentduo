import { resolve } from "node:path";
import { killAllActive } from "../../../src/agents/process.js";
import { Chat, notRepoNote, resumeHint, type ChatUi } from "../../../src/chat.js";
import { AttachmentError } from "../../../src/core/attachments.js";
import { isPermissionMode, parseInput, type Backend, type SettingCommand } from "../../../src/core/commands.js";
import { ConfigError, type ConfigData } from "../../../src/core/config.js";
import { Conversation } from "../../../src/core/conversation.js";
import type { Check } from "../../../src/core/doctor.js";
import { diagnose, EnvironmentError, prepareEnvironment, runnableProblem, type WorkspaceEnv } from "../../../src/core/environment.js";
import { ModelRegistry, resolvingModels } from "../../../src/core/models.js";
import type { Review } from "../../../src/core/outputs.js";
import { findingsMarkdown } from "../../../src/core/render.js";
import { permissionMode, settingsView, type SettingsView } from "../../../src/core/settings.js";
import { acquireWorkspaceLock, LockError, RunStore, workspaceBusy, workspaceLockHolder, type RunState } from "../../../src/core/state.js";
import { readClaudeUsage, readCodexUsage } from "../../../src/core/usage.js";
import { EventBus, type DuoEvent, type HumanReview, type ModelMap, type PermissionAnswer } from "../../../src/events.js";
import { packageVersion } from "../../../src/paths.js";
import { PIPELINE } from "../../../src/ui/format.js";
import { DecisionBroker, PermissionBroker } from "./decisionBroker.js";
import type {
  AccountUsage, ArtifactContent, ArtifactName, ChangeList, DecisionAnswer, FocusedRun, InitializeResult, PipelineStep, Problem, Route, SettingRequest,
  SnapshotFile, SnapshotSide, UiUpdate, WorkerErrorCode, WorkerResults,
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

/** Where the session's messages go: each names its conversation; a null one is for the whole workspace. */
export interface RuntimeSink {
  event(conversation: string, event: DuoEvent): void;
  ui(update: UiUpdate, conversation: string | null): void;
  decisionOpened(conversation: string, requestId: string, review: HumanReview, views: ArtifactName[]): void;
  decisionClosed(conversation: string, requestId: string): void;
}

/** One conversation of the workspace (an extension tab) in this worker: its chat, and the questions it asks the user. */
interface Tab {
  chat: Chat;
  bus: EventBus;
  decisions: DecisionBroker;
  permissions: PermissionBroker;
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

/** An unvalidated config may hold anything; the permission mode is only shown. */
function safePermissionMode(cfg: ConfigData): string {
  try {
    return permissionMode(cfg);
  } catch {
    return "manual";
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
  /** The conversations that have a chat in this worker, by id. */
  private readonly tabs = new Map<string, Tab>();
  private release: (() => void) | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /** Snapshots this worker has listed ("runId commit" → tree), so a diff of an earlier round stays readable. */
  private readonly listed = new Map<string, string>();
  private closing = false;
  private stopped: Promise<void> | null = null;
  /** For the whole workspace: what every tab shows (models, settings, the session). */
  private readonly ui: ChatUi;
  /** Model lookups, from initialize on; the chats share them. */
  private models: ModelRegistry | null = null;
  /** Who plain messages go to in tabs whose chat does not exist yet, so the choice is not lost. */
  private readonly chosen = new Map<string, Backend>();
  /** The settings changed in this session, in order: each tab follows them, also one opened later. */
  private readonly changed: SettingCommand[] = [];
  /** Stops the Account & Usage view's lookups at shutdown. */
  private readonly lookups = new AbortController();

  constructor(private readonly o: { workspace: string; configPath: string | null; env: NodeJS.ProcessEnv; sink: RuntimeSink }) {
    this.ui = this.uiFor(null);
  }

  /** What a chat shows goes to its own tab; the mode, models and settings are the workspace's, so every tab shows them. */
  private uiFor(conversation: string | null): ChatUi {
    const sink = this.o.sink;
    return {
      info: (text, tone) => sink.ui({ type: "info", text, ...(tone === "error" ? { tone } : {}) }, conversation),
      setStatus: (status) => sink.ui({ type: "status", status }, conversation),
      setMode: (mode) => sink.ui({ type: "mode", mode }, null),
      setRecipient: (backend) => sink.ui({ type: "recipient", backend }, conversation),
      setModels: (models) => sink.ui({ type: "models", models }, null),
      setSettings: (settings) => sink.ui({ type: "settings", settings }, null),
      usage: (report) => sink.ui({ type: "usage", report }, conversation),
      setAttachments: (files) => conversation && sink.ui({ type: "attachments", files }, conversation),
      sent: (files) => conversation && sink.ui({ type: "sent", files }, conversation),
      // /quit: leave the chat as `duo` does, which here means giving the workspace back.
      exit: () => void this.serial(() => this.endSession()),
    };
  }

  /** The config the next agent call gets; every tab follows the same settings, so any tab's is the workspace's. */
  private config(): ConfigData | null {
    for (const tab of this.tabs.values()) return tab.chat.config;
    return this.env?.cfg ?? null;
  }

  /** Looks the models up for this workspace's config (the chats', once they exist): never waited for, never blocking a request. */
  private modelsFor(env: WorkspaceEnv): ModelRegistry {
    this.models ??= new ModelRegistry({
      cfg: () => this.config(), workspace: env.workspace, env: this.o.env, onChange: (m) => this.ui.setModels(m),
      onCatalog: (codex) => this.o.sink.ui({ type: "catalog", codex }, null),
    });
    return this.models;
  }

  /** After initialize has answered: start looking the models up; their identities follow as `models` updates. */
  startDiscovery(): void {
    if (!this.closing) this.models?.refresh();
  }

  get active(): boolean {
    return !!this.release;
  }

  private async prepare(): Promise<WorkspaceEnv> {
    this.env = await prepareEnvironment({ cwd: this.o.workspace, configPath: this.o.configPath ?? undefined, env: this.o.env });
    return this.env;
  }

  /** Only looks: loads the config, checks that agents could run, and finds a run to offer; takes no lock, writes nothing. */
  async initialize(): Promise<InitializeResult> {
    const result: InitializeResult = {
      version: packageVersion(), node: process.versions.node, workspace: resolve(this.o.workspace), runsDir: null, configFile: null, configSources: [],
      pipeline: [], mode: "manual", recipient: "codex", models: unknownModels("the configuration could not be loaded"), settings: null, warnings: [],
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
      pipeline: pipelineOf(env.cfg), mode: safePermissionMode(env.cfg), models: this.modelsFor(env).current(), settings: safeSettings(env.cfg), warnings: env.warnings,
      problem: runnableProblem(env, env.cfg, env.sources.join(", "), this.o.env, { repo: false }) ?? locked,
      hint: resumeHint(env.runsDir, env.workspace) ?? (env.isRepo ? null : notRepoNote(env.workspace, this.o.env)),
    };
  }

  /** Session mutations run one at a time; decisions and permission answers never wait for them. */
  private serial<T>(op: () => Promise<T>): Promise<T> {
    const next = this.chain.then(op);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /**
   * The workspace, taken on first use: the config is read again, then the workspace lock is taken, once for every tab.
   * `needs` names the agents the work that opens it calls, so a missing CLI is refused before the lock is taken for nothing.
   */
  private async lockedEnv(conversation: string, needs: (cfg: ConfigData) => readonly Backend[]): Promise<WorkspaceEnv> {
    if (this.closing) throw new SessionError("shutting_down", "agentduo is shutting down");
    if (this.release && this.env) return this.env;
    let env: WorkspaceEnv;
    try {
      env = await this.prepare();
    } catch (e) {
      if (e instanceof EnvironmentError) throw new SessionError("environment", e.message);
      if (e instanceof ConfigError) throw new SessionError("config", e.message);
      throw e;
    }
    for (const warning of env.warnings) this.uiFor(conversation).info(`warning: ${warning}`);
    // As `duo` opens its chat: a valid config, in any folder (a run checks for the git repository it needs); each
    // question checks its own agent's CLI.
    const problem = runnableProblem(env, env.cfg, env.sources.join(", "), this.o.env, { backends: needs(env.cfg), repo: false });
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
    this.o.sink.ui({ type: "pipeline", pipeline: pipelineOf(env.cfg) }, null);
    this.o.sink.ui({ type: "mode", mode: permissionMode(env.cfg) }, null);
    this.o.sink.ui({ type: "settings", settings: settingsView(env.cfg) }, null);
    this.o.sink.ui({ type: "session", session: "active" }, null);
    return env;
  }

  /** The chat of `conversation`, opened on first use: a conversation saved earlier (a tab after a reload) carries on. */
  private async ensureSession(conversation: string, needs: (cfg: ConfigData) => readonly Backend[] = () => []): Promise<Chat> {
    const open = this.tabs.get(conversation);
    if (open) return open.chat;
    const env = await this.lockedEnv(conversation, needs);
    const bus = new EventBus();
    bus.on((event) => this.o.sink.event(conversation, event));
    const decisions = new DecisionBroker({
      opened: (id, review) => this.o.sink.decisionOpened(conversation, id, review, this.artifactsOf(this.focus(conversation))),
      closed: (id) => this.o.sink.decisionClosed(conversation, id),
    });
    const permissions = new PermissionBroker();
    const ui = this.uiFor(conversation);
    const models = this.modelsFor(env);
    const chat = new Chat({
      cfg: env.cfg, workspace: env.workspace, runsDir: env.runsDir, configFile: env.configFile, userConfigFile: env.userConfigFile, bus, decider: decisions, permissions, ui, env: this.o.env, models,
      conversationId: conversation, busyElsewhere: () => this.runningElsewhere(conversation),
    });
    // The settings changed in the other tabs of this session (already said and saved there).
    for (const setting of this.changed) chat.applySetting(setting, { quiet: true });
    const chosen = this.chosen.get(conversation);
    this.chosen.delete(conversation);
    if (chosen) chat.selectRecipient(chosen);
    this.tabs.set(conversation, { chat, bus, decisions, permissions });
    models.refresh();
    ui.setRecipient(chat.to);
    return chat;
  }

  /** A pipeline runs in another tab: what this one says instead of starting one. */
  private runningElsewhere(conversation: string): string | null {
    for (const [id, tab] of this.tabs) {
      if (id !== conversation && tab.chat.runningPipeline) {
        return `A pipeline run is going in the conversation «${tab.chat.title || "untitled"}»: wait for it, or stop it there (Esc) first. Questions and discussions can go on meanwhile.`;
      }
    }
    return null;
  }

  /** Who a message of `conversation` would go to: its chat's recipient, the one chosen, or the one its saved conversation had. */
  private recipientOf(conversation: string): Backend {
    const saved = this.env && !this.chosen.has(conversation) ? Conversation.open(this.env.runsDir, conversation).recipient : null;
    return this.tabs.get(conversation)?.chat.to ?? this.chosen.get(conversation) ?? saved ?? "codex";
  }

  /**
   * A message of a tab (to its recipient, or a slash command) or, with the Pipeline route, a task for the pipeline.
   * Resolves once the work has started: an answer or a run is never waited for, so interrupt is never held up behind it.
   */
  submit(conversation: string, text: string, route: Route = "message", attachments: string[] = []): Promise<void> {
    return this.serial(async () => {
      if (!this.release && /^\/(quit|exit)\b/.test(text.trim())) {
        this.uiFor(conversation).info("No session is open; the workspace is not locked.");
        return;
      }
      const chat = await this.ensureSession(conversation, (cfg) => agentsFor(text || (attachments.length ? "files" : ""), route, cfg, this.recipientOf(conversation)));
      // The files the tab showed as ready, by id: the chat sends only those, and only its own.
      const o = { attachments };
      await (route === "pipeline" ? chat.submitPipeline(text, o) : route === "discuss" ? chat.submitDiscuss(text, o) : chat.submit(text, o));
    });
  }

  /**
   * A file for the next message of `conversation`, from a path the host chose: the chat copies it into the conversation
   * (opened for it, as a message would), and says where it keeps such copies.
   */
  stageAttachment(conversation: string, key: string, path: string, name: string): Promise<WorkerResults["stageAttachment"]> {
    return this.serial(async () => {
      const chat = await this.ensureSession(conversation);
      try {
        return { key, conversation, attachment: chat.attach(path, name), root: chat.attachmentRoot };
      } catch (e) {
        if (e instanceof AttachmentError) throw new SessionError("bad_request", e.message);
        throw e;
      }
    });
  }

  /** A waiting file of `conversation` removed (its ✕), or every one; a tab without a chat has none. */
  removeAttachment(conversation: string, id: string): Promise<void> {
    return this.serial(async () => this.tabs.get(conversation)?.chat.detach(id, { quiet: true }));
  }

  /** Who plain messages of a tab go to; chosen before its chat exists, it waits for it (no lock is taken just for this). */
  selectRecipient(conversation: string, backend: Backend): Promise<void> {
    return this.serial(async () => {
      const tab = this.tabs.get(conversation);
      if (tab) tab.chat.selectRecipient(backend);
      else {
        this.chosen.set(conversation, backend);
        this.uiFor(conversation).setRecipient(backend);
      }
    });
  }

  /** A setting from a tab, applied as the chat's own command would; once it changed something, every other tab follows. */
  applySetting(conversation: string, request: SettingRequest): Promise<void> {
    return this.serial(async () => {
      const chat = await this.ensureSession(conversation);
      const before = JSON.stringify(chat.config);
      chat.applySetting(request.setting, { save: request.save, global: request.global, yes: request.yes });
      // Only shown, refused (full access without --yes), or already so: nothing for the other tabs to follow.
      if (JSON.stringify(chat.config) !== before) this.follow(conversation, request.setting);
    });
  }

  cycleMode(conversation: string): Promise<void> {
    return this.serial(async () => {
      const chat = await this.ensureSession(conversation);
      chat.cycleMode();
      const mode = permissionMode(chat.config);
      if (isPermissionMode(mode)) this.follow(conversation, { target: "mode", mode });
    });
  }

  /** The tab's usage, looked up again for its usage panel, as /usage does. */
  usage(conversation: string): Promise<void> {
    return this.serial(async () => (await this.ensureSession(conversation)).usage());
  }

  /** The other tabs take the setting a tab changed, quietly (that tab said so and saved it); later tabs will too. */
  private follow(origin: string, setting: SettingCommand): void {
    this.changed.push(setting);
    for (const [id, tab] of this.tabs) if (id !== origin) tab.chat.applySetting(setting, { quiet: true });
  }

  /** Esc in a tab: stops its answer or discussion, or the running step (/resume re-runs it). */
  interrupt(conversation: string): Promise<void> {
    return this.serial(async () => this.tabs.get(conversation)?.chat.escape());
  }

  /** The tab was closed: its questions are settled, what runs in it stops (a run stays resumable), and its chat goes. */
  closeConversation(conversation: string): Promise<void> {
    return this.serial(async () => {
      const tab = this.tabs.get(conversation);
      this.chosen.delete(conversation);
      if (!tab) return;
      this.tabs.delete(conversation);
      tab.decisions.deferAll(true);
      await this.denyPermissions(tab, true);
      await tab.chat.stop();
    });
  }

  answerDecision(requestId: string, answer: DecisionAnswer): void {
    for (const tab of this.tabs.values()) if (tab.decisions.answer(requestId, answer)) return;
    throw new SessionError("stale", "this decision was already answered or is no longer pending");
  }

  answerPermission(requestId: string, answer: PermissionAnswer): void {
    for (const tab of this.tabs.values()) if (tab.permissions.answer(requestId, answer)) return;
    throw new SessionError("stale", "this permission prompt was already answered or is no longer pending");
  }

  /**
   * Denies every open permission prompt of a tab and waits (briefly) until the runner has written each answer to the
   * agent: a control_request must always get its control_response, even when the agent is stopped right after.
   */
  private async denyPermissions(tab: Tab, close: boolean): Promise<void> {
    const open = new Set(tab.permissions.pending());
    const written = new Promise<void>((resolve) => {
      if (!open.size) return resolve();
      const timer = setTimeout(done, 500);
      const off = tab.bus.on((e) => {
        if (e.type === "permission.answered" && open.delete(e.id) && !open.size) done();
      });
      function done() {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
    tab.permissions.denyAll(close);
    await written;
  }

  /** Every tab, settled and stopped: their questions deferred or denied, their runs stopped and resumable. */
  private async stopTabs(close: boolean): Promise<void> {
    const tabs = [...this.tabs];
    this.tabs.clear();
    for (const [, tab] of tabs) tab.decisions.deferAll(close);
    await Promise.all(tabs.map(([, tab]) => this.denyPermissions(tab, close)));
    await Promise.all(tabs.map(([, tab]) => tab.chat.stop()));
    for (const [id] of tabs) this.o.sink.ui({ type: "status", status: "idle" }, id);
  }

  /** /quit: running runs stop at their step and stay resumable; the lock goes back. */
  private async endSession(): Promise<void> {
    if (!this.release) return;
    await this.stopTabs(false);
    this.release?.();
    this.release = null;
    this.o.sink.ui({ type: "session", session: "ended" }, null);
    this.ui.info("Session ended: the workspace is free for `duo` again. Send a message to start a new session.");
  }

  /**
   * Leaves nothing behind: waiting decisions are deferred and permission prompts denied (interrupting a run does
   * not settle them), runs stop at their step and stay resumable, and agents still alive after HARD_KILL_MS die.
   */
  shutdown(): Promise<void> {
    this.stopped ??= (async () => {
      this.closing = true;
      this.models?.close();
      this.lookups.abort();
      const hard = setTimeout(() => killAllActive(), HARD_KILL_MS);
      try {
        await this.stopTabs(true);
      } finally {
        clearTimeout(hard);
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

  /** The run a tab talks about: its chat's, or else the workspace's latest (after a reload, or with no tab named). */
  private focus(conversation: string | null): Run | null {
    const focused = conversation ? this.tabs.get(conversation)?.chat.focused() : null;
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
    for (const tab of this.tabs.values()) {
      const focused = tab.chat.focused();
      if (focused?.store.taskId === runId) return focused;
    }
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

  inspectFocusedRun(conversation: string | null): FocusedRun | null {
    const run = this.focus(conversation);
    if (!run) return null;
    const st = run.state;
    return { runId: st.taskId, task: st.task, phase: st.phase, artifacts: this.artifactsOf(run), hasSnapshots: !!(st.base && st.lastSnapshot) };
  }

  readArtifact(artifact: ArtifactName, conversation: string | null): ArtifactContent {
    const run = this.focus(conversation);
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
  async listChanges(conversation: string | null): Promise<ChangeList> {
    const run = this.focus(conversation);
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

  /**
   * The Account & Usage view: both agents' accounts and limits, as /usage looks them up (no model call, no lock), with
   * the config the next agent call gets. Runs beside whatever else runs; a broken config fails it as doctor says it.
   */
  async accountUsage(): Promise<AccountUsage> {
    if (this.closing) throw new SessionError("shutting_down", "the worker is shutting down");
    let cfg = this.config();
    if (!cfg) {
      try {
        cfg = (await this.prepare()).cfg;
      } catch (e) {
        if (e instanceof EnvironmentError || e instanceof ConfigError) throw new SessionError("config", e.message.replace(/\n\s*/g, " "));
        throw e;
      }
    }
    const o = { cfg, workspace: this.env?.workspace ?? this.o.workspace, env: this.o.env, signal: this.lookups.signal };
    const [claude, codex] = await Promise.all([readClaudeUsage(o), readCodexUsage(o)]);
    return { claude, codex };
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
