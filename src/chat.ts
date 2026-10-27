import { resolve } from "node:path";
import { firstLine } from "./agents/types.js";
import { configFromSaved, type ConfigData } from "./core/config.js";
import { Git } from "./core/git.js";
import { nowIso, RunStore, type EarlierTask, type RunState } from "./core/state.js";
import { EXIT, Workflow } from "./core/workflow.js";
import type { Decider, EventBus, PermissionDecider } from "./events.js";
import { formatCost, formatTokens } from "./ui/format.js";

export type ChatStatus = "idle" | "running" | "paused";

/** What the chat needs from the screen; the agents' own activity reaches it through the EventBus. */
export interface ChatUi {
  /** A line from agentduo itself: command output and hints. */
  info(text: string): void;
  /** idle: a message starts a task; running: a message is a note; paused: stopped with Esc, a message re-runs the step. */
  setStatus(status: ChatStatus): void;
  exit(): void;
}

export interface ChatOptions {
  cfg: ConfigData;
  workspace: string;
  runsDir: string;
  bus: EventBus;
  decider: Decider;
  permissions?: PermissionDecider;
  ui: ChatUi;
}

/** A new run for `task` in this workspace, with the config it starts with saved beside it. */
export function newRun(runsDir: string, workspace: string, task: string, cfg: ConfigData, earlier: EarlierTask[] = []): { store: RunStore; state: RunState } {
  const { store, state } = RunStore.create(runsDir, task, cfg.limits);
  state.workspace = workspace;
  if (earlier.length) state.earlier = earlier;
  store.saveState(state);
  store.writeJson("config.json", cfg);
  return { store, state };
}

const HELP = [
  "Type a task and press Enter: Codex plans and reviews it, Claude critiques the plan and implements it.",
  "While they work, a message is a note the agents get from the next step. Esc stops the current step; your next message then re-runs it.",
  "  /plan    the final plan of the current run",
  "  /diff    what the current run changed",
  "  /status  where the current run is",
  "  /resume  continue the latest stopped or waiting run",
  "  /new     leave a stopped run as it is and start a new task",
  "  /quit    leave (a running run stops and stays resumable)",
  "Ctrl-C twice also quits.",
].join("\n");

const OUTCOMES: Partial<Record<RunState["phase"], string>> = { DONE: "done", ABORTED: "aborted", HUMAN_REVIEW: "waiting for a decision" };

/** One chat session in one workspace: every message becomes a run, a note for the running one, or a command. */
export class Chat {
  private current: { store: RunStore; workflow: Workflow; done: Promise<void> } | null = null;
  /** Stopped with Esc: the next message re-runs its step. */
  private paused: RunStore | null = null;
  private last: RunStore | null = null;
  private escaped = false;
  private readonly earlier: EarlierTask[] = [];
  private readonly git: Git;

  constructor(private readonly o: ChatOptions) {
    this.git = new Git(o.workspace);
  }

  /** Points at a run an earlier session left stopped or waiting. */
  async greet(): Promise<void> {
    const store = this.latestResumable();
    if (!store) return;
    const st = store.loadState();
    const where = st.phase === "HUMAN_REVIEW" ? "is waiting for your decision" : `stopped during ${st.inProgress?.phase ?? st.phase}`;
    this.o.ui.info(`Run ${st.taskId} (${firstLine(st.task, 60)}) ${where}. Type /resume to continue it.`);
  }

  async submit(raw: string): Promise<void> {
    const text = raw.trim();
    if (text.startsWith("/")) return this.command(text);
    if (this.current) {
      if (!text) return;
      this.current.workflow.addNote(text);
      this.o.ui.info("Noted: the agents get this from the next step. Esc stops the current step to apply it now.");
      return;
    }
    if (this.paused) {
      const store = this.paused;
      this.paused = null;
      const state = store.loadState();
      if (text) {
        state.humanNotes.push({ at: nowIso(), phase: state.inProgress?.phase ?? state.phase, note: text });
        store.saveState(state);
      }
      this.start(store, state, this.configOf(store));
      return;
    }
    if (!text) return;
    const { store, state } = newRun(this.o.runsDir, this.o.workspace, text, this.o.cfg, [...this.earlier]);
    this.start(store, state, this.o.cfg);
  }

  /** Esc: stop the running step; it re-runs with the user's next message. */
  escape(): void {
    if (!this.current) return;
    this.escaped = true;
    this.current.workflow.interrupt();
  }

  /** The run the screen talks about (for the decision prompt's views). */
  focused(): { store: RunStore; state: RunState } | null {
    const store = this.focus();
    if (!store) return null;
    return { store, state: this.current?.store === store ? this.current.workflow.state : store.loadState() };
  }

