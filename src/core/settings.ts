import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { CLAUDE_EFFORTS, CODEX_EFFORTS, type CodexPermission, type PermissionMode, type SettingCommand } from "./commands.js";
import { AGENT_ROLES, ConfigError, configFromFiles, type ConfigData } from "./config.js";
import { atomicWrite } from "./state.js";

export { CLAUDE_EFFORTS, CODEX_EFFORTS, type CodexPermission, type PermissionMode };

/**
 * When a change reaches work that is already going. next-call: the run (or discussion) that runs now takes it from
 * its next agent call, and a resumed run gets it over its saved config. next-run: only work started after it (the next
 * run, question or discussion); a run that runs or is resumed keeps what its saved config.json says.
 */
export type SettingLive = "next-call" | "next-run";

/**
 * The settings the chat can change, each mirroring a command of the CLI it configures (Claude's /model, /effort,
 * /permissions, /add-dir and Shift+Tab; Codex's /model and /permissions), plus the keys the desktop's Settings set
 * (`settings.value`). Every change edits in place (`cfg.claude` / `cfg.codex` keep their identity), so a backend that
 * holds them sees it from its next call; `paths` are the config keys it touches. `whole`: it sets its paths' whole
 * values, so an earlier change of the same keys no longer matters once it is made.
 */
export interface SettingChange {
  apply(cfg: ConfigData): void;
  paths: string[][];
  live: SettingLive;
  whole?: boolean;
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

/** That mode by its flag value, "manual" for none or "default" (Claude Code's older name for it). */
export function permissionMode(cfg: ConfigData): PermissionMode | string {
  const mode = implementerMode(cfg);
  return !mode || mode === "default" ? "manual" : mode;
}

/**
 * The one implementer flag a conversation call to Claude also gets: its permission mode, so /mode and Shift+Tab mean
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
  /** Shift+Tab / `/mode`: the implementer's permission mode, as Claude Code's Shift+Tab sets it. */
  mode: (mode: PermissionMode): SettingChange => ({
    paths: [["claude", "role_args", "implementer"]],
    live: "next-call",
    apply(cfg) {
      const rest = without(cfg.claude.role_args.implementer ?? [], PERMISSION_MODE);
      if (mode !== "manual") rest.push("--permission-mode", mode);
      // A mode in claude.args applies to every call; the implementer needs an explicit one to ask again. "default", not
      // "manual": older Claude Code versions know only that name.
      else if (values(cfg.claude.args, PERMISSION_MODE).length) rest.push("--permission-mode", "default");
      setImplementerArgs(cfg, rest);
    },
  }),
  claudeModel: (model: string | null): SettingChange => ({
    paths: [["claude", "model"]],
    live: "next-call",
    apply(cfg) {
      cfg.claude.model = model;
    },
  }),
  claudeEffort: (effort: string | null): SettingChange => ({
    paths: [["claude", "args"]],
    live: "next-call",
    apply(cfg) {
      cfg.claude.args = [...without(cfg.claude.args, ["--effort"]), ...(effort ? ["--effort", effort] : [])];
    },
  }),
  /** `/claude permissions allow|deny <rule>`: Claude's allow and deny rules, for agentduo's calls only. */
  claudeRule: (kind: "allow" | "deny", rule: string): SettingChange => ({
    paths: [["claude", "args"]],
    live: "next-call",
    apply(cfg) {
      const flags = kind === "allow" ? ALLOW : DENY;
      if (values(cfg.claude.args, flags).includes(rule)) return;
      cfg.claude.args = [...cfg.claude.args, flags[0]!, rule];
    },
  }),
  claudeRemoveRule: (rule: string): SettingChange => ({
    paths: [["claude", "args"]],
    live: "next-call",
    apply(cfg) {
      cfg.claude.args = without(cfg.claude.args, [...ALLOW, ...DENY], (value) => value === rule);
    },
  }),
  claudeAddDir: (dir: string): SettingChange => ({
    paths: [["claude", "args"]],
    live: "next-call",
    apply(cfg) {
      if (!values(cfg.claude.args, ["--add-dir"]).includes(dir)) cfg.claude.args = [...cfg.claude.args, "--add-dir", dir];
    },
  }),
  /** `/codex model <name> [effort]`, like Codex's /model: the model and, optionally, its reasoning effort. */
  codexModel: (model: string | null, effort: string | null): SettingChange => ({
    paths: [["codex", "model"], ["codex", "args"]],
    live: "next-call",
    apply(cfg) {
      cfg.codex.model = model;
      if (effort) cfg.codex.args = [...without(cfg.codex.args, CONFIG, isEffort), "-c", `model_reasoning_effort=${effort}`];
    },
  }),
  /** `/codex permissions`: Codex's presets as sandbox modes; "default" leaves it to ~/.codex/config.toml. */
  codexPermissions: (preset: CodexPermission): SettingChange => ({
    paths: [["codex", "args"]],
    live: "next-call",
    apply(cfg) {
      const rest = without(cfg.codex.args, SANDBOX);
      cfg.codex.args = preset === "default" ? rest : [...rest, "--sandbox", CODEX_PERMISSIONS[preset]];
    },
  }),
  /**
   * One key of SETTING_KEYS set to `value` as a whole (a copy of it), the way the desktop's Settings set them;
   * `undefined` removes a role's args (that role gets only the args every call gets). Throws for a key or a value
   * that is not one (checkSettingValue says why).
   */
  value: (key: string, value: unknown): SettingChange => {
    const k = settingKey(key);
    if (!k) throw new ConfigError(`'${key}' is not a setting agentduo can change`);
    const problem = value === undefined && !k.removable ? `${key} cannot be removed, only set` : value === undefined ? null : checkSettingValue(k, value);
    if (problem) throw new ConfigError(problem);
    return {
      paths: [k.path],
      live: k.live,
      whole: true,
      apply(cfg) {
        setAt(cfg, k.path, value === undefined ? undefined : structuredClone(value));
      },
    };
  },
};

