import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { PermissionDenial } from "../agents/types.js";
import type { BudgetKey, HistoryEntry, HumanReview, Phase } from "../events.js";
import type { Attachment } from "./attachment-types.js";
import type { AgentRole, Backend } from "./config.js";
import type { GateResult } from "./gates.js";
import type { Snapshot } from "./git.js";
import type { Approval, Critique, Finding } from "./outputs.js";

export const STATE_VERSION = 1;

export interface HumanNote {
  at: string;
  phase: Phase;
  note: string;
  /** Files that came with the note, copied into the run; absent in older runs and for notes without files. */
  attachments?: Attachment[];
}

/** A task given earlier in the same chat, and how it ended; later runs are told about it. */
export interface EarlierTask {
  task: string;
  outcome: string;
}

/**
 * Where a run keeps its snapshots. native: the workspace's own git repository (and its refs/agentduo/…), as runs always
 * did. internal: a bare repository agentduo created for this run under its data root (a folder with no git repository
 * of its own), named by `repositoryId`; `gitDir` and `workspace` are what it was created for, checked on every open.
 */
export type RunGit =
  | { mode: "native" }
  | { mode: "internal"; repositoryId: string; workspace: string; gitDir: string };

/**
 * A pipeline role's CLI session, which the role's next call continues, and how far it has been told about the run:
 * that call's prompt gives only what came after. Keyed by config role, so plan sign-off continues the planner's
 * session and no session ever passes from one role to another.
 */
export interface RoleSession {
  backend: Backend;
  id: string;
  /** The workspace tree when its last turn ended: the files changed since are listed in its next turn. */
  tree: string;
  /** How many of the run's human notes it was given. */
  notes: number;
  /** The newest repository note (`seq`) it was given; 0: none. */
  repoNotes: number;
  /** The hash of the plan its last turn had (the one it wrote, critiqued or worked from). */
  planHash: string | null;
  /** Code reviewer: the revision it last reviewed, which its next diff starts from. */
  reviewed: string | null;
}

/**
 * A fact an agent of the run checked in the repository (its output's `repo_notes`), shared with the roles after it:
 * `tree` is the workspace when the agent's turn ended, and a note whose path changed since is no longer given.
 */
export interface RepoNote {
  seq: number;
  role: AgentRole;
  backend: Backend;
  round: number;
  path: string;
  note: string;
  tree: string;
}

/**
 * A run's budget: its limits (null: none), fixed when the run starts like its round limits, and raised only when you
 * let a run that reached one go on; and the limits it has already warned about (at 80%) since they were last set.
 */
export interface RunBudget {
  limits: Record<BudgetKey, number | null>;
  warned: BudgetKey[];
}

/** One question of the chat and the answer it got. */
export interface Exchange {
  backend: "codex" | "claude";
  question: string;
  answer: string;
  /**
   * /discuss: the other agent of the discussion this answer came from. The answer is Codex's synthesis of the
   * discussion, or the answerer's latest version when the synthesis failed (before synthesis: its agreed or final one).
   */
  discussedWith?: "codex" | "claude";
  /** The files the question came with: later prompts list them (their paths), never attach them again. */
  attachments?: Attachment[];
}

/**
 * The conversation a run was started from, as it stood then: the answered exchanges that fit the context budget,
 * oldest first, and how many older ones were left out.
 */
export interface ConversationContext {
  exchanges: Exchange[];
  omitted: number;
}

