// The environment the agents get when the app was opened from the Dock, Finder, the Start menu or a desktop launcher,
// whose PATH is not the terminal's: the app's own PATH, then the login shell's (asked once, with a fixed command and a
// timeout), then the places the CLIs' installers use. The configured binary (claude.bin, codex.bin) still wins over
// all of them. Nothing the user typed goes into the shell command. No Electron import.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { envValue } from "../../../../src/agents/resolve.js";
import type { LauncherInfo } from "../shared/protocol.js";

export const SHELL_TIMEOUT_MS = 5000;
const MARKER = "__AGENTDUO_PATH__=";

export interface ShellAnswer {
  code: number | null;
  stdout: string;
  error: string | null;
}

export type ShellRunner = (shell: string, args: string[], o: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<ShellAnswer>;

/** Runs the shell with no stdin and a timeout; never throws. */
export const runShell: ShellRunner = (shell, args, o) =>
  new Promise((resolve) => {
    execFile(shell, args, { env: o.env, timeout: o.timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, killSignal: "SIGKILL" }, (err, stdout) => {
      const timedOut = !!err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
      resolve({ code: err ? ((err as { code?: unknown }).code as number) ?? null : 0, stdout: String(stdout ?? ""), error: err ? (timedOut ? `did not answer within ${o.timeoutMs / 1000}s` : err.message) : null });
    }).stdin?.end();
  });

/** The fixed command that prints the shell's PATH after its login and interactive startup files ran. */
export function shellCommand(shell: string): string[] {
  const fish = basename(shell) === "fish";
  const print = fish ? `printf '${MARKER}%s\\n' (string join : $PATH)` : `printf '${MARKER}%s\\n' "$PATH"`;
  return ["-l", "-i", "-c", print];
}

/** The PATH the shell printed (the last marker line: startup files may print before it). */
export function parseShellPath(stdout: string): string | null {
  const line = stdout.split(/\r?\n/).reverse().find((l) => l.startsWith(MARKER));
  const value = line?.slice(MARKER.length).trim();
  return value ? value : null;
}

/** Where the CLIs' installers (and Node's version managers) put binaries, that exist on this machine. */
export function commonDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  const dirs: string[] = [];
  if (platform === "win32") {
    const appData = envValue(env, "APPDATA", platform);
    const local = envValue(env, "LOCALAPPDATA", platform);
    const programs = envValue(env, "ProgramFiles", platform);
    if (appData) dirs.push(join(appData, "npm"));
    if (local) dirs.push(join(local, "Microsoft", "WinGet", "Links"), join(local, "Programs", "nodejs"));
    if (programs) dirs.push(join(programs, "nodejs"));
    dirs.push(join(home, ".local", "bin"), join(home, "scoop", "shims"), join(home, ".bun", "bin"), join(home, ".volta", "bin"));
  } else {
    dirs.push(join(home, ".local", "bin"), join(home, "bin"), join(home, ".claude", "local"), join(home, ".npm-global", "bin"), join(home, ".bun", "bin"),
      join(home, ".volta", "bin"), join(home, ".cargo", "bin"), join(home, ".local", "share", "pnpm"));
    if (platform === "darwin") dirs.push("/opt/homebrew/bin", "/opt/homebrew/sbin", join(home, "Library", "pnpm"));
    if (platform === "linux") dirs.push("/home/linuxbrew/.linuxbrew/bin", "/snap/bin");
    dirs.push("/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin");
    // nvm's Node versions, newest first: a CLI installed with npm there runs with that Node.
    const nvm = join(home, ".nvm", "versions", "node");
    try {
      const versions = readdirSync(nvm).filter((v) => /^v\d+/.test(v)).sort((a, b) => cmp(b, a));
      dirs.push(...versions.map((v) => join(nvm, v, "bin")));
    } catch {
      // no nvm
    }
  }
  return dirs.filter((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}

function cmp(a: string, b: string): number {
  const pa = a.slice(1).split(".").map(Number);
  const pb = b.slice(1).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** `env` with one PATH variable (Windows: one Path, whatever case its copies had) set to `entries`. */
export function withPath(env: NodeJS.ProcessEnv, entries: string[], platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!(platform === "win32" ? k.toUpperCase() === "PATH" : k === "PATH")) out[k] = v;
  out[platform === "win32" ? "Path" : "PATH"] = entries.join(platform === "win32" ? ";" : ":");
  if (platform === "win32" && !envValue(out, "PATHEXT", platform)) out.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  return out;
}

export interface LauncherEnvironment {
  env: NodeJS.ProcessEnv;
  info: LauncherInfo;
}

/**
 * The environment for the engine and the agents: `env` with a PATH that also has the login shell's entries (POSIX)
 * and the installers' directories, in that order after the app's own, each once.
 */
export async function launcherEnvironment(o: {
  env: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string; run?: ShellRunner; timeoutMs?: number;
}): Promise<LauncherEnvironment> {
  const platform = o.platform ?? process.platform;
  const home = o.home ?? (envValue(o.env, platform === "win32" ? "USERPROFILE" : "HOME", platform) || homedir());
  const sep = platform === "win32" ? ";" : ":";
  const own = (envValue(o.env, "PATH", platform) ?? "").split(sep).filter(Boolean);
  const sources = ["the app's environment"];
  let shellProblem: string | null = null;
  let shellEntries: string[] = [];
  if (platform !== "win32") {
    const shell = o.env.SHELL && isAbsolute(o.env.SHELL) && existsSync(o.env.SHELL) ? o.env.SHELL : platform === "darwin" ? "/bin/zsh" : "/bin/sh";
    const answer = await (o.run ?? runShell)(shell, shellCommand(shell), { env: o.env, timeoutMs: o.timeoutMs ?? SHELL_TIMEOUT_MS });
    const path = parseShellPath(answer.stdout);
    if (path) {
      shellEntries = path.split(":").filter(Boolean);
      sources.push(`${basename(shell)} login shell`);
    } else shellProblem = `${shell} ${answer.error ?? "printed no PATH"}`;
  }
  const common = commonDirs(platform, o.env, home);
  if (common.length) sources.push("the CLIs' install directories");
  const seen = new Set<string>();
  const entries = [...own, ...shellEntries, ...common].filter((d) => {
    const key = platform === "win32" ? d.toLowerCase() : d;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { env: withPath(o.env, entries, platform), info: { sources, shellProblem, entries: entries.length } };
}
