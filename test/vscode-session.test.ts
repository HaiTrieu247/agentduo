// The extension host's per-folder session, against the real worker: presentation state, snapshots for a view that
// comes and goes, questions that survive it, and a worker that dies.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type HostMessage } from "../extensions/vscode/src/protocol.js";
import { SHUTDOWN_GRACE_MS } from "../extensions/vscode/src/workerClient.js";
import { emptyState, pickWorkspace, WorkspaceSession } from "../extensions/vscode/src/workspaceSession.js";
import { reduce, type ViewState } from "../extensions/vscode/webview/state.js";
import { RunStore } from "../src/core/state.js";
import { approval, critique, finding, impl, plan, review } from "./helpers/builders.js";
import type { ConfigOverrides } from "./helpers/config.js";
import { FakeClis } from "./helpers/fake-clis.js";
import { makeRepo } from "./helpers/repo.js";
import { tempDir } from "./helpers/tmp.js";
import { buildWorker, pidAlive, waitUntil, writeWorkspaceConfig } from "./helpers/vscode.js";

let worker: { script: string; cleanup(): void };
let t: { path: string; cleanup(): void };
let fake: FakeClis;
let repo: string;
let generation = 0;
const sessions: WorkspaceSession[] = [];

beforeAll(() => {
  worker = buildWorker();
}, 120_000);
afterAll(() => worker.cleanup());
beforeEach(() => {
  t = tempDir();
  repo = makeRepo(t.path);
  fake = new FakeClis(t.path).install();
});
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.dispose();
  fake.restore();
  t.cleanup();
});

const happy = () => ({
  planner: [{ output: plan() }],
  plan_reviewer: [{ output: critique(true) }],
  plan_finalizer: [{ output: approval(true) }],
  implementer: [{ write: { "app.txt": "fixed\n" }, output: impl() }],
  code_reviewer: [{ output: review(true) }],
});

function session(o: { overrides?: ConfigOverrides; node?: boolean; script?: string; env?: NodeJS.ProcessEnv } = {}): WorkspaceSession {
  writeWorkspaceConfig(repo, fake, o.overrides);
  const s = new WorkspaceSession({
    workspace: repo, configPath: null, workerScript: o.script ?? worker.script, env: { ...process.env, XDG_CONFIG_HOME: join(t.path, "xdg"), ...o.env },
    resolveNode: () => (o.node === false ? { ok: false, message: "agentduo needs Node >= 22.12; found only /usr/bin/node (18.0.0)" } : { ok: true, path: process.execPath, version: process.versions.node }),
    nextGeneration: () => ++generation, log: () => undefined,
  });
  sessions.push(s);
  return s;
}

/** A webview: applies the snapshot and then the action batches, as webview/main.ts does. */
class FakeView {
  state: ViewState | null = null;
  readonly post = (m: HostMessage) => {
    if (m.type === "snapshot") this.state = m.state;
    else if (m.type === "actions" && this.state) for (const a of m.actions) this.state = reduce(this.state, a);
  };
}

const until = (s: WorkspaceSession, check: (st: ViewState) => boolean, what: string, ms = 25_000) => waitUntil(() => check(s.state), ms, what);
const finishes = (st: ViewState) => st.timeline.flatMap((i) => (i.kind === "finish" ? [i.phase] : []));

