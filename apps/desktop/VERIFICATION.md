# Desktop verification

This file lists only what was run, with its results. If an OS, a package type or CI is not listed below, it has not been verified yet.

## 2026-10-31 · Follow-up: self-update and the release workflow (macOS, Darwin 27.2, Apple Silicon arm64)

- `npm run typecheck` and `npm test` pass (10 files, 93 tests). The new `test/updates.test.ts` drives the update state
  with a fake electron-updater: which builds install, only tell or never look; codesign's output (Developer ID or ad hoc);
  error texts; up to date → downloading (whole percents) → ready → restart, which hands over to the installer only at
  quit; tell-only builds download nothing; one check at a time; a failed check, download or install; the timer and its
  preference. IPC, preferences, packaging (the `publish` config, the devDependencies) and the release workflow's shape
  have tests too.
- `npm run test:e2e`: 10 tests pass on the dev build. The new one serves a local update feed (electron-updater's generic
  provider, version 99.0.0): Settings → General shows the version and *AgentDuo 99.0.0 is out*, with *Download*; the
  feed's channel file was fetched and no zip was; the automatic-check preference turns off and on; the sidebar shows
  *Get AgentDuo 99.0.0*.
- Screenshots of the dev build checked by eye (dark): the Updates card before a check, with a newer version out, and
  ready to restart; the sidebar's *Restart to update* above Account & Usage.
- `npm run package:mac` made `AgentDuo-0.7.3-mac-{arm64,x64}.{dmg,zip}` (the x64 executable is x86_64), both zips'
  blockmaps and `latest-mac.yml`, which lists both zips with sizes and sha512 (the arm64 one checked against the file).
  The app holds `Contents/Resources/app-update.yml` (github, HaiTrieu247/agentduo). It is ad-hoc signed
  (`Signature=adhoc`). `npm run test:pack` passes on `release/mac-arm64/AgentDuo.app`.
- That packaged app, started with a profile of its own through `--user-data-dir` (no test variables), logged
  `updates: notify` (not signed with a Developer ID) and its automatic check reached the real GitHub, which has no
  release yet. The first run showed electron-updater's raw error; it now reads *No AgentDuo release is published on
  GitHub yet.* (a unit test has the real message; the dev build checked against the real GitHub feed says it too).
- `codesign -dv` on Developer ID apps installed here (Visual Studio Code, Google Chrome) names a Developer ID authority,
  as the detection expects; on AgentDuo's ad-hoc build it does not.
- Root `npm run typecheck` and `npm test` (42 files, 529 tests) pass.
- `.github/workflows/release.yml`: its YAML parses, every `run` script passes `bash -n`, the tag check accepts v0.7.3
  and refuses v0.7.4 for version 0.7.3, and the `$GITHUB_ENV` writer skips an empty secret. **It has never run on GitHub**
  (nothing is pushed).
- Not run: installing an update on any OS (that needs two published releases), Windows and Linux packages and their
  feeds (`latest.yml`, `latest-linux.yml`), a Developer ID or notarized Mac build, and the restart's confirmation dialog
  while an agent works.

## 2026-10-31 · Follow-up: the app is named AgentDuo (macOS, Darwin 27.2, Apple Silicon arm64)

- `productName` is AgentDuo: `npm run pack:dir` made `release/mac-arm64/AgentDuo.app` (`CFBundleName` and the executable
  are AgentDuo; `codesign --verify --deep --strict` OK), and `npm run test:pack` passes on it. The window title, the
  sidebar, the welcome screen and the Help menu say AgentDuo; the `duo` CLI, the npm package and the config folders
  keep the name agentduo.
- `npm run typecheck`, `npm test` (72 tests), `npm run test:e2e` (9 tests, dev build) and the same 9 E2E tests on the
  packaged app (test fuses) pass.
- Not run: the Linux deb now installs to `/opt/AgentDuo` (its AppArmor profile names `/opt/AgentDuo/agentduo`) and the
  Windows executable is `AgentDuo.exe`; neither has been built on its OS.

## 2026-10-31 · Follow-up: app icon (macOS, Darwin 27.2, Apple Silicon arm64)

