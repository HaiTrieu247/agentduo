# agentduo: the task's scope as an acceptance contract

Status: implemented. Amends `2026-10-27-agentduo-channel-design.md` (§5 escalation reasons, DONE). Builds on
`2026-11-03-agentduo-acceptance-design.md`.

## Problem

Reviewers could keep adding requirements the task never had. In the run where this was seen, a small audio
transcript feature grew round after round into layout, orientation and baseline UI verification work:

- **Every severe finding blocked.** The reviewer's severity alone decided whether a finding went back to the
  implementer. A high-severity "also verify landscape" was a fix requirement like a real bug.
- **No difference between a defect and an extra.** A finding could be a regression or pre-existing (the acceptance
  contract), but nothing said whether the task needed it at all.
- **No link to the requirements.** A finding named no acceptance criterion, so nobody could tell which part of the task
  it held the change to.
- **The plan grew quietly.** The critic's suggestions went back to the planner as feedback, and a revision that adopted
  them widened the plan's scope and criteria. The code reviewer then held the change to the wider plan.

## What the user gets

- **A contract with ids.** Each acceptance criterion now has an id: the plan schema's `acceptance_criteria` is
  `[{ id, criterion }]` (`AC1`, `AC2`, …), and a revision keeps the ids. The final plan's criteria and scope are the
  task's acceptance contract. The planner is told to derive them from the task. After implementation starts, only the
  user's `revise` changes them. The plan's check requires a distinct id for each criterion. Older plans list bare
  strings, which count as `AC1`, `AC2`… in their order.
- **Every reviewer item is classified against the task.**
  - *Review findings*: `origin` gains `out_of_scope`, and `in_scope` widens. Together with the acceptance contract's
    origins, a finding is one of:
    - `in_scope`: required by the task. The change does not meet the criteria it names yet, or it was there before and
      the plan fixes it.
    - `regression`: introduced by the change. It breaks behaviour that worked, or the change's own code is wrong or
      unsafe.
    - `pre_existing`: it was there before, outside the scope.
    - `out_of_scope`: an optional improvement or a concern beyond the task, which the change does not cause.
    - `unclear`, which still counts as the task's.

    Each finding also gives `criteria`, the ids of the criteria it is about.
  - *Critique and sign-off issues*: a new `scope` is `task` or `out_of_scope`.
- **Suggestions never block.**
  - *In review*:
    - An `out_of_scope` finding is never a fix requirement, whatever its severity, and never stands between the run and
      `DONE`. The one exception is a critical one (below).
    - The implementer is told not to act on such a finding and to answer it `not_applicable`.
    - The report lists it as "outside the task's scope, not the task's to fix". The run's messages mark it.
  - *In planning*: an `out_of_scope` issue never holds the plan back, in the critique or at sign-off.
- **A refusal must name a reason.** Suppose a review that does not approve has only out-of-scope findings and nothing
  else that can hold it back: no finding of the task's, no blocking pre-existing finding, no undecided critical one,
  and no failing required gate. The check rejects it and the reviewer is asked again: approve, or report what the
  task must fix. The same check applies to a critique or sign-off that refuses the plan for out-of-scope issues alone.
  Without it, such a refusal would start a fix or planning round with nothing to do.
- **Traceability, checked.** The review's check rejects:
  - a finding that cites a criterion id the final plan does not have;
  - a blocking `in_scope` finding that cites none. The message says that a problem no criterion covers is
    `out_of_scope`, or a regression if the change causes it.

  The implementer's fix round shows each finding's criteria ("Fails acceptance criteria: AC1"), and so does the report.
- **Widening the scope takes your approval.**
  - *A critical problem outside the scope* (`out_of_scope_critical`): an `out_of_scope` finding of severity `critical`
    must justify itself in `evidence` (the check requires it). It then blocks completion: the run stops instead of
    adding it to the work.
    - With fixable findings left, it stops before the fix round (`resumePhase` `IMPLEMENT`). Otherwise it goes to
      `DONE` if the review approved, or to another review if not. Pre-existing failures waiting at the same time are
      in the same stop, and the same `resume` accepts them.
    - *Keep the scope* (`resume`): records them in `state.accepted.scope`. They stay unfixed, and the reviewer and the
      implementer are told so. A re-raised one (same id) blocks nothing.
    - `revise` with a note: re-plans to bring them into scope. The new criteria then trace to your note.
    - `abort`.
  - *A plan that adopts a suggestion* (`scope_expansion`): a revised plan answered `accepted` or
    `partially_accepted` to an issue the critic or sign-off marked `out_of_scope`. The run stops before the critique,
    listing those issues and the criteria new in this version. The planner is told to answer such issues `disputed`
    unless a note from you asks for them.
    - *Approve wider scope* (`resume`): records them in `state.accepted.scope`, and the critic is told you approved
      them.
    - `revise` with a note: re-plans, for example to keep to the task.
    - `abort`.
