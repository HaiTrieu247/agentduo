// Settings and the first-run check, on the host side. The configuration is read and changed through the project's
// worker when one runs (so its chats follow the change, as /claude … does), else as files only: no lock, no chat.
// The CLI check asks each CLI for its version and its sign-in, never the model. No Electron import.
import { closeSync, openSync, readSync } from "node:fs";
import { extname } from "node:path";
import { clearConfiguration, readConfiguration, updateConfiguration, type ConfigScope, type ConfigurationView } from "../../../../src/core/configuration.js";
import { resolveBinary } from "../../../../src/agents/resolve.js";
import { runProcess } from "../../../../src/agents/process.js";
import { claudeAccount } from "../../../../src/core/usage.js";
import type { WorkspaceSession } from "../../../../extensions/vscode/src/workspaceSession.js";
import type { Backend } from "../../../../src/core/commands.js";
import type { CliAuth, CliState, CliStatus } from "../shared/protocol.js";

export const PROBE_TIMEOUT_MS = 8000;

export interface ConfigTarget {
  workspace: string | null;
  session: WorkspaceSession | null;
  env: NodeJS.ProcessEnv;
}

/** Through the worker when it runs (its chats follow), else the files themselves; the session scope needs the worker. */
async function viaWorker<T>(t: ConfigTarget, ask: (s: WorkspaceSession) => Promise<T>, files: () => T, scope: ConfigScope): Promise<T> {
  if (t.session?.workerPid) {
    try {
      return await ask(t.session);
    } catch (e) {
      if (scope === "session") throw e;
    }
  }
  if (scope === "session") throw new Error("session settings need the project's agentduo worker running: open a conversation first");
  return files();
}

export function readSettings(t: ConfigTarget): Promise<ConfigurationView> {
  return viaWorker(t, (s) => s.request({ type: "readConfiguration", workspace: t.workspace, configPath: null }), () => readConfiguration({ workspace: t.workspace, env: t.env, pid: process.pid }), "global");
}

export function updateSetting(t: ConfigTarget, scope: ConfigScope, key: string, value: unknown): Promise<ConfigurationView> {
  if (!t.workspace && scope !== "global") return Promise.reject(new Error("with no project open, only the user config can be changed"));
  return viaWorker(
    t, (s) => s.request({ type: "updateConfiguration", workspace: t.workspace, configPath: null, scope, key, value }),
    () => updateConfiguration({ workspace: t.workspace, env: t.env, pid: process.pid }, scope as "global" | "project", key, value), scope,
  );
}

export function clearSetting(t: ConfigTarget, scope: ConfigScope, key: string): Promise<ConfigurationView> {
  if (!t.workspace && scope !== "global") return Promise.reject(new Error("with no project open, only the user config can be changed"));
  return viaWorker(
    t, (s) => s.request({ type: "clearConfiguration", workspace: t.workspace, configPath: null, scope, key }),
    () => clearConfiguration({ workspace: t.workspace, env: t.env, pid: process.pid }, scope as "global" | "project", key), scope,
  );
}

// ------------------------------------------------------------------ the CLIs
export type Runner = (cmd: string, args: string[], o: { env: NodeJS.ProcessEnv; cwd: string }) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;

