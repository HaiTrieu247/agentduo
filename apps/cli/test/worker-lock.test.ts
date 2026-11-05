// The CLI and the extension's (or the desktop's) engine worker share one workspace lock: a worker that holds it keeps
// `duo` from starting a second writer. The worker is built and copied outside the repository, as in the VSIX.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { userConfigEnv } from "@agentduo/engine/testing/config";
import { FakeClis } from "@agentduo/engine/testing/fake-clis";
import { makeRepo } from "@agentduo/engine/testing/repo";
import { tempDir } from "@agentduo/engine/testing/tmp";
import { acquireWorkspaceLock } from "@agentduo/engine/workflow/state";
import { buildWorker, WorkerHarness, writeWorkspaceConfig } from "@agentduo/host/testing/worker";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { main, type CliIO } from "../src/cli.js";

let worker: { script: string; cleanup(): void };
let t: { path: string; cleanup(): void };
let fake: FakeClis;
let repo: string;
let runsDir: string;
const harnesses: WorkerHarness[] = [];

beforeAll(() => {
  worker = buildWorker();
}, 120_000);
afterAll(() => worker.cleanup());
beforeEach(() => {
  t = tempDir();
  repo = makeRepo(t.path);
  runsDir = join(repo, ".agentduo", "runs");
  fake = new FakeClis(t.path).install();
});
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.client.shutdown();
  fake.restore();
  t.cleanup();
});

const C = "conv-test";
const lockFile = () => join(runsDir, ".lock");

async function open() {
  writeWorkspaceConfig(repo, fake);
  const h = new WorkerHarness({ script: worker.script, workspace: repo, env: { ...process.env, ...userConfigEnv(join(t.path, "xdg")) } });
  harnesses.push(h);
  await h.client.start();
  await h.client.request({ type: "initialize", workspace: repo, configPath: null, discover: true });
  return { h };
}

it("holds the lock the CLI checks, so `duo` refuses to start a second writer", async () => {
  const { h } = await open();
  await h.client.request({ type: "submit", conversation: C, text: "/status", route: "message" });
  let err = "";
  const io: CliIO = {
    stdout: { write: () => true }, stderr: { write: (s: string) => { err += s; } }, stdin: {},
    env: { ...process.env, ...userConfigEnv(join(t.path, "xdg")), CI: "" }, cwd: repo,
  };
  expect(await main(["Another task"], io)).toBe(1);
  expect(err).toContain(`another agentduo run is active in this workspace (pid ${h.client.pid})`);
  await h.client.request({ type: "submit", conversation: C, text: "/quit", route: "message" });
  await h.waitFor((m) => m.kind === "ui" && m.update.type === "session" && m.update.session === "ended");
  expect(existsSync(lockFile())).toBe(false);
  acquireWorkspaceLock(runsDir)(); // free for `duo` again
});
