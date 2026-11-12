// Team runs end to end: the PM, the techlead, two devs and a tester as fake CLIs (packages/engine/test/fake-agent.mjs),
// real git worktrees, and a decider that answers the approvals.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClarificationRequest, ClarificationResponse } from "../../src/clarification/clarification.js";
import { EventBus, type ClarificationDecider, type DuoEvent } from "../../src/events.js";
import type { Attachment } from "../../src/inputs/attachment-types.js";
import { AttachmentStore } from "../../src/inputs/attachments.js";
import type { TeamMemberEntry } from "../../src/team/config.js";
import { TeamStore } from "../../src/team/state.js";
import { TeamRun } from "../../src/team/team.js";
import { testConfig, userDataEnv } from "../helpers/config.js";
import { FakeClis, type FakeCall } from "../helpers/fake-clis.js";
import { png } from "../helpers/images.js";
import { git, makeRepo } from "../helpers/repo.js";
import { brief, task, teamCheck, teamPlan, teamPm, teamReview, teamTests, teamTriage, teamWork } from "../helpers/team-builders.js";
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

/** Answers every request with its first option (approve, accept), or with `script`'s answer for its header. */
function decider(script: Record<string, Array<{ option: 0 | 1; text?: string }>> = {}): ClarificationDecider & { asked: ClarificationRequest[] } {
  const asked: ClarificationRequest[] = [];
  return {
    asked,
    askClarification: async ({ request }): Promise<ClarificationResponse> => {
      asked.push(request);
      const q = request.questions[0]!;
      const next = script[q.header]?.shift() ?? { option: 0 };
      return { kind: "answered", answers: request.questions.map((qq) => ({ questionId: qq.id, optionIds: [qq.options[qq === q ? next.option : 0]!.id], otherText: qq === q ? next.text ?? null : null })) };
    },
  };
}

const two = brief(["Subtraction works", "It is documented"]);
const twoTasks = teamPlan([
  task("T1", { assignee: "dev-1", criteria: ["AC1"], area: ["app.txt"] }),
  task("T2", { assignee: "dev-2", criteria: ["AC2"], area: ["docs.md"] }),
]);
const acceptance = (status: "met" | "not_met" = "met") => ({
  message: "Both criteria are met.",
  action: { kind: "acceptance", criteria: [{ id: "AC1", status, evidence: "qa-1: C1" }, { id: "AC2", status, evidence: "qa-1: C2" }], summary: "Done." },
});

function teamRun(o: { decider?: ClarificationDecider; request?: string; gates?: boolean; members?: TeamMemberEntry[]; attachments?: Attachment[] } = {}) {
  const cfg = testConfig(fake, o.gates ? {} : { gates: [] });
  if (o.members) cfg.team.members = o.members;
  return TeamRun.create({
    runsDir: join(repo, ".agentduo", "runs"), request: o.request ?? "Add subtraction, and document it", cfg, workspace: repo, bus,
    decider: o.decider, env: { ...process.env, ...userDataEnv(join(t.path, "data")) }, reportIntervalMs: 0, attachments: o.attachments,
  });
}

const happy = (over: Record<string, unknown[]> = {}) => ({
  team_pm_conversation: [{ output: teamPm.brief(two) }],
  team_plan: [{ output: twoTasks }],
  team_pm_plan_review: [{ output: teamPm.planReview(true) }],
  team_pm_reports: [{ output: teamPm.none("Progress.") }],
  team_pm_acceptance: [{ output: acceptance() }],
  "team_work:dev-1": [{ output: teamWork(), write: { "app.txt": "fixed\n" } }],
  "team_work:dev-2": [{ output: teamWork(), write: { "docs.md": "# sub\n" } }],
  team_tests: [{ output: teamTests(), write: { "test/qa.txt": "tests\n" } }],
  team_review: [{ output: teamReview("approve") }],
  team_check: [{ output: teamCheck("pass") }],
  ...over,
});

