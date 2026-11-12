// The team's task board as rules (packages/engine/src/team): which jobs can run now, who reviews whom, what a plan
// must say, what blocks a review, and whether a fix round made progress. Pure: no Node, no git, no agents.
import { teamGroups, type Member, type TeamGroup } from "./config.js";
import type { Brief, CheckFailure, PlanTask, ReviewFinding, TaskState, TeamPhase, TeamState } from "./state.js";

/** A member's call agentduo can start, or a step of its own (gates, a merge). */
export type Job =
  | { kind: "pm" }
  | { kind: "plan"; member: string }
  | { kind: "work"; member: string; task: string }
  | { kind: "tests"; member: string; task: string }
  | { kind: "review"; member: string; task: string }
  | { kind: "check"; member: string; task: string }
  | { kind: "triage"; member: string; task: string }
  | { kind: "answer"; member: string; task: string }
  | { kind: "resolve"; member: string; task: string }
  | { kind: "gates"; task: string | null }
  | { kind: "merge"; task: string }
  | { kind: "integration_check"; member: string }
  | { kind: "integration_triage"; member: string }
  /** The techlead resolves a conflict between the result and your edits to the workspace. */
  | { kind: "resolve_apply"; member: string }
  /** A group's own PM checks its group's plan, or answers its techlead's question. */
  | { kind: "area_pm"; member: string };

/** A job's identity while it runs: nothing starts the same job twice. */
export const jobKey = (job: Job): string =>
  `${job.kind}:${"member" in job ? job.member : "-"}:${"task" in job ? job.task ?? "-" : "-"}`;

/** Jobs of agentduo's own (no agent): they never count against `max_parallel`. */
export const ownJob = (job: Job): boolean => job.kind === "gates" || job.kind === "merge";

const DONE: TaskState["status"][] = ["merged", "cancelled"];
export const finished = (t: TaskState): boolean => DONE.includes(t.status);

/** The techlead of a group (the task's), or of the one group of a team without groups. */
export const leadOf = (groups: TeamGroup[], group: string | null): Member => (groups.find((g) => g.name === group) ?? groups[0]!).lead;
export const testersOf = (members: Member[]): Member[] => members.filter((m) => m.kind === "checker");

/** Whether every task this one depends on is in the integration branch (or was cancelled). */
export function ready(task: TaskState, tasks: TaskState[]): boolean {
  return task.depends_on.every((id) => {
    const dep = tasks.find((t) => t.id === id);
    return !dep || finished(dep);
  });
}

/**
 * Who reviews a task: a member whose level cannot review is reviewed by one whose level can (another worker, the same
 * role first, a free one first); a member whose level can is reviewed by the techlead, as is anyone when no worker can
 * review. Null: every possible reviewer is busy now.
 */
export function chooseReviewer(task: TaskState, members: Member[], busy: ReadonlySet<string>, groups: TeamGroup[] = teamGroups(members)): string | null {
  const author = members.find((m) => m.name === task.assignee);
  const techlead = leadOf(groups, task.group ?? null).name;
  if (!author || author.canReview) return techlead;
  // The author's group first, then its role, then the highest level.
  const able = members.filter((m) => m.kind === "worker" && m.canReview && m.name !== author.name)
    .sort((a, b) => Number(b.group === author.group) - Number(a.group === author.group) || Number(b.role === author.role) - Number(a.role === author.role) ||
      b.levelRank - a.levelRank);
  if (!able.length) return techlead;
  return able.find((m) => !busy.has(m.name))?.name ?? null;
}

/** A finding the implementer must act on: inside the scope and of a blocking severity. Out of scope is a suggestion. */
export const blocks = (f: ReviewFinding, blocking: readonly string[]): boolean => f.origin === "in_scope" && blocking.includes(f.severity);

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** A check failure's identity across rounds: its title and what it suspects, its id and wording left out. */
export const failureKey = (f: Pick<CheckFailure, "title" | "suspect">): string => `${f.suspect}:${normalize(f.title)}`;

/**
 * Whether a fix round made progress: some failure of the previous check is gone. The same failures again (by
 * identity), or new ones only, is not progress.
 */
export function madeProgress(previous: string[], now: string[]): boolean {
  if (!previous.length) return true;
  const current = new Set(now);
  return previous.some((key) => !current.has(key));
}

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/;

