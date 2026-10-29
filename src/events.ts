import { EventEmitter } from "node:events";

export type Phase =
  | "PLAN" | "PLAN_REVIEW" | "PLAN_FINALIZE" | "IMPLEMENT" | "VERIFY" | "CODE_REVIEW"
  | "HUMAN_REVIEW" | "DONE" | "ABORTED";
export type Role = "planner" | "plan_reviewer" | "plan_finalizer" | "implementer" | "code_reviewer";
export type Party = "codex" | "claude" | "gates" | "human" | "orchestrator";

/** One thing an agent did, as seen in its output stream. Re-emitted with the same id when its status changes. */
export interface Activity {
  id: string;
  kind: "read" | "search" | "edit" | "command" | "say" | "think" | "submit" | "other";
  label: string;
  status: "running" | "ok" | "error" | "denied";
  exitCode?: number;
  added?: number;
  removed?: number;
}

/** What one party handed to another at the end of a step (relayed by the orchestrator). */
export interface Message {
  from: Party;
  to: Party;
  kind: "plan" | "critique" | "approval" | "implementation" | "gates" | "review" | "decision";
  headline: string;
  items: string[];
  artifact?: string;
}

export interface HistoryEntry {
  step: number;
  phase: Phase;
  round: number;
  agent: string;
  status: string;
  summary: string;
  kind: "info" | "ok" | "warn";
  at: string;
  artifact: string | null;
}

export interface HumanReview {
  reason: string;
  message: string;
  fromPhase: Phase;
  resumePhase: Phase;
  details: string[];
  at: string;
}

/** A tool call the agent's own settings do not allow, waiting for the human (Claude in host mode). */
export interface PermissionRequest {
  id: string;
  tool: string;
  /** What the call does, as an activity label ("Bash  npm test"). */
  label: string;
  description: string | null;
  blockedPath: string | null;
  /** The rules "Always allow" saves, as Claude spells them ("Bash(npm test:*)"); empty when Claude suggests none. */
  rules: string[];
}

export type PermissionAnswer = { decision: "once" } | { decision: "always" } | { decision: "deny"; message?: string };

export interface RoundInfo {
  round: number;
  limit: number;
}

export type Agent = "codex" | "claude";

/**
 * Which model a backend runs with, and how sure agentduo is: `requested` is an explicit choice (config or args),
 * `configured` a name or alias from the CLI's own settings, `resolved` a concrete name its doctor or its own stream
 * confirmed. "default" means agentduo passes no model, so the CLI picks one.
 */
export interface ModelIdentity {
  backend: Agent;
  requested: string | null;
  configured: string | null;
  resolved: string | null;
  /** Where the name shown comes from. */
  source: "config" | "args" | "env" | "settings" | "doctor" | "observed" | null;
  isDefault: boolean;
  status: "resolving" | "resolved" | "configured" | "unresolved";
  /** Why the model is not known (yet). */
  reason: string | null;
}

export type ModelMap = Record<Agent, ModelIdentity>;

export type TurnStatus = "success" | "error" | "interrupted";

/**
 * /discuss: one agent answers, the other reviews it, and the first revises until the reviewer agrees or the rounds
 * run out; then Codex, in a call of its own, synthesizes the discussion into the final answer. `final` (the answerer's
 * own last version after the rounds ran out) is what discussions did before; new ones never take that step, but
 * discussions saved by then (an extension tab's view.json) still show it.
 */
export type DiscussionStep = "answer" | "critique" | "revise" | "synthesis" | "final";
export type Verdict = "agree" | "revise";
/**
 * A turn's place in a discussion: an answer step writes version `round`; a critique reviews version `round`; the
 * synthesis comes after `round` reviews.
 */
export interface DiscussionPlace {
  id: string;
  step: DiscussionStep;
  round: number;
}
/** agreed: the reviewer agreed; disputed: the last review still asked for changes. Either way the reviews are over. */
export type DiscussionStatus = "agreed" | "disputed" | "interrupted" | "error";

/**
 * Who a permission prompt or an activity belongs to: a pipeline role, or a turn of the conversation. A conversation
 * turn is not a pipeline role, so it has none.
 */
