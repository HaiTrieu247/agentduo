// The configuration as the desktop's Settings show and change it, with no chat, no run and no workspace lock: each
// layer as its file says it (the user config, the workspace's), each key's effective value and where it comes from,
// what is wrong, and writes that keep the files' comments and never leave a configuration worse than they found it.
// Pure Node and YAML, so the desktop's main process and the engine worker share it.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { configErrors, ConfigError, configFromLayers, defaultConfig, userConfigPath, type ConfigData } from "./config.js";
import { expandHome } from "./environment.js";
import { checkSettingValue, configDocument, configText, removeKeys, SETTING_KEYS, settingKey, valueAt, type SettingKey, type SettingKind, type SettingLive } from "./settings.js";
import { atomicWrite, workspaceLockHolder } from "./state.js";

/** Where a Settings change goes: the user config (every workspace), the workspace's config file, or this session only. */
export type ConfigScope = "global" | "project" | "session";
export type ConfigSource = "default" | "global" | "project" | "session";
/** A layer's own value of a key; null when the layer does not set it (it inherits). */
export type LayerValue = { value: unknown } | null;

export interface ConfigFileInfo {
  scope: "global" | "project";
  path: string;
  exists: boolean;
  /** Not valid YAML, or not a mapping: Settings leaves the file alone until it is fixed by hand. */
  error: { message: string; line: number | null; col: number | null } | null;
}

export interface ConfigEntry {
  key: string;
  /** What its value is (a binary, a model, a list of args, a positive integer…): what Settings edits it with. */
  kind: SettingKind;
  live: SettingLive;
  /** A role's args: absent means "none of its own"; shown and set as null. */
  removable: boolean;
  defaultValue: unknown;
  global: LayerValue;
  project: LayerValue;
  /** This session's own value, where it differs from what the files say (a chat setting without --save). */
  session: LayerValue;
  /** What new work gets: the session's value, else the files' over the defaults. */
  effective: unknown;
  source: ConfigSource;
  /** The workspace's file sets it too, so the user config's value does not apply in this workspace. */
  projectOverridesGlobal: boolean;
  errors: string[];
}

export interface ConfigurationView {
  workspace: string | null;
  files: ConfigFileInfo[];
  entries: ConfigEntry[];
  /** Every problem of the merged files, also of keys Settings does not show (gates, quality gates…). */
  errors: string[];
  warnings: string[];
  /** Where runs and conversations live (and the workspace lock): shown, never changed from Settings. */
  storage: { runsDir: string | null; value: string; source: "default" | "global" | "project" };
  /** Another process holds the workspace lock: it reads the files again only once it restarts. */
  lockedBy: number | null;
}

export interface ConfigurationOptions {
  /** null: no project, only the user config. */
  workspace: string | null;
  /** --config: the file read in place of <workspace>/.agentduo/config.yaml. */
  configPath?: string | null;
  env: NodeJS.ProcessEnv;
  /** The config this session gives new work (its chats'): where it differs from the files it is the session's own. */
  session?: ConfigData | null;
  /** This process: a lock it holds itself is not another process's. */
  pid?: number;
}

/** A change Settings refused: it would leave the configuration with new problems, or the file is not valid YAML. */
export class ConfigurationError extends Error {
  override name = "ConfigurationError";
  constructor(message: string, readonly errors: string[] = []) {
    super(message);
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The two files, as loadConfig reads them: the user config, then the workspace's (or --config). */
export function configFiles(o: Pick<ConfigurationOptions, "workspace" | "configPath" | "env">): { global: string; project: string | null } {
  const project = o.workspace ? (o.configPath ? resolve(o.workspace, o.configPath) : join(o.workspace, ".agentduo", "config.yaml")) : null;
  return { global: userConfigPath(o.env), project };
}

interface Layer {
  info: ConfigFileInfo;
  raw: Record<string, unknown>;
}

function readLayer(scope: "global" | "project", path: string): Layer {
  const info: ConfigFileInfo = { scope, path, exists: existsSync(path), error: null };
  if (!info.exists) return { info, raw: {} };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { info: { ...info, error: { message: (e as Error).message, line: null, col: null } }, raw: {} };
  }
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) {
    const e = doc.errors[0]!;
    const pos = e.linePos?.[0];
    return { info: { ...info, error: { message: e.message.split("\n")[0]!, line: pos?.line ?? null, col: pos?.col ?? null } }, raw: {} };
  }
  const raw = doc.toJS() as unknown;
  if (raw === null || raw === undefined) return { info, raw: {} };
  if (!isPlainObject(raw)) return { info: { ...info, error: { message: "the top level must be a mapping", line: null, col: null } }, raw: {} };
  return { info, raw };
}

