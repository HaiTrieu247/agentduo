import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AgentRunner, type AgentResult } from "./agents/runner.js";
import { firstLine } from "./agents/types.js";
import { attachmentDetail, attachmentsText, type Attachment } from "./core/attachment-types.js";
import { AttachmentError, AttachmentStore } from "./core/attachments.js";
import {
  AGENT_NAMES, helpText, isPermissionMode, MODE_INFO, modeLabel, nextMode, parseInput, type Backend, type ChatCommand, type SettingCommand,
} from "./core/commands.js";
import { configFromSaved, type ConfigData } from "./core/config.js";
import { Conversation, type Turn } from "./core/conversation.js";
import { parseVerdict } from "./core/discussion.js";
import { missingCli } from "./core/environment.js";
import { Git } from "./core/git.js";
import { ModelRegistry, withObserved } from "./core/models.js";
import {
  claudeDirs, claudeRules, describeSettings, permissionMode, saveSettings, settings, settingsView, type SettingChange, type SettingsView,
} from "./core/settings.js";
import { nowIso, RunStore, type ConversationContext, type EarlierTask, type RunState } from "./core/state.js";
import { readClaudeUsage, readCodexUsage, type UsageReport, type UsageState } from "./core/usage.js";
import { EXIT, Workflow } from "./core/workflow.js";
import type {
  Decider, DiscussionPlace, DiscussionStatus, DiscussionStep, EventBus, ModelMap, PermissionDecider, TurnStatus, Verdict,
} from "./events.js";
import { formatCost, formatTokens, modelText, usageReportText } from "./ui/format.js";

/** idle: ready; running: a pipeline run is going; answering: an agent answers a question; paused: a run was stopped with Esc. */
export type ChatStatus = "idle" | "running" | "answering" | "paused";

/** What the chat needs from the screen; the agents' own activity reaches it through the EventBus. */
export interface ChatUi {
  /** A line from agentduo itself: command output and hints. */
  info(text: string, tone?: "info" | "error"): void;
  setStatus(status: ChatStatus): void;
  /** Claude's permission mode, shown beside the input: "manual", "acceptEdits", "auto", or another one Claude Code has. */
  setMode(mode: string): void;
  /** Who a plain message goes to. */
  setRecipient(backend: Backend): void;
  /** The model each agent runs with, as far as it is known. */
  setModels(models: ModelMap): void;
  /** Every setting the chat can change, for a settings panel. */
  setSettings?(settings: SettingsView): void;
  /**
   * /usage, for a screen with a usage panel: a report with a new id opens it (both parts loading), and the same id
   * comes again as each part arrives. A screen without one gets the report as text through `info`, once it is whole.
   */
  usage?(report: UsageReport): void;
  /** The files waiting to go with the next message, whenever they change (empty once they went, or were removed). */
  setAttachments?(files: Attachment[]): void;
  /** The files that went with the message just accepted; the screen shows them with it. */
  sent?(files: Attachment[]): void;
  exit(): void;
}

/** What goes with a line of input besides its text. */
export interface SubmitOptions {
  /**
   * The waiting files it sends, by id (the extension names those its tab shows); absent: every file waiting. A line
   * that sends nothing (a command, a setting) leaves them waiting.
   */
  attachments?: string[];
}

/** What a message with files and no words asks, and what such a note for a run says. */
const FILES_QUESTION = "Look at the attached file(s).";
const FILES_NOTE = "See the attached file(s).";
const DECISION_FILES = "The files waiting to be sent do not go with a decision. To give them to the run, send them with a message before you " +
  "decide (it becomes a note for the run's next step), or decide later and /resume with a note: the files go with it.";

export interface ChatOptions {
  cfg: ConfigData;
  workspace: string;
  runsDir: string;
  /** Where `--save` writes a setting: the workspace's .agentduo/config.yaml, or --config. */
  configFile: string;
  bus: EventBus;
  decider: Decider;
  permissions?: PermissionDecider;
  ui: ChatUi;
  /** The environment the agents get (and their binaries are looked up in); default: this process's. */
  env?: NodeJS.ProcessEnv;
  /** Model lookups to share (the extension starts them before the chat exists); by default the chat has its own. */
  models?: ModelRegistry;
  /** Carries on the conversation saved under this id (an extension tab after a reload), or starts one by that id. */
  conversationId?: string;
  /** Why a pipeline cannot start now because another conversation of the workspace runs one; null when none does. */
  busyElsewhere?: () => string | null;
}

/**
 * A new run for `task` in this workspace, with the config it starts with saved beside it, and copies of the files
 * attached to the task (so the run needs neither the originals nor the chat they came from).
 */
export function newRun(runsDir: string, workspace: string, task: string, cfg: ConfigData, earlier: EarlierTask[] = [],
  conversation?: ConversationContext, attachments: Attachment[] = []): { store: RunStore; state: RunState } {
  const { store, state } = RunStore.create(runsDir, task, cfg.limits);
  state.workspace = workspace;
  if (earlier.length) state.earlier = earlier;
  if (conversation?.exchanges.length) state.conversationContext = conversation;
  if (attachments.length) {
    const files = new AttachmentStore(runsDir, store.dir);
    state.attachments = attachments.map((a) => files.adopt(a));
  }
  store.saveState(state);
  store.writeJson("config.json", cfg);
  return { store, state };
}

const OUTCOMES: Partial<Record<RunState["phase"], string>> = { DONE: "done", ABORTED: "aborted", HUMAN_REVIEW: "waiting for a decision" };
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The latest run of this workspace when it is stopped or waiting for a decision; read-only, so no lock is needed. */
export function latestResumable(runsDir: string, workspace: string): RunStore | null {
  return resumableRun(runsDir, workspace);
}