- `node scripts/icon.mjs` rendered `resources/icon.svg` into `resources/icon.png` (1024 × 1024); renders at 64 and 32 px were checked by eye and stay legible.
- `npm run pack:dir` made `release/mac-arm64/AgentDuo.app` with `Contents/Resources/icon.icns` (`CFBundleIconFile` icon.icns), which `iconutil` expands into every size from 16 to 512@2x; `npm run test:pack` passes on it.
- Desktop typecheck passes; unit/integration tests pass (9 files, 72 tests); Electron E2E passes (9 tests) with the dev build's Dock icon set.
- Not checked: the ico and Linux icons (made only when packaging on Windows and Linux), and how the Dock and Finder show the packaged icon.

## 2026-10-31 · Follow-up: conversations without a project

- Desktop typecheck and build pass; unit/integration tests pass (9 files, 58 tests).
- The added real-worker scenario checks chat with both agents and `/discuss` in a non-Git home folder, separate project history, switching back to Conversations, global settings reaching its worker, and history/draft restoration after restarting the manager.
- Electron E2E was updated to cover chat before opening a folder, relaunching into that chat, and switching between Conversations and a project. Execution could not reach the tests: Electron aborted at launch (`SIGABRT`, with `kill EPERM` during cleanup) in the restricted execution environment. The earlier E2E/package results below apply to the prior implementation; this follow-up has not been verified in a running Electron window.

## 2026-10-31 · macOS (Darwin 27.2, Apple Silicon arm64)

All rows below ran on this one Mac, with Electron 45.2.1 (bundled Node 24.22.1).

