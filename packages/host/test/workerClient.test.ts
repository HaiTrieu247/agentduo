import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@agentduo/engine/testing/tmp";
import { afterEach, describe, expect, it } from "vitest";
import { findNode, nodeVersionOk, workerEnv } from "../src/workerClient.js";

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
