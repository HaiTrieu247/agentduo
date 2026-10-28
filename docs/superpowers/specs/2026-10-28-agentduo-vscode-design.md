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

```
┌ agentduo ───────────────────────────── ⋯ ┐
│ MultiAgent · v0.4.0        [New] [Resume] │  header: folder, version, session actions
│ PLAN ─ CRITIQUE ─ APPROVE ─ IMPLEMENT ─   │  pipeline: phase · role · backend, from config/events
│   VERIFY ─ REVIEW ─ DONE                  │  (VERIFY only when gates exist; ✓ done, ● active, ⏸ stopped)
├───────────────────────────────────────────┤
│ ── Run 20261028-…  "Add a VS Code …"      │  timeline: run divider, user bubbles,
│ ▸ PLAN r1  Codex · planner   12s · $0.04  │  one card per step and round; activities update by ID
│    ● ran `rg -n …`   ◌ reading src/…      │  and fold into <details> once the step ends
│ ⚠ warning: …                              │  warnings, retries, gate results, info and error notes
│ ✓ DONE  3 files · 41k tokens   [Report]   │  finish summary with Report / Changes; stays at the newest item
│            [New activity ↓]               │  until you scroll up, then this floats over the timeline
├───────────────────────────────────────────┤
│ ⚠ Your decision is needed · max_rounds    │  pending HUMAN_REVIEW card: Resume / Revise / Abort /
│   [Plan] [Review] [Changes]   note: ____  │  Defer + note; permission cards: once / always / deny
├───────────────────────────────────────────┤
│ [Plan] [Changes] [Report]   edits: ask ▾  │  toolbar
│ ┌───────────────────────────────────────┐ │  composer: Enter sends, Shift+Enter newline, IME-safe,
│ │ Type a task… (/help lists commands)   │ │  Esc stops; the placeholder follows ChatStatus
│ └───────────────────────────────────────┘ │  (task / note / re-run)
│                                  [Stop]   │
└───────────────────────────────────────────┘
```

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

Every status also has a text label or an icon, so it never relies on colour alone. The status colours are made for
icons, and in light themes they are too pale for small text. There, status text mixes them with
`--vscode-foreground` (`color-mix`). That keeps the hue and gives at least 4.5:1. High-contrast themes get outlines,
and `prefers-reduced-motion` turns off the spinner. Agent output is rendered with `textContent` only.
Plans and reports open in a VS Code editor, so no agent-written HTML or Markdown is rendered in the webview.

## References

These were used for the interaction patterns only. No policy or code was copied.

- [Claude Code in VS Code](https://code.claude.com/docs/en/vs-code): conversation in the sidebar, changes in the
  native diff editor.
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
