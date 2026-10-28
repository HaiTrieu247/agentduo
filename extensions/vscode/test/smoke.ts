// Runs inside an Extension Development Host, started by scripts/test-vscode.mjs on a scratch git repository with fake
// CLIs: activation, command registration, the chat view and the worker it starts, the two content providers, and a
// two-round run whose diff follows the run to its newer snapshot.
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { approval, critique, finding, impl, plan, review } from "../../../test/helpers/builders.js";
import { ARTIFACT_SCHEME, artifactLocation, SNAPSHOT_SCHEME, snapshotLocation } from "../src/artifacts.js";
import type { TestApi } from "../src/extension.js";

const ID = "agentduo-dev.agentduo-vscode";

async function until<T>(what: string, get: () => T | null | undefined | false, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = get();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const read = async (uri: vscode.Uri) => (await vscode.workspace.openTextDocument(uri)).getText();

const checks: Array<[string, (api: TestApi, ext: vscode.Extension<TestApi>) => Promise<void>]> = [
  ["activates without starting a worker", async (api) => {
    assert.equal(api.workerPid(), undefined);
    assert.equal(api.state(), null);
  }],
  ["registers every command in its manifest", async (_api, ext) => {
    const contributed = (ext.packageJSON.contributes.commands as Array<{ command: string }>).map((c) => c.command);
    const registered = new Set(await vscode.commands.getCommands(true));
    assert.deepEqual(contributed.filter((c) => !registered.has(c)), []);
  }],
  ["opens the chat view, whose worker initializes the folder without creating a run", async (api) => {
    const folder = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    await vscode.commands.executeCommand("agentduo.openChat");
    const state = await until("the session to start", () => {
      const s = api.state();
      return s && s.session !== "starting" ? s : null;
    });
    assert.equal(state.problem, null, `the session reports a problem: ${state.problem?.message}`);
    assert.equal(state.workspace, folder);
    assert.equal(state.status, "idle");
    assert.equal(state.run, null);
    assert.ok(api.workerPid(), "the worker runs");
    const runs = join(folder, ".agentduo", "runs");
    assert.deepEqual(existsSync(runs) ? readdirSync(runs).filter((f) => !f.startsWith(".")) : [], []);
  }],
  ["serves artifacts and snapshots only for what agentduo itself opened", async () => {
    const artifact = await read(vscode.Uri.from({ scheme: ARTIFACT_SCHEME, ...artifactLocation("20260101-000000-none", "plan") }));
    assert.match(artifact, /^\(.+\)\n$/);
    const pair = { runId: "20260101-000000-none", base: "0".repeat(40), snapshot: "1".repeat(40) };
    const snapshot = await read(vscode.Uri.from({ scheme: SNAPSHOT_SCHEME, ...snapshotLocation(pair, "base", "README.md") }));
    assert.match(snapshot, /no longer available/);
  }],
  ["answers Open Plan and Open Changes with no run yet, without throwing", async () => {
    await vscode.commands.executeCommand("agentduo.openPlan");
    await vscode.commands.executeCommand("agentduo.openChanges");
  }],
  ["opens a diff, and after the run's next round shows that round's snapshot, not the editor's cached document", async (api) => {
    writeFileSync(process.env.FAKE_SCENARIO!, JSON.stringify({
      planner: [{ output: plan() }], plan_reviewer: [{ output: critique(true) }], plan_finalizer: [{ output: approval(true) }],
      implementer: [{ write: { "app.txt": "round 1\n" }, output: impl() }, { write: { "app.txt": "round 2\n" }, output: impl("completed", ["F1"]) }],
      code_reviewer: [{ output: review(false, [finding("F1")]) }, { output: review(true, [], ["F1"]) }],
    }));
    await api.submit("Make app.txt fixed");
    await until("the decision after round 1", () => api.state()?.decision, 60_000);
    const first = await api.openDiff("app.txt");
    assert.equal(await read(first.base), "");
    assert.equal(await read(first.snapshot), "round 1\n");

    await api.decide("resume");
    await until("DONE after round 2", () => api.state()?.timeline.some((i) => i.kind === "finish" && i.phase === "DONE"), 60_000);
    const second = await api.openDiff("app.txt");
    assert.notEqual(second.snapshot.toString(), first.snapshot.toString());
    assert.equal(await read(second.snapshot), "round 2\n");
    assert.equal(await read(first.snapshot), "round 1\n", "an open diff of round 1 keeps showing round 1");
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(tab instanceof vscode.TabInputTextDiff, "a diff editor is active");
    assert.equal(tab.modified.toString(), second.snapshot.toString());
    const shown = vscode.workspace.textDocuments.find((d) => d.uri.toString() === tab.modified.toString());
    assert.equal(shown?.getText(), "round 2\n");
  }],
];

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<TestApi>(ID);
  assert.ok(ext, `${ID} is not loaded in the test host`);
  const api = await ext.activate();
  assert.ok(api, "the extension returns its test API in test mode");
  const failures: string[] = [];
  for (const [name, check] of checks) {
    try {
      await check(api, ext);
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failures.push(name);
      console.log(`  ✗ ${name}\n    ${(e as Error).stack ?? e}`);
    }
  }
  if (failures.length) throw new Error(`${failures.length} of ${checks.length} smoke checks failed`);
  console.log(`extension host smoke OK: ${checks.length} checks`);
}
