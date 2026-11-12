// A team run's state (packages/engine/src/team): its phase, the brief and the plan, every task and where it stands,
// the conversation with the PM, the reports waiting for the PM, the members' sessions, the questions asked of the user,
// and its usage. Saved whole after every change in <runs>/teams/<id>/state.json.
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClarificationEntry } from "../clarification/clarification.js";
import type { Attachment } from "../inputs/attachment-types.js";
import type { RunBudget, RunGit } from "../workflow/state.js";
import { atomicWrite } from "../workflow/state.js";
import type { Snapshot } from "../git/git.js";
import type { TeamBackend } from "./config.js";
import type { TaskStatus, TeamPhase } from "./model.js";

export type { TaskStatus, TeamPhase } from "./model.js";

export const TEAM_STATE_VERSION = 1;

export interface Criterion {
  id: string;
  criterion: string;
}

/** What the PM understood the user wants (packages/engine/schemas/team_pm.schema.json `brief`), by version. */
export interface Brief {
  version: number;
  /** The user asked for changes instead of approving it. */
  declined?: boolean;
  title: string;
  goal: string;
  scope: string[];
  out_of_scope: string[];
  constraints: string[];
  criteria: Criterion[];
  notes: string | null;
}

export interface PlanTask {
  id: string;
  title: string;
  description: string;
  assignee: string;
  testers: string[];
  area: string[];
  depends_on: string[];
  criteria: string[];
  test_focus: string;
}

/** The key of a group in maps and sets: its name, or "" for a team without groups. */
export const groupKey = (group: string | null): string => group ?? "";

/** The part of the brief the head PM gave a group (a team with groups): what it builds, and the criteria it answers for. */
export interface Area {
  briefVersion: number;
  group: string;
  area: string;
  criteria: string[];
}

export interface TeamPlan {
  version: number;
  /** The group whose techlead wrote it; null in a team without groups. */
  group: string | null;
  /** The brief it plans (the approved one when it was written). */
  briefVersion: number;
  /** The group's own PM's verdict (null until it checked it; absent when the group has none). */
  areaApproved?: boolean | null;
  /** The head PM approved the set of plans it is in, for the user to see. */
  pmApproved?: boolean | null;
  /** Sent back (by a PM or the user): its techlead plans again. */
  declined?: boolean;
  /** A plan of tasks added to the run's (a change of the brief), not of the whole work. */
  additions?: boolean;
  summary: string;
  tasks: PlanTask[];
  risks: string[];
}


export interface ReviewFinding {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  file: string | null;
  line: number | null;
  title: string;
  detail: string;
  criteria: string[];
  origin: "in_scope" | "out_of_scope";
}

export interface CheckFailure {
  id: string;
  title: string;
  detail: string;
  reproduction: string;
  expected: string;
  actual: string;
  criteria: string[];
  suspect: "code" | "test" | "plan";
}

/** A tester's tests for a task: written alongside the code, fixed when the techlead says they are wrong. */
export interface TaskTests {
  status: "pending" | "written" | "fixing";
  commit: string | null;
  summary: string | null;
  howToRun: string | null;
}

/** One tester's (or the gates') latest check of a task's candidate. */
export interface TaskCheck {
  by: string;
  verdict: "pass" | "fail";
  summary: string;
  failures: CheckFailure[];
  /** Tests the tester added while it checked, as a commit on the candidate; merged with the task. */
  commit?: string | null;
}

/** Why a task waits for the techlead or the PM, and what was said. */
export interface TaskQuestion {
  id: string;
  from: string;
  text: string;
  /** The techlead escalated it: the PM (or the user) answers. */
  escalated: boolean;
  answer: string | null;
}

export interface TaskState extends PlanTask {
  /** The group whose techlead planned it (and reviews, triages and merges it); null in a team without groups. */
  group: string | null;
  status: TaskStatus;
  /** Attempts of the task so far (a retry, a reassignment or a fix of its tests starts the next). */
  attempt: number;
  /** Review rounds of the current attempt. */
  reviewRound: number;
  /** The integration commit the task started from. */
  base: string | null;
  /** The assignee's latest work, as a commit. */
  code: string | null;
  codeSummary: string | null;
  notes: string[];
  tests: Record<string, TaskTests>;
  candidate: string | null;
  /** Who reviews the current attempt, once chosen. */
  reviewer: string | null;
  review: { reviewer: string; verdict: "approve" | "changes"; summary: string; findings: ReviewFinding[] } | null;
  checks: TaskCheck[];
  /** What the techlead told the next member to act on it. */
  guidance: string | null;
  /** Why it went to triage: a failed check, review rounds used up, a merge that broke the gates… */
  trouble: string | null;
  question: TaskQuestion | null;
  /** The failures of the previous check, by identity, to tell whether a fix round made progress. */
  lastFailureKeys: string[];
  stalls: number;
  conflicts: string[];
  history: Array<{ at: string; text: string }>;
}

