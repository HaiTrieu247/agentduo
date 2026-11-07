// `duo` and the extension's (or the desktop's) engine workers take turns in one workspace: each holds the workspace lock
// only while its work runs (an answer, a discussion, a run, their waits for the user included), so an idle window never
// keeps another from working, and a conversation goes on in whichever window it is opened. Real workers over IPC (built
// and copied outside the repository, as in the VSIX), the real CLI, and the fake agents as subprocesses.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { userConfigEnv } from "@agentduo/engine/testing/config";
import { approval, critique, finding, impl, plan, review } from "@agentduo/engine/testing/builders";
import { FakeClis } from "@agentduo/engine/testing/fake-clis";
import { makeRepo } from "@agentduo/engine/testing/repo";
import { tempDir } from "@agentduo/engine/testing/tmp";
import { pidAlive, waitUntil } from "@agentduo/engine/testing/wait";
import { RunStore } from "@agentduo/engine/workflow/state";
import type { ConfigOverrides } from "@agentduo/engine/testing/config";
import { buildWorker, finished, isEvent, WorkerHarness, writeWorkspaceConfig } from "@agentduo/host/testing/worker";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
const env = () => ({ ...process.env, ...userConfigEnv(join(t.path, "xdg")) });

const happy = () => ({
  planner: [{ output: plan() }],
  plan_reviewer: [{ output: critique(true) }],
  plan_finalizer: [{ output: approval(true) }],
  implementer: [{ write: { "app.txt": "fixed\n" }, output: impl() }],
  code_reviewer: [{ output: review(true) }],
});

/** A window: an engine worker of the extension or the desktop, initialized on the workspace. */
async function open(o: { generation?: number; overrides?: ConfigOverrides; config?: boolean } = {}) {
  if (o.config !== false) writeWorkspaceConfig(repo, fake, o.overrides);
  const h = new WorkerHarness({ script: worker.script, workspace: repo, env: env(), generation: o.generation ?? 1 });
  harnesses.push(h);
  await h.client.start();
  await h.client.request({ type: "initialize", workspace: repo, configPath: null, discover: false });
  return h;
}

/** `duo` with these words, in this process (so a lock it holds names this process's pid). */
async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io: CliIO = { stdout: { write: (s: string) => { out += s; } }, stderr: { write: (s: string) => { err += s; } }, stdin: {}, env: { ...env(), CI: "" }, cwd: repo };
  const code = await main(args, io);
  return { code, out, err };
}

const say = (h: WorkerHarness, text: string, conversation = C, route: "message" | "pipeline" = "message") =>
  h.client.request({ type: "submit", conversation, text, route });
const refused = (h: WorkerHarness, text?: string) =>
  h.messages.some((m) => m.kind === "ui" && m.update.type === "refused" && (text === undefined || m.update.text === text));
const answered = (h: WorkerHarness, answer: string) => h.waitFor(isEvent("turn.finished", (e) => e.answer === answer));
const dormant = (h: WorkerHarness) => waitUntil(() => {
  const sessions = h.messages.flatMap((m) => (m.kind === "ui" && m.update.type === "session" ? [m.update.session] : []));
  return sessions.at(-1) === "dormant";
}, 10_000, "the worker to give the workspace back");
const record = (id = C) => JSON.parse(readFileSync(join(runsDir, "conversations", id, "conversation.json"), "utf8")) as {
  exchanges: Array<{ id?: string; question: string; answer: string }>; recipient: string | null;
};

