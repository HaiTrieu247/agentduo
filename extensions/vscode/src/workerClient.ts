// The extension host's side of the engine worker: finding a Node that can run it, forking it, and talking to it.
// No `vscode` import here, so it can be tested with a real worker outside VS Code.
import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import {
  parseWorkerMessage, PROTOCOL_VERSION, type RequestEnvelope, type WorkerErrorCode, type WorkerMessage, type WorkerRequest, type WorkerResults,
} from "./protocol.js";

export const MIN_NODE = [22, 12] as const;
/** How long a shutdown may take before the worker is killed (the worker kills its agents well before that). */
export const SHUTDOWN_GRACE_MS = 4000;
/** After the kill at the end of the grace, how long a shutdown still waits for the exit. */
const KILL_WAIT_MS = 1000;
const HELLO_TIMEOUT_MS = 20_000;

export function nodeVersionOk(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

/** The environment agents and gates get: the extension host's own, without what would turn Electron binaries into Node. */
export function workerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.ELECTRON_RUN_AS_NODE;
  delete out.NODE_CHANNEL_FD;
  delete out.NODE_CHANNEL_SERIALIZATION_MODE;
  return out;
}

/**
 * How the worker is started. node: `path` is a Node (VS Code's extension, which never uses its own Electron). electron:
 * `path` is an Electron binary run as Node (ELECTRON_RUN_AS_NODE=1), the desktop app's own executable, so the
 * desktop needs no Node of its own; the worker removes that variable before anything it starts sees it.
 */
export type WorkerLaunch = "node" | "electron";

export type NodeLookup = { ok: true; path: string; version: string; launch?: WorkerLaunch } | { ok: false; message: string };

