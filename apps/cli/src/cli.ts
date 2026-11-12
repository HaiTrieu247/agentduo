import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command, CommanderError, Option } from "commander";
import { killAllActive } from "@agentduo/engine/agents/process";
import { Chat, newRun } from "@agentduo/engine/chat/chat";
import {
  archiveConversation, ConversationError, deleteConversation, listConversations, readConversation, restoreConversation,
} from "@agentduo/engine/chat/conversation";
import { ConfigFiles } from "@agentduo/engine/config/configuration";
import { conversationHolder, WorkspaceLease } from "@agentduo/engine/workflow/lease";
import { settings } from "@agentduo/engine/config/settings";
import { answersTemplate, pendingEntry } from "@agentduo/engine/clarification/clarification";
import { configFromSaved, ConfigError, PROFILES, type ConfigData, type ProfileName } from "@agentduo/engine/config/config";
import { decisionCommand } from "@agentduo/engine/workflow/decisions";
import { diagnose, EnvironmentError, prepareEnvironment, runnableProblem, type RunnableNeeds, type WorkspaceEnv } from "@agentduo/engine/system/environment";
import { initRepo } from "@agentduo/engine/config/init";
import { workspaceExcludes, WorkspacePaths } from "@agentduo/engine/inputs/mentions";
import type { Review } from "@agentduo/engine/workflow/outputs";
import { budgetLines, cycleLines, findingsMarkdown, metricsLines, usageSummary } from "@agentduo/engine/workflow/render";
import { openRunGit, RunGitError } from "@agentduo/engine/git/run-git";
import { acquireWorkspaceLock, LockError, RunStore, type RunState } from "@agentduo/engine/workflow/state";
import { gateSpecs, verificationLines } from "@agentduo/engine/quality/verification";
import { DecisionError, EXIT, Workflow, workspaceTree } from "@agentduo/engine/workflow/workflow";
import { EventBus, type ClarificationDecider, type Decider, type Decision, type PermissionDecider } from "@agentduo/engine/events";
import { packageVersion } from "@agentduo/engine/paths";
import type { ViewKind } from "./ui/ink/HumanReviewPrompt.js";
import { attachPlainRenderer, deferDecider, plainClarificationDecider, plainPermissionDecider } from "./ui/plain.js";

export interface CliIO {
  stdout: { write(text: string): unknown; isTTY?: boolean };
  stderr: { write(text: string): unknown };
  stdin: { isTTY?: boolean };
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Subscribe to SIGINT/SIGTERM/SIGHUP; returns an unsubscribe function. */
  onSignal?: (handler: () => void) => () => void;
  /** Ask a question on the terminal; absent when nobody can answer. */
  ask?: (question: string) => Promise<string>;
  /** True when this process runs in the terminal's background process group (`duo &`). */
  isBackground?: () => boolean;
}

/** A reader that went away (`duo … | head`) must not crash the run; any other stream error still does. */
export function guardStream(stream: { on(event: "error", listener: (err: NodeJS.ErrnoException) => void): unknown }): void {
  stream.on("error", (err) => {
    if (err.code !== "EPIPE") throw err;
  });
}

/** `ps -o pgid=,tpgid=` output: background when the terminal's foreground group is another group. */
export function isBackgroundFromPs(out: string): boolean {
  const [pgid, tpgid] = out.trim().split(/\s+/).map(Number);
  return !!pgid && !!tpgid && tpgid > 0 && pgid !== tpgid;
}

/** `duo` alone opens the chat only where someone can type: an interactive terminal in the foreground, outside CI. */
export function chatAvailable(io: CliIO, opts: { plain?: boolean }): boolean {
  return !opts.plain && !!io.stdin.isTTY && !!io.stdout.isTTY && io.env.CI !== "true" && !io.isBackground?.();
}

/**
 * A TTY that reports a 0×0 size (some pseudo-terminals) makes Ink ask terminal-size on every render, and on macOS
 * terminal-size opens /dev/tty each time without closing it: thousands of leaked descriptors per run, until a
 * spawn fails with EBADF. With COLUMNS/LINES set it answers from them instead.
 */
export function pinTerminalSize(stdout: { isTTY?: boolean; columns?: number; rows?: number }, env: NodeJS.ProcessEnv): void {
  if (!stdout.isTTY || (stdout.columns && stdout.rows)) return;
  env.COLUMNS ||= String(stdout.columns || 80);
  env.LINES ||= String(stdout.rows || 24);
}

/** Ink's colour support reads FORCE_COLOR when it is first imported; set it before that import. */
export function applyColorPreference(opts: { color?: boolean }, env: NodeJS.ProcessEnv): void {
  if (opts.color === false || env.NO_COLOR) env.FORCE_COLOR = "0";
}

let exitHookInstalled = false;
const STOP_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

