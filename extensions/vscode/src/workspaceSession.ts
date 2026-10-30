// One workspace folder's session in the extension host: its worker, and what each conversation's tab shows. The
// worker outlives the tabs (hiding or recreating a webview never stops a run); a reattached tab gets a snapshot, and a
// tab reopened after a reload gets what it showed then (view.json beside the conversation). No `vscode` import, so it
// is tested against a real worker.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Attachment } from "../../../src/core/attachment-types.js";
import { attachmentFile } from "../../../src/core/attachments.js";
import type { Backend } from "../../../src/core/commands.js";
import { atomicWrite } from "../../../src/core/state.js";
import type { PermissionAnswer } from "../../../src/events.js";
import { initialState, reduce, uploading, type SessionState, type ViewAction, type ViewState } from "../webview/state.js";
import type { DecisionChoice, HostMessage, Problem, Route, SettingRequest, WorkerRequest, WorkerResults } from "./protocol.js";
import { WorkerClient, WorkerError, type NodeLookup } from "./workerClient.js";

/** Messages arriving this close together reach the webview in one batch. */
const FLUSH_MS = 16;
/** What a tab shows is saved at most this often while it changes (and when the tab or the session goes). */
const SAVE_MS = 1000;
const VIEW_FILE = "view.json";
const PROBLEM_CODES = new Set<string>(["environment", "config", "not_repo", "missing_cli", "locked"]);

export type WorkspaceChoice = { kind: "none" } | { kind: "choose"; folders: string[] } | { kind: "folder"; path: string };

/** One folder is used as is; with several, the user picks (a remembered pick stays while it is still open). */
export function pickWorkspace(folders: string[], remembered: string | null): WorkspaceChoice {
  if (!folders.length) return { kind: "none" };
  if (folders.length === 1) return { kind: "folder", path: folders[0]! };
  if (remembered && folders.includes(remembered)) return { kind: "folder", path: remembered };
  return { kind: "choose", folders };
}

/** A placeholder state while there is no session to show (no folder open, or a folder still to choose). */
export function emptyState(session: Extract<SessionState, "no-folder" | "choose-folder">): ViewState {
  return initialState(session);
}

/** Actions that add to a tab's timeline: a broadcast one reaches every tab, never the workspace's own state. */
const addsToTimeline = (a: ViewAction) => a.type === "note" || a.type === "user" || a.type === "event" || (a.type === "ui" && (a.update.type === "info" || a.update.type === "status" || a.update.type === "recipient"));

/**
 * What a tab showed before a reload, as it can show it now: its timeline and recipient, with the workspace as it is
 * now (worker, models, settings). Nothing that waited on the old worker is pending any more, and nothing runs.
 */
export function restoredView(saved: ViewState, now: ViewState): ViewState {
  return {
    ...saved, generation: now.generation, session: now.session, workspace: now.workspace, version: now.version, pipeline: now.pipeline, mode: now.mode,
    models: now.models, settings: now.settings, catalog: now.catalog, problem: now.problem, status: "idle", current: null, turn: null, discussion: null,
    decision: null, permissions: [], usage: null, attachments: [],
  };
}

/** A conversation's tab as the host keeps it: what it shows, and where that goes while the tab is open. */
interface TabView {
  state: ViewState;
  post: ((message: HostMessage) => void) | null;
  queue: ViewAction[];
  timer: NodeJS.Timeout | null;
  saveTimer: NodeJS.Timeout | null;
  /** Opened before the worker said where conversations live: what it showed before a reload is loaded then. */
  restore: boolean;
}

