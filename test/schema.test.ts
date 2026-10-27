import { describe, expect, it } from "vitest";
import { loadSchema, SCHEMA_NAMES, strictProblems, validateOutput } from "../src/agents/schema.js";
import { approval, critique, finding, impl, issue, plan, review } from "./helpers/builders.js";

describe("schemas", () => {
  it("are compatible with OpenAI strict structured outputs", () => {
    for (const name of SCHEMA_NAMES) expect(strictProblems(loadSchema(name)), name).toEqual([]);
  });

  it("accept the builders' outputs", () => {
    const samples = {
      plan: plan(), plan_critique: critique(false, [issue("C1")]), plan_approval: approval(true),
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
});
