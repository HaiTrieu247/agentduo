import { randomUUID } from "node:crypto";
import type { Decider, Decision, HumanReview, PermissionAnswer, PermissionDecider } from "../../../src/events.js";
import type { DecisionAnswer } from "./protocol.js";

/**
 * HUMAN_REVIEW answered from the sidebar. Each question gets an id of its own; an answer applies once, to the
 * question it names. Workflow.interrupt() does not settle a pending decide(), so shutdown must close() first.
 */
export class DecisionBroker implements Decider {
  private readonly waiting = new Map<string, (answer: Decision | "defer") => void>();
  private closed = false;
  private count = 0;

  constructor(private readonly o: { opened(id: string, review: HumanReview): void; closed(id: string): void }) {}

  decide(review: HumanReview): Promise<Decision | "defer"> {
    if (this.closed) return Promise.resolve("defer");
    const id = `decision-${++this.count}-${randomUUID().slice(0, 8)}`;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.o.opened(id, review);
    });
  }

  /** False when `id` is not waiting (answered already, or from an earlier question). */
  answer(id: string, answer: DecisionAnswer): boolean {
    const resolve = this.waiting.get(id);
    if (!resolve) return false;
    this.waiting.delete(id);
    this.o.closed(id);
    resolve(answer.decision === "defer" ? "defer" : { decision: answer.decision, note: answer.note ?? undefined });
    return true;
  }

  pending(): string[] {
    return [...this.waiting.keys()];
  }

  /** Every waiting question is decided later (the run stays in HUMAN_REVIEW); with `close`, so is every later one. */
  deferAll(close = false): void {
    if (close) this.closed = true;
    for (const id of this.pending()) this.answer(id, { decision: "defer", note: null });
  }
}

/**
 * Claude's permission prompts answered from the sidebar, keyed by the CLI's own request id. An aborted agent
 * call, a closed broker and anything unanswered at shutdown deny, as Claude itself would without a host.
 */
export class PermissionBroker implements PermissionDecider {
  private readonly waiting = new Map<string, (answer: PermissionAnswer) => void>();
  private closed = false;

  askPermission({ request }: Parameters<PermissionDecider["askPermission"]>[0], signal?: AbortSignal): Promise<PermissionAnswer> {
    if (this.closed || signal?.aborted || this.waiting.has(request.id)) return Promise.resolve({ decision: "deny" });
    return new Promise((resolve) => {
      const done = (answer: PermissionAnswer) => {
        this.waiting.delete(request.id);
        signal?.removeEventListener("abort", onAbort);
        resolve(answer);
      };
      const onAbort = () => done({ decision: "deny" });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.set(request.id, done);
    });
  }

  answer(id: string, answer: PermissionAnswer): boolean {
    const done = this.waiting.get(id);
    if (!done) return false;
    done(answer);
    return true;
  }

  pending(): string[] {
    return [...this.waiting.keys()];
  }

  denyAll(close = false): void {
    if (close) this.closed = true;
    for (const id of this.pending()) this.answer(id, { decision: "deny" });
  }
}
