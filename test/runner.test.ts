import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agents/runner.js";
import { EventBus, type DuoEvent } from "../src/events.js";
import { critique, plan } from "./helpers/builders.js";
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

const runner = (o: ConfigOverrides = {}) => new AgentRunner(testConfig(fake, o), t.path, join(t.path, "logs"), bus);
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

  it("stops on abort", async () => {
    fake.setScenario({ planner: [{ output: plan(), sleep: 5000 }] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const r = await runner().call({ role: "planner", agentRole: "planner", prompt: prompt("planner"), schemaName: "plan", logPrefix: "007", signal: controller.signal });
    expect(r).toMatchObject({ ok: false, interrupted: true });
  });
});
