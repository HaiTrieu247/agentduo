// Where the desktop's engine worker is, and what runs it: Electron's own executable, as Node (ELECTRON_RUN_AS_NODE),
// so the app needs no Node installed. The worker, its package.json (named agentduo) and the schemas live outside
// the ASAR archive (resources/runtime), where packageRoot() finds them as in the npm package and the VSIX.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MIN_NODE, nodeVersionOk, type NodeLookup } from "../../../../extensions/vscode/src/workerClient.js";

export function runtimeDir(o: { packaged: boolean; resourcesPath: string; appPath: string }): string {
  return o.packaged ? join(o.resourcesPath, "runtime") : join(o.appPath, "dist", "runtime");
}

/** The Node inside this Electron runs the worker; never a Node found on the PATH. */
export function bundledNode(o: { execPath: string; node: string }): NodeLookup {
  if (!nodeVersionOk(o.node)) {
    return { ok: false, message: `this build's Electron has Node ${o.node}; AgentDuo's engine needs Node >= ${MIN_NODE.join(".")}. Build with a newer Electron.` };
  }
  return { ok: true, path: o.execPath, version: o.node, launch: "electron" };
}

/** What is missing from the runtime directory (a broken package or an unbuilt checkout); empty when it is whole. */
export function runtimeProblems(dir: string): string[] {
  const problems: string[] = [];
  if (!existsSync(join(dir, "worker.js"))) problems.push(`${join(dir, "worker.js")} is missing`);
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; type?: string };
    if (pkg.name !== "agentduo" || pkg.type !== "module") problems.push(`${join(dir, "package.json")} is not agentduo's runtime package`);
  } catch {
    problems.push(`${join(dir, "package.json")} is missing`);
  }
  try {
    if (!readdirSync(join(dir, "schemas")).some((f) => f.endsWith(".schema.json"))) problems.push(`${join(dir, "schemas")} has no schemas`);
  } catch {
    problems.push(`${join(dir, "schemas")} is missing`);
  }
  return problems;
}