interface Loaded {
  layers: Layer[];
  cfg: ConfigData;
  warnings: string[];
}

/**
 * The files merged over the defaults, unvalidated. A file that cannot be read as a configuration is left out (and
 * says why), so the rest still shows; `replace` puts a candidate in place of one layer's contents.
 */
function load(o: ConfigurationOptions, replace?: { scope: "global" | "project"; raw: Record<string, unknown> }): Loaded {
  const files = configFiles(o);
  const layers: Layer[] = [];
  // duo --config on the user config itself: one file, read once, as loadConfig does.
  if (files.global !== files.project) layers.push(readLayer("global", files.global));
  if (files.project) layers.push(readLayer("project", files.project));
  if (replace) for (const l of layers) if (l.info.scope === replace.scope) l.raw = replace.raw;
  const good: Array<Record<string, unknown>> = [];
  let warnings: string[] = [];
  for (const layer of layers) {
    if (layer.info.error) continue;
    const w: string[] = [];
    try {
      configFromLayers([...good, layer.raw], w);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      layer.info.error = { message: e.message, line: null, col: null };
      continue;
    }
    good.push(layer.raw);
    warnings = [...warnings, ...w.filter((x) => !warnings.includes(x)).map((x) => `${layer.info.path}: ${x}`)];
  }
  return { layers, cfg: configFromLayers(good), warnings };
}

/** The files' configuration, as the next process to start would read it (broken files left out). */
export function filesConfiguration(o: ConfigurationOptions): ConfigData {
  return load(o).cfg;
}

function layerValue(raw: Record<string, unknown>, path: string[]): LayerValue {
  let at: unknown = raw;
  for (const key of path) {
    if (!isPlainObject(at) || !Object.prototype.hasOwnProperty.call(at, key)) return null;
    at = at[key];
  }
  return { value: at };
}

/** A removable key that is absent reads as null, so it survives JSON. */
const shown = (k: SettingKey, v: unknown) => (v === undefined && k.removable ? null : v);
const belongs = (k: SettingKey) => (e: string) => e === k.key || e.startsWith(`${k.key} `) || e.startsWith(`${k.key}:`);

function view(o: ConfigurationOptions, loaded: Loaded): ConfigurationView {
  const { layers, cfg, warnings } = loaded;
  const errors = configErrors(cfg);
  const of = (scope: "global" | "project") => layers.find((l) => l.info.scope === scope && !l.info.error)?.raw ?? null;
  const global = of("global");
  const project = of("project");
  const session = o.session ?? null;
  const defaults = defaultConfig();
  const entries = SETTING_KEYS.map((k): ConfigEntry => {
    const g = global ? layerValue(global, k.path) : null;
    const p = project ? layerValue(project, k.path) : null;
    const files = valueAt(cfg, k.path);
    const own = session ? valueAt(session, k.path) : files;
    const s = session && !isDeepStrictEqual(own, files) ? { value: shown(k, own) } : null;
    return {
      key: k.key, kind: k.kind, live: k.live, removable: k.removable, defaultValue: shown(k, valueAt(defaults, k.path)),
      global: g && { value: shown(k, g.value) }, project: p && { value: shown(k, p.value) }, session: s,
      effective: shown(k, s ? own : files), source: s ? "session" : p ? "project" : g ? "global" : "default", projectOverridesGlobal: !!(g && p),
      errors: errors.filter(belongs(k)),
    };
  });
  const runs = valueAt(cfg, ["paths", "runs_dir"]);
  const value = typeof runs === "string" && runs ? runs : defaultConfig().paths.runs_dir;
  const where = project && layerValue(project, ["paths", "runs_dir"]) ? "project" : global && layerValue(global, ["paths", "runs_dir"]) ? "global" : "default";
  const expanded = expandHome(value, o.env);
  const runsDir = o.workspace ? (isAbsolute(expanded) ? expanded : join(o.workspace, expanded)) : null;
  const holder = runsDir ? workspaceLockHolder(runsDir) : null;
  return {
    workspace: o.workspace, files: layers.map((l) => l.info), entries, errors, warnings, storage: { runsDir, value, source: where },
    lockedBy: holder && holder !== (o.pid ?? process.pid) ? holder : null,
  };
}

