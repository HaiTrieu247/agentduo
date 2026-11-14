// Acceptance contract: only a user's decision on the matching proposal grants a scoped exception.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPROVE_OPTION, REJECT_OPTION, answerDirection, askDirection, assessException, beginLesson, callScope,
  completeLesson, decideException, decisionFromAnswer, declineLesson, deliverDecision, exceptionGrant,
  exceptionStatus, exceptionsFor, governanceOf, governanceWork, planningUnit, presentException, recordIncident,
  repointRequest, requestException, resolveIncident, scopeCovers, scopeProblems, splitReport,
  type AssessmentInput, type ExceptionScope, type IncidentInput, type IncidentSource, type UserDecision,
} from "../../src/team/rule-governance.js";
import { TeamStore } from "../../src/team/state.js";
import { assessedException, governanceState, outcomeValue, pendingException, requestedException, RULE_IDS } from "../helpers/governance-builders.js";
import { tempDir } from "../helpers/tmp.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-14T10:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

const reported = (task = "T1"): IncidentInput => ({
  kind: "deviation", source: { kind: "member_report", member: "qa-1", task, occurrence: "check-1#0" }, reportedBy: "qa-1",
  summary: "The implementation used a different unit from the requirement.", ruleIds: [],
});

describe("AC3: a lesson follows an incident resolved in the team's flow", () => {
  it("keeps the incident unresolved until a resolution exists, then owes the PM a lesson", () => {
    const state = governanceState();
    const incident = outcomeValue(recordIncident(state, reported()));
    expect(incident.status).toBe("reported");
    expect(beginLesson(state, incident.id, "State units explicitly.").ok).toBe(false);
    expect(completeLesson(state, incident.id, "R1").ok).toBe(false);
    expect(resolveIncident(state, incident.id, "   ").ok).toBe(false);
    outcomeValue(resolveIncident(state, incident.id, "The unit was corrected and checked."));
    expect(governanceWork(state).lessons.map((i) => i.id)).toContain(incident.id);
    outcomeValue(beginLesson(state, incident.id, "State units explicitly."));
    expect(incident.status).toBe("recording");
    expect(incident.lesson?.ruleId).toBeNull();
    expect(governanceWork(state).lessons.map((i) => i.id)).toContain(incident.id);
    outcomeValue(completeLesson(state, incident.id, "R1"));
    expect(incident).toMatchObject({ status: "recorded", lesson: { text: "State units explicitly.", ruleId: "R1" } });
    expect(governanceWork(state).lessons).toEqual([]);
  });

  it("replays reports, resolution and the store acknowledgement without duplicating or replacing lessons", () => {
    const state = governanceState();
    const first = outcomeValue(recordIncident(state, reported()));
    expect(recordIncident(state, reported())).toMatchObject({ ok: true, changed: false, value: { id: first.id } });
    outcomeValue(resolveIncident(state, first.id, "Corrected the units."));
    outcomeValue(beginLesson(state, first.id, "State units explicitly."));
    expect(beginLesson(state, first.id, "State units explicitly.")).toMatchObject({ ok: true, changed: false });
    expect(beginLesson(state, first.id, "A replacement rule.").ok).toBe(false);
    outcomeValue(completeLesson(state, first.id, "R1"));
    const saved = structuredClone(first);
    expect(completeLesson(state, first.id, "R1")).toMatchObject({ ok: true, changed: false });
    expect(completeLesson(state, first.id, "R9").ok).toBe(false);
    expect(declineLesson(state, first.id, "Remove it.").ok).toBe(false);
    outcomeValue(resolveIncident(state, first.id, "A replay must not rewrite the resolution."));
    const second = outcomeValue(recordIncident(state, reported("T2")));
    outcomeValue(resolveIncident(state, second.id, "Corrected another deviation."));
    outcomeValue(beginLesson(state, second.id, "Verify units in review."));
    outcomeValue(completeLesson(state, second.id, "R2"));
    expect(governanceOf(state).incidents).toHaveLength(2);
    expect(first).toEqual(saved);
    expect(second.id).not.toBe(first.id);
  });

  it.each<IncidentSource>([
    { kind: "review", task: "T1", occurrence: "1.1" }, { kind: "check", task: "T1", occurrence: "1.1" },
    { kind: "escalation", escalationId: "unknown" }, { kind: "user_message", seq: 999 },
    { kind: "member_report", member: "qa-1", task: "missing-task", occurrence: "check-1#0" },
  ])("refuses an incident whose claimed source is absent: %j", (source) => {
    const state = governanceState();
    expect(recordIncident(state, { ...reported(), source }).ok).toBe(false);
    expect(governanceOf(state).incidents).toEqual([]);
  });

  it("does not treat a PM message, an approving review or a passing check as evidence of a deviation", () => {
    const state = governanceState();
    state.messages.push({ seq: 2, at: state.createdAt, from: "pm", text: "There was a mistake." });
    state.tasks[0]!.review = { reviewer: "techlead", verdict: "approve", summary: "Looks good.", findings: [] };
    state.tasks[0]!.checks = [{ by: "qa-1", verdict: "pass", summary: "Passed.", failures: [] }];
    for (const source of [{ kind: "user_message", seq: 2 }, { kind: "review", task: "T1", occurrence: "1.1" }, { kind: "check", task: "T1", occurrence: "1.1" }] as IncidentSource[]) {
      expect(recordIncident(state, { ...reported(), source }).ok).toBe(false);
    }
  });

  it("accepts actual review, check, user and resolved escalation evidence", () => {
    const state = governanceState();
    state.tasks[0]!.review = { reviewer: "techlead", verdict: "changes", summary: "Wrong units.", findings: [] };
    state.tasks[0]!.checks = [{ by: "qa-1", verdict: "fail", summary: "Wrong units.", failures: [] }];
    state.escalations.push({ id: "E1", task: "T1", reason: "question", text: "Units?", to: "pm", told: true, answer: "Use milliseconds." });
    for (const source of [{ kind: "user_message", seq: 1 }, { kind: "review", task: "T1", occurrence: "1.1" }, { kind: "check", task: "T1", occurrence: "1.1" }] as IncidentSource[]) {
      expect(outcomeValue(recordIncident(state, { ...reported(), source })).status).toBe("reported");
    }
    const incident = outcomeValue(recordIncident(state, { ...reported(), kind: "disagreement", source: { kind: "escalation", escalationId: "E1" } }));
    expect(incident).toMatchObject({ status: "resolved", resolution: "Use milliseconds." });
    expect(governanceWork(state).lessons.map((i) => i.id)).toContain(incident.id);
  });
});

