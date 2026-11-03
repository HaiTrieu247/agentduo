import { BUDGET_CONFIG, BUDGET_KEYS, describeLimit, usageOf } from "./budget.js";
import { decisionCommand } from "./decisions.js";
import { describeGates } from "./gates.js";
import type { Approval, Critique, Finding, Issue, Plan, Review } from "./outputs.js";
import { criteria } from "./scope.js";
import type { Phase, Role } from "../events.js";
import type { ProfileName } from "./config.js";
import { profileChangeLines, profileText } from "./profiles.js";
import type { PlanCycle, ProfileChange, RejectedAnswers, ReviewCycle, RoleUsage, RunState, TrackedFinding, Verification } from "./state.js";
import { verificationLines } from "./verification.js";

const bullets = (items: string[], empty = "_(none)_") => (items.length ? items.map((x) => `- ${x}`).join("\n") : empty);

export function planMarkdown(plan: Plan, version: number): string {
  const steps = plan.steps.map((s, i) => `${i + 1}. **${s.id}** ${s.description}`
    + (s.files.length ? `  \n   Files: ${s.files.map((f) => "`" + f + "`").join(", ")}` : "")).join("\n") || "_(none)_";
  const risks = plan.risks.map((r) => `- **${r.risk}** — ${r.mitigation}`).join("\n") || "_(none)_";
  const parts = [
    `# Plan v${version}: ${plan.title}`,
    plan.summary,
    "## Goals\n" + bullets(plan.goals),
    "## Scope\n**In scope**\n" + bullets(plan.scope_in) + "\n\n**Out of scope**\n" + bullets(plan.scope_out),
    "## Architecture\n" + (plan.architecture || "_(none)_"),
    "## Steps\n" + steps,
    // The task's acceptance contract: reviewers cite each criterion by its id.
    "## Acceptance criteria\n" + bullets(criteria(plan).map((c) => `**${c.id}** ${c.criterion}`)),
    "## Risks\n" + risks,
    "## Test strategy\n" + (plan.test_strategy || "_(none)_"),
    "## Open questions\n" + bullets(plan.open_questions),
  ];
  if (plan.baseline_failures?.length) {
    // Older plans have no such field.
    parts.push("## Baseline failures\nRequired gates that fail before any change:\n" + plan.baseline_failures.map((b) =>
      "- `" + b.gate + "`: " + (b.in_scope ? "**fixed by this plan**" : "**left out of scope**") + (b.rationale ? ` — ${b.rationale}` : "")).join("\n"));
  }
  if (plan.feedback_resolution.length) {
    parts.push("## Response to feedback\n" + plan.feedback_resolution.map((f) => "- `" + f.issue_id + "` **" + f.decision + "** — " + f.rationale).join("\n"));
  }
  return parts.join("\n\n") + "\n";
}

export function issuesMarkdown(issues: Issue[]): string {
  if (!issues.length) return "_(no issues)_";
  return issues.map((i) => "- `" + i.id + "` [" + i.severity + "] " + (i.scope === "out_of_scope" ? "(outside the task's scope) " : "") + i.description +
    (i.suggestion ? `  \n  Suggestion: ${i.suggestion}` : "")).join("\n");
}

export function critiqueMarkdown(c: Critique, round: number, planVersion: number, agent: string): string {
  const parts = [`## Round ${round} — ${agent} critique of plan v${planVersion}: **${c.status}**`, c.summary, "### Issues\n" + issuesMarkdown(c.issues)];
  if (c.accepted.length) parts.push("### Accepted planner responses\n" + bullets(c.accepted));
  if (c.disputed.length) parts.push("### Still disputed\n" + bullets(c.disputed));
  if (c.proposed_changes.length) parts.push("### Proposed changes\n" + bullets(c.proposed_changes));
  if (c.conflicts?.length) {
    parts.push("### Conflicts only the user can settle\n" + bullets(c.conflicts.map((k) => "`" + k.id + "` " + k.description + (k.between.length ? ` (between: ${k.between.join("; ")})` : ""))));
  }
  return parts.join("\n\n") + "\n\n";
}

