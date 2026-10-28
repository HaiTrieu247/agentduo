import type { DiscussionStep, Verdict } from "../events.js";
import type { AgentRole, Backend, GateConfig } from "./config.js";
import { describeGates, type GateResult } from "./gates.js";
import type { Approval, Critique, Finding, Implementation, Plan, Review } from "./outputs.js";
import { findingsMarkdown, issuesMarkdown } from "./render.js";
import type { ConversationContext, EarlierTask, Exchange, HumanNote } from "./state.js";

export interface PromptContext {
  repo: string;
  taskId: string;
  task: string;
  agents: Record<AgentRole, Backend>;
  gates: GateConfig[];
  notes: HumanNote[];
  earlier?: EarlierTask[];
  /** The chat's conversation when the run started; every role sees the same one. */
  conversation?: ConversationContext;
}

/** The first line of a conversation prompt: not an orchestrator role, so no schema and no role instructions. */
export const CONVERSATION_MARKER = "[agentduo-conversation]";

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

export const OUTPUT_RULES = "## Output\nYour final message must be a single JSON object matching the provided output schema. No prose outside the JSON.\n";

const NAMES: Record<Backend, string> = { codex: "Codex", claude: "Claude Code" };

/** A markdown fence longer than any backtick run inside `text`, so the text cannot close it early. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function header(role: string, title: string, ctx: PromptContext): string {
  const a = ctx.agents;
  return "[orchestrator-role: " + role + "]\n" +
    "You are the **" + title + "** in a two-agent software workflow. agentduo only relays structured messages between the agents.\n" +
    "Roles: planner and plan sign-off: " + NAMES[a.planner] + "; plan critic: " + NAMES[a.plan_reviewer] + "; implementer: " +
    NAMES[a.implementer] + "; code reviewer: " + NAMES[a.code_reviewer] + ".\n" +
    "Follow your own configuration and the repository's instructions (AGENTS.md / CLAUDE.md).\n\n" +
    "- Workspace: `" + ctx.repo + "`\n" +
    "- Task ID: `" + ctx.taskId + "`\n";
}

function gateList(gates: GateConfig[]): string {
  return gates.map((g) => "- `" + g.command + "` (" + g.name + ", " + (g.required === false ? "optional" : "required") + ")").join("\n");
}

/** The pipeline tasks of the chat so far; the one place an outcome is told, in pipeline and conversation prompts alike. */
export function earlierTasks(list: EarlierTask[] = [], current = true): string {
  if (!list.length) return "";
  return "\n## Previous pipeline tasks\nThe user gave these tasks to the pipeline " + (current ? "before this one" : "earlier in this chat") +
    ", in this workspace; their changes are already in the working tree.\n" + list.map((t, i) => `${i + 1}. ${t.task} — ${t.outcome}`).join("\n") + "\n";
}

function exchangeText(e: Exchange): string {
  const name = NAMES[e.backend];
  if (e.discussedWith) {
    const other = NAMES[e.discussedWith];
    return `**User → ${name} (discussed with ${other}):**\n${e.question.trim()}\n\n**${name}, after discussing it with ${other}:**\n${e.answer.trim()}`;
  }
  return `**User → ${name}:**\n${e.question.trim()}\n\n**${name}:**\n${e.answer.trim()}`;
}

/** What was said in the chat, oldest first, and how many older exchanges did not fit. */
export function conversationSection(conversation: ConversationContext | undefined, title: string, intro: string): string {
  if (!conversation?.exchanges.length) return "";
  const omitted = conversation.omitted ? `(${conversation.omitted} older exchange(s) are left out.)\n` : "";
  return `\n## ${title}\n${intro}\n${omitted}\n${conversation.exchanges.map(exchangeText).join("\n\n")}\n`;
}

function earlier(ctx: PromptContext): string {
  return earlierTasks(ctx.earlier) + conversationSection(ctx.conversation, "Conversation before this task",
    "Before giving this task, the user talked about it with Claude Code and Codex in this chat. Use it as context; the task above is what to do.");
}

/**
 * A question of the three-way chat for one agent: who is talking, what was said, the pipeline tasks so far, and the
 * question itself, which appears exactly once, last.
 */
