import { resolve } from "node:path";
import { firstLine } from "./agents/types.js";
import { configFromSaved, type ConfigData } from "./core/config.js";
import { Git } from "./core/git.js";
import {
  CLAUDE_EFFORTS, CODEX_EFFORTS, CODEX_PERMISSIONS, claudeDirs, claudeRules, describeSettings, editMode, saveSettings, settings,
  type CodexPermission, type SettingChange,
} from "./core/settings.js";
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
  /** The implementer's edit mode, shown beside the input: "ask", "auto", or another Claude permission mode. */
  setEdits(mode: string): void;
  exit(): void;
}

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
  "",
  "Runs",
  "  <message>         start a task; while one runs, a note the agents get from the next step",
  "  Esc               stop the current step; your next message re-runs it with that note",
  "  /plan             show the final plan of the current run",
  "  /diff             show what the current run changed",
  "  /status           show where the current run is, and what it has cost",
  "  /resume           continue the latest stopped or waiting run, also one from an earlier session",
  "  /new              leave a stopped run as it is and start a new task",
  "  /quit             leave; a running run stops at its step and stays resumable (Ctrl-C twice too)",
  "",
  "Settings (this chat only; add --save to write one to .agentduo/config.yaml)",
  "  Shift+Tab         switch Claude's edits between ask and auto",
  "  /edits auto|ask   auto: the implementer edits files without asking (acceptEdits); ask: it asks first",
  "  /claude model <name|default>                        Claude's model, as /model in Claude Code",
  "  /claude effort low|medium|high|xhigh|max|default    Claude's effort level, as /effort",
  "  /claude permissions [allow|deny|remove <rule>]      Claude's tool rules for these runs, e.g. Bash(npm test:*); as /permissions",
  "  /claude add-dir <path>                              another directory Claude may work in, as /add-dir",
  "  /codex model <name|default> [effort]                Codex's model and reasoning effort, as /model in Codex",
  "  /codex permissions read-only|auto|full-access|default   what Codex may do, as /permissions in Codex",
  "  /config           show the settings both agents run with now",
  "  /help             show this list",
].join("\n");

const OUTCOMES: Partial<Record<RunState["phase"], string>> = { DONE: "done", ABORTED: "aborted", HUMAN_REVIEW: "waiting for a decision" };