export function processIO(): CliIO {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    guardStream(process.stdout);
    guardStream(process.stderr);
    // Agents run in their own process groups, so they do not die with us unless we kill them.
    process.once("exit", () => killAllActive());
  }
  return {
    stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, env: process.env, cwd: process.cwd(),
    onSignal: (handler) => {
      for (const signal of STOP_SIGNALS) process.on(signal, handler);
      return () => {
        for (const signal of STOP_SIGNALS) process.off(signal, handler);
      };
    },
    ask: process.stdin.isTTY
      ? async (question) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await rl.question(question);
        } finally {
          rl.close();
        }
      }
      : undefined,
    isBackground: () => {
      if (process.platform === "win32" || !process.stdout.isTTY) return false;
      const r = spawnSync("ps", ["-o", "pgid=,tpgid=", "-p", String(process.pid)], { encoding: "utf8" });
      return r.status === 0 && isBackgroundFromPs(r.stdout);
    },
  };
}

interface CommonOptions { dir?: string; config?: string; plain?: boolean; verbose?: boolean; color?: boolean }
interface RunOptions extends CommonOptions { taskFile?: string; acceptEdits?: boolean; profile?: ProfileName }

/** --profile: the pipeline profile of the runs started now, over pipeline.profile (a run keeps its own once started). */
function withProfile<T extends ConfigData>(cfg: T, opts: { profile?: ProfileName }): T {
  if (opts.profile) cfg.pipeline = { ...cfg.pipeline, profile: opts.profile };
  return cfg;
}
interface ResumeOptions extends CommonOptions { decision?: Decision["decision"]; note?: string; reloadConfig?: boolean; acceptEdits?: boolean; answers?: string }
interface ChatCommandOptions extends RunOptions {
  list?: boolean;
  archived?: boolean;
  archive?: boolean;
  restore?: boolean;
  delete?: boolean;
  yes?: boolean;
}

/** --accept-edits: the implementer edits files without asking, like /mode acceptEdits in the chat. */
function withAcceptEdits<T extends ConfigData>(cfg: T, opts: { acceptEdits?: boolean }): T {
  if (opts.acceptEdits) settings.mode("acceptEdits").apply(cfg);
  return cfg;
}

class CliExit extends Error {
  constructor(readonly code: number, message = "") {
    super(message);
  }
}

type Env = WorkspaceEnv;

/** The workspace is --dir or the current directory (never the repository root above it); config is loaded unvalidated. */
async function prepare(io: CliIO, opts: CommonOptions): Promise<Env> {
  let env: Env;
  try {
    env = await prepareEnvironment({ cwd: io.cwd, dir: opts.dir, configPath: opts.config, env: io.env });
  } catch (e) {
    if (e instanceof EnvironmentError) throw new CliExit(EXIT.ERROR, e.message);
    throw e;
  }
  for (const warning of env.warnings) io.stderr.write(`warning: ${warning}\n`);
  return env;
}

/** Default: the workflow's needs, a git repository and the CLIs of the pipeline's roles. */
function requireRunnable(env: Env, cfg: ConfigData, source: string, io: CliIO, o: RunnableNeeds = {}): void {
  const problem = runnableProblem(env, cfg, source, io.env, o);
  if (problem) throw new CliExit(EXIT.ERROR, problem.message);
}