export interface TeamMessage {
  seq: number;
  at: string;
  from: "user" | "pm";
  text: string;
  /** The files the user attached to it: copies of the run's own (`<run>/attachments/`), which every member is given. */
  attachments?: Attachment[];
}

/** A milestone for the PM to tell the user about. */
export interface Report {
  seq: number;
  at: string;
  from: string;
  text: string;
}

export interface MemberSession {
  backend: TeamBackend;
  id: string;
  /** The ids of the user's files this session was given (absent: none); a continued call gets only the others. */
  files?: string[];
}

/** What the run waits for from the user, through the PM: one of the three approvals, or how to apply a conflicting result. */
export interface Approval {
  kind: "brief" | "plan" | "acceptance" | "apply_conflict";
  requestId: string;
}

/** A question the team owes an answer to before it can go on (escalated by the techlead, or a stop the run reached). */
export interface Escalation {
  id: string;
  /** The task it is about, if any. */
  task: string | null;
  /** The group it is about when no task is (its planning, its share of an integration failure); absent: none. */
  group?: string | null;
  reason: "question" | "planning" | "task_limit" | "review_stalled" | "integration_limit" | "merge_conflict" | "agent_error";
  text: string;
  /** Who answers it now: the group's PM, or the head PM (who asks the user what it cannot answer). */
  to: string;
  /** The PM told the user about it. */
  told: boolean;
  /** The PM's answer (team_answer), which settles it. */
  answer: string | null;
}

export interface TeamUsage {
  calls: number;
  unpricedCalls: number;
  costUsd: number;
  tokens: number;
  /** Seconds of agent work (waiting for the user left out), for the budget's minutes. */
  workSec: number;
  byMember: Record<string, { calls: number; costUsd: number; tokens: number }>;
}

export interface TeamState {
  version: number;
  kind: "team";
  id: string;
  request: string;
  phase: TeamPhase;
  createdAt: string;
  updatedAt: string;
  git: RunGit | undefined;
  base: Snapshot | null;
  briefs: Brief[];
  /** The brief the user approved (its version). */
  approvedBrief: number | null;
  /** What the head PM gave each group of the brief (a team with groups). */
  areas: Area[];
  /** Every plan every techlead wrote, oldest first. */
  plans: TeamPlan[];
  /** The set of plans (one per group, `planSignature`) the head PM checked last, the one it showed you, the one you approved. */
  planReviewed: string | null;
  planPresented: string | null;
  approvedPlan: string | null;
  /** What a PM or the user asked a group's techlead to change (by group key): its next plan answers it. */
  planFeedback: Record<string, string>;
  planningRounds: number;
  /** Planning rounds a group got back when a PM answered why its planning did not converge (by group key). */
  planningExtra: Record<string, number>;
  tasks: TaskState[];
  integrationRounds: number;
  /**
   * The latest check of the integration head: each tester's and the gates'. `triage`: the techlead must add tasks,
   * because of the checks' failures or of `trouble` (what the user asked to change).
   */
  integration: { commit: string; checks: TaskCheck[]; triage: boolean; trouble: string | null; triageGroups: string[] } | null;
  /** The tree the last whole check passed on: the only tree written into the workspace. */
  verifiedTree: string | null;
  /** The user accepted the result: once the code is checked again (after merging your edits), it is written. */
  accepted: boolean;
  /** Writing the result conflicts with what you changed in the workspace meanwhile; resolving: the techlead resolves it. */
  applyConflict: { ours: string; tree: string; files: string[]; resolving: boolean } | null;
  /** When the PM last told the user about the team's reports. */
  lastReportAt: string | null;
  /** The user's words for the next change (acceptance), until the techlead or the PM acts on it. */
  changeRequest: string | null;
  acceptance: { criteria: Array<{ id: string; status: string; evidence: string }>; summary: string } | null;
  messages: TeamMessage[];
  /** How many of `messages` the PM has seen. */
  pmSeen: number;
  reports: Report[];
  reportsSeen: number;
  /** The approved brief changed after planning: the next plan adds tasks. */
  replanning: boolean;
  /** Notes from the PM for a group's techlead (group null: every techlead), and how far each techlead has read them. */
  leadNotes: Array<{ group: string | null; text: string }>;
  leadNotesSeen: Record<string, number>;
  escalations: Escalation[];
  sessions: Record<string, MemberSession>;
  clarifications: ClarificationEntry[];
  waiting: Approval | null;
  usage: TeamUsage;
  budget: RunBudget | null;
  /** Where the result went: the files written, and the tree. */
  applied: { tree: string; files: string[]; at: string } | null;
  summary: string | null;
  warnings: string[];
  seq: number;
}

