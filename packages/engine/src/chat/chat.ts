import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AgentRunner, type AgentResult } from "../agents/runner.js";
import { firstLine } from "../agents/types.js";
import { attachmentDetail, attachmentsText, type Attachment } from "../inputs/attachment-types.js";
import { AttachmentError, AttachmentStore } from "../inputs/attachments.js";
import {
  AGENT_NAMES, helpText, isPermissionMode, MODE_INFO, modeLabel, nextMode, parseInput, type Backend, type ChatCommand, type SettingCommand,
} from "./commands.js";
import { configFromSaved, type ConfigData, type ProfileName } from "../config/config.js";
import { Conversation, isArchivedConversation, restoreConversation, type Turn } from "./conversation.js";
import { parseVerdict } from "./discussion.js";
import { missingCli } from "../system/environment.js";
import { ModelRegistry, withObserved } from "../config/models.js";
import {
  claudeDirs, claudeRules, describeSettings, permissionMode, saveGlobalSetting, saveSettings, settings, settingsView, withChange, type SettingChange,
  type SettingsView,
} from "../config/settings.js";
import { openRunGit, preflightSnapshots, RunGitError, type SnapshotPreflight } from "../git/run-git.js";
import { LockError, nowIso, RunStore, type ConversationContext, type EarlierTask, type Exchange, type RunState } from "../workflow/state.js";
import { WorkspaceLease } from "../workflow/lease.js";
import { readClaudeUsage, readCodexUsage, type UsageReport, type UsageState } from "../system/usage.js";
import { EXIT, Workflow } from "../workflow/workflow.js";
import type {
  ClarificationDecider, Decider, DiscussionPlace, DiscussionStatus, DiscussionStep, EventBus, ModelMap, PermissionDecider, TurnStatus, Verdict,
} from "../events.js";
import { formatCost, formatTokens, modelText, usageReportText } from "../format.js";
import { teamConfigErrors, teamMembers } from "../team/config.js";
import { TeamStore } from "../team/state.js";
import { resumableTeam, TeamRun, teamRosterText, teamStatusText, undoTeam, type TeamOutcome } from "../team/team.js";

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
  /**
   * A line that could not run now, because another agentduo (another window, `duo`) works in this workspace or this
   * conversation: nothing was sent, its files still wait, and the screen gives the line back to the input to send again.
   */
  refused?(text: string): void;
  /**
   * What was said in this conversation that the screen has not shown: all of it as a saved conversation opens, then
   * what another agentduo said in it meanwhile (`refresh`). Oldest first.
   */
  history?(exchanges: Exchange[], earlier: EarlierTask[]): void;
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

/** Where a changed setting is written besides this chat: --save, the config file; --global, the user config file. */
export interface SaveFlags {
  save?: boolean;
  global?: boolean;
}

export interface ChatOptions {
  cfg: ConfigData;
  workspace: string;
  runsDir: string;
  /** Where `--save` writes a setting: the workspace's .agentduo/config.yaml, or --config. */
  configFile: string;
  /** Where `--global` writes a setting: the user config file, read before `configFile`. */
  userConfigFile: string;
  bus: EventBus;
  decider: Decider;
  permissions?: PermissionDecider;
  /**
   * Who answers an agent's structured questions (Claude's AskUserQuestion inside a turn, the planner's questions in a
   * run); absent when nobody can. Codex's turns keep asking in words: the user answers in the next message.
   */
  clarifier?: ClarificationDecider;
  ui: ChatUi;
  /** The environment the agents get (and their binaries are looked up in); default: this process's. */
  env?: NodeJS.ProcessEnv;
  /** Model lookups to share (the extension starts them before the chat exists); by default the chat has its own. */
  models?: ModelRegistry;
  /** Carries on the conversation saved under this id (an extension tab after a reload), or starts one by that id. */
  conversationId?: string;
  /** Why a pipeline cannot start now because another conversation of the workspace runs one; null when none does. */
  busyElsewhere?: () => string | null;
  /**
   * A setting the user changed in this chat (a command, the settings panel, Shift+Tab; never one it follows), with the
   * files it was written to: the host has its other chats follow it, and tells whoever else reads a file written.
   */
  changed?: (change: SettingChange, wrote: SaveFlags) => void;
  /**
   * The workspace lock work takes (packages/engine/src/workflow/lease.ts), shared by every chat of the process (the
   * extension's tabs); by default this chat's own. It is held only while work runs, never while the chat waits for input.
   */
  lease?: WorkspaceLease;
  /**
   * Once this chat holds the workspace, before new work starts: the host reads the config files again (another window
   * may have saved a setting), and its chats follow what changed, the session's own values still winning.
   */
  beforeWork?: () => void;
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
  const where = st.phase === "HUMAN_REVIEW"
    ? (st.humanReview?.reason === "clarification_required" ? "is waiting for your answers to an agent's questions" : "is waiting for your decision")
    : `stopped during ${st.inProgress?.phase ?? st.phase}`;
  return `Run ${st.taskId} (${firstLine(st.task, 60)}) ${where}. Type /resume to continue it.`;
}

/** What the chat says as it opens outside a git repository (the extension too). */
export const NOT_REPO_NOTE = "This folder is not inside a git repository, and a pipeline run needs none: it keeps its snapshots in a Git repository " +
  "of agentduo's own, outside the folder (no .git is created here).";
/** The same in the home folder (VS Code with no folder open works there), where a pipeline run would take in the whole home. */
export const HOME_NOTE = "This is your home folder: you can ask Claude and Codex and /discuss here, but a pipeline run needs a project folder: " +
  "open one (it needs no git repository).";

