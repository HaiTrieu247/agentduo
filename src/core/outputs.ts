/** Shapes of the agents' final JSON (see schemas/*.schema.json); keys stay snake_case. */
export type Severity = "critical" | "high" | "medium" | "low";
export type ReviewStatus = "approved" | "changes_requested";

export interface Issue {
  id: string;
  severity: Severity;
  description: string;
  suggestion: string;
}

export interface Plan {
  title: string;
  summary: string;
  goals: string[];
  scope_in: string[];
  scope_out: string[];
  architecture: string;
  steps: Array<{ id: string; description: string; files: string[] }>;
  acceptance_criteria: string[];
  risks: Array<{ risk: string; mitigation: string }>;
  test_strategy: string;
  open_questions: string[];
  feedback_resolution: Array<{ issue_id: string; decision: "accepted" | "partially_accepted" | "disputed"; rationale: string }>;
}

export interface Critique {
  status: ReviewStatus;
  approved: boolean;
  summary: string;
  issues: Issue[];
  accepted: string[];
  disputed: string[];
  proposed_changes: string[];
}

export interface Approval {
  status: ReviewStatus;
  approved: boolean;
  summary: string;
  issues: Issue[];
}

export interface Implementation {
  status: "completed" | "blocked";
  summary: string;
  files_changed: string[];
  tests_run: Array<{ command: string; passed: boolean; notes: string }>;
  addressed_findings: Array<{ finding_id: string; resolution: "fixed" | "disputed" | "not_applicable"; notes: string }>;
  blocking_reason: string | null;
}

export interface Finding {
  id: string;
  severity: Severity;
  file: string;
  line: number | null;
  issue: string;
  recommendation: string;
}

export interface Review {
  status: ReviewStatus;
  approved: boolean;
  reviewed_commit: string;
  summary: string;
  findings: Finding[];
  resolved_findings: string[];
}
