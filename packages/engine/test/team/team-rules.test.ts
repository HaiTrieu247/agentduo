// The team's rules inside a team run (T4): RULES.md is the team's, read before every member call, and the PM adds to it
// after an incident the run settled (a disagreement, a mistake against what the user asked), only through its structured
// action. Fake CLIs, real git worktrees; the stops between writing RULES.md and saving the state are made on the files.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClarificationRequest, ClarificationResponse } from "../../src/clarification/clarification.js";
import { EventBus, type ClarificationDecider, type DuoEvent } from "../../src/events.js";
import { beginLesson, recordIncident, resolveIncident } from "../../src/team/rule-governance.js";
import { TeamRules, teamRulesDir } from "../../src/team/rules.js";
import { TeamStore } from "../../src/team/state.js";
import { TeamRun, undoTeam } from "../../src/team/team.js";
import { testConfig, userDataEnv } from "../helpers/config.js";
import { FakeClis } from "../helpers/fake-clis.js";
import { git, makeRepo } from "../helpers/repo.js";
import { recordRuleReads } from "../helpers/rule-reads.js";
import { rulesInForce, sessionHeld } from "../helpers/session-held.js";
import { brief, reportIssue, task, teamCheck, teamPlan, teamPm, teamReview, teamTests, teamTriage, teamWork } from "../helpers/team-builders.js";
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
  vi.restoreAllMocks();
  fake.restore();
  t.cleanup();
});

const runsDir = () => join(repo, ".agentduo", "runs");
const env = () => ({ ...process.env, ...userDataEnv(join(t.path, "data")) });
/** The team's rules store, as the run opens it. */
const rulesOf = (teamId = "default") => new TeamRules(teamRulesDir(env(), repo, teamId));
const stateOf = () => TeamStore.open(runsDir(), "latest").load();

/** Approves everything (the brief, the plan, the acceptance). */
function decider(): ClarificationDecider {
  return {
    askClarification: async ({ request }: { request: ClarificationRequest }): Promise<ClarificationResponse> => ({
      kind: "answered", answers: request.questions.map((q) => ({ questionId: q.id, optionIds: [q.options[0]!.id], otherText: null })),
    }),
  };
}

/** A team run; `reportIntervalMs` (0 here unless given) is also how long lessons wait for more incidents while members work. */
function teamRun(o: { teamId?: string; reportIntervalMs?: number } = {}) {
  const cfg = testConfig(fake, { gates: [] });
  if (o.teamId) cfg.team.id = o.teamId;
  return TeamRun.create({
    runsDir: runsDir(), request: "Add subtraction, and document it", cfg, workspace: repo, bus, decider: decider(), env: env(), reportIntervalMs: o.reportIntervalMs ?? 0,
  });
}

function resume() {
  return TeamRun.resume({ runsDir: runsDir(), id: "latest", workspace: repo, bus: new EventBus(), decider: decider(), env: env(), reportIntervalMs: 0 });
}

const two = brief(["Subtraction works", "It is documented"]);
const oneTask = teamPlan([task("T1", { assignee: "dev-1", criteria: ["AC1", "AC2"], area: ["app.txt"] })]);
const acceptance = {
  message: "Both criteria are met.",
  action: { kind: "acceptance", criteria: [{ id: "AC1", status: "met", evidence: "qa-1: C1" }, { id: "AC2", status: "met", evidence: "qa-1: C2" }], summary: "Done." },
};

const happy = (over: Record<string, unknown> = {}) => ({
  team_pm_conversation: [{ output: teamPm.brief(two) }],
  team_plan: [{ output: oneTask }],
  team_pm_plan_review: [{ output: teamPm.planReview(true) }],
  team_pm_reports: [{ output: teamPm.none("Progress.") }],
  team_pm_acceptance: [{ output: acceptance }],
  "team_work:dev-1": [{ output: teamWork(), write: { "app.txt": "fixed\n" } }],
  team_tests: [{ output: teamTests(), write: { "test/qa.txt": "tests\n" } }],
  team_review: [{ output: teamReview("approve") }],
  team_check: [{ output: teamCheck("pass") }],
  ...over,
});

const SEED = { opId: "seed:1", text: "Always say which criterion a change serves.", incident: "an earlier run" };

