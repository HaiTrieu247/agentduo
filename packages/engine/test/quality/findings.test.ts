import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileChange, lateFindingErrors, ledgerOf, matchFindings, recordResponses, reviewFindings, setFindings, trackReview, unanswered } from "../../src/quality/findings.js";
import type { Finding } from "../../src/workflow/outputs.js";
import { newState, type TrackedFinding } from "../../src/workflow/state.js";
import { finding, impl, review } from "../helpers/builders.js";

const ws = join("/ws");
const stateWith = (ids: string[]) => {
  const st = newState("t", "task", { max_planning_rounds: 1, max_review_rounds: 1 });
  setFindings(st, ids.map((id) => finding(id, "high", `${id.toLowerCase()}.ts`)), { round: 1, revision: "r".repeat(40) });
  return st;
};

describe("findings", () => {
  it("tells how a finding's file changed since its revision, however the reviewer named it", () => {
    const changes: Array<[string, string]> = [["M", "src/a.ts"], ["D", "old.ts"], ["A", "lib/new/x.ts"]];
    expect(fileChange("src/a.ts", changes, ws)).toBe("M");
    expect(fileChange("./src/a.ts", changes, ws)).toBe("M");
    expect(fileChange("src\\a.ts", changes, ws)).toBe("M");
    expect(fileChange(join(ws, "src", "a.ts"), changes, ws)).toBe("M");
    expect(fileChange("old.ts", changes, ws)).toBe("D");
    expect(fileChange("lib/new", changes, ws)).toBe("M");
    expect(fileChange("src/b.ts", changes, ws)).toBeNull();
    expect(fileChange("src", [["M", "src2/a.ts"]], ws)).toBeNull();
    // A general finding, one outside the workspace, or no way to tell: nothing to say.
    for (const file of ["", "../elsewhere.ts"]) expect(fileChange(file, changes, ws)).toBeNull();
    expect(fileChange("src/a.ts", null, ws)).toBeNull();
  });

  it("keeps the implementer's latest answer to each open finding, from blocked attempts too, until the next review", () => {
    const st = stateWith(["F1", "F2", "F3"]);
    expect(unanswered(st).map((f) => f.id)).toEqual(["F1", "F2", "F3"]);
    recordResponses(st, impl("blocked", ["F2", "F9"], "stuck"), 2);
    expect(st.findingResponses).toEqual([{ id: "F2", resolution: "fixed", notes: "", round: 2, status: "blocked" }]);
    const disputed = { ...impl("completed"), addressed_findings: [{ finding_id: "F2", resolution: "disputed" as const, notes: "by design" },
      { finding_id: "F1", resolution: "not_applicable" as const, notes: "" }] };
    recordResponses(st, disputed, 3);
    // In the findings' order; the later answer to F2 replaces the earlier one; F9 was never open.
    expect(st.findingResponses!.map((r) => [r.id, r.resolution, r.round, r.status])).toEqual([["F1", "not_applicable", 3, "completed"], ["F2", "disputed", 3, "completed"]]);
    expect(unanswered(st).map((f) => f.id)).toEqual(["F3"]);
    // A report that answers nothing keeps the answers it had.
    recordResponses(st, impl("completed"), 4);
    expect(st.findingResponses).toHaveLength(2);
    // A new review's findings replace them, answers and all.
    setFindings(st, [finding("F4")], { round: 4, revision: "s".repeat(40) });
    expect([st.findingResponses, st.findingsSource, unanswered(st).map((f) => f.id)]).toEqual([[], { round: 4, revision: "s".repeat(40) }, ["F4"]]);
    setFindings(st, [], { round: 5, revision: "t".repeat(40) });
    expect(st.findingsSource).toBeNull();
  });

  it("shows each open finding with its answer and whether its file changed since the reviewed revision", () => {
    const st = stateWith(["F1", "F2"]);
    recordResponses(st, impl("completed", ["F1"]), 2);
    const view = reviewFindings({ state: st, source: st.findingsSource!, summary: "S", changedSince: [["M", "f2.ts"]], workspace: ws });
    expect(view).toMatchObject({ round: 1, revision: "r".repeat(40), summary: "S" });
    expect(view.items.map((i) => [i.finding.id, i.answer?.resolution ?? null, i.fileChange])).toEqual([["F1", "fixed", null], ["F2", null, "M"]]);
    expect(reviewFindings({ state: st, source: null, summary: "", changedSince: null, workspace: ws })).toMatchObject({ round: 0, revision: null, changedSince: null });
  });
});

/** A finding with its own words. */
const about = (id: string, issue: string, file = "app.ts", extra: Partial<Finding> = {}): Finding => ({ ...finding(id, "high", file), issue, ...extra });
const r1 = [about("F1", "parse() accepts a null input and then crashes"), about("F2", "the SQL query is built by string concatenation", "db.ts")];
const track = (ledger: TrackedFinding[], findings: Finding[], round: number) => trackReview(ledger, findings, { round, revision: `${round}`.repeat(40) });

