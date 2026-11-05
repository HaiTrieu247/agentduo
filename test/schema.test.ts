import { describe, expect, it } from "vitest";
import { loadSchema, SCHEMA_NAMES, strictProblems, validateOutput } from "../src/agents/schema.js";
import { approval, critique, finding, impl, issue, plan, plannerAsk, plannerPlan, plannerQuestion, review } from "./helpers/builders.js";

describe("schemas", () => {
  it("are compatible with OpenAI strict structured outputs", () => {
    for (const name of SCHEMA_NAMES) expect(strictProblems(loadSchema(name)), name).toEqual([]);
  });

  it("accept the builders' outputs", () => {
    const samples = {
      plan: plan(), planner: plannerPlan(), plan_critique: critique(false, [issue("C1")]), plan_approval: approval(true),
      implementation: impl("completed", ["F1"]), review: review(false, [finding("F1")], [], "a".repeat(40)),
    } as const;
    for (const name of SCHEMA_NAMES) expect(validateOutput(name, samples[name]), name).toEqual([]);
  });

  it("report readable errors", () => {
    const bad: Record<string, unknown> = { ...review(true, [{ ...finding("F1"), severity: "urgent" as never, line: "7" as never }], [], "x") };
    bad.extra = 1;
    delete bad.summary;
    const errors = validateOutput("review", bad).join(" | ");
    expect(errors).toContain("$: missing required property 'summary'");
    expect(errors).toContain("$: unexpected property 'extra'");
    expect(errors).toContain("$.findings[0].severity: must be one of");
    expect(errors).toContain("$.findings[0].line: must be integer,null");
  });

  it("flags non-strict schemas", () => {
    const loose = { type: "object", properties: { a: { type: "string" } }, required: [] };
    expect(strictProblems(loose)).toEqual(["$: additionalProperties must be false", "$: required must list every property"]);
  });

  it("check inside anyOf and $defs, and keep a choice between shapes out of the root", () => {
    const loose = { type: "object", additionalProperties: false, required: ["a"], properties: { a: { anyOf: [{ type: "object", properties: { b: { type: "string" } }, required: [] }] } } };
    expect(strictProblems(loose)).toEqual(["$.a.anyOf[0]: additionalProperties must be false", "$.a.anyOf[0]: required must list every property"]);
    const defs = { type: "object", additionalProperties: false, required: [], properties: {}, $defs: { x: { type: "object", properties: { c: { type: "string" } }, required: [] } } };
    expect(strictProblems(defs)).toContain("$.$defs.x: additionalProperties must be false");
    expect(strictProblems({ anyOf: [{ type: "object", additionalProperties: false, required: [], properties: {} }] })).toContain("$: the root must not be anyOf/oneOf");
  });

  describe("planner", () => {
    it("is strict, keeps the plan's own schema inside, and has no root anyOf", () => {
      const planner = loadSchema("planner") as { properties: { result: { anyOf: Array<{ properties: { plan?: unknown } }> } }; anyOf?: unknown };
      expect(planner.anyOf).toBeUndefined();
      // The plan branch is plan.schema.json itself (one definition of a plan, not a copy that can drift).
      expect(planner.properties.result.anyOf[1]!.properties.plan).toEqual(loadSchema("plan"));
    });

    it("accepts the question branch with nothing of a plan, and the plan branch", () => {
      expect(validateOutput("planner", plannerAsk())).toEqual([]);
      expect(validateOutput("planner", plannerAsk([plannerQuestion("A?"), plannerQuestion("B?", true)]))).toEqual([]);
      expect(validateOutput("planner", plannerPlan())).toEqual([]);
    });

    it("rejects with the errors of the branch the planner chose, never the other's", () => {
      const noOptions = { result: { kind: "needs_clarification", questions: [{ header: "x", question: "q", options: [] }] } };
      const errors = validateOutput("planner", noOptions);
      expect(errors).toEqual(["$.result.questions[0]: missing required property 'multi_select'"]);
      const brokenPlan = plannerPlan(plan()) as unknown as { result: { plan: Record<string, unknown> } };
      delete brokenPlan.result.plan.title;
      expect(validateOutput("planner", brokenPlan)).toEqual(["$.result.plan: missing required property 'title'"]);
      expect(validateOutput("planner", { result: { kind: "maybe" } })).toEqual(['$.result.kind: must be one of ["needs_clarification","plan"]']);
      expect(validateOutput("planner", { result: { kind: "plan", plan: plan(), questions: [] } })).toEqual(["$.result: unexpected property 'questions'"]);
      expect(validateOutput("planner", plan())).toContain("$.result: must be an object with a 'kind'");
      expect(validateOutput("planner", null)).toEqual(["$: must be an object with a 'result'"]);
    });
  });
});
