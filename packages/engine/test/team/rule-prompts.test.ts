// The rules and the guidance about them in every team prompt (packages/engine/src/team/prompts.ts), read from the prompt text.
import { describe, expect, it } from "vitest";
import { newTask } from "../../src/team/board.js";
import { TEAM_DEFAULTS, teamGroups, teamMembers, type Member, type TeamConfig } from "../../src/team/config.js";
import {
  areaPmPrompt, checkPrompt, integrationCheckPrompt, integrationTriagePrompt, answerPrompt, planPrompt, pmActions, pmPrompt, resolvePrompt, reviewPrompt, testsPrompt,
  triagePrompt, workPrompt, type PmOccasion, type PromptParts,
} from "../../src/team/prompts.js";
import {
  answerDirection, askDirection, assessException, decideException, declineException, presentException, recordIncident, requestException, resolveIncident,
  type GovernedState,
} from "../../src/team/rule-governance.js";
import type { RuleEntry } from "../../src/team/rules.js";
import { newTeamState, type Brief, type TeamState } from "../../src/team/state.js";
import { brief as briefOutput, task as planTask } from "../helpers/team-builders.js";

const rule = (n: number, text: string, incident = "an incident"): RuleEntry => ({ id: `R${n}`, opId: `op${n}`, text, incident, at: "2026-11-14T00:00:00.000Z" });
const RULES = [rule(1, "State the units in every task description."), rule(2, "Never merge without a green check.")];

const config = (members: TeamConfig["members"]): TeamConfig => ({ ...TEAM_DEFAULTS, members });
const flat = teamMembers(TEAM_DEFAULTS);
const grouped = teamMembers(config([
  { role: "pm", level: "senior", cli: "codex" },
  { role: "techlead", level: "senior", cli: "codex", group: "web" },
  { role: "dev", level: "mid", cli: "claude", group: "web" },
  { role: "qa", level: "mid", cli: "claude", group: "web" },
  { role: "pm", level: "mid", cli: "codex", group: "web" },
]));
const named = (members: Member[], name: string) => members.find((m) => m.name === name)!;
const brief: Brief = { version: 1, ...briefOutput() };

const state = (): TeamState => {
  const s = newTeamState("run-1", "do it");
  s.briefs = [brief];
  s.approvedBrief = 1;
  s.tasks = ["T1", "T2"].map((id) => newTask(planTask(id)));
  s.integration = { commit: "c1", checks: [], triage: false, trouble: null, triageGroups: [] };
  s.verifiedTree = "tree1";
  return s;
};
const parts = (s: TeamState, member: Member, members: Member[] = flat, identity: string | null = "IDENTITY", rules: readonly RuleEntry[] | null | undefined = RULES): PromptParts =>
  ({ member, members, identity, state: s, rules });
const T1 = (s: TeamState) => s.tasks[0]!;

/** An exception shown to the user in `req` and then decided (or not). */
function exception(s: TeamState, over: { from?: string; work?: Parameters<typeof requestException>[1]["work"]; taskIds?: string[]; decision?: "approve" | "reject" | null; assess?: boolean } = {}) {
  const g = s as GovernedState;
  const made = requestException(g, { from: over.from ?? "dev-1", ruleIds: ["R1"], reason: "R1 does not fit", alternative: "state them in the tests", work: over.work ?? { task: "T1" } });
  if (!made.ok) throw new Error(made.reason);
  const ex = made.value;
  if (over.assess === false) return ex;
  const a = assessException(g, ex.id, {
    by: "pm", ruleIds: ["R1"], reason: "R1 does not fit", alternative: "state them in the tests", taskIds: over.taskIds ?? (ex.requested.unit ? [] : ex.requested.taskIds),
    unit: ex.requested.unit ? { kind: ex.requested.unit.kind, id: ex.requested.unit.id } : null, summary: "R1 on this work",
  });
  if (!a.ok) throw new Error(a.reason);
  if (over.decision !== undefined) {
    const shown = presentException(g, ex.id, `REQ-${ex.id}`);
    if (!shown.ok) throw new Error(shown.reason);
    if (over.decision) {
      const d = decideException(g, { requestId: `REQ-${ex.id}`, source: "user", approved: over.decision === "approve" });
      if (!d.ok) throw new Error(d.reason);
    }
  }
  return ex;
}