  /** Resolves once no run is going (a stopped one may still wait for the user). */
  async idle(): Promise<void> {
    while (this.current) await this.current.done;
  }

  /** Stops a running run, which stays resumable, and waits for it. */
  async stop(): Promise<void> {
    this.current?.workflow.interrupt();
    await this.idle();
  }

  private start(store: RunStore, state: RunState, cfg: ConfigData): void {
    try {
      store.lock();
    } catch (e) {
      this.o.ui.info((e as Error).message);
      return;
    }
    const workflow = new Workflow({ cfg, repo: this.o.workspace, store, state, bus: this.o.bus, decider: this.o.decider, permissions: this.o.permissions });
    this.escaped = false;
    this.o.ui.setStatus("running");
    const done = (async () => {
      let code: number = EXIT.ERROR;
      try {
        code = await workflow.run();
      } catch (e) {
        this.o.ui.info(`error: ${(e as Error).message}`);
      } finally {
        store.unlock();
      }
      this.current = null;
      this.last = store;
      const st = store.loadState();
      if (code === EXIT.INTERRUPTED && this.escaped) {
        this.paused = store;
        this.o.ui.info(`Stopped ${st.inProgress?.phase ?? st.phase}. Type what to change and press Enter to re-run it (Enter alone re-runs it as is; /new leaves it).`);
        this.o.ui.setStatus("paused");
        return;
      }
      if (code === EXIT.HUMAN_REVIEW) this.o.ui.info("The run is waiting for your decision; type /resume to decide.");
      this.earlier.push(await this.outcome(st));
      this.o.ui.setStatus("idle");
    })();
    this.current = { store, workflow, done };
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

  private configOf(store: RunStore): ConfigData {
    return store.exists("config.json") ? configFromSaved(store.readJson("config.json")) : this.o.cfg;
  }

  private latestResumable(): RunStore | null {
    try {
      const store = RunStore.open(this.o.runsDir);
      const st = store.loadState();
      if (st.phase === "DONE" || st.phase === "ABORTED") return null;
      if (st.workspace && resolve(st.workspace) !== resolve(this.o.workspace)) return null;
      return store;
    } catch {
      return null;
    }
  }

  /** The run commands talk about: the one going, the stopped one, or the last one. */
  private focus(): RunStore | null {
    return this.current?.store ?? this.paused ?? this.last;
  }

  private async command(text: string): Promise<void> {
    const [name] = text.split(/\s+/);
    const ui = this.o.ui;
    const store = this.focus();
    switch (name) {
      case "/help":
        ui.info(HELP);
        return;
      case "/plan": {
        const plan = store && (store.exists("plan.final.md") ? store.readText("plan.final.md") : store.exists("plan.md") ? store.readText("plan.md") : null);
        ui.info(plan ? `── plan ──\n${plan.trimEnd()}` : "There is no plan yet.");
        return;
      }
      case "/diff": {
        const st = store?.loadState();
        const stat = st?.base && st.lastSnapshot ? (await this.git.diffStat(st.base.commit, st.lastSnapshot.commit)).trimEnd() : "";
        ui.info(stat ? `── diff stat ──\n${stat}` : "No changes yet.");
        return;
      }
      case "/status": {
        if (!store) {
          ui.info("No run yet. Type a task to start one.");
          return;
        }
        const st = store.loadState();
        const usage = [formatCost(st.costUsd), formatTokens(st.tokens)].filter(Boolean).join(" · ");
        ui.info(`Run ${st.taskId} — ${st.phase}${this.current ? " (running)" : this.paused ? " (stopped)" : ""} · plan round ${st.planningRound}/${st.limits.planningRounds}` +
          ` · implementation round ${st.implRound}/${st.limits.reviewRounds}${usage ? ` · ${usage}` : ""}`);
        return;
      }
      case "/resume": {
        if (this.current) {
          ui.info("A run is going already.");
          return;
        }
        const target = this.paused ?? this.latestResumable();
        if (!target) {
          ui.info("Nothing to resume.");
          return;
        }
        this.paused = null;
        this.start(target, target.loadState(), this.configOf(target));
        return;
      }
      case "/new":
        if (this.current) {
          ui.info("A run is going; Esc stops it first.");
          return;
        }
        if (this.paused) ui.info(`Left run ${this.paused.taskId} as it is; /resume continues it. Type the next task.`);
        this.paused = null;
        ui.setStatus("idle");
        return;
      case "/quit":
      case "/exit":
        ui.exit();
        return;
      default:
        ui.info(`unknown command ${name} — /help lists the commands`);
    }
  }
}
