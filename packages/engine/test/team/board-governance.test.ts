import { describe, expect, it } from "vitest";
import { boardJobs, heldByException, newTask, type BoardContext } from "../../src/team/board.js";
import { TEAM_DEFAULTS, teamMembers } from "../../src/team/config.js";
import {
  answerDirection, askDirection, decideException, deliverDecision, exceptionGrant, governanceWork, type WorkRef,
} from "../../src/team/rule-governance.js";
import type { TaskStatus } from "../../src/team/state.js";
import { governanceState, outcomeValue, pendingException, requestedException } from "../helpers/governance-builders.js";
import { task } from "../helpers/team-builders.js";

const context = (over: Partial<BoardContext> = {}): BoardContext => ({
  members: teamMembers(TEAM_DEFAULTS), busy: new Set(), running: new Set(), gates: true, ...over,
});

describe("AC5–AC7: the task board while an exception is undecided", () => {
  it.each<TaskStatus>(["pending", "coding", "review", "testing", "triage", "merging", "resolving", "blocked"])(
    "holds every T1 job in %s while unrelated T2 can proceed", (status) => {
      const state = governanceState();
      Object.assign(state.tasks[0]!, {
        status, candidate: "candidate-1",
        question: { id: "q1", from: "dev-1", text: "Can we depart from R1?", escalated: false, answer: null },
      });
      pendingException(state);
      const jobs = boardJobs(state, context());
      expect(jobs.filter((job) => "task" in job && job.task === "T1")).toEqual([]);
      expect(jobs).toContainEqual({ kind: "work", member: "dev-2", task: "T2" });
    },
  );

  it("holds work as soon as the member requests an exception, leaving the PM's assessment owed", () => {
    const state = governanceState();
    const ex = requestedException(state);
    expect(boardJobs(state, context()).some((job) => "task" in job && job.task === "T1")).toBe(false);
    expect(governanceWork(state).assess.map((e) => e.id)).toEqual([ex.id]);
    expect(heldByException({ kind: "pm" }, state)).toBe(false);
    expect(heldByException({ kind: "area_pm", member: "group-pm" }, state)).toBe(false);
  });

  it("keeps dependent tasks waiting and does not treat a held task as completed", () => {
    const state = governanceState();
    state.tasks.push(newTask(task("T3", { assignee: "dev-1", depends_on: ["T1"] })));
    pendingException(state);
    const jobs = boardJobs(state, context());
    expect(jobs.some((job) => "task" in job && (job.task === "T1" || job.task === "T3"))).toBe(false);
    expect(state.tasks[0]!.status).toBe("pending");
    expect(state.tasks[2]!.status).toBe("pending");
  });

  it("keeps work waiting for the user's direction, and a direction answer does not release it", () => {
    const state = governanceState();
    const ex = requestedException(state);
    outcomeValue(askDirection(state, { exceptionId: ex.id }, "direction-1"));
    expect(boardJobs(state, context()).some((job) => "task" in job && job.task === "T1")).toBe(false);
    expect(governanceWork(state).questions).toHaveLength(1);
    expect(heldByException({ kind: "pm" }, state)).toBe(false);
    outcomeValue(answerDirection(state, "direction-1", "Consider the compatible API."));
    expect(governanceWork(state).questions).toEqual([]);
    expect(boardJobs(state, context()).some((job) => "task" in job && job.task === "T1")).toBe(false);
  });

  it.each([true, false])("waits for a decision to be delivered after user approval=%s", (approved) => {
    const state = governanceState();
    const ex = pendingException(state);
    outcomeValue(decideException(state, { requestId: "exception-request-1", source: "user", approved }));
    expect(boardJobs(state, context()).some((job) => "task" in job && job.task === "T1")).toBe(false);
    expect(governanceWork(state).undelivered.map((e) => e.id)).toEqual([ex.id]);
    outcomeValue(deliverDecision(state, ex.id));
    expect(boardJobs(state, context())).toContainEqual({ kind: "work", member: "dev-1", task: "T1" });
    expect(exceptionGrant(state, { task: "T1" }, "R1")?.id ?? null).toBe(approved ? ex.id : null);
    // Rejection releases only work done under the original rules, never a permission to depart from them.
  });

  it("releasing an approved task does not release another task with its own pending exception", () => {
    const state = governanceState();
    const first = pendingException(state);
    pendingException(state, "exception-request-2", { task: "T2" });
    outcomeValue(decideException(state, { requestId: "exception-request-1", source: "user", approved: true }));
    outcomeValue(deliverDecision(state, first.id));
    const jobs = boardJobs(state, context());
    expect(jobs).toContainEqual({ kind: "work", member: "dev-1", task: "T1" });
    expect(jobs.some((job) => "task" in job && job.task === "T2")).toBe(false);
    expect(exceptionGrant(state, { task: "T2" }, "R1")).toBeNull();
  });

  it("keeps the usual busy-member and running-job exclusions when approval releases work", () => {
    const state = governanceState();
    const ex = pendingException(state);
    outcomeValue(decideException(state, { requestId: "exception-request-1", source: "user", approved: true }));
    outcomeValue(deliverDecision(state, ex.id));
    for (const ctx of [context({ busy: new Set(["dev-1"]) }), context({ running: new Set(["work:dev-1:T1"]) })]) {
      expect(boardJobs(state, ctx)).not.toContainEqual({ kind: "work", member: "dev-1", task: "T1" });
    }
  });
});

describe("AC5–AC8: waits for an identified unit outside a task", () => {
  it("holds integration checks and gates while PM can still process the request", () => {
    const state = governanceState();
    state.phase = "INTEGRATION";
    state.tasks.forEach((t) => { t.status = "merged"; });
    state.integration = { commit: "integration-1", checks: [], triage: false, trouble: null, triageGroups: [] };
    const work: WorkRef = { unit: { kind: "integration", id: "run" } };
    pendingException(state, "integration-exception", work);
    expect(boardJobs(state, context())).toEqual([]);
    expect(heldByException({ kind: "pm" }, state)).toBe(false);
    outcomeValue(decideException(state, { requestId: "integration-exception", source: "user", approved: true }));
    expect(boardJobs(state, context())).toEqual([]);
    outcomeValue(deliverDecision(state, state.governance.exceptions[0]!.id));
    expect(boardJobs(state, context())).toEqual(expect.arrayContaining([
      { kind: "integration_check", member: "qa-1" }, { kind: "gates", task: null },
    ]));
    expect(exceptionGrant(state, { task: "T1" }, "R1")).toBeNull();
  });

  it("holds apply conflict resolution while the matching unit awaits a decision", () => {
    const state = governanceState();
    state.phase = "APPLY";
    state.verifiedTree = "verified-tree";
    state.applyConflict = { ours: "before-apply", tree: "verified-tree", files: ["src/t1.ts"], resolving: true };
    pendingException(state, "apply-exception", { unit: { kind: "apply", id: "run" } });
    expect(boardJobs(state, context())).toEqual([]);
    expect(heldByException({ kind: "pm" }, state)).toBe(false);
  });
});
