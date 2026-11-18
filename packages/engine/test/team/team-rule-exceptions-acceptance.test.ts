// T5: an exception request is a stop before the ordinary result, not a completed task/check/plan.
// Fake CLIs and real worktrees exercise the PM → user → member round trip and its saved state.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClarificationRequest, ClarificationResponse } from "../../src/clarification/clarification.js";
import { ClarificationBroker, type AnswerOutcome } from "../../src/clarification/broker.js";
import { EventBus, type ClarificationDecider, type DuoEvent } from "../../src/events.js";
import type { TeamMemberEntry } from "../../src/team/config.js";
import { TeamRules, teamRulesDir } from "../../src/team/rules.js";
import { TeamStore, type TeamState } from "../../src/team/state.js";
import { TeamRun } from "../../src/team/team.js";
import { testConfig, userDataEnv } from "../helpers/config.js";
import { FakeClis } from "../helpers/fake-clis.js";
import { makeRepo } from "../helpers/repo.js";
import { rulesInForce, sessionHeld } from "../helpers/session-held.js";
import { askException, brief, task, teamAnswer, teamCheck, teamPlan, teamPm, teamReview, teamTests, teamTriage, teamWork } from "../helpers/team-builders.js";
import { tempDir } from "../helpers/tmp.js";

let tmp: ReturnType<typeof tempDir>;
let fake: FakeClis;
let repo: string;
let bus: EventBus;
let events: DuoEvent[];
let originalRules: string;

const RULE = "Use integers for every calculation.";
const REASON = "This task imports measurements with fractional precision.";
const ALTERNATIVE = "Keep decimal precision in the measurement import.";
const SUMMARY = "Depart from R1 for the measurement import in T1 only; keep decimal precision because the input contains fractions.";
const exception = () => askException(["R1"], REASON, ALTERNATIVE);
const runsDir = () => join(repo, ".agentduo", "runs");
const env = () => ({ ...process.env, ...userDataEnv(join(tmp.path, "data")) });
const rules = () => new TeamRules(teamRulesDir(env(), repo, "default"));
const store = () => TeamStore.open(runsDir(), "latest");
const saved = () => store().load();

beforeEach(() => {
  tmp = tempDir();
  fake = new FakeClis(tmp.path).install();
  repo = makeRepo(tmp.path);
  bus = new EventBus();
  events = [];
  bus.on((e) => events.push(e));
  rules().append({ opId: "seed:R1", text: RULE, incident: "a prior run" });
  originalRules = readFileSync(rules().path, "utf8");
});
afterEach(() => {
  fake.restore();
  tmp.cleanup();
});

type Scenario = Record<string, unknown[]>;
function proposal(id = "X1", taskIds = ["T1"], unit: { kind: "planning" | "integration" | "apply" | "acceptance"; id: string } | null = null) {
  const output = teamPm.exceptionProposal(id, { taskIds, unit });
  return { ...output, action: { ...output.action, reason: REASON, alternative: ALTERNATIVE, summary: SUMMARY } };
}

const happy = (over: Scenario = {}): Scenario => ({
  team_pm_conversation: [{ output: teamPm.brief(brief()) }],
  team_plan: [{ output: teamPlan([task("T1", { area: ["app.txt"] })]) }],
  team_pm_plan_review: [{ output: teamPm.planReview(true) }],
  team_pm_reports: [{ output: teamPm.none() }],
  team_pm_acceptance: [{ output: teamPm.acceptance() }],
  team_pm_rule_lesson: [{ output: teamPm.ruleLesson("I1", null, "The existing rule already covers this correction.") }],
  team_pm_rule_exception: [{ output: proposal() }],
  "team_work:dev-1": [{ output: teamWork(), write: { "app.txt": "complete\n" } }],
  "team_work:dev-2": [{ output: teamWork(), write: { "other.txt": "independent\n" } }],
  team_tests: [{ output: teamTests(), write: { "test/qa.txt": "checked\n" } }],
  team_review: [{ output: teamReview() }],
  team_check: [{ output: teamCheck() }],
  ...over,
});
const workerRequest = (over: Scenario = {}) => happy({
  "team_work:dev-1": [{ output: teamWork("done", null, exception()) }, { output: teamWork(), write: { "app.txt": "complete\n" } }],
  ...over,
});