function resumableRun(runsDir: string, workspace: string, runId?: string): RunStore | null {
  try {
    const store = RunStore.open(runsDir, runId);
    const st = store.loadState();
    if (st.phase === "DONE" || st.phase === "ABORTED") return null;
    if (st.workspace && resolve(st.workspace) !== resolve(workspace)) return null;
    return store;
  } catch {
    return null;
  }
}

/** What the chat says on opening about a run an earlier session left stopped or waiting, or null. */
export function resumeHint(runsDir: string, workspace: string): string | null {
  const store = latestResumable(runsDir, workspace);
  if (!store) return null;
  const st = store.loadState();
  const where = st.phase === "HUMAN_REVIEW" ? "is waiting for your decision" : `stopped during ${st.inProgress?.phase ?? st.phase}`;
  return `Run ${st.taskId} (${firstLine(st.task, 60)}) ${where}. Type /resume to continue it.`;
}

/** The one thing agents do for this chat at a time: a pipeline run, the answer to a question, or a discussion. */
type Execution =
  | { kind: "pipeline"; store: RunStore; workflow: Workflow; cfg: ConfigData; done: Promise<void> }
  | { kind: "conversation"; turnId: string; backend: Backend; abort: AbortController; done: Promise<void> }
  | { kind: "discussion"; id: string; answerer: Backend; critic: Backend; abort: AbortController; done: Promise<void> };

/** How one agent call of the conversation ended; a review's answer comes without its VERDICT line. */
interface TurnOutcome {
  status: TurnStatus;
  answer: string | null;
  error: string | null;
  verdict: Verdict | null;
  durationSec: number;
  costUsd: number;
  tokens: number;
}

const other = (b: Backend): Backend => (b === "codex" ? "claude" : "codex");

let lastUsageId = 0;
/**
 * A /usage report's id: later than any earlier one, also of another chat or of an earlier worker (a tab's chat starts
 * over after a reload), so a view that opens its panel for a new id never takes a new report for one it has seen.
 */
const nextUsageId = () => (lastUsageId = Math.max(Date.now(), lastUsageId + 1));

/**
 * One chat session in one workspace: a conversation with Claude and Codex, from which /pipeline hands a task to both.
 * A message is a question for the current recipient, a note for the running pipeline, or a command.
 */
export class Chat {
  private active: Execution | null = null;
  /** The config new runs and questions start with: the loaded one plus this chat's changes. */
  private readonly cfg: ConfigData;
  /** This chat's setting changes, in order; replayed on a run resumed from its saved config (they are idempotent). */
  private readonly changes: SettingChange[] = [];
  /** Stopped with Esc: /resume continues it. */
  private paused: RunStore | null = null;
  private last: RunStore | null = null;
  private escaped = false;
  private conversation: Conversation;
  private runner: AgentRunner | null = null;
  private recipient: Backend = "codex";
  /** How many old exchanges the last prompt left out, so the chat says so once each time it grows. */
  private omitted = 0;
  private readonly models: ModelRegistry;
  private readonly ownModels: boolean;
  private readonly env: NodeJS.ProcessEnv;
  private readonly git: Git;
  /** What stops the latest /usage's lookups: a refresh, or the chat stopping. */
  private usageAbort: AbortController | null = null;
  private readonly offBus: () => void;

  constructor(private readonly o: ChatOptions) {
    this.git = new Git(o.workspace);
    this.cfg = structuredClone(o.cfg);
    this.env = o.env ?? process.env;
    this.conversation = o.conversationId ? Conversation.open(o.runsDir, o.conversationId) : new Conversation(o.runsDir);
    // Files an earlier process left waiting (it crashed) were never sent, and no screen shows them any more.
    if (o.conversationId) this.conversation.recoverFiles();
    this.recipient = this.conversation.recipient ?? "codex";
    this.ownModels = !o.models;
    this.models = o.models ?? new ModelRegistry({ cfg: () => this.cfg, workspace: o.workspace, env: this.env, onChange: (m) => o.ui.setModels(m) });
    this.offBus = o.bus.on((e) => {
      if (e.type === "human.required" && this.conversation.pending.length) o.ui.info(DECISION_FILES);
    });
  }

  /** The config the next agent call gets. */
  get config(): ConfigData {
    return this.cfg;
  }

  /** Who a plain message goes to now. */
  get to(): Backend {
    return this.recipient;
  }

  get conversationId(): string {
    return this.conversation.id;
  }

  /** What the conversation is about: its first question, task or discussion ("" until then). */
  get title(): string {
    return this.conversation.title;
  }

  /** A pipeline run of this chat is going (another conversation of the workspace waits for it to start one). */
  get runningPipeline(): boolean {
    return this.active?.kind === "pipeline";
  }

  /** The conversation is about its first question, task or discussion. */
  private entitle(text: string): void {
    if (!this.conversation.title) this.conversation.title = firstLine(text, 80);
  }

  /** Another conversation of the workspace runs a pipeline: says so, and nothing starts. */
  private elsewhere(): boolean {
    const why = this.o.busyElsewhere?.() ?? null;
    if (why) this.o.ui.info(why);
    return !!why;
  }

  /** Shift+Tab, as in Claude Code: Claude's next permission mode (Manual, Edit automatically, Auto). */
  cycleMode(): void {
    this.change(settings.mode(nextMode(permissionMode(this.cfg))), false, () => this.modeText());
  }

  /** Shows the settings and models, starts looking the models up, and points at a run an earlier session left stopped or waiting. */
  async greet(): Promise<void> {
    this.o.ui.setMode(permissionMode(this.cfg));
    this.o.ui.setRecipient(this.recipient);
    this.o.ui.setSettings?.(settingsView(this.cfg));
    this.o.ui.setModels(this.models.current());
    this.models.refresh();
    const hint = resumeHint(this.o.runsDir, this.o.workspace);
    if (hint) this.o.ui.info(hint);
  }