describe("windows taking turns in a workspace", () => {
  it("an idle window holds nothing: `duo` runs a task without the window quitting, and the window works again after", async () => {
    fake.setScenario({ ...happy(), chat_codex: [{ answer: "before" }, { answer: "after" }] });
    const h = await open();
    await say(h, "What is it?");
    await answered(h, "before");
    await dormant(h);
    expect(existsSync(lockFile())).toBe(false);
    const run = await cli(["Make app.txt fixed"]);
    expect(run.code).toBe(0);
    expect(RunStore.open(runsDir).loadState().phase).toBe("DONE");
    await say(h, "And now?");
    await answered(h, "after");
    expect(refused(h)).toBe(false);
  });

  it("while a window works, waiting for the user included, `duo` is refused with its pid, and nothing there is interrupted", async () => {
    const flag = { questions: [{ question: "Which flag?", header: "Flag", multiSelect: false, options: [{ label: "--fast", description: "" }, { label: "--safe", description: "" }] }] };
    fake.setScenario({ chat_claude: [{ questions: [flag], answer: "built with --safe" }] });
    const h = await open();
    await say(h, "/claude Build it");
    const asked = await h.waitFor(isEvent("clarification.requested"));
    if (asked.kind !== "event" || asked.event.type !== "clarification.requested") throw new Error("unreachable");
    // Claude waits for an answer: the window keeps the workspace and the conversation.
    expect(readFileSync(lockFile(), "utf8").trim()).toBe(String(h.client.pid));
    const busy = await cli(["Another task"]);
    expect([busy.code, busy.err]).toEqual([1, expect.stringContaining(`another agentduo is working in this workspace (pid ${h.client.pid})`)]);
    expect(RunStore.list(runsDir)).toEqual([]);
    const opened = await cli(["chat", C]);
    expect([opened.code, opened.err]).toEqual([1, expect.stringContaining(`is in use by another agentduo (pid ${h.client.pid})`)]);
    const request = asked.event.request;
    await h.client.request({
      type: "clarificationAnswer", conversation: C, requestId: request.id, callId: request.callId,
      reply: { kind: "answered", answers: [{ questionId: request.questions[0]!.id, optionIds: [request.questions[0]!.options[1]!.id], otherText: null }] },
    });
    await answered(h, "built with --safe");
    await dormant(h);
    expect(existsSync(lockFile())).toBe(false);
    expect(existsSync(join(runsDir, "conversations", C, ".lock"))).toBe(false);
  });

  it("while `duo` works, a window's message is not sent but given back, and goes once `duo` is done", async () => {
    fake.setScenario({ ...happy(), planner: [{ sleep: 2500, output: plan() }], chat_codex: [{ answer: "after duo" }] });
    const h = await open();
    const running = cli(["Make app.txt fixed"]);
    await waitUntil(() => existsSync(lockFile()), 10_000, "`duo` to take the workspace");
    await say(h, "Can I ask now?");
    await h.waitFor((m) => m.kind === "ui" && m.conversation === C && m.update.type === "refused" && m.update.text === "Can I ask now?");
    expect(h.infos().some((l) => l.includes(`pid ${process.pid}`) && l.includes("Nothing was sent"))).toBe(true);
    expect(fake.calls("chat_codex")).toEqual([]);
    expect((await running).code).toBe(0);
    await say(h, "Can I ask now?");
    await answered(h, "after duo");
    expect(record().exchanges.map((e) => e.question)).toEqual(["Can I ask now?"]);
  });

  it("two windows sending at once: one works, the other is given its message back and sends it again; nothing is lost or doubled", async () => {
    fake.setScenario({ chat_codex: [{ sleep: 1500, answer: "first answer" }, { answer: "second answer" }] });
    const a = await open({ generation: 1 });
    const b = await open({ generation: 2, config: false });
    await Promise.all([say(a, "From A"), say(b, "From B")]);
    await waitUntil(() => refused(a) !== refused(b), 10_000, "one window to be refused");
    const [winner, loser, text] = refused(a) ? [b, a, "From A"] : [a, b, "From B"];
    await answered(winner, "first answer");
    await dormant(winner);
    await say(loser, text);
    await answered(loser, "second answer");
    const said = record().exchanges;
    expect(said.map((e) => e.question)).toEqual([text === "From A" ? "From B" : "From A", text]);
    expect(new Set(said.map((e) => e.id)).size).toBe(2);
    // The second one went on in the first one's session, with only what was new.
    const calls = fake.calls("chat_codex");
    expect(calls[1]!.resumed).toBe(calls[0]!.session);
    expect(calls[1]!.prompt).not.toContain("first answer");
  });

  it("a conversation goes on in another window, back and forth: history, sessions and the recipient carry over, once each", async () => {
    fake.setScenario({ chat_codex: [{ answer: "ANS-A1" }, { answer: "ANS-A2" }], chat_claude: [{ answer: "ANS-B1" }] });
    const a = await open({ generation: 1 });
    const b = await open({ generation: 2, config: false });
    await say(a, "Q-A1");
    await answered(a, "ANS-A1");
    await dormant(a);
    // The second window carries the conversation on: Claude sees what Codex said.
    await say(b, "/claude Q-B1");
    await answered(b, "ANS-B1");
    expect(fake.calls("chat_claude")[0]!.prompt).toContain("ANS-A1");
    await dormant(b);
    expect(record().recipient).toBe("claude");
    // Back in the first window: Codex goes on in its own session, told only what it has not seen.
    await say(a, "/codex Q-A2");
    await answered(a, "ANS-A2");
    const [first, second] = fake.calls("chat_codex");
    expect(second!.resumed).toBe(first!.session);
    expect(second!.prompt).toContain("ANS-B1");
    expect(second!.prompt).not.toContain("ANS-A1");
    expect(record().exchanges.map((e) => e.answer)).toEqual(["ANS-A1", "ANS-B1", "ANS-A2"]);
  });

  it("a window killed mid-answer does not keep the workspace: the next one takes its locks over and works", async () => {
    fake.setScenario({ chat_codex: [{ pid: "agent.pid", sleep: 4000, answer: "never recorded" }, { answer: "after the crash" }] });
    const a = await open({ generation: 1 });
    await say(a, "Q1");
    await waitUntil(() => existsSync(join(repo, "agent.pid")), 10_000, "the answer to start");
    const pid = a.client.pid!;
    a.client.kill();
    await a.client.whenExited();
    expect(pidAlive(pid)).toBe(false);
    // Left behind, naming a process that is gone.
    expect(readFileSync(lockFile(), "utf8").trim()).toBe(String(pid));
    expect(existsSync(join(runsDir, "conversations", C, ".lock"))).toBe(true);
    await new Promise((r) => setTimeout(r, 4500)); // the orphaned fake agent finishes on its own
    const b = await open({ generation: 2, config: false });
    await say(b, "Q2");
    await answered(b, "after the crash");
    await dormant(b);
    expect(existsSync(lockFile())).toBe(false);
    // The answer the killed window never recorded is not in the conversation.
    expect(record().exchanges.map((e) => e.answer)).toEqual(["after the crash"]);
  });

  it("a setting saved in one window reaches another's next call; one changed without --save stays in its window", async () => {
    fake.setScenario({ chat_claude: [{ answer: "c1" }, { answer: "c2" }, { answer: "b1" }] });
    const a = await open({ generation: 1 });
    const b = await open({ generation: 2, config: false });
    const c = await open({ generation: 3, config: false });
    await say(c, "/claude one", "tab-c");
    await answered(c, "c1");
    const setting = (h: WorkerHarness, conversation: string, model: string, save: boolean) =>
      h.client.request({ type: "setting", conversation, setting: { target: "claude.model", model }, save, global: false, yes: false });
    await setting(b, "tab-b", "haiku", false);
    await setting(a, "tab-a", "opus", true);
    await say(c, "/claude two", "tab-c");
    await answered(c, "c2");
    await say(b, "/claude three", "tab-b");
    await answered(b, "b1");
    const model = (i: number) => {
      const args = fake.calls("chat_claude")[i]!.args;
      return args.includes("--model") ? args[args.indexOf("--model") + 1] : null;
    };
    // c read the saved model before its next call; b keeps the one it set for itself; neither was saved for the other.
    expect([model(0), model(1), model(2)]).toEqual([null, "opus", "haiku"]);
    expect(readFileSync(join(repo, ".agentduo", "config.yaml"), "utf8")).not.toContain("haiku");
  });

  it("a run waiting for a decision keeps the workspace; decided later, it gives it back and `duo resume` continues the run", async () => {
    const h = await open({ overrides: { limits: { max_review_rounds: 1 } } });
    fake.setScenario({ ...happy(), code_reviewer: [{ output: review(false, [finding("F1")]) }] });
    await say(h, "Make app.txt fixed", C, "pipeline");
    const asked = await h.waitFor((m) => m.kind === "decision");
    if (asked.kind !== "decision") throw new Error("unreachable");
    expect(readFileSync(lockFile(), "utf8").trim()).toBe(String(h.client.pid));
    const busy = await cli(["resume", "--decision", "abort"]);
    expect([busy.code, busy.err]).toEqual([1, expect.stringContaining(`pid ${h.client.pid}`)]);
    expect(RunStore.open(runsDir).loadState().phase).toBe("HUMAN_REVIEW");
    await h.client.request({ type: "decision", requestId: asked.requestId, answer: { decision: "defer", note: null } });
    await h.waitFor(finished("HUMAN_REVIEW"));
    await dormant(h);
    expect(existsSync(lockFile())).toBe(false);
    // The conversation has the run's outcome, by its id.
    const runId = RunStore.open(runsDir).taskId;
    const earlier = (JSON.parse(readFileSync(join(runsDir, "conversations", C, "conversation.json"), "utf8")) as { earlier: Array<{ runId?: string }> }).earlier;
    expect(earlier.map((e) => e.runId)).toEqual([runId]);
    const resumed = await cli(["resume", "--decision", "abort"]);
    expect(resumed.code).not.toBe(1);
    expect(RunStore.open(runsDir).loadState().phase).toBe("ABORTED");
  });
});

