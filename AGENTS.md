# AGENTS.md

agentduo is a TypeScript CLI (`src/`, published to npm as `agentduo` with bins `agentduo` and `duo`). It is a channel between Codex CLI (planner and code reviewer) and Claude Code CLI (plan critic and implementer). The design is in `docs/superpowers/specs/2026-10-27-agentduo-channel-design.md`, which amends `2026-10-27-agentduo-npm-cli-design.md`. User docs are in `README.md`.

## Orchestrated runs

A prompt that starts with `[orchestrator-role: <role>]` comes from agentduo. Its role description and output schema are authoritative for that turn. For everything else, follow your own configuration and this file.

A prompt that starts with `[agentduo-conversation]` is a turn of the chat's three-way conversation (the user, Claude Code and Codex). It is not an orchestrated role: it has no schema, so answer in plain text, as the agent it names. When its second line is `[agentduo-discussion: <step>, round <n> of <max>]`, it is a turn of `/discuss`: the prompt says whether you answer, revise, review or synthesize the final answer (always Codex's step), and a review ends with its own `VERDICT: AGREE` or `VERDICT: REVISE` line.

## Conventions

- agentduo enforces nothing. It passes protocol flags only, plus the user's `args` and `role_args`. Unexpected changes become `warning` events, never blocks. Do not add permission flags, guards or rules to prompts; that belongs to each CLI's configuration.
- The workspace is the directory `duo` runs in. Every `Git` call runs there, so the pathspec `.` means "this workspace" and `:/` means "the whole repository".
- Node ≥ 22.12, ESM, TypeScript strict. Relative imports end in `.js`, including imports of `.ts`/`.tsx` files.
- Runtime dependencies are exactly `ink`, `react`, `commander`, `yaml` and `ajv`. Ask the user before adding another one.
- `duo` alone opens the chat (`src/chat.ts` drives runs, notes, Esc and slash commands; `src/ui/ink/ChatApp.tsx` draws it). The chat talks to its screen only through the `ChatUi` interface, so its tests use a fake one.
- Chat settings commands (`/mode`, `/claude …`, `/codex …`) mirror the CLIs' own commands and change only flags, through `src/core/settings.ts`. Each change edits `cfg.claude` / `cfg.codex` in place (the backends hold those objects) and must be idempotent, because the chat replays its changes on a resumed run.
- `src/core` and `src/agents` never import from `src/ui`. Everything that reaches the screen is an `EventBus` event (`src/events.ts`), and human decisions come back through the `Decider` interface.
- Tests: `npm test` (vitest). When you change a workflow transition, add a scenario to `test/workflow.test.ts`; those scenarios drive `test/fake-agent.mjs` through real subprocesses. When a CLI's stream format changes, refresh `test/fixtures/*.jsonl` from a real run, with personal paths replaced by `/repo`.

## Gotchas

- Agent output schemas (`schemas/`) must stay OpenAI-strict: every property is listed in `required`, and `additionalProperties` is `false`. Express an optional field as a nullable type. `test/schema.test.ts` enforces this, because Codex `--output-schema` rejects anything else.
- CLI flags and stream formats were verified against codex-cli 0.164 and Claude Code 2.1.31x. After a CLI upgrade, run `duo doctor` and the parser tests.
- `git add` fails when an `:(exclude)` pathspec names an already-ignored path, so `Git.pathspec` drops ignored excludes.
- Claude's stream reports each message's `usage` as the message starts, so its output tokens are far too low. The final token count comes from the result envelope's `usage`; the streamed count is only a fallback for attempts that never finished.
- Claude runs in host mode (`--input-format stream-json --permission-prompts host --permission-prompt-tool stdio`) only when the runner has a `PermissionDecider`, which the CLI passes only when someone can answer. Every other call keeps `--permission-prompts none`; without it a non-interactive run hangs on a prompt nobody answers. In host mode stdin stays open until the `result` event, and a `control_request` must always get a `control_response` (deny when in doubt).
- `/usage` reads Codex's limits from `codex app-server` (JSON-RPC lines on stdio: `initialize`, then `account/read` and `account/rateLimits/read`), because `codex exec "/status"` would send the words to the model. The app server exits as soon as its stdin closes, so `src/core/usage.ts` keeps stdin open (`holdStdin`) until both answers are in. `claude -p /usage` prints Claude Code's `/usage` without a model call.
- Codex's `--image` takes several values, so `--image a.png -` would read the prompt's `-` as one more image. Each image goes as its own `--image=<absolute path>` token.
- Claude takes images as base64 image blocks of a `--input-format stream-json` message. That input format is separate from host mode: without a `PermissionDecider` the call keeps `--permission-prompts none` and stdin closes after the message. `prompt.md` logs the text only, never the base64.
- Attached files (`src/core/attachments.ts`) are copied under the runs directory, which every snapshot excludes. A prompt lists them by path, and only `src/core/prompts.ts` writes that list.
- "Always allow" saves Claude's rule to `.claude/settings.local.json`, so `Git` excludes that file from every snapshot.
- Changing a tab's webview options (its `localResourceRoots`) reloads the page, which would lose pasted or dropped files it is still reading. So `ConversationPanel.allow` sends `prepareReload` and changes the options only after the page answers `readyToReload`. A hidden or loading page holds no files, so its options change at once.