  /**
   * Reads a line of input and acts on it. Returns once the work it starts has started, never waiting for an answer or a
   * run. A line that sends something takes the waiting files with it, once it is accepted; anything else leaves them.
   */
  async submit(raw: string, o: SubmitOptions = {}): Promise<void> {
    const input = parseInput(raw);
    const ui = this.o.ui;
    switch (input.kind) {
      case "empty": {
        // Enter with files and no words: the files go on their own.
        if (o.attachments ? o.attachments.length : this.conversation.pending.length) return this.withFiles(o, (files) => this.message("", files));
        if (this.paused && !this.active) ui.info(`Run ${this.paused.taskId} is stopped: /resume continues it (/resume <note> adds what to change); /new leaves it.`);
        return;
      }
      case "message":
        return this.withFiles(o, (files) => this.message(input.text, files));
      case "ask":
        return this.withFiles(o, (files) => this.ask(input.backend, input.text, input.hint, files));
      case "recipient":
        this.selectRecipient(input.backend);
        ui.info(`Your messages now go to ${AGENT_NAMES[input.backend]}. /claude or /codex switches; /pipeline <task> hands a task to both.`);
        return;
      case "pipeline":
        return this.withFiles(o, (files) => this.startPipeline(input.task, files));
      case "discuss":
        return this.withFiles(o, (files) => this.discuss(input.question, files));
      case "attach":
        return this.attachTyped(input.home ? join(homedir(), input.path) : resolve(this.o.workspace, input.path));
      case "detach":
        return this.detach(input.target);
      case "setting":
        return this.applySetting(input.setting, { save: input.save, yes: input.yes });
      case "usage":
        ui.info(input.text);
        return;
      case "unknown":
        ui.info(`unknown command ${input.name} — /help lists the commands`);
        return;
      case "command":
        return this.command(input.name, input.arg, o);
    }
  }

  /** The Pipeline button: the text is the task, unless it is a slash command, which goes as typed. */
  async submitPipeline(raw: string, o: SubmitOptions = {}): Promise<void> {
    const text = raw.trim();
    if (text.startsWith("/")) return this.submit(text, o);
    if (!text) {
      this.o.ui.info("usage: /pipeline <task>, e.g. /pipeline Add JWT auth");
      return;
    }
    this.withFiles(o, (files) => this.startPipeline(text, files));
  }

  /** The Discuss route of the sidebar: the text is the question, unless it is a slash command, which goes as typed. */
  async submitDiscuss(raw: string, o: SubmitOptions = {}): Promise<void> {
    const text = raw.trim();
    if (text.startsWith("/")) return this.submit(text, o);
    this.withFiles(o, (files) => {
      if (!text && !files.length) {
        this.o.ui.info("usage: /discuss <question>, e.g. /discuss Redis or Postgres for the job queue?");
        return;
      }
      this.discuss(text || FILES_QUESTION, files);
    });
  }

  /** The waiting files `o` names (every one by default), for `send`; an id that does not wait here sends nothing. */
  private withFiles(o: SubmitOptions, send: (files: Attachment[]) => void): void {
    let files: Attachment[];
    try {
      files = this.conversation.select(o.attachments);
    } catch (e) {
      if (!(e instanceof AttachmentError)) throw e;
      this.o.ui.info(e.message, "error");
      return;
    }
    send(files);
  }

  /** A plain message: a note for the running pipeline, or a question for the recipient. */
  private message(text: string, files: Attachment[]): void {
    if (this.active?.kind === "pipeline") return this.note(this.active, text, files);
    this.ask(this.recipient, text || FILES_QUESTION, null, files);
  }

  private note(exec: Extract<Execution, { kind: "pipeline" }>, text: string, files: Attachment[]): void {
    const copies = this.copyInto(exec.store, files);
    if (!copies) return;
    exec.workflow.addNote(text || FILES_NOTE, copies);
    this.sentFiles(files);
    const with_ = files.length ? ` (with ${files.length} file${files.length === 1 ? "" : "s"})` : "";
    this.o.ui.info(`Noted${with_}: the agents get this from the next step. Esc stops the current step to apply it now; to ask Claude or Codex, wait until the run stops.`);
  }

  /** Copies of `files` in a run's directory, for its notes; null (and said) when one cannot be copied. */
  private copyInto(store: RunStore, files: Attachment[]): Attachment[] | null {
    if (!files.length) return [];
    try {
      const target = new AttachmentStore(this.o.runsDir, store.dir);
      return files.map((a) => target.adopt(a));
    } catch (e) {
      if (!(e instanceof AttachmentError)) throw e;
      this.o.ui.info(e.message, "error");
      return null;
    }
  }

  /** `files` went with a message that was accepted: they wait no more, and the screen shows them with it. */
  private sentFiles(files: Attachment[]): void {
    if (!files.length) return;
    this.conversation.sent(files);
    this.o.ui.setAttachments?.(this.conversation.pending);
    this.o.ui.sent?.(files);
  }

  // ------------------------------------------------------------------ attachments
  /** The files waiting to go with the next message. */
  get pending(): Attachment[] {
    return this.conversation.pending;
  }

  /** Where this conversation keeps the copies of its files (the extension lets its tab show images from there). */
  get attachmentRoot(): string {
    return this.conversation.files.root;
  }

  /**
   * /attach, and the extension's Attach: a copy of the file at `source` waits to go with the next message, whatever
   * runs now. Throws AttachmentError when it cannot (a directory, too large, a message's limits).
   */
  attach(source: string, name?: string): Attachment {
    const a = this.conversation.stage(source, name);
    this.o.ui.setAttachments?.(this.conversation.pending);
    if (this.active?.kind === "pipeline" && this.active.workflow.state.phase === "HUMAN_REVIEW") this.o.ui.info(DECISION_FILES);
    return a;
  }

