/**
 * What a run waiting for a decision needs from you, by the reason it waits. No imports: the webviews bundle it.
 */

/**
 * A run waiting on the implementer's blocker needs something from you (a note, or files you changed) before `resume`
 * runs it again; agentduo keeps it waiting otherwise (src/core/progress.ts).
 */
export const needsInput = (reason: string | null | undefined): boolean => reason === "implementer_blocked" || reason === "no_progress";

/** How `duo resume` answers a run waiting with this reason (`cmd`: how agentduo was started). */
export const decisionCommand = (cmd: string, runId: string, reason: string | null | undefined): string => (needsInput(reason)
  ? `${cmd} resume ${runId} --decision resume --note "<what the implementer needs>" (or after changing the files), or --decision revise|abort`
  : `${cmd} resume ${runId} --decision resume|revise|abort [--note "..."]`);
