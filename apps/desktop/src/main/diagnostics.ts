// What "Export diagnostics" writes: versions, the platform, where things live, the PATH sources, both CLIs' state,
// the configuration files' problems and the host's recent log lines. Never credentials, attachments, prompts or the
// environment; the home folder is written as ~. The renderer shows this exact text before it is saved.
import { homedir } from "node:os";
import type { ConfigurationView } from "../../../../src/core/configuration.js";
import type { CliStatus, LauncherInfo } from "../shared/protocol.js";

const MAX_LOG_LINES = 400;

/** The host's own log, kept in memory (the last lines only), for diagnostics. */
export class LogBuffer {
  private readonly lines: string[] = [];

  add(line: string): void {
    this.lines.push(`${new Date().toISOString()} ${line}`);
    if (this.lines.length > MAX_LOG_LINES) this.lines.splice(0, this.lines.length - MAX_LOG_LINES);
  }

  get all(): readonly string[] {
    return this.lines;
  }
}

/** Long base64 runs (an image someone pasted, a token) and credential-looking values become [redacted]. */
export function redact(text: string, home = homedir()): string {
  let out = text;
  if (home && home.length > 1) out = out.split(home).join("~");
  out = out.replace(/[A-Za-z0-9+/=_-]{120,}/g, "[redacted]");
  out = out.replace(/((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',]+/gi, "$1[redacted]");
  return out;
}

export function diagnosticsText(o: {
  versions: Record<string, string>; platform: string; arch: string; userData: string; project: string | null;
  launcher: LauncherInfo | null; clis: CliStatus[]; config: ConfigurationView | null; configError: string | null; log: readonly string[]; home?: string;
}): string {
  const lines: string[] = ["# AgentDuo diagnostics", ""];
  lines.push(`versions: ${Object.entries(o.versions).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  lines.push(`platform: ${o.platform} ${o.arch}`);
  lines.push(`app data: ${o.userData}`);
  lines.push(`project: ${o.project ?? "(none)"}`);
  if (o.config?.storage) lines.push(`runs directory: ${o.config.storage.runsDir ?? "(no project)"} (${o.config.storage.source})`);
  lines.push("", "## PATH for the agents");
  if (o.launcher) {
    lines.push(`sources: ${o.launcher.sources.join(", ")}`, `entries: ${o.launcher.entries}`);
    if (o.launcher.shellProblem) lines.push(`login shell: ${o.launcher.shellProblem}`);
  } else lines.push("(not resolved yet)");
  lines.push("", "## CLIs");
  for (const c of o.clis) {
    lines.push(`${c.backend}: ${c.state}${c.auth ? ` (${c.auth.kind === "api" ? "API" : "account"})` : ""}; bin ${c.configured} (${c.source}) → ${c.path ?? "not found"}; version ${c.version ?? "?"}${c.detail ? `; ${c.detail}` : ""}`);
  }
  lines.push("", "## Configuration");
  if (o.configError) lines.push(`could not read it: ${o.configError}`);
  for (const f of o.config?.files ?? []) {
    lines.push(`${f.scope}: ${f.path} ${f.exists ? "" : "(none)"}${f.error ? ` — ${f.error.message}${f.error.line ? ` at line ${f.error.line}` : ""}` : ""}`.trimEnd());
  }
  for (const e of o.config?.errors ?? []) lines.push(`error: ${e}`);
  for (const w of o.config?.warnings ?? []) lines.push(`warning: ${w}`);
  if (o.config?.lockedBy) lines.push(`workspace lock held by pid ${o.config.lockedBy}`);
  lines.push("", "## Recent host log", ...(o.log.length ? o.log : ["(empty)"]));
  return `${redact(lines.join("\n"), o.home)}\n`;
}
