import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Backend } from "./config.js";
import * as prompts from "./prompts.js";
import { ensureRunsDir, stamp, type ConversationContext, type EarlierTask, type Exchange } from "./state.js";
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

let counter = 0;

/**
 * The chat's conversation with both agents: every turn, in memory, for this session only. Only answered turns are
 * context for later prompts; failed and stopped ones are shown, not repeated. A discussion is context only through its
 * final answer, given by the agent that answered and marked as discussed with the other. Its logs live under
 * <runsDir>/conversations/<id>/, which has no state.json, so it is never a run and never the latest run.
 */
export class Conversation {
  readonly id: string;
  readonly dir: string;
  private readonly turns: Turn[] = [];
  /** What later prompts carry, in the order it was said. */
  private readonly exchanges: Exchange[] = [];
  private readonly discussions = new Map<string, Discussion>();
  private discussed = 0;

  constructor(private readonly runsDir: string, now = new Date()) {
    this.id = `${stamp(now)}-chat-${process.pid}-${++counter}`;
    this.dir = join(runsDir, "conversations", this.id);
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
    const n = this.turns.length + 1;
    const turn: Turn = { id: `${this.id}-t${n}`, backend, question, answer: null, status: "running", logPrefix: `${String(n).padStart(3, "0")}-${backend}` };
    this.turns.push(turn);
    ensureRunsDir(this.runsDir);
    mkdirSync(this.logDir, { recursive: true });
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
    if (!place) this.exchanges.push({ backend: turn.backend, question: turn.question, answer: turn.answer });
    else this.discussions.get(place.id)?.messages.push({ backend: turn.backend, step: place.step, round: place.round, text: turn.answer, verdict });
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
    const n = this.turns.length + 1;
    const turn: Turn = {
      id: `${this.id}-t${n}`, backend, question: d.question, answer: null, status: "running", logPrefix: `${String(n).padStart(3, "0")}-${backend}-${step}${round}`,
      discussion: { id, step, round },
    };
    this.turns.push(turn);
    ensureRunsDir(this.runsDir);
    mkdirSync(this.logDir, { recursive: true });
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
    if (answer !== null) this.exchanges.push({ backend: d.answerer, question: d.question, answer, discussedWith: d.critic });
  }

  get size(): number {
    return this.turns.length;
  }
}