/** Every prompt a member can get, for one run, with the work it is about. */
function allPrompts(s: TeamState, members: Member[], identity: string | null, rules: readonly RuleEntry[] | null = RULES): Record<string, string> {
  const lead = members.find((m) => m.kind === "lead")!;
  const dev = members.find((m) => m.kind === "worker")!;
  const qa = members.find((m) => m.kind === "checker")!;
  const t = T1(s);
  const group = teamGroups(members)[0]!;
  const p = (m: Member) => parts(s, m, members, identity, rules);
  return {
    plan: planPrompt({ ...p(lead), brief, feedback: null, previous: null, existing: [], additions: false, area: null, group }),
    work: workPrompt({ ...p(dev), task: t, brief, others: s.tasks, cwd: "/w" }),
    tests: testsPrompt({ ...p(qa), task: t, brief, cwd: "/w", failures: [] }),
    review: reviewPrompt({ ...p(dev), task: t, brief, diff: "", blocking: ["high"] }),
    check: checkPrompt({ ...p(qa), task: t, brief, cwd: "/w" }),
    triage: triagePrompt({ ...p(lead), task: t, brief, maxAttempts: 3, workers: [dev] }),
    answer: answerPrompt({ ...p(lead), task: t, brief }),
    resolve: resolvePrompt({ ...p(lead), task: t, brief, cwd: "/w", files: ["a.ts"] }),
    resolveOwn: resolvePrompt({ ...p(lead), task: null, brief, cwd: "/w", files: ["a.ts"] }),
    integrationCheck: integrationCheckPrompt({ ...p(qa), brief, cwd: "/w" }),
    integrationTriage: integrationTriagePrompt({ ...p(lead), brief, trouble: "x", checks: [] }),
  };
}

const pm = (s: TeamState, members: Member[], occasion: PmOccasion, identity: string | null = "IDENTITY", rules: readonly RuleEntry[] | null = RULES) =>
  pmPrompt({ ...parts(s, members.find((m) => m.kind === "pm" && !m.group)!, members, identity, rules), occasion, seenMessages: 0, reports: [], openEscalations: [], groups: teamGroups(members), plans: [], areas: [] });