/** Stops the run while dev-1 works, as Esc does, to change what is stored before the next run. */
async function stopWhileWorking(run: TeamRun): Promise<void> {
  bus.on((e) => {
    if (e.type === "team.member" && e.member === "dev-1" && e.job === "work" && e.state === "busy") setTimeout(() => run.stop(), 300);
  });
  expect(await run.run()).toBe("stopped");
}

const stoppableScenario = (over: Record<string, unknown> = {}) =>
  happy({ "team_work:dev-1": [{ output: teamWork(), write: { "app.txt": "fixed\n" }, sleep: 3000 }], ...over });

describe("the team's RULES.md in a run (AC1)", () => {
  it("creates the team's RULES.md when it has none, names it in the run, and a later run of the same team reads what is stored", async () => {
    fake.setScenario(happy());
    expect(existsSync(rulesOf().path)).toBe(false);
    expect(await teamRun().run()).toBe("done");
    expect(existsSync(rulesOf().path)).toBe(true);
    expect(stateOf().rulesStore).toMatchObject({ teamId: "default" });
    rulesOf().append(SEED);
    fake.setScenario(happy());
    expect(await teamRun().run()).toBe("done");
    expect(rulesOf().rules().map((r) => r.text)).toEqual([SEED.text]);
    // The second run's calls have it (a continued one in its session, from the turn it was given).
    const held = sessionHeld(fake.calls());
    expect(held.slice(-5).every((text) => text.includes(SEED.text))).toBe(true);
  });

  it("keeps two teams' rules apart", async () => {
    rulesOf().append(SEED);
    fake.setScenario(happy());
    expect(await teamRun({ teamId: "other" }).run()).toBe("done");
    expect(stateOf().rulesStore).toMatchObject({ teamId: "other" });
    expect(rulesOf("other").rules()).toEqual([]);
    expect(rulesOf("other").path).not.toBe(rulesOf().path);
    for (const c of fake.calls().filter((x) => x.member)) {
      expect(c.prompt, `${c.role} of ${c.member}`).not.toContain(SEED.text);
      expect(c.prompt).toContain("(none yet)");
    }
    expect(rulesOf().rules().map((r) => r.text)).toEqual([SEED.text]);
  });

  it("keeps the team's rules when the result is taken back out and the run's worktrees are gone", async () => {
    rulesOf().append(SEED);
    fake.setScenario(happy());
    expect(await teamRun().run()).toBe("done");
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
    const before = readFileSync(rulesOf().path, "utf8");
    const undone = await undoTeam({ runsDir: runsDir(), workspace: repo, id: stateOf().id, env: env() });
    expect("restored" in undone).toBe(true);
    expect(readFileSync(rulesOf().path, "utf8")).toBe(before);
  });
});

