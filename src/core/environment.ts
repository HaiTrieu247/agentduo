import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { resolveBinary } from "../agents/resolve.js";
import { ConfigError, defaultConfig, loadConfig, validateConfig, type Backend, type ConfigData } from "./config.js";
import { runDoctor, type Check } from "./doctor.js";
import { Git } from "./git.js";

/** A workspace ready for a command: its config (loaded unvalidated), where its runs live, and what loading it noticed. */
export interface WorkspaceEnv {
  workspace: string;
  isRepo: boolean;
  git: Git;
  cfg: ConfigData;
  sources: string[];
  runsDir: string;
  /** Unknown or renamed config keys; shown, never fatal. */
  warnings: string[];
  /** Where a setting saved from the chat goes: the --config file, or <workspace>/.agentduo/config.yaml. */
  configFile: string;
}

/** The workspace directory is missing or is a file; the message is what the CLI prints. */
export class EnvironmentError extends Error {
  override name = "EnvironmentError";
}

export function expandHome(path: string, env: NodeJS.ProcessEnv): string {
  return path === "~" || path.startsWith("~/") ? join(env.HOME || homedir(), path.slice(1)) : path;
}

/**
 * The workspace is `dir` (relative to `cwd`) or `cwd` itself, never the repository root above it. Throws
 * EnvironmentError for a bad directory and ConfigError for a config file that cannot be read; writes nothing.
 */
export async function prepareEnvironment(o: { cwd: string; dir?: string; configPath?: string; env: NodeJS.ProcessEnv }): Promise<WorkspaceEnv> {
  const workspace = resolve(o.cwd, o.dir ?? ".");
  if (!existsSync(workspace)) throw new EnvironmentError(`no such directory: ${workspace}`);
  if (!statSync(workspace).isDirectory()) throw new EnvironmentError(`not a directory: ${workspace}`);
  const git = new Git(workspace);
  const isRepo = await git.isRepo();
  const configPath = o.configPath ? resolve(o.cwd, o.configPath) : undefined;
  const loaded = loadConfig({ dir: workspace, configPath, env: o.env, validate: false });
  // An unusable runs_dir is rejected by validateConfig before a run; status and list fall back to the default.
  const configured = loaded.data.paths?.runs_dir;
  const runs = expandHome(typeof configured === "string" && configured ? configured : defaultConfig().paths.runs_dir, o.env);
  return {
    workspace, isRepo, git, cfg: loaded.data, sources: loaded.sources, warnings: loaded.warnings,
    runsDir: isAbsolute(runs) ? runs : join(workspace, runs),
    configFile: configPath ?? join(workspace, ".agentduo", "config.yaml"),
  };
}

/** A resumed run keeps the config it started with, so a fix made in config.yaml needs --reload-config. */
export const SAVED_CONFIG_HINT = "this run uses the config it started with; pass --reload-config to apply changes to config.yaml";

export type RunnableProblem = { kind: "not_repo" | "config" | "missing_cli"; message: string };

/** The CLIs among `backends` that cannot be found, as the CLI says it; null when all are there. */
export function missingCli(cfg: ConfigData, backends: readonly Backend[], processEnv: NodeJS.ProcessEnv, saved = false): RunnableProblem | null {
  const missing = (["codex", "claude"] as const).filter((b) => backends.includes(b) && !resolveBinary(cfg[b].bin, b, processEnv));
  if (!missing.length) return null;
  return {
    kind: "missing_cli",
    message: `CLI not found: ${missing.join(", ")}. Install it or set '<backend>.bin' in the config${saved ? ` (${SAVED_CONFIG_HINT})` : ""}; run 'duo doctor' for details.`,
  };
}

/**
 * What the work needs besides a valid config. `backends`: the CLIs that must be there (default: every one the
 * pipeline's roles use; none to open the chat, which checks each agent when it is asked). `repo`: a git repository
 * (default), which the workflow snapshots and diffs; the chat opens anywhere and checks it when a run starts.
 * `saved`: the config is a run's saved one.
 */
export interface RunnableNeeds {
  backends?: readonly Backend[];
  repo?: boolean;
  saved?: boolean;
}

/** Why agents cannot run in this workspace with `cfg` for work that needs `o`, or null when they can. */
export function runnableProblem(env: Pick<WorkspaceEnv, "workspace" | "isRepo">, cfg: ConfigData, source: string,
  processEnv: NodeJS.ProcessEnv, o: RunnableNeeds = {}): RunnableProblem | null {
  if (o.repo !== false && !env.isRepo) {
    return { kind: "not_repo", message: `${env.workspace} is not inside a git repository (run 'git init' here, or 'duo init' to be asked)` };
  }
  try {
    validateConfig(cfg, source || undefined);
  } catch (e) {
    if (e instanceof ConfigError) return { kind: "config", message: e.message };
    throw e;
  }
  return missingCli(cfg, o.backends ?? Object.values(cfg.agents), processEnv, o.saved);
}

/** `duo doctor`: a config that does not validate is reported, and the defaults stand in for the remaining checks. */
export async function diagnose(env: WorkspaceEnv, processEnv: NodeJS.ProcessEnv): Promise<Check[]> {
  let configError: string | undefined;
  try {
    validateConfig(env.cfg, env.sources.join(", ") || undefined);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    configError = e.message.replace(/\n\s*/g, " ");
  }
  const cfg = configError ? defaultConfig() : env.cfg;
  return runDoctor({ dir: env.workspace, cfg, sources: env.sources, configError, env: processEnv, runsDir: env.runsDir });
}