describe("AC4–AC7: an exception request is separate from work and from approval", () => {
  it("retains the requester, rules, reason and exact work while the PM evaluates it", () => {
    const state = governanceState();
    const ex = requestedException(state);
    expect(ex).toMatchObject({ from: "dev-1", ruleIds: ["R1"], reason: expect.any(String), requested: { runId: state.id, taskIds: ["T1"], unit: null } });
    expect(exceptionStatus(ex)).toBe("requested");
    expect(governanceWork(state).assess.map((e) => e.id)).toEqual([ex.id]);
    expect(exceptionGrant(state, { task: "T1" }, "R1")).toBeNull();
    expect(presentException(state, ex.id, "too-early").ok).toBe(false);
    expect(deliverDecision(state, ex.id).ok).toBe(false);
  });

  it.each([
    { ruleIds: [] }, { ruleIds: ["unknown-rule"] }, { reason: "  " }, { work: { task: "missing-task" } }, { incidentId: "unknown-incident" },
  ])("refuses incomplete or foreign requests: %j", (over) => {
    const state = governanceState();
    expect(requestException(state, { from: "dev-1", ruleIds: ["R1"], reason: "Needs compatibility.", work: { task: "T1" }, known: RULE_IDS, ...over }).ok).toBe(false);
    expect(governanceOf(state).exceptions).toEqual([]);
  });

  it.each<Partial<AssessmentInput>>([
    { alternative: " " }, { reason: " " }, { summary: " " }, { ruleIds: [] },
    { ruleIds: ["R2"] }, { taskIds: ["T2"] }, { taskIds: [] },
    { taskIds: ["T1"], unit: { kind: "integration", id: "run" } },
  ])("cannot present an incomplete or wider PM proposal: %j", (over) => {
    const state = governanceState();
    const ex = requestedException(state);
    expect(assessException(state, ex.id, {
      by: "pm", ruleIds: ["R1"], reason: ex.reason, alternative: "Use the compatible API.", taskIds: ["T1"], unit: null,
      summary: "Only T1 departs from R1.", known: RULE_IDS, ...over,
    }).ok).toBe(false);
    expect(ex.assessment).toBeNull();
    expect(exceptionGrant(state, { task: "T1" }, "R1")).toBeNull();
  });

  it("freezes the exact proposal after it was shown to the user", () => {
    const state = governanceState();
    const ex = pendingException(state);
    const saved = structuredClone(ex.assessment!);
    expect(assessException(state, ex.id, {
      ...saved, taskIds: ["T2"], unit: null, alternative: "A different approach.",
    }).ok).toBe(false);
    expect(ex.assessment).toEqual(saved);
    expect(exceptionStatus(ex)).toBe("pending");
  });

  it.each(["plan-approval", "brief-approval", "acceptance-approval", "ordinary-question", "team-answer", "lead-note"])(
    "does not grant an exception for an unrelated %s request", (requestId) => {
      const state = governanceState();
      const ex = pendingException(state);
      expect(decideException(state, { requestId, source: "user", approved: true }).ok).toBe(false);
      expect(exceptionStatus(ex)).toBe("pending");
      expect(exceptionsFor(state, { task: "T1" })).toEqual([]);
    },
  );

  it.each(["pm", "techlead", "dev-1", "team_answer"])("refuses approval attributed to %s even for the matching request", (source) => {
    const state = governanceState();
    const ex = pendingException(state);
    expect(decideException(state, { requestId: "exception-request-1", source, approved: true } as UserDecision).ok).toBe(false);
    expect(exceptionStatus(ex)).toBe("pending");
  });

  it("grants only the matching rule, task and run, and keeps a decision stable under replay", () => {
    const state = governanceState();
    const first = pendingException(state);
    const other = pendingException(state, "exception-request-2", { task: "T2" });
    const decision: UserDecision = { requestId: "exception-request-1", source: "user", approved: true };
    outcomeValue(decideException(state, decision));
    expect(exceptionGrant(state, { task: "T1" }, "R1")?.id).toBe(first.id);
    expect(exceptionGrant(state, { task: "T1" }, "R2")).toBeNull();
    expect(exceptionGrant(state, { task: "T2" }, "R1")).toBeNull();
    expect(exceptionGrant({ ...state, id: "another-run" }, { task: "T1" }, "R1")).toBeNull();
    expect(exceptionStatus(other)).toBe("pending");
    const snapshot = structuredClone(first);
    expect(decideException(state, decision)).toMatchObject({ ok: true, changed: false });
    expect(decideException(state, { ...decision, approved: false }).ok).toBe(false);
    expect(first).toEqual(snapshot);
  });

  it("keeps rejection authoritative on replay and on a repeated member request", () => {
    const state = governanceState();
    const ex = pendingException(state);
    outcomeValue(decideException(state, { requestId: "exception-request-1", source: "user", approved: false }));
    expect(exceptionStatus(ex)).toBe("rejected");
    expect(decideException(state, { requestId: "exception-request-1", source: "user", approved: true }).ok).toBe(false);
    expect(requestException(state, { from: "dev-1", ruleIds: ["R1"], reason: "Asking again.", work: { task: "T1" } }).ok).toBe(false);
    outcomeValue(deliverDecision(state, ex.id));
    expect(exceptionGrant(state, { task: "T1" }, "R1")).toBeNull();
    expect(governanceOf(state).exceptions).toHaveLength(1);
  });

  it.each([
    { optionIds: [], otherText: "Approved" }, { optionIds: [] },
    { optionIds: [APPROVE_OPTION, REJECT_OPTION] }, { optionIds: [APPROVE_OPTION, APPROVE_OPTION] },
    { optionIds: ["Yes"] }, { optionIds: [APPROVE_OPTION], otherText: "Only if the scope changes." },
  ])("does not guess a decision from ambiguous answers: %j", (answer) => {
    expect(decisionFromAnswer(answer)).toBeNull();
  });

  it("recognizes the explicit approval and rejection option ids", () => {
    expect(decisionFromAnswer({ optionIds: [APPROVE_OPTION], otherText: null })).toBe("approved");
    expect(decisionFromAnswer({ optionIds: [REJECT_OPTION], otherText: null })).toBe("rejected");
  });

  it("does not count a done result asking for an exception as completed work", () => {
    const output = { status: "done", summary: "Ready if approved.", governance: {
      issues: [{ kind: "disagreement" as const, summary: "The rule conflicts with the runtime.", rule_ids: ["R1"] }],
      exception: { rule_ids: ["R1"], reason: "Needs compatibility.", alternative: "Use the older API." },
    } };
    const saved = structuredClone(output);
    const split = splitReport(output);
    expect(split.completes).toBe(false);
    expect(split.report).toEqual(output.governance);
    expect(split.result).toEqual({ status: "done", summary: "Ready if approved." });
    expect(output).toEqual(saved);
    expect(splitReport({ ...output, governance: { issues: output.governance.issues, exception: null } }).completes).toBe(true);
  });
});