- **Nothing is decided silently.** DONE's summary names your scope decisions ("you kept 1 critical finding(s) outside
  the task's scope unfixed (finding F3)", "you approved widening the task's scope for 1 suggestion(s) (C2)"), and so
  does the report's "Accepted by you". Re-planning (`revise`) clears them, with everything else accepted.

## Design

`src/core/scope.ts` holds the rules and does no I/O: `criteria`, `criterionIds`, `criteriaErrors`, `addedCriteria`,
`taskIssues`, `issueRefusalErrors`, `adoptedSuggestions`, `reviewScopeErrors`, `outOfScopeBlockers`, `keptIds`,
`scopeItemText`, and the two messages `expansionReview` and `scopeReview`. `src/core/acceptance.ts` leaves
`out_of_scope` out of `splitFindings`' fixable findings and out of `attributionErrors`. Its `acceptPending` and
`acceptedText` also cover `state.scopePending` and `state.accepted.scope`. The workflow places the checks:

- **`stepPlan`.** It checks the criteria ids. After recording the plan, it escalates `scope_expansion` when
  `adoptedSuggestions` finds any (`resumePhase` `PLAN_REVIEW`).
- **`stepPlanReview`, `stepPlanFinalize`.** They block on `taskIssues` only, and check `issueRefusalErrors`.
- **`stepCodeReview`.** It checks `reviewScopeErrors` against the final plan's criterion ids, with the findings you
  decided on (`decided`). It escalates `out_of_scope_critical` for `outOfScopeBlockers` before a fix round, or
  together with `preexisting_failures`.
- **`applyDecision`.** `resume` accepts through `acceptPending`; `revise` clears `scopePending`.

**State** (all optional): `scopePending`, `accepted.scope` (`ScopeItem`: `finding` or `suggestion`, with `id`, `text`,
`evidence`). **Schemas**: plan `acceptance_criteria` items `{ id, criterion }`, critique and approval issues `scope`,
review findings `criteria`, and `out_of_scope` in their `origin`. The gate attribution's `origin` stays without it: a
required gate is always part of the contract. The UI labels the two resume choices *Approve wider scope* and
*Keep the scope*.

## Not done, and why

- **Judging in code whether a finding is really outside the scope.** That is a reading of prose. The reviewer
  classifies, under narrow rules. agentduo checks what it can check exactly: the cited criteria exist, a blocking
  `in_scope` finding cites one, a critical out-of-scope finding gives its justification, and a refusal rests on
  something that can hold the change back.
- **A fourth decision ("widen the scope now", without re-planning).** The decisions stay `resume`, `revise` and
  `abort`. A scope change goes through the plan, so the new requirement becomes a criterion that later findings can
  trace to. For a finding, `resume` keeps the scope, as it accepts pre-existing failures: going on never widens the
  task.
- **Rejecting a plan that adopts a suggestion.** Your own note may have asked for it, so the run asks instead of
  rejecting.
- **Comparing criteria texts across plan versions.** A revision may reword a criterion. The ids say what is new, and
  the stop lists the new ones for you to read.

## Tests

- `test/scope.test.ts`:
  - criterion ids, older plans, duplicate and missing ids, criteria a revision adds;
  - task issues, a critique's refusal, adopted suggestions and approved ones, the expansion message;
  - traceability (cited, missing, unknown), a critical out-of-scope finding's justification, a review's refusal
    (and what can hold it back);
  - the blockers once decided, the scope message at each `resumePhase`.
- `test/acceptance.test.ts`: `out_of_scope` is neither fixable nor asked for origin evidence; accepting and saying
  scope decisions.
- `test/workflow.test.ts` ("the task's scope"), through `fake-agent.mjs`:
  - **extras**: no fix round for them, and a refusal on extras alone is retried;
  - **traceability**: an untraced `in_scope` finding and an unknown criterion are retried, and the fix round shows the
    criterion;
  - **a critical problem outside the scope**:
    - no justification: retried;
    - otherwise it stops before the fix round. *Keep the scope* gives a fix round for the task's finding only, a review
      told what you kept, and a DONE naming it;
    - `revise` with a note re-plans;
  - **plan suggestions**: they do not hold the plan back; a revision that adopts one stops before the critique;
    *Approve wider scope* tells the critic, and DONE names it; a revision that disputes them goes on without asking.
- `test/prompts.test.ts`, `render.test.ts` and `format.test.ts`: the classification rules and the contract in every
  role's prompt, criteria by id, the scope markers, and the labels.
