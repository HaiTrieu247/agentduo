import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Chat, type ChatUi } from "../../src/chat/chat.js";
import { AttachmentStore } from "../../src/inputs/attachments.js";
import { SHARED_SESSION } from "../../src/workflow/context.js";
import { settings } from "../../src/config/settings.js";
import { EventBus, type Message } from "../../src/events.js";
import { ClarificationBroker } from "../../src/clarification/broker.js";
import { answersTemplate, MAX_PLANNER_ASKS } from "../../src/clarification/clarification.js";
import { approval, critique, finding, impl, issue, plan, plannerAsk, plannerQuestion, review } from "../helpers/builders.js";
import { runMetrics, type RunMetrics } from "../../src/workflow/render.js";
import { GIT_MISSING, MARKER, RunGitError } from "../../src/git/run-git.js";
import { DecisionError, EXIT } from "../../src/workflow/workflow.js";
import { RunStore, type RunGit } from "../../src/workflow/state.js";
import { CHECK_GATE, testConfig, userDataEnv, type ConfigOverrides } from "../helpers/config.js";
import { FakeClis } from "../helpers/fake-clis.js";
import { makeHarness, newWorkflow, pickFirst, resume, resumedWorkflow, runDirOf, ScriptedClarifier, ScriptedDecider, stateOf, type Harness } from "../helpers/harness.js";
import { png } from "../helpers/images.js";
import { CHECK_SCRIPT, git, makeRepo } from "../helpers/repo.js";
import { tempDir } from "../helpers/tmp.js";

let t: { path: string; cleanup(): void };
let fake: FakeClis;
let h: Harness;
let head: string;

beforeEach(() => {
  t = tempDir();
  const repo = makeRepo(t.path);
  fake = new FakeClis(t.path).install();
  h = makeHarness(repo, testConfig(fake));
  head = git(repo, "rev-parse", "HEAD");
});
afterEach(() => {
  fake.restore();
  t.cleanup();
});

type Scenario = Record<string, unknown[] | Record<string, unknown>>;
function start(scenario: Scenario, overrides?: ConfigOverrides, opts: { task?: string; decider?: ScriptedDecider } = {}): Promise<number> {
  fake.setScenario(scenario);
  if (overrides) h.cfg = testConfig(fake, overrides);
  return newWorkflow(h, opts.task ?? "Make app.txt fixed", opts.decider).wf.run();
}
const happy = (): Scenario => ({
  planner: [{ output: plan() }],
  plan_reviewer: [{ output: critique(true) }],
  plan_finalizer: [{ output: approval(true) }],
  implementer: [{ write: { "app.txt": "fixed\n" }, output: impl() }],
  code_reviewer: [{ output: review(true) }],
});
const messages = (): Message[] => h.events.flatMap((e) => (e.type === "message" ? [e.message] : []));
const readRun = (name: string) => readFileSync(join(runDirOf(h), name), "utf8");
const readRunOf = (x: Harness, name: string) => readFileSync(join(runDirOf(x), name), "utf8");

describe("Workflow", () => {
  it("says on DONE which checks passed", async () => {
    expect(await start(happy())).toBe(0);
    expect(h.events.at(-1)).toMatchObject({ type: "run.finished", summary: "quality gates passed on the final code and the review approved" });
    h.events.length = 0;
    expect(await start({ ...happy(), code_reviewer: [{ output: review(false) }] }, { quality_gates: { require_codex_approval: false } })).toBe(0);
    expect(h.events.at(-1)).toMatchObject({ type: "run.finished", summary: "quality gates passed on the final code and the review did not approve (require_codex_approval is off)" });
  });

  it("debates the plan, fixes gate failures and review findings, then reaches DONE", async () => {
    const code = await start({
      planner: [{ output: plan("v1") }, { output: plan("v2", { feedback_resolution: [{ issue_id: "C1", decision: "accepted", rationale: "ok" }] }) }],
      plan_reviewer: [
        { activities: [{ tool: "Read", input: { file_path: join(h.repo, "check.mjs") } }], output: critique(false, [issue("C1")]) },
        { output: critique(true) },
      ],
      plan_finalizer: [{ output: approval(true) }],
      implementer: [
        { write: { "app.txt": "buggy\n" }, output: impl() },
        { write: { "app.txt": "fixed\n" }, output: impl() },
        { write: { "app.txt": "fixed\nedge case handled\n" }, output: impl("completed", ["F1"]) },
      ],
      code_reviewer: [{ output: review(false, [finding("F1")]) }, { output: review(true, [], ["F1"]) }],
    });
    expect(code).toBe(0);
    const st = stateOf(h);
    expect(st.phase).toBe("DONE");
    expect([st.planningRound, st.planVersion, st.finalPlanVersion, st.implRound]).toEqual([2, 2, 2, 3]);
    expect(st.openFindings).toEqual([]);
    expect(st.history.map((x) => `${x.phase}:${x.status}`)).toEqual([
      "PLAN:baseline failing", "PLAN:plan created", "PLAN_REVIEW:changes requested", "PLAN:plan revised", "PLAN_REVIEW:approved", "PLAN_FINALIZE:plan finalized",
      "IMPLEMENT:completed", "VERIFY:failed",
      "IMPLEMENT:completed", "VERIFY:passed", "CODE_REVIEW:changes requested",
      "IMPLEMENT:completed", "VERIFY:passed", "CODE_REVIEW:approved",
    ]);
    expect(git(h.repo, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(h.repo, "app.txt"), "utf8")).toBe("fixed\nedge case handled\n");
    const refs = git(h.repo, "for-each-ref", "--format=%(refname)", "refs/agentduo");
    expect(refs).toContain("/base");
    expect(refs).toContain("/impl-r3");
    for (const name of ["plan.md", "plan.final.md", "plan-feedback.md", "review.json", "report.md", "plan.v1.json", "critique.r1.json", "implementation.r3.json", "gates.r1.json"]) {
      expect(existsSync(join(runDirOf(h), name)), name).toBe(true);
    }
    const envelope = JSON.parse(readRun("review.json"));
    for (const key of ["task_id", "round", "timestamp", "git_sha", "plan_version"]) expect(envelope).toHaveProperty(key);
    expect(envelope.output.reviewed_commit).toBe(st.lastSnapshot!.commit);
    expect(readRun("report.md")).toContain("**Status:** DONE");
    expect(messages().map((m) => `${m.from}>${m.to}:${m.kind}`)).toEqual([
      "gates>codex:gates", "codex>claude:plan", "claude>codex:critique", "codex>claude:plan", "claude>codex:critique", "codex>claude:approval",
      "claude>codex:implementation", "gates>claude:gates",
      "claude>codex:implementation", "gates>codex:gates", "codex>claude:review",
      "claude>codex:implementation", "gates>codex:gates", "codex>claude:review",
    ]);
    expect(h.events.some((e) => e.type === "agent.activity" && e.role === "plan_reviewer" && e.activity.label === "Read  check.mjs")).toBe(true);
    const implCalls = fake.calls("implementer");
    expect(implCalls[1]!.prompt).toContain("Failing quality gates");
    expect(implCalls[1]!.prompt).toContain("check failed");
    expect(implCalls[2]!.prompt).toContain("`F1`");
    expect(fake.calls("planner")[1]!.prompt).toContain("C1");
    expect(fake.calls("code_reviewer")[1]!.prompt).toContain("`F1`");
  });

  it("lists the workspace paths the task tags with @ in each role's first prompt", async () => {
    fake.setScenario(happy());
    const { wf } = newWorkflow(h, "Make @README.md say what @check.mjs checks (@nothing.md is not there)");
    expect(await wf.run()).toBe(0);
    for (const role of ["planner", "plan_reviewer", "code_reviewer"] as const) {
      const prompt = fake.calls(role)[0]!.prompt;
      expect(prompt, role).toContain("### Workspace paths the user tagged in the task");
      expect(prompt, role).toContain("- `README.md` (file)\n- `check.mjs` (file)\n");
      expect(prompt, role).not.toContain("`nothing.md`");
    }
  });

  it("gives every call the task's files, retries too, and a note's files from the step after it", async () => {
    fake.setScenario({ ...happy(), planner: [{ raw: "not json" }, { output: plan(), sleep: 600 }] });
    const { wf, bus } = newWorkflow(h, "Make app.txt match the mockup", undefined, (state) => {
      const files = new AttachmentStore(h.runsDir, join(h.runsDir, state.taskId));
      state.attachments = [files.importBytes("mockup.png", png(32, 32))];
    });
    const files = new AttachmentStore(h.runsDir, join(h.runsDir, wf.state.taskId));
    // A note while the planner works: the critic gets it with its file, the planner did not.
    let noted = false;
    bus.on((e) => {
      if (e.type === "agent.retry" && !noted) {
        noted = true;
        wf.addNote("and this detail", [files.importBytes("detail.png", png(8, 8)), files.importBytes("notes.txt", Buffer.from("n"))]);
      }
    });
    expect(await wf.run()).toBe(0);
    const calls = fake.calls().map((c) => [c.role, c.call, c.images?.length ?? 0]);
    // Plan sign-off continues the planner's session, which has the task's image: it gets only the note's. The implementer
    // goes on in the critic's session, which has both images already.
    expect(calls).toEqual([["planner", 0, 1], ["planner", 1, 1], ["plan_reviewer", 0, 2], ["plan_finalizer", 0, 1], ["implementer", 0, 0], ["code_reviewer", 0, 2]]);
    const implementer = fake.calls("implementer")[0]!;
    expect(implementer.resumed).toBe(fake.calls("plan_reviewer")[0]!.session);
    for (const given of ["### Files the user attached to the task", "and this detail"]) expect(implementer.prompt, given).not.toContain(given);
    expect(fake.calls("plan_finalizer")[0]!.prompt).toContain("## New notes from the human operator");
    expect(fake.calls("plan_finalizer")[0]!.prompt).toContain("notes.txt");
    expect(fake.calls("plan_finalizer")[0]!.prompt).not.toContain("mockup.png");
    expect(fake.calls("plan_reviewer")[0]!.prompt).toContain("and this detail\n  Files:");
    expect(fake.calls("plan_reviewer")[0]!.prompt).toContain("notes.txt");
    expect(fake.calls("planner")[1]!.prompt).not.toContain("and this detail");
    expect(stateOf(h).humanNotes[0]!.attachments!.map((a) => a.name)).toEqual(["detail.png", "notes.txt"]);
  });

  it("escalates after max planning rounds; resume implements the latest plan", async () => {
    // The planner revises its plan each round (an unchanged plan would stop the loop as stalled, a round earlier).
    const scenario = { ...happy(), planner: [{ output: plan("v1") }, { output: plan("v2") }], plan_reviewer: [{ output: critique(false, [issue("C1")]) }] };
    expect(await start(scenario, { limits: { max_planning_rounds: 2 } })).toBe(2);
    let st = stateOf(h);
    expect([st.phase, st.humanReview?.reason, st.planVersion]).toEqual(["HUMAN_REVIEW", "max_planning_rounds", 2]);
    expect(existsSync(join(runDirOf(h), "report.md"))).toBe(true);
    expect(h.events.some((e) => e.type === "human.required")).toBe(true);
    expect(await resume(h, { decision: "resume", note: "C1 is acceptable, go ahead" })).toBe(0);
    st = stateOf(h);
    expect([st.phase, st.finalPlanVersion]).toEqual(["DONE", 2]);
    expect(readRun("plan.final.md")).toContain("accepted by the human operator");
    expect(fake.calls("implementer")[0]!.prompt).toContain("C1 is acceptable");
  });

  it("tells every role what the user and both agents said before the task, also after a resume", async () => {
    fake.setScenario({ ...happy(), plan_reviewer: [{ output: critique(false, [issue("C1")]) }] });
    h.cfg = testConfig(fake, { limits: { max_planning_rounds: 1 } });
    const context = { exchanges: [{ backend: "claude" as const, question: "Should the fix keep the old format?", answer: "Yes, keep the old format readable." }], omitted: 0 };
    const { wf } = newWorkflow(h, "Make app.txt fixed", undefined, (st) => {
      st.conversationContext = context;
    });
    expect(await wf.run()).toBe(2);
    expect(await resume(h, { decision: "resume", note: "go ahead" })).toBe(0);
    expect(stateOf(h).conversationContext).toEqual(context);
    for (const role of ["planner", "plan_reviewer", "code_reviewer"]) {
      for (const call of fake.calls(role)) {
        expect(call.prompt, role).toContain("Yes, keep the old format readable.");
        expect(call.prompt.split("Should the fix keep the old format?").length - 1, role).toBe(1);
      }
      expect(fake.calls(role).length, role).toBeGreaterThan(0);
    }
    // The implementer goes on in the critic's session, which was told it, also across the resume: not again. It is told
    // the plan became final by the decision, and the decision's note.
    const implementer = fake.calls("implementer")[0]!;
    expect(implementer.resumed).toBe(fake.calls("plan_reviewer")[0]!.session);
    expect(implementer.prompt).not.toContain("Should the fix keep the old format?");
    expect(implementer.prompt).toContain("- The human operator accepted the plan as it was, without a further review.");
    expect(implementer.prompt).toContain("go ahead");
  });

  it("revise re-plans with the operator's note", async () => {
    await start({ ...happy(), plan_reviewer: [{ output: critique(false, [issue("C1")]) }, { output: critique(false, [issue("C1")]) }, { output: critique(true) }] },
      { limits: { max_planning_rounds: 2 } });
    expect(await resume(h, { decision: "revise", note: "drop the cache layer" })).toBe(0);
    const st = stateOf(h);
    expect([st.phase, st.planningRound]).toEqual(["DONE", 3]);
    expect(fake.calls("planner")[2]!.prompt).toContain("drop the cache layer");
  });

  it("retries invalid output", async () => {
    await start({
      ...happy(),
      plan_reviewer: [{ raw: "I think the plan is fine!" }, { output: critique(true) }],
      plan_finalizer: [{ output: { ...approval(true), status: "changes_requested" } }, { output: approval(true) }],
      code_reviewer: [{ output: review(true, [], [], "0".repeat(40)) }, { output: review(true) }],
    });
    expect(stateOf(h).phase).toBe("DONE");
    for (const name of ["critique.r1.json", "approval.r1.json", "review.r1.json"]) expect(JSON.parse(readRun(name)).attempts, name).toBe(2);
    const retry = fake.calls("code_reviewer")[1]!.prompt;
    expect(retry).toContain("## Your previous answer was rejected");
    expect(retry).toContain("reviewed_commit");
    expect(h.events.filter((e) => e.type === "agent.retry")).toHaveLength(3);
  });

  it("escalates an agent that keeps failing", async () => {
    expect(await start({ planner: [{ raw: "not json" }] })).toBe(2);
    const st = stateOf(h);
    expect([st.humanReview?.reason, st.humanReview?.resumePhase]).toEqual(["agent_error", "PLAN"]);
    expect(fake.calls("planner")).toHaveLength(2);
  });

  it("stops on a critical finding; resume starts a fix round", async () => {
    const scenario = {
      ...happy(),
      implementer: [{ write: { "app.txt": "fixed\n" }, output: impl() }, { write: { "app.txt": "fixed safely\n" }, output: impl("completed", ["F1"]) }],
      code_reviewer: [{ output: review(false, [finding("F1", "critical")]) }, { output: review(true, [], ["F1"]) }],
    };
    expect(await start(scenario)).toBe(2);
    expect(stateOf(h).humanReview?.reason).toBe("critical_finding");
    expect(await resume(h, { decision: "resume" })).toBe(0);
    expect(stateOf(h).implRound).toBe(2);
  });

  it("escalates when the implementer is blocked", async () => {
    expect(await start({ ...happy(), implementer: [{ output: impl("blocked", [], "API key needed") }] })).toBe(2);
    const hr = stateOf(h).humanReview!;
    expect([hr.reason, hr.message]).toEqual(["implementer_blocked", expect.stringMatching(/^the implementer is blocked: API key needed\. /)]);
  });

  it("escalates when required gates keep failing, without spending reviews", async () => {
    expect(await start({ ...happy(), implementer: [{ write: { "app.txt": "still broken\n" }, output: impl() }] }, { limits: { max_consecutive_gate_failures: 2 } })).toBe(2);
    const st = stateOf(h);
    expect([st.humanReview?.reason, st.implRound]).toEqual(["gates_failing", 2]);
    expect(fake.calls("code_reviewer")).toHaveLength(0);
  });

  it("escalates after max review rounds; abort ends the run", async () => {
    // Each round changes the finding's file: progress, though the reviewer is not satisfied.
    const scenario = {
      ...happy(), code_reviewer: [{ output: review(false, [finding("F1")]) }],
      implementer: [{ write: { "app.txt": "fixed\n" }, output: impl() }, { write: { "app.txt": "fixed\nagain\n" }, output: impl("completed", ["F1"]) }],
    };
    expect(await start(scenario, { limits: { max_review_rounds: 2 } })).toBe(2);
    const st = stateOf(h);
    expect([st.humanReview?.reason, st.implRound]).toEqual(["max_review_rounds", 2]);
    expect(readRun("report.md")).toContain("`F1`");
    expect(await resume(h, { decision: "abort" })).toBe(3);
    expect(stateOf(h).phase).toBe("ABORTED");
  });

  it("can pause for the human before implementing", async () => {
    expect(await start(happy(), { safety: { pause_before_implement: true } })).toBe(2);
    expect(stateOf(h).humanReview?.reason).toBe("plan_ready");
    expect(fake.calls("implementer")).toHaveLength(0);
    expect(await resume(h, { decision: "resume" })).toBe(0);
  });

  it("does not block DONE on medium findings and reports them", async () => {
    expect(await start({ ...happy(), plan_reviewer: [{ output: critique(true, [issue("C1", "low")]) }], code_reviewer: [{ output: review(true, [finding("F1", "medium")]) }] })).toBe(0);
    expect(readRun("report.md")).toContain("F1");
  });

  it("asks the Decider in-process and continues without exiting", async () => {
    const decider = new ScriptedDecider([{ decision: "resume", note: "go" }]);
    const code = await start({ ...happy(), plan_reviewer: [{ output: critique(false, [issue("C1")]) }] }, { limits: { max_planning_rounds: 1 } }, { decider });
    expect(code).toBe(0);
    expect(decider.seen).toEqual(["max_planning_rounds"]);
    expect(messages().some((m) => m.from === "human" && m.headline.includes("go"))).toBe(true);
  });

  it("stops cleanly after the current step when asked", async () => {
    fake.setScenario(happy());
    const { wf, bus } = newWorkflow(h, "Make app.txt fixed");
    bus.on((e) => {
      if (e.type === "step.completed" && e.entry.phase === "PLAN") wf.requestStop();
    });
    expect(await wf.run()).toBe(130);
    const st = stateOf(h);
    expect([st.phase, st.inProgress]).toEqual(["PLAN_REVIEW", null]);
    expect(h.events.at(-1)).toMatchObject({ type: "run.finished", phase: "INTERRUPTED", exitCode: 130 });
    expect(await resume(h)).toBe(0);
  });

  it("interrupts a running agent and re-runs that step on resume", async () => {
    fake.setScenario({ ...happy(), implementer: [{ activities: [{ tool: "Read", input: { file_path: "app.txt" } }], sleep: 10_000, output: impl() }, { write: { "app.txt": "fixed\n" }, output: impl() }] });
    const { wf, bus } = newWorkflow(h, "Make app.txt fixed");
    let interrupted = false;
    bus.on((e) => {
      // Once the agent is really working: a fixed delay can fire before it has even started on a busy machine.
      if (e.type === "agent.activity" && e.role === "implementer" && !interrupted) {
        interrupted = true;
        wf.interrupt();
      }
    });
    expect(await wf.run()).toBe(130);
    expect(stateOf(h).inProgress?.phase).toBe("IMPLEMENT");
    expect(await resume(h)).toBe(0);
    expect(fake.calls("implementer")).toHaveLength(2);
  });

  it("keeps non-ASCII task text in prompts and uses an ASCII run id", async () => {
    expect(await start(happy(), undefined, { task: "Sửa app.txt cho đúng" })).toBe(0);
    expect(stateOf(h).taskId).toMatch(/-sua-app-txt-cho-dung$/);
    expect(fake.calls("planner")[0]!.prompt).toContain("Sửa app.txt cho đúng");
  });

  it("passes only protocol flags plus the configured args", async () => {
    await start(happy(), { codex: { args: ["--ephemeral", "-c", "x=1"] }, claude: { role_args: { implementer: ["--permission-mode", "acceptEdits"] } } });
    for (const role of ["planner", "plan_finalizer", "code_reviewer"]) {
      const args = fake.calls(role)[0]!.args;
      expect(args).not.toContain("--sandbox");
      expect(args).toContain("x=1");
      // Inside a repository Codex needs no protocol flag beyond its own.
      expect(args).not.toContain("--skip-git-repo-check");
    }
    expect(stateOf(h).git).toEqual({ mode: "native" });
    expect(fake.calls("plan_reviewer")[0]!.args).not.toContain("--tools");
    expect(fake.calls("plan_reviewer")[0]!.args).not.toContain("--permission-mode");
    expect(fake.calls("implementer")[0]!.args.slice(-2)).toEqual(["--permission-mode", "acceptEdits"]);
  });

  it("reports files changed by a read-only agent and keeps going", async () => {
    expect(await start({ ...happy(), planner: [{ write: { "sneaky.txt": "x" }, output: plan() }] })).toBe(0);
    const warnings = h.events.flatMap((e) => (e.type === "warning" ? [e.text] : []));
    expect(warnings.some((w) => w.includes("Codex (planner) changed files") && w.includes("sneaky.txt"))).toBe(true);
    expect(readRun("report.md")).toContain("sneaky.txt");
  });

  it("starts and implements on a dirty tree", async () => {
    writeFileSync(join(h.repo, "README.md"), "local edit\n");
    expect(await start(happy())).toBe(0);
  });

  it("warns when the quality gates change files", async () => {
    const touchy = 'import { writeFileSync } from "node:fs";\nwriteFileSync("gate-output.txt", "x");\nprocess.exit(0);\n';
    expect(await start({ ...happy(), implementer: [{ write: { "app.txt": "fixed\n", "check.mjs": touchy }, output: impl() }] })).toBe(0);
    expect(h.events.some((e) => e.type === "warning" && e.text.includes("quality gates modified the working tree") && e.text.includes("gate-output.txt"))).toBe(true);
  });

  it("skips VERIFY when no gates are configured and finishes on Codex approval", async () => {
    expect(await start(happy(), { gates: [] })).toBe(0);
    const st = stateOf(h);
    expect(st.history.map((x) => x.phase)).not.toContain("VERIFY");
    expect(messages().some((m) => m.kind === "gates")).toBe(false);
    expect(fake.calls("implementer")[0]!.prompt).toContain("Run the project's checks yourself");
    expect(h.events.at(-1)).toMatchObject({ type: "run.finished", phase: "DONE", summary: "the review approved; no quality gates configured" });
    // Not configured is not passed: nothing was verified automatically, and the record and the report say so.
    expect(st.verification).toMatchObject({ status: "no_gates", gates: [], config: null, gatesAt: null, exceptions: [] });
    expect(readRun("report.md")).toContain("## Verification\n- no quality gates configured: nothing was verified automatically; the review of round 1 approved it");
  });

  it("clears stale gate results when re-planning", async () => {
    expect(await start({ ...happy(), implementer: [{ write: { "app.txt": "broken\n" }, output: impl() }] }, { limits: { max_consecutive_gate_failures: 1 } })).toBe(2);
    expect(stateOf(h).lastGates).not.toBeNull();
    const { wf } = resumedWorkflow(h);
    await wf.applyDecision("revise", "simpler approach");
    const st = stateOf(h);
    expect([st.lastGates, st.consecutiveGateFailures, st.phase]).toEqual([null, 0, "PLAN"]);
  });

  it("surfaces permission denials with a configuration hint", async () => {
    expect(await start({ ...happy(), implementer: [{ write: { "app.txt": "fixed\n" }, denials: [{ tool_name: "Edit", tool_use_id: "t0" }], output: impl() }] })).toBe(0);
    const hint = h.events.find((e) => e.type === "warning" && e.text.includes("was denied 1 tool call(s) (Edit)"));
    expect(hint && hint.type === "warning" && hint.text).toContain('permissions.defaultMode "acceptEdits"');
    expect(hint && hint.type === "warning" && hint.text).toContain("--reload-config");
  });

  it("names denied tools other than edits and points at allow rules", async () => {
    const denials = [{ tool_name: "Bash", tool_use_id: "t0" }, { tool_name: "Bash", tool_use_id: "t1" }];
    expect(await start({ ...happy(), implementer: [{ write: { "app.txt": "fixed\n" }, denials, output: impl() }] })).toBe(0);
    const hint = h.events.find((e) => e.type === "warning" && e.text.includes("was denied 2 tool call(s)"));
    const text = hint && hint.type === "warning" ? hint.text : "";
    expect(text).toContain("(Bash ×2)");
    expect(text).toContain('permissions.allow rules for Bash (e.g. "Bash(npm test:*)")');
    expect(text).not.toContain("acceptEdits");
  });

  it("keeps a round's starting snapshot when the round is re-run", async () => {
    const scenario = { ...happy(), implementer: [{ write: { "half.txt": "1\n" }, raw: "not json" }, { raw: "not json" }, { write: { "app.txt": "fixed\n" }, output: impl() }] };
    expect(await start(scenario)).toBe(2);
    expect(stateOf(h).humanReview?.reason).toBe("agent_error");
    expect(await resume(h, { decision: "resume" })).toBe(0);
    const record = JSON.parse(readRun("implementation.r1.json"));
    expect(record.changes.map((c: { path: string }) => c.path).sort()).toEqual(["app.txt", "half.txt"]);
  });

  it("caps stored warnings and says how many were dropped", () => {
    const wf = newWorkflow(h, "Make app.txt fixed").wf as unknown as { warn(text: string): void; state: { warnings: string[] } };
    for (let i = 0; i < 55; i++) wf.warn(`w${i}`);
    expect(wf.state.warnings).toHaveLength(50);
    expect(wf.state.warnings.slice(-2)).toEqual(["w48", "… 6 more warning(s) not stored"]);
  });

  it("relays Claude's permission prompts, and keeps rules saved by \"always allow\" out of the diff and the warnings", async () => {
    git(h.repo, "config", "core.excludesFile", "/dev/null"); // as on a machine whose git does not ignore .claude/settings.local.json
    const answers: string[] = [];
    h.permissions = { askPermission: async ({ role, request }) => { answers.push(`${role}: ${request.label}`); return { decision: "always" }; } };
    const ask = (command: string, write: Record<string, string> = {}) => ({ tool: "Bash", input: { command }, rules: [{ toolName: "Bash", ruleContent: `${command}:*` }], write });
    expect(await start({
      ...happy(),
      plan_reviewer: [{ permissions: [ask("npm test")], output: critique(true) }],
      implementer: [{ permissions: [ask("node fix.mjs", { "app.txt": "fixed\n" })], output: impl() }],
    })).toBe(0);
    expect(answers).toEqual(["plan_reviewer: Bash  npm test", "implementer: Bash  node fix.mjs"]);
    expect(readFileSync(join(h.repo, ".claude", "settings.local.json"), "utf8")).toContain("Bash(node fix.mjs:*)");
    expect(JSON.parse(readRun("implementation.r1.json")).changes).toEqual([{ status: "A", path: "app.txt" }]);
    expect(h.events.some((e) => e.type === "warning")).toBe(false);
    expect(fake.calls("code_reviewer")[0]!.prompt).not.toContain("settings.local.json");
  });

  it("gives no settings hint for a call the user denied at the prompt", async () => {
    h.permissions = { askPermission: async () => ({ decision: "deny", message: "not now" }) };
    expect(await start({ ...happy(), implementer: [{ write: { "app.txt": "fixed\n" }, permissions: [{ tool: "Bash", input: { command: "rm -rf build" } }], output: impl() }] })).toBe(0);
    expect(fake.permissionAnswers()).toEqual([{ behavior: "deny", message: "not now" }]);
    expect(h.events.some((e) => e.type === "warning" && e.text.includes("was denied"))).toBe(false);
  });

  it("works in a subdirectory workspace and warns about changes outside it", async () => {
    const ws = join(h.repo, "gói pkg");
    mkdirSync(ws);
    writeFileSync(join(ws, "check.mjs"), readFileSync(join(h.repo, "check.mjs"), "utf8"));
    git(h.repo, "add", "-A");
    git(h.repo, "commit", "-q", "-m", "add workspace");
    const sub = makeHarness(ws, testConfig(fake));
    fake.setScenario({ ...happy(), implementer: [{ write: { "app.txt": "fixed\n", "../outside.txt": "x\n" }, output: impl() }] });
    expect(await newWorkflow(sub, "Make app.txt fixed").wf.run()).toBe(0);
    expect(existsSync(join(ws, ".agentduo", "runs"))).toBe(true);
    expect(sub.events.some((e) => e.type === "warning" && e.text.includes("outside the workspace changed during IMPLEMENT") && e.text.includes("outside.txt"))).toBe(true);
    const reviewPrompt = fake.calls("code_reviewer")[0]!.prompt;
    expect(reviewPrompt).toContain("app.txt");
    expect(reviewPrompt).not.toContain("outside.txt");
    expect(readFileSync(join(runDirOf(sub), "report.md"), "utf8")).toContain("outside.txt");
  });

  it("hands a note given while a step runs to every later step", async () => {
    fake.setScenario({ ...happy(), planner: [{ activities: [{ command: "cat app.txt" }], sleep: 300, output: plan() }] });
    const { wf, bus } = newWorkflow(h, "Make app.txt fixed");
    let noted = false;
    bus.on((e) => {
      // Once the planner's CLI reports what it does, it has its prompt: on a slow machine a timer could come before that.
      if (e.type === "agent.activity" && e.role === "planner" && !noted) {
        noted = true;
        wf.addNote("keep app.txt short");
      }
    });
    expect(await wf.run()).toBe(0);
    expect(fake.calls("planner")[0]!.prompt).not.toContain("keep app.txt short");
    for (const role of ["plan_reviewer", "code_reviewer"]) expect(fake.calls(role)[0]!.prompt, role).toContain("keep app.txt short");
    // The implementer goes on in the critic's session, which has the note: it is not given it twice.
    expect(fake.calls("implementer")[0]!.resumed).toBe(fake.calls("plan_reviewer")[0]!.session);
    expect(fake.calls("implementer")[0]!.prompt).not.toContain("keep app.txt short");
    expect(stateOf(h).humanNotes).toMatchObject([{ phase: "PLAN", note: "keep app.txt short" }]);
  });

  it("rejects decisions when none is pending", async () => {
    await start(happy());
    const { wf } = resumedWorkflow(h);
    await expect(wf.applyDecision("resume")).rejects.toThrow("not waiting for a decision");
  });
});

