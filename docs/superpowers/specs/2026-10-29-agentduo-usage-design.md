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
- **Claude's account:** `claude auth status` (JSON, about 0.1 s, run beside `/usage`) says who Claude Code signs in
  as. `claudeAccount` gives a claude.ai login its plan (`subscriptionType`: "Max", "Pro") and email, and names the
  other ways it signs in ("API key", "OAuth token", "Amazon Bedrock"…); the organization is never shown. Signed out,
  it exits with 1 and still prints its JSON (`loggedIn: false`), and Claude's part is "not signed in: run claude auth
  login" whatever `/usage` said. A Claude Code that cannot answer (older, or a failure) leaves the account `/usage`
  named ("subscription"). Verified against Claude Code 2.1.314 (`test/fixtures/claude-auth-status.json`, from a real
  run with the email, organization and paths replaced).
- **Codex:** `codex exec "/status"` would send the words to the model, so agentduo asks `codex app-server`, as Codex's
  IDE extension does: JSON-RPC lines on stdio, `initialize`, the `initialized` notification, then `account/read`
  (`refreshToken: false`) and `account/rateLimits/read`. The app server exits as soon as its stdin closes, so stdin
  stays open until both have answered. It takes the `-c`/`--enable`/`--disable` overrides of `codex.args`, as
  `codex doctor` does. Verified against codex-cli 0.164 (`test/fixtures/codex-account.json`, from a real run with
  the email and ids replaced).
- `codexUsage` shows the account as Codex's `/status` does (the plan, "ChatGPT Plus", and the email), each window as "5h limit",
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
- Each part's `AgentUsage` has the account (its plan, or how the CLI signs in) and the email apart, for the Account &
  Usage view's rows; the panel's heading joins them: "Claude Code · Max · email", "Codex · ChatGPT Plus · email".
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

## VS Code: the Account & Usage view

- The Activity Bar's agentduo container has a webview view, **Account & Usage** (`agentduo.account`), above the
  Conversations tree, as Claude Code's own sidebar shows its account and usage. Per agent, Claude Code first: its
  logo, name and plan; its email; each limit with its percent, a thin meter (warning colour from 70%, error from 90%)
  and when it resets; notes. A part that failed says why under the agent's name, so both agents always show.
  Below: "Updated N min ago · View details" (`agentduo.usage`: the tab's Usage panel, with Claude's details).
- Protocol 8: the `accountUsage` request (no conversation) answers `{ claude, codex }` once both lookups are done,
  with the config the next agent call gets; it takes no lock, writes nothing and runs beside any request. A broken
  config fails it (`config`); shutdown stops its lookups. With no folder open, the home folder's worker answers it
  (the tabs work there too); while several folders wait for a choice, a worker in the home folder answers it, with
  `initialize`'s `discover: false` (no model lookup) and no tab, and it goes once a folder's session starts. A worker
  that cannot start says why instead. What a worker says as it starts while no tab is open (the hint, warnings) waits
  for the first tab.
- `AccountView` (host) keeps the state and posts it whole (`account` message); the page (`webview/sidebar.ts`, rows
  from `webview/account.ts`) only asks for it (`ready`), `refresh`es and asks for `details`. It looks up when the
  view first shows, when it shows again with numbers a minute old, on ↻ (`agentduo.refreshAccount`, ignored while a
  lookup runs), every 5 minutes while it shows, and after an answer or a run in any tab ends, at most once a minute.
  A hidden or collapsed view looks nothing up; what changed meanwhile is looked up once it shows. While a lookup runs
  the earlier numbers stay, with a spinning icon; a lookup that cannot run keeps them and says why. Another workspace
  looks up again, after a lookup under way.

## Tests

`test/usage.test.ts` (reading the real outputs, the app server's dialogue through `test/fake-agent.mjs`, failures,
timeouts, stopping), `test/format.test.ts` (rows and text), `test/chat.test.ts` (the report's states, a failing part,
text without a panel, refresh, an answer left alone), `test/ink.test.tsx` (the panel, keys, scrolling, a prompt before
it), `test/vscode-*.test.ts` (protocol, state, the worker), `test/vscode-account.test.ts` (the Account & Usage view's
rows and when it looks up), and checks in the extension's smoke test.