export function conversation(o: { workspace: string; backend: Backend; context: ConversationContext; earlier: EarlierTask[]; question: string }): string {
  const name = NAMES[o.backend];
  const other = NAMES[o.backend === "codex" ? "claude" : "codex"];
  return [
    CONVERSATION_MARKER,
    `This is a three-way conversation in the workspace \`${o.workspace}\` between the user, Claude Code and Codex; agentduo relays the messages. ` +
      `You are ${name}. Answer the user's latest message as ${name}; earlier answers may come from ${other}, and the user can read all of them.`,
    "Follow your own configuration and the repository's instructions (AGENTS.md / CLAUDE.md).",
    earlierTasks(o.earlier, false) + conversationSection(o.context, "Conversation so far", "Oldest first."),
    `## The user's message to ${name}\n${o.question}\n`,
  ].filter(Boolean).join("\n");
}

/** One message of a discussion so far, as the later prompts of the discussion show it. */
export interface DiscussionMessage {
  backend: Backend;
  step: DiscussionStep;
  round: number;
  text: string;
  verdict: Verdict | null;
}

const STEP_TITLES: Record<DiscussionStep, (round: number) => string> = {
  answer: () => "answer, version 1",
  critique: (round) => `review of version ${round}`,
  revise: (round) => `answer, version ${round}`,
  final: (round) => `final answer, version ${round}`,
};

function discussionHistory(history: DiscussionMessage[]): string {
  if (!history.length) return "";
  return "\n## The discussion so far\nOldest first.\n\n" + history.map((m) => {
    const verdict = m.step === "critique" ? ` (verdict: ${m.verdict ? m.verdict.toUpperCase() : "none given, taken as REVISE"})` : "";
    return `### ${NAMES[m.backend]}: ${STEP_TITLES[m.step](m.round)}${verdict}\n${m.text.trim()}`;
  }).join("\n\n") + "\n";
}

/**
 * A turn of /discuss for one agent: the conversation so far, the user's question (once), the discussion so far, and
 * what this step asks. Its second line names the step, so the agent (and a test's fake agent) can tell it.
 */
export function discussion(o: {
  workspace: string; context: ConversationContext; earlier: EarlierTask[]; question: string; answerer: Backend; critic: Backend; maxRounds: number;
  step: DiscussionStep; round: number; history: DiscussionMessage[];
}): string {
  const answerer = NAMES[o.answerer];
  const critic = NAMES[o.critic];
  const me = o.step === "critique" ? critic : answerer;
  const verdicts = "End your review with one line of its own, exactly `VERDICT: AGREE` if the version is correct and complete enough to give the user " +
    "as it is, or `VERDICT: REVISE` if it needs changes.";
  const asks: Record<DiscussionStep, string> = {
    answer: `## Your turn: answer\nAnswer the user's question as ${answerer}. ${critic} will review your answer before the user gets it, and you can revise it then. ` +
      "Write it for the user.\n",
    critique: `## Your turn: review version ${o.round}\nCheck ${answerer}'s latest version for errors, gaps and claims it does not support; read the ` +
      "code or run what you need when the answer depends on it. Say what is wrong and what should change, briefly and concretely, and say what is right " +
      `only where it matters. Do not rewrite the answer. ${verdicts}\n`,
    revise: `## Your turn: version ${o.round}\nWrite version ${o.round} of your answer, taking ${critic}'s latest review into account: fix what it got ` +
      "right; where you disagree, keep your position and say why in a sentence. Give the whole answer again, for the user, not only the changes.\n",
    final: `## Your turn: the final answer\n${critic} still asks for changes after ${o.maxRounds} review(s), so this version goes to the user as it is, ` +
      `with no further review. Write the final answer (version ${o.round}), taking the latest review into account where you agree. End with a short ` +
      `section on the points you and ${critic} still disagree on: each point, and both positions, in a line or two.\n`,
  };
  return [
    CONVERSATION_MARKER,
    `[agentduo-discussion: ${o.step}, round ${o.round} of ${o.maxRounds}]`,
    `This is a three-way conversation in the workspace \`${o.workspace}\` between the user, Claude Code and Codex; agentduo relays the messages. ` +
      `The user asked for a discussion: ${answerer} answers, ${critic} reviews the answer, and ${answerer} revises it until ${critic} agrees, ` +
      `for at most ${o.maxRounds} review(s). The user reads the whole discussion and gets the last version as the response. You are ${me}.`,
    "Follow your own configuration and the repository's instructions (AGENTS.md / CLAUDE.md).",
    earlierTasks(o.earlier, false) + conversationSection(o.context, "Conversation so far", "Oldest first."),
    `## The user's question\n${o.question}\n`,
    discussionHistory(o.history),
    asks[o.step],
  ].filter(Boolean).join("\n");
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
    earlier(ctx),
    notes(ctx.notes),
    "## Your job\n" +
      "Study the repository and produce an implementation plan that the implementer can execute without further clarification.\n" +
      "- Goals and explicit scope (in / out). Keep the scope to what the task needs.\n" +
      "- Architecture / design decisions that fit the existing code and conventions.\n" +
      "- Ordered, concrete steps; list the files each step creates or changes.\n" +
      "- Acceptance criteria that are objective and testable.\n" +
      "- Risks with mitigations, and a test strategy (which tests to add or update).\n" +
      "- Open questions only for things that truly cannot be decided from the repository; state the assumption you made for each.\n" +
      (ctx.gates.length ? "\nAfter implementation agentduo runs these commands and shows their results to the code reviewer:\n" + gateList(ctx.gates) + "\n" : ""),
  ];
  if (!previousPlan) {
    out.push("\nThis is the first version: return `feedback_resolution` as an empty list.\n");
  } else {
    const json = JSON.stringify(previousPlan, null, 2);
    const fence = fenceFor(json);
    out.push(`\n## Previous plan (v${version - 1}) as JSON\n${fence}json\n${json}\n${fence}\n`);
    out.push(feedbackSection(feedback));
    out.push("\nRevise the plan to address the feedback. In `feedback_resolution`, add one entry per issue id " +
      "above with decision `accepted`, `partially_accepted` or `disputed` and a rationale. Dispute only " +
      "with a concrete technical reason; disputed critical/high issues will go back to the critic.\n");
  }
  out.push(OUTPUT_RULES);
  return out.join("\n");
}