describe("AC6: PM questions request direction and grant no exception", () => {
  it("keeps unresolved work owed while waiting and treats even 'approved' as information", () => {
    const state = governanceState();
    const ex = requestedException(state);
    outcomeValue(askDirection(state, { exceptionId: ex.id }, "direction-1"));
    expect(governanceWork(state).questions).toContainEqual({ requestId: "direction-1", exceptionId: ex.id, incidentId: null });
    expect(governanceWork(state).assess).toEqual([]);
    expect(answerDirection(state, "wrong-request", "Approved").ok).toBe(false);
    expect(decideException(state, { requestId: "direction-1", source: "user", approved: true }).ok).toBe(false);
    outcomeValue(answerDirection(state, "direction-1", "Approved"));
    expect(governanceWork(state).assess.map((e) => e.id)).toEqual([ex.id]);
    expect(exceptionStatus(ex)).toBe("requested");
    expect(exceptionGrant(state, { task: "T1" }, "R1")).toBeNull();
  });
});

describe("AC7: scope uses work identities", () => {
  it.each<ExceptionScope>([
    { runId: "another-run", taskIds: ["T1"], unit: null },
    { runId: "run-one", taskIds: [], unit: null },
    { runId: "run-one", taskIds: ["missing-task"], unit: null },
    { runId: "run-one", taskIds: ["T1", "T1"], unit: null },
    { runId: "run-one", taskIds: ["T1"], unit: { kind: "integration", id: "run", occurrence: "commit:c1" } },
  ])("refuses an ambiguous, missing or foreign scope: %j", (scope) => {
    expect(scopeProblems(governanceState(), scope).length).toBeGreaterThan(0);
  });

  it("does not turn free text describing scope into a work identity", () => {
    const state = governanceState();
    state.approvedBrief = 1;
    expect(callScope(state, { unit: { kind: "planning", id: "all tasks needing an exception" } }).ok).toBe(false);
    const ex = pendingException(state, "planning-request", { unit: planningUnit("frontend") });
    outcomeValue(decideException(state, { requestId: "planning-request", source: "user", approved: true }));
    expect(exceptionGrant(state, { unit: planningUnit("frontend") }, "R1")?.id).toBe(ex.id);
    expect(exceptionGrant(state, { unit: planningUnit("backend") }, "R1")).toBeNull();
    expect(exceptionGrant(state, { unit: { kind: "integration", id: "frontend" } }, "R1")).toBeNull();
    expect(exceptionGrant(state, { task: "T1" }, "R1")).toBeNull();
    expect(scopeCovers(ex.assessment!.scope, "another-run", { unit: ex.assessment!.scope.unit! })).toBe(false);
  });
});