/** The chat's setting command as the change it makes; null for one that only shows a setting. */
export function changeFor(s: SettingCommand): SettingChange | null {
  switch (s.target) {
    case "mode":
      return s.mode ? settings.mode(s.mode) : null;
    case "claude.model":
      return s.model === undefined ? null : settings.claudeModel(s.model);
    case "claude.effort":
      return s.effort === undefined ? null : settings.claudeEffort(s.effort);
    case "claude.permissions":
      if (!s.rule) return null;
      return s.rule.kind === "remove" ? settings.claudeRemoveRule(s.rule.rule) : settings.claudeRule(s.rule.kind, s.rule.rule);
    case "claude.add-dir":
      return s.dir === undefined ? null : settings.claudeAddDir(s.dir);
    case "codex.model":
      return s.model === undefined ? null : settings.codexModel(s.model, s.effort ?? null);
    case "codex.permissions":
      return s.preset ? settings.codexPermissions(s.preset) : null;
  }
}

/**
 * Whether `later`, made after `earlier`, leaves nothing of it: it sets whole values, and covers every key `earlier`
 * touched. A list of changes replayed in order may then drop `earlier` (the chat's, the extension worker's).
 */
export function supersedes(later: SettingChange, earlier: SettingChange): boolean {
  if (!later.whole) return false;
  return earlier.paths.every((p) => later.paths.some((q) => q.length <= p.length && q.every((k, i) => p[i] === k)));
}

/** `changes` with `change` added at the end, without the earlier changes it supersedes. */
export function withChange(changes: SettingChange[], change: SettingChange): SettingChange[] {
  return [...changes.filter((c) => !supersedes(change, c)), change];
}

// ------------------------------------------------------------------ the keys the desktop's Settings change
export type SettingKind = "bin" | "model" | "args" | "budget" | "prompts" | "backend" | "positive" | "count";

/** A config key a Settings field sets: where it is, what it takes, and when work already going gets it. */
export interface SettingKey {
  key: string;
  path: string[];
  kind: SettingKind;
  live: SettingLive;
  /** It may be absent from a config (a role's args): removing it is a value of its own, not "inherit". */
  removable: boolean;
}

const LIMIT_KEYS: Array<[keyof ConfigData["limits"], "positive" | "count"]> = [
  ["max_planning_rounds", "positive"], ["max_review_rounds", "positive"], ["max_discussion_rounds", "positive"], ["max_retries", "count"],
  ["max_consecutive_gate_failures", "positive"], ["agent_timeout_sec", "positive"], ["agent_idle_timeout_sec", "count"], ["gate_timeout_sec", "positive"],
  ["max_diff_chars", "positive"], ["max_gate_output_chars", "positive"],
];

/**
 * Every key Settings may write, and when it applies. Agent options (binary, model, flags, budget, prompts) reach a
 * running run from its next call; who plays which role and the loop limits only reach work started after them, so a
 * run never changes agents or limits halfway (its config.json keeps them). paths.runs_dir is not here: the workspace
 * lock lives there.
 */
