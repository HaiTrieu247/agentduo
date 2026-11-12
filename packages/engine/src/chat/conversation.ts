import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ATTACHMENT_LIMITS, formatBytes, type Attachment } from "../inputs/attachment-types.js";
import { AttachmentError, attachmentFile, AttachmentStore } from "../inputs/attachments.js";
import {
  clarifiedPairs, ledgerAnswer, ledgerClose, ledgerOpen, type ClarificationAnswer, type ClarificationEntry, type ClarificationRequest, type ClarificationStatus,
  type ClarifiedPair,
} from "../clarification/clarification.js";
import type { Backend } from "../config/config.js";
import { taggedPaths } from "../inputs/mentions.js";
import * as prompts from "../workflow/prompts.js";
import { acquireLockFile, atomicWrite, ensureRunsDir, LockError, stamp, type ConversationContext, type EarlierTask, type Exchange } from "../workflow/state.js";
import { conversationBusy, conversationHolder, conversationLockPath } from "../workflow/lease.js";
import type { DiscussionPlace, DiscussionStep, TurnStatus, Verdict } from "../events.js";

/** How much of the conversation (questions and answers) a prompt carries; older exchanges go first, whole. */
export const CONTEXT_CHARS = 120_000;

export interface Turn {
  id: string;
  backend: Backend;
  question: string;
  /** Null until the turn is over, and for a turn that failed or was stopped. */
  answer: string | null;
  status: TurnStatus | "running";
  logPrefix: string;
  /** A turn of a /discuss: its answer is a draft or a review, never an exchange of its own. */
  discussion?: DiscussionPlace;
  /** The files the question came with; every step of a discussion gets its question's. */
  attachments?: Attachment[];
  /** Prompt containing only context not already in this backend's session. */
  continuation?: string;
}

/** A /discuss under way: who answers and who reviews, the conversation as it stood when it began, and what was said. */
export interface Discussion {
  id: string;
  answerer: Backend;
  critic: Backend;
  question: string;
  maxRounds: number;
  context: ConversationContext;
  messages: prompts.DiscussionMessage[];
  attachments: Attachment[];
}

interface ConversationSession {
  id: string;
  exchanges: number;
  earlier: number;
  /** `clarified`: how many of the discussion's answered questions its prompts (or its own asking) gave it. */
  discussion?: { id: string; messages: number; clarified?: number };
}

/** What a conversation keeps on disk to go on after a restart: what later prompts carry, and how to show it in a list. */
export interface ConversationRecord {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Who plain messages went to last; null until the chat said. */
  recipient: Backend | null;
  /** Turns started so far, so the logs of a reopened conversation go on from there. */
  turns: number;
  exchanges: Exchange[];
  earlier: EarlierTask[];
  sessions?: Partial<Record<Backend, ConversationSession>>;
  /**
   * The questions the agents asked the user in this conversation, and their answers, in the order asked (saved when asked
   * and when answered). Absent in a conversation from before questions: none were asked.
   */
  clarifications?: ClarificationEntry[];
  /** The process that saved it last (`duo`, an extension's or the desktop's worker); absent in older conversations. */
  writer?: number;
}

export type ConversationSummary = Pick<ConversationRecord, "id" | "title" | "createdAt" | "updatedAt"> & {
  /** The live process working in it now (an answer, a discussion, a run), or null. */
  inUseBy: number | null;
  /** When the user archived it; null: it is not archived. */
  archivedAt: string | null;
};

/** What archiving, restoring or deleting a conversation could not do, said for the user. */
export class ConversationError extends Error {
  override name = "ConversationError";
}

const RECORD = "conversation.json";
/**
 * The mark of an archived conversation: a file of its own beside the record (never in it), so that no window's save of
 * the record drops it. Its text is when it was archived.
 */
const ARCHIVED = "archived";
/** What an exchange recovered from a turn that never ended says its question was (the turn itself was not saved). */
const UNFINISHED_QUESTION = "(the message of a turn that did not finish; it was not kept)";
const conversationsDir = (runsDir: string) => join(runsDir, "conversations");

/** Where conversation `id` keeps its record. */
export const conversationFile = (runsDir: string, id: string): string => join(conversationsDir(runsDir), id, RECORD);

/** The record of conversation `id` as saved, or null (none, or not one agentduo can read). Only reads. */
export function readConversation(runsDir: string, id: string): ConversationRecord | null {
  return readRecord(conversationFile(runsDir, id));
}

