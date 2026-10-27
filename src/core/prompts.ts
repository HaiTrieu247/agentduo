import type { GateConfig } from "./config.js";
import { describeGates, type GateResult } from "./gates.js";
import type { Approval, Critique, Finding, Implementation, Plan, Review } from "./outputs.js";
import { findingsMarkdown, issuesMarkdown } from "./render.js";
import type { HumanNote } from "./state.js";

export interface PromptContext {
  repo: string;
  taskId: string;
  task: string;
  gates: GateConfig[];
  notes: HumanNote[];
}

export interface PlanFeedback {
  critique?: Critique;
  approval?: Approval;
}

export const SEVERITY_GUIDE = [
  "Severity scale:",
  "- critical: the work cannot succeed as written, or it would cause damage (data loss, security hole, broken build for everyone).",
  "- high: a significant gap or defect that must be fixed before moving on.",
  "- medium: should be fixed, but does not block.",
  "- low: minor improvement or nit.",
].join("\n");

export const READONLY_RULES =
  "## Hard rules\n" +
  "- You are READ-ONLY. Do not create, modify, move or delete any file, and do not run commands that " +
  "change the repository, its git state or the network. The orchestrator verifies the working tree " +
  "is byte-for-byte unchanged after your turn and escalates to a human if it is not.\n" +
  "- Inspect the repository as needed (read files, search, read-only git commands such as " +
  "`git log`, `git show`, `git diff <a> <b>`).\n" +
  "- Your final message must be a single JSON object matching the provided output schema. " +
  "No prose outside the JSON.\n";

function header(role: string, title: string, ctx: PromptContext): string {
  return "[orchestrator-role: " + role + "]\n" +
    "You are the **" + title + "** in an automated multi-agent software workflow driven by an orchestrator (agentduo).\n" +
    "Team: Codex designs and plans, then reviews code (never edits files). Claude Code critiques plans for " +
    "feasibility and is the only agent that edits files. Agreement between agents is not proof of " +
    "correctness: the orchestrator runs the project's quality gates independently.\n\n" +
    "- Repository: `" + ctx.repo + "`\n" +
    "- Task ID: `" + ctx.taskId + "`\n";
}

function gateList(gates: GateConfig[]): string {
  if (!gates.length) return "_(none configured)_";
  return gates.map((g) => "- `" + g.command + "` (" + g.name + ", " + (g.required === false ? "optional" : "required") + ")").join("\n");
}

function notes(list: HumanNote[]): string {
  if (!list.length) return "";
  return "\n## Notes from the human operator (highest priority)\n" + list.map((n) => `- (${n.at}, during ${n.phase}) ${n.note}`).join("\n") + "\n";
}

function feedbackSection(feedback: PlanFeedback | null): string {
  if (!feedback) return "";
  const parts = ["\n## Feedback to address"];
  const { critique, approval } = feedback;
  if (critique) {
    parts.push(`### Plan critique (status: ${critique.status})\n${critique.summary}\n\n` + issuesMarkdown(critique.issues));
    if (critique.proposed_changes.length) parts.push("Proposed changes:\n" + critique.proposed_changes.map((c) => `- ${c}`).join("\n"));
    if (critique.disputed.length) parts.push("Critic still disputes:\n" + critique.disputed.map((c) => `- ${c}`).join("\n"));
  }
  if (approval) parts.push(`### Final-approval review (status: ${approval.status})\n${approval.summary}\n\n` + issuesMarkdown(approval.issues));
  return parts.join("\n\n") + "\n";
}

export function planner(ctx: PromptContext, round: number, version: number, previousPlan: Plan | null, feedback: PlanFeedback | null): string {
  const out = [
    header("planner", "Planner / Architect", ctx),
    `- Planning round: ${round} · Producing plan version: v${version}\n`,
    "## Task\n" + ctx.task + "\n",
    notes(ctx.notes),
    READONLY_RULES,
    "## Your job\n" +
      "Study the repository and produce an implementation plan that another agent (Claude Code) can " +
      "execute without further clarification.\n" +
      "- Goals and explicit scope (in / out). Keep the scope to what the task needs.\n" +
      "- Architecture / design decisions that fit the existing code and conventions.\n" +
      "- Ordered, concrete steps; list the files each step creates or changes.\n" +
      "- Acceptance criteria that are objective and testable.\n" +
      "- Risks with mitigations, and a test strategy (which tests to add or update).\n" +
      "- Open questions only for things that truly cannot be decided from the repository; " +
      "state the assumption you made for each.\n\n" +
      "After implementation the orchestrator will run these quality gates, which must pass:\n" + gateList(ctx.gates) + "\n",
  ];
  if (!previousPlan) {
    out.push("\nThis is the first version: return `feedback_resolution` as an empty list.\n");
  } else {
    out.push(`\n## Previous plan (v${version - 1}) as JSON\n` + "```json\n" + JSON.stringify(previousPlan, null, 2) + "\n```\n");
    out.push(feedbackSection(feedback));
    out.push("\nRevise the plan to address the feedback. In `feedback_resolution`, add one entry per issue id " +
      "above with decision `accepted`, `partially_accepted` or `disputed` and a rationale. Dispute only " +
      "with a concrete technical reason; disputed critical/high issues will go back to the critic.\n");
  }
  return out.join("\n");
}

