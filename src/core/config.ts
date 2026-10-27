import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";

export type Backend = "codex" | "claude";
export type AgentRole = "planner" | "plan_reviewer" | "implementer" | "code_reviewer";
export type RoleArgs = Partial<Record<AgentRole, string[]>>;

export const AGENT_ROLES: AgentRole[] = ["planner", "plan_reviewer", "implementer", "code_reviewer"];
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;

export interface GateConfig {
  name: string;
  command: string;
  required?: boolean;
  timeout_sec?: number;
}

/**
 * agentduo's own settings: who plays which role, loop limits, optional gates, and extra CLI arguments.
 * Permissions are deliberately absent; each CLI takes them from its own configuration.
 */
export interface ConfigData {
  agents: Record<AgentRole, Backend>;
  limits: {
    max_planning_rounds: number;
    max_review_rounds: number;
    max_retries: number;
    max_consecutive_gate_failures: number;
    agent_timeout_sec: number;
    agent_idle_timeout_sec: number;
    gate_timeout_sec: number;
    max_diff_chars: number;
    max_gate_output_chars: number;
  };
  quality_gates: {
    require_plan_approval: boolean;
    require_tests_pass: boolean;
    require_codex_approval: boolean;
    stop_on_critical_issue: boolean;
    blocking_severities: string[];
    review_on_gate_failure: boolean;
  };
  gates: GateConfig[];
  safety: { pause_before_implement: boolean };
  codex: { bin: string; model: string | null; args: string[]; role_args: RoleArgs };
  claude: { bin: string; model: string | null; max_budget_usd: number | null; args: string[]; role_args: RoleArgs };
  paths: { runs_dir: string };
}

const DEFAULTS: ConfigData = {
  agents: { planner: "codex", plan_reviewer: "claude", implementer: "claude", code_reviewer: "codex" },
  limits: {
    max_planning_rounds: 4,
    max_review_rounds: 5,
    max_retries: 1,
    max_consecutive_gate_failures: 3,
    agent_timeout_sec: 1800,
    agent_idle_timeout_sec: 900,
    gate_timeout_sec: 900,
    max_diff_chars: 120000,
    max_gate_output_chars: 6000,
  },
  quality_gates: {
    require_plan_approval: true,
    require_tests_pass: true,
    require_codex_approval: true,
    stop_on_critical_issue: true,
    blocking_severities: ["critical", "high"],
    review_on_gate_failure: false,
  },
  gates: [],
  safety: { pause_before_implement: false },
  codex: { bin: "codex", model: null, args: ["--ephemeral"], role_args: {} },
  claude: { bin: "claude", model: null, max_budget_usd: null, args: ["--no-session-persistence"], role_args: {} },
  paths: { runs_dir: ".agentduo/runs" },
};

/** Keys from agentduo v1 that kept their meaning under a new name. */
const RENAMED: Record<string, string> = { "codex.extra_args": "codex.args", "claude.extra_args": "claude.args" };
/** Mappings whose keys are user-chosen (validated later) rather than fixed by the defaults. */
const OPEN_MAPPINGS = new Set(["codex.role_args", "claude.role_args"]);

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface LoadedConfig {
  data: ConfigData;
  sources: string[];
  warnings: string[];
}