describe("every call gets the current rules (AC2)", () => {
  it("gives them to every member call, the fresh ones and the ones that continue a session", async () => {
    rulesOf().append(SEED);
    fake.setScenario(happy());
    expect(await teamRun().run()).toBe("done");
    const all = fake.calls();
    const held = sessionHeld(all);
    const calls = all.map((c, i) => ({ c, held: held[i]! })).filter(({ c }) => c.member);
    expect(calls.length).toBeGreaterThan(6);
    expect(calls.some(({ c }) => c.resumed)).toBe(true);
    for (const { c, held } of calls) {
      const name = `${c.role} of ${c.member}${c.resumed ? " (continued)" : ""}`;
      expect(c.prompt, name).toContain("## The team's rules");
      // A fresh session is given the rule; one that goes on holds it from an earlier turn and is told it is in force.
      expect(held, name).toContain(`- R1: ${SEED.text}`);
      if (c.resumed) expect(rulesInForce(c.prompt), name).toEqual(["R1"]);
      else expect(c.prompt, name).toContain(`- R1: ${SEED.text}`);
    }
  });

  it("gives a session the CLI compacted the whole prompt again in its next turn: the introduction, the identity and every rule", async () => {
    rulesOf().append(SEED);
    fake.setScenario(happy({
      team_review: [{ output: teamReview("changes") }, { output: teamReview("approve") }],
      "team_work:dev-1": [{ output: teamWork(), write: { "app.txt": "first\n" }, compact: true }, { output: teamWork(), write: { "app.txt": "fixed\n" } }],
      team_pm_rule_lesson: [{ output: teamPm.ruleLesson("I1", "A reviewer names the file of every change it asks for.") }],
    }));
    expect(await teamRun().run()).toBe("done");
    const works = fake.calls("team_work").filter((c) => c.member === "dev-1");
    expect(works).toHaveLength(2);
    // The same session goes on, but its earlier turns are a summary now: it is given what a fresh one is.
    expect(works[1]!.resumed).toBe(works[0]!.session);
    expect(works[1]!.prompt).not.toContain("This message continues your session");
    expect(works[1]!.prompt).toContain("You are dev-1");
    expect(works[1]!.prompt).toContain(`- R1: ${SEED.text}`);
    expect(works[1]!.prompt).toContain("## Task T1");
  });

  it("gives them to the fresh session a failed resume falls back to", async () => {
    rulesOf().append(SEED);
    fake.setScenario(stoppableScenario());
    await stopWhileWorking(teamRun());
    // The CLIs lost every session the stopped run kept: each continued call fails and falls back to a whole prompt.
    const kept = Object.values(stateOf().sessions);
    expect(kept.length).toBeGreaterThan(0);
    for (const k of kept) fake.forget(k.id);
    // (A lost resume is logged without its member: it failed before the CLI took a turn.)
    const before = fake.calls().length;
    expect(await resume().run()).toBe("done");
    const all = fake.calls();
    const held = sessionHeld(all);
    const calls = all.slice(before);
    expect(calls.some((c) => c.lost)).toBe(true);
    // A lost resume reached no model; every call that did has the rule in its session.
    calls.forEach((c, i) => { if (!c.lost) expect(held[before + i], `${c.role} of ${c.member}`).toContain(`- R1: ${SEED.text}`); });
    // The fallback is a fresh session, with the identity and the whole prompt (the rules' text among it).
    const fallbacks = calls.filter((c) => !c.resumed && !c.lost);
    expect(fallbacks.length).toBeGreaterThan(0);
    for (const c of fallbacks) expect(c.prompt, `${c.role} of ${c.member}`).toContain(`- R1: ${SEED.text}`);
  });

  it("gives a rule added while the run is stopped to the calls of the reopened run, and not to the earlier ones", async () => {
    rulesOf().append(SEED);
    fake.setScenario(stoppableScenario());
    await stopWhileWorking(teamRun());
    const before = fake.calls().filter((c) => c.member).length;
    expect(before).toBeGreaterThan(0);
    const added = rulesOf().append({ opId: "added:1", text: "Never leave a task without a test.", incident: "added by the PM" }).rule;
    expect(added.id).toBe("R2");
    expect(await resume().run()).toBe("done");
    const all = fake.calls();
    const held = sessionHeld(all);
    const calls = all.map((c, i) => ({ c, held: held[i]! })).filter(({ c }) => c.member);
    for (const { c } of calls.slice(0, before)) expect(c.prompt, `${c.role} before`).not.toContain(added.text);
    const after = calls.slice(before);
    expect(after.length).toBeGreaterThan(0);
    for (const { c, held } of after) {
      expect(held, `${c.role} of ${c.member} after`).toContain(`- R2: ${added.text}`);
      expect(held).toContain(`- R1: ${SEED.text}`);
      if (c.resumed) expect(rulesInForce(c.prompt)).toEqual(["R1", "R2"]);
    }
  });

  it("reads the same team after the configuration changed, because the run names its team", async () => {
    rulesOf().append(SEED);
    fake.setScenario(stoppableScenario());
    await stopWhileWorking(teamRun());
    const cfg = testConfig(fake, { gates: [] });
    cfg.team.id = "elsewhere";
    const again = TeamRun.resume({ runsDir: runsDir(), id: "latest", workspace: repo, bus: new EventBus(), cfg, decider: decider(), env: env(), reportIntervalMs: 0 });
    expect(await again.run()).toBe("done");
    expect(rulesOf("elsewhere").rules()).toEqual([]);
    expect(stateOf().rulesStore).toMatchObject({ teamId: "default" });
  });
});

