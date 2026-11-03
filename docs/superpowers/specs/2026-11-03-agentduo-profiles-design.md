# agentduo: pipeline profiles and planning convergence

Status: implemented. Builds on `2026-11-03-agentduo-context-sharing-design.md`, `2026-11-03-agentduo-run-budget-design.md`,
`2026-11-03-agentduo-convergence-design.md` and `2026-11-03-agentduo-final-verification-design.md`. Amends
`2026-10-27-agentduo-channel-design.md` (the planning flow and its escalation reasons).

## Problem

Every task went through the same pipeline: a plan, a critique, the planner's sign-off, then fix and review rounds. A
one-line fix paid for the same handoffs as an architectural change:

- **The sign-off.** It follows a critique that approved, adds a call, and can send an approved plan back for another
  whole planning round.
- **No lighter path, no deeper path.** There was no way to ask for less or more depth, and no recorded way to go deeper
  when a small task turned out larger.
- **Planning had no convergence check.** Only `max_planning_rounds` bounded it. A critic that kept blocking on the same
  issue used up every planning round.
- **No comparison.** Usage was kept as totals only: nothing said where the calls went.

## What the user gets

- **Three profiles.** `pipeline.profile` in the config (default `standard`), `--profile` on `duo` and `duo run`,
  `/pipeline --profile <name> <task>` in the chat, and Settings → Workflow roles in the desktop app.

  | | lightweight | standard | thorough |
  |---|---|---|---|
  | Sign-off after the critic approves | never | as `require_plan_approval` says | always |
  | Review when required gates fail | as `review_on_gate_failure` says | as configured | always |
  | Prompts | planner: a short plan; critic: there is no sign-off after you | unchanged | planner, critic, sign-off and reviewer: go in depth |
  | Moves up on its own | to standard, on an escalation signal | never | never |

- **Every profile keeps every check:**
  - the scope contract, with its criterion ids;
  - the baseline and the consistency check;
  - pre-existing failures;
  - the independent plan critique and code review;
  - the required gates and the final verification;
  - the review-loop, no-progress and planning breakers, and the run's budget;
  - your decisions on conflicts, scope and accepted failures.

  No profile approves a finding, skips a gate, lowers a limit or changes what blocks.
- **Escalation (lightweight → standard)** happens on a deterministic signal, never a model's opinion of the task:

  | Signal | When |
  |---|---|
  | `plan_size` | the plan has more than 6 steps or names more than 8 files |
  | `plan_blocking` | the critic sends the plan back |
  | `requirements_conflict` | a contradiction (the decision you are asked for stays as it is) |
  | `scope` | a scope expansion or a critical finding outside the scope (your decision stays) |
  | `implementer_blocked` | the implementer reports a blocker |
  | `unplanned_files` | a round changes 3 or more files that no plan step names |
  | `gates_failing` | required gates fail 2 rounds in a row |
  | `review_rounds` | the review of round 2 or later still blocks |
  | `review_stalled` | the review loop stalls |
  | `critical_finding` | the reviewer reports a critical finding |

  When escalation happens:
  - It is recorded in `state.profile.changes` with its signal, reason, phase and round.
  - It shows as a "profile escalated" step in every timeline, in the report and in `duo status`.
  - The run keeps its plan, its findings, each role's session, the implementation and its counters. Nothing runs
    again.
  - From then on the run is standard: a revised plan is signed off, and the prompts of later turns say the run is
    standard now (a continued session is told once the profile changed).
- **Resume keeps the profile.** `state.profile` holds the profile a run started with and the one in effect. A resumed
  run keeps them whatever the config says now, and warns when the config names another. `pipeline.profile` is a
  `next-run` setting, like the roles and the limits.
  - A run from before profiles goes on as standard, and is recorded as such.
  - The only change during a run is escalation, which only goes up.
- **Planning convergence (every profile).**
  - Each critique's issues are tracked by identity, as review findings are: an issue is a finding about no file, so a
    renumbered or reworded issue stays one.
  - A critique that sends the plan back closes a planning cycle. The cycle made progress when one of the earlier
    critique's blocking issues was resolved (left out) or no longer blocks. A rewritten plan, a new id or new wording
    is not progress.
  - After two cycles in a row without progress, or one whose plan did not change at all, the run stops with
    `planning_stalled` instead of spending its remaining planning rounds. The details list each issue that keeps
    blocking, with the rounds it was raised in and the plan's answer to it.
  - The choices: *Implement latest plan* (`resume`, recorded as accepted by you, as for `max_planning_rounds`);
    `revise` with a note that settles the issues; `abort`.
  - The report gains "Planning rounds".
