// The exception loop inside a team run (T5): a member asks for an exception to the team's rules, the PM who answers for the work
// assesses it, only the head PM shows it to the user, and the work it concerns waits for the user's own decision. Fake CLIs, real git
// worktrees; stops are made with Esc-like `stop()` calls, a decider that puts a request off, or no decider at all.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClarificationRequest, ClarificationResponse } from "../../src/clarification/clarification.js";
import { EventBus, type ClarificationDecider, type DuoEvent } from "../../src/events.js";
import type { TeamMemberEntry } from "../../src/team/config.js";
import { boardJobs } from "../../src/team/board.js";
import { assessException, exceptionsFor, heldTaskIds, planningUnit, presentException, requestException, unitHeld, type GovernedState } from "../../src/team/rule-governance.js";
import { TeamRules, teamRulesDir } from "../../src/team/rules.js";
import { TeamStore, type TeamState } from "../../src/team/state.js";
import { TeamRun } from "../../src/team/team.js";
import { testConfig, userDataEnv } from "../helpers/config.js";
import { FakeClis, type FakeCall } from "../helpers/fake-clis.js";
import { git, makeRepo } from "../helpers/repo.js";
import {
  askException, brief, task, teamCheck, teamPlan, teamPm, teamReview, teamTests, teamTriage, teamWork,
} from "../helpers/team-builders.js";
import { tempDir } from "../helpers/tmp.js";

let t: { path: string; cleanup(): void };
let fake: FakeClis;
let repo: string;
let events: DuoEvent[];
let bus: EventBus;

beforeEach(() => {
  t = tempDir();
  fake = new FakeClis(t.path).install();
  repo = makeRepo(t.path);
  bus = new EventBus();
  events = [];
  bus.on((e) => events.push(e));
});
afterEach(() => {
  fake.restore();
  t.cleanup();
});

const runsDir = () => join(repo, ".agentduo", "runs");
const env = () => ({ ...process.env, ...userDataEnv(join(t.path, "data")) });
const rulesOf = () => new TeamRules(teamRulesDir(env(), repo, "default"));
const stateOf = (): TeamState => TeamStore.open(runsDir(), "latest").load();
const SEED = { opId: "seed:1", text: "Always say which criterion a change serves.", incident: "an earlier run" };

type Reply = "first" | "approve" | "reject" | "defer" | "cancel" | { text: string } | (() => Promise<Reply>);

/**
 * The user. Every request is answered with its first option (approve the brief, the plan, the result), except those whose
 * header has a scripted reply: "Exception" (approve, reject, words of their own, put off, closed) and "Rule" (the PM's question).
 * `onAsk` sees a request as it arrives, before the answer.
 */
function user(replies: Record<string, Reply[]> = {}, onAsk: (r: ClarificationRequest) => void = () => undefined): ClarificationDecider & { asked: ClarificationRequest[] } {
  const asked: ClarificationRequest[] = [];
  const answer = async (request: ClarificationRequest, reply: Reply): Promise<ClarificationResponse> => {
    if (typeof reply === "function") return answer(request, await reply());
    if (reply === "defer") return { kind: "defer" };
    if (reply === "cancel") return { kind: "cancelled" };
    const q = request.questions[0]!;
    if (typeof reply === "object") return { kind: "answered", answers: [{ questionId: q.id, optionIds: [], otherText: reply.text }] };
    return { kind: "answered", answers: [{ questionId: q.id, optionIds: [reply === "approve" || reply === "reject" ? reply : q.options[0]!.id], otherText: null }] };
  };
  return {
    asked,
    askClarification: async ({ request }): Promise<ClarificationResponse> => {
      asked.push(request);
      onAsk(request);
      return answer(request, replies[request.questions[0]!.header]?.shift() ?? "first");
    },
  };
}

function teamRun(o: { decider?: ClarificationDecider; members?: TeamMemberEntry[] } = {}) {
  const cfg = testConfig(fake, { gates: [] });
  if (o.members) cfg.team.members = o.members;
  return TeamRun.create({ runsDir: runsDir(), request: "Add subtraction, and document it", cfg, workspace: repo, bus, decider: o.decider, env: env(), reportIntervalMs: 0 });
}

function resume(decider?: ClarificationDecider, members?: TeamMemberEntry[]) {
  const cfg = members ? testConfig(fake, { gates: [] }) : undefined;
  if (cfg && members) cfg.team.members = members;
  return TeamRun.resume({ runsDir: runsDir(), id: "latest", workspace: repo, bus: new EventBus(), decider, env: env(), reportIntervalMs: 0, ...(cfg ? { cfg } : {}) });
}

const two = brief(["Subtraction works", "It is documented"]);
const twoTasks = teamPlan([
  task("T1", { assignee: "dev-1", criteria: ["AC1"], area: ["app.txt"] }),
  task("T2", { assignee: "dev-2", criteria: ["AC2"], area: ["docs.md"] }),
]);
const acceptance = {
  message: "Both criteria are met.",
  action: { kind: "acceptance", criteria: [{ id: "AC1", status: "met", evidence: "qa-1: C1" }, { id: "AC2", status: "met", evidence: "qa-1: C2" }], summary: "Done." },
};

