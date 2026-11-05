import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

let root: string | undefined;

/** The packages whose directory holds the schemas: the CLI (apps/cli, also a bundled runtime's) and the engine's sources. */
const SCHEMA_PACKAGES = new Set(["agentduo", "@agentduo/engine"]);

/**
 * Directory of agentduo's own package.json, with the schemas beside it; works from the engine's sources (tests:
 * packages/engine) and from a bundle (the installed CLI's dist/, the extension's and the desktop's runtime/).
 */
export function packageRoot(): string {
  if (root) return root;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg) && SCHEMA_PACKAGES.has(JSON.parse(readFileSync(pkg, "utf8")).name)) return (root = dir);
    const parent = dirname(dir);
    if (parent === dir) throw new Error("agentduo package root not found");
    dir = parent;
  }
}

/**
 * Names agentduo's package for code bundled away from it: the desktop's main process runs from the ASAR archive,
 * whose package.json is agentduo-desktop's, so it gives its runtime directory.
 */
export function setPackageRoot(dir: string): void {
  root = dir;
}

export function packageVersion(): string {
  return JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")).version;
}

/** The user's home folder, the one `~` names. */
export const homeFolder = (env: NodeJS.ProcessEnv): string => env.HOME || homedir();

/** `dir` is the home folder itself, where a pipeline run would snapshot the whole home: a run asks for a project folder. */
export const isHomeFolder = (dir: string, env: NodeJS.ProcessEnv): boolean => resolve(dir) === resolve(homeFolder(env));

/**
 * Where agentduo keeps data of its own, outside every workspace (the snapshot repositories of folders that have no git
 * repository): %LOCALAPPDATA%\agentduo on Windows (else %APPDATA%), $XDG_DATA_HOME/agentduo or ~/.local/share/agentduo
 * elsewhere. Null on Windows with neither variable set: there is no place for it then.
 */
export function dataRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || env.APPDATA;
    return base ? join(base, "agentduo") : null;
  }
  // The XDG spec says to ignore a relative XDG_DATA_HOME.
  const xdg = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : null;
  return join(xdg ?? join(homeFolder(env), ".local", "share"), "agentduo");
}

/**
 * `path` with every symlink resolved, also when it does not exist yet: its nearest existing ancestor is resolved and
 * the rest appended. On Windows (case-insensitive) it is lower-cased, so two forms of one path compare equal.
 */
export function canonicalPath(path: string, platform: NodeJS.Platform = process.platform): string {
  let head = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      head = realpathSync.native(head);
      break;
    } catch {
      const parent = dirname(head);
      if (parent === head) break;
      rest.unshift(basename(head));
      head = parent;
    }
  }
  const full = join(head, ...rest);
  return platform === "win32" ? full.toLowerCase() : full;
}

/** A path `relative` gave leaves its base: `..`, `../…` or another root. `..data` is a child's name, inside. */
export const leavesBase = (rel: string): boolean => rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);

/** `path` is `dir` or inside it, both taken as canonical paths. */
export function isWithin(path: string, dir: string): boolean {
  return !leavesBase(relative(canonicalPath(dir), canonicalPath(path)));
}
