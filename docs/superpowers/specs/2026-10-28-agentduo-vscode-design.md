# agentduo for VS Code: design

Amends `2026-10-27-agentduo-channel-design.md`. The extension is the chat from `src/chat.ts`, placed in a VS Code
sidebar. It adds no workflow, schema, prompt or permission rules. User documentation is in `extensions/vscode/README.md`.

## Shape

```
VS Code (extension host, CJS: dist/extension.cjs)
  Controller ─ workspace choice, commands, OutputChannel, content providers (artifacts, snapshots)
  WorkspaceSession ─ one per chosen folder; holds the ViewState, pending requests, the worker client
  ChatViewProvider ─ WebviewView "agentduo.chat"; CSP with nonce, assets only from dist/webview
        │ postMessage (WebviewMessage / HostMessage, validated in protocol.ts)
  Webview (browser IIFE: dist/webview/main.js) ─ reducer (state.ts) + DOM renderer (render.ts), no framework
        │
        │ child_process.fork, IPC only, execPath = checked Node ≥ 22.12 (PATH or agentduo.nodePath)
        ▼
Worker (ESM: runtime/worker.js, every dependency bundled, runtime/package.json named agentduo + runtime/schemas)
  RuntimeSession ─ prepareEnvironment (src/core/environment.ts), acquireWorkspaceLock, Chat, EventBus,
                   ChatUi adapter, DecisionBroker (HUMAN_REVIEW) and PermissionBroker (Claude host mode)
```

- Each message carries the protocol version and the session generation. Each request has an ID. Replies to an
  unknown, stale or already-answered request are ignored.
- Opening the sidebar starts the worker. The worker only reads: it prepares the environment, inspects the latest run
  for `greet`/Resume, and does not take the lock. The lock is taken by the first command that starts a session.
- On shutdown (deactivate, reload, folder switch, IPC disconnect, SIGTERM), pending decisions are deferred, unanswered
  permission requests are denied, `Chat.stop()` is called, and the lock is released. The host waits a grace period
  (4 s), then kills the worker. This holds for a worker that is still starting, before its hello or while `initialize`
  is unanswered: teardown never waits for a start to finish. A restart starts the next worker only once the old one
  has exited, and requests that were waiting on the abandoned start go to the new worker.
- RunStore stays the only durable record. The host keeps a bounded presentation state: 400 timeline items, and
  150 activities per step. The webview gets that state as a snapshot whenever it is (re)created.
- Changes go from `state.base` to `state.lastSnapshot` (`Git.nameStatus`, `Git.readBlob`), never from HEAD. A change
  list names both snapshot commits, and so does every diff URI and snapshot read. Because VS Code caches a document per
  URI, a later round gets new documents instead of the previous round's cached text, and an open diff keeps showing the
  snapshot it was opened at. The host serves only files from a change list it showed, and the webview never sends a
  path or a URI.
- The host sends a worker nothing but `initialize` until `initialize` has answered. A request made during startup
  waits for it.

## Sidebar

The sidebar follows the look of VS Code's own chat views (Claude Code, Codex): no header of its own, a conversation on
a rail of dots, and one box to write in. Session actions live in the view's title bar.

```
┌ AGENTDUO: CHAT  MultiAgent ──── ＋ ⟲ ⚙ ⋯ ┐  title bar: folder (view description), New, Resume, Settings;
│                                           │  ⋯ holds Open Plan / Changes / Report, Doctor, Configuration
│ ✓ Plan › ● Critique › ○ Implement › ○ Rev │  progress: only while a run goes on or waits (runInProgress);
│                    plan 1/3 · impl 0/2 · $│  ✓ done, ● active, ⏸ stopped, ○ to do; rounds and usage
├───────────────────────────────────────────┤
│                                 → Codex   │  your message: a box, with where it went
│ ┌───────────────────────────────────────┐ │
│ │ fix the retry in the runner           │ │
│ └───────────────────────────────────────┘ │
│ ✻ Claude Anthropic plan critic  Plan r1 · │  a step or an answer: mark, name, role or model, meta
│ ● Read  src/agents/runner.ts              │  one row per activity, tool name apart (activityParts);
│ ● Edit  test/workflow.test.ts  +24 −3     │  folded into "N actions ›" once done
│ ◌ Bash  npm test                          │
│ ● Codex → Claude  Plan: 3 steps           │  a handoff, with Open plan / feedback / changes / review
│ ● The answer, as Markdown                 │  rendered by markdown.ts + render.ts as elements and text
│ ✓ Done: …              Report   Changes   │  notes, warnings, finish; New activity ↓ when scrolled up
├───────────────────────────────────────────┤
│ ⚠ Your decision is needed · plan_ready    │  HUMAN_REVIEW and permission cards, above the composer
├───────────────────────────────────────────┤
│ ╭───────────────────────────────────────╮ │  composer: Enter sends, Shift+Enter newline, IME-safe;
│ │ Ask Codex… (/ for commands)           │ │  the placeholder follows ChatStatus
│ │ /  ⬡ Codex gpt-6.1 ▾  ✎ Edits: ask [↑]│ │  / commands · recipient chip · edits · send, or Stop
│ ╰───────────────────────────────────────╯ │  (■) while something runs and the input is empty
└───────────────────────────────────────────┘
```

