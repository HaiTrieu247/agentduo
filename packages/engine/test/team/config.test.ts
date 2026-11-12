import { describe, expect, it } from "vitest";
import { configErrors, configFromLayers, defaultConfig } from "../../src/config/config.js";
import { headPm, memberNames, memberProfile, TEAM_DEFAULTS, teamConfigErrors, teamGroups, teamMembers, type TeamConfig } from "../../src/team/config.js";

const team = (over: Partial<TeamConfig> = {}): TeamConfig => ({ ...structuredClone(TEAM_DEFAULTS), ...over });

describe("team config", () => {
  it("has a default team: a PM and a techlead on Codex, two devs and a tester on Claude", () => {
    expect(teamConfigErrors(TEAM_DEFAULTS)).toEqual([]);
    expect(teamMembers(TEAM_DEFAULTS).map((m) => [m.name, m.role, m.kind, m.level, m.backend])).toEqual([
      ["pm", "pm", "pm", "senior", "codex"],
      ["techlead", "techlead", "lead", "senior", "codex"],
      ["dev-1", "dev", "worker", "senior", "claude"],
      ["dev-2", "dev", "worker", "mid", "claude"],
      ["qa-1", "qa", "checker", "mid", "claude"],
    ]);
    expect(defaultConfig().team).toEqual(TEAM_DEFAULTS);
  });

  it("names members by role, numbering each role across entries, and keeps an explicit name", () => {
    const members = teamMembers(team({
      members: [
        { role: "pm", level: "senior", cli: "codex" },
        { role: "techlead", level: "senior", cli: "codex" },
        { role: "dev", level: "senior", cli: "claude" },
        { role: "dev", level: "junior", cli: "claude", count: 2 },
        { role: "dev", level: "mid", cli: "codex", name: "api-dev" },
        { role: "qa", level: "mid", cli: "claude", count: 2 },
      ],
    }));
    expect(members.map((m) => m.name)).toEqual(["pm", "techlead", "dev-1", "dev-2", "dev-3", "api-dev", "qa-1", "qa-2"]);
  });

  it("gives each entry's names as a run makes them, also for a team that cannot start yet (Settings' list and preview)", () => {
    const roles = { ...TEAM_DEFAULTS.roles, designer: { kind: "worker" as const } };
    expect(memberNames({ roles, members: [
      { role: "dev", level: "mid", cli: "claude", count: 2, group: "web" },
      { role: "techlead", level: "senior", cli: "codex", group: "web" },
      { role: "designer", level: "mid", cli: "claude" },
      { role: "dev", level: "mid", cli: "claude", group: "web" },
    ] })).toEqual([["dev-web-1", "dev-web-2"], ["techlead-web"], ["designer-1"], ["dev-web-3"]]);
  });

  it("ranks levels in the order the config lists them, and says which can review", () => {
    const members = teamMembers(TEAM_DEFAULTS);
    const rank = Object.fromEntries(members.map((m) => [m.name, m.levelRank]));
    expect(rank["dev-1"]).toBeGreaterThan(rank["dev-2"]!);
    expect(members.find((m) => m.name === "dev-1")!.canReview).toBe(true);
    expect(members.find((m) => m.name === "dev-2")!.canReview).toBe(false);
  });

  it("takes a member's model and effort over its level's, its args after the CLI's own", () => {
    const cfg = team({
      members: [
        ...TEAM_DEFAULTS.members,
        { role: "dev", level: "junior", cli: "claude", name: "fast", model: "haiku", effort: "max", args: ["--verbose"] },
      ],
    });
    const fast = teamMembers(cfg).find((m) => m.name === "fast")!;
    expect(memberProfile(fast)).toEqual({ model: "haiku", effort: "max", args: ["--verbose"] });
    const dev1 = teamMembers(cfg).find((m) => m.name === "dev-1")!;
    expect(memberProfile(dev1)).toEqual({ model: "opus", effort: "high", args: [] });
    const pm = teamMembers(cfg).find((m) => m.name === "pm")!;
    // Codex's levels name no model: the CLI's own configuration decides.
    expect(memberProfile(pm)).toEqual({ model: null, effort: "high", args: [] });
  });

  it("refuses a team without exactly one PM and one techlead, or without a worker and a checker", () => {
    const errors = teamConfigErrors(team({ members: [{ role: "dev", level: "mid", cli: "claude" }] }));
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("exactly one member whose role is of kind pm"),
      expect.stringContaining("exactly one member whose role is of kind lead"),
      expect.stringContaining("at least one member whose role is of kind checker"),
    ]));
    const two = teamConfigErrors(team({ members: [...TEAM_DEFAULTS.members, { role: "pm", level: "mid", cli: "claude", name: "pm2" }] }));
    expect(two).toEqual([expect.stringContaining("exactly one member whose role is of kind pm (found 2: pm, pm2)")]);
  });

  it("refuses unknown roles, levels, CLIs, efforts, duplicate names and unsafe names", () => {
    const errors = teamConfigErrors(team({
      members: [
        ...TEAM_DEFAULTS.members,
        { role: "designer", level: "mid", cli: "claude" },
        { role: "dev", level: "staff", cli: "claude" },
        { role: "dev", level: "mid", cli: "gemini" as never },
        { role: "dev", level: "mid", cli: "claude", effort: "turbo" },
        { role: "dev", level: "mid", cli: "claude", name: "dev-1" },
        { role: "dev", level: "mid", cli: "claude", name: "../x" },
        { role: "dev", level: "mid", cli: "claude", name: "solo", count: 2 },
      ],
    }));
    expect(errors).toEqual(expect.arrayContaining([
      "team.members[5].role: unknown role 'designer' (roles: pm, techlead, dev, qa)",
      "team.members[6].level: unknown level 'staff' (levels: junior, mid, senior)",
      "team.members[7].cli must be one of codex, claude",
      expect.stringContaining("team.members[8].effort must be one of low"),
      "team.members[9]: duplicate member name 'dev-1'",
      expect.stringContaining("team.members[10].name"),
      "team.members[11]: a member with a name has count 1",
    ]));
  });

  it("checks levels, roles, limits and worktree settings", () => {
    const errors = teamConfigErrors({
      ...structuredClone(TEAM_DEFAULTS),
      levels: { mid: { can_review: "yes", claude: { model: "bad model" }, codex: {}, extra: 1 } },
      roles: { ...TEAM_DEFAULTS.roles, writer: { kind: "author" } },
      max_parallel: 0,
      limits: { max_review_rounds: 0, max_task_attempts: 2 },
      worktree: { setup: "npm ci", link: ["../outside"] },
    } as unknown as TeamConfig);
    expect(errors).toEqual(expect.arrayContaining([
      "team.levels.mid.can_review must be true or false",
      "team.levels.mid.claude.model must be a model name or null",
      "team.levels.mid: unknown keys extra",
      "team.roles.writer.kind must be one of pm, lead, worker, checker",
      "team.max_parallel must be a positive integer",
      "team.limits.max_review_rounds must be a positive integer",
      "team.worktree.setup must be a list of strings",
      "team.worktree.link[0] must be a relative path inside the workspace",
    ]));
  });

  it("is part of the configuration: errors are config errors, and a project's levels and roles add to the defaults", () => {
    const cfg = configFromLayers([{ team: { levels: { staff: { can_review: true } }, roles: { security: { kind: "checker" } } } }]);
    expect(Object.keys(cfg.team.levels)).toEqual(["junior", "mid", "senior", "staff"]);
    expect(cfg.team.levels.staff).toEqual({ can_review: true });
    expect(configErrors(cfg)).toEqual([]);
    expect(cfg.team.roles.security).toEqual({ kind: "checker" });
    // A level the project changes in part keeps what it does not say.
    const senior = configFromLayers([{ team: { levels: { senior: { can_review: false } } } }]);
    expect(senior.team.levels.senior).toEqual({ ...TEAM_DEFAULTS.levels.senior, can_review: false });
    const broken = defaultConfig();
    broken.team.max_parallel = -1;
    expect(configErrors(broken)).toContain("team.max_parallel must be a positive integer");
  });

  const grouped = (): TeamConfig => team({
    members: [
      { role: "pm", level: "senior", cli: "codex" },
      { role: "techlead", level: "senior", cli: "codex", group: "frontend" },
      { role: "dev", level: "mid", cli: "claude", count: 2, group: "frontend" },
      { role: "qa", level: "mid", cli: "claude", group: "frontend" },
      { role: "pm", level: "mid", cli: "codex", group: "backend" },
      { role: "techlead", level: "senior", cli: "codex", group: "backend" },
      { role: "dev", level: "senior", cli: "claude", group: "backend" },
      { role: "qa", level: "mid", cli: "claude", group: "backend" },
    ],
  });

  it("splits a team into groups, each with its techlead, members and maybe a PM of its own, under one head PM", () => {
    expect(teamConfigErrors(grouped())).toEqual([]);
    const members = teamMembers(grouped());
    expect(members.map((m) => m.name)).toEqual([
      "pm", "techlead-frontend", "dev-frontend-1", "dev-frontend-2", "qa-frontend-1", "pm-backend", "techlead-backend", "dev-backend-1", "qa-backend-1",
    ]);
    expect(headPm(members).name).toBe("pm");
    const groups = teamGroups(members);
    expect(groups.map((g) => [g.name, g.lead.name, g.pm?.name ?? null, g.members.length])).toEqual([
      ["frontend", "techlead-frontend", null, 4], ["backend", "techlead-backend", "pm-backend", 4],
    ]);
    // A team without groups is one group.
    expect(teamGroups(teamMembers(TEAM_DEFAULTS)).map((g) => [g.name, g.lead.name, g.pm])).toEqual([[null, "techlead", null]]);
  });

  it("refuses a group without its techlead, tester or worker, two PMs in a group, no head PM, or a member in no group", () => {
    const cfg = grouped();
    cfg.members = [
      { role: "pm", level: "senior", cli: "codex", group: "frontend" },
      { role: "pm", level: "senior", cli: "codex", group: "frontend", name: "pm2" },
      { role: "dev", level: "mid", cli: "claude", group: "frontend" },
      { role: "techlead", level: "senior", cli: "codex", group: "backend" },
      { role: "techlead", level: "senior", cli: "codex", group: "backend", name: "tl2" },
      { role: "qa", level: "mid", cli: "claude" },
      { role: "dev", level: "mid", cli: "claude", group: "Bad Group" },
    ];
    expect(teamConfigErrors(cfg)).toEqual(expect.arrayContaining([
      expect.stringContaining("exactly one member whose role is of kind pm and who is in no group (the head PM)"),
      "group 'frontend' must have exactly one techlead (a member whose role is of kind lead)",
      "group 'frontend' has at most one PM of its own (found pm-frontend, pm2)",
      "group 'frontend' must have at least one member whose role is of kind checker",
      "group 'backend' must have exactly one techlead (a member whose role is of kind lead) (found techlead-backend, tl2)",
      "group 'backend' must have at least one member whose role is of kind worker",
      expect.stringContaining("every member but the head PM is in a group (not in one: qa-1, dev-1)"),
      expect.stringContaining("team.members[6].group"),
    ]));
  });
});