/** The requests and state of one conversation's tab. */
export interface ConversationHandle {
  readonly id: string;
  readonly state: ViewState;
  attach(post: (message: HostMessage) => void): void;
  detach(): void;
  /** `attachments`: the ids of the tab's ready files that go with it. */
  submit(text: string, route?: Route, attachments?: string[]): Promise<void>;
  /**
   * A pasted or dropped file arrived, still to be written for the worker: its chip takes its place among the files now
   * (they keep the order they came in), and a message waits for it.
   */
  uploading(key: string, name: string): void;
  /** A file for the next message, at a path the host chose (picked by the user, or written from a paste or a drop). */
  stage(file: { key: string; path: string; name: string }): Promise<void>;
  /** A file of the composer removed, by its key: a waiting one goes from the worker too. */
  removeFile(key: string): void;
  /** A file the host could not even hand to the worker (too large, not base64…): the composer shows why. */
  failed(key: string, name: string, error: string): void;
  selectRecipient(backend: Backend): Promise<void>;
  applySetting(request: SettingRequest): Promise<void>;
  interrupt(): Promise<void>;
  cycleMode(): Promise<void>;
  /** Looks the usage up again for the tab's usage panel (its Refresh, the title bar's Usage), with no line in the timeline. */
  usage(): Promise<void>;
  answerDecision(generation: number, id: string, decision: DecisionChoice, note: string | null): Promise<void>;
  answerPermission(generation: number, id: string, answer: PermissionAnswer): Promise<void>;
  /** The tab was closed: what it shows is saved, and what runs in it stops. */
  close(): Promise<void>;
}

export interface WorkspaceSessionOptions {
  workspace: string;
  configPath: string | null;
  workerScript: string;
  env: NodeJS.ProcessEnv;
  resolveNode(): NodeLookup;
  /** Unique across sessions, so an answer meant for an earlier worker is told apart. */
  nextGeneration(): number;
  log(line: string): void;
  /** A tab's state changed (its title, its questions); the host updates the tab, the list and the badge. */
  onChange?(conversation: string, state: ViewState): void;
  /** A question arrived in a tab; the host may tell the user when that tab is not visible. */
  onQuestion?(conversation: string, kind: "decision" | "permission", text: string): void;
  /** /new in a tab: the host opens a new tab with a new conversation; the old one keeps its own. */
  onNewConversation?(): void;
}

export class WorkspaceSession {
  /** The workspace as every tab shows it (worker, models, settings); a new tab starts from it. */
  private base: ViewState;
  private readonly views = new Map<string, TabView>();
  private readonly handles = new Map<string, ConversationHandle>();
  /** Where conversations live, once the worker has said: each tab's view.json goes beside its conversation. */
  private runsDir: string | null = null;
  /** The worker a start has forked, until that start is over: restart and dispose shut it down without waiting for it. */
  private launching: WorkerClient | null = null;
  /** The worker this session owns, from its hello on, initialized or not; its messages and exit are ours. */
  private spawned: WorkerClient | null = null;
  /** The same worker once `initialize` has answered: only then does it take other requests. */
  private client: WorkerClient | null = null;
  private starting: Promise<WorkerClient | null> | null = null;
  /** Shutdowns of workers let go of; a restart starts the next worker only once they are over (one lock holder). */
  private stopping: Promise<void> = Promise.resolve();
  private disposed = false;
  /** Conversations whose worker named an attachment root other than their own: their tab is granted none. */
  private readonly untrusted = new Set<string>();

  constructor(private readonly o: WorkspaceSessionOptions) {
    this.base = initialState("starting", o.workspace, 0);
  }

  get workspace(): string {
    return this.o.workspace;
  }

  /** The workspace's own state, as a new tab would start from it. */
  get workspaceState(): ViewState {
    return this.base;
  }

  /** Where the workspace's conversations live, once the worker has said (null before). */
  get runsDirectory(): string | null {
    return this.runsDir;
  }

  /**
   * Where the tab of `id` may show attached images from: its conversation's copies, under the runs directory the
   * worker said; null before it said, or once the worker named another place for them (never trusted then).
   */
  attachmentRoot(id: string): string | null {
    return this.runsDir && !this.untrusted.has(id) ? join(this.runsDir, "conversations", id, "attachments") : null;
  }

  /** The copy of `a` the tab of `id` may show: inside its root, and still there; null otherwise. */
  attachmentPath(id: string, a: Attachment): string | null {
    const root = this.attachmentRoot(id);
    const file = this.runsDir ? attachmentFile(this.runsDir, a) : null;
    const rel = root && file ? relative(resolve(root), resolve(file)) : "";
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    return existsSync(file!) ? file : null;
  }

  /** The conversations that have a tab in this session. */
  get conversations(): string[] {
    return [...this.views.keys()];
  }

  get workerPid(): number | undefined {
    return this.spawned?.pid;
  }

