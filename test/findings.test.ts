import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileChange, recordResponses, reviewFindings, setFindings, unanswered } from "../src/core/findings.js";
import { newState } from "../src/core/state.js";
import { finding, impl } from "./helpers/builders.js";

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