export function approvalMarkdown(a: Approval, round: number, planVersion: number, agent: string): string {
  return [`## Round ${round} — ${agent} final decision on plan v${planVersion}: **${a.status}**`, a.summary, "### Issues\n" + issuesMarkdown(a.issues)].join("\n\n") + "\n\n";
}

export function findingsMarkdown(findings: Finding[]): string {
  if (!findings.length) return "_(no findings)_";
  return findings.map((f) => {
    const loc = f.file ? f.file + (f.line ? `:${f.line}` : "") : "(general)";
    return "- `" + f.id + "` [" + f.severity + "] `" + loc + "` — " + (f.origin === "out_of_scope" ? "(outside the task's scope) " : "") + f.issue +
      (f.criteria?.length ? `  \n  Criteria: ${f.criteria.join(", ")}` : "") + (f.recommendation ? `  \n  Recommendation: ${f.recommendation}` : "");
  }).join("\n");
}

const ROLE_NAMES: Record<RejectedAnswers["role"], string> = {
  planner: "planner", plan_reviewer: "plan critic", plan_finalizer: "plan sign-off", implementer: "implementer", code_reviewer: "code reviewer",
};

/** Each finding the reviews raised, by identity: its ids, words, the rounds that raised it, and where it stands. */
export function trackedLines(ledger: TrackedFinding[]): string[] {
  return ledger.map((e) => {
    const also = e.ids.filter((id) => id !== e.key);
    const words = e.firstIssue && e.firstIssue !== e.issue ? `${e.firstIssue} → ${e.issue}` : e.issue;
    const where = e.status === "resolved" ? `resolved by the review of round ${e.resolvedRound}` : "still open";
    return "`" + e.key + "`" + (also.length ? ` (also ${also.join(", ")})` : "") + ` [${e.severity}] ${e.file ? `${e.file} — ` : ""}${words}: ` +
      `raised in rounds ${e.seen.map((x) => x.round).join(", ")}; ${where}${e.reopened ? `; reopened ${e.reopened}×` : ""}`;
  });
}

/** Each review round: its findings against the ones before, and whether the cycle it closed made progress. */
export function cycleLines(cycles: ReviewCycle[]): string[] {
  return cycles.map((c) => {
    const n = c.counts;
    const progress = c.progress === null ? "" : c.progress.length ? ` — progress: ${c.progress.join("; ")}` : " — no progress";
    return `round ${c.round}: ${n.new} new, ${n.open} still open, ${n.reopened} reopened, ${n.resolved} resolved${progress}`;
  });
}

/**
 * Tokens, the cost the CLIs reported (and how many calls reported none, which it leaves out), agent calls and minutes
 * of work: the measures of the run's budget.
 */
export function usageSummary(st: RunState): string {
  const used = usageOf(st);
  const unpriced = st.unpricedCalls ?? 0;
  const cost = `reported cost $${used.cost.toFixed(2)}` + (unpriced ? ` (${unpriced} call(s) reported no cost, as Codex never does: the real cost is higher)` : "");
  return [`${Math.round(used.tokens).toLocaleString("en-US")} tokens`, cost, `${used.calls} agent call(s)`, `${Math.round(used.minutes * 10) / 10} min of work`].join(" · ");
}

/** Each limit of the run's budget, one line each: how much of it is used, and whether it was reached. */
export function budgetLines(st: RunState): string[] {
  const used = usageOf(st);
  return BUDGET_KEYS.filter((k) => st.budget?.limits[k] != null).map((k) => {
    const limit = st.budget!.limits[k]!;
    const share = Math.floor((used[k] / limit) * 100);
    return `${describeLimit(k, used[k], limit)} (${share}%, limits.${BUDGET_CONFIG[k]})${used[k] >= limit ? ": reached" : ""}`;
  });
}

const ROLE_ORDER: Role[] = ["planner", "plan_reviewer", "plan_finalizer", "implementer", "code_reviewer"];

/**
 * What a run spent and how it went, for comparing profiles on the same task (metrics.json, the report, `duo status`).
 * Built from what the run already keeps: its usage and budget counters, its timeline and its verification record.
 */
