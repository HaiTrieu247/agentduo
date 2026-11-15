// A team's rules over its life (T6, AC1–AC8 end to end): what one run settles, its PM writes into the team's RULES.md; the
// next runs of the same team read it; a member asks for an exception to that rule, which the user puts off, the run stops
// and is reopened, and the user's approval covers that task of that run only; another team never sees the rule, and a later
// run of the same team inherits no approval. Fake CLIs, real git worktrees, the run's own decider path.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClarificationRequest, ClarificationResponse } from "../../src/clarification/clarification.js";
import { EventBus, type ClarificationDecider } from "../../src/events.js";
import { exceptionsFor } from "../../src/team/rule-governance.js";
import { TeamRules, teamRulesDir } from "../../src/team/rules.js";
import { TeamStore, type TeamState } from "../../src/team/state.js";
import { TeamRun } from "../../src/team/team.js";
import { testConfig, userDataEnv } from "../helpers/config.js";
import { FakeClis, type FakeCall } from "../helpers/fake-clis.js";
import { makeRepo } from "../helpers/repo.js";
import { askException, brief, task, teamCheck, teamPlan, teamPm, teamReview, teamTests, teamWork } from "../helpers/team-builders.js";
import { tempDir } from "../helpers/tmp.js";

let t: { path: string; cleanup(): void };
let fake: FakeClis;
let repo: string;

beforeEach(() => {
  t = tempDir();
  fake = new FakeClis(t.path).install();
  repo = makeRepo(t.path);
});
afterEach(() => {
  fake.restore();
  t.cleanup();
});

const runsDir = () => join(repo, ".agentduo", "runs");
const env = () => ({ ...process.env, ...userDataEnv(join(t.path, "data")) });
const rulesOf = (teamId = "default") => new TeamRules(teamRulesDir(env(), repo, teamId));
const stateOf = (): TeamState => TeamStore.open(runsDir(), "latest").load();

/** The user: the first option of every request, except an exception request, answered as scripted (approve, refuse, put off). */
function user(exception: Array<"approve" | "reject" | "defer"> = []): ClarificationDecider & { asked: ClarificationRequest[] } {
  const asked: ClarificationRequest[] = [];
  return {
    asked,
    askClarification: async ({ request }): Promise<ClarificationResponse> => {
      asked.push(request);
      const q = request.questions[0]!;
      const reply = q.header === "Exception" ? exception.shift() : undefined;
      if (reply === "defer") return { kind: "defer" };
      return { kind: "answered", answers: request.questions.map((x) => ({ questionId: x.id, optionIds: [reply ?? x.options[0]!.id], otherText: null })) };
    },
  };
}

function teamRun(decider: ClarificationDecider, teamId?: string) {
  const cfg = testConfig(fake, { gates: [] });
  if (teamId) cfg.team.id = teamId;
  // Each run starts its scripts from the first answer of each role (a resume goes on where its run left off).
  rmSync(fake.env.FAKE_COUNTS!, { force: true });
  return TeamRun.create({ runsDir: runsDir(), request: "Add subtraction, and document it", cfg, workspace: repo, bus: new EventBus(), decider, env: env(), reportIntervalMs: 0 });
}

const resume = (decider: ClarificationDecider) =>
  TeamRun.resume({ runsDir: runsDir(), id: "latest", workspace: repo, bus: new EventBus(), decider, env: env(), reportIntervalMs: 0 });

const two = brief(["Subtraction works", "It is documented"]);
const acceptance = {
  message: "Both criteria are met.",
  action: { kind: "acceptance", criteria: [{ id: "AC1", status: "met", evidence: "qa-1: C1" }, { id: "AC2", status: "met", evidence: "qa-1: C2" }], summary: "Done." },
};
const base = {
  team_pm_conversation: [{ output: teamPm.brief(two) }, { output: teamPm.none("Noted.") }],
  team_pm_plan_review: [{ output: teamPm.planReview(true) }],
  team_pm_reports: [{ output: teamPm.none("Progress.") }],
  team_pm_acceptance: [{ output: acceptance }],
  team_tests: [{ output: teamTests(), write: { "test/qa.txt": "tests\n" } }],
  team_review: [{ output: teamReview("approve") }],
  team_check: [{ output: teamCheck("pass") }],
};
const oneTask = teamPlan([task("T1", { assignee: "dev-1", criteria: ["AC1", "AC2"], area: ["app.txt"] })]);
const twoTasks = teamPlan([
  task("T1", { assignee: "dev-1", criteria: ["AC1"], area: ["app.txt"] }),
  task("T2", { assignee: "dev-2", criteria: ["AC2"], area: ["docs.md"] }),
]);