function create(decider: ClarificationDecider, members?: TeamMemberEntry[]) {
  const cfg = testConfig(fake, { gates: [] });
  if (members) cfg.team.members = members;
  return TeamRun.create({ runsDir: runsDir(), request: "Import measurements", cfg, workspace: repo, bus, decider, env: env(), reportIntervalMs: 0 });
}
function reopen(decider?: ClarificationDecider) {
  return TeamRun.resume({ runsDir: runsDir(), id: "latest", workspace: repo, bus, decider, env: env(), reportIntervalMs: 0 });
}

function choose(request: ClarificationRequest, option: string): ClarificationResponse {
  return { kind: "answered", answers: request.questions.map((q) => ({ questionId: q.id, optionIds: [option], otherText: null })) };
}
function first(request: ClarificationRequest): ClarificationResponse {
  return { kind: "answered", answers: request.questions.map((q) => ({ questionId: q.id, optionIds: [q.options[0]!.id], otherText: null })) };
}
const isDecision = (request: ClarificationRequest) => request.questions.some((q) => q.options.some((o) => o.id === "reject"));
type Observation = { request: ClarificationRequest; state: TeamState; callCount: number };
function decisions(reply: (request: ClarificationRequest) => ClarificationResponse | Promise<ClarificationResponse> = () => ({ kind: "defer" })) {
  const observed: Observation[] = [];
  const asked: ClarificationRequest[] = [];
  const decider: ClarificationDecider = {
    askClarification: async ({ request }) => {
      asked.push(request);
      if (!isDecision(request)) return first(request);
      // Capture, then assert outside the callback: a thrown assertion here is a decider failure, not a test failure.
      observed.push({ request, state: saved(), callCount: fake.calls().length });
      return reply(request);
    },
  };
  return { decider, observed, asked };
}

function expectHeld(state: TeamState, taskId = "T1") {
  expect(state.governance.exceptions).toHaveLength(1);
  expect(state.governance.exceptions[0]).toMatchObject({
    ruleIds: ["R1"], requested: { runId: state.id, taskIds: [taskId], unit: null },
    decision: { status: "pending", by: null, delivered: false },
  });
  expect(state.tasks.find((t) => t.id === taskId)!.status).not.toBe("merged");
  expect(state.applied).toBeNull();
  expect(readFileSync(rules().path, "utf8")).toBe(originalRules);
  expect(existsSync(join(repo, "app.txt"))).toBe(false);
}

