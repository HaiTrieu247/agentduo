// What the Activity Bar's Account & Usage view shows, as rows (no DOM, so it is tested as is): each agent with its
// plan and email, then each of its limits with a meter, as Claude Code's own sidebar shows its account and usage.
import type { UsageState } from "../../../src/core/usage.js";
import type { Agent } from "../../../src/events.js";

export interface AccountRow {
  kind: "agent" | "field" | "group" | "limit" | "bar" | "muted" | "error" | "text";
  /** What the row says: the agent, a field's or a limit's name, a note. */
  text: string;
  /** Beside it, on the right: the agent's plan, a field's value, a limit's percent. */
  value?: string;
  /** A bar's fill, 0 to 100. */
  percent?: number;
}

export const ACCOUNT_AGENTS: Record<Agent, string> = { claude: "Claude Code", codex: "Codex" };

/** One agent's part: always its name (and its account once known), so both agents show whatever answered. */
export function accountRows(agent: Agent, state: UsageState | null): AccountRow[] {
  const rows: AccountRow[] = [];
  const ready = state?.status === "ready" ? state.usage : null;
  rows.push({ kind: "agent", text: ACCOUNT_AGENTS[agent], ...(ready?.account ? { value: ready.account } : {}) });
  if (!state || state.status === "loading") return [...rows, { kind: "muted", text: "loading…" }];
  if (state.status === "error") return [...rows, { kind: "error", text: state.error }];
  if (ready!.email) rows.push({ kind: "field", text: "Email", value: ready!.email });
  for (const group of ready!.groups) {
    if (group.title) rows.push({ kind: "group", text: group.title });
    for (const limit of group.limits) {
      const percent = Math.min(100, Math.max(0, limit.usedPercent));
      rows.push({ kind: "limit", text: limit.label, value: `${limit.usedPercent}%` }, { kind: "bar", text: `${limit.usedPercent}% used`, percent });
      if (limit.resets) rows.push({ kind: "muted", text: limit.resets });
    }
  }
  for (const note of ready!.notes) if (note.trim()) rows.push({ kind: "text", text: note.trim() });
  return rows;
}

/** "Updated just now", "Updated 4 min ago", "Updated 2 h ago": how old the numbers shown are. */
export function updatedText(updatedAt: number | null, now: number): string {
  if (updatedAt === null) return "";
  const minutes = Math.floor((now - updatedAt) / 60_000);
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes} min ago`;
  return `Updated ${Math.floor(minutes / 60)} h ago`;
}