export function planReviewer(ctx: PromptContext, round: number, version: number, planMd: string, previousCritique: Critique | null): string {
  const out = [
    header("plan_reviewer", "Plan Critic", ctx),
    `- Planning round: ${round} · Plan under review: v${version}\n`,
    "## Task\n" + ctx.task + "\n",
    earlier(ctx),
    notes(ctx.notes),
    "## Plan under review\n" + planMd + "\n",
    "## Your job\n" +
      "Judge whether this plan is feasible in THIS codebase; the implementer must be able to execute it without guessing:\n" +
      "- Do the files, modules, APIs and commands it relies on actually exist and work as assumed?\n" +
      "- Missing steps, wrong ordering, hidden dependencies, migration or compatibility concerns.\n" +
      "- Are the acceptance criteria objective and testable?\n" +
      "- Risks the planner missed; unnecessary scope; ambiguity that would force guessing.\n" +
      (ctx.gates.length ? "\nCommands agentduo runs after implementation:\n" + gateList(ctx.gates) + "\n" : "") + "\n" +
      SEVERITY_GUIDE + "\n\n" +
      "Decision rules:\n" +
      "- Set `approved: true` and `status: \"approved\"` only if no critical or high issue remains. " +
      "Medium/low issues may accompany an approval as suggestions.\n" +
      "- Give each issue a stable id (`C1`, `C2`, ...). Reuse the same id when you re-raise an issue from a previous round.\n" +
      "- `accepted`: planner responses (by issue id and short reason) you now agree with. `disputed`: planner responses you " +
      "still disagree with, with your reasoning; re-raise any still-blocking one in `issues`.\n" +
      "- `proposed_changes`: concrete edits to the plan you recommend.\n",
  ];
  if (previousCritique) {
    out.push("\n## Your critique from the previous round\n" + issuesMarkdown(previousCritique.issues) +
      "\n\nCheck how the new plan version addressed each of these (see its 'Response to feedback' section).\n");
  }
  out.push(OUTPUT_RULES);
  return out.join("\n");
}