describe("exception requests from every kind of member result (AC4, AC5, AC7)", () => {
  it("keeps ordinary work running without asking for an exception or changing the team's rules", async () => {
    fake.setScenario(happy());
    const d = decisions();
    expect(await create(d.decider).run()).toBe("done");
    expect(d.observed).toEqual([]);
    expect(saved().governance.exceptions).toEqual([]);
    expect(readFileSync(join(repo, "app.txt"), "utf8")).toBe("complete\n");
    expect(readFileSync(rules().path, "utf8")).toBe(originalRules);
  });

  const paths: Array<{
    name: string; member: string; role: string; over: Scenario;
    unit?: { kind: "planning" | "integration"; id: string };
    ordinaryNotUsed(state: TeamState): void;
  }> = [
    {
      name: "worker done", member: "dev-1", role: "team_work", over: {
        "team_work:dev-1": [{ output: teamWork("done", null, exception()) }, { output: teamWork(), write: { "app.txt": "complete\n" } }],
      }, ordinaryNotUsed: (s) => expect(s.tasks[0]!.code).toBeNull(),
    },
    {
      name: "checker writing tests", member: "qa-1", role: "team_tests", over: {
        team_tests: [{ output: teamTests(exception()) }, { output: teamTests(), write: { "test/qa.txt": "checked\n" } }],
      }, ordinaryNotUsed: (s) => expect(s.tasks[0]!.tests["qa-1"]!.status).not.toBe("written"),
    },
    {
      name: "lead approving a review", member: "techlead", role: "team_review", over: {
        team_review: [{ output: teamReview("approve", exception()) }, { output: teamReview() }],
      }, ordinaryNotUsed: (s) => expect(s.tasks[0]!.review).toBeNull(),
    },
    {
      name: "checker passing a candidate", member: "qa-1", role: "team_check", over: {
        team_check: [{ output: teamCheck("pass", "code", exception()) }, { output: teamCheck() }],
      }, ordinaryNotUsed: (s) => expect(s.tasks[0]!.checks.filter((c) => c.by === "qa-1")).toEqual([]),
    },
    {
      name: "lead returning a plan", member: "techlead", role: "team_plan", unit: { kind: "planning", id: "ungrouped" }, over: {
        team_plan: [{ output: teamPlan([task("T1")], exception()) }, { output: teamPlan([task("T1")]) }],
        team_pm_rule_exception: [{ output: proposal("X1", [], { kind: "planning", id: "ungrouped" }) }],
      }, ordinaryNotUsed: (s) => { expect(s.plans).toEqual([]); expect(s.tasks).toEqual([]); },
    },
    {
      name: "lead answering a blocked worker", member: "techlead", role: "team_answer", over: {
        "team_work:dev-1": [{ output: teamWork("blocked") }, { output: teamWork(), write: { "app.txt": "complete\n" } }],
        team_answer: [{ output: teamAnswer("Use decimals.", null, exception()) }, { output: teamAnswer("Use decimals.") }],
      }, ordinaryNotUsed: (s) => expect(s.tasks[0]!.question!.answer).toBeNull(),
    },
    {
      name: "lead retrying a failed task", member: "techlead", role: "team_triage", over: {
        team_check: [{ output: teamCheck("fail") }, { output: teamCheck() }],
        team_triage: [{ output: teamTriage("retry", { governance: exception() }) }, { output: teamTriage("retry") }],
      }, ordinaryNotUsed: (s) => expect(s.tasks[0]!.attempt).toBe(1),
    },
    {
      name: "checker passing the whole result", member: "qa-1", role: "team_check", unit: { kind: "integration", id: "run" }, over: {
        team_check: [{ output: teamCheck() }, { output: teamCheck("pass", "code", exception()) }, { output: teamCheck() }],
        team_pm_rule_exception: [{ output: proposal("X1", [], { kind: "integration", id: "run" }) }],
      }, ordinaryNotUsed: (s) => {
        expect(s.integration!.checks.filter((c) => c.by === "qa-1")).toEqual([]);
        expect(s.verifiedTree).toBeNull(); expect(s.accepted).toBe(false);
      },
    },
    {
      name: "lead adding integration repairs", member: "techlead", role: "team_triage", unit: { kind: "integration", id: "run" }, over: {
        team_check: [{ output: teamCheck() }, { output: teamCheck("fail") }, { output: teamCheck() }],
        team_triage: [
          { output: teamTriage("add_tasks", { tasks: [task("T9", { assignee: "dev-2", area: ["other.txt"] })], governance: exception() }) },
          { output: teamTriage("add_tasks", { tasks: [task("T9", { assignee: "dev-2", area: ["other.txt"] })] }) },
        ],
        team_pm_rule_exception: [{ output: proposal("X1", [], { kind: "integration", id: "run" }) }],
      }, ordinaryNotUsed: (s) => { expect(s.tasks.map((t) => t.id)).toEqual(["T1"]); expect(s.integration!.triage).toBe(true); },
    },
  ];

  it.each(paths)("holds $name before consuming its ordinary result, then calls it again with the user's approval", async (path) => {
    fake.setScenario(happy(path.over));
    const d = decisions();
    expect(await create(d.decider).run()).toBe("waiting");
    const state = saved();
    expect(state.governance.exceptions).toHaveLength(1);
    const ex = state.governance.exceptions[0]!;
    expect(ex).toMatchObject({ from: path.member, ruleIds: ["R1"], reason: REASON, alternative: ALTERNATIVE, decision: { status: "pending", by: null } });
    if (path.unit) expect(ex.requested).toMatchObject({ taskIds: [], unit: path.unit });
    else expectHeld(state);
    path.ordinaryNotUsed(state);
    expect(state.applied).toBeNull();
    expect(d.observed).toHaveLength(1);
    expect(fake.calls(path.role).filter((c) => c.member === path.member).length).toBeGreaterThan(0);
    const before = fake.calls().length;
    const approve = decisions((r) => choose(r, "approve"));
    expect(await reopen(approve.decider).run()).toBe("done");
    const retry = fake.calls().slice(before).find((c) => c.role === path.role && c.member === path.member);
    expect(retry).toBeDefined();
    expect(retry!.prompt).toContain("approved by the user");
    expect(saved().governance.exceptions).toHaveLength(1);
    expect(saved().governance.exceptions[0]!.decision).toMatchObject({ status: "approved", by: "user", delivered: true });
    expect(readFileSync(rules().path, "utf8")).toBe(originalRules);
  });
});