export interface RunState {
  version: number;
  taskId: string;
  task: string;
  phase: Phase;
  createdAt: string;
  updatedAt: string;
  limits: { planningRounds: number; reviewRounds: number };
  planningRound: number;
  planVersion: number;
  planHash: string | null;
  finalPlanVersion: number | null;
  finalPlanHash: string | null;
  planFeedback: { critique?: Critique; approval?: Approval } | null;
  implRound: number;
  base: (Snapshot & { head: string | null; branch: string | null }) | null;
  lastSnapshot: Snapshot | null;
  lastGates: GateResult[] | null;
  consecutiveGateFailures: number;
  openFindings: Finding[];
  lastImplementation: { round: number; summary: string | null; status: string | null; permissionDenials: PermissionDenial[] } | null;
  humanReview: HumanReview | null;
  humanNotes: HumanNote[];
  /** Notable things the run saw but did not act on (files changed outside the workspace, permission denials…). */
  warnings: string[];
  /** The directory the run works in; absent in runs created before v2. */
  workspace?: string;
  /** Where its snapshots are; absent until the run first prepares them, and in older runs (which are native). */
  git?: RunGit;
  /** Earlier tasks of the chat this run was started from (empty outside a chat). */
  earlier?: EarlierTask[];
  /** The chat's conversation when this run started; absent outside a chat and in older runs. */
  conversationContext?: ConversationContext;
  /** Files attached to the task, copied into the run (so a resume needs neither the originals nor the chat); absent: none. */
  attachments?: Attachment[];
  /** Each role's session that its next call continues; absent in older runs and while none is kept. */
  sessions?: Partial<Record<AgentRole, RoleSession>>;
  /** What the agents recorded about the repository, oldest first, at most MAX_REPO_NOTES; absent: none yet. */
  repoNotes?: RepoNote[];
  /** The cost the CLIs reported (Claude's); calls that reported none are counted in `unpricedCalls`. */
  costUsd: number;
  tokens: number;
  /** Agent CLI processes started, retries and resumed sessions included; absent in older runs (0). */
  agentCalls?: number;
  /** Of those, the calls whose CLI reported no cost (Codex never does): `costUsd` leaves them out. */
  unpricedCalls?: number;
  /** Seconds the run spent in its steps (agents and gates), not waiting for a decision; absent in older runs (0). */
  activeSec?: number;
  /** Absent in runs created before budgets, and in runs with none set. */
  budget?: RunBudget;
  step: number;
  inProgress: { phase: Phase; startedAt: string } | null;
  history: HistoryEntry[];
}

const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");

export function nowIso(d = new Date()): string {
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

export function stamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function slugify(text: string, maxLen = 40): string {
  const ascii = text.replace(/đ/g, "d").replace(/Đ/g, "D").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x00-\x7f]/g, "");
  const slug = ascii.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return slug.slice(0, maxLen).replace(/-+$/, "") || "task";
}

export function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export class LockError extends Error {
  override name = "LockError";
}

/** Create `path` exclusively holding our pid; a lock left by a dead process is reclaimed. */
function acquireLock(path: string, busy: (pid: number) => string): void {
  const take = () => {
    const fd = openSync(path, "wx");
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  };
  try {
    take();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const pid = Number(readFileSync(path, "utf8").trim());
    if (pid && pidAlive(pid)) throw new LockError(busy(pid));
    unlinkSync(path);
    take();
  }
}

