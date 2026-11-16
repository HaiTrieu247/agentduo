// The protocol part of every team turn (packages/engine/src/team): who the member is in the team, what the team knows,
// what to do now, and the output contract. The member's identity (packages/engine/src/team/identity.ts) comes after
// the first lines of a fresh session; a continued session already has it, and is given only the parts of the prompt
// that changed since its last turn (`render`, `MemberSession.seen`).
import { createHash } from "node:crypto";
import type { Attachment } from "../inputs/attachment-types.js";
import { attachmentLines, inlineCode, type Locate } from "../workflow/prompts.js";
import type { Member, TeamGroup } from "./config.js";
import {
  exceptionStatus, exceptionsFor, governanceWork, planningUnit, resolveUnit, RUN_UNIT, scopeCovers, type ExceptionScope, type GovernedState, type RuleException,
  type UnitRef, type WorkRef,
} from "./rule-governance.js";
import type { RuleEntry } from "./rules.js";
import { groupKey, type Area, type Brief, type Escalation, type Report, type TaskCheck, type TaskState, type TeamMessage, type TeamPlan, type TeamState } from "./state.js";

// ─── Parts of a prompt, and what a session that goes on is given ───────────────────────────────────────────────────

/**
 * What a member's session was given, part by part (`MemberSession.seen`): a part's key → its digest, a list's items as
 * `<key>#<id>`. A session that goes on is sent a part again only when its digest changed, a list only its new or changed items.
 */
export type SessionView = Record<string, string>;

/** How a prompt is built for a member's session: a fresh one (its identity, every part) or one that goes on (`since`). */
export interface SessionPrompt {
  /** The member's identity, for a fresh session; null when the session continues. */
  identity: string | null;
  /**
   * A session that goes on: what its earlier turns were given. Absent or null (a session recorded before agentduo kept
   * this): every part but the identity, as a fresh prompt has them.
   */
  since?: SessionView | null;
  /** Filled with the digest of every part of the whole prompt: what the session holds once the turn succeeded. */
  view?: SessionView;
}

/**
 * A part of a prompt:
 *  - a text: in every prompt (the role line, the team's rules and decisions, the work to act on, what to do now);
 *  - a kept part: given once to a session, then again only when it changed (`digest`, by default the text's). A session that
 *    had an earlier version (`previous`, its digest) is given `delta(previous)` when that says what changed, else the whole text;
 *  - a list: each item given once, then again when it changed (the board's tasks, a task's history).
 */
type Part =
  | string
  | { key: string; text: string; digest?: string; delta?: (previous: string) => string | null }
  | { key: string; items: Array<{ id: string; text: string }>; heading: string; changed: string; empty?: string };

/** A short digest of a part's text: equal digests, the same text (a session given it once need not be given it again). */
export const digest = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Whether this prompt is for a session that goes on and knows what it was given. */
const goesOn = (p: SessionPrompt): p is SessionPrompt & { since: SessionView } => p.identity === null && !!p.since;

const CONTINUED = "This message continues your session. Your earlier turns in it hold what you were given and read (the team, the brief, " +
  "the plan or your task…) and your own answers. The parts of this prompt that did not change since your last turn are left out: what they " +
  "said still holds. Below is only what is new or changed, then what to do now. Read a file again before you rely on what you remember of it.";

/** The prompt's text: every part for a fresh session, and for one that goes on only what it was not given (filling `p.view` either way). */
function render(parts: Part[], p: SessionPrompt): string {
  const since = goesOn(p) ? p.since : null;
  const out: string[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      if (part) out.push(part);
    } else if ("items" in part) {
      const fresh = part.items.filter((item) => {
        const key = `${part.key}#${item.id}`;
        const d = digest(item.text);
        if (p.view) p.view[key] = d;
        return !since || since[key] !== d;
      });
      if (fresh.length) out.push([since ? part.changed : part.heading, ...fresh.map((i) => i.text)].join("\n"));
      else if (!since && !part.items.length && part.empty) out.push(`${part.heading}\n${part.empty}`);
    } else {
      const d = part.digest ?? digest(part.text);
      if (p.view) p.view[part.key] = d;
      const previous = since?.[part.key];
      if (previous === d && !part.delta) continue;
      const text = previous !== undefined && part.delta ? part.delta(previous) ?? part.text : part.text;
      if (text) out.push(text);
    }
  }
  return out.join("\n\n");
}

/** Where a group's plan is kept in a session's view (the PM's and the group PM's plan, the techlead's previous one). */
const planKey = (group: string | null) => `plan:${groupKey(group)}`;

