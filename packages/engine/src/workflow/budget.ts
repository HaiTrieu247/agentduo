import type { BudgetKey, BudgetLine, BudgetView } from "../events.js";
import type { ConfigData } from "../config/config.js";
import type { RunBudget, RunState } from "./state.js";

/**
 * A pipeline run's budget (limits.max_run_*): what it may use across all its phases, rounds and retries, how much it
 * used, and what happens when a limit is near or reached. See docs/superpowers/specs/2026-11-03-agentduo-run-budget-design.md.
 *
 * How exactly each limit holds:
 * - calls: exact. Checked before every agent CLI call, so the run never starts one past it.
 * - minutes: no step or agent call starts past it; one already running finishes (at most agent_timeout_sec later).
 * - tokens: known only when a call ends, so the call that crosses the limit finishes past it.
 * - cost: what the CLIs report. A Claude call is capped by Claude itself at the cost left (--max-budget-usd), so it
 *   ends close to the limit; Codex reports no cost, so its calls are counted as unpriced and are not in it.
 */

export const BUDGET_KEYS: BudgetKey[] = ["tokens", "cost", "calls", "minutes"];

/** The config key of each limit. */
export const BUDGET_CONFIG: Record<BudgetKey, keyof ConfigData["limits"]> = {
  tokens: "max_run_tokens", cost: "max_run_cost_usd", calls: "max_run_agent_calls", minutes: "max_run_minutes",
};

/** Share of a limit at which the run warns once. */
export const WARN_AT = 0.8;

/** What a run has used, all phases and retries together. */
export type BudgetUsage = Record<BudgetKey, number>;

/** The limits a config sets, by budget key. */
export function configLimits(cfg: ConfigData): RunBudget["limits"] {
  const limits = {} as RunBudget["limits"];
  for (const key of BUDGET_KEYS) limits[key] = (cfg.limits[BUDGET_CONFIG[key]] as number | null | undefined) ?? null;
  return limits;
}

/**
 * The budget a run works with: its own once it has one. A run without one (older, or started with no limit set) takes
 * the limits of the config it runs with now, if that sets any.
 */
export function ensureBudget(state: RunState, cfg: ConfigData): RunBudget | null {
  if (state.budget) return state.budget;
  const limits = configLimits(cfg);
  if (BUDGET_KEYS.every((k) => limits[k] === null)) return null;
  state.budget = { limits, warned: [] };
  return state.budget;
}

/** What the run used, plus what a call or step under way has used so far (`extra`). */
export function usageOf(state: RunState, extra: Partial<BudgetUsage> = {}): BudgetUsage {
  return {
    tokens: state.tokens + (extra.tokens ?? 0),
    cost: state.costUsd + (extra.cost ?? 0),
    calls: (state.agentCalls ?? 0) + (extra.calls ?? 0),
    minutes: ((state.activeSec ?? 0) / 60) + (extra.minutes ?? 0),
  };
}

/** The limits that are reached (used >= limit), in BUDGET_KEYS order. */
export function reachedLimits(budget: RunBudget | null | undefined, used: BudgetUsage): BudgetKey[] {
  if (!budget) return [];
  return BUDGET_KEYS.filter((k) => budget.limits[k] !== null && used[k] >= budget.limits[k]!);
}

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

/** "512,340 of 500,000 tokens", "$4.98 of $5.00 reported cost", "40 of 40 agent calls", "61 of 60 minutes". */
export function describeLimit(key: BudgetKey, used: number, limit: number): string {
  switch (key) {
    case "tokens":
      return `${Math.round(used).toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} tokens`;
    case "cost":
      return `$${used.toFixed(2)} of $${limit.toFixed(2)} reported cost`;
    case "calls":
      return `${used} of ${limit} agent calls`;
    case "minutes":
      return `${round(used, 1)} of ${limit} minutes of work`;
  }
}

/** How exactly a limit can hold, said where the run stops on it. */
const PRECISION: Record<BudgetKey, string> = {
  tokens: "tokens are known when a call ends, so the call that crossed the limit finished past it",
  cost: "Claude stops a call at the cost left; Codex reports no cost, so its calls are not in it",
  calls: "no agent call starts past it",
  minutes: "no step or agent call starts past it; one already running finishes",
};

