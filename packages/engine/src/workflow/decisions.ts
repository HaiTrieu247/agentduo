/**
 * What a run waiting for a decision needs from you, by the reason it waits. No imports: the webviews bundle it.
 */

/**
 * A run waiting on the implementer's blocker, or on a review loop that stalled, needs something from you (a note, or
 * files you changed) before `resume` runs another round; agentduo keeps it waiting otherwise (packages/engine/src/quality/progress.ts).
 */
export const needsInput = (reason: string | null | undefined): boolean =>
  reason === "implementer_blocked" || reason === "no_progress" || reason === "review_stalled";

/** How `duo resume` answers a run waiting with this reason (`cmd`: how agentduo was started). */
export const decisionCommand = (cmd: string, runId: string, reason: string | null | undefined): string => (reason === "clarification_required"
  ? `${cmd} resume ${runId} (answers the questions in the terminal) or ${cmd} resume ${runId} --answers <file> (a template is in \`${cmd} status ${runId}\`), or --decision abort`
  : needsInput(reason)
  ? `${cmd} resume ${runId} --decision resume --note "<what the implementer needs>" (or after changing the files), or --decision revise|abort`
  : `${cmd} resume ${runId} --decision resume|revise|abort [--note "..."]`);
