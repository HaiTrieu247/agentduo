// Both agents' accounts and limits, as the sidebar's Account & Usage box and Settings → Claude & Codex show them:
// one latest answer, for the project it was looked up with, and at most one lookup at a time for a project. No DOM,
// so it is tested as is.
import type { AccountUsage } from "../../../../extensions/vscode/src/protocol.js";
import type { ConversationItem } from "../shared/protocol.js";
import { errorText } from "./bridge.js";

/** An answer younger than this is shown as is when a view opens; older is looked up again. */
export const USAGE_STALE_MS = 60_000;
/** While a view shows usage, it is looked up again this often. */
export const USAGE_PERIOD_MS = 5 * 60_000;

/** An answer, for the project whose config it was looked up with (null: the user config). */
export interface UsageAnswer {
  projectId: string | null;
  value: AccountUsage;
  at: number;
}

export class UsageStore {
  private answer: UsageAnswer | null = null;
  private lookup: { projectId: string | null; done: Promise<void> } | null = null;
  /** Lookups started, and the one the answer comes from: a slower, older lookup does not replace a newer answer. */
  private started = 0;
  private answered = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly ask: (projectId: string | null) => Promise<AccountUsage>, private readonly now: () => number = Date.now) {}

  /** The latest answer, whichever project it was for. */
  latest(): UsageAnswer | null {
    return this.answer;
  }

  /** The latest answer if it was for this project. */
  of(projectId: string | null): UsageAnswer | null {
    return this.answer?.projectId === projectId ? this.answer : null;
  }

  looking(projectId: string | null): boolean {
    return this.lookup?.projectId === projectId;
  }

  /** Looks up again, unless a lookup for this project is under way; a failed lookup is an error for both agents. */
  refresh(projectId: string | null): Promise<void> {
    if (this.lookup?.projectId === projectId) return this.lookup.done;
    const failed = (e: unknown): AccountUsage => ({ claude: { status: "error", error: errorText(e) }, codex: { status: "error", error: errorText(e) } });
    const n = ++this.started;
    const done: Promise<void> = this.ask(projectId).catch(failed)
      .then((value) => {
        if (n < this.answered) return;
        this.answered = n;
        this.answer = { projectId, value, at: this.now() };
      })
      .finally(() => {
        if (this.lookup?.done === done) this.lookup = null;
        this.changed();
      });
    this.lookup = { projectId, done };
    this.changed();
    return done;
  }

  /** Looks up when there is no answer for this project younger than maxAgeMs. */
  ensure(projectId: string | null, maxAgeMs: number): Promise<void> {
    const a = this.of(projectId);
    if (a && this.now() - a.at < maxAgeMs) return Promise.resolve();
    return this.refresh(projectId);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }
}

/** A project's conversations changed: an agent stopped working in one of them since the last change (a turn ended,
 * and used some of a limit). `working` keeps, per project, the conversations an agent worked in. */
export function turnEnded(working: Map<string, Set<string>>, projectId: string, items: readonly ConversationItem[]): boolean {
  const before = working.get(projectId);
  const now = new Set(items.filter((c) => c.running).map((c) => c.id));
  working.set(projectId, now);
  return !!before && [...before].some((id) => !now.has(id));
}
