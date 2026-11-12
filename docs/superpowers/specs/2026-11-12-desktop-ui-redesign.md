# agentduo desktop: UI redesign (design system)

Status: implemented. T1 (tokens and the split) by the team run that planned it; T2 (shell, dialogs) and T4 (Settings)
by its devs, reviewed and finished outside it, with its QA's tests (`test/e2e/shell.test.ts`, `test/e2e/settings-ui.test.ts`,
`test/settings-style.test.ts`, `test/dialog-qa.test.ts`); T3 (chat), T5 (work) and the acceptance screenshots
(`docs/verification/desktop-ui-2026-11-12/`) after the run stopped on a usage limit.

Date: 2026-11-12. Scope: the desktop app only (`apps/desktop`), light and dark. The CLI and the VS Code extension are
not redesigned; the shared chat page (`packages/webview`) changes only where the desktop overrides it, scoped to the
desktop (see "The chat"). No feature and no agent, pipeline or team behaviour changes: this is presentation only.

The user's screenshot is the reference for layout, colour, type and spacing: a left sidebar of projects and
conversations on a warm grey, a thin title bar over a near-black reading area, a centred text column, and a composer
fixed at the bottom. We follow its structure and feel, adapted to agentduo's functions; we copy none of its brand,
content or features.

## What the reference measures

Sampled from the attached screenshot (3456×2174, a 2× display):

| Element | Colour | Notes |
|---|---|---|
| Chat background | `#191919` | the whole reading area |
| Title bar | `#1c1c1c` | barely lighter than the chat; separated by a 1px line |
| Title bar line | `#373737` | 1px |
| Sidebar | `#292425` | warm grey-brown |
| Sidebar / chat divider | `#3f3a3b` | 1px |
| Selected sidebar row | `#494545` | a neutral lift, no hue |
| Composer surface | `#303030` | rounded, raised above the chat |
| Inline code | `#2a2a2a` | |
| Body text | `#efefef` | |
| Secondary text, placeholder | `#9c9c9c`, `#878787` | `#878787` is too faint on `#303030` (3.9:1): we use `#9a9a9a` |

Proportions (in CSS pixels): sidebar about 350px; title bar about 48px; text column about 670px (≈ 76 characters);
sidebar rows about 34px; composer radius about 12px; generous space between paragraphs.

## Layout

```
┌──────────────────────┬──────────────────────────────────────────────────────────┬──────────────┐
│ ● ● ●   agentduo     │  Conversation title ▾                 status   ⌘ ☰ ▣    │ (inspector,  │  ← title bar, --topbar-h, drag region
│──────────────────────│──────────────────────────────────────────────────────────│  optional)   │
│ + New conversation   │                                                          │ Plan Changes │
│ ⌕ Search             │        ┌─────────── --read-w (≈76ch) ───────────┐        │ Checks Report│
│                      │        │ user message                           │        │──────────────│
│ PROJECT A        ▾ + │        │ agent turn: text, code blocks, files,  │        │ facts        │
│  ▸ Conversation 1  ● │        │ runs, questions, approvals             │        │ diff         │
│  ▸ Conversation 2    │        │                                        │        │ gates        │
│ PROJECT B        ▾ + │        └────────────────────────────────────────┘        │              │
│  ▸ …                 │        ┌──────── composer (fixed, --r-lg) ──────┐        │              │
│──────────────────────│        │ + @ /   Type / for commands       ➤    │        │              │
│ Account & usage      │        └────────────────────────────────────────┘        │              │
│ ⚙ Settings           │        model · mode · effort                             │              │
└──────────────────────┴──────────────────────────────────────────────────────────┴──────────────┘
  --sidebar-w (resizable)              chat, --bg                                  --inspector-w
```

- The sidebar (`--bg-side`) holds the projects with their conversations, the general conversations, archived ones,
  account and usage, the update notice and Settings. A selected row is `--select-bg`, neutral, never the accent.
- The title bar is part of the chat column (`--bg`), `--topbar-h` high, a 1px `--line` under it; it is a drag region
  and its buttons opt out of dragging. On macOS the sidebar's first row leaves room for the window's buttons.
