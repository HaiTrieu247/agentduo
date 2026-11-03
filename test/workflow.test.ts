import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Chat, type ChatUi } from "../src/chat.js";
import { AttachmentStore } from "../src/core/attachments.js";
import { settings } from "../src/core/settings.js";
import { EventBus, type Message } from "../src/events.js";
import { approval, critique, finding, impl, issue, plan, review } from "./helpers/builders.js";
import { GIT_MISSING, MARKER, RunGitError } from "../src/core/run-git.js";
import type { RunGit } from "../src/core/state.js";
import { testConfig, userDataEnv, type ConfigOverrides } from "./helpers/config.js";
import { FakeClis } from "./helpers/fake-clis.js";
import { makeHarness, newWorkflow, resume, resumedWorkflow, runDirOf, ScriptedDecider, stateOf, type Harness } from "./helpers/harness.js";
import { png } from "./helpers/images.js";
import { CHECK_SCRIPT, git, makeRepo } from "./helpers/repo.js";
import { tempDir } from "./helpers/tmp.js";

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
    expect(h.events.at(-1)).toMatchObject({ type: "run.finished", summary: "quality gates passed and the review approved" });
    h.events.length = 0;
    expect(await start({ ...happy(), code_reviewer: [{ output: review(false) }] }, { quality_gates: { require_codex_approval: false } })).toBe(0);
    expect(h.events.at(-1)).toMatchObject({ type: "run.finished", summary: "quality gates passed and the review did not approve (require_codex_approval is off)" });
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
      "PLAN:plan created", "PLAN_REVIEW:changes requested", "PLAN:plan revised", "PLAN_REVIEW:approved", "PLAN_FINALIZE:plan finalized",
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
      "codex>claude:plan", "claude>codex:critique", "codex>claude:plan", "claude>codex:critique", "codex>claude:approval",
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
    // Plan sign-off continues the planner's session, which has the task's image: it gets only the note's.
    expect(calls).toEqual([["planner", 0, 1], ["planner", 1, 1], ["plan_reviewer", 0, 2], ["plan_finalizer", 0, 1], ["implementer", 0, 2], ["code_reviewer", 0, 2]]);
    expect(fake.calls("plan_finalizer")[0]!.prompt).toContain("## New notes from the human operator");
    expect(fake.calls("plan_finalizer")[0]!.prompt).toContain("notes.txt");
    expect(fake.calls("plan_finalizer")[0]!.prompt).not.toContain("mockup.png");
    expect(fake.calls("plan_reviewer")[0]!.prompt).toContain("and this detail\n  Files:");
    expect(fake.calls("plan_reviewer")[0]!.prompt).toContain("notes.txt");
    expect(fake.calls("planner")[1]!.prompt).not.toContain("and this detail");
    expect(stateOf(h).humanNotes[0]!.attachments!.map((a) => a.name)).toEqual(["detail.png", "notes.txt"]);
  });

  it("escalates after max planning rounds; resume implements the latest plan", async () => {
    expect(await start({ ...happy(), plan_reviewer: [{ output: critique(false, [issue("C1")]) }] }, { limits: { max_planning_rounds: 2 } })).toBe(2);
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
    for (const role of ["planner", "plan_reviewer", "implementer", "code_reviewer"]) {
      for (const call of fake.calls(role)) {
        expect(call.prompt, role).toContain("Yes, keep the old format readable.");
        expect(call.prompt.split("Should the fix keep the old format?").length - 1, role).toBe(1);
      }
      expect(fake.calls(role).length, role).toBeGreaterThan(0);
    }
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
    expect(retry).toContain("Previous attempt was rejected");
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
    const scenario = { ...happy(), implementer: [{ write: { "app.txt": "fixed\n" }, output: impl("completed", ["F1"]) }], code_reviewer: [{ output: review(false, [finding("F1")]) }] };
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
    fake.setScenario({ ...happy(), planner: [{ sleep: 1500, output: plan() }] });
    const { wf, bus } = newWorkflow(h, "Make app.txt fixed");
    bus.on((e) => {
      if (e.type === "phase.started" && e.phase === "PLAN") setTimeout(() => wf.addNote("keep app.txt short"), 300);
    });
    expect(await wf.run()).toBe(0);
    expect(fake.calls("planner")[0]!.prompt).not.toContain("keep app.txt short");
    for (const role of ["plan_reviewer", "implementer", "code_reviewer"]) expect(fake.calls(role)[0]!.prompt, role).toContain("keep app.txt short");
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
    const scenario = { ...happy(), code_reviewer: [{ output: review(false, [finding("F1")]) }, { output: review(false, [finding("F1")]) }, { output: review(true, [], ["F1"]) }] };
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
      expect(prompt, role).toContain("**Codex, after discussing it with Claude Code:**\nSYNTHESIS: keep the old format readable for old readers.");
      for (const draft of ["DRAFT: keep it.", "DRAFT 2:", "REVIEW: say why."]) expect(prompt, role).not.toContain(draft);
    }
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

  it("continues each role's own session with only what is new, and never passes a session from one role to another", async () => {
    expect(await start(twoRounds())).toBe(0);
    const [planner1, planner2] = calls("planner");
    const [critic1, critic2] = calls("plan_reviewer");
    const [impl1, impl2] = calls("implementer");
    const [review1, review2] = calls("code_reviewer");
    const signOff = calls("plan_finalizer")[0]!;
    for (const first of [planner1, critic1, impl1, review1]) expect(first!.resumed).toBeUndefined();
    expect(planner2!.resumed).toBe(planner1!.session);
    expect(signOff.resumed).toBe(planner1!.session);
    expect(critic2!.resumed).toBe(critic1!.session);
    expect(impl2!.resumed).toBe(impl1!.session);
    expect(review2!.resumed).toBe(review1!.session);
    // Four sessions, one per role: plan sign-off is the planner's own.
    expect(new Set(fake.calls().map((c) => c.session)).size).toBe(4);
    expect(stateOf(h).sessions).toEqual({
      planner: expect.objectContaining({ backend: "codex", id: planner1!.session }),
      plan_reviewer: expect.objectContaining({ backend: "claude", id: critic1!.session }),
      implementer: expect.objectContaining({ backend: "claude", id: impl1!.session, planHash: stateOf(h).finalPlanHash }),
      code_reviewer: expect.objectContaining({ backend: "codex", id: review1!.session, reviewed: stateOf(h).lastSnapshot!.commit }),
    });
    for (const c of [planner2, critic2, signOff, impl2, review2]) {
      expect(c!.prompt, c!.role).toContain("this message continues your session");
      expect(c!.prompt, c!.role).not.toContain("Make app.txt fixed");
    }
    for (const c of [planner1, critic1, impl1, review1]) expect(c!.prompt, c!.role).toContain("## Task\nMake app.txt fixed");
    expect(planner2!.prompt).toContain("problem"); // the critique's issue
    expect(planner2!.prompt).not.toContain("as JSON");
    expect(critic2!.prompt).toContain("# Plan v2: v2");
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
    expect(lost).toEqual(["planner", "plan_reviewer", "plan_finalizer", "implementer", "code_reviewer"]);
    for (const role of ["planner", "plan_reviewer", "plan_finalizer", "implementer", "code_reviewer"]) {
      for (const c of calls(role)) {
        expect(c.resumed, role).toBeUndefined();
        expect(c.prompt, role).toContain("## Task\nMake app.txt fixed");
      }
    }
    expect(stateOf(h).history.map((x) => `${x.phase}:${x.status}`)).toContain("CODE_REVIEW:approved");
    expect(h.events.filter((e) => e.type === "agent.retry")).toHaveLength(5);
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
    expect(impl2.resumed).toBe(saved.implementer!.id);
    expect(impl2.prompt).toContain("## New notes from the human operator (highest priority)\n- (");
    expect(impl2.prompt).toContain("try the edge case");
    expect(calls("code_reviewer")[1]!.resumed).toBe(saved.code_reviewer!.id);
    // The implementer moves to Codex: its Claude session cannot go on there.
    h.cfg = testConfig(fake, { limits: { max_review_rounds: 1 }, agents: { ...h.cfg.agents, implementer: "codex" } });
    expect(await resume(h, { decision: "resume" })).toBe(0);
    const impl3 = calls("implementer")[2]!;
    expect([impl3.backend, impl3.resumed]).toEqual(["codex", undefined]);
    expect(impl3.prompt).toContain("## Task\nMake app.txt fixed");
    expect(stateOf(h).sessions!.implementer).toMatchObject({ backend: "codex", id: impl3.session });
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
    for (const note of ["- `check.mjs`: CHECK-NOTE (Codex, planner)", "README-NOTE", "CRITIC-NOTE"]) expect(prompt("implementer"), note).toContain(note);
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
        "unchanged since: the workspace's files, your notes, the final plan, the open review findings, the implementer's settings (agentduo's and its CLI's)"]);
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
    // Blocked; the note's attempt fails (continued session, then two fresh ones); a plain resume retries it.
    expect(await start({ ...happy(), implementer: [blocked(), notJson(), notJson(), notJson(), fixed()] })).toBe(2);
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
    expect(h.events.at(-1)).toMatchObject({ type: "run.finished", summary: "quality gates passed and the review approved" });
  });

  it("re-runs the gates once a round at most, when the files keep changing", async () => {
    fake.setScenario(happy());
    const { wf, bus } = newWorkflow(h, "Make app.txt fixed");
    let n = 0;
    // Something writes a file each time the gates finish: the review must still come.
    bus.on((e) => {
      if (e.type === "step.completed" && e.entry.phase === "VERIFY") writeFileSync(join(h.repo, "log.txt"), `${++n}\n`);
    });
    expect(await wf.run()).toBe(0);
    expect(n).toBe(2);
    expect(warnings()).toContain("the workspace changed again after the quality gates ran: the review gets the results of an earlier revision");
    expect(fake.calls("code_reviewer")).toHaveLength(1);
    expect(h.events.at(-1)).toMatchObject({ type: "run.finished", summary: "quality gates passed on an earlier revision and the review approved" });
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