function lockWorkspace(runsDir: string): () => void {
  try {
    return acquireWorkspaceLock(runsDir);
  } catch (e) {
    if (e instanceof LockError) throw new CliExit(EXIT.ERROR, e.message);
    throw e;
  }
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

function openStore(runsDir: string, runId?: string): RunStore {
  try {
    return RunStore.open(runsDir, runId);
  } catch (e) {
    throw new CliExit(EXIT.ERROR, (e as Error).message);
  }
}

function availableViews(store: RunStore, st: RunState): ViewKind[] {
  const views: ViewKind[] = [];
  if (store.exists("plan.final.md") || store.exists("plan.md")) views.push("plan");
  if (store.exists("review.json")) views.push("review");
  if (store.exists("plan-feedback.md")) views.push("feedback");
  if (st.base && st.lastSnapshot) views.push("diffstat");
  return views;
}

async function readView(kind: ViewKind, store: RunStore, st: RunState, workspace: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  switch (kind) {
    case "plan":
      return store.exists("plan.final.md") ? store.readText("plan.final.md") : store.exists("plan.md") ? store.readText("plan.md") : null;
    case "review": {
      if (!store.exists("review.json")) return null;
      const r = store.readJson<{ output: Review }>("review.json").output;
      return `${r.status}: ${r.summary}\n\n${findingsMarkdown(r.findings)}`;
    }
    case "feedback":
      return store.exists("plan-feedback.md") ? store.readText("plan-feedback.md") : null;
    case "diffstat": {
      if (!st.base || !st.lastSnapshot) return null;
      try {
        return (await openRunGit(st, workspace, env).diffStat(st.base.commit, st.lastSnapshot.commit)) || "(no changes)";
      } catch (e) {
        return `cannot read the run's snapshots: ${(e as Error).message}`;
      }
    }
  }
}

/** Runs the workflow; the caller holds the workspace lock. */
async function execute(io: CliIO, env: Env, cfg: ConfigData, store: RunStore, state: RunState, opts: CommonOptions, decision?: Decision, answers?: unknown): Promise<number> {
  try {
    store.lock();
  } catch (e) {
    if (e instanceof LockError) throw new CliExit(EXIT.ERROR, e.message);
    throw e;
  }
  const bus = new EventBus();
  // A backgrounded process that touches the terminal's raw mode gets stopped by the shell, so it renders plain.
  const background = !!io.isBackground?.();
  const plain = !!opts.plain || io.env.CI === "true" || !io.stdout.isTTY || background;
  const interactive = !plain && !!io.stdin.isTTY;
  // Claude's permission prompts reach the user only where someone can answer; elsewhere Claude denies them itself.
  const terminal = !!io.stdin.isTTY && !!io.stdout.isTTY && !background && io.env.CI !== "true";
  let permissions: PermissionDecider | undefined;
  // The agents' questions likewise: only where someone can answer. Elsewhere Claude is not offered the tool and the planner's
  // questions wait, saved, for `duo resume --answers`.
  let clarifier: ClarificationDecider | undefined;
  const version = packageVersion();
  let workflow: Workflow | undefined;
  let presses = 0;
  const onInterrupt = () => {
    presses += 1;
    if (presses === 1) {
      workflow?.interrupt();
      return;
    }
    killAllActive();
    process.exit(EXIT.INTERRUPTED);
  };
  const onStop = () => workflow?.requestStop();
  let decider: Decider = deferDecider;
  let closeUi: () => Promise<void>;
  if (plain) {
    const detach = attachPlainRenderer(bus, io.stdout, { color: opts.color !== false && !io.env.NO_COLOR && !!io.stdout.isTTY, verbose: !!opts.verbose, version });
    closeUi = async () => detach();
    if (terminal && io.ask) {
      permissions = plainPermissionDecider(io.ask);
      clarifier = plainClarificationDecider(io.ask);
    }
  } else {
    applyColorPreference(opts, io.env);
    pinTerminalSize(io.stdout, io.env);
    const { startInk } = await import("./ui/ink/session.js");
    const session = startInk({
      bus, version, verbose: !!opts.verbose, interactive, onStop, onInterrupt,
      views: () => availableViews(store, workflow?.state ?? state),
      readView: (kind) => readView(kind, store, workflow?.state ?? state, env.workspace, io.env),
      stdout: io.stdout as NodeJS.WriteStream, stdin: io.stdin as NodeJS.ReadStream,
    });
    decider = session.decider;
    closeUi = session.close;
    if (interactive) {
      permissions = session.permissions;
      clarifier = session.clarifier;
    }
  }
  workflow = new Workflow({ cfg, repo: env.workspace, store, state, bus, decider, permissions, clarifier, env: io.env });
  const offSignal = io.onSignal?.(onInterrupt);
  try {
    if (decision) await workflow.applyDecision(decision.decision, decision.note);
    if (answers !== undefined) workflow.applyAnswers(answers);
    return await workflow.run();
  } catch (e) {
    if (e instanceof DecisionError) throw new CliExit(EXIT.ERROR, e.message);
    if (e instanceof RunGitError) throw new CliExit(EXIT.ERROR, `${e.message}\nrun ${store.taskId} is unchanged: fix this, then 'duo resume ${store.taskId}'`);
    throw e;
  } finally {
    store.unlock();
    offSignal?.();
    await closeUi();
  }
}

const COMMANDS = ["run", "resume", "status", "list", "chat", "doctor", "init"];
const COMMON_KEYS = ["dir", "config", "plain", "verbose", "color", "acceptEdits", "profile"] as const;

/** With positional options, `duo --dir X list` parses --dir as the root's option; give it to the subcommand unless it set its own. */
function withGlobals<T extends CommonOptions>(cmd: Command): T {
  const opts = { ...cmd.opts() } as Record<string, unknown>;
  const root = cmd.parent;
  if (root) {
    for (const key of COMMON_KEYS) {
      if (root.getOptionValueSource(key) === "cli" && cmd.getOptionValueSource(key) !== "cli") opts[key] = root.getOptionValue(key);
    }
  }
  return opts as T;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

/** `duo stauts` would otherwise start a paid run with the task "stauts". */
function mistypedCommand(words: string[]): string | null {
  if (words.length !== 1 || /\s/.test(words[0]!)) return null;
  const word = words[0]!.toLowerCase();
  return COMMANDS.find((c) => editDistance(word, c) <= 2) ?? null;
}

async function runCommand(io: CliIO, words: string[], opts: RunOptions, explicit = false): Promise<number> {
  const near = explicit ? null : mistypedCommand(words);
  if (near) throw new CliExit(EXIT.ERROR, `unknown command '${words[0]}' — did you mean '${near}'? To start a run with this task, use: duo run ${words[0]}`);
  let task = words.join(" ").trim();
  if (opts.taskFile) {
    const path = resolve(io.cwd, opts.taskFile);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      throw new CliExit(EXIT.ERROR, `cannot read task file ${path}: ${(e as Error).message}`);
    }
    task = `${task}\n\n${text}`.trim();
  }
  if (!task) {
    if (!explicit && !opts.taskFile && chatAvailable(io, opts)) return chatCommand(io, opts);
    throw new CliExit(EXIT.ERROR, 'a task description is required, e.g. duo "Add JWT auth"; in a terminal, `duo` alone opens a chat (other commands: chat, resume, status, list, doctor, init)');
  }
  const env = await prepare(io, opts);
  requireRunnable(env, env.cfg, env.sources.join(", "), io);
  withProfile(withAcceptEdits(env.cfg, opts), opts);
  // Lock first: a start refused because another run is active must not leave a run behind or move LATEST.
  const release = lockWorkspace(env.runsDir);
  try {
    const { store, state } = newRun(env.runsDir, env.workspace, task, env.cfg);
    return await execute(io, env, env.cfg, store, state, opts);
  } finally {
    release();
  }
}

/** How often the chat looks, while it waits for input, at what other agentduo windows said in its conversation. */
const REFRESH_MS = 2000;

/**
 * The saved conversation `wanted` names among `which`: its id, a prefix of one id, or `latest` (the one in use changed
 * last). An unknown or ambiguous name is an error that says what there is.
 */
function findConversation(runsDir: string, wanted: string, which: "active" | "archived" | "all" = "all"): string {
  const more = which === "archived" ? "`duo chat --list --archived` lists them" : "`duo chat --list` lists them";
  if (wanted === "latest" || wanted === "last") {
    const recent = listConversations(runsDir, which === "archived" ? "archived" : "active");
    if (!recent.length) throw new CliExit(EXIT.ERROR, `no saved conversation in ${runsDir} yet: \`duo\` starts one`);
    return recent[0]!.id;
  }
  const saved = listConversations(runsDir, which);
  if (saved.some((c) => c.id === wanted)) return wanted;
  const matches = saved.filter((c) => c.id.startsWith(wanted));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) throw new CliExit(EXIT.ERROR, `'${wanted}' is the start of ${matches.length} conversations (${matches.slice(0, 4).map((c) => c.id).join(", ")}${matches.length > 4 ? ", …" : ""}): give more of its id`);
  throw new CliExit(EXIT.ERROR, `no saved conversation '${wanted}' in ${runsDir} (${more})`);
}