/** The budget as the screen shows it; null when the run has none. */
export function budgetView(state: RunState, extra: Partial<BudgetUsage> = {}): BudgetView | null {
  const budget = state.budget;
  if (!budget) return null;
  const used = usageOf(state, extra);
  const lines: BudgetLine[] = BUDGET_KEYS.filter((k) => budget.limits[k] !== null).map((key) => ({ key, used: round(used[key], 4), limit: budget.limits[key]! }));
  return lines.length ? { lines, unpricedCalls: state.unpricedCalls ?? 0 } : null;
}

/** Why the run stops for a decision: the limits reached, each with its config key and how exactly it holds. */
export function exhaustedMessage(state: RunState, reached: BudgetKey[], used: BudgetUsage): { message: string; details: string[] } {
  const budget = state.budget!;
  const what = reached.map((k) => `${describeLimit(k, used[k], budget.limits[k]!)} (limits.${BUDGET_CONFIG[k]})`).join("; ");
  const message = `the run reached its budget: ${what}. Nothing more runs until you decide. Its state, files and report are kept: ` +
    "'resume' allows one more allowance of each limit reached (as much again as limits.max_run_* sets) and goes on where it stopped, " +
    "'revise' does the same and re-plans with your --note, 'abort' ends the run.";
  const details = [
    ...BUDGET_KEYS.filter((k) => budget.limits[k] !== null).map((k) => `${describeLimit(k, used[k], budget.limits[k]!)}${reached.includes(k) ? `: reached (${PRECISION[k]})` : ""}`),
    ...unpricedNote(state),
  ];
  return { message, details };
}

/** The honest part of a cost: how many calls are not in it. */
export function unpricedNote(state: RunState): string[] {
  const n = state.unpricedCalls ?? 0;
  return n ? [`${n} agent call(s) reported no cost (Codex never does): the run's real cost is higher than the reported one`] : [];
}

/**
 * The limits now at 80% or more and not yet warned about: each is marked warned (until it is raised), and its warning
 * returned. A reached limit is not warned about: the run stops on it instead.
 */
export function newWarnings(state: RunState): string[] {
  const budget = state.budget;
  if (!budget) return [];
  const used = usageOf(state);
  const out: string[] = [];
  for (const key of BUDGET_KEYS) {
    const limit = budget.limits[key];
    if (limit === null || budget.warned.includes(key) || used[key] < WARN_AT * limit || used[key] >= limit) continue;
    budget.warned.push(key);
    out.push(`budget: ${describeLimit(key, used[key], limit)} used (${Math.floor((used[key] / limit) * 100)}%, limits.${BUDGET_CONFIG[key]}); ` +
      "the run stops for your decision when it is reached");
  }
  return out;
}

/**
 * Your decision to go on after the run reached its budget: each limit reached gets one more allowance from what it
 * used, as much as the config (the run's saved one, or the current one with --reload-config) sets, or no limit when
 * that config sets none. Returns what changed, for the decision's record.
 */
export function raiseReached(state: RunState, cfg: ConfigData): string[] {
  const budget = state.budget;
  if (!budget) return [];
  const used = usageOf(state);
  const allowance = configLimits(cfg);
  const changes: string[] = [];
  for (const key of reachedLimits(budget, used)) {
    const add = allowance[key];
    budget.limits[key] = add === null ? null : roundUp(key, used[key] + add);
    budget.warned = budget.warned.filter((k) => k !== key);
    changes.push(add === null ? `${key}: no limit` : `${key} limit raised to ${budget.limits[key]}`);
  }
  return changes;
}

/** Integers stay integers (tokens, calls, minutes); a cost keeps its cents. */
function roundUp(key: BudgetKey, n: number): number {
  return key === "cost" ? Math.ceil(n * 100) / 100 : Math.ceil(n);
}

/**
 * The most a Claude call may cost so the run stays within its cost limit (for --max-budget-usd), in whole cents, at
 * least one; null without a cost limit.
 */
export function costLeft(state: RunState, callCost = 0): number | null {
  const limit = state.budget?.limits.cost ?? null;
  if (limit === null) return null;
  return Math.max(0.01, Math.floor((limit - state.costUsd - callCost) * 100) / 100);
}
