# agentduo: contradictory requirements and pre-existing failures

Status: implemented. Amends `2026-10-27-agentduo-channel-design.md` (§5 escalation reasons, DONE). Builds on
`2026-11-03-agentduo-review-state-design.md`. Amended by `2026-11-03-agentduo-scope-design.md`, which widens a
finding's `in_scope` and adds `out_of_scope` for what the task does not ask, and by
`2026-11-03-agentduo-final-verification-design.md`: an accepted gate is still attributed by every later review, and a
failure the change made worse (or a changed command) is never covered by the acceptance.

## Problem

A plan could contain requirements that cannot all hold. In the run where this was seen, the plan kept unrelated
layout defects that were there before the task out of scope, while its verification criteria needed those defects
gone. Nothing noticed:

- **No baseline.** agentduo never ran the gates before the change, so a failure that was already there looked
  exactly like a regression.
- **No consistency check.** The planner and the critic were never asked whether the criteria, the scope and what
  already fails agree with each other.
- **No attribution.** The reviewer did not say whether a problem came from the change or was there before.
- **So the run looped.** A pre-existing failure outside the scope went back to the implementer round after round. The
  implementer could only go out of scope or fail again, until a round limit or the budget stopped the run, with no
  sign of the real cause.

## What the user gets

- **A baseline.** When gates are configured, a new run runs them once before its first plan, as a step of its own (a
  PLAN step by `gates`: "baseline failing" or "baseline passed"). The results go into `state.baseline` (with the tree
  they ran on) and into `gates.baseline.json`. Each role's fresh prompt shows them ("Quality gates before any change"),
  and so does the report. Older runs, and runs past their first plan, have no baseline and behave as before.
- **The plan says what it does about each one.** The plan schema gains `baseline_failures: [{ gate, in_scope,
  rationale }]`. The plan's check requires an entry for every required gate that fails at the baseline, so a plan
  that leaves one out is retried. The plan's markdown has a "Baseline failures" section ("fixed by this plan" or
  "left out of scope").
- **A consistency check before implementation.** The critic is asked to check the plan's criteria and scope against
  the task's own requirements and the baseline. A contradiction the plan can resolve without changing what the task
  asks is an ordinary issue. A contradiction whose resolution would change what the task asks goes into the
  critique's new `conflicts: [{ id, description, between }]`. Neither the planner nor the critic may settle it by
  bending the task. agentduo adds one contradiction of its own, found without a model: a required gate that fails at
  the baseline and that the plan leaves out of scope, while `require_tests_pass` makes DONE need it to pass.
- **Conflicts stop the run before any implementation.** Any conflict escalates `requirements_conflict` after the
  critique, whether or not it approved. The details list each conflict, and the choices are:
  - *Implement as planned* (`resume`): freezes the latest plan as accepted by you, and records the conflicts in
    `state.accepted.conflicts`.
  - `revise` with a note that settles it: re-plans, and the critique stays the planner's feedback.
  - `abort`.
- **Pre-existing failures are told apart from the task's.**
  - *Gates* (`gateVerdicts`): a failing required gate is a *regression* if it passed at the baseline, or if there is
    no baseline for it (a new gate, or a changed command). It is *in scope* if it failed then and the plan fixes it.
    It is *pre-existing* only if it failed then, the plan leaves it out of scope, and the reviewer attributes it so
    with evidence.
    - In VERIFY, a run whose only failing gates are candidates for pre-existing (or ones you accepted) goes to the
      reviewer, not back to the implementer. Such gates do not count towards `max_consecutive_gate_failures`, and
      VERIFY records them as "failing as before the task".
  - *Findings*: every finding now has an `origin` and its `evidence`:
    - `regression`: the change causes it;
    - `in_scope`: it was there before, and the plan fixes it;
    - `pre_existing`: it was there before, and lies outside the scope;
    - `unclear`, which counts as the task's.

    The review's check requires evidence for every blocking finding, and a `gate_failures` entry with evidence for
    every gate it is asked to attribute. The reviewer is told to approve the change on its own merits: a pre-existing
    problem outside the scope does not weigh against its approval, but must still be reported, with evidence.
- **No impossible loop.** Suppose a review leaves nothing the task can fix (no blocking regression, `in_scope` or
  `unclear` finding, and no regression or in-scope gate), but at least one pre-existing blocker. The run then
  escalates `preexisting_failures`, listing each blocker with its evidence, instead of starting a fix round. The
  choices are:
  - *Accept as pre-existing* (`resume`): records them in `state.accepted.failures`. If the review approved (or
    approval is not required), the run ends DONE. Otherwise the reviewer reviews once more, told what you accepted,
    so that its approval is still required.
  - `revise` with a note: re-plans, for example to bring the blockers into scope.
  - `abort`.

  When fixable blockers remain, the fix round goes on as before. The implementer is told which findings are
  pre-existing and outside its scope: "do not fix it; answer it `not_applicable`".