const happy = (over: Record<string, unknown> = {}) => ({
  team_pm_conversation: [{ output: teamPm.brief(two) }, { output: teamPm.none("Noted.") }],
  team_plan: [{ output: twoTasks }],
  team_pm_plan_review: [{ output: teamPm.planReview(true) }],
  team_pm_reports: [{ output: teamPm.none("Progress.") }],
  team_pm_acceptance: [{ output: acceptance }],
  "team_work:dev-1": [{ output: teamWork(), write: { "app.txt": "fixed\n" } }],
  "team_work:dev-2": [{ output: teamWork(), write: { "docs.md": "# sub\n" } }],
  team_tests: [{ output: teamTests(), write: { "test/qa.txt": "tests\n" } }],
  team_review: [{ output: teamReview("approve") }],
  team_check: [{ output: teamCheck("pass") }],
  ...over,
});

/** dev-1 asks for an exception to R1 on T1 in its first turn (what it wrote then is not used), and works under the decision in its second. */
const devAsks = (over: Record<string, unknown> = {}) => happy({
  "team_work:dev-1": [{ output: teamWork("done", null, askException(["R1"])), write: { "app.txt": "partial\n" } }, { output: teamWork(), write: { "app.txt": "fixed\n" } }],
  team_pm_rule_exception: [{ output: teamPm.exceptionProposal("X1") }],
  ...over,
});

const forTask = (c: FakeCall, id: string) => c.prompt.includes(`## Task ${id}:`);
const exceptionRequests = (d: { asked: ClarificationRequest[] }) => d.asked.filter((r) => r.questions[0]!.header === "Exception");

