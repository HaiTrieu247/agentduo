import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "../src/events.js";
import { approval, critique, finding, impl, issue, plan, review } from "./helpers/builders.js";
import { testConfig, type ConfigOverrides } from "./helpers/config.js";
import { FakeClis } from "./helpers/fake-clis.js";
import { makeHarness, newWorkflow, resume, resumedWorkflow, runDirOf, ScriptedDecider, stateOf, type Harness } from "./helpers/harness.js";
import { git, makeRepo } from "./helpers/repo.js";
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

type Scenario = Record<string, unknown[]>;
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
    expect([hr.reason, hr.message]).toEqual(["implementer_blocked", "API key needed"]);
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
    fake.setScenario({ ...happy(), implementer: [{ sleep: 10_000, output: impl() }, { write: { "app.txt": "fixed\n" }, output: impl() }] });
    const { wf, bus } = newWorkflow(h, "Make app.txt fixed");
    bus.on((e) => {
      if (e.type === "phase.started" && e.phase === "IMPLEMENT") setTimeout(() => wf.interrupt(), 300);
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
    }
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

  it("rejects decisions when none is pending", async () => {
    await start(happy());
    const { wf } = resumedWorkflow(h);
    await expect(wf.applyDecision("resume")).rejects.toThrow("not waiting for a decision");
  });
});