export const nowIso = (): string => new Date().toISOString();

export function newTeamState(id: string, request: string): TeamState {
  const at = nowIso();
  return {
    version: TEAM_STATE_VERSION, kind: "team", id, request, phase: "INTAKE", createdAt: at, updatedAt: at, git: undefined, base: null,
    briefs: [], approvedBrief: null, areas: [], plans: [], planReviewed: null, planPresented: null, approvedPlan: null, planFeedback: {}, planningRounds: 0, planningExtra: {},
    tasks: [], integrationRounds: 0,
    integration: null, verifiedTree: null, accepted: false, applyConflict: null, lastReportAt: null, changeRequest: null, acceptance: null, messages: [{ seq: 1, at, from: "user", text: request }], pmSeen: 0,
    reports: [], reportsSeen: 0, replanning: false, leadNotes: [], leadNotesSeen: {}, escalations: [], sessions: {}, clarifications: [], waiting: null,
    usage: { calls: 0, unpricedCalls: 0, costUsd: 0, tokens: 0, workSec: 0, byMember: {} }, budget: null, applied: null, summary: null, warnings: [], seq: 1,
  };
}

/** The next number of the run's sequence (messages, reports, ids of its own). */
export const nextSeq = (state: TeamState): number => ++state.seq;

export const latestBrief = (state: TeamState): Brief | null => state.briefs.at(-1) ?? null;
export const approvedBrief = (state: TeamState): Brief | null => state.briefs.find((b) => b.version === state.approvedBrief) ?? null;
/** A group's latest plan of the approved brief, or null. */
export const latestPlan = (state: TeamState, group: string | null = null): TeamPlan | null =>
  state.plans.filter((p) => p.group === group && p.briefVersion === state.approvedBrief).at(-1) ?? null;

/** The areas of the approved brief (a team with groups). */
export const currentAreas = (state: TeamState): Area[] => state.areas.filter((a) => a.briefVersion === state.approvedBrief);

/** A set of plans as one value ("frontend:2,backend:1"), to tell whether the head PM or you saw that very set. */
export const planSignature = (plans: TeamPlan[]): string => plans.map((p) => `${p.group ?? ""}:${p.version}`).join(",");

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
const slug = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 40) || "team";

/** A team run's directory: state.json, the config and identities it started with, and its logs. */
export class TeamStore {
  readonly dir: string;

  constructor(readonly runsDir: string, readonly id: string) {
    this.dir = join(teamsDir(runsDir), id);
  }

  static create(runsDir: string, request: string, now = new Date()): { store: TeamStore; state: TeamState } {
    const base = `${stamp(now)}-${slug(request)}`;
    let id = base;
    for (let n = 2; existsSync(join(teamsDir(runsDir), id)); n++) id = `${base}-${n}`;
    const store = new TeamStore(runsDir, id);
    mkdirSync(join(store.dir, "logs"), { recursive: true });
    const state = newTeamState(id, request);
    store.save(state);
    return { store, state };
  }

  static open(runsDir: string, id: string): TeamStore {
    let name = id;
    if (id === "latest") {
      const all = TeamStore.list(runsDir);
      if (!all.length) throw new Error(`no team runs in ${teamsDir(runsDir)}`);
      name = all.at(-1)!.id;
    }
    const store = new TeamStore(runsDir, name);
    if (!existsSync(store.path("state.json"))) throw new Error(`team run '${name}' not found in ${teamsDir(runsDir)}`);
    return store;
  }

  /** Every team run, oldest first. */
  static list(runsDir: string): TeamState[] {
    const dir = teamsDir(runsDir);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().flatMap((name) => {
      try {
        return [new TeamStore(runsDir, name).load()];
      } catch {
        return [];
      }
    });
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  load(): TeamState {
    const state = JSON.parse(readFileSync(this.path("state.json"), "utf8")) as TeamState;
    if (state.kind !== "team" || state.version !== TEAM_STATE_VERSION) throw new Error(`unsupported team state in ${this.dir}`);
    return state;
  }

  save(state: TeamState): void {
    state.updatedAt = nowIso();
    atomicWrite(this.path("state.json"), `${JSON.stringify(state, null, 2)}\n`);
  }

  writeJson(name: string, data: unknown): void {
    atomicWrite(this.path(name), `${JSON.stringify(data, null, 2)}\n`);
  }

  readJson<T>(name: string): T {
    return JSON.parse(readFileSync(this.path(name), "utf8")) as T;
  }
}

export const teamsDir = (runsDir: string): string => join(runsDir, "teams");
