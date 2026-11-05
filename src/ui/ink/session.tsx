import { render, type RenderOptions } from "ink";
import { ClarificationBroker } from "../../core/clarification-broker.js";
import type { ClarificationAnswer } from "../../core/clarification.js";
import type { ClarificationDecider, Decider, Decision, EventBus, PermissionAnswer, PermissionDecider } from "../../events.js";
import { App } from "./App.js";
import type { ViewKind } from "./HumanReviewPrompt.js";

export interface InkSessionOptions {
  bus: EventBus;
  version: string;
  verbose: boolean;
  interactive: boolean;
  onStop(): void;
  onInterrupt(): void;
  views(): ViewKind[];
  readView(kind: ViewKind): Promise<string | null>;
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
}

export interface InkSession {
  decider: Decider;
  /** Resolves when the user answers a relayed permission prompt; denies when nobody can answer or the agent stops. */
  permissions: PermissionDecider;
  /** Resolves when the user answers an agent's question; "later" when nobody can answer or the agent stops. */
  clarifier: ClarificationDecider;
  close(): Promise<void>;
}

/** What the user did with a question: answered it (complete), dismissed it, or will answer later. */
export type QuestionReply = { kind: "answered"; answers: ClarificationAnswer[] } | { kind: "cancelled" } | { kind: "defer" };

/** The questions of the agents answered from the UI: each is settled once; an aborted call, or nobody to answer, is "later". */
export function clarificationDesk(interactive: boolean): { clarifier: ClarificationBroker; reply(id: string, reply: QuestionReply): void } {
  const clarifier = new ClarificationBroker({ interactive });
  return {
    clarifier,
    reply: (id, reply) => {
      if (reply.kind === "answered") clarifier.answer(id, undefined, reply.answers);
      else if (reply.kind === "cancelled") clarifier.cancel(id);
      else clarifier.defer(id);
    },
  };
}

/** Permission prompts answered from the UI: one pending answer per request; an aborted agent call denies. */
export function permissionBroker(interactive: boolean): { permissions: PermissionDecider; answer(id: string, answer: PermissionAnswer): void } {
  const waiting = new Map<string, (answer: PermissionAnswer) => void>();
  const permissions: PermissionDecider = {
    askPermission: ({ request }, signal) => {
      if (!interactive || signal?.aborted) return Promise.resolve({ decision: "deny" });
      return new Promise((resolve) => {
        const done = (answer: PermissionAnswer) => {
          waiting.delete(request.id);
          signal?.removeEventListener("abort", onAbort);
          resolve(answer);
        };
        const onAbort = () => done({ decision: "deny" });
        signal?.addEventListener("abort", onAbort, { once: true });
        waiting.set(request.id, done);
      });
    },
  };
  return { permissions, answer: (id, answer) => waiting.get(id)?.(answer) };
}

/** Mount the live UI; its Decider resolves when the user answers the human-review prompt. */
export function startInk(o: InkSessionOptions): InkSession {
  const pending: { resolve?: (d: Decision | "defer") => void } = {};
  const decider: Decider = {
    decide: () => (o.interactive ? new Promise((resolve) => { pending.resolve = resolve; }) : Promise.resolve("defer")),
  };
  const onDecision = (d: Decision | "defer") => {
    const resolve = pending.resolve;
    pending.resolve = undefined;
    resolve?.(d);
  };
  const broker = permissionBroker(o.interactive);
  const desk = clarificationDesk(o.interactive);
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const options: RenderOptions = { exitOnCtrlC: false, patchConsole: false };
  if (o.stdout) options.stdout = o.stdout;
  if (o.stdin) options.stdin = o.stdin;
  const instance = render(<App {...o} onDecision={onDecision} onPermission={broker.answer} onQuestion={desk.reply} onSettled={() => settle()} />, options);
  return {
    decider,
    permissions: broker.permissions,
    clarifier: desk.clarifier,
    close: async () => {
      desk.clarifier.deferAll(true);
      // Wait until the finish line has rendered; without a run.finished event (an error path) give up after a second.
      await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 1000))]);
      instance.unmount();
      await instance.waitUntilExit().catch(() => undefined);
    },
  };
}