  private attachTyped(path: string): void {
    try {
      const a = this.attach(path);
      const n = this.conversation.pending.length;
      this.o.ui.info(`Attached ${a.name} (${attachmentDetail(a)}). ${n === 1 ? "It goes" : `The ${n} files go`} with your next message ` +
        "(/attachments lists them, /detach removes one).");
    } catch (e) {
      if (!(e instanceof AttachmentError)) throw e;
      this.o.ui.info(e.message, "error");
    }
  }

  /**
   * /detach <n|id|all>, and a file's ✕ in the extension (`quiet`: the tab shows the change itself): a waiting file is
   * removed, its copy too.
   */
  detach(target: string, o: { quiet?: boolean } = {}): void {
    const ui = this.o.ui;
    const say = (text: string, tone?: "error") => (o.quiet ? undefined : ui.info(text, tone));
    const pending = this.conversation.pending;
    if (target === "all") {
      const gone = this.conversation.discardPending();
      ui.setAttachments?.([]);
      say(gone.length ? `Removed ${gone.length} file${gone.length === 1 ? "" : "s"}; nothing waits to be sent.` : "No file waits to be sent.");
      return;
    }
    const byNumber = /^\d+$/.test(target) ? pending[Number(target) - 1] : undefined;
    const gone = this.conversation.unstage(byNumber?.id ?? target);
    ui.setAttachments?.(this.conversation.pending);
    if (!gone) say(pending.length ? `No waiting file is ${target}: /attachments lists them.` : "No file waits to be sent.", "error");
    else say(`Removed ${gone.name}.`);
  }

  private attachmentsText(): string {
    const pending = this.conversation.pending;
    if (!pending.length) return "No file waits to be sent. /attach <path> attaches one (an image, a PDF, text, code…).";
    return [`${pending.length} file${pending.length === 1 ? "" : "s"} go${pending.length === 1 ? "es" : ""} with your next message:`,
      ...pending.map((a, i) => `  ${i + 1}. ${a.name} (${attachmentDetail(a)})`), "/detach <n|all> removes one, or all."].join("\n");
  }

  /** Plain messages go to `backend` from now on. */
  selectRecipient(backend: Backend): void {
    if (this.recipient === backend) return;
    this.recipient = backend;
    this.conversation.recipient = backend;
    this.o.ui.setRecipient(backend);
  }

  /** Esc: stop what runs. An answer or a discussion ends there; a pipeline's step stops and /resume continues it. */
  escape(): void {
    const a = this.active;
    if (!a) return;
    if (a.kind !== "pipeline") {
      a.abort.abort();
      return;
    }
    this.escaped = true;
    a.workflow.interrupt();
  }

  /** The run the screen talks about (for the decision prompt's views): asking an agent never changes it. */
  focused(): { store: RunStore; state: RunState } | null {
    const store = this.focus();
    if (!store) return null;
    const running = this.active?.kind === "pipeline" && this.active.store === store ? this.active : null;
    return { store, state: running ? running.workflow.state : store.loadState() };
  }

  /** Resolves once nothing runs (a stopped run may still wait for the user). */
  async idle(): Promise<void> {
    while (this.active) await this.active.done;
  }

  /**
   * /usage, and the usage panel's refresh: how much of their plans' limits both agents have used, as `claude -p /usage`
   * and Codex's app server say it (neither calls a model). Runs beside whatever else runs, and a refresh stops the
   * lookups it replaces.
   */
  usage(): void {
    this.usageAbort?.abort();
    const abort = new AbortController();
    this.usageAbort = abort;
    const show = this.o.ui.usage?.bind(this.o.ui);
    let report: UsageReport = { id: nextUsageId(), claude: { status: "loading" }, codex: { status: "loading" } };
    show?.(report);
    const o = { cfg: this.cfg, workspace: this.o.workspace, env: this.env, signal: abort.signal };
    const part = (backend: Backend, read: Promise<UsageState>) => read.then((state) => {
      if (abort.signal.aborted) return;
      report = { ...report, [backend]: state };
      show?.(report);
    });
    void Promise.all([part("claude", readClaudeUsage(o)), part("codex", readCodexUsage(o))]).then(() => {
      if (!show && !abort.signal.aborted) this.o.ui.info(usageReportText(report));
    });
  }

  /**
   * Stops what runs (a run stays resumable), waits for it, and stops looking models and usage up. The files waiting
   * to be sent go: nothing could send them any more.
   */
  async stop(): Promise<void> {
    this.usageAbort?.abort();
    const a = this.active;
    if (a && a.kind !== "pipeline") a.abort.abort();
    else a?.workflow.interrupt();
    await this.idle();
    this.offBus();
    this.conversation.discardPending();
    if (this.ownModels) this.models.close();
  }

  // ------------------------------------------------------------------ conversation
  private busy(): void {
    const a = this.active!;
    this.o.ui.info(a.kind === "pipeline"
      ? "A pipeline run is going: wait for it, or press Esc to stop its current step first. (A plain message is a note for its next step.)"
      : a.kind === "discussion"
        ? `${AGENT_NAMES[a.answerer]} and ${AGENT_NAMES[a.critic]} are still discussing: wait for it, or press Esc to stop it. Settings you change apply to its next turn.`
        : `${AGENT_NAMES[a.backend]} is still answering: wait for it, or press Esc to stop it. Settings you change apply to the next question.`);
  }

  private ask(backend: Backend, question: string, hint: string | null, files: Attachment[] = []): void {
    if (this.active) return this.busy();
    const problem = missingCli(this.cfg, [backend], this.env);
    if (problem) {
      this.o.ui.info(problem.message, "error");
      return;
    }
    this.selectRecipient(backend);
    if (hint) this.o.ui.info(hint);
    this.startTurn(backend, question, files);
  }

