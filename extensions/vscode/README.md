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

Click the agentduo button in an editor's title bar (beside Claude Code's and Codex's), or run **agentduo: Open Chat**.

- **Each conversation is an editor tab.** The first one opens beside your editors, and its tab is named after its first
  message. In a tab's title bar:
  - **＋** (or `/new` in the composer) opens a new conversation in a tab of its own; the other tabs keep theirs;
  - **Resume** and **Settings**;
  - the `⋯` menu opens the run's plan, changes and report, and **Usage**.
- **Tabs work independently.** You can ask in one tab while another is still answering. A workspace runs one pipeline at
  a time, so `/pipeline` or `/resume` in another tab says which conversation's run is going. Settings (models, effort,
  mode, permissions) are the workspace's, so a change in one tab applies to every tab. Who a message goes to is each
  tab's own.
- **Conversations last.** After a reload or a restart, VS Code reopens the tabs: each shows what it showed, and its next
  question still carries what was said before. An answer that was still going when the window closed has stopped, as Esc
  would stop it. Conversations live under the runs directory (`.agentduo/runs/conversations/`).
- **agentduo in the Activity Bar** lists the workspace's conversations, newest first: open ones, and closed ones you can
  open again to go on. **＋** starts a new one, and a badge counts the questions waiting for you.
- Opening a tab starts nothing but the worker, which only reads: it reads the latest run, so it can offer **Resume**. The
  first task you send starts a run in the chosen folder. In a multi-root window you choose the folder first
  (**agentduo: Choose Workspace Folder**).
- While a run goes on or waits for you, a line at the top of its tab shows its stages and rounds.
- The composer works like the terminal chat: a three-way conversation with Claude Code and Codex. The chip under the
  input says who a message goes to and on which model (Codex at first). Its menu switches between **Codex** and
  **Claude**, or makes the next message a question to **Discuss** (that agent answers, the other reviews, until they
  agree, as `/discuss` does) or a task for the **Pipeline**. A discussion shows each turn as it ends, with the
  reviewer's verdict; once it is over its turns fold into one row and the agreed or final answer follows, whole. A slash command typed in the composer always wins
  over the chip. The chip's tooltip and menu also tell what "default" currently means (for example
  `default → gpt-5.5 (codex doctor)`, or a Claude settings alias awaiting confirmation). The `/` button lists the
  commands, and typing `/` shows the same list with a description for each entry.
- **Usage** (or `/usage` in the composer) opens a panel above the composer, as `/usage` opens one in the terminal chat:
  how much of their plans' limits Claude Code and Codex have used, a meter per limit, then Claude's "What's contributing
  to your limits usage?". Each part fills in as its agent answers. **Refresh** looks again; Esc or **✕** closes it, and
  an answer under way goes on. A permission prompt or a decision goes before it.
- **Attached files.** The paperclip under the input picks any files (images, PDFs, text, code…). You can also paste an
  image (Cmd/Ctrl+V), or **hold Shift** while you drag files from Finder or Explorer onto the composer: VS Code needs
  Shift to let a webview take a drop. A drag from VS Code's own Explorer or an editor carries no file the tab can read,
  so use the paperclip for those. The files wait above the input, with a thumbnail for an image, until you send them
  with your next message, question, discussion, task or note (Send with an empty input sends the files alone, also as
  a note while the pipeline runs: the send button stops the run only when there is neither text nor a file); ✕
  removes one. Files keep the order you gave them in, and a message waits until each is attached. A pasted or dropped
  file goes to the extension host, which writes it to a file of its own and hands the engine its path; the engine
  copies it into the conversation (`.agentduo/runs/conversations/<id>/attachments/`).
  Sent files stay in the timeline, also after a reload; a copy that is gone shows a warning in place of its thumbnail.
  Files waiting to be sent go away with `/new` and when the tab closes. A decision never takes them: send them with a
  message first, or choose **Decide later**, then `/resume` with a note. Limits, the images sent as images and what
  that costs are as in the terminal chat (see the main README).
- **Settings** changes what the chat's settings commands change, and applies each choice at once. Model, effort,
  mode, reasoning and permissions are pickers: a click drops the list down. Codex's models are the ones its own
  `/model` offers (read with `codex debug models`), and its reasoning levels are those the chosen model takes. Claude's
  models are Claude Code's aliases (Fable, Opus, Sonnet, Haiku, their 1M-context variants, Best, Opus Plan). Claude's
  allowed and denied tool rules and its extra directories are tags: type one and press Enter to add it, and the × on a
  rule removes it. A box below saves the changes to `.agentduo/config.yaml`.
- Each answer and each pipeline step is drawn on a line of dots, as in VS Code's own chat views: one row per tool the
  agent used (Bash, Read, Edit…), folded once it is done, then the answer. Answers are shown whole, with an Anthropic or
  OpenAI mark and the model they ran on. Their Markdown (headings, lists, code, tables, quotes) is rendered as text
  elements, never as HTML, and links show their target as a tooltip without opening it.
- **agentduo: Open Chat** puts the cursor in the composer. Enter sends and Shift+Enter starts a new line; while an IME
  is composing, Enter only commits the word. The mode chip opens Claude Code's mode menu (Manual, Edit automatically,
  Auto), for Claude in the chat and as the pipeline's implementer; Shift+Tab in the composer switches to the next mode,
  as in Claude Code, so there it does not move the focus back. While a pipeline step runs, what you type is a note for the next step.
  While something runs and the input is empty, the send button becomes **Stop** (Esc in the composer does the same): it
  interrupts the answer or the step. A stopped step continues with `/resume [note]` (or **Resume**), and an empty Enter
  only reminds you of it.
- The sidebar keeps up to 400 entries and about 2,000,000 characters of answers. Older turns (a message and what
  followed it) are dropped whole and a notice says where the full logs are; the newest answer and its question always
  stay, however long.
- HUMAN_REVIEW decisions (resume, revise, abort, defer, with a note) and Claude's permission requests (allow once,
  always allow, deny) appear above the composer. They stay there when you hide the sidebar. **Always allow** saves
  Claude's rule to `.claude/settings.local.json`, the same file the CLI uses.
- The `⋯` menu and the links under each step open the plan, review, feedback and report of the run in an editor. **Changes** lists the files
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
supported. Each window has one session; its tabs answer side by side, but run one pipeline at a time. There is no
browser for older runs: **Resume** continues the latest run, as `/resume` does in the CLI.

## Credits

The icons are [Codicons](https://github.com/microsoft/vscode-codicons) by Microsoft, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) and bundled unchanged (`dist/webview/codicon-LICENSE.txt`).
The Claude and Codex marks are agentduo's own drawings, not either company's logo.
