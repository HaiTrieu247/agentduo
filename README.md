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
duo                      # opens the chat
```

`agentduo` is the same command as `duo`. Use `agentduo` if another tool already owns the name `duo`.

## Chat

Run `duo` (or `agentduo`) without a task in a terminal and type, as in any chat CLI:

```
agentduo 0.2.0 · chat
› Add JWT authentication with refresh tokens
── run 20261027-101500-add-jwt-authentication ──
  … Codex plans, Claude critiques, Claude implements, Codex reviews …
✔ DONE the review approved; no quality gates configured.
› Also cover token expiry with a test
```

- **A message when nothing runs** starts a task. Each new task is told what the earlier ones in the chat did, and its review covers only its own changes.
- **A message while the agents work** is a note: every step from the next one on carries it.
- **Esc** stops the current step. Type what should change and press Enter, and the step runs again with your message. Enter alone re-runs it as is; `/new` leaves it.
- **Permission prompts and decisions** appear in place of the input line.
- **Commands:** `/plan`, `/diff`, `/status`, `/resume` (continue a stopped or waiting run, also from an earlier session), `/new`, `/help`, `/quit`. Ctrl-C twice also quits; a running run stops at its current step and stays resumable.

### Settings from the chat

The settings commands of Claude Code and Codex work in the chat too, with the agent's name in front. A change applies to new runs, and to the current run from its next agent call. It lasts for this chat only, unless the command ends with `--save`, which writes it to `.agentduo/config.yaml` and keeps the file's comments.

| Command | Same as | What it changes |
|---|---|---|
| Shift+Tab, `/edits auto\|ask` | Shift+Tab in Claude Code | `auto`: the implementer edits files without asking (`acceptEdits`); the plan critic is not affected |
| `/claude model <name\|default>` | `/model` | Claude's model |
| `/claude effort low\|medium\|high\|xhigh\|max\|default` | `/effort` | Claude's effort level |
| `/claude permissions [allow\|deny\|remove <rule>]` | `/permissions` | tool rules for agentduo's Claude calls, e.g. `Bash(npm test:*)` |
| `/claude add-dir <path>` | `/add-dir` | another directory Claude may work in |
| `/codex model <name\|default> [effort]` | `/model` in Codex | Codex's model and reasoning effort |
| `/codex permissions read-only\|auto\|full-access\|default` | `/permissions` in Codex | Codex's sandbox; `full-access` asks you to confirm with `--yes` |
| `/config` | `/config`, `/status` | shows what both agents run with now |

Outside the chat, `duo --accept-edits "<task>"` does what `/edits auto` does.

`duo "<task>"` still runs a single task and exits; that is the form for scripts and CI.

## VS Code extension

`extensions/vscode` holds the same chat as a VS Code sidebar. It has a timeline of both agents, the HUMAN_REVIEW and
permission prompts above the composer, and buttons that open the plan, review and report, plus the run's changes in
the diff editor. It runs this package's engine with your Node (≥ 22.12) and shares the configuration, runs and lock with
`duo`, so a run started in one can be resumed in the other. It is not on the Marketplace yet. Build a VSIX with
`npm run package:vscode` and install it with `code --install-extension extensions/vscode/agentduo-vscode-*.vsix`.
See [extensions/vscode/README.md](extensions/vscode/README.md) for requirements, usage and current limits.

## The workspace

`duo` works in the directory you call it from, or in `--dir PATH`:

- both agents run there;
- `.agentduo/` (config and runs) lives there;
- the diff sent to the reviewer only contains changes inside it.

If an agent changes files outside the workspace (elsewhere in the same repository), agentduo warns on screen and in the report, with paths relative to the workspace (`../shared/x.ts`), but does not stop the run.

## Permissions and scope

agentduo passes only the flags its protocol needs: streaming JSON, the output schema, and the prompt on stdin. None of them grants a permission.

**Claude's permission prompts come to you.** When Claude wants a tool that its settings do not allow, the run pauses and agentduo shows Claude's own prompt:

```
⚠ Claude (implementer) asks to use Bash
  Bash  npm test
❯ Allow once
  Always allow Bash(npm test:*)  saved by Claude to .claude/settings.local.json
  Deny
  Deny with a message…
```

- **Always allow** hands Claude back the rule it suggested, and Claude saves it in its own settings, as it does when you answer its prompt directly. That file is never part of a snapshot or of the diff the reviewer sees.
- **Deny with a message** tells Claude what to do instead.
- The agent's timeouts stop while the prompt waits for you.
- In plain mode on a terminal, the same choices are a one-line question.
- Where nobody can answer (CI, the background, output piped elsewhere) Claude runs with `--permission-prompts none` and denies such calls itself. `claude.permission_prompts: deny` does that everywhere.

What each agent may do without asking is up to its own configuration:

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
| `duo` | Open the [chat](#chat) (in a terminal) |
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
claude: { model: null, max_budget_usd: null, permission_prompts: ask, args: [--no-session-persistence], role_args: {} }
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

- **Tool calls are denied.** In a terminal, Claude asks you first (see [Permissions and scope](#permissions-and-scope)). Unattended runs need the permission in advance; the warning names the denied tools.
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

npm run typecheck:vscode   # the VS Code extension (F5 in VS Code runs it in a development host)
npm run build:vscode       # extensions/vscode/dist (host, webview) and runtime/ (engine worker + schemas)
npm run test:vscode        # smoke test in a downloaded VS Code; on Linux run it under xvfb-run
npm run package:vscode     # extensions/vscode/agentduo-vscode-<version>.vsix (local, not published)
npm run test:pack:vscode   # package, check the VSIX contents, run its worker outside the checkout
```

The extension's design notes are in `docs/superpowers/specs/2026-10-28-agentduo-vscode-design.md`.

## License

MIT