  /** The tab of `id`, its requests and its state; opening a tab that showed something before a reload restores it. */
  conversation(id: string): ConversationHandle {
    const known = this.handles.get(id);
    if (known) return known;
    const handle: ConversationHandle = {
      id,
      get state() {
        return session.view(id).state;
      },
      attach: (post) => this.attach(id, post),
      detach: () => this.detach(id),
      submit: (text, route, attachments) => this.submit(id, text, route, attachments),
      uploading: (key, name) => this.dispatch({ type: "attachment.uploading", key, name }, id),
      stage: (file) => this.stage(id, file),
      removeFile: (key) => this.removeFile(id, key),
      failed: (key, name, error) => this.dispatch({ type: "attachment.failed", key, name, error }, id),
      selectRecipient: (backend) => this.send({ type: "recipient", conversation: id, backend }, id).then(() => undefined),
      applySetting: (request) => this.send({ type: "setting", conversation: id, ...request }, id).then(() => undefined),
      interrupt: async () => {
        if (this.client?.running) await this.send({ type: "interrupt", conversation: id }, id);
      },
      cycleMode: () => this.send({ type: "cycleMode", conversation: id }, id).then(() => undefined),
      usage: () => this.send({ type: "usage", conversation: id }, id).then(() => undefined),
      answerDecision: (generation, requestId, decision, note) => this.answerDecision(id, generation, requestId, decision, note),
      answerPermission: (generation, requestId, answer) => this.answerPermission(id, generation, requestId, answer),
      close: () => this.close(id),
    };
    const session = this;
    this.handles.set(id, handle);
    return handle;
  }

  private view(id: string): TabView {
    let view = this.views.get(id);
    if (view) return view;
    const saved = this.runsDir ? this.loadView(id) : null;
    view = { state: saved ? restoredView(saved, this.base) : this.base, post: null, queue: [], timer: null, saveTimer: null, restore: !this.runsDir };
    this.views.set(id, view);
    return view;
  }

  private viewFile(id: string): string | null {
    return this.runsDir ? join(this.runsDir, "conversations", id, VIEW_FILE) : null;
  }

