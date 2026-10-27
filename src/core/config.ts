import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";

export type Backend = "codex" | "claude";
export type AgentRole = "planner" | "plan_reviewer" | "implementer" | "code_reviewer";
export type Permission = "read-only" | "workspace-write";

export const AGENT_ROLES: AgentRole[] = ["planner", "plan_reviewer", "implementer", "code_reviewer"];
export const READ_ONLY_ROLES: AgentRole[] = ["planner", "plan_reviewer", "code_reviewer"];
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;

export interface GateConfig {
  name: string;
  command: string;
  required?: boolean;
  timeout_sec?: number;
}

/** agentduo's own config schema (not a Codex or Claude Code config). Keys match the YAML. */
export interface ConfigData {
  agents: Record<AgentRole, Backend>;
  limits: {
    max_planning_rounds: number;
    max_review_rounds: number;
    max_retries: number;
    max_consecutive_gate_failures: number;
    agent_timeout_sec: number;
    gate_timeout_sec: number;
    max_diff_chars: number;
    max_gate_output_chars: number;
  };
  permissions: { codex: Permission; claude_planning: Permission; claude_implementation: Permission };
  quality_gates: {
    require_plan_approval: boolean;
    require_tests_pass: boolean;
    require_codex_approval: boolean;
    stop_on_critical_issue: boolean;
    blocking_severities: string[];
    review_on_gate_failure: boolean;
  };
  gates: GateConfig[];
  safety: {
    allow_dirty_worktree: boolean;
    pause_before_implement: boolean;
    max_deleted_files: number;
    protected_paths: string[];
  };
  codex: { bin: string; model: string | null; extra_args: string[] };
  claude: {
    bin: string;
    model: string | null;
    max_budget_usd: number | null;
    extra_args: string[];
    read_only_tools: string[];
    implementation_tools: string[];
    implementation_allowed_tools: string[];
    implementation_disallowed_tools: string[];
  };
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
    gate_timeout_sec: 900,
    max_diff_chars: 120000,
    max_gate_output_chars: 6000,
  },
  permissions: { codex: "read-only", claude_planning: "read-only", claude_implementation: "workspace-write" },
  quality_gates: {
    require_plan_approval: true,
    require_tests_pass: true,
    require_codex_approval: true,
    stop_on_critical_issue: true,
    blocking_severities: ["critical", "high"],
    review_on_gate_failure: false,
  },
  gates: [],
  safety: {
    allow_dirty_worktree: false,
    pause_before_implement: false,
    max_deleted_files: 5,
    protected_paths: [".agentduo/**", ".git/**", ".env", ".env.*", "**/*.pem", "**/*.key", "**/secrets/**", ".github/workflows/**"],
  },
  codex: { bin: "codex", model: null, extra_args: ["--ephemeral"] },
  claude: {
    bin: "claude",
    model: null,
    max_budget_usd: null,
    extra_args: ["--strict-mcp-config", "--no-session-persistence"],
    read_only_tools: ["Read", "Grep", "Glob"],
    implementation_tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
    implementation_allowed_tools: [
      "Read", "Grep", "Glob", "Edit", "Write",
      "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git show*)",
      "Bash(ls*)", "Bash(cat*)", "Bash(pwd)",
    ],
    implementation_disallowed_tools: [
      "Bash(git push*)", "Bash(git commit*)", "Bash(git reset*)", "Bash(git checkout*)",
      "Bash(git switch*)", "Bash(git rebase*)", "Bash(git merge*)", "Bash(git clean*)",
      "Bash(git stash*)", "Bash(git tag*)", "Bash(git branch*)", "Bash(git update-ref*)",
      "Bash(rm -rf*)", "Bash(rm -fr*)", "Bash(sudo*)", "Bash(curl*)", "Bash(wget*)",
      "WebFetch", "WebSearch",
    ],
  },
  paths: { runs_dir: ".agentduo/runs" },
};

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

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function mergeInto(base: Record<string, unknown>, override: Record<string, unknown>, where: string,
  warnings: string[]): Record<string, unknown> {
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    const path = where ? `${where}.${key}` : key;
    if (!(key in base)) {
      warnings.push(`unknown config key '${path}' (ignored)`);
      continue;
    }
    const current = base[key];
    if (isPlainObject(current)) {
      if (value === null || value === undefined) continue; // "codex:" with no body keeps the defaults
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

export function loadConfig(opts: { repo: string; configPath?: string; env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform; validate?: boolean }): LoadedConfig {
  const warnings: string[] = [];
  const sources: string[] = [];
  let data = defaultConfig() as unknown as Record<string, unknown>;
  const repoPath = opts.configPath ? resolve(opts.configPath) : join(opts.repo, ".agentduo", "config.yaml");
  if (opts.configPath && !existsSync(repoPath)) throw new ConfigError(`config file not found: ${repoPath}`);
  const userPath = userConfigPath(opts.env ?? process.env, opts.platform ?? process.platform);
  for (const path of userPath === repoPath ? [repoPath] : [userPath, repoPath]) {
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
  if (opts.validate !== false) validateConfig(cfg, sources.at(-1));
  return { data: cfg, sources, warnings };
}

export function permissionFor(cfg: ConfigData, role: AgentRole): Permission {
  if (cfg.agents[role] === "codex") return cfg.permissions.codex;
  return READ_ONLY_ROLES.includes(role) ? cfg.permissions.claude_planning : cfg.permissions.claude_implementation;
}

const isPosInt = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 1;
const isNonNegInt = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0;

export function validateConfig(cfg: ConfigData, source?: string): void {
  const errors: string[] = [];
  for (const role of AGENT_ROLES) {
    if (cfg.agents[role] !== "codex" && cfg.agents[role] !== "claude") errors.push(`agents.${role} must be one of codex, claude`);
  }
  if (cfg.agents.implementer !== "claude") {
    errors.push("agents.implementer must be 'claude' (Claude is the only agent allowed to modify source code)");
  }
  if (!errors.length) {
    for (const role of READ_ONLY_ROLES) {
      if (permissionFor(cfg, role) !== "read-only") errors.push(`role '${role}' must run read-only (check permissions.*)`);
    }
    if (permissionFor(cfg, "implementer") !== "workspace-write") errors.push("permissions for the implementer must be 'workspace-write'");
  }
  for (const key of ["max_planning_rounds", "max_review_rounds", "max_consecutive_gate_failures", "agent_timeout_sec",
    "gate_timeout_sec", "max_diff_chars", "max_gate_output_chars"] as const) {
    if (!isPosInt(cfg.limits[key])) errors.push(`limits.${key} must be a positive integer`);
  }
  if (!isNonNegInt(cfg.limits.max_retries)) errors.push("limits.max_retries must be an integer >= 0");
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
    if (cfg.quality_gates.require_tests_pass && !cfg.gates.some((g) => isPlainObject(g) && g.required !== false)) {
      errors.push("quality_gates.require_tests_pass is true but no required gate is configured under 'gates' (run 'duo init')");
    }
  }
  if (!Array.isArray(cfg.safety.protected_paths)) errors.push("safety.protected_paths must be a list");
  if (!isNonNegInt(cfg.safety.max_deleted_files)) errors.push("safety.max_deleted_files must be an integer >= 0");
  const lists: Array<[string, unknown]> = [
    ["codex.extra_args", cfg.codex.extra_args], ["claude.extra_args", cfg.claude.extra_args],
    ["claude.read_only_tools", cfg.claude.read_only_tools], ["claude.implementation_tools", cfg.claude.implementation_tools],
    ["claude.implementation_allowed_tools", cfg.claude.implementation_allowed_tools],
    ["claude.implementation_disallowed_tools", cfg.claude.implementation_disallowed_tools],
  ];
  for (const [name, value] of lists) if (!Array.isArray(value)) errors.push(`${name} must be a list`);
  if (typeof cfg.paths.runs_dir !== "string" || !cfg.paths.runs_dir) errors.push("paths.runs_dir must be a non-empty string");
  if (errors.length) {
    throw new ConfigError(`invalid configuration${source ? ` (${source})` : ""}:\n  - ${errors.join("\n  - ")}`);
  }
}
