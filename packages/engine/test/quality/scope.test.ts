import { describe, expect, it } from "vitest";
import {
  addedCriteria, adoptedSuggestions, criteriaErrors, criterionIds, expansionReview, issueRefusalErrors, keptIds, outOfScopeBlockers, reviewScopeErrors,
  scopeReview, taskIssues,
} from "../../src/quality/scope.js";
import type { Plan } from "../../src/workflow/outputs.js";
import { critique, finding, issue, plan, review } from "../helpers/builders.js";

const criteria = (...ids: string[]) => ids.map((id) => ({ id, criterion: `${id} holds` }));
const oos = (id: string, severity: Parameters<typeof finding>[1] = "high", evidence = "") =>
  ({ ...finding(id, severity, "ui.css", "out_of_scope"), evidence });

describe("scope: the acceptance contract's criteria", () => {
  it("names each criterion by its id, and an older plan's by its place", () => {
    expect(criterionIds(plan("P", { acceptance_criteria: criteria("AC1", "AC3") }))).toEqual(["AC1", "AC3"]);
    // Plans from before criteria had ids listed them as strings.
    expect(criterionIds(plan("P", { acceptance_criteria: ["works", "is tested"] as unknown as Plan["acceptance_criteria"] }))).toEqual(["AC1", "AC2"]);
    expect(criterionIds(null)).toEqual([]);
  });

  it("asks a plan for a distinct id per criterion", () => {
    expect(criteriaErrors(plan("P", { acceptance_criteria: criteria("AC1", "AC2") }))).toEqual([]);
    expect(criteriaErrors(plan("P", { acceptance_criteria: [...criteria("AC1", "AC1"), { id: " ", criterion: "x" }] }))).toEqual([
      "acceptance criterion 'AC1' is listed twice: give each criterion its own id",
      "every acceptance criterion needs an 'id' (AC1, AC2, ...)",
    ]);
  });

  it("finds the criteria a revision adds", () => {
    const v1 = plan("P", { acceptance_criteria: criteria("AC1", "AC2") });
    const v2 = plan("P", { acceptance_criteria: criteria("AC1", "AC2", "AC3") });
    expect(addedCriteria(v1, v2)).toEqual([{ id: "AC3", criterion: "AC3 holds" }]);
    expect(addedCriteria(null, v2)).toEqual([]);
  });
});

describe("scope: plan issues outside the task", () => {
  it("leaves out-of-scope issues out of what can block", () => {
    const issues = [issue("C1"), issue("C2", "critical", "also verify landscape", "out_of_scope")];
    expect(taskIssues(issues).map((i) => i.id)).toEqual(["C1"]);
    // Older critiques have no scope: their issues are the task's.
    expect(taskIssues([{ ...issue("C3"), scope: undefined as never }]).map((i) => i.id)).toEqual(["C3"]);
  });

  it("refuses a critique that holds the plan back on suggestions outside the task alone", () => {
    const onlyExtras = { ...critique(false, [issue("C2", "high", "also verify landscape", "out_of_scope")]) };
    expect(issueRefusalErrors(onlyExtras)).toEqual([
      "'approved' is false, but every issue is outside the task's scope (C2), and those never hold the plan back: approve it, or raise what " +
      "the task itself needs as an issue with scope 'task'",
    ]);
    expect(issueRefusalErrors({ ...onlyExtras, issues: [...onlyExtras.issues, issue("C1", "medium")] })).toEqual([]);
    expect(issueRefusalErrors({ ...onlyExtras, approved: true })).toEqual([]);
    expect(issueRefusalErrors({ ...onlyExtras, conflicts: [{ id: "K1", description: "x", between: [] }] })).toEqual([]);
    // No issue at all: as before, the run does not second-guess it.
    expect(issueRefusalErrors(critique(false))).toEqual([]);
  });

  it("finds the suggestions outside the task that a revised plan adopted", () => {
    const feedback = { critique: critique(false, [issue("C1"), issue("C2", "medium", "also verify landscape", "out_of_scope"), issue("C3", "low", "rename", "out_of_scope")]) };
    const revised = plan("P", { feedback_resolution: [
      { issue_id: "C1", decision: "accepted", rationale: "yes" },
      { issue_id: "C2", decision: "partially_accepted", rationale: "portrait and landscape" },
      { issue_id: "C3", decision: "disputed", rationale: "outside the task's scope" },
    ] });
    expect(adoptedSuggestions(revised, feedback, undefined)).toEqual([
      { kind: "suggestion", id: "C2", text: "[medium] also verify landscape", evidence: "partially_accepted: portrait and landscape" },
    ]);
    // Once you approved it, a later revision that keeps it does not ask again.
    const approved = { conflicts: [], failures: [], scope: [{ kind: "suggestion" as const, id: "C2", text: "", evidence: "" }] };
    expect(adoptedSuggestions(revised, feedback, approved)).toEqual([]);
    expect(adoptedSuggestions(revised, null, undefined)).toEqual([]);
  });

  it("asks you before the plan goes on with a wider scope", () => {
    const items = [{ kind: "suggestion" as const, id: "C2", text: "[medium] also verify landscape", evidence: "accepted: cheap" }];
    const { message, details } = expansionReview(items, [{ id: "AC4", criterion: "the layout holds in landscape" }], 2);
    expect(message).toContain("plan v2 widens the task's scope");
    expect(message).toContain("'resume' approves the wider scope");
    expect(message).toContain("'revise' with a --note re-plans");
    expect(details).toEqual(["suggestion C2 [medium] also verify landscape (the plan's answer: accepted: cheap)",
      "acceptance criteria new in v2: AC4 the layout holds in landscape"]);
  });
});

