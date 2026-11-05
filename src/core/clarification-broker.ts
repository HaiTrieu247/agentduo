/**
 * The user's side of a question, for any screen: it holds each request that waits for an answer and settles it exactly once,
 * with the answer, a dismissal, or "later". It validates before it applies (src/core/clarification.ts), so an incomplete
 * answer, a duplicate, an answer to an earlier request or to another call's, changes nothing and leaves the question waiting.
 * Nothing is ever chosen for the user.
 */
import type { ClarificationDecider } from "../events.js";
import {
  answerErrors, cleanAnswers, type ClarificationAnswer, type ClarificationRequest, type ClarificationResponse,
} from "./clarification.js";

export type AnswerOutcome =
  /** Applied: the question is settled. */
  | { ok: true }
  /** Not applied: there is no such question waiting (answered already, ended, or from another run, turn or tab). */
  | { ok: false; reason: "stale" }
  /** Not applied, and the question keeps waiting: the answer is not a complete valid one. */
  | { ok: false; reason: "invalid"; errors: string[] };

export interface BrokerOptions {
  /** False when nobody can answer here (CI, background): every question is "later" at once. Default true. */
  interactive?: boolean;
  /** A question started to wait. */
  opened?(request: ClarificationRequest): void;
  /** A question stopped waiting, and how. */
  closed?(request: ClarificationRequest, how: ClarificationResponse["kind"]): void;
}

interface Waiting {
  request: ClarificationRequest;
  settle(response: ClarificationResponse): void;
}

export class ClarificationBroker implements ClarificationDecider {
  private readonly waiting = new Map<string, Waiting>();
  private closedFor = false;

  constructor(private readonly o: BrokerOptions = {}) {}

  askClarification({ request }: { request: ClarificationRequest }, signal?: AbortSignal): Promise<ClarificationResponse> {
    // An aborted call, a closed broker, a screen nobody answers on, and a request that already waits are all "later": a request
    // is never answered by a screen that did not show it, and never twice.
    if (this.closedFor || this.o.interactive === false || signal?.aborted || this.waiting.has(request.id)) return Promise.resolve({ kind: "defer" });
    return new Promise((resolve) => {
      const settle = (response: ClarificationResponse) => {
        if (this.waiting.get(request.id)?.settle !== settle) return;
        this.waiting.delete(request.id);
        signal?.removeEventListener("abort", onAbort);
        this.o.closed?.(request, response.kind);
        resolve(response);
      };
      const onAbort = () => settle({ kind: "defer" });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.set(request.id, { request, settle });
      this.o.opened?.(request);
    });
  }

  /** The requests waiting for the user, oldest first. */
  pending(): ClarificationRequest[] {
    return [...this.waiting.values()].map((w) => w.request);
  }

  has(id: string): boolean {
    return this.waiting.has(id);
  }

  /**
   * The user's answers to request `id` (of call `callId`, when the caller knows it). Applied once: the question is settled and
   * a second answer to it is `stale`. An answer that is not complete and valid is refused with what is wrong, and the
   * question keeps waiting.
   */
  answer(id: string, callId: string | undefined, answers: ClarificationAnswer[]): AnswerOutcome {
    const w = this.waiting.get(id);
    if (!w || (callId !== undefined && w.request.callId !== callId)) return { ok: false, reason: "stale" };
    const errors = answerErrors(w.request.questions, answers);
    if (errors.length) return { ok: false, reason: "invalid", errors };
    w.settle({ kind: "answered", answers: cleanAnswers(w.request.questions, answers) });
    return { ok: true };
  }

  /** The user dismisses request `id`: the agent is told it got no answer. False when it is not waiting (or is another call's). */
  cancel(id: string, callId?: string): boolean {
    const w = this.waiting.get(id);
    if (!w || (callId !== undefined && w.request.callId !== callId)) return false;
    w.settle({ kind: "cancelled" });
    return true;
  }

  /** The user will answer request `id` later (a pipeline's stays pending; a turn's call ends). False when it is not waiting (or is another call's). */
  defer(id: string, callId?: string): boolean {
    const w = this.waiting.get(id);
    if (!w || (callId !== undefined && w.request.callId !== callId)) return false;
    w.settle({ kind: "defer" });
    return true;
  }

  /** Every waiting question is "later"; with `close`, so is every question asked from now on (the screen is going away). */
  deferAll(close = false): void {
    if (close) this.closedFor = true;
    for (const w of [...this.waiting.values()]) w.settle({ kind: "defer" });
  }
}
