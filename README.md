# agentduo

A channel between two coding agents. **Codex** plans and reviews; **Claude Code** critiques the plan and implements it. agentduo relays their structured messages, runs the loop, and shows in a live terminal UI what each agent is doing and what they hand each other.

agentduo adds no rules of its own: permissions, sandboxes and conventions come from each CLI's configuration and your repository's `AGENTS.md` / `CLAUDE.md`.

Tiếng Việt: [docs/README.vi.md](docs/README.vi.md)

```text
● PLAN r1  Codex (planner)                                      32s · 33k tok
  │ exec  rg --files ✓
  └ Codex → Claude  Plan v1 "Add subtraction" · 3 steps · 6 criteria · 1 risks

● PLAN_REVIEW r1  Claude (plan critic)                          48s · $0.17
  │ Read  src/calc.ts ✓
  └ Claude → Codex  approved · 2 suggestion(s)
──────────────────────────────────────────────────────────────────────────────
 PLAN ✓ › CRITIQUE ✓ › FINALIZE ✓ › IMPLEMENT ● r1 › VERIFY › REVIEW    plan 1/4 · impl 1/5
 ⠋ Claude (implementer) · 0:21
   │ Edit  src/calc.ts  +4 −0 ✓
 $0.33 · 67k tok                  [v] details  [q] stop after this step  [ctrl-c] stop now
```

## How it works

1. **Plan and debate.** Codex writes a plan with goals, scope, steps, acceptance criteria and risks. Claude checks that it is feasible, Codex revises it, and Codex finally signs it off.
2. **Implement and review.** Claude implements the plan. Optional quality gates run, and their results go to the reviewer. Codex reviews the diff, and Claude fixes the findings, round after round, until the run reaches `DONE`.

A run reaches `DONE` when all of these hold:
- Codex approves;
- no blocking finding is left;
- if you configured gates, every required gate passes.

When a limit is reached, an agent fails or blocks, or a critical finding appears, the run asks you what to do.

## Requirements