function executable(path: string): boolean {
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function probeVersion(path: string, env: NodeJS.ProcessEnv): string | null {
  const r = spawnSync(path, ["-p", "process.versions.node"], { encoding: "utf8", timeout: 15_000, env: workerEnv(env), windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * A Node >= 22.12 to run the worker: `agentduo.nodePath` when set, else the first good one on PATH. Never VS Code's
 * own process.execPath, which is Electron (and usually an older Node).
 */
export function findNode(o: { configured: string | null; env: NodeJS.ProcessEnv; platform?: NodeJS.Platform }): NodeLookup {
  const platform = o.platform ?? process.platform;
  const want = `${MIN_NODE[0]}.${MIN_NODE[1]}`;
  const home = o.env.HOME || o.env.USERPROFILE || homedir();
  if (o.configured) {
    const path = o.configured.startsWith("~") ? join(home, o.configured.slice(1)) : o.configured;
    if (!isAbsolute(path) || !executable(path)) return { ok: false, message: `agentduo.nodePath '${o.configured}' is not an executable file (give an absolute path)` };
    const version = probeVersion(path, o.env);
    if (!version) return { ok: false, message: `agentduo.nodePath '${path}' did not run as Node` };
    if (!nodeVersionOk(version)) return { ok: false, message: `agentduo.nodePath '${path}' is Node ${version}; agentduo needs Node >= ${want}` };
    return { ok: true, path, version };
  }
  const names = platform === "win32" ? ["node.exe"] : ["node"];
  const seen: string[] = [];
  for (const dir of (o.env.PATH ?? o.env.Path ?? "").split(platform === "win32" ? ";" : delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const path = join(dir, name);
      if (!executable(path)) continue;
      const version = probeVersion(path, o.env);
      if (!version) continue;
      if (nodeVersionOk(version)) return { ok: true, path, version };
      seen.push(`${path} (${version})`);
    }
  }
  return {
    ok: false,
    message: seen.length
      ? `agentduo needs Node >= ${want}; found only ${seen.join(", ")}. Install a newer Node or set agentduo.nodePath.`
      : `agentduo needs Node >= ${want}, and none was found on the PATH VS Code sees. Install Node or set agentduo.nodePath.`,
  };
}

export class WorkerError extends Error {
  constructor(readonly code: WorkerErrorCode | "exited" | "timeout", message: string) {
    super(message);
  }
}

export interface Hello {
  pid: number;
  node: string;
  version: string;
}

type Pending = { resolve(value: unknown): void; reject(e: Error): void; timer?: NodeJS.Timeout };
type Pushed = Exclude<WorkerMessage, { kind: "hello" } | { kind: "response" }>;

/** One worker process for one workspace session; `generation` tells its messages apart from an earlier worker's. */
export class WorkerClient {
  private child: ChildProcess | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly listeners = new Set<(message: Pushed) => void>();
  private readonly exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  private exited: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly o: {
    node: string; script: string; cwd: string; env: NodeJS.ProcessEnv; generation: number; log(line: string): void; launch?: WorkerLaunch;
  }) {}

  get generation(): number {
    return this.o.generation;
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): Promise<Hello> {
    if (this.child) throw new Error("worker already started");
    const env = workerEnv(this.o.env);
    if (this.o.launch === "electron") env.ELECTRON_RUN_AS_NODE = "1";
    const child = fork(this.o.script, [], {
      execPath: this.o.node, execArgv: [], cwd: this.o.cwd, env, stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "json", windowsHide: true,
    });
    this.child = child;
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding("utf8");
      let buffered = "";
      stream?.on("data", (chunk: string) => {
        buffered += chunk;
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) if (line) this.o.log(line);
      });
    }
    this.exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        for (const p of this.pending.values()) {
          if (p.timer) clearTimeout(p.timer);
          p.reject(new WorkerError("exited", `the agentduo worker exited (${signal ?? `code ${code}`})`));
        }
        this.pending.clear();
        for (const listener of this.exitListeners) listener(code, signal);
        resolve();
      });
    });
    return new Promise<Hello>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new WorkerError("timeout", "the agentduo worker did not start"));
        this.kill();
      }, HELLO_TIMEOUT_MS);
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(new WorkerError("exited", `cannot start the agentduo worker: ${e.message}`));
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new WorkerError("exited", `the agentduo worker exited before it started (${signal ?? `code ${code}`})`));
      });
      child.on("message", (raw) => {
        let message: WorkerMessage;
        try {
          message = parseWorkerMessage(raw);
        } catch (e) {
          this.o.log(`ignored a worker message: ${(e as Error).message}`);
          return;
        }
        if (message.kind === "hello") {
          clearTimeout(timer);
          resolve({ pid: message.pid, node: message.node, version: message.version });
          return;
        }
        if (message.generation !== this.o.generation) return;
        if (message.kind === "response") {
          const p = this.pending.get(message.id);
          if (!p) return;
          this.pending.delete(message.id);
          if (p.timer) clearTimeout(p.timer);
          if (message.ok) p.resolve(message.result);
          else p.reject(new WorkerError(message.error.code, message.error.message));
          return;
        }
        for (const listener of this.listeners) listener(message);
      });
    });
  }

  onMessage(listener: (message: Pushed) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  request<T extends WorkerRequest["type"]>(request: Extract<WorkerRequest, { type: T }>, timeoutMs = 0): Promise<WorkerResults[T]> {
    const child = this.child;
    if (!child || !this.running || !child.connected) return Promise.reject(new WorkerError("exited", "the agentduo worker is not running"));
    if (this.stopping && request.type !== "shutdown") return Promise.reject(new WorkerError("shutting_down", "agentduo is shutting down"));
    const id = this.nextId++;
    const envelope: RequestEnvelope = { protocol: PROTOCOL_VERSION, generation: this.o.generation, id, request };
    return new Promise((resolve, reject) => {
      const entry: Pending = { resolve: resolve as (v: unknown) => void, reject };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new WorkerError("timeout", `the agentduo worker did not answer ${request.type}`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      child.send(envelope, (e) => {
        if (!e) return;
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(new WorkerError("exited", `cannot reach the agentduo worker: ${e.message}`));
      });
    });
  }

  /**
   * Asks the worker to stop (it defers decisions, denies prompts, stops the run and frees the lock), and kills it
   * when it has not exited within `graceMs`.
   */
  async shutdown(graceMs = SHUTDOWN_GRACE_MS): Promise<void> {
    if (!this.child || !this.exited) return;
    this.stopping = true;
    if (!this.running) return;
    // A worker that has not said hello, or is still initializing, gets the same request and the same grace.
    this.request({ type: "shutdown" }).catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const killed = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.kill();
        // Never wait on an exit that does not come (a fork that failed to spawn has none).
        timer = setTimeout(resolve, KILL_WAIT_MS);
      }, graceMs);
    });
    await Promise.race([this.exited, killed]);
    clearTimeout(timer);
  }

  kill(): void {
    if (this.running) this.child?.kill("SIGKILL");
  }

  /** Drops the IPC channel, as a crashed extension host would; the worker then shuts down on its own. */
  disconnect(): void {
    if (this.child?.connected) this.child.disconnect();
  }

  /** Resolves once the worker process has exited. */
  whenExited(): Promise<void> {
    return this.exited ?? Promise.resolve();
  }
}
