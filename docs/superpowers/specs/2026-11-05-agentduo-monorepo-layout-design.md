# agentduo repository layout: apps and packages (npm workspaces)

Date: 2026-11-05. Status: implemented.

## Why

The engine lived in the CLI's `src/`, but the CLI, the VS Code extension and the desktop app all run it: the extension
imported it as `../../../src/…` and the desktop as `../../../../src/…`. The code the extension and the desktop share
(the worker, its protocol, a workspace's session, the chat's page) lived inside `extensions/vscode`, so the desktop
reached into the extension's folder. `src/core` held 32 files of about eight areas side by side, and `test/` held 56
files, the extension's among them. Nothing on the tree said what depended on what.

## Layout

```
apps/cli          the npm package agentduo (bin duo, agentduo): cli.ts, bin.ts, ui/ink, ui/plain
apps/vscode       the extension: host code (src/) and VS Code's two page entries (webview/)
apps/desktop      the Electron app (unchanged inside; outside the workspace)
packages/engine   @agentduo/engine: src/{agents,workflow,quality,chat,clarification,config,git,inputs,system},
                  events.ts, paths.ts, format.ts; schemas/; the shared test kit (test/helpers, fixtures, fake-agent.mjs)
packages/host     @agentduo/host: protocol, worker, workerClient, runtimeSession, workspaceSession, decisionBroker,
                  viewState (the chat's view model, which the hosts reduce too)
packages/webview  @agentduo/webview: the chat's page (render, dom, markdown, uploads, account, styles.css)
test/             checks of the layout itself (boundaries.test.ts)
```

File names stayed (kebab-case in the engine, camelCase in the apps), so history and blame follow the moves. A name
changed only where its new folder made part of it redundant: `clarification-broker.ts` → `clarification/broker.ts`,
`clarification-form.ts` → `clarification/form.ts`, `webview/state.ts` → `host/src/viewState.ts`,
`ui/format.ts` → `engine/src/format.ts` (the chat and the webview use it, so it was never the CLI's), and the
extension's tests lost their `vscode-` prefix in their new packages.

## Decisions

- **npm workspaces, packages consumed as source.** Each package's `exports` maps `./*` to `./src/*.ts` (and
  `./testing/*` to `./test/helpers/*.ts`), so `@agentduo/engine/workflow/state` resolves to the source in TypeScript,
  esbuild/tsup and Vitest alike. Nothing builds a package on its own, and there are no index files: a barrel would
  pull Node code into the browser bundles, which import single modules that are Node-free.
- **One direction**: engine ← host ← webview ← apps; the CLI uses the engine only (its tests also drive the host's
  worker). `test/boundaries.test.ts` checks every import, that nothing leaves its package by a relative path, that
  source never imports a test helper, and that each workspace package declares the `@agentduo/*` packages it imports.
- **The desktop stays outside the workspace**, with its own lockfile, so Electron and electron-builder never enter
  the root install. It finds `@agentduo/*` through the root's `node_modules` (install the root first, as before), and
  so does not declare them: `npm ci --prefix apps/desktop` would look for them on the registry.
- **The published CLI is unchanged.** `apps/cli/package.json` keeps the name, bins, `files` and the five runtime
  dependencies; `@agentduo/*` are devDependencies bundled by tsup (`noExternal`). The build copies the schemas beside
  `package.json`; `prepack` copies the repository's README (its links are relative to the repository root, so the
  package's `repository` names no directory), `docs/README.vi.md` and the licence. These copies are ignored by git.
  `npm run test:pack` checks the tarball as before; publish with `npm publish -w agentduo`.
- **`packageRoot()`** accepts `@agentduo/engine` as well as `agentduo`: from the engine's sources (the tests) the
  nearest package is the engine's, whose `schemas/` sits beside its `package.json`. Bundles still find the
  `agentduo` package.json their build writes (the CLI's, the extension's and the desktop's `runtime/`).
- **Versions**: the root's `package.json` is the source; `npm version` runs `scripts/sync-versions.mjs`, which sets
  every package's version and the lockfiles' entries for them. The release workflow checks the tag against the
  root, the CLI and the desktop.
- **Scripts keep their names** at the root (`typecheck`, `test`, `build`, `test:pack`, `*:vscode`), delegating to the
  workspace that owns them, so CI and habits carry over. The extension's scripts live in `apps/vscode/scripts`, the
  CLI's in `apps/cli/scripts`.
