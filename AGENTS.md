# AGENTS.md

This repo is a Python orchestrator (`.orchestrator/`) that drives Codex CLI as planner/reviewer and Claude Code CLI as plan critic/implementer. The design spec is `docs/codex_claude_multi_agent_plan.md`; user docs are in `README.md`.

## Orchestrated runs

A prompt that starts with `[orchestrator-role: <role>]` comes from the orchestrator. Its role, hard rules and output schema are authoritative for that turn and override everything below. In read-only roles the orchestrator hashes the working tree before and after the turn, so any write, even to a scratch file, sends the run to human review.

## Conventions

- Python 3.9, stdlib only. `orch/yamlish.py` and `orch/schema.py` stand in for PyYAML and jsonschema, so new code imports neither.
- Modules start with `from __future__ import annotations` and use `typing` generics (`List`, `Optional`), because 3.9 rejects `X | Y` at runtime.
- Tests: `python3 -m unittest discover -s tests`. When you change a workflow transition, add a scenario to `tests/test_workflow.py`. Those scenarios drive `tests/fake_agent.py` through real subprocesses, so command lines and output parsing are exercised end to end.

## Gotchas

- Agent output schemas (`.orchestrator/schemas/`) must stay OpenAI-strict: every property is listed in `required`, and `additionalProperties` is `false`. Express an optional field as a nullable type (`["string", "null"]`). `test_schemas_are_strict_mode_compatible` enforces this, because Codex `--output-schema` rejects anything else.
- CLI flags were verified against codex-cli 0.164 and Claude Code 2.1.31x. After a CLI upgrade, run `python3 .orchestrator/orchestrator.py --doctor --repo <git repo>`.
- `git add` fails when an `:(exclude)` pathspec names a path that is already git-ignored, so `Git._pathspec` drops ignored excludes. Test repos ignore `.orchestrator/runs/` by default, as real ones do.