- **Metrics.** `state.usageByRole` (calls, tokens, reported cost, unpriced calls per role, from the same counters as
  the run's totals) and `metrics.json`, written with every report, give:
  - the profile, from first to last, with each escalation;
  - the outcome, the verification status, the required gates and the review's verdict;
  - agent calls by role, tokens, cost, unpriced calls;
  - planning and implementation rounds;
  - the steps by kind (plans, critiques, sign-offs, implementations, reviews, gate runs);
  - the decisions you were asked for;
  - minutes of work and of wall clock.

  The report's "Profile and metrics" section and `duo status` show the same.
- **The screens.**
  - The terminal footer and the VS Code / desktop header name a profile other than standard.
  - The terminal's phase strip leaves out the sign-off for a lightweight run, unless it reaches one.
  - The extension's pipeline steps follow the profile, and a sign-off reached after an escalation shows before
    IMPLEMENT.
  - `run.started` and `phase.started` carry the profile.

## Measured on the fake agents

The benchmark scenario runs the same task from the same files, with the same scripted answers, in `test/workflow.test.ts`
("benchmark: …"):

| Scenario | standard | lightweight |
|---|---|---|
| Plan approved, one review approves | 5 agent calls (1 sign-off) | 4 agent calls (no sign-off) |
| The sign-off sends an approved plan back once | 8 agent calls, 2 planning rounds | 4 agent calls, 1 planning round |

Both profiles run one critique, one implementation, one review, the baseline and the gates, and end `verified`.

## Design

`src/core/profiles.ts` holds the policies and the signals and does no I/O: `POLICIES`, `signsOff`,
`reviewsOnGateFailure`, `escalate`, `planTooLarge`, `unplannedFiles`, `LIGHTWEIGHT` (the thresholds), `profileText` and
`profileChangeLines`.

The workflow:

- **`run()`** records the profile of a new run, or standard for an older one.
- **The planning steps:**
  - `stepPlan` checks the plan's size.
  - `stepPlanReview` tracks the critique (`trackCritique`), records the cycle, escalates on a conflict or a refusal,
    checks the stall (`planningStalled`), then signs off as the profile says.
- **The implementation and review steps:**
  - `stepImplement` checks unplanned files and the blocker.
  - `stepVerify` checks gates failing in a row, and reviews on failure as the profile says.
  - `stepCodeReview` checks one signal before its branches.
- **`escalateProfile`** records the change as a step of its own.

Planning convergence is in `src/core/progress.ts`: `trackCritique` (with `trackReview` from `src/core/findings.ts`),
`planProgress`, `planStallReview` and `planAnswer`, reusing `nextStall` and `STALL_CYCLES`. Metrics (`runMetrics`,
`metricsLines` and `planCycleLines`) are in `src/core/render.ts`, built from the budget's counters (`usageOf`), the
timeline and the verification record. Prompts get `ctx.profile` and `profileSection`. Standard asks nothing new, so its
prompts are unchanged.

**State** (all optional, `STATE_VERSION` stays 1): `profile`, `usageByRole`, `planIssues`, `planCycles` and
`planStall`. **Config:** `pipeline.profile`. A saved `config.json` from before profiles merges over the defaults
(standard). **Events:** an optional `profile` on `run.started` and `phase.started`.

## Not done, and why

- **Choosing a profile automatically.** Predicting a task's size from its words is the opaque scoring the issue warns
  against. Lightweight's escalation signals give a run that starts light the depth it turns out to need.
- **Lower round limits for lightweight.** A low limit would stop the run for a decision, not save work, and checks must
  not be skipped because a limit is low. Every profile keeps the configured limits.
- **Stricter severities for thorough.** The prompts' severity scale says medium findings do not block. Changing what
  blocks per profile would contradict it, and would change what a finding means. Thorough adds depth (sign-off,
  reviews on failing gates, prompts), not a different bar.
- **Changing the profile by decision during a run.** Only escalation changes it, and only upward. A different profile
  is a new run.
- **Tracking the sign-off's issues for convergence.** The planner signing off its own plan is not an independent
  reviewer. Planning convergence follows the critic.

## Remaining limits

- **Token savings are not measured.** The fake agents report fixed token counts, so the benchmark measures calls and
  handoffs, not how much shorter a lightweight plan and its prompts are.
- **The signals are thresholds.** A small task that touches many files escalates. A task that is risky in few files
  does not escalate until the critique, review or gates show it.
- **Issue identity is a heuristic.** A critic that reuses an id for a different issue makes it look unresolved, so the
  run stops to ask you sooner. A rewording that shares few words with the earlier issue looks like a new issue, and the
  round limit still bounds the run.

## Tests

- `test/profiles.test.ts`: policies, escalation (only lightweight, only up, once), plan size, unplanned files.
- `test/progress.test.ts`: critique tracking across renumbered issues, planning progress, the stall and its message.
- `test/workflow.test.ts`, "pipeline profiles":
  - the benchmark;
  - lightweight's prompts and timeline;
  - escalation on a blocking critique, keeping sessions and work;
  - a blocking review finding is never bypassed, and a second blocking review escalates;
  - escalation on plan size and on unplanned files;
  - conflicts and scope expansion pause in every profile;
  - thorough's depth;
  - the planning stall, with renumbered issues, and the decision after it;
  - resume keeps the profile, and an older run is standard;
  - the budget and the circuit breakers in lightweight.
- `test/render.test.ts`, `cli.test.ts` (`--profile`, `duo status`), `commands.test.ts` (`/pipeline --profile`),
  `config.test.ts`, `settings.test.ts`, `format.test.ts`, `vscode-view-state.test.ts`, `vscode-pipeline.test.ts` and
  the desktop's `renderer.test.ts`.