export const SETTING_KEYS: SettingKey[] = [
  ...(["claude", "codex"] as const).flatMap((b): SettingKey[] => [
    { key: `${b}.bin`, path: [b, "bin"], kind: "bin", live: "next-call", removable: false },
    { key: `${b}.model`, path: [b, "model"], kind: "model", live: "next-call", removable: false },
    { key: `${b}.args`, path: [b, "args"], kind: "args", live: "next-call", removable: false },
    ...AGENT_ROLES.map((role): SettingKey => ({ key: `${b}.role_args.${role}`, path: [b, "role_args", role], kind: "args", live: "next-call", removable: true })),
  ]),
  { key: "claude.max_budget_usd", path: ["claude", "max_budget_usd"], kind: "budget", live: "next-call", removable: false },
  { key: "claude.permission_prompts", path: ["claude", "permission_prompts"], kind: "prompts", live: "next-call", removable: false },
  ...AGENT_ROLES.map((role): SettingKey => ({ key: `agents.${role}`, path: ["agents", role], kind: "backend", live: "next-run", removable: false })),
  ...LIMIT_KEYS.map(([name, kind]): SettingKey => ({ key: `limits.${name}`, path: ["limits", name], kind, live: "next-run", removable: false })),
];

export function settingKey(key: string): SettingKey | null {
  return SETTING_KEYS.find((k) => k.key === key) ?? null;
}

const MAX_ARGS = 200;
const MAX_ARG = 4096;

/** Why `value` cannot be what `k` is set to, in the words config validation uses; null when it can. */
export function checkSettingValue(k: SettingKey, value: unknown): string | null {
  switch (k.kind) {
    case "bin":
      return typeof value === "string" && value.trim() && value.length <= MAX_ARG && !/[\u0000-\u001f]/.test(value) ? null : `${k.key} must be a non-empty string`;
    case "model":
      return value === null || (typeof value === "string" && value.trim() && value.length <= 200 && !/[\s\u0000-\u001f]/.test(value)) ? null : `${k.key} must be a string or null`;
    case "args":
      return Array.isArray(value) && value.length <= MAX_ARGS && value.every((a) => typeof a === "string" && a.length <= MAX_ARG && !a.includes("\0"))
        ? null : `${k.key} must be a list of strings`;
    case "budget":
      return value === null || (typeof value === "number" && Number.isFinite(value) && value > 0) ? null : `${k.key} must be a positive number or null`;
    case "prompts":
      return value === "ask" || value === "deny" ? null : `${k.key} must be 'ask' or 'deny'`;
    case "backend":
      return value === "codex" || value === "claude" ? null : `${k.key} must be one of codex, claude`;
    case "positive":
      return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 1e9 ? null : `${k.key} must be a positive integer`;
    case "count":
      return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1e9 ? null : `${k.key} must be an integer >= 0`;
  }
}

export function valueAt(cfg: unknown, path: string[]): unknown {
  let value: unknown = cfg;
  for (const key of path) value = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  return value;
}

/** Sets (or, with undefined, removes) the key in place: the objects on the way keep their identity. */
function setAt(cfg: ConfigData, path: string[], value: unknown): void {
  let at = cfg as unknown as Record<string, unknown>;
  for (const key of path.slice(0, -1)) {
    if (typeof at[key] !== "object" || at[key] === null) at[key] = {};
    at = at[key] as Record<string, unknown>;
  }
  const last = path.at(-1)!;
  if (value === undefined) delete at[last];
  else at[last] = value;
}

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
  claude: { model: string | null; effort: string | null; mode: string; allow: string[]; deny: string[]; addDirs: string[] };
  codex: { model: string | null; effort: string | null; permissions: string };
}

export function settingsView(cfg: ConfigData): SettingsView {
  const { allow, deny } = claudeRules(cfg);
  return {
    claude: { model: cfg.claude.model, effort: values(cfg.claude.args, ["--effort"]).at(-1) ?? null, mode: permissionMode(cfg), allow, deny, addDirs: claudeDirs(cfg) },
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
      `mode: ${v.claude.mode} · allow: ${list(v.claude.allow)} · deny: ${list(v.claude.deny)} · add-dir: ${list(v.claude.addDirs)}`,
    `Codex   model: ${v.codex.model ?? "default"} · effort: ${v.codex.effort ?? "default"} · permissions: ${v.codex.permissions}`,
    `Roles   planner: ${a.planner} · plan critic: ${a.plan_reviewer} · implementer: ${a.implementer} · code reviewer: ${a.code_reviewer}`,
  ].join("\n");
}