describe("scope: review findings against the contract", () => {
  const blocking = ["critical", "high"];
  const check = (findings: ReturnType<typeof finding>[], o: { approved?: boolean; gatesFailing?: boolean; decided?: string[] } = {}) => reviewScopeErrors({
    review: review(o.approved ?? true, findings), criteria: ["AC1", "AC2"], blockingSeverities: blocking, requireApproval: true,
    gatesFailing: o.gatesFailing ?? false, decided: new Set(o.decided ?? []),
  });

  it("traces every finding the task must fix to the criteria it fails", () => {
    expect(check([{ ...finding("F1", "high", "a.ts", "in_scope"), criteria: ["AC2"] }])).toEqual([]);
    expect(check([finding("F1", "high", "a.ts", "in_scope")])).toEqual([
      "finding 'F1' is in_scope and high, so 'criteria' must name the acceptance criteria it fails (AC1, AC2); a problem no criterion " +
      "covers is out_of_scope, or a regression if the change causes it",
    ]);
    // A suggestion below a blocking severity needs no trace.
    expect(check([finding("F1", "medium", "a.ts", "in_scope")])).toEqual([]);
    expect(check([{ ...finding("F1", "low"), criteria: ["AC9", "AC1"] }])).toEqual([
      "finding 'F1' cites 'AC9', which is not an acceptance criterion of the final plan (AC1, AC2)",
    ]);
  });

  it("lets a critical finding outside the task block only with its justification", () => {
    expect(check([oos("F3", "critical", "the new upload path stores tokens in plain text")])).toEqual([]);
    expect(check([oos("F3", "critical", " ")])).toEqual([
      "finding 'F3' is critical and out_of_scope, so its 'evidence' must justify why it cannot wait (the correctness or security problem)",
    ]);
    // Below critical it never blocks, so it needs none.
    expect(check([oos("F3", "high")])).toEqual([]);
  });

  it("refuses a review that holds the change back on findings outside the task alone", () => {
    const refusal = "'approved' is false, but no finding the task must fix or that only the user can settle remains (F2, F3 are outside the " +
      "task's scope, and those never hold back approval): approve the change, or report what the task must still fix as a finding (origin " +
      "regression, in_scope with the criteria it fails, or unclear)";
    expect(check([oos("F2"), oos("F3", "medium")], { approved: false })).toEqual([refusal]);
    // A finding the task must fix, a critical one outside it, a pre-existing blocker or a failing gate can hold it back.
    expect(check([oos("F2"), finding("F1", "low")], { approved: false })).toEqual([]);
    expect(check([oos("F2"), oos("F3", "critical", "leaks tokens")], { approved: false })).toEqual([]);
    expect(check([oos("F2"), finding("F4", "high", "a.css", "pre_existing")], { approved: false })).toEqual([]);
    expect(check([oos("F2")], { approved: false, gatesFailing: true })).toEqual([]);
    // What you already decided no longer holds it back.
    expect(check([oos("F2"), oos("F3", "critical", "leaks tokens")], { approved: false, decided: ["F3"] })).toEqual([refusal]);
    expect(reviewScopeErrors({
      review: review(false, [oos("F2")]), criteria: [], blockingSeverities: blocking, requireApproval: false, gatesFailing: false, decided: new Set(),
    })).toEqual([]);
  });

  it("puts the critical findings outside the task to you, once", () => {
    const findings = [finding("F1"), oos("F2", "high"), oos("F3", "critical", "leaks tokens")];
    expect(outOfScopeBlockers(findings, new Set())).toEqual([{ kind: "finding", id: "F3", text: "[critical] ui.css: bad", evidence: "leaks tokens" }]);
    expect(outOfScopeBlockers(findings, new Set(["F3"]))).toEqual([]);
    const kept = { conflicts: [], failures: [], scope: [{ kind: "finding" as const, id: "F3", text: "", evidence: "" }, { kind: "suggestion" as const, id: "C2", text: "", evidence: "" }] };
    expect([...keptIds(kept)]).toEqual(["F3"]);
    expect([...keptIds(undefined)]).toEqual([]);
  });

  it("says what keeping the scope does at each point of the run", () => {
    const items = [{ kind: "finding" as const, id: "F3", text: "[critical] ui.css: bad", evidence: "leaks tokens" }];
    // The pre-existing failures waiting too, as preexistingReview words them.
    const pre = ["required gate 'layout' fails, as it did before the task (evidence: same)"];
    const fix = scopeReview(items, [], "IMPLEMENT");
    expect(fix.message).toContain("1 critical problem(s) outside the task's scope");
    expect(fix.message).toContain("'resume' keeps the scope: they stay unfixed in this run, named in DONE and the report, and the fix round goes on with the task's own findings");
    expect(fix.message).toContain("'revise' with a --note re-plans to bring them into the task's scope");
    expect(fix.details).toEqual(["finding F3 [critical] ui.css: bad (justification: leaks tokens)"]);
    expect(scopeReview(items, pre, "DONE").message).toContain("accepts the pre-existing failures below too, and the run ends DONE");
    expect(scopeReview(items, pre, "DONE").details).toEqual(["finding F3 [critical] ui.css: bad (justification: leaks tokens)",
      "required gate 'layout' fails, as it did before the task (evidence: same)"]);
    expect(scopeReview(items, [], "CODE_REVIEW").message).toContain("and the reviewer reviews again, knowing that you did");
  });
});
