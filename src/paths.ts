import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
