# agentduo: DONE verified against the final code

Status: implemented. Amends `2026-11-03-agentduo-review-state-design.md` (reviews of gated code) and
`2026-11-03-agentduo-acceptance-design.md` (accepted gates). Builds on `2026-11-03-agentduo-convergence-design.md`.

## Problem

`DONE` could be reached when the code in the workspace at the end had not passed the required gates:

- **Gates of an earlier revision.** CODE_REVIEW re-ran gates that were out of date once a round. If the files changed
  again, the review went ahead with a warning, and `DONE` said "quality gates passed on an earlier revision".
- **Changes after the approval.** Files changed during or after the review were not checked. This includes the
  reviewer's own edits, edits made while the run waited for a decision, and other tools.
- **The gates' own changes.** When the gates changed files, the run took a new snapshot and recorded the gates as
  having run on it, though they never ran on those files.
- **Gate configuration.** A changed command, `required` flag or timeout (for example after
  `duo resume --reload-config`) did not make earlier results out of date.
- **Accepted gates.** Accepting a gate's failure before the task removed that gate from every later verdict. A failure
  the change made worse, or a changed command, stayed covered by the old acceptance.
- **Unclear status.** "No gates configured", "not run", "on an earlier revision" and "accepted" were not told apart
  consistently.

## What the user gets

- **The DONE invariant.** A run ends `DONE` only when all of these hold for the workspace as it is then:
  - the gates' results and the review's approval are about that code;
  - the gates ran with the gate configuration as it is then;
  - every required gate passed, or failed only where you accepted it and the approving review still finds it
    failing as before the task;
  - the latest review approved that code under the final plan (or approval is not required), leaving nothing for the
    task to fix;
  - nothing waits for your decision.

  The check is in workflow code (`finalCheck`), never in a prompt.
- **One checkpoint for every way to DONE.** These all pass through `finalCheck`:
  - a review that leaves nothing to fix;
  - a resume of `preexisting_failures` or `out_of_scope_critical` whose next step is `DONE`;
  - gates that ran again on code the review approved.
- **What the checkpoint does.** It runs no gate and no agent itself. It compares the evidence with the workspace and
  the configuration, then does one of three things:
  - *all current*: ends `DONE`, with nothing run again;
  - *same code, gates out of date* (another tree, another configuration, or unknown): goes back to VERIFY and keeps
    the approval, so gates that pass end the run without a second review;
  - *code changed after the approval*: goes to VERIFY, then a review (CODE_REVIEW without gates). The review
    continues its session with the diff since the revision it approved.
- **Bounded.** It sends the run back at most `FINAL_REFRESHES` (2) times in a row. The third time, the run stops with
  `verification_stale`.
  - The details list each reason, with the files or the configuration change.
  - *Verify again* (`resume`) resets the count and verifies the files as they are then. `revise` and `abort` work as
    elsewhere.
  - The count also starts anew when the implementer completes a round.
  - Nothing is waived: the run keeps its workspace, sessions, findings, usage and report.
