// What a team prompt says about the team (packages/engine/src/team/prompts.ts `roster`): every member, and what each
// role the configuration describes does, so the techlead can give a role the work it is for.
import { describe, expect, it } from "vitest";
import { TEAM_DEFAULTS, teamMembers, type TeamConfig } from "../../src/team/config.js";
import { planPrompt, roster } from "../../src/team/prompts.js";
import { newTeamState, type Brief } from "../../src/team/state.js";
import { brief as briefOutput } from "../helpers/team-builders.js";

const DESIGNER = "Designs and builds the UI: layout, styles, components, accessibility.";
const withDesigner = (description: string | null = DESIGNER): TeamConfig => ({
  ...structuredClone(TEAM_DEFAULTS),
  roles: { ...TEAM_DEFAULTS.roles, designer: { kind: "worker", ...(description ? { description } : {}) } },
  members: [...TEAM_DEFAULTS.members, { role: "designer", level: "mid", cli: "claude", count: 2 }],
});
const brief: Brief = { version: 1, ...briefOutput() };

const plan = (team: TeamConfig) => {
  const members = teamMembers(team);
  const s = newTeamState("run-1", "Redo the settings page");
  s.briefs = [brief];
  s.approvedBrief = 1;
  return planPrompt({
    member: members.find((m) => m.kind === "lead")!, members, state: s, identity: "IDENTITY", brief, feedback: null, previous: null, existing: [],
    additions: false, area: null, group: null,
  });
};

describe("the team in a prompt", () => {
  it("says once what each described role does, after its members", () => {
    const text = roster(teamMembers(withDesigner()));
    expect(text).toContain("- designer-1: designer (takes tasks), level mid, on Claude\n- designer-2: designer (takes tasks), level mid, on Claude\n");
    expect(text.endsWith(`\nWhat the roles do:\n- designer: ${DESIGNER}`)).toBe(true);
    expect(text.split(DESIGNER)).toHaveLength(2);
  });

  it("says nothing more for a team whose roles are not described, as before", () => {
    const text = roster(teamMembers(TEAM_DEFAULTS));
    expect(text).not.toContain("What the roles do");
    expect(roster(teamMembers(withDesigner(null)))).not.toContain("What the roles do");
  });

  it("lists only the roles of the members it shows", () => {
    const team = withDesigner();
    team.roles.security = { kind: "checker", description: "Looks for security holes." };
    expect(roster(teamMembers(team))).not.toContain("security");
  });

  it("tells the techlead to assign by role too when a role that takes tasks is described", () => {
    expect(plan(withDesigner())).toContain("Assign by level, and by role: give a role the work its description says it does.");
    expect(plan(withDesigner())).toContain(`- designer: ${DESIGNER}`);
    expect(plan(TEAM_DEFAULTS)).toContain("Assign by level. ");
    expect(plan(TEAM_DEFAULTS)).not.toContain("by role");
  });
});
