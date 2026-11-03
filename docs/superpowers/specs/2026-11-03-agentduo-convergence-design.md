# agentduo: review loops that converge, and retries that are told why

Status: implemented. Amends `2026-10-27-agentduo-channel-design.md` (§5 escalation reasons). Builds on
`2026-11-03-agentduo-review-state-design.md` (revision-aware findings), `2026-11-03-agentduo-no-progress-design.md`
(the circuit breaker) and `2026-11-03-agentduo-scope-design.md` (the scope contract). Extended by
`2026-11-03-agentduo-profiles-design.md`, which applies the same identity tracking and stall rule to plan critiques
(`planning_stalled`).

## Problem

Fix rounds could repeat without making progress, and nothing told such a loop apart from productive iteration:

- **No finding identity.** Each review replaced the open findings. When a reviewer renumbered or reworded an issue, the
  run had no way to tell that it was the same one, so it could not see that a review left the same problems as the
  review before it.
- **A completed report was not progress.** The implementer could answer `fixed`, change nothing, and report
  `completed`. The next review raised the same findings, and another fix round started, up to `max_review_rounds` or
  the budget.
- **Churn.** A reviewer could raise new critical or high findings in a later round, about code that had not changed,
  without saying why it had not raised them before. Each one became another fix round.
- **Retries forgot why.** When a check rejected an answer from a continued session, the retry ran in a fresh session
  with no rejection note: it could not see the rejected answer and was not told what was wrong, so it could repeat it.
  A non-resumed retry was told the reason, but not given the answer it rejected, so it redid the whole turn.

## What the user gets

- **A stable identity for each finding** (`state.trackedFindings`, `src/core/findings.ts`). Every review's findings
  are matched to the ones raised before:
  - *By id.* A match needs the same file, or close words (the reviewer may have cited another file).
  - *Otherwise by words.* The same file, criteria that meet, and close words: Dice's coefficient of the words, without
    stopwords and with light stemming, at least 0.5 (0.6 for a finding with no file).

  The match must be unambiguous: a finding with two possible matches, or two findings that could be the same earlier
  one, stay apart. An id reused for an unrelated issue gets a key of its own (`F1@r2`).

  Each finding of a review is `new`, still `open`, or `reopened` (raised again after a review resolved it). Each open
  finding a review leaves out is `resolved` by that review. The implementer's `fixed` is a claim: only the next
  review resolves a finding. The review's record (`review.r<k>.json`) keeps the matching (`tracking`). An older run's
  ledger starts from its open findings.
- **Progress, measured by what moved** (`state.cycles`, `src/core/progress.ts`). Each review closes a cycle (fix
  round, gates, review). It is compared with the review before it, under the same plan. The cycle made progress when:
  - the review resolved a blocking finding;
  - one no longer blocks (downgraded, or reclassified out of the task);
  - a required gate the task had to fix passes now;
  - or a file of a blocking finding changed (any file, for a finding with no file; a changed tree, when git cannot
    tell).

  Repeated reports, renumbered findings and new wording are not progress. The first review of a plan, and a review
  after one where nothing blocked, are not judged.
- **`review_stalled`.** Before a fix round, the run stops instead of reviewing the same findings again in two cases:
  - two cycles in a row made no progress (`STALL_CYCLES`);
  - or one made none and the workspace did not change at all (the implementer reported `completed` and changed no
    file).

  A productive round, or one cycle that changed some files without moving the findings, goes on as before. The
  details list:
  - each finding that kept blocking: its identity, the id this review gave it, the rounds and revisions that raised
    it, and the implementer's answer;
  - what the implementer did in the cycle ("changed no file", "changed only notes.md (none of these findings' files)");
  - the count.

  Nothing is waived: the findings stay open and still block `DONE`.
- **Recovery, as after a blocker.** `review_stalled` is a reason that needs something from you (`needsInput`), so every
  UI offers *Unblock and retry*.
  - `resume` starts another fix round only if something the implementer is given changed since the stall (the
    `ProgressMark`: files, notes, plan, findings, settings). A note always counts. It is your explicit override, and the
    run records it with your decision. With nothing new, the run waits again, saying so, and no agent is called.
  - `revise` with a note re-plans, keeping the implementation in your files, and clears the stall.
  - `abort` keeps everything for the report.

  A round after a resume that again makes no progress stops again.
- **Late findings need a reason.** Findings get `late_reason` (nullable). In a review after an earlier one, the
  check rejects a finding that is:
  - blocking and new (matching no earlier one);
  - about a file that did not change since that review, or, with no file, raised when nothing changed;
  - and without a `late_reason`.

  The error asks for the earlier finding's id if it is the same issue in other words, or for the reason. A
  legitimately new finding with its reason is accepted, whenever it comes. Findings outside the task's scope below
  critical block nothing and are not asked. When git cannot tell what changed, nothing is asked.

  Evidence for a blocking finding, and valid criteria for one the task must fix, were already required (the acceptance
  and scope contracts). The reviewer is told to keep a finding's id when it raises the finding again, and is shown
  what earlier reviews resolved (ids and words, at most 20).
