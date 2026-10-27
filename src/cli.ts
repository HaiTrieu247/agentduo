import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Command, CommanderError, Option } from "commander";
import { killAllActive } from "./agents/process.js";
import { resolveBinary } from "./agents/resolve.js";
import { ConfigError, loadConfig, validateConfig, type ConfigData } from "./core/config.js";
import { runDoctor } from "./core/doctor.js";
import { Git } from "./core/git.js";
import { initRepo } from "./core/init.js";
import type { Review } from "./core/outputs.js";
import { findingsMarkdown } from "./core/render.js";
import { LockError, RunStore, type RunState } from "./core/state.js";
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
  /** Subscribe to SIGINT/SIGTERM; returns an unsubscribe function. */
  onSignal?: (handler: () => void) => () => void;
}

export function processIO(): CliIO {
  return {
    stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, env: process.env, cwd: process.cwd(),
    onSignal: (handler) => {
      process.on("SIGINT", handler);
      process.on("SIGTERM", handler);
      return () => {
        process.off("SIGINT", handler);
        process.off("SIGTERM", handler);
      };
    },
  };
}

interface CommonOptions { repo?: string; config?: string; plain?: boolean; verbose?: boolean; color?: boolean; allowDirty?: boolean }
interface RunOptions extends CommonOptions { taskFile?: string }
interface ResumeOptions extends CommonOptions { decision?: Decision["decision"]; note?: string }

class CliExit extends Error {
  constructor(readonly code: number, message = "") {
    super(message);
  }
}

interface Env { repo: string; isRepo: boolean; git: Git; cfg: ConfigData; sources: string[]; runsDir: string }

/** Resolve the repo (walking up to the git toplevel) and load config without validating it yet. */
async function prepare(io: CliIO, opts: CommonOptions): Promise<Env> {
  const start = resolve(io.cwd, opts.repo ?? ".");
  const probe = new Git(start);
  const isRepo = await probe.isRepo();
  const repo = isRepo ? await probe.toplevel() : start;
  const loaded = loadConfig({ repo, configPath: opts.config ? resolve(io.cwd, opts.config) : undefined, env: io.env, validate: false });
  for (const warning of loaded.warnings) io.stderr.write(`warning: ${warning}\n`);
  const runsDir = isAbsolute(loaded.data.paths.runs_dir) ? loaded.data.paths.runs_dir : join(repo, loaded.data.paths.runs_dir);
  return { repo, isRepo, git: new Git(repo), cfg: loaded.data, sources: loaded.sources, runsDir };
}