describe("findings across reviews", () => {
  it("keeps a finding's identity when a review words, orders or numbers it differently", () => {
    const first = track([], r1, 1);
    expect(first.tracking).toEqual({ findings: { F1: { key: "F1", status: "new" }, F2: { key: "F2", status: "new" } }, resolved: [] });
    // Same issues: reordered, reworded, F2 renumbered F7.
    const second = track(first.ledger, [about("F7", "SQL query built with string concatenation", "./db.ts"), about("F1", "a null input crashes parse()")], 2);
    expect(second.tracking).toEqual({ findings: { F7: { key: "F2", status: "open" }, F1: { key: "F1", status: "open" } }, resolved: [] });
    const f2 = second.ledger.find((e) => e.key === "F2")!;
    expect([f2.ids, f2.issue, f2.seen.map((x) => x.round), f2.status]).toEqual([["F2", "F7"], "SQL query built with string concatenation", [1, 2], "open"]);
  });

  it("keeps a genuinely new finding apart, and an ambiguous one too", () => {
    const { ledger } = track([], r1, 1);
    const next = track(ledger, [...r1, about("F3", "the error message is not translated")], 2);
    expect(next.tracking.findings.F3).toEqual({ key: "F3", status: "new" });
    // Two findings that could both be F1 in other words: neither is merged into it.
    const twins = track(ledger, [about("F8", "parse() accepts a null input"), about("F9", "parse() crashes on a null input"), r1[1]!], 2);
    expect([twins.tracking.findings.F8!.status, twins.tracking.findings.F9!.status]).toEqual(["new", "new"]);
    // The same id for an unrelated issue in another file is a new finding, under a key of its own.
    const reused = track(ledger, [about("F1", "the README lists the wrong port", "README.md"), r1[1]!], 2);
    expect(reused.tracking.findings.F1).toEqual({ key: "F1@r2", status: "new" });
    expect(reused.tracking.resolved).toEqual(["F1"]);
    // Criteria that do not meet tell two findings apart.
    const c = track([], [about("F1", "parse() accepts a null input", "app.ts", { criteria: ["AC1"] })], 1);
    expect(matchFindings(c.ledger, [about("F4", "parse() accepts a null input", "app.ts", { criteria: ["AC2"] })])).toEqual([null]);
  });

  it("counts a finding resolved only when a review leaves it out, and reopened when one raises it again", () => {
    const { ledger } = track([], r1, 1);
    // The implementer's claim does not resolve it; the review of round 2 does, by leaving F1 out.
    const second = track(ledger, [r1[1]!], 2);
    expect(second.tracking.resolved).toEqual(["F1"]);
    expect(second.ledger.find((e) => e.key === "F1")).toMatchObject({ status: "resolved", resolvedRound: 2 });
    const third = track(second.ledger, [about("F5", "parse() still crashes on a null input"), r1[1]!], 3);
    expect(third.tracking.findings.F5).toEqual({ key: "F1", status: "reopened" });
    expect(third.ledger.find((e) => e.key === "F1")).toMatchObject({ status: "open", reopened: 1, resolvedRound: 2 });
  });

  it("starts an older run's ledger from its open findings, with what older reviews left out", () => {
    const st = newState("t", "task", { max_planning_rounds: 1, max_review_rounds: 1 });
    expect(ledgerOf(st)).toEqual([]);
    // A finding of an older review: no criteria, no late_reason.
    const old = { ...about("F1", "parse() accepts a null input") } as Partial<Finding>;
    delete old.criteria;
    delete old.late_reason;
    st.openFindings = [old as Finding];
    st.findingsSource = { round: 2, revision: "a".repeat(40) };
    expect(ledgerOf(st)).toEqual([{ key: "F1", ids: ["F1"], file: "app.ts", issue: "parse() accepts a null input", severity: "high", origin: "regression",
      criteria: [], status: "open", seen: [{ round: 2, revision: "a".repeat(40) }], resolvedRound: null, reopened: 0 }]);
    expect(track(ledgerOf(st), [about("F1", "parse() accepts a null input")], 3).tracking.findings.F1).toEqual({ key: "F1", status: "open" });
    st.trackedFindings = [];
    expect(ledgerOf(st)).toEqual([]);
  });

  it("asks why a blocking finding new on code that did not change was not reported before", () => {
    const { ledger } = track([], r1, 1);
    const late = about("F3", "the cache is never invalidated", "cache.ts");
    const check = (findings: Finding[], changed: Array<[string, string]> | null) => lateFindingErrors({
      review: review(false, findings), ledger, since: { round: 1, changed }, blockingSeverities: ["critical", "high"], workspace: ws,
    });
    expect(check([...r1, late], [["M", "app.ts"]])).toEqual([
      "finding 'F3' is high and new since your review of round 1, but 'cache.ts' did not change since then: if you reported it before in other " +
      "words, give it that finding's id (F1, F2); if it is new, say in 'late_reason' why it was not reported then",
    ]);
    // Explained, on a file that changed, below a blocking severity, out of scope, or when git cannot tell: nothing to ask.
    expect(check([{ ...late, late_reason: "round 1 did not read cache.ts, which the change now calls" }], [])).toEqual([]);
    expect(check([late], [["M", "cache.ts"]])).toEqual([]);
    expect(check([{ ...late, severity: "medium" }], [])).toEqual([]);
    expect(check([{ ...late, origin: "out_of_scope" }], [])).toEqual([]);
    expect(check([late], null)).toEqual([]);
    // Raised before, in other words: not new.
    expect(check([about("F9", "a null input crashes parse()")], [])).toEqual([]);
    // No earlier review: everything is new.
    expect(lateFindingErrors({ review: review(false, [late]), ledger: [], since: null, blockingSeverities: ["high"], workspace: ws })).toEqual([]);
  });
});