async function waitFor(what: string, ok: () => boolean, ms = 40_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const pending = () => stateOf().governance.exceptions.filter((e) => e.decision?.status === "pending");

describe("a member asks for an exception: the work waits, the PM assesses, the user decides (AC4, AC5)", () => {
  it("holds the task and its dependent steps while the request waits, lets the independent task go on, and works under the approval only once the user agreed", async () => {
    rulesOf().append(SEED);
    const rules = readFileSync(rulesOf().path, "utf8");
    fake.setScenario(devAsks());
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let callsWhenAsked = 0;
    const d = user({ Exception: [async () => { await gate; return "approve"; }] }, (r) => { if (r.questions[0]!.header === "Exception") callsWhenAsked = fake.calls().length; });
    const done = teamRun({ decider: d }).run();
    // The request is shown to the user, and T2 (independent) goes all the way to merged while T1 waits.
    await waitFor("T2 merged and the request shown", () => stateOf().tasks.find((x) => x.id === "T2")?.status === "merged" && pending().length === 1);
    const mid = stateOf();
    const t1 = mid.tasks.find((x) => x.id === "T1")!;
    expect(t1.status).toBe("coding");
    expect(t1.code).toBeNull();
    expect(mid.integration).toBeNull();
    expect(mid.phase).toBe("EXECUTION");
    const waitingCalls = fake.calls().slice(callsWhenAsked);
    expect(waitingCalls.filter((c) => forTask(c, "T1") || c.member === "dev-1" && c.role === "team_work")).toHaveLength(0);
    // Nothing is approved: the request is shown, the PM's proposal is what the user reads.
    const asked = exceptionRequests(d);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ source: "team", member: "pm", teamRunId: mid.id });
    expect(asked[0]!.questions[0]!.question).toContain("R1 (Always say which criterion a change serves.)");
    expect(asked[0]!.questions[0]!.question).toContain("task T1");
    expect(asked[0]!.questions[0]!.question).toContain("Do it another way.");
    expect(asked[0]!.questions[0]!.options.map((o) => o.id)).toEqual(["approve", "reject"]);
    expect(mid.governance.exceptions[0]).toMatchObject({ id: "X1", from: "dev-1", ruleIds: ["R1"], decision: { status: "pending", requestId: asked[0]!.id, delivered: false } });
    expect(mid.governance.exceptions[0]!.requested).toMatchObject({ taskIds: ["T1"], unit: null });
    expect(mid.governance.exceptions[0]!.assessment).toMatchObject({ by: "pm", ruleIds: ["R1"] });
    expect(exceptionsFor(mid, { task: "T1" })).toEqual([]);
    expect(fake.calls().filter((c) => c.member === "dev-1" && c.role === "team_work")).toHaveLength(1);
    release();
    expect(await done).toBe("done");
    const state = stateOf();
    expect(state.governance.exceptions[0]!.decision).toMatchObject({ status: "approved", by: "user", delivered: true, requestId: asked[0]!.id });
    // dev-1 worked a second time, told what the user approved and for what work; what it wrote before was not used.
    const works = fake.calls("team_work").filter((c) => c.member === "dev-1");
    expect(works).toHaveLength(2);
    expect(works[0]!.prompt).not.toContain("approved by the user");
    expect(works[1]!.prompt).toContain("X1, approved by the user for task T1 only");
    expect(works[1]!.prompt).toContain("Do it another way.");
    expect(readFileSync(join(repo, "app.txt"), "utf8")).toBe("fixed\n");
    // The approval covers T1 only: T2's calls know nothing of it, and the rule is in force, as written, in every prompt.
    for (const c of fake.calls().filter((x) => x.member && x.member !== "pm" && forTask(x, "T2"))) expect(c.prompt, `${c.role} of T2`).not.toContain("approved by the user");
    expect(exceptionsFor(state, { task: "T2" })).toEqual([]);
    expect(exceptionsFor(state, { task: "T1" }).map((e) => e.id)).toEqual(["X1"]);
    expect(readFileSync(rulesOf().path, "utf8")).toBe(rules);
    for (const c of fake.calls().filter((x) => x.member && x.member !== "pm")) expect(c.prompt).toContain("- R1: Always say which criterion a change serves.");
  });

  it("works under the rules, never the exception, when the user refuses", async () => {
    rulesOf().append(SEED);
    const rules = readFileSync(rulesOf().path, "utf8");
    fake.setScenario(devAsks());
    const d = user({ Exception: ["reject"] });
    expect(await teamRun({ decider: d }).run()).toBe("done");
    const state = stateOf();
    expect(state.governance.exceptions[0]!.decision).toMatchObject({ status: "rejected", by: "user", delivered: true });
    expect(exceptionsFor(state, { task: "T1" })).toEqual([]);
    const second = fake.calls("team_work").filter((c) => c.member === "dev-1")[1]!;
    expect(second.prompt).toContain("X1 (R1): refused. The rules stand; do not depart from them.");
    expect(second.prompt).not.toContain("approved by the user");
    expect(readFileSync(rulesOf().path, "utf8")).toBe(rules);
    expect(events.some((e) => e.type === "team.message" && e.from === "pm")).toBe(true);
  });

  it("never lets a member ask again for what the user refused: it is told, and its answer is retried without the request", async () => {
    rulesOf().append(SEED);
    fake.setScenario(devAsks({
      "team_work:dev-1": [
        { output: teamWork("done", null, askException(["R1"])) },
        // The second turn insists; the check refuses the request (the user said no), so the call is retried and the third gives the work.
        { output: teamWork("done", null, askException(["R1"])) },
        { output: teamWork(), write: { "app.txt": "fixed\n" } },
      ],
    }));
    expect(await teamRun({ decider: user({ Exception: ["reject"] }) }).run()).toBe("done");
    expect(stateOf().governance.exceptions).toHaveLength(1);
    expect(fake.calls("team_work").filter((c) => c.member === "dev-1")[2]!.prompt).toContain("was already refused");
  });

  it("takes the user's own words as guidance for the PM, never as approval, and asks the same proposal again under a new request", async () => {
    rulesOf().append(SEED);
    fake.setScenario(devAsks());
    let second: ClarificationRequest | null = null;
    const d = user({ Exception: [{ text: "Only if the tests still pass." }, "approve"] }, (r) => {
      if (r.questions[0]!.header !== "Exception") return;
      const ex = stateOf().governance.exceptions[0]!;
      if (exceptionRequests(d).length === 2) {
        second = r;
        // When the user is asked again: still pending, now under a new request; the first one stands for nothing.
        expect(ex.decision).toMatchObject({ status: "pending", requestId: r.id });
        expect(ex.decision!.previousRequestIds).toHaveLength(1);
      }
    });
    expect(await teamRun({ decider: d }).run()).toBe("done");
    const asked = exceptionRequests(d);
    expect(asked).toHaveLength(2);
    expect(asked[1]!.id).not.toBe(asked[0]!.id);
    expect(asked[1]!.questions).toEqual(asked[0]!.questions);
    expect(second).not.toBeNull();
    const state = stateOf();
    expect(state.governance.exceptions[0]!.decision).toMatchObject({ status: "approved", requestId: asked[1]!.id, previousRequestIds: [asked[0]!.id] });
    // The words went to the PM as the user's message, apart from the decision.
    expect(state.messages.some((m) => m.from === "user" && m.text.includes("(about exception X1) Only if the tests still pass."))).toBe(true);
    expect(fake.calls("team_work").filter((c) => c.member === "dev-1")).toHaveLength(2);
  });

  it("is told to a tester too: a check that asks for an exception does not count, nothing merges, and the next check works under the decision", async () => {
    rulesOf().append(SEED);
    fake.setScenario(happy({
      team_check: [{ output: teamCheck("pass", "code", askException(["R1"])) }, { output: teamCheck("pass") }],
      team_pm_rule_exception: [{ output: teamPm.exceptionProposal("X1") }],
    }));
    const seen: string[] = [];
    const d = user({}, (r) => {
      if (r.questions[0]!.header !== "Exception") return;
      const s = stateOf();
      const x = s.governance.exceptions[0]!;
      const task = s.tasks.find((y) => y.id === x.requested.taskIds[0])!;
      seen.push(`${x.from}:${task.status}:${task.checks.length}:${task.status === "merged"}`);
    });
    expect(await teamRun({ decider: d }).run()).toBe("done");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^qa-1:testing:0:false$/);
    expect(stateOf().tasks.map((x) => x.status)).toEqual(["merged", "merged"]);
    expect(stateOf().governance.exceptions[0]!.decision).toMatchObject({ status: "approved", delivered: true });
  });

  it("is told to a reviewer and to the techlead (triage) as well", async () => {
    rulesOf().append(SEED);
    // dev-2 (mid) is reviewed by dev-1: its review asks for an exception on T2. T1's check fails once, so the techlead triages it and asks one on T1.
    fake.setScenario(happy({
      "team_review:dev-1": [{ output: teamReview("approve", askException(["R1"])) }, { output: teamReview("approve") }],
      team_check: [{ output: teamCheck("fail") }, { output: teamCheck("pass") }],
      team_triage: [{ output: teamTriage("retry", { governance: askException(["R1"]) }) }, { output: teamTriage("retry") }],
      "team_work:dev-1": [{ output: teamWork(), write: { "app.txt": "broken\n" } }, { output: teamWork(), write: { "app.txt": "fixed\n" } }],
      team_pm_rule_exception: [{ output: teamPm.exceptionProposal("X1", { taskIds: ["T2"] }) }, { output: teamPm.exceptionProposal("X2", { taskIds: ["T1"] }) }],
      // The failed check is an incident the run settled: the PM learns from it, and that has nothing to do with the exceptions.
      team_pm_rule_lesson: [{ output: teamPm.ruleLesson("I1", "Run the failing case before reporting a task done.") }],
    }));
    const d = user();
    expect(await teamRun({ decider: d }).run()).toBe("done");
    const state = stateOf();
    expect(state.governance.exceptions.map((e) => [e.id, e.from, e.requested.taskIds, e.decision?.status])).toEqual([
      ["X1", "dev-1", ["T2"], "approved"], ["X2", "techlead", ["T1"], "approved"],
    ]);
    expect(exceptionRequests(d)).toHaveLength(2);
  });
});

