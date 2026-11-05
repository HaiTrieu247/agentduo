import { describe, expect, it } from "vitest";
import type { GateResult } from "../../src/quality/gates.js";
import { newState, type ReviewApproval, type RunState } from "../../src/workflow/state.js";
import {
  configChanges, configDigest, doneText, FINAL_REFRESHES, finalProblems, finalVerification, gateOutcome, gateSpecs, gatesStale, gateText, nextFinalCheck,
  staleReview, verificationLines,
} from "../../src/quality/verification.js";

const gate = (name: string, passed: boolean, extra: Partial<GateResult> = {}): GateResult => ({
  name, command: `run ${name}`, required: true, exitCode: passed ? 0 : 1, timedOut: false, passed, durationSec: 0, log: "", outputTail: "", ...extra,
});
const specs = gateSpecs([{ name: "tests", command: "run tests" }, { name: "lint", command: "run lint", required: false, timeout_sec: 30 }], 900);
const approval: ReviewApproval = { round: 2, revision: "c".repeat(40), tree: "T1", plan: "P", approved: true };

describe("verification: what the gates' results are evidence about", () => {
  it("fingerprints the gate configuration and names what changed in it", () => {
    expect(specs).toEqual([{ name: "tests", command: "run tests", required: true, timeoutSec: 900 }, { name: "lint", command: "run lint", required: false, timeoutSec: 30 }]);
    expect(configDigest(specs)).toBe(configDigest(gateSpecs([{ name: "tests", command: "run tests" }, { name: "lint", command: "run lint", required: false, timeout_sec: 30 }], 900)));
    expect(configChanges(specs, specs)).toEqual([]);
    const now = [{ ...specs[0]!, command: "run tests --ci", timeoutSec: 60 }, { name: "types", command: "tsc", required: true, timeoutSec: 900 }];
    expect(configChanges(specs, now)).toEqual(["gate 'tests': command changed", "gate 'tests': timeout 900s → 60s", "gate 'types' added", "gate 'lint' removed"]);
    expect(configChanges(specs, [{ ...specs[1]!, required: true }, specs[0]!])).toEqual(["gate 'lint' is required now"]);
    expect(configChanges(specs, [specs[1]!, specs[0]!])).toEqual(["the gates' order changed"]);
  });

  it("tells a pass from a failure, a timeout, a gate that could not run, and a failure you accepted", () => {
    const accepted = new Set(["layout"]);
    expect([gate("a", true), gate("a", false), gate("a", false, { timedOut: true, exitCode: null }), gate("a", false, { exitCode: 127 }), gate("a", false, { exitCode: null })]
      .map((g) => gateOutcome(g, accepted))).toEqual(["passed", "failed", "timed_out", "error", "error"]);
    expect([gateOutcome(gate("layout", false), accepted), gateOutcome(gate("layout", false, { required: false }), accepted)]).toEqual(["accepted", "failed"]);
    expect(gateText({ name: "lint", required: false, outcome: "failed", exitCode: 2 })).toBe("lint (optional) failed (exit 2)");
    expect(gateText({ name: "layout", required: true, outcome: "accepted", exitCode: 1 })).toBe("layout failing as before the task, accepted by you");
  });

  it("holds results only for the tree and the configuration they ran with, and never assumes what it cannot tell", () => {
    const ran = { tree: "T1", config: specs, results: [gate("tests", true)] };
    expect(gatesStale(ran, "T1", specs)).toEqual([]);
    expect(gatesStale(ran, "T2", specs, [["M", "a.ts"], ["?", "b.ts"]])).toEqual(["the quality gates ran on an earlier revision; changed since: M a.ts, ? b.ts"]);
    expect(gatesStale({ ...ran, config: [specs[0]!] }, "T1", specs)).toEqual(["the gate configuration changed since they ran: gate 'lint' added"]);
    expect(gatesStale({ ...ran, results: null }, "T1", specs)).toEqual(["the quality gates have not run on this code"]);
    // An older run's: which tree or configuration is not known, so they are out of date.
    expect(gatesStale({ tree: undefined, config: undefined, results: ran.results }, "T1", specs)).toEqual([
      "it is not known which files the quality gates ran on (a run of an older agentduo)",
      "it is not known which gate configuration they ran with (a run of an older agentduo)",
    ]);
    // No gate configured: there is nothing to be out of date.
    expect(gatesStale({ ...ran, results: null }, "T9", [])).toEqual([]);
  });
});