describe("the rules in a prompt", () => {
  it("every role's prompt lists every rule with its id, in a fresh session and in one that continues", () => {
    for (const identity of ["IDENTITY", null]) {
      for (const [name, text] of Object.entries(allPrompts(state(), flat, identity))) {
        expect(text, name).toContain("## The team's rules");
        expect(text, name).toContain("R1: State the units in every task description.");
        expect(text, name).toContain("R2: Never merge without a green check.");
        expect(text.includes("IDENTITY"), name).toBe(identity !== null);
      }
    }
  });

  it("the rules are in the prompt itself, not in the identity: a continued session has no identity and still gets them", () => {
    const text = workPrompt({ ...parts(state(), named(flat, "dev-1"), flat, null), task: T1(state()), brief, others: [], cwd: "/w" });
    expect(text).not.toContain("IDENTITY");
    expect(text).toContain("R1: State the units");
  });

  it("the PM's prompts (every occasion) and a group PM's have them too", () => {
    const s = state();
    const occasions: PmOccasion["kind"][] = ["conversation", "areas", "plan_review", "reports", "escalation", "acceptance", "rule_lesson", "rule_exception"];
    for (const kind of occasions) for (const identity of ["IDENTITY", null]) {
      expect(pm(s, grouped, { kind } as PmOccasion, identity), `${kind}/${identity}`).toContain("R2: Never merge without a green check.");
    }
    const group = teamGroups(grouped).find((g) => g.name === "web")!;
    for (const kind of ["area_review", "area_escalation"] as const) {
      const text = areaPmPrompt({ ...parts(s, group.pm!, grouped, null), occasion: { kind }, brief, group, area: null, plan: null, openEscalations: [], head: named(grouped, "pm") });
      expect(text, kind).toContain("R1: State the units");
    }
  });

  it("a rule the PM added reaches the next prompt: the section is read from the rules given for each call", () => {
    const s = state();
    const before = workPrompt({ ...parts(s, named(flat, "dev-1"), flat, null, RULES), task: T1(s), brief, others: [], cwd: "/w" });
    const after = workPrompt({ ...parts(s, named(flat, "dev-1"), flat, null, [...RULES, rule(3, "Ask the PM before widening a task.")]), task: T1(s), brief, others: [], cwd: "/w" });
    expect(before).not.toContain("R3");
    expect(after).toContain("R3: Ask the PM before widening a task.");
    expect(after).toContain("R1: State the units");
  });

  it("a team with no rule says so, and a call that was not given the rules shows no section (it does not claim there are none)", () => {
    expect(allPrompts(state(), flat, null, []).work).toContain("(none yet)");
    expect(allPrompts(state(), flat, null, null).work).not.toContain("## The team's rules");
  });

  it("a rule is shown as written, with its source, and says no rule is lifted but by an approved exception", () => {
    const text = allPrompts(state(), flat, null).work;
    expect(text).toContain("(source: an incident)");
    expect(text).toMatch(/never lifted by anything but the user's approval of an exception/);
  });
});

describe("what a member is told to do about a rule", () => {
  it("every member's prompt says: report an issue or an exception through governance, stop that part, never ask the user", () => {
    for (const [name, text] of Object.entries(allPrompts(state(), flat, null))) {
      expect(text, name).toContain("governance.exception");
      expect(text, name).toContain("governance.issues");
      expect(text, name).toMatch(/never ask the user/i);
      expect(text, name).toMatch(/stop the part of the work that needs the exception/);
      expect(text, name).toMatch(/never means you may go ahead/);
    }
  });

  it("the PM's own prompts do not tell the PM to report through governance", () => {
    expect(pm(state(), flat, { kind: "conversation" })).not.toContain("governance.exception");
  });
});

describe("the exceptions a prompt shows", () => {
  it("an exception approved for this task is shown, with its scope, and the rule is said to stay", () => {
    const s = state();
    exception(s, { decision: "approve" });
    const text = workPrompt({ ...parts(s, named(flat, "dev-1"), flat, null), task: T1(s), brief, others: [], cwd: "/w" });
    expect(text).toContain("## Exceptions to the rules for this work");
    expect(text).toContain("approved by the user for task T1 only");
    expect(text).toContain("state them in the tests");
    expect(text).toContain("stays in force for everything else");
  });

  it("it reaches every role working on that task, and no other task's prompt", () => {
    const s = state();
    exception(s, { decision: "approve" });
    const t1 = allPrompts(s, flat, null);
    for (const name of ["work", "tests", "review", "check", "triage", "answer", "resolve"]) expect(t1[name], name).toContain("approved by the user for task T1 only");
    for (const name of ["resolveOwn", "integrationCheck", "integrationTriage", "plan"]) expect(t1[name], name).not.toContain("## Exceptions to the rules for this work");
    const other = workPrompt({ ...parts(s, named(flat, "dev-1"), flat, null), task: s.tasks[1]!, brief, others: [], cwd: "/w" });
    expect(other).not.toContain("## Exceptions to the rules for this work");
    expect(other).not.toContain("state them in the tests");
  });

  it("another task's approved exception never reads as this task's, even from the same member", () => {
    const s = state();
    exception(s, { from: "dev-1", work: { task: "T2" }, decision: "approve" });
    expect(workPrompt({ ...parts(s, named(flat, "dev-1"), flat, null), task: T1(s), brief, others: [], cwd: "/w" })).not.toContain("approved by the user");
  });

  it("an exception for a unit of work (the integration) appears in the integration prompts and in no task's", () => {
    const s = state();
    exception(s, { from: "techlead", work: { unit: { kind: "integration", id: "run" } }, decision: "approve" });
    const all = allPrompts(s, flat, null);
    for (const name of ["integrationCheck", "integrationTriage"]) expect(all[name], name).toContain("approved by the user for the integration");
    for (const name of ["resolveOwn", "work", "tests", "review", "check", "triage", "answer", "resolve", "plan"]) expect(all[name], name).not.toContain("approved by the user");
  });

  it("an exception for the apply reaches the resolve of the user's own changes only, never the integration jobs", () => {
    const s = state();
    exception(s, { from: "techlead", work: { unit: { kind: "apply", id: "run" } }, decision: "approve" });
    const all = allPrompts(s, flat, null);
    expect(all.resolveOwn).toContain("approved by the user for the apply");
    for (const name of ["integrationCheck", "integrationTriage", "work", "resolve", "plan"]) expect(all[name], name).not.toContain("approved by the user");
  });

  it("an exception approved for an earlier integration result is gone from the prompts once the integration changes", () => {
    const s = state();
    exception(s, { from: "techlead", work: { unit: { kind: "integration", id: "run" } }, decision: "approve" });
    s.integration!.commit = "c2";
    expect(allPrompts(s, flat, null).integrationCheck).not.toContain("approved by the user");
  });

  it("a planning exception reaches that group's plan only", () => {
    const s = state();
    exception(s, { from: "techlead", work: { unit: { kind: "planning", id: "group:web" } }, decision: "approve" });
    const lead = grouped.find((m) => m.kind === "lead")!;
    const group = teamGroups(grouped).find((g) => g.name === "web")!;
    const plan = (g: typeof group | null) => planPrompt({ ...parts(s, lead, grouped, null), brief, feedback: null, previous: null, existing: [], additions: false, area: null, group: g });
    expect(plan(group)).toContain("approved by the user for the planning of group:web");
    expect(plan({ ...group, name: "api" })).not.toContain("approved by the user");
  });

  it("a request still waiting, shown to the user and undecided, or refused is no permission, and says so", () => {
    for (const [decision, words] of [[undefined, /not decided yet\. It is no permission/], [null, /not decided yet\. It is no permission/], ["reject", /refused\. The rules stand/]] as const) {
      const s = state();
      exception(s, decision === undefined ? {} : { decision });
      const text = workPrompt({ ...parts(s, named(flat, "dev-1"), flat, null), task: T1(s), brief, others: [], cwd: "/w" });
      expect(text).toMatch(words);
      expect(text).not.toContain("approved by the user");
      expect(text).not.toContain("You may depart");
    }
  });

  it("a request the PM declined before showing it reads as refused", () => {
    const s = state();
    const ex = exception(s);
    expect(declineException(s as GovernedState, ex.id).ok).toBe(true);
    expect(workPrompt({ ...parts(s, named(flat, "dev-1"), flat, null), task: T1(s), brief, others: [], cwd: "/w" })).toMatch(/refused\. The rules stand/);
  });

  it("another member's request, or one for another task, is not shown to this member", () => {
    const s = state();
    exception(s, { from: "dev-2", decision: "reject" });
    expect(workPrompt({ ...parts(s, named(flat, "dev-1"), flat, null), task: T1(s), brief, others: [], cwd: "/w" })).not.toContain("refused");
  });
});

describe("the PM's prompt about the rules", () => {
  it("offers the rule actions for the lesson and the exception occasions only", () => {
    const s = state();
    expect(pmActions(s, { kind: "rule_lesson" })).toEqual(["rule_lesson", "rule_question"]);
    expect(pmActions(s, { kind: "rule_exception" })).toEqual(["exception_proposal", "exception_decline", "rule_question"]);
    for (const kind of ["conversation", "plan_review", "reports", "escalation", "acceptance", "areas", "area_review", "area_escalation"] as const) {
      expect(pmActions(s, { kind }).filter((a) => ["rule_lesson", "exception_proposal", "exception_decline", "rule_question"].includes(a)), kind).toEqual([]);
    }
  });

  it("lists the settled incidents and tells the PM to add a preventive rule, never to remove or replace one", () => {
    const s = state();
    const inc = recordIncident(s as GovernedState, { kind: "disagreement", source: { kind: "member_report", member: "dev-1", task: "T1", occurrence: "c1#0" }, reportedBy: "dev-1", summary: "dev-1 and dev-2 disagreed on the units" });
    if (!inc.ok) throw new Error(inc.reason);
    expect(pm(s, flat, { kind: "rule_lesson" })).not.toContain("Settled incidents");
    resolveIncident(s as GovernedState, inc.value.id, "the techlead chose centimetres");
    const text = pm(s, flat, { kind: "rule_lesson" });
    expect(text).toContain(`- ${inc.value.id} (disagreement, from dev-1): dev-1 and dev-2 disagreed on the units. Resolved: the techlead chose centimetres.`);
    expect(text).toContain("the rule that prevents it from happening again");
    expect(text).toContain("Answer all of them in this one turn");
    expect(text).toMatch(/never remove, replace or contradict one/);
    expect(text).toContain("Allowed actions now: rule_lesson, rule_question");
  });

  it("a lesson being recorded when the run stopped is shown, to be given again as it was", () => {
    const s = state();
    const inc = recordIncident(s as GovernedState, { kind: "deviation", source: { kind: "user_message", seq: 1 }, reportedBy: "dev-1", summary: "x" });
    s.messages.push({ seq: 1, from: "user", text: "do it" } as never);
    const again = recordIncident(s as GovernedState, { kind: "deviation", source: { kind: "user_message", seq: 1 }, reportedBy: "dev-1", summary: "x" });
    if (!inc.ok || !again.ok) throw new Error("incident");
    resolveIncident(s as GovernedState, again.value.id, "fixed");
    (s as GovernedState).governance!.incidents[0]!.status = "recording";
    (s as GovernedState).governance!.incidents[0]!.lesson = { text: "Say it twice.", ruleId: null, rationale: null };
    expect(pm(s, flat, { kind: "rule_lesson" })).toContain("give the same text again: Say it twice.");
  });

  it("an exception to assess shows the rules (with their text), the reason, the alternative and the scope asked for", () => {
    const s = state();
    const ex = exception(s, { assess: false });
    const text = pm(s, flat, { kind: "rule_exception" });
    expect(text).toContain(`${ex.id} from dev-1 for R1 (State the units in every task description.)`);
    expect(text).toContain("R1 does not fit");
    expect(text).toContain("Instead: state them in the tests");
    expect(text).toContain("It asked for task T1");
    expect(text).toMatch(/never more than was asked|the work the member asked for or less/);
    expect(text).toMatch(/nothing changes until they agree/);
    expect(text).toContain("Allowed actions now: exception_proposal, exception_decline, rule_question");
  });

  it("a proposal the PM made and the user has not been shown yet is listed as one to present, never as granted", () => {
    const s = state();
    exception(s);
    const text = pm(s, flat, { kind: "conversation" });
    expect(text).toContain("Your proposals not shown to the user yet");
    expect(text).not.toContain("approved for");
  });

  it("a request shown to the user and waiting is said to grant nothing; a refused one says the rules stand; an approved one covers its scope only", () => {
    const s = state();
    exception(s, { decision: null });
    expect(pm(s, flat, { kind: "conversation" })).toMatch(/grant nothing yet, and the work they hold waits/);
    const s2 = state();
    exception(s2, { decision: "reject" });
    expect(pm(s2, flat, { kind: "conversation" })).toContain("rejected; the rules stand");
    const s3 = state();
    exception(s3, { decision: "approve" });
    expect(pm(s3, flat, { kind: "conversation" })).toContain("approved for task T1 only");
  });

  it("an unanswered question to the user keeps its work waiting in the prompt; its answer is information, not approval", () => {
    const s = state();
    const ex = exception(s, { assess: false });
    askDirection(s as GovernedState, { exceptionId: ex.id }, "Q-REQ");
    expect(pm(s, flat, { kind: "conversation" })).toMatch(/not answered yet: X1\. The work that depends on them waits/);
    answerDirection(s as GovernedState, "Q-REQ", "yes, go ahead");
    const text = pm(s, flat, { kind: "rule_exception" });
    expect(text).not.toMatch(/not answered yet/);
    expect(text).toContain("Exception requests to assess");
  });

  it("every PM prompt carries the guidance: lesson after an incident, present rules/reason/alternative/scope, ask when unsure", () => {
    for (const kind of ["conversation", "plan_review", "acceptance", "rule_lesson", "rule_exception"] as const) {
      const text = pm(state(), flat, { kind });
      expect(text, kind).toContain("## Rules, lessons and exceptions");
      expect(text, kind).toMatch(/preventive rule \(rule_lesson\)/);
      expect(text, kind).toMatch(/exception_proposal\) with the rules involved, the reason, what the team does instead and exactly which work it covers/);
      expect(text, kind).toMatch(/Nothing is done differently until the user agrees/);
      expect(text, kind).toMatch(/refused or unanswered request changes nothing/);
      expect(text, kind).toMatch(/ask the user \(rule_question\)/);
    }
  });

  it("the PM prompt shows no incident section when the run has none", () => {
    expect(pm(state(), flat, { kind: "conversation" })).not.toContain("incidents and exceptions");
  });

  it("only the head PM asks the user: a team with groups says so, a team without does not", () => {
    expect(pm(state(), grouped, { kind: "conversation" })).toContain("only the head PM asks the user");
    expect(pm(state(), flat, { kind: "conversation" })).not.toContain("only the head PM asks the user");
  });
});

describe("a group's PM", () => {
  it("passes a request up to the head PM, never approves an exception and never asks the user", () => {
    const s = state();
    const group = teamGroups(grouped).find((g) => g.name === "web")!;
    const text = areaPmPrompt({ ...parts(s, group.pm!, grouped, null), occasion: { kind: "area_escalation" }, brief, group, area: null, plan: null, openEscalations: [], head: named(grouped, "pm") });
    expect(text).toContain("## Rules and exceptions");
    expect(text).toMatch(/goes up to pm \(escalate/);
    expect(text).toMatch(/alone shows it to the user/);
    expect(text).toMatch(/never approve an exception, and you never ask the user/);
    expect(text).not.toContain("governance.exception");
    expect(text).not.toMatch(/exception_proposal|rule_question/);
    expect(text).toContain("Allowed actions now: none, team_answer, escalate");
  });
});