/** The latest run of this workspace when it is stopped or waiting for a decision; read-only, so no lock is needed. */
export function latestResumable(runsDir: string, workspace: string): RunStore | null {
  try {
    const store = RunStore.open(runsDir);
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

/** One chat session in one workspace: every message becomes a run, a note for the running one, or a command. */
export class Chat {
  private current: { store: RunStore; workflow: Workflow; cfg: ConfigData; done: Promise<void> } | null = null;
  /** The config new runs start with: the loaded one plus this chat's changes. */
  private readonly cfg: ConfigData;
  /** This chat's setting changes, in order; replayed on a run resumed from its saved config (they are idempotent). */
  private readonly changes: SettingChange[] = [];
  /** Stopped with Esc: the next message re-runs its step. */
  private paused: RunStore | null = null;
  private last: RunStore | null = null;
  private escaped = false;
  private readonly earlier: EarlierTask[] = [];
  private readonly git: Git;

  constructor(private readonly o: ChatOptions) {
    this.git = new Git(o.workspace);
    this.cfg = structuredClone(o.cfg);
  }

  /** Shift+Tab: switch the implementer between asking before edits and editing automatically. */
  toggleEdits(): void {
    this.change(settings.edits(editMode(this.cfg) === "auto" ? "ask" : "auto"), false, () => this.editsText());
  }

  /** Points at a run an earlier session left stopped or waiting. */
  async greet(): Promise<void> {
    this.o.ui.setEdits(editMode(this.cfg));
    const hint = resumeHint(this.o.runsDir, this.o.workspace);
    if (hint) this.o.ui.info(hint);
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
    const cfg = structuredClone(this.cfg);
    const { store, state } = newRun(this.o.runsDir, this.o.workspace, text, cfg, [...this.earlier]);
    this.start(store, state, cfg);
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
    this.current = { store, workflow, cfg, done };
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

  private editsText(): string {
    const mode = editMode(this.cfg);
    return mode === "auto" ? "Edits: auto — the implementer edits files without asking."
      : mode === "ask" ? "Edits: ask — the implementer asks before editing files." : `Edits: Claude's permission mode is ${mode}.`;
  }

  /**
   * Applies a setting to new runs and, from its next agent call, to the run that is going (whose saved config
   * follows, so a resume keeps it); --save also writes it to the config file.
   */
  private change(change: SettingChange, save: boolean, text: () => string): void {
    change.apply(this.cfg);
    this.changes.push(change);
    if (this.current) {
      change.apply(this.current.cfg);
      this.current.store.writeJson("config.json", this.current.cfg);
    }
    if (save) saveSettings(this.o.configFile, this.cfg, change.paths);
    this.o.ui.setEdits(editMode(this.cfg));
    const scope = save ? `; saved to ${this.o.configFile}` : " (this chat only; add --save to keep it)";
    this.o.ui.info(`${text()}${this.current ? " Applies from the next agent call of the current run." : ""}${scope}`);
  }

  private settingCommand(words: string[], flags: Set<string>): boolean {
    const [name, sub, ...rest] = words;
    const arg = rest.join(" ");
    const ui = this.o.ui;
    const save = flags.has("--save");
    const value = (v: string | undefined) => (!v || v === "default" ? null : v);
    if (name === "/edits") {
      if (!sub) ui.info(this.editsText());
      else if (sub === "auto" || sub === "ask") this.change(settings.edits(sub), save, () => this.editsText());
      else ui.info("usage: /edits auto|ask");
      return true;
    }
    if (name === "/config") {
      ui.info(`${describeSettings(this.cfg)}\nChanges in this chat are not saved unless a command ends with --save (it writes ${this.o.configFile}).`);
      return true;
    }
    if (name === "/claude") {
      if (sub === "model") {
        if (!rest.length) ui.info(`Claude's model: ${this.cfg.claude.model ?? "default"}`);
        else this.change(settings.claudeModel(value(arg)), save, () => `Claude's model: ${this.cfg.claude.model ?? "default"}.`);
      } else if (sub === "effort") {
        const effort = rest[0];
        if (!effort || ![...CLAUDE_EFFORTS, "default"].includes(effort)) ui.info(`usage: /claude effort ${[...CLAUDE_EFFORTS, "default"].join("|")}`);
        else this.change(settings.claudeEffort(value(effort)), save, () => `Claude's effort: ${effort}.`);
      } else if (sub === "permissions") {
        const [kind, ...ruleWords] = rest;
        const rule = ruleWords.join(" ");
        if (!kind) {
          const { allow, deny } = claudeRules(this.cfg);
          ui.info(`Claude's rules for these runs (on top of its own settings)\n  allow: ${allow.join(", ") || "—"}\n  deny: ${deny.join(", ") || "—"}`);
        } else if ((kind === "allow" || kind === "deny") && rule) {
          this.change(settings.claudeRule(kind, rule), save, () => `Claude ${kind === "allow" ? "may use" : "may not use"} ${rule}.`);
        } else if (kind === "remove" && rule) {
          this.change(settings.claudeRemoveRule(rule), save, () => `Removed the rule ${rule}.`);
        } else ui.info("usage: /claude permissions [allow|deny|remove <rule>], e.g. /claude permissions allow Bash(npm test:*)");
      } else if (sub === "add-dir") {
        if (!arg) ui.info(`Extra directories for Claude: ${claudeDirs(this.cfg).join(", ") || "—"}`);
        else this.change(settings.claudeAddDir(arg), save, () => `Claude may also work in ${arg}.`);
      } else ui.info("usage: /claude model|effort|permissions|add-dir … (/help lists them)");
      return true;
    }
    if (name === "/codex") {
      if (sub === "model") {
        const [model, effort] = rest;
        if (!model) ui.info(`Codex's model: ${this.cfg.codex.model ?? "default"}`);
        else if (effort && !(CODEX_EFFORTS as readonly string[]).includes(effort)) ui.info(`usage: /codex model <name|default> [${CODEX_EFFORTS.join("|")}]`);
        else this.change(settings.codexModel(value(model), effort ?? null), save,
          () => `Codex's model: ${this.cfg.codex.model ?? "default"}${effort ? `, reasoning effort ${effort}` : ""}.`);
      } else if (sub === "permissions") {
        const preset = rest[0] as CodexPermission | undefined;
        if (!preset || ![...Object.keys(CODEX_PERMISSIONS), "default"].includes(preset)) {
          ui.info("usage: /codex permissions read-only|auto|full-access|default");
        } else if (preset === "full-access" && !flags.has("--yes")) {
          // Codex itself asks before full access; so does this.
          ui.info("Full access lets Codex edit any file on this computer and use the network without asking. To go ahead: /codex permissions full-access --yes");
        } else {
          this.change(settings.codexPermissions(preset), save, () => `Codex permissions: ${preset}.`);
        }
      } else ui.info("usage: /codex model|permissions … (/help lists them)");
      return true;
    }
    return false;
  }

  /** The run commands talk about: the one going, the stopped one, or the last one. */
  private focus(): RunStore | null {
    return this.current?.store ?? this.paused ?? this.last;
  }

  private async command(text: string): Promise<void> {
    const tokens = text.split(/\s+/).filter(Boolean);
    const flags = new Set<string>(tokens.filter((t) => t === "--save" || t === "--yes"));
    if (this.settingCommand(tokens.filter((t) => !flags.has(t)), flags)) return;
    const [name] = tokens;
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
        const target = this.paused ?? latestResumable(this.o.runsDir, this.o.workspace);
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