  private directRunner(): AgentRunner {
    return this.runner ??= new AgentRunner(this.cfg, this.o.workspace, this.conversation.logDir, this.o.bus, { permissions: this.o.permissions, runsDir: this.o.runsDir });
  }

  /** What a conversation is about when its first message was files with no words: their names. */
  private titleOf(text: string, files: Attachment[]): string {
    return files.length && text === FILES_QUESTION ? files.map((f) => f.name).join(", ") : text;
  }

  /** Says once each time it grows that the conversation no longer fits what a prompt carries. */
  private noteOmitted(omitted: number): void {
    if (omitted > this.omitted) {
      this.o.ui.info(`The conversation has grown long: its ${omitted} oldest exchange(s) no longer go to the agents (the logs keep them: ${this.conversation.logDir}).`);
    }
    this.omitted = omitted;
  }

  /** Starts the answer in the background: the active record exists before anything can finish, and only it clears itself. */
  private startTurn(backend: Backend, question: string, files: Attachment[]): void {
    this.entitle(this.titleOf(question, files));
    const { turn, prompt, omitted } = this.conversation.begin(backend, question, this.conversation.earlier, this.o.workspace, files);
    this.sentFiles(files);
    this.noteOmitted(omitted);
    const exec: Extract<Execution, { kind: "conversation" }> = { kind: "conversation", turnId: turn.id, backend, abort: new AbortController(), done: Promise.resolve() };
    this.active = exec;
    this.o.ui.setStatus("answering");
    exec.done = this.callTurn(turn, prompt, exec.abort.signal).then(() => undefined).finally(() => this.settled(exec));
  }

  /** Whatever ran is over: unless something else started meanwhile, the chat is idle (or a run stays stopped). */
  private settled(exec: Execution): void {
    if (this.active === exec) this.active = null;
    if (!this.active) this.o.ui.setStatus(this.paused ? "paused" : "idle");
  }

  /**
   * One agent call of the conversation, with its turn's events around it. `turn.started` goes out now; the call itself
   * starts a microtask later, so the caller's active record exists before anything can finish.
   */
  private callTurn(turn: Turn, prompt: string, signal: AbortSignal, place?: DiscussionPlace): Promise<TurnOutcome> {
    const conversation = this.conversation;
    const backend = turn.backend;
    // The CLI's own settings may have changed since the last look.
    this.models.refresh();
    const model = this.models.identity(backend);
    const signature = this.models.signature(backend);
    const runner = this.directRunner();
    const ids = { conversationId: conversation.id, turnId: turn.id, backend };
    this.o.bus.emit({ type: "turn.started", ...ids, question: turn.question, model, ...(place ? { discussion: place } : {}) });
    return (async () => {
      await Promise.resolve();
      let r: AgentResult | null = null;
      let failure: string | null = null;
      try {
        r = await runner.call({
          mode: "text", backend, prompt, logPrefix: turn.logPrefix, conversationId: conversation.id, turnId: turn.id, signal, attachments: turn.attachments,
        });
      } catch (e) {
        failure = (e as Error).message;
      }
      const status: TurnStatus = r?.interrupted ? "interrupted" : r?.ok ? "success" : "error";
      let answer = status === "success" ? String(r!.data) : null;
      let verdict: Verdict | null = null;
      if (answer !== null && place?.step === "critique") ({ verdict, text: answer } = parseVerdict(answer));
      if (r?.model) this.models.observe(backend, r.model, signature);
      conversation.finish(turn.id, status, answer, verdict);
      // A lookup still going when the call started may have ended since, for this same config.
      const looked = model.status === "resolving" && this.models.signature(backend) === signature ? this.models.identity(backend) : model;
      const error = status === "error" ? r?.error ?? failure ?? "the call failed" : null;
      this.o.bus.emit({
        type: "turn.finished", ...ids, status, answer, error, model: r?.model ? withObserved(model, r.model) : looked, durationSec: r?.durationSec ?? 0,
        costUsd: r?.costUsd ?? undefined, tokens: r?.tokens ?? undefined, logDir: conversation.logDir,
        ...(place ? { discussion: place.step === "critique" ? { ...place, verdict } : place } : {}),
      });
      return { status, answer, error, verdict, durationSec: r?.durationSec ?? 0, costUsd: r?.costUsd ?? 0, tokens: r?.tokens ?? 0 };
    })();
  }

