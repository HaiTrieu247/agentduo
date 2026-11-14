// A saved decision stays about the same occurrence; a replacement plan/result needs another user decision.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerDirection, askDirection, beginLesson, completeLesson, decideException, deliverDecision, exceptionGrant,
  governanceWork, issueOccurrence, planningUnit, recordIncident, repointRequest, requestException, resolveIncident,
  unitHeld, type ScopeUnitKind,
} from "../../src/team/rule-governance.js";
import { heldByException } from "../../src/team/board.js";
import { TeamStore, type TeamPlan } from "../../src/team/state.js";
import { governanceState, outcomeValue, pendingException } from "../helpers/governance-builders.js";
import { tempDir } from "../helpers/tmp.js";

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-14T10:00:00Z"));
  tmp = tempDir();
});
afterEach(() => {
  tmp.cleanup();
  vi.useRealTimers();
});

const plan = (group: string | null, version = 1): TeamPlan => ({
  group, version, briefVersion: 1, summary: "A replacement plan.", tasks: [], risks: [], declined: true,
});
const approve = (state: ReturnType<typeof governanceState>, requestId: string, exceptionId: string) => {
  outcomeValue(decideException(state, { requestId, source: "user", approved: true }));
  outcomeValue(deliverDecision(state, exceptionId));
};

describe("AC7–AC8: planning scope isolation across save and resume", () => {
  it.each(["run", "ungrouped", "frontend"])("keeps group '%s' distinct from an ungrouped team, including replacement plans", (group) => {
    const { state, store } = TeamStore.create(tmp.path, "Plan the work");
    state.approvedBrief = 1;
    const groupWork = { unit: planningUnit(group) };
    const ungroupedWork = { unit: planningUnit(null) };
    const grouped = pendingException(state, "group-proposal", groupWork);
    const ungrouped = pendingException(state, "ungrouped-proposal", ungroupedWork);
    approve(state, "group-proposal", grouped.id);
    approve(state, "ungrouped-proposal", ungrouped.id);
    store.save(state);

    const resumed = store.load();
    expect(exceptionGrant(resumed, groupWork, "R1")?.id).toBe(grouped.id);
    expect(exceptionGrant(resumed, ungroupedWork, "R1")?.id).toBe(ungrouped.id);
    resumed.plans.push(plan("unrelated"));
    expect(exceptionGrant(resumed, groupWork, "R1")?.id).toBe(grouped.id);
    resumed.plans.push(plan(group));
    expect(exceptionGrant(resumed, groupWork, "R1")).toBeNull();
    expect(exceptionGrant(resumed, ungroupedWork, "R1")?.id).toBe(ungrouped.id);
    // Replaying the old approval does not transfer it to the replacement plan.
    outcomeValue(decideException(resumed, { requestId: "group-proposal", source: "user", approved: true }));
    expect(exceptionGrant(resumed, groupWork, "R1")).toBeNull();
    const replacement = pendingException(resumed, "replacement-proposal", groupWork);
    expect(replacement.id).not.toBe(grouped.id);
    expect(unitHeld(resumed, groupWork.unit)).toBe(true);
    expect(exceptionGrant(resumed, groupWork, "R1")).toBeNull();
    approve(resumed, "replacement-proposal", replacement.id);
    expect(exceptionGrant(resumed, groupWork, "R1")?.id).toBe(replacement.id);
    resumed.plans.push(plan(null));
    expect(exceptionGrant(resumed, ungroupedWork, "R1")).toBeNull();
    expect(exceptionGrant(resumed, groupWork, "R1")?.id).toBe(replacement.id);
    store.save(resumed);
    expect(exceptionGrant(store.load(), groupWork, "R1")?.id).toBe(replacement.id);
  });
});