- The recipient chip's menu has Codex, Claude (with their models and effort), Discuss, Pipeline and the settings.
  Discuss (see `2026-10-28-agentduo-discuss-design.md`) is for the next message only, as Pipeline is; a discussion is
  one card, live while it goes on, then its outcome, its turns folded and its final answer. Pipeline is
  for the next message only: it is sent with the `pipeline` route, and the chip goes back to the recipient. It is off
  while something runs, because the chat would only answer that something is running; messages are notes then.
- Settings (title bar or the chip's menu, `showSettings` from the host) open as a sheet above the composer. The menus
  float above the box; a click elsewhere or Esc closes them.
- The sheet has no Apply buttons: each choice is sent at once as the chat's setting command (`SettingRequest`), and the
  sheet is rebuilt from the `settings` the worker sends back, keeping the focused control by its `data-key`.
  - Model, effort, edits, reasoning and permissions are pickers whose list drops down in the sheet's own flow.
  - Codex's models come from `codex debug models` (with the config overrides codex doctor gets): the models whose
    `visibility` is `list`, by `priority`, as Codex's /model shows them. The worker reads them once per binary,
    overrides and config files (`ModelRegistry`'s `onCatalog`, only for a view with a picker) and sends a `catalog`
    update (protocol 3). Reasoning offers the chosen model's levels that agentduo can set (`CODEX_EFFORTS`, so not
    `ultra`), and Default only while no effort is set, because `/codex model` keeps an effort once set.
  - Claude's models are Claude Code's aliases (`CLAUDE_MODELS`, from Claude Code 2.1.31x), with Default first and the
    model set now even when it is none of them.
  - Claude's allow and deny rules and extra directories are tags with an input (Enter adds); a rule's × removes it.
    There is no command to drop an extra directory, so its tags have no ×.

## Theme tokens

| Use | Token |
|---|---|
| Text, secondary text | `--vscode-foreground`, `--vscode-descriptionForeground` |
| Background | `--vscode-sideBar-background`, `--vscode-editor-background` (code), `--vscode-editorWidget-background` (cards) |
| Borders, focus | `--vscode-panel-border`, `--vscode-widget-border`, `--vscode-focusBorder`, `--vscode-contrastBorder`, `--vscode-contrastActiveBorder` |
| Input | `--vscode-input-background`, `-foreground`, `-border`, `-placeholderForeground` |
| Buttons, links | `--vscode-button-*`, `--vscode-button-secondary*`, `--vscode-textLink-foreground`, `--vscode-toolbar-hoverBackground` |
| Status | `--vscode-testing-iconPassed` (done), `--vscode-editorWarning-foreground` (warning), `--vscode-editorError-foreground`, `--vscode-inputValidation-error*` (errors) |
| Fonts | `--vscode-font-family`, `--vscode-font-size`, `--vscode-editor-font-family` |

Icons are [Codicons](https://github.com/microsoft/vscode-codicons), VS Code's own icon font (CC BY 4.0, a
devDependency): the build copies `codicon.css`, `codicon.ttf` and the licence to `dist/webview`, and the page loads
that stylesheet before ours. The Claude and Codex marks stay agentduo's own SVG drawings.

Every status also has a text label or an icon, so it never relies on colour alone. The status colours are made for
icons, and in light themes they are too pale for small text. There, status text mixes them with
`--vscode-foreground` (`color-mix`). That keeps the hue and gives at least 4.5:1. High-contrast themes get outlines,
and `prefers-reduced-motion` turns off the pulsing dots. Agent output reaches the page as text nodes only. Answers
and handoffs are Markdown: `webview/markdown.ts` reads a safe subset (headings, paragraphs, fenced code, lists,
quotes, rules, GFM tables; code spans, strong, emphasis, strikethrough and links inline) into plain data, and
`render.ts` builds elements from it with `createElement` and text nodes. HTML in an answer stays text. A link is shown
with its target as a tooltip and is never followed. Plans and reports still open in a VS Code editor.

## References

These were used for the interaction patterns only. No policy or code was copied.

- [Claude Code in VS Code](https://code.claude.com/docs/en/vs-code): conversation in the sidebar, the rail of tool
  rows, one composer box with a model chip, changes in the native diff editor.
- Codex in VS Code: session actions in the view's title bar, finished work folded into one row.
- [Cline](https://docs.cline.bot/cline-overview): tool activity shown as compact rows, and approvals shown as cards
  above the composer.
- [Webview API](https://code.visualstudio.com/api/extension-guides/webview) and
  [Bundling extensions](https://code.visualstudio.com/api/working-with-extensions/bundling-extension): CSP, local
  resource roots, message passing, and one bundle per runtime.

## Verification

- Automated: `test/vscode-*.test.ts` covers the protocol, brokers, reducer, webview rendering, artifacts, the session,
  and a real worker over IPC with the fake CLIs. `npm run test:vscode` runs an Extension Development Host smoke test
  (activation, commands, view, worker, content providers, and a two-round run whose diff moves to the newer snapshot).
  `npm run test:pack:vscode` checks the VSIX contents and runs
  the packaged worker outside the checkout.
- Sidebar redesign (title bar actions, rail, Markdown, Codicons, recipient chip), 2026-10-28: checked in Chrome with
  the built webview bundle and the real reducer, in Dark Modern and Light Modern colours at 500 px wide: a Markdown
  answer, a running pipeline, the recipient menu, a decision card, the settings sheet and the empty sidebar. The
  desktop check below predates the redesign; its layout, keyboard and high-contrast checks have to be repeated.
- Desktop check, 2026-10-28, VS Code 1.143.1 on macOS (arm64): 131 of 131 checks passed. A Playwright script drove
  the real workbench over the DevTools protocol, with the extension loaded from `extensions/vscode`. It used a scratch
  repository named `Dự án mẫu`, the fake CLIs and one gate. One run went through every role, a Claude permission prompt,
  a HUMAN_REVIEW stop and a second round to DONE. A second run was stopped with Esc and then re-run.
  - Layout and themes: the sidebar was checked at 319 px and 600 px wide in Light Modern, Dark Modern, High Contrast
    and High Contrast Light. That covered the empty sidebar, a permission card, a decision card and DONE (also with
    every activity list open). Each case got a screenshot and a check of the DOM. No element overflows horizontally,
    including long paths and unbroken strings. All visible text is at least 4.5:1 against its actual background.
    Question cards are not clipped. Nothing overlaps the composer, and the timeline stays at the newest item. With a
    600 px tall window, the composer stays whole and the card scrolls inside its own area.
  - Keyboard only: the chat was opened from the command palette and every Tab stop has a focus ring. The order is
    header, timeline, steps, toolbar, composer, Send. The permission and decision cards can be reached with Tab and
    Shift+Tab and answered with Space or Enter; the answer and the card note reached the agents. Enter opens an
    activity list. **Changes** opens a QuickPick that includes the Unicode and space names. "New activity ↓" works with
    the keyboard. Esc stops a step, and Enter on an empty composer re-runs it.
  - IME: Vietnamese Telex input was simulated through Chromium's composition path (`Input.imeSetComposition` and
    `insertText`). That path produces real composition events and a keyCode 229 Enter. The Enter that commits a word
    did not send. The text reached the planner unchanged, and so did a note typed the same way during a run.
  - Hide and reopen: Cmd+B was pressed twice during a running step. The timeline, the live step and a half-typed draft
    were all back afterwards. Agent-written HTML stayed text, and the webview console showed no CSP or script errors.
  - Defects found and fixed:
    - Open Chat focused the webview but no element in it.
    - Question cards shrank with the timeline.
    - The timeline lost the bottom when a card opened or the sidebar was resized.
    - The jump button moved the composer up over the timeline and was transparent in high contrast.
    - Status text was 1.9:1 to 2.9:1 in Light Modern.
    - The Abort button in High Contrast and the command block in High Contrast Light were unreadable.
    - The chip said "Running" while a permission waited.
    - A stopped phase showed as done in the pipeline.
  - Not covered: typing on the macOS Vietnamese input source with a physical keyboard. This could not be driven without
    sending OS-level keystrokes to the desktop session. The baseline VS Code 1.95 was also not checked.