describe("verification: the final check before DONE", () => {
  const fresh = { tree: "T1", plan: "P", approval, changedSinceApproval: null, gates: specs, ran: { tree: "T1", config: specs, results: [gate("tests", true)] },
    changedSinceGates: null, blockingGates: [], pending: 0 };

  it("finds nothing to hold DONE back when the approval and the gates are about the code as it is", () => {
    expect(finalProblems(fresh)).toEqual([]);
    // With no gate configured, the approval alone.
    expect(finalProblems({ ...fresh, gates: [], ran: { tree: null, config: null, results: null } })).toEqual([]);
  });

  it("names why the evidence does not hold: changed code, stale gates, no approval, failing gates or pending decisions", () => {
    expect(finalProblems({ ...fresh, tree: "T2", changedSinceApproval: [["D", "README.md"]], changedSinceGates: [["D", "README.md"]] })).toEqual([
      { kind: "code", text: "the code changed after the review of round 2 approved it: D README.md" },
      { kind: "gates", text: "the quality gates ran on an earlier revision; changed since: D README.md" },
    ]);
    expect(finalProblems({ ...fresh, gates: [specs[0]!] }).map((p) => p.kind)).toEqual(["gates"]);
    expect(finalProblems({ ...fresh, approval: null })).toEqual([{ kind: "review", text: "no review approved the code under the final plan" }]);
    expect(finalProblems({ ...fresh, approval: { ...approval, plan: "older plan" } }).map((p) => p.kind)).toEqual(["review"]);
    expect(finalProblems({ ...fresh, blockingGates: ["tests"], pending: 1 })).toEqual([
      { kind: "blocked", text: "required gate(s) failing on this code: 'tests'" }, { kind: "blocked", text: "1 item(s) still wait for your decision" },
    ]);
    // Failing results that are out of date are not the reason: they run again first.
    expect(finalProblems({ ...fresh, tree: "T2", blockingGates: ["tests"] }).map((p) => p.kind)).toEqual(["code", "gates"]);
  });

  it("counts its refreshes, keeps the latest reasons, and says what resume does once they run out", () => {
    let check = nextFinalCheck(null, ["a"]);
    for (let i = 0; i < 12; i++) check = nextFinalCheck(check, [`r${i}`]);
    expect([check.refreshes, check.reasons.length, check.reasons.at(-1)]).toEqual([13, 10, "r11"]);
    expect(FINAL_REFRESHES).toBe(2);
    const { message, details } = staleReview({ refreshes: 3, reasons: ["round 1: x"] }, true);
    expect(message).toContain("the final code could not be verified: 3 time(s) in a row");
    expect(message).toContain("'resume' verifies the files as they are then (the gates run again, and the code is reviewed again if it changed)");
    expect(message).toContain("nothing is waived");
    expect(details).toEqual(["round 1: x"]);
    expect(staleReview({ refreshes: 3, reasons: [] }, false).message).toContain("(the review's approval)");
  });
});

