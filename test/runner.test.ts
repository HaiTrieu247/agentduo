import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRunner, type CallBudget, type CallSession } from "../src/agents/runner.js";
import type { Attachment } from "../src/core/attachment-types.js";
import { AttachmentStore, existingAttachmentFile } from "../src/core/attachments.js";
import { png } from "./helpers/images.js";
import type { ClarificationRequest, ClarificationResponse } from "../src/core/clarification.js";
import { EventBus, type ClarificationDecider, type DuoEvent, type PermissionAnswer, type PermissionDecider } from "../src/events.js";
import { critique, impl, plan } from "./helpers/builders.js";
import { testConfig, type ConfigOverrides } from "./helpers/config.js";
import { FakeClis } from "./helpers/fake-clis.js";
import { tempDir } from "./helpers/tmp.js";

let t: { path: string; cleanup(): void };
let fake: FakeClis;
let events: DuoEvent[];
let bus: EventBus;

beforeEach(() => {
  t = tempDir();
  fake = new FakeClis(t.path).install();
  bus = new EventBus();
  events = [];
  bus.on((e) => events.push(e));
});
afterEach(() => {
  fake.restore();
  t.cleanup();
});

const runner = (o: ConfigOverrides = {}, permissions?: PermissionDecider) =>
  new AgentRunner(testConfig(fake, o), t.path, join(t.path, "logs"), bus, { permissions, runsDir: join(t.path, "runs") });
/** Files attached in a conversation of the runs directory: a 64×32 PNG, a big PNG (over Claude's 5 MB once encoded), and a PDF. */
const attached = () => {
  const store = new AttachmentStore(join(t.path, "runs"), join(t.path, "runs", "conversations", "c1"));
  return {
    shot: store.importBytes("shot.png", png(64, 32)),
    big: { ...store.importBytes("big.png", png(64, 32)), size: 4_000_000 } as Attachment,
    pdf: store.importBytes("spec.pdf", Buffer.from("%PDF-1.4\nMARKER\n")),
  };
};
const sha = (a: Attachment) => createHash("sha256").update(readFileSync(existingAttachmentFile(join(t.path, "runs"), a))).digest("hex");
const ask = (r: AgentRunner, backend: "claude" | "codex", attachments: Attachment[], logPrefix = "001-ask") =>
  r.call({ mode: "text", backend, prompt: "[agentduo-conversation]\nWhat is in the files?", logPrefix, conversationId: "c1", turnId: "c1-t1", attachments });
/** Answers every permission prompt with `answers` in turn, after `delayMs`, and records what it was asked. */
const scripted = (answers: PermissionAnswer[], delayMs = 0) => {
  const asked: string[] = [];
  const decider: PermissionDecider = {
    askPermission: async ({ request }) => {
      asked.push(request.label);
      await new Promise((r) => setTimeout(r, delayMs));
      return answers[asked.length - 1] ?? { decision: "deny" };
    },
  };
  return { decider, asked };
};
const implement = (r: AgentRunner) =>
  r.call({ role: "implementer", agentRole: "implementer", prompt: prompt("implementer"), schemaName: "implementation", logPrefix: "020-implement-r1" });
const bashAsk = (command: string, write: Record<string, string> = {}) =>
  ({ tool: "Bash", input: { command }, rules: [{ toolName: "Bash", ruleContent: `${command}:*` }], write });
const prompt = (role: string) => `[orchestrator-role: ${role}]\nhello`;

