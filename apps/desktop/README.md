# AgentDuo (desktop app)

AgentDuo is agentduo in a window of its own, on macOS, Windows and Linux: Codex plans and reviews, Claude Code
critiques and implements, and you talk to both. It is the same engine as the `duo` CLI and the VS Code extension (the
worker, `RuntimeSession`, the protocol and the chat UI), hosted by Electron.

- **Sidebar**: Conversations for chats without a project, your projects and each project's conversations (open, waiting for you), plus runs you can resume. A project or conversation where an agent is working (a chat answer, a discussion, a pipeline) has a slowly pulsing dot; the others have none. At the bottom, above Settings, a compact **Account & Usage** box shows each agent's email and its limits (a percent and a thin meter each; the plan and when a limit resets are in tooltips). Click its title to fold it; it stays folded. Above it, a button appears when a new version of the app needs you: *Restart to update*, or *Get AgentDuo x.y.z* where this build cannot install it ([Updates](#updates)).
- **Chat**: the three-way conversation User–Claude–Codex, with who is working, in which role and round, and what tools run.
- **Inspector** (right, collapsible): the run's plan, its changes as a line diff, gate results, the review and the report.
- **Composer**: attachments (picker, paste, drop), recipient and model, permission mode, the route (message, `/discuss`,
  `/pipeline`) and Stop.
- **Settings** (the gear at the bottom of the sidebar) and a first-run **onboarding** that checks both CLIs.

## Requirements

- **Claude Code CLI** (`claude`) and **Codex CLI** (`codex`), installed and signed in. The app runs them in the background;
  it does not install them or hold any credential. Onboarding tells you what is missing and how to install or sign in.
- Nothing else at run time: the engine runs on the Node inside Electron (no Node installation needed for agentduo itself).
  A CLI installed with npm may still need *its own* Node on the PATH; Settings → Diagnostics shows that separately.
- To build from source: Node ≥ 22.12 and npm.

## Build from source

The desktop package builds from the checkout's sources and uses the root toolchain (TypeScript, Vitest, tsup), so install
the root first, then the desktop package:

```sh
npm ci                          # repository root
npm ci --prefix apps/desktop    # Electron, electron-builder, @electron/fuses, electron-updater, Playwright (dev only)
```

| Command (in `apps/desktop`, or `npm --prefix apps/desktop run …`) | What it does |
|---|---|
| `npm run dev` | builds, then opens the app from the build output (`dist/`) |
| `npm run build` | bundles main, preload, renderer and the engine worker into `dist/` |
| `npm run typecheck` / `npm test` | the desktop's TypeScript check and unit/integration tests |
| `npm run test:e2e` | the Electron E2E (`test/e2e`, Playwright): the real app with fake CLIs in a scratch git project, driven as a user: first run, Settings, chat, a permission prompt, attached files, `/discuss`, a pipeline with its gate, review and decision, the inspector's diff, Stop, IME, a narrow window, light/dark, a newer version on a local update feed, quit mid-run and `/resume` after a restart |
| `npm run pack:dir` | an unpacked app for this OS under `release/` |
| `npm run test:pack` | checks that unpacked app away from the checkout: runtime outside ASAR, fuses, bundled Node, worker hello, and the app starting and showing its window |
| `npm run package:mac` | `release/AgentDuo-<version>-mac-{arm64,x64}.{dmg,zip}` (on macOS) |
| `npm run package:win` | `release/AgentDuo-<version>-win-x64.exe`, an NSIS installer (on Windows) |
| `npm run package:linux` | `release/AgentDuo-<version>-linux-x86_64.AppImage` and `…-amd64.deb` (on Linux) |

Packages are native: build each OS's package on that OS (CI does it on all three, `.github/workflows/desktop.yml`).
`npm run package -- --test-fuses` builds the inspector-enabled test profile for Playwright; never ship it. With it,
`AGENTDUO_E2E_APP=release/mac-arm64/AgentDuo.app npm run test:e2e` (the executable on Windows and Linux) runs the E2E
on the package instead of the build output.

The app icon's source is `resources/icon.svg`, drawn on the macOS icon grid (an 824 px rounded square in a 1024 px
canvas). `node scripts/icon.mjs` renders it into `resources/icon.png` (1024 px) with the desktop's own Electron, so it
needs no image tool, and electron-builder makes the icns, ico and Linux icons from that PNG. After changing the SVG,
render it again and commit both files. The build copies the PNG to `dist/main` for the window on Windows and Linux and
the Dock of `npm run dev` on a Mac.

## Using it

1. **Onboarding** checks `claude` and `codex`: missing, installed, signed in, signed out, unknown, or an error. Signed in,
   the card names the email it signs in with (plain, in the text colour), or *API* for an API key or a cloud provider,
   and shows the plan when the CLI gives it (never a key). It links
   the install guides, says which command signs in (`claude` then `/login`; `codex login`), lets you pick a binary
   (saved as `claude.bin` / `codex.bin` in your user config) and Recheck. No model is called. Continue straight to chat, or optionally pick a project folder.
2. **Projects**: *Open Project…* (the native folder picker). Each project runs its own engine worker; switching project
   or conversation keeps the others going in the background, with their drafts.
3. **Conversations**: the app opens a chat without requiring a folder. The sidebar's *Conversations* button returns to these chats from any project; their history and drafts survive restarts. These chats use your home folder and save under `~/.agentduo/runs` by default. Each project keeps its own history. Plain messages go to the recipient you chose; `/discuss <question>` has both agents discuss it and
   Codex sum it up; `/pipeline <task>` (or the route picker) runs the full plan → critique → implement → review workflow.
   Chat and discuss work in any folder; pipeline and resume need a git repository.
4. **Resume**: the sidebar lists the project's stopped or waiting runs; one click sends `/resume <id>`. Conversations come
   back after a restart with what they showed.
5. **Inspector**: Plan, Changes (a line diff of each changed file between the run's snapshots, kept as you look at it even
   when a new round starts), Checks (gate runs) and the review and report.
6. **Stop** (or Esc) stops what runs; quitting stops every run's process tree, answers open questions as the engine does
   on shutdown, and frees each project's lock. A run that was going stays resumable.

### Settings

- **General**: theme (light, dark, system), font size, the default recipient, and **Updates**: the app's version, where
  its update is (up to date, downloading, ready, out but to be downloaded, or why it could not check) with *Check now*,
  *Restart to update* or *Download*, and *Check for updates automatically*. Saved at once in the app's own preferences.
- **Claude & Codex**: a card per CLI: the email it signs in with (*API* for an API key or a cloud provider), its plan,
  path and version, and its limits with a meter each and when they reset, as the VS Code extension's Account & Usage
  view shows them (no model call). The limits are looked up when the page opens (unless a minute old), every 5 minutes
  while it shows, and on Recheck. The sidebar's Account & Usage box shares these numbers: it looks them up when the app
  starts and when you switch project (unless a minute old), every 5 minutes while the window shows, after each turn an
  agent finishes, and on its refresh button; folded, it looks nothing up.
- **Configuration**: a tab per agent, *Workflow roles* and *Rounds & limits*. A change saves at once, into the scope chosen
  at the top (all projects, this project, until the app closes). The model is picked from a list (Codex's comes from its
  own catalog once a chat has read it; *Other model…* takes any name). A CLI's options are added from a menu, each with a
  control of its own: reasoning effort, Claude's permission mode or Codex's sandbox, allowed and denied tools, extra
  folders, skipping MCP servers, not saving sessions; *Other flag…* takes any other flag and its value. Settings writes
  the flags into `args`. The executable and each role's own options are under *Advanced*.
- **Scopes**: each value shows where it comes from (default, user config, project config, this session) and whether the
  project overrides your user config. *Reset* removes the key from that file, so it inherits again; it never writes `null`.
  A change that would make the configuration invalid is not written. A file that is not valid YAML is left alone: Settings
  shows the error and its line, and opens the file for you.
- **When it applies**: *next call* settings (model, effort, permission mode, rules and directories, args, role args, bin,
  budget, permission prompts) apply from the agent's next call, also to a run that is going and when it is resumed.
  *Next run* settings (`agents.*` roles and every `limits.*`) apply to new work only: a run that is going, a discussion
  under way and a resumed run keep the values they started with.
- **Storage** (read only): where runs and conversations live (`paths.runs_dir`, by default `<project>/.agentduo/runs`)
  and where the app keeps its own data. Change `paths.runs_dir` in the config file with every agentduo closed: the
  workspace lock lives there.
- **Diagnostics**: versions, the PATH the agents get and where it came from, both CLIs' status, `duo doctor`'s checks.
  *Export* writes what you saw in the preview; it leaves out credentials, prompts and attachments.

The app's own data (preferences, known projects, drafts, logs) is in its user data folder:
`~/Library/Application Support/AgentDuo` (macOS), `%APPDATA%\AgentDuo` (Windows), `~/.config/AgentDuo` (Linux).

### Finding the CLIs from a launcher

Opened from the Dock, Finder, the Start menu or a desktop launcher, an app does not get your terminal's PATH. The app
builds the PATH the agents get from: the PATH it was started with, the login shell's (`$SHELL -ilc`, with a timeout, on
macOS and Linux), and the usual install folders (Homebrew, `~/.local/bin`, npm's global folder, `%APPDATA%\npm`…).
A binary picked in Settings always wins. Settings → Diagnostics shows where each entry came from.

## Updates

An installed AgentDuo updates itself from this repository's published
[GitHub Releases](https://github.com/HaiTrieu247/agentduo/releases), with
[electron-updater](https://www.electron.build/auto-update) (bundled into main; no runtime dependency). It reads the
release's feed (`latest.yml`, `latest-mac.yml`, `latest-linux.yml`) and compares versions; it never downgrades, and a
stable version skips pre-releases.

- **When**: 15 seconds after the app starts, then every 4 hours, while *Check for updates automatically* is on
  (Settings → General). *Check now* there, or *Check for Updates…* (the AgentDuo menu on macOS, Help on Windows and
  Linux), checks at once either way.
- **Windows** (the NSIS installer) and **Linux AppImage**: a new version downloads in the background (its checksum
  checked), then the sidebar shows *Restart to update*. Restarting quits as *Quit* does (open questions answered, runs
  stopped, locks freed; a stopped pipeline stays resumable), installs and starts the new version; the app asks first
  when an agent is working. Quitting without restarting installs it too.
- **Linux .deb**: the same, but it installs only on *Restart to update*, through `pkexec` (your password), never as a
  surprise when you quit.
- **macOS**: Squirrel.Mac installs only an update signed with the same **Developer ID** as the running app. A Developer
  ID build updates like Windows. An ad-hoc build (the default without a certificate, see [Signing](#signing)) cannot
  replace itself: it says a new version is out (*Get AgentDuo x.y.z*), which opens the release page to download the dmg.
- **Never**: a development build (`npm run dev`), and an app started with a profile of its own
  (`AGENTDUO_DESKTOP_USER_DATA`, as tests do). Such a profile checks only a feed named by
  `AGENTDUO_DESKTOP_UPDATE_CONFIG` (an `app-update.yml`, e.g. electron-updater's `generic` provider on a local server)
  and installs nothing; the E2E does that.

Until the first release is published, a check says *No AgentDuo release is published on GitHub yet.* The updater's
log lines go to the app's log (Settings → Diagnostics).

## Releasing

`.github/workflows/release.yml` releases the desktop app when a `v*` tag is pushed. The tag must be the version of
both `package.json` files, which `npm version` keeps together:

```sh
npm version minor               # or patch, or 0.8.0: bumps the root, the extension and the desktop, commits and tags v0.8.0
git push origin main --follow-tags
```

1. **draft**: checks the tag against both versions, then creates a draft release with generated notes (marked as a
   pre-release when the version has a `-`, e.g. `v0.8.0-beta.1`).
2. **build**, on macOS, Windows and Linux: `npm ci` (root, then desktop), the desktop's typecheck and tests,
   `package:mac` / `package:win` / `package:linux`, the package smoke test, then uploads the installers, their
   blockmaps and the update feed to the draft.
3. **publish**: once every OS has uploaded, and the release holds `latest.yml`, `latest-mac.yml` and
   `latest-linux.yml`, it is published, and installed apps see it at their next check. Should one OS fail, the release
   stays a draft: fix it, then run the failed jobs again (or delete the draft and the tag, and tag again).

Signing is optional. Each certificate is used only when its repository secrets are set (*Settings → Secrets and
variables → Actions*):

| Secrets | What they do |
|---|---|
| `MAC_CERTIFICATE` (the Developer ID Application .p12, base64), `MAC_CERTIFICATE_PASSWORD`, `MAC_IDENTITY` (the certificate's name, e.g. `Your Name (TEAMID)`) | signs the Mac app with your Developer ID, so Gatekeeper opens it and it updates itself |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (with the Mac certificate) | notarizes it |
| `WIN_CERTIFICATE` (a code-signing .pfx, base64), `WIN_CERTIFICATE_PASSWORD` | signs the Windows installer, so SmartScreen does not warn |

Without them, the Mac app is ad-hoc signed (Gatekeeper stops it once, and it does not update itself) and the Windows
installer is unsigned (SmartScreen warns). The workflow publishes neither the npm package nor the VS Code extension:
those are still published by hand.

## Security

- The renderer is isolated (`contextIsolation`, `sandbox`, no Node integration) under a strict content security policy,
  served from the app's own protocol. Navigation and new windows are blocked; links open in your browser, from a fixed list.
- The preload exposes one typed request channel and one event channel. Main checks every request
  (`src/shared/protocol.ts`): its sender (the app's window, top frame, app origin), its shape and sizes, and that the
  project, conversation, change list and view it names are ones it handed out. The renderer never names a path.
- Attached image previews are served by token, each checked again on load (inside its conversation's folder after
  symlinks, a real raster image); tokens go with the conversation's view.
- **RunAsNode**: the engine worker is the app's own executable run as Node (`ELECTRON_RUN_AS_NODE=1`), so the
  `RunAsNode` fuse stays on. Anyone who can run programs as you could already run that executable as Node; release
  builds turn the `NODE_OPTIONS` and `--inspect` fuses off. Moving the worker to `utilityProcess` would allow turning
  `RunAsNode` off later.

## Signing

Signing needs certificates of your own; none are in this repository.

- **macOS**: without a certificate the app is **ad-hoc signed** (`mac.identity: "-"`, hardened runtime, the entitlements
  in `resources/entitlements.mac.plist`), which lets it run on Apple silicon. A downloaded ad-hoc build is still stopped by
  Gatekeeper: use *System Settings → Privacy & Security → Open Anyway*, or, only for a build you trust,
  `xattr -dr com.apple.quarantine /Applications/AgentDuo.app`. A **Developer ID** build needs an Apple Developer
  certificate: `CSC_LINK` (the .p12, or base64) and `CSC_KEY_PASSWORD`, plus `CSC_NAME` or `AGENTDUO_MAC_IDENTITY` (the
  certificate's name, passed as `mac.identity`). **Notarization** needs `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
  `APPLE_TEAM_ID` (or `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) and `AGENTDUO_NOTARIZE=1 npm run
  package:mac` (or `npm run package:mac -- -c.mac.notarize=true`). Only a Developer ID build updates itself on macOS.
- **Windows**: unsigned by default, so SmartScreen warns on first run. Sign with a code-signing certificate
  (`CSC_LINK` / `WIN_CSC_LINK` and `CSC_KEY_PASSWORD`) or Azure Trusted Signing (`win.azureSignOptions`).
- **Linux**: packages are not signed. The `.deb` installs an AppArmor profile (`resources/apparmor-profile`) so
  Chromium's sandbox works on Ubuntu 24.04+, which restricts unprivileged user namespaces, and makes `chrome-sandbox`
  `root:root` mode `4755` where user namespaces are unavailable. An **AppImage** gets neither: on Ubuntu 24.04+ either
  install the `.deb`, add an AppArmor profile for the AppImage's path, or (less safe) allow unprivileged user namespaces
  (`sysctl kernel.apparmor_restrict_unprivileged_userns=0`). The app never turns its sandbox off by itself.

## Verification

What was actually run, on which OS and architecture, is recorded in [VERIFICATION.md](VERIFICATION.md). CI runs on all
three systems, but a system counts as verified only once a run there passed.