function readRecord(file: string): ConversationRecord | null {
  try {
    const r = JSON.parse(readFileSync(file, "utf8")) as ConversationRecord;
    return r && r.version === 1 && typeof r.id === "string" && Array.isArray(r.exchanges) ? r : null;
  } catch {
    return null;
  }
}

/**
 * The conversations of a workspace that said something, the most recently changed first: those in use (the default),
 * the archived ones, or all.
 */
export function listConversations(runsDir: string, which: "active" | "archived" | "all" = "active"): ConversationSummary[] {
  const dir = conversationsDir(runsDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name): ConversationSummary[] => {
    const r = readRecord(join(dir, name, RECORD));
    if (!r || r.id !== name) return [];
    const archivedAt = archiveTime(runsDir, r.id);
    if (which === "active" ? archivedAt : which === "archived" ? !archivedAt : false) return [];
    return [{ id: r.id, title: r.title, createdAt: r.createdAt, updatedAt: r.updatedAt, inUseBy: conversationHolder(runsDir, r.id), archivedAt }];
  }).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

const archiveMark = (runsDir: string, id: string) => join(conversationsDir(runsDir), id, ARCHIVED);

/** When conversation `id` was archived, or null: it is not. */
function archiveTime(runsDir: string, id: string): string | null {
  const file = archiveMark(runsDir, id);
  try {
    const text = readFileSync(file, "utf8").trim();
    return Number.isNaN(Date.parse(text)) ? statSync(file).mtime.toISOString() : text;
  } catch {
    return null;
  }
}

export const isArchivedConversation = (runsDir: string, id: string): boolean => archiveTime(runsDir, id) !== null;

const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Conversation `id`'s record, which must be saved: a name that is not one, or nothing saved by it, is an error. */
function savedRecord(runsDir: string, id: string): ConversationRecord {
  const r = CONVERSATION_ID.test(id) && !id.includes("..") ? readConversation(runsDir, id) : null;
  if (!r || r.id !== id) throw new ConversationError(`no saved conversation '${id}'`);
  return r;
}

/**
 * Archives conversation `id`: it leaves the lists and `latest`, whole (its exchanges, logs, files); new work in it, or
 * restoreConversation, brings it back. Refused while an agentduo works in it (its answer, run or wait for the user).
 */
export function archiveConversation(runsDir: string, id: string, now = new Date()): void {
  savedRecord(runsDir, id);
  const holder = conversationHolder(runsDir, id);
  if (holder) throw new ConversationError(`${conversationBusy(holder)}; archive it once that is done`);
  if (!isArchivedConversation(runsDir, id)) atomicWrite(archiveMark(runsDir, id), `${now.toISOString()}\n`);
}

/** Puts archived conversation `id` back in the lists. */
export function restoreConversation(runsDir: string, id: string): void {
  savedRecord(runsDir, id);
  rmSync(archiveMark(runsDir, id), { force: true });
}

/**
 * Deletes conversation `id` and everything under it (its record, view, logs and attached files; runs keep their own
 * copies), under its lock: refused while an agentduo works in it. A window that still has it open never writes it back
 * (`Conversation.deleted`).
 */
export function deleteConversation(runsDir: string, id: string): void {
  savedRecord(runsDir, id);
  let release: () => void;
  try {
    release = acquireLockFile(conversationLockPath(runsDir, id), conversationBusy);
  } catch (e) {
    if (e instanceof LockError) throw new ConversationError(`${e.message}; delete it once that is done`);
    throw e;
  }
  // Out of the way at once (a rename), then removed: no window sees half a conversation.
  const trash = join(conversationsDir(runsDir), `.deleted-${randomBytes(6).toString("hex")}`);
  try {
    renameSync(join(conversationsDir(runsDir), id), trash);
  } finally {
    release();
  }
  rmSync(trash, { recursive: true, force: true });
}

let counter = 0;

/** An exchange as prompts and runs carry it: its id is only for the windows that show the conversation. */
const withoutId = ({ id: _id, ...e }: Exchange): Exchange => e;