export interface RunMetrics {
  profile: { initial: ProfileName; final: ProfileName; escalations: ProfileChange[] };
  outcome: Phase;
  /** The final verification's status; null before DONE (or for a run that ended before it existed). */
  verification: Verification["status"] | null;
  /** passed (on the final code), exceptions (failures you accepted), failing, not_run, not_configured. */
  requiredGates: "passed" | "exceptions" | "failing" | "not_run" | "not_configured";
  /** The last review's verdict, or none yet. */
  review: "approved" | "changes requested" | "none";
  agentCalls: number;
  byRole: Partial<Record<Role, RoleUsage>>;
  tokens: number;
  costUsd: number;
  unpricedCalls: number;
  planningRounds: number;
  implementationRounds: number;
  /** The steps the timeline recorded: agent turns by kind, and gate runs (the baseline included). */
  steps: { plans: number; critiques: number; signOffs: number; implementations: number; reviews: number; gateRuns: number };
  /** Times the run stopped for your decision. */
  decisions: number;
  workMinutes: number;
  wallMinutes: number;
}

const AGENTS = new Set(["Codex", "Claude"]);

export function runMetrics(st: RunState): RunMetrics {
  const used = usageOf(st);
  const turns = (phase: Phase) => st.history.filter((h) => h.phase === phase && AGENTS.has(h.agent)).length;
  const lastReview = [...st.history].reverse().find((h) => h.phase === "CODE_REVIEW" && AGENTS.has(h.agent));
  const v = st.verification;
  let gates: RunMetrics["requiredGates"];
  if (v) {
    const accepted = v.gates.some((g) => g.outcome === "accepted");
    gates = !v.gates.length ? "not_configured" : v.status === "not_enforced" ? "failing" : accepted ? "exceptions" : "passed";
  } else if (!st.lastGates) {
    // A null baseline: no gate was configured when the run started.
    gates = st.baseline === null || st.gatesConfig?.length === 0 ? "not_configured" : "not_run";
  } else {
    gates = st.lastGates.every((g) => g.passed || !g.required) ? "passed" : "failing";
  }
  const wall = (Date.parse(st.updatedAt) - Date.parse(st.createdAt)) / 60_000;
  return {
    profile: { initial: st.profile?.initial ?? "standard", final: st.profile?.name ?? "standard", escalations: st.profile?.changes ?? [] },
    outcome: st.phase, verification: v?.status ?? null, requiredGates: gates,
    review: !lastReview ? "none" : lastReview.status === "approved" ? "approved" : "changes requested",
    agentCalls: used.calls, byRole: st.usageByRole ?? {}, tokens: used.tokens, costUsd: used.cost, unpricedCalls: st.unpricedCalls ?? 0,
    planningRounds: st.planningRound, implementationRounds: st.implRound,
    steps: {
      plans: turns("PLAN"), critiques: turns("PLAN_REVIEW"), signOffs: turns("PLAN_FINALIZE"), implementations: turns("IMPLEMENT"),
      reviews: turns("CODE_REVIEW"), gateRuns: st.history.filter((h) => h.agent === "gates").length,
    },
    decisions: st.history.filter((h) => h.phase === "HUMAN_REVIEW" && h.agent === "orchestrator").length,
    workMinutes: Math.round(used.minutes * 10) / 10, wallMinutes: Number.isFinite(wall) ? Math.round(wall * 10) / 10 : 0,
  };
}

const ROLE_WORDS: Record<Role, string> = {
  planner: "planner", plan_reviewer: "plan critic", plan_finalizer: "plan sign-off", implementer: "implementer", code_reviewer: "code reviewer",
};

