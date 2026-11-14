import { describe, expect, it, onTestFinished } from "vitest";
import {
  answerDirection, askDirection, assessException, beginLesson, callScope, completeLesson, declineException, declineLesson, decideException, decisionFromAnswer,
  deliverDecision, emptyGovernance, exceptionGrant, exceptionsFor, exceptionStatus, governanceOf, governanceWork, heldTaskIds, issueOccurrence, planningUnit, unitOccurrence, UNGROUPED_PLANNING, presentException, recordIncident,
  repointRequest, requestException, resolveIncident, scopeCovers, scopeProblems, scopeWithin, splitReport, unitHeld, type AssessmentInput, type ExceptionScope,
  type GovernedState, type IncidentSource,
} from "../../src/team/rule-governance.js";
import { boardJobs, newTask } from "../../src/team/board.js";
import { TEAM_DEFAULTS, teamMembers } from "../../src/team/config.js";
import { newTeamState, normalizeGovernance, TeamStore } from "../../src/team/state.js";
import { askException, reportIssue, governance, task } from "../helpers/team-builders.js";
import { tempDir } from "../helpers/tmp.js";

const state = (): GovernedState & ReturnType<typeof newTeamState> => {
  const s = newTeamState("run-1", "do it");
  s.tasks = ["T1", "T2", "T3"].map((id) => newTask(task(id)));
  s.integration = { commit: "c1", checks: [], triage: false, trouble: null, triageGroups: [] };
  s.verifiedTree = "tree1";
  return s;
};
const assessment = (over: Partial<AssessmentInput> = {}): AssessmentInput => ({
  by: "pm", ruleIds: ["R1"], reason: "R1 does not fit", alternative: "do it another way", taskIds: ["T1"], unit: null, summary: "R1 on T1", ...over,
});
const ask = (s: GovernedState, over: Partial<Parameters<typeof requestException>[1]> = {}) => {
  const r = requestException(s, { from: "dev-1", ruleIds: ["R1"], reason: "does not fit", alternative: null, work: { task: "T1" }, ...over });
  if (!r.ok) throw new Error(r.reason);
  return r.value;
};
/** An exception shown to the user in request `req`. */
const shown = (s: GovernedState, req = "REQ1", over: Partial<AssessmentInput> = {}, from = "dev-1") => {
  const ex = ask(s, { from });
  expect(assessException(s, ex.id, assessment(over)).ok).toBe(true);
  expect(presentException(s, ex.id, req).ok).toBe(true);
  return ex;
};

describe("a scope", () => {
  it("is this run and a task, or a unit of work with an identity, never free text", () => {
    const s = state();
    expect(callScope(s, { task: "T1" })).toMatchObject({ ok: true, value: { runId: "run-1", taskIds: ["T1"], unit: null } });
    expect(callScope(s, { unit: { kind: "integration", id: "run" } })).toMatchObject({ ok: true, value: { runId: "run-1", taskIds: [], unit: { kind: "integration", id: "run", occurrence: "commit:c1" } } });
    expect(callScope(s, { task: "T9" })).toMatchObject({ ok: false });
    expect(callScope(s, { unit: { kind: "everything" as never, id: "run" } })).toMatchObject({ ok: false });
    expect(callScope(s, { unit: { kind: "apply", id: "all the work please" } })).toMatchObject({ ok: false });
  });

  it("is checked against the run: another run, a task it lacks, both or none", () => {
    const s = state();
    const scope = (over: Partial<ExceptionScope>): ExceptionScope => ({ runId: "run-1", taskIds: ["T1"], unit: null, ...over });
    expect(scopeProblems(s, scope({}))).toEqual([]);
    expect(scopeProblems(s, scope({ runId: "other" }))).toEqual(["the scope is of run 'other', not this run"]);
    expect(scopeProblems(s, scope({ taskIds: ["T9"] }))).toEqual(["'T9' is not a task of this run"]);
    expect(scopeProblems(s, scope({ taskIds: [] }))).toEqual(["a scope names tasks or one unit of work"]);
    expect(scopeProblems(s, scope({ unit: { kind: "apply", id: "run", occurrence: "tree:tree1" } }))).toEqual(["a scope is tasks or one unit of work, not both"]);
  });

  it("covers by identity, in its own run only", () => {
    const scope: ExceptionScope = { runId: "run-1", taskIds: ["T1"], unit: null };
    expect(scopeCovers(scope, "run-1", { task: "T1" })).toBe(true);
    expect(scopeCovers(scope, "run-1", { task: "T2" })).toBe(false);
    expect(scopeCovers(scope, "run-2", { task: "T1" })).toBe(false);
    expect(scopeCovers(scope, "run-1", { unit: { kind: "apply", id: "run", occurrence: "tree:t1" } })).toBe(false);
    const unit: ExceptionScope = { runId: "run-1", taskIds: [], unit: { kind: "apply", id: "run", occurrence: "tree:t1" } };
    expect(scopeCovers(unit, "run-1", { unit: { kind: "apply", id: "run", occurrence: "tree:t1" } })).toBe(true);
    expect(scopeCovers(unit, "run-1", { unit: { kind: "apply", id: "run", occurrence: "tree:t2" } })).toBe(false);
    expect(scopeCovers(unit, "run-1", { unit: { kind: "integration", id: "run", occurrence: "tree:t1" } })).toBe(false);
    expect(scopeCovers(unit, "run-1", { task: "T1" })).toBe(false);
    expect(scopeWithin({ ...scope, taskIds: ["T1"] }, { ...scope, taskIds: ["T1", "T2"] })).toBe(true);
    expect(scopeWithin({ ...scope, taskIds: ["T1", "T2"] }, scope)).toBe(false);
  });
});

