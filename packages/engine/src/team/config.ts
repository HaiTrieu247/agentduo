// A team's configuration (`team:` in config.yaml): its levels, its roles and their kinds, its members, how many of them
// work at once, and its limits. Pure (no Node), so the webviews' settings can use it too.
import { CLAUDE_EFFORTS, CODEX_EFFORTS } from "../chat/commands.js";

export type TeamBackend = "codex" | "claude";

/**
 * What a role does in the team's flow. pm: talks with the user (exactly one member); lead: plans, reviews, triages and
 * merges (exactly one member); worker: takes tasks (dev, frontend-dev…); checker: writes and runs tests (qa, security…).
 */
export type RoleKind = "pm" | "lead" | "worker" | "checker";
export const ROLE_KINDS: readonly RoleKind[] = ["pm", "lead", "worker", "checker"];

/** A level's model and effort on one CLI; absent or null: the CLI's own setting (agentduo's `<cli>.model`, the CLI's config). */
export interface LevelCli {
  model?: string | null;
  effort?: string | null;
}

export interface TeamLevel {
  /** Members of this level review the code of members whose level cannot; their own code is reviewed by the techlead. */
  can_review?: boolean;
  claude?: LevelCli;
  codex?: LevelCli;
}

export interface TeamRole {
  kind: RoleKind;
}

/** One entry of `team.members`: `count` members of a role at a level, on a CLI. */
export interface TeamMemberEntry {
  role: string;
  level: string;
  cli: TeamBackend;
  /** How many members this entry makes (default 1); each is named `<role>-<n>`. */
  count?: number;
  /** The member's own name, for an entry of one member. */
  name?: string;
  /**
   * The group (an area of the work) the member is in: each group has its techlead, its members and at most one PM of
   * its own; the one PM with no group leads, and is the only one who talks with you. No group anywhere: one team.
   */
  group?: string;
  /** Over the level's. */
  model?: string | null;
  effort?: string | null;
  /** After the args every call of its CLI gets. */
  args?: string[];
}

export interface TeamConfig {
  /** Lowest first: the order ranks them. */
  levels: Record<string, TeamLevel>;
  roles: Record<string, TeamRole>;
  members: TeamMemberEntry[];
  /** How many member calls run at once; the PM's turns do not count (the user waits for them). */
  max_parallel: number;
  limits: {
    /** Review rounds of one attempt of a task before the techlead must decide. */
    max_review_rounds: number;
    /** Attempts of one task (a retry, a reassignment, a fix of its tests) before the team asks you. */
    max_task_attempts: number;
  };
  /**
   * setup: commands run once in each new worktree (e.g. `npm ci`); link: folders the workspace ignores, shared with every
   * worktree by a symlink (e.g. node_modules).
   */
  worktree: { setup: string[]; link: string[] };
}

export const TEAM_DEFAULTS: TeamConfig = {
  levels: {
    junior: { can_review: false, claude: { model: "sonnet", effort: "low" }, codex: { effort: "low" } },
    mid: { can_review: false, claude: { model: "sonnet", effort: "medium" }, codex: { effort: "medium" } },
    senior: { can_review: true, claude: { model: "opus", effort: "high" }, codex: { effort: "high" } },
  },
  roles: {
    pm: { kind: "pm" },
    techlead: { kind: "lead" },
    dev: { kind: "worker" },
    qa: { kind: "checker" },
  },
  members: [
    { role: "pm", level: "senior", cli: "codex" },
    { role: "techlead", level: "senior", cli: "codex" },
    { role: "dev", level: "senior", cli: "claude" },
    { role: "dev", level: "mid", cli: "claude" },
    { role: "qa", level: "mid", cli: "claude" },
  ],
  max_parallel: 3,
  limits: { max_review_rounds: 3, max_task_attempts: 3 },
  worktree: { setup: [], link: [] },
};

/** A member of a team as a run knows it. */
export interface Member {
  name: string;
  role: string;
  kind: RoleKind;
  /** Its group; null in a team without groups, and for the head PM. */
  group: string | null;
  level: string;
  /** The level's place in `team.levels` (0: the lowest). */
  levelRank: number;
  canReview: boolean;
  backend: TeamBackend;
  /** The member's own model and effort, else its level's on its CLI; null: the CLI's own. */
  model: string | null;
  effort: string | null;
  args: string[];
}

/** What a member's call runs with on its CLI, over what every call of that CLI gets. */
export interface CallProfile {
  model: string | null;
  effort: string | null;
  args: string[];
}

