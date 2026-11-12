// What a team run is made of, as the screens see it (packages/engine/src/team): its phases, a task's statuses, and a
// task and a member as events carry them. Pure: the webviews import it.
import type { TeamConfig } from "./config.js";

export type TeamPhase = "INTAKE" | "PLANNING" | "EXECUTION" | "INTEGRATION" | "ACCEPTANCE" | "APPLY" | "DONE" | "ABORTED";

/**
 * Where a task stands. pending: waiting for its dependencies or its assignee; coding: its assignee works; blocked: its
 * assignee asked the techlead; review: waiting for or under review; testing: its testers check the candidate; triage:
 * the techlead decides about a failure; merging: agentduo merges it; resolving: the techlead resolves a merge conflict;
 * escalated: waiting for the PM (and maybe the user); merged; cancelled.
 */
export type TaskStatus = "pending" | "coding" | "blocked" | "review" | "testing" | "triage" | "merging" | "resolving" | "escalated" | "merged" | "cancelled";

export interface TeamTaskView {
  id: string;
  title: string;
  status: TaskStatus;
  assignee: string;
  testers: string[];
  attempt: number;
  dependsOn: string[];
  /** The group it is in (a team with groups); absent or null otherwise. */
  group?: string | null;
}

export interface TeamMemberView {
  name: string;
  role: string;
  /** Its group (a team with groups); absent or null otherwise, and for the head PM. */
  group?: string | null;
  kind: "pm" | "lead" | "worker" | "checker";
  level: string;
  backend: "codex" | "claude";
}

/** One identity file of a team as Settings shows it: the user config's and the project's, and whether agentduo has a text of its own for it. */
export interface TeamIdentityFile {
  kind: "role" | "level" | "agent";
  name: string;
  builtIn: boolean;
  global: { path: string; exists: boolean } | null;
  project: { path: string; exists: boolean } | null;
}

/** A team as Settings shows it: its members (with what they run on), its roles and levels, and every identity file. */
export interface TeamInfo {
  members: Array<TeamMemberView & { model: string | null; effort: string | null; canReview: boolean }>;
  roles: Array<{ name: string; kind: TeamMemberView["kind"] }>;
  levels: Array<{ name: string; canReview: boolean }>;
  maxParallel: number;
  /**
   * The file whose team.members holds (the project's over the user config's), or null: no file has a team yet, and
   * agentduo's own team (TEAM_DEFAULTS) runs.
   */
  membersFrom: "project" | "global" | null;
  /** The team as the configuration has it now (every layer merged): what Settings → Team starts editing from. */
  config: Pick<TeamConfig, "members" | "roles" | "levels" | "max_parallel">;
  identities: TeamIdentityFile[];
  /** What is wrong with the team's configuration (it does not start then). */
  errors: string[];
}
