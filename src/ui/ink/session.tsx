import { render, type RenderOptions } from "ink";
import type { Decider, Decision, EventBus } from "../../events.js";
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
  close(): Promise<void>;
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
  const options: RenderOptions = { exitOnCtrlC: false, patchConsole: false };
  if (o.stdout) options.stdout = o.stdout;
  if (o.stdin) options.stdin = o.stdin;
  const instance = render(<App {...o} onDecision={onDecision} />, options);
  return {
    decider,
    close: async () => {
      // Events emitted just before close (run.finished) are still pending in React; let them commit first.
      await new Promise((resolve) => setTimeout(resolve, 50));
      instance.unmount();
      await instance.waitUntilExit().catch(() => undefined);
    },
  };
}
