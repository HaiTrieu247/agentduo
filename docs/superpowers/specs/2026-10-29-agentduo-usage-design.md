# /usage: both agents' plan limits in one panel

Amends `2026-10-27-agentduo-channel-design.md` and `2026-10-28-agentduo-vscode-design.md`. Claude Code has `/usage`
and Codex has `/status`, each in its own TUI. In the chat, `/usage` shows both in one panel, as Claude Code's
`/usage` dialog does. `/status` (the run's phase, rounds and cost) is unchanged.

## Where the numbers come from

Neither lookup calls a model, and both run beside whatever else runs.

- **Claude:** `claude -p /usage` (no other flag, the agents' environment, the workspace as cwd) prints Claude Code's
  `/usage` as text in about two seconds. `claudeUsage` reads the account line ("You are currently using your
  subscription…"), the block of `<limit>: N% used · resets …` lines, and keeps the rest as printed ("What's
  contributing to your limits usage?" and its blocks). Text with no limit line is kept whole, so a future format
  still shows verbatim.
- **Codex:** `codex exec "/status"` would send the words to the model, so agentduo asks `codex app-server`, as Codex's
  IDE extension does: JSON-RPC lines on stdio, `initialize`, the `initialized` notification, then `account/read`
  (`refreshToken: false`) and `account/rateLimits/read`. The app server exits as soon as its stdin closes, so stdin
  stays open until both have answered. It takes the `-c`/`--enable`/`--disable` overrides of `codex.args`, as
  `codex doctor` does. Verified against codex-cli 0.164 (`test/fixtures/codex-account.json`, from a real run with
  the email and ids replaced).
- `codexUsage` shows the account as Codex's `/status` does ("ChatGPT Plus · email"), each window as "5h limit",
  "Weekly limit" (from `windowDurationMins`), its `usedPercent`, and `resetsAt` as Claude says it ("Resets Nov 4 at
  1:41pm", local time). Each bucket of `rateLimitsByLimitId` other than Codex's own is a group titled by its
  `limitName`. Credits, a reached limit and a spend limit are notes. An API key account has no plan limits, which is
  said, not an error; no account at all is "not signed in: run codex login".
- Each lookup has 15 s (`USAGE_TIMEOUT_MS`). A failure (no CLI, a non-zero exit, a timeout) is that part's error,
  with the CLI's first line of output; the other part still shows.

## In the chat

- `/usage` (and the panel's refresh) builds a `UsageReport`: an id and each agent's `loading`, `ready` or `error`
  part. `ChatUi.usage` gets it at once with both parts loading, then again, same id, as each part arrives. A refresh
  gets a new id and stops the lookups it replaces; their results never show. Ids grow across chats and workers
  (`max(Date.now(), last + 1)`), because a view opens its panel for an id it has not seen.
- A screen without `ChatUi.usage` gets the whole report once, as text (`usageReportText`).
- `usageRows` lays the report out for every screen: each agent's account and limits, Claude first, then Claude's
  details. The terminal draws each bar as blocks, the webview as a meter.

## Terminal

- The panel takes the input's place, in a round box. It scrolls with ↑↓ (PgUp/PgDn, Space) when it is taller than
  the terminal; long lines wrap, keeping their indentation. `r` refreshes. Esc closes it and does nothing else, so an
  answer under way goes on; what still arrives for a closed report keeps it closed, and a new `/usage` opens it.
- A permission prompt or a decision goes before the panel, which comes back where it was once it is answered.

## VS Code

- Protocol 5: the `usage` UI update (for one tab) and the `usage` request (`{ conversation }`), which the panel's
  Refresh and the title bar's `⋯` → **Usage** (`agentduo.usage`) send; `/usage` typed in the composer goes as any
  command does.
- The tab's state keeps its latest report (`ViewState.usage`); a tab restored after a reload has none. The webview
  opens the Usage sheet, above the composer like Settings, for a report with an id it has not seen; the report a
  re-shown tab already had never opens it again. Refresh, ✕ and Esc; a pending permission or decision hides it until
  answered.

## Tests

`test/usage.test.ts` (reading the real outputs, the app server's dialogue through `test/fake-agent.mjs`, failures,
timeouts, stopping), `test/format.test.ts` (rows and text), `test/chat.test.ts` (the report's states, a failing part,
text without a panel, refresh, an answer left alone), `test/ink.test.tsx` (the panel, keys, scrolling, a prompt before
it), `test/vscode-*.test.ts` (protocol, state, the worker), and a check in the extension's smoke test.