export function planReviewer(ctx: PromptContext, round: number, version: number, planMd: string, previousCritique: Critique | null): string {
  const out = [
    header("plan_reviewer", "Plan Critic", ctx),
    `- Planning round: ${round} · Plan under review: v${version}\n`,
    "## Task\n" + ctx.task + "\n",
    notes(ctx.notes),
    READONLY_RULES,
    "## Plan under review\n" + planMd + "\n",
    "## Your job\n" +
      "You will implement this plan later, so judge whether it is feasible in THIS codebase:\n" +
      "- Do the files, modules, APIs and commands it relies on actually exist and work as assumed?\n" +
      "- Missing steps, wrong ordering, hidden dependencies, migration or compatibility concerns.\n" +
      "- Are the acceptance criteria objective and testable with the quality gates below?\n" +
      "- Risks the planner missed; unnecessary scope; ambiguity that would force guessing.\n\n" +
      "Quality gates that must pass after implementation:\n" + gateList(ctx.gates) + "\n\n" +
      SEVERITY_GUIDE + "\n\n" +
      "Decision rules:\n" +
      "- Set `approved: true` and `status: \"approved\"` only if no critical or high issue remains. " +
      "Medium/low issues may accompany an approval as suggestions.\n" +
      "- Give each issue a stable id (`C1`, `C2`, ...). Reuse the same id when you re-raise an issue " +
      "from a previous round.\n" +
      "- `accepted`: planner responses (by issue id and short reason) you now agree with. `disputed`: " +
      "planner responses you still disagree with, with your reasoning; re-raise any still-blocking one " +
      "in `issues`.\n" +
      "- `proposed_changes`: concrete edits to the plan you recommend.\n",
  ];
  if (previousCritique) {
    out.push("\n## Your critique from the previous round\n" + issuesMarkdown(previousCritique.issues) +
      "\n\nCheck how the new plan version addressed each of these (see its 'Response to feedback' section).\n");
  }
  return out.join("\n");
}

export function planFinalizer(ctx: PromptContext, round: number, version: number, planMd: string, critique: Critique): string {
  return [
    header("plan_finalizer", "Planner / Architect (final plan sign-off)", ctx),
    `- Planning round: ${round} · Plan up for sign-off: v${version}\n`,
    "## Task\n" + ctx.task + "\n",
    notes(ctx.notes),
    READONLY_RULES,
    "## Plan\n" + planMd + "\n",
    "## The critic approved this version\n" + critique.summary + "\n\nRemaining suggestions:\n" + issuesMarkdown(critique.issues) + "\n",
    "## Your job\n" +
      "Confirm whether this exact plan version is final and ready for implementation. Approve " +
      "(`approved: true`, `status: \"approved\"`) unless you find a critical or high problem; then return " +
      "`changes_requested` with issues (ids `A1`, `A2`, ...) and the plan goes through another revision " +
      "round. Do not request changes for style or wording alone.\n\n" + SEVERITY_GUIDE + "\n",
  ].join("\n");
}