describe("what the PM shows and what the user actually decides (AC5–AC8)", () => {
  it("saves the request and complete PM assessment before asking, and the decision before another member works", async () => {
    fake.setScenario(workerRequest());
    const d = decisions((r) => choose(r, "approve"));
    const resumedStates: TeamState[] = [];
    let workerCalls = 0;
    bus.on((e) => {
      if (e.type === "team.member" && e.member === "dev-1" && e.job === "work" && e.state === "busy" && ++workerCalls > 1) resumedStates.push(saved());
    });
    expect(await create(d.decider).run()).toBe("done");
    expect(d.observed).toHaveLength(1);
    const { request, state } = d.observed[0]!;
    expect(request).toMatchObject({ source: "team", teamRunId: state.id, member: "pm" });
    const q = request.questions[0]!;
    expect(q.multiSelect).toBe(false);
    expect(q.options.map((o) => o.id).sort()).toEqual(["approve", "reject"]);
    const shown = JSON.stringify(request.questions);
    for (const text of ["R1", RULE, REASON, ALTERNATIVE, "T1"]) expect(shown).toContain(text);
    expect(state.governance.exceptions[0]).toMatchObject({ assessment: { by: "pm", reason: REASON, alternative: ALTERNATIVE, scope: { runId: state.id, taskIds: ["T1"], unit: null } }, decision: { status: "pending", requestId: request.id } });
    expect(state.clarifications.find((e) => e.id === request.id)).toMatchObject({ status: "pending", callId: request.callId });
    expect(state.tasks[0]!.code).toBeNull();
    expect(resumedStates).toHaveLength(1);
    expect(resumedStates[0]!.governance.exceptions[0]!.decision).toMatchObject({ status: "approved", by: "user" });
    expect(resumedStates[0]!.clarifications.find((e) => e.id === request.id)!.status).toBe("answered");
    expect(events.filter((e) => e.type === "team.message" && e.from !== "user").every((e) => e.type === "team.message" && e.from === "pm")).toBe(true);
  });

  it.each(["reject", "pm-decline"])("%s resumes under the original rule, preserving it and never supplying approval", async (mode) => {
    fake.setScenario(workerRequest(mode === "pm-decline" ? { team_pm_rule_exception: [{ output: teamPm.exceptionDecline("X1") }] } : {}));
    const d = decisions((r) => choose(r, "reject"));
    expect(await create(d.decider).run()).toBe("done");
    const ex = saved().governance.exceptions[0];
    expect(ex).toMatchObject({ decision: { status: "rejected", by: mode === "reject" ? "user" : "pm", delivered: true } });
    expect(d.observed).toHaveLength(mode === "reject" ? 1 : 0);
    const all = fake.calls();
    const held = sessionHeld(all);
    const worker = all.flatMap((c, i) => (c.role === "team_work" && c.member === "dev-1" ? [{ c, held: held[i]! }] : []));
    expect(worker).toHaveLength(2);
    expect(worker[1]!.c.prompt).toContain("refused");
    // The rule stands: the session holds it as written, and the turn that goes on is told it is in force.
    expect(worker[1]!.held).toContain(RULE);
    expect(rulesInForce(worker[1]!.c.prompt)).toContain("R1");
    expect(worker[1]!.c.prompt).not.toContain("approved by the user for");
    expect(readFileSync(rules().path, "utf8")).toBe(originalRules);
  });

  it.each(["free text", "foreign option", "both options", "wrong question", "duplicate answer"])("%s is never a specific exception approval", async (mode) => {
    fake.setScenario(workerRequest());
    let replies = 0;
    const d = decisions((r) => {
      if (replies++ > 0) return { kind: "defer" };
      const answer = { questionId: r.questions[0]!.id, optionIds: ["approve"], otherText: null as string | null };
      if (mode === "free text") { answer.optionIds = []; answer.otherText = "Yes, go ahead."; }
      if (mode === "foreign option") answer.optionIds = ["q1o1"];
      if (mode === "both options") answer.optionIds = ["approve", "reject"];
      if (mode === "wrong question") answer.questionId = "another-request-question";
      return { kind: "answered", answers: mode === "duplicate answer" ? [answer, answer] : [answer] };
    });
    expect(await create(d.decider).run()).toBe("waiting");
    expectHeld(saved());
    expect(fake.calls("team_work").filter((c) => c.member === "dev-1")).toHaveLength(1);
    expect(d.observed.length).toBeGreaterThan(0);
  });

  it("an answer about how to treat a rule informs the PM, then a separate scoped approval is still owed", async () => {
    fake.setScenario(workerRequest({ team_pm_rule_exception: [
      { output: teamPm.ruleQuestion({ exceptionId: "X1" }) }, { output: proposal() },
    ] }));
    const d = decisions();
    expect(await create(d.decider).run()).toBe("waiting");
    expectHeld(saved());
    const direction = saved().governance.exceptions[0]!.direction!;
    expect(direction.answer).toBeTruthy();
    expect(direction.requestId).not.toBe(saved().governance.exceptions[0]!.decision!.requestId);
    expect(saved().clarifications.find((e) => e.id === direction.requestId)!.status).toBe("answered");
    expect(d.observed).toHaveLength(1);
    expect(fake.calls("team_pm_rule_exception")).toHaveLength(2);
    expect(fake.calls("team_work").filter((c) => c.member === "dev-1")).toHaveLength(1);
  });

  it("an unanswered PM direction question holds its task across reopening", async () => {
    fake.setScenario(workerRequest({ team_pm_rule_exception: [{ output: teamPm.ruleQuestion({ exceptionId: "X1" }) }, { output: proposal() }] }));
    const asked: ClarificationRequest[] = [];
    const d: ClarificationDecider = { askClarification: async ({ request }) => {
      asked.push(request);
      return request.questions[0]!.header === "Rule" ? { kind: "defer" } : first(request);
    } };
    expect(await create(d).run()).toBe("waiting");
    const state = saved();
    expect(state.governance.exceptions).toHaveLength(1);
    expect(state.governance.exceptions[0]).toMatchObject({ direction: { answer: null }, decision: null });
    expect(state.tasks[0]!.code).toBeNull();
    const questionId = state.governance.exceptions[0]!.direction!.requestId;
    const again = decisions();
    expect(await reopen(again.decider).run()).toBe("waiting");
    expect(again.asked.some((r) => r.id === questionId)).toBe(true);
    expectHeld(saved());
    expect(saved().governance.exceptions[0]!.direction!.answer).toBeTruthy();
    expect(fake.calls("team_work").filter((c) => c.member === "dev-1")).toHaveLength(1);
  });
});

