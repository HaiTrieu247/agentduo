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

export interface RoundInfo {
  round: number;
  limit: number;
}

export type DuoEvent =
  | { type: "run.started"; runId: string; task: string; repo: string; runDir: string }
  | { type: "phase.started"; step: number; phase: Phase; round: number; role?: Role; agent?: Party; planning: RoundInfo; impl: RoundInfo }
  | { type: "agent.activity"; role: Role; agent: Party; activity: Activity }
  | { type: "agent.retry"; role: Role; agent: Party; attempt: number; max: number; reason: string }
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