function requireRunnable(env: Env, io: CliIO): void {
  if (!env.isRepo) throw new CliExit(EXIT.ERROR, `${env.repo} is not a git repository (run 'git init' and commit first)`);
  validateConfig(env.cfg, env.sources.at(-1));
  const missing = (["codex", "claude"] as const).filter((b) => Object.values(env.cfg.agents).includes(b) && !resolveBinary(env.cfg[b].bin, b, io.env));
  if (missing.length) {
    throw new CliExit(EXIT.ERROR, `CLI not found: ${missing.join(", ")}. Install it or set '<backend>.bin' in the config; run 'duo doctor' for details.`);
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

async function execute(io: CliIO, env: Env, store: RunStore, state: RunState, opts: CommonOptions, allowDirty: boolean, decision?: Decision): Promise<number> {
  const bus = new EventBus();
  const plain = !!opts.plain || io.env.CI === "true" || !io.stdout.isTTY;
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
  workflow = new Workflow({ cfg: env.cfg, repo: env.repo, store, state, bus, decider, allowDirty });
  const offSignal = io.onSignal?.(onInterrupt);
  let locked = false;
  try {
    store.lock();
    locked = true;
    if (decision) await workflow.applyDecision(decision.decision, decision.note);
    return await workflow.run();
  } catch (e) {
    if (e instanceof LockError || e instanceof DecisionError) throw new CliExit(EXIT.ERROR, e.message);
    throw e;
  } finally {
    if (locked) store.unlock();
    offSignal?.();
    await closeUi();
  }
}

async function runCommand(io: CliIO, words: string[], opts: RunOptions): Promise<number> {
  let task = words.join(" ").trim();
  if (opts.taskFile) task = `${task}\n\n${readFileSync(resolve(io.cwd, opts.taskFile), "utf8")}`.trim();
  if (!task) throw new CliExit(EXIT.ERROR, 'a task description is required, e.g. duo "Add JWT auth" (other commands: resume, status, list, doctor, init)');
  const env = await prepare(io, opts);
  requireRunnable(env, io);
  const allowDirty = !!opts.allowDirty || env.cfg.safety.allow_dirty_worktree;
  const dirty = await env.git.statusPorcelain([".agentduo"]);
  if (dirty.length && !allowDirty) {
    throw new CliExit(EXIT.ERROR, `working tree has ${dirty.length} uncommitted change(s); commit or stash them first, or pass --allow-dirty\n`
      + dirty.slice(0, 10).map((l) => `    ${l}`).join("\n"));
  }
  const { store, state } = RunStore.create(env.runsDir, task, env.cfg.limits);
  return execute(io, env, store, state, opts, allowDirty);
}

async function resumeCommand(io: CliIO, runId: string | undefined, opts: ResumeOptions): Promise<number> {
  if (opts.note && !opts.decision) throw new CliExit(EXIT.ERROR, "--note is only accepted together with --decision");
  const env = await prepare(io, opts);
  requireRunnable(env, io);
  const store = openStore(env.runsDir, runId);
  return execute(io, env, store, store.loadState(), opts, !!opts.allowDirty, opts.decision ? { decision: opts.decision, note: opts.note } : undefined);
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
    validateConfig(env.cfg, env.sources.at(-1));
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    configError = e.message.replace(/\n\s*/g, " ");
  }
  const checks = await runDoctor({ repo: env.repo, cfg: env.cfg, sources: env.sources, configError, env: io.env });
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
  const r = initRepo(env.repo);
  if (r.created) {
    io.stdout.write(`created ${r.configPath}\n`);
    for (const g of r.gates) io.stdout.write(`  gate ${g.name}: ${g.command}  (${g.reason})\n`);
    if (!r.gates.length) io.stdout.write("  no quality gates detected: add your test/lint/typecheck commands under 'gates' before running\n");
  } else {
    io.stdout.write(`kept existing ${r.configPath}\n`);
  }
  io.stdout.write(r.gitignoreUpdated ? "added .agentduo/runs/ to .gitignore\n" : ".agentduo/runs/ is already ignored\n");
  if (!env.isRepo) io.stderr.write(`warning: ${env.repo} is not a git repository yet\n`);
  return EXIT.DONE;
}

export async function main(argv: string[], io: CliIO = processIO()): Promise<number> {
  let exitCode: number = EXIT.DONE;
  const program = new Command()
    .name("duo")
    .description("Codex plans and reviews; Claude Code critiques and implements. Start a run with a task description.")
    .version(packageVersion(), "-V, --version")
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.stdout.write(s), writeErr: (s) => io.stderr.write(s) })
    .showHelpAfterError();
  const common = (cmd: Command) => cmd
    .option("--repo <path>", "target git repository (default: the one containing the current directory)")
    .option("--config <path>", "config file (default: <repo>/.agentduo/config.yaml)")
    .option("--plain", "plain line output (default when stdout is not a TTY or CI=true)")
    .option("-v, --verbose", "show every agent activity, including thoughts")
    .option("--no-color", "disable colors");
  const dirtyOption = () => new Option("--allow-dirty", "allow implementing on top of uncommitted changes");

  common(program.argument("[task...]", "task description for a new run").option("--task-file <file>", "read the task description from a file").addOption(dirtyOption()))
    .action(async (words: string[], opts: RunOptions) => {
      exitCode = await runCommand(io, words, opts);
    });
  common(program.command("run").description("start a new run").argument("<task...>").option("--task-file <file>", "read the task description from a file").addOption(dirtyOption()))
    .action(async (words: string[], opts: RunOptions) => {
      exitCode = await runCommand(io, words, opts);
    });
  common(program.command("resume").description("continue a run (default: the latest), optionally answering a pending decision").argument("[runId]")
    .addOption(new Option("--decision <decision>", "answer a run waiting in HUMAN_REVIEW").choices(["resume", "revise", "abort"]))
    .option("--note <text>", "instruction for the agents, recorded with the decision").addOption(dirtyOption()))
    .action(async (runId: string | undefined, opts: ResumeOptions) => {
      exitCode = await resumeCommand(io, runId, opts);
    });
  common(program.command("status").description("show a run's state").argument("[runId]"))
    .action(async (runId: string | undefined, opts: CommonOptions) => {
      exitCode = await statusCommand(io, runId, opts);
    });
  common(program.command("list").description("list runs in this repository"))
    .action(async (opts: CommonOptions) => {
      exitCode = await listCommand(io, opts);
    });
  common(program.command("doctor").description("check CLIs, config and repository (no agent calls)"))
    .action(async (opts: CommonOptions) => {
      exitCode = await doctorCommand(io, opts);
    });
  common(program.command("init").description("create .agentduo/config.yaml with detected quality gates"))
    .action(async (opts: CommonOptions) => {
      exitCode = await initCommand(io, opts);
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
