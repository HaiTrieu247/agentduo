import { describe, expect, it } from "vitest";
import { pipelineOf } from "../extensions/vscode/src/runtimeSession.js";
import { defaultConfig, type ConfigData } from "../src/core/config.js";

const phases = (cfg: ConfigData) => pipelineOf(cfg).map((p) => p.phase);

describe("extension: the pipeline a config sets up", () => {
  it("shows the plan sign-off as each profile runs it: never in lightweight, as configured in standard, always in thorough", () => {
    const cfg = defaultConfig();
    expect(phases(cfg)).toEqual(["PLAN", "PLAN_REVIEW", "PLAN_FINALIZE", "IMPLEMENT", "CODE_REVIEW"]);
    cfg.pipeline.profile = "lightweight";
    expect(phases(cfg)).toEqual(["PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW"]);
    cfg.quality_gates.require_plan_approval = false;
    cfg.pipeline.profile = "thorough";
    expect(phases(cfg)).toContain("PLAN_FINALIZE");
    cfg.pipeline.profile = "standard";
    expect(phases(cfg)).not.toContain("PLAN_FINALIZE");
    // A config written before profiles has none: standard.
    const older = { ...defaultConfig(), pipeline: undefined } as unknown as ConfigData;
    expect(phases(older)).toContain("PLAN_FINALIZE");
  });
});
