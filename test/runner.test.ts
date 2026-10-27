import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agents/runner.js";
import { EventBus, type DuoEvent, type PermissionAnswer, type PermissionDecider } from "../src/events.js";
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
  new AgentRunner(testConfig(fake, o), t.path, join(t.path, "logs"), bus, { permissions });
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
    expect(fake.calls("plan_reviewer")[1]!.prompt).toContain("Previous attempt was rejected");
  });

  it("applies the semantic check and gives up after max_retries", async () => {
    fake.setScenario({ plan_reviewer: [{ output: critique(true) }] });
    const r = await runner().call({ role: "plan_reviewer", agentRole: "plan_reviewer", prompt: prompt("plan_reviewer"),
      schemaName: "plan_critique", logPrefix: "003", check: () => ["nope"] });
    expect(r).toMatchObject({ ok: false, attempts: 2 });
    expect(r.error).toContain("nope");
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

  it("stops on abort", async () => {
    fake.setScenario({ planner: [{ output: plan(), sleep: 5000 }] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const r = await runner().call({ role: "planner", agentRole: "planner", prompt: prompt("planner"), schemaName: "plan", logPrefix: "007", signal: controller.signal });
    expect(r).toMatchObject({ ok: false, interrupted: true });
  });
});