describe("a request is not judged as a completed result", () => {
  it("records and routes a request whose result could never complete the work (a plan with no task, a blocked work with no question)", async () => {
    rulesOf().append(SEED);
    fake.setScenario(happy({
      team_plan: [{ output: teamPlan([], askException(["R1"])) }, { output: twoTasks }],
      "team_work:dev-1": [{ output: teamWork("blocked", null, askException(["R1"])) }, { output: teamWork(), write: { "app.txt": "fixed\n" } }],
      team_pm_rule_exception: [
        { output: teamPm.exceptionProposal("X1", { unit: { kind: "planning", id: "ungrouped" } }) },
        { output: teamPm.exceptionProposal("X2", { taskIds: ["T1"] }) },
      ],
    }));
    const d = user();
    expect(await teamRun({ decider: d }).run()).toBe("done");
    // Each was asked once (no retry for a rejected ordinary check), reached the PM and the user, and held its work until decided.
    expect(fake.calls("team_plan")).toHaveLength(2);
    expect(fake.calls("team_work").filter((c) => c.member === "dev-1")).toHaveLength(2);
    expect(stateOf().governance.exceptions.map((e) => [e.id, e.from, e.decision?.status])).toEqual([["X1", "techlead", "approved"], ["X2", "dev-1", "approved"]]);
    expect(exceptionRequests(d)).toHaveLength(2);
    expect(fake.calls("team_plan")[1]!.prompt).not.toContain("rejected");
  });
});

describe("the work outside a task waits too (AC5)", () => {
  it("holds a group's planning: no plan is written or approved before the decision, and the next plan is told what the user approved for it", async () => {
    rulesOf().append(SEED);
    fake.setScenario(happy({
      team_plan: [{ output: teamPlan(twoTasks.tasks, askException(["R1"])) }, { output: twoTasks }],
      team_pm_rule_exception: [{ output: teamPm.exceptionProposal("X1", { unit: { kind: "planning", id: "ungrouped" } }) }],
    }));
    let plansWhenAsked = -1;
    const d = user({}, (r) => { if (r.questions[0]!.header === "Exception") plansWhenAsked = stateOf().plans.length; });
    expect(await teamRun({ decider: d }).run()).toBe("done");
    expect(plansWhenAsked).toBe(0);
    expect(d.asked.map((r) => r.questions[0]!.header)).toEqual(["Brief", "Exception", "Plan", "Acceptance"]);
    const plans = fake.calls("team_plan");
    expect(plans).toHaveLength(2);
    expect(plans[1]!.prompt).toContain("X1, approved by the user for the planning of ungrouped (brief1.plan0) only");
    expect(stateOf().governance.exceptions[0]!.requested.unit).toMatchObject({ kind: "planning", id: "ungrouped", occurrence: "brief1.plan0" });
  });

  it("holds the whole result's check: no acceptance is asked and nothing is written before the decision", async () => {
    rulesOf().append(SEED);
    fake.setScenario(happy({
      // qa-1 checks T1 and T2, then the whole result: its third check asks for the exception.
      team_check: [{ output: teamCheck("pass") }, { output: teamCheck("pass") }, { output: teamCheck("pass", "code", askException(["R1"])) }, { output: teamCheck("pass") }],
      team_pm_rule_exception: [{ output: teamPm.exceptionProposal("X1", { unit: { kind: "integration", id: "run" } }) }],
    }));
    const when: string[] = [];
    const d = user({}, (r) => {
      if (r.questions[0]!.header === "Exception") when.push(`${stateOf().phase}:${stateOf().acceptance === null}:${stateOf().applied === null}`);
    });
    expect(await teamRun({ decider: d }).run()).toBe("done");
    expect(when).toEqual(["INTEGRATION:true:true"]);
    expect(d.asked.map((r) => r.questions[0]!.header)).toEqual(["Brief", "Plan", "Exception", "Acceptance"]);
    const checks = fake.calls("team_check");
    expect(checks.at(-1)!.prompt).toContain("approved by the user for the integration (commit:");
  });
});