const LEARNT = "A reviewer names the file and the criterion of every change it asks for.";
const ruleLine = `- R1: ${LEARNT}`;
const memberCalls = (calls: FakeCall[]) => calls.filter((c) => c.member && c.member !== "pm");
const forTask = (c: FakeCall, id: string) => c.prompt.includes(`## Task ${id}:`);

describe("a team's rules across its runs (AC1–AC8)", () => {
  it("learns a rule in one run, reads it in the next, holds an exception to it across a stop until the user approves it for one task, and keeps it from other teams and later runs", async () => {
    // Run 1: the reviewer and dev-1 disagree, the review approves the fix, and the PM writes the lesson (no rule was seeded).
    fake.setScenario({
      ...base,
      team_plan: [{ output: oneTask }],
      team_review: [{ output: teamReview("changes") }, { output: teamReview("approve") }],
      "team_work:dev-1": [{ output: teamWork(), write: { "app.txt": "first\n" } }, { output: teamWork(), write: { "app.txt": "fixed\n" } }],
      team_pm_rule_lesson: [{ output: teamPm.ruleLesson("I1", LEARNT, "Vague change requests cost a round.") }],
    });
    expect(await teamRun(user()).run()).toBe("done");
    const first = stateOf();
    expect(first.governance.incidents.map((i) => [i.id, i.kind, i.status])).toEqual([["I1", "disagreement", "recorded"]]);
    expect(rulesOf().rules()).toMatchObject([{ id: "R1", text: LEARNT, opId: `lesson:${first.id}:I1` }]);
    const learnt = readFileSync(rulesOf().path, "utf8");

    // Run 2, same team: every member call has the rule. dev-1 asks to depart from it on T1, and the user puts the decision off.
    fake.setScenario({
      ...base,
      team_plan: [{ output: twoTasks }],
      "team_work:dev-1": [{ output: teamWork("done", null, askException(["R1"])), write: { "app.txt": "partial\n" } }, { output: teamWork(), write: { "app.txt": "fixed again\n" } }],
      "team_work:dev-2": [{ output: teamWork(), write: { "docs.md": "# sub\n" } }],
      team_pm_rule_exception: [{ output: teamPm.exceptionProposal("X1") }],
    });
    const run2Start = fake.calls().length;
    const putOff = user(["defer"]);
    expect(await teamRun(putOff).run()).toBe("waiting");
    let second = stateOf();
    expect(second.id).not.toBe(first.id);
    expect(second.rulesStore).toMatchObject({ teamId: "default" });
    const shown = putOff.asked.filter((r) => r.questions[0]!.header === "Exception");
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ source: "team", member: "pm" });
    expect(shown[0]!.questions[0]!.question).toContain(`R1 (${LEARNT})`);
    expect(second.governance.exceptions).toMatchObject([{ id: "X1", from: "dev-1", ruleIds: ["R1"], decision: { status: "pending", delivered: false } }]);
    // Put off is not approval: T1 waits (dev-1 was not called again), the independent T2 merged, and nothing was written.
    expect(second.tasks.map((x) => [x.id, x.status])).toEqual([["T1", "coding"], ["T2", "merged"]]);
    expect(exceptionsFor(second, { task: "T1" })).toEqual([]);
    expect(second.applied).toBeNull();
    expect(fake.calls().slice(run2Start).filter((c) => c.role === "team_work" && c.member === "dev-1")).toHaveLength(1);

    // Reopened (a new process): the very same request is asked again; the user approves it.
    const later = user(["approve"]);
    expect(await resume(later).run()).toBe("done");
    const reasked = later.asked.filter((r) => r.questions[0]!.header === "Exception");
    expect(reasked.map((r) => r.id)).toEqual([shown[0]!.id]);
    second = stateOf();
    expect(second.governance.exceptions[0]!.decision).toMatchObject({ status: "approved", by: "user", delivered: true });
    expect(fake.calls("team_pm_rule_exception")).toHaveLength(1);
    const run2 = fake.calls().slice(run2Start);
    for (const c of memberCalls(run2)) expect(c.prompt, `${c.role} of ${c.member}`).toContain(ruleLine);
    const works = run2.filter((c) => c.role === "team_work" && c.member === "dev-1");
    expect(works).toHaveLength(2);
    expect(works[0]!.prompt).not.toContain("approved by the user");
    expect(works[1]!.prompt).toContain("X1, approved by the user for task T1 only");
    // The approval is T1's only: T2's calls never read it, and the rule itself is unchanged.
    for (const c of memberCalls(run2).filter((x) => forTask(x, "T2"))) expect(c.prompt, `${c.role} of T2`).not.toContain("approved by the user");
    expect(exceptionsFor(second, { task: "T2" })).toEqual([]);
    expect(readFileSync(rulesOf().path, "utf8")).toBe(learnt);
    expect(readFileSync(join(repo, "app.txt"), "utf8")).toBe("fixed again\n");

    // Run 3, another team in the same folder: its own, empty RULES.md; the default team's rule is never given.
    fake.setScenario({ ...base, team_plan: [{ output: oneTask }], "team_work:dev-1": [{ output: teamWork(), write: { "app.txt": "other team\n" } }] });
    const run3Start = fake.calls().length;
    expect(await teamRun(user(), "other").run()).toBe("done");
    expect(rulesOf("other").rules()).toEqual([]);
    for (const c of memberCalls(fake.calls().slice(run3Start))) {
      expect(c.prompt, `${c.role} of ${c.member}`).not.toContain(LEARNT);
      expect(c.prompt).toContain("(none yet)");
    }

    // Run 4, the default team again: the rule is there, the approval of run 2 is not (a new run, the same task id).
    fake.setScenario({ ...base, team_plan: [{ output: oneTask }], "team_work:dev-1": [{ output: teamWork(), write: { "app.txt": "fourth\n" } }] });
    const run4Start = fake.calls().length;
    expect(await teamRun(user()).run()).toBe("done");
    const fourth = stateOf();
    expect(fourth.governance.exceptions).toEqual([]);
    expect(exceptionsFor(fourth, { task: "T1" })).toEqual([]);
    for (const c of memberCalls(fake.calls().slice(run4Start))) {
      expect(c.prompt, `${c.role} of ${c.member}`).toContain(ruleLine);
      expect(c.prompt).not.toContain("approved by the user");
    }
    expect(rulesOf().rules().map((r) => r.id)).toEqual(["R1"]);
    expect(readFileSync(rulesOf().path, "utf8")).toBe(learnt);
  }, 120_000); // five team runs, each with its own agent processes and git worktrees: 8 s on a Mac, 20–31 s on Windows CI

  it("asks a refused exception no more in the run, and the next run's member may ask again (a new request, undecided)", async () => {
    rulesOf().append({ opId: "seed:1", text: LEARNT, incident: "an earlier run" });
    const scenario = {
      ...base,
      team_plan: [{ output: twoTasks }],
      "team_work:dev-1": [{ output: teamWork("done", null, askException(["R1"])), write: { "app.txt": "partial\n" } }, { output: teamWork(), write: { "app.txt": "by the rules\n" } }],
      "team_work:dev-2": [{ output: teamWork(), write: { "docs.md": "# sub\n" } }],
      team_pm_rule_exception: [{ output: teamPm.exceptionProposal("X1") }],
    };
    fake.setScenario(scenario);
    const start = fake.calls().length;
    expect(await teamRun(user(["reject"])).run()).toBe("done");
    const refused = stateOf();
    expect(refused.governance.exceptions[0]!.decision).toMatchObject({ status: "rejected", by: "user", delivered: true });
    const works = fake.calls().slice(start).filter((c) => c.role === "team_work" && c.member === "dev-1");
    expect(works).toHaveLength(2);
    expect(works[1]!.prompt).toContain("X1 (R1): refused. The rules stand");
    expect(readFileSync(join(repo, "app.txt"), "utf8")).toBe("by the rules\n");

    // The next run: the refusal was that run's; the same request is a new one, shown to the user again, and grants nothing until answered.
    fake.setScenario(scenario);
    const putOff = user(["defer"]);
    expect(await teamRun(putOff).run()).toBe("waiting");
    const next = stateOf();
    expect(next.id).not.toBe(refused.id);
    expect(next.governance.exceptions).toMatchObject([{ id: "X1", decision: { status: "pending" } }]);
    expect(putOff.asked.filter((r) => r.questions[0]!.header === "Exception")).toHaveLength(1);
    expect(exceptionsFor(next, { task: "T1" })).toEqual([]);
  });
});
