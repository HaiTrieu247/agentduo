import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import {
  blockedReview, blockerKey, changedParts, cycleProgress, findingsDigest, heldReview, implementerSettings, nextBlocker, nextStall, planAnswer, planProgress,
  planStallReview, stallHeldReview, stallReview, trackCritique,
} from "../src/core/progress.js";
import type { PlanCycle, ProgressMark, ReviewCycle } from "../src/core/state.js";
import { finding, issue, plan } from "./helpers/builders.js";
import { tempDir } from "./helpers/tmp.js";

const mark = (extra: Partial<ProgressMark> = {}): ProgressMark => ({ tree: "t1", notes: 0, plan: "p1", findings: "f1", settings: "s1", ...extra });

describe("progress: a blocker's identity and repeats", () => {
  it("knows a blocker by its words, whatever their case, punctuation or spacing", () => {
    expect(blockerKey("  API key needed. ")).toBe("api key needed");
    expect(blockerKey("api  KEY — needed!")).toBe(blockerKey("API key needed"));
    expect(blockerKey("Thiếu khóa API")).toBe("thiếu khóa api");
    expect(blockerKey("API key needed")).not.toBe(blockerKey("API token needed"));
  });

  it("counts the same blocker in a row only when the attempt changed no file, in the same round", () => {
    const first = nextBlocker(null, "API key needed", 1, mark(), true);
    expect(first).toEqual({ reason: "API key needed", key: "api key needed", round: 1, repeats: 1, mark: mark() });
    const again = nextBlocker(first, "api key needed.", 1, mark({ notes: 1 }), false);
    expect([again.repeats, again.reason, again.mark.notes]).toEqual([2, "api key needed.", 1]);
    expect(nextBlocker(again, "API key needed", 1, mark(), false).repeats).toBe(3);
    // Progress or another blocker starts the count again.
    expect(nextBlocker(again, "API key needed", 1, mark(), true).repeats).toBe(1);
    expect(nextBlocker(again, "the database is down", 1, mark(), false).repeats).toBe(1);
    expect(nextBlocker(again, "API key needed", 2, mark(), false).repeats).toBe(1);
  });

  it("names what changed between two marks, in a fixed order", () => {
    expect(changedParts(mark(), mark())).toEqual([]);
    expect(changedParts(mark(), mark({ settings: "s2", tree: "t2", notes: 1 }))).toEqual(["tree", "notes", "settings"]);
    expect(changedParts(mark(), mark({ plan: null, findings: "f2" }))).toEqual(["plan", "findings"]);
    expect(findingsDigest([finding("F1")])).toBe(findingsDigest([finding("F1")]));
    expect(findingsDigest([finding("F1")])).not.toBe(findingsDigest([finding("F1", "critical")]));
  });

  it("says what a blocker needs, and why a resume with nothing new did not run the implementer", () => {
    const b = nextBlocker(null, "API key needed.", 2, mark(), false);
    const blocked = blockedReview(b);
    expect(blocked.message).toBe("the implementer is blocked: API key needed. It needs something from you: 'resume' with a --note that gives it what it " +
      "asks for, or after you change the files it needs, re-runs round 2; 'resume' with nothing new does not run it again. " +
      "'revise' re-plans with your note; 'abort' ends the run.");
    expect(blocked.details).toEqual([]);
    const repeated = { ...b, repeats: 3 };
    expect(blockedReview(repeated).details).toEqual(["the same blocker 3 times in a row, the last attempt changing no file: what it was given since " +
      "did not unblock it (consider 'revise' or 'abort')"]);
    const held = heldReview(repeated);
    expect(held.message).toContain("so it was not run again (that would repeat the same call): API key needed. Give it what it needs: 'resume' with a --note");
    expect(held.message).toContain("such as a credential, a service or a tool");
    expect(held.details).toEqual(["blocked in round 2, 3 times in a row",
      "unchanged since: the workspace's files, your notes, the final plan, the open review findings, the implementer's settings (agentduo's and its CLI's)"]);
  });
});

