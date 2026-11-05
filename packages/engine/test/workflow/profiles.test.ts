import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/config/config.js";
import {
  escalate, LIGHTWEIGHT, newProfile, planTooLarge, POLICIES, profileChangeLines, profileOf, profileText, reviewsOnGateFailure, signsOff, unplannedFiles,
} from "../../src/workflow/profiles.js";
import { newState } from "../../src/workflow/state.js";
import { plan } from "../helpers/builders.js";

describe("profiles: the policies", () => {
  it("leaves the sign-off out of lightweight, keeps standard as configured, and always signs off in thorough", () => {
    const cfg = defaultConfig();
    expect([signsOff("lightweight", cfg), signsOff("standard", cfg), signsOff("thorough", cfg)]).toEqual([false, true, true]);
    cfg.quality_gates.require_plan_approval = false;
    expect([signsOff("lightweight", cfg), signsOff("standard", cfg), signsOff("thorough", cfg)]).toEqual([false, false, true]);
    expect([reviewsOnGateFailure("lightweight", cfg), reviewsOnGateFailure("standard", cfg), reviewsOnGateFailure("thorough", cfg)]).toEqual([false, false, true]);
    cfg.quality_gates.review_on_gate_failure = true;
    expect(reviewsOnGateFailure("lightweight", cfg)).toBe(true);
    // Only lightweight moves up on its own; nothing ever moves down.
    expect(Object.values(POLICIES).map((p) => p.escalatesTo)).toEqual(["standard", null, null]);
  });

  it("takes an older run's profile, which it never recorded, for standard", () => {
    const st = newState("r", "t", { max_planning_rounds: 4, max_review_rounds: 5 });
    expect([profileOf(st), profileText(undefined)]).toEqual(["standard", "standard"]);
    st.profile = newProfile("thorough");
    expect(profileOf(st)).toBe("thorough");
  });
});

describe("profiles: escalation", () => {
  it("moves lightweight to standard once, recording why, and leaves standard and thorough as they are", () => {
    const p = newProfile("lightweight");
    const at = { phase: "PLAN_REVIEW" as const, round: 1, at: "now" };
    expect(escalate(p, { signal: "plan_blocking", reason: "the critic blocks on C1", ...at })).toMatchObject({ from: "lightweight", to: "standard" });
    expect(escalate(p, { signal: "gates_failing", reason: "again", ...at })).toBeNull();
    expect(p).toMatchObject({ initial: "lightweight", name: "standard", changes: [{ signal: "plan_blocking" }] });
    expect(profileText(p)).toBe("standard (from lightweight)");
    expect(profileChangeLines(p)).toEqual(["lightweight → standard at PLAN_REVIEW round 1 (plan_blocking): the critic blocks on C1"]);
    for (const name of ["standard", "thorough"] as const) {
      const q = newProfile(name);
      expect(escalate(q, { signal: "review_rounds", reason: "x", ...at })).toBeNull();
      expect(q.changes).toEqual([]);
    }
  });

  it("tells a plan larger than a lightweight task by its steps or its files", () => {
    const step = (i: number, files: string[]) => ({ id: `S${i}`, description: "d", files });
    expect(planTooLarge(plan())).toBeNull();
    expect(planTooLarge(plan("P", { steps: Array.from({ length: LIGHTWEIGHT.maxSteps + 1 }, (_, i) => step(i, ["a.ts"])) })))
      .toBe("the plan has 7 steps (a lightweight task has at most 6)");
    const files = Array.from({ length: 9 }, (_, i) => `src/f${i}.ts`);
    expect(planTooLarge(plan("P", { steps: [step(1, files.slice(0, 5)), step(2, [...files.slice(4), "./src/f0.ts"])] })))
      .toBe("the plan changes 9 files (a lightweight task changes at most 8)");
  });

  it("names the files an implementation changed outside every file and folder the plan names", () => {
    const p = plan("P", { steps: [{ id: "S1", description: "d", files: ["app.txt", "src/lib/"] }] });
    const changes: Array<[string, string]> = [["M", "app.txt"], ["A", "src/lib/x.ts"], ["A", "src/other.ts"], ["D", "README.md"]];
    expect(unplannedFiles(p, changes, "/repo")).toEqual(["src/other.ts", "README.md"]);
    // A plan that names no file gives nothing to compare with.
    expect(unplannedFiles(plan("P", { steps: [{ id: "S1", description: "d", files: [] }] }), changes, "/repo")).toEqual([]);
  });
});
