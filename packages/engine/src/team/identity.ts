// A team member's identity: its role's IDENTITY.md, its level's, and its own AGENT.md. Each is one text: the project's
// file (.agentduo/team/…) if there is one, else the user config's (team/… beside config.yaml), else agentduo's own
// (packages/engine/src/team/defaults.ts). A file is the whole text: it starts as agentduo's, and you add to it or rewrite it.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { userConfigPath } from "../config/config.js";
import { teamConfigErrors, teamMembers, type Member, type TeamConfig } from "./config.js";
import type { TeamIdentityFile, TeamInfo } from "./model.js";
import { KIND_IDENTITIES, LEVEL_IDENTITIES, ROLE_IDENTITIES } from "./defaults.js";

/** Where the user's identity files are: the user config's `team/` (every project), and the project's `.agentduo/team/`. */
export interface IdentityDirs {
  global: string | null;
  project: string | null;
}

export type IdentityKind = "role" | "level" | "agent";

/** One identity as its layers make it; `sources`: "default" and each file used, in order (empty: none at all). */
export interface Identity {
  text: string;
  sources: string[];
}

/** A team's identities, fixed when a run starts (it keeps this copy). */
export interface TeamIdentities {
  roles: Record<string, Identity>;
  levels: Record<string, Identity>;
  agents: Record<string, Identity>;
  warnings: string[];
}

export function identityDirs(workspace: string | null, env: NodeJS.ProcessEnv = process.env): IdentityDirs {
  return { global: join(dirname(userConfigPath(env)), "team"), project: workspace ? join(workspace, ".agentduo", "team") : null };
}

const FOLDERS: Record<IdentityKind, string> = { role: "roles", level: "levels", agent: "agents" };
const FILES: Record<IdentityKind, string> = { role: "IDENTITY.md", level: "IDENTITY.md", agent: "AGENT.md" };

export const identityPath = (dir: string, kind: IdentityKind, name: string): string => join(dir, FOLDERS[kind], name, FILES[kind]);

/** A file's text, without its front matter (older files' `replace: true`, which every file now means) and HTML comments. */
function parseFile(path: string, warnings: string[]): { text: string; replace: boolean } {
  // HTML comments are notes for whoever edits the file (the template's), never part of the prompt.
  const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "").trimStart();
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!m) return { text: raw.trim(), replace: false };
  let meta: unknown;
  try {
    meta = YAML.parse(m[1]!);
  } catch (e) {
    warnings.push(`${path}: its front matter is not valid YAML (${(e as Error).message.split("\n")[0]}), so the whole file is taken as text`);
    return { text: raw.slice(m[0].length).trim(), replace: false };
  }
  const replace = typeof meta === "object" && meta !== null && (meta as Record<string, unknown>).replace === true;
  return { text: raw.slice(m[0].length).trim(), replace };
}

/** The text that holds: the project's file, else the user config's, else the built-in one. */
function layered(kind: IdentityKind, name: string, dirs: IdentityDirs, builtIn: string | null, warnings: string[]): Identity {
  for (const dir of [dirs.project, dirs.global]) {
    if (!dir) continue;
    const path = identityPath(dir, kind, name);
    if (existsSync(path)) return { text: parseFile(path, warnings).text, sources: [path] };
  }
  return builtIn !== null ? { text: builtIn, sources: ["default"] } : { text: "", sources: [] };
}

/** agentduo's own text of an identity (a role of the user's own: its kind's), or "" when it has none (a member, a level of the user's own). */
export function builtInIdentity(team: TeamConfig, kind: IdentityKind, name: string): string {
  if (kind === "role") {
    const roleKind = team.roles[name]?.kind;
    if (!roleKind) return "";
    const own = ROLE_IDENTITIES[name];
    return own && own.kind === roleKind ? own.text : KIND_IDENTITIES[roleKind];
  }
  return kind === "level" ? LEVEL_IDENTITIES[name] ?? "" : "";
}

/** Where an identity's text comes from for a scope: the project's file, the user config's, agentduo's, or nothing. */
export type IdentitySource = "project" | "global" | "default" | "none";

/**
 * What an identity says as Settings edits it in `scope`: the project's file there (else what it falls back to), or the
 * user config's (else agentduo's). Editing starts from it: it is the whole text you change.
 */
export function readIdentity(team: TeamConfig, dirs: IdentityDirs, scope: "global" | "project", kind: IdentityKind, name: string): { text: string; source: IdentitySource } {
  const warnings: string[] = [];
  const order: Array<["project" | "global", string | null]> = scope === "project" ? [["project", dirs.project], ["global", dirs.global]] : [["global", dirs.global]];
  for (const [where, dir] of order) {
    if (!dir) continue;
    const path = identityPath(dir, kind, name);
    if (existsSync(path)) return { text: parseFile(path, warnings).text, source: where };
  }
  const builtIn = builtInIdentity(team, kind, name);
  return { text: builtIn, source: builtIn ? "default" : "none" };
}

