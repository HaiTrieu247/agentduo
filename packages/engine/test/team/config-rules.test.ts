import { describe, expect, it } from "vitest";
import { configErrors, configFromLayers, defaultConfig } from "../../src/config/config.js";
import { TEAM_DEFAULTS, teamConfigErrors } from "../../src/team/config.js";

describe("team.id for persistent rules (AC1)", () => {
  it("keeps old configurations valid when the optional id is absent", () => {
    const legacy = structuredClone(TEAM_DEFAULTS);
    delete legacy.id;
    expect(teamConfigErrors(legacy)).toEqual([]);
    expect(configErrors(configFromLayers([{ team: legacy }]))).toEqual([]);
    expect(teamConfigErrors(defaultConfig().team)).toEqual([]);
  });

  it.each(["a", "0", "default", "payments-api_v2", "a".repeat(40)])("accepts the existing name convention: %s", (id) => {
    const cfg = configFromLayers([{ team: { id } }]);
    expect(cfg.team.id).toBe(id);
    expect(teamConfigErrors({ ...structuredClone(TEAM_DEFAULTS), id })).toEqual([]);
    expect(configErrors(cfg)).toEqual([]);
  });

  it.each([
    "", " ", "Team", "-team", "_team", "a".repeat(41), "../other", "a/b", "a\\b", ".", "..", "a.b", "a\n", null, 1, true, [], {},
  ].map((id) => [id] as const))("rejects an invalid explicit team id: %j", (id) => {
    const raw = { ...structuredClone(TEAM_DEFAULTS), id };
    expect(teamConfigErrors(raw)).toEqual(expect.arrayContaining([expect.stringContaining("team.id")]));
    expect(configErrors(configFromLayers([{ team: { id } }]))).toEqual(expect.arrayContaining([expect.stringContaining("team.id")]));
  });

  it("uses the last explicit id, retaining it when later layers change models or membership", () => {
    const cfg = configFromLayers([
      { team: { id: "platform" } },
      { team: { id: "payments" } },
      { team: {
        levels: { senior: { codex: { model: "custom-model" } } },
        members: TEAM_DEFAULTS.members.map((m, i) => i === 2 ? { ...m, name: "api-dev", model: "haiku" } : m),
      } },
    ]);
    expect(cfg.team.id).toBe("payments");
    expect(configErrors(cfg)).toEqual([]);
    expect(cfg.team.members[2]!.name).toBe("api-dev");
    expect(cfg.team.levels.senior!.codex!.model).toBe("custom-model");
  });
});