describe("the PM learns from what was settled (AC3)", () => {
  it("adds a rule after a disagreement was settled, keeping the earlier rules, and gives it to the calls that follow", async () => {
    rulesOf().append(SEED);
    const seeded = readFileSync(rulesOf().path, "utf8");
    const lesson = "A reviewer names the file and the criterion of every change it asks for.";
    const reads = recordRuleReads(() => rulesOf());
    fake.setScenario(happy({
      team_review: [{ output: teamReview("changes") }, { output: teamReview("approve") }],
      "team_work:dev-1": [{ output: teamWork(), write: { "app.txt": "first\n" } }, { output: teamWork(), write: { "app.txt": "fixed\n" } }],
      team_pm_rule_lesson: [{ output: teamPm.ruleLesson("I1", lesson, "Vague requests cost a round.") }],
    }));
    expect(await teamRun().run()).toBe("done");
    const state = stateOf();
    expect(state.governance.incidents).toHaveLength(1);
    const incident = state.governance.incidents[0]!;
    expect(incident).toMatchObject({ id: "I1", kind: "disagreement", status: "recorded", lesson: { ruleId: "R2" }, source: { kind: "review", task: "T1" } });
    expect(incident.resolution).toContain("approved");
    // RULES.md: what it held stays byte for byte, the new rule is after it, with where it came from.
    const now = readFileSync(rulesOf().path, "utf8");
    expect(now.startsWith(seeded)).toBe(true);
    const rules = rulesOf().rules();
    expect(rules.map((r) => r.id)).toEqual(["R1", "R2"]);
    expect(rules[1]).toMatchObject({ text: lesson, opId: `lesson:${state.id}:I1` });
    expect(rules[1]!.incident).toContain(state.id);
    expect(rules[1]!.incident).toContain("I1");
    // The PM's turn came before the run ended, and the rule reached every call that started once it was written (the PM's
    // own included). A call already on its way then (the lesson turn runs beside the jobs started with it) has the rules it read.
    expect(fake.calls("team_pm_rule_lesson")).toHaveLength(1);
    expect(fake.calls("team_pm_rule_lesson")[0]!.prompt).toContain("rule_lesson");
    expect(events.at(-1)).toMatchObject({ type: "team.finished", outcome: "done" });
    const later = reads.filter((r) => r.rules.includes(lesson));
    expect(later.length).toBeGreaterThan(0);
    // The whole prompt has its text; a continued one names it in force (with its text when the session was not given it yet).
    for (const r of later) {
      expect(r.prompts[0], r.schema ?? undefined).toContain("R2: A reviewer names the file and the criterion");
      for (const prompt of r.prompts.slice(1)) expect(rulesInForce(prompt), r.schema ?? undefined).toEqual(["R1", "R2"]);
    }
  });

  it("adds a rule after a deviation a member reported was settled, naming only rules the team has", async () => {
    rulesOf().append(SEED);
    fake.setScenario(happy({
      "team_work:dev-1": [{ output: teamWork("done", null, reportIssue("deviation", "The task asked for floats but the brief says integers.", ["R1", "R99"])), write: { "app.txt": "fixed\n" } }],
      team_pm_rule_lesson: [{ output: teamPm.ruleLesson("I1", "A task's description repeats the brief's constraints it depends on.") }],
    }));
    expect(await teamRun().run()).toBe("done");
    const incident = stateOf().governance.incidents[0]!;
    expect(incident).toMatchObject({ kind: "deviation", status: "recorded", reportedBy: "dev-1", ruleIds: ["R1"], source: { kind: "member_report", member: "dev-1", task: "T1" } });
    expect(incident.resolution).toContain("T1");
    expect(rulesOf().rules().map((r) => r.id)).toEqual(["R1", "R2"]);
  });

  it("adds a rule after a failed check was settled by the retry", async () => {
    fake.setScenario(happy({
      team_check: [{ output: teamCheck("fail") }, { output: teamCheck("pass") }],
      team_triage: [{ output: teamTriage("retry") }],
      "team_work:dev-1": [{ output: teamWork(), write: { "app.txt": "broken\n" } }, { output: teamWork(), write: { "app.txt": "fixed\n" } }],
      team_pm_rule_lesson: [{ output: teamPm.ruleLesson("I1", "Run the case that failed before reporting a task done.") }],
    }));
    expect(await teamRun().run()).toBe("done");
    const state = stateOf();
    expect(state.governance.incidents.map((i) => [i.kind, i.source.kind, i.status])).toEqual([["deviation", "check", "recorded"]]);
    expect(rulesOf().rules().map((r) => r.text)).toEqual(["Run the case that failed before reporting a task done."]);
  });

  it("adds a rule after a failed check of the whole result was repaired and passes", async () => {
    fake.setScenario(happy({
      team_check: [{ output: teamCheck("pass") }, { output: teamCheck("fail") }, { output: teamCheck("pass") }],
      team_triage: [{ output: teamTriage("add_tasks", { tasks: [task("T9", { assignee: "dev-2", criteria: ["AC1"], area: ["fix.txt"] })] }) }],
      "team_work:dev-2": [{ output: teamWork(), write: { "fix.txt": "fix\n" } }],
      team_pm_rule_lesson: [{ output: teamPm.ruleLesson("I1", "Check the tasks together before calling the whole result ready.") }],
    }));
    expect(await teamRun().run()).toBe("done");
    expect(fake.calls("team_pm_rule_lesson")).toHaveLength(1);
    const incident = stateOf().governance.incidents[0]!;
    expect(incident).toMatchObject({ id: "I1", kind: "deviation", status: "recorded", lesson: { ruleId: "R1" } });
    expect(incident.source).toMatchObject({ kind: "member_report", task: null });
    expect(incident.resolution).toContain("whole result passes");
    expect(rulesOf().rules().map((r) => r.text)).toEqual(["Check the tasks together before calling the whole result ready."]);
  });

  it("does not write the result or end the run while the lesson is undecided (the PM asked the user, who has not answered), and goes on when the run is reopened", async () => {
    const scenario = () => happy({
      team_check: [{ output: teamCheck("fail") }, { output: teamCheck("pass") }],
      team_triage: [{ output: teamTriage("retry") }],
      "team_work:dev-1": [{ output: teamWork(), write: { "app.txt": "broken\n" } }, { output: teamWork(), write: { "app.txt": "fixed\n" } }],
      // The PM cannot tell what the lesson is and asks the user; once answered (a later run), it writes the rule.
      team_pm_rule_lesson: [{ output: teamPm.ruleQuestion({ incidentId: "I1" }) }, { output: teamPm.ruleLesson("I1", "Run the failing case first.") }],
    });
    // The user puts the question off (closes the window) and approves the rest.
    const putOff: ClarificationDecider = {
      askClarification: async ({ request }) => (request.questions[0]!.header === "Rule" ? { kind: "defer" } : decider().askClarification({ request })),
    };
    fake.setScenario(scenario());
    const first = TeamRun.create({ runsDir: runsDir(), request: "Add subtraction, and document it", cfg: testConfig(fake, { gates: [] }), workspace: repo, bus, decider: putOff, env: env(), reportIntervalMs: 0 });
    expect(await first.run()).toBe("waiting");
    expect(fake.calls("team_pm_rule_lesson")).toHaveLength(1);
    let state = stateOf();
    expect(state.phase).toBe("APPLY");
    expect(state.applied).toBeNull();
    expect(state.governance.incidents[0]).toMatchObject({ status: "resolved", lesson: null, direction: { answer: null } });
    expect(rulesOf().rules()).toEqual([]);
    expect(existsSync(join(repo, "app.txt"))).toBe(false);
    expect(await resume().run()).toBe("done");
    state = stateOf();
    expect(state.governance.incidents[0]).toMatchObject({ status: "recorded", direction: { answer: expect.any(String) } });
    expect(rulesOf().rules().map((r) => r.text)).toEqual(["Run the failing case first."]);
    expect(readFileSync(join(repo, "app.txt"), "utf8")).toBe("fixed\n");
  });

  it("adds a rule after the user's change of the brief was settled by their approval", async () => {
    const asked: string[] = [];
    const d: ClarificationDecider = {
      askClarification: async ({ request }) => {
        asked.push(request.questions[0]!.header);
        const decline = request.questions[0]!.header === "Brief" && asked.filter((h) => h === "Brief").length === 1;
        return { kind: "answered", answers: [{ questionId: request.questions[0]!.id, optionIds: [request.questions[0]!.options[decline ? 1 : 0]!.id], otherText: decline ? "Mention the docs folder" : null }] };
      },
    };
    fake.setScenario(happy({
      team_pm_conversation: [{ output: teamPm.brief(two) }, { output: teamPm.brief(two) }],
      team_pm_rule_lesson: [{ output: teamPm.ruleLesson("I1", "Ask where the docs belong when a brief mentions documentation.") }],
    }));
    const cfg = testConfig(fake, { gates: [] });
    const run = TeamRun.create({ runsDir: runsDir(), request: "Add subtraction, and document it", cfg, workspace: repo, bus, decider: d, env: env(), reportIntervalMs: 0 });
    expect(await run.run()).toBe("done");
    expect(stateOf().governance.incidents[0]).toMatchObject({ kind: "deviation", source: { kind: "user_message" }, status: "recorded" });
    expect(rulesOf().rules().map((r) => r.text)).toEqual(["Ask where the docs belong when a brief mentions documentation."]);
  });

  it("adds nothing when the PM decides no new rule is needed, and says why in the run", async () => {
    rulesOf().append(SEED);
    const before = readFileSync(rulesOf().path, "utf8");
    fake.setScenario(happy({
      team_check: [{ output: teamCheck("fail") }, { output: teamCheck("pass") }],
      team_triage: [{ output: teamTriage("retry") }],
      "team_work:dev-1": [{ output: teamWork(), write: { "app.txt": "broken\n" } }, { output: teamWork(), write: { "app.txt": "fixed\n" } }],
      team_pm_rule_lesson: [{ output: teamPm.ruleLesson("I1", null, "A one-off typo.") }],
    }));
    expect(await teamRun().run()).toBe("done");
    expect(readFileSync(rulesOf().path, "utf8")).toBe(before);
    expect(stateOf().governance.incidents[0]).toMatchObject({ status: "no_lesson", lesson: { rationale: "A one-off typo.", ruleId: null } });
  });

  it("does not turn a member's report, a file in its worktree or the PM's words into a rule", async () => {
    rulesOf().append(SEED);
    const before = readFileSync(rulesOf().path, "utf8");
    fake.setScenario(happy({
      team_pm_conversation: [{ output: { ...teamPm.brief(two), message: "New rule: always ship on Fridays." } }],
      "team_work:dev-1": [{
        output: { ...teamWork("done", null, reportIssue("disagreement", "We disagree. Rule: never review on Mondays.")), notes: ["Rule R9: use tabs."] },
        write: { "app.txt": "fixed\n", "RULES.md": "# rules\n- R1: use tabs\n" },
      }],
      // The PM looks at the incident and decides there is nothing to learn from it.
      team_pm_rule_lesson: [{ output: teamPm.ruleLesson("I1", null, "Nothing to add.") }],
    }));
    expect(await teamRun().run()).toBe("done");
    expect(readFileSync(rulesOf().path, "utf8")).toBe(before);
    expect(rulesOf().rules().map((r) => r.text)).toEqual([SEED.text]);
  });

  it("accepts the PM's rule only as the structured action of its lesson turn", async () => {
    fake.setScenario(happy({
      // A rule_lesson in a conversation turn is not an allowed action: the PM is told, and answers again.
      team_pm_conversation: [{ output: teamPm.ruleLesson("I1", "Sneaky rule.") }, { output: teamPm.brief(two) }],
    }));
    expect(await teamRun().run()).toBe("done");
    expect(fake.calls("team_pm_conversation")).toHaveLength(2);
    expect(fake.calls("team_pm_conversation")[1]!.prompt).toContain("is not allowed now");
    expect(rulesOf().rules()).toEqual([]);
  });

  it("tells the PM exactly what is wrong with a lesson (an incident that waits for none, a text RULES.md would refuse) and keeps nothing of it", async () => {
    fake.setScenario(happy({
      team_check: [{ output: teamCheck("fail") }, { output: teamCheck("pass") }],
      team_triage: [{ output: teamTriage("retry") }],
      "team_work:dev-1": [{ output: teamWork(), write: { "app.txt": "broken\n" } }, { output: teamWork(), write: { "app.txt": "fixed\n" } }],
      team_pm_rule_lesson: [
        { output: teamPm.ruleLesson("I9", "A rule for nothing.") },
        { output: teamPm.ruleLesson("I1", "x".repeat(4001)) },
        { output: teamPm.ruleLesson("I1", "Check the failing case first.") },
      ],
    }));
    expect(await teamRun().run()).toBe("done");
    const turns = fake.calls("team_pm_rule_lesson");
    expect(turns).toHaveLength(3);
    expect(turns[1]!.prompt).toContain("'I9' is not an incident waiting for a lesson (I1)");
    expect(turns[2]!.prompt).toContain("a rule's text is at most 4000 characters");
    expect(rulesOf().rules().map((r) => r.text)).toEqual(["Check the failing case first."]);
  });
});