describe("AC7–AC8: an old non-task request cannot grant a replacement result", () => {
  it.each<ScopeUnitKind>(["integration", "apply", "acceptance"])("keeps a pending %s decision tied to its saved occurrence", (kind) => {
    const { state, store } = TeamStore.create(tmp.path, "Check the result");
    state.integration = { commit: "commit-1", checks: [], triage: false, trouble: null, triageGroups: [] };
    state.verifiedTree = "tree-1";
    const work = { unit: { kind, id: "run" } };
    const old = pendingException(state, "old-proposal", work);
    store.save(state);
    const resumed = store.load();
    expect(unitHeld(resumed, work.unit)).toBe(true);
    if (kind === "apply") resumed.verifiedTree = "tree-2";
    else resumed.integration!.commit = "commit-2";
    expect(unitHeld(resumed, work.unit)).toBe(false);
    approve(resumed, "old-proposal", old.id);
    expect(exceptionGrant(resumed, work, "R1")).toBeNull();
    const replacement = pendingException(resumed, "new-proposal", work);
    expect(replacement.requested.unit?.occurrence).not.toBe(old.requested.unit?.occurrence);
    expect(unitHeld(resumed, work.unit)).toBe(true);
    expect(exceptionGrant(resumed, work, "R1")).toBeNull();
    approve(resumed, "new-proposal", replacement.id);
    store.save(resumed);
    expect(exceptionGrant(store.load(), work, "R1")?.id).toBe(replacement.id);
  });
});

describe("AC3 and AC6–AC8: persisted incident identities and directions", () => {
  it("keeps a new incident distinct from the same member's earlier resolved incident on the same task", () => {
    const { state, store } = TeamStore.create(tmp.path, "Fix the units");
    state.tasks = governanceState().tasks;
    const report = (call: string) => ({
      kind: "deviation" as const, reportedBy: "qa-1", summary: "The units differ from the requirement.",
      source: { kind: "member_report" as const, member: "qa-1", task: "T1", occurrence: issueOccurrence(call, 0) },
    });
    const first = outcomeValue(recordIncident(state, report("call-1")));
    outcomeValue(resolveIncident(state, first.id, "Corrected the units."));
    outcomeValue(beginLesson(state, first.id, "State units explicitly."));
    outcomeValue(completeLesson(state, first.id, "R1"));
    store.save(state);
    const resumed = store.load();
    expect(recordIncident(resumed, report("call-1"))).toMatchObject({ ok: true, changed: false });
    const second = outcomeValue(recordIncident(resumed, report("call-2")));
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("reported");
    outcomeValue(resolveIncident(resumed, second.id, "Corrected a separate mistake."));
    expect(governanceWork(resumed).lessons.map((i) => i.id)).toEqual([second.id]);
    expect(resumed.governance.incidents[0]).toEqual(first);
  });

  it("restores a pending incident question and holds the work until the replacement request is answered", () => {
    const { state, store } = TeamStore.create(tmp.path, "Resolve the disagreement");
    state.tasks = governanceState().tasks;
    const incident = outcomeValue(recordIncident(state, {
      kind: "disagreement", reportedBy: "qa-1", summary: "The requirement is ambiguous.",
      source: { kind: "member_report", member: "qa-1", task: "T1", occurrence: issueOccurrence("call-1", 0) },
    }));
    outcomeValue(askDirection(state, { incidentId: incident.id }, "before-pause"));
    store.save(state);
    const resumed = store.load();
    expect(heldByException({ kind: "work", member: "dev-1", task: "T1" }, resumed)).toBe(true);
    expect(heldByException({ kind: "work", member: "dev-2", task: "T2" }, resumed)).toBe(false);
    expect(heldByException({ kind: "pm" }, resumed)).toBe(false);
    outcomeValue(repointRequest(resumed, "before-pause", "after-resume"));
    expect(answerDirection(resumed, "before-pause", "Approved").ok).toBe(false);
    expect(heldByException({ kind: "work", member: "dev-1", task: "T1" }, resumed)).toBe(true);
    outcomeValue(answerDirection(resumed, "after-resume", "Use milliseconds."));
    expect(heldByException({ kind: "work", member: "dev-1", task: "T1" }, resumed)).toBe(false);
    expect(exceptionGrant(resumed, { task: "T1" }, "R1")).toBeNull();
  });
});