  // ------------------------------------------------------------------ discussion
  /**
   * /discuss: the recipient answers, the other agent reviews it, and the recipient revises until the reviewer agrees
   * or the reviews run out. Then Codex, in a call of its own, synthesizes the whole discussion into the response, the
   * only part of it later prompts carry. If the synthesis fails, the latest version is the response; Esc ends it all.
   */
  private discuss(question: string, files: Attachment[] = []): void {
    if (this.active) return this.busy();
    const answerer = this.recipient;
    const critic = other(answerer);
    const problem = missingCli(this.cfg, [answerer, critic], this.env);
    if (problem) {
      this.o.ui.info(problem.message, "error");
      return;
    }
    const conversation = this.conversation;
    this.entitle(this.titleOf(question, files));
    const maxRounds = this.cfg.limits.max_discussion_rounds;
    const d = conversation.beginDiscussion(answerer, critic, question, maxRounds, files);
    this.sentFiles(files);
    this.noteOmitted(d.context.omitted);
    const exec: Extract<Execution, { kind: "discussion" }> = { kind: "discussion", id: d.id, answerer, critic, abort: new AbortController(), done: Promise.resolve() };
    this.active = exec;
    this.o.ui.setStatus("answering");
    const ids = { conversationId: conversation.id, discussionId: d.id };
    this.o.bus.emit({ type: "discussion.started", ...ids, question, answerer, critic, maxRounds });
    const total = { durationSec: 0, costUsd: 0, tokens: 0 };
    const step = async (kind: DiscussionStep, round: number): Promise<TurnOutcome> => {
      if (exec.abort.signal.aborted) return { status: "interrupted", answer: null, error: null, verdict: null, durationSec: 0, costUsd: 0, tokens: 0 };
      const { turn, prompt } = conversation.discussionTurn(d.id, kind, round, conversation.earlier, this.o.workspace);
      const out = await this.callTurn(turn, prompt, exec.abort.signal, { id: d.id, step: kind, round });
      total.durationSec += out.durationSec;
      total.costUsd += out.costUsd;
      total.tokens += out.tokens;
      return out;
    };
    exec.done = (async () => {
      await Promise.resolve();
      let status: DiscussionStatus = "error";
      let answer: string | null = null;
      let answerBackend: Backend = answerer;
      let error: string | null = null;
      let rounds = 0;
      const failed = (out: TurnOutcome) => {
        status = out.status === "interrupted" ? "interrupted" : "error";
        error = out.error;
      };
      // How the reviews ended, once they did; the synthesis comes after.
      let reviewed: "agreed" | "disputed" | null = null;
      // The latest version and its number: the response if the synthesis fails.
      let latest = { text: "", round: 1 };
      let version = await step("answer", 1);
      while (version.status === "success") {
        latest = { text: version.answer ?? "", round: rounds + 1 };
        rounds++;
        const review = await step("critique", rounds);
        if (review.status !== "success") {
          failed(review);
          break;
        }
        if (review.verdict === "agree") {
          reviewed = "agreed";
          break;
        }
        if (review.verdict === null) {
          this.o.bus.emit({ type: "warning", text: `${AGENT_NAMES[critic]}'s review ${rounds} had no VERDICT line, so agentduo takes it as REVISE.` });
        }
        if (rounds >= maxRounds) {
          reviewed = "disputed";
          break;
        }
        version = await step("revise", rounds + 1);
      }
      if (version.status !== "success") failed(version);
      if (reviewed) {
        const synthesis = await step("synthesis", rounds);
        // Esc wins, even over a synthesis that finished as it came.
        if (synthesis.status === "interrupted" || exec.abort.signal.aborted) {
          status = "interrupted";
        } else if (synthesis.status === "success") {
          status = reviewed;
          answer = synthesis.answer;
          answerBackend = "codex";
        } else {
          // The version the reviews ended on is still a good answer: it stays the response.
          status = reviewed;
          answer = latest.text;
          this.o.bus.emit({
            type: "warning",
            text: `Codex could not synthesize the discussion (${synthesis.error ?? "the call failed"}), so the response is ${AGENT_NAMES[answerer]}'s version ${latest.round}.`,
          });
        }
      }
      conversation.finishDiscussion(d.id, answer, answerBackend);
      this.o.bus.emit({
        type: "discussion.finished", ...ids, status, answerer, critic, rounds, answer, answerBackend, error, durationSec: total.durationSec,
        costUsd: total.costUsd || undefined, tokens: total.tokens || undefined, logDir: conversation.logDir,
      });
    })().finally(() => this.settled(exec));
  }

  // ------------------------------------------------------------------ pipeline
  private startPipeline(task: string, files: Attachment[] = []): void {
    if (this.active) return this.busy();
    if (this.elsewhere()) return;
    const problem = missingCli(this.cfg, Object.values(this.cfg.agents), this.env);
    if (problem) {
      this.o.ui.info(problem.message, "error");
      return;
    }
    const left = this.paused;
    const cfg = structuredClone(this.cfg);
    const context = this.conversation.context();
    let run: { store: RunStore; state: RunState };
    try {
      run = newRun(this.o.runsDir, this.o.workspace, task, cfg, this.conversation.earlier, context, files);
    } catch (e) {
      if (!(e instanceof AttachmentError)) throw e;
      this.o.ui.info(e.message, "error");
      return;
    }
    const { store, state } = run;
    if (!this.start(store, state, cfg)) return;
    this.sentFiles(files);
    if (files.length) this.o.ui.info(`The task goes to the agents with ${files.length} file${files.length === 1 ? "" : "s"}, copied into run ${store.taskId}.`);
    this.entitle(task);
    if (left) {
      this.paused = null;
      this.o.ui.info(`Run ${left.taskId} stays stopped and resumable: /resume ${left.taskId} continues it (or duo resume ${left.taskId}).`);
    }
  }

  /** Locks and runs `store`'s run in the background; false when it cannot be locked. */
  private start(store: RunStore, state: RunState, cfg: ConfigData): boolean {
    try {
      store.lock();
    } catch (e) {
      this.o.ui.info((e as Error).message, "error");
      return false;
    }
    this.models.refresh();
    const workflow = new Workflow({ cfg, repo: this.o.workspace, store, state, bus: this.o.bus, decider: this.o.decider, permissions: this.o.permissions });
    this.escaped = false;
    const exec: Extract<Execution, { kind: "pipeline" }> = { kind: "pipeline", store, workflow, cfg, done: Promise.resolve() };
    const conversation = this.conversation;
    this.active = exec;
    this.o.ui.setStatus("running");
    exec.done = (async () => {
      await Promise.resolve();
      let code: number = EXIT.ERROR;
      try {
        code = await workflow.run();
      } catch (e) {
        this.o.ui.info(`error: ${(e as Error).message}`, "error");
      } finally {
        store.unlock();
      }
      this.last = store;
      const st = store.loadState();
      if (code === EXIT.INTERRUPTED && this.escaped) {
        this.paused = store;
        this.o.ui.info(`Stopped ${st.inProgress?.phase ?? st.phase}. /resume re-runs it (/resume <what to change> adds a note); /new leaves it. Meanwhile you can ask Claude or Codex.`);
        return;
      }
      if (code === EXIT.HUMAN_REVIEW) this.o.ui.info("The run is waiting for your decision; type /resume to decide.");
      // The conversation that started it keeps what came of it.
      conversation.addEarlier(await this.outcome(st));
    })().finally(() => {
      if (this.active === exec) this.active = null;
      if (!this.active) this.o.ui.setStatus(this.paused ? "paused" : "idle");
    });
    return true;
  }

