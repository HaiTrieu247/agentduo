import { describe, expect, it } from "vitest";
import {
  acceptedIds, acceptedText, acceptPending, attributionErrors, baselineFailures, conflictReview, gateVerdicts, missingBaselineEntries, outOfScopeGates,
  preexistingFailures, preexistingReview, requirementConflicts, splitFindings,
} from "../src/core/acceptance.js";
import type { GateResult } from "../src/core/gates.js";
import { newState } from "../src/core/state.js";
import { critique, finding, plan, review } from "./helpers/builders.js";

const gate = (name: string, passed: boolean, extra: Partial<GateResult> = {}): GateResult => ({
  name, command: `run ${name}`, required: true, exitCode: passed ? 0 : 1, timedOut: false, passed, durationSec: 0, log: "", outputTail: "", ...extra,
});
const baseline = [gate("tests", false), gate("layout", false), gate("lint", true), gate("docs", false, { required: false })];
const layoutOut = plan("P", { baseline_failures: [
  { gate: "tests", in_scope: true, rationale: "the task fixes them" },
  { gate: "layout", in_scope: false, rationale: "the task says not to touch the layout" },
] });

describe("acceptance: the plan against the baseline", () => {
  it("asks the plan about every required gate that fails before any change, and finds those it leaves failing", () => {
    expect(baselineFailures(baseline).map((g) => g.name)).toEqual(["tests", "layout"]);
    expect(missingBaselineEntries(layoutOut, baseline)).toEqual([]);
    expect(missingBaselineEntries(plan("P", { baseline_failures: [] }), baseline)).toEqual([
      "'baseline_failures' must say whether the plan fixes the required gate 'tests', which fails before any change",
      "'baseline_failures' must say whether the plan fixes the required gate 'layout', which fails before any change",
    ]);
    // No baseline (an older run, or no gates): nothing to ask.
    expect(missingBaselineEntries(plan("P", { baseline_failures: [] }), null)).toEqual([]);
    expect([...outOfScopeGates(layoutOut, baseline)]).toEqual(["layout"]);
    // A gate that passed before, or that the plan names but that is not failing, is never left failing.
    expect([...outOfScopeGates(plan("P", { baseline_failures: [{ gate: "lint", in_scope: false, rationale: "" }] }), baseline)]).toEqual([]);
    expect([...outOfScopeGates(null, baseline)]).toEqual([]);
  });

  it("names the contradictions only you can settle: the critic's, and a required gate left failing when DONE needs it", () => {
    const k1 = { id: "K1", description: "AC2 needs X, the task forbids X", between: ["AC2", "task"] };
    const both = requirementConflicts({ plan: layoutOut, critique: { ...critique(true), conflicts: [k1] }, baseline, requireTestsPass: true });
    expect(both).toEqual(["K1: AC2 needs X, the task forbids X (between: AC2; task)",
      "the required gate 'layout' fails before any change and the plan leaves fixing it out of scope (the task says not to touch the layout), " +
      "but DONE needs every required gate to pass (quality_gates.require_tests_pass)"]);
    // When required gates need not pass, a gate left failing contradicts nothing.
    expect(requirementConflicts({ plan: layoutOut, critique: critique(true), baseline, requireTestsPass: false })).toEqual([]);
    expect(requirementConflicts({ plan: plan(), critique: critique(true), baseline, requireTestsPass: true })).toEqual([]);
    const { message, details } = conflictReview(both);
    expect(message).toContain("so nothing is implemented yet. 'revise' with a --note that settles it re-plans");
    expect(message).toContain("'resume' implements the plan as it is, accepting the contradiction");
    expect(details).toBe(both);
  });
});

