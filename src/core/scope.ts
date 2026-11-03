import type { Approval, Critique, Criterion, Finding, Issue, Plan, Review } from "./outputs.js";
import type { Accepted, ScopeItem } from "./state.js";

/**
 * The task's scope as the run's acceptance contract. The final plan's acceptance criteria (each with an id) and scope
 * are what the change is held to; after implementation starts, only your `revise` changes them. Reviewers classify what
 * they report against it: a finding the task must fix names the criteria it fails, and anything beyond the task is a
 * suggestion, which never blocks and is never given to the implementer as work. Only you widen the scope: a critical
 * problem outside it, or a revised plan that adopts a suggestion outside it, stops the run for your decision.
 * See docs/superpowers/specs/2026-11-03-agentduo-scope-design.md.
 */

type Feedback = { critique?: Critique; approval?: Approval } | null;

/** A plan's criteria with their ids; an older plan's, listed as strings, are AC1, AC2… in their order. */
export function criteria(plan: Plan | null): Criterion[] {
  return (plan?.acceptance_criteria ?? []).map((c, i) => (typeof c === "string" ? { id: `AC${i + 1}`, criterion: c } : c));
}

export const criterionIds = (plan: Plan | null): string[] => criteria(plan).map((c) => c.id.trim());

/** The plan's check: a distinct id for every criterion, so that a finding can name the one it fails. */
export function criteriaErrors(plan: Plan): string[] {
  const ids = criterionIds(plan);
  const twice = [...new Set(ids.filter((id, i) => id && ids.indexOf(id) !== i))];
  return [
    ...twice.map((id) => `acceptance criterion '${id}' is listed twice: give each criterion its own id`),
    ...(ids.some((id) => !id) ? ["every acceptance criterion needs an 'id' (AC1, AC2, ...)"] : []),
  ];
}

/** The criteria a revision adds to the previous version. */
export function addedCriteria(previous: Plan | null, plan: Plan): Criterion[] {
  if (!previous) return [];
  const before = new Set(criterionIds(previous));
  return criteria(plan).filter((c) => !before.has(c.id.trim()));
}

const outside = (i: { scope?: string }) => i.scope === "out_of_scope";

/** The issues about the task itself: only these can hold a plan back. */
export const taskIssues = <T extends { scope?: string }>(issues: T[]): T[] => issues.filter((i) => !outside(i));

/** A critique or sign-off that refuses the plan for suggestions outside the task alone: they never hold it back. */
export function issueRefusalErrors(d: { approved: boolean; issues: Issue[]; conflicts?: unknown[] }): string[] {
  const extras = d.issues.filter(outside);
  if (d.approved || !extras.length || taskIssues(d.issues).length || d.conflicts?.length) return [];
  return [`'approved' is false, but every issue is outside the task's scope (${extras.map((i) => i.id).join(", ")}), and those never hold the ` +
    "plan back: approve it, or raise what the task itself needs as an issue with scope 'task'"];
}

/**
 * The suggestions outside the task that a revised plan adopted (accepted, even partly), less those you approved
 * already: each widens the task, which only you can approve.
 */
export function adoptedSuggestions(plan: Plan, feedback: Feedback, accepted: Accepted | undefined): ScopeItem[] {
  const extras = [...(feedback?.critique?.issues ?? []), ...(feedback?.approval?.issues ?? [])].filter(outside);
  const approved = new Set((accepted?.scope ?? []).filter((s) => s.kind === "suggestion").map((s) => s.id));
  return plan.feedback_resolution.filter((r) => r.decision !== "disputed").flatMap((r): ScopeItem[] => {
    const issue = extras.find((i) => i.id === r.issue_id);
    if (!issue || approved.has(issue.id)) return [];
    return [{ kind: "suggestion", id: issue.id, text: `[${issue.severity}] ${issue.description}`, evidence: `${r.decision}: ${r.rationale}` }];
  });
}