/** The run's profile and metrics, one line each (the report and `duo status`). */
export function metricsLines(st: RunState): string[] {
  const m = runMetrics(st);
  const roles = ROLE_ORDER.filter((r) => m.byRole[r]?.calls).map((r) => {
    const u = m.byRole[r]!;
    const cost = u.costUsd ? ` · $${u.costUsd.toFixed(2)}` : "";
    return `${ROLE_WORDS[r]} ${u.calls} · ${Math.round(u.tokens).toLocaleString("en-US")} tokens${cost}${u.unpricedCalls ? ` (${u.unpricedCalls} unpriced)` : ""}`;
  });
  const s = m.steps;
  return [
    `profile: ${profileText(st.profile)}`,
    ...profileChangeLines(st.profile).map((l) => `escalated: ${l}`),
    `agent calls: ${m.agentCalls}${roles.length ? ` (${roles.join("; ")})` : ""}`,
    `steps: ${s.plans} plan(s), ${s.critiques} critique(s), ${s.signOffs} sign-off(s), ${s.implementations} implementation(s), ${s.reviews} review(s), ` +
      `${s.gateRuns} gate run(s); planning rounds ${m.planningRounds}, implementation rounds ${m.implementationRounds}; ${m.decisions} decision(s) asked of you`,
    `outcome: ${m.outcome}${m.verification ? ` (${m.verification})` : ""}; required gates: ${m.requiredGates.split("_").join(" ")}; review: ${m.review}; ` +
      `${m.workMinutes} min of work, ${m.wallMinutes} min wall clock`,
  ];
}

/** Each critique that sent the plan back: what still blocked, and whether the revision before it made progress. */
export function planCycleLines(cycles: PlanCycle[]): string[] {
  return cycles.filter((c) => c.blocking.length).map((c) => {
    const progress = c.progress === null ? "" : c.progress.length ? ` — progress: ${c.progress.join("; ")}` : " — no progress";
    return `round ${c.round}: blocking ${c.blocking.join(", ")}${progress}`;
  });
}

