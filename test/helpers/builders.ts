import type { Approval, Critique, Finding, Implementation, Issue, Plan, Review, Severity } from "../../src/core/outputs.js";

export function plan(title = "Demo plan", extra: Partial<Plan> = {}): Plan {
  return {
    title, summary: "Do the thing.", goals: ["make app.txt fixed"], scope_in: ["app.txt"],
    scope_out: ["everything else"], architecture: "single file",
    steps: [{ id: "S1", description: "write app.txt", files: ["app.txt"] }],
    acceptance_criteria: ["check.mjs exits 0"], risks: [{ risk: "none", mitigation: "n/a" }],
    test_strategy: "run check.mjs", open_questions: [], feedback_resolution: [], ...extra,
  };
}

export const issue = (id: string, severity: Severity = "high", description = "problem"): Issue =>
  ({ id, severity, description, suggestion: "fix it" });

export const critique = (approved: boolean, issues: Issue[] = []): Critique => ({
  status: approved ? "approved" : "changes_requested", approved, summary: "critique", issues,
  accepted: [], disputed: [], proposed_changes: [],
});

export const approval = (approved: boolean, issues: Issue[] = []): Approval =>
  ({ status: approved ? "approved" : "changes_requested", approved, summary: "final decision", issues });

export const impl = (status: Implementation["status"] = "completed", addressed: string[] = [],
  blockingReason: string | null = null): Implementation => ({
  status, summary: `implementation ${status}`, files_changed: ["app.txt"],
  tests_run: [{ command: "node check.mjs", passed: true, notes: "" }],
  addressed_findings: addressed.map((finding_id) => ({ finding_id, resolution: "fixed" as const, notes: "" })),
  blocking_reason: blockingReason,
});

export const finding = (id: string, severity: Severity = "high", file = "app.txt"): Finding =>
  ({ id, severity, file, line: 1, issue: "bad", recommendation: "fix" });

export const review = (approved: boolean, findings: Finding[] = [], resolved: string[] = [],
  commit = "$SNAPSHOT"): Review => ({
  status: approved ? "approved" : "changes_requested", approved, reviewed_commit: commit,
  summary: "review", findings, resolved_findings: resolved,
});
