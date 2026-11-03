/** Shapes of the agents' final JSON (see schemas/*.schema.json); keys stay snake_case. */
export type Severity = "critical" | "high" | "medium" | "low";
export type ReviewStatus = "approved" | "changes_requested";
/**
 * Where a problem the reviewer reports stands against the task. regression: the change under review causes it.
 * in_scope: the task must still do it (an acceptance criterion it fails, or a problem there before the task that the
 * plan's scope includes fixing). pre_existing: it was there before the task, and the plan's scope leaves it out.
 * out_of_scope: beyond what the task and its criteria ask, and not caused by the change (a suggestion). unclear: the
 * reviewer cannot tell. See docs/superpowers/specs/2026-11-03-agentduo-scope-design.md.
 */
export type Origin = "regression" | "in_scope" | "pre_existing" | "out_of_scope" | "unclear";
/** A required gate is always part of the task's contract: never out of its scope. */
export type GateOrigin = Exclude<Origin, "out_of_scope">;

/**
 * Whether a plan issue is about the task (task) or asks for more than it needs (out_of_scope: a suggestion, which never
 * holds the plan back). Absent in older critiques: the task's.
 */
export type IssueScope = "task" | "out_of_scope";

export interface Issue {
  id: string;
  severity: Severity;
  description: string;
  suggestion: string;
  scope: IssueScope;
}

/** One acceptance criterion of the task's contract; reviewers cite it by `id`. Older plans list bare strings. */
export interface Criterion {
  id: string;
  criterion: string;
}

/**
 * A fact an agent checked in the repository and leaves for the agents after it (schemas' `repo_notes`): the
 * workspace-relative file or folder it is about, which is how agentduo tells when it may no longer hold.
 */
export interface RepoNoteOutput {
  path: string;
  note: string;
}

export interface Plan {
  title: string;
  summary: string;
  goals: string[];
  scope_in: string[];
  scope_out: string[];
  architecture: string;
  steps: Array<{ id: string; description: string; files: string[] }>;
  acceptance_criteria: Criterion[];
  risks: Array<{ risk: string; mitigation: string }>;
  test_strategy: string;
  open_questions: string[];
  feedback_resolution: Array<{ issue_id: string; decision: "accepted" | "partially_accepted" | "disputed"; rationale: string }>;
  /** Every required quality gate that fails before any change, and whether the plan fixes it. */
  baseline_failures: Array<{ gate: string; in_scope: boolean; rationale: string }>;
  repo_notes: RepoNoteOutput[];
}

export interface Critique {
  status: ReviewStatus;
  approved: boolean;
  summary: string;
  issues: Issue[];
  accepted: string[];
  disputed: string[];
  proposed_changes: string[];
  /** Contradictions only the user can settle: settling them would change what the task asks. */
  conflicts: Array<{ id: string; description: string; between: string[] }>;
  repo_notes: RepoNoteOutput[];
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
  repo_notes: RepoNoteOutput[];
}

export interface Finding {
  id: string;
  severity: Severity;
  file: string;
  line: number | null;
  issue: string;
  recommendation: string;
  origin: Origin;
  /**
   * What shows the origin: what in the change causes it, or that it was there before (required for a blocking finding);
   * for a critical out_of_scope one, why it cannot wait.
   */
  evidence: string;
  /** The ids of the final plan's acceptance criteria it is about (a blocking in_scope finding names those it fails); absent in older reviews. */
  criteria: string[];
}

export interface Review {
  status: ReviewStatus;
  approved: boolean;
  reviewed_commit: string;
  summary: string;
  findings: Finding[];
  resolved_findings: string[];
  /** The reviewer's attribution of the failing required gates agentduo asks about (those that failed before any change too). */
  gate_failures: Array<{ gate: string; origin: GateOrigin; evidence: string }>;
  repo_notes: RepoNoteOutput[];
}
