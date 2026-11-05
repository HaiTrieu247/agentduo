import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/config/config.js";
import { critiqueMarkdown, findingsMarkdown, metricsLines, planMarkdown, reportMarkdown, runMetrics } from "../../src/workflow/render.js";
import { newState } from "../../src/workflow/state.js";
import { finding, issue, critique, plan, review } from "../helpers/builders.js";

describe("render", () => {
  it("renders a plan with every section", () => {
    const md = planMarkdown(plan("Demo", { feedback_resolution: [{ issue_id: "C1", decision: "accepted", rationale: "ok" }] }), 2);
    for (const s of ["# Plan v2: Demo", "## Goals", "**Out of scope**", "1. **S1** write app.txt", "Files: `app.txt`", "## Acceptance criteria", "**none** — n/a", "## Response to feedback", "`C1` **accepted** — ok"]) {
      expect(md).toContain(s);
    }
  });

  it("renders what a plan does about each gate failing before any change, and the conflicts the critic leaves to the user", () => {
    const md = planMarkdown(plan("Demo", { baseline_failures: [{ gate: "check", in_scope: true, rationale: "the task" }, { gate: "layout", in_scope: false, rationale: "not ours" }] }), 1);
    expect(md).toContain("## Baseline failures\nRequired gates that fail before any change:\n- `check`: **fixed by this plan** — the task\n- `layout`: **left out of scope** — not ours");
    expect(planMarkdown(plan("Demo", { baseline_failures: [] }), 1)).not.toContain("## Baseline failures");
    const c = critiqueMarkdown({ ...critique(true), conflicts: [{ id: "K1", description: "AC2 vs scope", between: ["AC2", "scope_out"] }] }, 1, 1, "Claude");
    expect(c).toContain("### Conflicts only the user can settle\n- `K1` AC2 vs scope (between: AC2; scope_out)");
  });

  it("renders the criteria by id, an older plan's by place, and marks issues outside the task's scope", () => {
    const md = planMarkdown(plan("Demo", { acceptance_criteria: [{ id: "AC1", criterion: "works" }, { id: "AC3", criterion: "is tested" }] }), 1);
    expect(md).toContain("## Acceptance criteria\n- **AC1** works\n- **AC3** is tested");
    expect(planMarkdown(plan("Old", { acceptance_criteria: ["works"] as never }), 1)).toContain("## Acceptance criteria\n- **AC1** works");
    const c = critiqueMarkdown(critique(true, [issue("C1", "medium"), issue("C2", "high", "also verify landscape", "out_of_scope")]), 1, 1, "Claude");
    expect(c).toContain("- `C1` [medium] problem");
    expect(c).toContain("- `C2` [high] (outside the task's scope) also verify landscape");
  });

  it("reports the findings across reviews, each review round's progress and the rejected answers, and nothing of it for an older run", () => {
    const st = newState("run-1", "Fix it", { max_planning_rounds: 4, max_review_rounds: 5 });
    const older = reportMarkdown(st, "", null, null, "/runs/run-1");
    for (const s of ["## Findings across reviews", "## Review rounds", "## Rejected answers"]) expect(older).not.toContain(s);
    st.trackedFindings = [
      { key: "F1", ids: ["F1", "F4"], file: "app.ts", issue: "a null input crashes parse()", firstIssue: "parse() accepts null", severity: "high", origin: "regression",
        criteria: ["AC1"], status: "open", seen: [{ round: 1, revision: "a" }, { round: 2, revision: "b" }], resolvedRound: 1, reopened: 1 },
      { key: "F2", ids: ["F2"], file: "", issue: "no tests", severity: "medium", origin: "in_scope", criteria: [], status: "resolved", seen: [{ round: 1, revision: "a" }], resolvedRound: 2, reopened: 0 },
    ];
    st.cycles = [
      { round: 1, revision: "a", tree: "t1", plan: "p", blocking: [], failingGates: [], progress: null, counts: { new: 2, open: 0, reopened: 0, resolved: 0 } },
      { round: 2, revision: "b", tree: "t1", plan: "p", blocking: [], failingGates: [], progress: [], counts: { new: 0, open: 1, reopened: 0, resolved: 1 } },
    ];
    st.rejected = [{ role: "plan_reviewer", round: 1, count: 1, errors: ["issue 'C1' needs a scope"], outcome: "corrected" }];
    const md = reportMarkdown(st, "", null, null, "/runs/run-1");
    expect(md).toContain("## Findings across reviews\n- `F1` (also F4) [high] app.ts — parse() accepts null → a null input crashes parse(): raised in rounds 1, 2; " +
      "still open; reopened 1×\n- `F2` [medium] no tests: raised in rounds 1; resolved by the review of round 2");
    expect(md).toContain("## Review rounds\n- round 1: 2 new, 0 still open, 0 reopened, 0 resolved\n- round 2: 0 new, 1 still open, 0 reopened, 1 resolved — no progress");
    expect(md).toContain("## Rejected answers\n- plan critic, round 1: 1 answer(s) rejected (issue 'C1' needs a scope); a later answer was accepted");
  });

  it("renders finding locations", () => {
    expect(findingsMarkdown([finding("F1"), { ...finding("F2"), file: "", line: null }])).toContain("`(general)`");
    expect(findingsMarkdown([])).toBe("_(no findings)_");
  });

  it("renders a report with timeline, unresolved issues and the next step", () => {
    const st = newState("run-1", "Fix it", { max_planning_rounds: 4, max_review_rounds: 5 });
    st.phase = "HUMAN_REVIEW";
    st.humanReview = { reason: "max_review_rounds", message: "not approved after 5 rounds", fromPhase: "CODE_REVIEW", resumePhase: "IMPLEMENT", details: [], at: "now" };
    st.history.push({ step: 1, phase: "PLAN", round: 1, agent: "Codex", status: "plan created", summary: "v1", kind: "info", at: "now", artifact: null });
    st.lastImplementation = { round: 1, summary: "x", status: "completed", permissionDenials: [{ tool_name: "Bash", tool_input: { command: "curl x" } }] };
    st.base = { commit: "a".repeat(40), tree: "t".repeat(40), head: null, branch: null };
    st.lastSnapshot = { commit: "b".repeat(40), tree: "u".repeat(40) };
    const md = reportMarkdown(st, " app.txt | 1 +\n", review(false, [finding("F3")]), critique(false, [issue("C1")]), "/runs/run-1");
    for (const s of ["# agentduo report — run-1", "**Status:** HUMAN_REVIEW — max_review_rounds", "1. `PLAN` r1 **Codex** — plan created: v1", "## Diff stat", "[review high] `F3`", "[permission denied] Bash", "duo resume run-1 --decision resume|revise|abort",
      `git diff ${"a".repeat(12)} ${"b".repeat(12)} -- .`]) {
      expect(md).toContain(s);
    }
    expect(md).not.toContain("**Snapshots:**");
    // A run with agentduo's own repository: where it is, and a diff that needs no repository in the workspace.
    st.git = { mode: "internal", repositoryId: "x", workspace: "/ws", gitDir: "/data/agentduo/repositories/x.git" };
    const internal = reportMarkdown(st, "", null, null, "/runs/run-1");
    expect(internal).toContain("- **Snapshots:** agentduo's own Git repository `/data/agentduo/repositories/x.git`");
    expect(internal).toContain(`\`git --git-dir "/data/agentduo/repositories/x.git" diff ${"a".repeat(12)} ${"b".repeat(12)}\``);
    expect(internal).toContain("diff.r<round>.patch");
    expect(internal).not.toContain("-- .`");
  });
});

