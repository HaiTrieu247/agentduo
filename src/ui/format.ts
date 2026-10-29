import type { Activity, Agent, DiscussionStatus, DiscussionStep, Message, ModelIdentity, Party, PermissionAnswer, Phase, Role, Verdict } from "../events.js";

export const PIPELINE: Array<{ phase: Phase; label: string }> = [
  { phase: "PLAN", label: "PLAN" },
  { phase: "PLAN_REVIEW", label: "CRITIQUE" },
  { phase: "PLAN_FINALIZE", label: "FINALIZE" },
  { phase: "IMPLEMENT", label: "IMPLEMENT" },
  { phase: "VERIFY", label: "VERIFY" },
  { phase: "CODE_REVIEW", label: "REVIEW" },
];
export const IMPL_PHASES: Phase[] = ["IMPLEMENT", "VERIFY", "CODE_REVIEW"];
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const PARTY_LABELS: Record<Party, string> = { codex: "Codex", claude: "Claude", gates: "Gates", human: "You", orchestrator: "agentduo" };
const ROLE_LABELS: Record<Role, string> = {
  planner: "planner", plan_reviewer: "plan critic", plan_finalizer: "plan sign-off", implementer: "implementer", code_reviewer: "code reviewer",
};
const STATUS_ICONS: Record<Activity["status"], string> = { running: "…", ok: "✓", error: "✗", denied: "⊘" };

const RESUME_HINTS: Record<string, string> = {
  max_planning_rounds: "implement the latest plan as-is",
  plan_ready: "start implementation",
  max_review_rounds: "start another fix round",
  critical_finding: "start another fix round",
  gates_failing: "start another fix round",
  implementer_blocked: "re-run this implementation round",
  // Reasons only agentduo 0.1 runs can be waiting on; kept so those runs can still be resumed from the prompt.
  dirty_worktree: "re-run this implementation round",
  guard_violation: "accept the changes and run the gates",
};

/** What "resume" does for a run waiting with this reason. */
export const resumeHint = (reason: string): string => RESUME_HINTS[reason] ?? "re-run the step that stopped";

export const partyLabel = (p?: Party | string): string => (p ? PARTY_LABELS[p as Party] ?? p : "");
export const roleLabel = (r?: Role): string => (r ? ROLE_LABELS[r] : "");
export const statusIcon = (s: Activity["status"]): string => STATUS_ICONS[s];

/** "allowed once", "always allowed: Bash(npm test:*)", "denied: use the npm script". */
export function permissionAnswerText(answer: PermissionAnswer, rules: string[]): string {
  if (answer.decision === "once") return "allowed once";
  if (answer.decision === "always") return `always allowed${rules.length ? `: ${rules.join(", ")}` : ""}`;
  return answer.message ? `denied: ${answer.message}` : "denied";
}

