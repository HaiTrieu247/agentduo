// The protocol part of every team turn (packages/engine/src/team): who the member is in the team, what the team knows,
// what to do now, and the output contract. The member's identity (packages/engine/src/team/identity.ts) comes after
// the first lines of a fresh session; a continued session already has it.
import type { Attachment } from "../inputs/attachment-types.js";
import { attachmentLines, inlineCode, type Locate } from "../workflow/prompts.js";
import type { Member, TeamGroup } from "./config.js";
import type { Area, Brief, Escalation, Report, TaskCheck, TaskState, TeamMessage, TeamPlan, TeamState } from "./state.js";

export type PmOccasion =
  | { kind: "conversation" }
  | { kind: "areas" }
  | { kind: "plan_review" }
  | { kind: "reports" }
  | { kind: "escalation" }
  | { kind: "acceptance" }
  /** A group's own PM: it checks its group's plan, or answers (or passes up) its techlead's question. */
  | { kind: "area_review" }
  | { kind: "area_escalation" };

/** What a PM turn may answer with, by phase and occasion. */
export function pmActions(state: TeamState, occasion: PmOccasion): string[] {
  switch (occasion.kind) {
    case "plan_review": case "area_review": return ["plan_review"];
    case "areas": return ["areas"];
    case "area_escalation": return ["none", "team_answer", "escalate"];
    case "acceptance": return ["acceptance"];
    case "reports": return ["none"];
    case "escalation": return ["none", "questions", "team_answer"];
    case "conversation":
      switch (state.phase) {
        case "INTAKE": return ["none", "questions", "brief"];
        case "PLANNING": return ["none", "questions"];
        case "EXECUTION": case "INTEGRATION": return ["none", "questions", "lead_note", "change_request", "team_answer"];
        case "ACCEPTANCE": return ["none", "questions", "lead_note", "change_request", "acceptance"];
        default: return ["none"];
      }
  }
}

const header = (kind: string, member: Member) => `[orchestrator-role: team_${kind}]\n[agentduo-member: ${member.name}]\n`;

const intro = (member: Member) =>
  `You are ${member.name}, the ${member.role} (${member.level}) of a software team that agentduo runs. The user talks only to the PM; ` +
  "the techlead plans, assigns, reviews and merges; the other members take tasks or test them. Every member works in a git worktree " +
  "of its own, a copy of the repository: agentduo collects your changes after your turn (you need not commit) and merges them. " +
  "Follow your own configuration and the repository's instructions (AGENTS.md / CLAUDE.md).";

/** The groups of a team with groups: who leads each, its PM, who is in it. */
export function groupsSection(groups: TeamGroup[]): string {
  if (!groups.length || groups[0]!.name === null) return "";
  return ["## The groups", ...groups.map((g) => `- ${g.name}: techlead ${g.lead.name}${g.pm ? `, its PM ${g.pm.name}` : ""}; ` +
    `members ${g.members.filter((m) => m.kind === "worker" || m.kind === "checker").map((m) => m.name).join(", ")}`)].join("\n");
}

export function areaSection(area: Area): string {
  return `## Your group's part: ${area.group}\n${area.area}\nAcceptance criteria your group answers for: ${area.criteria.join(", ") || "(none)"}`;
}

export function roster(members: Member[]): string {
  return ["## The team", ...members.map((m) =>
    `- ${m.name}: ${m.role} (${m.kind === "worker" ? "takes tasks" : m.kind === "checker" ? "tests tasks" : m.kind}), level ${m.level}` +
    `${m.canReview && m.kind === "worker" ? ", reviews others" : ""}, on ${m.backend === "codex" ? "Codex" : "Claude"}`)].join("\n");
}

export function briefSection(brief: Brief, label = "The brief"): string {
  const list = (title: string, xs: string[]) => (xs.length ? `${title}:\n${xs.map((x) => `- ${x}`).join("\n")}` : "");
  return [
    `## ${label} (v${brief.version}): ${brief.title}`,
    brief.goal,
    list("In scope", brief.scope),
    list("Out of scope", brief.out_of_scope),
    list("Constraints", brief.constraints),
    `Acceptance criteria:\n${brief.criteria.map((c) => `- ${c.id}: ${c.criterion}`).join("\n")}`,
    brief.notes ? `Notes: ${brief.notes}` : "",
  ].filter(Boolean).join("\n\n");
}