describe("pending work and decision recovery (AC7, AC8)", () => {
  it.each(["defer", "closed app", "cancelled"])("%s keeps the exact request pending, including when reopened without a decider", async (mode) => {
    fake.setScenario(workerRequest());
    const d = decisions(() => mode === "closed app" ? Promise.reject(new Error("view closed")) : { kind: mode === "cancelled" ? "cancelled" : "defer" });
    expect(await create(d.decider).run()).toBe("waiting");
    expectHeld(saved());
    const pending = structuredClone(saved().governance.exceptions[0]!);
    const count = fake.calls().length;
    expect(await reopen().run()).toBe("waiting");
    expect(fake.calls()).toHaveLength(count);
    expectHeld(saved());
    expect(saved().governance.exceptions[0]).toEqual(pending);
    const again = decisions((r) => choose(r, "approve"));
    expect(await reopen(again.decider).run()).toBe("done");
    expect(again.observed).toHaveLength(1);
    expect(again.observed[0]!.request.id).toBe(pending.decision!.requestId);
    expect(again.observed[0]!.state.governance.exceptions[0]!.assessment).toEqual(pending.assessment);
    expect(saved().governance.exceptions).toHaveLength(1);
    expect(readFileSync(rules().path, "utf8")).toBe(originalRules);
  });

  it("stop and resume preserves pending, and a saved approval is not asked for again", async () => {
    fake.setScenario(workerRequest());
    let run: TeamRun;
    const d = decisions(() => { run.stop(); return { kind: "defer" }; });
    run = create(d.decider);
    expect(await run.run()).toBe("stopped");
    expectHeld(saved());
    const requestId = saved().governance.exceptions[0]!.decision!.requestId;
    let resumed: TeamRun;
    const approve = decisions((r) => { resumed.stop(); return choose(r, "approve"); });
    resumed = reopen(approve.decider);
    expect(await resumed.run()).toBe("stopped");
    expect(saved().governance.exceptions[0]!.decision).toMatchObject({ status: "approved", requestId, by: "user" });
    const final = decisions();
    expect(await reopen(final.decider).run()).toBe("done");
    expect(final.observed).toEqual([]);
    expect(fake.calls("team_pm_rule_exception")).toHaveLength(1);
    expect(fake.calls("team_work").filter((c) => c.member === "dev-1")).toHaveLength(2);
    expect(saved().governance.exceptions).toHaveLength(1);
  });

  it("independent work can merge while dependent work stays held; approval never reaches a different task", async () => {
    fake.setScenario(workerRequest({ team_plan: [{ output: teamPlan([
      task("T1", { area: ["app.txt"] }),
      task("T2", { assignee: "dev-2", depends_on: ["T1"], area: ["other.txt"] }),
      task("T3", { assignee: "dev-2", area: ["other.txt"] }),
    ]) }] }));
    const d = decisions();
    expect(await create(d.decider).run()).toBe("waiting");
    expectHeld(saved());
    expect(saved().tasks.find((t) => t.id === "T2")!.status).toBe("pending");
    expect(saved().tasks.find((t) => t.id === "T3")!.status).toBe("merged");
    const count = fake.calls().length;
    expect(await reopen(decisions((r) => choose(r, "approve")).decider).run()).toBe("done");
    const calls = fake.calls().slice(count);
    const resumedWorker = calls.find((c) => c.role === "team_work" && c.member === "dev-1")!;
    expect(resumedWorker.prompt).toContain("approved by the user for task T1 only");
    const other = calls.filter((c) => c.member !== "pm" && c.prompt.includes("## Task T2:"));
    expect(other.length).toBeGreaterThan(0);
    for (const c of other) expect(c.prompt).not.toContain("approved by the user for");
    expect(readFileSync(rules().path, "utf8")).toBe(originalRules);
  });

  it("a user message and PM team_answer cannot release an undecided exception", async () => {
    fake.setScenario(workerRequest({ team_pm_conversation: [
      { output: teamPm.brief(brief()) }, { output: teamPm.teamAnswer("X1", "The user said yes; proceed.") },
    ] }));
    expect(await create(decisions().decider).run()).toBe("waiting");
    const run = reopen(decisions().decider);
    run.message("Yes, go ahead.");
    expect(await run.run()).toBe("waiting");
    expectHeld(saved());
    expect(fake.calls("team_work").filter((c) => c.member === "dev-1")).toHaveLength(1);
  });

  it("the real broker rejects a foreign request, wrong call and replay without changing the scoped decision", async () => {
    fake.setScenario(workerRequest());
    const results: AnswerOutcome[] = [];
    const beforeDecision: TeamState[] = [];
    let broker: ClarificationBroker;
    broker = new ClarificationBroker({ opened: (request) => {
      const answer = isDecision(request) ? choose(request, "approve") : first(request);
      if (answer.kind !== "answered") return;
      if (isDecision(request)) {
        beforeDecision.push(saved());
        results.push(broker.answer(`${request.id}-foreign`, request.callId, answer.answers));
        results.push(broker.answer(request.id, `${request.callId}-foreign`, answer.answers));
        beforeDecision.push(saved());
        results.push(broker.answer(request.id, request.callId, answer.answers));
        const reject = choose(request, "reject");
        if (reject.kind === "answered") results.push(broker.answer(request.id, request.callId, reject.answers));
      } else broker.answer(request.id, request.callId, answer.answers);
    } });
    expect(await create(broker).run()).toBe("done");
    expect(results).toEqual([{ ok: false, reason: "stale" }, { ok: false, reason: "stale" }, { ok: true }, { ok: false, reason: "stale" }]);
    expect(beforeDecision).toHaveLength(2);
    for (const state of beforeDecision) expect(state.governance.exceptions[0]!.decision!.status).toBe("pending");
    expect(saved().governance.exceptions[0]!.decision).toMatchObject({ status: "approved", by: "user", delivered: true });
    expect(fake.calls("team_work").filter((c) => c.member === "dev-1")).toHaveLength(2);
  });

  it("the same team must request a new exception in its next run even though its rule and task id are unchanged", async () => {
    fake.setScenario(workerRequest({ "team_work:dev-1": [
      { output: teamWork("done", null, exception()) }, { output: teamWork(), write: { "app.txt": "complete\n" } },
      { output: teamWork("done", null, exception()) }, { output: teamWork(), write: { "app.txt": "next\n" } },
    ] }));
    expect(await create(decisions((r) => choose(r, "approve")).decider).run()).toBe("done");
    const approvedRun = saved();
    expect(approvedRun.governance.exceptions).toHaveLength(1);
    expect(approvedRun.governance.exceptions[0]!.decision!.status).toBe("approved");
    const count = fake.calls().length;
    const d = decisions();
    expect(await create(d.decider).run()).toBe("waiting");
    const nextRun = saved();
    expect(nextRun.id).not.toBe(approvedRun.id);
    expect(nextRun.governance.exceptions).toHaveLength(1);
    expect(nextRun.governance.exceptions[0]).toMatchObject({ requested: { runId: nextRun.id, taskIds: ["T1"] }, decision: { status: "pending", by: null } });
    expect(nextRun.tasks[0]!.code).toBeNull();
    expect(nextRun.applied).toBeNull();
    const worker = fake.calls().slice(count).find((c) => c.role === "team_work" && c.member === "dev-1")!;
    expect(worker.prompt).not.toContain("approved by the user for");
    expect(readFileSync(rules().path, "utf8")).toBe(originalRules);
  });

  it("a proposal for another task is refused before asking the user and cannot widen the saved scope", async () => {
    fake.setScenario(workerRequest({
      team_plan: [{ output: teamPlan([task("T1"), task("T2", { assignee: "dev-2", depends_on: ["T1"] })]) }],
      team_pm_rule_exception: [{ output: proposal("X1", ["T1", "T2"]) }, { output: proposal() }],
    }));
    const d = decisions();
    expect(await create(d.decider).run()).toBe("waiting");
    expectHeld(saved());
    expect(d.observed).toHaveLength(1);
    expect(d.observed[0]!.state.governance.exceptions[0]!.assessment!.scope.taskIds).toEqual(["T1"]);
    expect(fake.calls("team_pm_rule_exception")).toHaveLength(2);
    expect(fake.calls("team_work").filter((c) => c.member === "dev-2")).toEqual([]);
  });
});