- **Retries are told exactly why** (`src/agents/runner.ts`). An answer that is not JSON, or that fails the schema or
  the role's check, is a rejection. The next attempt's prompt is the whole prompt plus "Your previous answer was
  rejected", which carries:
  - the reasons;
  - "correct exactly these points … there is no need to redo the work";
  - the rejected answer itself (at most 20,000 characters).

  This now also holds for the fresh session that follows a rejected answer in a continued session ("given in a session
  you cannot see"). The note carries only the role's own answer and agentduo's reasons, nothing of another agent's.

  If the same rejection comes back after the attempt was told what to correct, the call stops there, without the
  attempts it has left: "the same invalid answer came back after it was told what to correct". Each attempt is counted
  against the run's budget, as before.

  When a call fails, `agent_error`'s details list the last rejection's reasons. A lost session still gets the whole
  prompt with no note.
- **Reports and status.**
  - The report gains "Findings across reviews" (each identity: its ids, first and latest words, rounds, status,
    reopenings), "Review rounds" (new, still open, reopened, resolved, and the cycle's progress or "no progress") and
    "Rejected answers" (each call's rejections, latest reasons, and outcome).
  - `duo status` gives a line for each.
  - The timeline and "Accepted by you" record your decisions as before.

## Design

- **`src/core/findings.ts`** holds the identity rules and does no I/O: `wordsAlike`, `matchFindings`, `ledgerOf`,
  `trackReview` and `lateFindingErrors`.
- **`src/core/progress.ts`** holds the stall rules next to the blocker's: `cycleProgress`, `nextStall`, `stallReview`
  and `stallHeldReview`. The hold reuses `ProgressMark` and `changedParts`.
- **`stepCodeReview`:**
  - before the call: reads the previous review (`review.json`) and the files changed since its revision, and checks
    `lateFindingErrors`;
  - after it: `trackReview` (`state.trackedFindings`, the envelope's `tracking`), then the cycle (`state.cycles`, at
    most 50) and `nextStall`;
  - escalates `review_stalled` (resume phase `IMPLEMENT`) before `critical_finding` and before the next round. That
    keeps it ahead of `max_review_rounds`, so the stop names the real cause.
- **`applyDecision`:**
  - `stallHolds` holds a resume with nothing new;
  - `revise` clears `stall`.
- **The runner:** `AgentResult.rejections`, `rejectionNote`, and the repeat stop.
- **Workflow records:** the workflow keeps each call's rejections in `state.rejected` (at most 30).
- **State** (all optional): `trackedFindings`, `cycles`, `stall`, `rejected`.
- **Schema:** review findings gain `late_reason` (string or null, required, OpenAI-strict).

## Not done, and why

- **A configurable threshold.** Two cycles is a constant (`STALL_CYCLES`). A cycle that changed nothing at all
  already stops, and a cycle that changed a finding's file is always progress, so the constant only decides how many
  cycles may change unrelated files before the run asks.
- **Semantic matching of findings.** Words and files are compared in code, and the matching is conservative: when it
  is unsure, two findings stay apart. A heavily reworded finding under a new id then counts as new. The churn check
  asks the reviewer for its old id when its file did not change. The stall check only compares the findings that
  blocked before, so a missed match makes the run see progress (that finding "resolved") and wait longer. It never
  makes the run stop sooner.
- **Planning loops.** The stall check is about fix rounds. Planning stays bounded by `max_planning_rounds`; the
  retry feedback helps every role.
- **Judging whether a code change is a real fix.** That is the review's job. A change to a finding's file counts as an
  attempt, so a run in which the implementer keeps changing that file stops only at `max_review_rounds` or its budget.

## Tests

- `test/findings.test.ts`:
  - identity across wording, order and ids;
  - a new finding, ambiguous matches, a reused id and criteria that do not meet stay apart;
  - resolved and reopened;
  - an older run's ledger;
  - late findings (asked, explained, changed file, below blocking, out of scope, unknown changes, reworded).
- `test/progress.test.ts`: cycle progress for every signal and for none; the stall count and its stop; the messages.
- `test/runner.test.ts`:
  - each retry is told the latest reasons and shown its answer;
  - a fresh session after a rejected continued answer is told why;
  - the same invalid answer stops the retries early.
- `test/workflow.test.ts` ("review loops that do not converge"), through `fake-agent.mjs`:
  - completed with no change and the same finding renumbered: stops at once; a resume with nothing new is held; a
    note resumes; the next review resolves the finding; the report shows the identities and rounds;
  - productive rounds are not stalled;
  - one cycle that changed only unrelated files goes on, the second stops, and abort keeps the state;
  - a late finding without a reason: the fresh retry is told exactly that; the same answer again stops the call with
    the reason in `agent_error`; resume, explained, goes on to DONE;
  - `revise` from a stall re-plans and keeps the files.
- `test/render.test.ts`, `prompts.test.ts`, `format.test.ts`: the report's sections (and none for an older run), the
  reviewer's instructions, the labels.