/** One scope decision, as the run's messages, details and records word it. */
export function scopeItemText(i: ScopeItem): string {
  return i.kind === "finding"
    ? `finding ${i.id} ${i.text}${i.evidence ? ` (justification: ${i.evidence})` : ""}`
    : `suggestion ${i.id} ${i.text}${i.evidence ? ` (the plan's answer: ${i.evidence})` : ""}`;
}

/** Why the run stops before the critique of a plan that widened the task, and what each choice does. */
export function expansionReview(items: ScopeItem[], added: Criterion[], version: number): { message: string; details: string[] } {
  return {
    message: `plan v${version} widens the task's scope: it adopts ${items.length} suggestion(s) that the reviewers marked as outside it, and ` +
      "nothing beyond the task is planned without your approval. 'resume' approves the wider scope (the critic reviews this plan as it is, and " +
      "DONE names what you approved; resume also if a note of yours asked for it); 'revise' with a --note re-plans (for example: keep to the " +
      "task, or keep only some of them); 'abort' ends the run.",
    details: [
      ...items.map(scopeItemText),
      ...(added.length ? [`acceptance criteria new in v${version}: ${added.map((c) => `${c.id} ${c.criterion}`).join("; ")}`] : []),
    ],
  };
}

/** Origins that make a finding the task's to fix. */
const TASK_ORIGINS = new Set(["regression", "in_scope", "unclear"]);

/**
 * The review's check against the contract: every criterion a finding cites is one of the final plan's, a blocking
 * in_scope finding names the criteria it fails, and a critical one outside the scope justifies itself. A review that
 * withholds approval must rest it on something that can hold it back: not on suggestions outside the task alone.
 * `decided`: the findings you accepted as pre-existing or kept out of the scope.
 */
export function reviewScopeErrors(o: {
  review: Review; criteria: string[]; blockingSeverities: string[]; requireApproval: boolean; gatesFailing: boolean; decided: Set<string>;
}): string[] {
  const known = new Set(o.criteria);
  const list = o.criteria.join(", ") || "it has none";
  const errors: string[] = [];
  for (const f of o.review.findings) {
    const cited = (f.criteria ?? []).map((c) => c.trim());
    for (const c of cited.filter((c) => !known.has(c))) errors.push(`finding '${f.id}' cites '${c}', which is not an acceptance criterion of the final plan (${list})`);
    if (f.origin === "in_scope" && o.blockingSeverities.includes(f.severity) && !cited.length) {
      errors.push(`finding '${f.id}' is in_scope and ${f.severity}, so 'criteria' must name the acceptance criteria it fails (${list}); a problem no ` +
        "criterion covers is out_of_scope, or a regression if the change causes it");
    }
    if (f.origin === "out_of_scope" && f.severity === "critical" && !f.evidence.trim()) {
      errors.push(`finding '${f.id}' is critical and out_of_scope, so its 'evidence' must justify why it cannot wait (the correctness or security problem)`);
    }
  }
  const extras = o.review.findings.filter((f) => f.origin === "out_of_scope");
  const holds = (f: Finding) => TASK_ORIGINS.has(f.origin) || (!o.decided.has(f.id) &&
    ((f.origin === "pre_existing" && o.blockingSeverities.includes(f.severity)) || (f.origin === "out_of_scope" && f.severity === "critical")));
  if (o.requireApproval && !o.review.approved && extras.length && !o.gatesFailing && !o.review.findings.some(holds)) {
    errors.push(`'approved' is false, but no finding the task must fix or that only the user can settle remains (${extras.map((f) => f.id).join(", ")} ` +
      "are outside the task's scope, and those never hold back approval): approve the change, or report what the task must still fix as a finding " +
      "(origin regression, in_scope with the criteria it fails, or unclear)");
  }
  return errors;
}

/** The critical findings outside the task's scope that you have not decided on: they block completion until you do. */
export function outOfScopeBlockers(findings: Finding[], decided: Set<string>): ScopeItem[] {
  return findings.filter((f) => f.origin === "out_of_scope" && f.severity === "critical" && !decided.has(f.id))
    .map((f) => ({ kind: "finding", id: f.id, text: `[${f.severity}] ${f.file ? `${f.file}: ` : ""}${f.issue}`, evidence: f.evidence }));
}

/** The findings you kept outside the task's scope: they no longer block, and no fix round takes them on. */
export const keptIds = (accepted: Accepted | undefined): Set<string> =>
  new Set((accepted?.scope ?? []).filter((s) => s.kind === "finding").map((s) => s.id));

/**
 * Why the run stops on critical problems outside the task's scope, and what each choice does. `next` is where `resume`
 * goes: the fix round for the task's own findings, DONE, or another review; `preexisting` the pre-existing failures
 * waiting for the same decision (worded as preexistingReview does).
 */
export function scopeReview(items: ScopeItem[], preexisting: string[], next: "IMPLEMENT" | "DONE" | "CODE_REVIEW"): { message: string; details: string[] } {
  const pre = preexisting.length ? ", accepts the pre-existing failures below too" : "";
  const then = next === "IMPLEMENT" ? ", and the fix round goes on with the task's own findings"
    : next === "DONE" ? `${pre}, and the run ends DONE` : `${pre}, and the reviewer reviews again, knowing that you did`;
  return {
    message: `the reviewer reports ${items.length} critical problem(s) outside the task's scope, which the change does not cause: fixing them would ` +
      "widen the task, which needs your approval, so the run stops instead of adding them to its work. 'resume' keeps the scope: they stay " +
      `unfixed in this run, named in DONE and the report${then}; 'revise' with a --note re-plans to bring them into the task's scope; 'abort' ends the run.`,
    details: [...items.map(scopeItemText), ...preexisting],
  };
}