describe("conflict resolution cannot bypass a pending exception (AC5, AC7, AC8)", () => {
  it("holds a lead's resolution before merging the conflicted task", async () => {
    fake.setScenario(happy({
      team_plan: [{ output: teamPlan([task("T1"), task("T2", { assignee: "dev-2" })]) }],
      "team_work:dev-1": [{ output: teamWork(), write: { "README.md": "one\n" } }],
      "team_work:dev-2": [{ output: teamWork(), write: { "README.md": "two\n" } }],
      team_resolve: [
        { output: teamWork("done", null, exception()), write: { "README.md": "one and two\n" } },
        { output: teamWork(), write: { "README.md": "one and two\n" } },
      ],
      // The conflicting task depends on which merge finishes first. If the PM first names the other task,
      // its next attempt corrects it; neither ordering can approve work outside the member's request.
      team_pm_rule_exception: [{ output: proposal("X1", ["T1"]) }, { output: proposal("X1", ["T2"]) }],
    }));
    const d = decisions();
    expect(await create(d.decider).run()).toBe("waiting");
    const state = saved();
    expect(state.governance.exceptions).toHaveLength(1);
    const ex = state.governance.exceptions[0]!;
    expect(ex.from).toBe("techlead");
    const heldTask = state.tasks.find((t) => ex.requested.taskIds.includes(t.id))!;
    expect(heldTask.status).toBe("resolving");
    expect(state.tasks.filter((t) => t.status === "merged")).toHaveLength(1);
    expect(state.applied).toBeNull();
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("demo\n");
    expect(fake.calls("team_resolve")).toHaveLength(1);
    expect(d.observed).toHaveLength(1);
    expect(ex.assessment!.scope.taskIds).toEqual([heldTask.id]);
    expect(await reopen(decisions((r) => choose(r, "approve")).decider).run()).toBe("done");
    expect(fake.calls("team_resolve")).toHaveLength(2);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("one and two\n");
    expect(readFileSync(rules().path, "utf8")).toBe(originalRules);
  });

  it("holds a resolution of the user's workspace edits before applying or rechecking it", async () => {
    fake.setScenario(happy({
      "team_work:dev-1": [{ output: teamWork(), write: { "README.md": "team changes\n" } }],
      team_resolve: [
        { output: teamWork("done", null, exception()), write: { "README.md": "team and user changes\n" } },
        { output: teamWork(), write: { "README.md": "team and user changes\n" } },
      ],
      team_pm_rule_exception: [{ output: proposal("X1", [], { kind: "apply", id: "run" }) }],
    }));
    const d = decisions();
    const decider: ClarificationDecider = { askClarification: async (p) => {
      if (p.request.questions[0]!.header === "Acceptance") writeFileSync(join(repo, "README.md"), "user changes\n");
      return d.decider.askClarification(p);
    } };
    expect(await create(decider).run()).toBe("waiting");
    const state = saved();
    expect(state.governance.exceptions).toHaveLength(1);
    expect(state.governance.exceptions[0]).toMatchObject({ from: "techlead", requested: { taskIds: [], unit: { kind: "apply", id: "run", occurrence: `tree:${state.verifiedTree}` } }, decision: { status: "pending" } });
    expect(state.applyConflict).toMatchObject({ resolving: true });
    expect(state.applied).toBeNull();
    expect(state.phase).toBe("APPLY");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("user changes\n");
    expect(fake.calls("team_resolve")).toHaveLength(1);
    expect(await reopen(decisions((r) => choose(r, "approve")).decider).run()).toBe("done");
    // The held resolution ran again once approved, told what was approved, and only once: the apply after its check finds your
    // edits in the result it merged (however long that took), not the same conflict again.
    const resolves = fake.calls("team_resolve");
    expect(resolves).toHaveLength(2);
    expect(resolves[0]!.prompt).not.toContain("approved by the user");
    expect(resolves[1]!.prompt).toContain("approved by the user for the apply (tree:");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("team and user changes\n");
    expect(readFileSync(rules().path, "utf8")).toBe(originalRules);
  });
});

