import type { GateResult } from "./gates.js";
import type { Critique, Finding, Plan, Review } from "./outputs.js";
import { scopeItemText } from "./scope.js";
import type { Accepted, PreexistingFailure, RunState } from "./state.js";

/**
 * The run's acceptance contract against what was there before the task. agentduo runs the quality gates before the
 * first plan (the baseline); the plan says whether it fixes each required gate that fails then; the critic names the
 * contradictions only the user can settle; and the reviewer says where each blocking problem comes from, with evidence.
 * A contradiction stops the run before any implementation, and a run left with nothing but pre-existing failures outside
 * its scope stops instead of looping: both wait for your decision, and nothing is waived without it.
 * See docs/superpowers/specs/2026-11-03-agentduo-acceptance-design.md.
 */

type Baseline = GateResult[] | null | undefined;

/** The required gates that failed before any change. */
export const baselineFailures = (baseline: Baseline): GateResult[] => (baseline ?? []).filter((g) => g.required && !g.passed);

/** The plan's check: it says, for every required gate that fails before any change, whether it fixes it. */
export function missingBaselineEntries(plan: Plan, baseline: Baseline): string[] {
  const listed = new Set(plan.baseline_failures.map((b) => b.gate));
  return baselineFailures(baseline).filter((g) => !listed.has(g.name))
    .map((g) => `'baseline_failures' must say whether the plan fixes the required gate '${g.name}', which fails before any change`);
}

/** The required gates a plan leaves failing: they failed before any change, and it marks fixing them out of scope. */
export function outOfScopeGates(plan: Plan | null, baseline: Baseline): Set<string> {
  if (!plan) return new Set();
  const failing = new Set(baselineFailures(baseline).map((g) => g.name));
  return new Set(plan.baseline_failures.filter((b) => !b.in_scope && failing.has(b.gate)).map((b) => b.gate));
}

/**
 * The contradictions only you can settle, before any implementation: the critic's, and every required gate the plan
 * leaves failing while DONE needs the required gates to pass. Implementing such a plan could only loop.
 */
export function requirementConflicts(o: { plan: Plan; critique: Critique; baseline: Baseline; requireTestsPass: boolean }): string[] {
  const named = o.critique.conflicts.map((c) => `${c.id}: ${c.description}${c.between.length ? ` (between: ${c.between.join("; ")})` : ""}`);
  const gates = o.requireTestsPass
    ? [...outOfScopeGates(o.plan, o.baseline)].map((name) => {
      const why = o.plan.baseline_failures.find((b) => b.gate === name)?.rationale.trim();
      return `the required gate '${name}' fails before any change and the plan leaves fixing it out of scope${why ? ` (${why})` : ""}, ` +
        "but DONE needs every required gate to pass (quality_gates.require_tests_pass)";
    })
    : [];
  return [...named, ...gates];
}

export function conflictReview(conflicts: string[]): { message: string; details: string[] } {
  return {
    message: "the requirements contradict each other in a way only you can settle (settling it would change what the task asks), so nothing " +
      "is implemented yet. 'revise' with a --note that settles it re-plans (for example: widen the scope to fix what fails, or relax a " +
      "criterion); 'resume' implements the plan as it is, accepting the contradiction (the run stops again if that leaves a required " +
      "check failing); 'abort' ends the run.",
    details: conflicts,
  };
}

/**
 * A failing required gate, as the task's to fix or as pre-existing. regression: it passed before (or there is no
 * baseline for it), or the reviewer finds the change made it worse or cannot tell. in_scope: it failed before and the
 * plan fixes it. pre_existing: it failed before, the plan leaves it out of scope and, once reviewed, the reviewer's
 * evidence says the change did not cause it.
 */
export interface GateVerdict {
  gate: GateResult;
  kind: "regression" | "in_scope" | "pre_existing";
  evidence: string | null;
}

/**
 * The failing required gates you did not accept, each with its verdict. `attributions` is null before the review: a
 * gate the plan leaves failing counts as pre-existing until the reviewer has looked. Your acceptance covers a gate's
 * failure as it was before the task, never a new one: not a gate that passed then or whose command changed since, and
 * not one the review of the code finds the change made worse (so the reviewer attributes accepted gates too).
 */
export function gateVerdicts(o: {
  results: GateResult[]; baseline: Baseline; outOfScope: Set<string>; attributions: Review["gate_failures"] | null; accepted: Set<string>;
}): GateVerdict[] {
  return o.results.filter((g) => g.required && !g.passed).flatMap((gate): GateVerdict[] => {
    const before = o.baseline?.find((b) => b.name === gate.name && b.command === gate.command);
    if (!before || before.passed) return [{ gate, kind: "regression", evidence: null }];
    const a = o.attributions?.find((x) => x.gate === gate.name);
    if (o.accepted.has(gate.name)) {
      if (!a || a.origin === "pre_existing") return [];
      return [{ gate, kind: "regression", evidence: a.evidence.trim() || null }];
    }
    if (!o.outOfScope.has(gate.name)) return [{ gate, kind: "in_scope", evidence: null }];
    if (!o.attributions) return [{ gate, kind: "pre_existing", evidence: null }];
    const evidence = a?.evidence.trim() || null;
    return [{ gate, kind: a?.origin === "pre_existing" && evidence ? "pre_existing" : "regression", evidence }];
  });
}