export function taskSection(t: TaskState, heading = `## Task ${t.id}: ${t.title}`): string {
  return [
    heading,
    t.description,
    `Assignee: ${t.assignee}. Testers: ${t.testers.join(", ")}. Area: ${t.area.join(", ") || "(not said)"}.`,
    `Acceptance criteria it serves: ${t.criteria.join(", ")}.${t.depends_on.length ? ` After: ${t.depends_on.join(", ")}.` : ""}`,
    `Test focus: ${t.test_focus}`,
  ].join("\n");
}

export function boardSection(tasks: TaskState[]): string {
  if (!tasks.length) return "## The board\n(no task yet)";
  return ["## The board", ...tasks.map((t) => `- ${t.id} [${t.status}] ${t.title} (assignee ${t.assignee}, attempt ${t.attempt})`)].join("\n");
}

const checkLines = (checks: TaskCheck[]) => checks.flatMap((c) => [
  `- ${c.by}: ${c.verdict}. ${c.summary}`,
  ...c.failures.map((f) => `  - ${f.id} ${f.title} (suspects the ${f.suspect}; ${f.criteria.join(", ") || "no criterion"}): ${f.detail}\n` +
    `    reproduce: ${f.reproduction}\n    expected: ${f.expected}\n    actual: ${f.actual}`),
]);

const json = "\n\n## Your output\nReply with one JSON object that matches the required schema exactly; nothing else.";

/** The parts of a prompt every member gets: the role line, its identity (fresh sessions), the team and the brief. */
function frame(kind: string, member: Member, identity: string | null, members: Member[], brief: Brief | null): string[] {
  return [header(kind, member) + intro(member), identity ?? "", roster(members), brief ? briefSection(brief) : ""].filter(Boolean);
}

export interface PromptParts {
  member: Member;
  members: Member[];
  /** The member's identity, for a fresh session; null when the session continues. */
  identity: string | null;
  state: TeamState;
}

const attached = (m: TeamMessage) => (m.attachments?.length ? `\n(attached: ${m.attachments.map((a) => inlineCode(a.name)).join(", ")})` : "");
const transcript = (messages: TeamMessage[]) => messages.map((m) => `${m.from === "user" ? "User" : "You (PM)"}: ${m.text}${attached(m)}`).join("\n\n");

const TEAM_FILES = "The user attached these files to their messages to the team. agentduo keeps a copy of each at the path given, outside " +
  "your folder. The images your CLI can take are also attached to this message as images; read any other file (text, code, PDF…) at its " +
  "path, and an image there too if you were not shown it. If you cannot read a file, say so.";

/**
 * The files the user attached to the request and to their messages, for every member: all of them for a fresh session,
 * the ones it was not given for a session that goes on (`continued`); empty when there are none.
 */
export function filesSection(list: Attachment[], locate: Locate, continued: boolean): string {
  if (!list.length) return "";
  return `## ${continued ? "New files the user attached" : "Files the user attached"}\n${TEAM_FILES}\n${attachmentLines(list, locate)}`;
}

