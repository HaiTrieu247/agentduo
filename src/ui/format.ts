import type { Activity, Message, Party, PermissionAnswer, Phase, Role } from "../events.js";

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