describe("render: profile and metrics", () => {
  it("measures an older run, which kept no profile or usage by role, from its totals and timeline", () => {
    const st = { ...newState("run-1", "task", { max_planning_rounds: 4, max_review_rounds: 5 }), phase: "HUMAN_REVIEW" as const, agentCalls: 3, tokens: 900, costUsd: 0.5,
      createdAt: "2026-11-03T10:00:00+07:00", updatedAt: "2026-11-03T10:30:00+07:00" };
    st.history = [
      { step: 1, phase: "PLAN", round: 1, agent: "Codex", status: "plan created", summary: "", kind: "info", at: "", artifact: null },
      { step: 2, phase: "PLAN_REVIEW", round: 1, agent: "Claude", status: "approved", summary: "", kind: "ok", at: "", artifact: null },
      { step: 3, phase: "HUMAN_REVIEW", round: 1, agent: "orchestrator", status: "plan_ready", summary: "", kind: "warn", at: "", artifact: null },
    ];
    expect(runMetrics(st)).toMatchObject({
      profile: { initial: "standard", final: "standard", escalations: [] }, outcome: "HUMAN_REVIEW", verification: null, requiredGates: "not_run", review: "none",
      agentCalls: 3, byRole: {}, tokens: 900, costUsd: 0.5, steps: { plans: 1, critiques: 1, signOffs: 0, reviews: 0, gateRuns: 0 }, decisions: 1, wallMinutes: 30,
    });
    expect(metricsLines(st)[0]).toBe("profile: standard");
    expect(metricsLines(st)[1]).toBe("agent calls: 3");
    expect(reportMarkdown(st, "", null, null, "/runs/run-1")).toContain("## Profile and metrics\n- profile: standard\n- agent calls: 3\n- steps: 1 plan(s), 1 critique(s)");
    expect(defaultConfig().pipeline.profile).toBe("standard");
    // No gate configured when it started (a null baseline): not configured, never "not run".
    expect(runMetrics({ ...st, baseline: null }).requiredGates).toBe("not_configured");
  });
});