describe("progress: review cycles that do not converge", () => {
  const ws = join("/ws");
  const F1 = { key: "F1", file: "app.ts" };
  const before = (extra: Partial<ReviewCycle> = {}): ReviewCycle => ({
    round: 1, revision: "a".repeat(40), tree: "t1", plan: "p", blocking: [F1], failingGates: [], progress: null,
    counts: { new: 1, open: 0, reopened: 0, resolved: 0 }, ...extra,
  });
  const now = (extra: Partial<Pick<ReviewCycle, "plan" | "tree" | "blocking" | "failingGates">> = {}) =>
    ({ plan: "p", tree: "t2", blocking: [F1], failingGates: [], ...extra });
  const moved = (prev: ReviewCycle | undefined, cur: ReturnType<typeof now>, resolved: string[], changed: Array<[string, string]> | null) =>
    cycleProgress(prev, cur, { resolved, changed, workspace: ws });

  it("measures a cycle's progress by what moved, not by what the agents said", () => {
    // Nothing to compare with: the first review of a plan, or nothing blocked before.
    expect(moved(undefined, now(), [], [])).toBeNull();
    expect(moved(before({ plan: "old" }), now(), [], [])).toBeNull();
    expect(moved(before({ blocking: [] }), now(), [], [])).toBeNull();
    // The same blocking finding, its file untouched, other files changed: no progress.
    expect(moved(before(), now(), [], [["M", "notes.md"]])).toEqual([]);
    // What counts: the review resolved one, one no longer blocks, a required gate passes, a finding's file changed.
    expect(moved(before({ blocking: [F1, { key: "F2", file: "db.ts" }] }), now(), ["F2"], [])).toEqual(["the review resolved F2"]);
    expect(moved(before(), now({ blocking: [] }), [], [])).toEqual(["F1 no longer blocks"]);
    expect(moved(before({ failingGates: ["check"] }), now(), [], [])).toEqual(["required gate 'check' passes now"]);
    expect(moved(before(), now(), [], [["M", "app.ts"], ["M", "notes.md"]])).toEqual(["app.ts changed (the file of F1)"]);
    // A general finding: any change to the files counts. Git cannot tell: a changed tree counts.
    expect(moved(before({ blocking: [{ key: "F1", file: "" }] }), now({ blocking: [{ key: "F1", file: "" }] }), [], [["M", "x.ts"]])).toEqual(["files changed: x.ts"]);
    expect(moved(before(), now(), [], null)).toEqual(["the code changed"]);
    expect(moved(before(), now({ tree: "t1" }), [], null)).toEqual([]);
  });

  it("stops after two cycles in a row without progress, or after one in which nothing changed at all", () => {
    const first = nextStall(null, { round: 2, progress: [], keys: ["F1"] }, false);
    expect(first).toEqual({ stall: { count: 1, since: 2, round: 2, keys: ["F1"], mark: null }, stop: false });
    const second = nextStall(first.stall, { round: 3, progress: [], keys: ["F1"] }, false);
    expect(second).toEqual({ stall: { count: 2, since: 2, round: 3, keys: ["F1"], mark: null }, stop: true });
    // Progress ends it; a cycle that cannot be judged neither counts nor stops.
    expect(nextStall(second.stall, { round: 4, progress: ["the review resolved F1"], keys: [] }, false)).toEqual({ stall: null, stop: false });
    expect(nextStall(null, { round: 2, progress: [], keys: ["F1"] }, true).stop).toBe(true);
    expect(nextStall(null, { round: 2, progress: null, keys: ["F1"] }, true)).toEqual({ stall: null, stop: false });
  });

  it("says what holds the loop, and why a resume with nothing new did not start a round", () => {
    const stall = { count: 2, since: 2, round: 3, keys: ["F1"], mark: mark() };
    const stopped = stallReview(stall, ["F1 [high] app.ts: bad"]);
    expect(stopped.message).toContain("the review loop is not converging: round 3's review leaves the same blocking finding(s) (F1)");
    expect(stopped.message).toContain("'resume' with a --note");
    expect(stopped.message).toContain("Nothing is waived: the findings stay open.");
    expect(stopped.details).toEqual(["F1 [high] app.ts: bad", "2 review round(s) in a row without progress (since round 2)"]);
    const held = stallHeldReview(stall);
    expect(held.message).toContain("nothing changed since the review loop stalled, so no fix round was started");
    expect(held.details).toEqual(["stalled at round 3 on F1",
      "unchanged since: the workspace's files, your notes, the final plan, the open review findings, the implementer's settings (agentduo's and its CLI's)"]);
  });
});