describe("Workflow in a native repository of another shape", () => {
  it("runs in a repository with no commit yet, and in a linked worktree", async () => {
    const unborn = join(t.path, "unborn");
    mkdirSync(unborn);
    git(unborn, "init", "-q", "-b", "main");
    writeFileSync(join(unborn, "check.mjs"), CHECK_SCRIPT);
    const u = makeHarness(unborn, testConfig(fake));
    fake.setScenario(happy());
    expect(await newWorkflow(u, "Make app.txt fixed").wf.run()).toBe(0);
    const st = stateOf(u);
    expect([st.git, st.base!.head, st.base!.branch]).toEqual([{ mode: "native" }, null, "main"]);
    expect(git(unborn, "for-each-ref", "--format=%(refname)", "refs/agentduo")).toContain("/impl-r1");

    const wt = join(t.path, "linked wt");
    git(h.repo, "worktree", "add", "-q", "-b", "feature", wt);
    const w = makeHarness(wt, testConfig(fake));
    expect(await newWorkflow(w, "Make app.txt fixed").wf.run()).toBe(0);
    expect([stateOf(w).git, stateOf(w).base!.branch]).toEqual([{ mode: "native" }, "feature"]);
    expect(git(h.repo, "for-each-ref", "--format=%(refname)", `refs/agentduo/${stateOf(w).taskId}`)).toContain("/base");
    expect(git(h.repo, "rev-parse", "HEAD")).toBe(head);
  });
});

describe("Workflow in a folder with no git repository", () => {
  let p: Harness;
  let plain: string;
  const internalOf = (st: { git?: RunGit }) => st.git as Extract<RunGit, { mode: "internal" }>;
  const bare = (gitDir: string, ...args: string[]) => git(gitDir, ...args);
  const codexCalls = () => fake.calls().filter((c) => c.backend === "codex");

  beforeEach(() => {
    plain = join(t.path, "plain project");
    mkdirSync(plain);
    writeFileSync(join(plain, "check.mjs"), CHECK_SCRIPT);
    writeFileSync(join(plain, "README.md"), "demo\n");
    writeFileSync(join(plain, "old.txt"), "old\n");
    p = makeHarness(plain, testConfig(fake));
    p.env = { ...process.env, ...userDataEnv(join(t.path, "data")) };
  });
  const run = (scenario: Scenario, overrides?: ConfigOverrides) => {
    fake.setScenario(scenario);
    if (overrides) p.cfg = testConfig(fake, overrides);
    return newWorkflow(p, "Make app.txt fixed").wf.run();
  };

  it("snapshots, diffs and reviews in agentduo's own repository, and never creates a .git", async () => {
    expect(await run({
      ...happy(),
      planner: [{ raw: "not json" }, { output: plan() }],
      implementer: [{ write: { "app.txt": "fixed\n", "README.md": "changed\n" }, delete: ["old.txt"], output: impl() }],
    })).toBe(0);
    const st = stateOf(p);
    const meta = internalOf(st);
    expect([st.phase, meta.mode, meta.workspace]).toEqual(["DONE", "internal", plain]);
    expect(meta.gitDir).toBe(join(t.path, "data", "agentduo", "repositories", `${meta.repositoryId}.git`));
    expect(existsSync(join(plain, ".git"))).toBe(false);
    expect([st.base!.head, st.base!.branch]).toEqual([null, null]);
    const refs = bare(meta.gitDir, "for-each-ref", "--format=%(refname)", "refs/agentduo");
    expect(refs).toContain(`refs/agentduo/${st.taskId}/base`);
    expect(refs).toContain(`refs/agentduo/${st.taskId}/impl-r1`);
    expect(JSON.parse(readRunOf(p, "implementation.r1.json")).changes).toEqual([
      { status: "M", path: "README.md" }, { status: "A", path: "app.txt" }, { status: "D", path: "old.txt" },
    ]);
    // The reviewer gets the diff and is told where the snapshots are, never to run git in the workspace.
    const prompt = fake.calls("code_reviewer")[0]!.prompt;
    for (const text of ["+fixed", "-old", "+changed", "- Snapshots: agentduo keeps this run's snapshots in a Git repository of its own"]) expect(prompt).toContain(text);
    expect(prompt).not.toContain("git diff " + st.base!.commit);
    expect(JSON.parse(readRunOf(p, "review.json")).output.reviewed_commit).toBe(st.lastSnapshot!.commit);
    expect(readRunOf(p, "diff.r1.patch")).toContain("+fixed");
    // Every Codex call, retries included, starts outside a repository; Claude's need no such flag.
    expect(codexCalls().map((c) => c.role)).toEqual(["planner", "planner", "plan_finalizer", "code_reviewer"]);
    for (const call of codexCalls()) expect(call.args).toContain("--skip-git-repo-check");
    for (const call of fake.calls().filter((c) => c.backend === "claude")) expect(call.args).not.toContain("--skip-git-repo-check");
    expect(p.events.some((e) => e.type === "warning" && e.text.includes(`agentduo's own Git repository, ${meta.gitDir}`))).toBe(true);
    expect(readRunOf(p, "report.md")).toContain(`agentduo's own Git repository \`${meta.gitDir}\``);
  });

  it("reviews changes inside nested repositories, committed or not, as plain files", async () => {
    const lib = join(plain, "lib");
    mkdirSync(lib);
    git(lib, "init", "-q", "-b", "main");
    git(lib, "config", "user.email", "t@example.com");
    git(lib, "config", "user.name", "T");
    git(lib, "config", "commit.gpgsign", "false");
    writeFileSync(join(lib, "x.txt"), "one\n");
    git(lib, "add", "-A");
    git(lib, "commit", "-q", "-m", "x");
    const libHead = git(lib, "rev-parse", "HEAD");
    mkdirSync(join(plain, "fresh"));
    git(join(plain, "fresh"), "init", "-q");
    writeFileSync(join(plain, "fresh", "y.txt"), "one\n");
    expect(await run({ ...happy(), implementer: [{ write: { "app.txt": "fixed\n", "lib/x.txt": "two\n", "fresh/y.txt": "two\n" }, output: impl() }] })).toBe(0);
    expect(JSON.parse(readRunOf(p, "implementation.r1.json")).changes).toEqual([
      { status: "A", path: "app.txt" }, { status: "M", path: "fresh/y.txt" }, { status: "M", path: "lib/x.txt" },
    ]);
    const prompt = fake.calls("code_reviewer")[0]!.prompt;
    expect(prompt).toContain("lib/x.txt");
    expect(prompt).toContain("fresh/y.txt");
    const st = stateOf(p);
    expect(bare(internalOf(st).gitDir, "ls-tree", "-r", st.lastSnapshot!.tree)).not.toMatch(/^160000|\scommit\s/m);
    expect([git(lib, "rev-parse", "HEAD"), git(lib, "status", "--porcelain")]).toEqual([libHead, "M x.txt"]);
  });

  it("leaves a runs folder named like `..runs` out of the snapshots, as any runs folder inside the workspace", async () => {
    p.runsDir = join(plain, "..runs");
    expect(await run(happy())).toBe(0);
    const st = stateOf(p);
    expect(bare(internalOf(st).gitDir, "ls-tree", "-r", "--name-only", st.lastSnapshot!.tree).split("\n")).toEqual(["README.md", "app.txt", "check.mjs", "old.txt"]);
  });

  it("resumes in a new workflow with the same repository, base and refs, also after `git init`", async () => {
    const scenario = {
      ...happy(), code_reviewer: [{ output: review(false, [finding("F1")]) }, { output: review(false, [finding("F1")]) }, { output: review(true, [], ["F1"]) }],
      implementer: [1, 2, 3].map((n) => ({ write: { "app.txt": `fixed\nround ${n}\n` }, output: impl() })),
    };
    expect(await run(scenario, { limits: { max_review_rounds: 1 } })).toBe(2);
    const first = stateOf(p);
    expect(await resume(p, { decision: "resume" })).toBe(2);
    expect(existsSync(join(plain, ".git"))).toBe(false);
    // The folder becomes a repository: the run keeps the one it recorded.
    git(plain, "init", "-q");
    const calls = codexCalls().length;
    expect(await resume(p, { decision: "resume" })).toBe(0);
    const st = stateOf(p);
    expect([st.phase, st.implRound, st.git, st.base]).toEqual(["DONE", 3, first.git, first.base]);
    const refs = bare(internalOf(st).gitDir, "for-each-ref", "--format=%(refname)", "refs/agentduo");
    for (const ref of ["base", "impl-r1-pre", "impl-r1", "impl-r2", "impl-r3"]) expect(refs).toContain(`refs/agentduo/${st.taskId}/${ref}`);
    expect(git(plain, "for-each-ref", "refs/agentduo")).toBe("");
    for (const call of codexCalls().slice(calls)) expect(call.args).toContain("--skip-git-repo-check");
  });

  it("leaves a run as it was when its snapshots cannot be opened, and still aborts it", async () => {
    expect(await run({ ...happy(), code_reviewer: [{ output: review(false, [finding("F1")]) }] }, { limits: { max_review_rounds: 1 } })).toBe(2);
    const before = stateOf(p);
    rmSync(internalOf(before).gitDir, { recursive: true, force: true });
    const calls = fake.calls().length;
    for (const decision of ["resume", "revise"] as const) {
      const { wf } = resumedWorkflow(p);
      await expect(wf.applyDecision(decision, "note")).rejects.toThrow(RunGitError);
      const st = stateOf(p);
      expect([st.phase, st.humanReview, st.history.length, st.humanNotes]).toEqual(["HUMAN_REVIEW", before.humanReview, before.history.length, []]);
    }
    // The decider's answer goes the same way, out of run().
    await expect(resume(p, undefined, { decider: new ScriptedDecider([{ decision: "resume" }]) })).rejects.toThrow("it is missing (deleted or moved)");
    expect(stateOf(p).phase).toBe("HUMAN_REVIEW");
    expect(fake.calls()).toHaveLength(calls);
    expect(await resume(p, { decision: "abort" })).toBe(3);
    expect(stateOf(p).phase).toBe("ABORTED");
  });

  it("keeps the decision waiting when a snapshot's tree or a file in it is missing, before any phase changes", async () => {
    expect(await run({ ...happy(), code_reviewer: [{ output: review(false, [finding("F1")]) }] }, { limits: { max_review_rounds: 1 } })).toBe(2);
    const before = stateOf(p);
    const { gitDir } = internalOf(before);
    const last = before.lastSnapshot!;
    const calls = fake.calls().length;
    // Its commit is still there; only what it holds is gone (snapshot objects are loose: no gc runs in the repository).
    for (const [decision, oid] of [["resume", bare(gitDir, "rev-parse", `${last.commit}:app.txt`)], ["revise", last.tree]] as const) {
      const file = join(gitDir, "objects", oid.slice(0, 2), oid.slice(2));
      const bytes = readFileSync(file);
      chmodSync(file, 0o644);
      rmSync(file);
      const { wf } = resumedWorkflow(p);
      await expect(wf.applyDecision(decision, "note")).rejects.toThrow(`the snapshots of run ${before.taskId} in ${gitDir} are damaged`);
      const st = stateOf(p);
      expect([st.phase, st.humanReview, st.implRound, st.history.length, st.humanNotes]).toEqual(["HUMAN_REVIEW", before.humanReview, before.implRound, before.history.length, []]);
      writeFileSync(file, bytes);
    }
    expect(fake.calls()).toHaveLength(calls);
    // Whole again, the decision goes through.
    const { wf } = resumedWorkflow(p);
    await wf.applyDecision("resume");
    expect(stateOf(p).phase).toBe("IMPLEMENT");
  });

  it("starts no agent when the run's snapshots cannot be set up, and continues once the cause is fixed", async () => {
    p.env = { ...process.env, ...userDataEnv(join(plain, "data")) }; // inside the workspace: refused
    fake.setScenario(happy());
    const { wf } = newWorkflow(p, "Make app.txt fixed");
    await expect(wf.run()).rejects.toThrow(`which is inside ${plain}`);
    let st = stateOf(p);
    expect([st.phase, st.inProgress, st.history, st.git]).toEqual(["PLAN", null, [], undefined]);
    expect(fake.calls()).toEqual([]);
    p.env = { ...process.env, ...userDataEnv(join(t.path, "data")) };
    expect(await resume(p)).toBe(0);
    st = stateOf(p);
    expect([st.phase, st.git?.mode]).toEqual(["DONE", "internal"]);
    expect(existsSync(join(internalOf(st).gitDir, MARKER))).toBe(true);
    // Without Git, nothing starts either.
    const empty = join(t.path, "no-git-bin");
    mkdirSync(empty);
    const noGit = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== "PATH")), PATH: empty };
    p.env = noGit;
    await expect(newWorkflow(p, "Another").wf.run()).rejects.toThrow(GIT_MISSING);
  });
});

describe("Workflow after a chat discussion", () => {
  it("tells every role the discussion's synthesis, as Codex's, and none of its drafts or reviews", async () => {
    const ui: ChatUi = { info: () => {}, setStatus: () => {}, setMode: () => {}, setRecipient: () => {}, setModels: () => {}, exit: () => {} };
    const chat = new Chat({
      cfg: h.cfg, workspace: h.repo, runsDir: h.runsDir, configFile: join(h.repo, ".agentduo", "config.yaml"),
      userConfigFile: join(h.runsDir, "..", "user-config.yaml"), bus: new EventBus(), decider: new ScriptedDecider(), ui,
    });
    fake.setScenario({
      ...happy(), discuss_answer: [{ answer: "DRAFT: keep it." }], discuss_critique: [{ answer: "REVIEW: say why.\nVERDICT: REVISE" }, { answer: "Good.\nVERDICT: AGREE" }],
      discuss_revise: [{ answer: "DRAFT 2: keep it, old readers need it." }], discuss_synthesis: [{ answer: "SYNTHESIS: keep the old format readable for old readers." }],
    });
    try {
      await chat.submit("/discuss Should the fix keep the old format?");
      await chat.idle();
      await chat.submit("/pipeline Make app.txt fixed");
      await chat.idle();
    } finally {
      await chat.stop();
    }
    const st = stateOf(h);
    expect(st.phase).toBe("DONE");
    expect(st.conversationContext?.exchanges).toEqual([
      { backend: "codex", question: "Should the fix keep the old format?", answer: "SYNTHESIS: keep the old format readable for old readers.", discussedWith: "claude" },
    ]);
    for (const role of ["planner", "plan_reviewer", "implementer", "code_reviewer"]) {
      const prompt = fake.calls(role)[0]!.prompt;
      if (role !== "implementer") expect(prompt, role).toContain("**Codex, after discussing it with Claude Code:**\nSYNTHESIS: keep the old format readable for old readers.");
      for (const draft of ["DRAFT: keep it.", "DRAFT 2:", "REVIEW: say why."]) expect(prompt, role).not.toContain(draft);
    }
    // The implementer goes on in the run's critic session, which was told it; never in the chat's Claude session.
    const [critic, implementer] = [fake.calls("plan_reviewer")[0]!, fake.calls("implementer")[0]!];
    expect([critic.resumed, implementer.resumed]).toEqual([undefined, critic.session]);
    expect(implementer.prompt).not.toContain("SYNTHESIS:");
    const chatSessions = fake.calls().filter((c) => c.role.startsWith("discuss_")).map((c) => c.session);
    expect(chatSessions).not.toContain(critic.session);
    // Plan sign-off continues the planner's session, which was told the conversation already.
    const signOff = fake.calls("plan_finalizer")[0]!;
    expect(signOff.resumed).toBe(fake.calls("planner")[0]!.session);
    expect(signOff.prompt).not.toContain("SYNTHESIS:");
  });
});