const titleOf = (title: string | undefined) => (title || "untitled").split("\n")[0]!.slice(0, 60);

/**
 * `duo chat --list`: the workspace's saved conversations, from any window (`duo`, VS Code, the desktop), newest first;
 * with --archived, the archived ones.
 */
function listChats(io: CliIO, env: Env, archived: boolean): number {
  const saved = listConversations(env.runsDir, archived ? "archived" : "active");
  if (!saved.length) {
    io.stdout.write(archived ? `no archived conversations in ${env.runsDir}\n` : `no saved conversations in ${env.runsDir}; \`duo\` starts one\n`);
    return EXIT.DONE;
  }
  for (const c of saved) {
    const busy = c.inUseBy && c.inUseBy !== process.pid ? `  [in use by pid ${c.inUseBy}]` : "";
    io.stdout.write(`${c.id}  ${archived ? `archived ${c.archivedAt}` : c.updatedAt}  ${titleOf(c.title)}${busy}\n`);
  }
  io.stdout.write(archived ? "bring one back with: duo chat --restore <id> (duo chat --delete <id> deletes it)\n"
    : "open one with: duo chat <id> (or duo chat latest); duo chat --archive <id> archives one\n");
  return EXIT.DONE;
}

/** `duo chat --archive|--restore|--delete <conversation>`: deleting asks first on a terminal, else needs --yes. */
async function manageChat(io: CliIO, env: Env, action: "archive" | "restore" | "delete", wanted: string | undefined, yes: boolean): Promise<number> {
  if (!wanted) throw new CliExit(EXIT.ERROR, `--${action} needs a conversation: its id (or the start of it), or latest`);
  const id = findConversation(env.runsDir, wanted, action === "archive" ? "active" : action === "restore" ? "archived" : "all");
  const name = `${id} («${titleOf(readConversation(env.runsDir, id)?.title)}»)`;
  try {
    if (action === "archive") {
      archiveConversation(env.runsDir, id);
      io.stdout.write(`archived ${name}: duo chat --list --archived lists it, duo chat --restore ${id} brings it back\n`);
    } else if (action === "restore") {
      restoreConversation(env.runsDir, id);
      io.stdout.write(`restored ${name}: duo chat ${id} opens it\n`);
    } else {
      if (!yes) {
        if (!io.ask || !io.stdin.isTTY) throw new CliExit(EXIT.ERROR, `deleting ${name} cannot be undone: pass --yes to delete it without a terminal to ask on`);
        const answer = (await io.ask(`Delete conversation ${name}, its logs and attached files? This cannot be undone. [y/N] `)).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          io.stdout.write(`kept ${name}\n`);
          return EXIT.DONE;
        }
      }
      deleteConversation(env.runsDir, id);
      io.stdout.write(`deleted ${name}\n`);
    }
  } catch (e) {
    if (e instanceof ConversationError) throw new CliExit(EXIT.ERROR, e.message);
    throw e;
  }
  return EXIT.DONE;
}

