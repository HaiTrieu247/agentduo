import { describe, expect, it } from "vitest";
import {
  budgetView, configLimits, costLeft, ensureBudget, exhaustedMessage, newWarnings, raiseReached, reachedLimits, usageOf,
} from "../../src/workflow/budget.js";
import { defaultConfig, type ConfigData } from "../../src/config/config.js";
import { newState, type RunState } from "../../src/workflow/state.js";

const cfgWith = (limits: Partial<ConfigData["limits"]>): ConfigData => {
  const cfg = defaultConfig();
  Object.assign(cfg.limits, limits);
  return cfg;
};
const state = (o: Partial<RunState> = {}): RunState => ({ ...newState("t1", "task", { max_planning_rounds: 4, max_review_rounds: 5 }), ...o });

describe("run budget", () => {
  it("has no limit by default, and a run without one takes the limits of the config it runs with", () => {
    const st = state();
    expect(ensureBudget(st, defaultConfig())).toBeNull();
    expect(st.budget).toBeUndefined();
    expect(budgetView(st)).toBeNull();
    const budget = ensureBudget(st, cfgWith({ max_run_tokens: 1000, max_run_minutes: 30 }));
    expect(budget).toEqual({ limits: { tokens: 1000, cost: null, calls: null, minutes: 30 }, warned: [] });
    // Once it has one, its own limits stay, whatever a later config says.
    expect(ensureBudget(st, cfgWith({ max_run_tokens: 99 }))!.limits.tokens).toBe(1000);
  });

  it("adds up what the run used, with what a call under way used so far", () => {
    const st = state({ tokens: 900, costUsd: 0.5, agentCalls: 3, activeSec: 90, budget: { limits: configLimits(cfgWith({ max_run_tokens: 1000, max_run_agent_calls: 4 })), warned: [] } });
    expect(usageOf(st)).toEqual({ tokens: 900, cost: 0.5, calls: 3, minutes: 1.5 });
    expect(reachedLimits(st.budget, usageOf(st))).toEqual([]);
    expect(reachedLimits(st.budget, usageOf(st, { tokens: 100, calls: 1 }))).toEqual(["tokens", "calls"]);
  });

  it("warns once per limit at 80%, not once it is reached, and again only after it was raised", () => {
    const st = state({ agentCalls: 7, tokens: 100, budget: { limits: { tokens: 1000, cost: null, calls: 10, minutes: null }, warned: [] } });
    expect(newWarnings(st)).toEqual([]);
    st.agentCalls = 8;
    expect(newWarnings(st)).toEqual(["budget: 8 of 10 agent calls used (80%, limits.max_run_agent_calls); the run stops for your decision when it is reached"]);
    expect(newWarnings(st)).toEqual([]);
    st.tokens = 1000;
    expect(newWarnings(st)).toEqual([]);
    st.agentCalls = 10;
    raiseReached(st, cfgWith({ max_run_agent_calls: 10, max_run_tokens: 1000 }));
    expect(st.budget!.limits).toMatchObject({ calls: 20, tokens: 2000 });
    st.agentCalls = 17;
    expect(newWarnings(st)).toHaveLength(1);
  });

  it("raises each limit reached by one allowance of the config, and lifts it when the config sets none", () => {
    const st = state({ tokens: 1200, costUsd: 2.013, agentCalls: 5, budget: { limits: { tokens: 1000, cost: 2, calls: 40, minutes: null }, warned: ["tokens"] } });
    expect(raiseReached(st, cfgWith({ max_run_tokens: 1000, max_run_cost_usd: 2, max_run_agent_calls: 40 }))).toEqual(["tokens limit raised to 2200", "cost limit raised to 4.02"]);
    expect(st.budget).toEqual({ limits: { tokens: 2200, cost: 4.02, calls: 40, minutes: null }, warned: [] });
    st.tokens = 2200;
    expect(raiseReached(st, defaultConfig())).toEqual(["tokens: no limit"]);
    expect(st.budget!.limits.tokens).toBeNull();
  });

  it("leaves a Claude call the cost left, in whole cents and never less than one", () => {
    expect(costLeft(state())).toBeNull();
    const st = state({ costUsd: 1.234, budget: { limits: { tokens: null, cost: 2, calls: null, minutes: null }, warned: [] } });
    expect(costLeft(st)).toBe(0.76);
    expect(costLeft(st, 0.5)).toBe(0.26);
    expect(costLeft(st, 5)).toBe(0.01);
  });

  it("says what was reached, how exactly each limit holds, and that unpriced calls are not in the cost", () => {
    const st = state({ tokens: 512_340, costUsd: 1.2, agentCalls: 9, unpricedCalls: 4, budget: { limits: { tokens: 500_000, cost: 5, calls: null, minutes: null }, warned: [] } });
    const used = usageOf(st);
    const { message, details } = exhaustedMessage(st, reachedLimits(st.budget, used), used);
    expect(message).toContain("the run reached its budget: 512,340 of 500,000 tokens (limits.max_run_tokens)");
    expect(message).toContain("'resume' allows one more allowance");
    expect(details).toEqual([
      "512,340 of 500,000 tokens: reached (tokens are known when a call ends, so the call that crossed the limit finished past it)",
      "$1.20 of $5.00 reported cost",
      "4 agent call(s) reported no cost (Codex never does): the run's real cost is higher than the reported one",
    ]);
    expect(budgetView(st)).toEqual({ lines: [{ key: "tokens", used: 512_340, limit: 500_000 }, { key: "cost", used: 1.2, limit: 5 }], unpricedCalls: 4 });
  });
});
