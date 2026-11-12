# Desktop UI redesign: acceptance screenshots (2026-11-12)

Design: [docs/superpowers/specs/2026-11-12-desktop-ui-redesign.md](../../superpowers/specs/2026-11-12-desktop-ui-redesign.md).

Taken from the built app (`npm --prefix apps/desktop run build`, Electron 45, macOS arm64, a 2× display, scaled to
1600px wide) with a profile, a git project (`demo`) and the fake codex/claude CLIs of the test kit, so no real account
or project appears. Font size 13px (the default). The reference the design follows is the user's own screenshot of the
Claude desktop app, kept with the team run that started this work, not in the repository (it shows the user's own
projects and account).

| File | Window | Theme | What it shows |
|---|---|---|---|
| `chat-dark-1360.png` | 1360×860 | dark | A chat with a pasted image, an answer with a list, code, a table and inline code, Claude's permission card waiting, the composer; the inspector beside it |
| `chat-light-1360.png` | 1360×860 | light | The same |
| `chat-dark-720.png` | 720×480 (the minimum) | dark | The waiting card, its buttons and the composer reachable; the inspector floats (closed) |
| `chat-light-720.png` | 720×480 | light | The same |
| `settings-dark.png`, `settings-light.png` | 1360×860 | both | Settings → General |
| `team-editor-dark.png`, `team-editor-light.png` | 1360×860 | both | Settings → Team with agentduo's team in the list, unsaved |
| `dialog-dark.png`, `dialog-light.png` | 1360×860 | both | The app's own confirmation (deleting an archived conversation), Cancel focused first |

What follows the reference: a warm grey sidebar with each project's conversations grouped under it, a thin title bar,
a near-black (white in light) reading area with one centred column of about 76 characters, your messages as raised
bubbles on the right, answers as plain text, and a raised, rounded composer at the bottom.

What differs on purpose: no Home, Search or Artifacts entries (agentduo has no such features); the inspector (plan,
changes, checks, report) is a third column on a wide window; agentduo's teal is the accent (links, focus, the primary
button) where the reference has none; the waiting cards (questions, permissions, decisions) keep an accent edge so they
are seen.

Checks run on this build: `npm --prefix apps/desktop run typecheck`, `test` (unit, with the style, contrast and dialog
tests), `build` and `test:e2e` (desktop.test.ts, shell.test.ts and settings-ui.test.ts: both window sizes, both
themes, contrast measured on the rendered colours, keyboard focus in dialogs and Settings).