describe("incidents", () => {
  it("come from something that happened in the run's flow, and name the rules they know", () => {
    const s = state();
    const bad = (source: IncidentSource) => recordIncident(s, { kind: "deviation", source, reportedBy: "dev-1", summary: "x" });
    expect(bad({ kind: "escalation", escalationId: "E9" })).toEqual({ ok: false, reason: "'E9' is not an escalation of this run" });
    expect(bad({ kind: "review", task: "T1", occurrence: "1.1" })).toMatchObject({ ok: false, reason: "task 'T1' has no review that asked for changes" });
    expect(bad({ kind: "check", task: "T1", occurrence: "1.1" })).toMatchObject({ ok: false, reason: "task 'T1' has no failed check" });
    expect(bad({ kind: "user_message", seq: 77 })).toMatchObject({ ok: false });
    expect(bad({ kind: "member_report", member: "dev-1", task: "T9", occurrence: "c1#0" })).toMatchObject({ ok: false });
    expect(bad({ kind: "member_report", member: " ", task: null, occurrence: "c1#0" })).toMatchObject({ ok: false });
    expect(recordIncident(s, { kind: "deviation", source: { kind: "member_report", member: "dev-1", task: null, occurrence: "c1#0" }, reportedBy: "dev-1", summary: "x", ruleIds: ["R7"], known: new Set(["R1"]) }))
      .toMatchObject({ ok: false });
    expect(recordIncident(s, { kind: "deviation", source: { kind: "member_report", member: "dev-1", task: null, occurrence: "c1#0" }, reportedBy: "dev-1", summary: " " })).toEqual({ ok: false, reason: "say what happened" });
    expect(governanceOf(s).incidents).toEqual([]);
  });

  it("are accepted from a review, a check, an answered escalation and the user's own message", () => {
    const s = state();
    s.tasks[0]!.review = { reviewer: "techlead", verdict: "changes", summary: "", findings: [] };
    s.tasks[1]!.checks = [{ by: "qa-1", verdict: "fail", summary: "", failures: [] }];
    s.escalations.push({ id: "E1", task: "T1", reason: "question", text: "q", to: "pm", told: true, answer: "ints" });
    s.escalations.push({ id: "E2", task: "T1", reason: "question", text: "q", to: "pm", told: true, answer: null });
    const rec = (source: IncidentSource) => recordIncident(s, { kind: "disagreement", source, reportedBy: "agentduo", summary: "s" });
    expect(rec({ kind: "review", task: "T1", occurrence: "1.1" })).toMatchObject({ ok: true, value: { id: "I1", status: "reported" } });
    expect(rec({ kind: "check", task: "T2", occurrence: "1.1" })).toMatchObject({ ok: true, value: { id: "I2" } });
    expect(rec({ kind: "user_message", seq: 1 })).toMatchObject({ ok: true, value: { id: "I3" } });
    expect(rec({ kind: "escalation", escalationId: "E1" })).toMatchObject({ ok: true, value: { id: "I4", status: "resolved", resolution: "ints" } });
    expect(rec({ kind: "escalation", escalationId: "E2" })).toMatchObject({ ok: false });
  });

  it("are recorded once for one source and kind, however often a turn reports it", () => {
    const s = state();
    const input = { kind: "deviation" as const, source: { kind: "member_report" as const, member: "dev-1", task: "T1", occurrence: "c1#0" }, reportedBy: "dev-1", summary: "s" };
    const first = recordIncident(s, input);
    expect(first).toMatchObject({ ok: true, changed: true });
    expect(recordIncident(s, { ...input, summary: "reworded" })).toMatchObject({ ok: true, changed: false });
    expect(governanceOf(s).incidents).toHaveLength(1);
    expect(recordIncident(s, { ...input, kind: "disagreement" })).toMatchObject({ ok: true, changed: true });
    expect(governanceOf(s).incidents.map((i) => i.id)).toEqual(["I1", "I2"]);
  });

  it("teach only once resolved: reported → resolved → recording → recorded, each step repeatable and none going back", () => {
    const s = state();
    recordIncident(s, { kind: "deviation", source: { kind: "member_report", member: "dev-1", task: null, occurrence: "c1#0" }, reportedBy: "dev-1", summary: "s" });
    expect(beginLesson(s, "I1", "Always say units.")).toMatchObject({ ok: false, reason: "incident I1 is not resolved yet" });
    expect(resolveIncident(s, "I1", " ")).toMatchObject({ ok: false });
    expect(resolveIncident(s, "I1", "the PM clarified it")).toMatchObject({ ok: true, changed: true });
    expect(resolveIncident(s, "I1", "again")).toMatchObject({ ok: true, changed: false, value: { resolution: "the PM clarified it" } });
    expect(beginLesson(s, "I1", "  ")).toMatchObject({ ok: false });
    expect(beginLesson(s, "I1", "Always say units.")).toMatchObject({ ok: true, changed: true, value: { status: "recording" } });
    expect(beginLesson(s, "I1", "Always say units.")).toMatchObject({ ok: true, changed: false });
    expect(beginLesson(s, "I1", "Another rule")).toMatchObject({ ok: false });
    expect(governanceWork(s).lessons.map((i) => i.id)).toEqual(["I1"]);
    expect(completeLesson(s, "I1", "")).toMatchObject({ ok: false });
    expect(completeLesson(s, "I1", "R4")).toMatchObject({ ok: true, changed: true, value: { status: "recorded", lesson: { text: "Always say units.", ruleId: "R4" } } });
    expect(completeLesson(s, "I1", "R4")).toMatchObject({ ok: true, changed: false });
    expect(completeLesson(s, "I1", "R5")).toMatchObject({ ok: false });
    expect(beginLesson(s, "I1", "Another rule")).toMatchObject({ ok: false });
    expect(declineLesson(s, "I1", "no")).toMatchObject({ ok: false });
    expect(governanceWork(s).lessons).toEqual([]);
    expect(completeLesson(s, "I9", "R1")).toMatchObject({ ok: false });
  });

  it("can be closed without a lesson by the PM, once, and then take none", () => {
    const s = state();
    recordIncident(s, { kind: "disagreement", source: { kind: "member_report", member: "dev-1", task: null, occurrence: "c1#0" }, reportedBy: "dev-1", summary: "s" });
    expect(declineLesson(s, "I1", "no")).toMatchObject({ ok: false });
    resolveIncident(s, "I1", "settled");
    expect(declineLesson(s, "I1", "one-off")).toMatchObject({ ok: true, changed: true, value: { status: "no_lesson" } });
    expect(declineLesson(s, "I1", "one-off")).toMatchObject({ ok: true, changed: false });
    expect(beginLesson(s, "I1", "A rule")).toMatchObject({ ok: false });
  });
});

