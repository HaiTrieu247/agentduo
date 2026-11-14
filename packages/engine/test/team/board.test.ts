import { describe, expect, it } from "vitest";
import { boardJobs, chooseReviewer, heldByException, failureKey, madeProgress, newTask, planProblems, ready, type BoardContext } from "../../src/team/board.js";
import { TEAM_DEFAULTS, teamMembers, type TeamConfig } from "../../src/team/config.js";
import { assessException, deliverDecision, decideException, presentException, requestException, emptyGovernance, type RuleGovernance } from "../../src/team/rule-governance.js";
import type { Brief, TaskState } from "../../src/team/state.js";
import { brief as briefOutput, task } from "../helpers/team-builders.js";

const BRIEF: Brief = { version: 1, ...briefOutput(["Subtraction works", "It is documented"]) };
const members = teamMembers(TEAM_DEFAULTS);
const juniors: TeamConfig = {
  ...structuredClone(TEAM_DEFAULTS),
  members: [
    ...TEAM_DEFAULTS.members.slice(0, 2),
    { role: "dev", level: "junior", cli: "claude", count: 2 },
    { role: "qa", level: "mid", cli: "claude" },
  ],
};
const ctx = (over: Partial<BoardContext> = {}): BoardContext => ({ members, busy: new Set(), running: new Set(), gates: false, ...over });
const t = (id: string, over: Partial<TaskState> = {}): TaskState => ({ ...newTask(task(id, { criteria: ["AC1"] })), ...over });

describe("a plan", () => {
  it("is fine when its tasks name members, testers, criteria and dependencies that exist and serve every criterion", () => {
    const tasks = [task("T1", { criteria: ["AC1"] }), task("T2", { assignee: "dev-2", criteria: ["AC2"], depends_on: ["T1"] })];
    expect(planProblems(tasks, members, BRIEF)).toEqual([]);
  });

  it("says exactly what to correct", () => {
    const tasks = [
      task("T1", { assignee: "qa-1", testers: [], criteria: ["AC9"] }),
      task("T1", { testers: ["dev-2"], depends_on: ["T7"] }),
      task("bad id!", { depends_on: ["bad id!"] }),
    ];
    expect(planProblems(tasks, members, BRIEF)).toEqual(expect.arrayContaining([
      "task 'T1': the assignee 'qa-1' is not a member who takes tasks (dev-1, dev-2)",
      "task 'T1': name at least one tester (qa-1)",
      "task 'T1': 'AC9' is not an acceptance criterion of the brief (AC1, AC2)",
      "task 'T1': the id is used twice",
      "task 'T1': 'dev-2' is not a tester (qa-1)",
      "task 'T1' depends on 'T7', which is no task",
      "task 'bad id!': an id is letters, digits, '-' or '_' (at most 20), like T1",
      "task 'bad id!' depends on itself",
      "acceptance criterion AC2 is served by no task",
    ]));
  });

  it("finds a dependency cycle, and lets added tasks depend on earlier ones without reusing their ids", () => {
    const cycle = [task("T1", { depends_on: ["T2"] }), task("T2", { depends_on: ["T1"], criteria: ["AC2"] })];
    expect(planProblems(cycle, members, BRIEF)).toContain("the dependencies form a cycle: T1 -> T2 -> T1");
    const existing = [t("T1")];
    expect(planProblems([task("T9", { depends_on: ["T1"] })], members, BRIEF, existing, null)).toEqual([]);
    expect(planProblems([task("T1")], members, BRIEF, existing, null)).toEqual(["task 'T1': the id is already a task of this run; use a new one"]);
  });
});

describe("the reviewer of a task", () => {
  it("is the techlead for a member whose level can review", () => {
    expect(chooseReviewer(t("T1", { assignee: "dev-1" }), members, new Set())).toBe("techlead");
  });

  it("is a member whose level can review for one whose level cannot, and waits while that member is busy", () => {
    expect(chooseReviewer(t("T1", { assignee: "dev-2" }), members, new Set())).toBe("dev-1");
    expect(chooseReviewer(t("T1", { assignee: "dev-2" }), members, new Set(["dev-1"]))).toBeNull();
  });

  it("is the techlead when no worker can review", () => {
    expect(chooseReviewer(t("T1", { assignee: "dev-2" }), teamMembers(juniors), new Set())).toBe("techlead");
  });
});