describe("progress: the implementer's settings", () => {
  let t: { path: string; cleanup(): void };
  let env: NodeJS.ProcessEnv;
  let workspace: string;
  beforeEach(() => {
    t = tempDir();
    workspace = join(t.path, "ws");
    mkdirSync(workspace);
    env = { HOME: join(t.path, "home"), CLAUDE_CONFIG_DIR: join(t.path, "claude"), CODEX_HOME: join(t.path, "codex") };
  });
  afterEach(() => t.cleanup());

  it("changes with what agentduo passes the implementer, and only that", () => {
    const cfg = defaultConfig();
    const base = implementerSettings(cfg, workspace, env);
    expect(implementerSettings(defaultConfig(), workspace, env)).toBe(base);
    const changed = (edit: (c: ReturnType<typeof defaultConfig>) => void) => {
      const c = defaultConfig();
      edit(c);
      return implementerSettings(c, workspace, env) !== base;
    };
    expect(changed((c) => { c.claude.role_args.implementer = ["--permission-mode", "acceptEdits"]; })).toBe(true);
    expect(changed((c) => { c.claude.args = ["--allowedTools", "Bash(npm test:*)"]; })).toBe(true);
    expect(changed((c) => { c.claude.model = "opus"; })).toBe(true);
    expect(changed((c) => { c.agents.implementer = "codex"; })).toBe(true);
    // Not the implementer's: the cost cap, other roles' arguments, the other CLI.
    expect(changed((c) => { c.claude.max_budget_usd = 2; })).toBe(false);
    expect(changed((c) => { c.claude.role_args.plan_reviewer = ["--effort", "high"]; })).toBe(false);
    expect(changed((c) => { c.codex.args = ["--sandbox", "workspace-write"]; })).toBe(false);
  });

  it("changes with the CLI's own settings files, which snapshots leave out", () => {
    const cfg = defaultConfig();
    const base = implementerSettings(cfg, workspace, env);
    mkdirSync(join(workspace, ".claude"));
    writeFileSync(join(workspace, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(npm test:*)"] } }));
    const local = implementerSettings(cfg, workspace, env);
    expect(local).not.toBe(base);
    mkdirSync(env.CLAUDE_CONFIG_DIR!);
    writeFileSync(join(env.CLAUDE_CONFIG_DIR!, "settings.json"), JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }));
    expect(implementerSettings(cfg, workspace, env)).not.toBe(local);
    // Codex reads its own config.toml; Claude's files are not its.
    cfg.agents.implementer = "codex";
    const codex = implementerSettings(cfg, workspace, env);
    writeFileSync(join(workspace, ".claude", "settings.local.json"), "{}");
    expect(implementerSettings(cfg, workspace, env)).toBe(codex);
    mkdirSync(env.CODEX_HOME!);
    writeFileSync(join(env.CODEX_HOME!, "config.toml"), 'sandbox_mode = "workspace-write"\n');
    expect(implementerSettings(cfg, workspace, env)).not.toBe(codex);
  });
});

describe("progress: planning that does not converge", () => {
  const empty = "the plan never handles an empty app.txt";

  it("tracks a critique's issues by identity: renumbered or reworded, one issue stays one; left out, it is resolved", () => {
    let t = trackCritique([], [issue("C1", "high", empty), issue("C2", "medium", "rename the helper")], { round: 1, plan: "p1" });
    expect(t.keys).toEqual({ C1: "C1", C2: "C2" });
    t = trackCritique(t.ledger, [issue("C7", "high", "the plan never handles an empty app.txt file")], { round: 2, plan: "p2" });
    expect([t.keys, t.resolved]).toEqual([{ C7: "C1" }, ["C2"]]);
    expect(t.ledger.find((e) => e.key === "C1")).toMatchObject({ ids: ["C1", "C7"], status: "open", seen: [{ round: 1 }, { round: 2 }] });
  });

  it("counts a resolved or no longer blocking issue as progress, and a rewritten plan with the same blockers as none", () => {
    const prev: PlanCycle = { round: 1, plan: "p1", blocking: ["C1", "C2"], progress: null };
    expect(planProgress(prev, ["C1"], ["C2"])).toEqual(["the critic resolved C2"]);
    expect(planProgress(prev, ["C1"], [])).toEqual(["C2 no longer blocks"]);
    expect(planProgress(prev, ["C1", "C2"], [])).toEqual([]);
    // Nothing to compare with: no critique before, or one that blocked on nothing.
    expect([planProgress(undefined, ["C1"], []), planProgress({ ...prev, blocking: [] }, ["C1"], [])]).toEqual([null, null]);
    // The review loop's breaker, on planning's terms: two critiques in a row without progress, or one on an unchanged plan.
    const once = nextStall(null, { round: 2, progress: [], keys: ["C1"] }, false);
    expect([once.stop, nextStall(once.stall, { round: 3, progress: [], keys: ["C1"] }, false).stop, nextStall(null, { round: 2, progress: [], keys: ["C1"] }, true).stop])
      .toEqual([false, true, true]);
  });

  it("says why planning stops and what each choice does, with the plan's answer to each issue", () => {
    const answered = plan("v2", { feedback_resolution: [{ issue_id: "C1", decision: "disputed", rationale: "cannot happen" }] });
    expect([planAnswer(answered, ["C1"]), planAnswer(answered, ["C9"])]).toEqual(["disputed (cannot happen)", "nothing"]);
    const { message, details } = planStallReview({ count: 2, since: 2, round: 3, keys: ["C1"], mark: null }, ["C1 [high] x"]);
    expect(message).toContain("planning is not converging: round 3's critique blocks on the same issue(s) (C1)");
    expect(message).toContain("'resume' implements the latest plan as it is, recorded as accepted by you");
    expect(details).toEqual(["C1 [high] x", "2 critique(s) in a row without progress (since round 2)"]);
  });
});