/**
 * `duo` alone, and `duo chat [conversation]`: a chat session in this workspace, in a new conversation or a saved one
 * (also one started in VS Code or the desktop app). It takes the workspace lock only while its work runs (an answer, a
 * discussion, a run, their waits for you included), so other agentduo windows can work here while it waits for input,
 * and it shows what they said in its conversation. It opens without either CLI (help and settings need none), and
 * without Git; each question checks its agent's CLI, and /pipeline those of every role and where its snapshots can go.
 */
async function chatCommand(io: CliIO, opts: ChatCommandOptions, wanted?: string, initial?: string): Promise<number> {
  const env = await prepare(io, opts);
  if (opts.list) return listChats(io, env, !!opts.archived);
  const actions = (["archive", "restore", "delete"] as const).filter((a) => opts[a]);
  if (actions.length > 1) throw new CliExit(EXIT.ERROR, "use one of --archive, --restore and --delete at a time");
  if (actions[0]) return manageChat(io, env, actions[0], wanted, !!opts.yes);
  let conversationId: string | undefined;
  if (wanted) {
    conversationId = findConversation(env.runsDir, wanted);
    const holder = conversationHolder(env.runsDir, conversationId);
    if (holder && holder !== process.pid) {
      const title = readConversation(env.runsDir, conversationId)?.title || "untitled";
      throw new CliExit(EXIT.ERROR, `conversation ${conversationId} («${title}») is in use by another agentduo (pid ${holder}): ` +
        "wait until its work there is done (an answer, a discussion or a run, or a question it waits on), then open it again");
    }
  }
  if (!chatAvailable(io, opts)) throw new CliExit(EXIT.ERROR, "the chat needs an interactive terminal (not --plain, CI or the background)");
  requireRunnable(env, env.cfg, env.sources.join(", "), io, { backends: [], repo: false });
  withProfile(withAcceptEdits(env.cfg, opts), opts);
  applyColorPreference(opts, io.env);
  pinTerminalSize(io.stdout, io.env);
  const { startChatInk } = await import("./ui/ink/chat-session.js");
  const bus = new EventBus();
  let chat: Chat | undefined;
  const paths = new WorkspacePaths(env.workspace, { exclude: workspaceExcludes(env.workspace, [env.runsDir]) });
  const session = startChatInk({
    bus, version: packageVersion(), verbose: !!opts.verbose, workspace: env.workspace,
    onSubmit: (text) => void chat?.submit(text), onEscape: () => chat?.escape(), onCycleMode: () => chat?.cycleMode(), onUsageRefresh: () => chat?.usage(),
    views: () => {
      const run = chat?.focused();
      return run ? availableViews(run.store, run.state) : [];
    },
    readView: async (kind) => {
      const run = chat?.focused();
      return run ? readView(kind, run.store, run.state, env.workspace, io.env) : null;
    },
    findFiles: (query) => paths.find(query),
    stdout: io.stdout as NodeJS.WriteStream, stdin: io.stdin as NodeJS.ReadStream,
  });
  // The config files as this chat read them: before each piece of work it follows what another window saved there.
  const files = new ConfigFiles({ workspace: env.workspace, configPath: env.configFile, env: io.env });
  chat = new Chat({
    cfg: env.cfg, workspace: env.workspace, runsDir: env.runsDir, configFile: env.configFile, userConfigFile: env.userConfigFile, bus, decider: session.decider, permissions: session.permissions, clarifier: session.clarifier, ui: session.ui,
    env: io.env, lease: new WorkspaceLease(env.runsDir), conversationId,
    beforeWork: () => {
      for (const change of files.changes(chat!.config)) chat!.follow(change);
    },
  });
  const offSignal = io.onSignal?.(() => session.ui.exit());
  const refresh = setInterval(() => {
    try {
      chat?.refresh();
    } catch {
      // a record being written as it is read: the next look gets it
    }
  }, REFRESH_MS);
  refresh.unref?.();
  try {
    await chat.greet();
    // `duo team <request>`: the chat opens on it, as if it had been typed.
    if (initial) await chat.submit(initial);
    await session.exited;
    await chat.stop(); // a running run stops at its current step and stays resumable; the workspace goes back with it
  } finally {
    clearInterval(refresh);
    offSignal?.();
    await session.close();
  }
  return EXIT.DONE;
}

