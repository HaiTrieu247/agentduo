import type { Phase } from "../events.js";
import type { ConfigData, ProfileName } from "../config/config.js";
import { workspacePath } from "./context.js";
import type { Change } from "../git/git.js";
import type { Plan } from "./outputs.js";
import type { ProfileChange, RunProfile, RunState } from "./state.js";

/**
 * Pipeline profiles: how much planning and review a run spends, never what it checks. Every profile keeps the scope
 * contract, the baseline and consistency check, pre-existing failures, the independent plan critique and code review,
 * the required gates, the final verification, the convergence and no-progress breakers, the budget, and your decisions.
 *
 * - lightweight: a small, clearly specified task. A plan the critic approves goes straight to implementation (no
 *   sign-off), and the planner is asked for a short plan. A deterministic signal of more work than that (escalation
 *   signals below) moves the run to standard, recorded, keeping everything it did.
 * - standard: the pipeline as it always was, and the default.
 * - thorough: a complex or risky task. The planner always signs off a plan the critic approved, a review runs even
 *   when required gates fail, and the planner, critic and reviewer are asked to go in depth. All limits still hold.
 *
 * A profile only goes up on its own (lightweight to standard); nothing lowers it. See
 * docs/superpowers/specs/2026-11-03-agentduo-profiles-design.md.
 */

export interface ProfilePolicy {
  /** Whether the planner signs off a plan the critic approved: never, as quality_gates.require_plan_approval says, or always. */
  signOff: "never" | "config" | "always";
  /** Whether a review runs when required gates fail: as quality_gates.review_on_gate_failure says, or always. */
  reviewOnGateFailure: "config" | "always";
  /** The profile an escalation signal moves the run to; null: it does not escalate. */
  escalatesTo: ProfileName | null;
}

export const POLICIES: Record<ProfileName, ProfilePolicy> = {
  lightweight: { signOff: "never", reviewOnGateFailure: "config", escalatesTo: "standard" },
  standard: { signOff: "config", reviewOnGateFailure: "config", escalatesTo: null },
  thorough: { signOff: "always", reviewOnGateFailure: "always", escalatesTo: null },
};

/** The run's profile in effect: an older run's (with none recorded) is standard. */
export const profileOf = (st: RunState): ProfileName => st.profile?.name ?? "standard";

export function signsOff(profile: ProfileName, cfg: ConfigData): boolean {
  const p = POLICIES[profile].signOff;
  return p === "always" || (p === "config" && cfg.quality_gates.require_plan_approval);
}

export function reviewsOnGateFailure(profile: ProfileName, cfg: ConfigData): boolean {
  return POLICIES[profile].reviewOnGateFailure === "always" || cfg.quality_gates.review_on_gate_failure;
}

/** A new run's profile record. */
export const newProfile = (name: ProfileName): RunProfile => ({ initial: name, name, changes: [] });

/**
 * The deterministic signals that a lightweight task is more than that, and their thresholds. Each is something the run
 * can count or a decision it already stops for; none is a model's opinion of the task.
 */
export const LIGHTWEIGHT = {
  /** A plan with more steps, or naming more files, is not a small task. */
  maxSteps: 6,
  maxFiles: 8,
  /** An implementation round that changes this many files no plan step names went beyond the plan. */
  unplannedFiles: 3,
  /** Rounds in a row with required gates failing. */
  gateFailures: 2,
  /** The implementation round whose review still blocks: one fix round was not enough. */
  reviewRound: 2,
} as const;

export type EscalationSignal =
  | "plan_size" | "plan_blocking" | "requirements_conflict" | "scope" | "implementer_blocked" | "unplanned_files" | "gates_failing"
  | "review_rounds" | "review_stalled" | "critical_finding";

/**
 * Moves `profile` up for `signal`, when its policy escalates: records the change and returns it; null when it does not
 * (standard and thorough stay as they are).
 */
export function escalate(profile: RunProfile, o: { signal: EscalationSignal; reason: string; phase: Phase; round: number; at: string }): ProfileChange | null {
  const to = POLICIES[profile.name].escalatesTo;
  if (!to) return null;
  const change: ProfileChange = { from: profile.name, to, ...o };
  profile.name = to;
  profile.changes.push(change);
  return change;
}

const distinctFiles = (plan: Plan) => new Set(plan.steps.flatMap((s) => s.files.map((f) => f.trim().replace(/\\/g, "/").replace(/^\.\//, "")).filter(Boolean)));

/** Why a plan is larger than a lightweight task, or null when it is not. */
export function planTooLarge(plan: Plan): string | null {
  if (plan.steps.length > LIGHTWEIGHT.maxSteps) return `the plan has ${plan.steps.length} steps (a lightweight task has at most ${LIGHTWEIGHT.maxSteps})`;
  const files = distinctFiles(plan).size;
  if (files > LIGHTWEIGHT.maxFiles) return `the plan changes ${files} files (a lightweight task changes at most ${LIGHTWEIGHT.maxFiles})`;
  return null;
}

/**
 * The files an implementation changed that no step of the plan names, itself or a folder holding it; empty when the
 * plan names no file (there is nothing to compare with).
 */
export function unplannedFiles(plan: Plan, changes: Change[], workspace: string): string[] {
  const named = [...distinctFiles(plan)].map((f) => workspacePath(f, workspace)).filter((p): p is string => !!p).map((p) => p.replace(/\/$/, ""));
  if (!named.length) return [];
  return changes.map(([, p]) => p).filter((p) => !named.some((n) => p === n || p.startsWith(`${n}/`)));
}

/** "lightweight", or "standard (from lightweight)" once it escalated. */
export function profileText(profile: RunProfile | undefined): string {
  if (!profile) return "standard";
  return profile.initial === profile.name ? profile.name : `${profile.name} (from ${profile.initial})`;
}

/** Each change of the run's profile, one line each, for the report and `duo status`. */
export const profileChangeLines = (profile: RunProfile | undefined): string[] => (profile?.changes ?? [])
  .map((c) => `${c.from} → ${c.to} at ${c.phase} round ${c.round} (${c.signal}): ${c.reason}`);