describe("the board's jobs", () => {
  it("start a ready task's work and its tests, and wait for a dependency", () => {
    const tasks = [t("T1"), t("T2", { assignee: "dev-2", depends_on: ["T1"] })];
    expect(ready(tasks[1]!, tasks)).toBe(false);
    expect(boardJobs({ phase: "EXECUTION", tasks, integration: null, applyConflict: null }, ctx())).toEqual([{ kind: "work", member: "dev-1", task: "T1" }]);
    const coding = [t("T1", { status: "coding" }), tasks[1]!];
    expect(boardJobs({ phase: "EXECUTION", tasks: coding, integration: null, applyConflict: null }, ctx({ busy: new Set(["dev-1"]) }))).toEqual([{ kind: "tests", member: "qa-1", task: "T1" }]);
  });

  it("give a member one job at a time, and the techlead's first", () => {
    const tasks = [t("T1", { status: "triage" }), t("T2", { status: "review", assignee: "dev-1" }), t("T3", { status: "coding" })];
    const jobs = boardJobs({ phase: "EXECUTION", tasks, integration: null, applyConflict: null }, ctx());
    expect(jobs[0]).toEqual({ kind: "triage", member: "techlead", task: "T1" });
    expect(jobs.filter((j) => "member" in j && j.member === "techlead")).toHaveLength(1);
    expect(jobs).toContainEqual({ kind: "work", member: "dev-1", task: "T3" });
  });

  it("check a candidate with each tester and the gates, and merge one task at a time", () => {
    const tasks = [
      t("T1", { status: "testing", candidate: "c1", testers: ["qa-1"] }),
      t("T2", { status: "merging" }), t("T3", { status: "merging" }),
    ];
    const jobs = boardJobs({ phase: "EXECUTION", tasks, integration: null, applyConflict: null }, ctx({ gates: true }));
    expect(jobs).toEqual(expect.arrayContaining([{ kind: "check", member: "qa-1", task: "T1" }, { kind: "gates", task: "T1" }, { kind: "merge", task: "T2" }]));
    expect(jobs.filter((j) => j.kind === "merge")).toHaveLength(1);
    expect(boardJobs({ phase: "EXECUTION", tasks, integration: null, applyConflict: null }, ctx({ running: new Set(["merge:-:T2"]) })).some((j) => j.kind === "merge")).toBe(false);
  });

  it("answer a member's question, unless the techlead sent it on to the PM", () => {
    const question = { id: "q1", from: "dev-1", text: "Floats?", escalated: false, answer: null };
    const asked = [t("T1", { status: "blocked", question })];
    expect(boardJobs({ phase: "EXECUTION", tasks: asked, integration: null, applyConflict: null }, ctx())).toContainEqual({ kind: "answer", member: "techlead", task: "T1" });
    const escalated = [t("T1", { status: "blocked", question: { ...question, escalated: true } })];
    expect(boardJobs({ phase: "EXECUTION", tasks: escalated, integration: null, applyConflict: null }, ctx()).some((j) => j.kind === "answer")).toBe(false);
  });

  it("check the integration head with every tester once all tasks are merged", () => {
    const tasks = [t("T1", { status: "merged" })];
    const jobs = boardJobs({ phase: "INTEGRATION", tasks, integration: { commit: "c", checks: [], triage: false, trouble: null, triageGroups: [] }, applyConflict: null }, ctx({ gates: true }));
    expect(jobs).toEqual([{ kind: "integration_check", member: "qa-1" }, { kind: "gates", task: null }]);
  });
});