export function defaultConfig(): ConfigData {
  return structuredClone(DEFAULTS);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function mergeInto(base: Record<string, unknown>, override: Record<string, unknown>, where: string, warnings: string[]): Record<string, unknown> {
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    const path = where ? `${where}.${key}` : key;
    if (!(key in base)) {
      warnings.push(RENAMED[path] ? `config key '${path}' was renamed to '${RENAMED[path]}' (ignored)` : `unknown config key '${path}' (ignored)`);
      continue;
    }
    const current = base[key];
    if ((isPlainObject(current) || Array.isArray(current)) && (value === null || value === undefined)) continue; // "codex:" / "gates:" with no body keep the defaults
    if (OPEN_MAPPINGS.has(path)) {
      // Merged per role, so a user-level implementer entry survives a workspace plan_reviewer entry.
      out[key] = isPlainObject(current) && isPlainObject(value) ? { ...current, ...value } : value;
      continue;
    }
    if (isPlainObject(current)) {
      if (!isPlainObject(value)) throw new ConfigError(`'${path}' must be a mapping`);
      out[key] = mergeInto(current, value, path, warnings);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32" && env.APPDATA) return join(env.APPDATA, "agentduo", "config.yaml");
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "agentduo", "config.yaml");
}

function readYaml(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = YAML.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`${path}: ${(err as Error).message}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isPlainObject(parsed)) throw new ConfigError(`${path}: top level must be a mapping`);
  return parsed;
}

/** Defaults ← user config ← `<dir>/.agentduo/config.yaml` (or --config). */
export function loadConfig(opts: { dir: string; configPath?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; validate?: boolean }): LoadedConfig {
  const warnings: string[] = [];
  const sources: string[] = [];
  let data = defaultConfig() as unknown as Record<string, unknown>;
  const dirPath = opts.configPath ? resolve(opts.configPath) : join(opts.dir, ".agentduo", "config.yaml");
  if (opts.configPath && !existsSync(dirPath)) throw new ConfigError(`config file not found: ${dirPath}`);
  const userPath = userConfigPath(opts.env ?? process.env, opts.platform ?? process.platform);
  for (const path of userPath === dirPath ? [dirPath] : [userPath, dirPath]) {
    if (!existsSync(path)) continue;
    const fileWarnings: string[] = [];
    try {
      data = mergeInto(data, readYaml(path), "", fileWarnings);
    } catch (err) {
      if (err instanceof ConfigError && !err.message.startsWith(path)) throw new ConfigError(`${path}: ${err.message}`);
      throw err;
    }
    warnings.push(...fileWarnings.map((w) => `${path}: ${w}`));
    sources.push(path);
  }
  const cfg = data as unknown as ConfigData;
  if (opts.validate !== false) validateConfig(cfg, sources.join(", ") || undefined);
  return { data: cfg, sources, warnings };
}

/** A run's saved config.json, merged over today's defaults so keys added later get their default value. */
export function configFromSaved(raw: unknown): ConfigData {
  if (!isPlainObject(raw)) throw new ConfigError("saved run config is not a mapping");
  return mergeInto(defaultConfig() as unknown as Record<string, unknown>, raw, "", []) as unknown as ConfigData;
}

const isPosInt = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 1;
const isNonNegInt = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0;
const isStringList = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");

export function validateConfig(cfg: ConfigData, source?: string): void {
  const errors: string[] = [];
  for (const role of AGENT_ROLES) {
    if (cfg.agents[role] !== "codex" && cfg.agents[role] !== "claude") errors.push(`agents.${role} must be one of codex, claude`);
  }
  for (const key of ["max_planning_rounds", "max_review_rounds", "max_consecutive_gate_failures", "agent_timeout_sec",
    "gate_timeout_sec", "max_diff_chars", "max_gate_output_chars"] as const) {
    if (!isPosInt(cfg.limits[key])) errors.push(`limits.${key} must be a positive integer`);
  }
  if (!isNonNegInt(cfg.limits.max_retries)) errors.push("limits.max_retries must be an integer >= 0");
  if (!isNonNegInt(cfg.limits.agent_idle_timeout_sec)) errors.push("limits.agent_idle_timeout_sec must be an integer >= 0");
  if (!Array.isArray(cfg.quality_gates.blocking_severities)) {
    errors.push("quality_gates.blocking_severities must be a list");
  } else {
    for (const s of cfg.quality_gates.blocking_severities) {
      if (!(SEVERITIES as readonly string[]).includes(s)) errors.push(`quality_gates.blocking_severities: unknown severity '${s}'`);
    }
  }
  if (!Array.isArray(cfg.gates)) {
    errors.push("gates must be a list");
  } else {
    const names = new Set<string>();
    cfg.gates.forEach((gate, i) => {
      const g = gate as unknown;
      if (!isPlainObject(g) || typeof g.name !== "string" || !g.name || typeof g.command !== "string" || !g.command) {
        errors.push(`gates[${i}] needs 'name' and 'command'`);
        return;
      }
      if (names.has(g.name)) errors.push(`gates[${i}]: duplicate name '${g.name}'`);
      names.add(g.name);
      const unknown = Object.keys(g).filter((k) => !["name", "command", "required", "timeout_sec"].includes(k));
      if (unknown.length) errors.push(`gates[${i}]: unknown keys ${unknown.sort().join(", ")}`);
      if (g.required !== undefined && typeof g.required !== "boolean") errors.push(`gates[${i}].required must be true or false`);
      if (g.timeout_sec !== undefined && !isPosInt(g.timeout_sec)) errors.push(`gates[${i}].timeout_sec must be a positive integer`);
    });
  }
  // YAML 1.2 reads `no`/`yes` as strings; a string flag must not be mistaken for false.
  const flags: Array<[string, unknown]> = [
    ...(["require_plan_approval", "require_tests_pass", "require_codex_approval", "stop_on_critical_issue", "review_on_gate_failure"] as const)
      .map((k): [string, unknown] => [`quality_gates.${k}`, cfg.quality_gates[k]]),
    ["safety.pause_before_implement", cfg.safety.pause_before_implement],
  ];
  for (const [name, value] of flags) if (typeof value !== "boolean") errors.push(`${name} must be true or false`);
  const strings: Array<[string, unknown]> = [["codex.bin", cfg.codex.bin], ["claude.bin", cfg.claude.bin], ["paths.runs_dir", cfg.paths.runs_dir]];
  for (const [name, value] of strings) if (typeof value !== "string" || !value) errors.push(`${name} must be a non-empty string`);
  for (const [name, value] of [["codex.model", cfg.codex.model], ["claude.model", cfg.claude.model]] as const) {
    if (value !== null && typeof value !== "string") errors.push(`${name} must be a string or null`);
  }
  const budget = cfg.claude.max_budget_usd;
  if (budget !== null && !(typeof budget === "number" && budget > 0)) errors.push("claude.max_budget_usd must be a positive number or null");
  for (const backend of ["codex", "claude"] as const) {
    if (!isStringList(cfg[backend].args)) errors.push(`${backend}.args must be a list of strings`);
    const roleArgs = cfg[backend].role_args as unknown;
    if (!isPlainObject(roleArgs)) {
      errors.push(`${backend}.role_args must be a mapping of role to a list of strings`);
      continue;
    }
    for (const [role, args] of Object.entries(roleArgs)) {
      if (!(AGENT_ROLES as string[]).includes(role)) errors.push(`${backend}.role_args: unknown role '${role}' (roles: ${AGENT_ROLES.join(", ")})`);
      else if (!isStringList(args)) errors.push(`${backend}.role_args.${role} must be a list of strings`);
    }
  }
  if (errors.length) {
    throw new ConfigError(`invalid configuration${source ? ` (${source})` : ""}:\n  - ${errors.join("\n  - ")}`);
  }
}
