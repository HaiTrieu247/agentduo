import { existsSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import { relPath } from "../agents/types.js";
import type { Attachment } from "../inputs/attachment-types.js";
import { answeredEntries, type ClarificationEntry } from "../clarification/clarification.js";
import type { AgentRole, Backend } from "../config/config.js";
import type { Change } from "../git/git.js";
import type { RepoNoteOutput } from "./outputs.js";
import type { HumanNote, RepoNote, RoleSession, RunState, SessionSlot } from "./state.js";

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

/** `path` relative to the workspace (workspacePath); null unless it names a file or folder that exists there. */
function notePath(raw: string, workspace: string): string | null {
  const path = workspacePath(raw, workspace);
  return path && existsSync(join(workspace, path)) ? path : null;
}

/** `raw` (relative to the workspace, or absolute) as git names it in the workspace: forward slashes, no trailing one; null outside it. */
export function workspacePath(raw: string, workspace: string): string | null {
  let path = raw.trim().replace(/\\/g, "/");
  if (!path) return null;
  if (isAbsolute(path) || /^[a-zA-Z]:\//.test(path)) {
    path = relPath(path, workspace).replace(/\\/g, "/");
    if (isAbsolute(path)) return null;
  }
  path = posix.normalize(path).replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (!path || path === "." || path === ".." || path.startsWith("../")) return null;
  return path;
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
export function touched(path: string, changed: Set<string>): boolean {
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

/** The slot of the session the plan critic and the implementer share (sessionSlot). */
export const SHARED_SESSION = "plan_reviewer+implementer" satisfies SessionSlot;
const SHARING: readonly AgentRole[] = ["plan_reviewer", "implementer"];

/**
 * Where `role`'s session is kept. None when the user's args turn its sessions off (`keeps`): it runs on its own, and
 * continues and records no session. The plan critic and the implementer share one when one CLI plays both, so that
 * the implementer goes on from what the critic read and judged. Every other role, or either of them on its own CLI,
 * keeps its own.
 */
export function sessionSlot(role: AgentRole, agents: Record<AgentRole, Backend>, keeps: boolean): SessionSlot | null {
  if (!keeps) return null;
  return SHARING.includes(role) && agents.plan_reviewer === agents.implementer ? SHARED_SESSION : role;
}

/**
 * The session `role` continues in `slot`. The shared slot's record, or, in a run from before sharing, the role's own
 * session with its own cursors (never the other role's). A role's own session was never given its judge's notes.
 */
function sessionIn(state: RunState, slot: SessionSlot, role: AgentRole): RoleSession | undefined {
  const kept = state.sessions?.[slot];
  if (kept || slot !== SHARED_SESSION) return kept;
  const own = state.sessions?.[role];
  if (!own) return undefined;
  const judge = JUDGES[role];
  const withheld = judge ? (state.repoNotes ?? []).filter((n) => n.role === judge && n.seq <= own.repoNotes).map((n) => n.seq) : [];
  return { ...own, role, withheld };
}

/** What a continued session is told about the run since its last turn. */
export interface Continuation {
  session: RoleSession;
  /** The role of the session's last turn, when it was the other role of the shared slot: this turn switches roles. */
  from?: AgentRole;
  /** The role's latest answer, which the prompt refers to, is in the session (always so in a role's own session). */
  knowsAnswer: boolean;
  /** Files of the workspace that changed since its last turn ended. */
  changed: Change[];
  /** Human notes it has not been given, and their files. */
  notes: HumanNote[];
  attachments: Attachment[];
  /** Repository notes it has not been given (its own are in its session already). */
  repoNotes: RepoNote[];
  /** The plan this turn is about is the one its last turn had. */
  knowsPlan: boolean;
  /** The user's answers to the agents' questions that it was not given yet (its own native ones are in its session already). */
  clarifications: ClarificationEntry[];
}

/** One agent turn of the pipeline: the notes a fresh session gets, and the session to continue instead when there is one. */
export interface Turn {
  repoNotes: RepoNote[];
  /** Keep the session for the role's next turn: the user's args leave the CLI's sessions on. */
  keep: boolean;
  /** Where the session is kept; null when it is not. Absent (older callers): the role's own when kept. */
  slot?: SessionSlot | null;
  continuation: Continuation | null;
  /** How many human notes this turn's prompt has, for the session it leaves. */
  notesGiven: number;
}

/**
 * Plans `role`'s next turn against the workspace `tree`. It continues the session of its slot (sessionSlot; absent:
 * the role's own when `keep`) when the user's args keep sessions, it still runs on that session's CLI, and git can
 * tell what changed since the session's last turn, whichever role took it; otherwise it starts a fresh one.
 * `planHash`: the plan the turn is about (null when it writes a new one). `answer`: the key of the role's latest
 * answer, which its prompt refers to (null: none).
 */
export async function planTurn(o: {
  state: RunState; role: AgentRole; backend: Backend; keep: boolean; slot?: SessionSlot | null; tree: string; planHash: string | null;
  answer?: string | null; changes: TreeChanges;
}): Promise<Turn> {
  const { state } = o;
  const slot = o.slot !== undefined ? o.slot : o.keep ? o.role : null;
  const repoNotes = await visibleRepoNotes(state, o.role, o.tree, o.changes);
  const turn: Turn = { repoNotes, keep: slot !== null, slot, continuation: null, notesGiven: state.humanNotes.length };
  const session = slot === null ? undefined : sessionIn(state, slot, o.role);
  if (!session || session.backend !== o.backend) return turn;
  let changed: Change[];
  try {
    changed = session.tree === o.tree ? [] : await o.changes(session.tree, o.tree);
  } catch {
    return turn; // what the session remembers can no longer be checked: a fresh one
  }
  const notes = state.humanNotes.slice(session.notes);
  const files = notes.flatMap((n) => n.attachments ?? []);
  const withheld = new Set(session.withheld ?? []);
  turn.continuation = {
    session, changed, notes,
    attachments: files.filter((a, i) => files.findIndex((b) => b.id === a.id) === i),
    // The notes it was not given: the newer ones, and those an earlier turn's role could not see (the critic's, the planner's).
    repoNotes: repoNotes.filter((n) => n.seq > session.repoNotes || withheld.has(n.seq)),
    knowsPlan: o.planHash !== null && session.planHash === o.planHash,
    clarifications: answeredEntries(state.clarifications).filter((e) => !(session.clarifications ?? []).includes(e.id)),
    ...(session.role && session.role !== o.role ? { from: session.role } : {}),
    knowsAnswer: !session.answers || o.answer == null || session.answers[o.role] === o.answer,
  };
  return turn;
}

/**
 * Records the session a turn of `role` ran in, once it succeeded, with what it now knows. A call whose CLI named no
 * session leaves none in its slot: the slot's next turn starts fresh. A role whose sessions are not kept leaves no
 * session of its own, and the shared one as it was. In the shared slot, a turn that went on in the session it
 * continued (`resumed`) adds to what that session holds; a fresh one starts the record over.
 */
export function rememberSession(state: RunState, role: AgentRole, r: { sessionId: string | null; backend: Backend; resumed?: boolean }, turn: Turn,
  at: { tree: string; planHash: string | null; reviewed?: string | null; answer?: string | null }): void {
  const slot = !turn.keep ? null : turn.slot !== undefined ? turn.slot : role;
  if (slot === null || !r.sessionId) {
    if (state.sessions) {
      delete state.sessions[role];
      if (slot === SHARED_SESSION) delete state.sessions[SHARED_SESSION];
    }
    return;
  }
  const record: RoleSession = {
    backend: r.backend, id: r.sessionId, tree: at.tree, notes: turn.notesGiven, repoNotes: latestRepoNote(state),
    planHash: at.planHash, reviewed: at.reviewed ?? null,
    // The answers it holds: its prompt gave it those so far, and a question it asked itself was answered in the session.
    // Absent when there are none, as in a record from before questions existed.
    ...(answeredEntries(state.clarifications).length ? { clarifications: answeredEntries(state.clarifications).map((e) => e.id) } : {}),
  };
  if (slot !== SHARED_SESSION) {
    state.sessions = { ...state.sessions, [slot]: record };
    return;
  }
  const went = r.resumed ? turn.continuation?.session : undefined;
  const before = new Set(went?.withheld ?? []);
  const judge = JUDGES[role];
  // The notes of its judge this session has still not been given: those this role could not see, now or before.
  const withheld = judge
    ? (state.repoNotes ?? []).filter((n) => n.role === judge && (!went || n.seq > went.repoNotes || before.has(n.seq))).map((n) => n.seq)
    : [];
  const answers = { ...(went?.answers ?? {}), ...(at.answer ? { [role]: at.answer } : {}) };
  const sessions: Partial<Record<SessionSlot, RoleSession>> = { ...state.sessions, [SHARED_SESSION]: { ...record, role, answers, ...(withheld.length ? { withheld } : {}) } };
  // A run from before sharing: the role's own session is the shared one now, or was replaced by it.
  delete sessions[role];
  state.sessions = sessions;
}