describe("an exception request", () => {
  it("is for the work of the call that made it, set by agentduo, with the rules named", () => {
    const s = state();
    const ex = ask(s, { work: { task: "T2" } });
    expect(ex).toMatchObject({ id: "X1", from: "dev-1", ruleIds: ["R1"], requested: { runId: "run-1", taskIds: ["T2"], unit: null }, assessment: null, decision: null });
    expect(exceptionStatus(ex)).toBe("requested");
    expect(requestException(s, { from: "dev-1", ruleIds: [], reason: "x", work: { task: "T1" } })).toMatchObject({ ok: false, reason: "name at least one rule id" });
    expect(requestException(s, { from: "dev-1", ruleIds: ["R1"], reason: " ", work: { task: "T1" } })).toMatchObject({ ok: false });
    expect(requestException(s, { from: "dev-1", ruleIds: ["R1"], reason: "x", work: { task: "T9" } })).toMatchObject({ ok: false });
    expect(requestException(s, { from: "dev-1", ruleIds: ["R8"], reason: "x", work: { task: "T1" }, known: new Set(["R1"]) })).toMatchObject({ ok: false });
    expect(requestException(s, { from: "dev-1", ruleIds: ["R1"], reason: "x", work: { task: "T1" }, incidentId: "I9" })).toMatchObject({ ok: false });
    expect(governanceOf(s).exceptions).toHaveLength(1);
  });

  it("is made once for the same member, rules and work; asked again after a refusal it is refused", () => {
    const s = state();
    const ex = ask(s);
    expect(requestException(s, { from: "dev-1", ruleIds: ["R1"], reason: "again", work: { task: "T1" } })).toMatchObject({ ok: true, changed: false, value: { id: ex.id } });
    expect(ask(s, { from: "dev-2" }).id).not.toBe(ex.id);
    expect(ask(s, { work: { task: "T2" } }).id).not.toBe(ex.id);
    assessException(s, ex.id, assessment());
    presentException(s, ex.id, "REQ1");
    decideException(s, { requestId: "REQ1", source: "user", approved: false });
    expect(requestException(s, { from: "dev-1", ruleIds: ["R1"], reason: "once more", work: { task: "T1" } })).toMatchObject({ ok: false });
  });

  it("holds its task from the moment it is made", () => {
    const s = state();
    ask(s);
    expect([...heldTaskIds(s)]).toEqual(["T1"]);
  });
});

describe("the PM's assessment", () => {
  it("names the rules, the reason, the alternative and the exact scope, inside what was asked", () => {
    const s = state();
    const ex = ask(s, { ruleIds: ["R1", "R2"], work: { task: "T1" } });
    expect(assessException(s, ex.id, assessment({ ruleIds: ["R3"] }))).toMatchObject({ ok: false, reason: expect.stringContaining("rule 'R3' was not in the request") });
    expect(assessException(s, ex.id, assessment({ taskIds: ["T1", "T2"] }))).toMatchObject({ ok: false, reason: expect.stringContaining("goes beyond what was asked for") });
    expect(assessException(s, ex.id, assessment({ taskIds: ["T9"] }))).toMatchObject({ ok: false });
    expect(assessException(s, ex.id, assessment({ taskIds: [], unit: { kind: "apply", id: "run" } }))).toMatchObject({ ok: false });
    expect(assessException(s, ex.id, assessment({ taskIds: [] }))).toMatchObject({ ok: false });
    expect(assessException(s, ex.id, assessment({ alternative: " " }))).toMatchObject({ ok: false, reason: "say what the team does instead" });
    expect(assessException(s, ex.id, assessment({ reason: "", summary: "" }))).toMatchObject({ ok: false });
    expect(assessException(s, "X9", assessment())).toMatchObject({ ok: false });
    expect(ex.assessment).toBeNull();
    const ok = assessException(s, ex.id, assessment({ ruleIds: ["R2"] }));
    expect(ok).toMatchObject({ ok: true, value: { assessment: { ruleIds: ["R2"], scope: { runId: "run-1", taskIds: ["T1"], unit: null }, alternative: "do it another way" } } });
    expect(exceptionStatus(ex)).toBe("assessed");
    expect(assessException(s, ex.id, assessment({ alternative: "better way" }))).toMatchObject({ ok: true });
  });

  it("is not changed once the user has been shown it", () => {
    const s = state();
    const ex = shown(s);
    expect(assessException(s, ex.id, assessment({ alternative: "a different one" }))).toMatchObject({ ok: false });
    expect(ex.assessment!.alternative).toBe("do it another way");
  });

  it("of a unit request stays on that unit", () => {
    const s = state();
    const ex = ask(s, { work: { unit: { kind: "integration", id: "run" } } });
    expect(assessException(s, ex.id, assessment({ taskIds: ["T1"] }))).toMatchObject({ ok: false });
    expect(assessException(s, ex.id, assessment({ taskIds: [], unit: { kind: "apply", id: "run" } }))).toMatchObject({ ok: false });
    expect(assessException(s, ex.id, assessment({ taskIds: [], unit: { kind: "integration", id: "run" } }))).toMatchObject({ ok: true });
  });

  it("goes to the user only when there is one, and as a request that no other thing uses", () => {
    const s = state();
    const ex = ask(s);
    expect(presentException(s, ex.id, "REQ1")).toMatchObject({ ok: false, reason: expect.stringContaining("no assessment") });
    assessException(s, ex.id, assessment());
    expect(presentException(s, ex.id, " ")).toMatchObject({ ok: false });
    s.waiting = { kind: "plan", requestId: "PLAN-REQ" };
    expect(presentException(s, ex.id, "PLAN-REQ")).toMatchObject({ ok: false, reason: "request PLAN-REQ already stands for something else" });
    expect(presentException(s, ex.id, "REQ1")).toMatchObject({ ok: true, changed: true, value: { decision: { status: "pending", requestId: "REQ1", by: null, delivered: false } } });
    expect(presentException(s, ex.id, "REQ1")).toMatchObject({ ok: true, changed: false });
    expect(presentException(s, ex.id, "REQ2")).toMatchObject({ ok: false });
    const other = ask(s, { from: "dev-2" });
    assessException(s, other.id, assessment());
    expect(presentException(s, other.id, "REQ1")).toMatchObject({ ok: false });
    expect(exceptionStatus(ex)).toBe("pending");
  });
});

