# agentduo: review findings kept in step with the code

Status: implemented. Builds on `2026-11-03-agentduo-context-sharing-design.md` and
`2026-11-03-agentduo-no-progress-design.md`.

## Problem

A review's findings (`state.openFindings`) were stored without the revision they were about, and they stayed "open"
until the next review, whatever happened in between. This caused five problems:

- **Gates failing after a fix round.** When the gates failed after a fix round (and `review_on_gate_failure` was off),
  the run went to another round without a review. That round's implementer got the same findings as must-fix, though
  it had answered them the round before. Each one it did not answer again raised "implementer did not respond".
- **Blocked attempts.** An attempt that ended blocked could fix some findings and answer them. A re-run of the round
  then overwrote `implementation.r<k>.json`, and the re-run's prompt listed every finding as open again. A fresh
  session (a lost one, or a CLI with sessions turned off) was not told that the earlier attempt's edits were in the
  tree, nor, in round 1, that there was any earlier attempt at all.
- **Code reviewer.** The reviewer saw only the last attempt's `addressed_findings`. So an answer given by a blocked
  attempt, or in a round whose gates failed, showed as "no response".
- **Edits outside a step.** Files could change after a step's snapshot, for example the user's edits while the run
  waited for a decision or was stopped. The next VERIFY credited those edits to the gates ("quality gates modified the
  working tree"). The next CODE_REVIEW reviewed the older snapshot while telling the reviewer "the workspace currently
  equals the revision under review". Gate results could also be for an older revision than the one reviewed, so
  `DONE` could say "quality gates passed" about code the gates never ran on.
- **Stale findings.** Nothing said that a finding's file had changed since its review, so neither its line nor whether
  it still held could be trusted.

## What the user gets

- **Findings name their revision.** `state.findingsSource = { round, revision }` is set when a review stores its
  findings. The implementer's and the reviewer's prompts say "raised on revision `abc123def456`". The report lists
  each finding with the revision it was raised on.
- **Answers are kept until the next review.** `state.findingResponses` holds the latest answer per open finding
  (resolution, notes, the round, and whether that attempt completed or was blocked). It is filled from every valid
  implementation report, blocked ones included. Only a review replaces the open findings and their answers
  (`setFindings`): a review is the fresh evidence. Re-planning clears both.
- **The implementer's prompt separates the two kinds of finding.**
  - *Open: not answered since that review.* It must answer these.
  - *Answered since that review, not verified yet.* It shows its own answer and is told to leave these alone unless
    the current code shows the answer no longer holds.
  - It also gets the files changed since the revision. Each finding whose file changed, was deleted or was added
    since then is marked: it may be fixed already, or its line may have moved.
  - The warning "did not respond" counts only unanswered findings, and never fires for a blocked attempt, which stops
    before some findings by its nature.
- **The reviewer gets every answer** since its review, whichever attempt or round gave it, with the same
  changed-since-revision marks. A finding answered `fixed` whose file did not change is marked so. The reviewer is
  told that the answers are claims, to be verified against the revision under review, not the one the finding was
  raised on.
- **A re-run goes on from the earlier attempt's partial work.** When a round's pre snapshot already exists, the
  prompt gets "An earlier attempt of this round". That section says:
  - how the earlier attempt ended (blocked with its reason, completed, or did not finish);
  - its report, for a fresh session;
  - the files the round changed so far;
  - "continue from them; do not start over or undo them unless they are wrong".

  `implementation.r<k>.json` keeps every attempt. `attempt_changes` holds that attempt's own changes. `changes` holds
  the round's changes, as before. `earlier_attempts` holds each earlier attempt's snapshot, status, summary, blocking
  reason, answers and changes.
- **Steps take the workspace as it is.** VERIFY and CODE_REVIEW first call `catchUp`: if the workspace tree differs
  from the last snapshot, they re-snapshot the round (`impl-r<k>`) and warn "N file(s) changed after the last
  snapshot, not by the run's last step: …; <PHASE> takes the workspace as it is now". The gates' own changes are
  still told apart, after they run.
- **Reviews of gated code.** `state.gatesTree` records the tree the gates ran on. If CODE_REVIEW finds it differs from
  the tree to review, it records "gates out of date" and goes back to VERIFY, once a round (`reverifiedRound`), so a
  file that keeps changing cannot hold the run in a loop. If the files changed again, the review goes ahead with a
  warning, and `DONE` says "quality gates passed on an earlier revision".

## Design

`src/core/findings.ts` holds the rules and does no I/O: `fileChange`, `reviewFindings`, `recordResponses`,
`unanswered` and `setFindings`. Paths are compared the way repository notes compare them: `workspacePath`, which was
factored out of `context.ts`, and `touched`, which treats a finding about a folder as touched when anything under the
folder changed. The changes since a revision come from `Git.nameStatus(revision, tree)`. If that revision is gone,
the result is null, and the prompt says that agentduo cannot tell.

**State** (all optional, so `STATE_VERSION` stays 1): `findingsSource`, `findingResponses`, `gatesTree`,
`reverifiedRound`, and `lastImplementation.blockingReason`. An older run has no `findingsSource`; it takes the round
and `reviewed_commit` from `review.json`. With no `gatesTree`, the gates count as having run on the last snapshot, as
before, so resuming an older run re-runs its gates only when its files changed.

**Prompts.** `prompts.implementer` takes `ReviewFindings | null` and `{ summary, rerun }`.
`prompts.codeReviewer` takes `ReviewFindings | null` in place of the bare findings, and reads the answers from it
rather than from the last report.

## Not done, and why

- **Re-reviewing stale findings on their own.** Revalidation is the next review, which the round has anyway. A review
  only to check old findings would cost a call and see no new code.
- **Dropping a finding because its file changed.** A changed file does not show that the finding is fixed: the
  finding is marked instead, and the reviewer decides.
- **Telling which edits during an agent's turn were the user's.** Changes made while an agent runs are credited to
  its turn, as before. agentduo has one tree before the turn and one after, nothing in between.
- **Matching findings across reviews by content.** Reviewers keep the ids of the findings they re-raise, which is
  enough to carry answers forward, and content matching would be guesswork.

## Tests

- `test/findings.test.ts`: `fileChange` (path forms, folders, deletions, general findings, unknown changes); answers
  (latest wins, blocked ones kept, findings that are not open ignored, replaced by a review); the view.
- `test/prompts.test.ts`: open and answered findings, the changed-since marks, "cannot tell", every finding answered,
  the earlier-attempt section (blocked, did not finish, no duplicated report), and the reviewer's answers with
  file-change marks.
- `test/workflow.test.ts` ("review findings kept in step with the code"), through `fake-agent.mjs`:
  - **blocked execution with partial edits**: answers and edits kept, the re-run told about them with only F2 open,
    the reviewer given both answers, and the round record holding both attempts;
  - **stale findings after failing gates**: the next round is not asked again;
  - **resume after edits made while the run was stopped**: VERIFY takes them as they are, and the review sees them;
  - **resume into a review whose gates are out of date**: the gates run again, the broken file goes back to the
    implementer, and only gated code is reviewed;
  - **files that keep changing**: the gates re-run at most once a round, and the summary says so.