export function pmPrompt(p: PromptParts & {
  occasion: PmOccasion; seenMessages: number; reports: Report[]; openEscalations: Escalation[]; groups: TeamGroup[]; plans: TeamPlan[]; areas: Area[];
}): string {
  const s = p.state;
  const brief = s.briefs.at(-1) ?? null;
  const actions = pmActions(s, p.occasion);
  // The occasion is part of the role tag: logs (and test scenarios) tell a plan review from a report.
  const parts = frame(`pm_${p.occasion.kind}`, p.member, p.identity, p.members, null);
  const groups = groupsSection(p.groups);
  if (groups) parts.push(`${groups}\nYou are the head PM: the only one who talks with the user. Each group's techlead plans its part; a group's own PM checks it first.`);
  parts.push(`## Where the work is\nPhase: ${s.phase}.${s.approvedBrief ? ` The user approved brief v${s.approvedBrief}.` : ""}` +
    `${s.approvedPlan ? " The user approved the plan." : ""}`);
  if (brief) parts.push(briefSection(brief, s.approvedBrief === brief.version ? "The brief" : "Your latest brief (not approved yet)"));
  if (p.areas.length) parts.push(`## The groups' parts\n${p.areas.map((a) => `- ${a.group}: ${a.area} (${a.criteria.join(", ")})`).join("\n")}`);
  if (s.phase !== "INTAKE") for (const plan of p.plans) parts.push(planSection(plan));
  if (s.tasks.length) parts.push(boardSection(s.tasks));
  const fresh = p.state.messages.slice(p.seenMessages);
  if (p.seenMessages > 0 && fresh.length) parts.push(`## New in the conversation with the user\n${transcript(fresh)}`);
  else if (s.messages.length) parts.push(`## The conversation with the user\n${transcript(s.messages)}`);
  if (p.reports.length) parts.push(`## Reports from the team since your last turn\n${p.reports.map((r) => `- ${r.from}: ${r.text}`).join("\n")}`);
  if (p.openEscalations.length) {
    parts.push(`## Questions the team needs answered (answer one with team_answer and its id)\n${p.openEscalations.map((e) =>
      `- ${e.id}${e.task ? ` (task ${e.task})` : ""}: ${e.text}`).join("\n")}`);
  }
  const feedback = Object.entries(s.planFeedback).filter(([, text]) => text);
  if (feedback.length && p.occasion.kind === "plan_review") {
    parts.push(`## What was asked of the techleads last time\n${feedback.map(([group, text]) => (group ? `- ${group}: ${text}` : text)).join("\n")}`);
  }
  parts.push(`## What to do now\n${pmTask(s, p.occasion)}\n\nAllowed actions now: ${actions.join(", ")}. ` +
    "`message` is what the user reads (in the user's language), or null. Use `questions` to ask the user up to 4 questions with 2 to 6 options each; " +
    "they can always answer in their own words too." + json);
  return parts.join("\n\n");
}

function pmTask(s: TeamState, occasion: PmOccasion): string {
  switch (occasion.kind) {
    case "plan_review":
      return "The techlead submitted the plan above (in a team with groups, each group's techlead its part). Check it against the brief: every acceptance " +
        "criterion served, nothing outside the scope, no assumption against what the user said, and in a team with groups the parts fit together. approve: true " +
        "sends it to the user for approval with your `summary` of it in plain words (what will be done, in how many parts, by whom, the risks); approve: false " +
        "sends it back with the exact `issues` (each naming its `group`, or null for every techlead).";
    case "areas":
      return "The user approved the brief. Split it between the groups above: for each group, the part it builds and the acceptance criteria it " +
        "answers for (action areas, every group once). Every criterion must be some group's; a criterion that needs two groups is given to both. " +
        "Split along the groups' strengths and so that they rarely touch the same files.";
    case "area_review": case "area_escalation":
      return "";
    case "acceptance":
      return `Every task is merged and the testers' last check of the whole passed: ${s.integration ? checkLines(s.integration.checks).join("\n") : ""}\n` +
        "Report to the user, criterion by criterion, whether it is met, with the evidence (the tests and checks that show it). Then the user accepts or asks for changes.";
    case "reports":
      return "Tell the user, in one or two short sentences, what the reports above mean for them. Nothing else.";
    case "escalation":
      return "The team needs the answers above. Answer one yourself with team_answer when the brief and the conversation already settle it; " +
        "otherwise explain it to the user in your message (and ask with questions if options help). The team waits.";
    case "conversation":
      switch (s.phase) {
        case "INTAKE":
          return "Understand what the user wants. Ask until the goal, scope, out of scope, constraints and testable acceptance criteria are clear; " +
            "then write the brief (action brief). The user approves it or asks for changes. Do not write the brief while something important is unclear.";
        case "PLANNING":
          return "The techlead is planning. Answer the user; their comments about the plan reach the techlead with the plan's review.";
        case "ACCEPTANCE":
          return "The user asked for changes to the result. Within the brief's scope: lead_note tells the techlead what to change. Outside it: " +
            "change_request with the new brief (the user approves it, then the techlead plans the rest). Ask first if it is unclear.";
        default:
          return "Answer the user from what you know (the board and the reports). A clarification of the work becomes a lead_note for the techlead; " +
            "a change of scope becomes a change_request with the new brief for the user to approve. The team keeps working meanwhile.";
      }
  }
}