describe("the user's decision", () => {
  it("approves only through the request that showed the exception, and only the user's", () => {
    const s = state();
    const ex = shown(s, "REQ1");
    expect(exceptionsFor(s, { task: "T1" })).toEqual([]);
    expect(decideException(s, { requestId: "REQ-OTHER", source: "user", approved: true })).toMatchObject({ ok: false });
    expect(decideException(s, { requestId: "REQ1", source: "pm" as never, approved: true })).toMatchObject({ ok: false });
    expect(decideException(s, { requestId: "REQ1", source: "agent" as never, approved: true })).toMatchObject({ ok: false });
    expect(exceptionStatus(ex)).toBe("pending");
    expect(exceptionGrant(s, { task: "T1" }, "R1")).toBeNull();
    expect(decideException(s, { requestId: "REQ1", source: "user", approved: true })).toMatchObject({ ok: true, changed: true, value: { decision: { status: "approved", by: "user" } } });
    expect(exceptionGrant(s, { task: "T1" }, "R1")?.id).toBe(ex.id);
  });

  it("is not made by a plan's approval, a team answer, a note or a PM's question under another id", () => {
    const s = state();
    const ex = shown(s, "REQ1");
    s.waiting = { kind: "plan", requestId: "REQ-PLAN" };
    s.leadNotes.push({ group: null, text: "ex approved" });
    s.escalations.push({ id: "E1", task: "T1", reason: "question", text: "approve?", to: "pm", told: true, answer: "approved" });
    const asked = askDirection(s, { exceptionId: ex.id }, "REQ-Q");
    expect(asked).toMatchObject({ ok: false }); // already shown to the user
    expect(decideException(s, { requestId: "REQ-PLAN", source: "user", approved: true })).toMatchObject({ ok: false });
    expect(decideException(s, { requestId: "E1", source: "user", approved: true })).toMatchObject({ ok: false });
    expect(decideException(s, { requestId: "REQ-Q", source: "user", approved: true })).toMatchObject({ ok: false });
    expect(exceptionStatus(ex)).toBe("pending");
    expect(exceptionsFor(s, { task: "T1" })).toEqual([]);
  });

  it("is not made by the answer to the PM's question about the same exception", () => {
    const s = state();
    const ex = ask(s);
    expect(askDirection(s, { exceptionId: ex.id }, "REQ-Q")).toMatchObject({ ok: true });
    expect(answerDirection(s, "REQ-Q", "Yes, go ahead")).toMatchObject({ ok: true, value: { answer: "Yes, go ahead" } });
    expect(decideException(s, { requestId: "REQ-Q", source: "user", approved: true })).toMatchObject({ ok: false });
    expect(exceptionStatus(ex)).toBe("requested");
    expect(exceptionsFor(s, { task: "T1" })).toEqual([]);
  });

  it("is final: the same again changes nothing, the opposite is refused, and a refusal grants nothing", () => {
    const s = state();
    const a = shown(s, "REQ1");
    expect(decideException(s, { requestId: "REQ1", source: "user", approved: true })).toMatchObject({ ok: true, changed: true });
    expect(decideException(s, { requestId: "REQ1", source: "user", approved: true })).toMatchObject({ ok: true, changed: false });
    expect(decideException(s, { requestId: "REQ1", source: "user", approved: false })).toMatchObject({ ok: false });
    expect(exceptionStatus(a)).toBe("approved");
    const s2 = state();
    const b = shown(s2, "REQ2");
    decideException(s2, { requestId: "REQ2", source: "user", approved: false });
    expect(decideException(s2, { requestId: "REQ2", source: "user", approved: true })).toMatchObject({ ok: false });
    expect(exceptionStatus(b)).toBe("rejected");
    expect(exceptionsFor(s2, { task: "T1" })).toEqual([]);
  });

  it("reads an answer as approval only for exactly the approve option", () => {
    expect(decisionFromAnswer({ optionIds: ["approve"] })).toBe("approved");
    expect(decisionFromAnswer({ optionIds: ["reject"] })).toBe("rejected");
    expect(decisionFromAnswer({ optionIds: [] })).toBeNull();
    expect(decisionFromAnswer({ optionIds: ["approve", "reject"] })).toBeNull();
    expect(decisionFromAnswer({ optionIds: ["maybe"] })).toBeNull();
    expect(decisionFromAnswer({ optionIds: ["approve"], otherText: "only if tests pass" })).toBeNull();
    expect(decisionFromAnswer({ optionIds: [], otherText: "approved!" })).toBeNull();
  });

  it("is told to the member once, and only when it was made", () => {
    const s = state();
    const ex = shown(s, "REQ1");
    expect(deliverDecision(s, ex.id)).toMatchObject({ ok: false });
    decideException(s, { requestId: "REQ1", source: "user", approved: true });
    expect(deliverDecision(s, ex.id)).toMatchObject({ ok: true, changed: true });
    expect(deliverDecision(s, ex.id)).toMatchObject({ ok: true, changed: false });
    expect(deliverDecision(s, "X9")).toMatchObject({ ok: false });
  });

  it("is made by the PM alone only to refuse, and only before the user was shown anything", () => {
    const s = state();
    const ex = ask(s);
    expect(declineException(s, ex.id)).toMatchObject({ ok: true, value: { decision: { status: "rejected", requestId: null, by: "pm" } } });
    expect(declineException(s, ex.id)).toMatchObject({ ok: true, changed: false });
    expect(presentException(s, ex.id, "REQ1")).toMatchObject({ ok: false });
    expect(exceptionsFor(s, { task: "T1" })).toEqual([]);
    const s2 = state();
    const e2 = shown(s2, "REQ2");
    expect(declineException(s2, e2.id)).toMatchObject({ ok: false });
    expect(exceptionStatus(e2)).toBe("pending");
  });
});

describe("an approved exception", () => {
  const approved = (s = state(), over: Partial<AssessmentInput> = {}) => {
    const ex = shown(s, "REQ1", over);
    decideException(s, { requestId: "REQ1", source: "user", approved: true });
    return { s, ex };
  };

  it("covers only the approved rules on the approved tasks of this run", () => {
    const { s, ex } = approved();
    expect(exceptionsFor(s, { task: "T1" }).map((e) => e.id)).toEqual([ex.id]);
    expect(exceptionGrant(s, { task: "T1" }, "R1")?.id).toBe(ex.id);
    expect(exceptionGrant(s, { task: "T1" }, "R2")).toBeNull();
    expect(exceptionGrant(s, { task: "T2" }, "R1")).toBeNull();
    expect(exceptionGrant(s, { task: "T3" }, "R1")).toBeNull();
    expect(exceptionGrant(s, { unit: { kind: "integration", id: "run" } }, "R1")).toBeNull();
    expect(exceptionGrant({ ...s, id: "run-2" }, { task: "T1" }, "R1")).toBeNull();
  });

  it("covers only what the PM narrowed it to", () => {
    const s = state();
    const ex = ask(s, { ruleIds: ["R1", "R2"] });
    assessException(s, ex.id, assessment({ ruleIds: ["R2"] }));
    presentException(s, ex.id, "REQ1");
    decideException(s, { requestId: "REQ1", source: "user", approved: true });
    expect(exceptionGrant(s, { task: "T1" }, "R2")?.id).toBe(ex.id);
    expect(exceptionGrant(s, { task: "T1" }, "R1")).toBeNull();
  });

  it("opens no other task: the others keep waiting for their own decisions, and the rule is untouched", () => {
    const { s } = approved();
    const other = ask(s, { work: { task: "T2" } });
    expect(exceptionStatus(other)).toBe("requested");
    expect(exceptionGrant(s, { task: "T2" }, "R1")).toBeNull();
    expect([...heldTaskIds(s)]).toEqual(["T1", "T2"]);
  });

  it("covers a unit of work only for that unit", () => {
    const s = state();
    const ex = ask(s, { work: { unit: { kind: "apply", id: "run" } } });
    assessException(s, ex.id, assessment({ taskIds: [], unit: { kind: "apply", id: "run" } }));
    presentException(s, ex.id, "REQ1");
    decideException(s, { requestId: "REQ1", source: "user", approved: true });
    expect(exceptionGrant(s, { unit: { kind: "apply", id: "run" } }, "R1")?.id).toBe(ex.id);
    expect(exceptionGrant(s, { unit: { kind: "integration", id: "run" } }, "R1")).toBeNull();
    expect(exceptionGrant(s, { task: "T1" }, "R1")).toBeNull();
  });
});

