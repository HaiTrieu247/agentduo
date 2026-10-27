# AGENTS.md

agentduo is a TypeScript CLI (`src/`, published to npm as `agentduo` with bins `agentduo` and `duo`). It drives Codex CLI as planner/reviewer and Claude Code CLI as plan critic/implementer. The design is in `docs/superpowers/specs/2026-10-27-agentduo-npm-cli-design.md`; user docs are in `README.md`.

## Orchestrated runs

A prompt that starts with `[orchestrator-role: <role>]` comes from agentduo. Its role, hard rules and output schema are authoritative for that turn and override everything below. In read-only roles agentduo hashes the working tree before and after the turn, so any write, even to a scratch file, stops the run for human review.

## Conventions

- Node ≥ 22.12, ESM, TypeScript strict. Relative imports end in `.js`, including imports of `.ts`/`.tsx` files.
- Runtime dependencies are exactly `ink`, `react`, `commander`, `yaml` and `ajv`. Ask the user before adding another one.
- `src/core` and `src/agents` never import from `src/ui`. Everything that reaches the screen is an `EventBus` event (`src/events.ts`), and human decisions come back through the `Decider` interface.
- Tests: `npm test` (vitest). When you change a workflow transition, add a scenario to `test/workflow.test.ts`; those scenarios drive `test/fake-agent.mjs` through real subprocesses. When a CLI's stream format changes, refresh `test/fixtures/*.jsonl` from a real run, with personal paths replaced by `/repo`.

## Gotchas

- Agent output schemas (`schemas/`) must stay OpenAI-strict: every property is listed in `required`, and `additionalProperties` is `false`. Express an optional field as a nullable type. `test/schema.test.ts` enforces this, because Codex `--output-schema` rejects anything else.
- CLI flags and stream formats were verified against codex-cli 0.164 and Claude Code 2.1.31x. After a CLI upgrade, run `duo doctor` and the parser tests.
- `git add` fails when an `:(exclude)` pathspec names an already-ignored path, so `Git.pathspec` drops ignored excludes. Test repos ignore `.agentduo/runs/`, as real ones do.
- Allowlisted Bash rules match per command, so chained commands (`a && b`) are denied. The implementer prompt says so; keep that sentence.