export function formatDuration(sec?: number): string {
  if (sec === undefined) return "";
  const s = Math.round(sec);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const formatCost = (usd?: number | null): string => (usd ? `$${usd.toFixed(2)}` : "");
export const formatTokens = (n?: number | null): string => (!n ? "" : n >= 1000 ? `${Math.round(n / 1000)}k tok` : `${n} tok`);
export const usageText = (costUsd?: number | null, tokens?: number | null): string => [formatCost(costUsd), formatTokens(tokens)].filter(Boolean).join(" · ");

export function activityText(a: Activity): string {
  const diff = a.added !== undefined || a.removed !== undefined ? `  +${a.added ?? 0} −${a.removed ?? 0}` : "";
  const exit = a.status === "error" && a.exitCode !== undefined ? ` (exit ${a.exitCode})` : "";
  return `${a.label}${diff}${exit}${a.status === "denied" ? " denied" : ""}`;
}

export const messageHeadline = (m: Message): string => `${partyLabel(m.from)} → ${partyLabel(m.to)}  ${m.headline}`;

/** Who makes each agent; the name the UI writes beside its mark. */
export const PROVIDERS: Record<Agent, { agent: string; company: string; mark: string }> = {
  claude: { agent: "Claude", company: "Anthropic", mark: "✻" },
  codex: { agent: "Codex", company: "OpenAI", mark: "◎" },
};

/** "Claude (implementer)", or just "Claude" for a call that belongs to no pipeline role (a chat answer). */
export const whoLabel = (agent: Party | string, role?: Role): string => `${partyLabel(agent)}${role ? ` (${roleLabel(role)})` : ""}`;

/** The turn's identity once the agent's own stream named its model. */
export const withObserved = (m: ModelIdentity, model: string): ModelIdentity => ({ ...m, resolved: model, source: "observed", status: "resolved", reason: null });

/**
 * What an answered turn shows of its activities: what the agent did, not its prose (the answer is shown whole once,
 * so a "say" line with its first line, or a "submitting result", would only repeat it).
 */
export function answerActivities(activities: Activity[], answer: string | null): Activity[] {
  const first = answer === null ? null : (answer.trim().split("\n")[0] ?? "").trim();
  return activities.filter((a) => a.kind !== "submit" && !(a.kind === "say" && first !== null && first.startsWith(a.label.replace(/…$/, ""))));
}

const looksLikeAlias = (name: string) => !/\d/.test(name);

/**
 * The model as it should be read: an explicit choice as is (with what it resolved to), else "default → …" with the
 * name the CLI's configuration gives, a note while it is unconfirmed, or why it is not known.
 */
export function modelText(m: ModelIdentity | null | undefined, o: { short?: boolean } = {}): string {
  if (!m) return "unknown";
  if (!m.isDefault) {
    const requested = m.requested ?? "?";
    return m.resolved && m.resolved !== requested ? `${requested} → ${m.resolved}` : requested;
  }
  switch (m.status) {
    case "resolved":
      return `default → ${m.resolved}`;
    case "configured":
      return o.short ? `default → ${m.configured}?` : `default → ${m.configured} (configured${looksLikeAlias(m.configured ?? "") ? " alias" : ""}; awaiting confirmation)`;
    case "resolving":
      return "default → resolving…";
    case "unresolved":
      return o.short || !m.reason ? "default → unknown" : `default → unknown (${m.reason})`;
  }
}

// ------------------------------------------------------------------ /discuss
/** What a discussion's turn is: "answer, version 2", "review of version 1", "final answer (synthesis)". */
export function discussionStepText(place: { step: DiscussionStep; round: number }): string {
  switch (place.step) {
    case "answer":
    case "revise":
      return `answer, version ${place.round}`;
    case "critique":
      return `review of version ${place.round}`;
    case "synthesis":
      return "final answer (synthesis)";
    case "final":
      return `final answer, version ${place.round}`;
  }
}

/** What an agent is doing in a discussion turn, while it works. */
export function discussionDoing(place: { step: DiscussionStep; round: number }): string {
  switch (place.step) {
    case "answer":
      return "answering";
    case "critique":
      return `reviewing version ${place.round}`;
    case "revise":
      return `revising: version ${place.round}`;
    case "synthesis":
      return "synthesizing the final answer";
    case "final":
      return "writing the final answer";
  }
}

/** How many lines of a discussion's turn the terminal shows (the final answer is shown whole; --verbose shows all). */
export const DISCUSSION_LINES = 8;

/** The first `n` lines of `text`, and how many more it has. */
export function firstLines(text: string, n: number): { shown: string; more: number } {
  const lines = text.trimEnd().split("\n");
  return { shown: lines.slice(0, n).join("\n"), more: Math.max(0, lines.length - n) };
}

/** Who wrote a discussion's answer: Codex for a synthesis; the answerer for a discussion from before synthesis, or when it failed. */
export const discussionAuthor = (d: { answerer: Agent; answerBackend?: Agent }): Agent => d.answerBackend ?? d.answerer;

export const verdictText = (v: Verdict | null | undefined): string => (v === "agree" ? "AGREE" : v === "revise" ? "REVISE" : "no verdict, taken as REVISE");

/** How a discussion ended, in a few words. */
export function discussionOutcome(d: { status: DiscussionStatus; answerer: Agent; critic: Agent; rounds: number }): string {
  const reviews = `${d.rounds} review${d.rounds === 1 ? "" : "s"}`;
  switch (d.status) {
    case "agreed":
      return `${PROVIDERS[d.critic].agent} agreed after ${reviews}`;
    case "disputed":
      return `no agreement after ${reviews}`;
    case "interrupted":
      return "stopped";
    case "error":
      return "failed";
  }
}
