import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command, CommanderError, Option } from "commander";
import { killAllActive } from "./agents/process.js";
import { resolveBinary } from "./agents/resolve.js";
import { configFromSaved, ConfigError, defaultConfig, loadConfig, validateConfig, type ConfigData } from "./core/config.js";
import { runDoctor } from "./core/doctor.js";
import { Git } from "./core/git.js";
import { initRepo } from "./core/init.js";
import type { Review } from "./core/outputs.js";
import { findingsMarkdown } from "./core/render.js";
import { acquireWorkspaceLock, LockError, RunStore, type RunState } from "./core/state.js";
import { DecisionError, EXIT, Workflow } from "./core/workflow.js";
import { EventBus, type Decider, type Decision } from "./events.js";
import { packageVersion } from "./paths.js";
import { formatCost, formatTokens } from "./ui/format.js";
import type { ViewKind } from "./ui/ink/HumanReviewPrompt.js";
import { attachPlainRenderer, deferDecider } from "./ui/plain.js";

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
interface RunOptions extends CommonOptions { taskFile?: string }
interface ResumeOptions extends CommonOptions { decision?: Decision["decision"]; note?: string; reloadConfig?: boolean }

class CliExit extends Error {
  constructor(readonly code: number, message = "") {
    super(message);
  }
}

interface Env { workspace: string; isRepo: boolean; git: Git; cfg: ConfigData; sources: string[]; runsDir: string }

function expandHome(path: string, env: NodeJS.ProcessEnv): string {
  return path === "~" || path.startsWith("~/") ? join(env.HOME || homedir(), path.slice(1)) : path;
}

/** The workspace is --dir or the current directory (never the repository root above it); config is loaded unvalidated. */
async function prepare(io: CliIO, opts: CommonOptions): Promise<Env> {
  const workspace = resolve(io.cwd, opts.dir ?? ".");
  if (!existsSync(workspace)) throw new CliExit(EXIT.ERROR, `no such directory: ${workspace}`);
  if (!statSync(workspace).isDirectory()) throw new CliExit(EXIT.ERROR, `not a directory: ${workspace}`);
  const git = new Git(workspace);
  const isRepo = await git.isRepo();
  const loaded = loadConfig({ dir: workspace, configPath: opts.config ? resolve(io.cwd, opts.config) : undefined, env: io.env, validate: false });
  for (const warning of loaded.warnings) io.stderr.write(`warning: ${warning}\n`);
  // An unusable runs_dir is rejected by validateConfig before a run; status and list fall back to the default.
  const configured = loaded.data.paths?.runs_dir;
  const runs = expandHome(typeof configured === "string" && configured ? configured : defaultConfig().paths.runs_dir, io.env);
  const runsDir = isAbsolute(runs) ? runs : join(workspace, runs);
  return { workspace, isRepo, git, cfg: loaded.data, sources: loaded.sources, runsDir };
}

/** A resumed run keeps the config it started with, so a fix made in config.yaml needs --reload-config. */
const SAVED_CONFIG_HINT = "this run uses the config it started with; pass --reload-config to apply changes to config.yaml";

function requireRunnable(env: Env, cfg: ConfigData, source: string, io: CliIO, saved = false): void {
  if (!env.isRepo) throw new CliExit(EXIT.ERROR, `${env.workspace} is not inside a git repository (run 'git init' here, or 'duo init' to be asked)`);
  validateConfig(cfg, source || undefined);
  const missing = (["codex", "claude"] as const).filter((b) => Object.values(cfg.agents).includes(b) && !resolveBinary(cfg[b].bin, b, io.env));
  if (missing.length) {
    throw new CliExit(EXIT.ERROR, `CLI not found: ${missing.join(", ")}. Install it or set '<backend>.bin' in the config${saved ? ` (${SAVED_CONFIG_HINT})` : ""}; run 'duo doctor' for details.`);
  }
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

async function readView(kind: ViewKind, store: RunStore, st: RunState, git: Git): Promise<string | null> {
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
    case "diffstat":
      return st.base && st.lastSnapshot ? (await git.diffStat(st.base.commit, st.lastSnapshot.commit)) || "(no changes)" : null;
  }
}

/** Runs the workflow; the caller holds the workspace lock. */
async function execute(io: CliIO, env: Env, cfg: ConfigData, store: RunStore, state: RunState, opts: CommonOptions, decision?: Decision): Promise<number> {
  try {
    store.lock();
  } catch (e) {
    if (e instanceof LockError) throw new CliExit(EXIT.ERROR, e.message);
    throw e;
  }
  const bus = new EventBus();
  // A backgrounded process that touches the terminal's raw mode gets stopped by the shell, so it renders plain.
  const plain = !!opts.plain || io.env.CI === "true" || !io.stdout.isTTY || !!io.isBackground?.();
  const interactive = !plain && !!io.stdin.isTTY;
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
  } else {
    applyColorPreference(opts, io.env);
    const { startInk } = await import("./ui/ink/session.js");
    const session = startInk({
      bus, version, verbose: !!opts.verbose, interactive, onStop, onInterrupt,
      views: () => availableViews(store, workflow?.state ?? state),
      readView: (kind) => readView(kind, store, workflow?.state ?? state, env.git),
      stdout: io.stdout as NodeJS.WriteStream, stdin: io.stdin as NodeJS.ReadStream,
    });
    decider = session.decider;
    closeUi = session.close;
  }
  workflow = new Workflow({ cfg, repo: env.workspace, store, state, bus, decider });
  const offSignal = io.onSignal?.(onInterrupt);
  try {
    if (decision) await workflow.applyDecision(decision.decision, decision.note);
    return await workflow.run();
  } catch (e) {
    if (e instanceof DecisionError) throw new CliExit(EXIT.ERROR, e.message);
    throw e;
  } finally {
    store.unlock();
    offSignal?.();
    await closeUi();
  }
}