/**
 * What is wrong with a plan's tasks, each said so that the techlead can correct exactly it. `members`: who may be given
 * its tasks (the techlead's group); `existing`: the run's tasks so far (new tasks may depend on them and must not reuse
 * their ids); `required`: the criteria the tasks must serve (true: every criterion of the brief; null: none in particular).
 */
export function planProblems(tasks: PlanTask[], members: Member[], brief: Brief, existing: TaskState[] = [], required: true | string[] | null = true): string[] {
  const problems: string[] = [];
  if (!tasks.length) problems.push("the plan has no task");
  const byName = new Map(members.map((m) => [m.name, m]));
  const workers = members.filter((m) => m.kind === "worker").map((m) => m.name);
  const checkers = members.filter((m) => m.kind === "checker").map((m) => m.name);
  const ids = new Set<string>();
  const known = new Set(existing.map((t) => t.id));
  const criteria = new Set(brief.criteria.map((c) => c.id));
  for (const t of tasks) {
    const where = `task '${t.id}'`;
    if (!TASK_ID.test(t.id)) problems.push(`${where}: an id is letters, digits, '-' or '_' (at most 20), like T1`);
    if (ids.has(t.id)) problems.push(`${where}: the id is used twice`);
    if (known.has(t.id)) problems.push(`${where}: the id is already a task of this run; use a new one`);
    ids.add(t.id);
    if (!t.title.trim() || !t.description.trim()) problems.push(`${where}: give it a title and a description`);
    const assignee = byName.get(t.assignee);
    if (!assignee || assignee.kind !== "worker") problems.push(`${where}: the assignee '${t.assignee}' is not a member who takes tasks (${workers.join(", ")})`);
    if (!t.testers.length) problems.push(`${where}: name at least one tester (${checkers.join(", ")})`);
    for (const tester of t.testers) {
      if (byName.get(tester)?.kind !== "checker") problems.push(`${where}: '${tester}' is not a tester (${checkers.join(", ")})`);
    }
    if (new Set(t.testers).size !== t.testers.length) problems.push(`${where}: a tester is named twice`);
    for (const c of t.criteria) if (!criteria.has(c)) problems.push(`${where}: '${c}' is not an acceptance criterion of the brief (${[...criteria].join(", ")})`);
    if (!t.criteria.length) problems.push(`${where}: name the acceptance criteria it serves`);
  }
  for (const t of tasks) {
    for (const d of t.depends_on) {
      if (d === t.id) problems.push(`task '${t.id}' depends on itself`);
      else if (!ids.has(d) && !known.has(d)) problems.push(`task '${t.id}' depends on '${d}', which is no task`);
    }
  }
  const cycle = findCycle(tasks);
  if (cycle) problems.push(`the dependencies form a cycle: ${cycle.join(" -> ")}`);
  if (required) {
    const served = new Set(tasks.flatMap((t) => t.criteria));
    for (const c of required === true ? brief.criteria.map((x) => x.id) : required) if (!served.has(c)) problems.push(`acceptance criterion ${c} is served by no task`);
  }
  return problems;
}

function findCycle(tasks: PlanTask[]): string[] | null {
  const deps = new Map(tasks.map((t) => [t.id, t.depends_on]));
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === "done" || !deps.has(id)) return null;
    if (state.get(id) === "visiting") return [...path.slice(path.indexOf(id)), id];
    state.set(id, "visiting");
    path.push(id);
    for (const d of deps.get(id)!) {
      const found = visit(d);
      if (found) return found;
    }
    path.pop();
    state.set(id, "done");
    return null;
  };
  for (const t of tasks) {
    const found = visit(t.id);
    if (found) return found;
  }
  return null;
}

/** A task as the board starts it, from the plan. */
export function newTask(t: PlanTask, group: string | null = null): TaskState {
  return {
    ...structuredClone(t), group, status: "pending", attempt: 1, reviewRound: 0, base: null, code: null, codeSummary: null, notes: [],
    tests: Object.fromEntries(t.testers.map((name) => [name, { status: "pending", commit: null, summary: null, howToRun: null }])),
    candidate: null, reviewer: null, review: null, checks: [], guidance: null, trouble: null, question: null, lastFailureKeys: [], stalls: 0, conflicts: [], history: [],
  };
}

export interface BoardContext {
  members: Member[];
  /** The team's groups (one, named null, in a team without groups); default: the members'. */
  groups?: TeamGroup[];
  /** Members with a call running. */
  busy: ReadonlySet<string>;
  /** Jobs running now, by key. */
  running: ReadonlySet<string>;
  /** Gates are configured: a candidate and the integration head are also checked by them. */
  gates: boolean;
}

