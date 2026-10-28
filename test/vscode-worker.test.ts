// The VS Code extension's engine worker, built and copied outside the repository, driven over real IPC with the
// fake codex/claude CLIs as subprocesses.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WorkerError } from "../extensions/vscode/src/workerClient.js";
import { main, type CliIO } from "../src/cli.js";
import { acquireWorkspaceLock, RunStore } from "../src/core/state.js";
import { approval, critique, finding, impl, plan, review } from "./helpers/builders.js";
import type { ConfigOverrides } from "./helpers/config.js";
import { FakeClis } from "./helpers/fake-clis.js";
import { makeRepo } from "./helpers/repo.js";
import { tempDir } from "./helpers/tmp.js";
import { buildWorker, finished, isEvent, pidAlive, waitUntil, WorkerHarness, writeWorkspaceConfig } from "./helpers/vscode.js";

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
  for (const h of harnesses.splice(0)) {
    h.client.kill();
    await h.client.whenExited();
  }
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

async function open(o: { overrides?: ConfigOverrides; config?: boolean; generation?: number } = {}) {
  if (o.config !== false) writeWorkspaceConfig(repo, fake, o.overrides);
  const h = new WorkerHarness({ script: worker.script, workspace: repo, env: { ...process.env, XDG_CONFIG_HOME: join(t.path, "xdg") }, generation: o.generation });
  harnesses.push(h);
  await h.client.start();
  const init = await h.client.request({ type: "initialize", workspace: repo, configPath: null });
  return { h, init };
}

const lockFile = () => join(runsDir, ".lock");
const latest = () => RunStore.open(runsDir).loadState();
/** The fake agent records its own pid (the shell's parent), so a test can check it is gone. */
const recordPid = (file: string) => `echo $PPID > ${file}`;

