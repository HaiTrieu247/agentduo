# Sources

Where the website's facts come from, checked on 2026-10-31/2026-11-01 against the working tree at commit `77248f7`
(`0.8.1`) plus the uncommitted `website/` folder. When the product changes, re-read the sources of the pages it touches.
Private conversations, attachments, account e-mails and usage figures from the maintainer's machine were not used.

## Product behaviour (repository)

| Topic | Pages | Source files |
| --- | --- | --- |
| What AgentDuo is, roles, three interfaces | Home, About, docs/concepts | `README.md`, `docs/README.vi.md`, `AGENTS.md`, `docs/superpowers/specs/2026-10-27-agentduo-channel-design.md`, `src/core/config.ts` (`agents.*` defaults) |
| Workflow: plan, critique, finalize, implement, verify, review, rounds, decisions | docs/pipeline, docs/decisions-resume | `src/core/workflow*.ts`, `schemas/*.json`, `src/core/prompts.ts`, `test/workflow.test.ts` |
| Conversations, recipients, history, home folder | docs/conversations, learn/* | `src/chat.ts`, `src/ui/ink/ChatApp.tsx`, `extensions/vscode/README.md`, `apps/desktop/README.md` |
| `/discuss` | docs/discuss | `src/chat.ts`, `src/core/discussion*.ts`, `AGENTS.md` |
| Configuration files, override order, next-call/next-run, reset | docs/configuration, docs/config-reference | `src/core/config.ts`, `src/core/settings.ts`, `AGENTS.md` (Conventions) |
| Command gates (`gates`) and review policy (`quality_gates`) | docs/pipeline, docs/config-reference | `src/core/config.ts` (defaults and validation), `src/core/gates*.ts` |
| CLI commands, options, exit codes | docs/cli | `src/cli.ts`, `dist/cli.js --help` of the built CLI |
| Slash commands | docs/slash-commands | `src/chat.ts`, `src/core/settings.ts` |
| Permissions, protocol flags, host prompts, warnings | docs/permissions | `src/agents/*.ts`, `AGENTS.md` (Gotchas), `README.md` |
| Attachments | docs/attachments | `src/core/attachments.ts`, `src/core/prompts.ts`, `AGENTS.md` |
| Run files, logs, diagnostics | docs/data-diagnostics | `src/core/` run storage, `apps/desktop/README.md` (Diagnostics), `duo doctor` |
| Account & Usage | docs/accounts-usage | `src/core/usage.ts`, `apps/desktop/README.md`, `extensions/vscode/webview/account.ts` |
| Desktop updates | docs/desktop-updates, Download | `apps/desktop/src/main/updates.ts` (`updateMode`, `createUpdater`), `apps/desktop/electron-builder.yml`, `.github/workflows/release.yml` |
| Launcher PATH, Linux sandbox, Windows | troubleshooting | `apps/desktop/src/main/environment.ts`, `apps/desktop/resources/apparmor-profile`, `apps/desktop/README.md`, `apps/desktop/VERIFICATION.md` |
| Build from source, contributing | docs/contributing | `package.json`, `apps/desktop/package.json`, `extensions/vscode/package.json`, `AGENTS.md`, `LICENSE` (MIT) |
| Logos and icon | every page | `extensions/vscode/media/agentduo*.svg`, `apps/desktop/resources/icon.svg`, `icon.png` |

The tutorial project (`examples/first-task`) and every config example (`examples/config/*.yaml`) are run by
`test/examples.test.mjs`; the config examples are validated by the repository's own `duo doctor`.

CLI stream formats and flags are verified by the repository against codex-cli 0.164 and Claude Code 2.1.31x
(`AGENTS.md`); the site states only that, not wider compatibility.

## Release channels (network, 2026-11-01T17:20Z)

| Data | Source | Result |
| --- | --- | --- |
| Public GitHub Releases and assets | `https://api.github.com/repos/HaiTrieu247/agentduo/releases` | Two public releases: `v0.8.2` (published 2026-11-01T15:48:40Z, the latest) and `v0.8.1` (2026-10-31T15:41:04Z), 12 assets each. The `v0.8.0` release exists only as a draft and is not listed; a `compare/v0.8.0...` link in the notes does not make it a public release. |
| npm | `https://registry.npmjs.org/agentduo` | `0.8.2`, published 2026-11-01T15:45:04Z (history back to 0.1.0 in `data/channels.json`). |
| VS Code Marketplace | `https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery` (`HaiTrieuThinh.agentduo-vscode`) | `0.8.2`, published 2026-11-01T15:49:08Z. |
| Version in source | `package.json`, `apps/desktop/package.json`, `extensions/vscode/package.json` | `0.8.2`. |

Installers in v0.8.2: `AgentDuo-0.8.2-mac-arm64.dmg`, `AgentDuo-0.8.2-mac-x64.dmg`, `AgentDuo-0.8.2-win-x64.exe`,
`AgentDuo-0.8.2-linux-x86_64.AppImage`, `AgentDuo-0.8.2-linux-amd64.deb`. Not published: Windows arm64 and Linux
arm64. The Mac `.zip` files, `.blockmap` files and `latest*.yml` feeds are update files, not downloads.

## Signing (release run 41322755718)

From the log of `https://github.com/HaiTrieu247/agentduo/actions/runs/41322755718`, the v0.8.2 release (recorded in `data/signing.json`):

- macOS: `signing … identityName=- identityHash=none` (ad-hoc signature, no Developer ID) and
  `skipped macOS notarization reason=notarize options were set explicitly false`.
- Windows: `no code signing certificate configured, signing is skipped` for the app and the installer.
- Linux: electron-builder signs neither the AppImage nor the deb.

So Gatekeeper and SmartScreen warn on first launch; the site says how to open the app and promises nothing more.

## Updates: implemented vs. verified

Implemented (from `updates.ts`): development builds never check; profiles with `AGENTDUO_DESKTOP_USER_DATA` only read
`AGENTDUO_DESKTOP_UPDATE_CONFIG` and never install; an ad-hoc signed Mac copy only tells; a Developer ID Mac build,
the Windows NSIS installer and the AppImage download in the background and install on restart or quit; a `.deb` is
installed only with **Restart to update**, through `pkexec`. Verified: an ad-hoc signed macOS 0.8.0 copy found 0.8.1
and showed the notify-only message (maintainer, 2026-10-31). No installation of an update has been tested on any OS.

## Provider CLIs (external, linked, not copied)

- Claude Code: `https://code.claude.com/docs/en/overview`, setup `https://code.claude.com/docs/en/setup`.
- Codex CLI: `https://developers.openai.com/codex/cli/`.
- Node.js download: `https://nodejs.org/en/download`.

The pages link to these for installation and sign-in steps instead of copying commands that may change.

## Information architecture reference

`https://nodejs.org/en` and its Download, Learn, About and Docs pages were used only as a reference for how to
organise a product site with tutorials, reference docs and downloads. No text, logo, image or code was taken.