describe("work held by an exception", () => {
  const held = (s: GovernedState) => [...heldTaskIds(s)];

  it("is held while undecided and until the member is told, then released: under the rule when refused, inside the scope when approved", () => {
    const s = state();
    const ex = ask(s);
    expect(held(s)).toEqual(["T1"]);
    assessException(s, ex.id, assessment());
    expect(held(s)).toEqual(["T1"]);
    presentException(s, ex.id, "REQ1");
    expect(held(s)).toEqual(["T1"]);
    decideException(s, { requestId: "REQ1", source: "user", approved: false });
    expect(held(s)).toEqual(["T1"]);
    deliverDecision(s, ex.id);
    expect(held(s)).toEqual([]);
  });

  it("is held by a PM's question to the user, and an answer to it releases nothing by itself", () => {
    const s = state();
    const ex = ask(s);
    askDirection(s, { exceptionId: ex.id }, "REQ-Q");
    expect(governanceWork(s).assess).toEqual([]);
    expect(governanceWork(s).questions).toEqual([{ requestId: "REQ-Q", exceptionId: ex.id, incidentId: null }]);
    answerDirection(s, "REQ-Q", "keep the rule for now");
    expect(held(s)).toEqual(["T1"]);
    expect(governanceWork(s).assess.map((e) => e.id)).toEqual([ex.id]);
    expect(governanceWork(s).questions).toEqual([]);
  });

  it("is held for a unit the same way", () => {
    const s = state();
    ask(s, { work: { unit: { kind: "integration", id: "run" } } });
    expect(unitHeld(s, { kind: "integration", id: "run" })).toBe(true);
    expect(unitHeld(s, { kind: "apply", id: "run" })).toBe(false);
    expect(held(s)).toEqual([]);
  });
});

describe("the PM's questions", () => {
  it("are asked once per item, answered only through their own request, and never approve", () => {
    const s = state();
    recordIncident(s, { kind: "deviation", source: { kind: "member_report", member: "dev-1", task: null, occurrence: "c1#0" }, reportedBy: "dev-1", summary: "s" });
    const ex = ask(s);
    expect(askDirection(s, { incidentId: "I1" }, "Q1")).toMatchObject({ ok: true, changed: true });
    expect(askDirection(s, { incidentId: "I1" }, "Q1")).toMatchObject({ ok: true, changed: false });
    expect(askDirection(s, { incidentId: "I1" }, "Q2")).toMatchObject({ ok: false });
    expect(askDirection(s, { exceptionId: ex.id }, "Q1")).toMatchObject({ ok: false });
    expect(askDirection(s, { exceptionId: "X9" }, "Q3")).toMatchObject({ ok: false });
    expect(askDirection(s, { exceptionId: ex.id }, " ")).toMatchObject({ ok: false });
    expect(answerDirection(s, "nope", "x")).toMatchObject({ ok: false });
    expect(answerDirection(s, "Q1", " ")).toMatchObject({ ok: false });
    expect(answerDirection(s, "Q1", "x")).toMatchObject({ ok: true, changed: true });
    expect(answerDirection(s, "Q1", "x")).toMatchObject({ ok: true, changed: false });
    expect(answerDirection(s, "Q1", "y")).toMatchObject({ ok: false });
    expect(governanceWork(s).questions).toEqual([]);
  });

  it("keep an exception from being shown until the user answered them", () => {
    const s = state();
    const ex = ask(s);
    assessException(s, ex.id, assessment());
    askDirection(s, { exceptionId: ex.id }, "Q1");
    expect(presentException(s, ex.id, "REQ1")).toMatchObject({ ok: false });
    expect(governanceWork(s).present).toEqual([]);
    answerDirection(s, "Q1", "ok");
    expect(governanceWork(s).present.map((e) => e.id)).toEqual([ex.id]);
    expect(presentException(s, ex.id, "REQ1")).toMatchObject({ ok: true });
  });
});

describe("a request asked again", () => {
  it("moves a pending request to a new id, and the old one decides and answers nothing", () => {
    const s = state();
    const ex = shown(s, "REQ1");
    expect(repointRequest(s, "REQ1", "REQ2")).toMatchObject({ ok: true, changed: true });
    expect(repointRequest(s, "REQ1", "REQ2")).toMatchObject({ ok: false }); // REQ1 no longer waits for anything
    expect(decideException(s, { requestId: "REQ1", source: "user", approved: true })).toMatchObject({ ok: false, reason: expect.stringContaining("replaced") });
    expect(exceptionStatus(ex)).toBe("pending");
    expect(presentException(s, ex.id, "REQ1")).toMatchObject({ ok: false });
    expect(decideException(s, { requestId: "REQ2", source: "user", approved: true })).toMatchObject({ ok: true });
    expect(repointRequest(s, "REQ2", "REQ3")).toMatchObject({ ok: false });
  });

  it("moves an unanswered question, and refuses an id in use", () => {
    const s = state();
    const ex = ask(s);
    expect(shown(s, "REQ9", {}, "dev-2").decision?.requestId).toBe("REQ9");
    askDirection(s, { exceptionId: ex.id }, "Q1");
    expect(repointRequest(s, "Q1", "REQ9")).toMatchObject({ ok: false });
    expect(repointRequest(s, "Q1", "Q2")).toMatchObject({ ok: true });
    expect(answerDirection(s, "Q1", "x")).toMatchObject({ ok: false });
    expect(answerDirection(s, "Q2", "x")).toMatchObject({ ok: true });
    expect(repointRequest(s, "Q2", "Q3")).toMatchObject({ ok: false });
  });
});

