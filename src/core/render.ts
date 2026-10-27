import { describeGates } from "./gates.js";
import type { Approval, Critique, Finding, Issue, Plan, Review } from "./outputs.js";
import type { RunState } from "./state.js";

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
    "## Acceptance criteria\n" + bullets(plan.acceptance_criteria),
    "## Risks\n" + risks,
    "## Test strategy\n" + (plan.test_strategy || "_(none)_"),
    "## Open questions\n" + bullets(plan.open_questions),
  ];
  if (plan.feedback_resolution.length) {
    parts.push("## Response to feedback\n" + plan.feedback_resolution.map((f) => "- `" + f.issue_id + "` **" + f.decision + "** — " + f.rationale).join("\n"));
  }
  return parts.join("\n\n") + "\n";
}

export function issuesMarkdown(issues: Issue[]): string {
  if (!issues.length) return "_(no issues)_";
  return issues.map((i) => "- `" + i.id + "` [" + i.severity + "] " + i.description + (i.suggestion ? `  \n  Suggestion: ${i.suggestion}` : "")).join("\n");
}

export function critiqueMarkdown(c: Critique, round: number, planVersion: number, agent: string): string {
  const parts = [`## Round ${round} — ${agent} critique of plan v${planVersion}: **${c.status}**`, c.summary, "### Issues\n" + issuesMarkdown(c.issues)];
  if (c.accepted.length) parts.push("### Accepted planner responses\n" + bullets(c.accepted));
  if (c.disputed.length) parts.push("### Still disputed\n" + bullets(c.disputed));
  if (c.proposed_changes.length) parts.push("### Proposed changes\n" + bullets(c.proposed_changes));
  return parts.join("\n\n") + "\n\n";
}

export function approvalMarkdown(a: Approval, round: number, planVersion: number, agent: string): string {
  return [`## Round ${round} — ${agent} final decision on plan v${planVersion}: **${a.status}**`, a.summary, "### Issues\n" + issuesMarkdown(a.issues)].join("\n\n") + "\n\n";
}

export function findingsMarkdown(findings: Finding[]): string {
  if (!findings.length) return "_(no findings)_";
  return findings.map((f) => {
    const loc = f.file ? f.file + (f.line ? `:${f.line}` : "") : "(general)";
    return "- `" + f.id + "` [" + f.severity + "] `" + loc + "` — " + f.issue + (f.recommendation ? `  \n  Recommendation: ${f.recommendation}` : "");
  }).join("\n");
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
    `- **Claude cost (reported):** $${(st.costUsd ?? 0).toFixed(2)} · **Codex tokens:** ${st.tokens ?? 0}`,
    "- **Run directory:** `" + runDir + "`",
  ];
  if (st.base && st.lastSnapshot) {
    lines.push("- **Diff:** `git diff " + st.base.commit.slice(0, 12) + " " + st.lastSnapshot.commit.slice(0, 12) + "` (changes are left uncommitted in your working tree)");
  }
  lines.push("\n## Timeline");
  for (const h of st.history) lines.push(`${h.step}. \`${h.phase}\` r${h.round} **${h.agent}** — ${h.status}: ${h.summary}`);
  lines.push("\n## Quality gates (last run)");
  lines.push(st.lastGates?.length ? describeGates(st.lastGates, false) : "_(not run)_");
  if (diffStat.trim()) lines.push("\n## Diff stat\n```\n" + diffStat.trimEnd() + "\n```");
  const unresolved: string[] = [];
  if (lastReview) {
    for (const f of lastReview.findings) unresolved.push(`[review ${f.severity}] \`${f.id}\` ${f.file} — ${f.issue}`);
  } else if (lastCritique && st.phase !== "DONE") {
    for (const i of lastCritique.issues) unresolved.push(`[plan ${i.severity}] \`${i.id}\` ${i.description}`);
  }
  for (const g of st.lastGates ?? []) if (!g.passed) unresolved.push(`[gate] ${g.name} failed (${g.required ? "required" : "optional"})`);
  for (const d of st.lastImplementation?.permissionDenials ?? []) {
    unresolved.push(`[permission denied] ${d.tool_name}: ${JSON.stringify(d.tool_input ?? "").slice(0, 160)}`);
  }
  lines.push("\n## Unresolved issues\n" + bullets(unresolved));
  if (st.phase === "HUMAN_REVIEW" && hr) {
    lines.push("\n## Next step\n" + hr.message + "\n\n```bash\nduo resume " + st.taskId + " --decision resume|revise|abort [--note \"...\"]\n```");
  }
  return lines.join("\n") + "\n";
}
