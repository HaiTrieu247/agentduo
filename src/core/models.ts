// Which model each agent runs with, found locally and without calling a model: the argv agentduo builds, then the
// CLI's own configuration (codex doctor for Codex; the environment and settings files for Claude). Claude's own
// stream names the model of each call, which confirms it.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runProcess } from "../agents/process.js";
import { resolveBinary } from "../agents/resolve.js";
import type { Agent, ModelIdentity, ModelMap } from "../events.js";
import type { ModelChoice } from "./commands.js";
import type { ConfigData } from "./config.js";
import { values } from "./settings.js";

/** codex doctor gets this long; then the model stays unknown (it never holds up the chat). */
export const DISCOVERY_TIMEOUT_MS = 10_000;

const blank = (backend: Agent): ModelIdentity => ({
  backend, requested: null, configured: null, resolved: null, source: null, isDefault: true, status: "unresolved", reason: null,
});

export const resolvingModels = (): ModelMap => ({ codex: { ...blank("codex"), status: "resolving" }, claude: { ...blank("claude"), status: "resolving" } });

/** A short fingerprint of what a model depends on (settings files' content never sits in memory as is). */
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The identity once the CLI's own stream named the model of a call. */
export function withObserved(m: ModelIdentity, model: string): ModelIdentity {
  return { ...m, resolved: model, source: "observed", status: "resolved", reason: null };
}

/**
 * The model the CLI would get from argv: agentduo puts `<backend>.model` as --model before `args`, so a --model in
 * args comes later and wins, as it does for the CLI.
 */
export function explicitModel(cfg: { model: string | null; args: string[] }, flags: string[]): { model: string; source: "config" | "args" } | null {
  const fromArgs = values(cfg.args, flags).at(-1);
  if (fromArgs) return { model: fromArgs, source: "args" };
  return cfg.model ? { model: cfg.model, source: "config" } : null;
}

// ------------------------------------------------------------------ Codex
const CODEX_MODEL_FLAGS = ["--model", "-m"];
const CODEX_FORWARDED = ["-c", "--config", "--enable", "--disable"];

/** The config overrides and feature switches of `args`, in order, which codex doctor takes too (it takes no --profile). */
export function codexDoctorArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const name = arg.split("=")[0]!;
    if (!CODEX_FORWARDED.includes(name)) continue;
    if (arg !== name) out.push(arg);
    else if (i + 1 < args.length) out.push(arg, args[++i]!);
  }
  return out;
}

/** The config files codex may load in `workspace`: CODEX_HOME's, the system's, and any project's .codex/ up the tree. */
export function codexConfigFiles(workspace: string, env: NodeJS.ProcessEnv): string[] {
  const home = env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
  const files = [join(home, "config.toml"), "/etc/codex/config.toml", "/etc/codex/managed_config.toml"];
  for (let dir = resolve(workspace); ; dir = dirname(dir)) {
    files.push(join(dir, ".codex", "config.toml"));
    if (dirname(dir) === dir) return files;
  }
}

/** What Codex's model depends on outside agentduo's config: where its config is, and what those files say. */
export function codexLocalSignature(workspace: string, env: NodeJS.ProcessEnv): string {
  const text = (path: string) => {
    try {
      return existsSync(path) ? readFileSync(path, "utf8") : null;
    } catch {
      return "unreadable";
    }
  };
  return digest([env.CODEX_HOME ?? "", env.HOME ?? "", codexConfigFiles(workspace, env).map((p) => [p, text(p)])]);
}

export interface DoctorAnswer {
  model: string | null;
  reason: string | null;
}

/** The model in codex doctor's JSON report: checks["config.load"].details.model. */
export function doctorModel(stdout: string): DoctorAnswer {
  let report: any;
  try {
    report = JSON.parse(stdout);
  } catch {
    return { model: null, reason: "codex doctor printed no JSON report" };
  }
  const model = report?.checks?.["config.load"]?.details?.model;
  return typeof model === "string" && model.trim() ? { model: model.trim(), reason: null } : { model: null, reason: "codex doctor reported no model" };
}