/** What the chat says as it opens about where a pipeline run would keep its snapshots; null in a git repository. */
export function snapshotNote(plan: SnapshotPreflight): string | null {
  if (plan.mode === "native") return null;
  if (plan.mode === "internal") return NOT_REPO_NOTE;
  return plan.problem.kind === "not_repo" ? HOME_NOTE : plan.problem.message;
}

/**
 * The one thing agents do for this chat at a time: a pipeline run, the answer to a question, or a discussion. Each holds
 * the workspace and the conversation (`release` gives them back) from before it starts until all it wrote is saved and
 * its agents are gone, waits for the user included.
 */
type Execution =
  | { kind: "pipeline"; store: RunStore; workflow: Workflow; cfg: ConfigData; done: Promise<void>; release: () => void }
  | { kind: "conversation"; turnId: string; backend: Backend; abort: AbortController; done: Promise<void>; release: () => void }
  | { kind: "discussion"; id: string; answerer: Backend; critic: Backend; abort: AbortController; done: Promise<void>; release: () => void }
  /** A team run (packages/engine/src/team): plain messages go to its PM while it works or waits for you. */
  | { kind: "team"; run: TeamRun; done: Promise<void>; release: () => void };

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
  /**
   * This chat's setting changes, in order (without those a later one supersedes). The next-call ones are replayed on a
   * run resumed from its saved config (they are idempotent); next-run ones never reach a run that started before.
   */
  private changes: SettingChange[] = [];
  /** Stopped with Esc: /resume continues it. */
  private paused: RunStore | null = null;
  /** A team run stopped with Esc (or waiting where nobody could answer): /resume continues it. */
  private pausedTeam: string | null = null;
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
  /** What stops the latest /usage's lookups: a refresh, or the chat stopping. */
  private usageAbort: AbortController | null = null;
  private readonly offBus: () => void;
  private readonly lease: WorkspaceLease;
  /** The recipient was chosen while another agentduo held the conversation: it is saved with it once this chat holds it. */
  private unsavedRecipient = false;
  /** The line being handled, as typed (a route's text as its command): what goes back to the input if it cannot run now. */
  private line: string | null = null;

  constructor(private readonly o: ChatOptions) {
    this.cfg = structuredClone(o.cfg);
    this.env = o.env ?? process.env;
    this.lease = o.lease ?? new WorkspaceLease(o.runsDir);
    this.conversation = o.conversationId ? Conversation.open(o.runsDir, o.conversationId) : new Conversation(o.runsDir);
    // Files an earlier process left waiting (it crashed) were never sent, and no screen shows them any more.
    if (o.conversationId) this.conversation.recoverFiles();
    this.recipient = this.conversation.recipient ?? "codex";
    this.ownModels = !o.models;
    this.models = o.models ?? new ModelRegistry({ cfg: () => this.cfg, workspace: o.workspace, env: this.env, onChange: (m) => o.ui.setModels(m) });
    this.offBus = o.bus.on((e) => {
      if (e.type === "human.required" && this.conversation.pending.length) o.ui.info(DECISION_FILES);
      // What an agent asks in this conversation's turns and what the user answers is saved the moment it happens (a pipeline's
      // questions are the run's, not the conversation's: Conversation ignores a request that names no turn of its own).
      else if (e.type === "clarification.requested") this.conversation.clarificationAsked(e.request);
      else if (e.type === "clarification.answered") this.conversation.clarificationAnswered(e.id, e.callId, e.answers);
      else if (e.type === "clarification.closed" && e.status !== "deferred") this.conversation.clarificationClosed(e.id, e.callId, e.status);
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
    this.change(settings.mode(nextMode(permissionMode(this.cfg))), {}, () => this.modeText());
  }

  /**
   * Shows the settings and models, starts looking the models up, says what works outside a git repository, and points
   * at a run an earlier session left stopped or waiting.
   */
  async greet(): Promise<void> {
    this.o.ui.setMode(permissionMode(this.cfg));
    this.o.ui.setRecipient(this.recipient);
    this.o.ui.setSettings?.(settingsView(this.cfg));
    this.o.ui.setModels(this.models.current());
    this.models.refresh();
    // A saved conversation (from this terminal, the extension or the desktop) opens with what was said in it.
    const said = this.conversation.history;
    const earlier = this.conversation.earlier;
    if (said.length || earlier.length) {
      this.o.ui.history?.(said, earlier);
      this.o.ui.info(`Continuing «${this.conversation.title || "untitled"}» (${this.conversation.id}): the agents see what was said in it${this.conversation.sessionsKept ? ", and go on in their sessions" : ""}.`);
    }
    const note = snapshotNote(await preflightSnapshots(this.o.workspace, this.env));
    if (note) this.o.ui.info(note);
    const hint = resumeHint(this.o.runsDir, this.o.workspace);
    if (hint) this.o.ui.info(hint);
    const team = hint ? null : resumableTeam(this.o.runsDir);
    if (team) this.o.ui.info(`Team run ${team.id} (${firstLine(team.request, 60)}) is ${team.waiting ? "waiting for you" : "stopped"} in ${team.phase}. Type /resume to continue it.`);
  }

  /**
   * Reads a line of input and acts on it. Returns once the work it starts has started, never waiting for an answer or a
   * run. A line that sends something takes the waiting files with it, once it is accepted; anything else leaves them.
   */
  async submit(raw: string, o: SubmitOptions = {}): Promise<void> {
    this.line = raw;
    const input = parseInput(raw, process.platform);
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
        if (await this.cannotSnapshot()) return;
        return this.withFiles(o, (files) => this.startPipeline(input.task, files, input.profile));
      case "discuss":
        return this.withFiles(o, (files) => this.discuss(input.question, files));
      case "team":
        return this.teamCommand(input, o);
      case "attach":
        return this.attachTyped(input.home ? join(homedir(), input.path) : resolve(this.o.workspace, input.path));
      case "detach":
        return this.detach(input.target);
      case "setting":
        return this.applySetting(input.setting, { save: input.save, global: input.global, yes: input.yes });
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
    this.line = `/pipeline ${text}`;
    if (!text) {
      this.o.ui.info("usage: /pipeline <task>, e.g. /pipeline Add JWT auth");
      return;
    }
    if (await this.cannotSnapshot()) return;
    this.withFiles(o, (files) => this.startPipeline(text, files));
  }

  /** The Team route of the composer: the text is the request for a new team (or a message to the running team's PM); a slash command goes as typed. */
  async submitTeam(raw: string, o: SubmitOptions = {}): Promise<void> {
    const text = raw.trim();
    if (text.startsWith("/")) return this.submit(text, o);
    if (this.active?.kind === "team") return this.submit(text, o);
    this.line = `/team ${text}`;
    if (!text) {
      this.o.ui.info("usage: a request for the team, e.g. Add a CSV export to the reports page (you then talk to its PM)");
      return;
    }
    if (await this.cannotSnapshot()) return;
    this.withFiles(o, (files) => this.startTeam(text, files));
  }

  /** The Discuss route of the sidebar: the text is the question, unless it is a slash command, which goes as typed. */
  async submitDiscuss(raw: string, o: SubmitOptions = {}): Promise<void> {
    const text = raw.trim();
    if (text.startsWith("/")) return this.submit(text, o);
    this.line = text ? `/discuss ${text}` : "";
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
    if (this.active?.kind === "team") return this.teamMessage(this.active.run, text, files);
    this.ask(this.recipient, text || FILES_QUESTION, null, files);
  }

  /** A message for the running team's PM, with its files (the run copies them; every member is given them). */
  private teamMessage(run: TeamRun, text: string, files: Attachment[]): void {
    try {
      run.message(text, files);
    } catch (e) {
      if (!(e instanceof AttachmentError)) throw e;
      this.o.ui.info(e.message, "error");
      return;
    }
    this.sentFiles(files);
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
    this.o.ui.setRecipient(backend);
    this.saveRecipient();
  }

  /**
   * The recipient is saved with the conversation, which only the process holding it writes: this chat while it works, or
   * for the moment it takes to write it. While another agentduo holds it, the choice stays here, and is saved with this
   * chat's next work (another window's choice made meanwhile then gives way to it).
   */
  private saveRecipient(): void {
    if (this.lease.holds(this.conversation.id)) {
      this.conversation.recipient = this.recipient;
      this.unsavedRecipient = false;
      return;
    }
    let release: () => void;
    try {
      release = this.lease.take(this.conversation.id);
    } catch (e) {
      if (!(e instanceof LockError)) throw e;
      this.unsavedRecipient = true;
      return;
    }
    try {
      this.conversation.reload({ settle: true });
      this.conversation.recipient = this.recipient;
      this.unsavedRecipient = false;
    } finally {
      release();
    }
  }

  // ------------------------------------------------------------------ the workspace, shared with other agentduo windows
  /**
   * Takes the workspace and this conversation for new work, then reads both again as other agentduo windows (`duo`, the
   * extension, the desktop) may have left them: the conversation's record, and the config files (`beforeWork`). Null,
   * and said, when another process holds either: nothing starts, its files stay waiting, and the line goes back to the
   * input. Nothing that runs elsewhere is interrupted.
   */
  private takeWorkspace(): (() => void) | null {
    if (this.conversation.deleted) {
      this.o.ui.info("This conversation was deleted in another agentduo window: nothing was sent. /new starts a new one.", "error");
      if (this.line !== null) this.o.ui.refused?.(this.line);
      return null;
    }
    let release: () => void;
    try {
      release = this.lease.take(this.conversation.id);
    } catch (e) {
      if (!(e instanceof LockError)) throw e;
      const what = e.message.charAt(0).toUpperCase() + e.message.slice(1);
      this.o.ui.info(`${what}. Nothing was sent, and nothing there is interrupted: send it again once that work is done.`, "error");
      if (this.line !== null) this.o.ui.refused?.(this.line);
      return null;
    }
    try {
      this.o.beforeWork?.();
      this.catchUp(true);
      // Work in an archived conversation brings it back to the lists.
      if (isArchivedConversation(this.o.runsDir, this.conversation.id)) {
        restoreConversation(this.o.runsDir, this.conversation.id);
        this.o.ui.info("This conversation was archived: it is back in the list.");
      }
    } catch (e) {
      release();
      throw e;
    }
    return release;
  }

  /**
   * The conversation as it is on disk now; `held`: this chat holds it (before new work). A recipient chosen here while
   * another window held it is saved now; otherwise one chosen there is followed. A run this chat stopped that another
   * window has finished meanwhile is no longer this chat's to resume. Returns the exchanges said elsewhere.
   */
  private catchUp(held: boolean): Exchange[] {
    const fresh = this.conversation.reload({ settle: held });
    if (this.unsavedRecipient && held) {
      this.conversation.recipient = this.recipient;
      this.unsavedRecipient = false;
    } else if (!this.unsavedRecipient && this.conversation.recipient && this.conversation.recipient !== this.recipient) {
      this.recipient = this.conversation.recipient;
      this.o.ui.setRecipient(this.recipient);
    }
    if (this.paused && !resumableRun(this.o.runsDir, this.o.workspace, this.paused.taskId)) this.paused = null;
    return fresh;
  }

  /**
   * While nothing runs in this chat: what another agentduo window said in its conversation since this chat last looked
   * (shown through `history`), its title and recipient, read without taking anything. The CLI's chat looks every few
   * seconds; the extension and the desktop follow the conversation's files themselves (packages/host/src/workspaceSession.ts).
   */
  refresh(): Exchange[] {
    if (this.active || !this.conversation.changedOnDisk()) return [];
    const fresh = this.catchUp(false);
    if (fresh.length) this.o.ui.history?.(fresh, []);
    return fresh;
  }

  /** Esc: stop what runs. An answer or a discussion ends there; a pipeline's step stops and /resume continues it. */
  escape(): void {
    const a = this.active;
    if (!a) return;
    if (a.kind === "team") {
      this.escaped = true;
      a.run.stop();
      return;
    }
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
    if (a?.kind === "team") a.run.stop();
    else if (a && a.kind !== "pipeline") a.abort.abort();
    else a?.workflow.interrupt();
    await this.idle();
    this.offBus();
    this.conversation.discardPending();
    if (this.ownModels) this.models.close();
  }

  // ------------------------------------------------------------------ conversation
  private busy(): void {
    const a = this.active!;
    this.o.ui.info(a.kind === "team"
      ? "The team is working: your messages go to its PM. Esc stops the team (/resume continues it); /team status shows the board."
      : a.kind === "pipeline"
      ? "A pipeline run is going: wait for it, or press Esc to stop its current step first. (A plain message is a note for its next step.)"
      : a.kind === "discussion"
        ? `${AGENT_NAMES[a.answerer]} and ${AGENT_NAMES[a.critic]} are still discussing: wait for it, or press Esc to stop it. Settings you change apply to its next turn.`
        : `${AGENT_NAMES[a.backend]} is still answering: wait for it, or press Esc to stop it. Settings you change apply to the next question.`);
  }

  private ask(backend: Backend, question: string, hint: string | null, files: Attachment[] = []): void {
    if (this.active) return this.busy();
    const release = this.takeWorkspace();
    if (!release) return;
    // Checked with the config as it is now (another window may have changed the agent's binary).
    const problem = missingCli(this.cfg, [backend], this.env);
    if (problem) {
      release();
      this.o.ui.info(problem.message, "error");
      return;
    }
    try {
      this.selectRecipient(backend);
      if (hint) this.o.ui.info(hint);
      this.startTurn(backend, question, files, release);
    } catch (e) {
      if (!this.runsWith(release)) release();
      throw e;
    }
  }

  /** Claude may ask the user in this chat's turns: someone can answer, and the setting allows it (checked per call, so a change applies at once). */
  private canAsk(): boolean {
    return !!this.o.clarifier && this.cfg.clarification?.enabled !== false;
  }

  private directRunner(): AgentRunner {
    return this.runner ??= new AgentRunner(this.cfg, this.o.workspace, this.conversation.logDir, this.o.bus, { permissions: this.o.permissions, clarifications: this.o.clarifier, runsDir: this.o.runsDir });
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

  /**
   * Starts the answer in the background, holding the workspace (`release`): the active record exists before anything
   * can finish, and only it clears itself.
   */
  private startTurn(backend: Backend, question: string, files: Attachment[], release: () => void): void {
    this.entitle(this.titleOf(question, files));
    const { turn, prompt, omitted } = this.conversation.begin(backend, question, this.conversation.earlier, this.o.workspace, files, this.canAsk());
    this.sentFiles(files);
    this.noteOmitted(omitted);
    const exec: Extract<Execution, { kind: "conversation" }> = { kind: "conversation", turnId: turn.id, backend, abort: new AbortController(), done: Promise.resolve(), release };
    this.active = exec;
    this.o.ui.setStatus("answering");
    exec.done = this.callTurn(turn, prompt, exec.abort.signal).then(() => undefined).finally(() => this.settled(exec));
  }

  /** Work holding `release` has started (it gives the workspace back itself when it is over). */
  private runsWith(release: () => void): boolean {
    return this.active?.release === release;
  }

  /**
   * Whatever ran is over, all it wrote saved and its agents gone: the workspace is given back, and unless something else
   * started meanwhile, the chat is idle (or a run stays stopped).
   */
  private settled(exec: Execution): void {
    exec.release();
    if (this.active === exec) this.active = null;
    if (!this.active) this.o.ui.setStatus(this.paused || this.pausedTeam ? "paused" : "idle");
  }

  /**
   * One agent call of the conversation, with its turn's events around it. `turn.started` goes out now; the call itself
   * starts a microtask later, so the caller's active record exists before anything can finish.
   */
  private callTurn(turn: Turn, prompt: string, signal: AbortSignal, place?: DiscussionPlace, runner = this.directRunner()): Promise<TurnOutcome> {
    const conversation = this.conversation;
    const backend = turn.backend;
    const keep = runner.backends[backend].keepsSessions();
    // Off the record until the call ends; with sessions turned off it is not continued, and the call's own is not kept.
    const sessionId = conversation.takeSession(backend);
    const resume = keep && sessionId && turn.continuation ? { id: sessionId, prompt: turn.continuation, attachments: turn.attachments } : undefined;
    const earlierCount = conversation.earlier.length;
    // The CLI's own settings may have changed since the last look.
    this.models.refresh();
    const model = this.models.identity(backend);
    const signature = this.models.signature(backend);
    const ids = { conversationId: conversation.id, turnId: turn.id, backend };
    this.o.bus.emit({ type: "turn.started", ...ids, question: turn.question, model, ...(place ? { discussion: place } : {}) });
    return (async () => {
      await Promise.resolve();
      let r: AgentResult | null = null;
      let failure: string | null = null;
      try {
        r = await runner.call({
          mode: "text", backend, prompt, logPrefix: turn.logPrefix, conversationId: conversation.id, turnId: turn.id, signal, attachments: turn.attachments,
          session: { keep, ...(resume ? { resume } : {}) },
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
      conversation.keepSession(turn, keep && status === "success" ? r?.sessionId ?? null : null, earlierCount);
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
    const release = this.takeWorkspace();
    if (!release) return;
    try {
      this.discussHeld(question, files, release);
    } catch (e) {
      if (!this.runsWith(release)) release();
      throw e;
    }
  }

  private discussHeld(question: string, files: Attachment[], release: () => void): void {
    const answerer = this.recipient;
    const critic = other(answerer);
    const problem = missingCli(this.cfg, [answerer, critic], this.env);
    if (problem) {
      release();
      this.o.ui.info(problem.message, "error");
      return;
    }
    const conversation = this.conversation;
    this.entitle(this.titleOf(question, files));
    // The discussion keeps the limits it started with (next-run settings), while each agent's options stay the chat's
    // own objects, so a model or flag changed meanwhile reaches its next turn (next-call).
    const snapshot: ConfigData = { ...this.cfg, limits: structuredClone(this.cfg.limits), agents: structuredClone(this.cfg.agents) };
    const runner = new AgentRunner(snapshot, this.o.workspace, conversation.logDir, this.o.bus, { permissions: this.o.permissions, clarifications: this.o.clarifier, runsDir: this.o.runsDir });
    const maxRounds = snapshot.limits.max_discussion_rounds;
    const d = conversation.beginDiscussion(answerer, critic, question, maxRounds, files);
    this.sentFiles(files);
    this.noteOmitted(d.context.omitted);
    const exec: Extract<Execution, { kind: "discussion" }> = { kind: "discussion", id: d.id, answerer, critic, abort: new AbortController(), done: Promise.resolve(), release };
    this.active = exec;
    this.o.ui.setStatus("answering");
    const ids = { conversationId: conversation.id, discussionId: d.id };
    this.o.bus.emit({ type: "discussion.started", ...ids, question, answerer, critic, maxRounds });
    const total = { durationSec: 0, costUsd: 0, tokens: 0 };
    const step = async (kind: DiscussionStep, round: number): Promise<TurnOutcome> => {
      if (exec.abort.signal.aborted) return { status: "interrupted", answer: null, error: null, verdict: null, durationSec: 0, costUsd: 0, tokens: 0 };
      const { turn, prompt } = conversation.discussionTurn(d.id, kind, round, conversation.earlier, this.o.workspace, this.canAsk());
      const out = await this.callTurn(turn, prompt, exec.abort.signal, { id: d.id, step: kind, round }, runner);
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

  // ------------------------------------------------------------------ team
  /** /team <request>, status, members, abort, undo. */
  private async teamCommand(input: Extract<ReturnType<typeof parseInput>, { kind: "team" }>, o: SubmitOptions = {}): Promise<void> {
    const ui = this.o.ui;
    const active = this.active?.kind === "team" ? this.active.run : null;
    switch (input.action) {
      case "start":
        if (await this.cannotSnapshot()) return;
        return this.withFiles(o, (files) => this.startTeam(input.request, files));
      case "status": {
        const state = active?.state ?? this.latestTeamState();
        ui.info(state ? teamStatusText(state) : "No team run yet. /team <request> starts one.");
        return;
      }
      case "members":
        ui.info(teamRosterText(active?.members ?? teamMembers(this.cfg.team)));
        return;
      case "abort": {
        if (active) {
          active.abortRun();
          return;
        }
        const id = this.pausedTeam ?? resumableTeam(this.o.runsDir)?.id;
        if (!id) {
          ui.info("No team run to abort.");
          return;
        }
        const store = TeamStore.open(this.o.runsDir, id);
        const state = store.load();
        state.phase = "ABORTED";
        store.save(state);
        this.pausedTeam = null;
        ui.info(`Team run ${id} is aborted; nothing of it went into your folder.`);
        return;
      }
      case "undo": {
        if (this.active) return this.busy();
        const id = input.runId ?? TeamStore.list(this.o.runsDir).filter((s) => s.applied).at(-1)?.id;
        if (!id) {
          ui.info("No team run has written a result into this folder.");
          return;
        }
        const release = this.takeWorkspace();
        if (!release) return;
        try {
          const undone = await undoTeam({ runsDir: this.o.runsDir, workspace: this.o.workspace, id, env: this.env });
          ui.info("restored" in undone ? `Team run ${id}'s result is taken back out: ${undone.restored.length} file(s) are as they were.` : `Cannot undo team run ${id}: ${undone.problem}.`,
            "restored" in undone ? "info" : "error");
        } catch (e) {
          ui.info(`Cannot undo team run ${id}: ${(e as Error).message}`, "error");
        } finally {
          release();
        }
        return;
      }
    }
  }

  private latestTeamState() {
    try {
      return TeamStore.list(this.o.runsDir).at(-1) ?? null;
    } catch {
      return null;
    }
  }

  private startTeam(request: string, files: Attachment[] = []): void {
    if (this.active) return this.busy();
    if (this.elsewhere()) return;
    const release = this.takeWorkspace();
    if (!release) return;
    try {
      const errors = teamConfigErrors(this.cfg.team);
      if (errors.length) {
        release();
        this.o.ui.info(`The team's configuration has problems:\n  - ${errors.join("\n  - ")}`, "error");
        return;
      }
      const problem = missingCli(this.cfg, [...new Set(teamMembers(this.cfg.team).map((m) => m.backend))], this.env);
      if (problem) {
        release();
        this.o.ui.info(problem.message, "error");
        return;
      }
      let run: TeamRun;
      try {
        run = TeamRun.create({
          runsDir: this.o.runsDir, request, cfg: structuredClone(this.cfg), workspace: this.o.workspace, bus: this.o.bus,
          decider: this.o.clarifier, permissions: this.o.permissions, env: this.env, attachments: files,
        });
      } catch (e) {
        if (!(e instanceof AttachmentError)) throw e;
        release();
        this.o.ui.info(e.message, "error");
        return;
      }
      this.sentFiles(files);
      this.entitle(request);
      this.pausedTeam = null;
      const with_ = files.length ? `, with ${files.length} file${files.length === 1 ? "" : "s"} every member is given` : "";
      this.o.ui.info(`The team takes it from here (run ${run.id}${with_}). Your messages now go to the PM; Esc stops the team, /team status shows the board.`);
      this.runTeam(run, release, request);
    } catch (e) {
      if (!this.runsWith(release)) release();
      throw e;
    }
  }

  /** The team run /resume continues: one named by id, else the stopped one, else the latest that is not over. */
  private teamToResume(arg: string): string | null {
    if (arg && RUN_ID.test(arg) && !arg.includes("..")) {
      try {
        const state = TeamStore.open(this.o.runsDir, arg).load();
        return state.phase !== "DONE" && state.phase !== "ABORTED" ? state.id : null;
      } catch {
        return null;
      }
    }
    if (this.pausedTeam) return this.pausedTeam;
    // A pipeline run waiting or stopped goes first, as it always did.
    if (this.paused || latestResumable(this.o.runsDir, this.o.workspace)) return null;
    return resumableTeam(this.o.runsDir)?.id ?? null;
  }

  private resumeTeam(id: string, note: string): void {
    if (this.elsewhere()) return;
    const release = this.takeWorkspace();
    if (!release) return;
    try {
      const run = TeamRun.resume({ runsDir: this.o.runsDir, id, workspace: this.o.workspace, bus: this.o.bus, decider: this.o.clarifier, permissions: this.o.permissions, env: this.env });
      const problem = missingCli(this.cfg, [...new Set(run.members.map((m) => m.backend))], this.env);
      if (problem) {
        release();
        this.o.ui.info(problem.message, "error");
        return;
      }
      const raised = run.raiseBudget();
      if (raised.length) this.o.ui.info(`Budget: ${raised.join("; ")}.`);
      if (note) run.message(note);
      this.pausedTeam = null;
      this.o.ui.info(`Team run ${id} goes on. Your messages go to the PM.`);
      this.runTeam(run, release, run.state.request);
    } catch (e) {
      if (!this.runsWith(release)) release();
      throw e;
    }
  }

  private runTeam(run: TeamRun, release: () => void, request: string): void {
    const exec: Extract<Execution, { kind: "team" }> = { kind: "team", run, done: Promise.resolve(), release };
    const conversation = this.conversation;
    this.active = exec;
    this.escaped = false;
    this.o.ui.setStatus("running");
    exec.done = (async () => {
      await Promise.resolve();
      let outcome: TeamOutcome = "error";
      try {
        outcome = await run.run();
      } catch (e) {
        this.o.ui.info(`error: ${(e as Error).message}`, "error");
      }
      const st = run.state;
      if (outcome === "done") {
        this.o.ui.info(st.summary ?? `Team run ${run.id} is done.`);
        conversation.addEarlier({ task: firstLine(request, 200), outcome: `done by a team; ${firstLine(st.summary ?? "", 200)}`, runId: run.id });
      } else if (outcome === "aborted") {
        this.o.ui.info(`Team run ${run.id} is aborted; nothing of it went into your folder.`);
      } else {
        this.pausedTeam = run.id;
        this.o.ui.info(outcome === "stopped"
          ? `The team stopped. /resume continues it (/resume <message> also tells the PM something); /team abort ends it.`
          : `The team waits (${st.waiting ? `for your ${st.waiting.kind === "apply_conflict" ? "decision on conflicts" : `approval of the ${st.waiting.kind}`}` : "for you"}). /resume continues it.`);
      }
    })().finally(() => this.settled(exec));
  }

  // ------------------------------------------------------------------ pipeline
  /**
   * A run snapshots and diffs the workspace with git, in its repository or, in a folder with none, in one of agentduo's
   * own. When neither can be (no Git, the home folder…) it says why, the files waiting stay, and nothing starts.
   * Checked each time: Git may be installed, or `git init` run, during the chat.
   */
  private async cannotSnapshot(): Promise<boolean> {
    const plan = await preflightSnapshots(this.o.workspace, this.env);
    if (plan.mode !== null) return false;
    this.o.ui.info(`A pipeline run cannot start here: ${plan.problem.message}`, "error");
    return true;
  }

  private startPipeline(task: string, files: Attachment[] = [], profile?: ProfileName): void {
    if (this.active) return this.busy();
    if (this.elsewhere()) return;
    const release = this.takeWorkspace();
    if (!release) return;
    try {
      this.startPipelineHeld(task, files, profile, release);
    } catch (e) {
      if (!this.runsWith(release)) release();
      throw e;
    }
  }

  private startPipelineHeld(task: string, files: Attachment[], profile: ProfileName | undefined, release: () => void): void {
    const problem = missingCli(this.cfg, Object.values(this.cfg.agents), this.env);
    if (problem) {
      release();
      this.o.ui.info(problem.message, "error");
      return;
    }
    const left = this.paused;
    const cfg = structuredClone(this.cfg);
    // --profile is this run's: the run records it and keeps it; the chat's own config stays as it is.
    if (profile) cfg.pipeline = { ...cfg.pipeline, profile };
    const context = this.conversation.context();
    let run: { store: RunStore; state: RunState };
    try {
      run = newRun(this.o.runsDir, this.o.workspace, task, cfg, this.conversation.earlier, context, files);
    } catch (e) {
      if (!(e instanceof AttachmentError)) throw e;
      release();
      this.o.ui.info(e.message, "error");
      return;
    }
    const { store, state } = run;
    if (!this.start(store, state, cfg, release)) return;
    this.sentFiles(files);
    if (files.length) this.o.ui.info(`The task goes to the agents with ${files.length} file${files.length === 1 ? "" : "s"}, copied into run ${store.taskId}.`);
    this.entitle(task);
    if (left) {
      this.paused = null;
      this.o.ui.info(`Run ${left.taskId} stays stopped and resumable: /resume ${left.taskId} continues it (or duo resume ${left.taskId}).`);
    }
  }

  /**
   * Locks and runs `store`'s run in the background, holding the workspace (`release`) until it stops or waits no more:
   * through its steps and its waits for a decision or an answer, until its state is saved, its agents are gone and the
   * conversation has its outcome. False (and the workspace given back) when the run cannot be locked.
   */
  private start(store: RunStore, state: RunState, cfg: ConfigData, release: () => void): boolean {
    try {
      store.lock();
    } catch (e) {
      release();
      this.o.ui.info((e as Error).message, "error");
      return false;
    }
    this.models.refresh();
    const workflow = new Workflow({ cfg, repo: this.o.workspace, store, state, bus: this.o.bus, decider: this.o.decider, permissions: this.o.permissions, clarifier: this.o.clarifier, env: this.env });
    this.escaped = false;
    const exec: Extract<Execution, { kind: "pipeline" }> = { kind: "pipeline", store, workflow, cfg, done: Promise.resolve(), release };
    const conversation = this.conversation;
    this.active = exec;
    this.o.ui.setStatus("running");
    exec.done = (async () => {
      await Promise.resolve();
      let code: number = EXIT.ERROR;
      let unprepared = false;
      try {
        code = await workflow.run();
      } catch (e) {
        unprepared = e instanceof RunGitError;
        this.o.ui.info(`error: ${(e as Error).message}`, "error");
      } finally {
        store.unlock();
      }
      this.last = store;
      if (unprepared) {
        // Its snapshots could not be set up or opened: the run is as it was, to continue once the cause is fixed.
        this.paused = store;
        this.o.ui.info(`Run ${store.taskId} is unchanged: fix this, then /resume continues it.`);
        return;
      }
      const st = store.loadState();
      if (code === EXIT.INTERRUPTED && this.escaped) {
        this.paused = store;
        // Stopped on a question of Claude's: the step runs again only once it is answered, so /resume asks it first.
        const owes = st.phase === "HUMAN_REVIEW" && st.humanReview?.reason === "clarification_required";
        this.o.ui.info(owes
          ? `Stopped ${st.humanReview!.fromPhase} on a question of Claude's. /resume asks it again, and re-runs the step with your answer; /new leaves it. Meanwhile you can ask Claude or Codex.`
          : `Stopped ${st.inProgress?.phase ?? st.phase}. /resume re-runs it (/resume <what to change> adds a note); /new leaves it. Meanwhile you can ask Claude or Codex.`);
        return;
      }
      if (code === EXIT.HUMAN_REVIEW) {
        this.o.ui.info(st.humanReview?.reason === "clarification_required"
          ? "The run is waiting for your answers to an agent's questions; type /resume to answer them."
          : "The run is waiting for your decision; type /resume to decide.");
      }
      // The conversation that started it keeps what came of it.
      conversation.addEarlier({ ...(await this.outcome(st)), runId: store.taskId });
    })().finally(() => this.settled(exec));
    return true;
  }

  private async outcome(st: RunState): Promise<EarlierTask> {
    const parts = [OUTCOMES[st.phase] ?? "stopped"];
    if (st.lastImplementation?.summary) parts.push(firstLine(st.lastImplementation.summary, 300));
    if (st.base && st.lastSnapshot) {
      try {
        const files = (await openRunGit(st, this.o.workspace, this.env).nameStatus(st.base.tree, st.lastSnapshot.tree)).map(([, path]) => path);
        if (files.length) parts.push(`files: ${files.slice(0, 12).join(", ")}${files.length > 12 ? ", …" : ""}`);
      } catch {
        // the outcome is a courtesy for the next run; a git hiccup must not end the chat
      }
    }
    return { task: firstLine(st.task, 200), outcome: parts.join("; ") };
  }

  /**
   * A stopped run's own config, with this chat's next-call changes on top: who plays which role and the loop limits
   * stay as the run saved them. A run with no saved config.json (an older agentduo's) takes the chat's, as said.
   */
  private configOf(store: RunStore): ConfigData {
    if (!store.exists("config.json")) {
      this.o.ui.info(`Run ${store.taskId} has no saved config.json, so it continues with this chat's current settings (agents and limits included).`);
      return structuredClone(this.cfg);
    }
    const cfg = configFromSaved(store.readJson("config.json"));
    for (const change of this.changes) if (change.live === "next-call") change.apply(cfg);
    return cfg;
  }

  /**
   * /resume [note | run id]: the stopped run, another resumable run by id, or the latest one. The waiting files go
   * with the note (a note of their own when there is none), copied into the run.
   */
  private resume(arg: string, o: SubmitOptions = {}): void {
    if (this.active) return this.busy();
    const teamId = this.teamToResume(arg.trim());
    if (teamId) return this.resumeTeam(teamId, arg.trim() === teamId ? "" : arg.trim());
    if (this.elsewhere()) return;
    const release = this.takeWorkspace();
    if (!release) return;
    try {
      this.resumeHeld(arg, o, release);
    } catch (e) {
      if (!this.runsWith(release)) release();
      throw e;
    }
  }

  private resumeHeld(arg: string, o: SubmitOptions, release: () => void): void {
    let files: Attachment[];
    try {
      files = this.conversation.select(o.attachments);
    } catch (e) {
      if (!(e instanceof AttachmentError)) throw e;
      release();
      this.o.ui.info(e.message, "error");
      return;
    }
    let note = arg.trim();
    const byId = RUN_ID.test(note) && !note.includes("..") ? resumableRun(this.o.runsDir, this.o.workspace, note) : null;
    if (byId) note = "";
    const target = byId ?? this.paused ?? latestResumable(this.o.runsDir, this.o.workspace);
    if (!target) {
      release();
      this.o.ui.info("Nothing to resume.");
      return;
    }
    const cfg = this.configOf(target);
    const problem = missingCli(cfg, Object.values(cfg.agents), this.env, target.exists("config.json"));
    if (problem) {
      release();
      this.o.ui.info(problem.message, "error");
      return;
    }
    const state = target.loadState();
    if (note || files.length) {
      const copies = this.copyInto(target, files);
      if (!copies) {
        release();
        return;
      }
      state.humanNotes.push({ at: nowIso(), phase: state.inProgress?.phase ?? state.phase, note: note || FILES_NOTE, ...(copies.length ? { attachments: copies } : {}) });
      target.saveState(state);
      this.sentFiles(files);
    }
    const paused = this.paused;
    this.paused = null;
    const saved = target.exists("config.json");
    if (!this.start(target, state, cfg, release)) this.paused = paused;
    // The chat's agent options it resumed with are the run's now: a later resume starts from them.
    else if (saved) target.writeJson("config.json", cfg);
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
    this.unsavedRecipient = false;
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
   * Applies a setting to new runs, questions and discussions. A next-call one also reaches the run that is going from
   * its next agent call (its saved config follows, so a resume keeps it); a next-run one leaves that run as it started.
   * --save also writes it to the config file, --global to the user's.
   */
  private change(change: SettingChange, flags: SaveFlags, text: () => string, quiet = false): void {
    change.apply(this.cfg);
    this.changes = withChange(this.changes, change);
    const running = this.active?.kind === "pipeline" ? this.active : null;
    const now = change.live === "next-call";
    if (running && now) {
      change.apply(running.cfg);
      running.store.writeJson("config.json", running.cfg);
    }
    const saved = quiet ? null : this.persist(change, flags);
    this.o.ui.setMode(permissionMode(this.cfg));
    this.o.ui.setSettings?.(settingsView(this.cfg));
    this.models.refresh();
    if (!saved) return;
    const when = running ? (now ? " Applies from the next agent call of the current run." : " Applies to the next run; the current run keeps its own.")
      : this.active?.kind === "discussion" && !now ? " Applies to the next discussion." : this.active ? " Applies from the next question." : "";
    this.o.ui.info(`${text()}${when}${saved.text}`);
    this.o.changed?.(change, saved.wrote);
  }

  /**
   * A change made elsewhere (another conversation of the workspace, or the desktop's Settings, which said so and saved
   * it): this chat follows it quietly, with the same timing as its own changes.
   */
  follow(change: SettingChange): void {
    this.change(change, {}, () => "", true);
  }

  /** Writes a change where --save and --global say; returns what the message about it says of that, and what was written. */
  private persist(change: SettingChange, flags: SaveFlags): { text: string; wrote: SaveFlags } {
    const { configFile, userConfigFile } = this.o;
    const wrote = { save: false, global: false };
    if (!flags.save && !flags.global) return { text: " (this chat only; add --save to keep it in this workspace, or --global in every workspace)", wrote };
    const saved: string[] = [];
    let hidden: string[] = [];
    try {
      if (flags.save) {
        saveSettings(configFile, this.cfg, change.paths);
        saved.push(configFile);
        wrote.save = true;
      }
      if (flags.global) {
        hidden = saveGlobalSetting(userConfigFile, configFile, change);
        saved.push(userConfigFile);
        wrote.global = true;
      }
    } catch (e) {
      const failed = flags.save && !saved.length ? configFile : userConfigFile;
      return { text: `${saved.length ? `; saved to ${saved[0]}` : ""}; could not save it to ${failed}: ${(e as Error).message}`, wrote };
    }
    const scope = `; saved to ${[...new Set(saved)].join(" and ")}`;
    if (!hidden.length) return { text: scope, wrote };
    return {
      text: `${scope}, but ${configFile} sets ${hidden.join(" and ")} too, which wins in this workspace: the saved setting will not apply here ` +
        "next time (add --save to save it here as well)",
      wrote,
    };
  }

  /**
   * A setting from a command or the settings panel: shows it when it has no value, changes it otherwise. `quiet`: it was
   * changed in another conversation of the workspace, which said so (and saved it): this one only follows.
   */
  applySetting(s: SettingCommand, flags: SaveFlags & { yes?: boolean; quiet?: boolean } = {}): void {
    const ui = this.o.ui;
    const saveFlags: SaveFlags = { save: !!flags.save, global: !!flags.global };
    const quiet = !!flags.quiet;
    const change = (c: SettingChange, text: () => string) => this.change(c, saveFlags, text, quiet);
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
          `Changes in this chat are not saved unless a command ends with --save (it writes ${this.o.configFile}) or --global (it writes ${this.o.userConfigFile}).`);
        return;
      case "plan": {
        const plan = store && (store.exists("plan.final.md") ? store.readText("plan.final.md") : store.exists("plan.md") ? store.readText("plan.md") : null);
        ui.info(plan ? `── plan ──\n${plan.trimEnd()}` : "There is no plan yet.");
        return;
      }
      case "diff": {
        const st = store?.loadState();
        let stat = "";
        if (st?.base && st.lastSnapshot) {
          try {
            stat = (await openRunGit(st, this.o.workspace, this.env).diffStat(st.base.commit, st.lastSnapshot.commit)).trimEnd();
          } catch (e) {
            ui.info(`Cannot read the snapshots of run ${st.taskId}: ${(e as Error).message}`, "error");
            return;
          }
        }
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
        // The run's snapshots are where it recorded them, which the run checks before its next step or decision.
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
