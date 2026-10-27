import { spawn, type ChildProcess } from "node:child_process";

export interface RunOptions {
  cwd: string;
  input?: string;
  timeoutMs: number;
  onStdoutLine?: (line: string) => void;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  killGraceMs?: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

const isWindows = process.platform === "win32";
const active = new Set<ChildProcess>();

/** Kill every child started by runProcess (used on a second Ctrl-C). */
export function killAllActive(): void {
  for (const child of active) killTree(child, 0);
}

/** SIGTERM the child's process group, then SIGKILL it after graceMs. On Windows: taskkill /T /F. */
export function killTree(child: ChildProcess, graceMs = 5000): void {
  if (child.pid === undefined) return;
  if (isWindows) {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  const pid = child.pid;
  const send = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      // the group is already gone
    }
  };
  if (graceMs <= 0) {
    send("SIGKILL"); // no grace: the caller is about to exit and timers would never fire
    return;
  }
  send("SIGTERM");
  setTimeout(() => send("SIGKILL"), graceMs).unref();
}

function quoteWindows(arg: string): string {
  return /[\s"&|<>^%]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/**
 * Spawn a process in its own process group, feed `input` on stdin, report complete stdout lines as they
 * arrive, and enforce a timeout / abort signal by killing the whole tree.
 */
export function runProcess(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    // Node refuses to spawn .cmd/.bat shims without a shell (CVE-2024-27980).
    const winShim = isWindows && /\.(cmd|bat)$/i.test(cmd);
    const command = winShim ? [cmd, ...args].map(quoteWindows).join(" ") : cmd;
    const child = spawn(command, winShim ? [] : args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: opts.shell || winShim,
      detached: !isWindows,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    active.add(child);
    let stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const emitLine = (raw: string) => {
      const line = raw.replace(/\r$/, "");
      if (line && opts.onStdoutLine) opts.onStdoutLine(line);
    };
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
      if (!opts.onStdoutLine) return;
      pending += chunk;
      let idx: number;
      while ((idx = pending.indexOf("\n")) >= 0) {
        emitLine(pending.slice(0, idx));
        pending = pending.slice(idx + 1);
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin!.on("error", () => {
      // the child exited before reading all of its input
    });
    child.stdin!.end(opts.input ?? "");
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, opts.killGraceMs);
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      killTree(child, opts.killGraceMs);
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      active.delete(child);
    };
    child.on("error", (err) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on("close", (code) => {
      cleanup();
      if (pending) emitLine(pending);
      pending = "";
      if (!settled) {
        settled = true;
        resolvePromise({ code: timedOut || aborted ? null : code, stdout, stderr, timedOut, aborted });
      }
    });
  });
}
