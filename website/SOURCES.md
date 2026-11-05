# Sources

Where the website's facts come from, checked on 2026-10-31/2026-11-01 against the working tree at commit `77248f7`
(`0.8.1`) plus the uncommitted `website/` folder. When the product changes, re-read the sources of the pages it touches.
Private conversations, attachments, account e-mails and usage figures from the maintainer's machine were not used.

## Product behaviour (repository)

| Topic | Pages | Source files |
| --- | --- | --- |
| What AgentDuo is, roles, three interfaces | Home, About, docs/concepts | `README.md`, `docs/README.vi.md`, `AGENTS.md`, `docs/superpowers/specs/2026-10-27-agentduo-channel-design.md`, `packages/engine/src/config/config.ts` (`agents.*` defaults) |
| Workflow: plan, critique, finalize, implement, verify, review, rounds, decisions | docs/pipeline, docs/decisions-resume | `packages/engine/src/workflow/*.ts`, `packages/engine/schemas/*.json`, `packages/engine/src/workflow/prompts.ts`, `packages/engine/test/workflow/workflow.test.ts` |
| Conversations, recipients, history, home folder | docs/conversations, learn/* | `packages/engine/src/chat/chat.ts`, `apps/cli/src/ui/ink/ChatApp.tsx`, `apps/vscode/README.md`, `apps/desktop/README.md` |
| `/discuss` | docs/discuss | `packages/engine/src/chat/chat.ts`, `packages/engine/src/chat/discussion*.ts`, `AGENTS.md` |
| Configuration files, override order, next-call/next-run, reset | docs/configuration, docs/config-reference | `packages/engine/src/config/config.ts`, `packages/engine/src/config/settings.ts`, `AGENTS.md` (Conventions) |
| Command gates (`gates`) and review policy (`quality_gates`) | docs/pipeline, docs/config-reference | `packages/engine/src/config/config.ts` (defaults and validation), `packages/engine/src/quality/gates*.ts` |
| CLI commands, options, exit codes | docs/cli | `apps/cli/src/cli.ts`, `apps/cli/dist/cli.js --help` of the built CLI |
| Slash commands | docs/slash-commands | `packages/engine/src/chat/chat.ts`, `packages/engine/src/config/settings.ts` |
| Permissions, protocol flags, host prompts, warnings | docs/permissions | `packages/engine/src/agents/*.ts`, `AGENTS.md` (Gotchas), `README.md` |
| Attachments | docs/attachments | `packages/engine/src/inputs/attachments.ts`, `packages/engine/src/workflow/prompts.ts`, `AGENTS.md` |
| Run files, logs, diagnostics | docs/data-diagnostics | `packages/engine/src/workflow/state.ts` run storage, `apps/desktop/README.md` (Diagnostics), `duo doctor` |
| Account & Usage | docs/accounts-usage | `packages/engine/src/system/usage.ts`, `apps/desktop/README.md`, `packages/webview/src/account.ts` |
| Desktop updates | docs/desktop-updates, Download | `apps/desktop/src/main/updates.ts` (`updateMode`, `createUpdater`), `apps/desktop/electron-builder.yml`, `.github/workflows/release.yml` |
| Launcher PATH, Linux sandbox, Windows | troubleshooting | `apps/desktop/src/main/environment.ts`, `apps/desktop/resources/apparmor-profile`, `apps/desktop/README.md`, `apps/desktop/VERIFICATION.md` |
| Build from source, contributing | docs/contributing | `package.json`, `apps/cli/package.json`, `apps/desktop/package.json`, `apps/vscode/package.json`, `AGENTS.md`, `LICENSE` (MIT) |
| Logos and icon | every page | `apps/vscode/media/agentduo*.svg`, `apps/desktop/resources/icon.svg`, `icon.png` |

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
| Version in source | `package.json`, `apps/desktop/package.json`, `apps/vscode/package.json` | `0.8.2`. |

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
