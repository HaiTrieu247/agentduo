import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Backend } from "./config.js";
import * as prompts from "./prompts.js";
import { atomicWrite, ensureRunsDir, stamp, type ConversationContext, type EarlierTask, type Exchange } from "./state.js";
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
}

export type ConversationSummary = Pick<ConversationRecord, "id" | "title" | "createdAt" | "updatedAt">;

const RECORD = "conversation.json";
const conversationsDir = (runsDir: string) => join(runsDir, "conversations");

function readRecord(file: string): ConversationRecord | null {
  try {
    const r = JSON.parse(readFileSync(file, "utf8")) as ConversationRecord;
    return r && r.version === 1 && typeof r.id === "string" && Array.isArray(r.exchanges) ? r : null;
  } catch {
    return null;
  }
}

/** The conversations of a workspace that said something, the most recently changed first. */
export function listConversations(runsDir: string): ConversationSummary[] {
  const dir = conversationsDir(runsDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const r = readRecord(join(dir, name, RECORD));
    return r ? [{ id: r.id, title: r.title, createdAt: r.createdAt, updatedAt: r.updatedAt }] : [];
  }).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

let counter = 0;

/**
 * The chat's conversation with both agents. Only answered turns are context for later prompts; failed and stopped
 * ones are shown, not repeated. A discussion is context only through its final answer, given by the agent that
 * answered and marked as discussed with the other. It lives under <runsDir>/conversations/<id>/: its logs, and once
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
  /** Turns started before this process: the logs of a reopened conversation number on from them. */
  private before = 0;
  private name = "";
  private to: Backend | null = null;
  private readonly done: EarlierTask[] = [];
  private createdAt: string;
  private readonly clock: () => Date;

  constructor(private readonly runsDir: string, o: { id?: string; clock?: () => Date } = {}) {
    this.clock = o.clock ?? (() => new Date());
    const now = this.clock();
    this.id = o.id ?? `${stamp(now)}-chat-${process.pid}-${++counter}`;
    this.dir = join(conversationsDir(runsDir), this.id);
    this.createdAt = now.toISOString();
  }

  /** The conversation `id` of this workspace as it was saved, or a new one by that id. */
  static open(runsDir: string, id: string, clock?: () => Date): Conversation {
    const c = new Conversation(runsDir, { id, clock });
    const r = readRecord(join(c.dir, RECORD));
    if (!r) return c;
    c.name = r.title;
    c.to = r.recipient;
    c.before = r.turns;
    c.createdAt = r.createdAt;
    c.exchanges.push(...r.exchanges);
    c.done.push(...r.earlier);
    return c;
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
    const record: ConversationRecord = {
      version: 1, id: this.id, title: this.name, createdAt: this.createdAt, updatedAt: this.clock().toISOString(), recipient: this.to,
      turns: this.before + this.turns.length, exchanges: this.exchanges, earlier: this.done,
    };
    ensureRunsDir(this.runsDir);
    mkdirSync(this.dir, { recursive: true });
    atomicWrite(join(this.dir, RECORD), `${JSON.stringify(record, null, 2)}\n`);
  }

  get logDir(): string {
    return join(this.dir, "logs");
  }

  /** The answered exchanges that fit `limit` characters, newest kept, oldest dropped whole. */
  context(limit = CONTEXT_CHARS): ConversationContext {
    const answered = this.exchanges;
    let size = 0;
    let keep = answered.length;
    while (keep > 0) {
      const e = answered[keep - 1]!;
      if (size + e.question.length + e.answer.length > limit) break;
      size += e.question.length + e.answer.length;
      keep--;
    }
    return { exchanges: answered.slice(keep), omitted: keep };
  }

  /**
   * Starts a turn: the prompt for `backend` carries the conversation so far within the budget and the pipeline tasks
   * of the chat; the question itself is never cut, however long it is.
   */
  begin(backend: Backend, question: string, earlier: EarlierTask[], workspace: string): { turn: Turn; prompt: string; omitted: number } {
    const context = this.context();
    const n = this.before + this.turns.length + 1;
    const turn: Turn = { id: `${this.id}-t${n}`, backend, question, answer: null, status: "running", logPrefix: `${String(n).padStart(3, "0")}-${backend}` };
    this.turns.push(turn);
    ensureRunsDir(this.runsDir);
    mkdirSync(this.logDir, { recursive: true });
    this.save();
    return { turn, prompt: prompts.conversation({ workspace, backend, context, earlier, question }), omitted: context.omitted };
  }

  /** `verdict`: a review's, without its VERDICT line in `answer`. */
  finish(id: string, status: TurnStatus, answer: string | null, verdict: Verdict | null = null): void {
    const turn = this.turns.find((t) => t.id === id);
    if (!turn) return;
    turn.status = status;
    turn.answer = status === "success" ? answer : null;
    if (turn.answer === null) return;
    const place = turn.discussion;
    if (!place) {
      this.exchanges.push({ backend: turn.backend, question: turn.question, answer: turn.answer });
      this.save();
    } else this.discussions.get(place.id)?.messages.push({ backend: turn.backend, step: place.step, round: place.round, text: turn.answer, verdict });
  }

  /** Starts a /discuss: every step sees the conversation as it is now, within the budget. */
  beginDiscussion(answerer: Backend, critic: Backend, question: string, maxRounds: number): Discussion {
    const d: Discussion = { id: `${this.id}-d${++this.discussed}`, answerer, critic, question, maxRounds, context: this.context(), messages: [] };
    this.discussions.set(d.id, d);
    return d;
  }

  /** A step of discussion `id`: the reviewer writes the critiques, the answerer every version. */
  discussionTurn(id: string, step: DiscussionStep, round: number, earlier: EarlierTask[], workspace: string): { turn: Turn; prompt: string } {
    const d = this.discussions.get(id);
    if (!d) throw new Error(`no discussion ${id}`);
    const backend = step === "critique" ? d.critic : d.answerer;
    const n = this.before + this.turns.length + 1;
    const turn: Turn = {
      id: `${this.id}-t${n}`, backend, question: d.question, answer: null, status: "running", logPrefix: `${String(n).padStart(3, "0")}-${backend}-${step}${round}`,
      discussion: { id, step, round },
    };
    this.turns.push(turn);
    ensureRunsDir(this.runsDir);
    mkdirSync(this.logDir, { recursive: true });
    this.save();
    const prompt = prompts.discussion({
      workspace, context: d.context, earlier, question: d.question, answerer: d.answerer, critic: d.critic, maxRounds: d.maxRounds, step, round, history: d.messages,
    });
    return { turn, prompt };
  }

  /** The discussion is over: its answer, if it has one, is what later prompts carry of it. */
  finishDiscussion(id: string, answer: string | null): void {
    const d = this.discussions.get(id);
    if (!d) return;
    this.discussions.delete(id);
    if (answer === null) return;
    this.exchanges.push({ backend: d.answerer, question: d.question, answer, discussedWith: d.critic });
    this.save();
  }

  get size(): number {
    return this.turns.length;
  }
}