export function implementer(ctx: PromptContext, round: number, planMd: string, protectedPaths: string[], findings: Finding[],
  review: Review | null, failedGates: GateResult[], previousReport: { summary: string | null } | null): string {
  const out = [
    header("implementer", "Implementer", ctx),
    `- Implementation round: ${round}\n`,
    "## Task\n" + ctx.task + "\n",
    notes(ctx.notes),
    "## Final approved plan\n" + planMd + "\n",
    "## Hard rules\n" +
      "- You are the only agent allowed to edit files. Stay within the plan's scope.\n" +
      "- Never commit, push, reset, stash, switch branches or rewrite git history; the orchestrator " +
      "snapshots your changes itself and leaves them uncommitted for the human.\n" +
      "- Do not touch these protected paths: " + protectedPaths.map((p) => "`" + p + "`").join(", ") + ".\n" +
      "- Do not delete files unless the plan requires it. No network access, no deploys, no secrets.\n" +
      "- Run the quality gates yourself before finishing and fix what fails:\n" + gateList(ctx.gates) + "\n" +
      "- Shell access is an allowlist matched per command: run each check as its own Bash call, " +
      "exactly as written above. Chained commands (`;`, `&&`, `|`) do not match and are denied.\n" +
      "- If you cannot proceed (missing information, contradictory requirements, missing permissions), " +
      "stop and return `status: \"blocked\"` with a precise `blocking_reason`.\n" +
      "- Your final message must be a single JSON object matching the output schema: summary, " +
      "files_changed, tests_run (what you actually ran and whether it passed) and addressed_findings.\n",
  ];
  if (round === 1 && !findings.length && !failedGates.length) {
    out.push("\nImplement the plan now. `addressed_findings` should be an empty list.\n");
  } else {
    out.push("\n## This is a fix round\nYour previous implementation is already in the working tree. " +
      "Address the problems below without redoing unrelated work.\n");
    if (findings.length) {
      const sha = review ? review.reviewed_commit.slice(0, 12) : "?";
      out.push("### Code review findings (reviewed revision `" + sha + "`)\n" + (review ? review.summary + "\n\n" : "") +
        findingsMarkdown(findings) + "\n\nFor every finding id, add an entry to `addressed_findings`: `fixed`, " +
        "`not_applicable`, or `disputed` with a concrete technical justification.\n");
    }
    if (failedGates.length) out.push("### Failing quality gates (run by the orchestrator)\n" + describeGates(failedGates) + "\n");
    if (previousReport?.summary) out.push("### Your previous report\n" + previousReport.summary + "\n");
  }
  return out.join("\n");
}

export function codeReviewer(ctx: PromptContext, round: number, planMd: string, base: string, snapshot: string, gateResults: GateResult[],
  diffStat: string, diff: string, truncated: boolean, previousFindings: Finding[], implReport: Implementation): string {
  const tests = implReport.tests_run.map((t) => "- `" + t.command + "` passed=" + t.passed + " " + t.notes).join("\n") || "_(none)_";
  const out = [
    header("code_reviewer", "Code Reviewer", ctx),
    `- Review round: ${round}\n` +
      "- Revision under review: `" + snapshot + "` (orchestrator snapshot of the working tree)\n" +
      "- Base revision: `" + base + "`\n",
    "## Task\n" + ctx.task + "\n",
    notes(ctx.notes),
    READONLY_RULES,
    "## Final approved plan\n" + planMd + "\n",
    "## Quality gate results (authoritative, run by the orchestrator on this revision)\n" + describeGates(gateResults) + "\n",
    "## Implementer's report\n" + implReport.summary + "\n\nTests the implementer says it ran:\n" + tests + "\n",
    "## Diff stat (base → revision)\n```\n" + (diffStat.trimEnd() || "(no changes)") + "\n```\n",
    "## Diff" + (truncated ? " (TRUNCATED: run `git diff " + base + " " + snapshot + "` for the full diff)" : "") + "\n```diff\n" + diff + "\n```\n",
  ];
  if (previousFindings.length) {
    const responses = new Map(implReport.addressed_findings.map((a) => [a.finding_id, a]));
    const lines = previousFindings.map((f) => {
      const r = responses.get(f.id);
      const reply = r ? `${r.resolution}: ${r.notes}` : "no response";
      return "- `" + f.id + "` [" + f.severity + "] " + f.file + " — " + f.issue + "  \n  Implementer: " + reply;
    });
    out.push("## Findings from the previous review and the implementer's responses\n" + lines.join("\n") +
      "\n\nVerify each one against the new revision. List ids that are now resolved in `resolved_findings`; " +
      "re-raise unresolved ones in `findings` with the same id. Accept a dispute only if the justification is technically sound.\n");
  }
  out.push(
    "## Your job\n" +
    "Review the change against the plan and its acceptance criteria: correctness, edge cases, error " +
    "handling, security, test adequacy, scope creep, and consistency with the codebase's conventions. " +
    "The working tree currently equals the revision under review, so you may read files directly.\n\n" +
    SEVERITY_GUIDE + "\n\n" +
    "Decision rules:\n" +
    "- Approve (`approved: true`, `status: \"approved\"`) only if there is no critical or high finding, " +
    "the acceptance criteria are met and the required quality gates pass.\n" +
    "- `reviewed_commit` must be exactly `" + snapshot + "`.\n" +
    "- New finding ids continue the sequence `F1`, `F2`, ...; `file` is repo-relative (empty string if " +
    "general) and `line` may be null.\n");
  return out.join("\n");
}