export function planSection(plan: TeamPlan): string {
  return [`## Plan v${plan.version}`, plan.summary, ...plan.tasks.map((t) =>
    `- ${t.id} ${t.title} → ${t.assignee} (tests: ${t.testers.join(", ")}; ${t.criteria.join(", ")}${t.depends_on.length ? `; after ${t.depends_on.join(", ")}` : ""}): ${t.description}`),
  plan.risks.length ? `Risks:\n${plan.risks.map((r) => `- ${r}`).join("\n")}` : ""].filter(Boolean).join("\n");
}

export function planPrompt(p: PromptParts & {
  brief: Brief; feedback: string | null; previous: TeamPlan | null; existing: TaskState[]; additions: boolean; area: Area | null; group: TeamGroup | null;
}): string {
  const parts = frame("plan", p.member, p.identity, p.members, p.brief);
  if (p.area && p.group) {
    parts.push(`${areaSection(p.area)}\nPlan only your group's part, and give its tasks only to your group: ` +
      `${p.group.members.filter((m) => m.kind === "worker").map((m) => m.name).join(", ")} take tasks, ` +
      `${p.group.members.filter((m) => m.kind === "checker").map((m) => m.name).join(", ")} test them. The other groups plan theirs at the same time; ` +
      "depend only on tasks of your own group.");
  }
  if (p.existing.length) parts.push(`## Tasks the run already has\n${p.existing.map((t) => `- ${t.id} [${t.status}] ${t.title} (${t.assignee})`).join("\n")}`);
  if (p.previous) parts.push(`## Your previous plan\n${planSection(p.previous)}`);
  if (p.feedback) parts.push(`## What must change\n${p.feedback}`);
  parts.push(`## What to do now\n${p.additions
    ? "The brief changed. Plan only the new tasks the change needs (new ids; they may depend on existing tasks)."
    : "Read the repository, then plan the work."} Split it into tasks that can each be done and tested on their own and that rarely touch the same files, ` +
    "so members can work in parallel. Name each task's assignee (a member who takes tasks), its testers, the files or folders it touches, its dependencies, " +
    `the acceptance criteria it serves and what its testers must cover. Assign by level. ${p.area ? "Every acceptance criterion of your group's part" : "Every acceptance criterion"} ` +
    "must be served by some task. `report` is one line for the PM." + json);
  return parts.join("\n\n");
}

export function workPrompt(p: PromptParts & { task: TaskState; brief: Brief; others: TaskState[]; cwd: string }): string {
  const t = p.task;
  const parts = frame("work", p.member, p.identity, p.members, p.brief);
  parts.push(taskSection(t));
  const inFlight = p.others.filter((o) => o.id !== t.id && !["merged", "cancelled"].includes(o.status));
  if (inFlight.length) parts.push(`## Other tasks in progress (stay out of their areas)\n${inFlight.map((o) => `- ${o.id} ${o.title} (${o.assignee}): ${o.area.join(", ")}`).join("\n")}`);
  if (t.question?.answer) parts.push(`## The answer to your question\nYou asked: ${t.question.text}\nAnswer: ${t.question.answer}`);
  if (t.review?.verdict === "changes") {
    parts.push(`## ${t.review.reviewer}'s review asks for changes\n${t.review.summary}\n${t.review.findings.map((f) =>
      `- ${f.id} [${f.severity}${f.origin === "out_of_scope" ? ", a suggestion outside the scope" : ""}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} ` : ""}${f.title}: ${f.detail}`).join("\n")}`);
  }
  if (t.guidance) parts.push(`## The techlead's guidance for this attempt (${t.attempt})\n${t.guidance}`);
  if (t.trouble && t.attempt > 1) parts.push(`## Why the previous attempt failed\n${t.trouble}`);
  parts.push(`## What to do now\nYou work in ${p.cwd}. ${t.code ? "Your earlier work on this task is already there; continue from it." : "Implement the task."} ` +
    "When it is done, report done with a summary; if you cannot go on without an answer, report blocked with one precise question for the techlead." + json);
  return parts.join("\n\n");
}

