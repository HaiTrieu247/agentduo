# agentduo

Two coding agents, one loop: **Codex** plans and reviews, **Claude Code** critiques the plan and implements it. Your project's own tests are the referee. A live terminal UI shows what each agent is doing and what they hand each other.

```text
● PLAN r1  Codex (planner)                                      32s · 33k tok
  │ exec  rg --files ✓
  │ exec  cat src/calc.ts ✓
  └ Codex → Claude  Plan v1 "Add subtraction" · 3 steps · 6 criteria · 1 risks

● PLAN_REVIEW r1  Claude (plan critic)                          48s · $0.17
  │ Read  src/calc.ts ✓
  └ Claude → Codex  approved · 2 suggestion(s)
      [low] C1 add a negative-number test
──────────────────────────────────────────────────────────────────────────────
 PLAN ✓ › CRITIQUE ✓ › FINALIZE ✓ › IMPLEMENT ● r1 › VERIFY › REVIEW    plan 1/4 · impl 1/5
 ⠋ Claude (implementer) · 0:21
   │ Edit  src/calc.ts  +4 −0 ✓
   │ Bash  npm test ⠋
 $0.33 · 67k tok                  [v] details  [q] stop after this step  [ctrl-c] stop now
```

## How it works

1. **Plan and debate.** Codex writes a plan: goals, scope, steps, acceptance criteria and risks. Claude checks that the plan is feasible in your codebase. Codex revises it until Claude approves, then signs off on the final plan.
2. **Implement and review.** Claude implements the plan. agentduo runs your quality gates (tests, lint, typecheck) itself. Codex reviews the diff and the gate results, and Claude fixes the findings, round after round, until the run reaches `DONE`.

The agents never talk to each other directly. agentduo relays schema-validated JSON between them, and agreement between agents is never accepted as proof. `DONE` requires all three:
- Codex approves;
- every required gate passes;
- no blocking finding is left.

When a limit is reached, a safety rule is broken or an agent fails, the run pauses in `HUMAN_REVIEW` and asks you what to do.

## Requirements