async function runCodexDoctor(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal, timeoutMs: number): Promise<DoctorAnswer> {
  try {
    const r = await runProcess(bin, ["doctor", "--json", ...args], { cwd, env, timeoutMs, signal, killGraceMs: 500, maxBufferChars: 1024 * 1024 });
    if (r.aborted) return { model: null, reason: "stopped" };
    if (r.timedOut) return { model: null, reason: `codex doctor did not answer within ${Math.round(timeoutMs / 1000)}s` };
    const answer = doctorModel(r.stdout);
    return answer.model || r.code === 0 ? answer : { model: null, reason: `codex doctor failed (exit code ${r.code})` };
  } catch (e) {
    return { model: null, reason: `cannot run codex doctor: ${(e as Error).message}` };
  }
}

/** Codex's model catalog, as `codex debug models` lists it for its /model; or why there is none. */
export interface CodexCatalog {
  models: ModelChoice[];
  reason: string | null;
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The models Codex's /model shows: those listed (not hidden) in the catalog, by priority. */
export function codexCatalog(stdout: string): CodexCatalog {
  let report: any;
  try {
    report = JSON.parse(stdout);
  } catch {
    return { models: [], reason: "codex debug models printed no JSON catalog" };
  }
  const listed = (Array.isArray(report?.models) ? report.models : [])
    .filter((m: any) => text(m?.slug) && (m.visibility === undefined || m.visibility === "list"))
    .sort((a: any, b: any) => (Number.isFinite(a.priority) ? a.priority : Infinity) - (Number.isFinite(b.priority) ? b.priority : Infinity));
  const models = listed.map((m: any): ModelChoice => ({
    id: text(m.slug), label: text(m.display_name) || text(m.slug), description: text(m.description),
    efforts: Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((l: any) => text(l?.effort)).filter(Boolean) : null,
    defaultEffort: text(m.default_reasoning_level) || null,
  }));
  return models.length ? { models, reason: null } : { models: [], reason: "codex debug models listed no models" };
}

async function runCodexCatalog(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal, timeoutMs: number): Promise<CodexCatalog> {
  try {
    const r = await runProcess(bin, ["debug", "models", ...args], { cwd, env, timeoutMs, signal, killGraceMs: 500, maxBufferChars: 8 * 1024 * 1024 });
    if (r.aborted) return { models: [], reason: "stopped" };
    if (r.timedOut) return { models: [], reason: `codex debug models did not answer within ${Math.round(timeoutMs / 1000)}s` };
    return r.code === 0 ? codexCatalog(r.stdout) : { models: [], reason: `codex debug models failed (exit code ${r.code})` };
  } catch (e) {
    return { models: [], reason: `cannot run codex debug models: ${(e as Error).message}` };
  }
}

// ------------------------------------------------------------------ Claude
const SOURCES = ["user", "project", "local"];

export function managedSettingsPaths(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "darwin") return ["/Library/Application Support/ClaudeCode/managed-settings.json"];
  if (platform === "win32") return ["C:\\ProgramData\\ClaudeCode\\managed-settings.json"];
  return ["/etc/claude-code/managed-settings.json"];
}

type Read = { missing: true } | { error: string } | { json: Record<string, unknown> };