- **Nothing is waived silently.**
  - *DONE*: there are only two ways past a blocker, `resume` on these two reasons. DONE's summary then names them:
    "quality gates passed, except 'layout', failing as before the task and the review approved; you accepted 1
    pre-existing failure(s) outside the task's scope (gate 'layout')".
  - *Report*: it gains "Accepted by you", and pre-existing findings are marked in "Unresolved issues".
  - *Re-planning* (`revise`) clears everything accepted, and anything still waiting for a decision.

## Design

`src/core/acceptance.ts` holds the rules and does no I/O: `baselineFailures`, `missingBaselineEntries`,
`outOfScopeGates`, `requirementConflicts`, `gateVerdicts`, `attributionErrors`, `splitFindings`,
`preexistingFailures`, the two messages, `acceptPending` and `acceptedText`. The workflow places the checks:

- **`runBaseline`.** It runs in `stepPlan`, before the first planner call, when `baselinePending()` holds (gates
  configured, no baseline, no plan, no base snapshot). It records its own step and starts the planner's step after it,
  adding the gates' time to `activeSec`. `emitPhaseStarted` names `gates` as the agent of that first step.
- **`stepPlanReview`.** It computes the conflicts after recording the critique, and escalates before the approval
  branch.
- **`stepVerify`.** It routes on `gateVerdicts(attributions: null)`.
- **`stepCodeReview`.** It asks the reviewer to attribute the gates that `gateVerdicts` calls pre-existing before the
  review, checks the attributions, and decides with `attributions: review.gate_failures`. `preexisting_failures` has
  `resumePhase` `DONE` or `CODE_REVIEW`.
- **`applyDecision`.** It calls `acceptPending` on `resume`. `revise` clears `conflicts`, `preexisting` and
  `accepted`.

**State** (all optional): `baseline`, `conflicts`, `preexisting`, `accepted`. **Schemas**: plan
`baseline_failures`, critique `conflicts`, review findings `origin` and `evidence`, review `gate_failures`, all
required and OpenAI-strict. The UI labels the resume choice by reason (`resumeLabel`).

## Not done, and why

- **Judging the plan's consistency in code.** Whether a criterion clashes with a scope item is a reading of prose.
  The critic does it, with a narrow duty: name only what the user must settle. agentduo checks in code what it can
  check exactly, which is the gates.
- **Comparing gate output with the baseline's.** No general parser for test output exists. A gate failing before and
  after may hide a new failure, so agentduo never counts it as pre-existing on its own: it needs the reviewer's
  evidence, and even then it only stops to ask.
- **Waiving a pre-existing failure automatically.** That is exactly the silent waiver the task forbids. The run asks
  instead; asking costs no tokens.
- **A baseline at the start of implementation.** Planning agents are read-only, so the workspace at the first plan is
  the one implementation starts from. If the user edits files during planning, the reviewer's evidence still decides.

## Tests

- `test/acceptance.test.ts`: baseline entries; gates left failing; conflicts (the critic's, the gate rule, and
  `require_tests_pass` off); gate verdicts (regression, in scope, pre-existing before and after the review, missing or
  empty evidence, changed command, accepted); attribution errors; the finding split; accepting and saying it.
- `test/workflow.test.ts` ("contradictory requirements and pre-existing failures"), through `fake-agent.mjs`, with a
  layout gate failing before the task:
  - **a gate left out of scope**: stops before implementation; *implement as planned*; VERIFY sends the layout gate
    to the reviewer rather than the implementer; `preexisting_failures` instead of a loop; *accept*; DONE naming it;
    the report's "Accepted by you";
  - **the critic's conflict**: stops before implementation, and `revise` with a note settles it;
  - **a missing attribution**: retried; the reviewer's `regression` sends the gate to the implementer;
  - **a pre-existing finding**: a fix round for the task's finding only (the implementer is told), then a stop, then
    *accept* and a re-review with the accepted finding, then DONE;
  - **evidence**: required for a blocking finding.
- `test/prompts.test.ts`, `render.test.ts`, `format.test.ts` and `vscode-view-state.test.ts` cover the baseline,
  the consistency check, the attribution rules, the accepted list, the plan and critique markdown, and the labels.
- Existing tests take the baseline step: the timeline and messages begin with it, the VS Code session shows it as
  its own PLAN step, and stopping a gate now stops the baseline gate.
