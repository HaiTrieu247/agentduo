// One workspace folder's session in the extension host: its worker, and the presentation state the sidebar shows.
// The worker outlives the view (hiding the sidebar or recreating the webview never stops a run); a reattached view
// gets a snapshot. No `vscode` import, so it is tested against a real worker.
import type { PermissionAnswer } from "../../../src/events.js";
import { initialState, reduce, type SessionState, type ViewAction, type ViewState } from "../webview/state.js";
import type { DecisionChoice, HostMessage, Problem, WorkerRequest, WorkerResults } from "./protocol.js";
import { WorkerClient, WorkerError, type NodeLookup } from "./workerClient.js";

/** Messages arriving this close together reach the webview in one batch. */
const FLUSH_MS = 16;
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

export interface WorkspaceSessionOptions {
  workspace: string;
  configPath: string | null;
  workerScript: string;
  env: NodeJS.ProcessEnv;
  resolveNode(): NodeLookup;
  /** Unique across sessions, so an answer meant for an earlier worker is told apart. */
  nextGeneration(): number;
  log(line: string): void;
  onChange?(state: ViewState): void;
  /** A question arrived; the host may tell the user when the sidebar is not visible. */
  onQuestion?(kind: "decision" | "permission", text: string): void;
}

export class WorkspaceSession {
  private current: ViewState;
  /** The worker a start has forked, until that start is over: restart and dispose shut it down without waiting for it. */
  private launching: WorkerClient | null = null;
  /** The worker this session owns, from its hello on, initialized or not; its messages and exit are ours. */
  private spawned: WorkerClient | null = null;
  /** The same worker once `initialize` has answered: only then does it take other requests. */
  private client: WorkerClient | null = null;
  private starting: Promise<WorkerClient | null> | null = null;
  /** Shutdowns of workers let go of; a restart starts the next worker only once they are over (one lock holder). */
  private stopping: Promise<void> = Promise.resolve();
  private post: ((message: HostMessage) => void) | null = null;
  private queue: ViewAction[] = [];
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(private readonly o: WorkspaceSessionOptions) {
    this.current = initialState("starting", o.workspace, 0);
  }

  get workspace(): string {
    return this.o.workspace;
  }

  get state(): ViewState {
    return this.current;
  }

  get workerPid(): number | undefined {
    return this.spawned?.pid;
  }

  /** The view (re)appeared: it gets the whole state, then batches of actions. */
  attach(post: (message: HostMessage) => void): void {
    this.post = post;
    this.queue = [];
    post({ type: "snapshot", state: this.current });
  }

  detach(): void {
    this.post = null;
    this.queue = [];
  }

  private dispatch(action: ViewAction): void {
    this.current = reduce(this.current, action);
    this.o.onChange?.(this.current);
    if (!this.post) return;
    this.queue.push(action);
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush(): void {
    this.timer = null;
    const actions = this.queue;
    this.queue = [];
    if (actions.length && this.post) this.post({ type: "actions", actions });
  }

  note(text: string, tone: "info" | "error" = "info"): void {
    this.dispatch({ type: "note", text, tone });
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
      this.dispatch({ type: "workspace", session: "stopped", workspace: this.o.workspace, generation: this.current.generation });
      this.dispatch({ type: "problem", problem: { kind: "node", message: node.message } });
      return null;
    }
    const generation = this.o.nextGeneration();
    this.dispatch({ type: "workspace", session: "starting", workspace: this.o.workspace, generation });
    const client = new WorkerClient({ node: node.path, script: this.o.workerScript, cwd: this.o.workspace, env: this.o.env, generation, log: this.o.log });
    client.onMessage((m) => {
      if (this.spawned !== client) return;
      switch (m.kind) {
        case "event":
          this.dispatch({ type: "event", event: m.event, now: Date.now() });
          if (m.event.type === "permission.requested") this.o.onQuestion?.("permission", `${m.event.request.tool}: ${m.event.request.label}`);
          break;
        case "ui":
          this.dispatch({ type: "ui", update: m.update });
          break;
        case "decision":
          this.dispatch({ type: "decision.open", id: m.requestId, review: m.review, views: m.views });
          this.o.onQuestion?.("decision", m.review.message);
          break;
        case "decisionClosed":
          this.dispatch({ type: "decision.closed", id: m.requestId });
          break;
      }
    });
    client.onExit((code, signal) => {
      if (this.spawned !== client) return;
      this.spawned = null;
      this.client = null;
      if (this.disposed) return;
      this.dispatch({ type: "workspace", session: "stopped", workspace: this.o.workspace, generation });
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
      this.dispatch({ type: "workspace", session: "stopped", workspace: this.o.workspace, generation });
      this.dispatch({ type: "problem", problem: { kind: "worker", message: (e as Error).message } });
      return null;
    }
    if (released()) return null;
    this.spawned = client;
    try {
      const init = await client.request({ type: "initialize", workspace: this.o.workspace, configPath: this.o.configPath });
      if (this.spawned === client) {
        this.dispatch({ type: "initialized", version: init.version, workspace: init.workspace, pipeline: init.pipeline, edits: init.edits });
        this.dispatch({ type: "problem", problem: init.problem });
        for (const warning of init.warnings) this.note(`warning: ${warning}`);
        if (init.hint) this.note(init.hint);
      }
    } catch (e) {
      if (this.spawned === client) this.fail(e);
    }
    // Gone meanwhile (it exited, or restart or dispose let go of it): there is no worker to hand out.
    if (this.spawned !== client) return null;
    this.client = client;
    return client;
  }

  private fail(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof WorkerError && PROBLEM_CODES.has(e.code)) this.dispatch({ type: "problem", problem: { kind: e.code as Problem["kind"], message } });
    this.note(message, "error");
  }

  /** A task, a note for the running run, a re-run of a stopped step (even an empty message), or a slash command. */
  async submit(text: string): Promise<void> {
    if (text.trim()) this.dispatch({ type: "user", text: text.trim() });
    await this.send({ type: "submit", text });
  }

  async interrupt(): Promise<void> {
    if (this.client?.running) await this.send({ type: "interrupt" });
  }

  async toggleEdits(): Promise<void> {
    await this.send({ type: "toggleEdits" });
  }

  async answerDecision(generation: number, id: string, decision: DecisionChoice, note: string | null): Promise<void> {
    if (generation !== this.current.generation || this.current.decision?.id !== id) {
      this.note("That decision is no longer pending.", "error");
      return;
    }
    await this.send({ type: "decision", requestId: id, answer: { decision, note } });
  }

  async answerPermission(generation: number, id: string, answer: PermissionAnswer): Promise<void> {
    if (generation !== this.current.generation || !this.current.permissions.some((p) => p.request.id === id)) {
      this.note("That permission prompt is no longer pending.", "error");
      return;
    }
    await this.send({ type: "permissionAnswer", requestId: id, answer });
  }

  private async send<T extends WorkerRequest["type"]>(request: WorkerRequestOf<T>): Promise<WorkerResults[T] | null> {
    const client = await this.start();
    if (!client) return null;
    try {
      return await client.request(request);
    } catch (e) {
      this.fail(e);
      return null;
    }
  }

  /** For artifacts, changes and doctor: errors come back to the caller, which shows them where they were asked for. */
  async request<T extends WorkerRequest["type"]>(request: WorkerRequestOf<T>): Promise<WorkerResults[T]> {
    const client = await this.start();
    if (!client) throw new WorkerError("exited", this.current.problem?.message ?? "the agentduo worker is not running");
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
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.post = null;
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