async function resumeCommand(io: CliIO, runId: string | undefined, opts: ResumeOptions): Promise<number> {
  if (opts.note && !opts.decision) throw new CliExit(EXIT.ERROR, "--note is only accepted together with --decision");
  if (opts.answers && opts.decision) {
    throw new CliExit(EXIT.ERROR, "--answers answers the questions a run waits on; --decision decides something else. Give one of them (an abort needs no answers)");
  }
  let answers: unknown;
  if (opts.answers) {
    const path = resolve(io.cwd, opts.answers);
    try {
      answers = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new CliExit(EXIT.ERROR, `cannot read the answers file ${path}: ${(e as Error).message}`);
    }
  }
  const env = await prepare(io, opts);
  const store = openStore(env.runsDir, runId);
  const state = store.loadState();
  // A shared runs_dir can hold runs of other workspaces; running their agents here would edit the wrong tree.
  if (state.workspace && !samePath(state.workspace, env.workspace)) {
    throw new CliExit(EXIT.ERROR, `run ${state.taskId} belongs to the workspace ${state.workspace}; resume it from there (or pass --dir)`);
  }
  const release = lockWorkspace(env.runsDir);
  try {
    // A run keeps the config it started with, unless asked to pick up the current one.
    const useSaved = !opts.reloadConfig && store.exists("config.json");
    const cfg = withAcceptEdits(useSaved ? configFromSaved(store.readJson("config.json")) : env.cfg, opts);
    // The run's snapshots are where it recorded them, which the workflow checks before a step or a decision.
    requireRunnable(env, cfg, useSaved ? store.path("config.json") : env.sources.join(", "), io, { saved: useSaved, repo: false });
    if (!useSaved || opts.acceptEdits) store.writeJson("config.json", cfg);
    state.workspace ??= env.workspace;
    return await execute(io, env, cfg, store, state, opts, opts.decision ? { decision: opts.decision, note: opts.note } : undefined, answers);
  } finally {
    release();
  }
}

async function statusCommand(io: CliIO, runId: string | undefined, opts: CommonOptions): Promise<number> {
  const env = await prepare(io, opts);
  const store = openStore(env.runsDir, runId);
  const st = store.loadState();
  const out = (s: string) => io.stdout.write(`${s}\n`);
  out(`Run ${st.taskId} — ${st.phase}`);
  out(`  task: ${st.task.split("\n")[0]!.slice(0, 100)}`);
  out(`  planning round ${st.planningRound}/${st.limits.planningRounds}, plan v${st.planVersion}, final ${st.finalPlanVersion ? `v${st.finalPlanVersion}` : "—"}`);
  out(`  implementation round ${st.implRound}/${st.limits.reviewRounds}, open findings ${st.openFindings.length}`);
  const tracked = st.trackedFindings ?? [];
  if (tracked.length) {
    const reopened = tracked.reduce((n, e) => n + e.reopened, 0);
    const last = st.cycles?.at(-1);
    out(`  findings across reviews: ${tracked.filter((e) => e.status === "open").length} open, ${tracked.filter((e) => e.status === "resolved").length} resolved` +
      (reopened ? `, ${reopened} reopened` : "") + (last ? `; last review: ${cycleLines([last])[0]}` : "") +
      (st.stall?.count ? `; ${st.stall.count} review round(s) in a row without progress` : ""));
  }
  if (st.rejected?.length) out(`  rejected answers: ${st.rejected.reduce((n, r) => n + r.count, 0)} in ${st.rejected.length} call(s) (see report.md)`);
  for (const line of await statusVerification(st, store, env, io.env)) out(`  verification: ${line}`);
  for (const line of metricsLines(st)) out(`  ${line}`);
  out(`  usage: ${usageSummary(st)}`);
  for (const line of budgetLines(st)) out(`  budget: ${line}`);
  if (st.inProgress) out(`  interrupted during ${st.inProgress.phase} (resume to re-run it)`);
  for (const h of st.history.slice(-12)) {
    out(`  [${String(h.step).padStart(2, "0")}] ${`${h.phase} r${h.round}`.padEnd(16)} ${h.agent.padEnd(12)} ${h.status}: ${h.summary}`);
  }
  if (st.warnings?.length) out(`  warnings: ${st.warnings.length} (see report.md)`);
  if (st.phase === "HUMAN_REVIEW" && st.humanReview) {
    const asked = st.humanReview.reason === "clarification_required" ? pendingEntry(st.clarifications) : null;
    out(`  waiting for ${asked ? "your answers" : "a decision"} (${st.humanReview.reason}): ${st.humanReview.message}`);
    if (asked) {
      for (const q of asked.questions) {
        out(`    ${q.id}${q.header ? ` [${q.header}]` : ""}: ${q.question}${q.multiSelect ? " (several may apply)" : ""}`);
        for (const o of q.options) out(`      ${o.id}  ${o.label}${o.description ? ` — ${o.description}` : ""}`);
      }
      out(`    answers file template (fill in 'options' with option ids and/or 'other' with your own words, per question):`);
      for (const l of JSON.stringify(answersTemplate(asked), null, 2).split("\n")) out(`      ${l}`);
    }
    out(`  continue: ${decisionCommand("duo", st.taskId, st.humanReview.reason)}`);
  }
  out(`  files: ${store.dir}`);
  return EXIT.DONE;
}

