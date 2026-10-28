import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findNode, nodeVersionOk, workerEnv } from "../extensions/vscode/src/workerClient.js";
import { tempDir } from "./helpers/tmp.js";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (dirs.length) dirs.pop()!.cleanup();
});

/** A directory holding a `node` that reports `version`. */
function fakeNode(parent: string, name: string, version: string): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "node");
  writeFileSync(path, `#!/bin/sh\necho ${version}\n`);
  chmodSync(path, 0o755);
  return dir;
}

describe.skipIf(process.platform === "win32")("finding Node for the worker", () => {
  it("takes the first Node >= 22.12 on PATH and says what it found when none is", () => {
    const t = tempDir();
    dirs.push(t);
    const old = fakeNode(t.path, "old", "20.18.0");
    const good = fakeNode(t.path, "good", "22.12.0");
    expect(findNode({ configured: null, env: { PATH: [old, good].join(":") } })).toEqual({ ok: true, path: join(good, "node"), version: "22.12.0" });
    const none = findNode({ configured: null, env: { PATH: old } });
    expect(none).toMatchObject({ ok: false, message: expect.stringContaining(`found only ${join(old, "node")} (20.18.0)`) });
    expect(findNode({ configured: null, env: { PATH: join(t.path, "empty") } })).toMatchObject({ ok: false, message: expect.stringContaining("agentduo.nodePath") });
  });

  it("uses agentduo.nodePath when set, and explains a wrong one", () => {
    const t = tempDir();
    dirs.push(t);
    const good = fakeNode(t.path, "good", "24.1.0");
    const old = fakeNode(t.path, "old", "18.0.0");
    expect(findNode({ configured: join(good, "node"), env: { PATH: "" } })).toMatchObject({ ok: true, version: "24.1.0" });
    expect(findNode({ configured: join(old, "node"), env: { PATH: good } })).toMatchObject({ ok: false, message: expect.stringContaining("is Node 18.0.0") });
    expect(findNode({ configured: "node", env: { PATH: good } })).toMatchObject({ ok: false, message: expect.stringContaining("absolute path") });
    expect(findNode({ configured: process.execPath, env: {} })).toMatchObject({ ok: true, version: process.versions.node });
  });

  it("compares versions and keeps Electron's switches away from the worker and agents", () => {
    expect(["22.12.0", "v22.13.1", "23.0.0", "24.20.0"].every(nodeVersionOk)).toBe(true);
    expect(["22.11.9", "20.18.0", "v18.0.0", ""].some(nodeVersionOk)).toBe(false);
    expect(workerEnv({ PATH: "/bin", ELECTRON_RUN_AS_NODE: "1", NODE_CHANNEL_FD: "3", HOME: "/h" })).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});

describe("extension manifest", () => {
  const ext = fileURLToPath(new URL("../extensions/vscode/", import.meta.url));
  const manifest = JSON.parse(readFileSync(join(ext, "package.json"), "utf8"));
  const root = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));

  it("is a desktop workspace extension that stays off in Restricted Mode and virtual workspaces", () => {
    expect(manifest.engines.vscode).toBe("^1.95.0");
    expect(manifest.extensionKind).toEqual(["workspace"]);
    expect(manifest.browser).toBeUndefined();
    expect(manifest.main).toBe("./dist/extension.cjs");
    expect(manifest.capabilities.untrustedWorkspaces.supported).toBe(false);
    expect(manifest.capabilities.virtualWorkspaces.supported).toBe(false);
    expect(manifest.version).toBe(root.version);
    expect(manifest.contributes.configuration.properties["agentduo.nodePath"].scope).toBe("machine");
    expect(manifest.dependencies).toBeUndefined();
  });

  it("registers every command it declares, and declares every command it registers", () => {
    const declared = manifest.contributes.commands.map((c: { command: string }) => c.command).sort();
    const registered = [...readFileSync(join(ext, "src", "extension.ts"), "utf8").matchAll(/registerCommand\("([^"]+)"/g)].map((m) => m[1]).sort();
    expect(registered).toEqual(declared);
    expect(declared).toEqual(expect.arrayContaining(["agentduo.openChat", "agentduo.stop", "agentduo.resume", "agentduo.newTask", "agentduo.openPlan",
      "agentduo.openChanges", "agentduo.openReport", "agentduo.doctor", "agentduo.openConfiguration"]));
  });

  it("leaves the npm package as it was: no new runtime dependency, the extension not in its files", () => {
    expect(Object.keys(root.dependencies).sort()).toEqual(["ajv", "commander", "ink", "react", "yaml"]);
    expect(root.files).toEqual(["dist", "schemas", "README.md", "docs/README.vi.md", "LICENSE"]);
    expect(root.bin).toEqual({ agentduo: "dist/cli.js", duo: "dist/cli.js" });
  });
});