export type CallContext = { role: Role; turnId?: undefined } | { role?: undefined; turnId: string };

export type DuoEvent =
  | { type: "run.started"; runId: string; task: string; repo: string; runDir: string }
  | { type: "phase.started"; step: number; phase: Phase; round: number; role?: Role; agent?: Party; planning: RoundInfo; impl: RoundInfo }
  | { type: "agent.activity"; role: Role; agent: Party; activity: Activity }
  | { type: "agent.retry"; role: Role; agent: Party; attempt: number; max: number; reason: string }
  | ({ type: "permission.requested"; agent: Party; request: PermissionRequest } & CallContext)
  | ({ type: "permission.answered"; agent: Party; id: string; answer: PermissionAnswer } & CallContext)
  /** A question of the conversation went to one agent; `model` is what it runs with as the turn starts. */
  | { type: "turn.started"; conversationId: string; turnId: string; backend: Agent; question: string; model: ModelIdentity; discussion?: DiscussionPlace }
  | { type: "turn.activity"; conversationId: string; turnId: string; backend: Agent; activity: Activity }
  | { type: "turn.usage"; turnId: string; backend: Agent; costUsd?: number; tokens?: number }
  /** The agent's own stream named the model of this turn. */
  | { type: "turn.model"; turnId: string; backend: Agent; model: string }
  | {
    type: "turn.finished"; conversationId: string; turnId: string; backend: Agent; status: TurnStatus; answer: string | null; error: string | null;
    model: ModelIdentity; durationSec: number; costUsd?: number; tokens?: number; logDir: string;
    /** A critique's answer comes without its VERDICT line; `verdict` is null when it had none. */
    discussion?: DiscussionPlace & { verdict?: Verdict | null };
  }
  /** A /discuss began; its turns follow, each with its place in it. */
  | { type: "discussion.started"; conversationId: string; discussionId: string; question: string; answerer: Agent; critic: Agent; maxRounds: number }
  /**
   * The discussion is over. `answer` is the response: Codex's synthesis, or the latest version when the synthesis
   * failed; null when it was stopped or failed before. `answerBackend` wrote it (absent before synthesis existed: the
   * answerer did). `rounds` counts the reviews; usage and duration add up its turns, which already reported theirs.
   */
  | {
    type: "discussion.finished"; conversationId: string; discussionId: string; status: DiscussionStatus; answerer: Agent; critic: Agent; rounds: number;
    answer: string | null; answerBackend?: Agent; error: string | null; durationSec: number; costUsd?: number; tokens?: number; logDir: string;
  }
  /** Running totals for the current agent call (all attempts so far). */
  | { type: "agent.usage"; agent: Party; costUsd?: number; tokens?: number }
  | { type: "gate.started"; name: string; command: string }
  | { type: "gate.completed"; name: string; command: string; passed: boolean; exitCode: number | null }
  | { type: "message"; message: Message }
  | { type: "step.completed"; entry: HistoryEntry; durationSec: number; costUsd?: number; tokens?: number }
  | { type: "warning"; text: string }
  | { type: "human.required"; runId: string; review: HumanReview }
  /** `summary` says, on DONE, what the run actually checked ("quality gates passed and the review approved"). */
  | { type: "run.finished"; runId: string; phase: "DONE" | "ABORTED" | "HUMAN_REVIEW" | "INTERRUPTED"; reportPath: string; exitCode: number; summary?: string };

export interface Decision {
  decision: "resume" | "revise" | "abort";
  note?: string;
}

export interface Decider {
  decide(review: HumanReview): Promise<Decision | "defer">;
}

/** Answers an agent's permission prompt; only given to the runner when someone can answer. */
export interface PermissionDecider {
  askPermission(ask: { agent: Party; request: PermissionRequest } & CallContext, signal?: AbortSignal): Promise<PermissionAnswer>;
}

export class EventBus {
  private readonly emitter = new EventEmitter();

  emit(event: DuoEvent): void {
    this.emitter.emit("event", event);
  }

  on(listener: (event: DuoEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }
}