describe("what is owed", () => {
  it("is read from the state alone, so a resumed run finds exactly what a paused one left", () => {
    const s = state();
    recordIncident(s, { kind: "deviation", source: { kind: "member_report", member: "dev-1", task: null, occurrence: "c1#0" }, reportedBy: "dev-1", summary: "s" });
    resolveIncident(s, "I1", "ok");
    const a = ask(s);
    const b = ask(s, { from: "dev-2" });
    const c = ask(s, { from: "dev-1", work: { task: "T2" } });
    assessException(s, b.id, assessment());
    assessException(s, c.id, assessment({ taskIds: ["T2"] }));
    presentException(s, c.id, "REQ1");
    const copy = JSON.parse(JSON.stringify(s)) as typeof s;
    for (const view of [s, copy]) {
      const w = governanceWork(view);
      expect(w.lessons.map((i) => i.id)).toEqual(["I1"]);
      expect(w.assess.map((e) => e.id)).toEqual([a.id]);
      expect(w.present.map((e) => e.id)).toEqual([b.id]);
      expect(w.pending.map((e) => e.id)).toEqual([c.id]);
      expect(w.undelivered).toEqual([]);
    }
    decideException(copy, { requestId: "REQ1", source: "user", approved: false });
    expect(governanceWork(copy).undelivered.map((e) => e.id)).toEqual([c.id]);
    expect(governanceWork(copy).pending).toEqual([]);
  });
});

describe("a member's result", () => {
  it("is split into the result and the request, and a result asking for an exception does not complete the work", () => {
    const plain = splitReport({ status: "done", governance: governance() });
    expect(plain).toEqual({ result: { status: "done" }, report: { issues: [], exception: null }, completes: true });
    const issue = splitReport({ status: "done", governance: reportIssue("disagreement", "s", ["R1"]) });
    expect(issue.completes).toBe(true);
    expect(issue.report.issues).toHaveLength(1);
    const asking = splitReport({ status: "done", governance: askException() });
    expect(asking.completes).toBe(false);
    expect(asking.result).toEqual({ status: "done" });
    expect(splitReport({ status: "done" })).toMatchObject({ completes: true, report: { issues: [], exception: null } });
  });
});

describe("the run's state", () => {
  it("starts empty, and an older run (no governance, or a damaged one) opens empty, never granting anything", () => {
    expect(newTeamState("r", "x").governance).toEqual(emptyGovernance());
    expect(normalizeGovernance(undefined)).toEqual(emptyGovernance());
    expect(normalizeGovernance(null)).toEqual(emptyGovernance());
    expect(normalizeGovernance({ incidents: "x" as never, exceptions: null as never })).toEqual(emptyGovernance());
    const tmp = tempDir();
    onTestFinished(tmp.cleanup);
    const { store, state: saved } = TeamStore.create(tmp.path, "do it");
    const raw = JSON.parse(JSON.stringify(saved));
    delete raw.governance;
    store.writeJson("state.json", raw);
    const loaded = store.load();
    expect(loaded.governance).toEqual(emptyGovernance());
    expect(exceptionsFor(loaded, { task: "T1" })).toEqual([]);
  });

  it("is saved whole and restored: the pending request, the decision and its scope come back as they were", () => {
    const tmp = tempDir();
    onTestFinished(tmp.cleanup);
    const { store, state: s } = TeamStore.create(tmp.path, "do it");
    s.tasks = [newTask(task("T1")), newTask(task("T2"))];
    const pending = shown(s, "REQ1");
    const other = ask(s, { work: { task: "T2" } });
    store.save(s);
    const back = store.load();
    expect(back.governance).toEqual(s.governance);
    expect(governanceWork(back).pending.map((e) => e.id)).toEqual([pending.id]);
    expect(exceptionGrant(back, { task: "T1" }, "R1")).toBeNull();
    expect(decideException(back, { requestId: "REQ1", source: "user", approved: true })).toMatchObject({ ok: true });
    store.save(back);
    const again = store.load();
    expect(exceptionGrant(again, { task: "T1" }, "R1")?.id).toBe(pending.id);
    expect(exceptionGrant(again, { task: "T2" }, "R1")).toBeNull();
    expect(exceptionStatus(again.governance.exceptions.find((e) => e.id === other.id)!)).toBe("requested");
    expect(requestException(again, { from: "dev-2", ruleIds: ["R1"], reason: "x", work: { task: "T2" } }).ok).toBe(true);
    expect(again.governance.nextException).toBe(4);
  });
});