describe("verification: what DONE says", () => {
  const snapshot = { commit: "a".repeat(40), tree: "T1" };
  const make = (results: GateResult[], o: { accepted?: string[]; findings?: string[]; gates?: typeof specs } = {}) => finalVerification({
    snapshot, gates: o.gates ?? specs, results, acceptedGates: new Set(o.accepted ?? []), gatesAt: "2026-11-03T10:00:00+07:00", approval, findings: o.findings ?? [], at: "now",
  });

  it("says verified only when every required gate passed on the final code", () => {
    const v = make([gate("tests", true), gate("lint", false, { required: false, exitCode: 2 })]);
    expect(v).toMatchObject({ status: "verified", exceptions: [], config: configDigest(specs), review: { round: 2, approved: true } });
    expect(doneText(v, "")).toBe("quality gates passed on the final code (optional 'lint' not passing) and the review approved");
  });

  it("keeps accepted failures apart from passes, and says DONE with accepted exceptions", () => {
    const layout = [{ name: "tests", command: "run tests", required: true, timeoutSec: 900 }, { name: "layout", command: "run layout", required: true, timeoutSec: 900 }];
    const v = make([gate("tests", true), gate("layout", false)], { accepted: ["layout"], gates: layout });
    expect(v).toMatchObject({ status: "exceptions", exceptions: ["gate 'layout'"], gates: [{ name: "tests", outcome: "passed" }, { name: "layout", outcome: "accepted", exitCode: 1 }] });
    expect(doneText(v, "you accepted 1 pre-existing failure(s)")).toBe("with accepted exceptions: quality gates passed on the final code, except 'layout', " +
      "failing as before the task, and the review approved; you accepted 1 pre-existing failure(s)");
    // An accepted finding the approving review still raises is an exception too.
    expect(make([gate("tests", true)], { findings: ["finding F2"] })).toMatchObject({ status: "exceptions", exceptions: ["finding F2"] });
  });

  it("never turns an unaccepted failure into an exception or a pass", () => {
    const v = make([gate("tests", false)], { accepted: ["other"] });
    expect([v.status, v.exceptions, v.gates[0]!.outcome]).toEqual(["not_enforced", [], "failed"]);
    expect(doneText(v, "")).toBe("required gates failing on the final code: tests failed (exit 1) (require_tests_pass is off) and the review approved");
  });

  it("says that nothing was verified automatically when no gate is configured", () => {
    const v = make([], { gates: [] });
    expect(v).toMatchObject({ status: "no_gates", gates: [], config: null, gatesAt: null });
    expect(doneText(v, "")).toBe("the review approved; no quality gates configured");
    expect(doneText({ ...v, review: { ...v.review, approved: false } }, "")).toBe("the review did not approve (require_codex_approval is off); no quality gates configured");
  });
});

describe("verification: status lines", () => {
  const running = (extra: Partial<RunState>): RunState => ({
    ...newState("run-1", "task", { max_planning_rounds: 3, max_review_rounds: 3 }), phase: "CODE_REVIEW",
    lastSnapshot: { commit: "b".repeat(40), tree: "T1" }, ...extra,
  });

  it("tells gates on the current revision from gates on an earlier one, not run, and none configured", () => {
    const ran = { lastGates: [gate("tests", true), gate("lint", false, { required: false })], gatesTree: "T1", gatesConfig: specs };
    expect(verificationLines(running(ran))).toEqual(["required quality gates passed on the current revision: tests passed, lint (optional) failed (exit 1)"]);
    expect(verificationLines(running({ ...ran, lastGates: [gate("tests", false, { timedOut: true, exitCode: null })] })))
      .toEqual(["required quality gates failing on the current revision: tests timed out"]);
    expect(verificationLines(running(ran), { workspaceTree: "T2" })).toEqual([
      "quality gates ran on an earlier revision or configuration, not on the current code: tests passed, lint (optional) failed (exit 1)",
      "out of date: the quality gates ran on an earlier revision",
    ]);
    expect(verificationLines(running(ran), { configured: [specs[0]!] })[1]).toBe("out of date: the gate configuration changed since they ran: gate 'lint' removed");
    expect(verificationLines(running({}))).toEqual(["quality gates not run yet"]);
    expect(verificationLines(running({}), { configured: [] })).toEqual(["no quality gates configured: nothing is verified automatically"]);
    // An older run's results: what they ran with is not known, so they are not said to hold.
    expect(verificationLines(running({ lastGates: [gate("tests", true)] }))[1]).toBe("out of date: it is not known which files the quality gates ran on (a run of an older agentduo)");
  });

  it("says what a DONE rests on, and when the workspace changed since", () => {
    const st = running({ phase: "DONE" });
    st.verification = finalVerification({
      snapshot: { commit: "a".repeat(40), tree: "T1" }, gates: specs, results: [gate("tests", true), gate("lint", true, { required: false })], acceptedGates: new Set(),
      gatesAt: "2026-11-03T10:00:00+07:00", approval, findings: [], at: "now",
    });
    expect(verificationLines(st)).toEqual([
      "verified: every required quality gate passed on the final code (`aaaaaaaaaaaa`), and the review of round 2 approved it",
      "gates: tests passed, lint (optional) passed (ran 2026-11-03T10:00:00+07:00)",
    ]);
    expect(verificationLines(st, { workspaceTree: "T2" })[2]).toBe("the workspace has changed since DONE verified it: the files there now are not verified");
    st.verification = { ...st.verification, status: "exceptions", exceptions: ["gate 'layout'"] };
    expect(verificationLines(st)[0]).toBe("DONE with accepted exceptions (gate 'layout'): the other required quality gates passed on the final code (`aaaaaaaaaaaa`), " +
      "and the review of round 2 approved it");
  });
});