describe("the PM learns from several incidents in one turn", () => {
  const RULE_A = "A reviewer names the file and the criterion of every change it asks for.";
  const RULE_B = "A task's description repeats the brief's constraints it depends on.";
  const twoTasks = teamPlan([
    task("T1", { assignee: "dev-1", criteria: ["AC1"], area: ["app.txt"] }),
    task("T2", { assignee: "dev-2", criteria: ["AC2"], area: ["docs.md"] }),
  ]);
  /**
   * Two incidents that settle at different moments while the team works: the techlead asks for changes to dev-1's T1 (settled
   * when the fix is approved), and dev-2 reports a deviation in T2 (settled when T2 merges). Which is I1 depends on timing.
   */
  const twoIncidents = (lessons: unknown[]) => happy({
    team_plan: [{ output: twoTasks }],
    "team_review:techlead": [{ output: teamReview("changes") }, { output: teamReview("approve") }],
    "team_work:dev-1": [{ output: teamWork(), write: { "app.txt": "first\n" } }, { output: teamWork(), write: { "app.txt": "fixed\n" } }],
    "team_work:dev-2": [{ output: teamWork("done", null, reportIssue("deviation", "The task asked for floats but the brief says integers.")), write: { "docs.md": "# sub\n" } }],
    team_pm_rule_lesson: lessons.map((output) => ({ output })),
  });

  it("waits while members work and answers every incident settled meanwhile in one turn, before the result is written", async () => {
    fake.setScenario(twoIncidents([teamPm.ruleLessons([["I1", RULE_A], ["I2", RULE_B]])]));
    // The default interval (a minute) is longer than the run: the lessons wait for the team to be idle or the result to be written.
    expect(await teamRun({ reportIntervalMs: 60_000 }).run()).toBe("done");
    const turns = fake.calls("team_pm_rule_lesson");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.prompt).toContain("- I1 (");
    expect(turns[0]!.prompt).toContain("- I2 (");
    expect(turns[0]!.prompt).toContain("Answer all of them in this one turn");
    const state = stateOf();
    expect(state.governance.incidents.map((i) => [i.id, i.status])).toEqual([["I1", "recorded"], ["I2", "recorded"]]);
    expect(rulesOf().rules().map((r) => [r.id, r.text, r.opId])).toEqual([["R1", RULE_A, `lesson:${state.id}:I1`], ["R2", RULE_B, `lesson:${state.id}:I2`]]);
  });

  it("tells the PM which settled incident it left out, and records nothing of that answer", async () => {
    fake.setScenario(twoIncidents([teamPm.ruleLesson("I1", RULE_A), teamPm.ruleLessons([["I1", RULE_A], ["I2", null, "The rule for I1 covers it."]])]));
    expect(await teamRun({ reportIntervalMs: 60_000 }).run()).toBe("done");
    const turns = fake.calls("team_pm_rule_lesson");
    expect(turns).toHaveLength(2);
    expect(turns[1]!.prompt).toContain("answer every settled incident in this one turn: I2 has no entry");
    const state = stateOf();
    expect(state.governance.incidents.find((i) => i.id === "I2")).toMatchObject({ status: "no_lesson", lesson: { rationale: "The rule for I1 covers it." } });
    expect(rulesOf().rules().map((r) => r.text)).toEqual([RULE_A]);
  });

  it("writes a rule once: the same rule for two incidents is refused, and the other incident names it instead", async () => {
    fake.setScenario(twoIncidents([teamPm.ruleLessons([["I1", RULE_A], ["I2", RULE_A]]), teamPm.ruleLessons([["I1", RULE_A], ["I2", null, "R-for-I1 covers it."]])]));
    expect(await teamRun({ reportIntervalMs: 60_000 }).run()).toBe("done");
    const turns = fake.calls("team_pm_rule_lesson");
    expect(turns).toHaveLength(2);
    expect(turns[1]!.prompt).toContain("I2 repeats the rule of I1: write it once");
    expect(rulesOf().rules().map((r) => r.text)).toEqual([RULE_A]);
    expect(stateOf().governance.incidents.map((i) => i.status)).toEqual(["recorded", "no_lesson"]);
  });
});