describe("a team run", () => {
  it("goes from the user's request to the accepted result in the workspace, each member in its own worktree", async () => {
    fake.setScenario(happy({
      "team_work:dev-1": [{ output: teamWork(), write: { "app.txt": "fixed\n" }, sleep: 700 }],
      "team_work:dev-2": [{ output: teamWork(), write: { "docs.md": "# sub\n" }, sleep: 700 }],
    }));
    const d = decider();
    const run = teamRun({ decider: d });
    expect(await run.run()).toBe("done");
    // The three approvals, all the PM's.
    expect(d.asked.map((r) => r.questions[0]!.header)).toEqual(["Brief", "Plan", "Acceptance"]);
    expect(d.asked.every((r) => r.source === "team" && r.member === "pm")).toBe(true);
    // Both tasks' work and the tester's tests are in the folder, nothing committed.
    expect(readFileSync(join(repo, "app.txt"), "utf8")).toBe("fixed\n");
    expect(readFileSync(join(repo, "docs.md"), "utf8")).toBe("# sub\n");
    expect(readFileSync(join(repo, "test", "qa.txt"), "utf8")).toBe("tests\n");
    expect(git(repo, "log", "--oneline").split("\n")).toHaveLength(1);
    // Each member worked in its own worktree, never in the workspace.
    // (The worktrees are gone by now; the paths are as the agents saw them, symlinks resolved, like the test's folder.)
    const cwds = new Map(fake.calls().filter((c) => c.member && c.member !== "pm").map((c) => [c.member!, c.cwd!]));
    expect(cwds.get("dev-1")).not.toBe(cwds.get("dev-2"));
    for (const name of ["dev-1", "dev-2", "qa-1", "techlead"]) expect(cwds.get(name)).toContain(join("data", "agentduo", "teams"));
    // dev-1 (senior) is reviewed by the techlead, dev-2 (mid) by dev-1.
    const reviews = fake.calls("team_review").map((c) => [c.member, /Review (dev-\d)'s change/.exec(c.prompt)?.[1]]);
    expect(reviews).toEqual(expect.arrayContaining([["techlead", "dev-1"], ["dev-1", "dev-2"]]));
    // The two devs worked at the same time: each started before the other finished.
    const work = events.flatMap((e) => (e.type === "team.member" && (e.job === "work" || e.state === "idle") && ["dev-1", "dev-2"].includes(e.member) ? [`${e.member}:${e.state}`] : []));
    expect(work.slice(0, 2).sort()).toEqual(["dev-1:busy", "dev-2:busy"]);
    // The user hears only the PM.
    const said = events.flatMap((e) => (e.type === "team.message" && e.from === "pm" ? [e.text] : []));
    expect(said).toContain("Here is what I understood.");
    const store = TeamStore.open(join(repo, ".agentduo", "runs"), "latest");
    const state = store.load();
    expect(state.phase).toBe("DONE");
    expect(state.tasks.map((x) => [x.id, x.status])).toEqual([["T1", "merged"], ["T2", "merged"]]);
    expect(state.applied?.files.sort()).toEqual(["app.txt", "docs.md", "test/qa.txt"]);
    // The worktrees are gone once it is done.
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "team.finished", outcome: "done", phase: "DONE" });
  });

  it("keeps a member's session to one task: a new task or a review of another's starts fresh, the same task's next job goes on", async () => {
    fake.setScenario(happy());
    expect(await teamRun({ decider: decider() }).run()).toBe("done");
    const task = (c: FakeCall) => /## Task (T\d+)/.exec(c.prompt)?.[1];
    // A task's own calls (the check of the whole result, once every task is merged, is no task's).
    const by = (role: string, member: string) => new Map(fake.calls(role).filter((c) => c.member === member && !c.prompt.includes("Every task is merged")).map((c) => [task(c), c]));
    // qa-1 writes the tests of both tasks, each in a session of its own: T2's does not carry T1's.
    const tests = by("team_tests", "qa-1");
    expect([...tests.keys()].sort()).toEqual(["T1", "T2"]);
    for (const c of tests.values()) expect(c.resumed, `tests of ${task(c)}`).toBeUndefined();
    expect(tests.get("T1")!.session).not.toBe(tests.get("T2")!.session);
    // Its check of a task goes on in the session that wrote that task's tests.
    for (const [id, check] of by("team_check", "qa-1")) expect(check.resumed, `check of ${id}`).toBe(tests.get(id)!.session);
    // dev-1 reviews dev-2's T2 in a session of its own, not in the one that built T1.
    const review = by("team_review", "dev-1").get("T2")!;
    expect(review.resumed).toBeUndefined();
    expect(review.session).not.toBe(by("team_work", "dev-1").get("T1")!.session);
    // The check of the whole result belongs to no task: it does not carry a task's history either.
    const whole = fake.calls("team_check").find((c) => c.prompt.includes("Every task is merged"))!;
    expect([tests.get("T1")!.session, tests.get("T2")!.session]).not.toContain(whole.resumed);
    // A turn that belongs to no task goes on as before: the PM keeps one session.
    expect(fake.calls().filter((c) => c.member === "pm").slice(1).every((c) => c.resumed)).toBe(true);
    const state = TeamStore.open(join(repo, ".agentduo", "runs"), "latest").load();
    expect(Object.keys(state.sessions).sort()).toEqual(expect.arrayContaining(["pm", "qa-1@T1", "qa-1@T2", "dev-1@T1", "dev-1@T2", "dev-2@T2"]));
  });

  it("asks the PM to revise the brief and the techlead the plan when you ask for changes", async () => {
    fake.setScenario(happy({
      team_pm_conversation: [{ output: teamPm.brief(two) }, { output: teamPm.brief(two) }, { output: teamPm.none("I passed it on.") }],
    }));
    const d = decider({ Brief: [{ option: 1, text: "Mention the docs folder" }, { option: 0 }], Plan: [{ option: 1, text: "Split it more" }, { option: 0 }] });
    expect(await teamRun({ decider: d }).run()).toBe("done");
    expect(d.asked.map((r) => r.questions[0]!.header)).toEqual(["Brief", "Brief", "Plan", "Plan", "Acceptance"]);
    expect(fake.calls("team_pm_conversation")[1]!.prompt).toContain("(about brief v1) Mention the docs folder");
    expect(fake.calls("team_plan")[1]!.prompt).toContain("The user asked for changes (through the PM): Split it more");
    const state = TeamStore.open(join(repo, ".agentduo", "runs"), "latest").load();
    expect(state.approvedBrief).toBe(2);
    expect(state.approvedPlan).toBe(":2");
  });

  it("sends a failing check to the techlead, who has the task retried with guidance, then merges it", async () => {
    fake.setScenario(happy({
      team_plan: [{ output: teamPlan([task("T1", { criteria: ["AC1", "AC2"] })]) }],
      team_check: [{ output: teamCheck("fail") }, { output: teamCheck("pass") }],
      team_triage: [{ output: teamTriage("retry") }],
      "team_work:dev-1": [{ output: teamWork(), write: { "app.txt": "broken\n" } }, { output: teamWork(), write: { "app.txt": "fixed\n" } }],
    }));
    expect(await teamRun({ decider: decider() }).run()).toBe("done");
    const second = fake.calls("team_work")[1]!.prompt;
    expect(second).toContain("## The techlead's guidance for this attempt (2)\nSwap the operands.");
    expect(second).toContain("## Why the previous attempt failed");
    expect(readFileSync(join(repo, "app.txt"), "utf8")).toBe("fixed\n");
    const state = TeamStore.open(join(repo, ".agentduo", "runs"), "latest").load();
    expect(state.tasks[0]!.attempt).toBe(2);
  });

  it("lets a blocked dev ask the techlead, and goes on with the answer", async () => {
    fake.setScenario(happy({
      team_plan: [{ output: teamPlan([task("T1", { criteria: ["AC1", "AC2"] })]) }],
      "team_work:dev-1": [{ output: teamWork("blocked") }, { output: teamWork(), write: { "app.txt": "fixed\n" } }],
      team_answer: [{ output: { answer: "Integers only.", escalate: null, report: null } }],
    }));
    expect(await teamRun({ decider: decider() }).run()).toBe("done");
    expect(fake.calls("team_answer")[0]!.prompt).toContain("## dev-1 asks\nIntegers or floats?");
    expect(fake.calls("team_work")[1]!.prompt).toContain("## The answer to your question\nYou asked: Integers or floats?\nAnswer: Integers only.");
  });

  it("checks every candidate with the gates, and stops for you when nobody can answer", async () => {
    fake.setScenario(happy({ team_plan: [{ output: teamPlan([task("T1", { criteria: ["AC1", "AC2"] })]) }] }));
    const run = teamRun({ gates: true });
    // No decider: the brief waits for an approval nobody can give here.
    expect(await run.run()).toBe("waiting");
    const state = TeamStore.open(join(repo, ".agentduo", "runs"), "latest").load();
    expect(state.waiting?.kind).toBe("brief");
    expect(existsSync(join(repo, "app.txt"))).toBe(false);
  });

  it("runs the gates on a task's candidate as one more check", async () => {
    fake.setScenario(happy({ team_plan: [{ output: teamPlan([task("T1", { criteria: ["AC1", "AC2"] })]) }] }));
    expect(await teamRun({ decider: decider(), gates: true }).run()).toBe("done");
    expect(events.filter((e) => e.type === "gate.completed").map((e) => (e as { passed: boolean }).passed)).toEqual([true, true]);
  });

  it("lets the techlead resolve a merge conflict between two tasks", async () => {
    fake.setScenario(happy({
      "team_work:dev-1": [{ output: teamWork(), write: { "README.md": "one\n" } }],
      "team_work:dev-2": [{ output: teamWork(), write: { "README.md": "two\n" } }],
      team_resolve: [{ output: teamWork(), write: { "README.md": "one and two\n" } }],
    }));
    expect(await teamRun({ decider: decider() }).run()).toBe("done");
    expect(fake.calls("team_resolve")).toHaveLength(1);
    expect(fake.calls("team_resolve")[0]!.prompt).toContain("conflicts in: README.md");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("one and two\n");
  });

  it("has the techlead add tasks when the check of the whole result fails", async () => {
    fake.setScenario(happy({
      team_plan: [{ output: teamPlan([task("T1", { criteria: ["AC1", "AC2"] })]) }],
      team_check: [{ output: teamCheck("pass") }, { output: teamCheck("fail") }, { output: teamCheck("pass") }],
      team_triage: [{ output: teamTriage("add_tasks", { tasks: [task("T9", { assignee: "dev-2", criteria: ["AC1"], area: ["fix.txt"] })] }) }],
      "team_work:dev-2": [{ output: teamWork(), write: { "fix.txt": "fix\n" } }],
    }));
    expect(await teamRun({ decider: decider() }).run()).toBe("done");
    expect(fake.calls("team_triage")[0]!.prompt).toContain("The check of the whole result (every task merged) failed.");
    const state = TeamStore.open(join(repo, ".agentduo", "runs"), "latest").load();
    expect(state.tasks.map((x) => [x.id, x.status])).toEqual([["T1", "merged"], ["T9", "merged"]]);
    expect(readFileSync(join(repo, "fix.txt"), "utf8")).toBe("fix\n");
  });

  it("sends a question the techlead cannot answer up to the PM, and its answer back down", async () => {
    fake.setScenario(happy({
      team_plan: [{ output: teamPlan([task("T1", { criteria: ["AC1", "AC2"] })]) }],
      "team_work:dev-1": [{ output: teamWork("blocked") }, { output: teamWork(), write: { "app.txt": "fixed\n" } }],
      team_answer: [{ output: { answer: null, escalate: "Should it round?", report: null } }],
      team_pm_escalation: [{ output: teamPm.teamAnswer("T1-E1", "Never round.") }],
    }));
    expect(await teamRun({ decider: decider() }).run()).toBe("done");
    expect(fake.calls("team_pm_escalation")[0]!.prompt).toContain("- T1-E1 (task T1): T1: Should it round?");
    expect(fake.calls("team_work")[1]!.prompt).toContain("Answer: Never round.");
  });

  it("hands your message to the PM while the team works, and the PM's note to the techlead", async () => {
    fake.setScenario(happy({
      team_plan: [{ output: teamPlan([task("T1", { criteria: ["AC1", "AC2"] })]) }],
      "team_work:dev-1": [{ output: teamWork(), write: { "app.txt": "fixed\n" }, sleep: 1500 }],
      team_pm_conversation: [{ output: teamPm.brief(two) }, { output: teamPm.leadNote("Integers only.") }],
    }));
    const run = teamRun({ decider: decider() });
    bus.on((e) => {
      if (e.type === "team.member" && e.member === "dev-1" && e.job === "work") run.message("Integers only, please");
    });
    expect(await run.run()).toBe("done");
    expect(fake.calls("team_pm_conversation")[1]!.prompt).toContain("User: Integers only, please");
    expect(events.some((e) => e.type === "team.message" && e.from === "pm" && e.text === "I told the techlead.")).toBe(true);
    // The techlead reviews dev-1's task after that, and reads the note.
    expect(fake.calls("team_review")[0]!.prompt).toContain("## Notes from the PM\n- Integers only.");
  });

  it("gives every member the files you attached, as images, and a continued session only the new ones", async () => {
    fake.setScenario(happy({
      team_plan: [{ output: teamPlan([task("T1", { criteria: ["AC1", "AC2"] })]) }],
      "team_work:dev-1": [{ output: teamWork(), write: { "app.txt": "fixed\n" }, sleep: 1500 }],
      team_pm_conversation: [{ output: teamPm.brief(two) }, { output: teamPm.leadNote("Match the detail too.") }],
    }));
    const runsDir = join(repo, ".agentduo", "runs");
    // The files as the chat keeps them: copies in a conversation's folder, which the run copies into its own.
    const chat = new AttachmentStore(runsDir, join(runsDir, "conversations", "c1"));
    const mockup = chat.importBytes("mockup.png", png(32, 32));
    const detail = chat.importBytes("detail.png", png(8, 8));
    const run = teamRun({ decider: decider(), attachments: [mockup] });
    let told = false;
    bus.on((e) => {
      if (!told && e.type === "team.member" && e.member === "dev-1" && e.job === "work") {
        told = true;
        run.message("And this detail", [detail]);
      }
    });
    expect(await run.run()).toBe("done");
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    const shown = (c: FakeCall) => (c.images ?? []).map((i) => i.sha256);
    // Each member's first call, a session of its own, has the request's image, and the path of the run's copy.
    const firsts = new Map<string, FakeCall>();
    for (const c of fake.calls()) if (c.member && !firsts.has(c.member)) firsts.set(c.member, c);
    expect([...firsts.keys()].sort()).toEqual(["dev-1", "pm", "qa-1", "techlead"]);
    for (const [name, c] of firsts) {
      expect(shown(c), name).toContain(sha(png(32, 32)));
      expect(c.prompt, name).toContain("## Files the user attached");
      expect(c.prompt, name).toMatch(/- `mockup\.png` \(PNG 32×32, \d+ B\): `[^`]*teams[^`]*mockup\.png`/);
    }
    expect(firsts.get("pm")!.prompt).toContain("User: Add subtraction, and document it\n(attached: `mockup.png`)");
    // The PM's next turn goes on in its session: your message, and only the file it has not seen.
    const pm = fake.calls("team_pm_conversation")[1]!;
    expect(pm.resumed).toBeTruthy();
    expect(shown(pm)).toEqual([sha(png(8, 8))]);
    expect(pm.prompt).toContain("User: And this detail\n(attached: `detail.png`)");
    expect(pm.prompt).not.toContain("mockup.png");
    // The run keeps its own copies, with the messages they came with.
    const state = TeamStore.open(runsDir, "latest").load();
    const files = (text: string) => state.messages.find((m) => m.from === "user" && m.text === text)!.attachments!;
    expect(files("Add subtraction, and document it").map((a) => a.name)).toEqual(["mockup.png"]);
    expect(files("And this detail").map((a) => a.name)).toEqual(["detail.png"]);
    for (const a of [...files("Add subtraction, and document it"), ...files("And this detail")]) {
      expect(a.path.startsWith(`teams/${state.id}/attachments/`), a.path).toBe(true);
      expect(existsSync(join(runsDir, a.path))).toBe(true);
    }
  });

  it("stops on Esc and goes on from where it was in a new run", async () => {
    fake.setScenario(happy({
      team_plan: [{ output: teamPlan([task("T1", { criteria: ["AC1", "AC2"] })]) }],
      "team_work:dev-1": [{ output: teamWork(), write: { "app.txt": "fixed\n" }, sleep: 3000 }],
    }));
    const first = teamRun({ decider: decider() });
    bus.on((e) => {
      if (e.type === "team.member" && e.member === "dev-1" && e.job === "work" && e.state === "busy") setTimeout(() => first.stop(), 300);
    });
    expect(await first.run()).toBe("stopped");
    expect(TeamStore.open(join(repo, ".agentduo", "runs"), "latest").load().tasks[0]!.status).toBe("coding");
    const again = TeamRun.resume({ runsDir: join(repo, ".agentduo", "runs"), id: "latest", workspace: repo, bus: new EventBus(), decider: decider(), env: { ...process.env, ...userDataEnv(join(t.path, "data")) }, reportIntervalMs: 0 });
    expect(await again.run()).toBe("done");
    expect(readFileSync(join(repo, "app.txt"), "utf8")).toBe("fixed\n");
  });

  it("stops and says so when the PM keeps failing, rather than wait for it", async () => {
    fake.setScenario({ team_pm_conversation: [{ raw: "not a JSON answer" }] });
    expect(await teamRun({ decider: decider() }).run()).toBe("waiting");
    expect(events.filter((e) => e.type === "warning").map((e) => (e as { text: string }).text).at(-1)).toContain("The team stopped: the PM failed twice");
  });

  it("gives Claude's members your permission mode, as the implementer gets it", async () => {
    fake.setScenario(happy({ team_plan: [{ output: teamPlan([task("T1", { criteria: ["AC1", "AC2"] })]) }] }));
    const cfg = testConfig(fake, { gates: [] });
    cfg.claude.role_args = { implementer: ["--permission-mode", "acceptEdits"] };
    const run = TeamRun.create({
      runsDir: join(repo, ".agentduo", "runs"), request: "Add subtraction", cfg, workspace: repo, bus, decider: decider(),
      env: { ...process.env, ...userDataEnv(join(t.path, "data")) }, reportIntervalMs: 0,
    });
    expect(await run.run()).toBe("done");
    const work = fake.calls("team_work")[0]!.args;
    expect(work[work.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    // Codex members get none of Claude's flags.
    expect(fake.calls("team_plan")[0]!.args).not.toContain("--permission-mode");
  });

  it("passes the user's message to the PM, which answers while nothing else waits", async () => {
    fake.setScenario(happy({
      team_pm_conversation: [{ output: teamPm.questions("Before I write it down:") }, { output: teamPm.brief(two) }],
    }));
    const d = decider({ Scope: [{ option: 1 }] });
    expect(await teamRun({ decider: d }).run()).toBe("done");
    expect(d.asked[0]!.questions[0]!.question).toBe("Should subtraction handle decimals?");
    expect(fake.calls("team_pm_conversation")[1]!.prompt).toContain("My answers to your questions:\n- Should subtraction handle decimals? → No");
  });

  describe("with groups", () => {
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
    const grouped = (over: Record<string, unknown[]> = {}) => happy({
      team_pm_areas: [{ output: teamPm.areas([{ group: "frontend", criteria: ["AC2"] }, { group: "backend", criteria: ["AC1"] }]) }],
      "team_plan:techlead-frontend": [{ output: teamPlan([task("F1", { assignee: "dev-frontend-1", testers: ["qa-frontend-1"], criteria: ["AC2"], area: ["docs.md"] })]) }],
      "team_plan:techlead-backend": [{ output: teamPlan([task("B1", { assignee: "dev-backend-1", testers: ["qa-backend-1"], criteria: ["AC1"], area: ["app.txt"] })]) }],
      "team_pm_area_review:pm-backend": [{ output: teamPm.planReview(true, null, "backend") }],
      "team_work:dev-frontend-1": [{ output: teamWork(), write: { "docs.md": "# sub\n" } }],
      "team_work:dev-backend-1": [{ output: teamWork(), write: { "app.txt": "fixed\n" } }],
      ...over,
    });

    it("splits the brief between the groups, has each techlead plan its part and the group's PM check it, then works it as one team", async () => {
      fake.setScenario(grouped());
      const d = decider();
      expect(await teamRun({ decider: d, members }).run()).toBe("done");
      expect(d.asked.map((r) => r.questions[0]!.header)).toEqual(["Brief", "Plan", "Acceptance"]);
      expect(d.asked.every((r) => r.member === "pm")).toBe(true);
      // The head PM split the work; each techlead planned only its part, at the same time.
      const plans = fake.calls("team_plan");
      expect(plans.map((c) => c.member).sort()).toEqual(["techlead-backend", "techlead-frontend"]);
      expect(plans.find((c) => c.member === "techlead-frontend")!.prompt).toContain("## Your group's part: frontend");
      expect(plans.find((c) => c.member === "techlead-frontend")!.prompt).toContain("Acceptance criteria your group answers for: AC2");
      // The backend's own PM checked its plan; the head PM then the whole of it, both groups' plans.
      expect(fake.calls("team_pm_area_review").map((c) => c.member)).toEqual(["pm-backend"]);
      const review = fake.calls("team_pm_plan_review")[0]!.prompt;
      expect(review).toContain("F1 Task F1 → dev-frontend-1");
      expect(review).toContain("B1 Task B1 → dev-backend-1");
      // A senior's code is reviewed by its own group's techlead; a mid's by a senior (here the backend's dev).
      const reviews = fake.calls("team_review").map((c) => [c.member, /Review (\S+)'s change/.exec(c.prompt)?.[1]]);
      expect(reviews).toEqual(expect.arrayContaining([["techlead-backend", "dev-backend-1"], ["dev-backend-1", "dev-frontend-1"]]));
      const state = TeamStore.open(join(repo, ".agentduo", "runs"), "latest").load();
      expect(state.tasks.map((x) => [x.id, x.group, x.status])).toEqual([["F1", "frontend", "merged"], ["B1", "backend", "merged"]]);
      expect(readFileSync(join(repo, "app.txt"), "utf8")).toBe("fixed\n");
      expect(readFileSync(join(repo, "docs.md"), "utf8")).toBe("# sub\n");
    });

    it("sends a group's question to its own PM first, who passes it up to the head PM", async () => {
      fake.setScenario(grouped({
        "team_work:dev-backend-1": [{ output: teamWork("blocked") }, { output: teamWork(), write: { "app.txt": "fixed\n" } }],
        team_answer: [{ output: { answer: null, escalate: "Should it round?", report: null } }],
        "team_pm_area_escalation:pm-backend": [{ output: teamPm.escalate("B1-E1", "The brief does not say; the user must.") }],
        team_pm_escalation: [{ output: teamPm.teamAnswer("B1-E1", "Never round.") }],
      }));
      expect(await teamRun({ decider: decider(), members }).run()).toBe("done");
      expect(fake.calls("team_answer")[0]!.member).toBe("techlead-backend");
      expect(fake.calls("team_pm_area_escalation")[0]!.prompt).toContain("- B1-E1 (task B1): B1: Should it round?");
      expect(fake.calls("team_pm_escalation")[0]!.prompt).toContain("pm-backend (the group's PM): The brief does not say; the user must.");
      expect(fake.calls("team_work").filter((c) => c.member === "dev-backend-1")[1]!.prompt).toContain("Answer: Never round.");
    });
  });
});
