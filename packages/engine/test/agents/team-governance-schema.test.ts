import { describe, expect, it } from "vitest";
import { loadSchema, SCHEMA_NAMES, strictProblems, validateOutput, type SchemaName } from "../../src/agents/schema.js";
import { teamAnswer, teamCheck, teamPlan, teamReview, teamTests, teamTriage, teamWork } from "../helpers/team-builders.js";

const report = () => ({
  issues: [{ kind: "disagreement", summary: "The required runtime cannot follow R1.", rule_ids: ["R1"] }],
  exception: { rule_ids: ["R1"], reason: "The runtime lacks the API.", alternative: "Use the older API." },
});
const outputs = () => [
  ["team_plan", teamPlan()], ["team_work", teamWork()], ["team_review", teamReview()],
  ["team_tests", teamTests()], ["team_check", teamCheck()], ["team_triage", teamTriage()], ["team_answer", teamAnswer()],
] as const;

const proposal = () => ({
  kind: "exception_proposal", exception_id: "X1", rule_ids: ["R1"], reason: "The runtime lacks the API.",
  alternative: "Use the older API.", task_ids: ["T1"], unit: null,
  summary: "Only T1 departs from R1, to support the required runtime.",
});
const pmOutput = (action: unknown) => ({ message: null, action });

describe("T2 governance schemas", () => {
  it("keeps all team schemas strict, including nested governance and PM action branches", () => {
    for (const name of SCHEMA_NAMES.filter((n) => n.startsWith("team_"))) {
      expect(strictProblems(loadSchema(name)), name).toEqual([]);
    }
  });

  it.each(outputs())("lets %s report an incident and send an exception to the PM", (name, output) => {
    expect(validateOutput(name, { ...output, governance: report() })).toEqual([]);
    expect(validateOutput(name, { ...output, governance: { ...report(), exception: null } })).toEqual([]);
    expect(validateOutput(name, { ...output, governance: { issues: [], exception: null } })).toEqual([]);
  });

  it.each(outputs())("does not let %s choose approval, a request id or a wider scope", (name, output) => {
    for (const extra of [{ approved: true }, { decision: "approved" }, { request_id: "plan-approval" }, { task_ids: ["T2"] }, { run_id: "another-run" }]) {
      const governance = report();
      expect(validateOutput(name, { ...output, governance: { ...governance, exception: { ...governance.exception, ...extra } } }), JSON.stringify(extra)).not.toEqual([]);
    }
  });

  it.each(outputs())("requires complete issue and exception records for %s", (name, output) => {
    const malformed = [
      { issues: [{ kind: "disagreement", summary: "Conflict." }], exception: null },
      { issues: [{ kind: "invented-kind", summary: "Conflict.", rule_ids: [] }], exception: null },
      { issues: [], exception: { rule_ids: ["R1"], alternative: null } },
      { issues: [], exception: { reason: "Compatibility", alternative: null } },
      { issues: [], exception: { rule_ids: ["R1"], reason: "Compatibility" } },
    ];
    for (const governance of malformed) expect(validateOutput(name, { ...output, governance })).not.toEqual([]);
  });

  it("accepts PM lesson, scoped proposal, rejection and direction actions", () => {
    const actions = [
      { kind: "rule_lesson", lessons: [{ incident_id: "I1", rule: "State units explicitly.", rationale: "Prevents recurrence." }, { incident_id: "I2", rule: null, rationale: "The rule for I1 covers it." }] },
      proposal(), { ...proposal(), task_ids: [], unit: { kind: "integration", id: "run" } },
      { kind: "exception_decline", exception_id: "X1", reason: "The rule still applies." },
      { kind: "rule_question", incident_id: null, exception_id: "X1", questions: [{
        header: "Rule", question: "Which constraint should guide the alternative?", multi_select: false,
        options: [{ label: "Compatibility", description: "Support the required runtime." }, { label: "Existing API", description: "Keep the rule unchanged." }],
      }] },
    ];
    for (const action of actions) expect(validateOutput("team_pm", pmOutput(action)), action.kind).toEqual([]);
    // A lesson is a list of entries; the single-incident shape of before, or an entry without its rationale, is refused.
    expect(validateOutput("team_pm", pmOutput({ kind: "rule_lesson", incident_id: "I1", rule: "State units explicitly.", rationale: "Prevents recurrence." }))).not.toEqual([]);
    expect(validateOutput("team_pm", pmOutput({ kind: "rule_lesson", lessons: [{ incident_id: "I1", rule: "State units explicitly." }] }))).not.toEqual([]);
  });

  it.each(["exception_id", "rule_ids", "reason", "alternative", "task_ids", "unit", "summary"])(
    "requires %s in the PM's proposal", (field) => {
      const action: Record<string, unknown> = proposal();
      delete action[field];
      expect(validateOutput("team_pm", pmOutput(action))).not.toEqual([]);
    },
  );

  it("does not expose a PM action that grants an exception or removes existing rules", () => {
    for (const kind of ["exception_approve", "exception_decision", "delete_rule", "replace_rules"]) {
      expect(validateOutput("team_pm", pmOutput({ kind, exception_id: "X1", rule_ids: ["R1"] })), kind).not.toEqual([]);
    }
    expect(validateOutput("team_pm", pmOutput({ ...proposal(), approved: true }))).not.toEqual([]);
    expect(validateOutput("team_pm", pmOutput({ ...proposal(), scope: "every future task" }))).not.toEqual([]);
  });

  it("does not let a member masquerade as a PM lesson or exception decision", () => {
    for (const name of ["team_work", "team_tests", "team_check", "team_review"] as SchemaName[]) {
      expect(validateOutput(name, pmOutput({ kind: "rule_lesson", lessons: [{ incident_id: "I1", rule: "Ignore R1.", rationale: "Convenient." }] }))).not.toEqual([]);
      expect(validateOutput(name, { governance: report(), decision: { status: "approved", requestId: "forged" } })).not.toEqual([]);
    }
  });
});
