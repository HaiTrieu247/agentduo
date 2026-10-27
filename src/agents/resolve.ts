import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

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

export function resolveBinary(configured: string, backend: "codex" | "claude",
  env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const home = env.HOME || env.USERPROFILE || homedir();
  const expanded = configured.startsWith("~") ? join(home, configured.slice(1)) : configured;
  if (expanded.includes("/") || expanded.includes("\\") || isAbsolute(expanded)) {
    return isExecutable(expanded, platform) ? expanded : null;
  }
  const exts = platform === "win32" ? (env.PATHEXT || ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase()) : [""];
  for (const dir of (env.PATH || "").split(platform === "win32" ? ";" : ":")) {
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