describe("work outside a task, by occurrence", () => {
  const unitOf = (kind: "integration" | "apply" | "planning" | "acceptance", id = "run") => ({ unit: { kind, id } });
  const approvedFor = (s: ReturnType<typeof state>, kind: "integration" | "apply" | "planning" | "acceptance", id = "run", req = "REQ1") => {
    const ex = ask(s, { work: unitOf(kind, id) });
    expect(assessException(s, ex.id, assessment({ taskIds: [], unit: { kind, id } })).ok).toBe(true);
    expect(presentException(s, ex.id, req).ok).toBe(true);
    expect(decideException(s, { requestId: req, source: "user", approved: true }).ok).toBe(true);
    return ex;
  };

  it("is read from the run's state and kept with the request: the integration commit, the tree to apply, the plan about to be written", () => {
    const s = state();
    expect(unitOccurrence(s, { kind: "integration", id: "run" })).toBe("commit:c1");
    expect(unitOccurrence(s, { kind: "apply", id: "run" })).toBe("tree:tree1");
    expect(unitOccurrence(s, { kind: "acceptance", id: "run" })).toBe("commit:c1/tree:tree1");
    expect(unitOccurrence(s, planningUnit("web"))).toBeNull(); // no approved brief
    s.approvedBrief = 1;
    expect(unitOccurrence(s, planningUnit("web"))).toBe("brief1.plan0");
    const empty = newTeamState("r", "x");
    expect(unitOccurrence(empty, { kind: "integration", id: "run" })).toBeNull();
    expect(requestException(empty, { from: "dev-1", ruleIds: ["R1"], reason: "x", work: unitOf("integration") })).toMatchObject({ ok: false, reason: expect.stringContaining("no integration") });
    expect(ask(s, { work: unitOf("integration") }).requested.unit).toEqual({ kind: "integration", id: "run", occurrence: "commit:c1" });
  });

  it("is never the PM's: its assessment takes the request's occurrence, and a unit that is not the one asked for is refused", () => {
    const s = state();
    const ex = ask(s, { work: unitOf("integration") });
    const forged = { kind: "integration", id: "run", occurrence: "commit:other" } as never;
    expect(assessException(s, ex.id, assessment({ taskIds: [], unit: forged })).ok).toBe(true);
    expect(ex.assessment!.scope.unit).toEqual({ kind: "integration", id: "run", occurrence: "commit:c1" });
    expect(assessException(s, ex.id, assessment({ taskIds: [], unit: { kind: "integration", id: "other" } }))).toMatchObject({ ok: false, reason: expect.stringContaining("not the one asked for") });
  });

  it("an approval for one integration result does not cover the next one", () => {
    const s = state();
    approvedFor(s, "integration");
    expect(exceptionGrant(s, unitOf("integration"), "R1")).not.toBeNull();
    s.integration!.commit = "c2";
    expect(exceptionGrant(s, unitOf("integration"), "R1")).toBeNull();
    expect(exceptionsFor(s, unitOf("integration"))).toEqual([]);
    s.integration!.commit = "c1";
    expect(exceptionGrant(s, unitOf("integration"), "R1")).not.toBeNull();
  });

  it("an approval for one tree to apply does not cover the next, and one for a plan does not cover its replacement", () => {
    const s = state();
    s.approvedBrief = 1;
    approvedFor(s, "apply", "run", "REQ-A");
    approvedFor(s, "planning", planningUnit("web").id, "REQ-P");
    expect(exceptionGrant(s, unitOf("apply"), "R1")).not.toBeNull();
    expect(exceptionGrant(s, unitOf("planning", planningUnit("web").id), "R1")).not.toBeNull();
    s.verifiedTree = "tree2";
    s.plans.push({ version: 1, group: "web", briefVersion: 1, summary: "", tasks: [], risks: [] });
    expect(exceptionGrant(s, unitOf("apply"), "R1")).toBeNull();
    expect(exceptionGrant(s, unitOf("planning", planningUnit("web").id), "R1")).toBeNull();
    // Another group's planning was never covered.
    s.approvedBrief = 1;
    expect(exceptionGrant({ ...s, plans: [] }, unitOf("planning", planningUnit("api").id), "R1")).toBeNull();
  });

  it("holds only the occurrence it was asked about, and the replacement needs its own request and decision", () => {
    const s = state();
    const a = ask(s, { work: unitOf("integration") });
    expect(unitHeld(s, { kind: "integration", id: "run" })).toBe(true);
    s.integration!.commit = "c2";
    expect(unitHeld(s, { kind: "integration", id: "run" })).toBe(false);
    const b = ask(s, { work: unitOf("integration") });
    expect(b.id).not.toBe(a.id);
    expect(unitHeld(s, { kind: "integration", id: "run" })).toBe(true);
    assessException(s, a.id, assessment({ taskIds: [], unit: { kind: "integration", id: "run" } }));
    presentException(s, a.id, "REQ1");
    decideException(s, { requestId: "REQ1", source: "user", approved: false });
    // A refusal of the earlier result does not refuse the new one.
    expect(requestException(s, { from: "dev-1", ruleIds: ["R1"], reason: "x", work: unitOf("integration") })).toMatchObject({ ok: true, changed: false, value: { id: b.id } });
  });

  it("tells a group named 'run' from a team without groups, and each advances with its own plans only", () => {
    const s = state();
    s.approvedBrief = 1;
    const plan = (group: string | null, version: number) => ({ version, group, briefVersion: 1, summary: "", tasks: [], risks: [] });
    expect(planningUnit(null)).toEqual({ kind: "planning", id: UNGROUPED_PLANNING });
    expect(planningUnit("run").id).not.toBe(planningUnit(null).id);
    approvedFor(s, "planning", planningUnit("run").id, "REQ-G");
    approvedFor(s, "planning", planningUnit(null).id, "REQ-N");
    const ungrouped = unitOf("planning", planningUnit(null).id);
    const grouped = unitOf("planning", planningUnit("run").id);
    expect(exceptionGrant(s, grouped, "R1")?.id).toBe("X1");
    expect(exceptionGrant(s, ungrouped, "R1")?.id).toBe("X2");
    // The group 'run' writes a plan (declined): its replacement needs its own decision, and the ungrouped planning is untouched.
    s.plans.push({ ...plan("run", 1), declined: true });
    expect(unitOccurrence(s, planningUnit("run"))).toBe("brief1.plan1");
    expect(unitOccurrence(s, planningUnit(null))).toBe("brief1.plan0");
    expect(exceptionGrant(s, grouped, "R1")).toBeNull();
    expect(exceptionGrant(s, ungrouped, "R1")?.id).toBe("X2");
    // A plan of the team without groups moves only its own.
    s.plans.push(plan(null, 1));
    expect(unitOccurrence(s, planningUnit(null))).toBe("brief1.plan1");
    expect(unitOccurrence(s, planningUnit("run"))).toBe("brief1.plan1");
    expect(exceptionGrant(s, ungrouped, "R1")).toBeNull();
  });

  it("names no occurrence for an id that is not a unit of its kind", () => {
    const s = state();
    s.approvedBrief = 1;
    expect(unitOccurrence(s, { kind: "planning", id: "run" })).toBeNull();
    expect(unitOccurrence(s, { kind: "planning", id: "web" })).toBeNull();
    expect(unitOccurrence(s, { kind: "planning", id: "group:" })).toBeNull();
    expect(unitOccurrence(s, { kind: "integration", id: "web" })).toBeNull();
    expect(unitOccurrence(s, { kind: "apply", id: "other" })).toBeNull();
    expect(unitOccurrence(s, { kind: "acceptance", id: "other" })).toBeNull();
  });

  it("keeps its occurrence through a save and a reload", () => {
    const s = state();
    approvedFor(s, "integration");
    const copy = JSON.parse(JSON.stringify(s)) as typeof s;
    expect(exceptionGrant(copy, unitOf("integration"), "R1")).not.toBeNull();
    copy.integration!.commit = "c3";
    expect(exceptionGrant(copy, unitOf("integration"), "R1")).toBeNull();
  });
});