describe("the PM who answers for the work, and the head PM (AC4, AC5, AC6)", () => {
  const members: TeamMemberEntry[] = [
    { role: "pm", level: "senior", cli: "codex" },
    { role: "techlead", level: "senior", cli: "codex", group: "frontend" },
    { role: "dev", level: "mid", cli: "claude", group: "frontend" },
    { role: "qa", level: "mid", cli: "claude", group: "frontend" },
    { role: "pm", level: "mid", cli: "codex", group: "backend" },
    { role: "techlead", level: "senior", cli: "codex", group: "backend" },
    { role: "dev", level: "senior", cli: "claude", group: "backend" },
    { role: "qa", level: "mid", cli: "claude", group: "backend" },
  ];
  const grouped = (over: Record<string, unknown> = {}) => happy({
    team_pm_areas: [{ output: teamPm.areas([{ group: "frontend", criteria: ["AC2"] }, { group: "backend", criteria: ["AC1"] }]) }],
    "team_plan:techlead-frontend": [{ output: teamPlan([task("F1", { assignee: "dev-frontend-1", testers: ["qa-frontend-1"], criteria: ["AC2"], area: ["docs.md"] })]) }],
    "team_plan:techlead-backend": [{ output: teamPlan([task("B1", { assignee: "dev-backend-1", testers: ["qa-backend-1"], criteria: ["AC1"], area: ["app.txt"] })]) }],
    "team_pm_area_review:pm-backend": [{ output: teamPm.planReview(true, null, "backend") }],
    "team_work:dev-frontend-1": [{ output: teamWork(), write: { "docs.md": "# sub\n" } }],
    "team_work:dev-backend-1": [{ output: teamWork("done", null, askException(["R1"])) }, { output: teamWork(), write: { "app.txt": "fixed\n" } }],
    ...over,
  });

  it("sends a group member's request to its group's PM, who passes it up to the head PM, the only one who shows it to the user", async () => {
    rulesOf().append(SEED);
    fake.setScenario(grouped({
      "team_pm_area_escalation:pm-backend": [{ output: teamPm.escalate("X1-E1", "The rule does not fit B1; the user must decide.") }],
      team_pm_rule_exception: [{ output: teamPm.exceptionProposal("X1", { taskIds: ["B1"] }) }],
    }));
    const d = user();
    expect(await teamRun({ decider: d, members }).run()).toBe("done");
    // The group's PM saw the request first, in its own turn, with what the member said.
    const area = fake.calls("team_pm_area_escalation");
    expect(area).toHaveLength(1);
    expect(area[0]!.prompt).toContain("dev-backend-1 asks for an exception to the team's rules R1 for task B1");
    expect(area[0]!.prompt).toContain("You never approve it.");
    // The head PM assessed it after the group's PM passed it up; the user was asked once, by the head PM.
    expect(fake.calls("team_pm_rule_exception").map((c) => c.member)).toEqual(["pm"]);
    const asked = exceptionRequests(d);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ member: "pm", source: "team" });
    expect(d.asked.every((r) => r.member === "pm")).toBe(true);
    const state = stateOf();
    expect(state.governance.exceptions[0]).toMatchObject({ from: "dev-backend-1", decision: { status: "approved", delivered: true } });
    expect(state.escalations.find((e) => e.id === "X1-E1")).toMatchObject({ reason: "rule_exception", exceptionId: "X1", to: "pm" });
    expect(state.escalations.find((e) => e.id === "X1-E1")!.answer).not.toBeNull();
    expect(fake.calls("team_work").filter((c) => c.member === "dev-backend-1")[1]!.prompt).toContain("X1, approved by the user for task B1 only");
  });

  it("lets a group's PM refuse a request itself: the rules stand, nothing is shown to the user, and nothing is approved", async () => {
    rulesOf().append(SEED);
    fake.setScenario(grouped({ "team_pm_area_escalation:pm-backend": [{ output: teamPm.teamAnswer("X1-E1", "R1 fits this task; follow it.") }] }));
    const d = user();
    expect(await teamRun({ decider: d, members }).run()).toBe("done");
    expect(exceptionRequests(d)).toHaveLength(0);
    expect(fake.calls("team_pm_rule_exception")).toHaveLength(0);
    const state = stateOf();
    expect(state.governance.exceptions[0]!.decision).toMatchObject({ status: "rejected", by: "pm", requestId: null, delivered: true });
    expect(exceptionsFor(state, { task: "B1" })).toEqual([]);
    expect(fake.calls("team_work").filter((c) => c.member === "dev-backend-1")[1]!.prompt).toContain("refused. The rules stand");
  });

  it("lets the head PM decline a request of a team without groups, and never asks the user", async () => {
    rulesOf().append(SEED);
    fake.setScenario(devAsks({ team_pm_rule_exception: [{ output: teamPm.exceptionDecline("X1") }] }));
    const d = user();
    expect(await teamRun({ decider: d }).run()).toBe("done");
    expect(exceptionRequests(d)).toHaveLength(0);
    expect(stateOf().governance.exceptions[0]!.decision).toMatchObject({ status: "rejected", by: "pm", delivered: true });
    expect(fake.calls("team_work").filter((c) => c.member === "dev-1")[1]!.prompt).toContain("refused");
  });

  it("holds the work while the PM asks the user a question it cannot decide, and an answer to it approves nothing (AC6)", async () => {
    rulesOf().append(SEED);
    fake.setScenario(devAsks({
      team_pm_rule_exception: [{ output: teamPm.ruleQuestion({ exceptionId: "X1" }) }, { output: teamPm.exceptionDecline("X1") }],
    }));
    const seen: string[] = [];
    const d = user({}, (r) => {
      if (r.questions[0]!.header !== "Rule") return;
      const s = stateOf();
      seen.push(`${s.governance.exceptions[0]!.direction?.answer ?? "open"}:${fake.calls("team_work").filter((c) => c.member === "dev-1").length}`);
    });
    expect(await teamRun({ decider: d }).run()).toBe("done");
    // While the question was open, dev-1 had worked once and was not called again.
    expect(seen).toEqual(["open:1"]);
    const state = stateOf();
    const ex = state.governance.exceptions[0]!;
    expect(ex.direction!.answer).toContain("Keep it");
    expect(ex.decision).toMatchObject({ status: "rejected", by: "pm" });
    expect(exceptionRequests(d)).toHaveLength(0);
    // The PM's second turn read the user's answer, as information.
    expect(fake.calls("team_pm_rule_exception")[1]!.prompt).toContain("The user's answers to your questions about the rules (information for your decision; they approve nothing)");
    expect(fake.calls("team_pm_rule_exception")[1]!.prompt).toContain("Keep it");
  });

  it("does not take an answer to the PM's question for the approval: the PM still has to propose it, and the user to agree", async () => {
    rulesOf().append(SEED);
    fake.setScenario(devAsks({
      team_pm_rule_exception: [{ output: teamPm.ruleQuestion({ exceptionId: "X1" }) }, { output: teamPm.exceptionProposal("X1") }],
    }));
    const d = user({ Rule: ["first"], Exception: ["reject"] });
    expect(await teamRun({ decider: d }).run()).toBe("done");
    expect(d.asked.map((r) => r.questions[0]!.header).filter((h) => h === "Rule" || h === "Exception")).toEqual(["Rule", "Exception"]);
    expect(stateOf().governance.exceptions[0]!.decision).toMatchObject({ status: "rejected", by: "user" });
    expect(exceptionsFor(stateOf(), { task: "T1" })).toEqual([]);
  });
});