describe("acceptance: what fails after the change", () => {
  const now = [gate("tests", false), gate("layout", false), gate("lint", false), gate("docs", false, { required: false }), gate("new", false)];
  const verdicts = (attributions: Parameters<typeof gateVerdicts>[0]["attributions"], accepted = new Set<string>()) =>
    gateVerdicts({ results: now, baseline, outOfScope: outOfScopeGates(layoutOut, baseline), attributions, accepted })
      .map((v) => [v.gate.name, v.kind, v.evidence]);

  it("tells the task's failures from those it found and leaves out of scope, and needs the reviewer's evidence for the latter", () => {
    // Before the review: a gate left failing is pre-existing until the reviewer looks; one that passed before (or has no
    // baseline) is a regression; one the plan fixes is the task's; an optional one is not asked about.
    expect(verdicts(null)).toEqual([["tests", "in_scope", null], ["layout", "pre_existing", null], ["lint", "regression", null], ["new", "regression", null]]);
    const evidence = "the same 2 defects as before";
    expect(verdicts([{ gate: "layout", origin: "pre_existing", evidence }])[1]).toEqual(["layout", "pre_existing", evidence]);
    for (const a of [[{ gate: "layout", origin: "regression" as const, evidence: "worse" }], [{ gate: "layout", origin: "pre_existing" as const, evidence: " " }], []]) {
      expect(verdicts(a)[1]![1], JSON.stringify(a)).toBe("regression");
    }
    // A gate whose command changed since the baseline has none.
    expect(gateVerdicts({ results: [gate("layout", false, { command: "other" })], baseline, outOfScope: new Set(["layout"]), attributions: null, accepted: new Set() })[0]!.kind)
      .toBe("regression");
    // What you accepted is not asked about again.
    expect(verdicts(null, new Set(["layout", "tests"])).map((v) => v[0])).toEqual(["lint", "new"]);
  });

  it("asks evidence for every blocking finding and an attribution for every gate in question", () => {
    const r = { ...review(false, [{ ...finding("F1"), evidence: "" }, { ...finding("F2", "low"), evidence: "" }]), gate_failures: [{ gate: "a", origin: "pre_existing" as const, evidence: "" }] };
    expect(attributionErrors(r, ["critical", "high"], ["a", "b"])).toEqual([
      "finding 'F1' is high, so its 'evidence' must say where it comes from",
      "'gate_failures' entry for 'a' must give its 'evidence'",
      "'gate_failures' must attribute the failing required gate 'b'",
    ]);
    expect(attributionErrors(review(false, [finding("F1")]), ["critical", "high"], [])).toEqual([]);
  });

  it("splits blocking findings into the task's and the pre-existing ones, leaving out only what you accepted", () => {
    const blocking = [finding("F1"), finding("F2", "high", "a.css", "pre_existing"), finding("F3", "high", "b.css", "pre_existing"), finding("F4", "high", "c", "unclear")];
    const split = splitFindings(blocking, new Set(["F3", "F1"]));
    expect([split.fixable.map((f) => f.id), split.preexisting.map((f) => f.id)]).toEqual([["F1", "F4"], ["F2"]]);
  });

  it("records what a decision accepts, and says it", () => {
    const st = newState("t", "task", { max_planning_rounds: 1, max_review_rounds: 1 });
    expect(acceptPending(st)).toEqual([]);
    expect(st.accepted).toBeUndefined();
    const v = gateVerdicts({ results: [gate("layout", false)], baseline, outOfScope: new Set(["layout"]), attributions: [{ gate: "layout", origin: "pre_existing", evidence: "same" }], accepted: new Set() });
    const items = preexistingFailures([finding("F2", "high", "a.css", "pre_existing")], v);
    expect(items).toEqual([
      { kind: "gate", id: "layout", text: "required gate 'layout' fails, as it did before the task", evidence: "same" },
      { kind: "finding", id: "F2", text: "[high] a.css: bad", evidence: "the same at the base revision" },
    ]);
    expect(preexistingReview(items, true).message).toContain("'resume' accepts these as pre-existing for this run, and the run ends DONE, saying so");
    expect(preexistingReview(items, false).details).toEqual(["required gate 'layout' fails, as it did before the task (evidence: same)",
      "finding F2 [high] a.css: bad (evidence: the same at the base revision)"]);
    st.conflicts = ["K1: x"];
    st.preexisting = items;
    expect(acceptPending(st)).toEqual(["accepted conflict: K1: x", "accepted as pre-existing: required gate 'layout' fails, as it did before the task (evidence: same)",
      "accepted as pre-existing: finding F2 [high] a.css: bad (evidence: the same at the base revision)"]);
    expect([st.conflicts, st.preexisting, st.accepted!.conflicts]).toEqual([null, null, ["K1: x"]]);
    expect([[...acceptedIds(st.accepted, "gate")], [...acceptedIds(st.accepted, "finding")]]).toEqual([["layout"], ["F2"]]);
    expect(acceptedText(st.accepted)).toBe("you accepted 2 pre-existing failure(s) outside the task's scope (gate 'layout', finding F2)");
    expect(acceptedText(undefined)).toBe("");
  });
});