describe("a stop between writing RULES.md and saving the state loses and doubles no lesson (AC3)", () => {
  const LESSON = "Settle the scope with the PM before the first line of code.";

  /** A run stopped while dev-1 works, with an incident the PM already wrote its lesson for (`recording`: asked, not confirmed). */
  async function stoppedWithLesson(): Promise<string> {
    fake.setScenario(stoppableScenario());
    await stopWhileWorking(teamRun());
    const store = TeamStore.open(runsDir(), "latest");
    const state = store.load();
    const made = recordIncident(state, { kind: "disagreement", source: { kind: "user_message", seq: 1 }, reportedBy: "agentduo", summary: "dev-1 and the techlead disagreed about the scope" });
    expect(made.ok).toBe(true);
    expect(resolveIncident(state, "I1", "the techlead decided").ok).toBe(true);
    expect(beginLesson(state, "I1", LESSON).ok).toBe(true);
    store.save(state);
    return state.id;
  }

  it("finishes a lesson the run stopped before writing: RULES.md gets it once, with no new call of the PM", async () => {
    rulesOf().append(SEED);
    const id = await stoppedWithLesson();
    expect(rulesOf().rules().map((r) => r.id)).toEqual(["R1"]);
    expect(await resume().run()).toBe("done");
    expect(rulesOf().rules().map((r) => [r.id, r.text, r.opId])).toEqual([["R1", SEED.text, "seed:1"], ["R2", LESSON, `lesson:${id}:I1`]]);
    expect(stateOf().governance.incidents[0]).toMatchObject({ status: "recorded", lesson: { ruleId: "R2" } });
    expect(fake.calls("team_pm_rule_lesson")).toHaveLength(0);
  });

  it("finishes a lesson whose rule was written before the state was saved, without writing it again", async () => {
    rulesOf().append(SEED);
    const id = await stoppedWithLesson();
    // The stop came after the file was written and before the state recorded it.
    rulesOf().append({ opId: `lesson:${id}:I1`, text: LESSON, incident: "run, I1" });
    expect(await resume().run()).toBe("done");
    expect(rulesOf().rules().map((r) => [r.id, r.text])).toEqual([["R1", SEED.text], ["R2", LESSON]]);
    expect(stateOf().governance.incidents[0]).toMatchObject({ status: "recorded", lesson: { ruleId: "R2" } });
    expect(fake.calls("team_pm_rule_lesson")).toHaveLength(0);
    // Another reopening of the finished run adds nothing either.
    expect(await resume().run()).toBe("done");
    expect(rulesOf().rules()).toHaveLength(2);
  });

  it("does not ask the PM again for an incident whose lesson is already recorded", async () => {
    fake.setScenario(happy({
      team_check: [{ output: teamCheck("fail") }, { output: teamCheck("pass") }],
      team_triage: [{ output: teamTriage("retry") }],
      "team_work:dev-1": [{ output: teamWork(), write: { "app.txt": "broken\n" } }, { output: teamWork(), write: { "app.txt": "fixed\n" } }],
      team_pm_rule_lesson: [{ output: teamPm.ruleLesson("I1", "Check the failing case first.") }],
    }));
    expect(await teamRun().run()).toBe("done");
    expect(await resume().run()).toBe("done");
    expect(fake.calls("team_pm_rule_lesson")).toHaveLength(1);
    expect(rulesOf().rules()).toHaveLength(1);
  });
});