describe("stop, resume and the user who has not answered (AC6, AC7, AC8)", () => {
  /** Waits for the request, then the run goes on only by `resume`. */
  async function toPending(decider?: ClarificationDecider, over: Record<string, unknown> = {}): Promise<void> {
    rulesOf().append(SEED);
    fake.setScenario(devAsks(over));
    const run = teamRun({ decider });
    expect(await run.run()).toBe("waiting");
  }

  it("keeps the request pending when the user puts it off, runs the independent task meanwhile, and asks the very same request on resume", async () => {
    const d = user({ Exception: ["defer"] });
    await toPending(d);
    let state = stateOf();
    const x = state.governance.exceptions[0]!;
    expect(x.decision).toMatchObject({ status: "pending", delivered: false });
    expect(state.tasks.map((y) => [y.id, y.status])).toEqual([["T1", "coding"], ["T2", "merged"]]);
    expect(fake.calls("team_work").filter((c) => c.member === "dev-1")).toHaveLength(1);
    expect(state.clarifications.find((c) => c.id === x.decision!.requestId)).toMatchObject({ status: "pending", source: "team" });
    expect(exceptionsFor(state, { task: "T1" })).toEqual([]);
    // Reopened: the same request, the same words, then the user's decision applies to it.
    const again = user({ Exception: ["approve"] });
    expect(await resume(again).run()).toBe("done");
    const asked = exceptionRequests(again);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.id).toBe(x.decision!.requestId);
    expect(asked[0]!.questions).toEqual(exceptionRequests(d)[0]!.questions);
    state = stateOf();
    expect(state.governance.exceptions[0]!.decision).toMatchObject({ status: "approved", requestId: x.decision!.requestId, previousRequestIds: [] });
    expect(fake.calls("team_work").filter((c) => c.member === "dev-1")).toHaveLength(2);
    // Asked once before and once after, not repeated: the PM was not asked to propose it again.
    expect(fake.calls("team_pm_rule_exception")).toHaveLength(1);
  });

  it("waits, the request shown to nobody, when the run is reopened where nobody can answer, and resumes the pending request when someone can", async () => {
    await toPending(user({ Exception: ["defer"] }));
    const x = stateOf().governance.exceptions[0]!;
    // Reopened with no decider: the request is announced once, stays pending, and nothing it holds moves.
    const later = new EventBus();
    const seen: DuoEvent[] = [];
    later.on((e) => seen.push(e));
    const cfg = testConfig(fake, { gates: [] });
    const blind = TeamRun.resume({ runsDir: runsDir(), id: "latest", workspace: repo, bus: later, env: env(), reportIntervalMs: 0, cfg });
    expect(await blind.run()).toBe("waiting");
    expect(seen.filter((e) => e.type === "clarification.requested" && e.request.id === x.decision!.requestId)).toHaveLength(1);
    const state = stateOf();
    expect(state.governance.exceptions[0]!.decision).toMatchObject({ status: "pending", requestId: x.decision!.requestId, delivered: false });
    expect(exceptionsFor(state, { task: "T1" })).toEqual([]);
    expect(state.clarifications.find((c) => c.id === x.decision!.requestId)!.status).toBe("pending");
    expect(fake.calls("team_work").filter((c) => c.member === "dev-1")).toHaveLength(1);
    expect(await resume(user({ Exception: ["reject"] })).run()).toBe("done");
    expect(stateOf().governance.exceptions[0]!.decision).toMatchObject({ status: "rejected", by: "user", requestId: x.decision!.requestId });
  });

  it("keeps the very same request pending when the user closed it unanswered, and asks it again as it was", async () => {
    const d = user({ Exception: ["cancel"] });
    await toPending(d);
    const before = stateOf().governance.exceptions[0]!;
    expect(before.decision).toMatchObject({ status: "pending", previousRequestIds: [] });
    const again = user({ Exception: ["approve"] });
    expect(await resume(again).run()).toBe("done");
    const asked = exceptionRequests(again);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.id).toBe(before.decision!.requestId);
    expect(stateOf().governance.exceptions[0]!.decision).toMatchObject({ status: "approved", requestId: before.decision!.requestId, previousRequestIds: [] });
  });

  it("restores a decision made before the stop without asking again or applying it to other work", async () => {
    rulesOf().append(SEED);
    // The user approves, and the run stops before dev-1 is called again.
    fake.setScenario(devAsks({ "team_work:dev-1": [{ output: teamWork("done", null, askException(["R1"])) }, { output: teamWork(), write: { "app.txt": "fixed\n" }, sleep: 3000 }] }));
    const run = teamRun({ decider: user({ Exception: ["approve"] }) });
    bus.on((e) => {
      if (e.type === "team.member" && e.member === "dev-1" && e.job === "work" && e.state === "busy" && fake.calls("team_work").filter((c) => c.member === "dev-1").length === 1) {
        setTimeout(() => run.stop(), 400);
      }
    });
    expect(await run.run()).toBe("stopped");
    const before = stateOf();
    expect(before.governance.exceptions[0]!.decision).toMatchObject({ status: "approved", by: "user" });
    const again = user();
    expect(await resume(again).run()).toBe("done");
    expect(exceptionRequests(again)).toHaveLength(0);
    expect(stateOf().governance.exceptions).toHaveLength(1);
    expect(stateOf().governance.exceptions[0]!.decision).toMatchObject({ status: "approved", requestId: before.governance.exceptions[0]!.decision!.requestId });
    for (const c of fake.calls().filter((x) => x.member === "dev-2")) expect(c.prompt).not.toContain("approved by the user");
  });

  it("reopens the PM's unanswered question and holds the work until it is answered", async () => {
    const d = user({ Rule: ["defer"] });
    await toPending(d, { team_pm_rule_exception: [{ output: teamPm.ruleQuestion({ exceptionId: "X1" }) }, { output: teamPm.exceptionDecline("X1") }] });
    let state = stateOf();
    const q = state.governance.exceptions[0]!.direction!;
    expect(q.answer).toBeNull();
    expect(state.governance.exceptions[0]!.decision).toBeNull();
    expect(fake.calls("team_work").filter((c) => c.member === "dev-1")).toHaveLength(1);
    const again = user();
    expect(await resume(again).run()).toBe("done");
    expect(again.asked.filter((r) => r.questions[0]!.header === "Rule").map((r) => r.id)).toEqual([q.requestId]);
    state = stateOf();
    expect(state.governance.exceptions[0]).toMatchObject({ direction: { answer: expect.any(String) }, decision: { status: "rejected", by: "pm" } });
  });
});