  private async outcome(st: RunState): Promise<EarlierTask> {
    const parts = [OUTCOMES[st.phase] ?? "stopped"];
    if (st.lastImplementation?.summary) parts.push(firstLine(st.lastImplementation.summary, 300));
    if (st.base && st.lastSnapshot) {
      try {
        const files = (await this.git.nameStatus(st.base.tree, st.lastSnapshot.tree)).map(([, path]) => path);
        if (files.length) parts.push(`files: ${files.slice(0, 12).join(", ")}${files.length > 12 ? ", …" : ""}`);
      } catch {
        // the outcome is a courtesy for the next run; a git hiccup must not end the chat
      }
    }
    return { task: firstLine(st.task, 200), outcome: parts.join("; ") };
  }

  /** A stopped run's own config, with this chat's changes on top. */
  private configOf(store: RunStore): ConfigData {
    const cfg = store.exists("config.json") ? configFromSaved(store.readJson("config.json")) : structuredClone(this.cfg);
    for (const change of this.changes) change.apply(cfg);
    return cfg;
  }

  /**
   * /resume [note | run id]: the stopped run, another resumable run by id, or the latest one. The waiting files go
   * with the note (a note of their own when there is none), copied into the run.
   */
  private resume(arg: string, o: SubmitOptions = {}): void {
    if (this.active) return this.busy();
    if (this.elsewhere()) return;
    let files: Attachment[];
    try {
      files = this.conversation.select(o.attachments);
    } catch (e) {
      if (!(e instanceof AttachmentError)) throw e;
      this.o.ui.info(e.message, "error");
      return;
    }
    let note = arg.trim();
    const byId = RUN_ID.test(note) && !note.includes("..") ? resumableRun(this.o.runsDir, this.o.workspace, note) : null;
    if (byId) note = "";
    const target = byId ?? this.paused ?? latestResumable(this.o.runsDir, this.o.workspace);
    if (!target) {
      this.o.ui.info("Nothing to resume.");
      return;
    }
    const cfg = this.configOf(target);
    const problem = missingCli(cfg, Object.values(cfg.agents), this.env, target.exists("config.json"));
    if (problem) {
      this.o.ui.info(problem.message, "error");
      return;
    }
    const state = target.loadState();
    if (note || files.length) {
      const copies = this.copyInto(target, files);
      if (!copies) return;
      state.humanNotes.push({ at: nowIso(), phase: state.inProgress?.phase ?? state.phase, note: note || FILES_NOTE, ...(copies.length ? { attachments: copies } : {}) });
      target.saveState(state);
      this.sentFiles(files);
    }
    const paused = this.paused;
    this.paused = null;
    if (!this.start(target, state, cfg)) this.paused = paused;
  }

  /** /new: forget the conversation and the earlier tasks; a stopped run keeps its files and stays resumable. */
  private reset(): void {
    if (this.active) {
      this.o.ui.info("Something is running; press Esc to stop it first.");
      return;
    }
    if (this.paused) this.o.ui.info(`Left run ${this.paused.taskId} as it is; /resume ${this.paused.taskId} continues it.`);
    this.paused = null;
    const unsent = this.conversation.discardPending();
    if (unsent.length) {
      this.o.ui.setAttachments?.([]);
      this.o.ui.info(`Removed ${unsent.length} attached file${unsent.length === 1 ? "" : "s"} that ${unsent.length === 1 ? "was" : "were"} not sent: ${attachmentsText(unsent)}.`);
    }
    this.conversation = new Conversation(this.o.runsDir);
    this.runner = null;
    this.omitted = 0;
    this.selectRecipient("codex");
    this.o.ui.setStatus("idle");
    this.o.ui.info("New conversation: the agents no longer see what was said or done before. Your messages go to Codex.");
  }

  // ------------------------------------------------------------------ settings
  private modeText(): string {
    const mode = permissionMode(this.cfg);
    const what = isPermissionMode(mode) ? ` — ${MODE_INFO[mode].description}` : "";
    return `Mode: ${modeLabel(mode)}${what}, in the chat and as the pipeline's implementer.`;
  }

  /**
   * Applies a setting to new runs and questions and, from its next agent call, to the run that is going (whose saved
   * config follows, so a resume keeps it); --save also writes it to the config file.
   */
  private change(change: SettingChange, save: boolean, text: () => string, quiet = false): void {
    change.apply(this.cfg);
    this.changes.push(change);
    const running = this.active?.kind === "pipeline" ? this.active : null;
    if (running) {
      change.apply(running.cfg);
      running.store.writeJson("config.json", running.cfg);
    }
    if (save && !quiet) saveSettings(this.o.configFile, this.cfg, change.paths);
    this.o.ui.setMode(permissionMode(this.cfg));
    this.o.ui.setSettings?.(settingsView(this.cfg));
    this.models.refresh();
    if (quiet) return;
    const scope = save ? `; saved to ${this.o.configFile}` : " (this chat only; add --save to keep it)";
    const when = running ? " Applies from the next agent call of the current run." : this.active ? " Applies from the next question." : "";
    this.o.ui.info(`${text()}${when}${scope}`);
  }