/** Every layer of the configuration, each key's value and source, and what is wrong; reads only. */
export function readConfiguration(o: ConfigurationOptions): ConfigurationView {
  return view(o, load(o));
}

function fileFor(o: ConfigurationOptions, scope: "global" | "project"): string {
  const files = configFiles(o);
  if (scope === "global") return files.global;
  if (!files.project) throw new ConfigurationError("open a project first: there is no workspace config without one");
  return files.project;
}

function documentOf(file: string): YAML.Document {
  try {
    return configDocument(file);
  } catch (e) {
    if (e instanceof ConfigError) throw new ConfigurationError(`${e.message}. Fix the file by hand (Settings opens it), then check again.`);
    throw e;
  }
}

/**
 * The candidate is checked before it is written: a change that would add a problem to the merged configuration is not
 * saved. Problems it already had do not block it, so a broken configuration can be fixed one field at a time.
 */
function guard(o: ConfigurationOptions, scope: "global" | "project", doc: YAML.Document): void {
  const before = configErrors(load(o).cfg);
  const raw = doc.toJS() as unknown;
  let after: string[];
  try {
    after = configErrors(load(o, { scope, raw: isPlainObject(raw) ? raw : {} }).cfg);
  } catch (e) {
    if (e instanceof ConfigError) throw new ConfigurationError(`not saved: ${e.message}`, [e.message]);
    throw e;
  }
  const added = after.filter((e) => !before.includes(e));
  if (added.length) throw new ConfigurationError(`not saved: ${added.join("; ")}`, added);
}

/** Sets one key in the user config (`global`) or the workspace's file (`project`), keeping the file's comments. */
export function updateConfiguration(o: ConfigurationOptions, scope: "global" | "project", key: string, value: unknown): ConfigurationView {
  const k = settingKey(key);
  if (!k) throw new ConfigurationError(`'${key}' is not a setting agentduo can change`);
  const problem = checkSettingValue(k, value);
  if (problem) throw new ConfigurationError(problem, [problem]);
  const file = fileFor(o, scope);
  const doc = documentOf(file);
  doc.setIn(k.path, structuredClone(value));
  guard(o, scope, doc);
  atomicWrite(file, configText(doc));
  return readConfiguration(o);
}

/**
 * Removes one key from the user config or the workspace's file, so it inherits again (from the user config, or the
 * default); it is deleted, never written as null.
 */
export function clearConfiguration(o: ConfigurationOptions, scope: "global" | "project", key: string): ConfigurationView {
  const k = settingKey(key);
  if (!k) throw new ConfigurationError(`'${key}' is not a setting agentduo can change`);
  const file = fileFor(o, scope);
  if (!existsSync(file)) return readConfiguration(o);
  const doc = documentOf(file);
  if (!doc.hasIn(k.path)) return readConfiguration(o);
  removeKeys(doc, [k.path]);
  guard(o, scope, doc);
  atomicWrite(file, configText(doc));
  return readConfiguration(o);
}