export const defaultRunner: Runner = async (cmd, args, o) => {
  const r = await runProcess(cmd, args, { cwd: o.cwd, env: o.env, timeoutMs: PROBE_TIMEOUT_MS, killGraceMs: 500, maxBufferChars: 64 * 1024 });
  return { code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
};

/** An npm-installed CLI is a script run by `node`: it needs a Node of its own on the PATH, apart from the app's. */
export function needsNode(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return [".cmd", ".bat", ".ps1"].includes(extname(path).toLowerCase());
  try {
    const fd = openSync(path, "r");
    const head = Buffer.alloc(128);
    const n = readSync(fd, head, 0, head.length, 0);
    closeSync(fd);
    return /^#!.*\bnode\b/.test(head.subarray(0, n).toString("utf8").split("\n")[0]!);
  } catch {
    return false;
  }
}

const firstLine = (s: string): string => s.trim().split(/\r?\n/)[0]?.trim() ?? "";

/** How `claude auth status` says Claude Code signs in: a claude.ai login (or its long-lived token) is the account. */
export function claudeAuth(status: Record<string, unknown>): CliAuth | null {
  if (typeof status.authMethod !== "string") return null;
  const who = claudeAccount(status);
  return {
    kind: status.authMethod === "claude.ai" || status.authMethod === "oauth_token" ? "account" : "api",
    plan: who.status === "ready" ? who.account : null, email: who.status === "ready" ? who.email : null,
  };
}

/** How `codex login status` says Codex signs in ("Logged in using ChatGPT", "… using an API key - sk-…"); the key never kept. */
export function codexAuth(said: string): CliAuth | null {
  if (/logged in using chatgpt/i.test(said)) return { kind: "account", plan: "ChatGPT", email: null };
  if (/logged in using an? api key/i.test(said)) return { kind: "api", plan: "API key", email: null };
  return null;
}

/** One CLI: where it is, its version, and whether (and how) it is signed in. */
export async function cliStatus(o: {
  backend: Backend; configured: string; source: CliStatus["source"]; env: NodeJS.ProcessEnv; cwd: string; run?: Runner; platform?: NodeJS.Platform;
}): Promise<CliStatus> {
  const run = o.run ?? defaultRunner;
  const platform = o.platform ?? process.platform;
  const base = { backend: o.backend, configured: o.configured, source: o.source, auth: null };
  const path = resolveBinary(o.configured, o.backend, o.env, platform);
  if (!path) {
    return { ...base, path: null, version: null, state: "missing", detail: `${o.configured} was not found on the PATH the app has, nor in the usual install directories.` };
  }
  let detail: string | null = null;
  if (needsNode(path, platform) && !resolveBinary("node", "codex", o.env, platform)) {
    detail = `${path} is run by Node, and no node is on the PATH the app has: install Node or pick the CLI's native binary.`;
  }
  let version: string | null = null;
  try {
    const v = await run(path, ["--version"], { env: o.env, cwd: o.cwd });
    if (v.timedOut) return { ...base, path, version, state: "error", detail: `${o.configured} --version did not answer in time` };
    if (v.code !== 0) return { ...base, path, version, state: "error", detail: firstLine(v.stderr || v.stdout) || `${o.configured} --version exited with ${v.code}` };
    version = firstLine(v.stdout) || null;
  } catch (e) {
    return { ...base, path, version, state: "error", detail: (e as Error).message };
  }
  let state: CliState = "unknown";
  let auth: CliAuth | null = null;
  try {
    if (o.backend === "claude") {
      const a = await run(path, ["auth", "status"], { env: o.env, cwd: o.cwd });
      try {
        const j = JSON.parse(a.stdout) as unknown;
        const loggedIn = typeof j === "object" && j !== null ? (j as { loggedIn?: unknown }).loggedIn : undefined;
        state = loggedIn === true ? "signed-in" : loggedIn === false ? "signed-out" : "unknown";
        if (state === "signed-in") auth = claudeAuth(j as Record<string, unknown>);
      } catch {
        state = a.timedOut ? "unknown" : "installed";
      }
    } else {
      const a = await run(path, ["login", "status"], { env: o.env, cwd: o.cwd });
      const said = `${a.stdout}\n${a.stderr}`;
      state = a.timedOut ? "unknown" : a.code === 0 && /logged in/i.test(said) && !/not logged in/i.test(said) ? "signed-in" : /not logged in|log in|login/i.test(said) ? "signed-out" : a.code === 0 ? "installed" : "unknown";
      if (state === "signed-in") auth = codexAuth(said);
    }
  } catch {
    state = "unknown";
  }
  return { ...base, path, version, state, auth, detail };
}

/** Both CLIs, with the bin each is configured with (a broken config falls back to the default names). */
export async function cliStatuses(o: { view: ConfigurationView | null; env: NodeJS.ProcessEnv; cwd: string; run?: Runner }): Promise<CliStatus[]> {
  const bin = (backend: Backend): { configured: string; source: CliStatus["source"] } => {
    const entry = o.view?.entries.find((e) => e.key === `${backend}.bin`);
    return typeof entry?.effective === "string" && entry.effective ? { configured: entry.effective, source: entry.source } : { configured: backend, source: "default" };
  };
  return Promise.all((["claude", "codex"] as const).map((backend) => cliStatus({ backend, ...bin(backend), env: o.env, cwd: o.cwd, run: o.run })));
}
