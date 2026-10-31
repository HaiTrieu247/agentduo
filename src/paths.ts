import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let root: string | undefined;

/** Directory of agentduo's own package.json; works from src/ (tests) and dist/ (installed). */
export function packageRoot(): string {
  if (root) return root;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg) && JSON.parse(readFileSync(pkg, "utf8")).name === "agentduo") return (root = dir);
    const parent = dirname(dir);
    if (parent === dir) throw new Error("agentduo package root not found");
    dir = parent;
  }
}

export function packageVersion(): string {
  return JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")).version;
}

/** The user's home folder, the one `~` names. */
export const homeFolder = (env: NodeJS.ProcessEnv): string => env.HOME || homedir();

/** `dir` is the home folder itself: there, nothing says to `git init` (that would put the whole home in a repository). */
export const isHomeFolder = (dir: string, env: NodeJS.ProcessEnv): boolean => resolve(dir) === resolve(homeFolder(env));