describe("vscode worker", () => {
  it("only reads the workspace when the sidebar opens: no lock, no run, no agent", async () => {
    const { init } = await open();
    expect(init.problem).toBeNull();
    expect(init.pipeline.map((p) => `${p.label}:${p.agent}`)).toEqual(["PLAN:codex", "CRITIQUE:claude", "FINALIZE:codex", "IMPLEMENT:claude", "VERIFY:gates", "REVIEW:codex"]);
    expect([init.edits, init.hint, init.workspace]).toEqual(["ask", null, repo]);
    expect(existsSync(runsDir)).toBe(false);
    expect(fake.calls()).toEqual([]);
  });

  it("leaves VERIFY out of the flow without gates", async () => {
    const { init } = await open({ overrides: { gates: [] } });
    expect(init.pipeline.map((p) => p.phase)).not.toContain("VERIFY");
  });

  it("runs a task to DONE with gates, usage and the report, holding the workspace lock until shutdown", async () => {
    const { h } = await open();
    fake.setScenario(happy());
    await h.client.request({ type: "submit", text: "Make app.txt fixed" });
    expect(readFileSync(lockFile(), "utf8").trim()).toBe(String(h.client.pid));
    const done = await h.waitFor(finished());
    expect(done.event).toMatchObject({ phase: "DONE", summary: "quality gates passed and the review approved" });
    const events = h.events();
    expect(events.some((e) => e.type === "gate.completed" && e.passed)).toBe(true);
    expect(events.filter((e) => e.type === "step.completed").every((e) => e.type === "step.completed")).toBe(true);
    expect(events.some((e) => e.type === "step.completed" && (e.tokens ?? 0) > 0)).toBe(true);
    await waitUntil(() => h.statuses().at(-1) === "idle", 5000, "idle");
    expect(h.statuses()).toEqual(["running", "idle"]);
    expect(latest().phase).toBe("DONE");
    expect(existsSync(RunStore.open(runsDir).path("report.md"))).toBe(true);
    await h.client.shutdown();
    expect(existsSync(lockFile())).toBe(false);
  });

  it("turns a message sent during a run into a note for the next step", async () => {
    const { h } = await open();
    fake.setScenario({ ...happy(), planner: [{ sleep: 1500, output: plan() }] });
    await h.client.request({ type: "submit", text: "Make app.txt fixed" });
    await h.waitFor(isEvent("phase.started", (e) => e.phase === "PLAN"));
    await h.client.request({ type: "submit", text: "keep it short" });
    await h.waitFor(finished("DONE"));
    expect(fake.calls("planner")).toHaveLength(1);
    expect(fake.calls("plan_reviewer")[0]!.prompt).toContain("keep it short");
    expect(h.infos().some((l) => l.includes("from the next step"))).toBe(true);
  });

  it("stops the step on interrupt and re-runs it with the next message", async () => {
    const { h } = await open();
    fake.setScenario({
      ...happy(),
      implementer: [{ activities: [{ tool: "Read", input: { file_path: "app.txt" } }], sleep: 20_000, output: impl() }, { write: { "app.txt": "fixed\n" }, output: impl() }],
    });
    await h.client.request({ type: "submit", text: "Make app.txt fixed" });
    await h.waitFor(isEvent("agent.activity", (e) => e.role === "implementer"));
    await h.client.request({ type: "interrupt" });
    await h.waitFor(finished("INTERRUPTED"));
    await waitUntil(() => h.statuses().at(-1) === "paused", 5000, "paused");
    await h.client.request({ type: "submit", text: "only touch app.txt" });
    await waitUntil(() => h.events().filter((e) => e.type === "run.finished").length === 2, 25_000, "second finish");
    expect(fake.calls("implementer")).toHaveLength(2);
    expect(fake.calls("implementer")[1]!.prompt).toContain("only touch app.txt");
    expect(latest().phase).toBe("DONE");
  });

  it("asks for a HUMAN_REVIEW decision, applies each answer once, and asks again on /resume after a deferral", async () => {
    const { h } = await open({ overrides: { limits: { max_review_rounds: 1 } } });
    fake.setScenario({ ...happy(), code_reviewer: [{ output: review(false, [finding("F1")]) }] });
    await h.client.request({ type: "submit", text: "Make app.txt fixed" });
    const asked = await h.waitFor((m) => m.kind === "decision");
    if (asked.kind !== "decision") throw new Error("unreachable");
    expect(asked.review.reason).toBe("max_review_rounds");
    expect(asked.views).toEqual(expect.arrayContaining(["plan", "review", "feedback"]));
    await expect(h.client.request({ type: "decision", requestId: "decision-0-bogus", answer: { decision: "abort", note: null } })).rejects.toMatchObject({ code: "stale" });
    await h.client.request({ type: "decision", requestId: asked.requestId, answer: { decision: "defer", note: null } });
    await expect(h.client.request({ type: "decision", requestId: asked.requestId, answer: { decision: "abort", note: null } })).rejects.toMatchObject({ code: "stale" });
    await h.waitFor(finished("HUMAN_REVIEW"));
    expect(h.messages.some((m) => m.kind === "decisionClosed" && m.requestId === asked.requestId)).toBe(true);
    expect(latest().phase).toBe("HUMAN_REVIEW");
    await waitUntil(() => h.statuses().at(-1) === "idle", 5000, "idle");
    await h.client.request({ type: "submit", text: "/resume" });
    const again = await h.nth((m) => m.kind === "decision", 1);
    if (again.kind !== "decision") throw new Error("unreachable");
    expect(again.requestId).not.toBe(asked.requestId);
    await h.client.request({ type: "decision", requestId: again.requestId, answer: { decision: "abort", note: "not now" } });
    await h.waitFor(finished("ABORTED"));
    expect(latest().humanNotes.map((n) => n.note)).toContain("not now");
  });

  it("relays Claude's permission prompts and answers each once: once, always, deny with a message", async () => {
    const { h } = await open();
    fake.setScenario({
      ...happy(),
      implementer: [{
        write: { "app.txt": "fixed\n" },
        permissions: [
          { tool: "Bash", input: { command: "npm test" }, rules: [] },
          { tool: "Bash", input: { command: "npm run lint" }, rules: [{ toolName: "Bash", ruleContent: "npm run lint:*" }] },
          { tool: "Bash", input: { command: "rm -rf build" }, rules: [] },
        ],
        output: impl(),
      }],
    });
    await h.client.request({ type: "submit", text: "Make app.txt fixed" });
    const answers = [{ decision: "once" }, { decision: "always" }, { decision: "deny", message: "use the npm script" }] as const;
    for (const [i, answer] of answers.entries()) {
      const asked = await h.nth(isEvent("permission.requested"), i);
      if (asked.kind !== "event" || asked.event.type !== "permission.requested") throw new Error("unreachable");
      if (i === 1) expect(asked.event.request.rules).toEqual(["Bash(npm run lint:*)"]);
      await h.client.request({ type: "permissionAnswer", requestId: asked.event.request.id, answer });
      await expect(h.client.request({ type: "permissionAnswer", requestId: asked.event.request.id, answer: { decision: "once" } })).rejects.toMatchObject({ code: "stale" });
    }
    await h.waitFor(finished("DONE"));
    expect(fake.permissionAnswers().map((a) => [a.behavior, a.message ?? null, !!a.updatedPermissions])).toEqual([
      ["allow", null, false], ["allow", null, true], ["deny", "use the npm script", false],
    ]);
    const args = fake.calls("implementer")[0]!.args;
    expect(args[args.indexOf("--permission-prompts") + 1]).toBe("host");
  });

  it("refuses requests meant for an earlier worker, from another protocol, or naming paths outside the workspace", async () => {
    const { h } = await open({ generation: 5 });
    await expect(h.client.request({ type: "submit", text: "/help" })).resolves.toEqual({ accepted: true });
    expect(await h.raw({ protocol: 1, generation: 4, id: 999, request: { type: "interrupt" } })).toMatchObject({ ok: false, error: { code: "stale" } });
    expect(await h.raw({ protocol: 2, generation: 5, id: 1000, request: { type: "interrupt" } })).toMatchObject({ ok: false, error: { code: "protocol" } });
    expect(await h.raw({ protocol: 1, generation: 5, id: 1001, request: { type: "readSnapshotFile", runId: "x", base: "a".repeat(40), snapshot: "b".repeat(40), side: "base", path: "../etc/passwd" } }))
      .toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(await h.raw({ protocol: 1, generation: 5, id: 1002, request: { type: "exec", command: "rm -rf /" } })).toMatchObject({ ok: false, error: { code: "bad_request" } });
  });

  describe("shutdown", () => {
    const within = async (h: WorkerHarness) => {
      const started = Date.now();
      await h.client.shutdown();
      return Date.now() - started;
    };

    it("stops a running agent within the grace period; the run stays resumable and the lock is freed", async () => {
      const { h } = await open();
      fake.setScenario({ ...happy(), implementer: [{ shell: [recordPid("agent.pid")], activities: [{ tool: "Read", input: { file_path: "app.txt" } }], sleep: 60_000, output: impl() }] });
      await h.client.request({ type: "submit", text: "Make app.txt fixed" });
      await h.waitFor(isEvent("agent.activity", (e) => e.role === "implementer"));
      const agent = Number(readFileSync(join(repo, "agent.pid"), "utf8"));
      expect(pidAlive(agent)).toBe(true);
      expect(await within(h)).toBeLessThan(4000);
      await waitUntil(() => !pidAlive(agent), 3000, "the agent to die");
      expect(latest().inProgress?.phase).toBe("IMPLEMENT");
      expect(existsSync(lockFile())).toBe(false);
      expect(existsSync(RunStore.open(runsDir).path("lock"))).toBe(false);
    });

    it("stops a running gate", async () => {
      const gate = { name: "slow", command: `"${process.execPath}" -e "require('fs').writeFileSync('gate.pid', String(process.pid)); setTimeout(() => {}, 60000)"`, required: true };
      const { h } = await open({ overrides: { gates: [gate] } });
      fake.setScenario(happy());
      await h.client.request({ type: "submit", text: "Make app.txt fixed" });
      await h.waitFor(isEvent("gate.started"));
      await waitUntil(() => existsSync(join(repo, "gate.pid")), 5000, "the gate to start");
      const pid = Number(readFileSync(join(repo, "gate.pid"), "utf8"));
      expect(await within(h)).toBeLessThan(4000);
      await waitUntil(() => !pidAlive(pid), 3000, "the gate to die");
      expect(latest().inProgress?.phase).toBe("VERIFY");
    });

    it("denies a permission prompt nobody answered", async () => {
      const { h } = await open();
      fake.setScenario({ ...happy(), implementer: [{ permissions: [{ tool: "Bash", input: { command: "npm test" }, rules: [] }], sleep: 60_000, output: impl() }] });
      await h.client.request({ type: "submit", text: "Make app.txt fixed" });
      const asked = await h.waitFor(isEvent("permission.requested"));
      expect(await within(h)).toBeLessThan(4000);
      // Answered before the agent was stopped: Claude never waits on a prompt nobody will answer.
      expect(h.events().find((e) => e.type === "permission.answered")).toMatchObject({ answer: { decision: "deny" } });
      const logs = join(RunStore.open(runsDir).dir, "logs");
      const answers = readFileSync(join(logs, readdirSync(logs).find((f) => f.endsWith(".answers.jsonl"))!), "utf8");
      expect(JSON.parse(answers).response).toMatchObject({ request_id: (asked.event as { request: { id: string } }).request.id, response: { behavior: "deny" } });
      expect(latest().inProgress?.phase).toBe("IMPLEMENT");
    });

    it("defers a decision nobody made", async () => {
      const { h } = await open({ overrides: { limits: { max_review_rounds: 1 } } });
      fake.setScenario({ ...happy(), code_reviewer: [{ output: review(false, [finding("F1")]) }] });
      await h.client.request({ type: "submit", text: "Make app.txt fixed" });
      await h.waitFor((m) => m.kind === "decision");
      expect(await within(h)).toBeLessThan(4000);
      expect(latest().phase).toBe("HUMAN_REVIEW");
      expect(existsSync(lockFile())).toBe(false);
    });

    it("cleans up on its own when the extension host goes away", async () => {
      const { h } = await open();
      fake.setScenario({ ...happy(), implementer: [{ shell: [recordPid("agent.pid")], activities: [{ tool: "Read", input: { file_path: "app.txt" } }], sleep: 60_000, output: impl() }] });
      await h.client.request({ type: "submit", text: "Make app.txt fixed" });
      await h.waitFor(isEvent("agent.activity", (e) => e.role === "implementer"));
      const agent = Number(readFileSync(join(repo, "agent.pid"), "utf8"));
      const started = Date.now();
      h.client.disconnect();
      await h.client.whenExited();
      expect(Date.now() - started).toBeLessThan(4000);
      await waitUntil(() => !pidAlive(agent), 3000, "the agent to die");
      expect(existsSync(lockFile())).toBe(false);
      expect(latest().inProgress?.phase).toBe("IMPLEMENT");
    });
  });

  it("after a worker crash, a new worker reclaims the stale lock and resumes the run", async () => {
    const { h } = await open();
    fake.setScenario({ ...happy(), implementer: [{ activities: [{ tool: "Read", input: { file_path: "app.txt" } }], sleep: 3000, output: impl() }, { write: { "app.txt": "fixed\n" }, output: impl() }] });
    await h.client.request({ type: "submit", text: "Make app.txt fixed" });
    await h.waitFor(isEvent("agent.activity", (e) => e.role === "implementer"));
    h.client.kill();
    await h.client.whenExited();
    expect(existsSync(lockFile())).toBe(true); // left behind by the killed worker
    await expect(h.client.request({ type: "interrupt" })).rejects.toBeInstanceOf(WorkerError);
    await new Promise((r) => setTimeout(r, 3500)); // the orphaned fake agent finishes on its own
    const next = await open({ generation: 2, config: false });
    expect(next.init.hint).toContain("/resume");
    await next.h.client.request({ type: "submit", text: "/resume" });
    await next.h.waitFor(finished("DONE"));
    expect(latest().phase).toBe("DONE");
  });

  it("reports a missing CLI, a broken config and a lock held by the CLI, without calling an agent", async () => {
    const missing = await open({ overrides: { codex: { bin: join(t.path, "missing") } } });
    expect(missing.init.problem).toMatchObject({ kind: "missing_cli" });
    await expect(missing.h.client.request({ type: "submit", text: "Fix" })).rejects.toMatchObject({ code: "missing_cli", message: expect.stringContaining("CLI not found: codex") });
    expect(existsSync(lockFile())).toBe(false);
    await missing.h.client.shutdown();

    writeFileSync(join(repo, ".agentduo", "config.yaml"), "codex:\n  bin: 5\n");
    const invalid = await open({ config: false });
    expect(invalid.init.problem).toMatchObject({ kind: "config", message: expect.stringContaining("codex.bin must be a non-empty string") });
    await invalid.h.client.shutdown();

    writeFileSync(join(repo, ".agentduo", "config.yaml"), "codex: [unclosed\n");
    const unreadable = await open({ config: false });
    expect(unreadable.init.problem).toMatchObject({ kind: "config" });
    await unreadable.h.client.shutdown();

    writeWorkspaceConfig(repo, fake);
    const release = acquireWorkspaceLock(runsDir); // as `duo` holds it
    try {
      const busy = await open({ config: false });
      expect(busy.init.problem).toMatchObject({ kind: "locked", message: expect.stringContaining(`pid ${process.pid}`) });
      await expect(busy.h.client.request({ type: "submit", text: "Fix" })).rejects.toMatchObject({ code: "locked" });
      await busy.h.client.shutdown();
    } finally {
      release();
    }
    expect(fake.calls()).toEqual([]);
  });

  it("holds the lock the CLI checks, so `duo` refuses to start a second writer", async () => {
    const { h } = await open();
    await h.client.request({ type: "submit", text: "/status" });
    let err = "";
    const io: CliIO = {
      stdout: { write: () => true }, stderr: { write: (s: string) => { err += s; } }, stdin: {},
      env: { ...process.env, XDG_CONFIG_HOME: join(t.path, "xdg"), CI: "" }, cwd: repo,
    };
    expect(await main(["Another task"], io)).toBe(1);
    expect(err).toContain(`another agentduo run is active in this workspace (pid ${h.client.pid})`);
    await h.client.request({ type: "submit", text: "/quit" });
    await h.waitFor((m) => m.kind === "ui" && m.update.type === "session" && m.update.session === "ended");
    expect(existsSync(lockFile())).toBe(false);
    acquireWorkspaceLock(runsDir)(); // free for `duo` again
  });
});