- **Gates' evidence.** VERIFY records:
  - the tree the gates started on (`gatesTree`, never the tree after them);
  - the configuration they ran with (`gatesConfig`: each gate's name, command, `required` and timeout);
  - when they finished (`gatesAt`).

  `gates.r<k>.json` holds the same, plus `changed_while_running`. Files the gates (or anything) changed while they ran
  are not verified by them. CODE_REVIEW's once-a-round re-run before a review also counts a configuration change.
- **Accepted failures stay narrow.**
  - An acceptance covers a gate's failure as it was before the task. It never covers a gate that passed then, or whose
    command changed since.
  - The reviewer now attributes accepted gates too. A `regression` (or `unclear`) attribution makes the gate the
    task's to fix again, accepted or not.
  - Accepting a contradiction (`requirements_conflict`) accepts no gate failure.
  - `revise` clears every acceptance, as before.
- **A record.** `state.verification` and `verification.json` record what DONE rests on:
  - the snapshot commit and tree (dirty, untracked and deleted files included);
  - each gate's outcome: `passed`, `failed`, `timed_out`, `error` or `accepted`, with its exit code;
  - the configuration digest, and when the gates ran;
  - the approving review;
  - the accepted exceptions;
  - when the check ran;
  - `status`: one of `verified`, `exceptions`, `not_enforced` or `no_gates`.
- **Accurate words everywhere.**
  - *DONE's summary:*
    - "quality gates passed on the final code and the review approved";
    - "with accepted exceptions: quality gates passed on the final code, except 'layout', failing as before the task,
      and …";
    - "required gates failing on the final code … (require_tests_pass is off)";
    - "…; no quality gates configured".
  - *Report:* a "Verification" section; accepted gates are marked in "Unresolved issues".
  - *`duo status`:* `verification:` lines. They compare the live workspace with what the gates ran on and use the
    run's saved config. A DONE run says so when the files have changed since.
  - *Desktop:* the run's Checks view gets a "Verification" row (`FocusedRun.verification`).
  - *Status lines (`verificationLines`) for a run that has not ended:* passed on the current revision, failing, on an
    earlier revision or configuration (with why), not run yet, or none configured.

## Design

`src/core/verification.ts` holds the rules and does no I/O:

- `gateSpecs`, `configDigest` and `configChanges`;
- `gateOutcome` and `gateText`;
- `gatesStale`: why results are no evidence about a tree, where unknown counts as out of date;
- `finalProblems`, with the kinds `code`, `review`, `gates` and `blocked`;
- `nextFinalCheck`, `staleReview`, `finalVerification`, `doneText`, `verificationLines` and `verificationText`.

The workflow places the checks:

- **`stepVerify`** records `ranOn` (the snapshot after `catchUp`), the specs and the time. When the gates pass on code
  the latest review approved (`approvalCovers`), it calls `finalCheck` instead of going to CODE_REVIEW.
- **`stepCodeReview`**:
  - uses `gatesStale` for its once-a-round re-run before a review;
  - asks the reviewer to attribute accepted gates (`gatesToAttribute`);
  - sets `state.reviewApproval` when the review approves and leaves nothing for the task to fix. Pre-existing and
    scope items wait for a decision.
  - calls `finalCheck` where it set `DONE`.
- **`applyDecision`** never sets `DONE`. A resume whose next step is `DONE` calls `finalCheck` after recording the
  decision. If the check cannot look at the files, the run goes to CODE_REVIEW.
- **`finalCheck(phase)`**:
  - snapshots the workspace into `impl-r<k>` if it changed;
  - computes the problems against the approving review's `gate_failures`;
  - ends `DONE` (writing the record), sends the run back (recording "not verified" with the reasons), or escalates;
  - with a `blocked` problem, clears the approval and sends the run to a review, which decides afresh.
- **`gateVerdicts`** (`src/core/acceptance.ts`): an accepted gate is left out only while it failed at the baseline
  with the same command, and no attribution says otherwise.

**State** (all optional, so `STATE_VERSION` stays 1): `gatesConfig`, `gatesAt`, `reviewApproval`, `finalCheck` and
`verification`. An older run has no configuration recorded, so its gates count as out of date and run once more at the
checkpoint. Its approval is taken from `review.json` when that review approved the run's last snapshot, so it needs no
second review. A run that ended `DONE` before this change keeps its DONE and its old summary.

## Not done, and why

- **Running gates inside the checkpoint.** VERIFY already handles failures, re-snapshots, consecutive failures and
  messages. The checkpoint routes to it instead of running a second copy of that logic.
- **Telling which changes during a gate run are the gates' own.** agentduo sees one tree before and one after. Any
  change in between makes the results out of date, whoever made it.
- **Ignoring changed files as irrelevant.** Every file the snapshots include counts. A gate that writes such a file
  each time ends in `verification_stale`, whose message says to make it write ignored files.
- **A configurable refresh limit.** Two refreshes cover an edit, or a gate that changes a file once. The decision
  covers the rest. A setting would add configuration for a rare case.
- **Keeping both reviews of a round.** A review after a refresh is of the same round. It replaces
  `review.r<k>.json` and `diff.r<k>.patch`, while the timeline and the cycles keep both.

## Remaining limits

- **Ignored files.** Snapshots leave out ignored files (`.gitignore`), so the evidence cannot see a change to an
  ignored file a gate reads, such as `.env` or `node_modules`. Environment variables and tool versions are not part of
  the gate configuration either.
- **Changes that are undone.** A change made and undone between two snapshots, for example during a gate run or between
  the final snapshot and the moment DONE is printed, cannot be seen.
- **Exit codes.** `error` is told from `failed` by exit code: killed, 126 or 127. On Windows, `cmd` reports a missing
  command as a plain failure.

## Tests

- `test/verification.test.ts`:
  - configuration specs, digest and changes;
  - outcomes and their text;
  - staleness, including older runs;
  - every problem kind, the refresh count and the escalation's message;
  - the record and DONE's words for each status;
  - status lines.
- `test/acceptance.test.ts`: an accepted gate is not covered when the review finds it worse, when its command
  changed, or when it passed before; `gatesToAttribute`.
- `test/workflow.test.ts`, "DONE rests on the final code":
  - current evidence, with nothing run again;
  - new and deleted files after the approval: gates and a review first;
  - a file broken after the approval goes back to the implementer;
  - a reviewer's own edits are not certified;
  - edits while the run waited are verified on resume;
  - a resume with nothing changed runs nothing;
  - a changed gate configuration reruns only the gates;
  - an older run's state.
- `test/workflow.test.ts`, elsewhere:
  - files that keep changing end in `verification_stale`, and *Verify again* then finishes;
  - an accepted gate the change made worse goes back to the implementer;
  - the existing DONE summaries;
  - no gates means `no_gates`.
- `test/cli.test.ts`: `duo status` says verified, then that the workspace changed since. `test/format.test.ts`:
  *Verify again*.
