# agentduo: no repeated resume on an unchanged blocker

Status: implemented. Amends `2026-10-27-agentduo-channel-design.md` (§5 escalation reasons).

## Problem

When the implementer reports `status: "blocked"`, the run escalates `implementer_blocked`, and `resume` re-runs the
same implementation round. Nothing checked whether anything had changed since the blocker. A resume with no note, no
file changed and no setting changed gave the implementer the same inputs, and so produced the same blocker at the
same cost. In the run where this was seen, several resumes in a row repeated one blocker. The prompt's "Resume"
choice ("re-run this implementation round") also suggested that trying again was the way out, when the blocker
actually needed something from the user.

## What the user gets

- **A circuit breaker on blockers.** When the implementer reports a blocker, the run records it (`state.blocker`)
  together with a *mark* of what the implementer had been given. A later `resume` into that round runs the
  implementer only if one part of the mark has changed. Otherwise no agent is called: the run waits again with the
  reason `no_progress`. Its message names the blocker and what would unblock it. Phase, round, snapshots, sessions,
  usage and the blocker are all unchanged.
- **What counts as something new** (`ProgressMark`):

  | Part | Compared | Typical change |
  |---|---|---|
  | `tree` | the workspace's snapshot tree after the blocked attempt | the user added the file or config it needs |
  | `notes` | how many human notes the attempt was given | a note with the decision, a chat note while waiting, `/resume <note>` |
  | `plan` | the final plan's hash | (only `revise` changes it, and `revise` also clears the blocker) |
  | `findings` | a digest of the open findings | (likewise) |
  | `settings` | which CLI implements, what agentduo passes it (`bin`, `model`, `args`, `role_args.implementer`, Claude's `permission_prompts`), and that CLI's own settings files | `/claude permission-mode acceptEdits`, an allow rule in `.claude/settings.local.json` (which snapshots leave out), `~/.claude/settings.json`, `~/.codex/config.toml` |

  `notes` counts only the notes the attempt was given: a note added while it ran still counts as new. The cost cap
  (`claude.max_budget_usd`) and the other roles' arguments are not part of the mark.
- **Explicit options.** For `implementer_blocked` and `no_progress` the resume choice is labelled *Unblock and
  retry*, with the hint "re-run this round with your note or the files you changed; with nothing new it does not
  run". The note field asks for "what the implementer needs". The plain renderer, the Ink finish line, `duo status`
  and the report give the command as
  `duo resume <id> --decision resume --note "<what the implementer needs>" (or after changing the files), or --decision revise|abort`.
  The blocked message itself says the same:
  `the implementer is blocked: <reason>. It needs something from you: 'resume' with a --note …; 'resume' with nothing new does not run it again. 'revise' re-plans with your note; 'abort' ends the run.`
- **User override.** A note is always new, so the user can always retry on purpose. The note should give the
  information or instruction the implementer lacks, or say that something agentduo cannot see (a credential, a
  service, a tool) has been fixed. Changing the files or the settings also counts.
- **Repeats.** `blocker.repeats` counts attempts in a row that reported the same blocker without changing a file. The
  blocker's identity (`blockerKey`) is its reason with case, punctuation and spacing ignored. From the second repeat
  on, the escalation's details say "the same blocker N times in a row, the last attempt changing no file: what it was
  given since did not unblock it (consider 'revise' or 'abort')". The count does not block anything, because a note
  should always be able to override.
- **Retryable failures stay retryable.** `agent_error` (a timeout, a crash, output that could not be used even after
  the retries) is not a blocker, and `resume` re-runs the step as before, with or without a note. A call that fails
  after a blocker leaves the blocker and its mark as they were. Typical case: the note's retry failed, so the
  implementer never got the note. A later plain resume then still counts that note as new, and runs.

## Design

`src/core/progress.ts` holds the rules and does no I/O beyond reading the CLI settings files. It contains
`blockerKey`, `nextBlocker`, `changedParts`, `findingsDigest`, `implementerSettings`, and the two messages
`blockedReview` and `heldReview`. `src/core/decisions.ts` (no imports, so the webviews can bundle it) says which
reasons need input (`needsInput`) and how to answer them from the shell (`decisionCommand`).
`src/ui/format.ts` adds `resumeLabel`.

**State** (optional, so `STATE_VERSION` stays 1): `blocker: { reason, key, round, repeats, mark } | null`. It is
set when the implementer reports `blocked`, cleared when an implementation completes and on `revise`, and kept
through `agent_error` and `budget_exhausted`.

**Where it is checked.** `Workflow.applyDecision`, for `resume` only, after the decision's note is recorded and the
budget is raised. `blockerHolds` is true when a blocker exists for the current round, the resume target is
`IMPLEMENT` (not a new round after VERIFY or CODE_REVIEW), and `changedParts(blocker.mark, now)` is empty. In that
case the decision is recorded (human: resume) and the run escalates `no_progress`, keeping `fromPhase`
(`IMPLEMENT`) and `resumePhase`. Doing this at decision time, not inside `stepImplement`, means no phase starts and
no step is counted. It also covers every way into that round: a plain decision, a decision after `budget_exhausted`,
the CLI's `--decision`, and the in-process `Decider`. The in-process `Decider` is simply asked again, and nothing
throws.

**Settings files.** `implementerSettings` reuses the existing discovery in `models.ts`. For Claude,
`claudeSettingsSignature` digests the whole of every settings source that `claudeSettingsSources` lists (managed,
`--settings`, local, project, user), whereas `claudeLocalSignature` digests only their model fields. For Codex,
`codexLocalSignature` digests every config file it may load. A file that is rewritten with the same meaning but a
different key order counts as a change: at worst one redundant call, never a missed fix.

## Not done, and why

- **A hard stop after N repeats.** It would override a deliberate note, which the user must always be able to give.
  The repeat count informs the user instead.
- **Fuzzy matching of blockers.** Wording varies between attempts. A similarity threshold would be one more tunable
  that is hard to explain. Identity only affects the repeat count and its message, while the hold depends on the
  inputs, which are exact.
- **Watching the environment** (variables, services, logins). agentduo cannot see these reliably. The `no_progress`
  message tells the user to say so in a note.
- **A no-change review loop** (an implementer that reports `completed` with no change while the same findings
  stay open). This is a different stall, already bounded by `max_review_rounds` and the run budget. Detecting it
  would need a reliable identity for findings across reviews.

## Tests

- `test/progress.test.ts`: blocker identity, repeats (same blocker without a file change, reset by progress, by
  another blocker or by another round), `changedParts`, the messages, and `implementerSettings` (changes with the
  implementer's flags, its CLI's settings files and its backend; not with the cost cap, other roles' arguments or
  the other CLI's files).
- `test/workflow.test.ts` ("a blocked implementer runs again only on something new"), through `fake-agent.mjs`:
  - repeated blocker: two plain resumes hold with no agent call and nothing changed, then a note runs the
    implementer with it, and the run finishes;
  - the in-process `Decider` is asked again (`implementer_blocked`, `no_progress`, `no_progress`) until a note
    comes;
  - files, agentduo's implementer settings and `.claude/settings.local.json` each unblock without a note, and the
    same blocker in a row is counted and reported;
  - a retryable failure (`agent_error`) after a blocker is retried by a plain resume;
  - `revise` clears the blocker, and `abort` ends a held run.
- `test/format.test.ts`, `plain.test.ts`, `ink.test.tsx` and `vscode-view-state.test.ts`: the label, hint and
  command for each reason.
