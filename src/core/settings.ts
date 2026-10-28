import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import YAML from "yaml";
import { CLAUDE_EFFORTS, CODEX_EFFORTS, type CodexPermission, type EditMode } from "./commands.js";
import type { ConfigData } from "./config.js";

export { CLAUDE_EFFORTS, CODEX_EFFORTS, type CodexPermission, type EditMode };

/**
 * The settings the chat can change, each mirroring a command of the CLI it configures (Claude's /model, /effort,
 * /permissions, /add-dir and Shift+Tab; Codex's /model and /permissions). Every change edits flags in place, so a
 * backend that holds `cfg.claude` / `cfg.codex` sees it from its next call; `paths` are the config keys it touches.
 */
export interface SettingChange {
  apply(cfg: ConfigData): void;
  paths: string[][];
}

export const CODEX_PERMISSIONS = { "read-only": "read-only", auto: "workspace-write", "full-access": "danger-full-access" } as const;

const name = (arg: string) => arg.split("=")[0]!;

/** `args` without every `--flag value` / `--flag=value` for the given names (values matching `only`, if given). */
function without(args: string[], names: string[], only?: (value: string) => boolean): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!names.includes(name(arg))) {
      out.push(arg);
      continue;
    }
    const inline = arg.includes("=");
    const value = inline ? arg.slice(arg.indexOf("=") + 1) : args[i + 1] ?? "";
    if (only && !only(value)) {
      out.push(arg);
      continue;
    }
    if (!inline) i++;
  }
  return out;
}

/** Every value given to the flags, in order. */
export function values(args: string[], names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!names.includes(name(arg))) continue;
    if (arg.includes("=")) out.push(arg.slice(arg.indexOf("=") + 1));
    else if (i + 1 < args.length) out.push(args[++i]!);
  }
  return out;
}

const PERMISSION_MODE = ["--permission-mode"];
const ALLOW = ["--allowedTools", "--allowed-tools"];
const DENY = ["--disallowedTools", "--disallowed-tools"];
const SANDBOX = ["--sandbox", "-s"];
const CONFIG = ["-c", "--config"];
const isEffort = (value: string) => value.startsWith("model_reasoning_effort=");

/** The implementer's permission mode, as Claude would see it: its role_args win over the args every call gets. */
export function implementerMode(cfg: ConfigData): string | null {
  return values([...cfg.claude.args, ...(cfg.claude.role_args.implementer ?? [])], PERMISSION_MODE).at(-1) ?? null;
}

export function editMode(cfg: ConfigData): EditMode | string {
  const mode = implementerMode(cfg);
  return mode === "acceptEdits" ? "auto" : !mode || mode === "default" ? "ask" : mode;
}

/**
 * The one implementer flag a conversation call to Claude also gets: its permission mode, so /edits and Shift+Tab mean
 * the same for Claude in the chat as for the implementer. Placed after `claude.args`, it wins over them as it does
 * for the implementer; no other implementer flag comes along.
 */
export function implementerPermissionArgs(claude: ConfigData["claude"]): string[] {
  const mode = values(claude.role_args.implementer ?? [], PERMISSION_MODE).at(-1);
  return mode ? ["--permission-mode", mode] : [];
}

function setImplementerArgs(cfg: ConfigData, args: string[]): void {
  if (args.length) cfg.claude.role_args.implementer = args;
  else delete cfg.claude.role_args.implementer;
}