| Check | Command | Result |
|---|---|---|
| Root typecheck (CLI, engine) and extension typecheck | `npm run typecheck`, `npm run typecheck:vscode` | pass |
| Root tests (engine, settings timing, workflow scenarios, worker/protocol) | `npm test` | 42 files, 529 tests pass |
| npm package and VSIX | `npm run build`, `npm run test:pack`, `npm run build:vscode`, `npm run test:pack:vscode` | pass (`agentduo-0.7.3.tgz`; 21 files in `agentduo-vscode-0.7.3.vsix`) |
| Desktop typecheck (main, preload, renderer, tests) | `npm --prefix apps/desktop run typecheck` | pass |
| Desktop unit/integration tests | `npm --prefix apps/desktop test` | 9 files, 71 tests pass. Covers IPC validation, Settings' option rows (args read as named options and written back token for token), sender trust, stale views, resources and symlinks, preferences, launcher PATH, the CLI probe (and how each CLI signs in: its plan and email or an API, never the key; the pill names the email, Codex's from the usage lookup), the sidebar's busy mark, the usage store the sidebar and Settings share (one lookup at a time per project, a newer answer kept over a slower older one, a failure shown for both agents, a lookup after a turn ends), the `accountOpen` preference, config with no project, diagnostics, diff and packaging config. With real workers (the engine worker run by Node) it also covers: a user config change reaching every open project's chats (from one project's Settings, from no project, a reset, the CLI picker, and from another project's composer: `/codex model … --global` typed, and the chat's settings menu with Global), with each project's override and each session's own value kept, and a `--save` staying in its own project; the selected conversation through A → B → A, a preference change and a restart; and the default recipient for new conversations versus saved ones |
| Build (main, preload, renderer with no Node imports, worker runtime) | `npm --prefix apps/desktop run build` | pass |
| Electron E2E, dev build (`dist/`) | `npm --prefix apps/desktop run test:e2e` | 9 tests pass. Uses fake CLIs and a scratch git project, driven through the window (see below) |
| Unpacked package, release fuses | `npm --prefix apps/desktop run pack:dir` | pass. `release/mac-arm64/AgentDuo.app`, ad-hoc signed (`codesign --verify --deep --strict` OK; flags adhoc, runtime) |
| Package smoke, release profile, on a copy outside the checkout | `npm --prefix apps/desktop run test:pack` | pass. Runtime outside ASAR, no `node_modules` packaged; fuses RunAsNode on, NODE_OPTIONS off, inspector off; bundled Node 24.22.1 runs as Node; the worker says hello (protocol 9); the app starts with a profile of its own and shows its window, with no inspector |
| Electron E2E on the packaged app (test fuses) | `node scripts/package.mjs --dir --test-fuses`, then `AGENTDUO_E2E_APP=$PWD/release/mac-arm64/AgentDuo.app npm run test:e2e` | 9 tests pass, the same tests as on the dev build |
| Real CLIs, read-only (no model call) | the dev build with a scratch profile, onboarding and Settings → Claude & Codex | Claude Code 2.1.314 (`~/.local/bin/claude`) and codex-cli 0.164.0 (an nvm install) found through the login-shell PATH. Each card shows the email it signs in with as plain text (no border, no ✓; Claude's from `claude auth status`, Codex's from `codex app-server` `account/read`), Plan shows Max and ChatGPT Plus, and Settings shows the same limits, percents and reset times as the VS Code extension's Account & Usage view (Claude: current session, week (all models), week (Fable); Codex: 5h and weekly). The sidebar's Account & Usage box shows both emails in full at the default width and the same limits; folding it and opening it again works |

What the E2E drives in the window, with fake CLIs:

- First run: both CLIs are checked (version, sign-in and usage only, no agent call); each card's pill shows the email it signs in with. The sidebar's Account & Usage box shows both emails and the fake limits with their meters; folded, it shows neither and the preference says so; opened again, both agents come back. Settings → Claude & Codex shows each plan and the fake limits, a meter each. Settings work with no project, where only the user config can be changed; each change saves at once, and `claude.max_budget_usd` set from its null default saves the number 5. Then a project is opened from the empty state.
- Chat: one message to Codex, one to Claude (`/claude`). Claude's permission prompt is answered with Allow once.
- Attachments: a file from the picker and a pasted PNG are sent to Claude. The PNG reaches Claude as an image block, and the sent message shows it through an `agentduo://resource/` token.
- `/discuss` until both agents agree, ending with the final answer.
- Selection: conversation A, then B, then A again, then a theme change; main still names A.
- `/pipeline`: plan, implement, the gate, a rejected review, the `max_review_rounds` decision answered with Resume, then an approved review and DONE.
  - While Claude implements, Settings change the project's `codex.model` (next call, typed through *Other model…*) and `agents.code_reviewer` (next run). Both reviews ran on Codex with the new model, and the run's `config.json` agrees.
  - The inspector shows Checks (the gate passed), Changes (app.txt as a line diff) and Plan.
  - The project overrides are reset, and they are deleted from the file.
- Stop during an answer. While it works, a pulsing dot marks its conversation and its project, and only those; after Stop there is none.
- Keyboard and IME: Enter while an IME composes sends nothing. A narrow window (820 px) hides the inspector, and its button brings it back. Light and dark themes both render.
- Quit during a run: the lock is freed and the run stays resumable. The app starts again on the same conversation, its history and the dark theme. Resume from the sidebar's Resumable runs finishes the run (DONE). The worker log shows Electron's own Node.

The screenshots from the E2E (`AGENTDUO_E2E_SHOTS=<dir>`) were checked by eye for dark, light and narrow. They showed one fix, which is made: the brand mark's dots were positioned by the chat's timeline style.

Sandbox mode: Chromium sandbox on everywhere above (the default; `--no-sandbox` was not used).

## Not verified yet

- Opening the dmg and running the macOS x64 build (both were built in the self-update follow-up above, not run).
- Windows (NSIS) and Linux (AppImage, deb): nothing has been run on either OS, including the Windows `.cmd` fake CLIs, the Linux sandbox helper and the AppArmor profile.
- `.github/workflows/desktop.yml` and `.github/workflows/release.yml`: added, but not pushed and never run.
- Self-update end to end (a published release, then an installed app finding, downloading and installing the next one).
- Real CLIs driving real agent work (chat, pipeline) in the desktop. Only the read-only sign-in check ran against them.
- Developer ID signing and notarization: these need your own certificates (see the README). An ad-hoc signed app downloaded from elsewhere is still stopped by Gatekeeper.
