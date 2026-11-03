import { describe, expect, it } from "vitest";
import { critiqueMarkdown, findingsMarkdown, planMarkdown, reportMarkdown } from "../src/core/render.js";
import { newState } from "../src/core/state.js";
import { finding, issue, critique, plan, review } from "./helpers/builders.js";

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