describe("what no path may go past (AC5, AC7, AC8)", () => {
  /** A run that never starts: its state is built by hand, the way a stopped run leaves it. */
  function idle(): { run: TeamRun; state: TeamState; priv: Record<string, (...a: never[]) => unknown> } {
    rulesOf().append(SEED);
    const run = teamRun();
    const state = run.state;
    state.phase = "EXECUTION";
    state.approvedBrief = 1;
    state.briefs.push({ version: 1, ...brief(["Subtraction works"]) } as never);
    return { run, state, priv: run as unknown as Record<string, (...a: never[]) => unknown> };
  }
  const gov = (s: TeamState): GovernedState => s;
  const known = new Set(["R1"]);

  it("takes no answer, merge or acceptance past a request that is waiting", async () => {
    const { run, state, priv } = idle();
    state.tasks.push(...[task("T1"), task("T2", { assignee: "dev-2" })].map((p) => ({ ...structuredClone(p), group: null, status: "escalated", attempt: 1, reviewRound: 0, base: null, code: null, codeSummary: null, notes: [], tests: {}, candidate: null, reviewer: null, review: null, checks: [], guidance: null, trouble: null, question: null, lastFailureKeys: [], stalls: 0, conflicts: [], history: [] }) as never));
    state.tasks[1]!.status = "escalated";
    const x = requestException(gov(state), { from: "dev-1", ruleIds: ["R1"], reason: "No fit", work: { task: "T1" }, known });
    expect(x.ok).toBe(true);
    // A question about T1 (the held task) and one about T2 (not held).
    state.escalations.push(
      { id: "T1-E1", task: "T1", reason: "question", text: "q1", to: "pm", told: false, answer: null },
      { id: "T2-E1", task: "T2", reason: "question", text: "q2", to: "pm", told: false, answer: null },
    );
    (priv.answerEscalation as (id: string, a: string) => void).call(run, "T1-E1" as never, "go ahead" as never);
    (priv.answerEscalation as (id: string, a: string) => void).call(run, "T2-E1" as never, "go ahead" as never);
    expect(state.escalations.find((e) => e.id === "T1-E1")!.answer).toBeNull();
    expect(state.tasks[0]!.status).toBe("escalated");
    expect(state.escalations.find((e) => e.id === "T2-E1")!.answer).toBe("go ahead");
    // The PM is asked about the request itself, not about the question of the held task.
    state.pmSeen = state.messages.length;
    expect((priv.pmOccasion as () => unknown).call(run)).toEqual({ kind: "rule_exception" });
    expect(state.escalations.find((e) => e.id === "T1-E1")!.told).toBe(false);
  });

  it("does not start the integration's step, ask for acceptance or write the result while a unit of work is held", async () => {
    const { run, state, priv } = idle();
    const advance = priv.advance as () => Promise<boolean>;
    state.integration = { commit: "c0ffee", checks: [{ by: "qa-1", verdict: "pass", summary: "ok", failures: [] }], triage: false, trouble: null, triageGroups: [] };
    state.verifiedTree = "feed";
    state.acceptance = { criteria: [], summary: "s" };
    const x = requestException(gov(state), { from: "qa-1", ruleIds: ["R1"], reason: "No fit", work: { unit: { kind: "integration", id: "run" } }, known });
    expect(x.ok).toBe(true);
    for (const phase of ["INTEGRATION", "ACCEPTANCE", "APPLY"] as const) {
      state.phase = phase;
      state.accepted = phase === "APPLY";
      // Held: nothing happens (no verified tree is taken, no approval is asked, nothing is written).
      expect(await advance.call(run), phase).toBe(false);
      expect(state.phase).toBe(phase);
      expect(state.waiting).toBeNull();
      expect(state.applied).toBeNull();
    }
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("holds the work behind a settled escalation while the user has not answered the PM's question about it, also after a reload", async () => {
    const { run, state, priv } = idle();
    const full = (id: string, over: object = {}) => ({ ...structuredClone(task(id)), group: null, status: "triage", attempt: 1, reviewRound: 0, base: null, code: null, codeSummary: null, notes: [], tests: {}, candidate: null, reviewer: null, review: null, checks: [], guidance: null, trouble: null, question: null, lastFailureKeys: [], stalls: 0, conflicts: [], history: [], ...over }) as never;
    state.tasks.push(full("T1"), full("T2", { assignee: "dev-2" }));
    state.escalations.push(
      { id: "T1-E1", task: "T1", reason: "task_limit", text: "T1 fails", to: "pm", told: true, answer: null },
      { id: "E1", task: null, group: null, reason: "planning", text: "planning does not converge", to: "pm", told: true, answer: null },
    );
    (priv.answerEscalation as (id: string, a: string) => void).call(run, "T1-E1" as never, "try again" as never);
    (priv.answerEscalation as (id: string, a: string) => void).call(run, "E1" as never, "keep going" as never);
    expect(state.governance.incidents.map((i) => [i.id, i.status, "escalationId" in i.source ? i.source.escalationId : null])).toEqual([["I1", "resolved", "T1-E1"], ["I2", "resolved", "E1"]]);
    const ask = (incident: string) => ({ ...teamPm.ruleQuestion({ incidentId: incident }).action }) as never;
    (priv.pmRuleQuestion as (a: never) => void).call(run, ask("I1"));
    (priv.pmRuleQuestion as (a: never) => void).call(run, ask("I2"));
    const reloaded = stateOf();
    expect(reloaded.governance.incidents[0]!.direction!.scope).toMatchObject({ taskIds: ["T1"], unit: null });
    expect(reloaded.governance.incidents[1]!.direction!.scope).toMatchObject({ taskIds: [], unit: { kind: "planning", id: "ungrouped" } });
    expect([...heldTaskIds(reloaded)]).toEqual(["T1"]);
    expect(unitHeld(reloaded, planningUnit(null))).toBe(true);
    // T1 does not run (no job for it), T2 does; an answer releases it.
    const jobs = boardJobs(reloaded, { members: run.members, busy: new Set(), running: new Set(), gates: false });
    expect(jobs.filter((j) => "task" in j && j.task === "T1")).toEqual([]);
    expect(jobs.filter((j) => "task" in j && j.task === "T2").length).toBeGreaterThan(0);
  });

  it("decides nothing by an answer to another request, a repeated one or one that came late", async () => {
    rulesOf().append(SEED);
    fake.setScenario(devAsks());
    const answers: Array<() => void> = [];
    const d: ClarificationDecider = {
      askClarification: ({ request }) => {
        if (request.questions[0]!.header !== "Exception") return user().askClarification({ request });
        return new Promise<ClarificationResponse>((resolve) => {
          answers.push(() => resolve({ kind: "answered", answers: [{ questionId: request.questions[0]!.id, optionIds: ["reject"], otherText: null }] }));
        });
      },
    };
    const run = teamRun({ decider: d });
    const done = run.run();
    await waitFor("the request", () => pending().length === 1);
    const request = stateOf().clarifications.find((c) => c.source === "team" && c.questions[0]!.header === "Exception")!;
    const priv = run as unknown as { exceptionAnswered(r: ClarificationRequest, resp: ClarificationResponse): void };
    const approve = (r: ClarificationRequest): ClarificationResponse => ({ kind: "answered", answers: [{ questionId: r.questions[0]!.id, optionIds: ["approve"], otherText: null }] });
    // An answer to another request (a brief's, the PM's question, one that never was): nothing.
    const other = stateOf().clarifications.find((c) => c.questions[0]!.header === "Brief")!;
    priv.exceptionAnswered(other as never, approve(other as never));
    priv.exceptionAnswered({ ...request, id: "tq-made-up" } as never, approve(request as never));
    expect(run.state.governance.exceptions[0]!.decision!.status).toBe("pending");
    // The user's answer comes: refused. A repeated answer, now approving, changes nothing.
    answers[0]!();
    expect(await done).toBe("done");
    priv.exceptionAnswered(request as never, approve(request as never));
    expect(stateOf().governance.exceptions[0]!.decision).toMatchObject({ status: "rejected", by: "user" });
    expect(exceptionsFor(stateOf(), { task: "T1" })).toEqual([]);
  });

  it("never reads the PM's proposal as the user's approval, in the state or in the prompts", () => {
    const { state } = idle();
    state.tasks.push(structuredClone({ ...task("T1"), group: null, status: "coding", attempt: 1, reviewRound: 0, base: null, code: null, codeSummary: null, notes: [], tests: {}, candidate: null, reviewer: null, review: null, checks: [], guidance: null, trouble: null, question: null, lastFailureKeys: [], stalls: 0, conflicts: [], history: [] }) as never);
    const ex = requestException(gov(state), { from: "dev-1", ruleIds: ["R1"], reason: "No fit", alternative: "Other", work: { task: "T1" }, known });
    if (!ex.ok) throw new Error(ex.reason);
    expect(assessException(gov(state), "X1", { by: "pm", ruleIds: ["R1"], reason: "No fit", alternative: "Other", taskIds: ["T1"], unit: null, summary: "s", known }).ok).toBe(true);
    expect(presentException(gov(state), "X1", "tq-1").ok).toBe(true);
    expect(exceptionsFor(gov(state), { task: "T1" })).toEqual([]);
  });
});