- The chat centres one column of `--read-w`, with the composer fixed at its bottom, the same width, on `--bg-raised`.
  Long words, paths and code wrap or scroll inside their own block; nothing widens the column.
- The inspector (run plan, changes, checks, report) stays a third column on a wide window and floats over the chat
  (`body.narrow`) below the narrow width.
- Settings and onboarding are full-window pages over the workbench: a sidebar of sections (as the app's sidebar) and
  a page of at most 760px.

At the smallest window the app supports, the sidebar keeps its minimum width (`SIDEBAR_WIDTHS`), the chat its
minimum (`CHAT_MIN`, `resizer.ts`), the composer and its send button stay visible and usable, and the inspector
floats.

## Catalogue of screens and states

Each area is owned by one task and one stylesheet. "States" lists what must be designed and checked in both themes.

| Area | Screen / component | States | Owner (task, stylesheet, code) |
|---|---|---|---|
| Shell | Workbench grid, sidebar edge (resize) | wide, narrow (inspector floats), resizing, keyboard resize | T2 · shell.css · main.ts, resizer.ts |
| Shell | Title bar: title, run status, buttons | idle, running, waiting (decision, permission, question), long title | T2 · shell.css · main.ts |
| Shell | Sidebar: projects, conversations, general, archived, runs | hover, selected, focus, busy dot, missing project, empty list, error, archived toggle on | T2 · shell.css · sidebar.ts |
| Shell | Account & usage box, update notice, Settings button | loading (spinning refresh), signed out, limits (normal, high, full), error note, update ready / download | T2 · shell.css · sidebar.ts, usage.ts, update.ts |
| Shell | Empty centre (no project, no conversation) | first run, no project open | T2 · shell.css · main.ts |
| Shell | Confirm dialogs (remove project, delete conversation, leave with a question) | open, focus trapped, Esc, confirm, cancel, destructive | T2 · shell.css · dialog.ts (replaces `confirm()`) |
| Shell | Toast | error, long text | T2 · shell.css · main.ts |
| Chat | Timeline: user messages, agent turns, markdown, code blocks, tables, quotes | long lines, long paths, wide code, copy button, collapsed rows | T3 · chat.css · chat.ts (+ webview.css) |
| Chat | Attachments and mentions | chips, thumbnails, too big, removing, dropped, pasted | T3 · chat.css |
| Chat | Runs in the chat: stages, progress, discussion, verdicts, finish | running, stopped, done, warning, failed | T3 · chat.css |
| Chat | Waiting for the user: questions, permissions, decisions, team requests | pending, answered, interrupted, held, invalid answer | T3 · chat.css |
| Chat | Composer: input, + menu, @ mentions, / commands, send / stop, pickers (model, mode, effort) | empty, typing, disabled (busy, locked), refused draft, menu open, recipient | T3 · chat.css |
| Chat | Chat empty state, loading, usage sheet | new conversation, reopening, error | T3 · chat.css |
| Work | Inspector: tabs Plan, Changes, Checks, Report | no run, running, empty lists, long paths | T5 · work.css · inspector.ts |
| Work | Changes list and diff | added, modified, deleted, active, long lines, binary | T5 · work.css · diff.ts |
| Work | Gates | ok, error, running, skipped | T5 · work.css · inspector.ts |
| Work | Running team: board, members, PM messages | working, waiting, done, failed | T5 · work.css (+ chat's team views) |
| Settings | Settings page: sections, cards, rows, scope switch, config tabs, advanced | changed, inherited, invalid, saving, locked by another agentduo, invalid YAML | T4 · settings.css · settings.ts |
| Settings | Claude & Codex: CLI cards, sign-in, usage | found, missing, signed out, error, loading | T4 · settings.css · settings.ts |
| Settings | Option editor (CLI args) and its add menu | empty, draft, menu up / down, invalid | T4 · settings.css · argumentOptions.ts |
| Settings | Settings → Team: members, groups, identity editor, member form, preview | empty, invalid team, unsaved, member open, preview pending / error | T4 · settings.css · team.ts |
| Settings | Diagnostics, Data & storage, About | checks ok / failing, long paths | T4 · settings.css · settings.ts |
| Settings | Onboarding | CLIs missing, signed out, ready | T4 · settings.css · onboarding.ts |
| All | Primitives: buttons, icon buttons, fields, selects, segmented, tags, pills, meters, notices | hover, active, focus-visible, disabled, invalid, warning, error | T1 · base.css |

Every state that has a colour also has a word or a mark (the app's rule since the first desktop design): selected
rows have `aria-current`, statuses have a word, a busy dot has a title.

## Tokens

All in `apps/desktop/src/renderer/styles/tokens.css`. Areas read tokens only: `test/styles.test.ts` fails on a raw
colour outside tokens.css, on a variable no file defines, on a theme missing a token the other has, and on a token
that takes a name the shared chat styles define for themselves (`--gap`, `--radius`, `--radius-lg`, `--ok`, `--err`,
`--warn`, `--accent`, `--muted`, `--border`, `--rail`, `--card`, `--surface`, `--code-bg`, `--hover`, `--*-text`).

### Colour

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#ffffff` | `#191919` | chat, title bar, pages |
| `--bg-side` | `#f4f2ef` | `#292425` | app sidebar, settings sidebar, inspector |
| `--bg-elev` | `#ffffff` | `#242424` | cards, menus, dialogs, buttons |
| `--bg-raised` | `#f7f6f4` | `#303030` | composer, raised panels |
| `--bg-input` | `#ffffff` | `#2a2a2a` | fields |
| `--fg` | `#1f1d1c` | `#efefef` | text |
| `--fg-muted` | `#5f5b57` | `#adadad` | secondary text, icon buttons at rest |
| `--fg-placeholder` | `#6f6b67` | `#9a9a9a` | placeholders |
| `--fg-on-accent` | `#ffffff` | `#ffffff` | text on `--accent-bg` |
| `--line` | `#e4e1dd` | `#343434` | dividers, card and button borders |
| `--line-strong` | `#cfcbc6` | `#4a4a4a` | field and segmented borders, quotes |
| `--line-side` | `#e4e1dd` | `#3f3a3b` | the sidebar's edge |
| `--hover-bg` | `rgba(60,47,40,.06)` | `rgba(255,255,255,.06)` | hover |
| `--select-bg` | `rgba(60,47,40,.09)` | `rgba(255,255,255,.11)` | selection, active tab, pressed |
| `--accent-c` | `#08695b` | `#4fd1bd` | links, accent text, active marks |
| `--accent-bg` / `--accent-bg-hover` | `#0b7d6e` / `#096b5e` | `#0b7d6e` / `#096b5e` | primary button |
| `--focus-c` | `#08695b` | `#4fd1bd` | focus ring |
| `--ok-c` · `--warn-c` · `--err-c` | `#16723a` · `#875a00` · `#b91f2a` | `#5cc97a` · `#e0b341` · `#ff8a80` | semantic text and marks |
| `--ok-bg` · `--warn-bg` · `--err-bg` | 10% of their colour | 12% of their colour | semantic tints (notices, banners, invalid fields) |
| `--code-c` | `rgba(60,47,40,.06)` | `rgba(255,255,255,.06)` | inline code, documents |
| `--add-bg` · `--del-bg` | green · red tints | green · red tints | diff rows |
| `--kind-pm` · `--kind-lead` · `--kind-worker` · `--kind-checker` | `#8250df` · `#0b7d6e` · `#57606a` · `#bc4c00` | `#b392f0` · `#4fd1bd` · `#a8afb5` · `#f0883e` | team member kinds (PM, Lead, Dev, Test), tinted tags with a word |
| `--scrim` | `rgba(31,29,28,.32)` | `rgba(0,0,0,.55)` | behind a dialog |
| `--shadow-sm` · `--shadow` | soft | deep | raised controls · menus, dialogs, floating inspector |
| `--codex` · `--claude` | `#0f9d8a` · `#d97a2b` | same | the brand dots only (never text) |
| `--kind-pm/lead/worker/checker` | purple, teal, grey, orange | lighter versions | team member kinds (tinted tags) |
| `--busy-c` | `--fg` | white | the busy dot |

The selection is neutral as in the reference; teal is agentduo's accent for links, focus and the one primary action
of a place. The old primary button (white on `#0f9d8a`, 3.4:1) failed AA: it is now white on `#0b7d6e` (5.0:1).

### Measured contrast (WCAG 2, `test/styles.test.ts` and `test/style-contract.test.ts` check each)

Normal text needs 4.5:1 on every surface it can sit on: `--bg`, `--bg-side`, `--bg-elev`, `--bg-raised`,
`--bg-input`, the selection and hover over the sidebar and the chat, and the semantic tints.

| Pair | Light (lowest) | Dark (lowest) |
|---|---|---|
| `--fg` | 12.6:1 (on selection) | 8.8:1 (on selection) |
| `--fg-muted` | 5.1:1 (on selection), 6.7:1 on `--bg` | 4.8:1 (on selection), 7.8:1 on `--bg` |
| `--fg-placeholder` on fields, composer | 4.9:1 | 4.7:1 |
| `--accent-c` | 5.0:1 (on selection) | 5.4:1 (on selection) |
| `--ok-c` | 4.6:1 (on selection) | ≥ 5.7:1 |
| `--warn-c` | 4.6:1 (on selection) | ≥ 6.7:1 |
| `--err-c` | 4.9:1 (on selection) | ≥ 5.8:1 |
| `--fg-on-accent` on `--accent-bg`, hovered | 5.0:1, 6.3:1 | 5.0:1, 6.3:1 |
| `--focus-c` (non-text, 3:1) | ≥ 5.0:1 | ≥ 5.4:1 |

Disabled controls (opacity .5) are exempt from the contrast minimum, as WCAG allows, and always keep their word.

### Type

- UI font `--font-ui`: the system font (`system-ui`, San Francisco, Segoe UI Variable, Roboto, Noto Sans…), all of
  which cover Vietnamese. Code `--font-mono`: the existing monospace stack (`ui-monospace`, SF Mono, Menlo, Consolas…).
- One base size, the user's (`--font-size`, Settings → Appearance, 11–20px, 13 by default; `theme.ts`). Every other
  size is relative: `--text-xs` .8em (tags), `--text-sm` .92em (secondary), `--text-md` 1em, `--text-lg` 1.15em
  (section titles), `--text-xl` 1.55em (page titles), `--text-2xl` 1.75em (Settings' title).
- Weights: 400 body, `--weight-medium` 550 (labels, names), `--weight-strong` 650 (titles). Line height
  `--leading-ui` 1.4 for controls, `--leading-read` 1.6 for chat prose.
- Reading width `--read-w`: 76ch of the body text (within the 72–78ch the brief asks).

### Space, radii, sizes

- Space: `--space-1` 4, `--space-2` 8, `--space-3` 12, `--space-4` 16, `--space-5` 24, `--space-6` 32. Within a
  control 4–8, between controls 8–12, between groups 16–24, page margins 24–32.
- Radii: `--r-sm` 6 (buttons, fields, rows), `--r-md` 8 (cards, menus, segmented), `--r-lg` 12 (composer, dialogs),
  `--r-pill`.
- Controls: `--control-sm` 24 (small buttons, icon buttons), `--control-md` 28 (buttons, fields, tabs),
  `--control-lg` 32 (sidebar rows, large buttons, the composer's send button). `--topbar-h` 44. `--icon-size` 16.
- Motion: `--dur-fast` .12s, `--dur-med` .2s, `--ease`; every transition or animation has a
  `prefers-reduced-motion: reduce` rule that turns it off.

### Icons

Codicon only (already bundled, CC BY 4.0, `codicon.css` beside the page), at `--icon-size`, in `--fg-muted` at rest
and `--fg` on hover; a meaningful icon has a word or an `aria-label` beside it.

### Interaction states

| State | Look |
|---|---|
| Hover | `--hover-bg`; icon buttons go from `--fg-muted` to `--fg` |
| Active / pressed / selected | `--select-bg` (a selected row also has `aria-current` or `aria-selected`) |
| Keyboard focus | `:focus-visible` ring `--focus-w` (2px) `--focus-c`, offset `--focus-offset` (2px), inset (-2px) inside clipped groups (segmented); never removed without a replacement |
| Disabled | opacity .5 (.55 for fields), default cursor, the word stays |
| Warning / error | `--warn-c` / `--err-c` text, with `--warn-bg` / `--err-bg` tint for a notice, a word or mark (`!`, `✕`), `aria-invalid` fields get an `--err-c` border |

## Stylesheets

```
apps/desktop/src/renderer/
  index.html          codicon.css, webview.css (the shared chat), styles.css; <body class="agentduo-desktop">
  styles.css          the entry: @import of each area, in cascade order, and nothing else
  styles/tokens.css   tokens per theme; --vscode-* mapped onto them for the chat
  styles/base.css     reset and shared primitives
  styles/shell.css    workbench, title bar, sidebar, account box, toast, dialogs          (T2)
  styles/chat.css     the desktop's chat: overrides of webview.css                        (T3)
  styles/work.css     inspector, diff, gates, the running team                            (T5)
  styles/settings.css overlay pages: settings, CLIs, Settings → Team, onboarding          (T4)
```

- Order is part of the design: a later file wins a tie with an earlier one, so the areas come after the base, and all
  come after webview.css. The reset and primitives live in `styles/base.css`, not in `styles.css` itself, because CSS
  allows `@import` only before every rule: primitives written in `styles.css` would come after every area and win
  their ties (for example `.error` over `.nav-empty`, `.btn` over a `.settings-tab`).
- The build (`scripts/build.mjs`) copies the area files beside `dist/renderer/styles.css`, flat (`tokens.css`,
  `base.css`…), and rewrites its imports to those names: the app's protocol serves only the renderer's own folder,
  without subfolders (`appFile`, `main/resources.ts`), and the page's policy (`style-src 'self'`) loads same-origin
  files and no inline style. It fails if an area file would overwrite one of the renderer's files or an import names
  a file it did not ship. No change to the policy or the protocol.
- The split was mechanical first (the old `styles.css`, rule for rule, by area, cascade order kept), then the tokens
  changed; the areas' own restyling is T2–T5.

### The chat (shared with VS Code)

The chat's page is `packages/webview`, drawn by both the VS Code extension and the desktop. It reads `--vscode-*`
variables, which `tokens.css` maps onto the desktop tokens for each theme, and its own `.btn`, `.icon-btn`, `.tag`,
`.notice`, `.muted`, `.small` and `.input`, which `base.css`'s rules of the same name also reach. So:

- The desktop restyles the chat from `styles/chat.css`, every rule under `body.agentduo-desktop` (the marker in
  `index.html`), which also gives it one more class than the shared rule it overrides. VS Code never loads this file.
- A change to `packages/webview` itself is a shared change: run the workspace tests and check the VS Code chat for
  regressions (`npm test`, and the extension's webview), without redesigning it.
- The theme classes `vscode-light` / `vscode-dark` on `<body>` (`theme.ts`) stay: the chat tunes its status colours
  by them.

## Settings that stay

- Theme (system, light, dark) and font size are the user's (`preferences`, applied by `applyAppearance`,
  `theme.ts`): `data-theme` on `<html>` picks the tokens, `--font-size` scales every size, `color-scheme` follows.
- `--sidebar-w` is set by the resizer from the saved width; `--inspector-w` as before.

## Verification

- `test/styles.test.ts` (QA's, from the acceptance criteria): this spec's catalogue and token table, the split, the
  build shipping every stylesheet under the CSP, the saved theme and font size, both themes' tokens and contrast, and
  that the new CSS is the desktop's only.
- `test/style-contract.test.ts` (the design's own rules): the entry imports every area exactly once in cascade order
  and nothing else; the page links the stylesheets in order; every variable used is defined; no token takes a name of
  the shared chat styles; no raw colour outside tokens; contrast on the surfaces QA's test does not cover (raised,
  selection and hover overlays, semantic tints).
- `npm --prefix apps/desktop run typecheck`, `test`, `build`, `test:e2e` (AC7), and the root `npm test` when
  `packages/webview` or `packages/host` change.
- T6 adds the regression and layout checks (narrow window, long names, keyboard focus), T7 the acceptance
  screenshots of both themes (chat with content, Team, Settings, a dialog) beside the reference.