describe("a question about an incident", () => {
  const incident = (s: ReturnType<typeof state>, source: IncidentSource = { kind: "member_report", member: "dev-1", task: "T1", occurrence: "c1#0" }) => {
    const r = recordIncident(s, { kind: "disagreement", source, reportedBy: "dev-1", summary: "s" });
    if (!r.ok) throw new Error(r.reason);
    return r.value;
  };

  it("holds the work waiting on it, by default its source's task, until the user answers", () => {
    const s = state();
    const i = incident(s);
    expect([...heldTaskIds(s)]).toEqual([]);
    expect(askDirection(s, { incidentId: i.id }, "Q1")).toMatchObject({ ok: true, value: { scope: { runId: "run-1", taskIds: ["T1"], unit: null }, answer: null } });
    expect([...heldTaskIds(s)]).toEqual(["T1"]);
    answerDirection(s, "Q1", "keep going");
    expect([...heldTaskIds(s)]).toEqual([]);
  });

  it("holds exactly the work named, a task or a unit occurrence, and none when nothing waits", () => {
    const s = state();
    const i = incident(s);
    expect(askDirection(s, { incidentId: i.id }, "Q1", { task: "T2" })).toMatchObject({ ok: true, value: { scope: { taskIds: ["T2"] } } });
    expect([...heldTaskIds(s)]).toEqual(["T2"]);
    const j = incident(s, { kind: "user_message", seq: 1 });
    expect(askDirection(s, { incidentId: j.id }, "Q2", { task: "T9" })).toMatchObject({ ok: false });
    expect(askDirection(s, { incidentId: j.id }, "Q2")).toMatchObject({ ok: true, value: { scope: null } });
    expect([...heldTaskIds(s)]).toEqual(["T2"]);
    const k = incident(s, { kind: "member_report", member: "dev-2", task: null, occurrence: "c9#0" });
    askDirection(s, { incidentId: k.id }, "Q3", { unit: { kind: "integration", id: "run" } });
    expect(unitHeld(s, { kind: "integration", id: "run" })).toBe(true);
    s.integration!.commit = "c2";
    expect(unitHeld(s, { kind: "integration", id: "run" })).toBe(false);
  });

  it("is held after a save and a reload, and in the board's jobs", () => {
    const s = state();
    const i = incident(s);
    askDirection(s, { incidentId: i.id }, "Q1");
    const copy = JSON.parse(JSON.stringify(s)) as typeof s;
    expect([...heldTaskIds(copy)]).toEqual(["T1"]);
    expect(governanceWork(copy).questions).toEqual([{ requestId: "Q1", exceptionId: null, incidentId: i.id }]);
    const jobs = boardJobs({ phase: "EXECUTION", tasks: copy.tasks, integration: null, applyConflict: null, governance: copy.governance }, { members: teamMembers(TEAM_DEFAULTS), busy: new Set(), running: new Set(), gates: false });
    expect(jobs.filter((j) => "task" in j && j.task === "T1")).toEqual([]);
    expect(jobs.filter((j) => "task" in j && j.task === "T2").length).toBeGreaterThan(0);
    answerDirection(copy, "Q1", "ok");
    const after = boardJobs({ phase: "EXECUTION", tasks: copy.tasks, integration: null, applyConflict: null, governance: copy.governance }, { members: teamMembers(TEAM_DEFAULTS), busy: new Set(), running: new Set(), gates: false });
    expect(after.filter((j) => "task" in j && j.task === "T1").length).toBeGreaterThan(0);
  });

  it("is moved with its scope when asked again, and its old id answers nothing", () => {
    const s = state();
    const i = incident(s);
    askDirection(s, { incidentId: i.id }, "Q1");
    repointRequest(s, "Q1", "Q2");
    expect(i.direction!.scope!.taskIds).toEqual(["T1"]);
    expect(answerDirection(s, "Q1", "x")).toMatchObject({ ok: false });
    expect([...heldTaskIds(s)]).toEqual(["T1"]);
  });

  it("from a run saved before the scope existed holds nothing and breaks nothing", () => {
    const s = state();
    const i = incident(s);
    i.direction = { requestId: "Q1", answer: null };
    expect([...heldTaskIds(s)]).toEqual([]);
    expect(answerDirection(s, "Q1", "x")).toMatchObject({ ok: true });
  });
});

describe("incidents of one source over time", () => {
  const report = (occurrence: string, over: Partial<{ kind: "deviation" | "disagreement"; summary: string }> = {}) => ({
    kind: over.kind ?? ("deviation" as const), source: { kind: "member_report" as const, member: "dev-1", task: "T1", occurrence }, reportedBy: "dev-1", summary: over.summary ?? `s ${occurrence}`,
  });

  it("are separate for the issues of one result, and one again when the same issue is recorded twice", () => {
    const s = state();
    const first = recordIncident(s, report(issueOccurrence("call-7", 0), { summary: "wrong units" }));
    const second = recordIncident(s, report(issueOccurrence("call-7", 1), { summary: "missed a file" }));
    expect(first).toMatchObject({ ok: true, changed: true, value: { id: "I1", summary: "wrong units" } });
    expect(second).toMatchObject({ ok: true, changed: true, value: { id: "I2", summary: "missed a file" } });
    expect(recordIncident(s, report(issueOccurrence("call-7", 1), { summary: "reworded" }))).toMatchObject({ ok: true, changed: false, value: { id: "I2", summary: "missed a file" } });
    expect(governanceOf(s).incidents).toHaveLength(2);
    expect(issueOccurrence("call-7", 1)).toBe("call-7#1");
  });

  it("are new when the same member reports the same kind in the same task later, even after the first was closed", () => {
    const s = state();
    recordIncident(s, report("call-1#0", { summary: "first" }));
    resolveIncident(s, "I1", "settled");
    beginLesson(s, "I1", "Rule one");
    completeLesson(s, "I1", "R1");
    const later = recordIncident(s, report("call-9#0", { summary: "second, later" }));
    expect(later).toMatchObject({ ok: true, changed: true, value: { id: "I2", summary: "second, later", status: "reported", lesson: null } });
    resolveIncident(s, "I2", "settled too");
    expect(beginLesson(s, "I2", "Rule two")).toMatchObject({ ok: true, value: { status: "recording" } });
    expect(governanceOf(s).incidents[0]).toMatchObject({ id: "I1", status: "recorded", lesson: { text: "Rule one", ruleId: "R1" } });
  });

  it("tell one review or check from the next by their occurrence", () => {
    const s = state();
    s.tasks[0]!.review = { reviewer: "techlead", verdict: "changes", summary: "", findings: [] };
    s.tasks[0]!.checks = [{ by: "qa-1", verdict: "fail", summary: "", failures: [] }];
    const rec = (source: IncidentSource) => recordIncident(s, { kind: "disagreement", source, reportedBy: "agentduo", summary: "s" });
    expect(rec({ kind: "review", task: "T1", occurrence: "1.1" })).toMatchObject({ ok: true, changed: true });
    expect(rec({ kind: "review", task: "T1", occurrence: "1.1" })).toMatchObject({ ok: true, changed: false });
    expect(rec({ kind: "review", task: "T1", occurrence: "1.2" })).toMatchObject({ ok: true, changed: true });
    expect(rec({ kind: "check", task: "T1", occurrence: "1.1" })).toMatchObject({ ok: true, changed: true });
    expect(rec({ kind: "check", task: "T1", occurrence: "2.1" })).toMatchObject({ ok: true, changed: true });
    expect(governanceOf(s).incidents).toHaveLength(4);
  });

  it("need the occurrence named", () => {
    const s = state();
    for (const occurrence of ["", "  "]) {
      expect(recordIncident(s, report(occurrence))).toEqual({ ok: false, reason: "a member_report names the occurrence it is about" });
    }
    expect(recordIncident(s, { kind: "deviation", source: { kind: "review", task: "T1" } as never, reportedBy: "x", summary: "s" })).toMatchObject({ ok: false });
    expect(governanceOf(s).incidents).toEqual([]);
  });
});