/** A config file as a document that keeps its comments; a file that is not valid YAML throws (it is never overwritten). */
export function configDocument(file: string): YAML.Document {
  if (!existsSync(file)) return new YAML.Document({});
  const doc = YAML.parseDocument(readFileSync(file, "utf8"));
  if (doc.errors.length) throw new ConfigError(`${file}: ${doc.errors[0]!.message.split("\n")[0]}`);
  return doc;
}

/** The comments above a key (YAML keeps them with it) go to what follows it, or above the document: they are the user's. */
function keepComments(doc: YAML.Document, path: string[]): void {
  const parent = path.length > 1 ? doc.getIn(path.slice(0, -1), true) : doc.contents;
  if (!YAML.isMap(parent)) return;
  const i = parent.items.findIndex((p) => (YAML.isScalar(p.key) ? p.key.value : p.key) === path.at(-1));
  const pair = parent.items[i];
  if (!pair) return;
  const comment = [YAML.isNode(pair.key) ? pair.key.commentBefore : null, YAML.isNode(pair.value) ? pair.value.commentBefore : null].filter(Boolean).join("\n");
  if (!comment) return;
  const next = parent.items[i + 1];
  if (next && YAML.isNode(next.key)) next.key.commentBefore = [comment, next.key.commentBefore].filter(Boolean).join("\n");
  else if (path.length === 1) doc.commentBefore = [doc.commentBefore, comment].filter(Boolean).join("\n");
  else parent.commentBefore = [parent.commentBefore, comment].filter(Boolean).join("\n");
}

/** Removes the key, and the mappings it leaves empty on the way up (`claude: {}` says nothing); comments stay. */
function deleteKey(doc: YAML.Document, path: string[]): void {
  keepComments(doc, path);
  doc.deleteIn(path);
  for (let i = path.length - 1; i > 0; i--) {
    const parent = doc.getIn(path.slice(0, i), true);
    if (!YAML.isMap(parent) || parent.items.length) break;
    keepComments(doc, path.slice(0, i));
    doc.deleteIn(path.slice(0, i));
  }
}

/** The document as its file's text: one left with no key is its comments alone, not `{}`. */
export function configText(doc: YAML.Document): string {
  if (YAML.isMap(doc.contents) && !doc.contents.items.length) {
    const comment = [doc.commentBefore, doc.contents.commentBefore].filter(Boolean).join("\n");
    return comment ? `${comment.split("\n").map((l) => `#${l}`).join("\n")}\n` : "";
  }
  return String(doc);
}

/** Removes each key from the document, with the mappings it leaves empty. */
export function removeKeys(doc: YAML.Document, paths: string[][]): void {
  for (const path of paths) if (doc.hasIn(path)) deleteKey(doc, path);
}

/**
 * Writes the keys a change touched into a config file, keeping its comments and everything else as it was. A key the
 * change removed (a role's args) is removed from the file too: null would be a value of its own.
 */
export function saveSettings(file: string, cfg: ConfigData, paths: string[][]): void {
  const doc = configDocument(file);
  for (const path of paths) {
    const value = valueAt(cfg, path);
    if (value === undefined) deleteKey(doc, path);
    else doc.setIn(path, structuredClone(value));
  }
  atomicWrite(file, configText(doc));
}

/**
 * Removes keys from a config file, so they inherit again (the user config's value, or the default): the key goes,
 * never a null in its place, which would mean "the default" and hide the user config. Comments stay. A file that is
 * not there has nothing to remove; one that is not valid YAML throws.
 */
export function clearSettings(file: string, paths: string[][]): boolean {
  if (!existsSync(file)) return false;
  const doc = configDocument(file);
  let changed = false;
  for (const path of paths) {
    if (!doc.hasIn(path)) continue;
    deleteKey(doc, path);
    changed = true;
  }
  if (changed) atomicWrite(file, configText(doc));
  return changed;
}

/**
 * `--global`: writes a change into the user config file, made to what that file says over the defaults, so nothing
 * of the workspace's config goes along. Returns the keys `configFile`, read over it, sets otherwise (there it wins):
 * a change is idempotent, so a key it still changes over both files is one the change is not in force for.
 */
export function saveGlobalSetting(userFile: string, configFile: string, change: SettingChange): string[] {
  const user = configFromFiles([userFile]);
  change.apply(user);
  saveSettings(userFile, user, change.paths);
  const here = configFromFiles([userFile, configFile]);
  const before = change.paths.map((path) => structuredClone(valueAt(here, path)));
  change.apply(here);
  return change.paths.filter((path, i) => !isDeepStrictEqual(valueAt(here, path), before[i])).map((path) => path.join("."));
}
