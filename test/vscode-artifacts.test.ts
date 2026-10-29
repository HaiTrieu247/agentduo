// Run documents and diffs for the editor: the worker serves only named artifacts of a run and only files that run
// changed (base snapshot ↔ last snapshot, scoped to the workspace); the host maps them to read-only URIs.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  artifactLocation, ChangeRegistry, changeLabel, diffTitle, parseArtifactLocation, parseSnapshotLocation, snapshotLocation, snapshotPair, snapshotText,
} from "../extensions/vscode/src/artifacts.js";
import type { ChangeList } from "../extensions/vscode/src/protocol.js";
import { approval, critique, finding, impl, plan, review } from "./helpers/builders.js";
import { FakeClis } from "./helpers/fake-clis.js";
import { git, makeRepo } from "./helpers/repo.js";
import { tempDir } from "./helpers/tmp.js";
import { buildWorker, finished, WorkerHarness, writeWorkspaceConfig } from "./helpers/vscode.js";

let worker: { script: string; cleanup(): void };
let t: { path: string; cleanup(): void };
let fake: FakeClis;
const harnesses: WorkerHarness[] = [];

beforeAll(() => {
  worker = buildWorker();
}, 120_000);
afterAll(() => worker.cleanup());
beforeEach(() => {
  t = tempDir();
  fake = new FakeClis(t.path).install();
});
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.client.shutdown();
  fake.restore();
  t.cleanup();
});

const SPACED = "tệp có dấu cách.txt";
const BASE = "a".repeat(40);
const ROUND1 = "b".repeat(40);
const ROUND2 = "c".repeat(40);

async function openWorker(workspace: string, generation = 1): Promise<WorkerHarness> {
  const h = new WorkerHarness({ script: worker.script, workspace, env: { ...process.env, XDG_CONFIG_HOME: join(t.path, "xdg") }, generation });
  harnesses.push(h);
  await h.client.start();
  await h.client.request({ type: "initialize", workspace, configPath: null });
  return h;
}

function scenario(implementer: Record<string, unknown>) {
  return {
    planner: [{ output: plan() }], plan_reviewer: [{ output: critique(true) }], plan_finalizer: [{ output: approval(true) }],
    implementer: [{ ...implementer, output: impl() }], code_reviewer: [{ output: review(true) }],
  };
}

/** The conversation (the extension tab) the runs are started in, and asked about. */
const C = "conv-test";