/** Names that go into paths and git refs: a letter or digit, then letters, digits, `-` or `_`. */
const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const EFFORTS: Record<TeamBackend, readonly string[]> = { claude: CLAUDE_EFFORTS, codex: CODEX_EFFORTS };
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPosInt = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 1;
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isModel = (v: unknown): boolean => typeof v === "string" && !!v.trim() && v.length <= 200 && !/[\s\u0000-\u001f]/.test(v);
const describeName = "must be lowercase letters, digits, '-' or '_' (at most 40), starting with a letter or digit";

/**
 * The names each entry makes: its own name, else its role's; a PM or techlead is named after its role (and group),
 * every other member numbered per role and group (dev-1, dev-2; dev-frontend-1…).
 */
function entryNames(entries: Array<Partial<TeamMemberEntry>>, kindOf: (role: unknown) => RoleKind | undefined): string[][] {
  const numbered = new Map<string, number>();
  return entries.map((e) => {
    if (typeof e.name === "string") return [e.name];
    const kind = kindOf(e.role);
    const group = typeof e.group === "string" && NAME.test(e.group) ? e.group : null;
    const count = isPosInt(e.count) ? (e.count as number) : 1;
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      if (kind === "pm" || kind === "lead") names.push(group ? `${String(e.role)}-${group}` : String(e.role));
      else {
        const key = `${String(e.role)}|${group ?? ""}`;
        const n = (numbered.get(key) ?? 0) + 1;
        numbered.set(key, n);
        names.push(group ? `${String(e.role)}-${group}-${n}` : `${String(e.role)}-${n}`);
      }
    }
    return names;
  });
}

/**
 * The names each entry of `team.members` makes, in order (dev-1, dev-2…), as a run names them; a role the team does not
 * have numbers like a worker. Settings uses it to show and preview names while the team is still being written.
 */
export function memberNames(team: Pick<TeamConfig, "roles" | "members">): string[][] {
  return entryNames(team.members, (role) => (typeof role === "string" ? team.roles[role]?.kind : undefined));
}

/** Each member of the team, named, in the order the config lists them. Assumes a config without errors. */
export function teamMembers(team: TeamConfig): Member[] {
  const levels = Object.keys(team.levels);
  const names = entryNames(team.members, (role) => team.roles[role as string]?.kind);
  const out: Member[] = [];
  team.members.forEach((entry, i) => {
    const kind = team.roles[entry.role]!.kind;
    const level = team.levels[entry.level] ?? {};
    const cli = level[entry.cli] ?? {};
    for (const name of names[i]!) {
      out.push({
        name, role: entry.role, kind, group: entry.group ?? null, level: entry.level, levelRank: levels.indexOf(entry.level), canReview: level.can_review === true,
        backend: entry.cli, model: entry.model ?? cli.model ?? null, effort: entry.effort ?? cli.effort ?? null, args: [...(entry.args ?? [])],
      });
    }
  });
  return out;
}

/** A group of the team: its techlead, its PM (null: the head PM checks its work), and everyone in it. */
export interface TeamGroup {
  /** null: the team has no groups, and this is all of it. */
  name: string | null;
  lead: Member;
  pm: Member | null;
  members: Member[];
}

/** The head PM: the one PM in no group, who talks with you. */
export const headPm = (members: Member[]): Member => members.find((m) => m.kind === "pm" && m.group === null)!;

/** The team's groups in the order the config first names them; a team without groups is one group (name null). */
export function teamGroups(members: Member[]): TeamGroup[] {
  const names = [...new Set(members.flatMap((m) => (m.group ? [m.group] : [])))];
  if (!names.length) {
    return [{ name: null, lead: members.find((m) => m.kind === "lead")!, pm: null, members: members.filter((m) => m.kind !== "pm") }];
  }
  return names.map((name) => {
    const inGroup = members.filter((m) => m.group === name);
    return { name, lead: inGroup.find((m) => m.kind === "lead")!, pm: inGroup.find((m) => m.kind === "pm") ?? null, members: inGroup };
  });
}

/** The group a member is in (its techlead's), or the one group of a team without groups. */
export const groupOf = (groups: TeamGroup[], member: Member): TeamGroup => groups.find((g) => g.name === member.group) ?? groups[0]!;

export const memberProfile = (m: Member): CallProfile => ({ model: m.model, effort: m.effort, args: [...m.args] });

