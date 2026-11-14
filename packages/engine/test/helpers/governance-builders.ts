// Shared fixtures for the acceptance tests of team rules. Scope ids are work identities, never permission text.
import { expect } from "vitest";
import { newTask } from "../../src/team/board.js";
import {
  assessException, presentException, requestException,
  type GovernedState, type Outcome, type RuleException, type WorkRef,
} from "../../src/team/rule-governance.js";
import { newTeamState } from "../../src/team/state.js";
import { task } from "./team-builders.js";

export const RULE_IDS = new Set(["R1", "R2"]);

export function outcomeValue<T>(result: Outcome<T>): T {
  expect(result.ok, result.ok ? undefined : result.reason).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

export function governanceState() {
  const state = newTeamState("run-one", "Implement subtraction");
  state.phase = "EXECUTION";
  state.tasks = [newTask(task("T1")), newTask(task("T2", { assignee: "dev-2" }))];
  return state;
}

export function requestedException(state: GovernedState, work: WorkRef = { task: "T1" }): RuleException {
  return outcomeValue(requestException(state, {
    from: "dev-1", ruleIds: ["R1"], reason: "The supported runtime lacks this API.",
    alternative: "Use the compatible API for this work only.", work, known: RULE_IDS,
  }));
}

export function assessedException(state: GovernedState, work: WorkRef = { task: "T1" }): RuleException {
  const ex = requestedException(state, work);
  return outcomeValue(assessException(state, ex.id, {
    by: "pm", ruleIds: ["R1"], reason: ex.reason, alternative: "Use the compatible API.",
    taskIds: [...ex.requested.taskIds], unit: ex.requested.unit,
    summary: "Depart from R1 only for the identified work, to support the required runtime.", known: RULE_IDS,
  }));
}

export function pendingException(state: GovernedState, requestId = "exception-request-1", work: WorkRef = { task: "T1" }): RuleException {
  const ex = assessedException(state, work);
  return outcomeValue(presentException(state, ex.id, requestId));
}