describe("run artifacts and changes (worker)", () => {
  it("lists and reads exactly what the run changed in a subdirectory workspace with earlier local edits", async () => {
    const repo = makeRepo(t.path);
    const ws = join(repo, "gói pkg");
    mkdirSync(ws);
    writeFileSync(join(ws, SPACED), "before\n");
    writeFileSync(join(ws, "old.txt"), "old\n");
    writeFileSync(join(ws, "dirty.txt"), "committed\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "ws");
    writeFileSync(join(ws, "dirty.txt"), "edited before the run\n"); // not the run's change
    writeWorkspaceConfig(ws, fake, { gates: [] });
    fake.setScenario(scenario({
      write: { "app.txt": "fixed\n", [SPACED]: "after\n", "logo.bin": "PNG\u0000\u0001binary", "../outside.txt": "elsewhere\n" },
      delete: ["old.txt"],
    }));
    const h = await openWorker(ws);
    expect(await h.client.request({ type: "inspectFocusedRun", conversation: C })).toBeNull();
    await expect(h.client.request({ type: "listChanges", conversation: C })).rejects.toMatchObject({ code: "no_run" });
    await h.client.request({ type: "submit", conversation: C, text: "Make app.txt fixed", route: "pipeline" });
    await h.waitFor(finished("DONE"));

    const list = await h.client.request({ type: "listChanges", conversation: C });
    expect(list.hasSnapshots).toBe(true);
    expect(list.changes.map((c) => `${c.status} ${c.path}`).sort()).toEqual(["A app.txt", "A logo.bin", "D old.txt", `M ${SPACED}`]);
    const pair = { base: list.base!, snapshot: list.snapshot! };
    const read = (side: "base" | "snapshot", path: string) => h.client.request({ type: "readSnapshotFile", runId: list.runId, ...pair, side, path });
    expect(await read("base", "app.txt")).toEqual({ missing: true, binary: false, tooLarge: false, text: null });
    expect(await read("snapshot", "app.txt")).toMatchObject({ missing: false, text: "fixed\n" });
    expect(await read("base", "old.txt")).toMatchObject({ text: "old\n" });
    expect(await read("snapshot", "old.txt")).toMatchObject({ missing: true });
    expect([(await read("base", SPACED)).text, (await read("snapshot", SPACED)).text]).toEqual(["before\n", "after\n"]);
    expect(await read("snapshot", "logo.bin")).toMatchObject({ binary: true, text: null });
    await expect(read("snapshot", "dirty.txt")).rejects.toMatchObject({ code: "not_found" });
    await expect(read("snapshot", "README.md")).rejects.toMatchObject({ code: "not_found" });
    await expect(h.client.request({ type: "readSnapshotFile", runId: "no-such-run", ...pair, side: "base", path: "app.txt" })).rejects.toMatchObject({ code: "not_found" });

    const focused = await h.client.request({ type: "inspectFocusedRun", conversation: C });
    expect(focused).toMatchObject({ runId: list.runId, phase: "DONE", hasSnapshots: true });
    expect(focused!.artifacts.sort()).toEqual(["feedback", "plan", "report", "review"]);
    expect((await h.client.request({ type: "readArtifact", conversation: C, artifact: "plan" })).text).toContain("<!-- final plan v1");
    expect((await h.client.request({ type: "readArtifact", conversation: C, artifact: "review" })).text).toMatch(/^# Code review: approved/);
    expect((await h.client.request({ type: "readArtifact", conversation: C, artifact: "feedback" })).text).toContain("critique of plan v1");
    expect((await h.client.request({ type: "readArtifact", conversation: C, artifact: "report" })).text).toContain(list.runId);

    // After a reload: a new worker with no chat session still finds the workspace's latest run, read-only.
    await h.client.shutdown();
    const again = await openWorker(ws, 2);
    expect((await again.client.request({ type: "inspectFocusedRun", conversation: C }))?.runId).toBe(list.runId);
    expect((await again.client.request({ type: "readSnapshotFile", runId: list.runId, ...pair, side: "snapshot", path: "app.txt" })).text).toBe("fixed\n");
  });

  it("reads the snapshots a change list named, not the run's latest, across implementation rounds", async () => {
    const repo = makeRepo(t.path);
    writeWorkspaceConfig(repo, fake, { gates: [], limits: { max_review_rounds: 1 } });
    fake.setScenario({
      ...scenario({}),
      implementer: [{ write: { "app.txt": "round 1\n" }, output: impl() }, { write: { "app.txt": "round 2\n" }, output: impl("completed", ["F1"]) }],
      code_reviewer: [{ output: review(false, [finding("F1")]) }, { output: review(true, [], ["F1"]) }],
    });
    const h = await openWorker(repo);
    await h.client.request({ type: "submit", conversation: C, text: "Make app.txt fixed", route: "pipeline" });
    const asked = await h.waitFor((m) => m.kind === "decision");
    const first = await h.client.request({ type: "listChanges", conversation: C });
    const read = (list: ChangeList, side: "base" | "snapshot", path = "app.txt") =>
      h.client.request({ type: "readSnapshotFile", runId: list.runId, base: list.base!, snapshot: list.snapshot!, side, path });
    expect((await read(first, "snapshot")).text).toBe("round 1\n");
    if (asked.kind === "decision") await h.client.request({ type: "decision", requestId: asked.requestId, answer: { decision: "resume", note: null } });
    await h.waitFor(finished("DONE"));

    const second = await h.client.request({ type: "listChanges", conversation: C });
    expect(second.base).toBe(first.base);
    expect(second.snapshot).not.toBe(first.snapshot);
    expect((await read(second, "snapshot")).text).toBe("round 2\n");
    expect((await read(second, "base")).missing).toBe(true);
    // The earlier list still reads its own snapshot: an open diff of round 1 keeps showing round 1.
    expect((await read(first, "snapshot")).text).toBe("round 1\n");
    const forged = { ...second, snapshot: "0".repeat(40) };
    await expect(read(forged, "snapshot")).rejects.toMatchObject({ code: "not_found" });
    await expect(read({ ...second, base: second.snapshot }, "base")).rejects.toMatchObject({ code: "not_found" });
  });

  it("diffs a run in a repository with no commit yet", async () => {
    const repo = join(t.path, "unborn");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "x\n");
    writeWorkspaceConfig(repo, fake, { gates: [] });
    fake.setScenario(scenario({ write: { "app.txt": "fixed\n", "README.md": "y\n" } }));
    const h = await openWorker(repo);
    await h.client.request({ type: "submit", conversation: C, text: "Make app.txt fixed", route: "pipeline" });
    await h.waitFor(finished("DONE"));
    const list = await h.client.request({ type: "listChanges", conversation: C });
    expect(list.changes.map((c) => `${c.status} ${c.path}`).sort()).toEqual(["A app.txt", "M README.md"]);
    const pair = { base: list.base!, snapshot: list.snapshot! };
    expect((await h.client.request({ type: "readSnapshotFile", runId: list.runId, ...pair, side: "base", path: "README.md" })).text).toBe("x\n");
  });

  it("says a run has nothing to compare before the implementer ran", async () => {
    const repo = makeRepo(t.path);
    writeWorkspaceConfig(repo, fake, { gates: [], limits: { max_planning_rounds: 1 } });
    fake.setScenario({ planner: [{ output: plan() }], plan_reviewer: [{ output: critique(false, [{ id: "C1", severity: "high", description: "no", suggestion: "x" }]) }] });
    const h = await openWorker(repo);
    await h.client.request({ type: "submit", conversation: C, text: "Plan only", route: "pipeline" });
    const asked = await h.waitFor((m) => m.kind === "decision");
    expect(await h.client.request({ type: "listChanges", conversation: C })).toMatchObject({ hasSnapshots: false, base: null, snapshot: null, changes: [] });
    if (asked.kind === "decision") await h.client.request({ type: "decision", requestId: asked.requestId, answer: { decision: "abort", note: null } });
  });
});

describe("artifact and snapshot URIs (host)", () => {
  it("round-trips the names it builds and refuses anything else", () => {
    const run = "20261028-102900-fix-it";
    expect(parseArtifactLocation(artifactLocation(run, "report"))).toEqual({ runId: run, artifact: "report" });
    expect(artifactLocation(run, "plan").path).toBe(`/${run}/plan.md`);
    expect(parseArtifactLocation({ path: "/x", query: "run=../../etc&artifact=plan" })).toBeNull();
    expect(parseArtifactLocation({ path: "/x", query: `run=${run}&artifact=state` })).toBeNull();
    const pair = { runId: run, base: BASE, snapshot: ROUND1 };
    const loc = snapshotLocation(pair, "base", `gói pkg/${SPACED}`);
    expect(loc.path).toBe(`/gói pkg/${SPACED}`);
    expect(parseSnapshotLocation(loc)).toEqual({ ...pair, side: "base", file: `gói pkg/${SPACED}` });
    // A later snapshot is another document: the editor never serves a cached earlier round under the new name.
    expect(snapshotLocation({ ...pair, snapshot: ROUND2 }, "snapshot", "a.txt")).not.toEqual(snapshotLocation(pair, "snapshot", "a.txt"));
    const commits = `base=${BASE}&snapshot=${ROUND1}`;
    for (const bad of [
      { path: "/../secret", query: `run=${run}&${commits}&side=base` }, { path: "/a.txt", query: `run=${run}&${commits}&side=head` },
      { path: "/a.txt", query: `run=&${commits}&side=base` }, { path: "/a.txt", query: `run=${run}&side=base` },
      { path: "/a.txt", query: `run=${run}&base=HEAD&snapshot=${ROUND1}&side=base` }, { path: "/a.txt", query: `run=${run}&base=${BASE}&snapshot=main~1&side=snapshot` },
    ]) {
      expect(parseSnapshotLocation(bad)).toBeNull();
    }
  });

  it("opens diffs only for files of a change list the user was shown, at the snapshots it named", () => {
    const registry = new ChangeRegistry();
    const r1 = { runId: "r1", base: BASE, snapshot: ROUND1 };
    expect(registry.has(r1, "a.txt")).toBe(false);
    registry.remember({ ...r1, hasSnapshots: true, changes: [{ status: "M", path: "a.txt" }] });
    registry.remember({ runId: "r1", hasSnapshots: false, base: null, snapshot: null, changes: [] });
    expect([registry.has(r1, "a.txt"), registry.has(r1, "b.txt"), registry.has({ ...r1, runId: "r2" }, "a.txt")]).toEqual([true, false, false]);
    expect(registry.has({ ...r1, snapshot: ROUND2 }, "a.txt")).toBe(false);
    registry.remember({ ...r1, snapshot: ROUND2, hasSnapshots: true, changes: [{ status: "M", path: "b.txt" }] });
    expect([registry.has(r1, "a.txt"), registry.has({ ...r1, snapshot: ROUND2 }, "b.txt")]).toEqual([true, true]);
    expect(snapshotPair({ ...r1, hasSnapshots: true, changes: [] })).toEqual(r1);
    expect(snapshotPair({ runId: "r1", hasSnapshots: false, base: null, snapshot: null, changes: [] })).toBeNull();
  });

  it("labels changes and shows what has no text", () => {
    expect(["A", "M", "D", "T", "X"].map(changeLabel)).toEqual(["added", "modified", "deleted", "type changed", "X"]);
    expect(diffTitle({ runId: "r1", base: BASE, snapshot: ROUND1 }, { status: "A", path: "src/a b.ts" }))
      .toBe(`a b.ts (added) · before ↔ after run r1 (snapshot ${ROUND1.slice(0, 7)})`);
    expect(snapshotText({ missing: true, binary: false, tooLarge: false, text: null })).toBe("");
    expect(snapshotText({ missing: false, binary: true, tooLarge: false, text: null })).toContain("binary");
    expect(snapshotText({ missing: false, binary: false, tooLarge: true, text: null })).toContain("too large");
    expect(snapshotText({ missing: false, binary: false, tooLarge: false, text: "x\n" })).toBe("x\n");
  });
});