describe("work held by an exception request", () => {
  const board = (tasks: TaskState[], governance: RuleGovernance | undefined, phase: "EXECUTION" | "INTEGRATION" = "EXECUTION", c = ctx()) =>
    boardJobs({ phase, tasks, integration: null, applyConflict: null, governance }, c);
  const withGov = (tasks: TaskState[], steps: (g: { id: string; tasks: TaskState[]; governance: RuleGovernance }) => void) => {
    const s = { id: "run-1", tasks, governance: emptyGovernance() };
    steps(s);
    return s.governance;
  };
  const open = (s: { id: string; tasks: TaskState[]; governance: RuleGovernance }, taskId = "T1", from = "dev-1") =>
    (requestException(s, { from, ruleIds: ["R1"], reason: "x", work: { task: taskId } }) as { value: { id: string } }).value.id;
  const assessment = { by: "pm", ruleIds: ["R1"], reason: "x", alternative: "y", taskIds: ["T1"], unit: null, summary: "s" };

  it("start as before when the run has no governance state, or no request", () => {
    const tasks = [t("T1"), t("T2", { assignee: "dev-2" })];
    expect(board(tasks, undefined)).toEqual(board(tasks, emptyGovernance()));
    expect(board(tasks, undefined).filter((j) => j.kind === "work")).toEqual([{ kind: "work", member: "dev-1", task: "T1" }, { kind: "work", member: "dev-2", task: "T2" }]);
  });

  it("keep every job of the task back while the request is open, and leave the other tasks alone", () => {
    const tasks = [t("T1", { status: "testing", candidate: "c1" }), t("T2", { assignee: "dev-2" })];
    const gov = withGov(tasks, (s) => open(s, "T1"));
    const jobs = board(tasks, gov, "EXECUTION", ctx({ gates: true }));
    expect(jobs.filter((j) => "task" in j && j.task === "T1")).toEqual([]);
    expect(jobs).toContainEqual({ kind: "work", member: "dev-2", task: "T2" });
  });

  it.each(["pending", "coding", "review", "testing", "triage", "merging", "resolving"] as const)("keep a task in '%s' back", (status) => {
    const tasks = [t("T1", { status, candidate: "c1", question: null })];
    expect(board(tasks, emptyGovernance())).not.toEqual([]);
    const gov = withGov(tasks, (s) => open(s, "T1"));
    expect(board(tasks, gov)).toEqual([]);
  });

  it("keep holding through the PM's assessment, the user's pending request and a refusal until the member is told", () => {
    const tasks = [t("T1")];
    const steps: Array<[string, (s: { id: string; tasks: TaskState[]; governance: RuleGovernance }, id: string) => void, boolean]> = [
      ["assessed", (s, id) => assessException(s, id, assessment), true],
      ["pending", (s, id) => presentException(s, id, "REQ1"), true],
      ["rejected", (s) => decideException(s, { requestId: "REQ1", source: "user", approved: false }), true],
      ["told", (s, id) => deliverDecision(s, id), false],
    ];
    const s = { id: "run-1", tasks, governance: emptyGovernance() };
    const id = open(s);
    for (const [name, step, holds] of steps) {
      step(s, id);
      expect(board(tasks, s.governance).length === 0, name).toBe(holds);
    }
    expect(board(tasks, s.governance)).toEqual([{ kind: "work", member: "dev-1", task: "T1" }]);
  });

  it("let an approved exception release only its own task, once the member is told", () => {
    const tasks = [t("T1"), t("T2", { assignee: "dev-2" })];
    const s = { id: "run-1", tasks, governance: emptyGovernance() };
    const a = open(s, "T1");
    open(s, "T2", "dev-2");
    assessException(s, a, assessment);
    presentException(s, a, "REQ1");
    decideException(s, { requestId: "REQ1", source: "user", approved: true });
    expect(board(tasks, s.governance)).toEqual([]);
    deliverDecision(s, a);
    const jobs = board(tasks, s.governance);
    expect(jobs.filter((j) => "task" in j && j.task === "T1").length).toBeGreaterThan(0);
    expect(jobs.filter((j) => "task" in j && j.task === "T2")).toEqual([]);
  });

  it("keep a dependent task waiting through its dependency, and a held unit's jobs, while the PM's jobs are never held", () => {
    const tasks = [t("T1", { status: "pending" }), t("T2", { depends_on: ["T1"], assignee: "dev-2" })];
    const s = { id: "run-1", tasks, governance: emptyGovernance() };
    open(s, "T1");
    expect(board(tasks, s.governance)).toEqual([]);
    expect(heldByException({ kind: "pm" }, s)).toBe(false);
    expect(heldByException({ kind: "area_pm", member: "pm" }, s)).toBe(false);
    expect(heldByException({ kind: "work", member: "dev-1", task: "T1" }, s)).toBe(true);

    const merged = [t("T1", { status: "merged" })];
    const head = (commit: string) => ({ commit, checks: [], triage: false, trouble: null, triageGroups: [] });
    const unit = { id: "run-1", tasks: merged, integration: head("c1"), verifiedTree: "tree1", governance: emptyGovernance() };
    requestException(unit, { from: "dev-1", ruleIds: ["R1"], reason: "x", work: { unit: { kind: "integration", id: "run" } } });
    const integration = { phase: "INTEGRATION" as const, tasks: merged, integration: head("c1"), verifiedTree: "tree1", applyConflict: null, governance: unit.governance };
    expect(boardJobs(integration, ctx())).toEqual([]);
    expect(boardJobs({ ...integration, governance: emptyGovernance() }, ctx())).toEqual([{ kind: "integration_check", member: "qa-1" }]);
    expect(heldByException({ kind: "resolve_apply", member: "techlead" }, unit)).toBe(false);
    expect(heldByException({ kind: "gates", task: null }, unit)).toBe(true);
    // The result is replaced by another: the request was about the first, so the new head's jobs start.
    expect(boardJobs({ ...integration, integration: head("c2") }, ctx())).toEqual([{ kind: "integration_check", member: "qa-1" }]);
    expect(heldByException({ kind: "gates", task: null }, { ...unit, integration: head("c2") })).toBe(false);
  });

  it("hold the apply's conflict resolution for the tree it was asked about only", () => {
    const merged = [t("T1", { status: "merged" })];
    const unit = { id: "run-1", tasks: merged, integration: null, verifiedTree: "tree1", governance: emptyGovernance() };
    requestException(unit, { from: "dev-1", ruleIds: ["R1"], reason: "x", work: { unit: { kind: "apply", id: "run" } } });
    const conflict = { phase: "APPLY" as const, tasks: merged, integration: null, verifiedTree: "tree1", applyConflict: { ours: "o", tree: "tree1", files: ["a"], resolving: true }, governance: unit.governance };
    expect(boardJobs(conflict, ctx())).toEqual([]);
    expect(boardJobs({ ...conflict, verifiedTree: "tree2" }, ctx())).toEqual([{ kind: "resolve_apply", member: "techlead" }]);
  });
});

describe("progress of a fix round", () => {
  it("is a failure of the previous check gone; the same failures reworded is not", () => {
    const before = [failureKey({ title: "C1 fails!", suspect: "code" })];
    expect(madeProgress(before, [failureKey({ title: "c1 FAILS", suspect: "code" })])).toBe(false);
    expect(madeProgress(before, [failureKey({ title: "C2 fails", suspect: "code" })])).toBe(true);
    expect(madeProgress([], before)).toBe(true);
  });
});
