import { describe, expect, it } from "vitest";
import { findingsMarkdown, planMarkdown, reportMarkdown } from "../src/core/render.js";
import { newState } from "../src/core/state.js";
import { finding, issue, critique, plan, review } from "./helpers/builders.js";

describe("render", () => {
  it("renders a plan with every section", () => {
    const md = planMarkdown(plan("Demo", { feedback_resolution: [{ issue_id: "C1", decision: "accepted", rationale: "ok" }] }), 2);
    for (const s of ["# Plan v2: Demo", "## Goals", "**Out of scope**", "1. **S1** write app.txt", "Files: `app.txt`", "## Acceptance criteria", "**none** — n/a", "## Response to feedback", "`C1` **accepted** — ok"]) {
      expect(md).toContain(s);
    }
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
    const md = reportMarkdown(st, " app.txt | 1 +\n", review(false, [finding("F3")]), critique(false, [issue("C1")]), "/runs/run-1");
    for (const s of ["# agentduo report — run-1", "**Status:** HUMAN_REVIEW — max_review_rounds", "1. `PLAN` r1 **Codex** — plan created: v1", "## Diff stat", "[review high] `F3`", "[permission denied] Bash", "duo resume run-1 --decision resume|revise|abort"]) {
      expect(md).toContain(s);
    }
  });
});