- Node.js ≥ 22.12 and git. The workspace must be inside a git repository; `duo init` offers to run `git init`.
- [Codex CLI](https://developers.openai.com/codex/cli/): run `npm i -g @openai/codex`, then `codex login`.
- [Claude Code](https://code.claude.com/docs/en/overview): the `claude` command. If it is installed only through the VS Code, Cursor or Windsurf extension, agentduo finds the bundled binary.

## Install and quick start

```bash
npm i -g agentduo
cd my-project            # or any subdirectory: that directory is the workspace
duo init                 # .agentduo/config.yaml (everything optional) and .agentduo/.gitignore
duo doctor               # checks the CLIs and config; no model calls
duo "Add JWT authentication with refresh tokens"
```

`agentduo` is the same command as `duo`. Use `agentduo` if another tool already owns the name `duo`.

## The workspace

`duo` works in the directory you call it from, or in `--dir PATH`:

- both agents run there;
- `.agentduo/` (config and runs) lives there;
- the diff sent to the reviewer only contains changes inside it.

If an agent changes files outside the workspace (elsewhere in the same repository), agentduo warns on screen and in the report, with paths relative to the workspace (`../shared/x.ts`), but does not stop the run.

## Permissions and scope

agentduo passes only the flags its protocol needs: streaming JSON, the output schema, and the prompt on stdin. For Claude it also passes `--permission-prompts none`, because nobody can answer a prompt in non-interactive mode. That flag grants nothing.

What each agent may do is up to its own configuration:

- **Claude Code**: your settings (`~/.claude/settings.json`, `.claude/settings.json`). In non-interactive mode Claude can only use a tool that your settings allow:
  - `"permissions": { "defaultMode": "acceptEdits" }` allows edits, but not commands;
  - allow rules allow commands, for example `"permissions": { "allow": ["Bash(npm test:*)"] }`. Without gates the implementer runs the project's checks itself, so allow those commands.

  Denied tool calls appear as `⊘ denied`, followed by a warning that names the tools.
- **Codex**: `~/.codex/config.toml` (for example `sandbox_mode`). `codex exec` is read-only unless configured otherwise, so a Codex implementer needs `sandbox_mode = "workspace-write"` or `codex.role_args.implementer: [--sandbox, workspace-write]`.
- **Per role, only for agentduo runs**, add flags in `.agentduo/config.yaml`:

```yaml
claude:
  role_args:
    implementer: [--permission-mode, acceptEdits]
codex:
  role_args:
    code_reviewer: [--sandbox, read-only]
```

agentduo reports what the agents did; it does not block it. Two kinds of change produce a warning:
- files changed by a planning or reviewing agent;
- files changed outside the workspace.

Nothing is ever committed or pushed by agentduo: review the changes with `git diff` and commit them yourself.

## Commands

| Command | What it does |
|---|---|
| `duo "<task>"`, `duo run "<task>"` | Start a run (`--task-file F`; use `duo -- "-x …"` for a task that starts with `-`) |
| `duo resume [id]` | Continue the latest (or given) run with the config it started with (`--reload-config` to use today's); `--decision resume\|revise\|abort [--note "..."]` answers a pending decision |
| `duo status [id]`, `duo list` | Progress, history and where the files are |
| `duo doctor` | Check the CLIs and config without calling models |
| `duo init` | Create `.agentduo/config.yaml` and `.agentduo/.gitignore`, and offer `git init` |

Every command also takes `--dir PATH`, `--config PATH`, `--plain`, `-v/--verbose` and `--no-color`, before or after the command name. The UI switches to plain timestamped lines with `--plain`, in CI, when stdout is not a terminal, or when the process runs in the background (`duo … &`).

## When a run needs you

In a terminal, agentduo shows the reason and a menu: Resume, Revise (with a note), view the plan, the review, the plan feedback or the diff stat, Abort, or Decide later. Ctrl-C at the menu also means Decide later. In plain mode the run exits with code 2, and you answer with `duo resume --decision …`.

| Reason | What `resume` does |
|---|---|
| `max_planning_rounds` | Implements the latest plan, recorded as accepted by you |
| `plan_ready` (with `safety.pause_before_implement`) | Starts implementing |
| `max_review_rounds`, `critical_finding`, `gates_failing` | Starts another fix round |
| `implementer_blocked` | Re-runs the implementation round |
| `agent_error`, `orchestrator_error` | Re-runs the failed step |

`revise` goes back to planning with your note. `abort` ends the run.

## Configuration

Settings are merged in this order, later sources winning: built-in defaults, then `~/.config/agentduo/config.yaml` (or `$XDG_CONFIG_HOME/agentduo/` or `%APPDATA%\agentduo\` on Windows), then `<workspace>/.agentduo/config.yaml` or `--config`. A misspelled key produces a warning. A value of the wrong type produces an error that names the file.

- **Mappings** are merged key by key, and `role_args` role by role.
- **Lists** (`args`, `gates`, `blocking_severities`) replace the earlier value. `claude.args: [--strict-mcp-config]` therefore drops the default `--no-session-persistence` unless you list it too.

```yaml
agents: { planner: codex, plan_reviewer: claude, implementer: claude, code_reviewer: codex }
limits: { max_planning_rounds: 4, max_review_rounds: 5, agent_timeout_sec: 1800, agent_idle_timeout_sec: 900 }
gates:                       # optional
  - name: tests
    command: "npm test"
    required: true
codex:  { model: null, args: [--ephemeral], role_args: {} }
claude: { model: null, max_budget_usd: null, args: [--no-session-persistence], role_args: {} }
```

`agent_idle_timeout_sec` stops an agent that prints nothing for that long; set it to 0 to turn the check off.

## Run files

Everything about a run lives in `.agentduo/runs/<run-id>/`:

- `state.json`: makes the run resumable;
- `config.json`: the config the run started with;
- `report.md`: timeline, gates, diff stat, unresolved issues, warnings, cost and tokens;
- the plans, the critiques, and every agent's JSON (with task id, round, timestamp, git SHA and plan version);
- `logs/`: the prompt, the command line, the raw event stream and stderr of every CLI call.

The runs directory carries its own `.gitignore`, so run data stays out of `git status` and out of commits, even without `duo init`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | done |
| 1 | config or environment error |
| 2 | waiting for your decision |
| 3 | aborted |
| 130 | stopped (resumable) |

## Troubleshooting

- **Tool calls are denied.** The warning names the tools.
  - Edits (`Edit`, `Write`): set `permissions.defaultMode` to `"acceptEdits"` in your Claude Code settings, or add `claude.role_args.implementer: [--permission-mode, acceptEdits]`.
  - Commands (`Bash`): add allow rules such as `"Bash(npm test:*)"`.
  - With a Codex implementer, see **Codex** under [Permissions and scope](#permissions-and-scope).
- **A config change has no effect on `duo resume`.** A run keeps the config it started with. Use `duo resume --reload-config` to apply your `config.yaml` changes. Changes to Claude Code or Codex settings apply without it.
- **A task that starts with `-`** is read as an option. Put `--` before it: `duo -- "-x is broken"`.
- **The terminal behaves oddly after agentduo was killed with `kill -9`.** Run `reset`. A SIGKILL gives no process a chance to restore the terminal.
- **Costs.** `claude.args: [--strict-mcp-config, --no-session-persistence]` skips loading your MCP servers for agentduo runs, which makes each call noticeably cheaper. `claude.max_budget_usd` caps the cost of each call.
- **Windows** is experimental and not covered by CI.

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
