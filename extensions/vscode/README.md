# agentduo for VS Code

The [agentduo](https://github.com/HaiTrieu247/agentduo) channel in a VS Code sidebar. Codex plans and reviews
the code, and Claude Code critiques the plan and implements it. The extension runs the same engine as the `duo` CLI and
uses the same configuration, run directory and lock. A run started in one can be resumed in the other.

## Requirements

- VS Code desktop 1.95 or later, with a local, trusted folder that is inside a git repository.
- Node 22.12 or later. VS Code's own Node is not used. The extension takes the first suitable `node` on the
  `PATH` VS Code sees, or the path in the `agentduo.nodePath` setting.
- Codex CLI and Claude Code CLI, installed and signed in. Set `codex.bin` / `claude.bin` in `.agentduo/config.yaml`
  when VS Code's `PATH` differs from your terminal's. This often happens on macOS when VS Code is opened from the Dock.

The npm package `agentduo` does not need to be installed, because the VSIX carries its own engine.

## Install a local build

```sh
npm ci
npm run package:vscode            # writes extensions/vscode/agentduo-vscode-<version>.vsix
code --install-extension extensions/vscode/agentduo-vscode-*.vsix
```

To develop it, open the repository in VS Code and press F5 (**Run agentduo extension**). The launch builds the
extension and opens an Extension Development Host on the repository.

## Using it

Open **agentduo** in the Activity Bar.

- Opening the sidebar starts nothing. It reads the latest run so it can offer **Resume**. The first task you send starts
  a run in the chosen folder. In a multi-root window you choose the folder first (**agentduo: Choose Workspace Folder**).
- The composer works like the terminal chat. **agentduo: Open Chat** puts the cursor in it. Enter sends and Shift+Enter
  starts a new line; while an IME is composing, Enter only commits the word. While a step runs, what you type is a note
  for the next step. **Stop** (or Esc in the composer) interrupts the step, and sending again re-runs it.
  `/help` lists the slash commands: `/new`, `/resume`, `/edits`, `/claude …`, `/codex …`, and the rest.
- HUMAN_REVIEW decisions (resume, revise, abort, defer, with a note) and Claude's permission requests (allow once,
  always allow, deny) appear above the composer. They stay there when you hide the sidebar. **Always allow** saves
  Claude's rule to `.claude/settings.local.json`, the same file the CLI uses.
- The toolbar opens the plan, review, feedback and report of the run in an editor. **Changes** lists the files
  the run changed and opens them in VS Code's diff editor. The diff goes from the run's baseline snapshot to its latest
  snapshot, so edits you made before the run are not included. Opening Changes again after another round shows that
  round's snapshot. A diff that is already open keeps the snapshot it was opened at.
- **agentduo: Doctor** checks Node, the CLIs, the configuration and the workspace, and writes the results to the
  **agentduo** output channel. **agentduo: Open Configuration** opens `.agentduo/config.yaml`.

Agents, models, flags and gates are configured as for the CLI. The extension adds no permission rules or flags of its
own. Claude's permission requests come to the sidebar only while it can answer them.

Reloading the window or closing VS Code stops the current step, as Esc does in the terminal. Pending decisions are
deferred, unanswered permission requests are denied, the lock is released, and the run stays resumable. The engine
gets 4 seconds to do this, even when it is still starting, and is then stopped outright. The extension never restarts
a task on its own. It offers **Resume** instead.

## Limits of this version

Desktop VS Code with a local folder only. There is no web build, and Remote SSH, WSL and containers are not
supported. Each window has one session and runs one task at a time. There is no browser for older runs: **Resume**
continues the latest run, as `/resume` does in the CLI.