describe("WorkspaceSession", () => {
  it("opens without a lock or a run, then shows a whole run: steps, gates, usage, DONE", async () => {
    const s = session();
    const view = new FakeView();
    s.attach(view.post);
    await s.start();
    expect(s.state.session).toBe("dormant");
    expect(s.state.pipeline.map((p) => p.phase)).toContain("VERIFY");
    expect(existsSync(join(repo, ".agentduo", "runs"))).toBe(false);
    fake.setScenario(happy());
    await s.submit("Make app.txt fixed");
    await until(s, (st) => finishes(st).includes("DONE") && st.status === "idle", "DONE");
    const st = s.state;
    expect(st.session).toBe("active");
    expect(st.timeline.map((i) => i.kind)).toEqual(expect.arrayContaining(["user", "run", "step", "finish"]));
    const steps = st.timeline.flatMap((i) => (i.kind === "step" ? [i.step] : []));
    expect(steps.map((x) => x.phase)).toEqual(["PLAN", "PLAN_REVIEW", "PLAN_FINALIZE", "IMPLEMENT", "VERIFY", "CODE_REVIEW"]);
    expect(steps.find((x) => x.phase === "VERIFY")!.activities).toEqual([expect.objectContaining({ id: "gate-check", status: "ok" })]);
    expect(st.totals.tokens).toBeGreaterThan(0);
    expect(st.totals.costUsd).toBeGreaterThan(0);
    // The last actions may still be in a batch on its way: wait for all of them, not just the timeline.
    await waitUntil(() => isDeepStrictEqual(view.state, st), 2000, "the view to catch up").catch(() => undefined);
    expect(view.state).toEqual(st);
  });

  it("keeps a decision across hiding and reopening the view, and refuses a stale answer", async () => {
    const s = session({ overrides: { limits: { max_review_rounds: 1 } } });
    fake.setScenario({ ...happy(), code_reviewer: [{ output: review(false, [finding("F1")]) }] });
    s.attach(new FakeView().post);
    await s.submit("Make app.txt fixed");
    await until(s, (st) => !!st.decision, "the decision");
    s.detach();
    const reopened = new FakeView();
    s.attach(reopened.post);
    expect(reopened.state?.decision?.review.reason).toBe("max_review_rounds");
    const { id } = s.state.decision!;
    await s.answerDecision(s.state.generation - 1, id, "abort", null);
    expect(s.state.decision?.id).toBe(id);
    expect(s.state.timeline.at(-1)).toMatchObject({ kind: "info", tone: "error", text: expect.stringContaining("no longer pending") });
    await s.answerDecision(s.state.generation, id, "revise", "smaller steps");
    await until(s, (st) => fake.calls("planner").length === 2, "the re-plan");
    expect(fake.calls("planner")[1]!.prompt).toContain("smaller steps");
  });

  it("keeps a permission prompt across hiding the view, and answers it", async () => {
    const s = session();
    fake.setScenario({ ...happy(), implementer: [{ write: { "app.txt": "fixed\n" }, permissions: [{ tool: "Bash", input: { command: "npm test" }, rules: [] }], output: impl() }] });
    await s.submit("Make app.txt fixed");
    await until(s, (st) => st.permissions.length === 1, "the prompt");
    const view = new FakeView();
    s.attach(view.post);
    expect(view.state?.permissions[0]?.request.label).toBe("Bash  npm test");
    await s.answerPermission(s.state.generation, s.state.permissions[0]!.request.id, { decision: "once" });
    await until(s, (st) => finishes(st).includes("DONE"), "DONE");
    expect(s.state.timeline.some((i) => i.kind === "permission" && i.answer.decision === "once")).toBe(true);
  });

  it("survives a dead worker: says so, forgets its questions, and starts a new one that resumes the run", async () => {
    const s = session();
    fake.setScenario({ ...happy(), implementer: [{ permissions: [{ tool: "Bash", input: { command: "npm test" }, rules: [] }], output: impl() }, { write: { "app.txt": "fixed\n" }, output: impl() }] });
    await s.submit("Make app.txt fixed");
    await until(s, (st) => st.permissions.length === 1, "the prompt");
    const first = s.state.generation;
    process.kill(s.workerPid!, "SIGKILL");
    await until(s, (st) => st.session === "stopped", "stopped");
    expect(s.state.permissions).toEqual([]);
    expect(s.state.timeline.at(-1)).toMatchObject({ tone: "error", text: expect.stringContaining("worker stopped") });
    await s.submit("/resume");
    await until(s, (st) => finishes(st).includes("DONE"), "DONE after resume", 30_000);
    expect(s.state.generation).toBeGreaterThan(first);
    expect(RunStore.open(join(repo, ".agentduo", "runs")).loadState().phase).toBe("DONE");
  });

  it("sends nothing but initialize until the worker has answered it, so a slow start loses no state", async () => {
    // The real worker, whose answer to initialize is held back; it logs each request it gets and when that answer leaves.
    const log = join(t.path, "worker-requests.log");
    const script = join(t.path, "slow-initialize.mjs");
    writeFileSync(script, [
      `import { appendFileSync } from "node:fs";`,
      `const send = process.send.bind(process);`,
      `let initialize = null;`,
      `process.send = (message, ...rest) => {`,
      `  if (message?.kind !== "response" || message.id !== initialize) return send(message, ...rest);`,
      `  setTimeout(() => { appendFileSync(${JSON.stringify(log)}, "(initialized)\\n"); send(message, ...rest); }, 600);`,
      `  return true;`,
      `};`,
      `process.on("message", (m) => {`,
      `  if (m?.request?.type === "initialize") initialize = m.id;`,
      `  appendFileSync(${JSON.stringify(log)}, m?.request?.type + "\\n");`,
      `});`,
      `await import(${JSON.stringify(pathToFileURL(worker.script).href)});`,
    ].join("\n"));
    const s = session({ script });
    fake.setScenario(happy());
    const started = s.start();
    await waitUntil(() => s.workerPid !== undefined, 10_000, "the worker's hello");
    await Promise.all([s.submit("Make app.txt fixed"), s.toggleEdits(), started]);
    await until(s, (st) => finishes(st).includes("DONE") && st.status === "idle", "DONE");
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["initialize", "(initialized)", "submit", "toggleEdits"]);
    expect(s.state.session).toBe("active");
    expect(s.state.edits).toBe("auto");
    expect(s.state.timeline.filter((i) => i.kind === "info" && i.tone === "error")).toEqual([]);
  });

  it("shows how to fix a missing Node instead of starting the worker", async () => {
    const s = session({ node: false });
    await s.submit("Fix it");
    expect(s.state.problem).toMatchObject({ kind: "node", message: expect.stringContaining("Node >= 22.12") });
    expect(s.state.session).toBe("stopped");
    expect(s.workerPid).toBeUndefined();
  });

  describe("a start that hangs", () => {
    /** The real worker, which never answers the first worker's initialize (later workers answer); it logs what it gets. */
    function withholdingInitialize(): { script: string; requests(): string[] } {
      const log = join(t.path, "worker-requests.log");
      const flag = join(t.path, "withheld-once");
      const script = join(t.path, "withhold-initialize.mjs");
      writeFileSync(script, [
        `import { appendFileSync, existsSync, writeFileSync } from "node:fs";`,
        `const hold = !existsSync(${JSON.stringify(flag)});`,
        `if (hold) writeFileSync(${JSON.stringify(flag)}, "");`,
        `const send = process.send.bind(process);`,
        `let initialize = null;`,
        `process.send = (message, ...rest) => (hold && message?.kind === "response" && message.id === initialize ? true : send(message, ...rest));`,
        `process.on("message", (m) => {`,
        `  if (m?.request?.type === "initialize") initialize = m.id;`,
        `  appendFileSync(${JSON.stringify(log)}, process.pid + " " + m?.request?.type + "\\n");`,
        `});`,
        `await import(${JSON.stringify(pathToFileURL(worker.script).href)});`,
      ].join("\n"));
      return { script, requests: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
    }

    /** A worker that answers nothing at all, with or without saying hello first; it writes its pid down. */
    function unresponsive(hello: boolean): { script: string; pid(): number | null } {
      const pidFile = join(t.path, "unresponsive.pid");
      const script = join(t.path, "unresponsive.mjs");
      writeFileSync(script, [
        `import { writeFileSync } from "node:fs";`,
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        `process.on("message", () => undefined);`,
        `setInterval(() => undefined, 1000);`,
        hello ? `process.send({ kind: "hello", protocol: ${PROTOCOL_VERSION}, pid: process.pid, node: process.versions.node, version: "0.0.0" });` : ``,
      ].join("\n"));
      return { script, pid: () => (existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null) };
    }

    it("is stopped at once by dispose while initialize goes unanswered", async () => {
      const worker = withholdingInitialize();
      const s = session({ script: worker.script });
      const started = s.start();
      await waitUntil(() => worker.requests().some((r) => r.endsWith(" initialize")), 10_000, "initialize to reach the worker");
      const pid = s.workerPid!;
      const t0 = Date.now();
      await s.dispose();
      // The worker got the shutdown and left by itself, long before it would have been killed.
      expect(Date.now() - t0).toBeLessThan(SHUTDOWN_GRACE_MS - 1000);
      expect(worker.requests()).toEqual([`${pid} initialize`, `${pid} shutdown`]);
      expect(pidAlive(pid)).toBe(false);
      await expect(started).resolves.toBeNull();
      sessions.splice(sessions.indexOf(s), 1);
    });

    it("is replaced by restart while initialize goes unanswered, and the new worker takes the requests", async () => {
      const worker = withholdingInitialize();
      const s = session({ script: worker.script });
      fake.setScenario(happy());
      const started = s.start();
      await waitUntil(() => worker.requests().some((r) => r.endsWith(" initialize")), 10_000, "initialize to reach the worker");
      const first = s.workerPid!;
      // Waits for the start that hangs.
      const submitted = s.submit("Make app.txt fixed");
      const t0 = Date.now();
      await s.restart();
      expect(Date.now() - t0).toBeLessThan(SHUTDOWN_GRACE_MS);
      expect(pidAlive(first)).toBe(false);
      const second = s.workerPid!;
      expect(second).not.toBe(first);
      // Whoever waited on the start that was given up gets the new worker.
      await expect(started).resolves.not.toBeNull();
      await submitted;
      await until(s, (st) => finishes(st).includes("DONE") && st.status === "idle", "DONE");
      expect(worker.requests()).toEqual([`${first} initialize`, `${first} shutdown`, `${second} initialize`, `${second} submit`]);
      expect(s.state.session).toBe("active");
      expect(s.state.problem).toBeNull();
      expect(s.state.timeline.filter((i) => i.kind === "info" && i.tone === "error")).toEqual([]);
    });

    it("starts one worker when a second restart comes while the first is still stopping the old one", async () => {
      const worker = withholdingInitialize();
      const s = session({ script: worker.script });
      void s.start();
      await waitUntil(() => worker.requests().some((r) => r.endsWith(" initialize")), 10_000, "initialize to reach the worker");
      const first = s.workerPid!;
      await Promise.all([s.restart(), s.restart()]);
      const second = s.workerPid!;
      expect(pidAlive(first)).toBe(false);
      expect(worker.requests()).toEqual([`${first} initialize`, `${first} shutdown`, `${second} initialize`]);
      expect(s.state.session).toBe("dormant");
      expect(s.state.problem).toBeNull();
    });

    for (const hello of [false, true]) {
      it(`kills a worker that answers nothing${hello ? " after its hello" : ", not even hello"}, once the grace is over`, async () => {
        const worker = unresponsive(hello);
        const s = session({ script: worker.script });
        const started = s.start();
        await waitUntil(() => worker.pid() !== null, 10_000, "the worker to run");
        if (hello) await waitUntil(() => s.workerPid !== undefined, 10_000, "the worker's hello");
        const pid = worker.pid()!;
        const t0 = Date.now();
        await s.dispose();
        const took = Date.now() - t0;
        expect(took).toBeGreaterThanOrEqual(SHUTDOWN_GRACE_MS - 50);
        expect(took).toBeLessThan(SHUTDOWN_GRACE_MS + 1000);
        expect(pidAlive(pid)).toBe(false);
        await expect(started).resolves.toBeNull();
        sessions.splice(sessions.indexOf(s), 1);
      });
    }
  });

  it("stops within the grace period on dispose, leaving the run resumable", async () => {
    const s = session();
    fake.setScenario({ ...happy(), implementer: [{ activities: [{ tool: "Read", input: { file_path: "app.txt" } }], sleep: 60_000, output: impl() }] });
    await s.submit("Make app.txt fixed");
    await until(s, (st) => st.current?.phase === "IMPLEMENT" && st.current.activities.length > 0, "the implementer");
    const started = Date.now();
    await s.dispose();
    expect(Date.now() - started).toBeLessThan(4500);
    sessions.splice(sessions.indexOf(s), 1);
    expect(RunStore.open(join(repo, ".agentduo", "runs")).loadState().inProgress?.phase).toBe("IMPLEMENT");
    expect(existsSync(join(repo, ".agentduo", "runs", ".lock"))).toBe(false);
  });
});

describe("pickWorkspace", () => {
  it("uses the only folder, asks among several, and keeps a remembered pick while it is open", () => {
    expect(pickWorkspace([], null)).toEqual({ kind: "none" });
    expect(pickWorkspace(["/a"], "/b")).toEqual({ kind: "folder", path: "/a" });
    expect(pickWorkspace(["/a", "/b"], null)).toEqual({ kind: "choose", folders: ["/a", "/b"] });
    expect(pickWorkspace(["/a", "/b"], "/b")).toEqual({ kind: "folder", path: "/b" });
    expect(pickWorkspace(["/a", "/b"], "/c")).toEqual({ kind: "choose", folders: ["/a", "/b"] });
    expect(emptyState("choose-folder").session).toBe("choose-folder");
  });
});
