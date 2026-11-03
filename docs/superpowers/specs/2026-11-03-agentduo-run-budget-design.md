# agentduo: a budget per pipeline run

Status: implemented. Amends `2026-10-27-agentduo-channel-design.md` (§4 config, §5 escalation reasons).

## Problem

Every limit agentduo had worked on one loop or one call. `max_planning_rounds` and `max_review_rounds` bounded the
loops, `max_retries` bounded one call's attempts, `agent_timeout_sec` and `agent_idle_timeout_sec` bounded one call's
time, and `claude.max_budget_usd` bounded one Claude call's cost. Nothing bounded a whole run. Each `resume` after
`max_review_rounds` granted more rounds, every round could retry, and every call could be expensive, so a run's total
was unbounded. The total was also only partly visible: the screen and report showed "Claude cost" and tokens, and
said nothing about Codex's cost, which its CLI never reports.

## What the user gets

Four limits under `limits`, each `null` (off) by default, so existing configs and runs behave as before:

| Key | Measure | How exactly it holds |
|---|---|---|
| `max_run_agent_calls` | agent CLI processes started: retries, a lost session's failed resume, and fresh fallbacks included | **exact**: checked before every attempt, so none starts past it |
| `max_run_minutes` | work time: the steps' wall time, agent calls and gates, not time spent waiting for a decision | **at boundaries**: no step or attempt starts past it; one already running finishes (at most `agent_timeout_sec` later) |
| `max_run_tokens` | the tokens every call reports, failed and stopped attempts included | **best-effort**: known only when a call ends, so the call that crosses it finishes |
| `max_run_cost_usd` | the cost the CLIs report | **Claude: capped per call** at what is left (`--max-budget-usd`, lowered from `claude.max_budget_usd` when less is left), so it stops close to the limit; **Codex: unknown**, never zero |

- **Visible throughout.** `phase.started` carries a `BudgetView` (the limits that are set, used and limit, and the
  unpriced calls). The Ink footer, the plain log, and the VS Code and desktop progress line all show it as
  `budget 120k/2M tok · $1.20+/$10.00 (3 calls unpriced) · 7/40 calls · 12/90 min`. `duo status` and `report.md`
  (a "Budget" section, and a "Usage" line) show it too.
- **Warning.** At 80% of a limit, a `warning` (stored with the run's warnings) is given once per limit until that limit
  is raised.
- **Stop.** When a limit is reached, the run starts no further step or attempt and escalates to `HUMAN_REVIEW` with the
  reason `budget_exhausted`. The message names each limit reached, its config key, and how exactly it held. The details
  list every limit's usage and the unpriced calls. The step it stopped before is the one a `resume` runs.
- **Recoverable.** Nothing is undone: plans, reviews, snapshots, the working tree, sessions and the report stay as they
  are. `resume` (or `revise`) is the user's authorization: each limit reached gets one more allowance from what was
  used (`used + configured limit`, rounded up, cost in whole cents). If the config in use (the run's saved config, or
  the current one with `--reload-config`) no longer sets that limit, it is lifted. `abort` ends the run without
  raising anything. The decision's message lists what was raised ("tokens limit raised to 2234").
- **Honest cost.** Codex reports no cost, so the run counts `unpricedCalls` (calls that reported none) next to
  `costUsd`. Cost is shown as a lower bound (`$1.20+`, "the real cost is higher"), and the report and the escalation
  details say how many calls it leaves out. When a cost limit is set and any role runs on Codex, every start of the run
  says that the cost limit does not count Codex, and that tokens or calls bound it. This is an event, not a stored
  warning: it describes the setup, not the run's work.

## Design

`src/core/budget.ts` holds the rules: which limits a config sets, the usage, which limits are reached, the 80%
warnings, the message, how a decision raises limits, and the cost left for Claude. It does no I/O, so
`test/budget.test.ts` tests it directly.

**State** (all optional, so `STATE_VERSION` stays 1): `budget: { limits, warned }`, `agentCalls`, `unpricedCalls`
and `activeSec`, next to the existing `tokens` and `costUsd`. Like the round limits, a run's limits are fixed when it
first runs and change only through a decision. A run without a budget (older, or started with none set) takes the
limits of the config it next runs with.

**Where it is checked**

1. *Before every step* (`Workflow.run`), before snapshots are prepared: a reached limit escalates with
   `resumePhase` = that step, so gates never start past the budget either.
2. *Before every attempt* of an agent call (`CallBudget.stop`, in `AgentRunner.call`), with the run's usage plus what
   the call used so far and the minutes of the step under way. A stopped call returns `budgetStop` without starting a
   process.
3. *After a failed call*: if the budget is reached by then, the step escalates `budget_exhausted` rather than
   `agent_error`. Case: a Claude call cut at the cost left (`error_max_budget_usd`) with no retry left.

**Counting.** The runner counts the processes it starts (on spawn) and those that reported a cost; the difference is
`unpricedCalls`. Tokens and cost add up across attempts as before, timed-out and stopped attempts included. Work time
is added after every step, also an interrupted one (before `finish` saves, which `test/workflow.test.ts` checks).

**Claude's cap.** `costLeft` gives the cost limit minus the reported cost of the run and of the call so far, in whole
cents and at least one. `ClaudeBackend.buildArgs` passes the lower of that and `claude.max_budget_usd` as
`--max-budget-usd`. Codex has no such flag.

**Settings.** The four keys are `next-run` settings (`SETTING_KEYS`, kind `limit` for the integers and `budget` for
the cost). Desktop Settings shows them in a "Budget per pipeline run" card with "No limit" when empty.

## Not done, and why

- **Killing a running call at the limit.** Tokens and minutes could be enforced inside a call by killing the CLI. The
  call's work would be lost and redone on resume, which costs more than letting it finish. The bounded overshoot is
  documented instead. Claude's cost is the exception, because Claude stops the call itself.
- **Estimating Codex's cost from its tokens.** It would need a price list per model that agentduo does not have and
  could not keep current. Unknown stays unknown, and the token and call limits bound it.
- **Budgets for chat and `/discuss`.** They are one question at a time, with no loop to run away.
- **A configurable warning threshold.** 80% is fixed; add a key if users ask for one.

## Tests

- `test/budget.test.ts`: defaults off, a run picking up a budget, usage, reached limits, warnings (once, not when
  reached, again after a raise), raising (allowance, lifting, cents), the cost left, and the message and details.
- `test/runner.test.ts`: no attempt starts past the budget, before the first one or a retry; calls and unpriced calls
  are counted; Claude gets the cap.
- `test/workflow.test.ts`, through `fake-agent.mjs`:
  - a run within its budget: counts, the view at each step, the 80% warning, the report, Claude's caps;
  - token exhaustion stopping twice and finishing after two `resume` decisions, with no step run twice;
  - the call limit stopping a retry and then `abort`;
  - minutes stopping before any call;
  - cost with Codex unpriced and Claude capped;
  - an interrupted step's work time.
- `test/backends.test.ts`, `config.test.ts`, `settings.test.ts`, `format.test.ts`, `plain.test.ts` and
  `vscode-view-state.test.ts` cover the cap, validation, setting kinds and each screen.