/**
 * The chat's conversation with both agents. Only answered turns are context for later prompts; failed and stopped
 * ones are shown, not repeated. A discussion is context only through its final answer, given by the agent that wrote
 * it (Codex for a synthesis) and marked as discussed with the other. It lives under <runsDir>/conversations/<id>/: its logs, and once
 * something was said its conversation.json, from which `open` carries it on (the extension's tabs do, after a reload).
 * That directory has no state.json, so it is never a run and never the latest run.
 */
export class Conversation {
  readonly id: string;
  readonly dir: string;
  private readonly turns: Turn[] = [];
  /** What later prompts carry, in the order it was said. */
  private readonly exchanges: Exchange[] = [];
  private readonly discussions = new Map<string, Discussion>();
  private discussed = 0;
  private sessions: Partial<Record<Backend, ConversationSession>> = {};
  /** Turns started before this process: the logs of a reopened conversation number on from them. */
  private before = 0;
  private name = "";
  private to: Backend | null = null;
  private readonly done: EarlierTask[] = [];
  /** What the agents asked the user in this conversation, and the answers. */
  private readonly asked: ClarificationEntry[] = [];
  private createdAt: string;
  private readonly clock: () => Date;
  /** The copies of the files attached in this conversation. */
  readonly files: AttachmentStore;
  /** Files waiting to go with the next message, in the order they were attached. */
  private waiting: Attachment[] = [];
  /** Where an attachment's copy is, for prompts. */
  readonly locate: prompts.Locate;

  constructor(private readonly runsDir: string, o: { id?: string; clock?: () => Date } = {}) {
    this.clock = o.clock ?? (() => new Date());
    const now = this.clock();
    this.id = o.id ?? `${stamp(now)}-chat-${process.pid}-${++counter}`;
    this.dir = join(conversationsDir(runsDir), this.id);
    this.createdAt = now.toISOString();
    this.files = new AttachmentStore(runsDir, this.dir);
    this.locate = (a) => attachmentFile(runsDir, a);
  }

  /** The conversation `id` of this workspace as it was saved, or a new one by that id. Only reads. */
  static open(runsDir: string, id: string, clock?: () => Date): Conversation {
    const c = new Conversation(runsDir, { id, clock });
    const r = c.read();
    // While another agentduo works in it, a question it asks is still open there.
    if (r) c.load(r, !conversationHolder(runsDir, id));
    return c;
  }

  /** The record's file as this process last read or wrote it (time and size), to tell when another process saved it. */
  private seen: string | null = null;
  /** The record was on disk when this process last read or wrote it. */
  private persisted = false;

  /** It was saved, and its record is gone: another window deleted it (deleteConversation). Nothing writes it back. */
  get deleted(): boolean {
    return this.persisted && !existsSync(join(this.dir, RECORD));
  }

