import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TEAM_DEFAULTS, teamMembers, type TeamConfig } from "../../src/team/config.js";
import { LEVEL_IDENTITIES, ROLE_IDENTITIES, KIND_IDENTITIES } from "../../src/team/defaults.js";
import {
  identityDirs, identityPath, memberIdentity, readIdentity, resetIdentity, teamIdentities, teamInfo, writeDefaultIdentities, writeIdentity,
} from "../../src/team/identity.js";
import { userConfigEnv } from "../helpers/config.js";
import { tempDir } from "../helpers/tmp.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function makeTmp(): string {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return t.path;
}

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

describe("team identities", () => {
  it("are the built-in role and level texts when nobody wrote a file", () => {
    const tmp = makeTmp();
    const dirs = identityDirs(join(tmp, "ws"), userConfigEnv(join(tmp, "cfg")));
    const ids = teamIdentities(TEAM_DEFAULTS, teamMembers(TEAM_DEFAULTS), dirs);
    expect(ids.roles.dev).toEqual({ text: ROLE_IDENTITIES.dev!.text, sources: ["default"] });
    expect(ids.levels.senior).toEqual({ text: LEVEL_IDENTITIES.senior, sources: ["default"] });
    expect(ids.agents["dev-1"]).toEqual({ text: "", sources: [] });
    expect(ids.warnings).toEqual([]);
  });

  it("are the project's file, else the user config's, else agentduo's: each file is the whole text", () => {
    const tmp = makeTmp();
    const env = userConfigEnv(join(tmp, "cfg"));
    const dirs = identityDirs(join(tmp, "ws"), env);
    write(identityPath(dirs.global!, "role", "dev"), "Prefer small commits of thought.");
    write(identityPath(dirs.global!, "role", "qa"), "Every project: property-based tests.");
    write(identityPath(dirs.project!, "role", "qa"), "This project: snapshot tests.");
    write(identityPath(dirs.project!, "level", "mid"), "---\nreplace: true\n---\nAsk the techlead before every edit.\n");
    write(identityPath(dirs.project!, "agent", "dev-2"), "You own the billing module.");
    const ids = teamIdentities(TEAM_DEFAULTS, teamMembers(TEAM_DEFAULTS), dirs);
    expect(ids.roles.dev).toEqual({ text: "Prefer small commits of thought.", sources: [identityPath(dirs.global!, "role", "dev")] });
    expect(ids.roles.qa!.text).toBe("This project: snapshot tests.");
    expect(ids.roles.pm).toEqual({ text: ROLE_IDENTITIES.pm!.text, sources: ["default"] });
    expect(ids.levels.mid).toEqual({ text: "Ask the techlead before every edit.", sources: [identityPath(dirs.project!, "level", "mid")] });
    expect(ids.agents["dev-2"]!.text).toBe("You own the billing module.");
  });

  it("are read for editing as the whole text they fall back to, saved, and reset to it", () => {
    const tmp = makeTmp();
    const dirs = identityDirs(join(tmp, "ws"), userConfigEnv(join(tmp, "cfg")));
    expect(readIdentity(TEAM_DEFAULTS, dirs, "project", "role", "dev")).toEqual({ text: ROLE_IDENTITIES.dev!.text, source: "default" });
    expect(readIdentity(TEAM_DEFAULTS, dirs, "global", "agent", "dev-1")).toEqual({ text: "", source: "none" });
    writeIdentity(dirs, "global", "role", "dev", `${ROLE_IDENTITIES.dev!.text}\n\nUse pnpm.`);
    expect(readIdentity(TEAM_DEFAULTS, dirs, "project", "role", "dev")).toEqual({ text: `${ROLE_IDENTITIES.dev!.text}\n\nUse pnpm.`, source: "global" });
    writeIdentity(dirs, "project", "role", "dev", "Only this project.");
    expect(readIdentity(TEAM_DEFAULTS, dirs, "project", "role", "dev").source).toBe("project");
    resetIdentity(dirs, "project", "role", "dev");
    expect(readIdentity(TEAM_DEFAULTS, dirs, "project", "role", "dev").source).toBe("global");
    resetIdentity(dirs, "global", "role", "dev");
    expect(readIdentity(TEAM_DEFAULTS, dirs, "project", "role", "dev").source).toBe("default");
  });

  it("can be written into the project with agentduo's text, each file kept once it is there", () => {
    const tmp = makeTmp();
    const dirs = identityDirs(join(tmp, "ws"), userConfigEnv(join(tmp, "cfg")));
    write(identityPath(dirs.project!, "role", "qa"), "mine");
    const written = writeDefaultIdentities(TEAM_DEFAULTS, teamMembers(TEAM_DEFAULTS), dirs);
    expect(written.map((p) => p.slice(dirs.project!.length + 1)).sort()).toEqual([
      join("levels", "mid", "IDENTITY.md"), join("levels", "senior", "IDENTITY.md"), join("roles", "dev", "IDENTITY.md"),
      join("roles", "pm", "IDENTITY.md"), join("roles", "techlead", "IDENTITY.md"),
    ].sort());
    expect(readFileSync(identityPath(dirs.project!, "role", "dev"), "utf8")).toBe(`${ROLE_IDENTITIES.dev!.text}\n`);
    expect(readFileSync(identityPath(dirs.project!, "role", "qa"), "utf8")).toBe("mine");
  });

  it("give a role of the user's own its kind's text and a warning, unless it has a file", () => {
    const tmp = makeTmp();
    const dirs = identityDirs(join(tmp, "ws"), userConfigEnv(join(tmp, "cfg")));
    const team: TeamConfig = {
      ...structuredClone(TEAM_DEFAULTS),
      levels: { ...TEAM_DEFAULTS.levels, staff: { can_review: true } },
      roles: { ...TEAM_DEFAULTS.roles, security: { kind: "checker" }, "frontend-dev": { kind: "worker" } },
      members: [
        ...TEAM_DEFAULTS.members,
        { role: "security", level: "staff", cli: "claude" },
        { role: "frontend-dev", level: "mid", cli: "claude" },
      ],
    };
    write(identityPath(dirs.project!, "role", "frontend-dev"), "You build the React front end.");
    const ids = teamIdentities(team, teamMembers(team), dirs);
    expect(ids.roles.security).toEqual({ text: KIND_IDENTITIES.checker, sources: ["default"] });
    expect(ids.roles["frontend-dev"]!.text).toBe("You build the React front end.");
    expect(ids.levels.staff).toEqual({ text: "", sources: [] });
    expect(ids.warnings).toEqual([
      expect.stringContaining("role 'security' has no IDENTITY.md"),
      expect.stringContaining("level 'staff' has no IDENTITY.md"),
    ]);
  });

  it("use a role's built-in text only for the kind it was written for", () => {
    const tmp = makeTmp();
    const dirs = identityDirs(join(tmp, "ws"), userConfigEnv(join(tmp, "cfg")));
    const team: TeamConfig = { ...structuredClone(TEAM_DEFAULTS), roles: { ...TEAM_DEFAULTS.roles, qa: { kind: "worker" }, tester: { kind: "checker" } } };
    team.members = [...team.members.filter((m) => m.role !== "qa"), { role: "tester", level: "mid", cli: "claude" }];
    const ids = teamIdentities(team, teamMembers(team), dirs);
    expect(ids.roles.qa).toBeUndefined();
    expect(ids.roles.tester!.text).toBe(KIND_IDENTITIES.checker);
  });

  it("make a member's prompt section: role, level, then its own notes", () => {
    const tmp = makeTmp();
    const dirs = identityDirs(join(tmp, "ws"), userConfigEnv(join(tmp, "cfg")));
    write(identityPath(dirs.project!, "agent", "dev-1"), "You know the payments code best.");
    const members = teamMembers(TEAM_DEFAULTS);
    const ids = teamIdentities(TEAM_DEFAULTS, members, dirs);
    const text = memberIdentity(ids, members.find((m) => m.name === "dev-1")!);
    expect(text).toContain("## Your role: dev\n");
    expect(text).toContain(ROLE_IDENTITIES.dev!.text);
    expect(text).toContain("## Your level: senior\n");
    expect(text).toContain("## Notes for you (dev-1)\nYou know the payments code best.");
    expect(text.indexOf("## Your role")).toBeLessThan(text.indexOf("## Your level"));
    expect(memberIdentity(ids, members.find((m) => m.name === "dev-2")!)).not.toContain("## Notes for you");
  });

  it("warn about front matter they cannot read, and use the file as text", () => {
    const tmp = makeTmp();
    const dirs = identityDirs(join(tmp, "ws"), userConfigEnv(join(tmp, "cfg")));
    write(identityPath(dirs.project!, "role", "pm"), "---\nreplace: [\n---\nAlways answer in Vietnamese.");
    const ids = teamIdentities(TEAM_DEFAULTS, teamMembers(TEAM_DEFAULTS), dirs);
    expect(ids.roles.pm!.text).toBe("Always answer in Vietnamese.");
    expect(ids.warnings).toEqual([expect.stringContaining("front matter")]);
  });

  it("leave HTML comments out of the prompt, and a front matter block", () => {
    const tmp = makeTmp();
    const dirs = identityDirs(join(tmp, "ws"), userConfigEnv(join(tmp, "cfg")));
    write(identityPath(dirs.project!, "role", "qa"), "<!-- a note for whoever edits this -->\n---\nreplace: true\n---\nOnly property-based tests.");
    const ids = teamIdentities(TEAM_DEFAULTS, teamMembers(TEAM_DEFAULTS), dirs);
    expect(ids.roles.qa!.text).toBe("Only property-based tests.");
  });

  it("describe the team and the files Settings can open for it", () => {
    const tmp = makeTmp();
    const dirs = identityDirs(join(tmp, "ws"), userConfigEnv(join(tmp, "cfg")));
    write(identityPath(dirs.global!, "level", "senior"), "x");
    const info = teamInfo(TEAM_DEFAULTS, dirs);
    expect(info.errors).toEqual([]);
    expect(info.members.map((m) => m.name)).toEqual(["pm", "techlead", "dev-1", "dev-2", "qa-1"]);
    const senior = info.identities.find((i) => i.kind === "level" && i.name === "senior")!;
    expect(senior).toMatchObject({ builtIn: true, global: { exists: true }, project: { exists: false } });
    expect(info.identities.find((i) => i.kind === "agent" && i.name === "dev-1")).toMatchObject({ builtIn: false });
    expect(teamInfo({ ...structuredClone(TEAM_DEFAULTS), members: [] }, dirs).errors.length).toBeGreaterThan(0);
  });
});