/** Whether a task's candidate has every check it needs: each tester's, and the gates' when there are gates. */
export function checksComplete(task: TaskState, gates: boolean): boolean {
  const by = new Set(task.checks.map((c) => c.by));
  return task.testers.every((t) => by.has(t)) && (!gates || by.has("gates"));
}

/** Whether every test of a task is written (none pending or being fixed). */
export const testsWritten = (task: TaskState): boolean => Object.values(task.tests).every((t) => t.status === "written");

/**
 * The jobs that can start now, most urgent first (the techlead's, then reviews, checks, work and tests). The PM's turn
 * and the phases' own steps are the run's to decide; this is the task board's part.
 */
export function boardJobs(state: Pick<TeamState, "phase" | "tasks" | "integration" | "applyConflict">, ctx: BoardContext): Job[] {
  const jobs: Job[] = [];
  const groups = ctx.groups ?? teamGroups(ctx.members);
  const techleadOf = (t: TaskState) => leadOf(groups, t.group ?? null).name;
  const free = (m: string) => !ctx.busy.has(m);
  const add = (job: Job) => {
    if (ctx.running.has(jobKey(job))) return;
    if ("member" in job && !free(job.member)) return;
    if (jobs.some((j) => "member" in j && "member" in job && j.member === job.member)) return;
    jobs.push(job);
  };
  const phase: TeamPhase = state.phase;
  if (phase === "EXECUTION") {
    const tasks = state.tasks;
    for (const t of tasks) {
      if (t.status === "triage") add({ kind: "triage", member: techleadOf(t), task: t.id });
      else if (t.status === "blocked" && t.question && !t.question.escalated && t.question.answer === null) add({ kind: "answer", member: techleadOf(t), task: t.id });
      else if (t.status === "resolving") add({ kind: "resolve", member: techleadOf(t), task: t.id });
    }
    for (const t of tasks) {
      if (t.status !== "review") continue;
      const reviewer = chooseReviewer(t, ctx.members, ctx.busy, groups);
      if (reviewer) add({ kind: "review", member: reviewer, task: t.id });
    }
    for (const t of tasks) {
      if (t.status !== "testing" || !t.candidate) continue;
      const by = new Set(t.checks.map((c) => c.by));
      for (const tester of t.testers) if (!by.has(tester)) add({ kind: "check", member: tester, task: t.id });
      if (ctx.gates && !by.has("gates")) add({ kind: "gates", task: t.id });
    }
    for (const t of tasks) if (t.status === "merging") add({ kind: "merge", task: t.id });
    for (const t of tasks) {
      if (t.status === "coding" || (t.status === "pending" && ready(t, tasks))) add({ kind: "work", member: t.assignee, task: t.id });
    }
    for (const t of tasks) {
      if (!["coding", "review", "testing", "blocked"].includes(t.status)) continue;
      for (const [tester, tests] of Object.entries(t.tests)) if (tests.status !== "written") add({ kind: "tests", member: tester, task: t.id });
    }
  }
  if (state.integration?.triage && (phase === "INTEGRATION" || phase === "ACCEPTANCE")) {
    // Each group whose criteria failed (or that the change is for) adds the tasks that fix its part.
    for (const key of state.integration.triageGroups) add({ kind: "integration_triage", member: leadOf(groups, key || null).name });
  }
  else if (phase === "INTEGRATION" && state.integration) {
    const by = new Set(state.integration.checks.map((c) => c.by));
    const testers = new Set(state.tasks.flatMap((t) => t.testers));
    for (const tester of testers) if (!by.has(tester)) add({ kind: "integration_check", member: tester });
    if (ctx.gates && !by.has("gates")) add({ kind: "gates", task: null });
  }
  if (phase === "APPLY" && state.applyConflict?.resolving) add({ kind: "resolve_apply", member: groups[0]!.lead.name });
  // One merge at a time (the integration branch is one), and one run of the gates (they have one worktree).
  return (["merge", "gates"] as const).reduce((list, kind) => {
    const first = list.find((j) => j.kind === kind);
    const runs = [...ctx.running].some((k) => k.startsWith(`${kind}:`));
    return list.filter((j) => j.kind !== kind || (!runs && j === first));
  }, jobs);
}