describe("Workflow with settings changed while it runs", () => {
  const ui = (): ChatUi & { lines: string[] } => {
    const lines: string[] = [];
    return { lines, info: (t) => void lines.push(t), setStatus: () => {}, setMode: () => {}, setRecipient: () => {}, setModels: () => {}, exit: () => {} };
  };
  const newChat = (u: ChatUi, bus: EventBus) => new Chat({
    cfg: h.cfg, workspace: h.repo, runsDir: h.runsDir, configFile: join(h.repo, ".agentduo", "config.yaml"),
    userConfigFile: join(h.runsDir, "..", "user-config.yaml"), bus, decider: new ScriptedDecider(), ui: u,
  });
  /** A second claude, at another path: its calls carry --via-alt, so the log tells which binary ran. */
  const altClaude = () => {
    // The fake's shim: a shell script passing "$@", or on Windows a claude.cmd passing %*.
    const path = join(t.path, "alt", basename(fake.path("claude")));
    mkdirSync(join(t.path, "alt"), { recursive: true });
    writeFileSync(path, readFileSync(fake.path("claude"), "utf8").replace(/ claude ("\$@"|%\*)/, " claude --via-alt $1"), { mode: 0o755 });
    return path;
  };
  const savedConfig = () => JSON.parse(readRun("config.json"));

  it("keeps the run's roles and limits, and gives agent options to its next call; the next run gets them all", async () => {
    const bus = new EventBus();
    const u = ui();
    const chat = newChat(u, bus);
    const alt = altClaude();
    fake.setScenario({ ...happy(), planner: [{ sleep: 1200, output: plan() }] });
    bus.on((e) => {
      if (e.type !== "phase.started" || e.phase !== "PLAN") return;
      setTimeout(() => {
        chat.follow(settings.value("agents.plan_reviewer", "codex"));
        chat.follow(settings.value("agents.implementer", "codex"));
        chat.follow(settings.value("limits.max_retries", 0));
        chat.follow(settings.value("limits.agent_timeout_sec", 7));
        chat.follow(settings.value("limits.max_consecutive_gate_failures", 1));
        chat.follow(settings.value("claude.bin", alt));
        chat.follow(settings.value("claude.role_args.plan_reviewer", ["--max-turns", "9"]));
      }, 200);
    });
    try {
      await chat.submit("/pipeline Make app.txt fixed");
      await chat.idle();
      expect(stateOf(h).phase).toBe("DONE");
      // The roles stayed as the run started: Claude critiqued and implemented, through the binary set meanwhile.
      for (const role of ["plan_reviewer", "implementer"]) {
        const calls = fake.calls(role);
        expect(calls.map((c) => c.backend), role).toEqual(["claude"]);
        expect(calls[0]!.args, role).toContain("--via-alt");
      }
      expect(fake.calls("plan_reviewer")[0]!.args).toEqual(expect.arrayContaining(["--max-turns", "9"]));
      const saved = savedConfig();
      expect(saved.agents).toMatchObject({ plan_reviewer: "claude", implementer: "claude" });
      expect(saved.limits).toMatchObject({ max_retries: h.cfg.limits.max_retries, agent_timeout_sec: h.cfg.limits.agent_timeout_sec, max_consecutive_gate_failures: 3 });
      expect(saved.claude.bin).toBe(alt);
      expect(saved.claude.role_args.plan_reviewer).toEqual(["--max-turns", "9"]);
      expect(u.lines.some((l) => l.includes("from the next agent call"))).toBe(false); // followed quietly
      // A new run takes every change: Codex critiques and implements, with the new limits.
      fake.setScenario({ ...happy(), plan_reviewer: [{ output: critique(true) }], implementer: [{ write: { "app.txt": "fixed\n" }, output: impl() }] });
      await chat.submit("/pipeline Make app.txt fixed again");
      await chat.idle();
      expect(fake.calls("plan_reviewer").map((c) => c.backend)).toEqual(["claude", "codex"]);
      expect(fake.calls("implementer").map((c) => c.backend)).toEqual(["claude", "codex"]);
      expect(savedConfig().limits).toMatchObject({ max_retries: 0, agent_timeout_sec: 7, max_consecutive_gate_failures: 1 });
    } finally {
      await chat.stop();
    }
  });

  it("resumes a stopped run with its saved roles and limits, and the chat's agent options on top", async () => {
    const bus = new EventBus();
    const u = ui();
    const chat = newChat(u, bus);
    fake.setScenario({ ...happy(), plan_reviewer: [{ sleep: 3000, output: critique(true) }] });
    let stopped = false;
    bus.on((e) => {
      if (e.type !== "phase.started" || e.phase !== "PLAN_REVIEW" || stopped) return;
      stopped = true;
      setTimeout(() => chat.escape(), 300);
    });
    try {
      await chat.submit("/pipeline Make app.txt fixed");
      await chat.idle();
      expect(stateOf(h).inProgress?.phase ?? stateOf(h).phase).toBe("PLAN_REVIEW");
      chat.follow(settings.value("agents.implementer", "codex"));
      chat.follow(settings.value("limits.max_review_rounds", 9));
      chat.follow(settings.claudeModel("opus"));
      fake.setScenario(happy());
      await chat.submit("/resume");
      await chat.idle();
      expect(stateOf(h).phase, JSON.stringify(stateOf(h).humanReview)).toBe("DONE");
      expect(fake.calls("implementer").map((c) => c.backend)).toEqual(["claude"]);
      expect(fake.calls("implementer")[0]!.args).toEqual(expect.arrayContaining(["--model", "opus"]));
      const saved = savedConfig();
      expect(saved.agents.implementer).toBe("claude");
      expect(saved.limits.max_review_rounds).toBe(h.cfg.limits.max_review_rounds);
      expect(saved.claude.model).toBe("opus");
      expect(stateOf(h).limits.reviewRounds).toBe(h.cfg.limits.max_review_rounds);
    } finally {
      await chat.stop();
    }
  });

  it("keeps a discussion's round limit as it started, while a model changed meanwhile reaches its next turn", async () => {
    const bus = new EventBus();
    const chat = newChat(ui(), bus);
    const finished: number[] = [];
    bus.on((e) => {
      if (e.type === "discussion.finished") finished.push(e.rounds);
      if (e.type === "turn.started" && e.discussion?.step === "answer") {
        setTimeout(() => {
          chat.follow(settings.value("limits.max_discussion_rounds", 1));
          chat.follow(settings.claudeModel("opus"));
        }, 100);
      }
    });
    fake.setScenario({
      discuss_answer: [{ sleep: 700, answer: "v1" }], discuss_critique: [{ answer: "No.\nVERDICT: REVISE" }], discuss_revise: [{ answer: "v2" }],
      discuss_synthesis: [{ answer: "done" }],
    });
    try {
      chat.selectRecipient("codex");
      await chat.submit("/discuss Which queue?");
      await chat.idle();
      // Three reviews (the limit it started with), not one; Claude, the critic, ran its reviews with the new model.
      expect(finished).toEqual([3]);
      expect(fake.calls("discuss_critique").map((c) => c.args.includes("opus"))).toEqual([true, true, true]);
      expect(chat.config.limits.max_discussion_rounds).toBe(1);
    } finally {
      await chat.stop();
    }
  });
});

describe("Workflow: context shared between the agents", () => {
  /** Two planning rounds and two implementation rounds; the code reviewer leaves a file of its own in round 1. */
  const twoRounds = (): Scenario => ({
    planner: [{ output: plan("v1") }, { output: plan("v2", { feedback_resolution: [{ issue_id: "C1", decision: "accepted", rationale: "ok" }] }) }],
    plan_reviewer: [{ output: critique(false, [issue("C1")]) }, { output: critique(true) }],
    plan_finalizer: [{ output: approval(true) }],
    implementer: [{ write: { "app.txt": "fixed\n" }, output: impl() }, { write: { "app.txt": "fixed\nedge case handled\n" }, output: impl("completed", ["F1"]) }],
    code_reviewer: [{ write: { "scratch.txt": "reviewer's\n" }, output: review(false, [finding("F1")]) }, { output: review(true, [], ["F1"]) }],
  });
  const calls = (role: string) => fake.calls(role).filter((c) => !c.lost);

  it("continues each role's session with only what is new; the plan critic's goes on as the implementer's, and no other passes between roles", async () => {
    expect(await start(twoRounds())).toBe(0);
    const [planner1, planner2] = calls("planner");
    const [critic1, critic2] = calls("plan_reviewer");
    const [impl1, impl2] = calls("implementer");
    const [review1, review2] = calls("code_reviewer");
    const signOff = calls("plan_finalizer")[0]!;
    for (const first of [planner1, critic1, review1]) expect(first!.resumed).toBeUndefined();
    expect(planner2!.resumed).toBe(planner1!.session);
    expect(signOff.resumed).toBe(planner1!.session);
    expect(critic2!.resumed).toBe(critic1!.session);
    // Claude critiques the plan, implements it and fixes it in one session.
    expect([impl1!.resumed, impl2!.resumed, impl1!.session, impl2!.session]).toEqual(Array(4).fill(critic1!.session));
    expect(review2!.resumed).toBe(review1!.session);
    // Three sessions: the planner's (with its sign-off), the critic's and implementer's, and the reviewer's.
    expect(new Set(fake.calls().map((c) => c.session)).size).toBe(3);
    const st = stateOf(h);
    expect(st.sessions).toEqual({
      planner: { backend: "codex", id: planner1!.session, tree: expect.any(String), notes: 0, repoNotes: 0, planHash: st.finalPlanHash, reviewed: null },
      [SHARED_SESSION]: expect.objectContaining({ backend: "claude", id: critic1!.session, role: "implementer", planHash: st.finalPlanHash }),
      code_reviewer: { backend: "codex", id: review1!.session, tree: expect.any(String), notes: 0, repoNotes: 0, planHash: st.finalPlanHash, reviewed: st.lastSnapshot!.commit },
    });
    for (const c of [planner2, critic2, signOff, impl2, review2]) {
      expect(c!.prompt, c!.role).toContain("this message continues your session");
      expect(c!.prompt, c!.role).not.toContain("Make app.txt fixed");
    }
    for (const c of [planner1, critic1, review1]) expect(c!.prompt, c!.role).toContain("## Task\nMake app.txt fixed");
    // The critic's session becomes the implementer's: told so, given the whole job, the final plan and how it became final.
    expect(impl1!.prompt).toContain("This message continues the session in which you were the **plan critic** until now. From this turn on you are the **Implementer**");
    expect(impl1!.prompt).not.toContain("## Task\nMake app.txt fixed");
    expect(impl1!.prompt).toContain("## Final approved plan (v2)\nThe version you reviewed in your last turn as plan critic, now final.");
    for (const part of ["# Plan v2: v2", "## Acceptance criteria", "**AC1**", "- The planner signed the plan off: final decision", "## How to work", "Implement the plan now"]) {
      expect(impl1!.prompt, part).toContain(part);
    }
    // The critique's first version was revised: the implementer works from v2, the one that was signed off.
    expect(impl1!.prompt).not.toContain("# Plan v1");
    expect(impl1!.args).toContain("--json-schema");
    expect(impl1!.args[impl1!.args.indexOf("--json-schema") + 1]).toContain("files_changed");
    expect(planner2!.prompt).toContain("problem"); // the critique's issue
    expect(planner2!.prompt).not.toContain("as JSON");
    expect(critic2!.prompt).toContain("# Plan v2: v2");
    // The shared session holds the critic's round-1 critique (its key matches the one critique.r1.json gives back): pointed to, not repeated.
    expect(critic2!.prompt).toContain("## Your critique from the previous round\nYour last answer in this session.");
    expect(critic2!.prompt).not.toContain("- `C1` [high] problem");
    // The implementer is told what changed after its turn (the reviewer's file), not its own edit.
    expect(impl2!.prompt).toContain("## Files changed since your last turn");
    expect(impl2!.prompt).toContain("- A `scratch.txt`");
    expect(impl2!.prompt).not.toContain("- M `app.txt`");
    expect(impl2!.prompt).toContain("`F1`");
    expect(impl2!.prompt).not.toContain("# Plan v2");
    // The reviewer gets the changes since the revision it reviewed, not the whole diff again.
    const reviewed = JSON.parse(readRun("review.r1.json")).snapshot as string;
    expect(review2!.prompt).toContain("## Changes since the revision you last reviewed (`" + reviewed + "` → ");
    expect(review2!.prompt).toContain("+edge case handled");
    expect(review2!.prompt).not.toContain("\n+fixed\n+edge case handled");
    expect(review2!.prompt).toContain("- M `app.txt`");
    expect(JSON.parse(readRun("review.r2.json")).resumed_session).toBe(true);
    expect(JSON.parse(readRun("review.r1.json")).resumed_session).toBe(false);
  });

  it("starts a fresh session with the whole prompt when the CLI lost the one to continue, without spending a retry", async () => {
    expect(await start({ ...twoRounds(), sessions: { lost: true } }, { limits: { max_retries: 0 } })).toBe(0);
    const lost = fake.calls().filter((c) => c.lost).map((c) => c.role);
    // The implementer's first turn tries the critic's session too.
    expect(lost).toEqual(["planner", "plan_reviewer", "plan_finalizer", "implementer", "implementer", "code_reviewer"]);
    for (const role of ["planner", "plan_reviewer", "plan_finalizer", "implementer", "code_reviewer"]) {
      for (const c of calls(role)) {
        expect(c.resumed, role).toBeUndefined();
        expect(c.prompt, role).toContain("## Task\nMake app.txt fixed");
      }
    }
    expect(stateOf(h).history.map((x) => `${x.phase}:${x.status}`)).toContain("CODE_REVIEW:approved");
    expect(h.events.filter((e) => e.type === "agent.retry")).toHaveLength(6);
  });

  it("keeps no session when the user's args turn the CLI's sessions off, and passes their flag once", async () => {
    expect(await start(twoRounds(), { codex: { args: ["--ephemeral"] }, claude: { args: ["--no-session-persistence"] } })).toBe(0);
    for (const c of fake.calls()) {
      expect(c.resumed, c.role).toBeUndefined();
      expect(c.args.filter((a) => a === "--ephemeral" || a === "--no-session-persistence"), c.role).toHaveLength(1);
      if (c.role !== "plan_finalizer") expect(c.prompt, c.role).toContain("## Task\nMake app.txt fixed");
    }
    expect(stateOf(h).sessions ?? {}).toEqual({});
  });

  it("continues the sessions of a resumed run from its state, with the decision's note, and starts fresh on a role's new CLI", async () => {
    const scenario = { ...happy(), code_reviewer: [{ output: review(false, [finding("F1")]) }, { output: review(false, [finding("F1")]) }, { output: review(true, [], ["F1"]) }] };
    expect(await start(scenario, { limits: { max_review_rounds: 1 } })).toBe(2);
    const saved = stateOf(h).sessions!;
    expect(await resume(h, { decision: "resume", note: "try the edge case" })).toBe(2);
    const impl2 = calls("implementer")[1]!;
    expect(impl2.resumed).toBe(saved[SHARED_SESSION]!.id);
    expect(impl2.resumed).toBe(calls("plan_reviewer")[0]!.session);
    expect(impl2.prompt).toContain("this message continues your session");
    expect(impl2.prompt).toContain("## New notes from the human operator (highest priority)\n- (");
    expect(impl2.prompt).toContain("try the edge case");
    expect(calls("code_reviewer")[1]!.resumed).toBe(saved.code_reviewer!.id);
    // The implementer moves to Codex: its Claude session cannot go on there.
    h.cfg = testConfig(fake, { limits: { max_review_rounds: 1 }, agents: { ...h.cfg.agents, implementer: "codex" } });
    expect(await resume(h, { decision: "resume" })).toBe(0);
    const impl3 = calls("implementer")[2]!;
    expect([impl3.backend, impl3.resumed]).toEqual(["codex", undefined]);
    expect(impl3.prompt).toContain("## Task\nMake app.txt fixed");
    // On another CLI than the critic's, the implementer keeps a session of its own; the Claude one is not passed to Codex.
    expect(stateOf(h).sessions!.implementer).toMatchObject({ backend: "codex", id: impl3.session });
    expect(stateOf(h).sessions![SHARED_SESSION]).toMatchObject({ backend: "claude", id: saved[SHARED_SESSION]!.id });
  });

  /** The plan critic approves, the implementer runs once, and the reviewer's findings stop the run after each review. */
  const stopsAfterReviews = (): Scenario => ({
    ...happy(),
    implementer: [{ write: { "app.txt": "fixed\n" }, output: impl() }, { write: { "app.txt": "fixed\nmore\n" }, output: impl("completed", ["F1"]) }, { output: impl("completed", ["F1"]) }],
    code_reviewer: [{ output: review(false, [finding("F1")]) }, { output: review(false, [finding("F1")]) }, { output: review(true, [], ["F1"]) }],
  });

  it("keeps an implementer whose session was lost going in a fresh one with the whole prompt, and continues that one from there", async () => {
    expect(await start(stopsAfterReviews(), { limits: { max_review_rounds: 1 } })).toBe(2);
    const shared = stateOf(h).sessions![SHARED_SESSION]!.id;
    fake.forget(shared);
    h.events.length = 0;
    expect(await resume(h, { decision: "resume", note: "NOTE-AFTER-LOSS" })).toBe(2);
    const [lost] = fake.calls("implementer").filter((c) => c.lost);
    expect(lost).toMatchObject({ resumed: shared });
    const fresh = calls("implementer")[1]!;
    expect(fresh.resumed).toBeUndefined();
    for (const part of ["## Task\nMake app.txt fixed", "Roles: planner", "# Plan v1", "NOTE-AFTER-LOSS", "`F1`"]) expect(fresh.prompt, part).toContain(part);
    expect(h.events.filter((e) => e.type === "agent.retry").map((e) => e.type === "agent.retry" && e.reason)).toEqual([
      expect.stringContaining("the earlier session could not be continued"),
    ]);
    // The fresh session is the shared one now, as far as that turn went.
    const st = stateOf(h);
    expect(st.sessions![SHARED_SESSION]).toMatchObject({ id: fresh.session, role: "implementer", notes: st.humanNotes.length, tree: st.lastSnapshot!.tree });
    expect(await resume(h, { decision: "resume" })).toBe(0);
    const next = calls("implementer")[2]!;
    expect(next.resumed).toBe(fresh.session);
    expect(next.prompt).not.toContain("NOTE-AFTER-LOSS");
    expect(next.prompt).toContain("this message continues your session");
  });

  it("continues, in a run that kept a session per role, only the implementer's own, then keeps it as the shared one", async () => {
    expect(await start(stopsAfterReviews(), { limits: { max_review_rounds: 1 } })).toBe(2);
    // As an older agentduo left the run: a session per role, the critic's being one this CLI no longer has.
    const path = join(runDirOf(h), "state.json");
    const older = JSON.parse(readFileSync(path, "utf8"));
    const { role: _role, answers: _answers, withheld: _withheld, ...own } = older.sessions[SHARED_SESSION];
    older.sessions = { ...older.sessions, implementer: own, plan_reviewer: { ...own, id: "critic-legacy", tree: older.baseline?.tree ?? own.tree, notes: 0 } };
    delete older.sessions[SHARED_SESSION];
    writeFileSync(path, JSON.stringify(older));
    expect(await resume(h, { decision: "resume", note: "LEGACY-NOTE" })).toBe(2);
    expect(fake.calls().filter((c) => c.lost)).toEqual([]);
    const impl2 = calls("implementer")[1]!;
    expect(impl2.resumed).toBe(own.id);
    // Its own cursors: the note is new, and nothing it was told before is told again.
    expect(impl2.prompt).toContain("this message continues your session");
    expect(impl2.prompt).toContain("LEGACY-NOTE");
    expect(impl2.prompt).not.toContain("# Plan v1");
    const sessions = stateOf(h).sessions!;
    expect(sessions[SHARED_SESSION]).toMatchObject({ id: own.id, role: "implementer" });
    expect(sessions.implementer).toBeUndefined();
    expect(sessions.plan_reviewer!.id).toBe("critic-legacy");
  });

  it("gives an implementer that goes on in the critic's session the plan revised after the critic's last turn there", async () => {
    const scenario = {
      ...happy(),
      planner: [{ output: plan("v1") }, { output: plan("v2", { feedback_resolution: [{ issue_id: "C1", decision: "accepted", rationale: "ok" }] }) }],
      plan_reviewer: [{ output: critique(false, [issue("C1")]) }, { output: critique(true) }],
    };
    expect(await start(scenario, { limits: { max_planning_rounds: 1 } })).toBe(2);
    const critic1 = calls("plan_reviewer")[0]!;
    // Its second round runs on its own: the user turned the critic's sessions off.
    h.cfg = testConfig(fake, { claude: { role_args: { plan_reviewer: ["--no-session-persistence"] } } });
    expect(await resume(h, { decision: "revise", note: "REVISE-NOTE" })).toBe(0);
    const critic2 = calls("plan_reviewer")[1]!;
    expect(critic2.resumed).toBeUndefined();
    expect(critic2.args.filter((a) => a === "--no-session-persistence")).toHaveLength(1);
    expect(critic2.prompt).toContain("## Task\nMake app.txt fixed");
    const impl = calls("implementer")[0]!;
    expect(impl.resumed).toBe(critic1.session);
    // The session last saw v1, under review: the implementer gets v2, whole and marked new, and the note it was not given.
    expect(impl.prompt).toContain("## Final approved plan (v2) (new since your last turn)\nIt changed after your last turn as plan critic");
    expect(impl.prompt).toContain("# Plan v2: v2");
    expect(impl.prompt).toContain("REVISE-NOTE");
    expect(impl.prompt).toContain("- The planner signed the plan off: final decision");
  });

  it("keeps the critic's and the implementer's sessions apart on two CLIs, and passes no session id between them", async () => {
    expect(await start(twoRounds(), { agents: { planner: "codex", plan_reviewer: "codex", implementer: "claude", code_reviewer: "codex" } })).toBe(0);
    const [critic1, critic2] = calls("plan_reviewer");
    const [impl1, impl2] = calls("implementer");
    expect([critic1!.backend, impl1!.backend, critic2!.resumed, impl1!.resumed, impl2!.resumed]).toEqual(["codex", "claude", critic1!.session, undefined, impl1!.session]);
    expect(impl1!.prompt).toContain("## Task\nMake app.txt fixed");
    const sessions = stateOf(h).sessions!;
    expect(sessions[SHARED_SESSION]).toBeUndefined();
    expect([sessions.plan_reviewer!.backend, sessions.plan_reviewer!.id, sessions.implementer!.backend, sessions.implementer!.id])
      .toEqual(["codex", critic1!.session, "claude", impl1!.session]);
  });

  it("shares the session of a critic and an implementer with models, efforts and flags of their own, each call with its role's", async () => {
    expect(await start(twoRounds(), {
      claude: {
        role_models: { plan_reviewer: "opus-critic", implementer: "sonnet-impl" }, role_efforts: { plan_reviewer: "high" },
        role_args: { implementer: ["--permission-mode", "acceptEdits"], plan_reviewer: ["--permission-mode", "plan"] },
      },
    })).toBe(0);
    const critic = calls("plan_reviewer");
    const impl = calls("implementer");
    expect([impl[0]!.resumed, impl[1]!.resumed]).toEqual([critic[0]!.session, critic[0]!.session]);
    const flag = (args: string[], name: string) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
    for (const c of critic) {
      expect([flag(c.args, "--model"), flag(c.args, "--effort"), flag(c.args, "--permission-mode")]).toEqual([["opus-critic"], ["high"], ["plan"]]);
      expect(flag(c.args, "--json-schema")[0]).toContain("conflicts");
    }
    for (const c of impl) {
      expect([flag(c.args, "--model"), flag(c.args, "--effort"), flag(c.args, "--permission-mode")]).toEqual([["sonnet-impl"], [], ["acceptEdits"]]);
      expect(flag(c.args, "--json-schema")[0]).toContain("files_changed");
    }
  });

  it("runs an implementer whose sessions are off on its own, leaving the critic's session as the critic left it", async () => {
    expect(await start(twoRounds(), { claude: { role_args: { implementer: ["--no-session-persistence"] } } })).toBe(0);
    const [critic1, critic2] = calls("plan_reviewer");
    expect(critic2!.resumed).toBe(critic1!.session);
    for (const c of calls("implementer")) {
      expect(c.resumed).toBeUndefined();
      expect(c.args.filter((a) => a === "--no-session-persistence")).toHaveLength(1);
      expect(c.prompt).toContain("## Task\nMake app.txt fixed");
    }
    const sessions = stateOf(h).sessions!;
    expect(sessions[SHARED_SESSION]).toMatchObject({ id: critic1!.session, role: "plan_reviewer" });
    expect(sessions.implementer).toBeUndefined();
  });

  it("passes on what agents recorded about the repository while it holds, never to the role that judges its author", async () => {
    const notes = (...list: Array<[string, string]>) => ({ repo_notes: list.map(([path, note]) => ({ path, note })) });
    expect(await start({
      planner: [{ output: plan("v1", notes(["check.mjs", "CHECK-NOTE"], ["README.md", "README-NOTE"], ["nope.txt", "MISSING-NOTE"])) }],
      plan_reviewer: [{ output: { ...critique(true), ...notes(["README.md", "CRITIC-NOTE"]) } }],
      plan_finalizer: [{ output: approval(true) }],
      implementer: [
        { write: { "app.txt": "fixed\n", "README.md": "demo, fixed\n" }, output: { ...impl(), ...notes(["app.txt", "IMPL-NOTE"]) } },
        { write: { "app.txt": "fixed\nedge case handled\n" }, output: impl("completed", ["F1"]) },
      ],
      code_reviewer: [{ output: { ...review(false, [finding("F1")]), ...notes(["check.mjs", "REVIEW-NOTE"]) } }, { output: review(true, [], ["F1"]) }],
    })).toBe(0);
    const prompt = (role: string, i = 0) => calls(role)[i]!.prompt;
    // The critic checks the planner's assumptions itself.
    expect(prompt("plan_reviewer")).not.toContain("CHECK-NOTE");
    // Plan sign-off continues the planner's session: only the critic's note is new to it.
    expect(prompt("plan_finalizer")).toContain("## New repository notes");
    expect(prompt("plan_finalizer")).toContain("- `README.md`: CRITIC-NOTE (Claude Code, plan critic)");
    expect(prompt("plan_finalizer")).not.toContain("CHECK-NOTE");
    // The implementer goes on in the critic's session: it gets the planner's notes the critic was never given, not the critic's own.
    expect(calls("implementer")[0]!.resumed).toBe(calls("plan_reviewer")[0]!.session);
    expect(prompt("implementer")).toContain("## New repository notes");
    for (const note of ["- `check.mjs`: CHECK-NOTE (Codex, planner)", "- `README.md`: README-NOTE (Codex, planner)"]) expect(prompt("implementer"), note).toContain(note);
    expect(prompt("implementer")).not.toContain("CRITIC-NOTE");
    expect(prompt("implementer")).not.toContain("MISSING-NOTE");
    // README.md changed in the implementation: its notes no longer hold. The implementer's own never reach its reviewer.
    expect(prompt("code_reviewer")).toContain("CHECK-NOTE");
    for (const note of ["README-NOTE", "CRITIC-NOTE", "IMPL-NOTE"]) expect(prompt("code_reviewer"), note).not.toContain(note);
    // The implementer's next turn is given the reviewer's note, and none of the ones its session has.
    expect(prompt("implementer", 1)).toContain("- `check.mjs`: REVIEW-NOTE (Codex, code reviewer)");
    expect(prompt("implementer", 1)).not.toContain("CHECK-NOTE");
    expect(stateOf(h).repoNotes!.map((n) => `${n.role}:${n.note}`)).toEqual([
      "planner:CHECK-NOTE", "planner:README-NOTE", "plan_reviewer:CRITIC-NOTE", "implementer:IMPL-NOTE", "code_reviewer:REVIEW-NOTE",
    ]);
  });
});