describe("duo chat: the saved conversations", () => {
  it("lists every window's conversations, and says when one does not exist or is in use elsewhere", async () => {
    fake.setScenario({ chat_codex: [{ answer: "ok" }, { sleep: 2500, answer: "slow" }] });
    const h = await open();
    await say(h, "First question");
    await answered(h, "ok");
    const list = await cli(["chat", "--list"]);
    expect(list.code).toBe(0);
    expect(list.out).toMatch(new RegExp(`^${C}  \\S+  First question\\n`));
    expect(list.out).toContain("duo chat <id>");
    const missing = await cli(["chat", "nope"]);
    expect([missing.code, missing.err]).toEqual([1, expect.stringContaining(`no saved conversation 'nope' in ${runsDir}`)]);
    await say(h, "Slow one");
    await waitUntil(() => existsSync(join(runsDir, "conversations", C, ".lock")), 10_000, "the answer to start");
    expect((await cli(["chat", "--list"])).out).toContain(`[in use by pid ${h.client.pid}]`);
    const inUse = await cli(["chat", "conv"]);
    expect([inUse.code, inUse.err]).toEqual([1, expect.stringContaining(`conversation ${C} («First question») is in use by another agentduo (pid ${h.client.pid})`)]);
    await answered(h, "slow");
    await dormant(h);
    // Free again: found by the start of its id, or as the latest; only a terminal is missing to open it here.
    for (const name of ["conv", "latest"]) {
      const opened = await cli(["chat", name]);
      expect([opened.code, opened.err]).toEqual([1, "error: the chat needs an interactive terminal (not --plain, CI or the background)\n"]);
    }
  });
});