- Node.js ≥ 22.12 and git. The target project must be a git repository.
- [Codex CLI](https://developers.openai.com/codex/cli/): run `npm i -g @openai/codex`, then `codex login`.
- [Claude Code](https://code.claude.com/docs/en/overview): the `claude` command. If Claude Code is installed only through the VS Code, Cursor or Windsurf extension, agentduo finds the bundled binary.

Both agents run under your own accounts. agentduo does not call model APIs itself.

## Install

```bash
npm i -g agentduo
```

## Quick start

```bash
cd my-project
duo init      # writes .agentduo/config.yaml (detected gates) and .agentduo/.gitignore (keeps run data out of git)
duo doctor    # checks CLIs, flags, config and gates; makes no model calls
duo "Add JWT authentication with refresh tokens"
```

`agentduo` is the same command as `duo`. Use `agentduo` if another tool on your machine already owns the name `duo`.

## Commands

| Command | What it does |
|---|---|
| `duo "<task>"`, `duo run "<task>"` | Start a run (`--task-file F`, `--allow-dirty`) |
| `duo resume [id]` | Continue the latest (or given) run; `--decision resume\|revise\|abort [--note "..."]` answers a pending decision |
| `duo status [id]`, `duo list` | Show progress, history and where the files are |
| `duo doctor` | Check the environment without calling models |
| `duo init` | Create `.agentduo/config.yaml` |

Every command also takes `--repo PATH`, `--config PATH`, `--plain`, `-v/--verbose` and `--no-color`.

Output is the live UI in a terminal. It switches to plain timestamped lines with `--plain`, when `CI=true`, or when stdout is not a TTY.

agentduo **never commits or pushes**. Changes stay uncommitted in your working tree, so review them with `git diff` and commit them yourself.

## When a run needs you

In an interactive terminal, agentduo shows the reason and a menu. You can resume, revise with a note, view the final plan, the last review, the plan feedback or the diff stat, abort, or decide later. In plain mode the run exits with code 2, and you answer with `duo resume --decision …`.

| Reason | What `resume` does |
|---|---|
| `max_planning_rounds` | Implements the latest plan, recorded as accepted by you |
| `plan_ready` (with `safety.pause_before_implement`) | Starts implementing |
| `max_review_rounds`, `critical_finding`, `gates_failing` | Starts another fix round |
| `implementer_blocked`, `dirty_worktree` | Re-runs the implementation round (add `--allow-dirty` if needed) |
| `guard_violation` | Accepts the changes after your inspection and runs the gates |
| `readonly_violation`, `agent_error`, `orchestrator_error` | Re-runs the failed step |

`revise` always goes back to planning with your note. `abort` ends the run. Notes are added to every later prompt as top-priority instructions.

## Configuration

Settings are merged in this order, later sources winning: built-in defaults, then `~/.config/agentduo/config.yaml` (or `$XDG_CONFIG_HOME/agentduo/` or `%APPDATA%\agentduo\` on Windows), then `<repo>/.agentduo/config.yaml` or `--config`, then CLI flags. A misspelled key produces a warning. An unsafe configuration is rejected, for example one where the implementer is not Claude, a reviewer can write, or no gate is required.

```yaml
gates:                        # run by agentduo after every implementation round
  - name: tests
    command: "npm test"
    required: true
limits:
  max_planning_rounds: 4
  max_review_rounds: 5
  agent_timeout_sec: 1800
safety:
  pause_before_implement: false
  protected_paths: [".agentduo/**", ".env", ".env.*", "**/*.pem", "**/*.key", "**/secrets/**", ".github/workflows/**"]
codex:
  model: null                 # e.g. a cheaper model
claude:
  model: null
  max_budget_usd: null        # per call
```

## Safety model

Permissions are enforced by the CLIs themselves, not only stated in prompts:

| Role | Invocation | Limits |
|---|---|---|
| Codex planner / reviewer | `codex exec --json --sandbox read-only --output-schema …` | read-only sandbox |
| Claude plan critic | `claude -p --output-format stream-json --tools Read,Grep,Glob --permission-mode dontAsk --permission-prompts none` | read tools only |
| Claude implementer | `claude -p … --permission-mode acceptEdits --allowedTools … --disallowedTools …` | edits files and runs allowlisted commands (your gates, read-only git); `git commit/push/reset`, `rm -rf`, `curl` and web access are denied |

agentduo also checks independently:

- **Snapshots.** It snapshots the whole working tree into `refs/agentduo/<run>/…` through a temporary index, leaving your index, HEAD and branch untouched. Every review therefore targets an exact SHA, and the state before every round can be restored.
- **What the checks cover.** Before and after every agent step and every gate run, it compares:
  - the working tree (tracked and untracked files);
  - git-ignored files that match `protected_paths` (for example a git-ignored `.env`);
  - `.git/config` and `.git/hooks/*`;
  - the run's own `plan.final.md` and `review.json`.
- **Read-only steps.** Any change during a read-only step, or any movement of HEAD or the branch, stops the run.
- **Implementation rounds and gates.** HEAD and the branch must not move (no commits), no protected path may change, and deletions stay within a limit. This also holds when an attempt fails or is interrupted: a re-run of the round is still compared against the state before its first attempt. Changes made by the gate scripts themselves are checked too, because the implementer can edit those scripts.
- **Starting a run.** It refuses to start on uncommitted changes unless you pass `--allow-dirty`, and allows one active run per repository.

Limits: files that are git-ignored and do not match `protected_paths` are not tracked, and nothing stops an agent from reading files. Keep secrets out of the repository, or list them in `protected_paths`.

## Run files

Everything about a run lives in `.agentduo/runs/<run-id>/`:

- `state.json`: rewritten after every step, which makes a run resumable;
- `report.md`: timeline, gate results, diff stat, unresolved issues, cost;
- `plan.vN.md`, `plan.final.md` and `plan-feedback.md`;
- the per-round JSON from every agent, wrapped with task id, round, timestamp, git SHA and plan version;
- `gates/` logs;
- `logs/`: for every CLI call, the prompt, the command line, the raw event stream and stderr.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | done |
| 1 | config or environment error |
| 2 | waiting for your decision |
| 3 | aborted |
| 130 | stopped (resumable) |

## Platforms

macOS and Linux are supported. Windows is experimental and not covered by CI.

## Costs

Each round makes a few agent calls against your own Codex and Claude accounts. A small task took about 3 minutes, $0.33 of Claude usage and 67k Codex tokens. The live UI shows running totals. Use `claude.model`, `codex.model` and `claude.max_budget_usd` to keep costs down.

## Development

```bash
npm install
npm test             # unit + end-to-end (fake agents) + UI tests
npm run typecheck
npm run test:pack    # build, pack, install into a temp prefix, run the binaries
npm run demo:ui      # watch the live UI with scripted fake agents (free)
npm run smoke:real   # REAL agents on a demo repo — costs money
```

## License

MIT