function levelErrors(name: string, level: unknown): string[] {
  const where = `team.levels.${name}`;
  if (!isPlainObject(level)) return [`${where} must be a mapping`];
  const errors: string[] = [];
  const unknown = Object.keys(level).filter((k) => !["can_review", "claude", "codex"].includes(k));
  if (unknown.length) errors.push(`${where}: unknown keys ${unknown.sort().join(", ")}`);
  if (level.can_review !== undefined && typeof level.can_review !== "boolean") errors.push(`${where}.can_review must be true or false`);
  for (const cli of ["claude", "codex"] as const) {
    const value = level[cli];
    if (value === undefined || value === null) continue;
    if (!isPlainObject(value)) {
      errors.push(`${where}.${cli} must be a mapping with model and effort`);
      continue;
    }
    const extra = Object.keys(value).filter((k) => !["model", "effort"].includes(k));
    if (extra.length) errors.push(`${where}.${cli}: unknown keys ${extra.sort().join(", ")}`);
    if (value.model != null && !isModel(value.model)) errors.push(`${where}.${cli}.model must be a model name or null`);
    if (value.effort != null && !EFFORTS[cli].includes(value.effort as string)) errors.push(`${where}.${cli}.effort must be one of ${EFFORTS[cli].join(", ")}, or null`);
  }
  return errors;
}

/** A path the workspace shares with each worktree: relative, inside it, without `..`. */
const insidePath = (p: string): boolean => !!p && !/^([a-zA-Z]:)?[\\/]/.test(p) && !p.split(/[\\/]/).some((part) => part === ".." || part === "");

