import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join } from "node:path";

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (platform === "win32") return existsSync(path);
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function versionKey(name: string): number[] {
  const m = /claude-code-(\d+(?:\.\d+)*)/.exec(name);
  return m ? m[1]!.split(".").map(Number) : [];
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * A variable as Windows reads it: names are case-insensitive there, and a copied environment may say Path, not PATH
 * (an app opened from the Start menu, an environment built by a host). Elsewhere names are exact.
 */
export function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== "win32") return env[name];
  if (env[name] !== undefined) return env[name];
  return Object.entries(env).find(([k]) => k.toUpperCase() === name.toUpperCase())?.[1];
}

export function resolveBinary(configured: string, backend: "codex" | "claude",
  env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const home = env.HOME || env.USERPROFILE || homedir();
  const expanded = configured.startsWith("~") ? join(home, configured.slice(1)) : configured;
  if (expanded.includes("/") || expanded.includes("\\") || isAbsolute(expanded)) {
    return isExecutable(expanded, platform) ? expanded : null;
  }
  const pathext = (envValue(env, "PATHEXT", platform) || ".EXE;.CMD;.BAT").split(";").filter(Boolean).map((e) => e.toLowerCase());
  // A name that has its extension already (claude.exe) is taken as given; never a bare `codex` beside codex.cmd (npm's
  // shell script for Git Bash, which Windows cannot start).
  const exts = platform !== "win32" ? [""] : pathext.includes(extname(expanded).toLowerCase()) ? [""] : pathext;
  for (const dir of (envValue(env, "PATH", platform) || "").split(platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, expanded + ext);
      if (isExecutable(candidate, platform)) return candidate;
    }
  }
  if (backend !== "claude" || configured !== "claude") return null;
  // Claude Code installed only through an IDE extension is not on PATH.
  const exe = platform === "win32" ? "claude.exe" : "claude";
  const candidates = [join(home, ".claude", "local", exe)];
  for (const editor of [".vscode", ".vscode-insiders", ".cursor", ".windsurf"]) {
    const extDir = join(home, editor, "extensions");
    let names: string[];
    try {
      names = readdirSync(extDir).filter((n) => n.startsWith("anthropic.claude-code-"));
    } catch {
      continue;
    }
    names.sort((a, b) => compareVersions(versionKey(a), versionKey(b)));
    candidates.push(...names.map((n) => join(extDir, n, "resources", "native-binary", exe)));
  }
  return candidates.filter((c) => isExecutable(c, platform)).at(-1) ?? null;
}