export function planFinalizer(ctx: PromptContext, round: number, version: number, planMd: string, critique: Critique): string {
  return [
    header("plan_finalizer", "Planner / Architect (final plan sign-off)", ctx),
    `- Planning round: ${round} · Plan up for sign-off: v${version}\n`,
    "## Task\n" + ctx.task + "\n",
    earlier(ctx),
    notes(ctx.notes),
    "## Plan\n" + planMd + "\n",
    "## The critic approved this version\n" + critique.summary + "\n\nRemaining suggestions:\n" + issuesMarkdown(critique.issues) + "\n",
    "## Your job\n" +
      "Confirm whether this exact plan version is final and ready for implementation. Approve " +
      "(`approved: true`, `status: \"approved\"`) unless you find a critical or high problem; then return " +
      "`changes_requested` with issues (ids `A1`, `A2`, ...) and the plan goes through another revision " +
      "round. Do not request changes for style or wording alone.\n\n" + SEVERITY_GUIDE + "\n",
    OUTPUT_RULES,
  ].join("\n");
}

export function implementer(ctx: PromptContext, round: number, planMd: string, findings: Finding[], review: Review | null,
  failedGates: GateResult[], previousReport: { summary: string | null } | null): string {
  const out = [
    header("implementer", "Implementer", ctx),
    `- Implementation round: ${round}\n`,
    "## Task\n" + ctx.task + "\n",
    earlier(ctx),
    notes(ctx.notes),
    "## Final approved plan\n" + planMd + "\n",
    "## How to work\n" +
      "- Implement the plan and stay within its scope.\n" +
      (ctx.gates.length
        ? "- After your turn agentduo runs these commands and shows the results to the code reviewer; make them pass:\n" + gateList(ctx.gates) + "\n"
        : "- Run the project's checks yourself, as your configuration and the repository's instructions describe.\n") +
      "- If you cannot proceed (missing information, contradictory requirements, missing permissions), stop and return " +
      "`status: \"blocked\"` with a precise `blocking_reason`.\n",
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
    if (failedGates.length) out.push("### Failing quality gates (run by agentduo)\n" + describeGates(failedGates) + "\n");
    if (previousReport?.summary) out.push("### Your previous report\n" + previousReport.summary + "\n");
  }
  out.push("## Output\nYour final message must be a single JSON object matching the output schema: summary, files_changed, " +
    "tests_run (what you actually ran and whether it passed) and addressed_findings.\n");
  return out.join("\n");
}

export function codeReviewer(ctx: PromptContext, round: number, planMd: string, base: string, snapshot: string, gateResults: GateResult[],
  diffStat: string, diff: string, truncated: boolean, previousFindings: Finding[], implReport: Implementation): string {
  const tests = implReport.tests_run.map((t) => "- `" + t.command + "` passed=" + t.passed + " " + t.notes).join("\n") || "_(none)_";
  const fence = fenceFor(diff);
  const stat = diffStat.trimEnd() || "(no changes)";
  const statFence = fenceFor(stat);
  const out = [
    header("code_reviewer", "Code Reviewer", ctx),
    `- Review round: ${round}\n` +
      "- Revision under review: `" + snapshot + "` (agentduo snapshot of the workspace)\n" +
      "- Base revision: `" + base + "`\n",
    "## Task\n" + ctx.task + "\n",
    earlier(ctx),
    notes(ctx.notes),
    "## Final approved plan\n" + planMd + "\n",
    "## Quality gate results (run by agentduo on this revision)\n" + describeGates(gateResults) + "\n",
    "## Implementer's report\n" + implReport.summary + "\n\nTests the implementer says it ran:\n" + tests + "\n",
    "## Diff stat (base → revision)\n" + statFence + "\n" + stat + "\n" + statFence + "\n",
    "## Diff" + (truncated ? " (TRUNCATED: run `git diff " + base + " " + snapshot + " -- .` for the full diff)" : "") + "\n" +
      fence + "diff\n" + diff + "\n" + fence + "\n",
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
    "The workspace currently equals the revision under review, so you may read files directly.\n\n" +
    SEVERITY_GUIDE + "\n\n" +
    "Decision rules:\n" +
    "- Approve (`approved: true`, `status: \"approved\"`) only if there is no critical or high finding and the acceptance " +
    "criteria are met" + (ctx.gates.length ? ", and the required quality gates pass" : "") + ".\n" +
    "- `reviewed_commit` must be exactly `" + snapshot + "`.\n" +
    "- New finding ids continue the sequence `F1`, `F2`, ...; `file` is workspace-relative (empty string if " +
    "general) and `line` may be null.\n",
    OUTPUT_RULES);
  return out.join("\n");
}