  /**
   * A setting from a command or the settings panel: shows it when it has no value, changes it otherwise. `quiet`: it was
   * changed in another conversation of the workspace, which said so (and saved it): this one only follows.
   */
  applySetting(s: SettingCommand, flags: { save?: boolean; yes?: boolean; quiet?: boolean } = {}): void {
    const ui = this.o.ui;
    const save = !!flags.save;
    const quiet = !!flags.quiet;
    const change = (c: SettingChange, text: () => string) => this.change(c, save, text, quiet);
    const view = settingsView(this.cfg);
    switch (s.target) {
      case "mode":
        if (!s.mode) return ui.info(this.modeText());
        return change(settings.mode(s.mode), () => this.modeText());
      case "claude.model":
        if (s.model === undefined) return ui.info(`Claude's model: ${modelText(this.models.identity("claude"))}`);
        return change(settings.claudeModel(s.model), () => `Claude's model: ${this.cfg.claude.model ?? "default"}.`);
      case "claude.effort":
        if (s.effort === undefined) return ui.info(`Claude's effort: ${view.claude.effort ?? "default"}`);
        return change(settings.claudeEffort(s.effort), () => `Claude's effort: ${s.effort ?? "default"}.`);
      case "claude.permissions": {
        if (!s.rule) {
          const { allow, deny } = claudeRules(this.cfg);
          return ui.info(`Claude's rules for agentduo's calls (on top of its own settings)\n  allow: ${allow.join(", ") || "—"}\n  deny: ${deny.join(", ") || "—"}`);
        }
        const { kind, rule } = s.rule;
        if (kind === "remove") return change(settings.claudeRemoveRule(rule), () => `Removed the rule ${rule}.`);
        return change(settings.claudeRule(kind, rule), () => `Claude ${kind === "allow" ? "may use" : "may not use"} ${rule}.`);
      }
      case "claude.add-dir":
        if (s.dir === undefined) return ui.info(`Extra directories for Claude: ${claudeDirs(this.cfg).join(", ") || "—"}`);
        return change(settings.claudeAddDir(s.dir), () => `Claude may also work in ${s.dir}.`);
      case "codex.model": {
        if (s.model === undefined) return ui.info(`Codex's model: ${modelText(this.models.identity("codex"))}${view.codex.effort ? `, reasoning effort ${view.codex.effort}` : ""}`);
        const effort = s.effort ?? null;
        return change(settings.codexModel(s.model, effort), () => `Codex's model: ${this.cfg.codex.model ?? "default"}${effort ? `, reasoning effort ${effort}` : ""}.`);
      }
      case "codex.permissions": {
        if (!s.preset) return ui.info(`Codex permissions: ${view.codex.permissions}`);
        const preset = s.preset;
        // Codex itself asks before full access; so does this.
        if (preset === "full-access" && !flags.yes && !quiet) {
          return ui.info("Full access lets Codex edit any file on this computer and use the network without asking. To go ahead: /settings codex permissions full-access --yes");
        }
        return change(settings.codexPermissions(preset), () => `Codex permissions: ${preset}.`);
      }
    }
  }

  // ------------------------------------------------------------------ commands
  /** The run commands talk about: the one going, the stopped one, or the last one. */
  private focus(): RunStore | null {
    return (this.active?.kind === "pipeline" ? this.active.store : null) ?? this.paused ?? this.last;
  }

  private async command(name: ChatCommand, arg: string, o: SubmitOptions = {}): Promise<void> {
    const ui = this.o.ui;
    const store = this.focus();
    switch (name) {
      case "help":
        ui.info(helpText());
        return;
      case "config":
        ui.info(`${describeSettings(this.cfg)}\nModels  Claude: ${modelText(this.models.identity("claude"))} · Codex: ${modelText(this.models.identity("codex"))}\n` +
          `Changes in this chat are not saved unless a command ends with --save (it writes ${this.o.configFile}).`);
        return;
      case "plan": {
        const plan = store && (store.exists("plan.final.md") ? store.readText("plan.final.md") : store.exists("plan.md") ? store.readText("plan.md") : null);
        ui.info(plan ? `── plan ──\n${plan.trimEnd()}` : "There is no plan yet.");
        return;
      }
      case "diff": {
        const st = store?.loadState();
        const stat = st?.base && st.lastSnapshot ? (await this.git.diffStat(st.base.commit, st.lastSnapshot.commit)).trimEnd() : "";
        ui.info(stat ? `── diff stat ──\n${stat}` : "No changes yet.");
        return;
      }
      case "status": {
        const a = this.active;
        const answering = a?.kind === "conversation" ? `${AGENT_NAMES[a.backend]} is answering a question.`
          : a?.kind === "discussion" ? `${AGENT_NAMES[a.answerer]} and ${AGENT_NAMES[a.critic]} are discussing a question.` : "";
        if (!store) {
          ui.info([answering, "No run yet. /pipeline <task> starts one."].filter(Boolean).join("\n"));
          return;
        }
        const st = store.loadState();
        const usage = [formatCost(st.costUsd), formatTokens(st.tokens)].filter(Boolean).join(" · ");
        const running = this.active?.kind === "pipeline" && this.active.store === store;
        ui.info([answering, `Run ${st.taskId} — ${st.phase}${running ? " (running)" : this.paused === store ? " (stopped)" : ""} · plan round ${st.planningRound}/${st.limits.planningRounds}` +
          ` · implementation round ${st.implRound}/${st.limits.reviewRounds}${usage ? ` · ${usage}` : ""}`].filter(Boolean).join("\n"));
        return;
      }
      case "usage":
        return this.usage();
      case "resume":
        return this.resume(arg, o);
      case "attachments":
        ui.info(this.attachmentsText());
        return;
      case "new":
        return this.reset();
      case "quit":
        ui.exit();
        return;
    }
  }
}