/** What is wrong with a `team:` configuration, one line per problem; empty when nothing. */
export function teamConfigErrors(raw: unknown): string[] {
  if (!isPlainObject(raw)) return ["team must be a mapping"];
  const team = raw as unknown as TeamConfig;
  const errors: string[] = [];
  const levels = isPlainObject(team.levels) ? Object.keys(team.levels) : [];
  if (!isPlainObject(team.levels) || !levels.length) errors.push("team.levels must be a mapping of at least one level");
  else {
    for (const name of levels) {
      if (!NAME.test(name)) errors.push(`team.levels: level name '${name}' ${describeName}`);
      errors.push(...levelErrors(name, team.levels[name]));
    }
  }
  const roles = isPlainObject(team.roles) ? Object.keys(team.roles) : [];
  if (!isPlainObject(team.roles) || !roles.length) errors.push("team.roles must be a mapping of at least one role");
  else {
    for (const name of roles) {
      const role = team.roles[name] as unknown;
      if (!NAME.test(name)) errors.push(`team.roles: role name '${name}' ${describeName}`);
      if (!isPlainObject(role)) {
        errors.push(`team.roles.${name} must be a mapping with a kind`);
        continue;
      }
      if (!ROLE_KINDS.includes(role.kind as RoleKind)) errors.push(`team.roles.${name}.kind must be one of ${ROLE_KINDS.join(", ")}`);
      const extra = Object.keys(role).filter((k) => k !== "kind");
      if (extra.length) errors.push(`team.roles.${name}: unknown keys ${extra.sort().join(", ")}`);
    }
  }
  if (!isPosInt(team.max_parallel)) errors.push("team.max_parallel must be a positive integer");
  if (!isPlainObject(team.limits)) errors.push("team.limits must be a mapping");
  else for (const key of ["max_review_rounds", "max_task_attempts"] as const) {
    if (!isPosInt(team.limits[key])) errors.push(`team.limits.${key} must be a positive integer`);
  }
  if (!isPlainObject(team.worktree)) errors.push("team.worktree must be a mapping with setup and link");
  else {
    if (!isStringList(team.worktree.setup)) errors.push("team.worktree.setup must be a list of strings");
    if (!isStringList(team.worktree.link)) errors.push("team.worktree.link must be a list of strings");
    else team.worktree.link.forEach((p, i) => {
      if (!insidePath(p)) errors.push(`team.worktree.link[${i}] must be a relative path inside the workspace`);
    });
  }
  if (!Array.isArray(team.members)) {
    errors.push("team.members must be a list");
    return errors;
  }
  const names = new Map<string, number>();
  const placed: Array<{ name: string; kind: RoleKind; group: string | null }> = [];
  // Names as teamMembers makes them, numbered across entries.
  const made = entryNames(team.members.map((e) => (isPlainObject(e) ? e as Partial<TeamMemberEntry> : {})),
    (r) => (isPlainObject(team.roles) && typeof r === "string" ? team.roles[r]?.kind : undefined));
  team.members.forEach((entry, i) => {
    const where = `team.members[${i}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${where} must be a mapping with role, level and cli`);
      return;
    }
    const e = entry as unknown as Record<string, unknown>;
    const extra = Object.keys(e).filter((k) => !["role", "level", "cli", "count", "name", "group", "model", "effort", "args"].includes(k));
    if (extra.length) errors.push(`${where}: unknown keys ${extra.sort().join(", ")}`);
    const role = isPlainObject(team.roles) && typeof e.role === "string" ? team.roles[e.role] : undefined;
    if (!role) errors.push(`${where}.role: unknown role '${String(e.role)}' (roles: ${roles.join(", ")})`);
    if (typeof e.level !== "string" || !levels.includes(e.level)) errors.push(`${where}.level: unknown level '${String(e.level)}' (levels: ${levels.join(", ")})`);
    const cli = e.cli === "codex" || e.cli === "claude" ? e.cli : null;
    if (!cli) errors.push(`${where}.cli must be one of codex, claude`);
    if (e.count !== undefined && !isPosInt(e.count)) errors.push(`${where}.count must be a positive integer`);
    if (e.name !== undefined) {
      if (typeof e.name !== "string" || !NAME.test(e.name)) errors.push(`${where}.name ${describeName}`);
      if (e.count !== undefined && e.count !== 1) errors.push(`${where}: a member with a name has count 1`);
    }
    if (e.model != null && !isModel(e.model)) errors.push(`${where}.model must be a model name or null`);
    if (e.effort != null && cli && !EFFORTS[cli].includes(e.effort as string)) errors.push(`${where}.effort must be one of ${EFFORTS[cli].join(", ")}, or null`);
    if (e.args !== undefined && !isStringList(e.args)) errors.push(`${where}.args must be a list of strings`);
    if (e.group !== undefined && (typeof e.group !== "string" || !NAME.test(e.group))) errors.push(`${where}.group ${describeName}`);
    if (!role || !ROLE_KINDS.includes(role.kind)) return;
    const group = typeof e.group === "string" && NAME.test(e.group) ? e.group : null;
    for (const name of made[i]!) {
      if (names.has(name)) errors.push(`${where}: duplicate member name '${name}'`);
      names.set(name, i);
      placed.push({ name, kind: role.kind, group });
    }
  });
  const groups = [...new Set(placed.flatMap((p) => (p.group ? [p.group] : [])))];
  const list = (xs: Array<{ name: string }>) => xs.map((x) => x.name).join(", ");
  const heads = placed.filter((p) => p.kind === "pm" && !p.group);
  if (heads.length !== 1) {
    errors.push(`team.members must have exactly one member whose role is of kind pm${groups.length ? " and who is in no group (the head PM)" : ""}` +
      (heads.length ? ` (found ${heads.length}: ${list(heads)})` : ""));
  }
  if (!groups.length) {
    const leads = placed.filter((p) => p.kind === "lead");
    if (leads.length !== 1) errors.push(`team.members must have exactly one member whose role is of kind lead${leads.length ? ` (found ${leads.length}: ${list(leads)})` : ""}`);
    for (const kind of ["worker", "checker"] as const) {
      if (!placed.some((p) => p.kind === kind)) errors.push(`team.members must have at least one member whose role is of kind ${kind}`);
    }
  } else {
    const loose = placed.filter((p) => !p.group && p.kind !== "pm");
    if (loose.length) errors.push(`team.members: in a team with groups every member but the head PM is in a group (not in one: ${list(loose)})`);
    for (const g of groups) {
      const inGroup = placed.filter((p) => p.group === g);
      const leads = inGroup.filter((p) => p.kind === "lead");
      const pms = inGroup.filter((p) => p.kind === "pm");
      if (leads.length !== 1) errors.push(`group '${g}' must have exactly one techlead (a member whose role is of kind lead)${leads.length ? ` (found ${list(leads)})` : ""}`);
      if (pms.length > 1) errors.push(`group '${g}' has at most one PM of its own (found ${list(pms)})`);
      for (const kind of ["worker", "checker"] as const) {
        if (!inGroup.some((p) => p.kind === kind)) errors.push(`group '${g}' must have at least one member whose role is of kind ${kind}`);
      }
    }
  }
  return errors;
}
