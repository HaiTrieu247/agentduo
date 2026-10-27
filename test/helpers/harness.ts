import { join } from "node:path";
import type { ConfigData } from "../../src/core/config.js";
import { RunStore, type RunState } from "../../src/core/state.js";
import { Workflow } from "../../src/core/workflow.js";
import { EventBus, type Decider, type Decision, type DuoEvent, type HumanReview } from "../../src/events.js";

export class ScriptedDecider implements Decider {
  readonly seen: string[] = [];
  constructor(private readonly answers: Array<Decision | "defer"> = []) {}
  async decide(review: HumanReview): Promise<Decision | "defer"> {
    this.seen.push(review.reason);
    return this.answers.shift() ?? "defer";
  }
}

export interface Harness {
  repo: string;
  cfg: ConfigData;
  runsDir: string;
  events: DuoEvent[];
}

export function makeHarness(repo: string, cfg: ConfigData): Harness {
  return { repo, cfg, runsDir: join(repo, ".agentduo", "runs"), events: [] };
}

function busFor(h: Harness): EventBus {
  const bus = new EventBus();
  bus.on((e) => h.events.push(e));
  return bus;
}

export function newWorkflow(h: Harness, task: string, decider: Decider = new ScriptedDecider()): { wf: Workflow; bus: EventBus } {
  const bus = busFor(h);
  const { store, state } = RunStore.create(h.runsDir, task, h.cfg.limits);
  return { wf: new Workflow({ cfg: h.cfg, repo: h.repo, store, state, bus, decider }), bus };
}

export function resumedWorkflow(h: Harness, opts: { decider?: Decider; allowDirty?: boolean } = {}): { wf: Workflow; bus: EventBus } {
  const bus = busFor(h);
  const store = RunStore.open(h.runsDir);
  const wf = new Workflow({ cfg: h.cfg, repo: h.repo, store, state: store.loadState(), bus, decider: opts.decider ?? new ScriptedDecider(), allowDirty: opts.allowDirty });
  return { wf, bus };
}

export async function resume(h: Harness, decision?: Decision, opts: { decider?: Decider; allowDirty?: boolean } = {}): Promise<number> {
  const { wf } = resumedWorkflow(h, opts);
  if (decision) await wf.applyDecision(decision.decision, decision.note);
  return wf.run();
}

export const stateOf = (h: Harness): RunState => RunStore.open(h.runsDir).loadState();
export const runDirOf = (h: Harness): string => RunStore.open(h.runsDir).dir;