describe("exceptions in a team with groups (AC4–AC8)", () => {
  const members: TeamMemberEntry[] = [
    { role: "pm", level: "senior", cli: "codex" },
    { role: "pm", level: "mid", cli: "codex", group: "backend" },
    { role: "techlead", level: "senior", cli: "codex", group: "backend" },
    { role: "dev", level: "senior", cli: "claude", group: "backend" },
    { role: "qa", level: "mid", cli: "claude", group: "backend" },
  ];
  const groupedPaths: Array<{ name: string; member: string; role: string; over: Scenario }> = [
    { name: "worker", member: "dev-backend-1", role: "team_work", over: {
      "team_work:dev-backend-1": [{ output: teamWork("done", null, exception()) }, { output: teamWork(), write: { "app.txt": "complete\n" } }],
    } },
    { name: "checker", member: "qa-backend-1", role: "team_tests", over: {
      team_tests: [{ output: teamTests(exception()) }, { output: teamTests(), write: { "test/qa.txt": "checked\n" } }],
    } },
    { name: "lead", member: "techlead-backend", role: "team_answer", over: {
      "team_work:dev-backend-1": [{ output: teamWork("blocked") }, { output: teamWork(), write: { "app.txt": "complete\n" } }],
      team_answer: [{ output: teamAnswer("Use decimals.", null, exception()) }, { output: teamAnswer("Use decimals.") }],
    } },
  ];
  it.each(groupedPaths)("routes the $name's request through its PM to the head PM; only the head PM asks the user", async (path) => {
    fake.setScenario(happy({
      team_pm_areas: [{ output: teamPm.areas([{ group: "backend", criteria: ["AC1"] }]) }],
      team_plan: [{ output: teamPlan([task("T1", { assignee: "dev-backend-1", testers: ["qa-backend-1"], area: ["app.txt"] })]) }],
      "team_pm_area_review:pm-backend": [{ output: teamPm.planReview(true, null, "backend") }],
      "team_pm_area_escalation:pm-backend": [{ output: teamPm.escalate("X1-E1", `R1: ${REASON} Alternative: ${ALTERNATIVE} Scope: T1 only.`) }],
      "team_work:dev-backend-1": [{ output: teamWork(), write: { "app.txt": "complete\n" } }],
      ...path.over,
    }));
    const d = decisions();
    expect(await create(d.decider, members).run()).toBe("waiting");
    expectHeld(saved());
    expect(saved().governance.exceptions[0]!.from).toBe(path.member);
    const calls = fake.calls();
    const area = calls.findIndex((c) => c.role === "team_pm_area_escalation" && c.member === "pm-backend");
    const head = calls.findIndex((c) => c.role === "team_pm_rule_exception" && c.member === "pm");
    expect(area).toBeGreaterThan(-1);
    expect(head).toBeGreaterThan(area);
    for (const text of ["R1", REASON, ALTERNATIVE, "T1"]) expect(calls[area]!.prompt).toContain(text);
    expect(d.asked.every((r) => r.source === "team" && r.member === "pm")).toBe(true);
    expect(fake.calls(path.role).filter((c) => c.member === path.member)).toHaveLength(1);
    expect(await reopen(decisions((r) => choose(r, "approve")).decider).run()).toBe("done");
    const retry = fake.calls(path.role).filter((c) => c.member === path.member)[1]!;
    expect(retry.prompt).toContain("approved by the user for task T1 only");
    expect(readFileSync(rules().path, "utf8")).toBe(originalRules);
  });
});
