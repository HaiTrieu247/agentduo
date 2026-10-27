import { describe, expect, it } from "vitest";
import type { GateResult } from "../src/core/gates.js";
import * as prompts from "../src/core/prompts.js";
import { critique, finding, impl, issue, plan, review } from "./helpers/builders.js";

const agents = { planner: "codex", plan_reviewer: "claude", implementer: "claude", code_reviewer: "codex" } as const;
const ctx: prompts.PromptContext = {
  repo: "/ws", taskId: "t1", task: "Sửa app.txt cho đúng", agents,
  gates: [{ name: "tests", command: "npm test", required: true }, { name: "lint", command: "npm run lint", required: false }],
  notes: [{ at: "2026-10-27T13:00:00+07:00", phase: "PLAN_REVIEW", note: "use redis" }],
};
const noGates: prompts.PromptContext = { ...ctx, gates: [] };
const failedGate: GateResult = { name: "tests", command: "npm test", required: true, exitCode: 1, timedOut: false, passed: false, durationSec: 1, log: "/x", outputTail: "check failed: boom" };
const RULE_WORDS = ["READ-ONLY", "Hard rules", "protected paths", "Chained commands", "Never commit", "byte-for-byte"];

describe("prompts", () => {
  it("describe roles and the output contract, with no rules of agentduo's own", () => {
    const all = [
      prompts.planner(ctx, 1, 1, null, null),
      prompts.planReviewer(ctx, 1, 1, "# Plan", null),
      prompts.planFinalizer(ctx, 1, 1, "# Plan", critique(true)),
      prompts.implementer(ctx, 1, "# Plan", [], null, [], null),
      prompts.codeReviewer(ctx, 1, "# Plan", "a".repeat(40), "b".repeat(40), [], "", "", false, [], impl()),
    ];
    for (const p of all) {
      for (const word of RULE_WORDS) expect(p).not.toContain(word);
      expect(p).toContain("Follow your own configuration and the repository's instructions");
      expect(p).toContain("implementer: Claude Code");
      expect(p).toContain("single JSON object");
    }
  });

  it("planner v1 states the task, notes and the gates when there are any", () => {
    const p = prompts.planner(ctx, 1, 1, null, null);
    expect(p.startsWith("[orchestrator-role: planner]")).toBe(true);
    for (const s of ["Sửa app.txt cho đúng", "use redis", "- `npm test` (tests, required)", "- `npm run lint` (lint, optional)", "return `feedback_resolution` as an empty list"]) {
      expect(p).toContain(s);
    }
    expect(prompts.planner(noGates, 1, 1, null, null)).not.toContain("npm test");
  });

  it("planner revisions include the previous plan and the feedback", () => {
    const c = { ...critique(false, [issue("C1", "high", "missing migration")]), proposed_changes: ["add a migration step"] };
    const p = prompts.planner(ctx, 2, 2, plan("Old plan"), { critique: c });
    for (const s of ["## Previous plan (v1) as JSON", "Old plan", "`C1` [high] missing migration", "add a migration step", "one entry per issue id"]) expect(p).toContain(s);
  });

  it("plan reviewer and finalizer see the plan and previous issues", () => {
    const r = prompts.planReviewer(ctx, 2, 2, "# Plan v2", critique(false, [issue("C1")]));
    expect(r).toContain("[orchestrator-role: plan_reviewer]");
    expect(r).toContain("Your critique from the previous round");
    const f = prompts.planFinalizer(ctx, 2, 2, "# Plan v2", critique(true, [issue("C2", "low")]));
    expect(f).toContain("`C2` [low]");
    expect(f).toContain("`A1`");
  });

  it("implementer prompts for the first round and fix rounds", () => {
    const first = prompts.implementer(ctx, 1, "# Final plan", [], null, [], null);
    expect(first).toContain("Implement the plan now");
    expect(first).toContain("After your turn agentduo runs these commands");
    expect(prompts.implementer(noGates, 1, "# Final plan", [], null, [], null)).toContain("Run the project's checks yourself");
    const fix = prompts.implementer(ctx, 2, "# Final plan", [finding("F1")], review(false, [finding("F1")], [], "a".repeat(40)), [failedGate], { summary: "did the thing" });
    for (const s of ["This is a fix round", "reviewed revision `aaaaaaaaaaaa`", "`F1` [high] `app.txt:1`", "Failing quality gates", "check failed: boom", "did the thing"]) {
      expect(fix).toContain(s);
    }
  });

  it("code reviewer sees the revision, gates, diff and previous findings, fenced safely", () => {
    const sha = "b".repeat(40);
    const diff = "+```js\n+code\n+```";
    const p = prompts.codeReviewer(ctx, 2, "# Final plan", "a".repeat(40), sha, [failedGate], " app.txt | 1 +", diff, true, [finding("F1")], impl("completed", ["F1"]));
    for (const s of [`Revision under review: \`${sha}\``, "[FAIL] tests", "TRUNCATED", "Implementer: fixed", `\`reviewed_commit\` must be exactly \`${sha}\``, "````diff\n+```js"]) {
      expect(p).toContain(s);
    }
    expect(prompts.fenceFor("no backticks")).toBe("```");
    expect(prompts.fenceFor("a ````` b")).toBe("``````");
  });
});