describe("AC8: resume restores the work and the decisions still owed", () => {
  it("loads an older state without governance as empty, preserving unrelated approvals", () => {
    const tmp = tempDir();
    try {
      const state = governanceState();
      state.waiting = { kind: "plan", requestId: "plan-approval" };
      const legacy = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
      delete legacy.governance;
      const store = new TeamStore(tmp.path, state.id);
      mkdirSync(store.dir, { recursive: true });
      writeFileSync(store.path("state.json"), JSON.stringify(legacy));
      const loaded = store.load();
      expect(loaded.waiting).toEqual(state.waiting);
      expect(loaded.governance).toBeDefined();
      expect(governanceOf(loaded).incidents).toEqual([]);
      expect(governanceOf(loaded).exceptions).toEqual([]);
      expect(exceptionsFor(loaded, { task: "T1" })).toEqual([]);
      expect(loaded.tasks).toEqual(state.tasks);
    } finally {
      tmp.cleanup();
    }
  });

  it.each(["pending", "approved", "rejected"] as const)("persists %s without changing its authority or scope", (status) => {
    const tmp = tempDir();
    try {
      const { store, state } = TeamStore.create(join(tmp.path, "runs"), "Subtraction", new Date("2026-11-14T10:00:00Z"));
      state.tasks = governanceState().tasks;
      const ex = pendingException(state);
      if (status !== "pending") outcomeValue(decideException(state, { requestId: "exception-request-1", source: "user", approved: status === "approved" }));
      const incident = outcomeValue(recordIncident(state, reported()));
      outcomeValue(resolveIncident(state, incident.id, "Corrected."));
      outcomeValue(beginLesson(state, incident.id, "State units explicitly."));
      store.save(state);
      const loaded = TeamStore.open(join(tmp.path, "runs"), state.id).load();
      expect(governanceOf(loaded)).toEqual(governanceOf(state));
      expect(exceptionStatus(governanceOf(loaded).exceptions[0]!)).toBe(status);
      expect(exceptionGrant(loaded, { task: "T1" }, "R1")?.id ?? null).toBe(status === "approved" ? ex.id : null);
      expect(exceptionGrant(loaded, { task: "T2" }, "R1")).toBeNull();
      expect(governanceWork(loaded).lessons.map((i) => i.id)).toEqual([incident.id]);
      expect(governanceWork(loaded)[status === "pending" ? "pending" : "undelivered"].map((e) => e.id)).toEqual([ex.id]);
    } finally {
      tmp.cleanup();
    }
  });

  it("reissues a paused request without allowing the old answer to decide it", () => {
    const state = governanceState();
    const ex = pendingException(state, "request-before-pause");
    outcomeValue(repointRequest(state, "request-before-pause", "request-after-resume"));
    expect(decideException(state, { requestId: "request-before-pause", source: "user", approved: true }).ok).toBe(false);
    expect(exceptionStatus(ex)).toBe("pending");
    outcomeValue(decideException(state, { requestId: "request-after-resume", source: "user", approved: true }));
    expect(exceptionStatus(ex)).toBe("approved");
    expect(ex.decision?.requestId).toBe("request-after-resume");
  });

  it("does not reuse request ids across an exception and a direction question", () => {
    const state = governanceState();
    pendingException(state, "already-used");
    const second = assessedException(state, { task: "T2" });
    expect(presentException(state, second.id, "already-used").ok).toBe(false);
    expect(askDirection(state, { exceptionId: second.id }, "already-used").ok).toBe(false);
    expect(exceptionStatus(second)).toBe("assessed");
  });

  it.each(["brief", "plan", "acceptance", "apply_conflict"] as const)(
    "cannot link an exception to the current %s approval", (kind) => {
      const state = governanceState();
      state.waiting = { kind, requestId: "ordinary-approval" };
      const ex = assessedException(state);
      expect(presentException(state, ex.id, "ordinary-approval").ok).toBe(false);
      expect(decideException(state, { requestId: "ordinary-approval", source: "user", approved: true }).ok).toBe(false);
      expect(exceptionStatus(ex)).toBe("assessed");
      expect(exceptionsFor(state, { task: "T1" })).toEqual([]);
    },
  );
});