/**
 * What the run's gates and DONE are evidence about, against the workspace as it is now: the run's own gates (its saved
 * config), and the files compared with what the gates ran on. When the files cannot be looked at, the run's last
 * snapshot stands for them.
 */
async function statusVerification(st: RunState, store: RunStore, env: WorkspaceEnv, vars: NodeJS.ProcessEnv): Promise<string[]> {
  let configured = null;
  try {
    const cfg = store.exists("config.json") ? configFromSaved(store.readJson("config.json")) : null;
    configured = cfg ? gateSpecs(cfg.gates, cfg.limits.gate_timeout_sec) : null;
  } catch {
    // an unreadable saved config: the gates that last ran stand for it
  }
  let tree: string | null = null;
  if (st.lastSnapshot) {
    try {
      tree = await workspaceTree(st, env.workspace, env.runsDir, vars);
    } catch {
      // the run's snapshots cannot be opened here
    }
  }
  return verificationLines(st, { configured, workspaceTree: tree });
}

async function listCommand(io: CliIO, opts: CommonOptions): Promise<number> {
  const env = await prepare(io, opts);
  const runs = RunStore.list(env.runsDir);
  if (!runs.length) io.stdout.write(`no runs in ${env.runsDir}\n`);
  for (const st of runs) io.stdout.write(`${st.taskId}  ${st.phase.padEnd(13)} ${st.updatedAt}  ${st.task.split("\n")[0]!.slice(0, 60)}\n`);
  return EXIT.DONE;
}

async function doctorCommand(io: CliIO, opts: CommonOptions): Promise<number> {
  const env = await prepare(io, opts);
  const checks = await diagnose(env, io.env);
  let failed = false;
  for (const c of checks) {
    if (c.ok) io.stdout.write(`  ✓ ${c.message}\n`);
    else if (c.required) {
      failed = true;
      io.stdout.write(`  ✗ ${c.message}\n`);
    } else io.stdout.write(`  ! ${c.message}\n`);
  }
  io.stdout.write(`doctor: ${failed ? "problems found" : "ready"}\n`);
  return failed ? EXIT.ERROR : EXIT.DONE;
}

async function initCommand(io: CliIO, opts: CommonOptions): Promise<number> {
  const env = await prepare(io, opts);
  // A pipeline needs no repository (agentduo snapshots a folder without one in a repository of its own); one is offered.
  if (env.snapshots.mode === "internal") {
    const without = "agentduo snapshots it in a Git repository of its own, outside the folder";
    if (io.ask && io.stdin.isTTY) {
      const answer = (await io.ask(`This folder is not a git repository; a pipeline run does not need one (${without}). Run 'git init' here anyway? [y/N] `)).trim().toLowerCase();
      if (answer === "y" || answer === "yes") {
        await env.git.run(["init", "-q"]);
        io.stdout.write(`initialized a git repository in ${env.workspace}\n`);
      } else {
        io.stdout.write(`skipped; 'duo run' works here without it (${without})\n`);
      }
    } else {
      io.stdout.write(`note: this folder is not a git repository; 'duo run' works here without one (${without})\n`);
    }
  } else if (env.snapshots.mode === null) {
    io.stdout.write(`note: ${env.snapshots.problem.message}\n`);
  }
  const r = initRepo(env.workspace);
  if (r.created) {
    io.stdout.write(`created ${r.configPath}\n`);
    for (const g of r.gates) io.stdout.write(`  suggested gate ${g.name}: ${g.command}  (${g.reason}; commented out)\n`);
  } else {
    io.stdout.write(`kept existing ${r.configPath}\n`);
  }
  io.stdout.write(r.ignoreCreated ? "created .agentduo/.gitignore (keeps run data out of git)\n" : ".agentduo/.gitignore already exists\n");
  return EXIT.DONE;
}