/** Creates the runs dir with a `.gitignore` of `*`, so run data stays out of git (and out of snapshots) wherever it lives. */
export function ensureRunsDir(runsDir: string): void {
  mkdirSync(runsDir, { recursive: true });
  const ignore = join(runsDir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
}

export const workspaceBusy = (pid: number): string =>
  `another agentduo run is active in this workspace (pid ${pid}); wait for it to finish or stop it first`;

/** One active run per workspace: concurrent runs in one directory would review each other's edits. */
export function acquireWorkspaceLock(runsDir: string): () => void {
  ensureRunsDir(runsDir);
  const path = join(runsDir, ".lock");
  acquireLock(path, workspaceBusy);
  return () => {
    try {
      unlinkSync(path);
    } catch {
      // already removed
    }
  };
}

/** The live process holding the workspace lock, or null; only looks, never takes or reclaims it. */
export function workspaceLockHolder(runsDir: string): number | null {
  try {
    const pid = Number(readFileSync(join(runsDir, ".lock"), "utf8").trim());
    return pid && pidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function newState(taskId: string, task: string, limits: { max_planning_rounds: number; max_review_rounds: number }): RunState {
  const ts = nowIso();
  return {
    version: STATE_VERSION, taskId, task, phase: "PLAN", createdAt: ts, updatedAt: ts,
    limits: { planningRounds: limits.max_planning_rounds, reviewRounds: limits.max_review_rounds },
    planningRound: 1, planVersion: 0, planHash: null, finalPlanVersion: null, finalPlanHash: null, planFeedback: null,
    implRound: 0, base: null, lastSnapshot: null, lastGates: null, consecutiveGateFailures: 0, openFindings: [],
    lastImplementation: null, humanReview: null, humanNotes: [], warnings: [], costUsd: 0, tokens: 0, step: 0, inProgress: null, history: [],
  };
}

/** One run's directory: state.json (rewritten atomically after every step) plus all artifacts and logs. */
export class RunStore {
  static readonly LATEST = "LATEST";
  readonly dir: string;
  private locked = false;

  constructor(readonly runsDir: string, readonly taskId: string) {
    this.dir = join(runsDir, taskId);
  }

  static create(runsDir: string, task: string, limits: { max_planning_rounds: number; max_review_rounds: number },
    now = new Date()): { store: RunStore; state: RunState } {
    const base = `${stamp(now)}-${slugify(task)}`;
    let id = base;
    for (let n = 2; existsSync(join(runsDir, id)); n++) id = `${base}-${n}`;
    const store = new RunStore(runsDir, id);
    mkdirSync(join(store.dir, "logs"), { recursive: true });
    const state = newState(id, task, limits);
    store.saveState(state);
    atomicWrite(join(runsDir, RunStore.LATEST), `${id}\n`);
    return { store, state };
  }

  static open(runsDir: string, taskId?: string): RunStore {
    let id = taskId;
    if (!id || id === "latest") {
      const latest = join(runsDir, RunStore.LATEST);
      if (!existsSync(latest)) throw new Error(`no runs found in ${runsDir}`);
      id = readFileSync(latest, "utf8").trim();
    }
    const store = new RunStore(runsDir, id);
    if (!existsSync(store.path("state.json"))) throw new Error(`run '${id}' not found in ${runsDir}`);
    return store;
  }

  static list(runsDir: string): RunState[] {
    if (!existsSync(runsDir)) return [];
    return readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(runsDir, d.name, "state.json")))
      .map((d) => d.name).sort()
      .flatMap((name) => {
        try {
          return [new RunStore(runsDir, name).loadState()];
        } catch {
          return [];
        }
      });
  }

  lock(): void {
    acquireLock(this.path("lock"), (pid) => `run ${this.taskId} is already being processed by pid ${pid}`);
    this.locked = true;
  }

  unlock(): void {
    if (!this.locked) return;
    try {
      unlinkSync(this.path("lock"));
    } catch {
      // already removed
    }
    this.locked = false;
  }

  loadState(): RunState {
    const state = JSON.parse(readFileSync(this.path("state.json"), "utf8")) as RunState;
    if (state.version !== STATE_VERSION) throw new Error(`unsupported state version ${state.version}`);
    return state;
  }

  saveState(state: RunState): void {
    state.updatedAt = nowIso();
    this.writeJson("state.json", state);
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  exists(name: string): boolean {
    return existsSync(this.path(name));
  }

  writeJson(name: string, data: unknown): string {
    const path = this.path(name);
    atomicWrite(path, `${JSON.stringify(data, null, 2)}\n`);
    return path;
  }

  readJson<T = unknown>(name: string): T {
    return JSON.parse(readFileSync(this.path(name), "utf8")) as T;
  }

  writeText(name: string, text: string): string {
    const path = this.path(name);
    atomicWrite(path, text);
    return path;
  }

  readText(name: string): string {
    return readFileSync(this.path(name), "utf8");
  }

  appendText(name: string, text: string): void {
    mkdirSync(dirname(this.path(name)), { recursive: true });
    appendFileSync(this.path(name), text);
  }

  appendEvent(event: Record<string, unknown>): void {
    this.appendText("events.jsonl", `${JSON.stringify({ at: nowIso(), ...event })}\n`);
  }
}