export const settings = {
  /** Shift+Tab / `/edits`: let the implementer edit files without asking ("acceptEdits"), or ask first. */
  edits: (mode: EditMode): SettingChange => ({
    paths: [["claude", "role_args"]],
    apply(cfg) {
      const rest = without(cfg.claude.role_args.implementer ?? [], PERMISSION_MODE);
      if (mode === "auto") rest.push("--permission-mode", "acceptEdits");
      // A mode in claude.args applies to every call; the implementer needs an explicit "default" to ask again.
      else if (values(cfg.claude.args, PERMISSION_MODE).length) rest.push("--permission-mode", "default");
      setImplementerArgs(cfg, rest);
    },
  }),
  claudeModel: (model: string | null): SettingChange => ({
    paths: [["claude", "model"]],
    apply(cfg) {
      cfg.claude.model = model;
    },
  }),
  claudeEffort: (effort: string | null): SettingChange => ({
    paths: [["claude", "args"]],
    apply(cfg) {
      cfg.claude.args = [...without(cfg.claude.args, ["--effort"]), ...(effort ? ["--effort", effort] : [])];
    },
  }),
  /** `/claude permissions allow|deny <rule>`: Claude's allow and deny rules, for agentduo's calls only. */
  claudeRule: (kind: "allow" | "deny", rule: string): SettingChange => ({
    paths: [["claude", "args"]],
    apply(cfg) {
      const flags = kind === "allow" ? ALLOW : DENY;
      if (values(cfg.claude.args, flags).includes(rule)) return;
      cfg.claude.args = [...cfg.claude.args, flags[0]!, rule];
    },
  }),
  claudeRemoveRule: (rule: string): SettingChange => ({
    paths: [["claude", "args"]],
    apply(cfg) {
      cfg.claude.args = without(cfg.claude.args, [...ALLOW, ...DENY], (value) => value === rule);
    },
  }),
  claudeAddDir: (dir: string): SettingChange => ({
    paths: [["claude", "args"]],
    apply(cfg) {
      if (!values(cfg.claude.args, ["--add-dir"]).includes(dir)) cfg.claude.args = [...cfg.claude.args, "--add-dir", dir];
    },
  }),
  /** `/codex model <name> [effort]`, like Codex's /model: the model and, optionally, its reasoning effort. */
  codexModel: (model: string | null, effort: string | null): SettingChange => ({
    paths: [["codex", "model"], ["codex", "args"]],
    apply(cfg) {
      cfg.codex.model = model;
      if (effort) cfg.codex.args = [...without(cfg.codex.args, CONFIG, isEffort), "-c", `model_reasoning_effort=${effort}`];
    },
  }),
  /** `/codex permissions`: Codex's presets as sandbox modes; "default" leaves it to ~/.codex/config.toml. */
  codexPermissions: (preset: CodexPermission): SettingChange => ({
    paths: [["codex", "args"]],
    apply(cfg) {
      const rest = without(cfg.codex.args, SANDBOX);
      cfg.codex.args = preset === "default" ? rest : [...rest, "--sandbox", CODEX_PERMISSIONS[preset]];
    },
  }),
};

export function claudeRules(cfg: ConfigData): { allow: string[]; deny: string[] } {
  return { allow: values(cfg.claude.args, ALLOW), deny: values(cfg.claude.args, DENY) };
}

export function claudeDirs(cfg: ConfigData): string[] {
  return values(cfg.claude.args, ["--add-dir"]);
}

const codexPermission = (cfg: ConfigData): string => {
  const sandbox = values(cfg.codex.args, SANDBOX).at(-1);
  const preset = Object.entries(CODEX_PERMISSIONS).find(([, mode]) => mode === sandbox)?.[0];
  return preset ?? sandbox ?? "default";
};

/** The chat's settings as plain values, for a settings panel; "default" = whatever the CLI's own configuration says. */
export interface SettingsView {
  claude: { model: string | null; effort: string | null; edits: string; allow: string[]; deny: string[]; addDirs: string[] };
  codex: { model: string | null; effort: string | null; permissions: string };
}

export function settingsView(cfg: ConfigData): SettingsView {
  const { allow, deny } = claudeRules(cfg);
  return {
    claude: { model: cfg.claude.model, effort: values(cfg.claude.args, ["--effort"]).at(-1) ?? null, edits: editMode(cfg), allow, deny, addDirs: claudeDirs(cfg) },
    codex: { model: cfg.codex.model, effort: values(cfg.codex.args, CONFIG).filter(isEffort).at(-1)?.split("=")[1] ?? null, permissions: codexPermission(cfg) },
  };
}

/** `/config`: what each agent runs with now ("default" = whatever its own configuration says). */
export function describeSettings(cfg: ConfigData): string {
  const list = (items: string[]) => (items.length ? items.join(", ") : "—");
  const v = settingsView(cfg);
  const a = cfg.agents;
  return [
    `Claude  model: ${v.claude.model ?? "default"} · effort: ${v.claude.effort ?? "default"} · ` +
      `edits: ${v.claude.edits} · allow: ${list(v.claude.allow)} · deny: ${list(v.claude.deny)} · add-dir: ${list(v.claude.addDirs)}`,
    `Codex   model: ${v.codex.model ?? "default"} · effort: ${v.codex.effort ?? "default"} · permissions: ${v.codex.permissions}`,
    `Roles   planner: ${a.planner} · plan critic: ${a.plan_reviewer} · implementer: ${a.implementer} · code reviewer: ${a.code_reviewer}`,
  ].join("\n");
}

/** Writes the keys a change touched into a config file, keeping its comments and everything else as it was. */
export function saveSettings(file: string, cfg: ConfigData, paths: string[][]): void {
  const doc = existsSync(file) ? YAML.parseDocument(readFileSync(file, "utf8")) : new YAML.Document({});
  for (const path of paths) {
    let value: unknown = cfg;
    for (const key of path) value = (value as Record<string, unknown> | undefined)?.[key];
    doc.setIn(path, value === undefined ? null : structuredClone(value));
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, String(doc));
}