describe("Workflow: a blocked implementer runs again only on something new", () => {
  const blocked = (reason = "API key needed") => ({ output: impl("blocked", [], reason) });
  const fixed = () => ({ write: { "app.txt": "fixed\n" }, output: impl() });
  const notJson = () => ({ raw: "not json" });
  const holds = () => stateOf(h).history.filter((e) => e.agent === "orchestrator" && e.status === "no_progress");

  it("holds a resume with nothing new, calling no agent, and says what the implementer needs", async () => {
    expect(await start({ ...happy(), implementer: [blocked(), fixed()] })).toBe(2);
    let st = stateOf(h);
    expect(st.humanReview).toMatchObject({ reason: "implementer_blocked", resumePhase: "IMPLEMENT", details: [] });
    expect(st.humanReview!.message).toContain("the implementer is blocked: API key needed. It needs something from you: 'resume' with a --note");
    expect(st.blocker).toMatchObject({ reason: "API key needed", key: "api key needed", round: 1, repeats: 1 });
    const { agentCalls, tokens, sessions } = st;
    for (let i = 0; i < 2; i++) {
      expect(await resume(h, { decision: "resume" })).toBe(2);
      st = stateOf(h);
      expect(st.humanReview).toMatchObject({ reason: "no_progress", fromPhase: "IMPLEMENT", resumePhase: "IMPLEMENT" });
      expect(st.humanReview!.message).toContain("so it was not run again (that would repeat the same call): API key needed. Give it what it needs");
      expect(st.humanReview!.details).toEqual(["blocked in round 1",
        "unchanged since: the workspace's files, your notes, the final plan, the open review findings, the implementer's settings (agentduo's and its CLI's), your answers to the agents' questions"]);
    }
    // Nothing ran and nothing moved: the round, its blocker, its usage and its sessions are as they were.
    expect(fake.calls("implementer")).toHaveLength(1);
    expect([st.agentCalls, st.tokens, st.sessions, st.implRound, st.blocker?.repeats]).toEqual([agentCalls, tokens, sessions, 1, 1]);
    expect(holds()).toHaveLength(2);
    expect(readRun("report.md")).toContain(`duo resume ${st.taskId} --decision resume --note "<what the implementer needs>"`);
    // A note is something new: the implementer gets it, and the run goes on.
    expect(await resume(h, { decision: "resume", note: "the key is in .env.example" })).toBe(0);
    expect(fake.calls("implementer")).toHaveLength(2);
    expect(fake.calls("implementer")[1]!.prompt).toContain("the key is in .env.example");
    st = stateOf(h);
    expect([st.phase, st.blocker]).toEqual(["DONE", null]);
  });

  it("asks again in-process, without running the implementer, until it gets something new", async () => {
    const decider = new ScriptedDecider([{ decision: "resume" }, { decision: "resume" }, { decision: "resume", note: "use the staging key" }]);
    expect(await start({ ...happy(), implementer: [blocked(), fixed()] }, undefined, { decider })).toBe(0);
    expect(decider.seen).toEqual(["implementer_blocked", "no_progress", "no_progress"]);
    expect(fake.calls("implementer")).toHaveLength(2);
    expect(h.events.filter((e) => e.type === "human.required").map((e) => e.type === "human.required" && e.review.reason))
      .toEqual(["implementer_blocked", "no_progress", "no_progress"]);
  });

  it("runs it again, with no note, once the workspace's files or the implementer's settings changed", async () => {
    const reason = "config.json is missing";
    expect(await start({ ...happy(), implementer: [blocked(reason), blocked(reason), blocked(reason), fixed()] })).toBe(2);
    writeFileSync(join(h.repo, "config.json"), "{}\n");
    expect(await resume(h, { decision: "resume" })).toBe(2);
    expect(fake.calls("implementer")).toHaveLength(2);
    // The same blocker again, and the attempt changed no file: what it got since did not unblock it.
    let st = stateOf(h);
    expect([st.humanReview?.reason, st.blocker?.repeats]).toEqual(["implementer_blocked", 2]);
    expect(st.humanReview!.details).toEqual([expect.stringContaining("the same blocker 2 times in a row, the last attempt changing no file")]);
    // agentduo's settings for the implementer (here its permission mode, which /claude permission-mode changes).
    h.cfg = testConfig(fake, { claude: { role_args: { implementer: ["--permission-mode", "acceptEdits"] } } });
    expect(await resume(h, { decision: "resume" })).toBe(2);
    expect(fake.calls("implementer")).toHaveLength(3);
    expect(stateOf(h).blocker?.repeats).toBe(3);
    expect(await resume(h, { decision: "resume" })).toBe(2);
    expect(stateOf(h).humanReview!.details[0]).toBe("blocked in round 1, 3 times in a row");
    // Claude's own settings: a rule saved to .claude/settings.local.json, which snapshots leave out.
    mkdirSync(join(h.repo, ".claude"), { recursive: true });
    writeFileSync(join(h.repo, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(npm test:*)"] } }));
    expect(await resume(h, { decision: "resume" })).toBe(0);
    expect(fake.calls("implementer")).toHaveLength(4);
    st = stateOf(h);
    expect([st.phase, st.blocker]).toEqual(["DONE", null]);
  });

  it("retries a failed implementer call on a resume with nothing new: a failure is not a blocker", async () => {
    // Blocked; the note's attempt fails (continued session, then a fresh one with the same invalid answer, which ends the
    // call); a plain resume retries it.
    expect(await start({ ...happy(), implementer: [blocked(), notJson(), notJson(), fixed()] })).toBe(2);
    expect(await resume(h, { decision: "resume", note: "the key is in .env.example" })).toBe(2);
    let st = stateOf(h);
    expect(st.humanReview!.reason).toBe("agent_error");
    expect(st.blocker).toMatchObject({ reason: "API key needed", repeats: 1 });
    const before = fake.calls("implementer").length;
    expect(await resume(h, { decision: "resume" })).toBe(0);
    expect(fake.calls("implementer").length).toBe(before + 1);
    st = stateOf(h);
    expect([st.phase, st.blocker]).toEqual(["DONE", null]);
  });

  it("forgets the blocker when you re-plan, and aborts a held run as any other", async () => {
    expect(await start({ ...happy(), implementer: [blocked(), fixed()] })).toBe(2);
    expect(await resume(h, { decision: "revise", note: "do it without the API" })).toBe(0);
    let st = stateOf(h);
    expect([st.phase, st.blocker, st.implRound]).toEqual(["DONE", null, 2]);
    expect(await start({ ...happy(), implementer: [blocked()] })).toBe(2);
    expect(await resume(h, { decision: "resume" })).toBe(2);
    expect(await resume(h, { decision: "abort" })).toBe(3);
    st = stateOf(h);
    expect([st.phase, fake.calls("implementer").length]).toEqual(["ABORTED", 3]);
  });
});

describe("Workflow: review findings kept in step with the code", () => {
  const warnings = () => stateOf(h).warnings;
  const record = (name: string) => JSON.parse(readRun(name));
  const stopAfter = (wf: { requestStop(): void }, bus: EventBus, phase: string) => bus.on((e) => {
    if (e.type === "step.completed" && e.entry.phase === phase) wf.requestStop();
  });

  it("keeps a blocked attempt's fixes and answers, and its re-run goes on from them with the open findings only", async () => {
    const scenario = {
      ...happy(),
      implementer: [
        { write: { "app.txt": "fixed\n" }, output: impl() },
        { write: { "app.txt": "fixed safely\n" }, output: impl("blocked", ["F1"], "F2 needs the API key") },
        { write: { "other.txt": "ok\n" }, output: impl("completed", ["F2"]) },
      ],
      code_reviewer: [{ output: review(false, [finding("F1"), finding("F2", "high", "other.txt")]) }, { output: review(true, [], ["F1", "F2"]) }],
    };
    expect(await start(scenario)).toBe(2);
    let st = stateOf(h);
    const revision = record("review.r1.json").snapshot as string;
    expect(st.findingsSource).toEqual({ round: 1, revision });
    expect(st.findingResponses).toEqual([{ id: "F1", resolution: "fixed", notes: "", round: 2, status: "blocked" }]);
    expect(record("implementation.r2.json")).toMatchObject({ attempt_changes: [{ status: "M", path: "app.txt" }], unanswered_findings: ["F2"] });
    // Blocked on F2, it could not answer it: no warning for that.
    expect(warnings().some((w) => w.includes("did not respond"))).toBe(false);

    expect(await resume(h, { decision: "resume", note: "the key is in .env.example" })).toBe(0);
    const rerun = fake.calls("implementer")[2]!.prompt;
    for (const s of ["## An earlier attempt of this round\nIt ended blocked: F2 needs the API key.", "- M `app.txt`", "continue from them",
      `Since \`${revision.slice(0, 12)}\` these files changed`, "#### Open: not answered since that review\n- `F2` [high] `other.txt:1`",
      "#### Answered since that review, not verified yet", "Your answer: fixed (round 2, in an attempt that ended blocked)"]) {
      expect(rerun).toContain(s);
    }
    // F1's file changed since the review; F2's did not.
    expect(rerun.slice(rerun.indexOf("`F1` [high]"))).toContain("its file changed since that revision");
    expect(rerun.slice(rerun.indexOf("`F2` [high]"), rerun.indexOf("#### Answered"))).not.toContain("its file changed");
    // The reviewer gets every answer since its review, the blocked attempt's too, and checks them against this revision.
    const reviewPrompt = fake.calls("code_reviewer")[1]!.prompt;
    expect(reviewPrompt).toContain("Implementer: fixed (round 2, in an attempt that ended blocked)");
    expect(reviewPrompt).toMatch(/`F2` \[high\] `other\.txt:1` — bad {2}\n {2}Recommendation: fix {2}\n {2}Implementer: fixed \(round 2\)/);
    // The round's record has both attempts.
    const r2 = record("implementation.r2.json");
    expect(r2.earlier_attempts).toEqual([{ snapshot: expect.any(String), status: "blocked", summary: "implementation blocked", blocking_reason: "F2 needs the API key",
      addressed_findings: [{ finding_id: "F1", resolution: "fixed", notes: "" }], changes: [{ status: "M", path: "app.txt" }] }]);
    expect([r2.attempt_changes, r2.changes, r2.unanswered_findings]).toEqual([[{ status: "A", path: "other.txt" }],
      [{ status: "M", path: "app.txt" }, { status: "A", path: "other.txt" }], []]);
    st = stateOf(h);
    expect([st.phase, st.openFindings, st.findingsSource, st.findingResponses]).toEqual(["DONE", [], null, []]);
    expect(warnings().some((w) => w.includes("did not respond"))).toBe(false);
  });

  it("does not ask again about findings answered in a round whose gates then failed", async () => {
    const scenario = {
      ...happy(),
      implementer: [
        { write: { "app.txt": "fixed\n" }, output: impl() },
        { write: { "app.txt": "broken\n" }, output: impl("completed", ["F1"]) },
        { write: { "app.txt": "fixed again\n" }, output: impl() },
      ],
      code_reviewer: [{ output: review(false, [finding("F1")]) }, { output: review(true, [], ["F1"]) }],
    };
    expect(await start(scenario)).toBe(0);
    const round3 = fake.calls("implementer")[2]!.prompt;
    for (const s of ["#### Answered since that review, not verified yet", "Your answer: fixed (round 2)", "Every finding is answered", "Failing quality gates"]) {
      expect(round3).toContain(s);
    }
    expect(round3).not.toContain("#### Open");
    expect(warnings().some((w) => w.includes("did not respond"))).toBe(false);
    expect(fake.calls("code_reviewer")[1]!.prompt).toContain("Implementer: fixed (round 2)");
    expect(readRun("report.md")).not.toContain("not re-reviewed yet");
  });

  it("gates and reviews the files as they are after changes made while the run was stopped", async () => {
    fake.setScenario(happy());
    const { wf, bus } = newWorkflow(h, "Make app.txt fixed");
    stopAfter(wf, bus, "IMPLEMENT");
    expect(await wf.run()).toBe(130);
    writeFileSync(join(h.repo, "notes.txt"), "added by hand\n");
    expect(await resume(h)).toBe(0);
    expect(warnings()).toContain("1 file(s) changed after the last snapshot, not by the run's last step: A notes.txt; VERIFY takes the workspace as it is now");
    expect(warnings().some((w) => w.startsWith("quality gates modified"))).toBe(false);
    const st = stateOf(h);
    expect([record("gates.r1.json").snapshot, record("review.r1.json").snapshot]).toEqual([st.lastSnapshot!.commit, st.lastSnapshot!.commit]);
    expect(fake.calls("code_reviewer")[0]!.prompt).toContain("notes.txt");
  });

  it("runs the gates again before a review when the files changed after they ran, and reviews only gated code", async () => {
    fake.setScenario({ ...happy(), implementer: [{ write: { "app.txt": "fixed\n" }, output: impl() }, { write: { "app.txt": "fixed\n" }, output: impl() }] });
    const { wf, bus } = newWorkflow(h, "Make app.txt fixed");
    stopAfter(wf, bus, "VERIFY");
    expect(await wf.run()).toBe(130);
    expect(stateOf(h).phase).toBe("CODE_REVIEW");
    // Broken by hand while the run was stopped: the gates' pass was for the code before.
    writeFileSync(join(h.repo, "app.txt"), "oops\n");
    expect(await resume(h)).toBe(0);
    const st = stateOf(h);
    expect(warnings()).toContain("1 file(s) changed after the last snapshot, not by the run's last step: M app.txt; CODE_REVIEW takes the workspace as it is now");
    expect(st.history.map((e) => `${e.phase} ${e.agent} ${e.status}`)).toEqual(expect.arrayContaining([
      "CODE_REVIEW orchestrator gates out of date", "VERIFY gates failed", "IMPLEMENT Claude completed", "VERIFY gates passed", "CODE_REVIEW Codex approved",
    ]));
    // The failing revision never reached the reviewer; the one it reviewed is the one the gates passed.
    expect(fake.calls("code_reviewer")).toHaveLength(1);
    expect(fake.calls("implementer")[1]!.prompt).toContain("check failed: app.txt is not fixed");
    expect(record("review.r2.json").snapshot).toBe(record("gates.r2.json").snapshot);
    expect(h.events.at(-1)).toMatchObject({ type: "run.finished", summary: "quality gates passed on the final code and the review approved" });
  });

  it("re-runs the gates once a round before a review, and never ends on gates of an earlier revision when the files keep changing", async () => {
    fake.setScenario({ ...happy(), code_reviewer: [{ output: review(true) }, { output: review(true) }] });
    const { wf, bus } = newWorkflow(h, "Make app.txt fixed");
    let n = 0;
    // Something writes a file each time a VERIFY step ends: the review still comes, but DONE never rests on stale gates.
    bus.on((e) => {
      if (e.type === "step.completed" && e.entry.phase === "VERIFY") writeFileSync(join(h.repo, "log.txt"), `${++n}\n`);
    });
    expect(await wf.run()).toBe(2);
    let st = stateOf(h);
    expect(st.humanReview).toMatchObject({ reason: "verification_stale", resumePhase: "VERIFY" });
    expect(st.humanReview!.message).toContain("the final code could not be verified: 3 time(s) in a row");
    expect(st.humanReview!.details).toEqual(expect.arrayContaining([expect.stringContaining("the quality gates ran on an earlier revision; changed since: M log.txt"),
      expect.stringContaining("the code changed after the review of round 1 approved it: M log.txt")]));
    expect(warnings()).toContain("the quality gates' results are out of date again (the quality gates ran on an earlier revision): the review gets them as they " +
      "are, and the run ends only once the gates ran on the code it ends with");
    // Bounded: two reviews and five gate steps, then a stop for your decision; never DONE, nothing waived.
    expect([fake.calls("code_reviewer").length, n, st.verification]).toEqual([2, 5, undefined]);
    expect(h.events.some((e) => e.type === "run.finished" && e.phase === "DONE")).toBe(false);

    // Once nothing changes them any more, resume verifies the files as they are: the gates run on the code the last
    // review approved, which needs no review again.
    expect(await resume(h, { decision: "resume" })).toBe(0);
    st = stateOf(h);
    expect([st.phase, fake.calls("code_reviewer").length, st.verification!.status, st.verification!.tree]).toEqual(["DONE", 2, "verified", st.gatesTree]);
    expect(h.events.at(-1)).toMatchObject({ type: "run.finished", summary: "quality gates passed on the final code and the review approved" });
  });
});

describe("Workflow: DONE rests on the final code", () => {
  const record = (name: string) => JSON.parse(readRun(name));
  const statuses = () => stateOf(h).history.map((e) => `${e.phase} ${e.agent} ${e.status}`).filter((s) => !s.startsWith("PLAN"));
  const notVerified = () => stateOf(h).history.filter((e) => e.status === "not verified").map((e) => e.summary);
  const gateRuns = () => h.events.filter((e) => e.type === "gate.started").length;
  /** Runs `act` once, when the reviewer's verdict comes in: after its review, before the run could end. */
  const afterReview = (bus: EventBus, act: () => void) => {
    let done = false;
    bus.on((e) => {
      if (!done && e.type === "message" && e.message.kind === "review") {
        done = true;
        act();
      }
    });
  };
  // A review that approves but finds a blocking problem there before the task: the run waits for you after the approval.
  const preexisting = finding("F2", "high", "layout.css", "pre_existing");
  const approvedThenPaused = (): Scenario => ({ ...happy(), code_reviewer: [{ output: review(true, [preexisting]) }, { output: review(true, [preexisting]) }] });

  it("ends on the gates and the review of the code as it is, running nothing again when nothing changed", async () => {
    expect(await start(happy())).toBe(0);
    const st = stateOf(h);
    const v = st.verification!;
    expect(v).toMatchObject({
      status: "verified", commit: st.lastSnapshot!.commit, tree: st.lastSnapshot!.tree, exceptions: [], gatesAt: st.gatesAt,
      gates: [{ name: "check", required: true, outcome: "passed", exitCode: 0 }], review: { round: 1, revision: st.lastSnapshot!.commit, approved: true },
    });
    expect(JSON.parse(readRun("verification.json"))).toEqual(v);
    expect([record("gates.r1.json").snapshot, record("review.r1.json").snapshot]).toEqual([v.commit, v.commit]);
    // The baseline and one VERIFY: the evidence was current, so nothing ran again.
    expect([gateRuns(), fake.calls("code_reviewer").length, notVerified()]).toEqual([2, 1, []]);
    expect(readRun("report.md")).toContain(`## Verification\n- verified: every required quality gate passed on the final code (\`${v.commit.slice(0, 12)}\`), ` +
      "and the review of round 1 approved it\n- gates: check passed (ran ");
  });

  it("does not end on an approval of code that changed after it: new and deleted files get the gates and a review first", async () => {
    fake.setScenario({ ...happy(), code_reviewer: [{ output: review(true) }, { output: review(true) }] });
    const { wf, bus } = newWorkflow(h, "Make app.txt fixed");
    afterReview(bus, () => {
      writeFileSync(join(h.repo, "notes.txt"), "added after the approval\n");
      rmSync(join(h.repo, "README.md"));
    });
    expect(await wf.run()).toBe(0);
    expect(statuses()).toEqual([
      "IMPLEMENT Claude completed", "VERIFY gates passed", "CODE_REVIEW Codex approved", "CODE_REVIEW orchestrator not verified",
      "VERIFY gates passed", "CODE_REVIEW Codex approved",
    ]);
    expect(notVerified()).toEqual(["the code changed after the review of round 1 approved it: D README.md, A notes.txt; the quality gates ran on an earlier " +
      "revision; changed since: D README.md, A notes.txt; running the quality gates, then the review, again"]);
    // The second review is of the files as they are, and DONE rests on that revision: gated, reviewed, the one delivered.
    expect(fake.calls("code_reviewer")).toHaveLength(2);
    expect(fake.calls("code_reviewer")[1]!.prompt).toContain("notes.txt");
    const v = stateOf(h).verification!;
    expect([record("gates.r1.json").snapshot, record("review.r1.json").snapshot, v.status]).toEqual([v.commit, v.commit, "verified"]);
    const files = git(h.repo, "ls-tree", "-r", "--name-only", v.commit).split("\n");
    expect([files.includes("notes.txt"), files.includes("README.md")]).toEqual([true, false]);
  });

  it("rejects gate results that a change before the end made stale: a broken file goes back to the implementer, never to DONE", async () => {
    fake.setScenario({
      ...happy(), implementer: [{ write: { "app.txt": "fixed\n" }, output: impl() }, { write: { "app.txt": "fixed again\n" }, output: impl() }],
      code_reviewer: [{ output: review(true) }, { output: review(true) }],
    });
    const { wf, bus } = newWorkflow(h, "Make app.txt fixed");
    afterReview(bus, () => writeFileSync(join(h.repo, "app.txt"), "oops\n"));
    expect(await wf.run()).toBe(0);
    expect(statuses()).toEqual([
      "IMPLEMENT Claude completed", "VERIFY gates passed", "CODE_REVIEW Codex approved", "CODE_REVIEW orchestrator not verified",
      "VERIFY gates failed", "IMPLEMENT Claude completed", "VERIFY gates passed", "CODE_REVIEW Codex approved",
    ]);
    expect(fake.calls("implementer")[1]!.prompt).toContain("check failed: app.txt is not fixed");
    expect(stateOf(h).verification).toMatchObject({ status: "verified", review: { round: 2 } });
    expect(readFileSync(join(h.repo, "app.txt"), "utf8")).toBe("fixed again\n");
  });

  it("does not let a review certify code the reviewer changed during its own turn", async () => {
    expect(await start({ ...happy(), code_reviewer: [{ write: { "app.txt": "fixed\nreviewer's tweak\n" }, output: review(true) }, { output: review(true) }] })).toBe(0);
    expect(stateOf(h).warnings).toContain("Codex (code reviewer) changed files: M app.txt");
    expect(notVerified()[0]).toMatch(/^the code changed after the review of round 1 approved it: M app\.txt;/);
    expect(fake.calls("code_reviewer")).toHaveLength(2);
    expect(fake.calls("code_reviewer")[1]!.prompt).toContain("reviewer's tweak");
    expect(git(h.repo, "show", `${stateOf(h).verification!.commit}:app.txt`)).toBe("fixed\nreviewer's tweak");
  });

  it("verifies the files as they are when you resume after editing them while the run waited", async () => {
    expect(await start(approvedThenPaused())).toBe(2);
    expect(stateOf(h).humanReview).toMatchObject({ reason: "preexisting_failures", resumePhase: "DONE" });
    writeFileSync(join(h.repo, "README.md"), "edited while the run waited\n");
    h.events.length = 0;
    expect(await resume(h, { decision: "resume" })).toBe(0);
    expect(notVerified()[0]).toMatch(/^the code changed after the review of round 1 approved it: M README\.md;/);
    expect(statuses().slice(-4)).toEqual(["HUMAN_REVIEW human resume", "CODE_REVIEW orchestrator not verified", "VERIFY gates passed", "CODE_REVIEW Codex approved"]);
    expect([gateRuns(), fake.calls("code_reviewer").length]).toEqual([1, 2]);
    const v = stateOf(h).verification!;
    expect(v).toMatchObject({ status: "exceptions", exceptions: ["finding F2"] });
    expect(git(h.repo, "show", `${v.commit}:README.md`)).toBe("edited while the run waited");
    expect(h.events.at(-1)).toMatchObject({ summary: "with accepted exceptions: quality gates passed on the final code and the review approved; " +
      "you accepted 1 pre-existing failure(s) outside the task's scope (finding F2)" });
  });

  it("ends straight away on a resume when nothing changed while the run waited: no gate and no review again", async () => {
    expect(await start(approvedThenPaused())).toBe(2);
    h.events.length = 0;
    expect(await resume(h, { decision: "resume" })).toBe(0);
    expect([gateRuns(), fake.calls("code_reviewer").length, notVerified(), stateOf(h).verification!.status]).toEqual([0, 1, [], "exceptions"]);
  });

  it("runs the gates again when their configuration changed though the code did not, keeping the review's approval", async () => {
    expect(await start(approvedThenPaused())).toBe(2);
    const before = record("gates.r1.json").config as string;
    // As `duo resume --reload-config` after the config file changed.
    h.cfg = testConfig(fake, { gates: [{ ...CHECK_GATE, timeout_sec: 30 }] });
    h.events.length = 0;
    expect(await resume(h, { decision: "resume" })).toBe(0);
    expect(notVerified()).toEqual(["the gate configuration changed since they ran: gate 'check': timeout 60s → 30s; running the quality gates again"]);
    expect([gateRuns(), fake.calls("code_reviewer").length]).toEqual([1, 1]);
    const v = stateOf(h).verification!;
    expect([v.config === before, v.config === record("gates.r1.json").config, v.status]).toEqual([false, true, "exceptions"]);
  });

  it("checks an older run's final code too, running the gates it cannot vouch for, and keeps a DONE it ended with before", async () => {
    expect(await start(approvedThenPaused())).toBe(2);
    // As an older agentduo left the run: no gate configuration, approval or final check recorded.
    const path = join(runDirOf(h), "state.json");
    const older = JSON.parse(readFileSync(path, "utf8"));
    for (const key of ["gatesConfig", "gatesAt", "reviewApproval", "finalCheck"]) delete older[key];
    writeFileSync(path, JSON.stringify(older));
    h.events.length = 0;
    expect(await resume(h, { decision: "resume" })).toBe(0);
    expect(notVerified()).toEqual(["it is not known which gate configuration they ran with (a run of an older agentduo); running the quality gates again"]);
    // The approval review.json records still covers the code: the gates run again, the review does not.
    expect([gateRuns(), fake.calls("code_reviewer").length, stateOf(h).verification!.status]).toEqual([1, 1, "exceptions"]);
    // A run that ended DONE before agentduo checked its final code stays DONE, said as it was then.
    const done = JSON.parse(readFileSync(path, "utf8"));
    delete done.verification;
    writeFileSync(path, JSON.stringify(done));
    h.events.length = 0;
    expect(await resume(h)).toBe(0);
    expect(h.events.at(-1)).toMatchObject({ type: "run.finished", phase: "DONE",
      summary: "quality gates passed and the review approved; you accepted 1 pre-existing failure(s) outside the task's scope (finding F2)" });
    expect(gateRuns()).toBe(0);
  });
});

describe("Workflow: contradictory requirements and pre-existing failures", () => {
  // A required gate that fails before any change, unrelated to the task (the layout), next to the task's own check.
  const LAYOUT = `import { existsSync } from "node:fs";
const ok = existsSync("layout.ok");
console.log(ok ? "layout ok" : "layout: 2 defects (header, footer)");
process.exit(ok ? 0 : 1);
`;
  const layoutGate = { name: "layout", command: `"${process.execPath}" layout.mjs`, required: true };
  const withLayout = (): ConfigOverrides => ({ gates: [CHECK_GATE, layoutGate] });
  const outOfScopePlan = () => plan("Demo plan", { baseline_failures: [
    { gate: "check", in_scope: true, rationale: "the task fixes app.txt" },
    { gate: "layout", in_scope: false, rationale: "the task says not to touch the layout" },
  ] });
  const preexistingGate = { gate: "layout", origin: "pre_existing" as const, evidence: "the same 2 defects as before the change; the diff does not touch the layout" };
  const record = (name: string) => JSON.parse(readRun(name));
  beforeEach(() => writeFileSync(join(h.repo, "layout.mjs"), LAYOUT));

  it("stops before any implementation when the plan leaves a required gate failing, and finishes only on what you accept", async () => {
    const scenario = {
      ...happy(),
      planner: [{ output: outOfScopePlan() }],
      code_reviewer: [{ output: { ...review(true), gate_failures: [preexistingGate] } }],
    };
    expect(await start(scenario, withLayout())).toBe(2);
    let st = stateOf(h);
    // The gates ran before the plan: both fail, and the planner was told so.
    expect(record("gates.baseline.json").results.map((g: { name: string; passed: boolean }) => [g.name, g.passed])).toEqual([["check", false], ["layout", false]]);
    expect(fake.calls("planner")[0]!.prompt).toContain("## Required gates that fail before any change\n- `check`\n- `layout`");
    expect(st.humanReview).toMatchObject({ reason: "requirements_conflict", fromPhase: "PLAN_REVIEW", resumePhase: "IMPLEMENT" });
    expect(st.humanReview!.details).toEqual(["the required gate 'layout' fails before any change and the plan leaves fixing it out of scope " +
      "(the task says not to touch the layout), but DONE needs every required gate to pass (quality_gates.require_tests_pass)"]);
    expect(fake.calls("implementer")).toHaveLength(0);
    expect(fake.calls("plan_finalizer")).toHaveLength(0);

    // "Implement as planned": the layout still fails after the change, as before it. It goes to the reviewer, not back
    // to the implementer, and the reviewer shows it is not the change's doing: the run asks instead of looping.
    expect(await resume(h, { decision: "resume" })).toBe(2);
    st = stateOf(h);
    expect(st.humanReview).toMatchObject({ reason: "preexisting_failures", resumePhase: "DONE" });
    expect(st.humanReview!.details).toEqual(["required gate 'layout' fails, as it did before the task (evidence: " + preexistingGate.evidence + ")"]);
    expect([fake.calls("implementer").length, fake.calls("code_reviewer").length, st.implRound]).toEqual([1, 1, 1]);
    expect(st.history.map((e) => `${e.phase} ${e.status}`)).toContain("VERIFY failing as before the task");
    expect(fake.calls("code_reviewer")[0]!.prompt).toContain("## Required gates that failed before the task too\n- `layout`");
    expect(st.phase).toBe("HUMAN_REVIEW");

    // Accepted by you, it ends DONE, saying so, and the report lists what you accepted.
    expect(await resume(h, { decision: "resume" })).toBe(0);
    st = stateOf(h);
    expect(st.phase).toBe("DONE");
    expect(h.events.at(-1)).toMatchObject({ type: "run.finished", summary: "with accepted exceptions: quality gates passed on the final code, except 'layout', " +
      "failing as before the task, and the review approved; you accepted 1 pre-existing failure(s) outside the task's scope (gate 'layout')" });
    // Accepted, never passed: the record keeps the gate's failure apart from the gates that passed.
    expect(st.verification).toMatchObject({ status: "exceptions", exceptions: ["gate 'layout'"], gates: [
      { name: "check", outcome: "passed" }, { name: "layout", outcome: "accepted", exitCode: 1 }] });
    expect([st.accepted!.conflicts.length, st.accepted!.failures.map((f) => f.id)]).toEqual([1, ["layout"]]);
    const report = readRun("report.md");
    expect(report).toContain("## Accepted by you\nThe run would have stopped on these; your decision let it go on.\n- [conflict, implemented as planned] the required gate 'layout'");
    expect(report).toContain("- [pre-existing gate] `layout` required gate 'layout' fails, as it did before the task — evidence: the same 2 defects");
    expect(report).toContain("## Quality gates before any change (baseline)");
  });

  it("asks before implementing when the critic finds a contradiction only you can settle, and re-plans with your settlement", async () => {
    const conflict = { id: "K1", description: "AC2 needs a page with no layout defect, but the task keeps the existing layout defects out of scope",
      between: ["AC2", "task: do not fix unrelated layout defects", "baseline: layout fails"] };
    const scenario = { ...happy(), plan_reviewer: [{ output: { ...critique(true), conflicts: [conflict] } }, { output: critique(true) }] };
    expect(await start(scenario)).toBe(2);
    let st = stateOf(h);
    expect(st.humanReview).toMatchObject({ reason: "requirements_conflict", details: [
      "K1: AC2 needs a page with no layout defect, but the task keeps the existing layout defects out of scope (between: AC2; task: do not fix unrelated layout defects; baseline: layout fails)",
    ] });
    expect(st.humanReview!.message).toContain("so nothing is implemented yet");
    expect(fake.calls("implementer")).toHaveLength(0);
    expect(fake.calls("plan_reviewer")[0]!.prompt).toContain("## Consistency check");
    expect(readRun("plan-feedback.md")).toContain("### Conflicts only the user can settle\n- `K1` AC2 needs");
    // Your note settles it: the planner re-plans with it, the critic finds no contradiction, and the run goes on.
    expect(await resume(h, { decision: "revise", note: "AC2 is about the new page only" })).toBe(0);
    expect(fake.calls("planner")[1]!.prompt).toContain("AC2 is about the new page only");
    st = stateOf(h);
    expect([st.phase, st.conflicts, st.accepted]).toEqual(["DONE", null, undefined]);
  });

  it("does not take a required gate's failure for pre-existing without the reviewer's evidence, nor a gate that passed before", async () => {
    const scenario = {
      ...happy(),
      planner: [{ output: outOfScopePlan() }],
      implementer: [{ write: { "app.txt": "fixed\n" }, output: impl() }, { write: { "app.txt": "fixed\n" }, output: impl() }],
      code_reviewer: [
        // No attribution of the layout gate: rejected, and asked again.
        { output: review(true) },
        // The change made it worse: the implementer's to fix.
        { output: { ...review(false), gate_failures: [{ gate: "layout", origin: "regression", evidence: "the diff moves the header" }] } },
        { output: { ...review(true), gate_failures: [preexistingGate] } },
      ],
    };
    expect(await start(scenario, withLayout())).toBe(2);
    expect(await resume(h, { decision: "resume" })).toBe(2);
    expect(fake.calls("code_reviewer")[1]!.prompt).toContain("'gate_failures' must attribute the failing required gate 'layout'");
    expect(fake.calls("implementer")[1]!.prompt).toContain("layout: 2 defects (header, footer)");
    const st = stateOf(h);
    expect([st.humanReview?.reason, st.implRound, fake.calls("code_reviewer").length]).toEqual(["preexisting_failures", 2, 3]);
    // Never DONE without your decision.
    expect(st.phase).toBe("HUMAN_REVIEW");
  });

  it("stops on blocking review findings that were there before the task and outside its scope, instead of looping on them", async () => {
    const preexisting = finding("F2", "high", "layout.css", "pre_existing");
    const scenario = {
      ...happy(),
      implementer: [{ write: { "app.txt": "fixed\n" }, output: impl() }, { write: { "app.txt": "fixed well\n" }, output: impl("completed", ["F1", "F2"]) }],
      code_reviewer: [
        { output: review(false, [finding("F1"), preexisting]) },
        { output: review(false, [preexisting]) },
        { output: review(true, [preexisting]) },
      ],
    };
    expect(await start(scenario)).toBe(2);
    // F1 is the task's: one fix round, told that F2 is not its to fix.
    expect(fake.calls("implementer")[1]!.prompt).toContain("The reviewer found it there before the task, outside the plan's scope (the same at the base revision): do not fix it");
    let st = stateOf(h);
    expect(st.humanReview).toMatchObject({ reason: "preexisting_failures", resumePhase: "CODE_REVIEW" });
    expect(st.humanReview!.message).toContain("and the reviewer reviews again, knowing that you did");
    expect(st.humanReview!.details).toEqual(["finding F2 [high] layout.css: bad (evidence: the same at the base revision)"]);
    expect(readRun("report.md")).toContain("(raised on `");
    expect(readRun("report.md")).toContain("; pre-existing, outside the task's scope)");
    // Accepted: the reviewer reviews again knowing it, and the run ends DONE with no further fix round.
    expect(await resume(h, { decision: "resume" })).toBe(0);
    expect(fake.calls("code_reviewer")[2]!.prompt).toContain("## Pre-existing failures the user accepted for this run\n- finding `F2`: [high] layout.css: bad");
    expect(fake.calls("implementer")).toHaveLength(2);
    st = stateOf(h);
    expect(st.phase).toBe("DONE");
    expect(h.events.at(-1)).toMatchObject({ summary: expect.stringContaining("; you accepted 1 pre-existing failure(s) outside the task's scope (finding F2)") });
  });

  it("never lets your acceptance of a gate's old failure cover a failure the change made worse", async () => {
    const worse = { gate: "layout", origin: "regression" as const, evidence: "a third defect (sidebar), which the diff causes" };
    const scenario = {
      ...happy(),
      planner: [{ output: outOfScopePlan() }],
      implementer: [{ write: { "app.txt": "fixed\n" }, output: impl() }, { write: { "app.txt": "fixed\nsidebar restored\n" }, output: impl() }],
      code_reviewer: [
        // Not approved yet: once you accept the layout gate's old failure, it reviews again.
        { output: { ...review(false), gate_failures: [preexistingGate] } },
        // It approves the change, but finds the accepted gate worse: that alone keeps the run from DONE.
        { output: { ...review(true), gate_failures: [worse] } },
        { output: { ...review(true), gate_failures: [preexistingGate] } },
      ],
    };
    expect(await start(scenario, withLayout())).toBe(2);
    expect(await resume(h, { decision: "resume" })).toBe(2);
    expect(stateOf(h).humanReview).toMatchObject({ reason: "preexisting_failures", resumePhase: "CODE_REVIEW" });
    expect(await resume(h, { decision: "resume" })).toBe(0);
    // Accepted, the gate is still the reviewer's to attribute; found worse, it is the implementer's to fix, accepted or not.
    const second = fake.calls("code_reviewer")[1]!.prompt;
    expect(second).toContain("## Required gates that failed before the task too\n- `layout`");
    expect(second).toContain("A gate the user accepted as failing before the task is listed too");
    expect(fake.calls("implementer")).toHaveLength(2);
    expect(fake.calls("implementer")[1]!.prompt).toContain("layout: 2 defects (header, footer)");
    const st = stateOf(h);
    expect(st.history.map((e) => `${e.phase} ${e.status}`).filter((x) => x.startsWith("CODE_REVIEW") || x.startsWith("IMPLEMENT"))).toEqual([
      "IMPLEMENT completed", "CODE_REVIEW changes requested", "CODE_REVIEW changes requested", "IMPLEMENT completed", "CODE_REVIEW approved",
    ]);
    // DONE only once the reviewer of the final code finds it failing as before: an exception, never a pass.
    expect(st.verification).toMatchObject({ status: "exceptions", exceptions: ["gate 'layout'"], gates: [{ name: "check", outcome: "passed" }, { name: "layout", outcome: "accepted" }] });
  });

  it("asks the reviewer for evidence of every blocking finding", async () => {
    const vague = { ...finding("F1"), evidence: " " };
    expect(await start({ ...happy(), code_reviewer: [{ output: review(false, [vague]) }, { output: review(true) }] })).toBe(0);
    expect(fake.calls("code_reviewer")[1]!.prompt).toContain("finding 'F1' is high, so its 'evidence' must say where it comes from");
  });
});

describe("Workflow: the task's scope", () => {
  // A reviewer's extra: something the task does not ask for, which the change does not cause.
  const extra = (id: string, severity: "critical" | "high" | "medium" | "low" = "high", evidence = "") =>
    ({ ...finding(id, severity, "ui.css", "out_of_scope"), evidence });

  it("reports findings outside the task's scope without a fix round, and refuses to hold the change back on them alone", async () => {
    const scenario = {
      ...happy(),
      code_reviewer: [
        // Changes requested for extras only: refused, and asked again.
        { output: review(false, [extra("F1"), extra("F2", "medium")]) },
        { output: review(true, [extra("F1"), extra("F2", "medium")]) },
      ],
    };
    expect(await start(scenario)).toBe(0);
    expect(fake.calls("code_reviewer")[0]!.prompt).toContain("- `out_of_scope`: an improvement or concern beyond what the task and its criteria ask");
    expect(fake.calls("code_reviewer")[1]!.prompt).toContain("'approved' is false, but no finding the task must fix or that only the user can settle remains " +
      "(F1, F2 are outside the task's scope, and those never hold back approval)");
    const st = stateOf(h);
    expect([st.phase, st.implRound, fake.calls("implementer").length]).toEqual(["DONE", 1, 1]);
    expect(messages().find((m) => m.kind === "review")!.items).toContain("[high] F1 ui.css:1 bad (outside the task's scope)");
    expect(readRun("report.md")).toContain("[review high] `F1` ui.css — bad (raised on `");
    expect(readRun("report.md")).toContain("; outside the task's scope, not the task's to fix)");
  });

  it("holds the change only to the plan's acceptance criteria: a finding the task must fix names the ones it fails", async () => {
    const untraced = finding("F1", "high", "app.txt", "in_scope");
    const scenario = {
      ...happy(),
      implementer: [{ write: { "app.txt": "fixed\n" }, output: impl() }, { write: { "app.txt": "fixed\nwith header\n" }, output: impl("completed", ["F1"]) }],
      code_reviewer: [
        { output: review(false, [untraced]) },
        { output: review(false, [{ ...untraced, criteria: ["AC1"] }]) },
        { output: review(true, [{ ...finding("F2", "low"), criteria: ["AC7"] }], ["F1"]) },
        { output: review(true, [], ["F1"]) },
      ],
    };
    expect(await start(scenario)).toBe(0);
    // Each rejection is why the reviewer was asked again (the second continued its session, so the retry is a fresh one).
    const retries = h.events.flatMap((e) => (e.type === "agent.retry" && e.role === "code_reviewer" ? [e.reason] : []));
    expect(retries).toEqual([
      expect.stringContaining("finding 'F1' is in_scope and high, so 'criteria' must name the acceptance criteria it fails (AC1)"),
      expect.stringContaining("finding 'F2' cites 'AC7', which is not an acceptance criterion of the final plan (AC1)"),
    ]);
    expect(fake.calls("code_reviewer")).toHaveLength(4);
    // The fix round sees which criterion the finding holds the change to.
    expect(fake.calls("implementer")[1]!.prompt).toContain("Fails acceptance criteria: AC1");
    expect(readRun("plan.final.md")).toContain("## Acceptance criteria\n- **AC1** check.mjs exits 0");
    expect(stateOf(h).phase).toBe("DONE");
  });

  it("asks you before widening the task for a critical problem outside it, and keeps the scope when you say so", async () => {
    const leak = extra("F3", "critical", "the settings page the change links to stores tokens in plain text");
    const scenario = {
      ...happy(),
      implementer: [{ write: { "app.txt": "fixed\n" }, output: impl() }, { write: { "app.txt": "fixed well\n" }, output: impl("completed", ["F1"]) }],
      code_reviewer: [
        // Critical and outside the scope, with no justification: refused.
        { output: review(false, [finding("F1"), { ...leak, evidence: "" }]) },
        { output: review(false, [finding("F1"), leak]) },
        { output: review(true, [leak], ["F1"]) },
      ],
    };
    expect(await start(scenario)).toBe(2);
    expect(fake.calls("code_reviewer")[1]!.prompt).toContain("finding 'F3' is critical and out_of_scope, so its 'evidence' must justify why it cannot wait");
    let st = stateOf(h);
    // It stops before the fix round: the task's own finding waits for your decision about the scope.
    expect(st.humanReview).toMatchObject({ reason: "out_of_scope_critical", fromPhase: "CODE_REVIEW", resumePhase: "IMPLEMENT" });
    expect(st.humanReview!.details).toEqual(["finding F3 [critical] ui.css: bad (justification: the settings page the change links to stores tokens in plain text)"]);
    expect([fake.calls("implementer").length, st.scopePending!.map((s) => s.id)]).toEqual([1, ["F3"]]);

    // "Keep the scope": the fix round is for F1 only, and the reviewer no longer weighs F3.
    expect(await resume(h, { decision: "resume" })).toBe(0);
    expect(fake.calls("implementer")[1]!.prompt).toContain("The reviewer marks it outside the task's scope");
    expect(fake.calls("code_reviewer")[2]!.prompt).toContain("## Findings the user kept outside the task's scope\n- finding `F3`: [critical] ui.css: bad");
    st = stateOf(h);
    expect([st.phase, st.implRound, st.scopePending]).toEqual(["DONE", 2, null]);
    expect(h.events.at(-1)).toMatchObject({ summary: expect.stringContaining("; you kept 1 critical finding(s) outside the task's scope unfixed (finding F3)") });
    expect(readRun("report.md")).toContain("- [kept outside the task's scope] `F3` [critical] ui.css: bad — justification: the settings page");
  });

  it("re-plans when you bring a critical problem outside the task into its scope", async () => {
    const leak = extra("F3", "critical", "leaks tokens");
    const widened = plan("v2", { acceptance_criteria: [{ id: "AC1", criterion: "check.mjs exits 0" }, { id: "AC2", criterion: "tokens are stored encrypted" }] });
    const scenario = {
      ...happy(),
      planner: [{ output: plan() }, { output: widened }],
      plan_reviewer: [{ output: critique(true) }, { output: critique(true) }],
      plan_finalizer: [{ output: approval(true) }, { output: approval(true) }],
      implementer: [{ write: { "app.txt": "fixed\n" }, output: impl() }, { write: { "app.txt": "fixed\nencrypted\n" }, output: impl() }],
      code_reviewer: [{ output: review(true, [leak]) }, { output: review(true) }],
    };
    expect(await start(scenario)).toBe(2);
    expect(stateOf(h).humanReview).toMatchObject({ reason: "out_of_scope_critical", resumePhase: "DONE" });
    expect(await resume(h, { decision: "revise", note: "fix F3 too: encrypt the tokens" })).toBe(0);
    expect(fake.calls("planner")[1]!.prompt).toContain("fix F3 too: encrypt the tokens");
    const st = stateOf(h);
    expect([st.phase, st.finalPlanVersion, st.scopePending, st.accepted]).toEqual(["DONE", 2, null, undefined]);
  });

  it("does not let suggestions outside the task hold the plan back", async () => {
    const landscape = issue("C2", "high", "also verify the layout in landscape", "out_of_scope");
    const scenario = { ...happy(), plan_reviewer: [{ output: critique(false, [landscape]) }, { output: critique(true, [landscape]) }] };
    expect(await start(scenario)).toBe(0);
    expect(fake.calls("plan_reviewer")[0]!.prompt).toContain("- `out_of_scope`: asks for more than the task needs");
    expect(fake.calls("plan_reviewer")[1]!.prompt).toContain("'approved' is false, but every issue is outside the task's scope (C2)");
    // Approved with it as a suggestion: no revision for it.
    expect(fake.calls("planner")).toHaveLength(1);
    expect(messages().find((m) => m.kind === "critique")!.items).toEqual(["[high] C2 also verify the layout in landscape (outside the task's scope)"]);
    expect(readRun("plan-feedback.md")).toContain("- `C2` [high] (outside the task's scope) also verify the layout in landscape");
  });

  it("asks you before a revised plan adopts a suggestion outside the task", async () => {
    const landscape = issue("C2", "medium", "also verify the layout in landscape", "out_of_scope");
    const widened = plan("v2", {
      acceptance_criteria: [{ id: "AC1", criterion: "check.mjs exits 0" }, { id: "AC2", criterion: "the layout holds in landscape" }],
      feedback_resolution: [{ issue_id: "C1", decision: "accepted", rationale: "done" }, { issue_id: "C2", decision: "accepted", rationale: "cheap to add" }],
    });
    const scenario = {
      ...happy(),
      planner: [{ output: plan() }, { output: widened }],
      plan_reviewer: [{ output: critique(false, [issue("C1"), landscape]) }, { output: critique(true) }],
    };
    expect(await start(scenario)).toBe(2);
    let st = stateOf(h);
    expect(st.humanReview).toMatchObject({ reason: "scope_expansion", fromPhase: "PLAN", resumePhase: "PLAN_REVIEW" });
    expect(st.humanReview!.details).toEqual(["suggestion C2 [medium] also verify the layout in landscape (the plan's answer: accepted: cheap to add)",
      "acceptance criteria new in v2: AC2 the layout holds in landscape"]);
    expect(fake.calls("plan_reviewer")).toHaveLength(1);
    expect(fake.calls("planner")[1]!.prompt).toContain("do not adopt them");

    // Approved by you: the critic reviews the wider plan knowing it, and DONE says what you approved.
    expect(await resume(h, { decision: "resume" })).toBe(0);
    expect(fake.calls("plan_reviewer")[1]!.prompt).toContain("## Scope the user approved\n- suggestion `C2`: [medium] also verify the layout in landscape");
    st = stateOf(h);
    expect(st.phase).toBe("DONE");
    expect(h.events.at(-1)).toMatchObject({ summary: expect.stringContaining("; you approved widening the task's scope for 1 suggestion(s) (C2)") });
  });

  it("goes on without asking when the revised plan leaves the suggestions outside the task out", async () => {
    const landscape = issue("C2", "medium", "also verify the layout in landscape", "out_of_scope");
    const kept = plan("v2", { feedback_resolution: [
      { issue_id: "C1", decision: "accepted", rationale: "done" }, { issue_id: "C2", decision: "disputed", rationale: "outside the task's scope" },
    ] });
    const scenario = { ...happy(), planner: [{ output: plan() }, { output: kept }], plan_reviewer: [{ output: critique(false, [issue("C1"), landscape]) }, { output: critique(true) }] };
    expect(await start(scenario)).toBe(0);
    expect(stateOf(h).history.some((e) => e.status === "scope_expansion")).toBe(false);
  });
});

describe("Workflow: review loops that do not converge", () => {
  /** The finding each review raises about app.txt, in its own words. */
  const nullCheck = (id: string, issue = "parse() accepts a null input and then crashes") => ({ ...finding(id, "high", "app.txt"), issue });

  it("stops a fix loop in which the implementer reports completed but nothing moves, and resumes only on something new", async () => {
    const scenario = {
      ...happy(),
      implementer: [
        { write: { "app.txt": "fixed\n" }, output: impl() },
        // Claims the fix, changes nothing.
        { output: impl("completed", ["F1"]) },
        { write: { "app.txt": "fixed\nnull checked\n" }, output: impl("completed", ["F1"]) },
      ],
      code_reviewer: [
        { output: review(false, [nullCheck("F1")]) },
        // The same finding, renumbered and reworded.
        { output: review(false, [nullCheck("F4", "a null input still crashes parse()")]) },
        { output: review(true, [], ["F1"]) },
      ],
    };
    expect(await start(scenario)).toBe(2);
    let st = stateOf(h);
    expect(st.humanReview).toMatchObject({ reason: "review_stalled", fromPhase: "CODE_REVIEW", resumePhase: "IMPLEMENT" });
    const [stuck, attempt, count] = st.humanReview!.details;
    expect(stuck).toContain("F1 (F4 in this review) [high] app.txt: a null input still crashes parse() — open since round 1, raised in rounds 1, 2 on `");
    expect(stuck).toContain("; the implementer answered: fixed (round 2)");
    expect([attempt, count]).toEqual(["round 2: the implementer reported completed and changed no file", "1 review round(s) in a row without progress (since round 2)"]);
    expect([fake.calls("implementer").length, fake.calls("code_reviewer").length]).toEqual([2, 2]);
    expect(st.trackedFindings!.map((e) => [e.key, e.ids, e.status])).toEqual([["F1", ["F1", "F4"], "open"]]);

    // Resume with nothing new: no round, and the run says why.
    expect(await resume(h, { decision: "resume" })).toBe(2);
    st = stateOf(h);
    expect(st.humanReview).toMatchObject({ reason: "review_stalled" });
    expect(st.humanReview!.message).toContain("nothing changed since the review loop stalled, so no fix round was started");
    expect(fake.calls("implementer")).toHaveLength(2);

    // A note is new: another round, and only the next review resolves the finding.
    expect(await resume(h, { decision: "resume", note: "parse() must return null for a null input" })).toBe(0);
    expect(fake.calls("implementer")[2]!.prompt).toContain("parse() must return null for a null input");
    st = stateOf(h);
    expect([st.phase, st.stall ?? null]).toEqual(["DONE", null]);
    expect(st.trackedFindings!.find((e) => e.key === "F1")).toMatchObject({ status: "resolved", resolvedRound: 3 });
    const report = readRun("report.md");
    expect(report).toContain("## Findings across reviews\n- `F1` (also F4) [high] app.txt — parse() accepts a null input and then crashes → " +
      "a null input still crashes parse(): raised in rounds 1, 2; resolved by the review of round 3");
    expect(report).toContain("## Review rounds\n- round 1: 1 new, 0 still open, 0 reopened, 0 resolved\n" +
      "- round 2: 0 new, 1 still open, 0 reopened, 0 resolved — no progress\n" +
      "- round 3: 0 new, 0 still open, 0 reopened, 1 resolved — progress: the review resolved F1; app.txt changed (the file of F1)");
  });

  it("does not take a productive fix round for a stalled one", async () => {
    const scenario = {
      ...happy(),
      implementer: [
        { write: { "app.txt": "fixed\n" }, output: impl() },
        { write: { "app.txt": "fixed\nhalf of it\n" }, output: impl("completed", ["F1", "F2"]) },
        { write: { "app.txt": "fixed\nall of it\n" }, output: impl("completed", ["F1"]) },
      ],
      code_reviewer: [
        { output: review(false, [nullCheck("F1"), { ...finding("F2", "high", "app.txt"), issue: "the error message names the wrong file" }]) },
        // F2 resolved; F1 still open, its file changed.
        { output: review(false, [nullCheck("F1")], ["F2"]) },
        { output: review(true, [], ["F1"]) },
      ],
    };
    expect(await start(scenario)).toBe(0);
    const st = stateOf(h);
    expect(st.history.some((e) => e.status === "review_stalled")).toBe(false);
    expect(st.cycles!.map((c) => c.progress)).toEqual([null, ["the review resolved F2", "app.txt changed (the file of F1, F2)"],
      ["the review resolved F1", "app.txt changed (the file of F1)"]]);
  });

  it("allows one cycle without progress when files changed, stops at the second, and keeps everything when you abort", async () => {
    const scenario = {
      ...happy(),
      implementer: [
        { write: { "app.txt": "fixed\n" }, output: impl() },
        { write: { "notes.md": "tried once\n" }, output: impl("completed", ["F1"]) },
        { write: { "notes.md": "tried twice\n" }, output: impl("completed", ["F1"]) },
      ],
      code_reviewer: [{ output: review(false, [nullCheck("F1")]) }],
    };
    expect(await start(scenario)).toBe(2);
    let st = stateOf(h);
    expect([st.humanReview?.reason, fake.calls("implementer").length, fake.calls("code_reviewer").length]).toEqual(["review_stalled", 3, 3]);
    expect(st.humanReview!.details.slice(1)).toEqual(["round 3: the implementer reported completed and changed only notes.md (none of these findings' files)",
      "2 review round(s) in a row without progress (since round 2)"]);
    expect(await resume(h, { decision: "abort" })).toBe(3);
    st = stateOf(h);
    expect([st.phase, st.trackedFindings!.length, st.cycles!.length, st.stall!.count]).toEqual(["ABORTED", 1, 3, 2]);
    expect(st.openFindings.map((f) => f.id)).toEqual(["F1"]);
  });

  it("asks why a blocking finding is new on code that did not change, tells the retry exactly that, and stops when it keeps giving no reason", async () => {
    const late = { ...finding("F2", "high", "other.txt"), issue: "other.txt has no license header" };
    const lateError = "finding 'F2' is high and new since your review of round 1, but 'other.txt' did not change since then: if you reported it " +
      "before in other words, give it that finding's id (F1); if it is new, say in 'late_reason' why it was not reported then";
    const scenario = {
      ...happy(),
      implementer: [
        { write: { "app.txt": "fixed\n" }, output: impl() },
        { write: { "app.txt": "fixed\nnull checked\n" }, output: impl("completed", ["F1"]) },
        { write: { "other.txt": "// license\n" }, output: impl("completed", ["F2"]) },
      ],
      code_reviewer: [
        { output: review(false, [nullCheck("F1")]) },
        // Round 2: F1 resolved, and a blocking finding new on a file nobody touched, with no reason, twice.
        { output: review(false, [late], ["F1"]) },
        { output: review(false, [late], ["F1"]) },
        // After your resume: explained, so it is the task's to fix.
        { output: review(false, [{ ...late, late_reason: "round 1 read only app.txt; AC1 covers every file the change ships" }], ["F1"]) },
        { output: review(true, [], ["F2"]) },
      ],
    };
    expect(await start(scenario)).toBe(2);
    let st = stateOf(h);
    expect(st.humanReview).toMatchObject({ reason: "agent_error", fromPhase: "CODE_REVIEW", details: [lateError] });
    expect(st.humanReview!.message).toContain("the same invalid answer came back after it was told what to correct");
    // Round 2's first answer continued the reviewer's session; the retry was a fresh one, told exactly what to correct.
    const [, continued, fresh] = fake.calls("code_reviewer");
    expect([!!continued!.resumed, fresh!.resumed]).toEqual([true, undefined]);
    expect(fresh!.prompt).toContain("## Your previous answer was rejected\nagentduo checked your previous answer to this request, given in a session you " +
      `cannot see, and rejected it:\n- ${lateError}\n`);
    // The same answer again: no third attempt, and no fix round for the unsupported finding.
    expect([fake.calls("code_reviewer").length, fake.calls("implementer").length]).toEqual([3, 2]);
    expect(readRun("report.md")).toContain("## Rejected answers\n- code reviewer, round 2: 2 answer(s) rejected (" + lateError + "); the call failed");

    expect(await resume(h, { decision: "resume" })).toBe(0);
    st = stateOf(h);
    expect(st.phase).toBe("DONE");
    expect(st.trackedFindings!.map((e) => [e.key, e.status])).toEqual([["F1", "resolved"], ["F2", "resolved"]]);
    expect(fake.calls("code_reviewer")[3]!.prompt).toContain("`late_reason`");
  });

  it("re-plans from a stalled loop with your note, keeping the implementation in the files", async () => {
    const scenario = {
      ...happy(),
      planner: [{ output: plan() }, { output: plan("v2") }],
      plan_reviewer: [{ output: critique(true) }, { output: critique(true) }],
      plan_finalizer: [{ output: approval(true) }, { output: approval(true) }],
      implementer: [{ write: { "app.txt": "fixed\n" }, output: impl() }, { output: impl("completed", ["F1"]) }, { write: { "README.md": "null input: unsupported\n" }, output: impl() }],
      code_reviewer: [{ output: review(false, [nullCheck("F1")]) }, { output: review(false, [nullCheck("F1")]) }, { output: review(true) }],
    };
    expect(await start(scenario)).toBe(2);
    expect(stateOf(h).humanReview?.reason).toBe("review_stalled");
    expect(await resume(h, { decision: "revise", note: "a null input is out of the task: document it instead" })).toBe(0);
    const st = stateOf(h);
    expect([st.phase, st.finalPlanVersion, st.stall ?? null]).toEqual(["DONE", 2, null]);
    expect(readFileSync(join(h.repo, "app.txt"), "utf8")).toBe("fixed\n");
    expect(st.trackedFindings!.find((e) => e.key === "F1")).toMatchObject({ status: "resolved", resolvedRound: 3 });
  });
});

describe("Workflow: pipeline profiles", () => {
  const withProfile = (profile: "lightweight" | "standard" | "thorough", overrides: ConfigOverrides = {}) => {
    h.cfg = testConfig(fake, { ...overrides, pipeline: { profile } });
  };
  const timeline = () => stateOf(h).history.map((e) => `${e.phase} ${e.agent} ${e.status}`).filter((x) => !x.startsWith("PLAN gates"));
  const escalations = () => stateOf(h).profile!.changes.map((c) => `${c.from}>${c.to} ${c.signal}`);
  /** One run of `scenario` under `profile`, from the same files each time: its metrics. */
  const measure = async (profile: "lightweight" | "standard", scenario: Scenario): Promise<RunMetrics> => {
    rmSync(join(h.repo, "app.txt"), { force: true });
    withProfile(profile);
    fake.setScenario(scenario);
    expect(await newWorkflow(h, "Make app.txt fixed").wf.run()).toBe(0);
    return runMetrics(stateOf(h));
  };

  it("benchmark: does the same small task with fewer handoffs in lightweight, and every required check still", async () => {
    const standard = await measure("standard", happy());
    const light = await measure("lightweight", happy());
    // Same task, same files, same answers: the sign-off is the one handoff lightweight leaves out.
    expect([standard.agentCalls, light.agentCalls]).toEqual([5, 4]);
    expect([standard.steps.signOffs, light.steps.signOffs]).toEqual([1, 0]);
    for (const m of [standard, light]) {
      // A plan, an independent critique, the implementation, an independent review, the baseline and the gates, the final check.
      expect(m).toMatchObject({ outcome: "DONE", verification: "verified", requiredGates: "passed", review: "approved", planningRounds: 1, implementationRounds: 1,
        steps: { plans: 1, critiques: 1, implementations: 1, reviews: 1, gateRuns: 2 }, decisions: 0 });
    }
    expect(light.byRole).toEqual({ planner: expect.objectContaining({ calls: 1 }), plan_reviewer: expect.objectContaining({ calls: 1 }),
      implementer: expect.objectContaining({ calls: 1 }), code_reviewer: expect.objectContaining({ calls: 1 }) });
    expect(standard.byRole.plan_finalizer).toMatchObject({ calls: 1, tokens: 1234, unpricedCalls: 1 });
    // The counts add up to the run's totals: no separate accounting.
    for (const m of [standard, light]) {
      expect(Object.values(m.byRole).reduce((n, u) => n + u.calls, 0)).toBe(m.agentCalls);
      expect(Object.values(m.byRole).reduce((n, u) => n + u.tokens, 0)).toBe(m.tokens);
      expect(Math.round(Object.values(m.byRole).reduce((n, u) => n + u.costUsd, 0) * 100) / 100).toBe(m.costUsd);
    }
    expect(light.profile).toEqual({ initial: "lightweight", final: "lightweight", escalations: [] });
    expect(JSON.parse(readRun("metrics.json"))).toEqual(runMetrics(stateOf(h)));
    expect(readRun("report.md")).toContain("## Profile and metrics\n- profile: lightweight\n- agent calls: 4 (planner 1 · 1,234 tokens (1 unpriced); plan critic 1 · 0 tokens · $0.01;");

    // A planner that second-guesses a plan the critic approved costs standard a whole planning round more; lightweight none.
    // The fake counts each role's calls across this test's runs: the first standard run took the sign-off's first answer.
    const churn = { ...happy(), plan_finalizer: [{ output: approval(true) }, { output: approval(false, [issue("S1", "high", "name the helper after the module")]) },
      { output: approval(true) }] };
    const standardChurn = await measure("standard", churn);
    const lightChurn = await measure("lightweight", churn);
    expect([standardChurn.agentCalls, lightChurn.agentCalls, standardChurn.planningRounds, lightChurn.planningRounds]).toEqual([8, 4, 2, 1]);
    expect(lightChurn).toMatchObject({ verification: "verified", review: "approved", steps: { critiques: 1, reviews: 1 } });
  });

  it("tells the planner and critic what lightweight asks, and goes straight from the critic's approval to implementation", async () => {
    withProfile("lightweight");
    expect(await start(happy())).toBe(0);
    expect(fake.calls("planner")[0]!.prompt).toContain("## Pipeline profile: lightweight\nThe task is expected to be small and clearly specified. Keep the plan short");
    expect(fake.calls("plan_reviewer")[0]!.prompt).toContain("A plan you approve goes straight to implementation: there is no sign-off round after you.");
    // No profile text where it asks nothing: the implementer and reviewer get the same prompts as in standard.
    expect(fake.calls("implementer")[0]!.prompt).not.toContain("Pipeline profile");
    expect(fake.calls("code_reviewer")[0]!.prompt).not.toContain("Pipeline profile");
    expect(timeline()).toEqual(["PLAN Codex plan created", "PLAN_REVIEW Claude approved", "IMPLEMENT Claude completed", "VERIFY gates passed", "CODE_REVIEW Codex approved"]);
    expect(readRun("plan.final.md")).toContain("final plan v1");
    expect(h.events.find((e) => e.type === "run.started")).toMatchObject({ profile: "lightweight" });
    expect(h.events.filter((e) => e.type === "phase.started").every((e) => e.type === "phase.started" && e.profile === "lightweight")).toBe(true);
  });

  it("moves to standard on a blocking plan issue, keeping the plan, the critique and the sessions, and signs the revision off", async () => {
    withProfile("lightweight");
    const scenario = {
      ...happy(),
      planner: [{ output: plan("v1") }, { output: plan("v2", { feedback_resolution: [{ issue_id: "C1", decision: "accepted", rationale: "handled" }] }) }],
      plan_reviewer: [{ output: critique(false, [issue("C1", "high", "the plan never handles an empty app.txt")]) }, { output: critique(true) }],
    };
    expect(await start(scenario)).toBe(0);
    expect(timeline()).toEqual(["PLAN Codex plan created", "PLAN_REVIEW Claude changes requested",
      "PLAN_REVIEW orchestrator profile escalated", "PLAN Codex plan revised", "PLAN_REVIEW Claude approved", "PLAN_FINALIZE Codex plan finalized",
      "IMPLEMENT Claude completed", "VERIFY gates passed", "CODE_REVIEW Codex approved"]);
    expect(escalations()).toEqual(["lightweight>standard plan_blocking"]);
    expect(stateOf(h).profile!.changes[0]).toMatchObject({ phase: "PLAN_REVIEW", round: 1, reason: "the plan critic raised 1 blocking issue(s) (C1)" });
    // The planner goes on in its own session with the critique, told the run is now standard; nothing ran twice.
    const second = fake.calls("planner")[1]!;
    expect(second.resumed).toBe(fake.calls("planner")[0]!.session);
    expect(second.prompt).toContain("## Pipeline profile: standard (escalated from lightweight)");
    expect(second.prompt).toContain("the plan never handles an empty app.txt");
    expect([fake.calls("implementer").length, fake.calls("code_reviewer").length]).toEqual([1, 1]);
    expect(readRun("report.md")).toContain("- profile: standard (from lightweight)\n- escalated: lightweight → standard at PLAN_REVIEW round 1 (plan_blocking): " +
      "the plan critic raised 1 blocking issue(s) (C1)");
    expect(stateOf(h).verification!.status).toBe("verified");
  });

  it("never lets lightweight skip a fix round for a blocking review finding, and moves to standard when one round is not enough", async () => {
    withProfile("lightweight");
    const scenario = {
      ...happy(),
      implementer: [{ write: { "app.txt": "fixed\n" }, output: impl() }, { write: { "app.txt": "fixed\nv2\n" }, output: impl("completed", ["F1"]) },
        { write: { "app.txt": "fixed\nv3\n" }, output: impl("completed", ["F1"]) }],
      code_reviewer: [{ output: review(false, [finding("F1")]) }, { output: review(false, [finding("F1")]) }, { output: review(true, [], ["F1"]) }],
    };
    expect(await start(scenario)).toBe(0);
    const reviews = timeline().filter((x) => x.startsWith("CODE_REVIEW"));
    expect(reviews).toEqual(["CODE_REVIEW Codex changes requested", "CODE_REVIEW Codex changes requested", "CODE_REVIEW orchestrator profile escalated",
      "CODE_REVIEW Codex approved"]);
    expect(escalations()).toEqual(["lightweight>standard review_rounds"]);
    expect([fake.calls("implementer").length, fake.calls("code_reviewer").length, stateOf(h).verification!.status]).toEqual([3, 3, "verified"]);
  });

  it("escalates on a plan larger than a lightweight task, and on files the plan never named", async () => {
    withProfile("lightweight");
    const steps = Array.from({ length: 7 }, (_, i) => ({ id: `S${i + 1}`, description: `step ${i + 1}`, files: ["app.txt"] }));
    expect(await start({ ...happy(), planner: [{ output: plan("big", { steps }) }] })).toBe(0);
    expect(escalations()).toEqual(["lightweight>standard plan_size"]);
    expect(timeline()).toContain("PLAN_FINALIZE Codex plan finalized");
    expect(stateOf(h).profile!.changes[0]!.reason).toBe("the plan has 7 steps (a lightweight task has at most 6)");

    rmSync(join(h.repo, "app.txt"));
    const sprawl = { "app.txt": "fixed\n", "src/a.ts": "a\n", "src/b.ts": "b\n", "docs/c.md": "c\n" };
    expect(await start({ ...happy(), implementer: [{ write: sprawl, output: impl() }] })).toBe(0);
    expect(escalations()).toEqual(["lightweight>standard unplanned_files"]);
    expect(stateOf(h).profile!.changes[0]!.reason).toBe("round 1 changed 3 file(s) no step of the plan names (docs/c.md, src/a.ts, src/b.ts)");
  });

  it("pauses for your decision on a requirements conflict and on a scope expansion in every profile", async () => {
    const conflict = { id: "K1", description: "AC1 needs the old format, the task drops it", between: ["AC1", "task"] };
    const landscape = issue("C2", "medium", "also verify the layout in landscape", "out_of_scope");
    const widened = plan("v2", { feedback_resolution: [{ issue_id: "C1", decision: "accepted", rationale: "done" }, { issue_id: "C2", decision: "accepted", rationale: "cheap" }] });
    for (const profile of ["lightweight", "standard", "thorough"] as const) {
      withProfile(profile);
      expect(await start({ ...happy(), plan_reviewer: [{ output: { ...critique(true), conflicts: [conflict] } }] })).toBe(2);
      expect(stateOf(h).humanReview?.reason, profile).toBe("requirements_conflict");
      expect(await start({ ...happy(), planner: [{ output: plan() }, { output: widened }],
        plan_reviewer: [{ output: critique(false, [issue("C1"), landscape]) }] })).toBe(2);
      expect(stateOf(h).humanReview?.reason, profile).toBe("scope_expansion");
      fake.setScenario({});
    }
    expect(fake.calls("implementer")).toHaveLength(0);
  });

  it("goes deeper in thorough: a sign-off even when not required, a review even when gates fail, and prompts that ask for depth", async () => {
    withProfile("thorough", { quality_gates: { require_plan_approval: false } });
    const scenario = {
      ...happy(),
      implementer: [{ write: { "app.txt": "broken\n" }, output: impl() }, { write: { "app.txt": "fixed\n" }, output: impl("completed", ["F1"]) }],
      code_reviewer: [{ output: review(false, [finding("F1")]) }, { output: review(true, [], ["F1"]) }],
    };
    expect(await start(scenario)).toBe(0);
    expect(timeline()).toEqual(["PLAN Codex plan created", "PLAN_REVIEW Claude approved", "PLAN_FINALIZE Codex plan finalized", "IMPLEMENT Claude completed",
      "VERIFY gates failed", "CODE_REVIEW Codex changes requested", "IMPLEMENT Claude completed", "VERIFY gates passed", "CODE_REVIEW Codex approved"]);
    expect(fake.calls("code_reviewer")[0]!.prompt).toContain("## Pipeline profile: thorough\nThe task is expected to be complex or risky: review in depth");
    expect(fake.calls("planner")[0]!.prompt).toContain("Cover the architecture and the alternatives you rejected");
    expect(escalations()).toEqual([]);
    expect(stateOf(h).verification!.status).toBe("verified");
  });

  it("detects a planning loop that does not converge, even with renumbered issues, and stops before spending every round", async () => {
    const stuck = (id: string) => critique(false, [issue(id, "high", "the plan never handles an empty app.txt")]);
    const answer = (v: string) => plan(v, { feedback_resolution: [{ issue_id: "C1", decision: "disputed", rationale: "empty input cannot happen" }] });
    const scenario = {
      ...happy(),
      planner: [{ output: plan("v1") }, { output: answer("v2") }, { output: answer("v3") }, { output: answer("v4") }],
      // The same issue each time, renumbered once: one issue, never resolved.
      plan_reviewer: [{ output: stuck("C1") }, { output: stuck("C4") }, { output: stuck("C1") }, { output: critique(true) }],
    };
    expect(await start(scenario)).toBe(2);
    let st = stateOf(h);
    expect(st.humanReview).toMatchObject({ reason: "planning_stalled", fromPhase: "PLAN_REVIEW", resumePhase: "IMPLEMENT" });
    expect([st.planningRound, st.limits.planningRounds, fake.calls("plan_reviewer").length]).toEqual([3, 4, 3]);
    expect(st.humanReview!.details).toEqual([
      "C1 [high] the plan never handles an empty app.txt — raised in rounds 1, 2, 3; the plan answered: disputed (empty input cannot happen)",
      "2 critique(s) in a row without progress (since round 2)",
    ]);
    expect(st.planCycles!.map((c) => c.progress)).toEqual([null, [], []]);
    expect(readRun("report.md")).toContain("## Planning rounds\n- round 1: blocking C1\n- round 2: blocking C1 — no progress\n- round 3: blocking C1 — no progress");
    // Your decision: implement the latest plan as it is, recorded as accepted by you.
    expect(await resume(h, { decision: "resume" })).toBe(0);
    st = stateOf(h);
    expect([st.phase, st.finalPlanVersion, st.planStall]).toEqual(["DONE", 3, null]);
    expect(readRun("plan.final.md")).toContain("accepted by the human operator");
  });

  it("keeps a resumed run's profile whatever the config says now, and runs an older run with none as standard", async () => {
    withProfile("lightweight");
    fake.setScenario(happy());
    const { wf, bus } = newWorkflow(h, "Make app.txt fixed");
    bus.on((e) => {
      if (e.type === "step.completed" && e.entry.phase === "PLAN" && e.entry.agent === "Codex") wf.requestStop();
    });
    expect(await wf.run()).toBe(130);
    withProfile("thorough");
    h.events.length = 0;
    expect(await resume(h)).toBe(0);
    expect(h.events).toContainEqual({ type: "warning", text: "this run keeps its pipeline profile, lightweight; pipeline.profile 'thorough' applies to new runs" });
    expect(stateOf(h).profile).toEqual({ initial: "lightweight", name: "lightweight", changes: [] });
    expect(timeline()).not.toContain("PLAN_FINALIZE Codex plan finalized");

    // An older run, stopped before profiles existed: it goes on as standard (with its sign-off), whatever the config says.
    withProfile("lightweight");
    fake.setScenario(happy());
    const older = newWorkflow(h, "Make app.txt fixed");
    older.bus.on((e) => {
      if (e.type === "step.completed" && e.entry.phase === "PLAN" && e.entry.agent === "Codex") older.wf.requestStop();
    });
    expect(await older.wf.run()).toBe(130);
    const path = join(runDirOf(h), "state.json");
    const st = JSON.parse(readFileSync(path, "utf8"));
    delete st.profile;
    writeFileSync(path, JSON.stringify(st));
    expect(await resume(h)).toBe(0);
    expect(stateOf(h).profile).toEqual({ initial: "standard", name: "standard", changes: [] });
    expect(timeline()).toContain("PLAN_FINALIZE Codex plan finalized");
  });

  it("keeps the budget and the circuit breakers in lightweight", async () => {
    withProfile("lightweight", { limits: { max_run_agent_calls: 2 } });
    expect(await start(happy())).toBe(2);
    expect(stateOf(h).humanReview).toMatchObject({ reason: "budget_exhausted", resumePhase: "IMPLEMENT" });
    expect(fake.calls("implementer")).toHaveLength(0);

    withProfile("lightweight");
    expect(await start({ ...happy(), implementer: [{ output: impl("blocked", [], "API key needed") }] })).toBe(2);
    expect(stateOf(h).humanReview!.reason).toBe("implementer_blocked");
    expect(escalations()).toEqual(["lightweight>standard implementer_blocked"]);
    // Nothing new: the implementer does not run again, whichever profile the run is in.
    expect(await resume(h, { decision: "resume" })).toBe(2);
    expect(stateOf(h).humanReview!.reason).toBe("no_progress");
    expect(fake.calls("implementer")).toHaveLength(1);
  });
});

describe("Workflow: the run's budget", () => {
  const budgetWarnings = () => stateOf(h).warnings.filter((w) => w.startsWith("budget:"));
  const decisionItems = () => messages().filter((m) => m.kind === "decision").map((m) => m.items);

  it("runs as before within its budget, shows it at every step, warns near a limit, and reports what it used", async () => {
    expect(await start(happy(), { limits: { max_run_tokens: 100_000, max_run_cost_usd: 1, max_run_agent_calls: 6, max_run_minutes: 60 } })).toBe(0);
    const st = stateOf(h);
    // Three Codex calls (1,234 tokens each, no cost reported) and two Claude calls ($0.01 each).
    expect([st.agentCalls, st.unpricedCalls, st.tokens, st.costUsd]).toEqual([5, 3, 3702, 0.02]);
    expect(st.budget).toEqual({ limits: { tokens: 100_000, cost: 1, calls: 6, minutes: 60 }, warned: ["calls"] });
    expect(budgetWarnings()).toEqual(["budget: 5 of 6 agent calls used (83%, limits.max_run_agent_calls); the run stops for your decision when it is reached"]);
    const phases = h.events.flatMap((e) => (e.type === "phase.started" ? [e] : []));
    expect(phases[0]!.budget!.lines.map((l) => [l.key, l.used, l.limit])).toEqual([["tokens", 0, 100_000], ["cost", 0, 1], ["calls", 0, 6], ["minutes", 0, 60]]);
    expect(phases.at(-1)!.budget).toMatchObject({ unpricedCalls: 2, lines: expect.arrayContaining([{ key: "calls", used: 4, limit: 6 }]) });
    // Codex's missing cost is said, never counted as zero; the notice is not one of the run's warnings.
    expect(h.events).toContainEqual({ type: "warning", text: expect.stringContaining("Codex reports none, so the cost of its calls is not in it") });
    expect(st.warnings.some((w) => w.includes("Codex reports none"))).toBe(false);
    const report = readRun("report.md");
    expect(report).toContain("- **Usage:** 3,702 tokens · reported cost $0.02 (3 call(s) reported no cost, as Codex never does: the real cost is higher) · 5 agent call(s)");
    expect(report).toContain("## Budget\n- 3,702 of 100,000 tokens (3%, limits.max_run_tokens)\n- $0.02 of $1.00 reported cost (2%, limits.max_run_cost_usd)\n- 5 of 6 agent calls (83%, limits.max_run_agent_calls)");
    // Claude is capped at what the run has left: all of it first, then less the critic's cost.
    const cap = (role: string) => { const a = fake.calls(role)[0]!.args; return a[a.indexOf("--max-budget-usd") + 1]; };
    expect([cap("plan_reviewer"), cap("implementer")]).toEqual(["1", "0.99"]);
  });

  it("stops before the next step once a limit is reached, keeps everything, and goes on only when you allow it", async () => {
    expect(await start(happy(), { limits: { max_run_tokens: 1000 } })).toBe(2);
    let st = stateOf(h);
    expect(st.phase).toBe("HUMAN_REVIEW");
    expect(st.humanReview).toMatchObject({ reason: "budget_exhausted", fromPhase: "PLAN_REVIEW", resumePhase: "PLAN_REVIEW" });
    expect(st.humanReview!.message).toContain("the run reached its budget: 1,234 of 1,000 tokens (limits.max_run_tokens)");
    expect(st.humanReview!.details[0]).toContain("reached (tokens are known when a call ends");
    expect(fake.calls().map((c) => c.role)).toEqual(["planner"]);
    expect(existsSync(join(runDirOf(h), "plan.v1.md"))).toBe(true);
    expect(readRun("report.md")).toContain("1,234 of 1,000 tokens (123%, limits.max_run_tokens): reached");
    // `duo resume --decision resume`: one more allowance (1,000 tokens from what it used), then it stops again.
    expect(await resume(h, { decision: "resume" })).toBe(2);
    st = stateOf(h);
    expect(st.humanReview).toMatchObject({ reason: "budget_exhausted", resumePhase: "IMPLEMENT" });
    expect(fake.calls().map((c) => c.role)).toEqual(["planner", "plan_reviewer", "plan_finalizer"]);
    expect(await resume(h, { decision: "resume" })).toBe(0);
    st = stateOf(h);
    expect(st.phase).toBe("DONE");
    // Every step ran once: a stop never re-ran work that was done.
    expect(fake.calls().map((c) => c.role)).toEqual(["planner", "plan_reviewer", "plan_finalizer", "implementer", "code_reviewer"]);
    expect(decisionItems()).toEqual([["tokens limit raised to 2234"], ["tokens limit raised to 3468"]]);
    expect(st.budget!.limits.tokens).toBe(3468);
  });

  it("never starts an agent call past the call limit, a retry included, and stops for a decision rather than an error", async () => {
    expect(await start({ ...happy(), planner: [{ raw: "not json" }, { output: plan() }] }, { limits: { max_run_agent_calls: 1, max_retries: 3 } })).toBe(2);
    let st = stateOf(h);
    expect(st.humanReview).toMatchObject({ reason: "budget_exhausted", resumePhase: "PLAN" });
    expect(st.humanReview!.message).toContain("1 of 1 agent calls (limits.max_run_agent_calls)");
    expect(fake.calls("planner")).toHaveLength(1);
    expect(st.agentCalls).toBe(1);
    // Allowed one more call: the planner's step runs again and succeeds, and the run stops before the critic.
    expect(await resume(h, { decision: "resume" })).toBe(2);
    st = stateOf(h);
    expect([st.agentCalls, st.planVersion, st.humanReview?.resumePhase]).toEqual([2, 1, "PLAN_REVIEW"]);
    expect(fake.calls("planner")).toHaveLength(2);
    expect(await resume(h, { decision: "abort" })).toBe(3);
    expect(stateOf(h).budget!.limits.calls).toBe(2);
  });

  it("starts no step past its minutes of work", async () => {
    fake.setScenario(happy());
    h.cfg = testConfig(fake, { limits: { max_run_minutes: 1 } });
    const { wf } = newWorkflow(h, "Make app.txt fixed", undefined, (state) => {
      state.activeSec = 61;
    });
    expect(await wf.run()).toBe(2);
    expect(stateOf(h).humanReview).toMatchObject({ reason: "budget_exhausted", resumePhase: "PLAN" });
    expect(stateOf(h).humanReview!.message).toContain("1 of 1 minutes of work (limits.max_run_minutes)");
    expect(fake.calls()).toEqual([]);
  });

  it("saves the work time of a step that was stopped, which a resumed run counts on from", async () => {
    fake.setScenario({ ...happy(), planner: [{ activities: [{ command: "ls" }], sleep: 5000, output: plan() }] });
    const { wf, bus } = newWorkflow(h, "Make app.txt fixed");
    bus.on((e) => {
      if (e.type === "agent.activity") wf.interrupt();
    });
    expect(await wf.run()).toBe(130);
    expect(stateOf(h).activeSec).toBeGreaterThan(0);
  });

  it("counts the cost the CLIs report, caps Claude at what is left, and says how much Codex left out", async () => {
    expect(await start(happy(), { limits: { max_run_cost_usd: 0.015 } })).toBe(2);
    const st = stateOf(h);
    expect([st.costUsd, st.unpricedCalls]).toEqual([0.02, 2]);
    expect(st.humanReview).toMatchObject({ reason: "budget_exhausted", resumePhase: "VERIFY" });
    expect(st.humanReview!.details).toContain("2 agent call(s) reported no cost (Codex never does): the run's real cost is higher than the reported one");
    const capOf = (role: string) => { const a = fake.calls(role)[0]!.args; return a[a.indexOf("--max-budget-usd") + 1]; };
    // Never less than a cent: Claude stops a call that would spend more than is left.
    expect([capOf("plan_reviewer"), capOf("implementer")]).toEqual(["0.01", "0.01"]);
    expect(fake.calls("plan_finalizer")[0]!.args).not.toContain("--max-budget-usd");
  });
});


describe("Workflow: questions for the user", () => {
  const plannerCalls = () => fake.calls("planner");
  const flag = {
    questions: [{
      question: "Which flag should the build use?", header: "Flag", multiSelect: false,
      options: [{ label: "--fast", description: "skips the slow checks" }, { label: "--safe", description: "keeps every check" }],
    }],
  };

  it("asks before the critic when the planner needs the user, and plans from the answers without spending a round, a version or a stall", async () => {
    const clarifier = new ScriptedClarifier([pickFirst]);
    h.clarifier = clarifier;
    expect(await start({ ...happy(), planner: [{ output: plannerAsk() }, { output: plan() }] })).toBe(0);
    const st = stateOf(h);
    // Nothing else ran between the question and the answer; then the pipeline goes on as for any plan.
    expect(fake.calls().map((c) => c.role)).toEqual(["planner", "planner", "plan_reviewer", "plan_finalizer", "implementer", "code_reviewer"]);
    expect([st.planningRound, st.planVersion, st.finalPlanVersion]).toEqual([1, 1, 1]);
    expect(st.planStall ?? null).toBeNull();
    expect(clarifier.seen).toHaveLength(1);
    expect(clarifier.seen[0]).toMatchObject({ source: "planner", role: "planner", questions: [{ id: "q1", header: "Database", question: "Which database?", multiSelect: false }] });
    expect(clarifier.seen[0]!.questions[0]!.options.map((o) => [o.id, o.label, o.description])).toEqual([["q1o1", "SQLite", "one file, no server"], ["q1o2", "Postgres", "a server, concurrent writers"]]);
    expect(st.clarifications).toMatchObject([{ seq: 1, status: "answered", source: "planner", answers: [{ questionId: "q1", optionIds: ["q1o1"], otherText: null }] }]);
    // The plan call that followed saw the answer, and so did the critic and every later role.
    expect(plannerCalls()[1]!.resumed).toBeTruthy();
    expect(plannerCalls()[1]!.prompt).toContain("## New answers from the user to questions the agents asked");
    expect(plannerCalls()[1]!.prompt).toContain("Which database?\n  → SQLite");
    expect(fake.calls("plan_reviewer")[0]!.prompt).toContain("Which database?\n  → SQLite");
    // The implementer goes on in the critic's session, which was given the answer: it is not repeated, and the session says it holds it.
    expect(fake.calls("implementer")[0]!.prompt).not.toContain("Which database?");
    expect(st.sessions?.[SHARED_SESSION]?.clarifications).toEqual([st.clarifications![0]!.id]);
    expect(fake.calls("code_reviewer")[0]!.prompt).toContain("Which database?\n  → SQLite");
    // Usage is recorded for both planner calls, and the question is a step of the log, not a plan version.
    expect(st.usageByRole?.planner?.calls).toBe(2);
    expect(st.agentCalls).toBe(6);
    expect(st.history.map((x) => `${x.phase}:${x.status}`)).toContain("PLAN:questions asked");
    expect(st.history.map((x) => `${x.phase}:${x.status}`)).toContain("HUMAN_REVIEW:questions answered");
    expect(existsSync(join(runDirOf(h), "plan.v1.json"))).toBe(true);
    expect(existsSync(join(runDirOf(h), "plan.v2.json"))).toBe(false);
    expect(JSON.parse(readRun("clarification.1.json"))).toMatchObject({ request: { id: st.clarifications![0]!.id }, answers: [{ questionId: "q1" }] });
    expect(h.events.filter((e) => e.type.startsWith("clarification.")).map((e) => e.type)).toEqual(["clarification.requested", "clarification.answered"]);
  });

  it("goes straight to the plan when the task is clear: no question, no extra call", async () => {
    const clarifier = new ScriptedClarifier([pickFirst]);
    h.clarifier = clarifier;
    expect(await start(happy())).toBe(0);
    expect(clarifier.seen).toEqual([]);
    expect(fake.calls().map((c) => c.role)).toEqual(["planner", "plan_reviewer", "plan_finalizer", "implementer", "code_reviewer"]);
    expect(stateOf(h).clarifications).toBeUndefined();
    // The planner is told to look in the repository first and ask only what only the user can say.
    expect(plannerCalls()[0]!.prompt).toContain("Look in the repository first: do not ask what its code, tests, docs or configuration can tell you");
    expect(plannerCalls()[0]!.prompt).toContain("A clear task goes straight to `result.kind` `plan`");
  });

  it("waits, saved, when nobody can answer: no agent runs, a decision does not answer it, and answers from a file do", async () => {
    expect(await start({ ...happy(), planner: [{ output: plannerAsk() }, { output: plan() }] })).toBe(EXIT.HUMAN_REVIEW);
    let st = stateOf(h);
    expect(st.humanReview).toMatchObject({ reason: "clarification_required", fromPhase: "PLAN", resumePhase: "PLAN" });
    expect(st.humanReview!.details[0]).toContain("[Database] Which database? — SQLite / Postgres");
    const pending = st.clarifications![0]!;
    expect(pending.status).toBe("pending");
    expect(fake.calls().map((c) => c.role)).toEqual(["planner"]);
    // The report names what waits, and what answers it.
    expect(readRun("report.md")).toContain("clarification_required");

    // Neither a resume nor a revise goes past the questions; an abort does not need them.
    for (const decision of ["resume", "revise"] as const) {
      await expect(resume(h, { decision })).rejects.toThrow("waits for your answers to the planner's questions");
    }
    // A plain resume with nobody to answer calls no agent and leaves everything as it was.
    expect(await resume(h)).toBe(EXIT.HUMAN_REVIEW);
    expect(fake.calls().map((c) => c.role)).toEqual(["planner"]);
    expect(stateOf(h).clarifications![0]!.status).toBe("pending");

    // A file for another request, an incomplete one and one with an option that is not the question's are refused, changing nothing.
    const { wf } = resumedWorkflow(h);
    expect(() => wf.applyAnswers({ requestId: "clq-other", answers: { q1: { options: ["q1o1"] } } })).toThrow(DecisionError);
    expect(() => wf.applyAnswers({ requestId: pending.id, answers: {} })).toThrow("question q1 (\"Which database?\") is not answered");
    expect(() => wf.applyAnswers({ requestId: pending.id, answers: { q1: { options: ["q9o9"] } } })).toThrow("q9o9 is not one of its options");
    expect(() => wf.applyAnswers({ requestId: pending.id, answers: { q1: { options: ["q1o1", "q1o2"] } } })).toThrow("takes one answer");
    expect(stateOf(h).clarifications![0]!.status).toBe("pending");
    expect(answersTemplate(pending)).toEqual({ requestId: pending.id, answers: { q1: { options: [], other: null } } });

    wf.applyAnswers({ requestId: pending.id, answers: { q1: { options: ["q1o2"] } } });
    // The same answers again change nothing: the request is answered.
    expect(() => wf.applyAnswers({ requestId: pending.id, answers: { q1: { options: ["q1o1"] } } })).toThrow("is not waiting for answers");
    expect(await wf.run()).toBe(0);
    st = stateOf(h);
    expect(st.clarifications).toMatchObject([{ status: "answered", answers: [{ questionId: "q1", optionIds: ["q1o2"] }] }]);
    expect(plannerCalls()[1]!.prompt).toContain("Which database?\n  → Postgres");
    expect(st.planVersion).toBe(1);
  });

  it("keeps the question for later when the user puts it off, and asks again on a resume where someone can answer", async () => {
    h.clarifier = new ScriptedClarifier([{ kind: "defer" }]);
    expect(await start({ ...happy(), planner: [{ output: plannerAsk() }, { output: plan() }] })).toBe(EXIT.HUMAN_REVIEW);
    expect(h.events).toContainEqual({ type: "clarification.closed", id: stateOf(h).clarifications![0]!.id, callId: expect.any(String), status: "deferred" });
    expect(stateOf(h).clarifications![0]!.status).toBe("pending");
    expect(fake.calls()).toHaveLength(1);

    // A dismissal is no answer either: the question stays pending.
    h.clarifier = new ScriptedClarifier([{ kind: "cancelled" }]);
    expect(await resume(h)).toBe(EXIT.HUMAN_REVIEW);
    expect(stateOf(h).clarifications![0]!.status).toBe("pending");

    const second = new ScriptedClarifier([pickFirst]);
    h.clarifier = second;
    expect(await resume(h)).toBe(0);
    // The saved request is the one shown again, with the same id.
    expect(second.seen[0]!.id).toBe(stateOf(h).clarifications![0]!.id);
    expect(fake.calls("planner")).toHaveLength(2);
  });

  it("refuses an answer that does not fit the questions, and an answer after an abort", async () => {
    h.clarifier = new ScriptedClarifier([{ kind: "answered", answers: [{ questionId: "q1", optionIds: ["nope"], otherText: null }] }]);
    expect(await start({ ...happy(), planner: [{ output: plannerAsk() }, { output: plan() }] })).toBe(EXIT.HUMAN_REVIEW);
    expect(stateOf(h).clarifications![0]!.status).toBe("pending");
    expect(fake.calls()).toHaveLength(1);
    expect(await resume(h, { decision: "abort" })).toBe(EXIT.ABORTED);
    const st = stateOf(h);
    expect([st.phase, st.clarifications![0]!.status]).toEqual(["ABORTED", "cancelled"]);
  });

  it("takes several batches of questions in a row without spending a round or reading it as a stalled plan", async () => {
    h.clarifier = new ScriptedClarifier([pickFirst]);
    expect(await start({
      ...happy(),
      planner: [{ output: plannerAsk() }, { output: plannerAsk([plannerQuestion("Which cache?", true)]) }, { output: plannerAsk([plannerQuestion("Which queue?")]) }, { output: plan() }],
    })).toBe(0);
    const st = stateOf(h);
    expect(st.clarifications!.map((e) => [e.seq, e.status])).toEqual([[1, "answered"], [2, "answered"], [3, "answered"]]);
    // The one planning cycle is the critic's, as for any plan: the questions added none.
    expect([st.planningRound, st.planVersion, st.planCycles?.length]).toEqual([1, 1, 1]);
    expect(st.planStall ?? null).toBeNull();
    // Every ask is a call of its own with its own log, and the artifacts of an ask are numbered, not overwritten.
    for (const n of [1, 2, 3]) expect(existsSync(join(runDirOf(h), `clarification.${n}.json`)), String(n)).toBe(true);
    expect(plannerCalls()).toHaveLength(4);
    expect(plannerCalls()[3]!.prompt).toContain("Which queue?");
  });

  it("stops asking once the planner has asked its share, and tells it to plan on assumptions", async () => {
    h.clarifier = new ScriptedClarifier([pickFirst]);
    const asks = Array.from({ length: MAX_PLANNER_ASKS }, (_, i) => ({ output: plannerAsk([plannerQuestion(`Question ${i + 1}?`)]) }));
    expect(await start({ ...happy(), planner: [...asks, { output: plannerAsk([plannerQuestion("One more?")]) }, { output: plan() }] })).toBe(0);
    const calls = plannerCalls();
    // The fourth ask was rejected as an answer (and told so), not shown to the user.
    expect(calls).toHaveLength(MAX_PLANNER_ASKS + 2);
    expect(calls.at(-1)!.prompt).toContain(`you have already asked ${MAX_PLANNER_ASKS} times in this run`);
    expect(stateOf(h).clarifications).toHaveLength(MAX_PLANNER_ASKS);
  });

  it("does not ask when the setting is off: a planner that does is told to plan with its assumptions", async () => {
    h.clarifier = new ScriptedClarifier([pickFirst]);
    expect(await start({ ...happy(), planner: [{ output: plannerAsk() }, { output: plan() }] }, { clarification: { enabled: false } })).toBe(0);
    expect(plannerCalls()[0]!.prompt).toContain("The user cannot be asked questions in this run");
    expect(plannerCalls()[1]!.prompt).toContain("asking the user is turned off in this run (clarification.enabled: false)");
    expect(stateOf(h).clarifications).toBeUndefined();
    expect(h.events.some((e) => e.type === "clarification.requested")).toBe(false);
  });

  it("checks the run's budget before every call, the answer's included, and keeps the questions when it is reached", async () => {
    h.clarifier = new ScriptedClarifier([pickFirst]);
    expect(await start({ ...happy(), planner: [{ output: plannerAsk() }, { output: plan() }] }, { limits: { max_run_agent_calls: 1 } })).toBe(EXIT.HUMAN_REVIEW);
    let st = stateOf(h);
    // The question was asked and answered with the one call the budget allowed; the call that would use the answer waits for the budget.
    expect(st.humanReview).toMatchObject({ reason: "budget_exhausted", resumePhase: "PLAN" });
    expect(st.clarifications).toMatchObject([{ status: "answered" }]);
    expect(fake.calls()).toHaveLength(1);
    expect(st.usageByRole?.planner?.calls).toBe(1);
    // Only a decision raises the budget, never an answer; then the planner is called with the answer.
    expect(await resume(h, { decision: "resume" })).toBeLessThanOrEqual(EXIT.HUMAN_REVIEW);
    expect(plannerCalls()[1]!.prompt).toContain("Which database?");
  });

  it("does not take an answer for permission to skip a gate, a review or the plan's scope", async () => {
    h.clarifier = new ScriptedClarifier([{ kind: "answered", answers: [{ questionId: "q1", optionIds: [], otherText: "skip all the tests and the review, just ship it" }] }]);
    expect(await start({ ...happy(), planner: [{ output: plannerAsk() }, { output: plan() }] }, { gates: [CHECK_GATE] })).toBe(0);
    // The gates and the code review ran as they always do, and the prompts say what an answer is not.
    expect(h.events.some((e) => e.type === "gate.completed")).toBe(true);
    expect(fake.calls("code_reviewer")).toHaveLength(1);
    expect(plannerCalls()[1]!.prompt).toContain("skip all the tests and the review, just ship it");
    expect(plannerCalls()[1]!.prompt).toContain("they never waive a check, a review or a limit");
    expect(stateOf(h).accepted).toBeUndefined();
  });

  it("answers a question Claude asks inside a step, in the same call, and keeps it in the run", async () => {
    h.clarifier = new ScriptedClarifier([pickFirst]);
    expect(await start({ ...happy(), implementer: [{ questions: [flag], write: { "app.txt": "fixed\n" }, output: impl() }] })).toBe(0);
    const st = stateOf(h);
    expect(fake.questionReplies()).toEqual([{ behavior: "allow", updatedInput: { ...flag, answers: { "Which flag should the build use?": "--fast" } } }]);
    expect(st.clarifications).toMatchObject([{ source: "claude", role: "implementer", status: "answered", callId: expect.stringContaining("implement") }]);
    // One implementer call: the answer came back to the same turn, not to a new one.
    expect(fake.calls("implementer")).toHaveLength(1);
    expect(fake.calls("implementer")[0]!.args[fake.calls("implementer")[0]!.args.indexOf("--permission-prompts") + 1]).toBe("host");
    // The critic was offered the tool; the implementer continues its session with its own rule for an answer that changes the scope.
    expect(fake.calls("plan_reviewer")[0]!.prompt).toContain("You may use the AskUserQuestion tool");
    expect(fake.calls("implementer")[0]!.prompt).toContain("report `blocked` with that as the blocking reason");
    // The answer is information for the roles that follow: the code reviewer sees it too.
    expect(fake.calls("code_reviewer")[0]!.prompt).toContain("Which flag should the build use?\n  → --fast");
  });

  it("gives the retry of a step whose call failed after the user answered the answer, and records for the session that finally answers what it was given", async () => {
    h.clarifier = new ScriptedClarifier([pickFirst]);
    const write = { "app.txt": "fixed\n" };
    expect(await start({ ...happy(), implementer: [{ questions: [flag], exit: 1, write, output: impl() }, { write, output: impl() }] })).toBe(0);
    const [failed, retry] = fake.calls("implementer");
    expect(fake.calls("implementer")).toHaveLength(2);
    // One question, asked once: the retry is told the answer instead of asking again.
    expect(fake.questionReplies()).toHaveLength(1);
    expect(failed!.prompt).not.toContain("already answered");
    expect(retry!.prompt).toContain("What the user already answered during an earlier attempt of this request");
    expect(retry!.prompt).toContain("Which flag should the build use?\n  → --fast");
    expect(retry!.session).not.toBe(failed!.session);
    // The ledger holds the answer once, and the session that finished the step (the retry's) is the one recorded as having it.
    const st = stateOf(h);
    expect(st.clarifications).toMatchObject([{ status: "answered", role: "implementer" }]);
    const kept = Object.values(st.sessions ?? {}).find((s) => s?.id === retry!.session);
    expect(kept?.clarifications).toEqual([st.clarifications![0]!.id]);
    expect(Object.values(st.sessions ?? {}).some((s) => s?.id === failed!.session)).toBe(false);
    // And the roles that follow have it from the ledger, as for any answer.
    expect(fake.calls("code_reviewer")[0]!.prompt).toContain("Which flag should the build use?\n  → --fast");
  });

  it("is not offered to Claude when nobody can answer: the call keeps its prompts off", async () => {
    expect(await start({ ...happy(), implementer: [{ questions: [flag], write: { "app.txt": "fixed\n" }, output: impl() }] })).toBe(0);
    const args = fake.calls("implementer")[0]!.args;
    expect(args[args.indexOf("--permission-prompts") + 1]).toBe("none");
    expect(fake.questionReplies()).toEqual([]);
    expect(fake.calls("implementer")[0]!.prompt).not.toContain("AskUserQuestion");
    expect(stateOf(h).clarifications).toBeUndefined();
  });

  /** The scenario of a step whose Claude call asks, is put off, and runs again once the user has answered. */
  const putOff = () => ({
    ...happy(),
    implementer: [{ questions: [flag], afterQuestion: 5000, write: { "app.txt": "fixed\n" }, output: impl() }, { write: { "app.txt": "fixed\n" }, output: impl() }],
  });

  it("keeps a question of Claude that the user put off as owed: the run waits for the answer, calls no agent, and runs the step again with it", async () => {
    h.clarifier = new ScriptedClarifier([{ kind: "defer" }]);
    expect(await start(putOff())).toBe(EXIT.HUMAN_REVIEW);
    let st = stateOf(h);
    // The call is gone (its tool can never be answered), but the question is still the user's to answer.
    expect(st.humanReview).toMatchObject({ reason: "clarification_required", fromPhase: "IMPLEMENT", resumePhase: "IMPLEMENT" });
    expect(st.humanReview!.details[0]).toContain("[Flag] Which flag should the build use? — --fast / --safe");
    expect(st.clarifications).toMatchObject([{ source: "claude", role: "implementer", status: "pending" }]);
    expect(st.inProgress).toBeNull();
    expect(fake.calls("implementer")).toHaveLength(1);
    expect(fake.questionReplies()).toEqual([]);
    const pending = st.clarifications![0]!;

    // Neither a resume nor a revise goes past it, and a resume with nobody to answer runs nothing.
    for (const decision of ["resume", "revise"] as const) {
      await expect(resume(h, { decision })).rejects.toThrow("waits for your answers to Claude's questions");
    }
    h.clarifier = undefined;
    expect(await resume(h)).toBe(EXIT.HUMAN_REVIEW);
    expect(fake.calls("implementer")).toHaveLength(1);
    expect(stateOf(h).clarifications![0]!.status).toBe("pending");

    // A file for another request is refused; the right one answers it, and the step runs again with the question and the answer.
    const { wf } = resumedWorkflow(h);
    expect(() => wf.applyAnswers({ requestId: "clq-other", answers: { q1: { options: ["q1o1"] } } })).toThrow(DecisionError);
    wf.applyAnswers({ requestId: pending.id, answers: { q1: { options: ["q1o2"] } } });
    expect(await wf.run()).toBe(0);
    st = stateOf(h);
    expect(fake.calls("implementer")).toHaveLength(2);
    expect(fake.calls("implementer")[1]!.prompt).toContain("Which flag should the build use?\n  → --safe");
    expect(st.clarifications).toMatchObject([{ status: "answered", answers: [{ questionId: "q1", optionIds: ["q1o2"] }] }]);
    // Information, not a waiver: the gates, the review and the approval still ran.
    expect(fake.calls("code_reviewer")).toHaveLength(1);
    expect(st.accepted).toBeUndefined();
  });

  it("asks the owed question again where someone can answer it, as a request that can be put off but not dismissed", async () => {
    h.clarifier = new ScriptedClarifier([{ kind: "defer" }]);
    expect(await start(putOff())).toBe(EXIT.HUMAN_REVIEW);
    const asked = stateOf(h).clarifications![0]!;
    // A dismissal of the re-asked question is no answer: the question stays owed, and still nothing runs.
    const dismissing = new ScriptedClarifier([{ kind: "cancelled" }]);
    h.clarifier = dismissing;
    expect(await resume(h)).toBe(EXIT.HUMAN_REVIEW);
    expect(dismissing.seen).toMatchObject([{ id: asked.id, source: "claude", role: "implementer", held: true }]);
    expect(stateOf(h).clarifications![0]!.status).toBe("pending");
    expect(fake.calls("implementer")).toHaveLength(1);

    const answering = new ScriptedClarifier([pickFirst]);
    h.clarifier = answering;
    expect(await resume(h)).toBe(0);
    expect(fake.calls("implementer")).toHaveLength(2);
    expect(fake.calls("implementer")[1]!.prompt).toContain("Which flag should the build use?\n  → --fast");
    expect(stateOf(h).clarifications).toMatchObject([{ status: "answered" }]);
    // The answer reached the roles after it, and only the one question was ever asked of the user twice.
    expect(fake.calls("code_reviewer")[0]!.prompt).toContain("Which flag should the build use?\n  → --fast");
    expect(answering.seen).toHaveLength(1);
  });

  it("holds on a question that a killed process left open before it runs the step again", async () => {
    h.clarifier = new ScriptedClarifier([{ kind: "defer" }]);
    expect(await start(putOff())).toBe(EXIT.HUMAN_REVIEW);
    // As a crash leaves the run: the step in progress and its question pending, with no decision recorded.
    const store = RunStore.open(h.runsDir);
    const crashed = store.loadState();
    crashed.humanReview = null;
    crashed.phase = "IMPLEMENT";
    crashed.inProgress = { phase: "IMPLEMENT", startedAt: new Date().toISOString() };
    store.saveState(crashed);
    h.clarifier = undefined;
    expect(await resume(h)).toBe(EXIT.HUMAN_REVIEW);
    expect(stateOf(h).humanReview).toMatchObject({ reason: "clarification_required", resumePhase: "IMPLEMENT" });
    expect(fake.calls("implementer")).toHaveLength(1);
    h.clarifier = new ScriptedClarifier([pickFirst]);
    expect(await resume(h)).toBe(0);
    expect(fake.calls("implementer")[1]!.prompt).toContain("Which flag should the build use?\n  → --fast");
  });

  it("takes the answers of a question a killed process left open straight away, without a resume first, and calls no agent before the step runs again", async () => {
    h.clarifier = new ScriptedClarifier([{ kind: "defer" }]);
    expect(await start(putOff())).toBe(EXIT.HUMAN_REVIEW);
    const pending = stateOf(h).clarifications![0]!;
    const store = RunStore.open(h.runsDir);
    const crashed = store.loadState();
    crashed.humanReview = null;
    crashed.phase = "IMPLEMENT";
    crashed.inProgress = { phase: "IMPLEMENT", startedAt: new Date().toISOString() };
    store.saveState(crashed);
    h.clarifier = undefined;

    // `duo resume --answers` applies the file before run() starts. A file that does not fit is refused, and the run then holds on the
    // question (saved), as a plain resume would have left it; it does not go back to the step.
    let { wf } = resumedWorkflow(h);
    expect(() => wf.applyAnswers({ requestId: "clq-other", answers: { q1: { options: ["q1o1"] } } })).toThrow(DecisionError);
    expect(stateOf(h)).toMatchObject({ phase: "HUMAN_REVIEW", inProgress: null, humanReview: { reason: "clarification_required", resumePhase: "IMPLEMENT" } });
    expect(stateOf(h).clarifications).toMatchObject([{ id: pending.id, status: "pending" }]);
    expect(fake.calls("implementer")).toHaveLength(1);

    // The right file, on a process that has only just started: accepted, the step runs again with the question and the answer.
    store.saveState({ ...stateOf(h), humanReview: null, phase: "IMPLEMENT", inProgress: { phase: "IMPLEMENT", startedAt: new Date().toISOString() } });
    ({ wf } = resumedWorkflow(h));
    wf.applyAnswers({ requestId: pending.id, answers: { q1: { options: ["q1o2"] } } });
    expect(fake.calls("implementer")).toHaveLength(1);
    expect(stateOf(h).clarifications).toMatchObject([{ status: "answered", answers: [{ questionId: "q1", optionIds: ["q1o2"] }] }]);
    expect(await wf.run()).toBe(0);
    expect(fake.calls("implementer")).toHaveLength(2);
    expect(fake.calls("implementer")[1]!.prompt).toContain("Which flag should the build use?\n  → --safe");
    expect(h.events.some((e) => e.type === "warning" && e.text.includes("previous run was interrupted"))).toBe(false);
    // Information, not a waiver: the review ran, nothing was accepted.
    expect(fake.calls("code_reviewer")).toHaveLength(1);
    expect(stateOf(h).accepted).toBeUndefined();
  });

  it("does not turn a run that is over, or waits for something else, into one that waits for answers when --answers comes", async () => {
    h.clarifier = new ScriptedClarifier([{ kind: "defer" }]);
    expect(await start(putOff())).toBe(EXIT.HUMAN_REVIEW);
    const pending = stateOf(h).clarifications![0]!;
    const store = RunStore.open(h.runsDir);
    const aborted = store.loadState();
    aborted.humanReview = null;
    aborted.phase = "ABORTED";
    store.saveState(aborted);
    const { wf } = resumedWorkflow(h);
    expect(() => wf.applyAnswers({ requestId: pending.id, answers: { q1: { options: ["q1o2"] } } })).toThrow("is not waiting for answers");
    // Its question belongs to a call that is gone and nobody owes it any more.
    expect(stateOf(h)).toMatchObject({ phase: "ABORTED" });
    expect(stateOf(h).clarifications).toMatchObject([{ status: "interrupted" }]);
  });

  it("stops on Esc with the question still open: the run is interrupted, and the question is still owed", async () => {
    const broker = new ClarificationBroker();
    h.clarifier = broker;
    fake.setScenario(putOff());
    const { wf, bus } = newWorkflow(h, "Make app.txt fixed");
    bus.on((e) => {
      if (e.type === "clarification.requested") setTimeout(() => wf.interrupt(), 200);
    });
    expect(await wf.run()).toBe(EXIT.INTERRUPTED);
    const st = stateOf(h);
    expect(st.humanReview).toMatchObject({ reason: "clarification_required", resumePhase: "IMPLEMENT" });
    expect(st.clarifications).toMatchObject([{ status: "pending" }]);
    expect(broker.pending()).toEqual([]);
    expect(fake.questionReplies()).toEqual([]);
  });

  it("closes a question of Claude that nobody answered when the run is stopped, and records a dismissal as one", async () => {
    h.clarifier = new ScriptedClarifier([{ kind: "cancelled" }]);
    expect(await start({ ...happy(), implementer: [{ questions: [flag], write: { "app.txt": "fixed\n" }, output: impl() }] })).toBe(0);
    expect(fake.questionReplies()).toEqual([{ behavior: "deny", message: expect.stringContaining("dismissed the question") }]);
    expect(stateOf(h).clarifications).toMatchObject([{ status: "cancelled" }]);
    // A dismissed question is not a tool that needs allowing in Claude's settings.
    expect(h.events.some((e) => e.type === "warning" && e.text.includes("AskUserQuestion"))).toBe(false);
  });

  it("asks in the middle of a revision without losing its feedback, and still asks before adopting what the answer widens", async () => {
    h.clarifier = new ScriptedClarifier([{ kind: "answered", answers: [{ questionId: "q1", optionIds: [], otherText: "yes, also cover landscape" }] }]);
    const landscape = issue("C2", "medium", "also verify the layout in landscape", "out_of_scope");
    const widened = plan("v2", {
      acceptance_criteria: [{ id: "AC1", criterion: "check.mjs exits 0" }, { id: "AC2", criterion: "the layout holds in landscape" }],
      feedback_resolution: [{ issue_id: "C1", decision: "accepted", rationale: "done" }, { issue_id: "C2", decision: "accepted", rationale: "the user said so" }],
    });
    const scenario = {
      ...happy(),
      planner: [{ output: plan() }, { output: plannerAsk([plannerQuestion("Cover landscape as well?")]) }, { output: widened }],
      plan_reviewer: [{ output: critique(false, [issue("C1"), landscape]) }, { output: critique(true) }],
    };
    expect(await start(scenario)).toBe(EXIT.HUMAN_REVIEW);
    const st = stateOf(h);
    // The question belonged to round 2's revision (it spent neither the round nor the version), and the revision after the answer
    // still carried the critic's feedback.
    expect([st.planningRound, st.planVersion]).toEqual([2, 2]);
    expect(fake.calls("planner")).toHaveLength(3);
    expect(fake.calls("planner")[2]!.prompt).toContain("C1");
    expect(fake.calls("planner")[2]!.prompt).toContain("Cover landscape as well?");
    // What the answer widens is the existing mechanism's to decide: the user is asked to approve it, as for any widened plan.
    expect(st.humanReview).toMatchObject({ reason: "scope_expansion", fromPhase: "PLAN", resumePhase: "PLAN_REVIEW" });
    expect(st.accepted?.scope ?? []).toEqual([]);
    expect(fake.calls("plan_reviewer")).toHaveLength(1);
  });

  it("takes the user's answers into the mark of what the implementer was given, so a resume after new answers runs it again", async () => {
    h.clarifier = new ScriptedClarifier([pickFirst]);
    const { answersDigest } = await import("../../src/quality/progress.js");
    expect(await start({ ...happy(), planner: [{ output: plannerAsk() }, { output: plan() }] })).toBe(0);
    const entries = stateOf(h).clarifications!;
    const before = answersDigest(entries);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    // The same answers again, or a question not answered, change nothing; another answer does.
    expect(answersDigest([...entries, { ...entries[0]!, id: "clq-x", status: "pending", answers: undefined }])).toBe(before);
    expect(answersDigest([...entries, { ...entries[0]!, id: "clq-y", status: "answered", answers: [{ questionId: "q1", optionIds: ["q1o2"], otherText: null }] }])).not.toBe(before);
    expect(answersDigest(undefined)).toBe("");
  });
});