/**
 * The parts a member wrote itself, as its session's view keeps them: what a turn's own answer added (the PM's brief and
 * the groups' parts, a techlead's plan) is in the session that wrote it, and is not sent back to it.
 */
export const authored = {
  brief: (b: Brief): SessionView => ({ brief: digest(briefSection(b)) }),
  areas: (areas: Area[]): SessionView => ({ areas: digest(areasText(areas)) }),
  plan: (plan: TeamPlan): SessionView => ({ [planKey(plan.group)]: digest(planSection(plan)) }),
};

export type PmOccasion =
  | { kind: "conversation" }
  | { kind: "areas" }
  | { kind: "plan_review" }
  | { kind: "reports" }
  | { kind: "escalation" }
  | { kind: "acceptance" }
  /** A group's own PM: it checks its group's plan, or answers (or passes up) its techlead's question. */
  | { kind: "area_review" }
  | { kind: "area_escalation" }
  /** The head PM learns from resolved incidents: a preventive rule for RULES.md, or none. */
  | { kind: "rule_lesson" }
  /** The head PM assesses the exception requests members made: a proposal for the user, or a refusal. */
  | { kind: "rule_exception" };

/** What a PM turn may answer with, by phase and occasion. */
export function pmActions(state: TeamState, occasion: PmOccasion): string[] {
  switch (occasion.kind) {
    case "plan_review": case "area_review": return ["plan_review"];
    case "areas": return ["areas"];
    case "area_escalation": return ["none", "team_answer", "escalate"];
    case "acceptance": return ["acceptance"];
    case "rule_lesson": return ["rule_lesson", "rule_question"];
    case "rule_exception": return ["exception_proposal", "exception_decline", "rule_question"];
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

const boardLine = (t: TaskState) => `- ${t.id} [${t.status}] ${t.title} (assignee ${t.assignee}, attempt ${t.attempt})`;

export function boardSection(tasks: TaskState[]): string {
  if (!tasks.length) return "## The board\n(no task yet)";
  return ["## The board", ...tasks.map(boardLine)].join("\n");
}

/** The board as a list: a session that goes on is given the tasks that changed since its last turn, and where the board stands. */
function boardPart(tasks: TaskState[]): Part {
  const counts = new Map<string, number>();
  for (const t of tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const stands = [...counts].map(([status, n]) => `${n} ${status}`).join(", ");
  return {
    key: "board", heading: "## The board", empty: "(no task yet)", items: tasks.map((t) => ({ id: t.id, text: boardLine(t) })),
    changed: `## The board: what changed since your last turn (${tasks.length} task${tasks.length === 1 ? "" : "s"}: ${stands})`,
  };
}

const checkLines = (checks: TaskCheck[]) => checks.flatMap((c) => [
  `- ${c.by}: ${c.verdict}. ${c.summary}`,
  ...c.failures.map((f) => `  - ${f.id} ${f.title} (suspects the ${f.suspect}; ${f.criteria.join(", ") || "no criterion"}): ${f.detail}\n` +
    `    reproduce: ${f.reproduction}\n    expected: ${f.expected}\n    actual: ${f.actual}`),
]);

const json = "\n\n## Your output\nReply with one JSON object that matches the required schema exactly; nothing else.";

/**
 * The parts of a prompt every member gets: the role line, its identity (fresh sessions), the team, the brief, and (for fresh
 * and continued sessions alike, since they are written into the prompt, never into the identity) the team's rules, what the
 * user approved for this very work, the requests that wait, and how to bring a rule problem to the PM. A session that goes on
 * is told so in place of the introduction, and is given the team and the brief again only when they changed.
 */
function frame(kind: string, p: PromptParts, brief: Brief | null, work: WorkRef | null): Part[] {
  return [
    header(kind, p.member) + (goesOn(p) ? CONTINUED : intro(p.member)), p.identity ?? "", { key: "team", text: roster(p.members) },
    brief ? { key: "brief", text: briefSection(brief) } : "",
    rulesSection(p.rules), exceptionsSection(p.state, p.member, work), p.member.kind === "pm" ? "" : memberGovernanceGuidance(),
  ];
}

export interface PromptParts extends SessionPrompt {
  member: Member;
  members: Member[];
  state: TeamState;
  /** The team's rules as RULES.md holds them now (`TeamRules.rules()`), read for this call; absent: not given (the section is left out). */
  rules?: readonly RuleEntry[] | null;
}

// ─── The team's rules, requests and exceptions ──────────────────────────────────────────────────────────────────────

/** The unit of work a call outside a task is about. */
export const integrationWork = (): WorkRef => ({ unit: { kind: "integration", id: RUN_UNIT } });
/** The user's own changes merged into the integration branch belong to the apply unit, not the integration's. */
export const applyWork = (): WorkRef => ({ unit: { kind: "apply", id: RUN_UNIT } });
export const planningWork = (group: string | null): WorkRef => ({ unit: planningUnit(group) });

/** The rules in force, every one with its id: members cite these ids. Empty: the team has none yet. */
export function rulesSection(rules: readonly RuleEntry[] | null | undefined): string {
  if (!rules) return "";
  const head = "## The team's rules\nThese rules come from what this team settled before. They hold for all of your work, whatever you were told " +
    "earlier in this session. A rule is never lifted by anything but the user's approval of an exception, which is granted for named work only.";
  if (!rules.length) return `${head}\n(none yet)`;
  return `${head}\n${rules.map((r) => `- ${r.id}: ${r.text}${r.incident ? ` (source: ${r.incident})` : ""}`).join("\n")}`;
}

const scopeText = (scope: ExceptionScope): string =>
  scope.unit ? `the ${scope.unit.kind}${scope.unit.id === RUN_UNIT ? "" : ` of ${scope.unit.id}`} (${scope.unit.occurrence})` : `task${scope.taskIds.length === 1 ? "" : "s"} ${scope.taskIds.join(", ")}`;

/** Whether a request's own scope (what was asked for, not what an assessment narrowed it to) is the work of this call. */
function requestedHere(state: GovernedState, ex: RuleException, work: WorkRef): boolean {
  if (work.task !== undefined) return scopeCovers(ex.requested, state.id, { task: work.task });
  const unit = resolveUnit(state, work.unit);
  return !!unit && scopeCovers(ex.requested, state.id, { unit });
}

/**
 * What the user decided that touches this call, and nothing else:
 *  - the exceptions the user approved for exactly this work (`exceptionsFor`): the only departure from a rule there is;
 *  - this member's requests for this work that are not approved: waiting, or refused, which grant nothing.
 * Another task's or unit's exception, an approved one for other work, a pending one and a refused one never read as permission.
 */
export function exceptionsSection(state: TeamState | GovernedState, member: Member, work: WorkRef | null): string {
  if (!work || member.kind === "pm") return "";
  const gov = state as GovernedState;
  const lines: string[] = [];
  const approved = exceptionsFor(gov, work);
  for (const ex of approved) {
    const a = ex.assessment!;
    lines.push(`- ${ex.id}, approved by the user for ${scopeText(a.scope)} only. You may depart from ${a.ruleIds.join(", ")} in the way the user approved: ${a.alternative}. ` +
      `Reason shown to the user: ${a.reason}. The rule itself stays in force for everything else.`);
  }
  const approvedIds = new Set(approved.map((e) => e.id));
  for (const ex of state.governance?.exceptions ?? []) {
    if (approvedIds.has(ex.id) || ex.from !== member.name || !requestedHere(gov, ex, work)) continue;
    const status = exceptionStatus(ex);
    if (status === "approved") continue; // approved for narrower work: it covers none of this
    lines.push(status === "rejected"
      ? `- ${ex.id} (${ex.ruleIds.join(", ")}): refused. The rules stand; do not depart from them.`
      : `- ${ex.id} (${ex.ruleIds.join(", ")}): not decided yet. It is no permission: do not act on it, and do not do the part of the work it needs.`);
  }
  if (!lines.length) return "";
  return `## Exceptions to the rules for this work\n${lines.join("\n")}`;
}

/** How a member brings a problem with the rules to the PM. The user is never asked by a member. */
export function memberGovernanceGuidance(): string {
  return "## When a rule does not fit, or something went wrong\n" +
    "You never ask the user, and you never decide an exception yourself: the PM does, and only the user can agree to one.\n" +
    "- A disagreement with a member, or a result that differs from what the user asked, that you saw: put it in `governance.issues` (kind `disagreement` or `deviation`, " +
    "what happened, the ids of the rules involved).\n" +
    "- A rule that does not fit this work: put it in `governance.exception` with the rule ids (as written in the list above), why the rule does not fit " +
    "this work, and what you would do instead. Then stop the part of the work that needs the exception: do only what the rules allow, and leave the rest undone. " +
    "A request for an exception never means you may go ahead.\n" +
    "- Otherwise leave `governance` with no issue and no exception. An exception you ask for covers the work of this call only.";
}

const ruleLines = (ids: string[], rules: readonly RuleEntry[] | null | undefined) =>
  ids.map((id) => { const r = rules?.find((x) => x.id === id); return r ? `${id} (${r.text})` : id; }).join("; ");

/**
 * What the PM has before it about the team's rules: the incidents settled that it may learn from, the requests for
 * exceptions (to assess, shown to the user and waiting, decided), and the questions it asked the user. Waiting is not
 * approval: the PM is told so. Empty when there is nothing.
 */
export function pmGovernanceSection(state: TeamState, rules: readonly RuleEntry[] | null | undefined): string {
  const g = state.governance;
  if (!g || (!g.incidents.length && !g.exceptions.length)) return "";
  const work = governanceWork(state);
  const out: string[] = [];
  if (work.lessons.length) {
    out.push("Settled incidents to learn from (answer them all in one rule_lesson, one entry per id):\n" + work.lessons.map((i) =>
      `- ${i.id} (${i.kind}, from ${i.reportedBy}${i.ruleIds.length ? `, rules ${i.ruleIds.join(", ")}` : ""}): ${i.summary}. Resolved: ${i.resolution ?? "(not said)"}.` +
      `${i.status === "recording" && i.lesson ? ` You already wrote this rule, which is being recorded; give the same text again: ${i.lesson.text}` : ""}` +
      `${i.direction && i.direction.answer === null ? " You asked the user about it; it waits for their answer (leave it out until then)." : ""}`).join("\n"));
  }
  const req = (e: RuleException) => `- ${e.id} from ${e.from} for ${ruleLines(e.ruleIds, rules)}: ${e.reason}${e.alternative ? ` Instead: ${e.alternative}.` : ""} It asked for ${scopeText(e.requested)}.`;
  if (work.assess.length) out.push(`Exception requests to assess (exception_proposal, or exception_decline, with its id):\n${work.assess.map(req).join("\n")}`);
  if (work.present.length) out.push(`Your proposals not shown to the user yet (they grant nothing):\n${work.present.map((e) => `- ${e.id}: ${e.assessment!.summary}`).join("\n")}`);
  if (work.pending.length) {
    out.push("Exception requests the user has been shown and has not decided. They grant nothing yet, and the work they hold waits:\n" + work.pending.map((e) =>
      `- ${e.id}: ${e.assessment?.summary ?? e.reason}`).join("\n"));
  }
  if (work.questions.length) out.push(`Questions you asked the user about the rules, not answered yet: ${work.questions.map((q) => q.exceptionId ?? q.incidentId).join(", ")}. The work that depends on them waits.`);
  const answered = [...g.exceptions.map((e) => ({ id: e.id, d: e.direction })), ...g.incidents.map((i) => ({ id: i.id, d: i.direction }))].filter((x) => x.d?.answer);
  if (answered.length) {
    out.push("The user's answers to your questions about the rules (information for your decision; they approve nothing):\n" + answered.map((x) => `- ${x.id}: ${x.d!.answer}`).join("\n"));
  }
  const decided = g.exceptions.filter((e) => e.decision && e.decision.status !== "pending");
  if (decided.length) {
    out.push("Decided:\n" + decided.map((e) => `- ${e.id}: ${e.decision!.status}${e.decision!.status === "approved" && e.assessment ? ` for ${scopeText(e.assessment.scope)} only` : "; the rules stand"}`).join("\n"));
  }
  return out.length ? `## The team's rules: incidents and exceptions\n${out.join("\n\n")}` : "";
}

/** What the PM does about the rules, in every PM turn: learn after an incident, present exceptions, ask when unsure. */
function pmGovernanceGuidance(grouped: boolean): string {
  return "## Rules, lessons and exceptions\n" +
    "- After a disagreement between members or a mistake against what the user asked has been settled, you write a preventive rule (rule_lesson): short, general, " +
    "so that it does not happen again. Rules are only added: never write one that removes, replaces or weakens an earlier rule. Say null when no new rule is needed.\n" +
    "- A member may ask for an exception to a rule. Assess it: when the rule really does not fit, propose it to the user (exception_proposal) with the rules involved, the reason, " +
    "what the team does instead and exactly which work it covers (never more than was asked); when the rule should stand, decline it (exception_decline). " +
    "Nothing is done differently until the user agrees; a refused or unanswered request changes nothing, and an approved one covers only the work you named and does not remove the rule.\n" +
    "- When you cannot tell what to do about a rule or an incident, ask the user (rule_question): the work that depends on it waits for the answer, which is information and never an approval.\n" +
    (grouped ? "- In a team with groups only the head PM asks the user; a group's PM passes the question up to the head PM.\n" : "");
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
  const parts = frame(`pm_${p.occasion.kind}`, p, null, null);
  const groups = groupsSection(p.groups);
  if (groups) parts.push({ key: "groups", text: `${groups}\nYou are the head PM: the only one who talks with the user. Each group's techlead plans its part; a group's own PM checks it first.` });
  parts.push({ key: "where", text: `## Where the work is\nPhase: ${s.phase}.${s.approvedBrief ? ` The user approved brief v${s.approvedBrief}.` : ""}` +
    `${s.approvedPlan ? " The user approved the plan." : ""}` });
  // The brief is the same part whatever its label: its approval is said under "Where the work is".
  if (brief) parts.push({ key: "brief", text: briefSection(brief, s.approvedBrief === brief.version ? "The brief" : "Your latest brief (not approved yet)"), digest: digest(briefSection(brief)) });
  if (p.areas.length) parts.push({ key: "areas", text: areasText(p.areas) });
  if (s.phase !== "INTAKE") for (const plan of p.plans) parts.push({ key: planKey(plan.group), text: planSection(plan) });
  if (s.tasks.length) parts.push(boardPart(s.tasks));
  // The conversation goes by the PM's own count of what it read (`seenMessages`, which counts its own messages too): a
  // session that goes on is given the messages after it, and none when there are none.
  const fresh = p.state.messages.slice(p.seenMessages);
  if (p.identity === null && p.seenMessages > 0) {
    if (fresh.length) parts.push(`## New in the conversation with the user\n${transcript(fresh)}`);
  } else if (s.messages.length) parts.push(`## The conversation with the user\n${transcript(s.messages)}`);
  if (p.reports.length) parts.push(`## Reports from the team since your last turn\n${p.reports.map((r) => `- ${r.from}: ${r.text}`).join("\n")}`);
  if (p.openEscalations.length) {
    parts.push(`## Questions the team needs answered (answer one with team_answer and its id)\n${p.openEscalations.map((e) =>
      `- ${e.id}${e.task ? ` (task ${e.task})` : ""}: ${e.text}`).join("\n")}`);
  }
  const feedback = Object.entries(s.planFeedback).filter(([, text]) => text);
  if (feedback.length && p.occasion.kind === "plan_review") {
    parts.push(`## What was asked of the techleads last time\n${feedback.map(([group, text]) => (group ? `- ${group}: ${text}` : text)).join("\n")}`);
  }
  const governed = pmGovernanceSection(s, p.rules);
  if (governed) parts.push(governed);
  parts.push(pmGovernanceGuidance(!!groups));
  parts.push(`## What to do now\n${pmTask(s, p.occasion)}\n\nAllowed actions now: ${actions.join(", ")}. ` +
    "`message` is what the user reads (in the user's language), or null. Use `questions` to ask the user up to 4 questions with 2 to 6 options each; " +
    "they can always answer in their own words too." + json);
  return render(parts, p);
}

const areasText = (areas: Area[]) => `## The groups' parts\n${areas.map((a) => `- ${a.group}: ${a.area} (${a.criteria.join(", ")})`).join("\n")}`;

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
    case "rule_lesson":
      return "Incidents above were settled (a disagreement between members, or a result that differed from what the user asked). Answer all of them in this one turn: " +
        "rule_lesson with one entry in `lessons` per incident (except one that waits for the user's answer), each with its incident_id, the rule that prevents it from " +
        "happening again, as one short, general sentence that members can follow, and why it prevents it. " +
        "The rules above stay as they are: add to them, never remove, replace or contradict one. Give rule null when no new rule is needed (say why in rationale); " +
        "when several incidents come from the same cause, write the rule once and give the others rule null with a rationale that names it. " +
        "When you cannot tell which way the team should go about one of them, ask the user with rule_question and that incident's id instead (the others wait for your next turn).";
    case "rule_exception":
      return "A member asked for an exception to a rule (the requests above). Look at the rules it names and its reason. When the rule really does not fit that work, propose the exception " +
        "(exception_proposal with the request's id): the rules involved, the reason, what the team does instead and the work it covers, which is the work the member asked for or less. " +
        "The user reads your summary and decides; nothing changes until they agree, and until then the work stays held. When the rule should stand, decline (exception_decline) and say why " +
        "for the member. When you cannot decide, ask the user with rule_question and the request's id (its work waits). One request per turn.";
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
  const parts = frame("plan", p, p.brief, planningWork(p.group?.name ?? null));
  if (p.area && p.group) {
    parts.push({ key: "area", text: `${areaSection(p.area)}\nPlan only your group's part, and give its tasks only to your group: ` +
      `${p.group.members.filter((m) => m.kind === "worker").map((m) => m.name).join(", ")} take tasks, ` +
      `${p.group.members.filter((m) => m.kind === "checker").map((m) => m.name).join(", ")} test them. The other groups plan theirs at the same time; ` +
      "depend only on tasks of your own group." });
  }
  if (p.existing.length) parts.push({ key: "existing", text: `## Tasks the run already has\n${p.existing.map((t) => `- ${t.id} [${t.status}] ${t.title} (${t.assignee})`).join("\n")}` });
  // The techlead's own plan, which the session that wrote it holds (`authored.plan`).
  if (p.previous) parts.push({ key: planKey(p.previous.group), text: `## Your previous plan\n${planSection(p.previous)}`, digest: digest(planSection(p.previous)) });
  if (p.feedback) parts.push(`## What must change\n${p.feedback}`);
  parts.push(`## What to do now\n${p.additions
    ? "The brief changed. Plan only the new tasks the change needs (new ids; they may depend on existing tasks)."
    : "Read the repository, then plan the work."} Split it into tasks that can each be done and tested on their own and that rarely touch the same files, ` +
    "so members can work in parallel. Name each task's assignee (a member who takes tasks), its testers, the files or folders it touches, its dependencies, " +
    `the acceptance criteria it serves and what its testers must cover. Assign by level. ${p.area ? "Every acceptance criterion of your group's part" : "Every acceptance criterion"} ` +
    "must be served by some task. `report` is one line for the PM." + json);
  return render(parts, p);
}

/** The task a prompt is about: a session that goes on has it (its session holds this one task), unless it changed. */
const taskPart = (t: TaskState): Part => ({ key: "task", text: taskSection(t) });

export function workPrompt(p: PromptParts & { task: TaskState; brief: Brief; others: TaskState[]; cwd: string }): string {
  const t = p.task;
  const parts = frame("work", p, p.brief, { task: t.id });
  parts.push(taskPart(t));
  const inFlight = p.others.filter((o) => o.id !== t.id && !["merged", "cancelled"].includes(o.status));
  if (inFlight.length) parts.push({ key: "others", text: `## Other tasks in progress (stay out of their areas)\n${inFlight.map((o) => `- ${o.id} ${o.title} (${o.assignee}): ${o.area.join(", ")}`).join("\n")}` });
  // The work to act on (an answer, a review, the techlead's guidance) comes every time it is there; why the attempt before
  // failed only until the session has it.
  if (t.question?.answer) parts.push(`## The answer to your question\nYou asked: ${t.question.text}\nAnswer: ${t.question.answer}`);
  if (t.review?.verdict === "changes") {
    parts.push(`## ${t.review.reviewer}'s review asks for changes\n${t.review.summary}\n${t.review.findings.map((f) =>
      `- ${f.id} [${f.severity}${f.origin === "out_of_scope" ? ", a suggestion outside the scope" : ""}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} ` : ""}${f.title}: ${f.detail}`).join("\n")}`);
  }
  if (t.guidance) parts.push(`## The techlead's guidance for this attempt (${t.attempt})\n${t.guidance}`);
  if (t.trouble && t.attempt > 1) parts.push({ key: "trouble", text: `## Why the previous attempt failed\n${t.trouble}` });
  parts.push(`## What to do now\nYou work in ${p.cwd}. ${t.code ? "Your earlier work on this task is already there; continue from it." : "Implement the task."} ` +
    "When it is done, report done with a summary; if you cannot go on without an answer, report blocked with one precise question for the techlead." + json);
  return render(parts, p);
}

export function testsPrompt(p: PromptParts & { task: TaskState; brief: Brief; cwd: string; failures: TaskCheck[] }): string {
  const t = p.task;
  const parts = frame("tests", p, p.brief, { task: t.id });
  parts.push(taskPart(t));
  const fixing = t.tests[p.member.name]?.status === "fixing";
  if (fixing) {
    parts.push(`## The techlead says your tests are wrong\n${t.guidance ?? ""}\n${checkLines(p.failures).join("\n")}`);
  }
  parts.push(`## What to do now\nYou work in ${p.cwd}. ${fixing ? "Fix your tests." : `Write the tests for task ${t.id} now, while ${t.assignee} writes the code.`} ` +
    "Test the acceptance criteria and the test focus, not an implementation: the code is not there yet, so your tests may fail for now. " +
    "Put them where the repository keeps its tests and follow its conventions. Never change the product code. Say how to run them." + json);
  return render(parts, p);
}

const fenceFor = (text: string) => "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
const fenced = (lang: string, text: string) => `${fenceFor(text)}${lang}\n${text}\n${fenceFor(text)}`;
const short = (commit: string) => commit.slice(0, 12);

/**
 * The change a review is about. `head`: the commit under review, by which a session knows which change it reviewed (its
 * view keeps it). `previous`: the diff from the commit the session reviewed last to `head`, which a session that goes on
 * is given instead of the whole diff, with `stat` (the whole change, file by file); null: it cannot be diffed (or there
 * was no earlier review), and the session gets the whole diff.
 */
export interface ReviewChange {
  head: string;
  base: string;
  stat: string;
  previous: { from: string; diff: string } | null;
}

export function reviewPrompt(p: PromptParts & { task: TaskState; brief: Brief; diff: string; blocking: readonly string[]; change?: ReviewChange | null }): string {
  const t = p.task;
  const parts = frame("review", p, p.brief, { task: t.id });
  parts.push(taskPart(t));
  if (t.codeSummary) parts.push({ key: "report", text: `## ${t.assignee}'s report\n${t.codeSummary}${t.notes.length ? `\n${t.notes.map((n) => `- ${n}`).join("\n")}` : ""}` });
  const whole = `## The change\n${fenced("diff", p.diff || "(no change)")}`;
  const c = p.change ?? null;
  // The commit this session reviewed in its last turn, when it goes on and agentduo can tell it what changed since.
  const reviewed = goesOn(p) && c ? p.since.change : undefined;
  const again = reviewed !== undefined && (reviewed === c!.head || c!.previous?.from === reviewed);
  parts.push({
    key: "change", text: whole, digest: c?.head ?? digest(whole),
    delta: (from) => {
      if (!again) return null;
      if (from === c!.head) return `## The change\nThe same commit (\`${short(c!.head)}\`) is the one you reviewed last, earlier in this session: nothing changed since.`;
      return `## The change since the commit you last reviewed (\`${short(from)}\` → \`${short(c!.head)}\`)\n` +
        `You reviewed the change up to \`${short(from)}\` earlier in this session; below is what changed after it. Judge the whole change all the same: ` +
        `every file it touches is listed here, and \`git diff ${short(c!.base)} HEAD -- .\` in your worktree shows all of it.\n` +
        `${fenced("", c!.stat.trimEnd() || "(no change)")}\n\n${fenced("diff", c!.previous!.diff || "(no change)")}`;
    },
  });
  parts.push(`## What to do now\nReview ${t.assignee}'s change for task ${t.id}; the code is checked out in your worktree. ` +
    (again ? "Your findings from your last review are in this session: check that each was dealt with, and that nothing else broke. " : "") +
    `Ask for changes (verdict changes) only for a finding inside the task's scope of severity ${p.blocking.join(" or ")}; anything else is a suggestion. ` +
    "A finding outside the task or the brief has origin out_of_scope and is never work for this task. Cite the acceptance criteria a finding concerns." + json);
  return render(parts, p);
}

export function checkPrompt(p: PromptParts & { task: TaskState; brief: Brief; cwd: string }): string {
  const t = p.task;
  const tests = t.tests[p.member.name];
  const parts = frame("check", p, p.brief, { task: t.id });
  parts.push(taskPart(t));
  if (tests?.summary) parts.push({ key: "tests", text: `## Your tests\n${tests.summary}${tests.howToRun ? `\nRun them with: ${tests.howToRun}` : ""}` });
  if (t.codeSummary) parts.push({ key: "report", text: `## ${t.assignee}'s report\n${t.codeSummary}` });
  parts.push(`## What to do now\nIn ${p.cwd} the code of task ${t.id} and its tests are merged. Run your tests and check the task against its acceptance criteria and its test focus. ` +
    "Now that you see the code you may add tests for cases it reveals (list them in added_tests). Report pass only when every case passes; " +
    "for each failure say how to reproduce it, what was expected, what happened, and whether you suspect the code, the test or the plan." + json);
  return render(parts, p);
}

export function triagePrompt(p: PromptParts & { task: TaskState; brief: Brief; maxAttempts: number; workers: Member[] }): string {
  const t = p.task;
  const parts = frame("triage", p, p.brief, { task: t.id });
  parts.push(taskPart(t));
  parts.push(`## What went wrong (attempt ${t.attempt} of ${p.maxAttempts})\n${t.trouble ?? "(not said)"}${t.checks.length ? `\n${checkLines(t.checks).join("\n")}` : ""}`);
  // The latest dozen entries; a session that goes on, those it was not given (an entry is known by its place in the history).
  const from = Math.max(0, t.history.length - 12);
  if (t.history.length) {
    parts.push({
      key: "history", heading: "## The task's history", changed: "## The task's history since your last turn",
      items: t.history.slice(from).map((h, i) => ({ id: String(from + i), text: `- ${h.text}` })),
    });
  }
  parts.push(`## What to do now\nDecide what happens next: retry (the same assignee, with your guidance), reassign (to another member who takes tasks: ` +
    `${p.workers.map((w) => `${w.name} (${w.level})`).join(", ")}), fix_tests (the tests are wrong: the testers fix them), or escalate (a question only the PM or the user can answer). ` +
    "After a second failure of the same kind, change the approach rather than retry the same way. `report` is one line for the PM." + json);
  return render(parts, p);
}

export function answerPrompt(p: PromptParts & { task: TaskState; brief: Brief }): string {
  const t = p.task;
  const parts = frame("answer", p, p.brief, { task: t.id });
  parts.push(taskPart(t));
  parts.push(`## ${t.question?.from} asks\n${t.question?.text}`);
  parts.push("## What to do now\nAnswer from the brief, the plan and the repository. When only the PM or the user can decide it (the product, the scope), " +
    "give escalate with the question for the PM and no answer." + json);
  return render(parts, p);
}

export function resolvePrompt(p: PromptParts & { task: TaskState | null; brief: Brief; cwd: string; files: string[] }): string {
  const t = p.task;
  const parts = frame("resolve", p, p.brief, t ? { task: t.id } : applyWork());
  if (t) parts.push(taskPart(t));
  const what = t ? `Merging task ${t.id} into the integration branch` : "Merging the user's own changes to their folder (made while the team worked) into the integration branch";
  parts.push(`## What to do now\n${what} conflicts in: ${p.files.join(", ")}. In ${p.cwd} the integration branch is checked out ` +
    "with the other side merged in and conflict markers in those files. Resolve them so that both sides keep working, remove every marker, and report done." + json);
  return render(parts, p);
}

export function integrationCheckPrompt(p: PromptParts & { brief: Brief; cwd: string }): string {
  const parts = frame("check", p, p.brief, integrationWork());
  parts.push(boardPart(p.state.tasks));
  parts.push(`## What to do now\nEvery task is merged; ${p.cwd} holds the whole result. Run every test of the repository and every test the team wrote, ` +
    "and check the result against every acceptance criterion of the brief. Report pass only when all of it passes." + json);
  return render(parts, p);
}

export function integrationTriagePrompt(p: PromptParts & { brief: Brief; trouble: string; checks: TaskCheck[] }): string {
  const parts = frame("triage", p, p.brief, integrationWork());
  parts.push(boardPart(p.state.tasks));
  parts.push(`## What must be fixed\n${p.trouble}${p.checks.length ? `\n${checkLines(p.checks).join("\n")}` : ""}`);
  parts.push("## What to do now\nAdd the tasks that fix it (action add_tasks, new ids, with assignees and testers), or escalate with a question only the PM " +
    "or the user can answer. `report` is one line for the PM." + json);
  return render(parts, p);
}

/** A group's own PM: it checks its group's plan against its part of the brief, or answers its techlead's question. */
export function areaPmPrompt(p: PromptParts & {
  occasion: PmOccasion; brief: Brief; group: TeamGroup; area: Area | null; plan: TeamPlan | null; openEscalations: Escalation[]; head: Member;
}): string {
  const parts = frame(`pm_${p.occasion.kind}`, p, p.brief, null);
  parts.push({ key: "group", text: `You are the PM of group ${p.group.name}. You never talk to the user: ${p.head.name}, the head PM, does. You answer for your group's part.` });
  parts.push("## Rules and exceptions\nThe team's rules above hold for your group too. A request to depart from a rule, and any question to the user about one, goes up to " +
    `${p.head.name} (escalate, naming the rules, the reason, the alternative and the work), who alone shows it to the user. You never approve an exception, and you never ask the user.`);
  if (p.area) parts.push({ key: "area", text: areaSection(p.area) });
  if (p.plan) parts.push({ key: planKey(p.plan.group), text: planSection(p.plan) });
  if (p.openEscalations.length) {
    parts.push(`## Questions from your group's techlead (answer one with team_answer and its id)\n${p.openEscalations.map((e) =>
      `- ${e.id}${e.task ? ` (task ${e.task})` : ""}: ${e.text}`).join("\n")}`);
  }
  const task = p.occasion.kind === "area_review"
    ? `Check ${p.group.lead.name}'s plan above against your group's part and the brief: every criterion of the part served, nothing outside the scope, ` +
      "no assumption against the brief. approve: true passes it to the head PM; approve: false sends it back with the exact `issues` (group: your group's name)."
    : "Answer a question yourself (team_answer) when the brief and your part settle it; otherwise pass it to the head PM (escalate, with what the head PM must decide).";
  parts.push(`## What to do now\n${task}\n\nAllowed actions now: ${pmActions(p.state, p.occasion).join(", ")}. \`message\` is never shown to the user: leave it null.` + json);
  return render(parts, p);
}