describe("AgentRunner", () => {
  it("returns validated output and streams activities (codex)", async () => {
    fake.setScenario({ planner: [{ activities: [{ command: "cat README.md" }], output: plan() }] });
    const r = await runner().call({ role: "planner", agentRole: "planner", prompt: prompt("planner"), schemaName: "plan", logPrefix: "001-plan-r1" });
    expect(r).toMatchObject({ ok: true, attempts: 1, backend: "codex", tokens: 1234, interrupted: false });
    expect(r.data.title).toBe("Demo plan");
    const labels = events.flatMap((e) => (e.type === "agent.activity" ? [e.activity.label] : []));
    expect(labels).toContain("exec  cat README.md");
    expect(events.some((e) => e.type === "agent.usage" && e.tokens === 1234)).toBe(true);
    for (const ext of ["prompt.md", "cmd.json", "events.jsonl", "stderr.txt", "output.json"]) {
      expect(existsSync(join(t.path, "logs", `001-plan-r1.a1.${ext}`)), ext).toBe(true);
    }
    expect(fake.calls("planner")[0]!.args).toContain("--json");
  });

  it("retries invalid output with the reason and accumulates cost (claude)", async () => {
    fake.setScenario({ plan_reviewer: [{ raw: "looks fine!" }, { output: critique(true) }] });
    const r = await runner().call({ role: "plan_reviewer", agentRole: "plan_reviewer", prompt: prompt("plan_reviewer"), schemaName: "plan_critique", logPrefix: "002" });
    expect(r).toMatchObject({ ok: true, attempts: 2, costUsd: 0.02 });
    expect(events.find((e) => e.type === "agent.retry")).toMatchObject({ attempt: 2, max: 2, role: "plan_reviewer" });
    expect(fake.calls("plan_reviewer")[1]!.prompt).toContain("## Your previous answer was rejected\n");
  });

  it("applies the semantic check and gives up after max_retries", async () => {
    fake.setScenario({ plan_reviewer: [{ output: critique(true) }] });
    const r = await runner().call({ role: "plan_reviewer", agentRole: "plan_reviewer", prompt: prompt("plan_reviewer"),
      schemaName: "plan_critique", logPrefix: "003", check: () => ["nope"] });
    expect(r).toMatchObject({ ok: false, attempts: 2 });
    expect(r.error).toContain("nope");
  });

  it("tells each retry exactly what to correct, with the answer it rejected, and keeps every rejection", async () => {
    fake.setScenario({ plan_reviewer: [{ output: critique(false) }, { output: critique(true) }, { output: critique(true) }] });
    let k = 0;
    const r = await runner({ limits: { max_retries: 2 } }).call({ role: "plan_reviewer", agentRole: "plan_reviewer", prompt: prompt("plan_reviewer"),
      schemaName: "plan_critique", logPrefix: "004", check: () => (++k < 3 ? [`issue 'C${k}' needs a scope`] : []) });
    expect(r).toMatchObject({ ok: true, attempts: 3, calls: 3 });
    expect(r.rejections).toEqual([{ attempt: 1, errors: ["issue 'C1' needs a scope"] }, { attempt: 2, errors: ["issue 'C2' needs a scope"] }]);
    const second = fake.calls("plan_reviewer")[1]!.prompt;
    expect(second).toContain("## Your previous answer was rejected\nagentduo checked your previous answer to this request and rejected it:\n- issue 'C1' needs a scope\n");
    expect(second).toContain("Correct exactly these points");
    expect(second).toContain('"status": "changes_requested"');
    // Only the latest rejection: the agent corrects the answer it is shown.
    expect(fake.calls("plan_reviewer")[2]!.prompt).toContain("- issue 'C2' needs a scope\n");
    expect(fake.calls("plan_reviewer")[2]!.prompt).not.toContain("'C1'");
  });

  it("stops retrying when the same invalid answer comes back, and says why", async () => {
    fake.setScenario({ plan_reviewer: [{ output: critique(true) }] });
    const r = await runner({ limits: { max_retries: 3 } }).call({ role: "plan_reviewer", agentRole: "plan_reviewer", prompt: prompt("plan_reviewer"),
      schemaName: "plan_critique", logPrefix: "005", check: () => ["finding 'F1' cites 'AC9', which is not an acceptance criterion of the final plan (AC1)"] });
    expect(r).toMatchObject({ ok: false, attempts: 2, calls: 2 });
    expect(r.error).toBe("the same invalid answer came back after it was told what to correct, so no further attempt was made:\n" +
      "- finding 'F1' cites 'AC9', which is not an acceptance criterion of the final plan (AC1)");
    expect(r.rejections).toHaveLength(2);
    expect(fake.calls("plan_reviewer")).toHaveLength(2);
  });

  it("reports a missing binary without retrying", async () => {
    const r = await runner({ codex: { bin: join(t.path, "missing") } }).call({ role: "planner", agentRole: "planner", prompt: prompt("planner"), schemaName: "plan", logPrefix: "004" });
    expect(r).toMatchObject({ ok: false, attempts: 1 });
    expect(r.error).toContain("codex CLI not found");
  });

  it("fails on a non-zero exit code", async () => {
    fake.setScenario({ planner: [{ output: plan(), exit: 2 }] });
    const r = await runner({ limits: { max_retries: 0 } }).call({ role: "planner", agentRole: "planner", prompt: prompt("planner"), schemaName: "plan", logPrefix: "005" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("exited with code 2");
  });

  it("times out", async () => {
    fake.setScenario({ planner: [{ output: plan(), sleep: 5000 }] });
    const r = await runner({ limits: { max_retries: 0, agent_timeout_sec: 1 } }).call({ role: "planner", agentRole: "planner", prompt: prompt("planner"), schemaName: "plan", logPrefix: "006" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("timed out after 1s");
  });

  it("gives every call its own log files and ignores a stale last message", async () => {
    fake.setScenario({ planner: [{ output: plan() }, { noLastMessage: true, raw: "not json" }] });
    const r = runner({ limits: { max_retries: 0 } });
    expect((await r.call({ role: "planner", agentRole: "planner", prompt: prompt("planner"), schemaName: "plan", logPrefix: "010-plan-r1" })).ok).toBe(true);
    const second = await r.call({ role: "planner", agentRole: "planner", prompt: prompt("planner"), schemaName: "plan", logPrefix: "010-plan-r1" });
    expect(second.ok).toBe(false);
    expect(existsSync(join(t.path, "logs", "010-plan-r1.a1.prompt.md"))).toBe(true);
    expect(existsSync(join(t.path, "logs", "010-plan-r1-2.a1.prompt.md"))).toBe(true);
  });

  it("treats a silent agent as hung", async () => {
    fake.setScenario({ planner: [{ output: plan(), sleep: 5000 }] });
    const r = await runner({ limits: { max_retries: 0, agent_idle_timeout_sec: 1 } }).call({ role: "planner", agentRole: "planner", prompt: prompt("planner"), schemaName: "plan", logPrefix: "011" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("codex produced no output for 1s");
  });

  it("counts Claude tokens, also for an interrupted attempt", async () => {
    fake.setScenario({ implementer: [{ activities: [{ tool: "Read", input: { file_path: "x" } }], sleep: 5000, output: {} }] });
    const controller = new AbortController();
    // Abort once the usage has streamed in; a fixed delay races the agent's startup on a busy machine.
    bus.on((e) => {
      if (e.type === "agent.usage" && e.tokens) controller.abort();
    });
    const r = await runner().call({ role: "implementer", agentRole: "implementer", prompt: prompt("implementer"), schemaName: "implementation", logPrefix: "012", signal: controller.signal });
    expect(r).toMatchObject({ interrupted: true, tokens: 15 });
  });

  it("relays Claude's permission prompts to the user and answers on stdin", async () => {
    fake.setScenario({ implementer: [{ permissions: [bashAsk("npm test", { "tested.txt": "ok\n" }), bashAsk("rm -rf build")], output: impl() }] });
    const { decider, asked } = scripted([{ decision: "always" }, { decision: "deny", message: "keep build/" }]);
    const r = await implement(runner({}, decider));
    expect(r.ok, r.error ?? "").toBe(true);
    expect(asked).toEqual(["Bash  npm test", "Bash  rm -rf build"]);
    const args = fake.calls("implementer")[0]!.args;
    expect(args[args.indexOf("--permission-prompts") + 1]).toBe("host");
    expect(fake.permissionAnswers().map((a) => [a.behavior, a.message ?? null])).toEqual([["allow", null], ["deny", "keep build/"]]);
    expect(readFileSync(join(t.path, ".claude", "settings.local.json"), "utf8")).toContain("Bash(npm test:*)");
    expect(existsSync(join(t.path, "tested.txt"))).toBe(true);
    // A call the user denied is the user's choice, not a settings problem to hint about.
    expect(r.meta.permissionDenials).toEqual([]);
    const types = events.map((e) => e.type);
    expect(types.filter((x) => x === "permission.requested")).toHaveLength(2);
    expect(events.find((e) => e.type === "permission.answered")).toMatchObject({ role: "implementer", agent: "claude", answer: { decision: "always" } });
  });

  it("does not count the time a person takes to answer against the agent's timeouts", async () => {
    fake.setScenario({ implementer: [{ permissions: [bashAsk("npm test")], output: impl() }] });
    const { decider } = scripted([{ decision: "once" }], 2500); // longer than both limits below
    const r = await implement(runner({ limits: { max_retries: 0, agent_idle_timeout_sec: 1, agent_timeout_sec: 2 } }, decider));
    expect(r.ok, r.error ?? "").toBe(true);
  });

  it("keeps denying prompts automatically when nobody can answer, or when configured to", async () => {
    fake.setScenario({ implementer: [{ output: impl() }] });
    await implement(runner());
    const { decider } = scripted([]);
    await implement(runner({ claude: { permission_prompts: "deny" } }, decider));
    for (const call of fake.calls("implementer")) {
      expect(call.args[call.args.indexOf("--permission-prompts") + 1]).toBe("none");
      expect(call.args).not.toContain("--input-format");
    }
  });

  it("sends Claude the images as blocks of a stream-json message and closes stdin when nobody answers prompts", async () => {
    const { shot, big, pdf } = attached();
    const r = await ask(runner(), "claude", [shot, pdf, big]);
    expect(r).toMatchObject({ ok: true, data: "Answer from claude." });
    const call = fake.calls("chat_claude")[0]!;
    expect(call.args).toEqual(expect.arrayContaining(["--input-format", "stream-json"]));
    expect(call.args[call.args.indexOf("--permission-prompts") + 1]).toBe("none");
    expect(call.prompt).toBe("[agentduo-conversation]\nWhat is in the files?");
    expect(call.images).toEqual([{ mediaType: "image/png", base64: 4 * Math.ceil(shot.size / 3), sha256: sha(shot) }]);
    // The image too large for Claude goes as its path only, said once before the call.
    const warnings = events.flatMap((e) => (e.type === "warning" ? [e.text] : []));
    expect(warnings).toEqual(["big.png goes to Claude as a file to read, not as an image: it is over 4.8 MB once encoded."]);
    await ask(runner(), "claude", [big], "002-ask");
    // The prompt log is the text as sent; no base64 in agentduo's logs.
    const logs = join(t.path, "logs");
    expect(readFileSync(join(logs, "001-ask.a1.prompt.md"), "utf8")).toBe("[agentduo-conversation]\nWhat is in the files?");
    const listed = JSON.parse(readFileSync(join(logs, "001-ask.a1.attachments.json"), "utf8")) as Array<{ name: string; image: boolean }>;
    expect(listed.map((x) => [x.name, x.image])).toEqual([["shot.png", true], ["spec.pdf", false], ["big.png", false]]);
    expect(readFileSync(join(logs, "001-ask.a1.cmd.json"), "utf8")).not.toMatch(/iVBOR/);
  });

  it("sends images in host mode too, and still answers every permission prompt", async () => {
    const { shot } = attached();
    fake.setScenario({ chat_claude: [{ permissions: [bashAsk("ls")], answer: "two files" }] });
    const { decider, asked } = scripted([{ decision: "once" }]);
    const r = await ask(runner({}, decider), "claude", [shot]);
    expect(r).toMatchObject({ ok: true, data: "two files" });
    expect(asked).toEqual(["Bash  ls"]);
    expect(fake.permissionAnswers()).toEqual([expect.objectContaining({ behavior: "allow" })]);
    expect(fake.calls("chat_claude")[0]!.images).toHaveLength(1);
  });

  it("gives Codex each image as --image=<path>, the prompt still on stdin", async () => {
    const { shot, big, pdf } = attached();
    const r = await ask(runner(), "codex", [shot, pdf, big]);
    expect(r.ok).toBe(true);
    const call = fake.calls("chat_codex")[0]!;
    expect(call.args.slice(-3)).toEqual([`--image=${existingAttachmentFile(join(t.path, "runs"), shot)}`, `--image=${existingAttachmentFile(join(t.path, "runs"), big)}`, "-"]);
    expect(call.prompt).toBe("[agentduo-conversation]\nWhat is in the files?");
    expect(call.images).toEqual([expect.objectContaining({ sha256: sha(shot) }), expect.objectContaining({ sha256: sha(big) })]);
    expect(events.some((e) => e.type === "warning")).toBe(false);
  });

  it("fails before the call when a copy is gone, on every attempt", async () => {
    const { shot, pdf } = attached();
    rmSync(existingAttachmentFile(join(t.path, "runs"), pdf));
    const r = await ask(runner(), "codex", [shot, pdf]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/spec\.pdf is no longer where agentduo kept it/);
    expect(fake.calls()).toEqual([]);
    fake.setScenario({ implementer: [{ output: impl() }] });
    const s = await runner().call({ role: "implementer", agentRole: "implementer", prompt: prompt("implementer"), schemaName: "implementation", logPrefix: "020", attachments: [pdf] });
    expect(s).toMatchObject({ ok: false, attempts: 1 });
    expect(fake.calls()).toEqual([]);
  });

  it("stops on abort", async () => {
    fake.setScenario({ planner: [{ output: plan(), sleep: 5000 }] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const r = await runner().call({ role: "planner", agentRole: "planner", prompt: prompt("planner"), schemaName: "plan", logPrefix: "007", signal: controller.signal });
    expect(r).toMatchObject({ ok: false, interrupted: true });
  });
});

describe("AgentRunner sessions", () => {
  const call = (r: AgentRunner, role: "planner" | "plan_reviewer", logPrefix: string, o: { attachments?: Attachment[]; session?: CallSession }) =>
    r.call({
      role, agentRole: role, prompt: `${prompt(role)}\nWHOLE`, schemaName: role === "planner" ? "plan" : "plan_critique", logPrefix, ...o,
    });

  it("continues a kept session with only what is new, and the files it was not given", async () => {
    fake.setScenario({ planner: [{ output: plan("v1") }, { output: plan("v2") }] });
    const r = runner();
    const { shot, pdf } = attached();
    const first = await call(r, "planner", "001-plan-r1", { attachments: [shot], session: { keep: true } });
    expect(first).toMatchObject({ ok: true, resumed: false, sessionId: fake.calls("planner")[0]!.session });
    expect(fake.calls("planner")[0]!.args).not.toContain("--ephemeral");
    const second = await call(r, "planner", "002-plan-r2", {
      attachments: [shot, pdf], session: { keep: true, resume: { id: first.sessionId!, prompt: `${prompt("planner")}\nNEW ONLY`, attachments: [] } },
    });
    expect(second).toMatchObject({ ok: true, resumed: true, attempts: 1, sessionId: first.sessionId });
    const continued = fake.calls("planner")[1]!;
    expect(continued.resumed).toBe(first.sessionId);
    expect(continued.prompt).toBe(`${prompt("planner")}\nNEW ONLY`);
    expect(continued.images).toBeUndefined();
    expect(readFileSync(join(t.path, "logs", "002-plan-r2.a1.prompt.md"), "utf8")).toContain("NEW ONLY");
  });

  it("starts a fresh session with the whole prompt when the CLI lost the one to continue, without costing a retry", async () => {
    fake.setScenario({ sessions: { lost: true }, planner: [{ output: plan() }], plan_reviewer: [{ output: critique(true) }] });
    const r = runner({ limits: { max_retries: 0 } });
    const { shot } = attached();
    for (const role of ["planner", "plan_reviewer"] as const) {
      const res = await call(r, role, `001-${role}`, { attachments: [shot], session: { keep: true, resume: { id: `gone-${role}`, prompt: `${prompt(role)}\nNEW ONLY` } } });
      expect(res, role).toMatchObject({ ok: true, resumed: false, attempts: 2 });
      const [lost, fresh] = fake.calls(role);
      expect([lost!.resumed, lost!.lost], role).toEqual([`gone-${role}`, true]);
      expect(fresh!.resumed, role).toBeUndefined();
      // The fresh session never saw the lost attempt: the whole prompt, its files, and no rejection note.
      expect(fresh!.prompt, role).toBe(`${prompt(role)}\nWHOLE`);
      expect(fresh!.images, role).toHaveLength(1);
      expect(res.sessionId, role).toBe(fresh!.session);
    }
    const retries = events.filter((e) => e.type === "agent.retry");
    expect(retries).toHaveLength(2);
    expect(retries[0]).toMatchObject({ attempt: 2, max: 2, reason: expect.stringContaining("the earlier session could not be continued (codex exited with code 1") });
    expect(retries[1]).toMatchObject({ reason: expect.stringContaining("No conversation found with session ID: gone-plan_reviewer") });
  });

  it("tells the fresh session after a rejected continued answer why it was rejected, with that answer", async () => {
    fake.setScenario({ planner: [{ output: plan("v1") }, { output: plan("v2") }, { output: plan("v3") }] });
    const r = runner();
    const first = await call(r, "planner", "001-plan-r1", { session: { keep: true } });
    const res = await r.call({
      role: "planner", agentRole: "planner", prompt: `${prompt("planner")}\nWHOLE`, schemaName: "plan", logPrefix: "002-plan-r2",
      check: (p: { title: string }) => (p.title === "v2" ? ["acceptance criterion 'AC1' is listed twice: give each criterion its own id"] : []),
      session: { keep: true, resume: { id: first.sessionId!, prompt: `${prompt("planner")}\nNEW ONLY` } },
    });
    expect(res).toMatchObject({ ok: true, resumed: false, attempts: 2, rejections: [{ attempt: 1, errors: ["acceptance criterion 'AC1' is listed twice: give each criterion its own id"] }] });
    const fresh = fake.calls("planner")[2]!;
    expect(fresh.resumed).toBeUndefined();
    // The whole prompt, the reasons, and the answer it rejected: the new session corrects it rather than starting over.
    expect(fresh.prompt).toContain(`${prompt("planner")}\nWHOLE\n\n## Your previous answer was rejected\nagentduo checked your previous answer to this request, given in ` +
      "a session you cannot see, and rejected it:\n- acceptance criterion 'AC1' is listed twice");
    expect(fresh.prompt).toContain('"title": "v2"');
    const retry = events.find((e) => e.type === "agent.retry");
    expect(retry).toMatchObject({ attempt: 2, reason: expect.stringContaining("the continued session's answer was rejected (output failed validation:\n- acceptance criterion 'AC1'") });
  });

  const turn = (r: AgentRunner, backend: "codex" | "claude", logPrefix: string, o: { attachments?: Attachment[]; session?: CallSession } = {}) =>
    r.call({ mode: "text", backend, prompt: "[agentduo-conversation]\nWHOLE", logPrefix, conversationId: "c1", turnId: `c1-${logPrefix}`, ...o });

  it("keeps a conversation turn's session and continues it with only the new prompt and its files", async () => {
    fake.setScenario({ chat: [{ answer: "first" }, { answer: "second" }] });
    const r = runner();
    const { shot } = attached();
    for (const backend of ["codex", "claude"] as const) {
      const first = await turn(r, backend, `001-${backend}`, { session: { keep: true } });
      expect(first, backend).toMatchObject({ ok: true, resumed: false, sessionId: fake.calls(`chat_${backend}`)[0]!.session });
      expect(fake.calls(`chat_${backend}`)[0]!.args, backend).not.toContain(backend === "codex" ? "--ephemeral" : "--no-session-persistence");
      const second = await turn(r, backend, `002-${backend}`, {
        attachments: [shot], session: { keep: true, resume: { id: first.sessionId!, prompt: "[agentduo-conversation]\nNEW ONLY", attachments: [shot] } },
      });
      expect(second, backend).toMatchObject({ ok: true, resumed: true, attempts: 1, calls: 1, sessionId: first.sessionId });
      const continued = fake.calls(`chat_${backend}`)[1]!;
      expect([continued.resumed, continued.prompt, continued.images?.length], backend).toEqual([first.sessionId, "[agentduo-conversation]\nNEW ONLY", 1]);
    }
    expect(events.filter((e) => e.type === "warning")).toEqual([]);
  });

  it("asks a conversation turn whose session is lost again in a new one, with the whole prompt and its files, and says so", async () => {
    fake.setScenario({ sessions: { lost: true }, chat: [{ answer: "fresh" }] });
    const r = runner();
    const { shot } = attached();
    for (const backend of ["codex", "claude"] as const) {
      const res = await turn(r, backend, `001-${backend}`, {
        attachments: [shot], session: { keep: true, resume: { id: `gone-${backend}`, prompt: "[agentduo-conversation]\nNEW ONLY", attachments: [] } },
      });
      expect(res, backend).toMatchObject({ ok: true, resumed: false, attempts: 2, data: "fresh" });
      const [lost, fresh] = fake.calls(`chat_${backend}`);
      expect([lost!.resumed, lost!.lost], backend).toEqual([`gone-${backend}`, true]);
      expect([fresh!.resumed, fresh!.prompt, fresh!.images?.length], backend).toEqual([undefined, "[agentduo-conversation]\nWHOLE", 1]);
      expect(res.sessionId, backend).toBe(fresh!.session);
    }
    // A conversation turn has no retries to show: a warning says why it takes a second call.
    expect(events.filter((e) => e.type === "agent.retry")).toEqual([]);
    expect(events.flatMap((e) => (e.type === "warning" ? [e.text] : []))).toEqual([
      expect.stringMatching(/^Codex could not answer in this conversation's session \(codex exited with code 1: Error: thread\/resume.*\), so it is asked again in a new one, with the whole conversation\.$/),
      expect.stringMatching(/^Claude could not answer in this conversation's session \(.*No conversation found with session ID: gone-claude.*\), so it is asked again in a new one, with the whole conversation\.$/),
    ]);
  });

  it("ends a continued conversation turn that timed out or went silent: a CLI that hangs is no lost session, and a new one would wait again", async () => {
    for (const limit of ["agent_timeout_sec", "agent_idle_timeout_sec"] as const) {
      fake.restore();
      fake = new FakeClis(join(t.path, limit)).install();
      fake.setScenario({ chat_codex: [{ answer: "one" }, { sleep: 5_000, answer: "slow" }] });
      const r = runner({ limits: { [limit]: 1 } });
      const first = await turn(r, "codex", `001-${limit}`, { session: { keep: true } });
      const started = Date.now();
      const res = await turn(r, "codex", `002-${limit}`, { session: { keep: true, resume: { id: first.sessionId!, prompt: "[agentduo-conversation]\nNEW ONLY" } } });
      expect(res, limit).toMatchObject({ ok: false, attempts: 1, calls: 1, error: expect.stringMatching(/timed out|no output/) });
      expect(Date.now() - started, limit).toBeLessThan(4_000);
      expect(fake.calls("chat_codex"), limit).toHaveLength(2);
    }
  });

  it("keeps each conversation turn's session off disk", async () => {
    const r = runner();
    for (const backend of ["codex", "claude"] as const) {
      await r.call({ mode: "text", backend, prompt: "[agentduo-conversation]\nhi", logPrefix: `001-${backend}`, conversationId: "c1", turnId: `t-${backend}` });
    }
    const [codex, claude] = fake.calls();
    expect(codex!.args).toContain("--ephemeral");
    expect(claude!.args).toContain("--no-session-persistence");
  });
});

describe("AgentRunner and the run's budget", () => {
  const plannerCall = (r: AgentRunner, budget: CallBudget, logPrefix = "001-plan-r1") =>
    r.call({ role: "planner", agentRole: "planner", prompt: prompt("planner"), schemaName: "plan", logPrefix, budget });

  it("starts no attempt once the budget stops it, retries included, and says why", async () => {
    fake.setScenario({ planner: [{ raw: "not json" }, { output: plan() }] });
    const r = runner({ limits: { max_retries: 3 } });
    const seen: Array<{ tokens: number; costUsd: number; calls: number }> = [];
    const res = await plannerCall(r, { stop: (call) => (seen.push(call), call.calls >= 1 ? "the run reached its budget" : null), costCap: () => null });
    expect(res).toMatchObject({ ok: false, budgetStop: "the run reached its budget", error: "the run reached its budget", attempts: 1, calls: 1, unpricedCalls: 1 });
    expect(seen).toEqual([{ tokens: 0, costUsd: 0, calls: 0, waitedSec: 0 }, { tokens: 1234, costUsd: 0, calls: 1, waitedSec: 0 }]);
    expect(fake.calls("planner")).toHaveLength(1);
    const before = await plannerCall(r, { stop: () => "no budget left", costCap: () => null }, "002-plan-r1");
    expect(before).toMatchObject({ ok: false, attempts: 0, calls: 0, budgetStop: "no budget left" });
    expect(fake.calls("planner")).toHaveLength(1);
  });

  it("counts every CLI call, and those that reported no cost; caps Claude's at what is left", async () => {
    fake.setScenario({ planner: [{ raw: "not json" }, { output: plan() }], plan_reviewer: [{ output: critique(true) }] });
    const r = runner();
    const caps: number[] = [];
    const budget: CallBudget = { stop: () => null, costCap: (spent) => (caps.push(spent), 0.42) };
    expect(await plannerCall(r, budget)).toMatchObject({ ok: true, calls: 2, unpricedCalls: 2, costUsd: null });
    const critic = await r.call({ role: "plan_reviewer", agentRole: "plan_reviewer", prompt: prompt("plan_reviewer"), schemaName: "plan_critique", logPrefix: "003-review", budget });
    expect(critic).toMatchObject({ ok: true, calls: 1, unpricedCalls: 0, costUsd: 0.01 });
    const args = fake.calls("plan_reviewer")[0]!.args;
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("0.42");
    expect(fake.calls("planner")[0]!.args).not.toContain("--max-budget-usd");
  });
});


describe("AgentRunner and the questions Claude asks", () => {
  const flag = {
    questions: [
      { question: "Which flag should the build use?", header: "Flag", multiSelect: false, options: [{ label: "--fast", description: "skips the slow checks" }, { label: "--safe", description: "keeps every check" }] },
      { question: "Which targets?", header: "Targets", multiSelect: true, options: [{ label: "web", description: "browser" }, { label: "cli", description: "terminal" }, { label: "api", description: "server" }] },
    ],
  };
  const withUser = (o: ConfigOverrides, o2: { permissions?: PermissionDecider; clarifications?: ClarificationDecider }) =>
    new AgentRunner(testConfig(fake, o), t.path, join(t.path, "logs"), bus, { ...o2, runsDir: join(t.path, "runs") });
  /** A decider that answers `respond` after `delayMs`, and records the requests and the abort signals it was given. */
  const user = (respond: (r: ClarificationRequest) => ClarificationResponse, delayMs = 0) => {
    const seen: ClarificationRequest[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    const decider: ClarificationDecider = {
      askClarification: async ({ request }, signal) => {
        seen.push(request);
        signals.push(signal);
        await new Promise((r) => setTimeout(r, delayMs));
        return respond(request);
      },
    };
    return { decider, seen, signals };
  };
  const choose = (labels: Record<string, string[]>, other: Record<string, string> = {}) => (r: ClarificationRequest): ClarificationResponse => ({
    kind: "answered",
    answers: r.questions.map((q) => ({
      questionId: q.id, optionIds: q.options.filter((o) => (labels[q.id] ?? []).includes(o.label)).map((o) => o.id), otherText: other[q.id] ?? null,
    })),
  });
  const closed = () => events.flatMap((e) => (e.type === "clarification.closed" ? [e.status] : []));

  it("sends the question to the user whole, apart from permissions, and answers it in the same call with the labels chosen", async () => {
    fake.setScenario({ implementer: [{ questions: [flag], output: impl() }] });
    const { decider, seen } = user(choose({ q1: ["--safe"], q2: ["web", "api"] }));
    const r = await implement(withUser({}, { clarifications: decider }));
    expect(r.ok, r.error ?? "").toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ source: "claude", agent: "claude", role: "implementer", callId: "020-implement-r1.a1" });
    expect(seen[0]!.questions.map((q) => [q.id, q.header, q.question, q.multiSelect, q.options.map((o) => [o.id, o.label, o.description])])).toEqual([
      ["q1", "Flag", "Which flag should the build use?", false, [["q1o1", "--fast", "skips the slow checks"], ["q1o2", "--safe", "keeps every check"]]],
      ["q2", "Targets", "Which targets?", true, [["q2o1", "web", "browser"], ["q2o2", "cli", "terminal"], ["q2o3", "api", "server"]]],
    ]);
    // Claude's own protocol (verified on 2.1.318): its input back, with `answers` keyed by the question's text, a multiple choice comma-separated.
    expect(fake.questionReplies()).toEqual([{ behavior: "allow", updatedInput: { ...flag, answers: { "Which flag should the build use?": "--safe", "Which targets?": "web, api" } } }]);
    // It is a question, never a permission: no permission event and no "always allow" to offer.
    expect(events.some((e) => e.type.startsWith("permission."))).toBe(false);
    expect(events.map((e) => e.type).filter((x) => x.startsWith("clarification."))).toEqual(["clarification.requested", "clarification.answered"]);
    expect(fake.calls("implementer")).toHaveLength(1);
    expect(r.meta.permissionDenials).toEqual([]);
  });

  it("gives the user's own words, alone or with options, as the answer's text", async () => {
    fake.setScenario({ implementer: [{ questions: [flag], output: impl() }] });
    const { decider } = user(choose({ q2: ["cli"] }, { q1: "neither: use --profile ci", q2: "and the docs site" }));
    await implement(withUser({}, { clarifications: decider }));
    expect(fake.questionReplies()[0]!.updatedInput!.answers).toEqual({ "Which flag should the build use?": "neither: use --profile ci", "Which targets?": "cli, and the docs site" });
  });

  it("uses host mode for the questions alone, keeps denying every other tool request, and offers nothing when neither is on", async () => {
    fake.setScenario({ implementer: [{ questions: [flag], permissions: [bashAsk("rm -rf build")], output: impl() }] });
    const { decider } = user(choose({ q1: ["--fast"], q2: ["cli"] }));
    // permission_prompts: deny, no permission decider: the questions still reach the user; the tool request does not.
    const r = await implement(withUser({ claude: { permission_prompts: "deny" } }, { clarifications: decider }));
    expect(r.ok, r.error ?? "").toBe(true);
    const args = fake.calls("implementer")[0]!.args;
    expect(args[args.indexOf("--permission-prompts") + 1]).toBe("host");
    expect(args).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--permission-prompt-tool", "stdio"]));
    expect(fake.permissionAnswers().map((a) => [a.behavior, a.message ?? ""])).toEqual([["deny", expect.stringContaining("permission prompts are off")]]);
    expect(events.some((e) => e.type === "permission.requested")).toBe(false);
    // No rule, mode or flag was added on the way.
    expect(args.filter((a) => /allowedTools|permission-mode|dangerously/.test(a))).toEqual(args.filter((a) => /permission-mode/.test(a)));

    // The setting off: back to the host mode of the permission setting alone.
    fake.setScenario({ implementer: [{ output: impl() }] });
    await implement(withUser({ clarification: { enabled: false } }, { clarifications: decider }));
    const off = fake.calls("implementer")[1]!.args;
    expect(off[off.indexOf("--permission-prompts") + 1]).toBe("none");
    // Both on, with both deciders: the permission prompt still goes to the permission decider, the question to the clarification one.
    fake.setScenario({ implementer: [{ questions: [flag], permissions: [bashAsk("npm test")], output: impl() }] });
    const asked = scripted([{ decision: "once" }]);
    await implement(withUser({ claude: { permission_prompts: "ask" } }, { clarifications: decider, permissions: asked.decider }));
    expect(asked.asked).toEqual(["Bash  npm test"]);
    expect(fake.questionReplies()).toHaveLength(2);
  });

  it("does not offer the tool to Codex, nor to a Claude call nobody can answer", async () => {
    fake.setScenario({ planner: [{ output: plan() }], implementer: [{ output: impl() }] });
    const { decider } = user(choose({}));
    await runner({ agents: { planner: "codex" } }).call({ role: "planner", agentRole: "planner", prompt: prompt("planner"), schemaName: "plan", logPrefix: "001-plan-r1" });
    await implement(runner());
    for (const call of fake.calls()) expect(call.args).not.toContain("--input-format");
    expect(decider).toBeDefined();
  });

  it("stops the clocks while the user thinks: neither the whole-call nor the idle limit ends a call that waits for an answer", async () => {
    fake.setScenario({ implementer: [{ questions: [flag], output: impl() }] });
    const { decider } = user(choose({ q1: ["--fast"], q2: ["cli"] }), 2500);
    const r = await implement(withUser({ limits: { max_retries: 0, agent_idle_timeout_sec: 1, agent_timeout_sec: 2 } }, { clarifications: decider }));
    expect(r.ok, r.error ?? "").toBe(true);
    // The wait is told, not counted: what the call reports as waited is about what the user took.
    expect(r.waitedSec).toBeGreaterThan(2.3);
    expect(r.waitedSec).toBeLessThan(5);
  });

  it("counts a wait over several questions once, and the same wait twice never", async () => {
    fake.setScenario({ implementer: [{ questions: [flag, flag], output: impl() }] });
    const { decider } = user(choose({ q1: ["--fast"], q2: ["cli"] }), 300);
    const r = await implement(withUser({}, { clarifications: decider }));
    expect(r.ok, r.error ?? "").toBe(true);
    expect(fake.questionReplies()).toHaveLength(2);
    expect(r.waitedSec).toBeGreaterThan(0.55);
    expect(r.waitedSec).toBeLessThan(2);
  });

  it("ends the call and records the question interrupted when the user would answer later; nothing is written to a process that goes away", async () => {
    fake.setScenario({ implementer: [{ questions: [flag], afterQuestion: 10_000, output: impl() }] });
    const { decider } = user(() => ({ kind: "defer" }));
    const r = await implement(withUser({}, { clarifications: decider }));
    expect(r).toMatchObject({ ok: false, interrupted: true });
    expect(closed()).toEqual(["interrupted"]);
    expect(fake.questionReplies()).toEqual([]);
    // The process is gone, and no retry ran for a question nobody answered.
    expect(fake.calls("implementer")).toHaveLength(1);
    expect(events.some((e) => e.type === "clarification.answered")).toBe(false);
  });

  it("releases the waiting user and the process when the call is aborted while it waits, and no late answer is written", async () => {
    fake.setScenario({ implementer: [{ questions: [flag], output: impl() }] });
    const controller = new AbortController();
    let release: (r: ClarificationResponse) => void = () => undefined;
    const signals: Array<AbortSignal | undefined> = [];
    const decider: ClarificationDecider = {
      askClarification: ({ request: _r }, signal) => {
        signals.push(signal);
        return new Promise((resolve) => { release = resolve; setTimeout(() => controller.abort(), 150); });
      },
    };
    const r = await implement2(withUser({}, { clarifications: decider }), controller.signal);
    expect(r).toMatchObject({ ok: false, interrupted: true });
    expect(signals[0]!.aborted).toBe(true);
    expect(closed()).toEqual(["interrupted"]);
    // The user answers after all, too late: nothing is written, nothing is recorded as answered.
    release(choose({ q1: ["--fast"], q2: ["cli"] })({ questions: flag.questions.map((q, i) => ({ id: `q${i + 1}`, header: q.header, question: q.question, multiSelect: q.multiSelect, options: q.options.map((o, j) => ({ id: `q${i + 1}o${j + 1}`, ...o })) })) } as ClarificationRequest));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.questionReplies()).toEqual([]);
    expect(events.some((e) => e.type === "clarification.answered")).toBe(false);
  });

  it("tells Claude, not the user, when a question cannot be shown, and when the answers do not fit", async () => {
    fake.setScenario({ implementer: [{ questions: [{ questions: [{ question: "One option only?", header: "x", multiSelect: false, options: [{ label: "yes", description: "" }] }] }], output: impl() }] });
    const { decider, seen } = user(choose({}));
    await implement(withUser({}, { clarifications: decider }));
    expect(seen).toEqual([]);
    expect(fake.questionReplies()).toEqual([{ behavior: "deny", message: expect.stringContaining("could not show this question to the user (question 1: needs 2 to 6 options)") }]);

    const wrong = user(() => ({ kind: "answered", answers: [{ questionId: "q1", optionIds: ["q9o9"], otherText: null }] }));
    fake.setScenario({ implementer: [{ questions: [flag], output: impl() }] });
    await implement(withUser({}, { clarifications: wrong.decider }));
    expect(fake.questionReplies().at(-1)).toMatchObject({ behavior: "deny", message: expect.stringContaining("did not match the questions") });
    expect(closed()).toContain("cancelled");
  });

  it("treats a decider that fails as a question put off, and a dismissal as a refusal Claude is told about", async () => {
    fake.setScenario({ implementer: [{ questions: [flag], afterQuestion: 10_000, output: impl() }] });
    const failing: ClarificationDecider = { askClarification: async () => { throw new Error("the window closed"); } };
    expect(await implement(withUser({}, { clarifications: failing }))).toMatchObject({ interrupted: true });
    expect(closed()).toEqual(["interrupted"]);

    events.length = 0;
    fake.setScenario({ implementer: [{ questions: [flag], output: impl() }] });
    const dismiss = user(() => ({ kind: "cancelled" }));
    const r = await implement(withUser({}, { clarifications: dismiss.decider }));
    expect(r.ok, r.error ?? "").toBe(true);
    expect(fake.questionReplies().at(-1)).toMatchObject({ behavior: "deny", message: expect.stringContaining("dismissed the question") });
    expect(closed()).toEqual(["cancelled"]);
    expect(r.meta.permissionDenials).toEqual([]);
  });

  it("asks a chat turn's question for the turn, and numbers nothing to a run", async () => {
    fake.setScenario({ chat_claude: [{ questions: [flag], answer: "the build uses --fast" }] });
    const { decider, seen } = user(choose({ q1: ["--fast"], q2: ["web"] }));
    const r = await withUser({}, { clarifications: decider }).call({
      mode: "text", backend: "claude", prompt: "[agentduo-conversation]\nhow?", logPrefix: "001-claude", conversationId: "c1", turnId: "c1-t1",
    });
    expect(r).toMatchObject({ ok: true, data: "the build uses --fast" });
    expect(seen[0]).toMatchObject({ source: "claude", turnId: "c1-t1", callId: "001-claude.a1" });
    expect(seen[0]!.role).toBeUndefined();
  });

  describe("an attempt that failed after the user answered it", () => {
    const pairs = "- [Flag] Which flag should the build use?\n  → --safe\n- [Targets] Which targets?\n  → web, api";
    const seenBefore = "this session did not see the answers";
    const roles = { callOf: (n: number) => fake.calls("implementer")[n]! };

    it("gives the retry's new session the answers, so it does not ask again or go without them", async () => {
      fake.setScenario({ implementer: [{ questions: [flag], exit: 1, output: impl() }, { output: impl() }] });
      const { decider, seen } = user(choose({ q1: ["--safe"], q2: ["web", "api"] }));
      const r = await implement(withUser({}, { clarifications: decider }));
      expect(r, r.error ?? "").toMatchObject({ ok: true, attempts: 2, calls: 2 });
      expect(seen).toHaveLength(1);
      expect(roles.callOf(0).prompt).not.toContain("already answered");
      const retry = roles.callOf(1).prompt;
      expect(retry).toContain("What the user already answered during an earlier attempt of this request");
      expect(retry).toContain(seenBefore);
      expect(retry).toContain(pairs);
      // Information, not permission: the guard that goes with every answer goes with these.
      expect(retry).toContain("never waive a check, a review or a limit");
      // The prompt of the attempt as the agent got it is logged with them.
      expect(readFileSync(join(t.path, "logs", "020-implement-r1.a2.prompt.md"), "utf8")).toContain(pairs);
    });

    it("gives them also to the retry of an answer agentduo rejected, next to what to correct", async () => {
      fake.setScenario({ implementer: [{ questions: [flag], output: { status: "not a status" } }, { output: impl() }] });
      const { decider } = user(choose({ q1: ["--safe"], q2: ["web", "api"] }));
      const r = await implement(withUser({}, { clarifications: decider }));
      expect(r, r.error ?? "").toMatchObject({ ok: true, attempts: 2 });
      const retry = roles.callOf(1).prompt;
      expect(retry).toContain("## Your previous answer was rejected");
      expect(retry).toContain(pairs);
    });

    it("gives them to every later attempt, also the ones that are asked nothing themselves", async () => {
      fake.setScenario({ implementer: [{ questions: [flag], exit: 1, output: impl() }, { exit: 1, output: impl() }, { output: impl() }] });
      const { decider } = user(choose({ q1: ["--safe"], q2: ["web", "api"] }));
      const r = await implement(withUser({ limits: { max_retries: 2 } }, { clarifications: decider }));
      expect(r, r.error ?? "").toMatchObject({ ok: true, attempts: 3 });
      expect(roles.callOf(1).prompt).toContain(pairs);
      expect(roles.callOf(2).prompt).toContain(pairs);
      expect(roles.callOf(2).prompt.split("What the user already answered").length - 1).toBe(1);
    });

    it("gives the fresh session after a continued one that was answered and then failed the whole prompt with the answers, not the new-only one", async () => {
      fake.setScenario({ chat_claude: [{ answer: "first" }, { questions: [flag], exit: 1 }, { answer: "fresh" }] });
      const { decider } = user(choose({ q1: ["--safe"], q2: ["web", "api"] }));
      const r = withUser({}, { clarifications: decider });
      const call = (logPrefix: string, session: CallSession) =>
        r.call({ mode: "text", backend: "claude", prompt: "[agentduo-conversation]\nWHOLE", logPrefix, conversationId: "c1", turnId: `c1-${logPrefix}`, session });
      const first = await call("001-claude", { keep: true });
      const second = await call("002-claude", { keep: true, resume: { id: first.sessionId!, prompt: "[agentduo-conversation]\nNEW ONLY" } });
      expect(second).toMatchObject({ ok: true, resumed: false, attempts: 2, data: "fresh" });
      const [, continued, fresh] = fake.calls("chat_claude");
      expect(continued!.resumed).toBe(first.sessionId);
      expect(continued!.prompt).toBe("[agentduo-conversation]\nNEW ONLY");
      expect(fresh!.resumed).toBeUndefined();
      expect(fresh!.prompt).toContain("[agentduo-conversation]\nWHOLE");
      expect(fresh!.prompt).toContain(pairs);
    });

    it("adds nothing to a call that was not answered anything, or whose question was dismissed", async () => {
      fake.setScenario({ implementer: [{ questions: [flag], exit: 1, output: impl() }, { output: impl() }] });
      const dismiss = user(() => ({ kind: "cancelled" }));
      const r = await implement(withUser({}, { clarifications: dismiss.decider }));
      expect(r.ok, r.error ?? "").toBe(true);
      expect(roles.callOf(1).prompt).not.toContain("already answered");
    });
  });
});

const implement2 = (r: AgentRunner, signal: AbortSignal) =>
  r.call({ role: "implementer", agentRole: "implementer", prompt: prompt("implementer"), schemaName: "implementation", logPrefix: "020-implement-r1", signal });