const COMMANDS = ["run", "resume", "status", "list", "doctor", "init"];
const COMMON_KEYS = ["dir", "config", "plain", "verbose", "color"] as const;

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
  if (!task) throw new CliExit(EXIT.ERROR, 'a task description is required, e.g. duo "Add JWT auth" (other commands: resume, status, list, doctor, init)');
  const env = await prepare(io, opts);
  requireRunnable(env, env.cfg, env.sources.join(", "), io);
  // Lock first: a start refused because another run is active must not leave a run behind or move LATEST.
  const release = lockWorkspace(env.runsDir);
  try {
    const { store, state } = RunStore.create(env.runsDir, task, env.cfg.limits);
    state.workspace = env.workspace;
    store.saveState(state);
    store.writeJson("config.json", env.cfg);
    return await execute(io, env, env.cfg, store, state, opts);
  } finally {
    release();
  }
}

async function resumeCommand(io: CliIO, runId: string | undefined, opts: ResumeOptions): Promise<number> {
  if (opts.note && !opts.decision) throw new CliExit(EXIT.ERROR, "--note is only accepted together with --decision");
  const env = await prepare(io, opts);
  if (!env.isRepo) requireRunnable(env, env.cfg, "", io);
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
    const cfg = useSaved ? configFromSaved(store.readJson("config.json")) : env.cfg;
    requireRunnable(env, cfg, useSaved ? store.path("config.json") : env.sources.join(", "), io, useSaved);
    if (!useSaved) store.writeJson("config.json", cfg);
    state.workspace ??= env.workspace;
    return await execute(io, env, cfg, store, state, opts, opts.decision ? { decision: opts.decision, note: opts.note } : undefined);
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
  out(`  usage: ${[formatCost(st.costUsd), formatTokens(st.tokens)].filter(Boolean).join(" · ") || "none"}`);
  if (st.inProgress) out(`  interrupted during ${st.inProgress.phase} (resume to re-run it)`);
  for (const h of st.history.slice(-12)) {
    out(`  [${String(h.step).padStart(2, "0")}] ${`${h.phase} r${h.round}`.padEnd(16)} ${h.agent.padEnd(12)} ${h.status}: ${h.summary}`);
  }
  if (st.warnings?.length) out(`  warnings: ${st.warnings.length} (see report.md)`);
  if (st.phase === "HUMAN_REVIEW" && st.humanReview) {
    out(`  waiting for a decision (${st.humanReview.reason}): ${st.humanReview.message}`);
    out(`  continue: duo resume ${st.taskId} --decision resume|revise|abort [--note "..."]`);
  }
  out(`  files: ${store.dir}`);
  return EXIT.DONE;
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
  let configError: string | undefined;
  try {
    validateConfig(env.cfg, env.sources.join(", ") || undefined);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    configError = e.message.replace(/\n\s*/g, " ");
  }
  // An invalid config cannot be trusted for the remaining checks; fall back to the defaults for those.
  const cfg = configError ? defaultConfig() : env.cfg;
  const checks = await runDoctor({ dir: env.workspace, cfg, sources: env.sources, configError, env: io.env, runsDir: env.runsDir });
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
  if (!env.isRepo) {
    if (io.ask && io.stdin.isTTY) {
      const answer = (await io.ask("This folder is not a git repository. Run 'git init' here? [y/N] ")).trim().toLowerCase();
      if (answer === "y" || answer === "yes") {
        await env.git.run(["init", "-q"]);
        io.stdout.write(`initialized a git repository in ${env.workspace}\n`);
      } else {
        io.stdout.write("skipped; run 'git init' here before 'duo run'\n");
      }
    } else {
      io.stdout.write("note: this folder is not a git repository; run 'git init' here before 'duo run'\n");
    }
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
    .description("A channel between Codex and Claude Code: Codex plans and reviews, Claude critiques and implements. Start a run with a task description.")
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

  common(program.argument("[task...]", "task description for a new run (use -- before a task that starts with '-')").option("--task-file <file>", "read the task description from a file"))
    .action(async (words: string[], opts: RunOptions) => {
      exitCode = await runCommand(io, words, opts);
    });
  common(program.command("run").description("start a new run").argument("<task...>").option("--task-file <file>", "read the task description from a file"))
    .action(async (words: string[], _opts: RunOptions, cmd: Command) => {
      exitCode = await runCommand(io, words, withGlobals<RunOptions>(cmd), true);
    });
  common(program.command("resume").description("continue a run (default: the latest), optionally answering a pending decision").argument("[runId]")
    .addOption(new Option("--decision <decision>", "answer a run waiting in HUMAN_REVIEW").choices(["resume", "revise", "abort"]))
    .option("--note <text>", "instruction for the agents, recorded with the decision")
    .option("--reload-config", "use the current config instead of the one the run started with"))
    .action(async (runId: string | undefined, _opts: ResumeOptions, cmd: Command) => {
      exitCode = await resumeCommand(io, runId, withGlobals<ResumeOptions>(cmd));
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