function readJsonFile(path: string): Read {
  if (!existsSync(path)) return { missing: true };
  try {
    const json = JSON.parse(readFileSync(path, "utf8"));
    return json && typeof json === "object" && !Array.isArray(json) ? { json } : { error: "not a JSON object" };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

type SettingsOptions = { args: string[]; workspace: string; env: NodeJS.ProcessEnv; managed?: string[] };
type Candidate = { where: string; read: () => Read };

/**
 * The settings Claude Code reads, in its order of precedence: managed settings, --settings, then the local, project
 * and user settings that --setting-sources leaves in; or why agentduo cannot tell.
 */
function claudeSettingsSources(o: SettingsOptions): { candidates: Candidate[] } | { reason: string } {
  const listed = values(o.args, ["--setting-sources"]).at(-1);
  const enabled = listed === undefined ? SOURCES : listed.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = enabled.find((s) => !SOURCES.includes(s));
  if (unknown) return { reason: `--setting-sources names '${unknown}', which agentduo cannot read` };
  const configDir = o.env.CLAUDE_CONFIG_DIR || join(o.env.HOME || homedir(), ".claude");
  const candidates: Candidate[] = [
    ...(o.managed ?? managedSettingsPaths()).map((p) => ({ where: p, read: () => readJsonFile(p) })),
    // A later --settings wins over an earlier one.
    ...values(o.args, ["--settings"]).reverse().map((v) => (v.trim().startsWith("{")
      ? { where: "--settings", read: (): Read => {
        try {
          return { json: JSON.parse(v) };
        } catch (e) {
          return { error: (e as Error).message };
        }
      } }
      : { where: resolve(o.workspace, v), read: () => readJsonFile(resolve(o.workspace, v)) })),
    ...(enabled.includes("local") ? [join(o.workspace, ".claude", "settings.local.json")] : []).map((p) => ({ where: p, read: () => readJsonFile(p) })),
    ...(enabled.includes("project") ? [join(o.workspace, ".claude", "settings.json")] : []).map((p) => ({ where: p, read: () => readJsonFile(p) })),
    ...(enabled.includes("user") ? [join(configDir, "settings.json")] : []).map((p) => ({ where: p, read: () => readJsonFile(p) })),
  ];
  return { candidates };
}

/** The model Claude Code's settings name (see claudeSettingsSources). A source it cannot judge gives a reason, not a guess. */
export function claudeSettingsModel(o: SettingsOptions): { model: string | null; where: string | null; envModel: string | null; reason: string | null } {
  const none = { model: null, where: null, envModel: null };
  const sources = claudeSettingsSources(o);
  if ("reason" in sources) return { ...none, reason: sources.reason };
  let found: { model: string; where: string } | null = null;
  let envModel: string | null = null;
  for (const c of sources.candidates) {
    const r = c.read();
    if ("missing" in r) continue;
    if ("error" in r) return { ...none, reason: `cannot read ${c.where}` };
    const env = r.json.env as Record<string, unknown> | undefined;
    if (!envModel && env && typeof env.ANTHROPIC_MODEL === "string" && env.ANTHROPIC_MODEL.trim()) envModel = env.ANTHROPIC_MODEL.trim();
    if (!found && typeof r.json.model === "string" && r.json.model.trim()) found = { model: r.json.model.trim(), where: c.where };
  }
  return { model: found?.model ?? null, where: found?.where ?? null, envModel, reason: null };
}

/** The environment Claude Code takes its model from (ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_*_MODEL…) and finds its settings with. */
const claudeEnv = (env: NodeJS.ProcessEnv) =>
  Object.keys(env).filter((k) => /^ANTHROPIC_.*MODEL$|^CLAUDE_CONFIG_DIR$|^HOME$|^CLAUDE_CODE_USE_/.test(k)).sort().map((k) => [k, env[k]]);

/**
 * What Claude's model depends on outside agentduo's config: that environment, and the `model` and `env` of each
 * settings file (not the rest, so saving a permission rule, even in a file that did not exist, changes nothing).
 */
export function claudeLocalSignature(o: SettingsOptions): string {
  const sources = claudeSettingsSources(o);
  const files = "reason" in sources ? sources.reason : sources.candidates.map((c) => {
    const r = c.read();
    return [c.where, "error" in r ? "unreadable" : "json" in r ? [r.json.model ?? null, r.json.env ?? null] : [null, null]];
  });
  return digest([claudeEnv(o.env), files]);
}

/** Claude's model as far as agentduo can tell before a call; `observed` is what Claude's stream named. */
export function claudeIdentity(cfg: ConfigData["claude"], workspace: string, env: NodeJS.ProcessEnv, observed?: string, managed?: string[]): ModelIdentity {
  const base = blank("claude");
  const explicit = explicitModel(cfg, ["--model"]);
  if (explicit) {
    const m: ModelIdentity = { ...base, requested: explicit.model, source: explicit.source, isDefault: false, status: "configured", reason: "Claude Code names the exact model with its first answer" };
    return observed ? withObserved(m, observed) : m;
  }
  const settings = claudeSettingsModel({ args: cfg.args, workspace, env, managed });
  let m: ModelIdentity;
  if (settings.reason) m = { ...base, reason: settings.reason };
  else if (settings.envModel) m = { ...base, reason: "a settings file sets ANTHROPIC_MODEL in its env; Claude Code names the model with its first answer" };
  else if (env.ANTHROPIC_MODEL?.trim()) m = { ...base, configured: env.ANTHROPIC_MODEL.trim(), source: "env", status: "configured", reason: "from ANTHROPIC_MODEL" };
  else if (settings.model) m = { ...base, configured: settings.model, source: "settings", status: "configured", reason: `from ${settings.where}` };
  else m = { ...base, reason: "Claude Code's own default; it is named with the first answer" };
  return observed ? withObserved(m, observed) : m;
}

// ------------------------------------------------------------------ registry
export interface ModelRegistryOptions {
  /** The config the next call runs with (the chat's, which its settings commands change); null before there is one. */
  cfg(): ConfigData | null;
  workspace: string;
  env: NodeJS.ProcessEnv;
  onChange?(models: ModelMap): void;
  /** For a view with a model picker: Codex's catalog, read as `refresh()` finds a new Codex binary or config. */
  onCatalog?(catalog: CodexCatalog): void;
  timeoutMs?: number;
  /** Managed settings files to read instead of the platform's (tests). */
  managedSettings?: string[];
}

/**
 * Both agents' current model identity. `refresh()` recomputes it for the config as it is now, agentduo's and the CLI's
 * own (and starts codex doctor in the background, cached per binary, overrides, environment and config files); a
 * lookup that ends after either changed is kept for later but never shown for the new config, which is asked again.
 */
export class ModelRegistry {
  private models: ModelMap = resolvingModels();
  private readonly doctor = new Map<string, Promise<DoctorAnswer> | DoctorAnswer>();
  private readonly observed = new Map<string, string>();
  /** What the catalog shown was read for (null: nothing yet, or the last read failed and is asked again). */
  private catalogKey: string | null = null;
  private readonly abort = new AbortController();
  private closed = false;

  constructor(private readonly o: ModelRegistryOptions) {}

  current(): ModelMap {
    return structuredClone(this.models);
  }

  identity(backend: Agent): ModelIdentity {
    return structuredClone(this.models[backend]);
  }

  /** What the identity of `backend` depends on: agentduo's config for it, and the environment and files the CLI reads. */
  signature(backend: Agent): string {
    const cfg = this.o.cfg()?.[backend];
    if (!cfg) return "";
    const local = backend === "claude"
      ? claudeLocalSignature({ args: cfg.args, workspace: this.o.workspace, env: this.o.env, managed: this.o.managedSettings })
      : codexLocalSignature(this.o.workspace, this.o.env);
    return digest([cfg.bin, cfg.model, cfg.args, local]);
  }

  refresh(): void {
    const cfg = this.o.cfg();
    if (!cfg || this.closed) return;
    this.set("claude", this.claudeNow(cfg));
    this.set("codex", this.codexNow(cfg));
    this.loadCatalog(cfg);
  }

  /** Claude's stream named the model of a call made with `signature`; it stands for that config from now on. */
  observe(backend: Agent, model: string, signature: string): void {
    if (this.closed) return;
    this.observed.set(`${backend} ${signature}`, model);
    const cfg = this.o.cfg();
    if (cfg && this.signature(backend) === signature && backend === "claude") this.set("claude", this.claudeNow(cfg));
  }

  close(): void {
    this.closed = true;
    this.abort.abort();
  }

  private set(backend: Agent, identity: ModelIdentity): void {
    if (JSON.stringify(this.models[backend]) === JSON.stringify(identity)) return;
    this.models = { ...this.models, [backend]: identity };
    this.o.onChange?.(this.current());
  }

  /** Codex's catalog depends on its binary, the overrides it takes and its own config (its model provider). */
  private loadCatalog(cfg: ConfigData): void {
    const onCatalog = this.o.onCatalog;
    if (!onCatalog) return;
    const bin = resolveBinary(cfg.codex.bin, "codex", this.o.env);
    const forwarded = codexDoctorArgs(cfg.codex.args);
    const key = digest([bin, forwarded, this.o.workspace, codexLocalSignature(this.o.workspace, this.o.env)]);
    if (key === this.catalogKey) return;
    this.catalogKey = key;
    if (!bin) return onCatalog({ models: [], reason: "codex CLI not found" });
    void runCodexCatalog(bin, forwarded, this.o.workspace, this.o.env, this.abort.signal, this.o.timeoutMs ?? DISCOVERY_TIMEOUT_MS).then((catalog) => {
      if (this.closed || this.catalogKey !== key) return;
      if (catalog.reason) this.catalogKey = null; // a failure is not kept: the next refresh asks again
      onCatalog(catalog);
    });
  }

  private claudeNow(cfg: ConfigData): ModelIdentity {
    return claudeIdentity(cfg.claude, this.o.workspace, this.o.env, this.observed.get(`claude ${this.signature("claude")}`), this.o.managedSettings);
  }

  private codexNow(cfg: ConfigData): ModelIdentity {
    const base = blank("codex");
    const explicit = explicitModel(cfg.codex, CODEX_MODEL_FLAGS);
    if (explicit) return { ...base, requested: explicit.model, resolved: explicit.model, source: explicit.source, isDefault: false, status: "resolved" };
    const profile = values(cfg.codex.args, ["-p", "--profile"]).at(-1);
    if (profile) return { ...base, reason: `Codex profile '${profile}': codex doctor cannot load profiles` };
    const bin = resolveBinary(cfg.codex.bin, "codex", this.o.env);
    if (!bin) return { ...base, reason: "codex CLI not found" };
    const forwarded = codexDoctorArgs(cfg.codex.args);
    const key = digest([bin, forwarded, this.o.workspace, codexLocalSignature(this.o.workspace, this.o.env)]);
    const signature = this.signature("codex");
    let known = this.doctor.get(key);
    if (known && !(known instanceof Promise)) return fromDoctor(base, known);
    if (!known) {
      known = runCodexDoctor(bin, forwarded, this.o.workspace, this.o.env, this.abort.signal, this.o.timeoutMs ?? DISCOVERY_TIMEOUT_MS).then((answer) => {
        if (answer.model) this.doctor.set(key, answer);
        else this.doctor.delete(key); // a failure is not kept: the next look (a question, a run, a setting) asks again
        return answer;
      });
      this.doctor.set(key, known);
    }
    // Shown only if the config is still the one it was asked for; otherwise the config as it is now is asked about.
    void known.then((answer) => {
      const now = this.o.cfg();
      if (this.closed || !now) return;
      this.set("codex", this.signature("codex") === signature ? fromDoctor(base, answer) : this.codexNow(now));
    });
    return { ...base, status: "resolving" };
  }
}

function fromDoctor(base: ModelIdentity, answer: DoctorAnswer): ModelIdentity {
  return answer.model
    ? { ...base, resolved: answer.model, source: "doctor", status: "resolved" }
    : { ...base, reason: answer.reason };
}