/** The required gates the reviewer attributes: those failing as before the task, out of the plan's scope, accepted ones included. */
export const gatesToAttribute = (o: { results: GateResult[]; baseline: Baseline; outOfScope: Set<string> }): string[] =>
  gateVerdicts({ ...o, attributions: null, accepted: new Set() }).filter((v) => v.kind === "pre_existing").map((v) => v.gate.name);

/**
 * The review's check: evidence for every blocking finding, and an attribution with evidence for every gate it is asked
 * about. A finding outside the task's scope blocks nothing, so it is left to the scope's check (src/core/scope.ts).
 */
export function attributionErrors(review: Review, blockingSeverities: string[], gates: string[]): string[] {
  const errors = review.findings.filter((f) => f.origin !== "out_of_scope" && blockingSeverities.includes(f.severity) && !f.evidence.trim())
    .map((f) => `finding '${f.id}' is ${f.severity}, so its 'evidence' must say where it comes from`);
  for (const name of gates) {
    const a = review.gate_failures.find((x) => x.gate === name);
    if (!a) errors.push(`'gate_failures' must attribute the failing required gate '${name}'`);
    else if (!a.evidence.trim()) errors.push(`'gate_failures' entry for '${name}' must give its 'evidence'`);
  }
  return errors;
}

/**
 * Blocking findings: what the task must still fix, and what was there before outside its scope (less what you
 * accepted). A finding outside the task's scope is in neither: it is never the task's to fix (src/core/scope.ts).
 */
export function splitFindings(blocking: Finding[], accepted: Set<string>): { fixable: Finding[]; preexisting: Finding[] } {
  return {
    fixable: blocking.filter((f) => f.origin !== "pre_existing" && f.origin !== "out_of_scope"),
    preexisting: blocking.filter((f) => f.origin === "pre_existing" && !accepted.has(f.id)),
  };
}

export function preexistingFailures(findings: Finding[], gates: GateVerdict[]): PreexistingFailure[] {
  return [
    ...gates.map((v): PreexistingFailure => ({ kind: "gate", id: v.gate.name, text: `required gate '${v.gate.name}' fails, as it did before the task`, evidence: v.evidence ?? "" })),
    ...findings.map((f): PreexistingFailure => ({ kind: "finding", id: f.id, text: `[${f.severity}] ${f.file ? `${f.file}: ` : ""}${f.issue}`, evidence: f.evidence })),
  ];
}

const itemText = (i: PreexistingFailure) => `${i.kind === "finding" ? `finding ${i.id} ` : ""}${i.text}${i.evidence ? ` (evidence: ${i.evidence})` : ""}`;

/** Why the run stops with nothing but pre-existing failures left, and what each choice does. */
export function preexistingReview(items: PreexistingFailure[], approved: boolean): { message: string; details: string[] } {
  return {
    message: "all that still fails was there before the task, and the plan's scope leaves it out: another fix round could only go out of " +
      "scope or fail again, and DONE cannot be reached as the task stands. 'resume' accepts these as pre-existing for this run" +
      (approved ? ", and the run ends DONE, saying so" : ", and the reviewer reviews again, knowing that you did") +
      "; 'revise' with a --note re-plans (for example, to bring them into scope); 'abort' ends the run.",
    details: items.map(itemText),
  };
}

/** The ids of the failures of `kind` you accepted. */
export const acceptedIds = (accepted: Accepted | undefined, kind: PreexistingFailure["kind"]): Set<string> =>
  new Set((accepted?.failures ?? []).filter((f) => f.kind === kind).map((f) => f.id));

/**
 * Your decision to go on: what waited for it is accepted, for the rest of the run (a critical finding outside the
 * scope stays out of it; a suggestion a plan adopted widens it). Returns what it accepted, for its record.
 */
export function acceptPending(state: RunState): string[] {
  const conflicts = state.conflicts ?? [];
  const failures = state.preexisting ?? [];
  const scope = state.scopePending ?? [];
  if (!conflicts.length && !failures.length && !scope.length) return [];
  const before = state.accepted ?? { conflicts: [], failures: [] };
  state.accepted = {
    conflicts: [...before.conflicts, ...conflicts], failures: [...before.failures, ...failures],
    ...(before.scope?.length || scope.length ? { scope: [...before.scope ?? [], ...scope] } : {}),
  };
  state.conflicts = null;
  state.preexisting = null;
  state.scopePending = null;
  return [
    ...conflicts.map((c) => `accepted conflict: ${c}`), ...failures.map((f) => `accepted as pre-existing: ${itemText(f)}`),
    ...scope.map((i) => `${i.kind === "finding" ? "kept outside the task's scope" : "scope widened"}: ${scopeItemText(i)}`),
  ];
}

/** What you accepted, as DONE and the report say it; empty when nothing. */
export function acceptedText(accepted: Accepted | undefined): string {
  const failures = accepted?.failures ?? [];
  const kept = (accepted?.scope ?? []).filter((s) => s.kind === "finding");
  const widened = (accepted?.scope ?? []).filter((s) => s.kind === "suggestion");
  return [
    failures.length ? `you accepted ${failures.length} pre-existing failure(s) outside the task's scope ` +
      `(${failures.map((f) => (f.kind === "gate" ? `gate '${f.id}'` : `finding ${f.id}`)).join(", ")})` : "",
    kept.length ? `you kept ${kept.length} critical finding(s) outside the task's scope unfixed (${kept.map((f) => `finding ${f.id}`).join(", ")})` : "",
    widened.length ? `you approved widening the task's scope for ${widened.length} suggestion(s) (${widened.map((s) => s.id).join(", ")})` : "",
  ].filter(Boolean).join("; ");
}
