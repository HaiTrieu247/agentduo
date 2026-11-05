import { join } from "node:path";
import type { ConfigData } from "../../src/config/config.js";
import { RunStore, type RunState } from "../../src/workflow/state.js";
import { Workflow } from "../../src/workflow/workflow.js";
import type { ClarificationAnswer, ClarificationRequest, ClarificationResponse } from "../../src/clarification/clarification.js";
import { EventBus, type ClarificationDecider, type Decider, type Decision, type DuoEvent, type HumanReview, type PermissionDecider } from "../../src/events.js";

export class ScriptedDecider implements Decider {
  readonly seen: string[] = [];
  constructor(private readonly answers: Array<Decision | "defer"> = []) {}
  async decide(review: HumanReview): Promise<Decision | "defer"> {
    this.seen.push(review.reason);
    return this.answers.shift() ?? "defer";
  }
}

/** Answers the questions it is asked with `responses` in turn (the last one repeats); records the requests it saw. Out of responses: defer. */
export class ScriptedClarifier implements ClarificationDecider {
  readonly seen: ClarificationRequest[] = [];
  constructor(private readonly responses: Array<ClarificationResponse | ((r: ClarificationRequest) => ClarificationResponse)> = []) {}
  async askClarification({ request }: { request: ClarificationRequest }): Promise<ClarificationResponse> {
    this.seen.push(request);
    const next = this.responses[Math.min(this.seen.length - 1, this.responses.length - 1)];
    return typeof next === "function" ? next(request) : next ?? { kind: "defer" };
  }
}

/** The first option of every question, as the user's answer (a test's choice, never agentduo's). */
export const pickFirst = (request: ClarificationRequest): ClarificationResponse => ({
  kind: "answered", answers: request.questions.map((q): ClarificationAnswer => ({ questionId: q.id, optionIds: [q.options[0]!.id], otherText: null })),
});

export interface Harness {
  repo: string;
  cfg: ConfigData;
  runsDir: string;
  events: DuoEvent[];
  /** Answers Claude's permission prompts in host mode; absent = nobody can answer. */
  permissions?: PermissionDecider;
  /** Answers the agents' structured questions; absent = nobody can answer. */
  clarifier?: ClarificationDecider;
  /** The workflow's environment (its data root); absent: this process's. */
  env?: NodeJS.ProcessEnv;
}

export function makeHarness(repo: string, cfg: ConfigData): Harness {
  return { repo, cfg, runsDir: join(repo, ".agentduo", "runs"), events: [] };
}

function busFor(h: Harness): EventBus {
  const bus = new EventBus();
  bus.on((e) => h.events.push(e));
  return bus;
}

export function newWorkflow(h: Harness, task: string, decider: Decider = new ScriptedDecider(), prepare?: (state: RunState) => void): { wf: Workflow; bus: EventBus } {
  const bus = busFor(h);
  const { store, state } = RunStore.create(h.runsDir, task, h.cfg.limits);
  if (prepare) {
    prepare(state);
    store.saveState(state);
  }
  return { wf: new Workflow({ cfg: h.cfg, repo: h.repo, store, state, bus, decider, permissions: h.permissions, clarifier: h.clarifier, env: h.env }), bus };
}

export function resumedWorkflow(h: Harness, opts: { decider?: Decider } = {}): { wf: Workflow; bus: EventBus } {
  const bus = busFor(h);
  const store = RunStore.open(h.runsDir);
  const wf = new Workflow({ cfg: h.cfg, repo: h.repo, store, state: store.loadState(), bus, decider: opts.decider ?? new ScriptedDecider(), permissions: h.permissions, clarifier: h.clarifier, env: h.env });
  return { wf, bus };
}

export async function resume(h: Harness, decision?: Decision, opts: { decider?: Decider } = {}): Promise<number> {
  const { wf } = resumedWorkflow(h, opts);
  if (decision) await wf.applyDecision(decision.decision, decision.note);
  return wf.run();
}

export const stateOf = (h: Harness): RunState => RunStore.open(h.runsDir).loadState();
export const runDirOf = (h: Harness): string => RunStore.open(h.runsDir).dir;
