import { existsSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import { relPath } from "../agents/types.js";
import type { Attachment } from "./attachment-types.js";
import type { AgentRole, Backend } from "./config.js";
import type { Change } from "./git.js";
import type { RepoNoteOutput } from "./outputs.js";
import type { HumanNote, RepoNote, RoleSession, RunState } from "./state.js";

/**
 * What the agents of a run share besides the artifacts they hand on (plan, critique, report, diff, review): the
 * repository notes, and each role's own CLI session. See docs/superpowers/specs/2026-11-03-agentduo-context-sharing-design.md.
 */

/** The most notes a run keeps (the oldest go first), one agent turn may leave, and the length of one. */
export const MAX_REPO_NOTES = 60;
export const MAX_NOTES_PER_TURN = 12;
export const MAX_NOTE_CHARS = 300;

/**
 * Whose notes a role never gets: the author of the work it judges, so that its judgement stays its own. The plan
 * critic checks the planner's assumptions in the code; the code reviewer checks the implementer's work.
 */
const JUDGES: Partial<Record<AgentRole, AgentRole>> = { plan_reviewer: "planner", code_reviewer: "implementer" };

/** What diffs two workspace trees (Git.nameStatus): paths relative to the workspace. */
export type TreeChanges = (from: string, to: string) => Promise<Change[]>;

/**
 * The notes of one turn that can be kept: one line each, cut to MAX_NOTE_CHARS, about a file or folder that exists in
 * the workspace (named relative to it), each once, at most MAX_NOTES_PER_TURN. A note about nothing in particular, a
 * path outside the workspace or one that does not exist would never be checked against later changes, so it is dropped.
 */
export function acceptRepoNotes(notes: RepoNoteOutput[] | undefined, workspace: string): Array<{ path: string; note: string }> {
  const kept: Array<{ path: string; note: string }> = [];
  const seen = new Set<string>();
  for (const n of Array.isArray(notes) ? notes : []) {
    if (kept.length >= MAX_NOTES_PER_TURN) break;
    if (!n || typeof n.path !== "string" || typeof n.note !== "string") continue;
    const path = notePath(n.path, workspace);
    const note = n.note.replace(/\s+/g, " ").trim();
    if (!path || !note) continue;
    const text = note.length > MAX_NOTE_CHARS ? `${note.slice(0, MAX_NOTE_CHARS - 1)}…` : note;
    const key = `${path}\n${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ path, note: text });
  }
  return kept;
}

/** `path` relative to the workspace, with forward slashes and no trailing one; null when it is not a path in it. */
function notePath(raw: string, workspace: string): string | null {
  let path = raw.trim().replace(/\\/g, "/");
  if (!path) return null;
  if (isAbsolute(path) || /^[a-zA-Z]:\//.test(path)) {
    path = relPath(path, workspace).replace(/\\/g, "/");
    if (isAbsolute(path)) return null;
  }
  path = posix.normalize(path).replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (!path || path === "." || path === ".." || path.startsWith("../")) return null;
  return existsSync(join(workspace, path)) ? path : null;
}

/** Appends a turn's accepted notes with the tree they were written against; the run keeps the newest MAX_REPO_NOTES. */
export function addRepoNotes(state: RunState, from: { role: AgentRole; backend: Backend; round: number; tree: string },
  notes: Array<{ path: string; note: string }>): void {
  if (!notes.length) return;
  const list = state.repoNotes ?? [];
  let seq = latestRepoNote(state);
  for (const n of notes) list.push({ seq: ++seq, ...from, ...n });
  state.repoNotes = list.slice(-MAX_REPO_NOTES);
}

/** The newest note's `seq`; 0 when there is none. */
export function latestRepoNote(state: RunState): number {
  return state.repoNotes?.at(-1)?.seq ?? 0;
}

/** Whether `path` (a file or folder) or anything under it is among `changed`. */
function touched(path: string, changed: Set<string>): boolean {
  if (changed.has(path)) return true;
  for (const p of changed) if (p.startsWith(`${path}/`)) return true;
  return false;
}

/**
 * The notes `role` may be given now, oldest first: not its judge's (JUDGES), and still true of the workspace, that is
 * no file under its path changed between the tree it was written against and `tree`. A tree git cannot diff any more
 * (pruned, or from a repository that was replaced) takes its notes with it.
 */
export async function visibleRepoNotes(state: RunState, role: AgentRole, tree: string, changes: TreeChanges): Promise<RepoNote[]> {
  const hidden = JUDGES[role];
  const candidates = (state.repoNotes ?? []).filter((n) => n.role !== hidden);
  const changedSince = new Map<string, Set<string> | null>();
  for (const anchor of new Set(candidates.map((n) => n.tree))) {
    if (anchor === tree) {
      changedSince.set(anchor, new Set());
      continue;
    }
    try {
      changedSince.set(anchor, new Set((await changes(anchor, tree)).map(([, path]) => path)));
    } catch {
      changedSince.set(anchor, null);
    }
  }
  return candidates.filter((n) => {
    const changed = changedSince.get(n.tree);
    return !!changed && !touched(n.path, changed);
  });
}

/** What a continued session is told about the run since its last turn. */
export interface Continuation {
  session: RoleSession;
  /** Files of the workspace that changed since its last turn ended. */
  changed: Change[];
  /** Human notes it has not been given, and their files. */
  notes: HumanNote[];
  attachments: Attachment[];
  /** Repository notes it has not been given (its own are in its session already). */
  repoNotes: RepoNote[];
  /** The plan this turn is about is the one its last turn had. */
  knowsPlan: boolean;
}

/** One agent turn of the pipeline: the notes a fresh session gets, and the session to continue instead when there is one. */
export interface Turn {
  repoNotes: RepoNote[];
  /** Keep the session for the role's next turn: the user's args leave the CLI's sessions on. */
  keep: boolean;
  continuation: Continuation | null;
  /** How many human notes this turn's prompt has, for the session it leaves. */
  notesGiven: number;
}

/**
 * Plans `role`'s next turn against the workspace `tree`. It continues the role's session when the user's args keep
 * sessions, the role still runs on the same CLI, and git can tell what changed since the session's last turn;
 * otherwise it starts a fresh one. `planHash`: the plan the turn is about (null when it writes a new one).
 */
export async function planTurn(o: {
  state: RunState; role: AgentRole; backend: Backend; keep: boolean; tree: string; planHash: string | null; changes: TreeChanges;
}): Promise<Turn> {
  const { state } = o;
  const repoNotes = await visibleRepoNotes(state, o.role, o.tree, o.changes);
  const turn: Turn = { repoNotes, keep: o.keep, continuation: null, notesGiven: state.humanNotes.length };
  const session = state.sessions?.[o.role];
  if (!o.keep || !session || session.backend !== o.backend) return turn;
  let changed: Change[];
  try {
    changed = session.tree === o.tree ? [] : await o.changes(session.tree, o.tree);
  } catch {
    return turn; // what the session remembers can no longer be checked: a fresh one
  }
  const notes = state.humanNotes.slice(session.notes);
  const files = notes.flatMap((n) => n.attachments ?? []);
  turn.continuation = {
    session, changed, notes,
    attachments: files.filter((a, i) => files.findIndex((b) => b.id === a.id) === i),
    repoNotes: repoNotes.filter((n) => n.seq > session.repoNotes),
    knowsPlan: o.planHash !== null && session.planHash === o.planHash,
  };
  return turn;
}

/**
 * Records the session a turn of `role` ran in, once it succeeded, with what it now knows. A call whose CLI named no
 * session, or whose sessions are not kept, leaves none: the role's next turn starts fresh.
 */
export function rememberSession(state: RunState, role: AgentRole, r: { sessionId: string | null; backend: Backend }, turn: Turn,
  at: { tree: string; planHash: string | null; reviewed?: string | null }): void {
  if (!turn.keep || !r.sessionId) {
    if (state.sessions) delete state.sessions[role];
    return;
  }
  state.sessions = {
    ...state.sessions,
    [role]: {
      backend: r.backend, id: r.sessionId, tree: at.tree, notes: turn.notesGiven, repoNotes: latestRepoNote(state),
      planHash: at.planHash, reviewed: at.reviewed ?? null,
    },
  };
}
