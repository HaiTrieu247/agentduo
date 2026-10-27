import { describe, expect, it } from "vitest";
import type { GateResult } from "../src/core/gates.js";
import * as prompts from "../src/core/prompts.js";
import { critique, finding, impl, issue, plan, review } from "./helpers/builders.js";

const ctx: prompts.PromptContext = {
  repo: "/repo", taskId: "t1", task: "Sửa app.txt cho đúng",
  gates: [{ name: "tests", command: "npm test", required: true }, { name: "lint", command: "npm run lint", required: false }],
  notes: [{ at: "2026-10-27T13:00:00+07:00", phase: "PLAN_REVIEW", note: "use redis" }],
};
const failedGate: GateResult = { name: "tests", command: "npm test", required: true, exitCode: 1, timedOut: false, passed: false, durationSec: 1, log: "/x", outputTail: "check failed: boom" };

describe("prompts", () => {
  it("planner v1 states the role, rules, task, notes and gates", () => {
    const p = prompts.planner(ctx, 1, 1, null, null);
    expect(p.startsWith("[orchestrator-role: planner]")).toBe(true);
    for (const s of ["READ-ONLY", "Sửa app.txt cho đúng", "use redis", "- `npm test` (tests, required)", "- `npm run lint` (lint, optional)", "return `feedback_resolution` as an empty list"]) {
      expect(p).toContain(s);
    }
  });

  it("planner revisions include the previous plan and the feedback", () => {
    const c = { ...critique(false, [issue("C1", "high", "missing migration")]), proposed_changes: ["add a migration step"] };
    const p = prompts.planner(ctx, 2, 2, plan("Old plan"), { critique: c });
    for (const s of ["## Previous plan (v1) as JSON", "Old plan", "`C1` [high] missing migration", "add a migration step", "one entry per issue id"]) {
      expect(p).toContain(s);
    }
  });

  it("plan reviewer and finalizer see the plan and previous issues", () => {
    const r = prompts.planReviewer(ctx, 2, 2, "# Plan v2", critique(false, [issue("C1")]));
    expect(r).toContain("[orchestrator-role: plan_reviewer]");
    expect(r).toContain("# Plan v2");
    expect(r).toContain("Your critique from the previous round");
    const f = prompts.planFinalizer(ctx, 2, 2, "# Plan v2", critique(true, [issue("C2", "low")]));
    expect(f).toContain("[orchestrator-role: plan_finalizer]");
    expect(f).toContain("`C2` [low]");
    expect(f).toContain("`A1`");
  });

  it("implementer prompts for the first round and for fix rounds", () => {
    const first = prompts.implementer(ctx, 1, "# Final plan", [".env", ".agentduo/**"], [], null, [], null);
    for (const s of ["[orchestrator-role: implementer]", "Implement the plan now", "`.env`, `.agentduo/**`", "Chained commands"]) expect(first).toContain(s);
    const fix = prompts.implementer(ctx, 2, "# Final plan", [".env"], [finding("F1")], review(false, [finding("F1")], [], "a".repeat(40)),
      [failedGate], { summary: "did the thing" });
    for (const s of ["This is a fix round", "reviewed revision `aaaaaaaaaaaa`", "`F1` [high] `app.txt:1`", "Failing quality gates", "check failed: boom", "did the thing"]) {
      expect(fix).toContain(s);
    }
  });

  it("code reviewer sees the revision, gates, diff and previous findings", () => {
    const sha = "b".repeat(40);
    const p = prompts.codeReviewer(ctx, 2, "# Final plan", "a".repeat(40), sha, [failedGate], " app.txt | 1 +", "+fixed", true,
      [finding("F1")], impl("completed", ["F1"]));
    for (const s of [`Revision under review: \`${sha}\``, "[FAIL] tests", "TRUNCATED", "+fixed", "Implementer: fixed", `\`reviewed_commit\` must be exactly \`${sha}\``]) {
      expect(p).toContain(s);
    }
  });
});