export function testsPrompt(p: PromptParts & { task: TaskState; brief: Brief; cwd: string; failures: TaskCheck[] }): string {
  const t = p.task;
  const parts = frame("tests", p.member, p.identity, p.members, p.brief);
  parts.push(taskSection(t));
  const fixing = t.tests[p.member.name]?.status === "fixing";
  if (fixing) {
    parts.push(`## The techlead says your tests are wrong\n${t.guidance ?? ""}\n${checkLines(p.failures).join("\n")}`);
  }
  parts.push(`## What to do now\nYou work in ${p.cwd}. ${fixing ? "Fix your tests." : `Write the tests for task ${t.id} now, while ${t.assignee} writes the code.`} ` +
    "Test the acceptance criteria and the test focus, not an implementation: the code is not there yet, so your tests may fail for now. " +
    "Put them where the repository keeps its tests and follow its conventions. Never change the product code. Say how to run them." + json);
  return parts.join("\n\n");
}

export function reviewPrompt(p: PromptParts & { task: TaskState; brief: Brief; diff: string; blocking: readonly string[] }): string {
  const t = p.task;
  const parts = frame("review", p.member, p.identity, p.members, p.brief);
  parts.push(taskSection(t));
  if (t.codeSummary) parts.push(`## ${t.assignee}'s report\n${t.codeSummary}${t.notes.length ? `\n${t.notes.map((n) => `- ${n}`).join("\n")}` : ""}`);
  const fence = "`".repeat(Math.max(3, ...[...p.diff.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  parts.push(`## The change\n${fence}diff\n${p.diff || "(no change)"}\n${fence}`);
  parts.push(`## What to do now\nReview ${t.assignee}'s change for task ${t.id}; the code is checked out in your worktree. ` +
    `Ask for changes (verdict changes) only for a finding inside the task's scope of severity ${p.blocking.join(" or ")}; anything else is a suggestion. ` +
    "A finding outside the task or the brief has origin out_of_scope and is never work for this task. Cite the acceptance criteria a finding concerns." + json);
  return parts.join("\n\n");
}

export function checkPrompt(p: PromptParts & { task: TaskState; brief: Brief; cwd: string }): string {
  const t = p.task;
  const tests = t.tests[p.member.name];
  const parts = frame("check", p.member, p.identity, p.members, p.brief);
  parts.push(taskSection(t));
  if (tests?.summary) parts.push(`## Your tests\n${tests.summary}${tests.howToRun ? `\nRun them with: ${tests.howToRun}` : ""}`);
  if (t.codeSummary) parts.push(`## ${t.assignee}'s report\n${t.codeSummary}`);
  parts.push(`## What to do now\nIn ${p.cwd} the task's code and its tests are merged. Run your tests and check the task against its acceptance criteria and its test focus. ` +
    "Now that you see the code you may add tests for cases it reveals (list them in added_tests). Report pass only when every case passes; " +
    "for each failure say how to reproduce it, what was expected, what happened, and whether you suspect the code, the test or the plan." + json);
  return parts.join("\n\n");
}

export function triagePrompt(p: PromptParts & { task: TaskState; brief: Brief; maxAttempts: number; workers: Member[] }): string {
  const t = p.task;
  const parts = frame("triage", p.member, p.identity, p.members, p.brief);
  parts.push(taskSection(t));
  parts.push(`## What went wrong (attempt ${t.attempt} of ${p.maxAttempts})\n${t.trouble ?? "(not said)"}${t.checks.length ? `\n${checkLines(t.checks).join("\n")}` : ""}`);
  if (t.history.length) parts.push(`## The task's history\n${t.history.slice(-12).map((h) => `- ${h.text}`).join("\n")}`);
  parts.push(`## What to do now\nDecide what happens next: retry (the same assignee, with your guidance), reassign (to another member who takes tasks: ` +
    `${p.workers.map((w) => `${w.name} (${w.level})`).join(", ")}), fix_tests (the tests are wrong: the testers fix them), or escalate (a question only the PM or the user can answer). ` +
    "After a second failure of the same kind, change the approach rather than retry the same way. `report` is one line for the PM." + json);
  return parts.join("\n\n");
}

export function answerPrompt(p: PromptParts & { task: TaskState; brief: Brief }): string {
  const t = p.task;
  const parts = frame("answer", p.member, p.identity, p.members, p.brief);
  parts.push(taskSection(t));
  parts.push(`## ${t.question?.from} asks\n${t.question?.text}`);
  parts.push("## What to do now\nAnswer from the brief, the plan and the repository. When only the PM or the user can decide it (the product, the scope), " +
    "give escalate with the question for the PM and no answer." + json);
  return parts.join("\n\n");
}

export function resolvePrompt(p: PromptParts & { task: TaskState | null; brief: Brief; cwd: string; files: string[] }): string {
  const t = p.task;
  const parts = frame("resolve", p.member, p.identity, p.members, p.brief);
  if (t) parts.push(taskSection(t));
  const what = t ? `Merging task ${t.id} into the integration branch` : "Merging the user's own changes to their folder (made while the team worked) into the integration branch";
  parts.push(`## What to do now\n${what} conflicts in: ${p.files.join(", ")}. In ${p.cwd} the integration branch is checked out ` +
    "with the other side merged in and conflict markers in those files. Resolve them so that both sides keep working, remove every marker, and report done." + json);
  return parts.join("\n\n");
}

export function integrationCheckPrompt(p: PromptParts & { brief: Brief; cwd: string }): string {
  const parts = frame("check", p.member, p.identity, p.members, p.brief);
  parts.push(boardSection(p.state.tasks));
  parts.push(`## What to do now\nEvery task is merged; ${p.cwd} holds the whole result. Run every test of the repository and every test the team wrote, ` +
    "and check the result against every acceptance criterion of the brief. Report pass only when all of it passes." + json);
  return parts.join("\n\n");
}

export function integrationTriagePrompt(p: PromptParts & { brief: Brief; trouble: string; checks: TaskCheck[] }): string {
  const parts = frame("triage", p.member, p.identity, p.members, p.brief);
  parts.push(boardSection(p.state.tasks));
  parts.push(`## What must be fixed\n${p.trouble}${p.checks.length ? `\n${checkLines(p.checks).join("\n")}` : ""}`);
  parts.push("## What to do now\nAdd the tasks that fix it (action add_tasks, new ids, with assignees and testers), or escalate with a question only the PM " +
    "or the user can answer. `report` is one line for the PM." + json);
  return parts.join("\n\n");
}

/** A group's own PM: it checks its group's plan against its part of the brief, or answers its techlead's question. */
export function areaPmPrompt(p: PromptParts & {
  occasion: PmOccasion; brief: Brief; group: TeamGroup; area: Area | null; plan: TeamPlan | null; openEscalations: Escalation[]; head: Member;
}): string {
  const parts = frame(`pm_${p.occasion.kind}`, p.member, p.identity, p.members, p.brief);
  parts.push(`You are the PM of group ${p.group.name}. You never talk to the user: ${p.head.name}, the head PM, does. You answer for your group's part.`);
  if (p.area) parts.push(areaSection(p.area));
  if (p.plan) parts.push(planSection(p.plan));
  if (p.openEscalations.length) {
    parts.push(`## Questions from your group's techlead (answer one with team_answer and its id)\n${p.openEscalations.map((e) =>
      `- ${e.id}${e.task ? ` (task ${e.task})` : ""}: ${e.text}`).join("\n")}`);
  }
  const task = p.occasion.kind === "area_review"
    ? `Check ${p.group.lead.name}'s plan above against your group's part and the brief: every criterion of the part served, nothing outside the scope, ` +
      "no assumption against the brief. approve: true passes it to the head PM; approve: false sends it back with the exact `issues` (group: your group's name)."
    : "Answer a question yourself (team_answer) when the brief and your part settle it; otherwise pass it to the head PM (escalate, with what the head PM must decide).";
  parts.push(`## What to do now\n${task}\n\nAllowed actions now: ${pmActions(p.state, p.occasion).join(", ")}. \`message\` is never shown to the user: leave it null.` + json);
  return parts.join("\n\n");
}