export function reportMarkdown(st: RunState, diffStat: string, lastReview: Review | null, lastCritique: Critique | null, runDir: string): string {
  const hr = st.humanReview;
  const lines = [
    `# agentduo report — ${st.taskId}`,
    `- **Status:** ${st.phase}` + (st.phase === "HUMAN_REVIEW" && hr ? ` — ${hr.reason}: ${hr.message}` : ""),
    `- **Task:** ${st.task}`,
    `- **Started:** ${st.createdAt} · **Updated:** ${st.updatedAt}`,
    `- **Planning rounds:** ${st.planningRound} · **Plan version:** ${st.planVersion} · **Final plan:** ${st.finalPlanVersion ? `v${st.finalPlanVersion}` : "—"}`,
    `- **Implementation rounds:** ${st.implRound}`,
    `- **Usage:** ${usageSummary(st)}`,
    "- **Run directory:** `" + runDir + "`",
  ];
  if (st.git?.mode === "internal") {
    lines.push("- **Snapshots:** agentduo's own Git repository `" + st.git.gitDir + "`, outside the workspace (kept after the run, to read its history)");
  }
  if (st.base && st.lastSnapshot && st.git?.mode === "internal") {
    lines.push("- **Diff:** `git --git-dir \"" + st.git.gitDir + "\" diff " + st.base.commit.slice(0, 12) + " " + st.lastSnapshot.commit.slice(0, 12) +
      "` (from anywhere; or open Changes in the editor or the app; each review's whole diff is `diff.r<round>.patch` in the run directory; " +
      "changes are left in your files)");
  } else if (st.base && st.lastSnapshot) {
    lines.push("- **Diff:** `git diff " + st.base.commit.slice(0, 12) + " " + st.lastSnapshot.commit.slice(0, 12) + " -- .` (run it in the workspace; changes are left uncommitted in your working tree)");
  }
  const budget = budgetLines(st);
  if (budget.length) lines.push("\n## Budget\n" + bullets(budget));
  lines.push("\n## Profile and metrics\n" + bullets(metricsLines(st)));
  const planning = planCycleLines(st.planCycles ?? []);
  if (planning.length) lines.push("\n## Planning rounds\n" + bullets(planning));
  lines.push("\n## Timeline");
  for (const h of st.history) lines.push(`${h.step}. \`${h.phase}\` r${h.round} **${h.agent}** — ${h.status}: ${h.summary}`);
  // What DONE rests on, or how current the gates' results are: never "passed" for results about other code.
  lines.push("\n## Verification\n" + bullets(verificationLines(st)));
  lines.push("\n## Quality gates (last run)");
  lines.push(st.lastGates?.length ? describeGates(st.lastGates, false) : "_(not run)_");
  if (st.baseline?.results.length) lines.push("\n## Quality gates before any change (baseline)\n" + describeGates(st.baseline.results, false));
  const accepted = [...(st.accepted?.conflicts ?? []).map((c) => `[conflict, implemented as planned] ${c}`),
    ...(st.accepted?.failures ?? []).map((f) => `[pre-existing ${f.kind}] \`${f.id}\` ${f.text}${f.evidence ? ` — evidence: ${f.evidence}` : ""}`),
    ...(st.accepted?.scope ?? []).map((i) => (i.kind === "finding"
      ? `[kept outside the task's scope] \`${i.id}\` ${i.text}${i.evidence ? ` — justification: ${i.evidence}` : ""}`
      : `[scope widened] \`${i.id}\` ${i.text}${i.evidence ? ` — the plan's answer: ${i.evidence}` : ""}`))];
  if (accepted.length) lines.push("\n## Accepted by you\nThe run would have stopped on these; your decision let it go on.\n" + bullets(accepted));
  // Older runs have none of these.
  if (st.trackedFindings?.length) lines.push("\n## Findings across reviews\n" + bullets(trackedLines(st.trackedFindings)));
  if (st.cycles?.length) lines.push("\n## Review rounds\n" + bullets(cycleLines(st.cycles)));
  if (st.rejected?.length) {
    lines.push("\n## Rejected answers\n" + bullets(st.rejected.map((r) => `${ROLE_NAMES[r.role] ?? r.role}, round ${r.round}: ${r.count} answer(s) rejected ` +
      `(${r.errors.join("; ")}); ${r.outcome === "failed" ? "the call failed" : "a later answer was accepted"}`)));
  }
  if (diffStat.trim()) lines.push("\n## Diff stat\n```\n" + diffStat.trimEnd() + "\n```");
  const unresolved: string[] = [];
  if (lastReview) {
    // Each finding holds for the revision it was raised on; an answer since is the implementer's claim, not yet verified.
    const current = st.findingsSource === undefined || st.findingsSource?.revision === lastReview.reviewed_commit;
    const answers = new Map((current ? st.findingResponses ?? [] : []).map((r) => [r.id, r]));
    for (const f of lastReview.findings) {
      const a = answers.get(f.id);
      const answer = a ? `; the implementer answered ${a.resolution} in round ${a.round}, not re-reviewed yet` : "";
      const origin = f.origin === "pre_existing" ? "; pre-existing, outside the task's scope"
        : f.origin === "out_of_scope" ? "; outside the task's scope, not the task's to fix" : "";
      const trace = f.criteria?.length ? `; criteria ${f.criteria.join(", ")}` : "";
      unresolved.push(`[review ${f.severity}] \`${f.id}\` ${f.file} — ${f.issue} (raised on \`${lastReview.reviewed_commit.slice(0, 12)}\`${trace}${origin}${answer})`);
    }
  } else if (lastCritique && st.phase !== "DONE") {
    for (const i of lastCritique.issues) unresolved.push(`[plan ${i.severity}] \`${i.id}\` ${i.description}`);
  }
  const acceptedGates = new Set((st.accepted?.failures ?? []).filter((f) => f.kind === "gate").map((f) => f.id));
  for (const g of st.lastGates ?? []) {
    if (!g.passed) unresolved.push(`[gate] ${g.name} failed (${g.required ? "required" : "optional"}${g.required && acceptedGates.has(g.name) ? "; failing as before the task, accepted by you" : ""})`);
  }
  for (const d of st.lastImplementation?.permissionDenials ?? []) {
    unresolved.push(`[permission denied] ${d.tool_name}: ${JSON.stringify(d.tool_input ?? "").slice(0, 160)}`);
  }
  lines.push("\n## Unresolved issues\n" + bullets(unresolved));
  if (st.warnings?.length) lines.push("\n## Warnings\n" + bullets(st.warnings));
  if (st.phase === "HUMAN_REVIEW" && hr) {
    lines.push("\n## Next step\n" + hr.message + "\n\n```bash\n" + decisionCommand("duo", st.taskId, hr.reason) + "\n```");
  }
  return lines.join("\n") + "\n";
}