  private loadView(id: string): ViewState | null {
    const file = this.viewFile(id);
    try {
      return file && existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ViewState) : null;
    } catch (e) {
      this.o.log(`could not read ${file}: ${(e as Error).message}`);
      return null;
    }
  }

  /** Saves what a tab shows, once it shows something: an empty tab leaves no file. */
  private saveView(id: string): void {
    const view = this.views.get(id);
    if (!view) return;
    if (view.saveTimer) clearTimeout(view.saveTimer);
    view.saveTimer = null;
    const file = this.viewFile(id);
    if (!file || !view.state.timeline.length) return;
    try {
      mkdirSync(join(file, ".."), { recursive: true });
      atomicWrite(file, JSON.stringify(view.state));
    } catch (e) {
      this.o.log(`could not save ${file}: ${(e as Error).message}`);
    }
  }

  /** The worker said where conversations live: tabs opened before that get what they showed before a reload. */
  private restoreViews(): void {
    for (const [id, view] of this.views) {
      if (!view.restore) continue;
      view.restore = false;
      const saved = this.loadView(id);
      if (!saved || view.state.timeline.length) continue;
      view.state = restoredView(saved, this.base);
      view.queue = [];
      view.post?.({ type: "snapshot", state: view.state, conversation: id });
      this.o.onChange?.(id, view.state);
    }
  }

  /** The tab (re)appeared: it gets its whole state, then batches of actions. */
  private attach(id: string, post: (message: HostMessage) => void): void {
    const view = this.view(id);
    view.post = post;
    view.queue = [];
    post({ type: "snapshot", state: view.state, conversation: id });
  }

  private detach(id: string): void {
    const view = this.views.get(id);
    if (!view) return;
    view.post = null;
    view.queue = [];
  }

  private async close(id: string): Promise<void> {
    const view = this.views.get(id);
    if (!view) return;
    this.saveView(id);
    if (view.timer) clearTimeout(view.timer);
    this.views.delete(id);
    this.handles.delete(id);
    if (this.client?.running) await this.send({ type: "closeConversation", conversation: id }, null);
  }

  /** An action for one tab, or with `to` null for the whole workspace: every tab, and the state new tabs start from. */
  private dispatch(action: ViewAction, to: string | null): void {
    if (to !== null) return this.apply(to, this.view(to), action);
    if (!addsToTimeline(action)) this.base = reduce(this.base, action);
    for (const [id, view] of this.views) this.apply(id, view, action);
  }

  private apply(id: string, view: TabView, action: ViewAction): void {
    view.state = reduce(view.state, action);
    this.o.onChange?.(id, view.state);
    view.saveTimer ??= setTimeout(() => this.saveView(id), SAVE_MS);
    if (!view.post) return;
    view.queue.push(action);
    view.timer ??= setTimeout(() => this.flush(view), FLUSH_MS);
  }

  private flush(view: TabView): void {
    view.timer = null;
    const actions = view.queue;
    view.queue = [];
    if (actions.length && view.post) view.post({ type: "actions", actions });
  }

  /** A line from agentduo itself, in one tab, or with no conversation in every tab. */
  note(text: string, tone: "info" | "error" = "info", conversation: string | null = null): void {
    this.dispatch({ type: "note", text, tone }, conversation);
  }

  /**
   * The initialized worker, starting one if none runs. It only reads the workspace: no lock, no run, no agent.
   * A request made while a start is under way waits for it, so nothing reaches the worker before `initialize`.
   */
  start(): Promise<WorkerClient | null> {
    if (this.disposed) return Promise.resolve(null);
    if (this.starting) return this.starting;
    if (this.client?.running) return Promise.resolve(this.client);
    return this.begin(() => this.spawn());
  }

  /**
   * Makes `run` the start under way; `current()` tells it whether it still is. When restart gives it up, whoever
   * waits on it gets the start that replaced it.
   */
  private begin(run: (current: () => boolean) => Promise<WorkerClient | null>): Promise<WorkerClient | null> {
    const starting: Promise<WorkerClient | null> = run(() => this.starting === starting)
      .then((client) => client ?? (this.starting && this.starting !== starting ? this.starting : null))
      .finally(() => {
        if (this.starting === starting) this.starting = null;
      });
    this.starting = starting;
    return starting;
  }

  private async spawn(): Promise<WorkerClient | null> {
    const node = this.o.resolveNode();
    if (!node.ok) {
      this.dispatch({ type: "workspace", session: "stopped", workspace: this.o.workspace, generation: this.base.generation }, null);
      this.dispatch({ type: "problem", problem: { kind: "node", message: node.message } }, null);
      return null;
    }
    const generation = this.o.nextGeneration();
    this.dispatch({ type: "workspace", session: "starting", workspace: this.o.workspace, generation }, null);
    const client = new WorkerClient({ node: node.path, script: this.o.workerScript, cwd: this.o.workspace, env: this.o.env, generation, log: this.o.log });
    client.onMessage((m) => {
      if (this.spawned !== client) return;
      switch (m.kind) {
        case "event":
          this.dispatch({ type: "event", event: m.event, now: Date.now() }, m.conversation);
          if (m.event.type === "permission.requested") this.o.onQuestion?.(m.conversation, "permission", `${m.event.request.tool}: ${m.event.request.label}`);
          break;
        case "ui":
          this.dispatch({ type: "ui", update: m.update }, m.conversation);
          break;
        case "decision":
          this.dispatch({ type: "decision.open", id: m.requestId, review: m.review, views: m.views }, m.conversation);
          this.o.onQuestion?.(m.conversation, "decision", m.review.message);
          break;
        case "decisionClosed":
          this.dispatch({ type: "decision.closed", id: m.requestId }, m.conversation);
          break;
      }
    });
    client.onExit((code, signal) => {
      if (this.spawned !== client) return;
      this.spawned = null;
      this.client = null;
      if (this.disposed) return;
      this.dispatch({ type: "workspace", session: "stopped", workspace: this.o.workspace, generation }, null);
      this.note(`The agentduo worker stopped (${signal ?? `exit code ${code}`}). A run that was going stays resumable: send a message or /resume to start again.`, "error");
    });
    this.launching = client;
    try {
      return await this.launch(client, node, generation);
    } finally {
      if (this.launching === client) this.launching = null;
    }
  }

  /** Waits for the hello, then for `initialize`; once restart or dispose has let go of the worker, it gives up quietly. */
  private async launch(client: WorkerClient, node: Extract<NodeLookup, { ok: true }>, generation: number): Promise<WorkerClient | null> {
    const released = () => this.launching !== client;
    this.o.log(`starting the worker with Node ${node.version} (${node.path}) in ${this.o.workspace}`);
    try {
      const hello = await client.start();
      this.o.log(`worker ${hello.pid} up: agentduo ${hello.version} on Node ${hello.node}`);
    } catch (e) {
      if (released()) return null;
      this.dispatch({ type: "workspace", session: "stopped", workspace: this.o.workspace, generation }, null);
      this.dispatch({ type: "problem", problem: { kind: "worker", message: (e as Error).message } }, null);
      return null;
    }
    if (released()) return null;
    this.spawned = client;
    try {
      const init = await client.request({ type: "initialize", workspace: this.o.workspace, configPath: this.o.configPath });
      if (this.spawned === client) {
        this.dispatch({
          type: "initialized", version: init.version, workspace: init.workspace, pipeline: init.pipeline, mode: init.mode, recipient: init.recipient,
          models: init.models, settings: init.settings,
        }, null);
        this.dispatch({ type: "problem", problem: init.problem }, null);
        this.runsDir = init.runsDir;
        this.restoreViews();
        for (const warning of init.warnings) this.note(`warning: ${warning}`);
        if (init.hint) this.note(init.hint);
      }
    } catch (e) {
      if (this.spawned === client) this.fail(e, null);
    }
    // Gone meanwhile (it exited, or restart or dispose let go of it): there is no worker to hand out.
    if (this.spawned !== client) return null;
    this.client = client;
    return client;
  }

  /** A request failed: the problem is the workspace's, the message goes to the tab that asked (or every tab). */
  private fail(e: unknown, to: string | null = null): void {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof WorkerError && PROBLEM_CODES.has(e.code)) this.dispatch({ type: "problem", problem: { kind: e.code as Problem["kind"], message } }, null);
    this.note(message, "error", to);
  }

  /**
   * A question for the recipient, a note for the running run, or a slash command; with the Pipeline route, a task for
   * the pipeline, and with the Discuss route a question to discuss (a slash command still goes as typed). Resolves once
   * the worker has started it, not when it is done.
   */
  private async submit(conversation: string, text: string, route: Route = "message", attachments: string[] = []): Promise<void> {
    const typed = text.trim();
    // /new keeps this tab's conversation and starts another in a new tab (the terminal chat starts over instead).
    if (/^\/new$/.test(typed) && this.o.onNewConversation) return this.o.onNewConversation();
    if (uploading(this.view(conversation).state)) {
      this.note("Some files are still being attached: send once they are ready (or remove them).", "error", conversation);
      return;
    }
    const command = typed.startsWith("/");
    // Files alone are a message too; the worker says which went with it (`sent`), and they join it then.
    if (typed || attachments.length) {
      this.dispatch({ type: "user", text: typed, ...(route === "pipeline" && !command ? { pipeline: true } : {}), ...(route === "discuss" && !command ? { discuss: true } : {}) }, conversation);
    }
    await this.send({ type: "submit", conversation, text, route, attachments }, conversation);
  }

  /**
   * A file goes to the worker, which copies it into the conversation. Its answer counts only for the tab, the key and
   * the worker that asked: a tab closed meanwhile, a file removed meanwhile, or a worker started over drop it.
   */
  private async stage(conversation: string, file: { key: string; path: string; name: string }): Promise<void> {
    this.dispatch({ type: "attachment.uploading", key: file.key, name: file.name }, conversation);
    const fail = (error: string) => {
      if (this.views.has(conversation)) this.dispatch({ type: "attachment.failed", key: file.key, name: file.name, error }, conversation);
    };
    let r: WorkerResults["stageAttachment"];
    let generation: number;
    try {
      // The first file of a tab may start the worker: what counts is the worker that took the file.
      const client = await this.start();
      if (!client) throw new WorkerError("exited", this.base.problem?.message ?? "the agentduo worker is not running");
      generation = this.base.generation;
      r = await client.request({ type: "stageAttachment", conversation, key: file.key, path: file.path, name: file.name });
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
    if (!this.views.has(conversation)) return;
    if (r.conversation !== conversation || r.key !== file.key || this.base.generation !== generation) return fail("agentduo started over meanwhile: attach the file again");
    const root = this.attachmentRoot(conversation);
    if (!root || resolve(r.root) !== resolve(root)) {
      this.untrusted.add(conversation);
      this.o.log(`the worker keeps the attachments of ${conversation} in ${r.root}, not ${root ?? "(unknown)"}: its images are not shown`);
    }
    if (!this.view(conversation).state.attachments.some((c) => c.key === file.key)) {
      await this.send({ type: "removeAttachment", conversation, id: r.attachment.id }, conversation);
      return;
    }
    this.dispatch({ type: "attachment.ready", key: file.key, attachment: r.attachment }, conversation);
  }

  private removeFile(conversation: string, key: string): void {
    const chip = this.view(conversation).state.attachments.find((c) => c.key === key);
    if (!chip) return;
    this.dispatch({ type: "attachment.dismissed", key }, conversation);
    if (chip.status === "ready" && chip.attachment) void this.send({ type: "removeAttachment", conversation, id: chip.attachment.id }, conversation);
  }

  private async answerDecision(conversation: string, generation: number, id: string, decision: DecisionChoice, note: string | null): Promise<void> {
    const st = this.view(conversation).state;
    if (generation !== st.generation || st.decision?.id !== id) {
      this.note("That decision is no longer pending.", "error", conversation);
      return;
    }
    await this.send({ type: "decision", requestId: id, answer: { decision, note } }, conversation);
  }

  private async answerPermission(conversation: string, generation: number, id: string, answer: PermissionAnswer): Promise<void> {
    const st = this.view(conversation).state;
    if (generation !== st.generation || !st.permissions.some((p) => p.request.id === id)) {
      this.note("That permission prompt is no longer pending.", "error", conversation);
      return;
    }
    await this.send({ type: "permissionAnswer", requestId: id, answer }, conversation);
  }

  /** A request of a tab (`to`), whose failure that tab shows. */
  private async send<T extends WorkerRequest["type"]>(request: WorkerRequestOf<T>, to: string | null): Promise<WorkerResults[T] | null> {
    const client = await this.start();
    if (!client) return null;
    try {
      return await client.request(request);
    } catch (e) {
      this.fail(e, to);
      return null;
    }
  }

  /** For artifacts, changes and doctor: errors come back to the caller, which shows them where they were asked for. */
  async request<T extends WorkerRequest["type"]>(request: WorkerRequestOf<T>): Promise<WorkerResults[T]> {
    const client = await this.start();
    if (!client) throw new WorkerError("exited", this.base.problem?.message ?? "the agentduo worker is not running");
    return client.request(request);
  }

  /**
   * Stops the worker (it settles open questions, stops the run, frees the lock) and starts a fresh one. A worker
   * still starting is stopped the same way, so this never waits on a start that hangs; requests waiting on that
   * start go to the fresh worker.
   */
  async restart(): Promise<void> {
    if (this.disposed) return;
    const stopped = this.stop();
    await this.begin(async (current) => {
      await stopped;
      // Given up meanwhile, by dispose or by another restart: that one decides what runs next.
      return current() ? this.spawn() : null;
    });
  }

  /** Bounded by the worker's shutdown grace, whatever the worker is doing, starting included. */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const [id, view] of this.views) {
      this.saveView(id);
      if (view.timer) clearTimeout(view.timer);
      view.timer = null;
      view.post = null;
    }
    await this.stop();
  }

  /**
   * Lets go of the worker, started or still starting, and shuts it down: its exit is no longer reported, and its
   * start gives up. Resolves once every worker this session let go of has exited.
   */
  private stop(): Promise<void> {
    const client = this.spawned ?? this.launching;
    this.launching = null;
    this.spawned = null;
    this.client = null;
    this.starting = null;
    if (client) this.stopping = Promise.all([this.stopping, client.shutdown()]).then(() => undefined);
    return this.stopping;
  }
}

type WorkerRequestOf<T extends WorkerRequest["type"]> = Extract<WorkerRequest, { type: T }>;