  private fileStamp(): string | null {
    try {
      const st = statSync(join(this.dir, RECORD));
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  }

  /** The saved record; what it was is noted first, so a save that lands while it is read is seen as a change next time. */
  private read(): ConversationRecord | null {
    this.seen = this.fileStamp();
    const r = readRecord(join(this.dir, RECORD));
    if (r) this.persisted = true;
    return r;
  }

  /**
   * Takes on a saved record. `settle`: nobody else works in the conversation, so a question still open was asked by a
   * process that is gone (its call ended, nobody can answer it now), and answers given in a turn that never ended are
   * passed on.
   */
  private load(r: ConversationRecord, settle: boolean): void {
    this.name = r.title;
    this.to = r.recipient;
    this.before = r.turns;
    this.createdAt = r.createdAt;
    this.exchanges.splice(0, this.exchanges.length, ...r.exchanges);
    this.done.splice(0, this.done.length, ...r.earlier);
    this.sessions = r.sessions ?? {};
    this.asked.splice(0, this.asked.length, ...(r.clarifications ?? []).map((e): ClarificationEntry => (settle && e.status === "pending" ? { ...e, status: "interrupted", closedAt: e.at } : e)));
    if (settle) this.recoverAnswers();
  }

  /** Another process saved the conversation since this one last read or wrote it. */
  changedOnDisk(): boolean {
    return this.fileStamp() !== this.seen;
  }

  /**
   * Reads the conversation again, as another agentduo (`duo`, an extension's or the desktop's) may have saved it since:
   * its exchanges, tasks, title, recipient, sessions and questions. The files waiting to be sent from here stay.
   * `settle`: this process holds the conversation now (packages/engine/src/workflow/lease.ts), as before new work.
   * Returns the answered exchanges it did not have; nothing while a turn or a discussion of it runs here.
   */
  reload(o: { settle?: boolean } = {}): Exchange[] {
    if (this.turns.some((t) => t.status === "running") || this.discussions.size) return [];
    const r = this.read();
    if (!r || r.id !== this.id) return [];
    const ids = new Set(this.exchanges.flatMap((e) => (e.id ? [e.id] : [])));
    const count = this.exchanges.length;
    this.turns.length = 0;
    this.load(r, !!o.settle);
    return this.exchanges.filter((e, i) => !e.unfinished && (e.id ? !ids.has(e.id) : i >= count));
  }

  /** The agents' sessions the next calls continue: at least one is kept. */
  get sessionsKept(): boolean {
    return Object.keys(this.sessions).length > 0;
  }

  /** What was answered in the conversation so far, oldest first (a reopened conversation shows it). */
  get history(): Exchange[] {
    return this.exchanges.filter((e) => !e.unfinished);
  }

  /** What the conversation is about, for its tab and the list: its first question, task or discussion. */
  get title(): string {
    return this.name;
  }

  set title(text: string) {
    this.name = text;
    this.save();
  }

  get recipient(): Backend | null {
    return this.to;
  }

  set recipient(backend: Backend | null) {
    this.to = backend;
    this.save();
  }

  /** The pipeline tasks of this conversation, and what came of them. */
  get earlier(): EarlierTask[] {
    return [...this.done];
  }

  addEarlier(task: EarlierTask): void {
    this.done.push(task);
    this.save();
  }

  /** Writes conversation.json once there is something to keep; an empty conversation leaves no file. */
  private save(): void {
    if (!this.name && !this.exchanges.length && !this.done.length) return;
    if (this.deleted) return;
    const record: ConversationRecord = {
      version: 1, id: this.id, title: this.name, createdAt: this.createdAt, updatedAt: this.clock().toISOString(), recipient: this.to,
      turns: this.before + this.turns.length, exchanges: this.exchanges, earlier: this.done, sessions: this.sessions,
      ...(this.asked.length ? { clarifications: this.asked } : {}), writer: process.pid,
    };
    ensureRunsDir(this.runsDir);
    mkdirSync(this.dir, { recursive: true });
    atomicWrite(join(this.dir, RECORD), `${JSON.stringify(record, null, 2)}\n`);
    this.seen = this.fileStamp();
    this.persisted = true;
  }

  /**
   * The session `backend`'s call continues, taken off the record until keepSession says what the call ended with: a
   * process killed meanwhile leaves no session behind that holds a turn the conversation never recorded.
   */
  takeSession(backend: Backend): string | undefined {
    const id = this.sessions[backend]?.id;
    if (id) {
      delete this.sessions[backend];
      this.save();
    }
    return id;
  }

  /** Commit only successful calls; failed or interrupted sessions may contain unseen partial work. */
  keepSession(turn: Turn, id: string | null, earlier: number): void {
    if (!id) delete this.sessions[turn.backend];
    else {
      const d = turn.discussion && this.discussions.get(turn.discussion.id);
      const clarified = d ? this.discussionPairs(d.id).length : 0;
      this.sessions[turn.backend] = {
        id, exchanges: this.exchanges.length, earlier,
        // What the user answered during the discussion is in this session: in a prompt it was given, or in a question it asked itself.
        ...(d ? { discussion: { id: d.id, messages: d.messages.length, ...(clarified ? { clarified } : {}) } } : {}),
      };
    }
    this.save();
  }

  /** The exchanges `session` has not seen, within the budget; omitted counts those it never saw that do not fit. */
  private newContext(session: ConversationSession): ConversationContext {
    const context = this.context();
    return { exchanges: this.exchanges.slice(Math.max(session.exchanges, context.omitted)).map(withoutId), omitted: Math.max(0, context.omitted - session.exchanges) };
  }

  get logDir(): string {
    return join(this.dir, "logs");
  }

  // ------------------------------------------------------------------ questions the agents asked the user
  /** The questions asked in this conversation, with their answers, oldest first. */
  get clarifications(): readonly ClarificationEntry[] {
    return this.asked;
  }

  /** The entry still waiting for the user for this request id and call, if any. */
  pendingClarification(id: string): ClarificationEntry | null {
    return this.asked.find((e) => e.id === id && e.status === "pending") ?? null;
  }

  /** The answered questions of discussion `id`, as pairs, in the order asked. */
  private discussionPairs(id: string) {
    return clarifiedPairs(this.asked.filter((e) => e.discussionId === id));
  }

  /**
   * An agent of one of this conversation's turns asks the user: saved now, before anyone can answer. Null when the request
   * is not for a turn of this conversation (another chat's, or a pipeline's), so a shared event bus never mixes them.
   */
  clarificationAsked(request: ClarificationRequest): ClarificationEntry | null {
    const turn = request.turnId ? this.turns.find((t) => t.id === request.turnId) : undefined;
    if (!turn) return null;
    const entry = ledgerOpen(this.asked, { ...request, ...(turn.discussion ? { discussionId: turn.discussion.id } : {}) });
    this.save();
    return entry;
  }

  /** The user's answers to request `id`, saved the moment they are given; false (nothing changes) for an old, duplicate or foreign one. */
  clarificationAnswered(id: string, callId: string | undefined, answers: ClarificationAnswer[]): boolean {
    if (!ledgerAnswer(this.asked, id, callId, answers, this.clock().toISOString())) return false;
    this.save();
    return true;
  }

  /** Request `id` ended without an answer (dismissed, or its call ended first). False when it is not waiting. */
  clarificationClosed(id: string, callId: string | undefined, status: Exclude<ClarificationStatus, "pending" | "answered">): boolean {
    if (!ledgerClose(this.asked, id, status, this.clock().toISOString(), callId)) return false;
    this.save();
    return true;
  }

  /**
   * The answered, not yet carried entries that `match`, as pairs; they are marked carried. An exchange takes them from here
   * when its turn (or discussion) ends, so each answer is passed on once, however the turn ended.
   */
  private settle(match: (e: ClarificationEntry) => boolean): ClarifiedPair[] {
    const mine = this.asked.filter((e) => e.status === "answered" && !e.settled && match(e));
    for (const e of mine) e.settled = true;
    return clarifiedPairs(mine);
  }

  /**
   * A conversation reopened: answers given in a turn whose process went before the turn ended are in no exchange. They become
   * one each (the turn's question is not kept), so later prompts, and the other agent, still have what the user answered.
   */
  private recoverAnswers(): void {
    const groups = new Map<string, ClarificationEntry>();
    for (const e of this.asked) if (e.status === "answered" && !e.settled) groups.set(e.discussionId ?? e.turnId ?? e.id, groups.get(e.discussionId ?? e.turnId ?? e.id) ?? e);
    for (const [key, first] of groups) {
      const clarified = this.settle((e) => (e.discussionId ?? e.turnId ?? e.id) === key);
      this.exchanges.push({ id: key, backend: first.agent, question: UNFINISHED_QUESTION, answer: "", unfinished: true, clarified });
    }
  }

  // ------------------------------------------------------------------ attachments
  /**
   * For the chat that takes the conversation on: files an earlier process had waiting to be sent (it crashed, or was
   * killed) are removed, since they were never sent and nothing shows them now; files that were sent stay.
   */
  recoverFiles(): number {
    return this.files.recover();
  }

  /** The files waiting to go with the next message. */
  get pending(): Attachment[] {
    return [...this.waiting];
  }

  /** A copy of the file at `source` waits to go with the next message; refused past a message's limits. */
  stage(source: string, name?: string): Attachment {
    if (this.waiting.length >= ATTACHMENT_LIMITS.files) throw new AttachmentError(`a message can take at most ${ATTACHMENT_LIMITS.files} files`);
    ensureRunsDir(this.runsDir);
    const a = this.files.importFile(source, name);
    const total = this.waiting.reduce((n, x) => n + x.size, a.size);
    if (total > ATTACHMENT_LIMITS.submissionBytes) {
      this.files.remove(a.id);
      throw new AttachmentError(`${a.name} would make the message's files ${formatBytes(total)}; a message can take ${formatBytes(ATTACHMENT_LIMITS.submissionBytes)} in all`);
    }
    this.waiting.push(a);
    this.files.setPending(this.waiting.map((x) => x.id));
    return a;
  }

  /** Removes a waiting file (its copy too); null when no file of this conversation waits by that id. */
  unstage(id: string): Attachment | null {
    const a = this.waiting.find((x) => x.id === id);
    if (!a) return null;
    this.waiting = this.waiting.filter((x) => x !== a);
    this.files.remove(a.id);
    this.files.setPending(this.waiting.map((x) => x.id));
    return a;
  }

  /** Removes every waiting file; the files already sent stay. */
  discardPending(): Attachment[] {
    const gone = this.waiting;
    for (const a of gone) this.unstage(a.id);
    return gone;
  }

  /**
   * The waiting files `ids` names, in the order of `ids` (the tab's, which files stored side by side do not follow);
   * all of them, in their order, when absent. An error names one that does not wait here.
   */
  select(ids?: string[]): Attachment[] {
    if (!ids) return this.pending;
    const unknown = ids.find((id) => !this.waiting.some((x) => x.id === id));
    if (unknown) throw new AttachmentError("a file you attached is no longer waiting to be sent in this conversation; attach it again");
    return [...new Set(ids)].map((id) => this.waiting.find((x) => x.id === id)!);
  }

  /** `files` went with a message that was accepted: they no longer wait, and stay as sent. */
  sent(files: Attachment[]): void {
    if (!files.length) return;
    this.waiting = this.waiting.filter((x) => !files.some((f) => f.id === x.id));
    this.files.setPending(this.waiting.map((x) => x.id));
  }

  /** The answered exchanges that fit `limit` characters, newest kept, oldest dropped whole. */
  context(limit = CONTEXT_CHARS): ConversationContext {
    const answered = this.exchanges;
    let size = 0;
    let keep = answered.length;
    while (keep > 0) {
      const e = answered[keep - 1]!;
      const length = e.question.length + e.answer.length + (e.clarified ?? []).reduce((n, p) => n + p.question.length + p.answer.length, 0);
      if (size + length > limit) break;
      size += length;
      keep--;
    }
    return { exchanges: answered.slice(keep).map(withoutId), omitted: keep };
  }

  /**
   * Starts a turn: the prompt for `backend` carries the conversation so far within the budget and the pipeline tasks
   * of the chat; the question itself is never cut, however long it is.
   */
  begin(backend: Backend, question: string, earlier: EarlierTask[], workspace: string, attachments: Attachment[] = [], canAsk = false): { turn: Turn; prompt: string; omitted: number } {
    const context = this.context();
    const n = this.before + this.turns.length + 1;
    const turn: Turn = {
      id: `${this.id}-t${n}`, backend, question, answer: null, status: "running", logPrefix: `${String(n).padStart(3, "0")}-${backend}`,
      ...(attachments.length ? { attachments } : {}),
    };
    this.turns.push(turn);
    ensureRunsDir(this.runsDir);
    mkdirSync(this.logDir, { recursive: true });
    this.save();
    const tagged = (text: string) => taggedPaths(text, workspace);
    const prompt = prompts.conversation({ workspace, backend, context, earlier, question, attachments, locate: this.locate, tagged, canAsk });
    const session = this.sessions[backend];
    if (session) turn.continuation = prompts.conversation({
      workspace, backend, context: this.newContext(session), earlier: earlier.slice(session.earlier), question, attachments, locate: this.locate, tagged,
    });
    return { turn, prompt, omitted: context.omitted };
  }

  /** `verdict`: a review's, without its VERDICT line in `answer`. */
  finish(id: string, status: TurnStatus, answer: string | null, verdict: Verdict | null = null): void {
    const turn = this.turns.find((t) => t.id === id);
    if (!turn) return;
    turn.status = status;
    turn.answer = status === "success" ? answer : null;
    const place = turn.discussion;
    if (place) {
      // A step of a discussion: what the user answered in it is carried when the discussion ends (finishDiscussion).
      if (turn.answer !== null) this.discussions.get(place.id)?.messages.push({ backend: turn.backend, step: place.step, round: place.round, text: turn.answer, verdict });
      return;
    }
    // What the answer's author asked the user on the way goes with the exchange, so every later prompt carries it. The user's
    // answers outlive the turn: one that failed or was stopped after they answered keeps them (and nothing else of it).
    const clarified = this.settle((e) => e.turnId === turn.id);
    if (turn.answer === null) {
      if (!clarified.length) return;
      this.exchanges.push({
        id: turn.id, backend: turn.backend, question: turn.question, answer: "", unfinished: true, ...(turn.attachments ? { attachments: turn.attachments } : {}), clarified,
      });
      this.save();
      return;
    }
    this.exchanges.push({
      id: turn.id, backend: turn.backend, question: turn.question, answer: turn.answer, ...(turn.attachments ? { attachments: turn.attachments } : {}),
      ...(clarified.length ? { clarified } : {}),
    });
    this.save();
  }

  /** Starts a /discuss: every step sees the conversation as it is now, within the budget. */
  beginDiscussion(answerer: Backend, critic: Backend, question: string, maxRounds: number, attachments: Attachment[] = []): Discussion {
    const d: Discussion = { id: `${this.id}-d${this.before + this.turns.length}-${++this.discussed}`, answerer, critic, question, maxRounds, context: this.context(), messages: [], attachments };
    this.discussions.set(d.id, d);
    return d;
  }

  /** A step of discussion `id`: the reviewer writes the critiques, the answerer every version, and Codex the synthesis. */
  discussionTurn(id: string, step: DiscussionStep, round: number, earlier: EarlierTask[], workspace: string, canAsk = false): { turn: Turn; prompt: string } {
    const d = this.discussions.get(id);
    if (!d) throw new Error(`no discussion ${id}`);
    const backend: Backend = step === "critique" ? d.critic : step === "synthesis" ? "codex" : d.answerer;
    const n = this.before + this.turns.length + 1;
    const turn: Turn = {
      id: `${this.id}-t${n}`, backend, question: d.question, answer: null, status: "running", logPrefix: `${String(n).padStart(3, "0")}-${backend}-${step}${round}`,
      discussion: { id, step, round }, ...(d.attachments.length ? { attachments: d.attachments } : {}),
    };
    this.turns.push(turn);
    ensureRunsDir(this.runsDir);
    mkdirSync(this.logDir, { recursive: true });
    this.save();
    // Every step is a call of its own, so each gets the question's files again (the images as images too).
    const tagged = (text: string) => taggedPaths(text, workspace);
    // What the user answered during this discussion, read now: a step sees the answers given to the steps before it, not only
    // those of the conversation as it stood when the discussion began.
    const pairs = this.discussionPairs(id);
    const prompt = prompts.discussion({
      workspace, context: d.context, earlier, question: d.question, answerer: d.answerer, critic: d.critic, maxRounds: d.maxRounds, step, round, history: d.messages,
      attachments: d.attachments, locate: this.locate, tagged, clarified: pairs, canAsk,
    });
    const session = this.sessions[backend];
    if (session) {
      const same = session.discussion?.id === d.id;
      turn.continuation = prompts.discussion({
        workspace, context: this.newContext(session), earlier: earlier.slice(session.earlier), question: d.question,
        answerer: d.answerer, critic: d.critic, maxRounds: d.maxRounds, step, round, history: d.messages,
        historyStart: same ? session.discussion!.messages : 0,
        attachments: d.attachments, locate: this.locate, tagged,
        clarified: pairs.slice(same ? session.discussion!.clarified ?? 0 : 0), clarifiedNew: same,
      });
    }
    return { turn, prompt };
  }

  /**
   * The discussion is over: its answer, if it has one, is what later prompts carry of it, from `backend` (Codex for a
   * synthesis, the answerer for its own version), discussed with the other agent.
   */
  finishDiscussion(id: string, answer: string | null, backend?: Backend): void {
    const d = this.discussions.get(id);
    if (!d) return;
    this.discussions.delete(id);
    // The user's answers during the discussion are carried whether or not it reached an answer.
    const clarified = this.settle((e) => e.discussionId === id);
    if (answer === null) {
      // Nothing of it joins the conversation, so no session that took part in it is continued.
      for (const party of [d.answerer, d.critic]) if (this.sessions[party]?.discussion?.id === id) delete this.sessions[party];
      if (clarified.length) {
        this.exchanges.push({
          id: d.id, backend: d.answerer, question: d.question, answer: "", unfinished: true, discussedWith: d.critic, ...(d.attachments.length ? { attachments: d.attachments } : {}), clarified,
        });
      }
      this.save();
      return;
    }
    const by = backend ?? d.answerer;
    this.exchanges.push({
      id: d.id, backend: by, question: d.question, answer, discussedWith: by === d.answerer ? d.critic : d.answerer, ...(d.attachments.length ? { attachments: d.attachments } : {}),
      ...(clarified.length ? { clarified } : {}),
    });
    this.save();
  }

  get size(): number {
    return this.turns.length;
  }
}