export async function main(argv: string[], io: CliIO = processIO()): Promise<number> {
  let exitCode: number = EXIT.DONE;
  const program = new Command()
    .name("duo")
    .description("A channel between Codex and Claude Code. `duo` alone opens a chat with both (ask either one; /pipeline <task> runs the workflow); " +
      "`duo <task>` runs the workflow directly: Codex plans and reviews, Claude critiques and implements.")
    .version(packageVersion(), "-V, --version")
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.stdout.write(s), writeErr: (s) => io.stderr.write(s) })
    .showHelpAfterError();
  const common = (cmd: Command) => cmd
    .option("--dir <path>", "workspace directory (default: the current directory)")
    .option("--config <path>", "config file (default: <dir>/.agentduo/config.yaml)")
    .option("--plain", "plain line output (default when stdout is not a TTY, in CI, or in the background)")
    .option("-v, --verbose", "show every agent activity, including thoughts")
    .option("--no-color", "disable colors");

  const acceptEdits = "the implementer edits files without asking (Claude's acceptEdits mode)";
  const profile = () => new Option("--profile <profile>", "pipeline profile of new runs: lightweight (small, clear tasks), standard, thorough").choices([...PROFILES]);
  common(program.argument("[task...]", "task description for a new run, or none for the chat (use -- before a task that starts with '-')")
    .option("--task-file <file>", "read the task description from a file").option("--accept-edits", acceptEdits).addOption(profile()))
    .action(async (words: string[], opts: RunOptions) => {
      exitCode = await runCommand(io, words, opts);
    });
  common(program.command("run").description("start a new run").argument("<task...>").option("--task-file <file>", "read the task description from a file")
    .option("--accept-edits", acceptEdits).addOption(profile()))
    .action(async (words: string[], _opts: RunOptions, cmd: Command) => {
      exitCode = await runCommand(io, words, withGlobals<RunOptions>(cmd), true);
    });
  common(program.command("resume").description("continue a run (default: the latest), optionally answering a pending decision or the agents' questions").argument("[runId]")
    .addOption(new Option("--decision <decision>", "answer a run waiting in HUMAN_REVIEW").choices(["resume", "revise", "abort"]))
    .option("--note <text>", "instruction for the agents, recorded with the decision")
    .option("--answers <file>", "answer the questions a run waits on, from a JSON file (`duo status` prints its template)")
    .option("--reload-config", "use the current config instead of the one the run started with")
    .option("--accept-edits", acceptEdits))
    .action(async (runId: string | undefined, _opts: ResumeOptions, cmd: Command) => {
      exitCode = await resumeCommand(io, runId, withGlobals<ResumeOptions>(cmd));
    });
  common(program.command("chat").description("open the chat in a new conversation, or continue a saved one (also one from VS Code or the desktop app)")
    .argument("[conversation]", "a saved conversation's id (or the start of it), or latest")
    .option("--list", "list the saved conversations, newest first").option("--archived", "with --list: list the archived ones")
    .option("--archive", "archive the conversation: it leaves the list, whole (--restore brings it back)")
    .option("--restore", "bring an archived conversation back to the list")
    .option("--delete", "delete the conversation with its logs and files (asks first; cannot be undone)")
    .option("--yes", "with --delete: do not ask").option("--accept-edits", acceptEdits).addOption(profile()))
    .action(async (conversation: string | undefined, _opts: ChatCommandOptions, cmd: Command) => {
      exitCode = await chatCommand(io, withGlobals<ChatCommandOptions>(cmd), conversation);
    });
  common(program.command("team").description("open the chat and hand the request to a team (PM, techlead, devs, testers): you talk to the PM only")
    .argument("<request...>", "what you want the team to build").option("--accept-edits", acceptEdits))
    .action(async (words: string[], _opts: ChatCommandOptions, cmd: Command) => {
      exitCode = await chatCommand(io, withGlobals<ChatCommandOptions>(cmd), undefined, `/team ${words.join(" ")}`);
    });
  common(program.command("status").description("show a run's state").argument("[runId]"))
    .action(async (runId: string | undefined, _opts: CommonOptions, cmd: Command) => {
      exitCode = await statusCommand(io, runId, withGlobals(cmd));
    });
  common(program.command("list").description("list runs in this workspace"))
    .action(async (_opts: CommonOptions, cmd: Command) => {
      exitCode = await listCommand(io, withGlobals(cmd));
    });
  common(program.command("doctor").description("check CLIs, config and workspace (no agent calls)"))
    .action(async (_opts: CommonOptions, cmd: Command) => {
      exitCode = await doctorCommand(io, withGlobals(cmd));
    });
  common(program.command("init").description("create .agentduo/config.yaml (and offer git init)"))
    .action(async (_opts: CommonOptions, cmd: Command) => {
      exitCode = await initCommand(io, withGlobals(cmd));
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return exitCode;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode === 0 ? EXIT.DONE : EXIT.ERROR;
    if (err instanceof CliExit) {
      if (err.message) io.stderr.write(`error: ${err.message}\n`);
      return err.code;
    }
    if (err instanceof ConfigError) {
      io.stderr.write(`error: ${err.message}\n`);
      return EXIT.ERROR;
    }
    throw err;
  }
}