/** Saves an identity's whole text in `scope` (the file is created when there is none). */
export function writeIdentity(dirs: IdentityDirs, scope: "global" | "project", kind: IdentityKind, name: string, text: string): string {
  const dir = dirs[scope];
  if (!dir) throw new Error("no project is open");
  const path = identityPath(dir, kind, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${text.trim()}\n`);
  return path;
}

/** Removes an identity's file in `scope`: what it falls back to holds again (agentduo's text, or the user config's). */
export function resetIdentity(dirs: IdentityDirs, scope: "global" | "project", kind: IdentityKind, name: string): void {
  const dir = dirs[scope];
  if (!dir) throw new Error("no project is open");
  rmSync(identityPath(dir, kind, name), { force: true });
}

/**
 * Writes agentduo's text of every role and level the team uses into `scope` (the project's .agentduo/team by default),
 * where there is no file yet, so each IDENTITY.md is there to read and edit. Returns the files written.
 */
export function writeDefaultIdentities(team: TeamConfig, members: Member[], dirs: IdentityDirs, scope: "global" | "project" = "project"): string[] {
  const written: string[] = [];
  const dir = dirs[scope];
  if (!dir) throw new Error("no project is open");
  const wanted: Array<[IdentityKind, string]> = [
    ...[...new Set(members.map((m) => m.role))].map((r): [IdentityKind, string] => ["role", r]),
    ...[...new Set(members.map((m) => m.level))].map((l): [IdentityKind, string] => ["level", l]),
  ];
  for (const [kind, name] of wanted) {
    const text = builtInIdentity(team, kind, name);
    if (!text || existsSync(identityPath(dir, kind, name))) continue;
    written.push(writeIdentity(dirs, scope, kind, name, text));
  }
  return written;
}

const hasFile = (kind: IdentityKind, name: string, dirs: IdentityDirs) =>
  [dirs.global, dirs.project].some((dir) => !!dir && existsSync(identityPath(dir, kind, name)));

/** Every identity the team's members use. */
export function teamIdentities(team: TeamConfig, members: Member[], dirs: IdentityDirs): TeamIdentities {
  const warnings: string[] = [];
  const roles: Record<string, Identity> = {};
  const levels: Record<string, Identity> = {};
  const agents: Record<string, Identity> = {};
  for (const role of new Set(members.map((m) => m.role))) {
    const kind = team.roles[role]!.kind;
    const own = ROLE_IDENTITIES[role];
    let builtIn: string | null = own && own.kind === kind ? own.text : null;
    if (builtIn === null) {
      builtIn = KIND_IDENTITIES[kind];
      if (!hasFile("role", role, dirs)) {
        warnings.push(`role '${role}' has no IDENTITY.md of its own, so it uses the default for a ${kind} role (write roles/${role}/IDENTITY.md in .agentduo/team to describe it)`);
      } else builtIn = null;
    }
    roles[role] = layered("role", role, dirs, builtIn, warnings);
  }
  for (const level of new Set(members.map((m) => m.level))) {
    const builtIn = LEVEL_IDENTITIES[level] ?? null;
    if (builtIn === null && !hasFile("level", level, dirs)) {
      warnings.push(`level '${level}' has no IDENTITY.md (write levels/${level}/IDENTITY.md in .agentduo/team to describe it)`);
    }
    levels[level] = layered("level", level, dirs, builtIn, warnings);
  }
  for (const m of members) agents[m.name] = layered("agent", m.name, dirs, null, warnings);
  return { roles, levels, agents, warnings };
}

/** A member's identity as its prompt gives it: its role, its level, then its own notes. */
export function memberIdentity(ids: Pick<TeamIdentities, "roles" | "levels" | "agents">, m: Member): string {
  const parts = [
    `## Your role: ${m.role}\n${ids.roles[m.role]?.text ?? ""}`.trimEnd(),
    `## Your level: ${m.level}\n${ids.levels[m.level]?.text ?? ""}`.trimEnd(),
  ];
  const own = ids.agents[m.name]?.text;
  if (own) parts.push(`## Notes for you (${m.name})\n${own}`);
  return parts.join("\n\n");
}

/** The team of `team` as Settings shows it, with the identity files each of its roles, levels and members may have. */
export function teamInfo(team: TeamConfig, dirs: IdentityDirs, membersFrom: TeamInfo["membersFrom"] = null): TeamInfo {
  const errors = teamConfigErrors(team);
  const members = errors.length ? [] : teamMembers(team);
  const file = (dir: string | null, kind: TeamIdentityFile["kind"], name: string) => {
    if (!dir) return null;
    const path = identityPath(dir, kind, name);
    return { path, exists: existsSync(path) };
  };
  const identity = (kind: TeamIdentityFile["kind"], name: string, builtIn: boolean): TeamIdentityFile =>
    ({ kind, name, builtIn, global: file(dirs.global, kind, name), project: file(dirs.project, kind, name) });
  const roles = Object.entries(team.roles ?? {}).map(([name, r]) => ({ name, kind: r.kind }));
  const levels = Object.entries(team.levels ?? {}).map(([name, l]) => ({ name, canReview: l?.can_review === true }));
  return {
    members: members.map((m) => ({ name: m.name, role: m.role, kind: m.kind, level: m.level, backend: m.backend, model: m.model, effort: m.effort, canReview: m.canReview })),
    roles, levels, maxParallel: team.max_parallel, errors, membersFrom,
    config: structuredClone({ members: team.members, roles: team.roles, levels: team.levels, max_parallel: team.max_parallel }),
    identities: [
      ...roles.map((r) => identity("role", r.name, !!builtInIdentity(team, "role", r.name))),
      ...levels.map((l) => identity("level", l.name, !!builtInIdentity(team, "level", l.name))),
      ...members.map((m) => identity("agent", m.name, false)),
    ],
  };
}
