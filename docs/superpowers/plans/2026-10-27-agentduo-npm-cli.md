# agentduo npm CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the copy-into-each-repo Python orchestrator with a globally installable TypeScript npm package (`agentduo`, bins `agentduo` and `duo`). The package has a live Ink terminal UI that shows, per step, what Codex or Claude is doing and what they send each other.

**Architecture:** `src/core/` ports the Python state machine 1:1 (config, run store, git snapshots, guards, gates, prompts, reports, workflow). It runs async and only *emits typed events* on an `EventBus`. `src/agents/` spawns the CLIs in streaming mode (`codex exec --json`, `claude -p --output-format stream-json --verbose`) and turns each stdout line into `Activity` events. `src/ui/` holds two renderers that subscribe to the bus: Ink for TTYs (scrollback `<Static>` step blocks, a live footer, and an interactive human-review prompt) and a plain line renderer for CI/pipes. Human decisions flow back through a `Decider` interface.

**Tech Stack:** Node ≥ 22.12, TypeScript 7 (strict, ESM), Ink 8 + React 19, commander 15, yaml 2, ajv 8, tsup 9 (build), vitest 5 + ink-testing-library 4 (tests).

**Spec:** [docs/superpowers/specs/2026-10-27-agentduo-npm-cli-design.md](../specs/2026-10-27-agentduo-npm-cli-design.md). Behavioral source of truth for the port: `.orchestrator/orch/*.py` and `tests/*.py` at commit `7559c70`.

## Global Constraints

- Runtime: `"engines": { "node": ">=22.12" }`. This deliberately updates the spec's "Node ≥ 20", because Node 20 reached EOL in April 2026 and Ink 8 and commander 15 require Node 22. Update spec §2 in Task 16.
- ESM only (`"type": "module"`). Relative imports always end in `.js` (also for `.ts`/`.tsx` sources).
- Runtime dependencies, exactly: `ink@^8.0.0`, `react@^19.3.1`, `commander@^15.0.0`, `yaml@^2.9.1`, `ajv@^8.20.0`. Adding another runtime dependency requires the user's approval.
- Dev dependencies: `typescript@^7.0.2`, `tsup@^9.0.0`, `vitest@^5.0.5`, `ink-testing-library@^4.0.0`, `@types/react@^19.3.0`, `@types/node@^26.6.5`.
- Package `agentduo`, version `0.1.0`, license MIT, bins `agentduo` and `duo` → `dist/cli.js`.
- Per-repo data lives in `<repo>/.agentduo/` (`config.yaml`, `runs/<run-id>/`). Snapshot refs are named `refs/agentduo/<run-id>/{base,impl-rN-pre,impl-rN}`.
- UI text and agent prompts are English.
- Never commit, push or `npm publish` on the user's behalf from product code. Agent permission flags are exactly spec §5.
- Exit codes: `0` DONE, `1` config/environment error, `2` waiting for HUMAN_REVIEW, `3` ABORTED, `130` stopped (`q` / Ctrl-C), resumable.
- Agent-output JSON (schemas, envelopes, artifact files) keeps the snake_case keys of the Python version. Internal TypeScript state uses camelCase.
- Work on branch `feat/agentduo`. Each task ends with a commit whose message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Repo path containing spaces** (and macOS `/private` tmp symlinks). Every git call, spawn and pathspec must still work. Pinned by `tempDir()` (Task 3), which always creates `…/agentduo test-XXXX/`, so every repo-touching test runs under a path with a space.
2. **Non-ASCII task text** (for example Vietnamese `Thêm đăng nhập JWT`). The run id slug must be ASCII and the prompt must keep the original text. Pinned in Task 9 (`slugify`) and Task 11 (an e2e scenario with a Vietnamese task).
3. **Config sections present but empty, or of the wrong type** (`codex:` with no body, `gates: npm test`). Empty sections keep the defaults; wrong types raise a `ConfigError` that names the file and key, never a crash. Pinned in Task 3.
4. **Stream lines split across chunks, CRLF, blank lines, non-JSON noise.** The parser must never throw and must not lose events. Pinned in Task 5 (line splitting) and Task 6 (parser noise).
5. **Narrow terminal / very long labels.** Lines are truncated, never wrapped into garbage. Pinned in Task 14 (render inside a 40-column box).

---

## File Structure

```text
package.json  tsconfig.json  tsup.config.ts  vitest.config.ts  LICENSE  .gitignore
schemas/{plan,plan_critique,plan_approval,implementation,review}.schema.json   (copied from .orchestrator/schemas)
src/
  bin.ts                  process entry: main(process.argv) → exitCode
  cli.ts                  commander program: run/resume/status/list/doctor/init, renderer selection
  paths.ts                packageRoot(), packageVersion()
  events.ts               DuoEvent union, Activity, Message, HistoryEntry, HumanReview, Decider, EventBus
  core/
    outputs.ts            TypeScript types of the five agent output schemas
    config.ts             defaults, YAML loading, layered merge, validation, permissionFor
    git.ts                Git class: snapshots via temp index, nameStatus, diff, isIgnored
    guards.ts             glob matching, checkChanges, checkGitPosition
    state.ts              RunState, RunStore (atomic writes, lock, LATEST), slugify, nowIso
    gates.ts              runGates, requiredPassed, describeGates
    prompts.ts            prompt builders per role (port of orch/prompts.py)
    render.ts             plan / critique / approval / findings / report markdown
    workflow.ts           Workflow: state machine, events, Decider, stop/interrupt
    init.ts               gate detection + `duo init`
    doctor.ts             environment checks
  agents/
    schema.ts             SCHEMA_NAMES, schemaPath, loadSchema, validateOutput (ajv), strictProblems
    types.ts              AgentBackend, StreamParser, AgentMeta, AgentFailure, extractJson, helpers
    process.ts            runProcess (streaming lines, timeout, abort, kill tree), killAllActive
    resolve.ts            resolveBinary (PATH, ~/.claude/local, IDE-bundled Claude)
    codex.ts              CodexBackend + CodexParser
    claude.ts             ClaudeBackend + ClaudeParser
    runner.ts             AgentRunner.call: attempts, retries, validation, logs, events
  ui/
    format.ts             shared labels/formatting (durations, cost, activity lines, pipeline)
    plain.ts              plain line renderer + deferDecider
    ink/store.ts          pure reducer: events → view state
    ink/StepBlock.tsx     static block per finished step
    ink/LiveFooter.tsx    live pipeline/spinner/activities/totals
    ink/HumanReviewPrompt.tsx  interactive menu + note input
    ink/App.tsx           wiring of the above
    ink/session.tsx       startInk(): mounts App, returns Decider + close()
test/
  fake-agent.mjs          scripted stand-in for both CLIs (stream output, file writes, shell, sleep)
  fixtures/codex-stream.jsonl  fixtures/claude-stream.jsonl
  helpers/{tmp,repo,builders,fake-clis,config}.ts
  *.test.ts(x)            one file per module + workflow e2e + cli + ui
scripts/pack-smoke.mjs  scripts/smoke-real.mjs
.github/workflows/ci.yml
README.md (English)  README.vi.md  AGENTS.md  CLAUDE.md (unchanged: @AGENTS.md)
```

`.orchestrator/` and `tests/*.py` remain until Task 16 deletes them.

---

### Task 1: Package scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `LICENSE`, `src/paths.ts`, `src/bin.ts` (temporary; replaced in Task 15), `test/paths.test.ts`, `schemas/*.json` (copied)
- Modify: `.gitignore`

**Interfaces:**
- Produces: `packageRoot(): string` and `packageVersion(): string` from `src/paths.js`.

- [ ] **Step 1: Create the branch and copy the schemas**

```bash
git checkout -b feat/agentduo
mkdir -p schemas && cp .orchestrator/schemas/*.schema.json schemas/
```

- [ ] **Step 2: Write the package files**

```json file=package.json
{
  "name": "agentduo",
  "version": "0.1.0",
  "description": "Two-agent development loop: Codex plans and reviews, Claude Code critiques and implements, with a live terminal UI.",
  "license": "MIT",
  "author": "Thinh Hai Trieu",
  "type": "module",
  "bin": {
    "agentduo": "dist/cli.js",
    "duo": "dist/cli.js"
  },
  "files": ["dist", "schemas", "README.md", "README.vi.md", "LICENSE"],
  "engines": { "node": ">=22.12" },
  "keywords": ["codex", "claude", "claude-code", "ai-agents", "multi-agent", "code-review", "cli"],
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc -p .",
    "test": "vitest run",
    "test:pack": "node scripts/pack-smoke.mjs",
    "smoke:real": "npm run build && node scripts/smoke-real.mjs",
    "prepublishOnly": "npm run typecheck && npm test && npm run build"
  },
  "dependencies": {
    "ajv": "^8.20.0",
    "commander": "^15.0.0",
    "ink": "^8.0.0",
    "react": "^19.3.1",
    "yaml": "^2.9.1"
  },
  "devDependencies": {
    "@types/node": "^26.6.5",
    "@types/react": "^19.3.0",
    "ink-testing-library": "^4.0.0",
    "tsup": "^9.0.0",
    "typescript": "^7.0.2",
    "vitest": "^5.0.5"
  }
}
```

```json file=tsconfig.json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

```ts file=tsup.config.ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/bin.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
```

```ts file=vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
```

```text file=LICENSE
MIT License

Copyright (c) 2026 Thinh Hai Trieu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

```text file=.gitignore
__pycache__/
*.pyc
.DS_Store
node_modules/
dist/
*.tgz
.agentduo/runs/
```

- [ ] **Step 3: Write the failing test**

```ts file=test/paths.test.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageRoot, packageVersion } from "../src/paths.js";

describe("paths", () => {
  it("finds the package root and version", () => {
    const root = packageRoot();
    expect(existsSync(join(root, "schemas", "plan.schema.json"))).toBe(true);
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
```

- [ ] **Step 4: Install and run the test to verify it fails**

Run: `npm install && npx vitest run test/paths.test.ts`
Expected: FAIL, "Failed to load url ../src/paths.js" (or "Cannot find module").

- [ ] **Step 5: Implement**

```ts file=src/paths.ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let root: string | undefined;

/** Directory of agentduo's own package.json; works from src/ (tests) and dist/ (installed). */
export function packageRoot(): string {
  if (root) return root;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg) && JSON.parse(readFileSync(pkg, "utf8")).name === "agentduo") return (root = dir);
    const parent = dirname(dir);
    if (parent === dir) throw new Error("agentduo package root not found");
    dir = parent;
  }
}

export function packageVersion(): string {
  return JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")).version;
}
```

```ts file=src/bin.ts
import { packageVersion } from "./paths.js";

process.stdout.write(`agentduo ${packageVersion()}\n`);
```

- [ ] **Step 6: Verify the test, typecheck and build**

Run: `npx vitest run test/paths.test.ts && npm run typecheck && npm run build && node dist/cli.js`
Expected: test PASS; typecheck prints nothing; build creates `dist/cli.js`; last command prints `agentduo 0.1.0`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsup.config.ts vitest.config.ts LICENSE .gitignore schemas src test
git commit -m "chore: scaffold agentduo TypeScript package

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Event model, output types, schema validation

**Files:**
- Create: `src/events.ts`, `src/core/outputs.ts`, `src/agents/schema.ts`, `test/helpers/builders.ts`, `test/schema.test.ts`

**Interfaces:**
- Produces (`src/events.ts`): types `Phase`, `Role`, `Party`, `Activity`, `Message`, `HistoryEntry`, `HumanReview`, `RoundInfo`, `DuoEvent`, `Decision`, `Decider`; class `EventBus { emit(e: DuoEvent): void; on(fn): () => void }`.
- Produces (`src/core/outputs.ts`): `Severity`, `Issue`, `Plan`, `Critique`, `Approval`, `Implementation`, `Finding`, `Review`.
- Produces (`src/agents/schema.ts`): `SCHEMA_NAMES`, `type SchemaName`, `schemaPath(name): string`, `loadSchema(name): Record<string, unknown>`, `validateOutput(name, data): string[]`, `strictProblems(schema, path?): string[]`.
- Produces (`test/helpers/builders.ts`): `plan()`, `issue()`, `critique()`, `approval()`, `impl()`, `finding()`, `review()`.

- [ ] **Step 1: Write the types (no behavior to test yet; typecheck covers them)**

```ts file=src/events.ts
import { EventEmitter } from "node:events";

export type Phase =
  | "PLAN" | "PLAN_REVIEW" | "PLAN_FINALIZE" | "IMPLEMENT" | "VERIFY" | "CODE_REVIEW"
  | "HUMAN_REVIEW" | "DONE" | "ABORTED";
export type Role = "planner" | "plan_reviewer" | "plan_finalizer" | "implementer" | "code_reviewer";
export type Party = "codex" | "claude" | "gates" | "human" | "orchestrator";

/** One thing an agent did, as seen in its output stream. Re-emitted with the same id when its status changes. */
export interface Activity {
  id: string;
  kind: "read" | "search" | "edit" | "command" | "say" | "think" | "submit" | "other";
  label: string;
  status: "running" | "ok" | "error" | "denied";
  exitCode?: number;
  added?: number;
  removed?: number;
}

/** What one party handed to another at the end of a step (relayed by the orchestrator). */
export interface Message {
  from: Party;
  to: Party;
  kind: "plan" | "critique" | "approval" | "implementation" | "gates" | "review" | "decision";
  headline: string;
  items: string[];
  artifact?: string;
}

export interface HistoryEntry {
  step: number;
  phase: Phase;
  round: number;
  agent: string;
  status: string;
  summary: string;
  kind: "info" | "ok" | "warn";
  at: string;
  artifact: string | null;
}

export interface HumanReview {
  reason: string;
  message: string;
  fromPhase: Phase;
  resumePhase: Phase;
  details: string[];
  at: string;
}

export interface RoundInfo {
  round: number;
  limit: number;
}

export type DuoEvent =
  | { type: "run.started"; runId: string; task: string; repo: string; runDir: string }
  | { type: "phase.started"; step: number; phase: Phase; round: number; role?: Role; agent?: Party; planning: RoundInfo; impl: RoundInfo }
  | { type: "agent.activity"; role: Role; agent: Party; activity: Activity }
  | { type: "agent.retry"; role: Role; agent: Party; attempt: number; max: number; reason: string }
  /** Running totals for the current agent call (all attempts so far). */
  | { type: "agent.usage"; agent: Party; costUsd?: number; tokens?: number }
  | { type: "gate.started"; name: string; command: string }
  | { type: "gate.completed"; name: string; command: string; passed: boolean; exitCode: number | null }
  | { type: "message"; message: Message }
  | { type: "step.completed"; entry: HistoryEntry; durationSec: number; costUsd?: number; tokens?: number }
  | { type: "warning"; text: string }
  | { type: "human.required"; runId: string; review: HumanReview }
  | { type: "run.finished"; runId: string; phase: "DONE" | "ABORTED" | "HUMAN_REVIEW" | "INTERRUPTED"; reportPath: string; exitCode: number };

export interface Decision {
  decision: "resume" | "revise" | "abort";
  note?: string;
}

export interface Decider {
  decide(review: HumanReview): Promise<Decision | "defer">;
}

export class EventBus {
  private readonly emitter = new EventEmitter();

  emit(event: DuoEvent): void {
    this.emitter.emit("event", event);
  }

  on(listener: (event: DuoEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }
}
```

```ts file=src/core/outputs.ts
/** Shapes of the agents' final JSON (see schemas/*.schema.json); keys stay snake_case. */
export type Severity = "critical" | "high" | "medium" | "low";
export type ReviewStatus = "approved" | "changes_requested";

export interface Issue {
  id: string;
  severity: Severity;
  description: string;
  suggestion: string;
}

export interface Plan {
  title: string;
  summary: string;
  goals: string[];
  scope_in: string[];
  scope_out: string[];
  architecture: string;
  steps: Array<{ id: string; description: string; files: string[] }>;
  acceptance_criteria: string[];
  risks: Array<{ risk: string; mitigation: string }>;
  test_strategy: string;
  open_questions: string[];
  feedback_resolution: Array<{ issue_id: string; decision: "accepted" | "partially_accepted" | "disputed"; rationale: string }>;
}

export interface Critique {
  status: ReviewStatus;
  approved: boolean;
  summary: string;
  issues: Issue[];
  accepted: string[];
  disputed: string[];
  proposed_changes: string[];
}

export interface Approval {
  status: ReviewStatus;
  approved: boolean;
  summary: string;
  issues: Issue[];
}

export interface Implementation {
  status: "completed" | "blocked";
  summary: string;
  files_changed: string[];
  tests_run: Array<{ command: string; passed: boolean; notes: string }>;
  addressed_findings: Array<{ finding_id: string; resolution: "fixed" | "disputed" | "not_applicable"; notes: string }>;
  blocking_reason: string | null;
}

export interface Finding {
  id: string;
  severity: Severity;
  file: string;
  line: number | null;
  issue: string;
  recommendation: string;
}

export interface Review {
  status: ReviewStatus;
  approved: boolean;
  reviewed_commit: string;
  summary: string;
  findings: Finding[];
  resolved_findings: string[];
}
```

```ts file=test/helpers/builders.ts
import type { Approval, Critique, Finding, Implementation, Issue, Plan, Review, Severity } from "../../src/core/outputs.js";

export function plan(title = "Demo plan", extra: Partial<Plan> = {}): Plan {
  return {
    title, summary: "Do the thing.", goals: ["make app.txt fixed"], scope_in: ["app.txt"],
    scope_out: ["everything else"], architecture: "single file",
    steps: [{ id: "S1", description: "write app.txt", files: ["app.txt"] }],
    acceptance_criteria: ["check.mjs exits 0"], risks: [{ risk: "none", mitigation: "n/a" }],
    test_strategy: "run check.mjs", open_questions: [], feedback_resolution: [], ...extra,
  };
}

export const issue = (id: string, severity: Severity = "high", description = "problem"): Issue =>
  ({ id, severity, description, suggestion: "fix it" });

export const critique = (approved: boolean, issues: Issue[] = []): Critique => ({
  status: approved ? "approved" : "changes_requested", approved, summary: "critique", issues,
  accepted: [], disputed: [], proposed_changes: [],
});

export const approval = (approved: boolean, issues: Issue[] = []): Approval =>
  ({ status: approved ? "approved" : "changes_requested", approved, summary: "final decision", issues });

export const impl = (status: Implementation["status"] = "completed", addressed: string[] = [],
  blockingReason: string | null = null): Implementation => ({
  status, summary: `implementation ${status}`, files_changed: ["app.txt"],
  tests_run: [{ command: "node check.mjs", passed: true, notes: "" }],
  addressed_findings: addressed.map((finding_id) => ({ finding_id, resolution: "fixed" as const, notes: "" })),
  blocking_reason: blockingReason,
});

export const finding = (id: string, severity: Severity = "high", file = "app.txt"): Finding =>
  ({ id, severity, file, line: 1, issue: "bad", recommendation: "fix" });

export const review = (approved: boolean, findings: Finding[] = [], resolved: string[] = [],
  commit = "$SNAPSHOT"): Review => ({
  status: approved ? "approved" : "changes_requested", approved, reviewed_commit: commit,
  summary: "review", findings, resolved_findings: resolved,
});
```

- [ ] **Step 2: Write the failing schema test**

```ts file=test/schema.test.ts
import { describe, expect, it } from "vitest";
import { loadSchema, SCHEMA_NAMES, strictProblems, validateOutput } from "../src/agents/schema.js";
import { approval, critique, finding, impl, issue, plan, review } from "./helpers/builders.js";

describe("schemas", () => {
  it("are compatible with OpenAI strict structured outputs", () => {
    for (const name of SCHEMA_NAMES) expect(strictProblems(loadSchema(name)), name).toEqual([]);
  });

  it("accept the builders' outputs", () => {
    const samples = {
      plan: plan(), plan_critique: critique(false, [issue("C1")]), plan_approval: approval(true),
      implementation: impl("completed", ["F1"]), review: review(false, [finding("F1")], [], "a".repeat(40)),
    } as const;
    for (const name of SCHEMA_NAMES) expect(validateOutput(name, samples[name]), name).toEqual([]);
  });

  it("report readable errors", () => {
    const bad: Record<string, unknown> = review(true, [{ ...finding("F1"), severity: "urgent" as never, line: "7" as never }], [], "x");
    bad.extra = 1;
    delete bad.summary;
    const errors = validateOutput("review", bad).join(" | ");
    expect(errors).toContain("$: missing required property 'summary'");
    expect(errors).toContain("$: unexpected property 'extra'");
    expect(errors).toContain("$.findings[0].severity: must be one of");
    expect(errors).toContain("$.findings[0].line: must be integer,null");
  });

  it("flags non-strict schemas", () => {
    const loose = { type: "object", properties: { a: { type: "string" } }, required: [] };
    expect(strictProblems(loose)).toEqual(["$: additionalProperties must be false", "$: required must list every property"]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/schema.test.ts`
Expected: FAIL, cannot resolve `../src/agents/schema.js`.

- [ ] **Step 4: Implement**

```ts file=src/agents/schema.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { packageRoot } from "../paths.js";

export const SCHEMA_NAMES = ["plan", "plan_critique", "plan_approval", "implementation", "review"] as const;
export type SchemaName = (typeof SCHEMA_NAMES)[number];

const ajv = new Ajv({ allErrors: true, strict: false });
const schemas = new Map<SchemaName, Record<string, unknown>>();
const validators = new Map<SchemaName, ValidateFunction>();

export function schemaPath(name: SchemaName): string {
  return join(packageRoot(), "schemas", `${name}.schema.json`);
}

export function loadSchema(name: SchemaName): Record<string, unknown> {
  let schema = schemas.get(name);
  if (!schema) {
    schema = JSON.parse(readFileSync(schemaPath(name), "utf8")) as Record<string, unknown>;
    schemas.set(name, schema);
  }
  return schema;
}

function pointerToPath(pointer: string): string {
  return "$" + pointer.split("/").slice(1).map((s) => (/^\d+$/.test(s) ? `[${s}]` : `.${s}`)).join("");
}

function formatError(e: ErrorObject): string {
  const where = pointerToPath(e.instancePath);
  if (e.keyword === "required") return `${where}: missing required property '${(e.params as { missingProperty: string }).missingProperty}'`;
  if (e.keyword === "additionalProperties") return `${where}: unexpected property '${(e.params as { additionalProperty: string }).additionalProperty}'`;
  if (e.keyword === "enum") return `${where}: must be one of ${JSON.stringify((e.params as { allowedValues: unknown[] }).allowedValues)}`;
  return `${where}: ${e.message}`;
}

/** Validate an agent's final JSON; returns human-readable errors (empty = valid). */
export function validateOutput(name: SchemaName, data: unknown): string[] {
  let validate = validators.get(name);
  if (!validate) {
    validate = ajv.compile(loadSchema(name));
    validators.set(name, validate);
  }
  return validate(data) ? [] : (validate.errors ?? []).map(formatError);
}

/** Constraints of OpenAI strict structured outputs (Codex --output-schema). */
export function strictProblems(schema: Record<string, unknown>, path = "$"): string[] {
  const problems: string[] = [];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("object")) {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    if (schema.additionalProperties !== false) problems.push(`${path}: additionalProperties must be false`);
    const required = [...((schema.required as string[]) ?? [])].sort();
    if (JSON.stringify(required) !== JSON.stringify(Object.keys(props).sort())) problems.push(`${path}: required must list every property`);
    for (const [key, sub] of Object.entries(props)) problems.push(...strictProblems(sub, `${path}.${key}`));
  }
  if (types.includes("array") && schema.items) problems.push(...strictProblems(schema.items as Record<string, unknown>, `${path}[]`));
  return problems;
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/schema.test.ts && npm run typecheck`
Expected: 4 tests PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/events.ts src/core/outputs.ts src/agents/schema.ts test/helpers/builders.ts test/schema.test.ts
git commit -m "feat: add event model, output types and ajv schema validation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Configuration

**Files:**
- Create: `src/core/config.ts`, `test/helpers/tmp.ts`, `test/config.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: types `Backend`, `AgentRole`, `Permission`, `GateConfig`, `ConfigData`, `LoadedConfig`; constants `AGENT_ROLES`, `READ_ONLY_ROLES`, `SEVERITIES`; `class ConfigError`; `defaultConfig(): ConfigData`; `userConfigPath(env?, platform?): string`; `loadConfig({ repo, configPath?, env?, platform?, validate? }): LoadedConfig`; `validateConfig(cfg, source?): void`; `permissionFor(cfg, role): Permission`.
- Produces (`test/helpers/tmp.ts`): `tempDir(): { path: string; cleanup(): void }`. Its path always contains a space.

- [ ] **Step 1: Write the temp-dir helper and the failing test**

```ts file=test/helpers/tmp.ts
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh directory whose path contains a space (Review Focus #1). */
export function tempDir(): { path: string; cleanup(): void } {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "agentduo test-")));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
```

```ts file=test/config.test.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, defaultConfig, loadConfig, permissionFor, userConfigPath } from "../src/core/config.js";
import { tempDir } from "./helpers/tmp.js";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (dirs.length) dirs.pop()!.cleanup();
});

function setup(repoYaml?: string, userYaml?: string) {
  const t = tempDir();
  dirs.push(t);
  const repo = join(t.path, "repo");
  const xdg = join(t.path, "xdg");
  mkdirSync(join(repo, ".agentduo"), { recursive: true });
  if (repoYaml !== undefined) writeFileSync(join(repo, ".agentduo", "config.yaml"), repoYaml);
  if (userYaml !== undefined) {
    mkdirSync(join(xdg, "agentduo"), { recursive: true });
    writeFileSync(join(xdg, "agentduo", "config.yaml"), userYaml);
  }
  return { repo, env: { XDG_CONFIG_HOME: xdg, HOME: t.path } as NodeJS.ProcessEnv };
}

const GATES = "gates:\n  - name: t\n    command: npm test\n";

describe("loadConfig", () => {
  it("layers defaults, user config and repo config", () => {
    const { repo, env } = setup(`${GATES}codex:\n  model: gpt-repo\n`, "codex:\n  model: gpt-user\nclaude:\n  model: opus\n");
    const { data, sources, warnings } = loadConfig({ repo, env });
    expect(data.codex.model).toBe("gpt-repo");
    expect(data.claude.model).toBe("opus");
    expect(data.limits.max_planning_rounds).toBe(4);
    expect(data.safety.protected_paths).toContain(".agentduo/**");
    expect(data.paths.runs_dir).toBe(".agentduo/runs");
    expect(sources).toHaveLength(2);
    expect(warnings).toEqual([]);
  });

  it("warns about unknown keys and names the file", () => {
    const { repo, env } = setup(`${GATES}limits:\n  max_planing_rounds: 3\n`);
    const { warnings } = loadConfig({ repo, env });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("config.yaml: unknown config key 'limits.max_planing_rounds' (ignored)");
  });

  it("keeps defaults when a section is present but empty", () => {
    const { repo, env } = setup(`${GATES}codex:\nclaude:\n`);
    const { data } = loadConfig({ repo, env });
    expect(data.codex.bin).toBe("codex");
    expect(data.claude.read_only_tools).toEqual(["Read", "Grep", "Glob"]);
  });

  it("rejects wrong types with a clear message", () => {
    const cases: Array<[string, string]> = [
      ["gates: npm test\n", "gates must be a list"],
      [`limits: 5\n${GATES}`, "'limits' must be a mapping"],
      ["- a\n- b\n", "top level must be a mapping"],
      ["a: [1\n", "config.yaml"],
      [`${GATES}safety:\n  protected_paths: .env\n`, "safety.protected_paths must be a list"],
    ];
    for (const [yaml, expected] of cases) {
      const { repo, env } = setup(yaml);
      expect(() => loadConfig({ repo, env }), yaml).toThrow(ConfigError);
      expect(() => loadConfig({ repo, env }), yaml).toThrow(expected);
    }
  });

  it("rejects unsafe settings", () => {
    const cases: Array<[string, string]> = [
      [`${GATES}agents:\n  implementer: codex\n`, "only agent allowed"],
      [`${GATES}permissions:\n  codex: workspace-write\n`, "must run read-only"],
      ["gates: []\n", "no required gate"],
      [`${GATES}limits:\n  max_review_rounds: 0\n`, "limits.max_review_rounds must be a positive integer"],
      [`${GATES}quality_gates:\n  blocking_severities: [urgent]\n`, "unknown severity 'urgent'"],
    ];
    for (const [yaml, expected] of cases) {
      const { repo, env } = setup(yaml);
      expect(() => loadConfig({ repo, env }), yaml).toThrow(expected);
    }
  });

  it("errors when --config points to a missing file", () => {
    const { repo, env } = setup();
    expect(() => loadConfig({ repo, env, configPath: join(repo, "missing.yaml") })).toThrow("config file not found");
  });

  it("can skip validation for read-only commands", () => {
    const { repo, env } = setup();
    expect(loadConfig({ repo, env, validate: false }).data.gates).toEqual([]);
    expect(() => loadConfig({ repo, env })).toThrow("no required gate");
  });
});

describe("permissions and paths", () => {
  it("maps roles to permissions", () => {
    const cfg = defaultConfig();
    expect(permissionFor(cfg, "planner")).toBe("read-only");
    expect(permissionFor(cfg, "plan_reviewer")).toBe("read-only");
    expect(permissionFor(cfg, "code_reviewer")).toBe("read-only");
    expect(permissionFor(cfg, "implementer")).toBe("workspace-write");
  });

  it("finds the user config file per platform", () => {
    expect(userConfigPath({ XDG_CONFIG_HOME: "/x" }, "linux")).toBe(join("/x", "agentduo", "config.yaml"));
    expect(userConfigPath({ HOME: "/h" }, "darwin")).toBe(join("/h", ".config", "agentduo", "config.yaml"));
    expect(userConfigPath({ APPDATA: "C:\\AppData" }, "win32")).toContain("agentduo");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL, cannot resolve `../src/core/config.js`.

- [ ] **Step 3: Implement**

```ts file=src/core/config.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";

export type Backend = "codex" | "claude";
export type AgentRole = "planner" | "plan_reviewer" | "implementer" | "code_reviewer";
export type Permission = "read-only" | "workspace-write";

export const AGENT_ROLES: AgentRole[] = ["planner", "plan_reviewer", "implementer", "code_reviewer"];
export const READ_ONLY_ROLES: AgentRole[] = ["planner", "plan_reviewer", "code_reviewer"];
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;

export interface GateConfig {
  name: string;
  command: string;
  required?: boolean;
  timeout_sec?: number;
}

/** agentduo's own config schema (not a Codex or Claude Code config). Keys match the YAML. */
export interface ConfigData {
  agents: Record<AgentRole, Backend>;
  limits: {
    max_planning_rounds: number;
    max_review_rounds: number;
    max_retries: number;
    max_consecutive_gate_failures: number;
    agent_timeout_sec: number;
    gate_timeout_sec: number;
    max_diff_chars: number;
    max_gate_output_chars: number;
  };
  permissions: { codex: Permission; claude_planning: Permission; claude_implementation: Permission };
  quality_gates: {
    require_plan_approval: boolean;
    require_tests_pass: boolean;
    require_codex_approval: boolean;
    stop_on_critical_issue: boolean;
    blocking_severities: string[];
    review_on_gate_failure: boolean;
  };
  gates: GateConfig[];
  safety: {
    allow_dirty_worktree: boolean;
    pause_before_implement: boolean;
    max_deleted_files: number;
    protected_paths: string[];
  };
  codex: { bin: string; model: string | null; extra_args: string[] };
  claude: {
    bin: string;
    model: string | null;
    max_budget_usd: number | null;
    extra_args: string[];
    read_only_tools: string[];
    implementation_tools: string[];
    implementation_allowed_tools: string[];
    implementation_disallowed_tools: string[];
  };
  paths: { runs_dir: string };
}

const DEFAULTS: ConfigData = {
  agents: { planner: "codex", plan_reviewer: "claude", implementer: "claude", code_reviewer: "codex" },
  limits: {
    max_planning_rounds: 4,
    max_review_rounds: 5,
    max_retries: 1,
    max_consecutive_gate_failures: 3,
    agent_timeout_sec: 1800,
    gate_timeout_sec: 900,
    max_diff_chars: 120000,
    max_gate_output_chars: 6000,
  },
  permissions: { codex: "read-only", claude_planning: "read-only", claude_implementation: "workspace-write" },
  quality_gates: {
    require_plan_approval: true,
    require_tests_pass: true,
    require_codex_approval: true,
    stop_on_critical_issue: true,
    blocking_severities: ["critical", "high"],
    review_on_gate_failure: false,
  },
  gates: [],
  safety: {
    allow_dirty_worktree: false,
    pause_before_implement: false,
    max_deleted_files: 5,
    protected_paths: [".agentduo/**", ".git/**", ".env", ".env.*", "**/*.pem", "**/*.key", "**/secrets/**", ".github/workflows/**"],
  },
  codex: { bin: "codex", model: null, extra_args: ["--ephemeral"] },
  claude: {
    bin: "claude",
    model: null,
    max_budget_usd: null,
    extra_args: ["--strict-mcp-config", "--no-session-persistence"],
    read_only_tools: ["Read", "Grep", "Glob"],
    implementation_tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
    implementation_allowed_tools: [
      "Read", "Grep", "Glob", "Edit", "Write",
      "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git show*)",
      "Bash(ls*)", "Bash(cat*)", "Bash(pwd)",
    ],
    implementation_disallowed_tools: [
      "Bash(git push*)", "Bash(git commit*)", "Bash(git reset*)", "Bash(git checkout*)",
      "Bash(git switch*)", "Bash(git rebase*)", "Bash(git merge*)", "Bash(git clean*)",
      "Bash(git stash*)", "Bash(git tag*)", "Bash(git branch*)", "Bash(git update-ref*)",
      "Bash(rm -rf*)", "Bash(rm -fr*)", "Bash(sudo*)", "Bash(curl*)", "Bash(wget*)",
      "WebFetch", "WebSearch",
    ],
  },
  paths: { runs_dir: ".agentduo/runs" },
};

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface LoadedConfig {
  data: ConfigData;
  sources: string[];
  warnings: string[];
}

export function defaultConfig(): ConfigData {
  return structuredClone(DEFAULTS);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function mergeInto(base: Record<string, unknown>, override: Record<string, unknown>, where: string,
  warnings: string[]): Record<string, unknown> {
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    const path = where ? `${where}.${key}` : key;
    if (!(key in base)) {
      warnings.push(`unknown config key '${path}' (ignored)`);
      continue;
    }
    const current = base[key];
    if (isPlainObject(current)) {
      if (value === null || value === undefined) continue; // "codex:" with no body keeps the defaults
      if (!isPlainObject(value)) throw new ConfigError(`'${path}' must be a mapping`);
      out[key] = mergeInto(current, value, path, warnings);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32" && env.APPDATA) return join(env.APPDATA, "agentduo", "config.yaml");
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "agentduo", "config.yaml");
}

function readYaml(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = YAML.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`${path}: ${(err as Error).message}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isPlainObject(parsed)) throw new ConfigError(`${path}: top level must be a mapping`);
  return parsed;
}

export function loadConfig(opts: { repo: string; configPath?: string; env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform; validate?: boolean }): LoadedConfig {
  const warnings: string[] = [];
  const sources: string[] = [];
  let data = defaultConfig() as unknown as Record<string, unknown>;
  const repoPath = opts.configPath ? resolve(opts.configPath) : join(opts.repo, ".agentduo", "config.yaml");
  if (opts.configPath && !existsSync(repoPath)) throw new ConfigError(`config file not found: ${repoPath}`);
  const userPath = userConfigPath(opts.env ?? process.env, opts.platform ?? process.platform);
  for (const path of userPath === repoPath ? [repoPath] : [userPath, repoPath]) {
    if (!existsSync(path)) continue;
    const fileWarnings: string[] = [];
    try {
      data = mergeInto(data, readYaml(path), "", fileWarnings);
    } catch (err) {
      if (err instanceof ConfigError && !err.message.startsWith(path)) throw new ConfigError(`${path}: ${err.message}`);
      throw err;
    }
    warnings.push(...fileWarnings.map((w) => `${path}: ${w}`));
    sources.push(path);
  }
  const cfg = data as unknown as ConfigData;
  if (opts.validate !== false) validateConfig(cfg, sources.at(-1));
  return { data: cfg, sources, warnings };
}

export function permissionFor(cfg: ConfigData, role: AgentRole): Permission {
  if (cfg.agents[role] === "codex") return cfg.permissions.codex;
  return READ_ONLY_ROLES.includes(role) ? cfg.permissions.claude_planning : cfg.permissions.claude_implementation;
}

const isPosInt = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 1;
const isNonNegInt = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0;

export function validateConfig(cfg: ConfigData, source?: string): void {
  const errors: string[] = [];
  for (const role of AGENT_ROLES) {
    if (cfg.agents[role] !== "codex" && cfg.agents[role] !== "claude") errors.push(`agents.${role} must be one of codex, claude`);
  }
  if (cfg.agents.implementer !== "claude") {
    errors.push("agents.implementer must be 'claude' (Claude is the only agent allowed to modify source code)");
  }
  if (!errors.length) {
    for (const role of READ_ONLY_ROLES) {
      if (permissionFor(cfg, role) !== "read-only") errors.push(`role '${role}' must run read-only (check permissions.*)`);
    }
    if (permissionFor(cfg, "implementer") !== "workspace-write") errors.push("permissions for the implementer must be 'workspace-write'");
  }
  for (const key of ["max_planning_rounds", "max_review_rounds", "max_consecutive_gate_failures", "agent_timeout_sec",
    "gate_timeout_sec", "max_diff_chars", "max_gate_output_chars"] as const) {
    if (!isPosInt(cfg.limits[key])) errors.push(`limits.${key} must be a positive integer`);
  }
  if (!isNonNegInt(cfg.limits.max_retries)) errors.push("limits.max_retries must be an integer >= 0");
  if (!Array.isArray(cfg.quality_gates.blocking_severities)) {
    errors.push("quality_gates.blocking_severities must be a list");
  } else {
    for (const s of cfg.quality_gates.blocking_severities) {
      if (!(SEVERITIES as readonly string[]).includes(s)) errors.push(`quality_gates.blocking_severities: unknown severity '${s}'`);
    }
  }
  if (!Array.isArray(cfg.gates)) {
    errors.push("gates must be a list");
  } else {
    const names = new Set<string>();
    cfg.gates.forEach((gate, i) => {
      const g = gate as unknown;
      if (!isPlainObject(g) || typeof g.name !== "string" || !g.name || typeof g.command !== "string" || !g.command) {
        errors.push(`gates[${i}] needs 'name' and 'command'`);
        return;
      }
      if (names.has(g.name)) errors.push(`gates[${i}]: duplicate name '${g.name}'`);
      names.add(g.name);
      const unknown = Object.keys(g).filter((k) => !["name", "command", "required", "timeout_sec"].includes(k));
      if (unknown.length) errors.push(`gates[${i}]: unknown keys ${unknown.sort().join(", ")}`);
      if (g.required !== undefined && typeof g.required !== "boolean") errors.push(`gates[${i}].required must be true or false`);
      if (g.timeout_sec !== undefined && !isPosInt(g.timeout_sec)) errors.push(`gates[${i}].timeout_sec must be a positive integer`);
    });
    if (cfg.quality_gates.require_tests_pass && !cfg.gates.some((g) => isPlainObject(g) && g.required !== false)) {
      errors.push("quality_gates.require_tests_pass is true but no required gate is configured under 'gates' (run 'duo init')");
    }
  }
  if (!Array.isArray(cfg.safety.protected_paths)) errors.push("safety.protected_paths must be a list");
  if (!isNonNegInt(cfg.safety.max_deleted_files)) errors.push("safety.max_deleted_files must be an integer >= 0");
  const lists: Array<[string, unknown]> = [
    ["codex.extra_args", cfg.codex.extra_args], ["claude.extra_args", cfg.claude.extra_args],
    ["claude.read_only_tools", cfg.claude.read_only_tools], ["claude.implementation_tools", cfg.claude.implementation_tools],
    ["claude.implementation_allowed_tools", cfg.claude.implementation_allowed_tools],
    ["claude.implementation_disallowed_tools", cfg.claude.implementation_disallowed_tools],
  ];
  for (const [name, value] of lists) if (!Array.isArray(value)) errors.push(`${name} must be a list`);
  if (typeof cfg.paths.runs_dir !== "string" || !cfg.paths.runs_dir) errors.push("paths.runs_dir must be a non-empty string");
  if (errors.length) {
    throw new ConfigError(`invalid configuration${source ? ` (${source})` : ""}:\n  - ${errors.join("\n  - ")}`);
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/config.test.ts && npm run typecheck`
Expected: 9 tests PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts test/helpers/tmp.ts test/config.test.ts
git commit -m "feat: add layered YAML configuration with validation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Git snapshots and guards

**Files:**
- Create: `src/core/git.ts`, `src/core/guards.ts`, `test/helpers/repo.ts`, `test/git.test.ts`, `test/guards.test.ts`

**Interfaces:**
- Produces (`src/core/git.ts`): `class GitError`; `interface Snapshot { commit: string; tree: string }`; `type Change = [status: string, path: string]`; `class Git` with async methods `run(args, {env?, check?})`, `isRepo()`, `toplevel()`, `head()`, `branch()`, `position(): Promise<[string|null, string|null]>`, `isIgnored(path)`, `statusPorcelain(exclude?)`, `worktreeTree(exclude?)`, `snapshot(exclude?, ref?, message?)`, `nameStatus(a, b): Promise<Change[]>`, `diff(a, b)`, `diffStat(a, b)`.
- Produces (`src/core/guards.ts`): `globToRegExp(glob): RegExp`, `matchProtected(path, patterns): string | null`, `checkChanges(changes, protected, maxDeleted): string[]`, `checkGitPosition(before, after): string[]`.
- Produces (`test/helpers/repo.ts`): `git(repo, ...args): string`, `makeRepo(parent, { ignoreRuns? }): string`. `makeRepo` creates the repo at `<parent>/repo` with `README.md`, a `.gitignore` containing `.agentduo/runs/` (unless `ignoreRuns: false`) and `check.mjs` (exits 0 only when `app.txt` contains "fixed"), then commits everything once.

- [ ] **Step 1: Write the repo helper and the failing tests**

```ts file=test/helpers/repo.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

/** Gate script used by e2e tests: passes once app.txt says "fixed". */
export const CHECK_SCRIPT = `import { existsSync, readFileSync } from "node:fs";
const ok = existsSync("app.txt") && readFileSync("app.txt", "utf8").includes("fixed");
console.log(ok ? "check ok" : "check failed: app.txt is not fixed");
process.exit(ok ? 0 : 1);
`;

export function makeRepo(parent: string, opts: { ignoreRuns?: boolean } = {}): string {
  const repo = join(parent, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "demo\n");
  if (opts.ignoreRuns !== false) writeFileSync(join(repo, ".gitignore"), ".agentduo/runs/\n");
  writeFileSync(join(repo, "check.mjs"), CHECK_SCRIPT);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}
```

```ts file=test/git.test.ts
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Git } from "../src/core/git.js";
import { git, makeRepo } from "./helpers/repo.js";
import { tempDir } from "./helpers/tmp.js";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (dirs.length) dirs.pop()!.cleanup();
});
function newRepo(ignoreRuns = true) {
  const t = tempDir();
  dirs.push(t);
  return { tmp: t.path, repo: makeRepo(t.path, { ignoreRuns }) };
}
const EXCLUDE = [".agentduo/runs"];

describe("Git", () => {
  for (const ignoreRuns of [true, false]) {
    it(`snapshots the whole worktree without touching index or HEAD (runs ignored: ${ignoreRuns})`, async () => {
      const { repo } = newRepo(ignoreRuns);
      const g = new Git(repo);
      const head = await g.head();
      const index = readFileSync(join(repo, ".git", "index"));
      const base = await g.snapshot(EXCLUDE);
      writeFileSync(join(repo, "new.txt"), "n\n");
      rmSync(join(repo, "README.md"));
      mkdirSync(join(repo, ".agentduo", "runs"), { recursive: true });
      writeFileSync(join(repo, ".agentduo", "runs", "log.txt"), "excluded\n");
      const snap = await g.snapshot(EXCLUDE, "refs/agentduo/t/r1");
      expect((await g.nameStatus(base.tree, snap.tree)).sort()).toEqual([["A", "new.txt"], ["D", "README.md"]]);
      expect(await g.worktreeTree(EXCLUDE)).toBe(snap.tree);
      expect(await g.head()).toBe(head);
      expect(readFileSync(join(repo, ".git", "index")).equals(index)).toBe(true);
      expect(git(repo, "rev-parse", "refs/agentduo/t/r1")).toBe(snap.commit);
      expect(await g.statusPorcelain(EXCLUDE)).toContain("?? new.txt");
      expect(await g.diffStat(base.commit, snap.commit)).toContain("new.txt");
      expect(await g.diff(base.commit, snap.commit)).toContain("+n");
    });
  }

  it("reports non-ASCII paths unquoted", async () => {
    const { repo } = newRepo();
    const g = new Git(repo);
    const before = await g.worktreeTree();
    writeFileSync(join(repo, "tệp.txt"), "x\n");
    expect(await g.nameStatus(before, await g.worktreeTree())).toEqual([["A", "tệp.txt"]]);
  });

  it("knows HEAD, branch and whether a path is a repo or ignored", async () => {
    const { tmp, repo } = newRepo();
    const g = new Git(repo);
    expect(await g.isRepo()).toBe(true);
    expect(await g.toplevel()).toBe(repo);
    expect(await g.position()).toEqual([git(repo, "rev-parse", "HEAD"), "main"]);
    expect(await g.isIgnored(".agentduo/runs")).toBe(true);
    expect(await g.isIgnored("src")).toBe(false);
    expect(await new Git(tmp).isRepo()).toBe(false);
    expect(await new Git(join(tmp, "missing")).isRepo()).toBe(false);
  });
});
```

```ts file=test/guards.test.ts
import { describe, expect, it } from "vitest";
import { checkChanges, checkGitPosition, matchProtected } from "../src/core/guards.js";

describe("guards", () => {
  it("matches protected globs like the Python version", () => {
    const patterns = [".agentduo/**", ".env", ".env.*", "**/*.pem", "**/secrets/**"];
    for (const path of [".agentduo/config.yaml", ".env", ".env.local", "key.pem", "a/b/key.pem", "secrets/x", "app/secrets/y.txt"]) {
      expect(matchProtected(path, patterns), path).not.toBeNull();
    }
    for (const path of ["src/env.ts", "README.md", "pem.txt", "src/.envrc.md", "agentduo/x"]) {
      expect(matchProtected(path, patterns), path).toBeNull();
    }
  });

  it("checks protected paths and mass deletion", () => {
    const changes: Array<[string, string]> = [["M", "src/a.ts"], ["A", ".env"], ["D", "f0"], ["D", "f1"], ["D", "f2"]];
    const violations = checkChanges(changes, [".env"], 2);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain("modified protected path '.env' (A, rule '.env')");
    expect(violations[1]).toContain("deleted 3 files (limit 2)");
    expect(checkChanges(changes.slice(0, 1), [".env"], 2)).toEqual([]);
  });

  it("detects HEAD and branch moves", () => {
    expect(checkGitPosition(["a", "main"], ["a", "main"])).toEqual([]);
    const v = checkGitPosition(["a", "main"], ["b", "other"]);
    expect(v[0]).toContain("HEAD moved from a to b");
    expect(v[1]).toContain("branch changed from main to other");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/git.test.ts test/guards.test.ts`
Expected: FAIL, cannot resolve `../src/core/git.js` / `guards.js`.

- [ ] **Step 3: Implement**

```ts file=src/core/git.ts
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class GitError extends Error {
  override name = "GitError";
}

export interface Snapshot {
  commit: string;
  tree: string;
}

export type Change = [status: string, path: string];

const IDENTITY = {
  GIT_AUTHOR_NAME: "agentduo", GIT_AUTHOR_EMAIL: "agentduo@localhost",
  GIT_COMMITTER_NAME: "agentduo", GIT_COMMITTER_EMAIL: "agentduo@localhost",
};

/**
 * Git helpers. Snapshots stage the whole working tree (tracked + untracked, honouring .gitignore) into a
 * temporary index and write an unreferenced commit, so the user's index, HEAD and branches are never touched.
 */
export class Git {
  constructor(readonly repo: string) {}

  run(args: string[], opts: { env?: Record<string, string>; check?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      execFile("git", args, { cwd: this.repo, env: { ...process.env, ...opts.env }, maxBuffer: 512 * 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (error && typeof error.code === "string") {
            reject(new GitError(`cannot run git in ${this.repo}: ${error.message}`));
            return;
          }
          const code = error ? Number(error.code ?? 1) : 0;
          if (opts.check !== false && code !== 0) {
            reject(new GitError(`git ${args.join(" ")} failed: ${(stderr || stdout).trim()}`));
            return;
          }
          resolvePromise({ code, stdout, stderr });
        });
    });
  }

  async isRepo(): Promise<boolean> {
    try {
      return (await this.run(["rev-parse", "--is-inside-work-tree"], { check: false })).stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  async toplevel(): Promise<string> {
    return (await this.run(["rev-parse", "--show-toplevel"])).stdout.trim();
  }

  async head(): Promise<string | null> {
    return (await this.run(["rev-parse", "--verify", "-q", "HEAD"], { check: false })).stdout.trim() || null;
  }

  async branch(): Promise<string | null> {
    return (await this.run(["symbolic-ref", "-q", "--short", "HEAD"], { check: false })).stdout.trim() || null;
  }

  async position(): Promise<[string | null, string | null]> {
    return [await this.head(), await this.branch()];
  }

  async isIgnored(path: string): Promise<boolean> {
    for (const candidate of [path, `${path.replace(/\/+$/, "")}/probe`]) {
      if ((await this.run(["check-ignore", "-q", candidate], { check: false })).code === 0) return true;
    }
    return false;
  }

  /** `git add` fails when an exclude pathspec names an already-ignored path, and ignored paths are skipped anyway. */
  private async pathspec(exclude: string[]): Promise<string[]> {
    const kept: string[] = [];
    for (const p of exclude) if (!(await this.isIgnored(p))) kept.push(`:(exclude)${p}`);
    return ["--", ".", ...kept];
  }

  async statusPorcelain(exclude: string[] = []): Promise<string[]> {
    const out = await this.run(["-c", "core.quotePath=false", "status", "--porcelain", "--untracked-files=all", ...(await this.pathspec(exclude))]);
    return out.stdout.split("\n").filter((line) => line.trim());
  }

  async worktreeTree(exclude: string[] = []): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "agentduo-index-"));
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    try {
      const head = await this.head();
      if (head) await this.run(["read-tree", head], { env });
      await this.run(["add", "-A", ...(await this.pathspec(exclude))], { env });
      return (await this.run(["write-tree"], { env })).stdout.trim();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async snapshot(exclude: string[] = [], ref?: string, message = "agentduo snapshot"): Promise<Snapshot> {
    const tree = await this.worktreeTree(exclude);
    const head = await this.head();
    const commit = (await this.run(["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", message], { env: IDENTITY })).stdout.trim();
    if (ref) await this.run(["update-ref", ref, commit]);
    return { commit, tree };
  }

  async nameStatus(a: string, b: string): Promise<Change[]> {
    const out = (await this.run(["-c", "core.quotePath=false", "diff", "--no-renames", "--name-status", a, b])).stdout;
    return out.split("\n").filter((line) => line.trim()).map((line) => {
      const [status, ...rest] = line.split("\t");
      return [status!.trim(), rest.join("\t").trim()] as Change;
    });
  }

  async diff(a: string, b: string): Promise<string> {
    return (await this.run(["diff", "--no-color", a, b])).stdout;
  }

  async diffStat(a: string, b: string): Promise<string> {
    return (await this.run(["diff", "--no-color", "--stat", a, b])).stdout;
  }
}
```

```ts file=src/core/guards.ts
import type { Change } from "./git.js";

// Glob to RegExp: "*" stays inside a segment, "**/" matches zero or more directories,
// and a trailing "/**" matches everything below.
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const atSegmentStart = i === 0 || glob[i - 1] === "/";
        const next = glob[i + 2];
        if (atSegmentStart && next === "/") {
          re += "(?:.*/)?";
          i += 2;
          continue;
        }
        if (atSegmentStart && next === undefined && re.endsWith("/")) {
          re = re.slice(0, -1) + "(?:/.*)?";
          i += 1;
          continue;
        }
        re += ".*";
        i += 1;
        continue;
      }
      re += "[^/]*";
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      continue;
    }
    re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchProtected(path: string, patterns: Iterable<string>): string | null {
  for (const pattern of patterns) if (globToRegExp(pattern).test(path)) return pattern;
  return null;
}

export function checkChanges(changes: Change[], protectedPaths: Iterable<string>, maxDeleted: number): string[] {
  const patterns = [...protectedPaths];
  const violations: string[] = [];
  for (const [status, path] of changes) {
    const rule = matchProtected(path, patterns);
    if (rule) violations.push(`modified protected path '${path}' (${status}, rule '${rule}')`);
  }
  const deleted = changes.filter(([status]) => status.startsWith("D")).map(([, path]) => path);
  if (deleted.length > maxDeleted) {
    violations.push(`deleted ${deleted.length} files (limit ${maxDeleted}): ${deleted.slice(0, 10).join(", ")}${deleted.length > 10 ? " ..." : ""}`);
  }
  return violations;
}

/** before/after are [HEAD sha, branch name]. */
export function checkGitPosition(before: [string | null, string | null], after: [string | null, string | null]): string[] {
  const violations: string[] = [];
  if (before[0] !== after[0]) violations.push(`HEAD moved from ${before[0]} to ${after[0]} (agents must not commit or reset)`);
  if (before[1] !== after[1]) violations.push(`branch changed from ${before[1]} to ${after[1]}`);
  return violations;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/git.test.ts test/guards.test.ts && npm run typecheck`
Expected: 7 tests PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/git.ts src/core/guards.ts test/helpers/repo.ts test/git.test.ts test/guards.test.ts
git commit -m "feat: add git working-tree snapshots and safety guards

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Process runner (streaming, timeouts, kill tree)

**Files:**
- Create: `src/agents/process.ts`, `test/process.test.ts`

**Interfaces:**
- Produces: `interface RunOptions { cwd; input?; timeoutMs; onStdoutLine?; signal?; env?; shell?; killGraceMs? }`, `interface RunResult { code: number | null; stdout; stderr; timedOut; aborted }`, `runProcess(cmd, args, opts): Promise<RunResult>` (rejects only when the process cannot start), `killTree(child, graceMs?)`, `killAllActive()`.

- [ ] **Step 1: Write the failing test**

```ts file=test/process.test.ts
import { describe, expect, it } from "vitest";
import { runProcess } from "../src/agents/process.js";

const node = process.execPath;
const cwd = process.cwd();

describe("runProcess", () => {
  it("passes stdin and collects stdout, stderr and the exit code", async () => {
    const r = await runProcess(node, ["-e", "process.stdin.pipe(process.stdout); process.stderr.write('warn'); process.stdin.on('end', () => { process.exitCode = 3; })"],
      { cwd, input: "hello", timeoutMs: 10_000 });
    expect(r).toMatchObject({ code: 3, stdout: "hello", stderr: "warn", timedOut: false, aborted: false });
  });

  it("splits stdout into lines across chunks, CRLF and blank lines", async () => {
    const lines: string[] = [];
    await runProcess(node, ["-e", "process.stdout.write('one\\r\\ntw'); setTimeout(() => process.stdout.write('o\\n\\nthree'), 50)"],
      { cwd, timeoutMs: 10_000, onStdoutLine: (l) => lines.push(l) });
    expect(lines).toEqual(["one", "two", "three"]);
  });

  it.skipIf(process.platform === "win32")("kills the whole process tree on timeout", async () => {
    const code = "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000);";
    const r = await runProcess(node, ["-e", code], { cwd, timeoutMs: 500, killGraceMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
    const grandchild = Number(r.stdout.trim());
    await new Promise((res) => setTimeout(res, 500));
    expect(() => process.kill(grandchild, 0)).toThrow();
  });

  it("stops when the abort signal fires", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const r = await runProcess(node, ["-e", "setInterval(() => {}, 1000)"], { cwd, timeoutMs: 10_000, signal: controller.signal, killGraceMs: 200 });
    expect(r.aborted).toBe(true);
    expect(r.code).toBeNull();
  });

  it("rejects when the binary does not exist", async () => {
    await expect(runProcess("/nonexistent/agentduo-bin", [], { cwd, timeoutMs: 1000 })).rejects.toThrow(/ENOENT/);
  });

  it("runs shell commands", async () => {
    const r = await runProcess("echo hi && exit 4", [], { cwd, timeoutMs: 10_000, shell: true });
    expect(r.code).toBe(4);
    expect(r.stdout.trim()).toBe("hi");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/process.test.ts`
Expected: FAIL, cannot resolve `../src/agents/process.js`.

- [ ] **Step 3: Implement**

```ts file=src/agents/process.ts
import { spawn, type ChildProcess } from "node:child_process";

export interface RunOptions {
  cwd: string;
  input?: string;
  timeoutMs: number;
  onStdoutLine?: (line: string) => void;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  killGraceMs?: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

const isWindows = process.platform === "win32";
const active = new Set<ChildProcess>();

/** Kill every child started by runProcess (used on a second Ctrl-C). */
export function killAllActive(): void {
  for (const child of active) killTree(child, 0);
}

/** SIGTERM the child's process group, then SIGKILL it after graceMs. On Windows: taskkill /T /F. */
export function killTree(child: ChildProcess, graceMs = 5000): void {
  if (child.pid === undefined) return;
  if (isWindows) {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  const pid = child.pid;
  const send = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      // the group is already gone
    }
  };
  send("SIGTERM");
  setTimeout(() => send("SIGKILL"), graceMs).unref();
}

function quoteWindows(arg: string): string {
  return /[\s"&|<>^%]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/**
 * Spawn a process in its own process group, feed `input` on stdin, report complete stdout lines as they
 * arrive, and enforce a timeout / abort signal by killing the whole tree.
 */
export function runProcess(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    // Node refuses to spawn .cmd/.bat shims without a shell (CVE-2024-27980).
    const winShim = isWindows && /\.(cmd|bat)$/i.test(cmd);
    const command = winShim ? [cmd, ...args].map(quoteWindows).join(" ") : cmd;
    const child = spawn(command, winShim ? [] : args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: opts.shell || winShim,
      detached: !isWindows,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    active.add(child);
    let stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const emitLine = (raw: string) => {
      const line = raw.replace(/\r$/, "");
      if (line && opts.onStdoutLine) opts.onStdoutLine(line);
    };
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
      if (!opts.onStdoutLine) return;
      pending += chunk;
      let idx: number;
      while ((idx = pending.indexOf("\n")) >= 0) {
        emitLine(pending.slice(0, idx));
        pending = pending.slice(idx + 1);
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin!.on("error", () => {
      // the child exited before reading all of its input
    });
    child.stdin!.end(opts.input ?? "");
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, opts.killGraceMs);
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      killTree(child, opts.killGraceMs);
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      active.delete(child);
    };
    child.on("error", (err) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on("close", (code) => {
      cleanup();
      if (pending) emitLine(pending);
      pending = "";
      if (!settled) {
        settled = true;
        resolvePromise({ code: timedOut || aborted ? null : code, stdout, stderr, timedOut, aborted });
      }
    });
  });
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/process.test.ts && npm run typecheck`
Expected: 6 tests PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/agents/process.ts test/process.test.ts
git commit -m "feat: add streaming process runner with timeout and tree kill

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Agent backends and stream parsers

**Files:**
- Create: `src/agents/types.ts`, `src/agents/resolve.ts` (stub here, implemented in Task 7), `src/agents/codex.ts`, `src/agents/claude.ts`, `test/fixtures/codex-stream.jsonl`, `test/fixtures/claude-stream.jsonl`, `test/parsers.test.ts`, `test/backends.test.ts`

**Interfaces:**
- Consumes: `ConfigData`, `Permission` (Task 3); `Activity` (Task 2); `SchemaName`, `schemaPath`, `loadSchema` (Task 2).
- Produces (`types.ts`): `PermissionDenial`, `AgentMeta { costUsd?; tokens?; sessionId?; numTurns?; permissionDenials }`, `ParsedEvent = {type:"activity"; activity} | {type:"usage"; costUsd?; tokens?}`, `StreamParser { feed(line): ParsedEvent[] }`, `BuildArgs { schemaName; permission; lastMessageFile; extraAllowed }`, `FinalOutput { data; meta }`, `AgentBackend { name; binary(); buildArgs(a); createParser(); finalize(parser, stdout, lastMessageFile) }`, `class AgentFailure(message, meta)`, `class BinaryNotFound`, `extractJson(text)`, `firstLine(text, max?)`, `relPath(path, repo)`.
- Produces: `CodexBackend(cfg.codex, repo)`, `CodexParser` (public `tokens`, `lastAgentMessage`, `error`), `unwrapShell(cmd)`, `ClaudeBackend(cfg.claude, repo)`, `ClaudeParser(repo)` (public `result`).

- [ ] **Step 1: Write the fixtures (sanitized from real codex-cli 0.164.0 and Claude Code 2.1.311 runs)**

```text file=test/fixtures/codex-stream.jsonl
{"type":"thread.started","thread_id":"01a17c13-e50d-7603-8538-a3f4ebfe421d"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll read `a.txt`, then run `ls`.\n"}}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'cat a.txt'","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'cat a.txt'","aggregated_output":"hello\n","exit_code":0,"status":"completed"}}
{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc ls","aggregated_output":"a.txt\nschema.json\n","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"{\"answer\":\"hello\\n\",\"n\":2}"}}
{"type":"turn.completed","usage":{"input_tokens":30210,"cached_input_tokens":14848,"cache_write_input_tokens":0,"output_tokens":85,"reasoning_output_tokens":0}}
```

```text file=test/fixtures/claude-stream.jsonl
{"type":"system","subtype":"init","cwd":"/repo","session_id":"s1","tools":["Read","Grep","Glob","Bash"],"model":"claude-opus-5-5"}
{"type":"rate_limit_event"}
{"type":"assistant","message":{"id":"msg_1","role":"assistant","content":[{"type":"thinking","thinking":""}]},"session_id":"s1","uuid":"u1"}
{"type":"assistant","message":{"id":"msg_1","role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"/repo/a.txt"}}]},"session_id":"s1","uuid":"u2"}
{"type":"assistant","message":{"id":"msg_1","role":"assistant","content":[{"type":"tool_use","id":"toolu_2","name":"Bash","input":{"command":"ls","description":"List files in current directory"}}]},"session_id":"s1","uuid":"u3"}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"1\thello\n2\t"}]},"session_id":"s1","uuid":"u4"}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_2","type":"tool_result","content":"a.txt\nschema.json","is_error":false}]},"session_id":"s1","uuid":"u5"}
{"type":"assistant","message":{"id":"msg_2","role":"assistant","content":[{"type":"tool_use","id":"toolu_3","name":"StructuredOutput","input":{"answer":"hello","n":2}}]},"session_id":"s1","uuid":"u6"}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_3","type":"tool_result","content":"Structured output provided successfully"}]},"session_id":"s1","uuid":"u7"}
{"type":"result","subtype":"success","is_error":false,"num_turns":4,"result":"{\"answer\":\"hello\",\"n\":2}","structured_output":{"answer":"hello","n":2},"total_cost_usd":0.0847458,"session_id":"s1","permission_denials":[]}
```

- [ ] **Step 2: Write the failing tests**

```ts file=test/parsers.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeParser } from "../src/agents/claude.js";
import { CodexParser, unwrapShell } from "../src/agents/codex.js";
import { extractJson, type ParsedEvent, type StreamParser } from "../src/agents/types.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").split("\n").filter(Boolean);
const feedAll = (p: StreamParser, lines: string[]) => lines.flatMap((l) => p.feed(l));
const summary = (events: ParsedEvent[]) => events.map((e) =>
  e.type === "activity" ? `${e.activity.kind}:${e.activity.status}:${e.activity.label}` : `usage:${e.costUsd ?? ""}:${e.tokens ?? ""}`);

describe("CodexParser", () => {
  it("turns a real codex exec --json stream into activities", () => {
    const p = new CodexParser();
    expect(summary(feedAll(p, fixture("codex-stream.jsonl")))).toEqual([
      "say:ok:I’ll read `a.txt`, then run `ls`.",
      "command:running:exec  cat a.txt",
      "command:ok:exec  cat a.txt",
      "command:running:exec  ls",
      "command:ok:exec  ls",
      "submit:ok:submitting result",
      "usage::30295",
    ]);
    expect(p.lastAgentMessage).toBe('{"answer":"hello\\n","n":2}');
  });

  it("marks failed commands, records errors and ignores noise", () => {
    const p = new CodexParser();
    const events = feedAll(p, [
      "not json", "", "[1,2]", "null",
      JSON.stringify({ type: "item.completed", item: { id: "x", type: "command_execution", command: "bash -lc 'npm test'", exit_code: 1, status: "failed" } }),
      JSON.stringify({ type: "turn.failed", error: { message: "boom" } }),
    ]);
    expect(summary(events)).toEqual(["command:error:exec  npm test"]);
    expect(events[0]).toMatchObject({ activity: { exitCode: 1 } });
    expect(p.error).toBe("boom");
  });

  it("unwraps shell wrappers", () => {
    expect(unwrapShell("/bin/zsh -lc 'cat a.txt'")).toBe("cat a.txt");
    expect(unwrapShell("/bin/zsh -lc ls")).toBe("ls");
    expect(unwrapShell("bash -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'");
    expect(unwrapShell("git status")).toBe("git status");
  });
});

describe("ClaudeParser", () => {
  it("turns a real stream-json stream into activities", () => {
    const p = new ClaudeParser("/repo");
    expect(summary(feedAll(p, fixture("claude-stream.jsonl")))).toEqual([
      "think:ok:thinking",
      "read:running:Read  a.txt",
      "command:running:Bash  ls",
      "read:ok:Read  a.txt",
      "command:ok:Bash  ls",
      "submit:running:submitting result",
      "submit:ok:submitting result",
      "usage:0.0847458:",
    ]);
    expect(p.result?.structured_output).toEqual({ answer: "hello", n: 2 });
  });

  it("counts edited lines, marks denials and errors, and ignores noise", () => {
    const p = new ClaudeParser("/repo");
    const events = feedAll(p, [
      "Warning: something printed on stdout", "{broken",
      JSON.stringify({ type: "assistant", uuid: "a", message: { id: "m", content: [
        { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/repo/src/x.ts", old_string: "a\nb", new_string: "a\nb\nc" } },
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "git push\nmore" } },
        { type: "text", text: "Done.\nDetails" },
      ] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true,
        content: "Claude requested permissions to use Bash, but you haven't granted it yet." }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "String not found in file" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.5, permission_denials: [{ tool_name: "Bash", tool_use_id: "t2" }] }),
    ]);
    expect(summary(events)).toEqual([
      "edit:running:Edit  src/x.ts", "command:running:Bash  git push", "say:ok:Done.",
      "command:denied:Bash  git push", "edit:error:Edit  src/x.ts", "usage:0.5:",
    ]);
    expect(events[0]).toMatchObject({ activity: { added: 3, removed: 2 } });
  });
});

describe("extractJson", () => {
  it("handles fences and surrounding prose", () => {
    expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here: {"a": {"b": 2}} done')).toEqual({ a: { b: 2 } });
    expect(() => extractJson("no json here")).toThrow("not valid JSON");
  });
});
```

```ts file=test/backends.test.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeBackend, ClaudeParser } from "../src/agents/claude.js";
import { CodexBackend, CodexParser } from "../src/agents/codex.js";
import { loadSchema, schemaPath } from "../src/agents/schema.js";
import { AgentFailure } from "../src/agents/types.js";
import { defaultConfig } from "../src/core/config.js";
import { tempDir } from "./helpers/tmp.js";

const cfg = defaultConfig();

describe("ClaudeBackend", () => {
  const backend = new ClaudeBackend(cfg.claude, "/repo");

  it("builds read-only and implementer command lines", () => {
    const ro = backend.buildArgs({ schemaName: "plan_critique", permission: "read-only", lastMessageFile: "/tmp/x", extraAllowed: [] });
    expect(ro.slice(0, 5)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--json-schema"]);
    expect(JSON.parse(ro[5]!)).toEqual(loadSchema("plan_critique"));
    expect(ro[ro.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(ro[ro.indexOf("--permission-prompts") + 1]).toBe("none");
    expect(ro[ro.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(ro).not.toContain("--disallowedTools");
    const rw = backend.buildArgs({ schemaName: "implementation", permission: "workspace-write", lastMessageFile: "/tmp/x", extraAllowed: ["Bash(npm test*)"] });
    expect(rw[rw.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(rw[rw.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,Edit,Write,Bash");
    expect(rw.slice(rw.indexOf("--allowedTools"), rw.indexOf("--disallowedTools"))).toContain("Bash(npm test*)");
    expect(rw.slice(rw.indexOf("--disallowedTools"))).toContain("Bash(git push*)");
    expect(rw).toContain("--strict-mcp-config");
  });

  it("finalizes from the result envelope", () => {
    const p = new ClaudeParser("/repo");
    p.feed(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: '{"a":1}', structured_output: { a: 2 }, total_cost_usd: 0.5, permission_denials: [] }));
    expect(backend.finalize(p, "", "")).toMatchObject({ data: { a: 2 }, meta: { costUsd: 0.5 } });
    const q = new ClaudeParser("/repo");
    q.feed(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: '{"a":1}' }));
    expect(backend.finalize(q, "", "").data).toEqual({ a: 1 });
  });

  it("keeps the cost when the envelope reports an error", () => {
    const p = new ClaudeParser("/repo");
    p.feed(JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 0.7 }));
    let failure: unknown;
    try {
      backend.finalize(p, "", "");
    } catch (e) {
      failure = e;
    }
    expect(failure).toBeInstanceOf(AgentFailure);
    expect((failure as AgentFailure).meta.costUsd).toBe(0.7);
    expect(() => backend.finalize(new ClaudeParser("/repo"), "garbage", "")).toThrow("did not return a result envelope");
  });
});

describe("CodexBackend", () => {
  const backend = new CodexBackend(cfg.codex, "/repo");

  it("builds the command line", () => {
    const args = backend.buildArgs({ schemaName: "review", permission: "read-only", lastMessageFile: "/tmp/last.json", extraAllowed: [] });
    expect(args.slice(0, 4)).toEqual(["exec", "--json", "--sandbox", "read-only"]);
    expect(args[args.indexOf("--output-schema") + 1]).toBe(schemaPath("review"));
    expect(args[args.indexOf("--output-last-message") + 1]).toBe("/tmp/last.json");
    expect(args[args.indexOf("--cd") + 1]).toBe("/repo");
    expect(args).toContain("--ephemeral");
    expect(args.at(-1)).toBe("-");
  });

  it("finalizes from the last-message file, then from the stream", () => {
    const t = tempDir();
    try {
      const file = join(t.path, "last.json");
      writeFileSync(file, '{"a":1}');
      const p = new CodexParser();
      p.feed(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }));
      expect(backend.finalize(p, "", file)).toMatchObject({ data: { a: 1 }, meta: { tokens: 15 } });
      const q = new CodexParser();
      q.feed(JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text: '{"b":2}' } }));
      expect(backend.finalize(q, "", join(t.path, "missing.json")).data).toEqual({ b: 2 });
      const r = new CodexParser();
      r.feed(JSON.stringify({ type: "turn.failed", error: { message: "rate limited" } }));
      expect(() => backend.finalize(r, "", join(t.path, "missing.json"))).toThrow("codex failed: rate limited");
    } finally {
      t.cleanup();
    }
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/parsers.test.ts test/backends.test.ts`
Expected: FAIL, cannot resolve `../src/agents/claude.js`.

- [ ] **Step 4: Implement**

```ts file=src/agents/types.ts
import { isAbsolute, relative } from "node:path";
import type { Permission } from "../core/config.js";
import type { Activity } from "../events.js";
import type { SchemaName } from "./schema.js";

export interface PermissionDenial {
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
}

export interface AgentMeta {
  costUsd?: number;
  tokens?: number;
  sessionId?: string;
  numTurns?: number;
  permissionDenials: PermissionDenial[];
}

export type ParsedEvent =
  | { type: "activity"; activity: Activity }
  | { type: "usage"; costUsd?: number; tokens?: number };

/** Stateful translator from one CLI's stdout lines to activities. Must never throw. */
export interface StreamParser {
  feed(line: string): ParsedEvent[];
}

export interface BuildArgs {
  schemaName: SchemaName;
  permission: Permission;
  lastMessageFile: string;
  extraAllowed: string[];
}

export interface FinalOutput {
  data: unknown;
  meta: AgentMeta;
}

export interface AgentBackend {
  readonly name: "codex" | "claude";
  binary(): string;
  buildArgs(args: BuildArgs): string[];
  createParser(): StreamParser;
  /** Extract the final JSON; throws AgentFailure (carrying whatever meta is known) when unusable. */
  finalize(parser: StreamParser, stdout: string, lastMessageFile: string): FinalOutput;
}

export class AgentFailure extends Error {
  override name = "AgentFailure";
  constructor(message: string, readonly meta: Partial<AgentMeta> = {}) {
    super(message);
  }
}

export class BinaryNotFound extends Error {
  override name = "BinaryNotFound";
}

export function extractJson(text: string): unknown {
  let body = (text ?? "").trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(body);
  if (fence) body = fence[1]!.trim();
  try {
    return JSON.parse(body);
  } catch {
    // fall through to the brace search
  }
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      // fall through to the error
    }
  }
  throw new AgentFailure(`output is not valid JSON: ${body.length > 300 ? `${body.slice(0, 300)}...` : body}`);
}

export function firstLine(text: string, max = 120): string {
  const line = String(text ?? "").trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function relPath(path: string, repo: string): string {
  if (!path || !isAbsolute(path)) return path;
  const rel = relative(repo, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}
```

```ts file=src/agents/resolve.ts
/** Implemented in Task 7. */
export function resolveBinary(configured: string, _backend: "codex" | "claude"): string | null {
  return configured.includes("/") ? configured : null;
}
```

```ts file=src/agents/codex.ts
import { existsSync, readFileSync } from "node:fs";
import type { ConfigData } from "../core/config.js";
import type { Activity } from "../events.js";
import { resolveBinary } from "./resolve.js";
import { schemaPath } from "./schema.js";
import {
  AgentFailure, BinaryNotFound, extractJson, firstLine,
  type AgentBackend, type AgentMeta, type BuildArgs, type FinalOutput, type ParsedEvent, type StreamParser,
} from "./types.js";

/** "/bin/zsh -lc 'cat a.txt'" → "cat a.txt" */
export function unwrapShell(command: string): string {
  const quoted = /^\S*?(?:ba|z)?sh -lc '([\s\S]*)'$/.exec(command);
  if (quoted) return quoted[1]!.replace(/'\\''/g, "'");
  const bare = /^\S*?(?:ba|z)?sh -lc (.+)$/.exec(command);
  return bare ? bare[1]! : command;
}

type Item = Record<string, unknown> & { id?: unknown; type?: unknown };

export class CodexParser implements StreamParser {
  tokens = 0;
  lastAgentMessage: string | null = null;
  error: string | null = null;

  feed(line: string): ParsedEvent[] {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) return [];
    if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
      const usage = event.usage as { input_tokens?: number; output_tokens?: number };
      this.tokens += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
      return [{ type: "usage", tokens: this.tokens }];
    }
    if (event.type === "turn.failed" || event.type === "error") {
      const err = event.error as { message?: string } | undefined;
      this.error = String(err?.message ?? event.message ?? "codex reported an error");
      return [];
    }
    if (typeof event.type !== "string" || !/^item\.(started|updated|completed)$/.test(event.type) || !event.item) return [];
    const activity = this.toActivity(event.item as Item, event.type === "item.completed");
    return activity ? [{ type: "activity", activity }] : [];
  }

  private toActivity(item: Item, completed: boolean): Activity | null {
    const id = String(item.id ?? "");
    const failed = item.status === "failed";
    switch (item.type) {
      case "command_execution": {
        const done = completed || item.status === "completed" || failed;
        const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
        return {
          id, kind: "command", label: `exec  ${firstLine(unwrapShell(String(item.command ?? "")))}`,
          status: !done ? "running" : exitCode === 0 && !failed ? "ok" : "error", exitCode,
        };
      }
      case "agent_message": {
        if (!completed) return null;
        const text = String(item.text ?? "");
        this.lastAgentMessage = text;
        return text.trim().startsWith("{")
          ? { id, kind: "submit", label: "submitting result", status: "ok" }
          : { id, kind: "say", label: firstLine(text), status: "ok" };
      }
      case "reasoning":
        return { id, kind: "think", label: item.text ? firstLine(String(item.text)) : "thinking", status: completed ? "ok" : "running" };
      case "file_change": {
        const changes = Array.isArray(item.changes) ? (item.changes as Array<{ path?: string }>).map((c) => c.path).join(", ") : "";
        return { id, kind: "edit", label: `edit  ${firstLine(changes)}`, status: !completed ? "running" : failed ? "error" : "ok" };
      }
      case "web_search":
        return { id, kind: "search", label: `search  ${firstLine(String(item.query ?? ""))}`, status: completed ? "ok" : "running" };
      case "mcp_tool_call":
        return { id, kind: "other", label: `${String(item.server ?? "mcp")}.${String(item.tool ?? "tool")}`, status: !completed ? "running" : failed ? "error" : "ok" };
      case "todo_list":
        return { id, kind: "other", label: "update plan", status: "ok" };
      case "error":
        return { id, kind: "other", label: firstLine(String(item.message ?? "error")), status: "error" };
      default:
        return null;
    }
  }
}

export class CodexBackend implements AgentBackend {
  readonly name = "codex" as const;

  constructor(private readonly cfg: ConfigData["codex"], private readonly repo: string) {}

  binary(): string {
    const found = resolveBinary(this.cfg.bin, "codex");
    if (!found) throw new BinaryNotFound(`codex CLI not found (configured bin: '${this.cfg.bin}')`);
    return found;
  }

  buildArgs({ schemaName, permission, lastMessageFile }: BuildArgs): string[] {
    return [
      "exec", "--json",
      "--sandbox", permission,
      "--color", "never",
      "--output-schema", schemaPath(schemaName),
      "--output-last-message", lastMessageFile,
      "--cd", this.repo,
      ...(this.cfg.model ? ["--model", this.cfg.model] : []),
      ...this.cfg.extra_args.map(String),
      "-", // read the prompt from stdin
    ];
  }

  createParser(): CodexParser {
    return new CodexParser();
  }

  finalize(parser: StreamParser, _stdout: string, lastMessageFile: string): FinalOutput {
    const p = parser as CodexParser;
    const fromFile = lastMessageFile && existsSync(lastMessageFile) ? readFileSync(lastMessageFile, "utf8") : "";
    const text = fromFile.trim() ? fromFile : p.lastAgentMessage ?? "";
    const meta: AgentMeta = { tokens: p.tokens || undefined, permissionDenials: [] };
    if (!text.trim()) throw new AgentFailure(p.error ? `codex failed: ${p.error}` : "codex produced no final message", meta);
    try {
      return { data: extractJson(text), meta };
    } catch (e) {
      throw new AgentFailure((e as Error).message, meta);
    }
  }
}
```

```ts file=src/agents/claude.ts
import type { ConfigData } from "../core/config.js";
import type { Activity } from "../events.js";
import { resolveBinary } from "./resolve.js";
import { loadSchema } from "./schema.js";
import {
  AgentFailure, BinaryNotFound, extractJson, firstLine, relPath,
  type AgentBackend, type AgentMeta, type BuildArgs, type FinalOutput, type ParsedEvent, type StreamParser,
} from "./types.js";

const DENIAL_RE = /permission|denied|haven't granted|not allowed/i;
const countLines = (text: unknown): number => (typeof text === "string" && text.length ? text.split("\n").length : 0);

type Block = Record<string, unknown> & { type?: unknown };

export class ClaudeParser implements StreamParser {
  result: Record<string, any> | null = null;
  private readonly tools = new Map<string, Activity>();

  constructor(private readonly repo: string) {}

  feed(line: string): ParsedEvent[] {
    let event: Record<string, any>;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) return [];
    if (event.type === "result") return this.onResult(event);
    const content = event.message?.content;
    if (!Array.isArray(content)) return [];
    const out: ParsedEvent[] = [];
    content.forEach((block: Block, i: number) => {
      if (event.type === "assistant") {
        const id = `${event.uuid ?? event.message.id ?? "msg"}-${i}`;
        if (block.type === "text" && String(block.text ?? "").trim()) {
          out.push({ type: "activity", activity: { id, kind: "say", label: firstLine(String(block.text)), status: "ok" } });
        } else if (block.type === "thinking") {
          out.push({ type: "activity", activity: { id, kind: "think", label: "thinking", status: "ok" } });
        } else if (block.type === "tool_use") {
          const activity = this.toolActivity(block);
          this.tools.set(activity.id, activity);
          out.push({ type: "activity", activity: { ...activity } });
        }
      } else if (event.type === "user" && block.type === "tool_result") {
        const activity = this.tools.get(String(block.tool_use_id));
        if (!activity) return;
        const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
        activity.status = block.is_error ? (DENIAL_RE.test(text) ? "denied" : "error") : "ok";
        out.push({ type: "activity", activity: { ...activity } });
      }
    });
    return out;
  }

  private onResult(event: Record<string, any>): ParsedEvent[] {
    this.result = event;
    const out: ParsedEvent[] = [];
    for (const denial of Array.isArray(event.permission_denials) ? event.permission_denials : []) {
      const activity = denial?.tool_use_id ? this.tools.get(String(denial.tool_use_id)) : undefined;
      if (activity && activity.status !== "denied") {
        activity.status = "denied";
        out.push({ type: "activity", activity: { ...activity } });
      }
    }
    if (typeof event.total_cost_usd === "number") out.push({ type: "usage", costUsd: event.total_cost_usd });
    return out;
  }

  private toolActivity(block: Block): Activity {
    const input = (block.input ?? {}) as Record<string, any>;
    const id = String(block.id);
    const path = (p: unknown) => relPath(String(p ?? ""), this.repo);
    switch (block.name) {
      case "Read":
        return { id, kind: "read", label: `Read  ${path(input.file_path)}`, status: "running" };
      case "Grep":
        return { id, kind: "search", label: `Grep  "${firstLine(String(input.pattern ?? ""), 60)}"${input.path ? ` in ${path(input.path)}` : ""}`, status: "running" };
      case "Glob":
        return { id, kind: "search", label: `Glob  ${firstLine(String(input.pattern ?? ""), 60)}`, status: "running" };
      case "Edit":
        return { id, kind: "edit", label: `Edit  ${path(input.file_path)}`, status: "running", added: countLines(input.new_string), removed: countLines(input.old_string) };
      case "MultiEdit": {
        const edits: Array<Record<string, unknown>> = Array.isArray(input.edits) ? input.edits : [];
        return {
          id, kind: "edit", label: `Edit  ${path(input.file_path)}`, status: "running",
          added: edits.reduce((n, e) => n + countLines(e.new_string), 0),
          removed: edits.reduce((n, e) => n + countLines(e.old_string), 0),
        };
      }
      case "Write":
        return { id, kind: "edit", label: `Write ${path(input.file_path)}`, status: "running", added: countLines(input.content), removed: 0 };
      case "NotebookEdit":
        return { id, kind: "edit", label: `Edit  ${path(input.notebook_path)}`, status: "running" };
      case "Bash":
        return { id, kind: "command", label: `Bash  ${firstLine(String(input.command ?? ""))}`, status: "running" };
      case "StructuredOutput":
        return { id, kind: "submit", label: "submitting result", status: "running" };
      case "TodoWrite":
        return { id, kind: "other", label: "update todos", status: "running" };
      default:
        return { id, kind: "other", label: String(block.name ?? "tool"), status: "running" };
    }
  }
}

export class ClaudeBackend implements AgentBackend {
  readonly name = "claude" as const;

  constructor(private readonly cfg: ConfigData["claude"], private readonly repo: string) {}

  binary(): string {
    const found = resolveBinary(this.cfg.bin, "claude");
    if (!found) throw new BinaryNotFound(`claude CLI not found (configured bin: '${this.cfg.bin}')`);
    return found;
  }

  buildArgs({ schemaName, permission, extraAllowed }: BuildArgs): string[] {
    const write = permission === "workspace-write";
    const tools = write ? this.cfg.implementation_tools : this.cfg.read_only_tools;
    const allowed = write ? [...this.cfg.implementation_allowed_tools, ...extraAllowed] : [...tools];
    const disallowed = write ? this.cfg.implementation_disallowed_tools : [];
    return [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--json-schema", JSON.stringify(loadSchema(schemaName)),
      "--permission-mode", write ? "acceptEdits" : "dontAsk",
      "--permission-prompts", "none",
      "--tools", tools.join(","),
      "--allowedTools", ...allowed,
      ...(disallowed.length ? ["--disallowedTools", ...disallowed] : []),
      ...(this.cfg.model ? ["--model", this.cfg.model] : []),
      ...(this.cfg.max_budget_usd ? ["--max-budget-usd", String(this.cfg.max_budget_usd)] : []),
      ...this.cfg.extra_args.map(String),
    ];
  }

  createParser(): ClaudeParser {
    return new ClaudeParser(this.repo);
  }

  finalize(parser: StreamParser, stdout: string): FinalOutput {
    let envelope = (parser as ClaudeParser).result;
    if (!envelope) {
      try {
        const parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) envelope = parsed;
      } catch {
        // handled below
      }
    }
    if (!envelope) throw new AgentFailure(`claude did not return a result envelope: ${stdout.trim().slice(0, 300)}`);
    const meta: AgentMeta = {
      costUsd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : undefined,
      sessionId: envelope.session_id, numTurns: envelope.num_turns,
      permissionDenials: Array.isArray(envelope.permission_denials) ? envelope.permission_denials : [],
    };
    if (envelope.is_error || (envelope.subtype !== undefined && envelope.subtype !== "success")) {
      throw new AgentFailure(`claude reported an error (subtype=${envelope.subtype}): ${String(envelope.result ?? "").slice(0, 500)}`, meta);
    }
    if (envelope.structured_output != null) return { data: envelope.structured_output, meta };
    try {
      return { data: extractJson(String(envelope.result ?? "")), meta };
    } catch (e) {
      throw new AgentFailure((e as Error).message, meta);
    }
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/parsers.test.ts test/backends.test.ts && npm run typecheck`
Expected: 11 tests PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/agents test/fixtures test/parsers.test.ts test/backends.test.ts
git commit -m "feat: add Codex and Claude backends with stream parsers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Binary resolution

**Files:**
- Modify: `src/agents/resolve.ts` (replace the Task 6 stub entirely)
- Create: `test/resolve.test.ts`

**Interfaces:**
- Produces: `resolveBinary(configured: string, backend: "codex" | "claude", env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string | null`. It searches an explicit or `~` path, then `PATH` (with `PATHEXT` on Windows). Only for `claude`, it then falls back to `~/.claude/local/claude` and finally to the newest IDE-bundled binary.

- [ ] **Step 1: Write the failing test**

```ts file=test/resolve.test.ts
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBinary } from "../src/agents/resolve.js";
import { tempDir } from "./helpers/tmp.js";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (dirs.length) dirs.pop()!.cleanup();
});
function tmp(): string {
  const t = tempDir();
  dirs.push(t);
  return t.path;
}
function file(path: string, executable = true): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n");
  if (executable) chmodSync(path, 0o755);
  return path;
}

describe.skipIf(process.platform === "win32")("resolveBinary", () => {
  it("searches PATH", () => {
    const home = tmp();
    const bin = file(join(home, "bin", "codex"));
    expect(resolveBinary("codex", "codex", { PATH: `/nonexistent:${join(home, "bin")}`, HOME: home })).toBe(bin);
  });

  it("accepts explicit and ~ paths", () => {
    const home = tmp();
    const bin = file(join(home, "tools", "claude"));
    expect(resolveBinary(bin, "claude", { PATH: "", HOME: home })).toBe(bin);
    expect(resolveBinary("~/tools/claude", "claude", { PATH: "", HOME: home })).toBe(bin);
    expect(resolveBinary(join(home, "nope"), "claude", { PATH: "", HOME: home })).toBeNull();
  });

  it("falls back to the newest IDE-bundled Claude", () => {
    const home = tmp();
    for (const v of ["2.1.9", "2.1.310"]) {
      file(join(home, ".vscode", "extensions", `anthropic.claude-code-${v}-darwin-arm64`, "resources", "native-binary", "claude"));
    }
    expect(resolveBinary("claude", "claude", { PATH: "/nonexistent", HOME: home })).toContain("anthropic.claude-code-2.1.310");
    expect(resolveBinary("codex", "codex", { PATH: "/nonexistent", HOME: home })).toBeNull();
  });

  it("skips files that are not executable", () => {
    const home = tmp();
    file(join(home, "bin", "codex"), false);
    expect(resolveBinary("codex", "codex", { PATH: join(home, "bin"), HOME: home })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/resolve.test.ts`
Expected: FAIL, because the stub ignores PATH ("expected null to be …/bin/codex").

- [ ] **Step 3: Implement**

```ts file=src/agents/resolve.ts
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (platform === "win32") return existsSync(path);
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function versionKey(name: string): number[] {
  const m = /claude-code-(\d+(?:\.\d+)*)/.exec(name);
  return m ? m[1]!.split(".").map(Number) : [];
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function resolveBinary(configured: string, backend: "codex" | "claude",
  env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const home = env.HOME || env.USERPROFILE || homedir();
  const expanded = configured.startsWith("~") ? join(home, configured.slice(1)) : configured;
  if (expanded.includes("/") || expanded.includes("\\") || isAbsolute(expanded)) {
    return isExecutable(expanded, platform) ? expanded : null;
  }
  const exts = platform === "win32" ? (env.PATHEXT || ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase()) : [""];
  for (const dir of (env.PATH || "").split(platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, expanded + ext);
      if (isExecutable(candidate, platform)) return candidate;
    }
  }
  if (backend !== "claude" || configured !== "claude") return null;
  // Claude Code installed only through an IDE extension is not on PATH.
  const exe = platform === "win32" ? "claude.exe" : "claude";
  const candidates = [join(home, ".claude", "local", exe)];
  for (const editor of [".vscode", ".vscode-insiders", ".cursor", ".windsurf"]) {
    const extDir = join(home, editor, "extensions");
    let names: string[];
    try {
      names = readdirSync(extDir).filter((n) => n.startsWith("anthropic.claude-code-"));
    } catch {
      continue;
    }
    names.sort((a, b) => compareVersions(versionKey(a), versionKey(b)));
    candidates.push(...names.map((n) => join(extDir, n, "resources", "native-binary", exe)));
  }
  return candidates.filter((c) => isExecutable(c, platform)).at(-1) ?? null;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/resolve.test.ts test/backends.test.ts && npm run typecheck`
Expected: all PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/agents/resolve.ts test/resolve.test.ts
git commit -m "feat: resolve agent binaries from PATH and IDE-bundled Claude

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Agent runner and fake CLIs

**Files:**
- Create: `src/agents/runner.ts`, `test/fake-agent.mjs`, `test/helpers/fake-clis.ts`, `test/helpers/config.ts`, `test/runner.test.ts`

**Interfaces:**
- Consumes: `runProcess` (Task 5); `CodexBackend`, `ClaudeBackend`, `AgentBackend`, `AgentFailure`, `BinaryNotFound`, `AgentMeta` (Task 6); `validateOutput`, `SchemaName` (Task 2); `ConfigData`, `AgentRole`, `permissionFor` (Task 3); `EventBus`, `Role`, `Party` (Task 2).
- Produces: `interface CallOptions { role: Role; agentRole: AgentRole; prompt; schemaName; logPrefix; check?; extraAllowed?; signal? }`, `interface AgentResult { ok; data; error; attempts; durationSec; costUsd: number|null; tokens: number|null; meta: AgentMeta; backend: "codex"|"claude"; interrupted }`, `class AgentRunner(cfg, repo, logDir, bus, backends?)` with `call(o): Promise<AgentResult>`. Log files per attempt: `<logPrefix>.aN.{prompt.md,cmd.json,events.jsonl,stderr.txt,last.json,output.json}`.
- Produces (tests): `FakeClis(dir)` with `bin`, `path(name)`, `setScenario(s)`, `install()`, `restore()`, `calls(role?)`; `testConfig(fake, overrides?)`, `CHECK_GATE`.

The fake agent's scenario format: `{ "<role>": [response, ...] }`. `role` is the `[orchestrator-role: X]` tag of the prompt. Each call consumes the next response, and the last response repeats once the list runs out. A response may contain:

| Key | Effect |
|---|---|
| `output` | The final JSON. `reviewed_commit: "$SNAPSHOT"` is replaced with the SHA from the prompt |
| `raw` | Text to return instead of JSON |
| `activities` | Codex: `{command, exit?}`. Claude: `{tool, input?, result?, error?}` |
| `write` | `{path: content}`, files to write |
| `delete` | Paths to delete |
| `shell` | Shell commands to run |
| `sleep` | Milliseconds to wait |
| `exit` | Process exit code |

- [ ] **Step 1: Write the fake CLI and helpers**

```js file=test/fake-agent.mjs
// Stand-in for the codex / claude CLIs in tests: fake-agent.mjs <codex|claude> <cli args...>.
// The prompt arrives on stdin; its "[orchestrator-role: X]" tag selects the next scripted response for
// role X from $FAKE_SCENARIO (the last response repeats). Every call is appended to $FAKE_LOG.
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const HELP = {
  codex: "Usage: codex exec [OPTIONS] --json --output-schema --sandbox --output-last-message --cd",
  claude: "Usage: claude [options] --output-format --verbose --json-schema --permission-mode --permission-prompts --tools --allowedTools --disallowedTools",
};

async function main() {
  const [backend, ...args] = process.argv.slice(2);
  if (args.includes("--version")) {
    process.stdout.write(`${backend}-fake 1.0.0\n`);
    return 0;
  }
  if (args.includes("--help")) {
    process.stdout.write(`${HELP[backend]}\n`);
    return 0;
  }
  const prompt = readFileSync(0, "utf8");
  const role = /\[orchestrator-role: (\w+)\]/.exec(prompt)?.[1] ?? "unknown";
  const scenario = JSON.parse(readFileSync(process.env.FAKE_SCENARIO, "utf8"));
  const counts = existsSync(process.env.FAKE_COUNTS) ? JSON.parse(readFileSync(process.env.FAKE_COUNTS, "utf8")) : {};
  const n = counts[role] ?? 0;
  counts[role] = n + 1;
  writeFileSync(process.env.FAKE_COUNTS, JSON.stringify(counts));
  const responses = scenario[role] ?? [{ raw: `no scripted response for role ${role}` }];
  const resp = responses[Math.min(n, responses.length - 1)];
  appendFileSync(process.env.FAKE_LOG, JSON.stringify({ backend, role, call: n, args, prompt }) + "\n");

  for (const [path, content] of Object.entries(resp.write ?? {})) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  for (const path of resp.delete ?? []) rmSync(path);
  for (const command of resp.shell ?? []) {
    try {
      execSync(command, { stdio: "ignore" });
    } catch {
      // scripted commands may fail on purpose
    }
  }
  if (resp.sleep) await new Promise((r) => setTimeout(r, resp.sleep));

  let text;
  if ("raw" in resp) {
    text = resp.raw;
  } else {
    const output = structuredClone(resp.output);
    if (output.reviewed_commit === "$SNAPSHOT") output.reviewed_commit = /Revision under review: `([0-9a-f]{40})`/.exec(prompt)[1];
    text = JSON.stringify(output);
  }
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  const activities = resp.activities ?? [];
  if (backend === "codex") {
    emit({ type: "thread.started", thread_id: "fake" });
    emit({ type: "turn.started" });
    activities.forEach((a, i) => {
      const item = { id: `item_${i}`, type: "command_execution", command: `/bin/zsh -lc '${a.command}'`, aggregated_output: "", exit_code: null, status: "in_progress" };
      emit({ type: "item.started", item });
      emit({ type: "item.completed", item: { ...item, exit_code: a.exit ?? 0, status: "completed" } });
    });
    emit({ type: "item.completed", item: { id: "item_final", type: "agent_message", text } });
    emit({ type: "turn.completed", usage: { input_tokens: 1000, output_tokens: 234 } });
    writeFileSync(args[args.indexOf("--output-last-message") + 1], text);
  } else {
    emit({ type: "system", subtype: "init", session_id: "fake" });
    activities.forEach((a, i) => {
      emit({ type: "assistant", uuid: `u${i}`, message: { id: "m", content: [{ type: "tool_use", id: `t${i}`, name: a.tool, input: a.input ?? {} }] } });
      emit({ type: "user", uuid: `r${i}`, message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, content: a.result ?? "ok", is_error: a.error ?? false }] } });
    });
    const envelope = { type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0.01, session_id: "fake", num_turns: 1, permission_denials: [] };
    if (!("raw" in resp)) envelope.structured_output = JSON.parse(text);
    emit(envelope);
  }
  return resp.exit ?? 0;
}

process.exitCode = await main();
```

```ts file=test/helpers/fake-clis.ts
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_AGENT = fileURLToPath(new URL("../fake-agent.mjs", import.meta.url));

export interface FakeCall {
  backend: string;
  role: string;
  call: number;
  args: string[];
  prompt: string;
}

/** Executables named codex/claude that run fake-agent.mjs against a scripted scenario. */
export class FakeClis {
  readonly bin: string;
  private readonly files: { FAKE_SCENARIO: string; FAKE_COUNTS: string; FAKE_LOG: string };
  private saved: Record<string, string | undefined> = {};

  constructor(readonly dir: string) {
    this.bin = join(dir, "bin");
    mkdirSync(this.bin, { recursive: true });
    for (const name of ["codex", "claude"]) {
      const path = join(this.bin, name);
      writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGENT}" ${name} "$@"\n`);
      chmodSync(path, 0o755);
    }
    this.files = { FAKE_SCENARIO: join(dir, "scenario.json"), FAKE_COUNTS: join(dir, "counts.json"), FAKE_LOG: join(dir, "calls.jsonl") };
    this.setScenario({});
  }

  path(name: "codex" | "claude"): string {
    return join(this.bin, name);
  }

  setScenario(scenario: Record<string, unknown[]>): void {
    writeFileSync(this.files.FAKE_SCENARIO, JSON.stringify(scenario));
  }

  install(): this {
    for (const [key, value] of Object.entries(this.files)) {
      this.saved[key] = process.env[key];
      process.env[key] = value;
    }
    return this;
  }

  restore(): void {
    for (const [key, value] of Object.entries(this.saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  calls(role?: string): FakeCall[] {
    if (!existsSync(this.files.FAKE_LOG)) return [];
    return readFileSync(this.files.FAKE_LOG, "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as FakeCall).filter((c) => !role || c.role === role);
  }
}
```

```ts file=test/helpers/config.ts
import { defaultConfig, type ConfigData, type GateConfig } from "../../src/core/config.js";
import type { FakeClis } from "./fake-clis.js";

export type ConfigOverrides = {
  [K in keyof ConfigData]?: ConfigData[K] extends unknown[] ? ConfigData[K] : Partial<ConfigData[K]>;
};

export const CHECK_GATE: GateConfig = { name: "check", command: `"${process.execPath}" check.mjs`, required: true };

/** Defaults pointed at the fake CLIs, with the check.mjs gate and short timeouts. */
export function testConfig(fake: FakeClis, overrides: ConfigOverrides = {}): ConfigData {
  const cfg = defaultConfig();
  cfg.codex.bin = fake.path("codex");
  cfg.claude.bin = fake.path("claude");
  cfg.limits.agent_timeout_sec = 60;
  cfg.limits.gate_timeout_sec = 60;
  cfg.gates = [CHECK_GATE];
  const target = cfg as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (Array.isArray(value)) target[key] = value;
    else Object.assign(target[key] as object, value);
  }
  return cfg;
}
```

- [ ] **Step 2: Write the failing runner test**

```ts file=test/runner.test.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agents/runner.js";
import { EventBus, type DuoEvent } from "../src/events.js";
import { critique, plan } from "./helpers/builders.js";
import { testConfig, type ConfigOverrides } from "./helpers/config.js";
import { FakeClis } from "./helpers/fake-clis.js";
import { tempDir } from "./helpers/tmp.js";

let t: { path: string; cleanup(): void };
let fake: FakeClis;
let events: DuoEvent[];
let bus: EventBus;

beforeEach(() => {
  t = tempDir();
  fake = new FakeClis(t.path).install();
  bus = new EventBus();
  events = [];
  bus.on((e) => events.push(e));
});
afterEach(() => {
  fake.restore();
  t.cleanup();
});

const runner = (o: ConfigOverrides = {}) => new AgentRunner(testConfig(fake, o), t.path, join(t.path, "logs"), bus);
const prompt = (role: string) => `[orchestrator-role: ${role}]\nhello`;

describe("AgentRunner", () => {
  it("returns validated output and streams activities (codex)", async () => {
    fake.setScenario({ planner: [{ activities: [{ command: "cat README.md" }], output: plan() }] });
    const r = await runner().call({ role: "planner", agentRole: "planner", prompt: prompt("planner"), schemaName: "plan", logPrefix: "001-plan-r1" });
    expect(r).toMatchObject({ ok: true, attempts: 1, backend: "codex", tokens: 1234, interrupted: false });
    expect(r.data.title).toBe("Demo plan");
    const labels = events.flatMap((e) => (e.type === "agent.activity" ? [e.activity.label] : []));
    expect(labels).toContain("exec  cat README.md");
    expect(events.some((e) => e.type === "agent.usage" && e.tokens === 1234)).toBe(true);
    for (const ext of ["prompt.md", "cmd.json", "events.jsonl", "stderr.txt", "output.json"]) {
      expect(existsSync(join(t.path, "logs", `001-plan-r1.a1.${ext}`)), ext).toBe(true);
    }
    expect(fake.calls("planner")[0]!.args).toContain("--json");
  });

  it("retries invalid output with the reason and accumulates cost (claude)", async () => {
    fake.setScenario({ plan_reviewer: [{ raw: "looks fine!" }, { output: critique(true) }] });
    const r = await runner().call({ role: "plan_reviewer", agentRole: "plan_reviewer", prompt: prompt("plan_reviewer"), schemaName: "plan_critique", logPrefix: "002" });
    expect(r).toMatchObject({ ok: true, attempts: 2, costUsd: 0.02 });
    expect(events.find((e) => e.type === "agent.retry")).toMatchObject({ attempt: 2, max: 2, role: "plan_reviewer" });
    expect(fake.calls("plan_reviewer")[1]!.prompt).toContain("Previous attempt was rejected");
  });

  it("applies the semantic check and gives up after max_retries", async () => {
    fake.setScenario({ plan_reviewer: [{ output: critique(true) }] });
    const r = await runner().call({ role: "plan_reviewer", agentRole: "plan_reviewer", prompt: prompt("plan_reviewer"),
      schemaName: "plan_critique", logPrefix: "003", check: () => ["nope"] });
    expect(r).toMatchObject({ ok: false, attempts: 2 });
    expect(r.error).toContain("nope");
  });

  it("reports a missing binary without retrying", async () => {
    const r = await runner({ codex: { bin: join(t.path, "missing") } }).call({ role: "planner", agentRole: "planner", prompt: prompt("planner"), schemaName: "plan", logPrefix: "004" });
    expect(r).toMatchObject({ ok: false, attempts: 1 });
    expect(r.error).toContain("codex CLI not found");
  });

  it("fails on a non-zero exit code", async () => {
    fake.setScenario({ planner: [{ output: plan(), exit: 2 }] });
    const r = await runner({ limits: { max_retries: 0 } }).call({ role: "planner", agentRole: "planner", prompt: prompt("planner"), schemaName: "plan", logPrefix: "005" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("exited with code 2");
  });

  it("times out", async () => {
    fake.setScenario({ planner: [{ output: plan(), sleep: 5000 }] });
    const r = await runner({ limits: { max_retries: 0, agent_timeout_sec: 1 } }).call({ role: "planner", agentRole: "planner", prompt: prompt("planner"), schemaName: "plan", logPrefix: "006" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("timed out after 1s");
  });

  it("stops on abort", async () => {
    fake.setScenario({ planner: [{ output: plan(), sleep: 5000 }] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const r = await runner().call({ role: "planner", agentRole: "planner", prompt: prompt("planner"), schemaName: "plan", logPrefix: "007", signal: controller.signal });
    expect(r).toMatchObject({ ok: false, interrupted: true });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/runner.test.ts`
Expected: FAIL, cannot resolve `../src/agents/runner.js`.

- [ ] **Step 4: Implement**

```ts file=src/agents/runner.ts
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { permissionFor, type AgentRole, type ConfigData } from "../core/config.js";
import type { EventBus, Party, Role } from "../events.js";
import { ClaudeBackend } from "./claude.js";
import { CodexBackend } from "./codex.js";
import { runProcess, type RunResult } from "./process.js";
import { validateOutput, type SchemaName } from "./schema.js";
import { AgentFailure, BinaryNotFound, type AgentBackend, type AgentMeta } from "./types.js";

export interface CallOptions {
  role: Role;
  agentRole: AgentRole;
  prompt: string;
  schemaName: SchemaName;
  logPrefix: string;
  check?: (data: any) => string[];
  extraAllowed?: string[];
  signal?: AbortSignal;
}

export interface AgentResult {
  ok: boolean;
  data: any;
  error: string | null;
  attempts: number;
  durationSec: number;
  costUsd: number | null;
  tokens: number | null;
  meta: AgentMeta;
  backend: "codex" | "claude";
  interrupted: boolean;
}

export class AgentRunner {
  readonly backends: Record<"codex" | "claude", AgentBackend>;

  constructor(private readonly cfg: ConfigData, private readonly repo: string, private readonly logDir: string,
    private readonly bus: EventBus, backends?: Record<"codex" | "claude", AgentBackend>) {
    this.backends = backends ?? { codex: new CodexBackend(cfg.codex, repo), claude: new ClaudeBackend(cfg.claude, repo) };
  }

  async call(o: CallOptions): Promise<AgentResult> {
    const backend = this.backends[this.cfg.agents[o.agentRole]];
    const agent: Party = backend.name;
    const permission = permissionFor(this.cfg, o.agentRole);
    const attemptsAllowed = this.cfg.limits.max_retries + 1;
    const timeoutMs = this.cfg.limits.agent_timeout_sec * 1000;
    mkdirSync(this.logDir, { recursive: true });
    const started = Date.now();
    let cost = 0;
    let costSeen = false;
    let tokens = 0;
    let tokensSeen = false;
    let meta: AgentMeta = { permissionDenials: [] };
    let lastError: string | null = null;
    const finish = (ok: boolean, attempts: number, data: unknown, error: string | null, interrupted = false): AgentResult => ({
      ok, data, error, attempts, durationSec: (Date.now() - started) / 1000,
      costUsd: costSeen ? cost : null, tokens: tokensSeen ? tokens : null, meta, backend: backend.name, interrupted,
    });

    for (let attempt = 1; attempt <= attemptsAllowed; attempt++) {
      if (attempt > 1) this.bus.emit({ type: "agent.retry", role: o.role, agent, attempt, max: attemptsAllowed, reason: lastError ?? "" });
      const stem = join(this.logDir, `${o.logPrefix}.a${attempt}`);
      const prompt = lastError
        ? `${o.prompt}\n\n## Previous attempt was rejected by the orchestrator\n${lastError}\nReturn ONLY a JSON object that matches the required schema exactly.\n`
        : o.prompt;
      const lastMessageFile = `${stem}.last.json`;
      let binary: string;
      let args: string[];
      try {
        binary = backend.binary();
        args = backend.buildArgs({ schemaName: o.schemaName, permission, lastMessageFile, extraAllowed: o.extraAllowed ?? [] });
      } catch (e) {
        if (e instanceof BinaryNotFound) return finish(false, attempt, null, e.message);
        throw e;
      }
      writeFileSync(`${stem}.prompt.md`, prompt);
      writeFileSync(`${stem}.cmd.json`, JSON.stringify([binary, ...args], null, 1));
      const eventsLog = createWriteStream(`${stem}.events.jsonl`);
      const parser = backend.createParser();
      const baseCost = cost;
      const baseTokens = tokens;
      let run: RunResult;
      try {
        run = await runProcess(binary, args, {
          cwd: this.repo, input: prompt, timeoutMs, signal: o.signal,
          onStdoutLine: (line) => {
            eventsLog.write(`${line}\n`);
            for (const ev of parser.feed(line)) {
              if (ev.type === "activity") this.bus.emit({ type: "agent.activity", role: o.role, agent, activity: ev.activity });
              else this.bus.emit({
                type: "agent.usage", agent,
                costUsd: ev.costUsd !== undefined ? baseCost + ev.costUsd : undefined,
                tokens: ev.tokens !== undefined ? baseTokens + ev.tokens : undefined,
              });
            }
          },
        });
      } catch (e) {
        await new Promise((r) => eventsLog.end(r));
        return finish(false, attempt, null, `cannot start ${backend.name}: ${(e as Error).message}`);
      }
      await new Promise((r) => eventsLog.end(r));
      writeFileSync(`${stem}.stderr.txt`, run.stderr);
      if (run.aborted) return finish(false, attempt, null, "interrupted", true);
      if (run.timedOut) {
        lastError = `${backend.name} timed out after ${this.cfg.limits.agent_timeout_sec}s`;
        continue;
      }
      let data: unknown = null;
      let parseError: string | null = null;
      try {
        ({ data, meta } = backend.finalize(parser, run.stdout, lastMessageFile));
      } catch (e) {
        if (!(e instanceof AgentFailure)) throw e;
        parseError = e.message;
        meta = { permissionDenials: [], ...e.meta };
      }
      if (typeof meta.costUsd === "number") {
        cost += meta.costUsd;
        costSeen = true;
      }
      if (typeof meta.tokens === "number") {
        tokens += meta.tokens;
        tokensSeen = true;
      }
      if (parseError) {
        lastError = run.code === 0 ? parseError : `${backend.name} exited with code ${run.code}: ${(run.stderr || run.stdout).trim().slice(-800)}`;
        continue;
      }
      if (run.code !== 0) {
        lastError = `${backend.name} exited with code ${run.code}: ${run.stderr.trim().slice(-800)}`;
        continue;
      }
      let errors = validateOutput(o.schemaName, data);
      if (!errors.length && o.check) errors = o.check(data);
      if (errors.length) {
        lastError = `output failed validation:\n- ${errors.slice(0, 20).join("\n- ")}`;
        continue;
      }
      writeFileSync(`${stem}.output.json`, JSON.stringify(data, null, 2));
      return finish(true, attempt, data, null);
    }
    return finish(false, attemptsAllowed, null, lastError);
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/runner.test.ts && npm run typecheck`
Expected: 7 tests PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/agents/runner.ts test/fake-agent.mjs test/helpers/fake-clis.ts test/helpers/config.ts test/runner.test.ts
git commit -m "feat: add agent runner with streaming events, retries and validation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Run store and quality gates

**Files:**
- Create: `src/core/state.ts`, `src/core/gates.ts`, `test/state.test.ts`, `test/gates.test.ts`

**Interfaces:**
- Consumes: `runProcess` (Task 5); `EventBus`, `Phase`, `HistoryEntry`, `HumanReview` (Task 2); `Snapshot` (Task 4); `Critique`, `Approval`, `Finding` (Task 2); `PermissionDenial` (Task 6); `GateConfig` (Task 3).
- Produces (`state.ts`): `STATE_VERSION = 1`, `interface HumanNote { at; phase; note }`, `interface RunState` (fields below), `nowIso(d?)`, `slugify(text, maxLen?)`, `atomicWrite(path, text)`, `class LockError`, `newState(taskId, task, limits)`, `class RunStore` with `static LATEST`, `runsDir`, `taskId`, `dir`, `static create(runsDir, task, limits, now?) → { store, state }`, `static open(runsDir, taskId?)`, `static list(runsDir): RunState[]`, `lock()`, `unlock()`, `loadState()`, `saveState(state)`, `path(name)`, `exists(name)`, `writeJson(name, data): string`, `readJson<T>(name): T`, `writeText(name, text): string`, `readText(name)`, `appendText(name, text)`, `appendEvent(event)`.
- Produces (`gates.ts`): `interface GateResult { name; command; required; exitCode: number|null; timedOut; passed; durationSec; log; outputTail }`, `class GatesInterrupted`, `runGates({ gates, repo, logDir, label, defaultTimeoutSec, maxOutputChars, bus, signal? }): Promise<GateResult[]>`, `requiredPassed(results)`, `describeGates(results, withOutput = true)`.

- [ ] **Step 1: Write the failing tests**

```ts file=test/state.test.ts
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LockError, nowIso, RunStore, slugify } from "../src/core/state.js";
import { tempDir } from "./helpers/tmp.js";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (dirs.length) dirs.pop()!.cleanup();
});
function runsDir(): string {
  const t = tempDir();
  dirs.push(t);
  return join(t.path, "runs");
}
const LIMITS = { max_planning_rounds: 4, max_review_rounds: 5 };

describe("slugify and nowIso", () => {
  it("makes ASCII slugs from any text", () => {
    expect(slugify("Thêm đăng nhập bằng JWT")).toBe("them-dang-nhap-bang-jwt");
    expect(slugify("Implement JWT authentication with refresh tokens")).toBe("implement-jwt-authentication-with-refres");
    expect(slugify("!!! ???")).toBe("task");
    expect(slugify("a".repeat(60))).toHaveLength(40);
  });

  it("formats local time with an offset", () => {
    expect(nowIso()).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  });
});

describe("RunStore", () => {
  it("creates runs with unique ids and a LATEST pointer", () => {
    const dir = runsDir();
    const now = new Date(2026, 9, 27, 13, 20, 0);
    const a = RunStore.create(dir, "Fix it", LIMITS, now);
    const b = RunStore.create(dir, "Fix it", LIMITS, now);
    expect(a.store.taskId).toBe("20261027-132000-fix-it");
    expect(b.store.taskId).toBe("20261027-132000-fix-it-2");
    expect(existsSync(join(b.store.dir, "logs"))).toBe(true);
    expect(RunStore.open(dir).taskId).toBe(b.store.taskId);
    expect(RunStore.open(dir, a.store.taskId).loadState()).toMatchObject({ task: "Fix it", phase: "PLAN", planningRound: 1, limits: { planningRounds: 4, reviewRounds: 5 } });
    expect(RunStore.list(dir).map((s) => s.taskId)).toEqual([a.store.taskId, b.store.taskId]);
  });

  it("errors for unknown runs", () => {
    const dir = runsDir();
    expect(() => RunStore.open(dir)).toThrow("no runs found");
    RunStore.create(dir, "x", LIMITS);
    expect(() => RunStore.open(dir, "nope")).toThrow("run 'nope' not found");
    expect(RunStore.list(join(dir, "missing"))).toEqual([]);
  });

  it("locks, refuses a second lock and reclaims stale locks", () => {
    const { store } = RunStore.create(runsDir(), "x", LIMITS);
    store.lock();
    expect(() => new RunStore(store.runsDir, store.taskId).lock()).toThrow(LockError);
    store.unlock();
    writeFileSync(store.path("lock"), "999999999");
    const again = new RunStore(store.runsDir, store.taskId);
    again.lock();
    again.unlock();
    expect(existsSync(store.path("lock"))).toBe(false);
  });

  it("writes atomically and updates timestamps", () => {
    const { store, state } = RunStore.create(runsDir(), "x", LIMITS);
    state.updatedAt = "old";
    store.saveState(state);
    expect(store.loadState().updatedAt).not.toBe("old");
    store.writeJson("a/b.json", { ok: 1 });
    expect(store.readJson("a/b.json")).toEqual({ ok: 1 });
    store.appendEvent({ type: "x" });
    expect(store.readText("events.jsonl")).toContain('"type":"x"');
    expect(readdirSync(store.dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});
```

```ts file=test/gates.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeGates, GatesInterrupted, requiredPassed, runGates } from "../src/core/gates.js";
import { EventBus, type DuoEvent } from "../src/events.js";
import { tempDir } from "./helpers/tmp.js";

const node = `"${process.execPath}"`;
let t: { path: string; cleanup(): void };
let bus: EventBus;
let events: DuoEvent[];
beforeEach(() => {
  t = tempDir();
  bus = new EventBus();
  events = [];
  bus.on((e) => events.push(e));
});
afterEach(() => t.cleanup());
const run = (gates: Array<{ name: string; command: string; required?: boolean; timeout_sec?: number }>, extra: { maxOutputChars?: number; signal?: AbortSignal } = {}) =>
  runGates({ gates, repo: t.path, logDir: join(t.path, "gates"), label: "r1", defaultTimeoutSec: 30, maxOutputChars: extra.maxOutputChars ?? 1000, bus, signal: extra.signal });

describe("runGates", () => {
  it("runs each gate and reports results", async () => {
    const results = await run([
      { name: "ok", command: `${node} -e "console.log('fine')"` },
      { name: "bad", command: `${node} -e "console.error('broken'); process.exit(2)"`, required: false },
    ]);
    expect(results.map((r) => [r.name, r.passed, r.exitCode, r.required])).toEqual([["ok", true, 0, true], ["bad", false, 2, false]]);
    expect(results[1]!.outputTail).toContain("broken");
    expect(readFileSync(results[1]!.log, "utf8")).toContain("[exit code: 2]");
    expect(requiredPassed(results)).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["gate.started", "gate.completed", "gate.started", "gate.completed"]);
    expect(describeGates(results)).toContain("- [FAIL] bad (optional)");
    expect(describeGates(results)).toContain("broken");
    expect(describeGates(results, false)).not.toContain("broken");
    expect(describeGates([])).toBe("(no quality gates configured)");
  });

  it("times out and truncates long output", async () => {
    const [slow] = await run([{ name: "slow", command: `${node} -e "setInterval(() => {}, 1000)"`, timeout_sec: 1 }]);
    expect(slow).toMatchObject({ timedOut: true, exitCode: null, passed: false });
    expect(describeGates([slow!])).toContain("[TIMEOUT]");
    const [loud] = await run([{ name: "loud", command: `${node} -e "console.log('x'.repeat(100))"` }], { maxOutputChars: 10 });
    expect(loud!.outputTail.startsWith("...[truncated]...")).toBe(true);
  });

  it("throws GatesInterrupted when aborted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expect(run([{ name: "slow", command: `${node} -e "setInterval(() => {}, 1000)"` }], { signal: controller.signal })).rejects.toThrow(GatesInterrupted);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/state.test.ts test/gates.test.ts`
Expected: FAIL, cannot resolve `../src/core/state.js` / `gates.js`.

- [ ] **Step 3: Implement**

```ts file=src/core/state.ts
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { PermissionDenial } from "../agents/types.js";
import type { HistoryEntry, HumanReview, Phase } from "../events.js";
import type { GateResult } from "./gates.js";
import type { Snapshot } from "./git.js";
import type { Approval, Critique, Finding } from "./outputs.js";

export const STATE_VERSION = 1;

export interface HumanNote {
  at: string;
  phase: Phase;
  note: string;
}

export interface RunState {
  version: number;
  taskId: string;
  task: string;
  phase: Phase;
  createdAt: string;
  updatedAt: string;
  limits: { planningRounds: number; reviewRounds: number };
  planningRound: number;
  planVersion: number;
  planHash: string | null;
  finalPlanVersion: number | null;
  finalPlanHash: string | null;
  planFeedback: { critique?: Critique; approval?: Approval } | null;
  implRound: number;
  base: (Snapshot & { head: string | null; branch: string | null; dirty: boolean }) | null;
  lastSnapshot: Snapshot | null;
  lastGates: GateResult[] | null;
  consecutiveGateFailures: number;
  openFindings: Finding[];
  lastImplementation: { round: number; summary: string | null; status: string | null; permissionDenials: PermissionDenial[] } | null;
  humanReview: HumanReview | null;
  humanNotes: HumanNote[];
  costUsd: number;
  tokens: number;
  step: number;
  inProgress: { phase: Phase; startedAt: string } | null;
  history: HistoryEntry[];
}

const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");

export function nowIso(d = new Date()): string {
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

function stamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function slugify(text: string, maxLen = 40): string {
  const ascii = text.replace(/đ/g, "d").replace(/Đ/g, "D").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x00-\x7f]/g, "");
  const slug = ascii.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return slug.slice(0, maxLen).replace(/-+$/, "") || "task";
}

export function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export class LockError extends Error {
  override name = "LockError";
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function newState(taskId: string, task: string, limits: { max_planning_rounds: number; max_review_rounds: number }): RunState {
  const ts = nowIso();
  return {
    version: STATE_VERSION, taskId, task, phase: "PLAN", createdAt: ts, updatedAt: ts,
    limits: { planningRounds: limits.max_planning_rounds, reviewRounds: limits.max_review_rounds },
    planningRound: 1, planVersion: 0, planHash: null, finalPlanVersion: null, finalPlanHash: null, planFeedback: null,
    implRound: 0, base: null, lastSnapshot: null, lastGates: null, consecutiveGateFailures: 0, openFindings: [],
    lastImplementation: null, humanReview: null, humanNotes: [], costUsd: 0, tokens: 0, step: 0, inProgress: null, history: [],
  };
}

/** One run's directory: state.json (rewritten atomically after every step) plus all artifacts and logs. */
export class RunStore {
  static readonly LATEST = "LATEST";
  readonly dir: string;
  private locked = false;

  constructor(readonly runsDir: string, readonly taskId: string) {
    this.dir = join(runsDir, taskId);
  }

  static create(runsDir: string, task: string, limits: { max_planning_rounds: number; max_review_rounds: number },
    now = new Date()): { store: RunStore; state: RunState } {
    const base = `${stamp(now)}-${slugify(task)}`;
    let id = base;
    for (let n = 2; existsSync(join(runsDir, id)); n++) id = `${base}-${n}`;
    const store = new RunStore(runsDir, id);
    mkdirSync(join(store.dir, "logs"), { recursive: true });
    const state = newState(id, task, limits);
    store.saveState(state);
    atomicWrite(join(runsDir, RunStore.LATEST), `${id}\n`);
    return { store, state };
  }

  static open(runsDir: string, taskId?: string): RunStore {
    let id = taskId;
    if (!id || id === "latest") {
      const latest = join(runsDir, RunStore.LATEST);
      if (!existsSync(latest)) throw new Error(`no runs found in ${runsDir}`);
      id = readFileSync(latest, "utf8").trim();
    }
    const store = new RunStore(runsDir, id);
    if (!existsSync(store.path("state.json"))) throw new Error(`run '${id}' not found in ${runsDir}`);
    return store;
  }

  static list(runsDir: string): RunState[] {
    if (!existsSync(runsDir)) return [];
    return readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(runsDir, d.name, "state.json")))
      .map((d) => d.name).sort()
      .flatMap((name) => {
        try {
          return [new RunStore(runsDir, name).loadState()];
        } catch {
          return [];
        }
      });
  }

  lock(): void {
    const path = this.path("lock");
    const take = () => {
      const fd = openSync(path, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
    };
    try {
      take();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(readFileSync(path, "utf8").trim());
      if (pid && pidAlive(pid)) throw new LockError(`run ${this.taskId} is already being processed by pid ${pid}`);
      unlinkSync(path);
      take();
    }
    this.locked = true;
  }

  unlock(): void {
    if (!this.locked) return;
    try {
      unlinkSync(this.path("lock"));
    } catch {
      // already removed
    }
    this.locked = false;
  }

  loadState(): RunState {
    const state = JSON.parse(readFileSync(this.path("state.json"), "utf8")) as RunState;
    if (state.version !== STATE_VERSION) throw new Error(`unsupported state version ${state.version}`);
    return state;
  }

  saveState(state: RunState): void {
    state.updatedAt = nowIso();
    this.writeJson("state.json", state);
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  exists(name: string): boolean {
    return existsSync(this.path(name));
  }

  writeJson(name: string, data: unknown): string {
    const path = this.path(name);
    atomicWrite(path, `${JSON.stringify(data, null, 2)}\n`);
    return path;
  }

  readJson<T = unknown>(name: string): T {
    return JSON.parse(readFileSync(this.path(name), "utf8")) as T;
  }

  writeText(name: string, text: string): string {
    const path = this.path(name);
    atomicWrite(path, text);
    return path;
  }

  readText(name: string): string {
    return readFileSync(this.path(name), "utf8");
  }

  appendText(name: string, text: string): void {
    mkdirSync(dirname(this.path(name)), { recursive: true });
    appendFileSync(this.path(name), text);
  }

  appendEvent(event: Record<string, unknown>): void {
    this.appendText("events.jsonl", `${JSON.stringify({ at: nowIso(), ...event })}\n`);
  }
}
```

```ts file=src/core/gates.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runProcess } from "../agents/process.js";
import type { EventBus } from "../events.js";
import type { GateConfig } from "./config.js";

export interface GateResult {
  name: string;
  command: string;
  required: boolean;
  exitCode: number | null;
  timedOut: boolean;
  passed: boolean;
  durationSec: number;
  log: string;
  outputTail: string;
}

export class GatesInterrupted extends Error {
  override name = "GatesInterrupted";
}

const tail = (text: string, limit: number) => (text.length <= limit ? text : `...[truncated]...\n${text.slice(-limit)}`);

/** Run the project's own checks; the orchestrator trusts these, not what the agents report. */
export async function runGates(o: {
  gates: GateConfig[]; repo: string; logDir: string; label: string; defaultTimeoutSec: number;
  maxOutputChars: number; bus: EventBus; signal?: AbortSignal;
}): Promise<GateResult[]> {
  mkdirSync(o.logDir, { recursive: true });
  const results: GateResult[] = [];
  for (const gate of o.gates) {
    const log = join(o.logDir, `${o.label}-gate-${gate.name}.log`);
    o.bus.emit({ type: "gate.started", name: gate.name, command: gate.command });
    const started = Date.now();
    const run = await runProcess(gate.command, [], {
      cwd: o.repo, shell: true, timeoutMs: (gate.timeout_sec ?? o.defaultTimeoutSec) * 1000, signal: o.signal, killGraceMs: 2000,
    });
    if (run.aborted) throw new GatesInterrupted(`gate '${gate.name}' interrupted`);
    const separator = run.stdout && run.stderr && !run.stdout.endsWith("\n") ? "\n" : "";
    const output = run.stdout + separator + run.stderr;
    const exitCode = run.timedOut ? null : run.code;
    writeFileSync(log, `$ ${gate.command}\n${output}\n[exit code: ${exitCode}]\n`);
    const result: GateResult = {
      name: gate.name, command: gate.command, required: gate.required !== false, exitCode, timedOut: run.timedOut,
      passed: exitCode === 0, durationSec: Math.round((Date.now() - started) / 10) / 100, log, outputTail: tail(output, o.maxOutputChars),
    };
    o.bus.emit({ type: "gate.completed", name: gate.name, command: gate.command, passed: result.passed, exitCode });
    results.push(result);
  }
  return results;
}

export function requiredPassed(results: GateResult[]): boolean {
  return results.every((r) => r.passed || !r.required);
}

export function describeGates(results: GateResult[], withOutput = true): string {
  if (!results.length) return "(no quality gates configured)";
  const lines: string[] = [];
  for (const r of results) {
    const verdict = r.passed ? "PASS" : r.timedOut ? "TIMEOUT" : "FAIL";
    lines.push(`- [${verdict}] ${r.name} (${r.required ? "required" : "optional"}): \`${r.command}\` exit=${r.exitCode} in ${r.durationSec}s`);
    if (withOutput && !r.passed && r.outputTail.trim()) {
      lines.push("  ```\n" + r.outputTail.split("\n").map((l) => `  ${l}`).join("\n") + "\n  ```");
    }
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/state.test.ts test/gates.test.ts && npm run typecheck`
Expected: 9 tests PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/state.ts src/core/gates.ts test/state.test.ts test/gates.test.ts
git commit -m "feat: add run store and quality gate runner

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Prompts and markdown rendering

**Files:**
- Create: `src/core/render.ts`, `src/core/prompts.ts`, `test/prompts.test.ts`, `test/render.test.ts`

**Interfaces:**
- Consumes: `describeGates`, `GateResult` (Task 9); `GateConfig` (Task 3); `RunState`, `HumanNote` (Task 9); the output types (Task 2).
- Produces (`render.ts`): `planMarkdown(plan, version)`, `issuesMarkdown(issues)`, `critiqueMarkdown(c, round, planVersion, agent)`, `approvalMarkdown(a, round, planVersion, agent)`, `findingsMarkdown(findings)`, `reportMarkdown(state, diffStat, lastReview, lastCritique, runDir)`.
- Produces (`prompts.ts`): `interface PromptContext { repo; taskId; task; gates: GateConfig[]; notes: HumanNote[] }`, `interface PlanFeedback { critique?; approval? }`, `SEVERITY_GUIDE`, `READONLY_RULES`, `planner(ctx, round, version, previousPlan, feedback)`, `planReviewer(ctx, round, version, planMd, previousCritique)`, `planFinalizer(ctx, round, version, planMd, critique)`, `implementer(ctx, round, planMd, protectedPaths, findings, review, failedGates, previousReport)`, `codeReviewer(ctx, round, planMd, base, snapshot, gateResults, diffStat, diff, truncated, previousFindings, implReport)`.

Prompt text is a verbatim port of `.orchestrator/orch/prompts.py`. The only change is the header, which names the orchestrator "agentduo".

- [ ] **Step 1: Write the failing tests**

```ts file=test/prompts.test.ts
import { describe, expect, it } from "vitest";
import type { GateResult } from "../src/core/gates.js";
import * as prompts from "../src/core/prompts.js";
import { critique, finding, impl, issue, plan, review } from "./helpers/builders.js";

const ctx: prompts.PromptContext = {
  repo: "/repo", taskId: "t1", task: "Sửa app.txt cho đúng",
  gates: [{ name: "tests", command: "npm test", required: true }, { name: "lint", command: "npm run lint", required: false }],
  notes: [{ at: "2026-10-27T13:00:00+07:00", phase: "PLAN_REVIEW", note: "use redis" }],
};
const failedGate: GateResult = { name: "tests", command: "npm test", required: true, exitCode: 1, timedOut: false, passed: false, durationSec: 1, log: "/x", outputTail: "check failed: boom" };

describe("prompts", () => {
  it("planner v1 states the role, rules, task, notes and gates", () => {
    const p = prompts.planner(ctx, 1, 1, null, null);
    expect(p.startsWith("[orchestrator-role: planner]")).toBe(true);
    for (const s of ["READ-ONLY", "Sửa app.txt cho đúng", "use redis", "- `npm test` (tests, required)", "- `npm run lint` (lint, optional)", "return `feedback_resolution` as an empty list"]) {
      expect(p).toContain(s);
    }
  });

  it("planner revisions include the previous plan and the feedback", () => {
    const c = { ...critique(false, [issue("C1", "high", "missing migration")]), proposed_changes: ["add a migration step"] };
    const p = prompts.planner(ctx, 2, 2, plan("Old plan"), { critique: c });
    for (const s of ["## Previous plan (v1) as JSON", "Old plan", "`C1` [high] missing migration", "add a migration step", "one entry per issue id"]) {
      expect(p).toContain(s);
    }
  });

  it("plan reviewer and finalizer see the plan and previous issues", () => {
    const r = prompts.planReviewer(ctx, 2, 2, "# Plan v2", critique(false, [issue("C1")]));
    expect(r).toContain("[orchestrator-role: plan_reviewer]");
    expect(r).toContain("# Plan v2");
    expect(r).toContain("Your critique from the previous round");
    const f = prompts.planFinalizer(ctx, 2, 2, "# Plan v2", critique(true, [issue("C2", "low")]));
    expect(f).toContain("[orchestrator-role: plan_finalizer]");
    expect(f).toContain("`C2` [low]");
    expect(f).toContain("`A1`");
  });

  it("implementer prompts for the first round and for fix rounds", () => {
    const first = prompts.implementer(ctx, 1, "# Final plan", [".env", ".agentduo/**"], [], null, [], null);
    for (const s of ["[orchestrator-role: implementer]", "Implement the plan now", "`.env`, `.agentduo/**`", "Chained commands"]) expect(first).toContain(s);
    const fix = prompts.implementer(ctx, 2, "# Final plan", [".env"], [finding("F1")], review(false, [finding("F1")], [], "a".repeat(40)),
      [failedGate], { summary: "did the thing" });
    for (const s of ["This is a fix round", "reviewed revision `aaaaaaaaaaaa`", "`F1` [high] `app.txt:1`", "Failing quality gates", "check failed: boom", "did the thing"]) {
      expect(fix).toContain(s);
    }
  });

  it("code reviewer sees the revision, gates, diff and previous findings", () => {
    const sha = "b".repeat(40);
    const p = prompts.codeReviewer(ctx, 2, "# Final plan", "a".repeat(40), sha, [failedGate], " app.txt | 1 +", "+fixed", true,
      [finding("F1")], impl("completed", ["F1"]));
    for (const s of [`Revision under review: \`${sha}\``, "[FAIL] tests", "TRUNCATED", "+fixed", "Implementer: fixed", `\`reviewed_commit\` must be exactly \`${sha}\``]) {
      expect(p).toContain(s);
    }
  });
});
```

```ts file=test/render.test.ts
import { describe, expect, it } from "vitest";
import { findingsMarkdown, planMarkdown, reportMarkdown } from "../src/core/render.js";
import { newState } from "../src/core/state.js";
import { finding, issue, critique, plan, review } from "./helpers/builders.js";

describe("render", () => {
  it("renders a plan with every section", () => {
    const md = planMarkdown(plan("Demo", { feedback_resolution: [{ issue_id: "C1", decision: "accepted", rationale: "ok" }] }), 2);
    for (const s of ["# Plan v2: Demo", "## Goals", "**Out of scope**", "1. **S1** write app.txt", "Files: `app.txt`", "## Acceptance criteria", "**none** — n/a", "## Response to feedback", "`C1` **accepted** — ok"]) {
      expect(md).toContain(s);
    }
  });

  it("renders finding locations", () => {
    expect(findingsMarkdown([finding("F1"), { ...finding("F2"), file: "", line: null }])).toContain("`(general)`");
    expect(findingsMarkdown([])).toBe("_(no findings)_");
  });

  it("renders a report with timeline, unresolved issues and the next step", () => {
    const st = newState("run-1", "Fix it", { max_planning_rounds: 4, max_review_rounds: 5 });
    st.phase = "HUMAN_REVIEW";
    st.humanReview = { reason: "max_review_rounds", message: "not approved after 5 rounds", fromPhase: "CODE_REVIEW", resumePhase: "IMPLEMENT", details: [], at: "now" };
    st.history.push({ step: 1, phase: "PLAN", round: 1, agent: "Codex", status: "plan created", summary: "v1", kind: "info", at: "now", artifact: null });
    st.lastImplementation = { round: 1, summary: "x", status: "completed", permissionDenials: [{ tool_name: "Bash", tool_input: { command: "curl x" } }] };
    const md = reportMarkdown(st, " app.txt | 1 +\n", review(false, [finding("F3")]), critique(false, [issue("C1")]), "/runs/run-1");
    for (const s of ["# agentduo report — run-1", "**Status:** HUMAN_REVIEW — max_review_rounds", "1. `PLAN` r1 **Codex** — plan created: v1", "## Diff stat", "[review high] `F3`", "[permission denied] Bash", "duo resume run-1 --decision resume|revise|abort"]) {
      expect(md).toContain(s);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/prompts.test.ts test/render.test.ts`
Expected: FAIL, cannot resolve `../src/core/prompts.js` / `render.js`.

- [ ] **Step 3: Implement**

```ts file=src/core/render.ts
import { describeGates } from "./gates.js";
import type { Approval, Critique, Finding, Issue, Plan, Review } from "./outputs.js";
import type { RunState } from "./state.js";

const bullets = (items: string[], empty = "_(none)_") => (items.length ? items.map((x) => `- ${x}`).join("\n") : empty);

export function planMarkdown(plan: Plan, version: number): string {
  const steps = plan.steps.map((s, i) => `${i + 1}. **${s.id}** ${s.description}`
    + (s.files.length ? `  \n   Files: ${s.files.map((f) => "`" + f + "`").join(", ")}` : "")).join("\n") || "_(none)_";
  const risks = plan.risks.map((r) => `- **${r.risk}** — ${r.mitigation}`).join("\n") || "_(none)_";
  const parts = [
    `# Plan v${version}: ${plan.title}`,
    plan.summary,
    "## Goals\n" + bullets(plan.goals),
    "## Scope\n**In scope**\n" + bullets(plan.scope_in) + "\n\n**Out of scope**\n" + bullets(plan.scope_out),
    "## Architecture\n" + (plan.architecture || "_(none)_"),
    "## Steps\n" + steps,
    "## Acceptance criteria\n" + bullets(plan.acceptance_criteria),
    "## Risks\n" + risks,
    "## Test strategy\n" + (plan.test_strategy || "_(none)_"),
    "## Open questions\n" + bullets(plan.open_questions),
  ];
  if (plan.feedback_resolution.length) {
    parts.push("## Response to feedback\n" + plan.feedback_resolution.map((f) => "- `" + f.issue_id + "` **" + f.decision + "** — " + f.rationale).join("\n"));
  }
  return parts.join("\n\n") + "\n";
}

export function issuesMarkdown(issues: Issue[]): string {
  if (!issues.length) return "_(no issues)_";
  return issues.map((i) => "- `" + i.id + "` [" + i.severity + "] " + i.description + (i.suggestion ? `  \n  Suggestion: ${i.suggestion}` : "")).join("\n");
}

export function critiqueMarkdown(c: Critique, round: number, planVersion: number, agent: string): string {
  const parts = [`## Round ${round} — ${agent} critique of plan v${planVersion}: **${c.status}**`, c.summary, "### Issues\n" + issuesMarkdown(c.issues)];
  if (c.accepted.length) parts.push("### Accepted planner responses\n" + bullets(c.accepted));
  if (c.disputed.length) parts.push("### Still disputed\n" + bullets(c.disputed));
  if (c.proposed_changes.length) parts.push("### Proposed changes\n" + bullets(c.proposed_changes));
  return parts.join("\n\n") + "\n\n";
}

export function approvalMarkdown(a: Approval, round: number, planVersion: number, agent: string): string {
  return [`## Round ${round} — ${agent} final decision on plan v${planVersion}: **${a.status}**`, a.summary, "### Issues\n" + issuesMarkdown(a.issues)].join("\n\n") + "\n\n";
}

export function findingsMarkdown(findings: Finding[]): string {
  if (!findings.length) return "_(no findings)_";
  return findings.map((f) => {
    const loc = f.file ? f.file + (f.line ? `:${f.line}` : "") : "(general)";
    return "- `" + f.id + "` [" + f.severity + "] `" + loc + "` — " + f.issue + (f.recommendation ? `  \n  Recommendation: ${f.recommendation}` : "");
  }).join("\n");
}

export function reportMarkdown(st: RunState, diffStat: string, lastReview: Review | null, lastCritique: Critique | null, runDir: string): string {
  const hr = st.humanReview;
  const lines = [
    `# agentduo report — ${st.taskId}`,
    `- **Status:** ${st.phase}` + (st.phase === "HUMAN_REVIEW" && hr ? ` — ${hr.reason}: ${hr.message}` : ""),
    `- **Task:** ${st.task}`,
    `- **Started:** ${st.createdAt} · **Updated:** ${st.updatedAt}`,
    `- **Planning rounds:** ${st.planningRound} · **Plan version:** ${st.planVersion} · **Final plan:** ${st.finalPlanVersion ? `v${st.finalPlanVersion}` : "—"}`,
    `- **Implementation rounds:** ${st.implRound}`,
    `- **Claude cost (reported):** $${(st.costUsd ?? 0).toFixed(2)} · **Codex tokens:** ${st.tokens ?? 0}`,
    "- **Run directory:** `" + runDir + "`",
  ];
  if (st.base && st.lastSnapshot) {
    lines.push("- **Diff:** `git diff " + st.base.commit.slice(0, 12) + " " + st.lastSnapshot.commit.slice(0, 12) + "` (changes are left uncommitted in your working tree)");
  }
  lines.push("\n## Timeline");
  for (const h of st.history) lines.push(`${h.step}. \`${h.phase}\` r${h.round} **${h.agent}** — ${h.status}: ${h.summary}`);
  lines.push("\n## Quality gates (last run)");
  lines.push(st.lastGates?.length ? describeGates(st.lastGates, false) : "_(not run)_");
  if (diffStat.trim()) lines.push("\n## Diff stat\n```\n" + diffStat.trimEnd() + "\n```");
  const unresolved: string[] = [];
  if (lastReview) {
    for (const f of lastReview.findings) unresolved.push(`[review ${f.severity}] \`${f.id}\` ${f.file} — ${f.issue}`);
  } else if (lastCritique && st.phase !== "DONE") {
    for (const i of lastCritique.issues) unresolved.push(`[plan ${i.severity}] \`${i.id}\` ${i.description}`);
  }
  for (const g of st.lastGates ?? []) if (!g.passed) unresolved.push(`[gate] ${g.name} failed (${g.required ? "required" : "optional"})`);
  for (const d of st.lastImplementation?.permissionDenials ?? []) {
    unresolved.push(`[permission denied] ${d.tool_name}: ${JSON.stringify(d.tool_input ?? "").slice(0, 160)}`);
  }
  lines.push("\n## Unresolved issues\n" + bullets(unresolved));
  if (st.phase === "HUMAN_REVIEW" && hr) {
    lines.push("\n## Next step\n" + hr.message + "\n\n```bash\nduo resume " + st.taskId + " --decision resume|revise|abort [--note \"...\"]\n```");
  }
  return lines.join("\n") + "\n";
}
```

```ts file=src/core/prompts.ts
import type { GateConfig } from "./config.js";
import { describeGates, type GateResult } from "./gates.js";
import type { Approval, Critique, Finding, Implementation, Plan, Review } from "./outputs.js";
import { findingsMarkdown, issuesMarkdown } from "./render.js";
import type { HumanNote } from "./state.js";

export interface PromptContext {
  repo: string;
  taskId: string;
  task: string;
  gates: GateConfig[];
  notes: HumanNote[];
}

export interface PlanFeedback {
  critique?: Critique;
  approval?: Approval;
}

export const SEVERITY_GUIDE = [
  "Severity scale:",
  "- critical: the work cannot succeed as written, or it would cause damage (data loss, security hole, broken build for everyone).",
  "- high: a significant gap or defect that must be fixed before moving on.",
  "- medium: should be fixed, but does not block.",
  "- low: minor improvement or nit.",
].join("\n");

export const READONLY_RULES =
  "## Hard rules\n" +
  "- You are READ-ONLY. Do not create, modify, move or delete any file, and do not run commands that " +
  "change the repository, its git state or the network. The orchestrator verifies the working tree " +
  "is byte-for-byte unchanged after your turn and escalates to a human if it is not.\n" +
  "- Inspect the repository as needed (read files, search, read-only git commands such as " +
  "`git log`, `git show`, `git diff <a> <b>`).\n" +
  "- Your final message must be a single JSON object matching the provided output schema. " +
  "No prose outside the JSON.\n";

function header(role: string, title: string, ctx: PromptContext): string {
  return "[orchestrator-role: " + role + "]\n" +
    "You are the **" + title + "** in an automated multi-agent software workflow driven by an orchestrator (agentduo).\n" +
    "Team: Codex designs and plans, then reviews code (never edits files). Claude Code critiques plans for " +
    "feasibility and is the only agent that edits files. Agreement between agents is not proof of " +
    "correctness: the orchestrator runs the project's quality gates independently.\n\n" +
    "- Repository: `" + ctx.repo + "`\n" +
    "- Task ID: `" + ctx.taskId + "`\n";
}

function gateList(gates: GateConfig[]): string {
  if (!gates.length) return "_(none configured)_";
  return gates.map((g) => "- `" + g.command + "` (" + g.name + ", " + (g.required === false ? "optional" : "required") + ")").join("\n");
}

function notes(list: HumanNote[]): string {
  if (!list.length) return "";
  return "\n## Notes from the human operator (highest priority)\n" + list.map((n) => `- (${n.at}, during ${n.phase}) ${n.note}`).join("\n") + "\n";
}

function feedbackSection(feedback: PlanFeedback | null): string {
  if (!feedback) return "";
  const parts = ["\n## Feedback to address"];
  const { critique, approval } = feedback;
  if (critique) {
    parts.push(`### Plan critique (status: ${critique.status})\n${critique.summary}\n\n` + issuesMarkdown(critique.issues));
    if (critique.proposed_changes.length) parts.push("Proposed changes:\n" + critique.proposed_changes.map((c) => `- ${c}`).join("\n"));
    if (critique.disputed.length) parts.push("Critic still disputes:\n" + critique.disputed.map((c) => `- ${c}`).join("\n"));
  }
  if (approval) parts.push(`### Final-approval review (status: ${approval.status})\n${approval.summary}\n\n` + issuesMarkdown(approval.issues));
  return parts.join("\n\n") + "\n";
}

export function planner(ctx: PromptContext, round: number, version: number, previousPlan: Plan | null, feedback: PlanFeedback | null): string {
  const out = [
    header("planner", "Planner / Architect", ctx),
    `- Planning round: ${round} · Producing plan version: v${version}\n`,
    "## Task\n" + ctx.task + "\n",
    notes(ctx.notes),
    READONLY_RULES,
    "## Your job\n" +
      "Study the repository and produce an implementation plan that another agent (Claude Code) can " +
      "execute without further clarification.\n" +
      "- Goals and explicit scope (in / out). Keep the scope to what the task needs.\n" +
      "- Architecture / design decisions that fit the existing code and conventions.\n" +
      "- Ordered, concrete steps; list the files each step creates or changes.\n" +
      "- Acceptance criteria that are objective and testable.\n" +
      "- Risks with mitigations, and a test strategy (which tests to add or update).\n" +
      "- Open questions only for things that truly cannot be decided from the repository; " +
      "state the assumption you made for each.\n\n" +
      "After implementation the orchestrator will run these quality gates, which must pass:\n" + gateList(ctx.gates) + "\n",
  ];
  if (!previousPlan) {
    out.push("\nThis is the first version: return `feedback_resolution` as an empty list.\n");
  } else {
    out.push(`\n## Previous plan (v${version - 1}) as JSON\n` + "```json\n" + JSON.stringify(previousPlan, null, 2) + "\n```\n");
    out.push(feedbackSection(feedback));
    out.push("\nRevise the plan to address the feedback. In `feedback_resolution`, add one entry per issue id " +
      "above with decision `accepted`, `partially_accepted` or `disputed` and a rationale. Dispute only " +
      "with a concrete technical reason; disputed critical/high issues will go back to the critic.\n");
  }
  return out.join("\n");
}

export function planReviewer(ctx: PromptContext, round: number, version: number, planMd: string, previousCritique: Critique | null): string {
  const out = [
    header("plan_reviewer", "Plan Critic", ctx),
    `- Planning round: ${round} · Plan under review: v${version}\n`,
    "## Task\n" + ctx.task + "\n",
    notes(ctx.notes),
    READONLY_RULES,
    "## Plan under review\n" + planMd + "\n",
    "## Your job\n" +
      "You will implement this plan later, so judge whether it is feasible in THIS codebase:\n" +
      "- Do the files, modules, APIs and commands it relies on actually exist and work as assumed?\n" +
      "- Missing steps, wrong ordering, hidden dependencies, migration or compatibility concerns.\n" +
      "- Are the acceptance criteria objective and testable with the quality gates below?\n" +
      "- Risks the planner missed; unnecessary scope; ambiguity that would force guessing.\n\n" +
      "Quality gates that must pass after implementation:\n" + gateList(ctx.gates) + "\n\n" +
      SEVERITY_GUIDE + "\n\n" +
      "Decision rules:\n" +
      "- Set `approved: true` and `status: \"approved\"` only if no critical or high issue remains. " +
      "Medium/low issues may accompany an approval as suggestions.\n" +
      "- Give each issue a stable id (`C1`, `C2`, ...). Reuse the same id when you re-raise an issue " +
      "from a previous round.\n" +
      "- `accepted`: planner responses (by issue id and short reason) you now agree with. `disputed`: " +
      "planner responses you still disagree with, with your reasoning; re-raise any still-blocking one " +
      "in `issues`.\n" +
      "- `proposed_changes`: concrete edits to the plan you recommend.\n",
  ];
  if (previousCritique) {
    out.push("\n## Your critique from the previous round\n" + issuesMarkdown(previousCritique.issues) +
      "\n\nCheck how the new plan version addressed each of these (see its 'Response to feedback' section).\n");
  }
  return out.join("\n");
}

export function planFinalizer(ctx: PromptContext, round: number, version: number, planMd: string, critique: Critique): string {
  return [
    header("plan_finalizer", "Planner / Architect (final plan sign-off)", ctx),
    `- Planning round: ${round} · Plan up for sign-off: v${version}\n`,
    "## Task\n" + ctx.task + "\n",
    notes(ctx.notes),
    READONLY_RULES,
    "## Plan\n" + planMd + "\n",
    "## The critic approved this version\n" + critique.summary + "\n\nRemaining suggestions:\n" + issuesMarkdown(critique.issues) + "\n",
    "## Your job\n" +
      "Confirm whether this exact plan version is final and ready for implementation. Approve " +
      "(`approved: true`, `status: \"approved\"`) unless you find a critical or high problem; then return " +
      "`changes_requested` with issues (ids `A1`, `A2`, ...) and the plan goes through another revision " +
      "round. Do not request changes for style or wording alone.\n\n" + SEVERITY_GUIDE + "\n",
  ].join("\n");
}

export function implementer(ctx: PromptContext, round: number, planMd: string, protectedPaths: string[], findings: Finding[],
  review: Review | null, failedGates: GateResult[], previousReport: { summary: string | null } | null): string {
  const out = [
    header("implementer", "Implementer", ctx),
    `- Implementation round: ${round}\n`,
    "## Task\n" + ctx.task + "\n",
    notes(ctx.notes),
    "## Final approved plan\n" + planMd + "\n",
    "## Hard rules\n" +
      "- You are the only agent allowed to edit files. Stay within the plan's scope.\n" +
      "- Never commit, push, reset, stash, switch branches or rewrite git history; the orchestrator " +
      "snapshots your changes itself and leaves them uncommitted for the human.\n" +
      "- Do not touch these protected paths: " + protectedPaths.map((p) => "`" + p + "`").join(", ") + ".\n" +
      "- Do not delete files unless the plan requires it. No network access, no deploys, no secrets.\n" +
      "- Run the quality gates yourself before finishing and fix what fails:\n" + gateList(ctx.gates) + "\n" +
      "- Shell access is an allowlist matched per command: run each check as its own Bash call, " +
      "exactly as written above. Chained commands (`;`, `&&`, `|`) do not match and are denied.\n" +
      "- If you cannot proceed (missing information, contradictory requirements, missing permissions), " +
      "stop and return `status: \"blocked\"` with a precise `blocking_reason`.\n" +
      "- Your final message must be a single JSON object matching the output schema: summary, " +
      "files_changed, tests_run (what you actually ran and whether it passed) and addressed_findings.\n",
  ];
  if (round === 1 && !findings.length && !failedGates.length) {
    out.push("\nImplement the plan now. `addressed_findings` should be an empty list.\n");
  } else {
    out.push("\n## This is a fix round\nYour previous implementation is already in the working tree. " +
      "Address the problems below without redoing unrelated work.\n");
    if (findings.length) {
      const sha = review ? review.reviewed_commit.slice(0, 12) : "?";
      out.push("### Code review findings (reviewed revision `" + sha + "`)\n" + (review ? review.summary + "\n\n" : "") +
        findingsMarkdown(findings) + "\n\nFor every finding id, add an entry to `addressed_findings`: `fixed`, " +
        "`not_applicable`, or `disputed` with a concrete technical justification.\n");
    }
    if (failedGates.length) out.push("### Failing quality gates (run by the orchestrator)\n" + describeGates(failedGates) + "\n");
    if (previousReport?.summary) out.push("### Your previous report\n" + previousReport.summary + "\n");
  }
  return out.join("\n");
}

export function codeReviewer(ctx: PromptContext, round: number, planMd: string, base: string, snapshot: string, gateResults: GateResult[],
  diffStat: string, diff: string, truncated: boolean, previousFindings: Finding[], implReport: Implementation): string {
  const tests = implReport.tests_run.map((t) => "- `" + t.command + "` passed=" + t.passed + " " + t.notes).join("\n") || "_(none)_";
  const out = [
    header("code_reviewer", "Code Reviewer", ctx),
    `- Review round: ${round}\n` +
      "- Revision under review: `" + snapshot + "` (orchestrator snapshot of the working tree)\n" +
      "- Base revision: `" + base + "`\n",
    "## Task\n" + ctx.task + "\n",
    notes(ctx.notes),
    READONLY_RULES,
    "## Final approved plan\n" + planMd + "\n",
    "## Quality gate results (authoritative, run by the orchestrator on this revision)\n" + describeGates(gateResults) + "\n",
    "## Implementer's report\n" + implReport.summary + "\n\nTests the implementer says it ran:\n" + tests + "\n",
    "## Diff stat (base → revision)\n```\n" + (diffStat.trimEnd() || "(no changes)") + "\n```\n",
    "## Diff" + (truncated ? " (TRUNCATED: run `git diff " + base + " " + snapshot + "` for the full diff)" : "") + "\n```diff\n" + diff + "\n```\n",
  ];
  if (previousFindings.length) {
    const responses = new Map(implReport.addressed_findings.map((a) => [a.finding_id, a]));
    const lines = previousFindings.map((f) => {
      const r = responses.get(f.id);
      const reply = r ? `${r.resolution}: ${r.notes}` : "no response";
      return "- `" + f.id + "` [" + f.severity + "] " + f.file + " — " + f.issue + "  \n  Implementer: " + reply;
    });
    out.push("## Findings from the previous review and the implementer's responses\n" + lines.join("\n") +
      "\n\nVerify each one against the new revision. List ids that are now resolved in `resolved_findings`; " +
      "re-raise unresolved ones in `findings` with the same id. Accept a dispute only if the justification is technically sound.\n");
  }
  out.push(
    "## Your job\n" +
    "Review the change against the plan and its acceptance criteria: correctness, edge cases, error " +
    "handling, security, test adequacy, scope creep, and consistency with the codebase's conventions. " +
    "The working tree currently equals the revision under review, so you may read files directly.\n\n" +
    SEVERITY_GUIDE + "\n\n" +
    "Decision rules:\n" +
    "- Approve (`approved: true`, `status: \"approved\"`) only if there is no critical or high finding, " +
    "the acceptance criteria are met and the required quality gates pass.\n" +
    "- `reviewed_commit` must be exactly `" + snapshot + "`.\n" +
    "- New finding ids continue the sequence `F1`, `F2`, ...; `file` is repo-relative (empty string if " +
    "general) and `line` may be null.\n");
  return out.join("\n");
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/prompts.test.ts test/render.test.ts && npm run typecheck`
Expected: 8 tests PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/render.ts src/core/prompts.ts test/prompts.test.ts test/render.test.ts
git commit -m "feat: port role prompts and markdown reports

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Workflow state machine

**Files:**
- Create: `src/core/workflow.ts`, `test/helpers/harness.ts`, `test/workflow.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–10: `AgentRunner`/`AgentResult`, `Git`, `checkChanges`, `checkGitPosition`, `runGates`, `requiredPassed`, `GatesInterrupted`, `prompts.*`, `render.*`, `RunStore`, `RunState`, `nowIso`, `EventBus`, `Decider`, `Message`, `HistoryEntry`, `ConfigData`.
- Produces: `EXIT = { DONE: 0, ERROR: 1, HUMAN_REVIEW: 2, ABORTED: 3, INTERRUPTED: 130 }`, `class DecisionError`, `interface WorkflowOptions { cfg; repo; store; state; bus; decider; allowDirty?; runner? }`, and `class Workflow` with:
  - `state` (getter);
  - `run(): Promise<number>`, which emits `run.started` … `run.finished`;
  - `applyDecision(decision, note?): Promise<void>`, which throws `DecisionError` when no decision is pending;
  - `requestStop()`: graceful, takes effect after the current step;
  - `interrupt()`: aborts the running agent or gate;
  - `writeReport(): Promise<string>`.
- Behavior: a 1:1 port of `.orchestrator/orch/workflow.py` (same phases, escalation reasons, resume semantics, artifact names, and `refs/agentduo/...` snapshot refs). In addition:
  - each step emits a `message` (spec §6 table) and then a `step.completed`;
  - `HUMAN_REVIEW` asks the `Decider` in-process, where `"defer"` returns exit 2;
  - interrupts return exit 130 and leave `inProgress` set, so the step re-runs.
- Produces (tests): `ScriptedDecider(answers)` (records `seen` reasons), `makeHarness(repo, cfg)`, `newWorkflow(h, task, decider?) → { wf, bus }`, `resumedWorkflow(h, opts?)`, `resume(h, decision?, opts?)`, `stateOf(h)`, `runDirOf(h)`.

- [ ] **Step 1: Write the harness and the failing e2e tests**

```ts file=test/helpers/harness.ts
import { join } from "node:path";
import type { ConfigData } from "../../src/core/config.js";
import { RunStore, type RunState } from "../../src/core/state.js";
import { Workflow } from "../../src/core/workflow.js";
import { EventBus, type Decider, type Decision, type DuoEvent, type HumanReview } from "../../src/events.js";

export class ScriptedDecider implements Decider {
  readonly seen: string[] = [];
  constructor(private readonly answers: Array<Decision | "defer"> = []) {}
  async decide(review: HumanReview): Promise<Decision | "defer"> {
    this.seen.push(review.reason);
    return this.answers.shift() ?? "defer";
  }
}

export interface Harness {
  repo: string;
  cfg: ConfigData;
  runsDir: string;
  events: DuoEvent[];
}

export function makeHarness(repo: string, cfg: ConfigData): Harness {
  return { repo, cfg, runsDir: join(repo, ".agentduo", "runs"), events: [] };
}

function busFor(h: Harness): EventBus {
  const bus = new EventBus();
  bus.on((e) => h.events.push(e));
  return bus;
}

export function newWorkflow(h: Harness, task: string, decider: Decider = new ScriptedDecider()): { wf: Workflow; bus: EventBus } {
  const bus = busFor(h);
  const { store, state } = RunStore.create(h.runsDir, task, h.cfg.limits);
  return { wf: new Workflow({ cfg: h.cfg, repo: h.repo, store, state, bus, decider }), bus };
}

export function resumedWorkflow(h: Harness, opts: { decider?: Decider; allowDirty?: boolean } = {}): { wf: Workflow; bus: EventBus } {
  const bus = busFor(h);
  const store = RunStore.open(h.runsDir);
  const wf = new Workflow({ cfg: h.cfg, repo: h.repo, store, state: store.loadState(), bus, decider: opts.decider ?? new ScriptedDecider(), allowDirty: opts.allowDirty });
  return { wf, bus };
}

export async function resume(h: Harness, decision?: Decision, opts: { decider?: Decider; allowDirty?: boolean } = {}): Promise<number> {
  const { wf } = resumedWorkflow(h, opts);
  if (decision) await wf.applyDecision(decision.decision, decision.note);
  return wf.run();
}

export const stateOf = (h: Harness): RunState => RunStore.open(h.runsDir).loadState();
export const runDirOf = (h: Harness): string => RunStore.open(h.runsDir).dir;
```

```ts file=test/workflow.test.ts
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "../src/events.js";
import { approval, critique, finding, impl, issue, plan, review } from "./helpers/builders.js";
import { testConfig, type ConfigOverrides } from "./helpers/config.js";
import { FakeClis } from "./helpers/fake-clis.js";
import { makeHarness, newWorkflow, resume, resumedWorkflow, runDirOf, ScriptedDecider, stateOf, type Harness } from "./helpers/harness.js";
import { git, makeRepo } from "./helpers/repo.js";
import { tempDir } from "./helpers/tmp.js";

let t: { path: string; cleanup(): void };
let fake: FakeClis;
let h: Harness;
let head: string;

beforeEach(() => {
  t = tempDir();
  const repo = makeRepo(t.path);
  fake = new FakeClis(t.path).install();
  h = makeHarness(repo, testConfig(fake));
  head = git(repo, "rev-parse", "HEAD");
});
afterEach(() => {
  fake.restore();
  t.cleanup();
});

type Scenario = Record<string, unknown[]>;
function start(scenario: Scenario, overrides?: ConfigOverrides, opts: { task?: string; decider?: ScriptedDecider } = {}): Promise<number> {
  fake.setScenario(scenario);
  if (overrides) h.cfg = testConfig(fake, overrides);
  return newWorkflow(h, opts.task ?? "Make app.txt fixed", opts.decider).wf.run();
}
const happy = (): Scenario => ({
  planner: [{ output: plan() }],
  plan_reviewer: [{ output: critique(true) }],
  plan_finalizer: [{ output: approval(true) }],
  implementer: [{ write: { "app.txt": "fixed\n" }, output: impl() }],
  code_reviewer: [{ output: review(true) }],
});
const messages = (): Message[] => h.events.flatMap((e) => (e.type === "message" ? [e.message] : []));
const readRun = (name: string) => readFileSync(join(runDirOf(h), name), "utf8");

describe("Workflow", () => {
  it("debates the plan, fixes gate failures and review findings, then reaches DONE", async () => {
    const code = await start({
      planner: [{ output: plan("v1") }, { output: plan("v2", { feedback_resolution: [{ issue_id: "C1", decision: "accepted", rationale: "ok" }] }) }],
      plan_reviewer: [
        { activities: [{ tool: "Read", input: { file_path: join(h.repo, "check.mjs") } }], output: critique(false, [issue("C1")]) },
        { output: critique(true) },
      ],
      plan_finalizer: [{ output: approval(true) }],
      implementer: [
        { write: { "app.txt": "buggy\n" }, output: impl() },
        { write: { "app.txt": "fixed\n" }, output: impl() },
        { write: { "app.txt": "fixed\nedge case handled\n" }, output: impl("completed", ["F1"]) },
      ],
      code_reviewer: [{ output: review(false, [finding("F1")]) }, { output: review(true, [], ["F1"]) }],
    });
    expect(code).toBe(0);
    const st = stateOf(h);
    expect(st.phase).toBe("DONE");
    expect([st.planningRound, st.planVersion, st.finalPlanVersion, st.implRound]).toEqual([2, 2, 2, 3]);
    expect(st.openFindings).toEqual([]);
    expect(st.history.map((x) => `${x.phase}:${x.status}`)).toEqual([
      "PLAN:plan created", "PLAN_REVIEW:changes requested", "PLAN:plan revised", "PLAN_REVIEW:approved", "PLAN_FINALIZE:plan finalized",
      "IMPLEMENT:completed", "VERIFY:failed",
      "IMPLEMENT:completed", "VERIFY:passed", "CODE_REVIEW:changes requested",
      "IMPLEMENT:completed", "VERIFY:passed", "CODE_REVIEW:approved",
    ]);
    expect(git(h.repo, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(h.repo, "app.txt"), "utf8")).toBe("fixed\nedge case handled\n");
    const refs = git(h.repo, "for-each-ref", "--format=%(refname)", "refs/agentduo");
    expect(refs).toContain("/base");
    expect(refs).toContain("/impl-r3");
    for (const name of ["plan.md", "plan.final.md", "plan-feedback.md", "review.json", "report.md", "plan.v1.json", "critique.r1.json", "implementation.r3.json", "gates.r1.json"]) {
      expect(existsSync(join(runDirOf(h), name)), name).toBe(true);
    }
    const envelope = JSON.parse(readRun("review.json"));
    for (const key of ["task_id", "round", "timestamp", "git_sha", "plan_version"]) expect(envelope).toHaveProperty(key);
    expect(envelope.output.reviewed_commit).toBe(st.lastSnapshot!.commit);
    expect(readRun("report.md")).toContain("**Status:** DONE");
    expect(messages().map((m) => `${m.from}>${m.to}:${m.kind}`)).toEqual([
      "codex>claude:plan", "claude>codex:critique", "codex>claude:plan", "claude>codex:critique", "codex>claude:approval",
      "claude>codex:implementation", "gates>claude:gates",
      "claude>codex:implementation", "gates>codex:gates", "codex>claude:review",
      "claude>codex:implementation", "gates>codex:gates", "codex>claude:review",
    ]);
    expect(h.events.some((e) => e.type === "agent.activity" && e.role === "plan_reviewer" && e.activity.label === "Read  check.mjs")).toBe(true);
    const implCalls = fake.calls("implementer");
    expect(implCalls[1]!.prompt).toContain("Failing quality gates");
    expect(implCalls[1]!.prompt).toContain("check failed");
    expect(implCalls[2]!.prompt).toContain("`F1`");
    expect(fake.calls("planner")[1]!.prompt).toContain("C1");
    expect(fake.calls("code_reviewer")[1]!.prompt).toContain("`F1`");
  });

  it("runs each role with its CLI permissions", async () => {
    await start(happy());
    for (const role of ["planner", "plan_finalizer", "code_reviewer"]) {
      const args = fake.calls(role)[0]!.args;
      expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
      expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    }
    const critic = fake.calls("plan_reviewer")[0]!.args;
    expect(critic[critic.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(critic[critic.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    const implementer = fake.calls("implementer")[0]!.args;
    expect(implementer[implementer.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(implementer).toContain("Bash(git push*)");
    expect(implementer.some((a) => a.startsWith("Bash(") && a.includes("check.mjs"))).toBe(true);
  });

  it("escalates after max planning rounds; resume implements the latest plan", async () => {
    expect(await start({ ...happy(), plan_reviewer: [{ output: critique(false, [issue("C1")]) }] }, { limits: { max_planning_rounds: 2 } })).toBe(2);
    let st = stateOf(h);
    expect([st.phase, st.humanReview?.reason, st.planVersion]).toEqual(["HUMAN_REVIEW", "max_planning_rounds", 2]);
    expect(existsSync(join(runDirOf(h), "report.md"))).toBe(true);
    expect(h.events.some((e) => e.type === "human.required")).toBe(true);
    expect(await resume(h, { decision: "resume", note: "C1 is acceptable, go ahead" })).toBe(0);
    st = stateOf(h);
    expect([st.phase, st.finalPlanVersion]).toEqual(["DONE", 2]);
    expect(readRun("plan.final.md")).toContain("accepted by the human operator");
    expect(fake.calls("implementer")[0]!.prompt).toContain("C1 is acceptable");
  });

  it("revise re-plans with the operator's note", async () => {
    await start({ ...happy(), plan_reviewer: [{ output: critique(false, [issue("C1")]) }, { output: critique(false, [issue("C1")]) }, { output: critique(true) }] },
      { limits: { max_planning_rounds: 2 } });
    expect(await resume(h, { decision: "revise", note: "drop the cache layer" })).toBe(0);
    const st = stateOf(h);
    expect([st.phase, st.planningRound]).toEqual(["DONE", 3]);
    expect(fake.calls("planner")[2]!.prompt).toContain("drop the cache layer");
  });

  it("escalates when a read-only agent writes, and re-runs the step after a revert", async () => {
    expect(await start({ ...happy(), planner: [{ write: { "sneaky.txt": "x" }, output: plan() }, { output: plan() }] })).toBe(2);
    const st = stateOf(h);
    expect(st.humanReview?.reason).toBe("readonly_violation");
    expect(st.humanReview?.details.join(" ")).toContain("sneaky.txt");
    expect(st.planVersion).toBe(0);
    unlinkSync(join(h.repo, "sneaky.txt"));
    expect(await resume(h, { decision: "resume" })).toBe(0);
  });

  it("retries invalid output", async () => {
    await start({
      ...happy(),
      plan_reviewer: [{ raw: "I think the plan is fine!" }, { output: critique(true) }],
      plan_finalizer: [{ output: { ...approval(true), status: "changes_requested" } }, { output: approval(true) }],
      code_reviewer: [{ output: review(true, [], [], "0".repeat(40)) }, { output: review(true) }],
    });
    expect(stateOf(h).phase).toBe("DONE");
    for (const name of ["critique.r1.json", "approval.r1.json", "review.r1.json"]) expect(JSON.parse(readRun(name)).attempts, name).toBe(2);
    const retry = fake.calls("code_reviewer")[1]!.prompt;
    expect(retry).toContain("Previous attempt was rejected");
    expect(retry).toContain("reviewed_commit");
    expect(h.events.filter((e) => e.type === "agent.retry")).toHaveLength(3);
  });

  it("escalates an agent that keeps failing", async () => {
    expect(await start({ planner: [{ raw: "not json" }] })).toBe(2);
    const st = stateOf(h);
    expect([st.humanReview?.reason, st.humanReview?.resumePhase]).toEqual(["agent_error", "PLAN"]);
    expect(fake.calls("planner")).toHaveLength(2);
  });

  it("stops on a critical finding; resume starts a fix round", async () => {
    const scenario = {
      ...happy(),
      implementer: [{ write: { "app.txt": "fixed\n" }, output: impl() }, { write: { "app.txt": "fixed safely\n" }, output: impl("completed", ["F1"]) }],
      code_reviewer: [{ output: review(false, [finding("F1", "critical")]) }, { output: review(true, [], ["F1"]) }],
    };
    expect(await start(scenario)).toBe(2);
    expect(stateOf(h).humanReview?.reason).toBe("critical_finding");
    expect(await resume(h, { decision: "resume" })).toBe(0);
    expect(stateOf(h).implRound).toBe(2);
  });

  it("treats protected paths and commits by the implementer as guard violations", async () => {
    const scenario = { ...happy(), implementer: [{ write: { "app.txt": "fixed\n", ".env": "TOKEN=1\n" }, shell: ["git add app.txt && git commit -qm sneaky"], output: impl() }] };
    expect(await start(scenario)).toBe(2);
    const hr = stateOf(h).humanReview!;
    expect(hr.reason).toBe("guard_violation");
    expect(hr.details.join(" ")).toContain(".env");
    expect(hr.details.join(" ")).toContain("HEAD moved");
  });

  it("escalates when the implementer is blocked", async () => {
    expect(await start({ ...happy(), implementer: [{ output: impl("blocked", [], "API key needed") }] })).toBe(2);
    const hr = stateOf(h).humanReview!;
    expect([hr.reason, hr.message]).toEqual(["implementer_blocked", "API key needed"]);
  });

  it("escalates when required gates keep failing, without spending reviews", async () => {
    expect(await start({ ...happy(), implementer: [{ write: { "app.txt": "still broken\n" }, output: impl() }] }, { limits: { max_consecutive_gate_failures: 2 } })).toBe(2);
    const st = stateOf(h);
    expect([st.humanReview?.reason, st.implRound]).toEqual(["gates_failing", 2]);
    expect(fake.calls("code_reviewer")).toHaveLength(0);
  });

  it("escalates after max review rounds; abort ends the run", async () => {
    const scenario = { ...happy(), implementer: [{ write: { "app.txt": "fixed\n" }, output: impl("completed", ["F1"]) }], code_reviewer: [{ output: review(false, [finding("F1")]) }] };
    expect(await start(scenario, { limits: { max_review_rounds: 2 } })).toBe(2);
    const st = stateOf(h);
    expect([st.humanReview?.reason, st.implRound]).toEqual(["max_review_rounds", 2]);
    expect(readRun("report.md")).toContain("`F1`");
    expect(await resume(h, { decision: "abort" })).toBe(3);
    expect(stateOf(h).phase).toBe("ABORTED");
  });

  it("can pause for the human before implementing", async () => {
    expect(await start(happy(), { safety: { pause_before_implement: true } })).toBe(2);
    expect(stateOf(h).humanReview?.reason).toBe("plan_ready");
    expect(fake.calls("implementer")).toHaveLength(0);
    expect(await resume(h, { decision: "resume" })).toBe(0);
  });

  it("does not block DONE on medium findings and reports them", async () => {
    expect(await start({ ...happy(), plan_reviewer: [{ output: critique(true, [issue("C1", "low")]) }], code_reviewer: [{ output: review(true, [finding("F1", "medium")]) }] })).toBe(0);
    expect(readRun("report.md")).toContain("F1");
  });

  it("asks the Decider in-process and continues without exiting", async () => {
    const decider = new ScriptedDecider([{ decision: "resume", note: "go" }]);
    const code = await start({ ...happy(), plan_reviewer: [{ output: critique(false, [issue("C1")]) }] }, { limits: { max_planning_rounds: 1 } }, { decider });
    expect(code).toBe(0);
    expect(decider.seen).toEqual(["max_planning_rounds"]);
    expect(messages().some((m) => m.from === "human" && m.headline.includes("go"))).toBe(true);
  });

  it("stops cleanly after the current step when asked", async () => {
    fake.setScenario(happy());
    const { wf, bus } = newWorkflow(h, "Make app.txt fixed");
    bus.on((e) => {
      if (e.type === "step.completed" && e.entry.phase === "PLAN") wf.requestStop();
    });
    expect(await wf.run()).toBe(130);
    const st = stateOf(h);
    expect([st.phase, st.inProgress]).toEqual(["PLAN_REVIEW", null]);
    expect(h.events.at(-1)).toMatchObject({ type: "run.finished", phase: "INTERRUPTED", exitCode: 130 });
    expect(await resume(h)).toBe(0);
  });

  it("interrupts a running agent and re-runs that step on resume", async () => {
    fake.setScenario({ ...happy(), implementer: [{ sleep: 10_000, output: impl() }, { write: { "app.txt": "fixed\n" }, output: impl() }] });
    const { wf, bus } = newWorkflow(h, "Make app.txt fixed");
    bus.on((e) => {
      if (e.type === "phase.started" && e.phase === "IMPLEMENT") setTimeout(() => wf.interrupt(), 300);
    });
    expect(await wf.run()).toBe(130);
    expect(stateOf(h).inProgress?.phase).toBe("IMPLEMENT");
    expect(await resume(h)).toBe(0);
    expect(fake.calls("implementer")).toHaveLength(2);
  });

  it("keeps non-ASCII task text in prompts and uses an ASCII run id", async () => {
    expect(await start(happy(), undefined, { task: "Sửa app.txt cho đúng" })).toBe(0);
    expect(stateOf(h).taskId).toMatch(/-sua-app-txt-cho-dung$/);
    expect(fake.calls("planner")[0]!.prompt).toContain("Sửa app.txt cho đúng");
  });

  it("refuses to implement on a dirty tree unless allowed", async () => {
    writeFileSync(join(h.repo, "README.md"), "local edit\n");
    expect(await start(happy())).toBe(2);
    expect(stateOf(h).humanReview?.reason).toBe("dirty_worktree");
    expect(await resume(h, { decision: "resume" }, { allowDirty: true })).toBe(0);
    expect(stateOf(h).base?.dirty).toBe(true);
  });

  it("rejects decisions when none is pending", async () => {
    await start(happy());
    const { wf } = resumedWorkflow(h);
    await expect(wf.applyDecision("resume")).rejects.toThrow("not waiting for a decision");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/workflow.test.ts`
Expected: FAIL, cannot resolve `../../src/core/workflow.js`.

- [ ] **Step 3: Implement**

```ts file=src/core/workflow.ts
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { AgentRunner, type AgentResult } from "../agents/runner.js";
import type { SchemaName } from "../agents/schema.js";
import type { Decider, DuoEvent, EventBus, HistoryEntry, Message, Party, Phase, Role } from "../events.js";
import type { AgentRole, ConfigData } from "./config.js";
import { GatesInterrupted, requiredPassed, runGates, type GateResult } from "./gates.js";
import { Git } from "./git.js";
import { checkChanges, checkGitPosition } from "./guards.js";
import type { Approval, Critique, Finding, Implementation, Issue, Plan, Review } from "./outputs.js";
import * as prompts from "./prompts.js";
import * as render from "./render.js";
import { nowIso, type RunState, type RunStore } from "./state.js";

export const EXIT = { DONE: 0, ERROR: 1, HUMAN_REVIEW: 2, ABORTED: 3, INTERRUPTED: 130 } as const;

// "--decision resume" after an escalation raised in these phases starts a new implementation round;
// from anywhere else it re-runs the same round.
const NEW_ROUND_FROM: Phase[] = ["VERIFY", "CODE_REVIEW"];
const IMPL_PHASES: Phase[] = ["IMPLEMENT", "VERIFY", "CODE_REVIEW"];
const PHASE_ROLES: Partial<Record<Phase, { role: Role; agentRole: AgentRole }>> = {
  PLAN: { role: "planner", agentRole: "planner" },
  PLAN_REVIEW: { role: "plan_reviewer", agentRole: "plan_reviewer" },
  PLAN_FINALIZE: { role: "plan_finalizer", agentRole: "planner" },
  IMPLEMENT: { role: "implementer", agentRole: "implementer" },
  CODE_REVIEW: { role: "code_reviewer", agentRole: "code_reviewer" },
};
const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

class Interrupted extends Error {}

export class DecisionError extends Error {
  override name = "DecisionError";
}

export interface WorkflowOptions {
  cfg: ConfigData;
  repo: string;
  store: RunStore;
  state: RunState;
  bus: EventBus;
  decider: Decider;
  allowDirty?: boolean;
  runner?: AgentRunner;
}

function relativeInside(path: string, root: string): string | null {
  const rel = relative(resolve(root), resolve(path));
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split("\\").join("/") : null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const planHash = (plan: Plan) => createHash("sha256").update(stableStringify(plan)).digest("hex");

function consistentStatus(d: { approved: boolean; status: string }): string[] {
  return d.approved !== (d.status === "approved") ? [`'approved' (${d.approved}) contradicts 'status' ('${d.status}')`] : [];
}

const bySeverity = <T extends { severity: string }>(xs: T[]) =>
  [...xs].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
const issueItems = (issues: Issue[]) => bySeverity(issues).map((i) => `[${i.severity}] ${i.id} ${i.description}`);
const findingItems = (findings: Finding[]) =>
  bySeverity(findings).map((f) => `[${f.severity}] ${f.id} ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} ` : ""}${f.issue}`);

function lastLine(text: string): string {
  const line = text.trim().split("\n").filter((l) => l.trim()).at(-1) ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

export class Workflow {
  private readonly git: Git;
  private readonly runner: AgentRunner;
  private readonly snapshotExclude: string[];
  private readonly dirtyExclude: string[];
  private readonly allowDirty: boolean;
  private readonly abort = new AbortController();
  private stopRequested = false;
  private phaseStartedAt = Date.now();

  constructor(private readonly o: WorkflowOptions) {
    this.git = new Git(o.repo);
    this.runner = o.runner ?? new AgentRunner(o.cfg, o.repo, o.store.path("logs"), o.bus);
    const runsRel = relativeInside(o.store.runsDir, o.repo);
    this.snapshotExclude = runsRel ? [runsRel] : [];
    this.dirtyExclude = [".agentduo", ...this.snapshotExclude.filter((p) => !p.startsWith(".agentduo"))];
    this.allowDirty = !!o.allowDirty || o.cfg.safety.allow_dirty_worktree;
  }

  get state(): RunState {
    return this.o.state;
  }

  /** Stop cleanly after the step that is running now; the run stays resumable. */
  requestStop(): void {
    this.stopRequested = true;
  }

  /** Kill the running agent or gate now; that step re-runs on resume. */
  interrupt(): void {
    this.abort.abort();
  }

  // ------------------------------------------------------------------ loop
  async run(): Promise<number> {
    const st = this.state;
    this.emit({ type: "run.started", runId: st.taskId, task: st.task, repo: this.o.repo, runDir: this.o.store.dir });
    if (st.inProgress) this.emit({ type: "warning", text: `previous run was interrupted during ${st.inProgress.phase}; re-running it` });
    for (;;) {
      const phase = st.phase;
      if (phase === "DONE") return this.finish("DONE", EXIT.DONE);
      if (phase === "ABORTED") return this.finish("ABORTED", EXIT.ABORTED);
      if (phase === "HUMAN_REVIEW") {
        st.inProgress = null;
        this.save();
        await this.writeReport();
        const review = st.humanReview!;
        this.emit({ type: "human.required", runId: st.taskId, review });
        const answer = await this.o.decider.decide(review);
        if (answer === "defer") return this.finish("HUMAN_REVIEW", EXIT.HUMAN_REVIEW);
        await this.applyDecision(answer.decision, answer.note);
        continue;
      }
      if (this.stopRequested) return this.finish("INTERRUPTED", EXIT.INTERRUPTED);
      st.inProgress = { phase, startedAt: nowIso() };
      this.save();
      this.phaseStartedAt = Date.now();
      this.emitPhaseStarted(phase);
      try {
        await this.handler(phase)();
      } catch (err) {
        if (err instanceof Interrupted || this.abort.signal.aborted) return this.finish("INTERRUPTED", EXIT.INTERRUPTED);
        const e = err as Error;
        this.o.store.writeText(`logs/error-step${String(st.step + 1).padStart(3, "0")}.txt`, e.stack ?? String(e));
        this.escalate("orchestrator_error", `${e.name}: ${e.message}`, phase);
      }
      st.inProgress = null;
      this.save();
    }
  }

  private handler(phase: Phase): () => Promise<void> {
    switch (phase) {
      case "PLAN": return () => this.stepPlan();
      case "PLAN_REVIEW": return () => this.stepPlanReview();
      case "PLAN_FINALIZE": return () => this.stepPlanFinalize();
      case "IMPLEMENT": return () => this.stepImplement();
      case "VERIFY": return () => this.stepVerify();
      case "CODE_REVIEW": return () => this.stepCodeReview();
      default: throw new Error(`no handler for phase ${phase}`);
    }
  }

  private async finish(phase: "DONE" | "ABORTED" | "HUMAN_REVIEW" | "INTERRUPTED", exitCode: number): Promise<number> {
    if (phase !== "INTERRUPTED") this.state.inProgress = null;
    this.save();
    const reportPath = await this.writeReport();
    this.emit({ type: "run.finished", runId: this.state.taskId, phase, reportPath, exitCode });
    return exitCode;
  }

  // --------------------------------------------------------------- helpers
  private emit(event: DuoEvent): void {
    this.o.bus.emit(event);
  }

  private save(): void {
    this.o.store.saveState(this.state);
  }

  private ctx(): prompts.PromptContext {
    const st = this.state;
    return { repo: this.o.repo, taskId: st.taskId, task: st.task, gates: this.o.cfg.gates, notes: st.humanNotes };
  }

  private party(role: AgentRole): Party {
    return this.o.cfg.agents[role];
  }

  private agentName(role: AgentRole): string {
    return this.o.cfg.agents[role] === "codex" ? "Codex" : "Claude";
  }

  private logPrefix(label: string, round: number): string {
    return `${String(this.state.step + 1).padStart(3, "0")}-${label}-r${round}`;
  }

  private ref(name: string): string {
    return `refs/agentduo/${this.state.taskId}/${name}`;
  }

  private tree(): Promise<string> {
    return this.git.worktreeTree(this.snapshotExclude);
  }

  private emitPhaseStarted(phase: Phase): void {
    const st = this.state;
    const info = PHASE_ROLES[phase];
    this.emit({
      type: "phase.started", step: st.step + 1, phase,
      round: IMPL_PHASES.includes(phase) ? Math.max(st.implRound, 1) : st.planningRound,
      role: info?.role, agent: phase === "VERIFY" ? "gates" : info ? this.party(info.agentRole) : undefined,
      planning: { round: st.planningRound, limit: st.limits.planningRounds },
      impl: { round: st.implRound, limit: st.limits.reviewRounds },
    });
  }

  private record(phase: Phase, round: number, agent: string, status: string, summary: string,
    kind: HistoryEntry["kind"] = "info", artifact: string | null = null, usage?: AgentResult): void {
    const st = this.state;
    st.step += 1;
    const entry: HistoryEntry = { step: st.step, phase, round, agent, status, summary, kind, at: nowIso(), artifact };
    st.history.push(entry);
    this.o.store.appendEvent({ type: "step", ...entry });
    this.emit({
      type: "step.completed", entry, durationSec: (Date.now() - this.phaseStartedAt) / 1000,
      costUsd: usage?.costUsd ?? undefined, tokens: usage?.tokens ?? undefined,
    });
  }

  private message(m: Message): void {
    this.emit({ type: "message", message: m });
  }

  private escalate(reason: string, message: string, resumePhase: Phase, details: string[] = []): void {
    const st = this.state;
    const fromPhase = st.phase;
    st.humanReview = { reason, message, fromPhase, resumePhase, details, at: nowIso() };
    st.phase = "HUMAN_REVIEW";
    this.record("HUMAN_REVIEW", IMPL_PHASES.includes(fromPhase) ? st.implRound : st.planningRound, "orchestrator", reason, message, "warn");
  }

  private async envelope(role: Role, round: number, r: AgentResult, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const st = this.state;
    return {
      task_id: st.taskId, role, agent: r.backend, round, timestamp: nowIso(), git_sha: await this.git.head(),
      plan_version: st.planVersion, attempts: r.attempts, duration_sec: Math.round(r.durationSec * 10) / 10,
      cost_usd: r.costUsd, tokens: r.tokens, meta: r.meta, ...extra, output: r.data,
    };
  }

  private addUsage(r: AgentResult): void {
    const st = this.state;
    if (r.costUsd) st.costUsd = Math.round((st.costUsd + r.costUsd) * 10000) / 10000;
    if (r.tokens) st.tokens += r.tokens;
  }

  private blocking<T extends { severity: string }>(issues: T[]): T[] {
    const severities = new Set(this.o.cfg.quality_gates.blocking_severities);
    return issues.filter((i) => severities.has(i.severity));
  }

  private lastCritique(beforeRound: number): Critique | null {
    for (let r = beforeRound - 1; r >= 1; r--) {
      const name = `critique.r${r}.json`;
      if (this.o.store.exists(name)) return this.o.store.readJson<{ output: Critique }>(name).output;
    }
    return null;
  }

  /**
   * Run a read-only role and verify, independently of the agent's own sandbox, that the working tree and
   * git position did not change.
   */
  private async readonlyCall<T>(role: Role, agentRole: AgentRole, label: string, prompt: string, schemaName: SchemaName,
    round: number, check?: (data: T) => string[]): Promise<AgentResult | null> {
    const beforeTree = await this.tree();
    const beforePos = await this.git.position();
    const r = await this.runner.call({ role, agentRole, prompt, schemaName, logPrefix: this.logPrefix(label, round), check, signal: this.abort.signal });
    this.addUsage(r);
    if (r.interrupted) throw new Interrupted();
    const afterTree = await this.tree();
    const violations = checkGitPosition(beforePos, await this.git.position());
    if (afterTree !== beforeTree) {
      const changed = await this.git.nameStatus(beforeTree, afterTree);
      violations.unshift(`working tree changed during a read-only step: ${changed.slice(0, 20).map(([s, p]) => `${s} ${p}`).join(", ")}`);
    }
    const who = `${role} (${r.backend})`;
    if (violations.length) {
      this.escalate("readonly_violation", `${who} changed the repository although it must be read-only. Inspect and revert the changes, then resume to re-run this step.`,
        this.state.phase, violations);
      return null;
    }
    if (!r.ok) {
      this.escalate("agent_error", `${who} failed after ${r.attempts} attempt(s): ${r.error}`, this.state.phase);
      return null;
    }
    return r;
  }

  // -------------------------------------------------------------- planning
  private async stepPlan(): Promise<void> {
    const st = this.state;
    const { store } = this.o;
    const r = st.planningRound;
    const v = st.planVersion + 1;
    const previous = v > 1 ? store.readJson<{ output: Plan }>(`plan.v${v - 1}.json`).output : null;
    const prompt = prompts.planner(this.ctx(), r, v, previous, st.planFeedback);
    const check = (p: Plan) => (["goals", "scope_in", "steps", "acceptance_criteria"] as const).filter((k) => p[k].length === 0).map((k) => `'${k}' must not be empty`);
    const res = await this.readonlyCall<Plan>("planner", "planner", "plan", prompt, "plan", r, check);
    if (!res) return;
    const plan = res.data as Plan;
    store.writeJson(`plan.v${v}.json`, await this.envelope("planner", r, res, { plan_version: v }));
    const md = render.planMarkdown(plan, v);
    store.writeText(`plan.v${v}.md`, md);
    store.writeText("plan.md", md);
    st.planVersion = v;
    st.planHash = planHash(plan);
    this.message({
      from: this.party("planner"), to: this.party("plan_reviewer"), kind: "plan",
      headline: `Plan v${v} "${plan.title}" · ${plan.steps.length} steps · ${plan.acceptance_criteria.length} criteria · ${plan.risks.length} risks`,
      items: plan.feedback_resolution.map((f) => `${f.issue_id} ${f.decision}: ${f.rationale}`), artifact: `plan.v${v}.md`,
    });
    this.record("PLAN", r, this.agentName("planner"), v === 1 ? "plan created" : "plan revised",
      `v${v} '${plan.title}' (${plan.steps.length} steps, ${plan.acceptance_criteria.length} acceptance criteria, ${plan.risks.length} risks)`,
      "info", `plan.v${v}.md`, res);
    st.phase = "PLAN_REVIEW";
  }

  private async stepPlanReview(): Promise<void> {
    const st = this.state;
    const { store, cfg } = this.o;
    const r = st.planningRound;
    const v = st.planVersion;
    const prompt = prompts.planReviewer(this.ctx(), r, v, store.readText(`plan.v${v}.md`), this.lastCritique(r));
    const res = await this.readonlyCall<Critique>("plan_reviewer", "plan_reviewer", "plan_review", prompt, "plan_critique", r, consistentStatus);
    if (!res) return;
    const critique = res.data as Critique;
    store.writeJson(`critique.r${r}.json`, await this.envelope("plan_reviewer", r, res));
    store.appendText("plan-feedback.md", render.critiqueMarkdown(critique, r, v, this.agentName("plan_reviewer")));
    const blocking = this.blocking(critique.issues);
    const approved = critique.approved && blocking.length === 0;
    if (critique.approved && blocking.length) this.emit({ type: "warning", text: "the critic approved but raised blocking issues; treating as changes requested" });
    this.message({
      from: this.party("plan_reviewer"), to: this.party("planner"), kind: "critique",
      headline: approved ? `approved${critique.issues.length ? ` · ${critique.issues.length} suggestion(s)` : ""}` : `changes requested · ${blocking.length} blocking`,
      items: issueItems(critique.issues), artifact: `critique.r${r}.json`,
    });
    this.record("PLAN_REVIEW", r, this.agentName("plan_reviewer"), approved ? "approved" : "changes requested",
      `${critique.issues.length} issue(s), ${blocking.length} blocking`, approved ? "ok" : "warn", `critique.r${r}.json`, res);
    if (!approved) {
      st.planFeedback = { critique };
      this.nextPlanningRound();
    } else if (cfg.quality_gates.require_plan_approval) {
      st.phase = "PLAN_FINALIZE";
    } else {
      this.freezePlan(v);
    }
  }

  private async stepPlanFinalize(): Promise<void> {
    const st = this.state;
    const { store } = this.o;
    const r = st.planningRound;
    const v = st.planVersion;
    const critique = store.readJson<{ output: Critique }>(`critique.r${r}.json`).output;
    const prompt = prompts.planFinalizer(this.ctx(), r, v, store.readText(`plan.v${v}.md`), critique);
    const res = await this.readonlyCall<Approval>("plan_finalizer", "planner", "plan_finalize", prompt, "plan_approval", r, consistentStatus);
    if (!res) return;
    const approval = res.data as Approval;
    store.writeJson(`approval.r${r}.json`, await this.envelope("plan_finalizer", r, res));
    store.appendText("plan-feedback.md", render.approvalMarkdown(approval, r, v, this.agentName("planner")));
    const blocking = this.blocking(approval.issues);
    const approved = approval.approved && blocking.length === 0;
    this.message({
      from: this.party("planner"), to: this.party("implementer"), kind: "approval",
      headline: approved ? `plan finalized v${v}` : `changes requested · ${blocking.length} blocking`,
      items: issueItems(approval.issues), artifact: `approval.r${r}.json`,
    });
    this.record("PLAN_FINALIZE", r, this.agentName("planner"), approved ? "plan finalized" : "changes requested",
      `v${v}: ${approval.summary.slice(0, 120)}`, approved ? "ok" : "warn", `approval.r${r}.json`, res);
    if (approved) {
      this.freezePlan(v);
    } else {
      st.planFeedback = { critique, approval };
      this.nextPlanningRound();
    }
  }

  private nextPlanningRound(): void {
    const st = this.state;
    if (st.planningRound >= st.limits.planningRounds) {
      this.escalate("max_planning_rounds",
        `no agreed plan after ${st.planningRound} planning round(s). Read plan.md and plan-feedback.md, then 'resume' to implement ` +
        "the latest plan as-is, or 'revise' with a --note that settles the disagreement.", "IMPLEMENT");
      return;
    }
    st.planningRound += 1;
    st.phase = "PLAN";
  }

  private freezePlan(version: number, byHuman = false): void {
    const st = this.state;
    const { store, cfg } = this.o;
    st.finalPlanVersion = version;
    st.finalPlanHash = st.planHash;
    const header = `<!-- final plan v${version}, sha256 ${st.planHash}${byHuman ? ", accepted by the human operator" : ""} -->\n`;
    store.writeText("plan.final.md", header + store.readText(`plan.v${version}.md`));
    if (st.base !== null) {
      // Re-planned after implementation started: continue in a new round.
      st.implRound += 1;
      st.openFindings = [];
      this.ensureReviewBudget();
    }
    if (cfg.safety.pause_before_implement && !byHuman) {
      this.escalate("plan_ready", `final plan v${version} is ready for your review (${store.path("plan.final.md")}). Resume to start implementation.`, "IMPLEMENT");
      return;
    }
    st.phase = "IMPLEMENT";
  }

  // -------------------------------------------------------- implementation
  private ensureReviewBudget(): void {
    const st = this.state;
    if (st.implRound > st.limits.reviewRounds) st.limits.reviewRounds = st.implRound + this.o.cfg.limits.max_review_rounds - 1;
  }

  private nextImplRound(): void {
    const st = this.state;
    if (st.implRound >= st.limits.reviewRounds) {
      this.escalate("max_review_rounds",
        `not approved after ${st.implRound} implementation round(s). Inspect review.json and the working tree, then 'resume' for ` +
        "more fix rounds (optionally with a --note), 'revise' to re-plan, or 'abort'.", "IMPLEMENT");
      return;
    }
    st.implRound += 1;
    st.phase = "IMPLEMENT";
  }

  private async stepImplement(): Promise<void> {
    const st = this.state;
    const { store, cfg } = this.o;
    if (st.base === null) {
      const dirty = await this.git.statusPorcelain(this.dirtyExclude);
      if (dirty.length && !this.allowDirty) {
        this.escalate("dirty_worktree",
          `the working tree has ${dirty.length} uncommitted change(s). Commit or stash them, then resume (or resume with --allow-dirty ` +
          "to let the implementer work on top of them).", "IMPLEMENT", dirty.slice(0, 20));
        return;
      }
      const base = await this.git.snapshot(this.snapshotExclude, this.ref("base"), `agentduo ${st.taskId}: base`);
      st.base = { commit: base.commit, tree: base.tree, head: await this.git.head(), branch: await this.git.branch(), dirty: dirty.length > 0 };
      st.implRound = Math.max(st.implRound, 1);
    }
    const k = st.implRound;
    const protectedPaths = [...cfg.safety.protected_paths];
    const pre = await this.git.snapshot(this.snapshotExclude, this.ref(`impl-r${k}-pre`), `agentduo ${st.taskId}: before implementation round ${k}`);
    const beforePos = await this.git.position();
    const review = store.exists("review.json") ? store.readJson<{ output: Review }>("review.json").output : null;
    const failed = k > 1 ? (st.lastGates ?? []).filter((g) => !g.passed) : [];
    const prompt = prompts.implementer(this.ctx(), k, store.readText("plan.final.md"), protectedPaths, st.openFindings, review, failed, st.lastImplementation);
    const check = (rep: Implementation) =>
      rep.status === "blocked" && !(rep.blocking_reason ?? "").trim() ? ["status is 'blocked' but blocking_reason is empty"] : [];
    const res = await this.runner.call({
      role: "implementer", agentRole: "implementer", prompt, schemaName: "implementation", logPrefix: this.logPrefix("implement", k),
      check, extraAllowed: cfg.gates.map((g) => `Bash(${g.command}*)`), signal: this.abort.signal,
    });
    this.addUsage(res);
    const post = await this.git.snapshot(this.snapshotExclude, this.ref(`impl-r${k}`), `agentduo ${st.taskId}: implementation round ${k}`);
    st.lastSnapshot = { commit: post.commit, tree: post.tree };
    if (res.interrupted) throw new Interrupted();
    const changes = await this.git.nameStatus(pre.tree, post.tree);
    const violations = [...checkGitPosition(beforePos, await this.git.position()), ...checkChanges(changes, protectedPaths, cfg.safety.max_deleted_files)];
    const denials = res.meta.permissionDenials ?? [];
    const report = res.data as Implementation | null;
    const answered = new Set((report?.addressed_findings ?? []).map((a) => a.finding_id));
    const missing = report ? st.openFindings.filter((f) => !answered.has(f.id)).map((f) => f.id) : [];
    store.writeJson(`implementation.r${k}.json`, await this.envelope("implementer", k, res, {
      pre_snapshot: pre.commit, snapshot: post.commit, changes: changes.map(([status, path]) => ({ status, path })),
      violations, unanswered_findings: missing,
    }));
    st.lastImplementation = { round: k, summary: report?.summary ?? null, status: report?.status ?? null, permissionDenials: denials };
    if (!res.ok || !report) {
      this.escalate("agent_error", `implementer (${res.backend}) failed after ${res.attempts} attempt(s): ${res.error}`, "IMPLEMENT");
      return;
    }
    if (violations.length) {
      this.escalate("guard_violation",
        `the implementer broke a safety rule. Inspect the working tree; the state before this round is pinned at ${this.ref(`impl-r${k}-pre`)} ` +
        `(${pre.commit.slice(0, 12)}). Resume to accept the changes and continue with the quality gates, or abort.`, "VERIFY", violations);
      return;
    }
    this.message({
      from: this.party("implementer"), to: this.party("code_reviewer"), kind: "implementation",
      headline: report.status === "blocked" ? `blocked: ${report.blocking_reason}` : `completed · ${changes.length} file(s) changed`,
      items: [
        ...report.addressed_findings.map((a) => `${a.finding_id} ${a.resolution}${a.notes ? `: ${a.notes}` : ""}`),
        ...changes.slice(0, 10).map(([s, p]) => `${s} ${p}`),
      ],
      artifact: `implementation.r${k}.json`,
    });
    this.record("IMPLEMENT", k, this.agentName("implementer"), report.status, `${changes.length} file(s) changed; ${report.summary.slice(0, 140)}`,
      report.status === "completed" ? "ok" : "warn", `implementation.r${k}.json`, res);
    if (missing.length) this.emit({ type: "warning", text: `implementer did not respond to finding(s): ${missing.join(", ")}` });
    if (denials.length) this.emit({ type: "warning", text: `${denials.length} tool call(s) were denied by permissions (see implementation.r${k}.json)` });
    if (report.status === "blocked") {
      this.escalate("implementer_blocked", report.blocking_reason ?? "implementer reported blocked", "IMPLEMENT");
      return;
    }
    st.phase = "VERIFY";
  }

  private async stepVerify(): Promise<void> {
    const st = this.state;
    const { store, cfg } = this.o;
    const k = st.implRound;
    let results: GateResult[];
    try {
      results = await runGates({
        gates: cfg.gates, repo: this.o.repo, logDir: store.path("gates"), label: `r${k}`, defaultTimeoutSec: cfg.limits.gate_timeout_sec,
        maxOutputChars: cfg.limits.max_gate_output_chars, bus: this.o.bus, signal: this.abort.signal,
      });
    } catch (e) {
      if (e instanceof GatesInterrupted) throw new Interrupted();
      throw e;
    }
    const tree = await this.tree();
    if (tree !== st.lastSnapshot!.tree) {
      const changed = await this.git.nameStatus(st.lastSnapshot!.tree, tree);
      this.emit({ type: "warning", text: `quality gates modified the working tree: ${changed.slice(0, 10).map(([s, p]) => `${s} ${p}`).join(", ")} (re-snapshotting)` });
      const snap = await this.git.snapshot(this.snapshotExclude, this.ref(`impl-r${k}`), `agentduo ${st.taskId}: round ${k} after gates`);
      st.lastSnapshot = { commit: snap.commit, tree: snap.tree };
    }
    store.writeJson(`gates.r${k}.json`, { round: k, snapshot: st.lastSnapshot!.commit, timestamp: nowIso(), results });
    st.lastGates = results;
    const passed = requiredPassed(results);
    st.consecutiveGateFailures = passed ? 0 : st.consecutiveGateFailures + 1;
    const enforce = cfg.quality_gates.require_tests_pass;
    const toReviewer = passed || !enforce || cfg.quality_gates.review_on_gate_failure;
    this.message({
      from: "gates", to: toReviewer ? this.party("code_reviewer") : this.party("implementer"), kind: "gates",
      headline: results.map((g) => (g.passed ? `${g.name} ✓` : `${g.name} ✗ (${g.timedOut ? "timeout" : `exit ${g.exitCode}`})`)).join(" · ") || "no gates",
      items: results.filter((g) => !g.passed).map((g) => `${g.name}: ${lastLine(g.outputTail)}`), artifact: `gates.r${k}.json`,
    });
    this.record("VERIFY", k, "gates", passed ? "passed" : "failed", results.map((g) => `${g.name} ${g.passed ? "PASS" : "FAIL"}`).join(", ") || "no gates",
      passed ? "ok" : "warn", `gates.r${k}.json`);
    if (!passed && enforce) {
      const limit = cfg.limits.max_consecutive_gate_failures;
      if (st.consecutiveGateFailures >= limit) {
        this.escalate("gates_failing", `required quality gates failed ${limit} round(s) in a row. Check the logs under gates/, then resume (optionally with a --note) or abort.`, "IMPLEMENT");
        return;
      }
      if (!cfg.quality_gates.review_on_gate_failure) {
        this.nextImplRound(); // back to the implementer without spending a review
        return;
      }
    }
    st.phase = "CODE_REVIEW";
  }

  private async stepCodeReview(): Promise<void> {
    const st = this.state;
    const { store, cfg } = this.o;
    const k = st.implRound;
    const base = st.base!.commit;
    const snap = st.lastSnapshot!.commit;
    const diff = await this.git.diff(base, snap);
    const maxChars = cfg.limits.max_diff_chars;
    const implReport = store.readJson<{ output: Implementation }>(`implementation.r${k}.json`).output;
    const prompt = prompts.codeReviewer(this.ctx(), k, store.readText("plan.final.md"), base, snap, st.lastGates ?? [],
      await this.git.diffStat(base, snap), diff.slice(0, maxChars), diff.length > maxChars, st.openFindings, implReport);
    const check = (rv: Review) => {
      const errors = consistentStatus(rv);
      if (rv.reviewed_commit !== snap) errors.push(`reviewed_commit is '${rv.reviewed_commit}', expected '${snap}'`);
      return errors;
    };
    const res = await this.readonlyCall<Review>("code_reviewer", "code_reviewer", "code_review", prompt, "review", k, check);
    if (!res) return;
    const review = res.data as Review;
    const envelope = await this.envelope("code_reviewer", k, res, { base, snapshot: snap });
    store.writeJson(`review.r${k}.json`, envelope);
    store.writeJson("review.json", envelope);
    st.openFindings = review.findings;
    const blocking = this.blocking(review.findings);
    const critical = review.findings.filter((f) => f.severity === "critical");
    const gatesOk = requiredPassed(st.lastGates ?? []) || !cfg.quality_gates.require_tests_pass;
    const approved = review.approved || !cfg.quality_gates.require_codex_approval;
    const done = approved && blocking.length === 0 && gatesOk;
    if (review.approved && blocking.length) this.emit({ type: "warning", text: "the reviewer approved but reported blocking findings; continuing with a fix round" });
    this.message({
      from: this.party("code_reviewer"), to: this.party("implementer"), kind: "review",
      headline: done
        ? `approved${review.findings.length ? ` · ${review.findings.length} non-blocking finding(s)` : ""}`
        : `${review.findings.length} finding(s) · ${blocking.length} blocking${gatesOk ? "" : " · required gates failing"}`,
      items: findingItems(review.findings), artifact: `review.r${k}.json`,
    });
    this.record("CODE_REVIEW", k, this.agentName("code_reviewer"), done ? "approved" : "changes requested",
      `${review.findings.length} finding(s), ${blocking.length} blocking${gatesOk ? "" : ", required gates failing"}`, done ? "ok" : "warn", `review.r${k}.json`, res);
    if (done) {
      st.phase = "DONE";
      return;
    }
    if (critical.length && cfg.quality_gates.stop_on_critical_issue) {
      this.escalate("critical_finding",
        `the reviewer reported critical finding(s): ${critical.map((f) => `${f.id} ${f.issue}`).join("; ")}. Inspect them, then resume to let the ` +
        "implementer fix them, revise, or abort.", "IMPLEMENT");
      return;
    }
    this.nextImplRound();
  }

  // ---------------------------------------------------------- human review
  async applyDecision(decision: "resume" | "revise" | "abort", note?: string): Promise<void> {
    const st = this.state;
    if (st.phase !== "HUMAN_REVIEW" || !st.humanReview) throw new DecisionError(`run ${st.taskId} is not waiting for a decision (phase ${st.phase})`);
    const hr = st.humanReview;
    if (note) st.humanNotes.push({ at: nowIso(), phase: hr.fromPhase, note });
    if (decision === "abort") {
      st.phase = "ABORTED";
    } else if (decision === "revise") {
      if (IMPL_PHASES.includes(hr.fromPhase)) st.planFeedback = null; // planning-era critique is stale; the note drives the revision
      st.finalPlanVersion = null;
      st.finalPlanHash = null;
      st.planningRound += 1;
      st.limits.planningRounds = Math.max(st.limits.planningRounds, st.planningRound + this.o.cfg.limits.max_planning_rounds - 1);
      st.phase = "PLAN";
    } else {
      const target = hr.resumePhase;
      if (target === "IMPLEMENT" && st.finalPlanVersion === null) {
        if (!st.planVersion) throw new DecisionError("there is no plan yet; use --decision revise");
        this.freezePlan(st.planVersion, true);
      } else if (target === "IMPLEMENT" && NEW_ROUND_FROM.includes(hr.fromPhase)) {
        st.implRound += 1;
        this.ensureReviewBudget();
      }
      st.consecutiveGateFailures = 0;
      st.phase = target;
    }
    st.humanReview = null;
    this.message({ from: "human", to: "orchestrator", kind: "decision", headline: `${decision}${note ? ` · "${note}"` : ""}`, items: [] });
    this.record("HUMAN_REVIEW", st.implRound || st.planningRound, "human", decision, note || `after ${hr.reason}`);
    this.save();
  }

  // ---------------------------------------------------------------- report
  async writeReport(): Promise<string> {
    const st = this.state;
    const { store } = this.o;
    const lastReview = store.exists("review.json") ? store.readJson<{ output: Review }>("review.json").output : null;
    let diffStat = "";
    if (st.base && st.lastSnapshot) {
      try {
        diffStat = await this.git.diffStat(st.base.commit, st.lastSnapshot.commit);
      } catch {
        diffStat = "";
      }
    }
    return store.writeText("report.md", render.reportMarkdown(st, diffStat, lastReview, this.lastCritique(st.planningRound + 1), store.dir));
  }
}
```

- [ ] **Step 4: Run the e2e tests, then the whole suite and typecheck**

Run: `npx vitest run test/workflow.test.ts && npm test && npm run typecheck`
Expected: 20 workflow tests PASS; the full suite PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/workflow.ts test/helpers/harness.ts test/workflow.test.ts
git commit -m "feat: port the orchestration state machine with events and in-process decisions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: `duo init` gate detection and `duo doctor` checks

**Files:**
- Create: `src/core/init.ts`, `src/core/doctor.ts`, `test/init.test.ts`, `test/doctor.test.ts`

**Interfaces:**
- Consumes: `runProcess` (Task 5), `resolveBinary` (Task 7), `SCHEMA_NAMES`/`loadSchema`/`strictProblems` (Task 2), `ConfigData` (Task 3), `Git` (Task 4).
- Produces (`init.ts`): `interface DetectedGate { name; command; reason }`, `detectGates(repo): DetectedGate[]`, `renderConfigYaml(gates): string`, `interface InitResult { configPath; created; gitignoreUpdated; gates }`, `initRepo(repo): InitResult`.
- Produces (`doctor.ts`): `interface Check { ok; required; message }`, `runDoctor({ repo, cfg, sources, configError?, env? }): Promise<Check[]>`.

- [ ] **Step 1: Write the failing tests**

```ts file=test/init.test.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { detectGates, initRepo, renderConfigYaml } from "../src/core/init.js";
import { makeRepo } from "./helpers/repo.js";
import { tempDir } from "./helpers/tmp.js";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (dirs.length) dirs.pop()!.cleanup();
});
function tmp(): string {
  const t = tempDir();
  dirs.push(t);
  return t.path;
}

describe("detectGates", () => {
  it("finds package scripts and uses the project's package manager", () => {
    const dir = tmp();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run", lint: "eslint .", "type-check": "tsc" } }));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    expect(detectGates(dir).map((g) => [g.name, g.command])).toEqual([["test", "pnpm run test"], ["lint", "pnpm run lint"], ["typecheck", "pnpm run type-check"]]);
  });

  it("skips npm's placeholder test script", () => {
    const dir = tmp();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(detectGates(dir)).toEqual([]);
  });

  it("detects Python, Go, Rust and make", () => {
    const dir = tmp();
    for (const name of ["pyproject.toml", "go.mod", "Cargo.toml"]) writeFileSync(join(dir, name), "");
    writeFileSync(join(dir, "Makefile"), "build:\n\techo build\ntest:\n\techo ok\n");
    expect(detectGates(dir).map((g) => g.name)).toEqual(["pytest", "go-test", "cargo-test", "make-test"]);
  });
});

describe("initRepo", () => {
  it("writes a config that loads, ignores run data, and is idempotent", () => {
    const parent = tmp();
    const repo = makeRepo(parent, { ignoreRuns: false });
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    expect(initRepo(repo)).toMatchObject({ created: true, gitignoreUpdated: true });
    expect(loadConfig({ repo, env: { XDG_CONFIG_HOME: join(parent, "xdg") } }).data.gates).toEqual([{ name: "test", command: "npm run test", required: true }]);
    expect(initRepo(repo)).toMatchObject({ created: false, gitignoreUpdated: false });
    expect(readFileSync(join(repo, ".gitignore"), "utf8").match(/\.agentduo\/runs\//g)).toHaveLength(1);
  });

  it("renders a valid placeholder when nothing is detected", () => {
    const yaml = renderConfigYaml([]);
    expect(yaml).toContain("gates: []");
    expect(yaml).toContain("None were detected");
  });
});
```

```ts file=test/doctor.test.ts
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/core/doctor.js";
import { testConfig } from "./helpers/config.js";
import { FakeClis } from "./helpers/fake-clis.js";
import { makeRepo } from "./helpers/repo.js";
import { tempDir } from "./helpers/tmp.js";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (dirs.length) dirs.pop()!.cleanup();
});

describe("runDoctor", () => {
  it("passes with working CLIs and config", async () => {
    const t = tempDir();
    dirs.push(t);
    const repo = makeRepo(t.path);
    const checks = await runDoctor({ repo, cfg: testConfig(new FakeClis(t.path)), sources: ["repo.yaml"] });
    expect(checks.filter((c) => !c.ok && c.required)).toEqual([]);
    const text = checks.map((c) => c.message).join("\n");
    for (const s of ["codex CLI:", "codex-fake 1.0.0", "claude supports --output-format", "schema review", ".agentduo/runs/ is git-ignored", "config: repo.yaml"]) {
      expect(text).toContain(s);
    }
  });

  it("reports missing CLIs, missing flags and config errors", async () => {
    const t = tempDir();
    dirs.push(t);
    const repo = makeRepo(t.path);
    const cfg = testConfig(new FakeClis(t.path));
    cfg.codex.bin = join(t.path, "missing");
    const oldClaude = join(t.path, "old-claude");
    writeFileSync(oldClaude, "#!/bin/sh\necho claude 0.1\n");
    chmodSync(oldClaude, 0o755);
    cfg.claude.bin = oldClaude;
    const checks = await runDoctor({ repo, cfg, sources: [], configError: "bad gates" });
    expect(checks.find((c) => c.message.startsWith("codex CLI not found"))?.ok).toBe(false);
    expect(checks.find((c) => c.message.startsWith("claude supports"))?.message).toContain("missing: --output-format");
    expect(checks.find((c) => c.message.startsWith("config:"))).toMatchObject({ ok: false, message: "config: bad gates" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/init.test.ts test/doctor.test.ts`
Expected: FAIL, cannot resolve `../src/core/init.js` / `doctor.js`.

- [ ] **Step 3: Implement**

```ts file=src/core/init.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DetectedGate {
  name: string;
  command: string;
  reason: string;
}

export interface InitResult {
  configPath: string;
  created: boolean;
  gitignoreUpdated: boolean;
  gates: DetectedGate[];
}

const read = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);

function packageManager(repo: string): "npm" | "pnpm" | "yarn" | "bun" {
  if (existsSync(join(repo, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repo, "yarn.lock"))) return "yarn";
  if (existsSync(join(repo, "bun.lockb")) || existsSync(join(repo, "bun.lock"))) return "bun";
  return "npm";
}

export function detectGates(repo: string): DetectedGate[] {
  const gates: DetectedGate[] = [];
  const pkg = read(join(repo, "package.json"));
  if (pkg) {
    let scripts: Record<string, unknown> = {};
    try {
      scripts = JSON.parse(pkg).scripts ?? {};
    } catch {
      // unreadable package.json: no script gates
    }
    const pm = packageManager(repo);
    const wanted: Array<[string, string[]]> = [["test", ["test"]], ["lint", ["lint"]], ["typecheck", ["typecheck", "type-check"]]];
    for (const [name, candidates] of wanted) {
      const script = candidates.find((c) => typeof scripts[c] === "string");
      if (!script) continue;
      if (script === "test" && /no test specified/.test(String(scripts.test))) continue;
      gates.push({ name, command: `${pm} run ${script}`, reason: `package.json script "${script}"` });
    }
  }
  if (existsSync(join(repo, "pyproject.toml")) || existsSync(join(repo, "pytest.ini")) || (read(join(repo, "setup.cfg"))?.includes("[tool:pytest]") ?? false)) {
    gates.push({ name: "pytest", command: "python3 -m pytest", reason: "Python project (pyproject.toml / pytest.ini / setup.cfg)" });
  }
  if (existsSync(join(repo, "go.mod"))) gates.push({ name: "go-test", command: "go test ./...", reason: "go.mod" });
  if (existsSync(join(repo, "Cargo.toml"))) gates.push({ name: "cargo-test", command: "cargo test", reason: "Cargo.toml" });
  const makefile = read(join(repo, "Makefile"));
  if (makefile && /^test\s*:/m.test(makefile)) gates.push({ name: "make-test", command: "make test", reason: "Makefile target 'test'" });
  return gates;
}

export function renderConfigYaml(gates: DetectedGate[]): string {
  const lines = [
    "# agentduo configuration for this repository.",
    "# Every key is optional; anything not set here uses the built-in defaults (run `duo doctor` to check).",
    "",
    "# Quality gates: commands agentduo runs itself after every implementation round.",
  ];
  if (gates.length) {
    lines.push("gates:");
    for (const g of gates) lines.push(`  - name: ${g.name}`, `    command: ${JSON.stringify(g.command)}   # detected: ${g.reason}`, "    required: true");
  } else {
    lines.push(
      "# None were detected. Add your test/lint/typecheck commands, for example:",
      "#   - name: tests",
      '#     command: "npm test"',
      "#     required: true",
      "gates: []",
    );
  }
  lines.push("", "# limits:", "#   max_planning_rounds: 4", "#   max_review_rounds: 5", "# safety:", "#   pause_before_implement: false",
    "# codex:", "#   model: null", "# claude:", "#   model: null", "#   max_budget_usd: null", "");
  return lines.join("\n");
}

const IGNORE_LINES = [".agentduo/runs/", ".agentduo/runs", "/.agentduo/runs/", ".agentduo/", ".agentduo", "/.agentduo/"];

export function initRepo(repo: string): InitResult {
  const configPath = join(repo, ".agentduo", "config.yaml");
  const gates = detectGates(repo);
  let created = false;
  if (!existsSync(configPath)) {
    mkdirSync(join(repo, ".agentduo"), { recursive: true });
    writeFileSync(configPath, renderConfigYaml(gates));
    created = true;
  }
  const gitignore = join(repo, ".gitignore");
  const current = read(gitignore) ?? "";
  let gitignoreUpdated = false;
  if (!current.split(/\r?\n/).some((line) => IGNORE_LINES.includes(line.trim()))) {
    writeFileSync(gitignore, `${current}${current && !current.endsWith("\n") ? "\n" : ""}.agentduo/runs/\n`);
    gitignoreUpdated = true;
  }
  return { configPath, created, gitignoreUpdated, gates };
}
```

```ts file=src/core/doctor.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runProcess } from "../agents/process.js";
import { resolveBinary } from "../agents/resolve.js";
import { loadSchema, SCHEMA_NAMES, strictProblems } from "../agents/schema.js";
import type { ConfigData } from "./config.js";
import { Git } from "./git.js";

export interface Check {
  ok: boolean;
  required: boolean;
  message: string;
}

const REQUIRED_FLAGS = {
  codex: { args: ["exec", "--help"], flags: ["--json", "--output-schema", "--sandbox", "--output-last-message", "--cd"] },
  claude: { args: ["--help"], flags: ["--output-format", "--verbose", "--json-schema", "--permission-mode", "--permission-prompts", "--tools", "--allowedTools", "--disallowedTools"] },
} as const;

async function probe(bin: string, args: readonly string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await runProcess(bin, [...args], { cwd, timeoutMs: 60_000 });
    return { ok: r.code === 0, out: r.stdout + r.stderr };
  } catch (e) {
    return { ok: false, out: (e as Error).message };
  }
}

function firstToken(command: string): string {
  const m = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
}

/** Environment checks for `duo doctor`. Never calls a model. */
export async function runDoctor(o: { repo: string; cfg: ConfigData; sources: string[]; configError?: string; env?: NodeJS.ProcessEnv }): Promise<Check[]> {
  const env = o.env ?? process.env;
  const checks: Check[] = [];
  const add = (ok: boolean, message: string, required = true) => checks.push({ ok, required, message });

  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  add(major > 22 || (major === 22 && minor >= 12), `node ${process.versions.node} (>= 22.12)`);
  const gitVersion = await probe("git", ["--version"], o.repo);
  add(gitVersion.ok, gitVersion.ok ? gitVersion.out.trim() : "git is not installed");
  const git = new Git(o.repo);
  const isRepo = await git.isRepo();
  add(isRepo, `git repository: ${o.repo}`);
  add(!o.configError, o.configError ? `config: ${o.configError}` : `config: ${o.sources.length ? o.sources.join(", ") : "built-in defaults"}`);
  for (const name of SCHEMA_NAMES) {
    const problems = strictProblems(loadSchema(name));
    add(!problems.length, `schema ${name}${problems.length ? `: ${problems.join("; ")}` : ""}`);
  }
  for (const backend of ["codex", "claude"] as const) {
    if (!Object.values(o.cfg.agents).includes(backend)) continue;
    const bin = resolveBinary(o.cfg[backend].bin, backend, env);
    if (!bin) {
      add(false, `${backend} CLI not found (bin: '${o.cfg[backend].bin}')`);
      continue;
    }
    const version = await probe(bin, ["--version"], o.repo);
    add(version.ok, `${backend} CLI: ${bin} (${version.out.trim().split("\n")[0] || "?"})`);
    const spec = REQUIRED_FLAGS[backend];
    const help = await probe(bin, spec.args, o.repo);
    const missing = spec.flags.filter((f) => !help.out.includes(f));
    add(help.ok && !missing.length, `${backend} supports ${spec.flags.join(", ")}${missing.length ? ` — missing: ${missing.join(", ")}` : ""}`);
  }
  if (!o.cfg.gates.length) add(!o.cfg.quality_gates.require_tests_pass, "no quality gates configured (run 'duo init')");
  for (const gate of o.cfg.gates) {
    const exe = firstToken(gate.command);
    const found = !!exe && (resolveBinary(exe, "codex", env) !== null || existsSync(join(o.repo, exe)));
    add(found, `gate '${gate.name}': ${gate.command}${found ? "" : ` — '${exe}' not found`}`, false);
  }
  if (isRepo) {
    const dirty = await git.statusPorcelain([".agentduo"]);
    add(!dirty.length, `working tree clean${dirty.length ? ` (${dirty.length} uncommitted change(s))` : ""}`, false);
    add(await git.isIgnored(o.cfg.paths.runs_dir), `${o.cfg.paths.runs_dir}/ is git-ignored`, false);
  }
  return checks;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/init.test.ts test/doctor.test.ts && npm run typecheck`
Expected: 7 tests PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/init.ts src/core/doctor.ts test/init.test.ts test/doctor.test.ts
git commit -m "feat: add gate detection for duo init and environment checks for duo doctor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Formatting helpers and plain renderer

**Files:**
- Create: `src/ui/format.ts`, `src/ui/plain.ts`, `test/format.test.ts`, `test/plain.test.ts`

**Interfaces:**
- Consumes: `EventBus`, `DuoEvent`, `Activity`, `Message`, `Decider` (Task 2).
- Produces (`format.ts`): `PIPELINE: Array<{ phase; label }>`, `SPINNER: string[]`, `IMPL_PHASES`, `partyLabel(p)`, `roleLabel(r)`, `formatDuration(sec?)`, `formatClock(sec)`, `formatCost(usd?)`, `formatTokens(n?)`, `usageText(cost?, tokens?)`, `statusIcon(status)`, `activityText(a)`, `messageHeadline(m)`.
- Produces (`plain.ts`): `interface TextSink { write(text: string): unknown }`, `interface PlainOptions { color; verbose; version; now?; commandName? }`, `attachPlainRenderer(bus, out, opts): () => void`, `deferDecider: Decider`.

- [ ] **Step 1: Write the failing tests**

```ts file=test/format.test.ts
import { describe, expect, it } from "vitest";
import { activityText, formatClock, formatCost, formatDuration, formatTokens, messageHeadline, partyLabel, roleLabel, usageText } from "../src/ui/format.js";

describe("format", () => {
  it("formats durations, money and tokens", () => {
    expect([formatDuration(48), formatDuration(72), formatDuration(undefined)]).toEqual(["48s", "1m12s", ""]);
    expect(formatClock(72.9)).toBe("1:12");
    expect([formatCost(0.171), formatCost(0), formatCost(null)]).toEqual(["$0.17", "", ""]);
    expect([formatTokens(67_400), formatTokens(512), formatTokens(0)]).toEqual(["67k tok", "512 tok", ""]);
    expect(usageText(0.5, 2000)).toBe("$0.50 · 2k tok");
  });

  it("labels parties, roles, activities and messages", () => {
    expect([partyLabel("codex"), partyLabel("human"), roleLabel("plan_reviewer")]).toEqual(["Codex", "You", "plan critic"]);
    expect(activityText({ id: "1", kind: "edit", label: "Edit  a.ts", status: "ok", added: 4, removed: 0 })).toBe("Edit  a.ts  +4 −0");
    expect(activityText({ id: "2", kind: "command", label: "Bash  npm test", status: "error", exitCode: 1 })).toBe("Bash  npm test (exit 1)");
    expect(activityText({ id: "3", kind: "command", label: "Bash  git push", status: "denied" })).toBe("Bash  git push denied");
    expect(messageHeadline({ from: "codex", to: "claude", kind: "plan", headline: "Plan v1", items: [] })).toBe("Codex → Claude  Plan v1");
  });
});
```

```ts file=test/plain.test.ts
import { describe, expect, it } from "vitest";
import { EventBus, type DuoEvent } from "../src/events.js";
import { attachPlainRenderer, deferDecider } from "../src/ui/plain.js";

const now = () => new Date(2026, 9, 27, 12, 0, 0);
const review = { reason: "max_review_rounds", message: "not approved", fromPhase: "CODE_REVIEW" as const, resumePhase: "IMPLEMENT" as const, details: ["F1 bad"], at: "x" };
const EVENTS: DuoEvent[] = [
  { type: "run.started", runId: "run-1", task: "t", repo: "/repo", runDir: "/repo/.agentduo/runs/run-1" },
  { type: "phase.started", step: 1, phase: "PLAN", round: 1, role: "planner", agent: "codex", planning: { round: 1, limit: 4 }, impl: { round: 0, limit: 5 } },
  { type: "agent.activity", role: "planner", agent: "codex", activity: { id: "1", kind: "command", label: "exec  cat README.md", status: "running" } },
  { type: "agent.activity", role: "planner", agent: "codex", activity: { id: "1", kind: "command", label: "exec  cat README.md", status: "ok", exitCode: 0 } },
  { type: "agent.activity", role: "planner", agent: "codex", activity: { id: "2", kind: "think", label: "thinking", status: "ok" } },
  { type: "agent.retry", role: "planner", agent: "codex", attempt: 2, max: 2, reason: "output is not valid JSON\nmore" },
  { type: "message", message: { from: "codex", to: "claude", kind: "plan", headline: 'Plan v1 "Demo" · 1 steps', items: ["[high] C1 problem"] } },
  { type: "step.completed", entry: { step: 1, phase: "PLAN", round: 1, agent: "Codex", status: "plan created", summary: "v1", kind: "info", at: "x", artifact: null }, durationSec: 32, tokens: 1234 },
  { type: "gate.completed", name: "tests", command: "npm test", passed: false, exitCode: 1 },
  { type: "warning", text: "something odd" },
  { type: "human.required", runId: "run-1", review },
  { type: "run.finished", runId: "run-1", phase: "DONE", reportPath: "/r/report.md", exitCode: 0 },
];

function render(verbose: boolean, color = false): string {
  const bus = new EventBus();
  let text = "";
  attachPlainRenderer(bus, { write: (s: string) => { text += s; } }, { color, verbose, version: "0.1.0", now });
  for (const e of EVENTS) bus.emit(e);
  return text;
}

describe("plain renderer", () => {
  it("prints one line per event with time, agent and phase columns", () => {
    const text = render(false);
    expect(text.split("\n")).toContain("12:00:00  codex    PLAN r1          ▶ planner");
    for (const s of ["agentduo 0.1.0 · run run-1", "✓ exec  cat README.md", "↻ retry 2/2: output is not valid JSON", "Codex → Claude  Plan v1",
      "- [high] C1 problem", "● plan created: v1 (32s · 1k tok)", "✗ gate tests (exit 1)", "warning: something odd",
      "⚠ HUMAN_REVIEW needed (max_review_rounds): not approved", "    - F1 bad", "duo resume run-1 --decision resume|revise|abort", "[DONE]"]) {
      expect(text).toContain(s);
    }
    expect(text).not.toContain("thinking");
    expect(text).not.toContain("\u001b[");
  });

  it("shows thoughts in verbose mode and colors when asked", () => {
    expect(render(true)).toContain("thinking");
    expect(render(false, true)).toContain("\u001b[");
  });

  it("defers every decision", async () => {
    expect(await deferDecider.decide(review)).toBe("defer");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/format.test.ts test/plain.test.ts`
Expected: FAIL, cannot resolve `../src/ui/format.js`.

- [ ] **Step 3: Implement**

```ts file=src/ui/format.ts
import type { Activity, Message, Party, Phase, Role } from "../events.js";

export const PIPELINE: Array<{ phase: Phase; label: string }> = [
  { phase: "PLAN", label: "PLAN" },
  { phase: "PLAN_REVIEW", label: "CRITIQUE" },
  { phase: "PLAN_FINALIZE", label: "FINALIZE" },
  { phase: "IMPLEMENT", label: "IMPLEMENT" },
  { phase: "VERIFY", label: "VERIFY" },
  { phase: "CODE_REVIEW", label: "REVIEW" },
];
export const IMPL_PHASES: Phase[] = ["IMPLEMENT", "VERIFY", "CODE_REVIEW"];
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const PARTY_LABELS: Record<Party, string> = { codex: "Codex", claude: "Claude", gates: "Gates", human: "You", orchestrator: "agentduo" };
const ROLE_LABELS: Record<Role, string> = {
  planner: "planner", plan_reviewer: "plan critic", plan_finalizer: "plan sign-off", implementer: "implementer", code_reviewer: "code reviewer",
};
const STATUS_ICONS: Record<Activity["status"], string> = { running: "…", ok: "✓", error: "✗", denied: "⊘" };

export const partyLabel = (p?: Party | string): string => (p ? PARTY_LABELS[p as Party] ?? p : "");
export const roleLabel = (r?: Role): string => (r ? ROLE_LABELS[r] : "");
export const statusIcon = (s: Activity["status"]): string => STATUS_ICONS[s];

export function formatDuration(sec?: number): string {
  if (sec === undefined) return "";
  const s = Math.round(sec);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const formatCost = (usd?: number | null): string => (usd ? `$${usd.toFixed(2)}` : "");
export const formatTokens = (n?: number | null): string => (!n ? "" : n >= 1000 ? `${Math.round(n / 1000)}k tok` : `${n} tok`);
export const usageText = (costUsd?: number | null, tokens?: number | null): string => [formatCost(costUsd), formatTokens(tokens)].filter(Boolean).join(" · ");

export function activityText(a: Activity): string {
  const diff = a.added !== undefined || a.removed !== undefined ? `  +${a.added ?? 0} −${a.removed ?? 0}` : "";
  const exit = a.status === "error" && a.exitCode !== undefined ? ` (exit ${a.exitCode})` : "";
  return `${a.label}${diff}${exit}${a.status === "denied" ? " denied" : ""}`;
}

export const messageHeadline = (m: Message): string => `${partyLabel(m.from)} → ${partyLabel(m.to)}  ${m.headline}`;
```

```ts file=src/ui/plain.ts
import type { Decider, DuoEvent, EventBus } from "../events.js";
import { activityText, formatDuration, messageHeadline, roleLabel, statusIcon, usageText } from "./format.js";

export interface TextSink {
  write(text: string): unknown;
}

export interface PlainOptions {
  color: boolean;
  verbose: boolean;
  version: string;
  now?: () => Date;
  commandName?: string;
}

/** Plain mode cannot ask questions: every human review becomes "exit 2, resume later". */
export const deferDecider: Decider = { decide: async () => "defer" };

const CODES = { dim: 2, bold: 1, red: 31, green: 32, yellow: 33, cyan: 36 } as const;
const INDENT = " ".repeat(36);

export function attachPlainRenderer(bus: EventBus, out: TextSink, o: PlainOptions): () => void {
  const paint = (c: keyof typeof CODES, s: string) => (o.color ? `\u001b[${CODES[c]}m${s}\u001b[0m` : s);
  const now = o.now ?? (() => new Date());
  const cmd = o.commandName ?? "duo";
  let ctx = { agent: "", where: "" };
  const clock = () => {
    const d = now();
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
  };
  const line = (text: string, agent = ctx.agent, where = ctx.where) => {
    out.write(`${paint("dim", clock())}  ${agent.padEnd(8)} ${where.padEnd(16)} ${text}\n`);
  };

  return bus.on((e: DuoEvent) => {
    switch (e.type) {
      case "run.started":
        out.write(`${paint("bold", `agentduo ${o.version} · run ${e.runId}`)}\n  repo: ${e.repo}\n  run dir: ${e.runDir}\n`);
        break;
      case "phase.started":
        ctx = { agent: e.agent ?? "", where: `${e.phase} r${e.round}` };
        line(paint("cyan", `▶ ${e.role ? roleLabel(e.role) : e.phase.toLowerCase()}`));
        break;
      case "agent.activity": {
        const a = e.activity;
        if (a.status === "running") break;
        if (!o.verbose && (a.kind === "think" || a.kind === "say")) break;
        const color = a.status === "ok" ? "green" : a.status === "denied" ? "yellow" : "red";
        line(`${paint(color, statusIcon(a.status))} ${activityText(a)}`, e.agent);
        break;
      }
      case "agent.retry":
        line(paint("yellow", `↻ retry ${e.attempt}/${e.max}: ${e.reason.split("\n")[0]}`), e.agent);
        break;
      case "gate.completed":
        line(`${e.passed ? paint("green", "✓") : paint("red", "✗")} gate ${e.name}${e.passed ? "" : ` (${e.exitCode === null ? "timeout" : `exit ${e.exitCode}`})`}`, "gates");
        break;
      case "message": {
        const m = e.message;
        line(paint("bold", messageHeadline(m)), m.from);
        const max = o.verbose ? m.items.length : 5;
        for (const item of m.items.slice(0, max)) out.write(`${INDENT}- ${item}\n`);
        if (m.items.length > max) out.write(`${INDENT}… ${m.items.length - max} more\n`);
        break;
      }
      case "step.completed": {
        const en = e.entry;
        const tail = [formatDuration(e.durationSec), usageText(e.costUsd, e.tokens)].filter(Boolean).join(" · ");
        const icon = en.kind === "warn" ? paint("yellow", "▲") : paint("green", "●");
        line(`${icon} ${en.status}: ${en.summary}${tail ? paint("dim", ` (${tail})`) : ""}`, en.agent.toLowerCase(), `${en.phase} r${en.round}`);
        break;
      }
      case "warning":
        out.write(`${paint("yellow", "warning: ")}${e.text}\n`);
        break;
      case "human.required": {
        const r = e.review;
        out.write(`${paint("yellow", `⚠ HUMAN_REVIEW needed (${r.reason}): `)}${r.message}\n`);
        for (const d of r.details) out.write(`    - ${d}\n`);
        out.write(`  Continue: ${cmd} resume ${e.runId} --decision resume|revise|abort [--note "..."]\n`);
        break;
      }
      case "run.finished":
        if (e.phase === "DONE") out.write(`${paint("green", "[DONE] quality gates passed and the review approved.")} Report: ${e.reportPath}\n`);
        else if (e.phase === "ABORTED") out.write(`${paint("yellow", "run aborted.")} Report: ${e.reportPath}\n`);
        else if (e.phase === "INTERRUPTED") out.write(`${paint("yellow", "stopped.")} Resume with: ${cmd} resume ${e.runId}\n`);
        else out.write(`  Report: ${e.reportPath}\n`);
        break;
      default:
        break;
    }
  });
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/format.test.ts test/plain.test.ts && npm run typecheck`
Expected: 5 tests PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/ui/format.ts src/ui/plain.ts test/format.test.ts test/plain.test.ts
git commit -m "feat: add plain line renderer for CI and pipes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Ink live UI

**Files:**
- Create: `src/ui/ink/store.ts`, `src/ui/ink/StepBlock.tsx`, `src/ui/ink/LiveFooter.tsx`, `src/ui/ink/HumanReviewPrompt.tsx`, `src/ui/ink/App.tsx`, `src/ui/ink/session.tsx`, `test/ink.test.tsx`

**Interfaces:**
- Consumes: `DuoEvent`, `Activity`, `Message`, `HistoryEntry`, `HumanReview`, `RoundInfo`, `Decision`, `Decider`, `EventBus` (Task 2); `format.*` (Task 13).
- Produces (`store.ts`): `interface StepView { phase; round; role?; agent?; activities; message?; entry?; durationSec?; costUsd?; tokens?; startedAt; verbose }`, `type StaticItem = { id } & ({kind:"header"…} | {kind:"step"; step} | {kind:"note"; text} | {kind:"artifact"; title; body})`, `interface ViewState`, `type ViewAction`, `initialView(version, verbose?)`, `reduce(state, action)`.
- Produces (`HumanReviewPrompt.tsx`): `type ViewKind = "plan" | "review" | "feedback" | "diffstat"`, `VIEWS: Record<ViewKind, { label; title }>`, `HumanReviewPrompt({ review, views, onDecision, onView })`.
- Produces (`session.tsx`): `interface InkSessionOptions { bus; version; verbose; interactive; onStop; onInterrupt; views(): ViewKind[]; readView(kind): Promise<string|null>; stdout?; stdin? }`, `startInk(o): { decider: Decider; close(): Promise<void> }`.

- [ ] **Step 1: Write the failing tests**

```tsx file=test/ink.test.tsx
import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { EventBus, type Activity, type DuoEvent, type HistoryEntry, type Phase, type Role } from "../src/events.js";
import { App } from "../src/ui/ink/App.js";
import { HumanReviewPrompt } from "../src/ui/ink/HumanReviewPrompt.js";
import { StepBlock } from "../src/ui/ink/StepBlock.js";
import { initialView, reduce, type StepView, type ViewState } from "../src/ui/ink/store.js";

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const phase = (p: Phase, role: Role, agent: "codex" | "claude", round = 1): DuoEvent =>
  ({ type: "phase.started", step: 1, phase: p, round, role, agent, planning: { round: 1, limit: 4 }, impl: { round, limit: 5 } });
const act = (id: string, label: string, status: Activity["status"], extra: Partial<Activity> = {}): DuoEvent =>
  ({ type: "agent.activity", role: "implementer", agent: "claude", activity: { id, kind: "edit", label, status, ...extra } });
const entry = (p: Phase, status: string, summary: string, kind: HistoryEntry["kind"] = "ok"): HistoryEntry =>
  ({ step: 1, phase: p, round: 1, agent: "Claude", status, summary, kind, at: "x", artifact: null });
const review = { reason: "max_review_rounds", message: "not approved after 5 rounds", fromPhase: "CODE_REVIEW" as const,
  resumePhase: "IMPLEMENT" as const, details: ["F3 [high] src/auth.ts:42"], at: "x" };
const play = (events: DuoEvent[], s: ViewState = initialView("0.1.0")) => events.reduce((acc, event) => reduce(acc, { type: "event", event, now: 0 }), s);
const lastStep = (s: ViewState): StepView => {
  const item = s.items.at(-1)!;
  if (item.kind !== "step") throw new Error("last item is not a step");
  return item.step;
};
const noop = () => undefined;

describe("view reducer", () => {
  it("collects activities into the current step and finalizes it", () => {
    const s = play([
      { type: "run.started", runId: "r1", task: "t", repo: "/repo", runDir: "/d" },
      phase("IMPLEMENT", "implementer", "claude"),
      act("a", "Edit  src/x.ts", "running"),
      act("a", "Edit  src/x.ts", "ok", { added: 4, removed: 0 }),
      { type: "agent.usage", agent: "claude", costUsd: 0.2 },
      { type: "message", message: { from: "claude", to: "codex", kind: "implementation", headline: "completed · 1 file(s) changed", items: [] } },
      { type: "step.completed", entry: entry("IMPLEMENT", "completed", "1 file(s) changed"), durationSec: 12, costUsd: 0.2 },
    ]);
    expect(s.items.map((i) => i.kind)).toEqual(["header", "step"]);
    expect(lastStep(s).activities).toEqual([{ id: "a", kind: "edit", label: "Edit  src/x.ts", status: "ok", added: 4, removed: 0 }]);
    expect(s.totals.costUsd).toBeCloseTo(0.2);
    expect([s.current, s.reached]).toEqual([null, ["IMPLEMENT"]]);
  });

  it("tracks human review and clears it on a decision", () => {
    let s = play([{ type: "human.required", runId: "r1", review }]);
    expect(s.humanReview?.reason).toBe("max_review_rounds");
    s = play([
      { type: "message", message: { from: "human", to: "orchestrator", kind: "decision", headline: "resume", items: [] } },
      { type: "step.completed", entry: { ...entry("HUMAN_REVIEW", "resume", "after max_review_rounds", "info"), agent: "human", round: 3 }, durationSec: 0 },
    ], s);
    expect(s.humanReview).toBeNull();
    const step = lastStep(s);
    expect([step.phase, step.round, step.agent]).toEqual(["HUMAN_REVIEW", 3, "human"]);
  });
});

describe("Ink components", () => {
  it("renders a finished step block", () => {
    const s = play([
      phase("PLAN_REVIEW", "plan_reviewer", "claude"),
      { type: "agent.activity", role: "plan_reviewer", agent: "claude", activity: { id: "r", kind: "read", label: "Read  calc.py", status: "ok" } },
      { type: "message", message: { from: "claude", to: "codex", kind: "critique", headline: "approved · 2 suggestion(s)", items: ["[low] C1 add a negative test", "[low] C2 docstring"] } },
      { type: "step.completed", entry: entry("PLAN_REVIEW", "approved", "2 issue(s), 0 blocking"), durationSec: 48, costUsd: 0.17 },
    ]);
    const frame = render(<StepBlock step={lastStep(s)} />).lastFrame()!;
    for (const text of ["PLAN_REVIEW r1", "Claude (plan critic)", "48s · $0.17", "Read  calc.py ✓", "Claude → Codex  approved · 2 suggestion(s)", "[low] C1 add a negative test"]) {
      expect(frame).toContain(text);
    }
  });

  it("truncates long lines in a narrow terminal", () => {
    const s = play([
      phase("IMPLEMENT", "implementer", "claude"),
      act("x", `Edit  ${"very/long/path/".repeat(10)}file.ts`, "ok"),
      { type: "step.completed", entry: entry("IMPLEMENT", "completed", "x".repeat(200), "warn"), durationSec: 1 },
    ]);
    const frame = render(<Box width={40}><StepBlock step={lastStep(s)} /></Box>).lastFrame()!;
    for (const line of frame.split("\n")) expect([...line].length).toBeLessThanOrEqual(40);
  });

  it("shows the live footer with pipeline, agent, activities and cost", async () => {
    const bus = new EventBus();
    const app = render(<App bus={bus} version="0.1.0" verbose={false} interactive={false} onStop={noop} onInterrupt={noop} onDecision={noop} views={() => []} readView={async () => null} />);
    bus.emit({ type: "run.started", runId: "r1", task: "t", repo: "/repo", runDir: "/d" });
    bus.emit(phase("PLAN", "planner", "codex"));
    bus.emit({ type: "step.completed", entry: entry("PLAN", "plan created", "v1"), durationSec: 3 });
    bus.emit(phase("IMPLEMENT", "implementer", "claude", 2));
    bus.emit(act("a", "Bash  npm test", "running"));
    bus.emit({ type: "agent.usage", agent: "claude", costUsd: 0.41 });
    await wait();
    const frame = app.lastFrame()!;
    for (const text of ["PLAN ✓", "IMPLEMENT ● r2", "plan 1/4 · impl 2/5", "Claude (implementer)", "Bash  npm test", "$0.41"]) expect(frame).toContain(text);
    app.unmount();
  });

  it("lets the user pick a decision and type a note", async () => {
    const decisions: unknown[] = [];
    const ui = render(<HumanReviewPrompt review={review} views={["plan"]} onDecision={(d) => decisions.push(d)} onView={noop} />);
    expect(ui.lastFrame()).toContain("❯ Resume");
    await wait();
    ui.stdin.write("\u001B[B");
    await wait();
    expect(ui.lastFrame()).toContain("❯ Revise");
    ui.stdin.write("\r");
    await wait();
    ui.stdin.write("use redis");
    await wait();
    expect(ui.lastFrame()).toContain("use redis");
    ui.stdin.write("\r");
    await wait();
    expect(decisions).toEqual([{ decision: "revise", note: "use redis" }]);
  });

  it("offers artifact views and deferring", async () => {
    const views: string[] = [];
    const decisions: unknown[] = [];
    const ui = render(<HumanReviewPrompt review={review} views={["plan", "review"]} onDecision={(d) => decisions.push(d)} onView={(k) => views.push(k)} />);
    expect(ui.lastFrame()).toContain("View final plan");
    await wait();
    for (const key of ["\u001B[B", "\u001B[B", "\r"]) {
      ui.stdin.write(key);
      await wait();
    }
    expect(views).toEqual(["plan"]);
    for (const key of ["\u001B[A", "\u001B[A", "\u001B[A", "\r"]) {
      ui.stdin.write(key);
      await wait();
    }
    expect(decisions).toEqual(["defer"]);
  });

  it("handles q when interactive", async () => {
    let stops = 0;
    const bus = new EventBus();
    const app = render(<App bus={bus} version="0.1.0" verbose={false} interactive onStop={() => { stops += 1; }} onInterrupt={noop} onDecision={noop} views={() => []} readView={async () => null} />);
    bus.emit(phase("PLAN", "planner", "codex"));
    await wait();
    app.stdin.write("q");
    await wait();
    expect(stops).toBe(1);
    expect(app.lastFrame()).toContain("stopping after this step");
    app.unmount();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ink.test.tsx`
Expected: FAIL, cannot resolve `../src/ui/ink/App.js`.

- [ ] **Step 3: Implement**

```ts file=src/ui/ink/store.ts
import type { Activity, DuoEvent, HistoryEntry, HumanReview, Message, Party, Phase, Role, RoundInfo } from "../../events.js";

export interface StepView {
  phase: Phase;
  round: number;
  role?: Role;
  agent?: Party;
  activities: Activity[];
  message?: Message;
  entry?: HistoryEntry;
  durationSec?: number;
  costUsd?: number;
  tokens?: number;
  startedAt: number;
  verbose: boolean;
}

type StaticContent =
  | { kind: "header"; runId: string; repo: string; version: string }
  | { kind: "step"; step: StepView }
  | { kind: "note"; text: string }
  | { kind: "artifact"; title: string; body: string };
export type StaticItem = { id: string } & StaticContent;

export interface ViewState {
  version: string;
  items: StaticItem[];
  current: StepView | null;
  planning: RoundInfo;
  impl: RoundInfo;
  reached: Phase[];
  totals: { costUsd: number; tokens: number };
  live: { costUsd: number; tokens: number };
  humanReview: HumanReview | null;
  finished: { phase: string; reportPath: string; exitCode: number } | null;
  verbose: boolean;
  stopping: boolean;
  seq: number;
}

export type ViewAction =
  | { type: "event"; event: DuoEvent; now: number }
  | { type: "toggleVerbose" }
  | { type: "stopping" }
  | { type: "artifact"; title: string; body: string };

export function initialView(version: string, verbose = false): ViewState {
  return {
    version, items: [], current: null, planning: { round: 1, limit: 0 }, impl: { round: 0, limit: 0 }, reached: [],
    totals: { costUsd: 0, tokens: 0 }, live: { costUsd: 0, tokens: 0 }, humanReview: null, finished: null, verbose, stopping: false, seq: 0,
  };
}

function push(s: ViewState, item: StaticContent): ViewState {
  return { ...s, items: [...s.items, { ...item, id: `${item.kind}-${s.seq}` } as StaticItem], seq: s.seq + 1 };
}

function newStep(s: ViewState, phase: Phase, round: number, now: number, role?: Role, agent?: Party): StepView {
  return { phase, round, role, agent, activities: [], startedAt: now, verbose: s.verbose };
}

function upsert(list: Activity[], activity: Activity): Activity[] {
  const i = list.findIndex((a) => a.id === activity.id);
  if (i === -1) return [...list, activity];
  const copy = list.slice();
  copy[i] = activity;
  return copy;
}

function withActivity(s: ViewState, activity: Activity): ViewState {
  return s.current ? { ...s, current: { ...s.current, activities: upsert(s.current.activities, activity) } } : s;
}

export function reduce(s: ViewState, action: ViewAction): ViewState {
  switch (action.type) {
    case "toggleVerbose":
      return { ...s, verbose: !s.verbose };
    case "stopping":
      return { ...s, stopping: true };
    case "artifact":
      return push(s, { kind: "artifact", title: action.title, body: action.body });
    case "event":
      return onEvent(s, action.event, action.now);
  }
}

function onEvent(s: ViewState, e: DuoEvent, now: number): ViewState {
  switch (e.type) {
    case "run.started": {
      const next = { ...s, finished: null, stopping: false };
      return s.items.some((i) => i.kind === "header") ? next : push(next, { kind: "header", runId: e.runId, repo: e.repo, version: s.version });
    }
    case "phase.started":
      return {
        ...s, current: newStep(s, e.phase, e.round, now, e.role, e.agent), planning: e.planning, impl: e.impl,
        reached: s.reached.includes(e.phase) ? s.reached : [...s.reached, e.phase], live: { costUsd: 0, tokens: 0 },
      };
    case "agent.activity":
      return withActivity(s, e.activity);
    case "agent.usage":
      return { ...s, live: { costUsd: e.costUsd ?? s.live.costUsd, tokens: e.tokens ?? s.live.tokens } };
    case "gate.started":
      return withActivity(s, { id: `gate-${e.name}`, kind: "command", label: `gate  ${e.name}: ${e.command}`, status: "running" });
    case "gate.completed":
      return withActivity(s, { id: `gate-${e.name}`, kind: "command", label: `gate  ${e.name}: ${e.command}`, status: e.passed ? "ok" : "error", exitCode: e.exitCode ?? undefined });
    case "message": {
      const current = s.current ?? newStep(s, "HUMAN_REVIEW", 0, now, undefined, e.message.from);
      return { ...s, current: { ...current, message: e.message }, humanReview: e.message.kind === "decision" ? null : s.humanReview };
    }
    case "step.completed": {
      const base = s.current ?? newStep(s, e.entry.phase, e.entry.round, now);
      const step: StepView = { ...base, round: base.round || e.entry.round, entry: e.entry, durationSec: e.durationSec, costUsd: e.costUsd, tokens: e.tokens, verbose: s.verbose };
      return {
        ...push({ ...s, current: null }, { kind: "step", step }),
        totals: { costUsd: s.totals.costUsd + (e.costUsd ?? 0), tokens: s.totals.tokens + (e.tokens ?? 0) },
        live: { costUsd: 0, tokens: 0 },
      };
    }
    case "warning":
      return push(s, { kind: "note", text: e.text });
    case "human.required":
      return { ...s, humanReview: e.review, current: null };
    case "run.finished":
      return { ...s, finished: { phase: e.phase, reportPath: e.reportPath, exitCode: e.exitCode }, current: null, humanReview: null };
    default:
      return s;
  }
}
```

```tsx file=src/ui/ink/StepBlock.tsx
import { Box, Text } from "ink";
import type { Activity, Message } from "../../events.js";
import { activityText, formatDuration, messageHeadline, partyLabel, roleLabel, statusIcon, usageText } from "../format.js";
import type { StepView } from "./store.js";

const MAX_ACTIVITIES = 6;
const MAX_ITEMS = 5;
const statusColor = (s: Activity["status"]) => (s === "ok" ? "green" : s === "running" ? "cyan" : s === "denied" ? "yellow" : "red");

export function ActivityLine({ activity, spinner }: { activity: Activity; spinner?: string }) {
  const icon = activity.status === "running" ? spinner ?? "…" : statusIcon(activity.status);
  return (
    <Text wrap="truncate-end">
      <Text dimColor>  │ </Text>
      {activityText(activity)} <Text color={statusColor(activity.status)}>{icon}</Text>
    </Text>
  );
}

export function MessageView({ message, verbose }: { message: Message; verbose: boolean }) {
  const items = verbose ? message.items : message.items.slice(0, MAX_ITEMS);
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text dimColor>  └ </Text>
        <Text bold>{messageHeadline(message)}</Text>
      </Text>
      {items.map((item, i) => (
        <Text key={i} wrap="truncate-end">{`      ${item}`}</Text>
      ))}
      {message.items.length > items.length ? <Text dimColor>{`      … ${message.items.length - items.length} more`}</Text> : null}
    </Box>
  );
}

export function StepBlock({ step }: { step: StepView }) {
  const entry = step.entry;
  const warn = entry?.kind === "warn";
  const visible = step.verbose ? step.activities : step.activities.filter((a) => a.kind !== "think");
  const shown = step.verbose ? visible : visible.slice(-MAX_ACTIVITIES);
  const hidden = step.activities.length - shown.length;
  const who = step.agent ? `${partyLabel(step.agent)}${step.role ? ` (${roleLabel(step.role)})` : ""}` : "";
  const right = [formatDuration(step.durationSec), usageText(step.costUsd, step.tokens)].filter(Boolean).join(" · ");
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            <Text color={warn ? "yellow" : "green"}>{warn ? "▲ " : "● "}</Text>
            <Text bold>{`${step.phase} r${step.round}`}</Text>
            {who ? `  ${who}` : ""}
          </Text>
        </Box>
        <Box flexGrow={1} />
        {right ? <Text dimColor>{` ${right}`}</Text> : null}
      </Box>
      {hidden > 0 ? <Text dimColor>{`  │ … ${hidden} more`}</Text> : null}
      {shown.map((a) => (
        <ActivityLine key={a.id} activity={a} />
      ))}
      {step.message ? <MessageView message={step.message} verbose={step.verbose} /> : null}
      {entry && (!step.message || warn) ? (
        <Text wrap="truncate-end" color={warn ? "yellow" : undefined}>{`  └ ${entry.status}: ${entry.summary}`}</Text>
      ) : null}
    </Box>
  );
}
```

```tsx file=src/ui/ink/LiveFooter.tsx
import { Box, Text } from "ink";
import { IMPL_PHASES, PIPELINE, SPINNER, formatClock, partyLabel, roleLabel, usageText } from "../format.js";
import { ActivityLine } from "./StepBlock.js";
import type { ViewState } from "./store.js";

function Pipeline({ view }: { view: ViewState }) {
  const current = view.current?.phase;
  return (
    <Text wrap="truncate-end">
      {PIPELINE.map((p, i) => {
        const active = p.phase === current;
        const done = !active && view.reached.includes(p.phase);
        const round = active && IMPL_PHASES.includes(p.phase) ? ` r${view.current!.round}` : "";
        return (
          <Text key={p.phase}>
            {i > 0 ? <Text dimColor>{" › "}</Text> : " "}
            <Text color={active ? "cyan" : done ? "green" : undefined} dimColor={!active && !done} bold={active}>
              {`${p.label}${active ? ` ●${round}` : done ? " ✓" : ""}`}
            </Text>
          </Text>
        );
      })}
      <Text dimColor>{`    plan ${view.planning.round}/${view.planning.limit} · impl ${view.impl.round}/${view.impl.limit}`}</Text>
    </Text>
  );
}

export function LiveFooter({ view, now, frame, interactive }: { view: ViewState; now: number; frame: number; interactive: boolean }) {
  const cur = view.current;
  const spinner = SPINNER[frame % SPINNER.length]!;
  const total = usageText(view.totals.costUsd + view.live.costUsd || undefined, view.totals.tokens + view.live.tokens || undefined);
  const hints = view.stopping ? "stopping after this step…" : interactive ? "[v] details  [q] stop after this step  [ctrl-c] stop now" : "";
  return (
    <Box flexDirection="column" borderStyle="single" borderLeft={false} borderRight={false} borderBottom={false} borderDimColor>
      <Pipeline view={view} />
      {cur ? (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text color="cyan">{spinner}</Text>
            {` ${cur.agent ? partyLabel(cur.agent) : cur.phase}${cur.role ? ` (${roleLabel(cur.role)})` : ""} · ${formatClock((now - cur.startedAt) / 1000)}`}
          </Text>
          {cur.activities.filter((a) => a.kind !== "think").slice(-3).map((a) => (
            <ActivityLine key={a.id} activity={a} spinner={spinner} />
          ))}
        </Box>
      ) : (
        <Text dimColor>waiting…</Text>
      )}
      <Box>
        <Text dimColor wrap="truncate-end">{total || "no usage yet"}</Text>
        <Box flexGrow={1} />
        <Text dimColor wrap="truncate-end">{hints}</Text>
      </Box>
    </Box>
  );
}
```

```tsx file=src/ui/ink/HumanReviewPrompt.tsx
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Decision, HumanReview } from "../../events.js";

export type ViewKind = "plan" | "review" | "feedback" | "diffstat";

export const VIEWS: Record<ViewKind, { label: string; title: string }> = {
  plan: { label: "View final plan", title: "Final plan" },
  review: { label: "View last review", title: "Last review" },
  feedback: { label: "View plan feedback", title: "Plan feedback" },
  diffstat: { label: "View diff stat", title: "Diff stat" },
};

const RESUME_HINTS: Record<string, string> = {
  max_planning_rounds: "implement the latest plan as-is",
  plan_ready: "start implementation",
  max_review_rounds: "start another fix round",
  critical_finding: "start another fix round",
  gates_failing: "start another fix round",
  implementer_blocked: "re-run this implementation round",
  dirty_worktree: "re-run this implementation round",
  guard_violation: "accept the changes and run the gates",
};

interface Option {
  key: string;
  label: string;
  hint: string;
}

export function HumanReviewPrompt({ review, views, onDecision, onView }: {
  review: HumanReview; views: ViewKind[]; onDecision(d: Decision | "defer"): void; onView(kind: ViewKind): void;
}) {
  const options: Option[] = [
    { key: "resume", label: "Resume", hint: RESUME_HINTS[review.reason] ?? "re-run the step that stopped" },
    { key: "revise", label: "Revise", hint: "re-plan with your note" },
    ...views.map((kind) => ({ key: `view:${kind}`, label: VIEWS[kind].label, hint: "" })),
    { key: "abort", label: "Abort", hint: "end the run" },
    { key: "defer", label: "Decide later", hint: "exit now; continue with `duo resume`" },
  ];
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<"menu" | "note">("menu");
  const [pending, setPending] = useState<"resume" | "revise">("resume");
  const [note, setNote] = useState("");

  useInput((input, key) => {
    if (mode === "menu") {
      if (key.upArrow) setIndex((i) => (i - 1 + options.length) % options.length);
      else if (key.downArrow) setIndex((i) => (i + 1) % options.length);
      else if (key.return) {
        const option = options[index]!;
        if (option.key === "resume" || option.key === "revise") {
          setPending(option.key);
          setMode("note");
        } else if (option.key.startsWith("view:")) {
          onView(option.key.slice(5) as ViewKind);
        } else if (option.key === "abort") {
          onDecision({ decision: "abort" });
        } else {
          onDecision("defer");
        }
      }
      return;
    }
    if (key.return) onDecision({ decision: pending, note: note.trim() || undefined });
    else if (key.escape) {
      setMode("menu");
      setNote("");
    } else if (key.backspace || key.delete) setNote((n) => n.slice(0, -1));
    else if (input && !key.ctrl && !key.meta) setNote((n) => n + input);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold wrap="truncate-end">{`⚠ Your decision is needed: ${review.reason}`}</Text>
      <Text wrap="wrap">{review.message}</Text>
      {review.details.slice(0, 8).map((d, i) => (
        <Text key={i} dimColor wrap="truncate-end">{`  - ${d}`}</Text>
      ))}
      <Box marginTop={1} flexDirection="column">
        {mode === "menu" ? (
          options.map((o, i) => (
            <Text key={o.key} wrap="truncate-end">
              <Text color={i === index ? "cyan" : undefined}>{`${i === index ? "❯ " : "  "}${o.label}`}</Text>
              {o.hint ? <Text dimColor>{`  ${o.hint}`}</Text> : null}
            </Text>
          ))
        ) : (
          <Box flexDirection="column">
            <Text>{`${pending === "resume" ? "Resume" : "Revise"}: note for the agents (Enter to continue, Esc to go back)`}</Text>
            <Text>
              <Text color="cyan">{"› "}</Text>
              {note}
              <Text inverse> </Text>
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
```

```tsx file=src/ui/ink/App.tsx
import { Box, Static, Text, useInput } from "ink";
import { useEffect, useReducer, useState } from "react";
import type { Decision, EventBus } from "../../events.js";
import { HumanReviewPrompt, VIEWS, type ViewKind } from "./HumanReviewPrompt.js";
import { LiveFooter } from "./LiveFooter.js";
import { StepBlock } from "./StepBlock.js";
import { initialView, reduce, type StaticItem } from "./store.js";

export interface AppProps {
  bus: EventBus;
  version: string;
  verbose: boolean;
  interactive: boolean;
  onStop(): void;
  onInterrupt(): void;
  onDecision(d: Decision | "defer"): void;
  views(): ViewKind[];
  readView(kind: ViewKind): Promise<string | null>;
}

function StaticItemView({ item }: { item: StaticItem }) {
  switch (item.kind) {
    case "header":
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>{`agentduo ${item.version} · run ${item.runId}`}</Text>
          <Text dimColor>{item.repo}</Text>
        </Box>
      );
    case "step":
      return <StepBlock step={item.step} />;
    case "note":
      return <Text color="yellow" wrap="truncate-end">{`warning: ${item.text}`}</Text>;
    case "artifact":
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>{`── ${item.title} ──`}</Text>
          <Text>{item.body}</Text>
        </Box>
      );
  }
}

export function App(p: AppProps) {
  const [view, dispatch] = useReducer(reduce, undefined, () => initialView(p.version, p.verbose));
  const [frame, setFrame] = useState(0);

  useEffect(() => p.bus.on((event) => dispatch({ type: "event", event, now: Date.now() })), [p.bus]);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => f + 1), 100);
    return () => clearInterval(timer);
  }, []);

  // Raw mode swallows SIGINT, so Ctrl-C arrives as input.
  useInput((input, key) => {
    if (key.ctrl && input === "c") p.onInterrupt();
  }, { isActive: p.interactive });
  useInput((input, key) => {
    if (key.ctrl || key.meta) return;
    if (input === "v") dispatch({ type: "toggleVerbose" });
    else if (input === "q" && !view.stopping) {
      dispatch({ type: "stopping" });
      p.onStop();
    }
  }, { isActive: p.interactive && !view.humanReview });

  const onView = (kind: ViewKind) => {
    void p.readView(kind).then((body) => dispatch({ type: "artifact", title: VIEWS[kind].title, body: body ?? "(not available)" }));
  };

  return (
    <>
      <Static items={view.items}>{(item) => <StaticItemView key={item.id} item={item} />}</Static>
      {view.humanReview && p.interactive ? (
        <HumanReviewPrompt review={view.humanReview} views={p.views()} onDecision={p.onDecision} onView={onView} />
      ) : view.finished ? null : (
        <LiveFooter view={view} now={Date.now()} frame={frame} interactive={p.interactive} />
      )}
    </>
  );
}
```

```tsx file=src/ui/ink/session.tsx
import { render, type RenderOptions } from "ink";
import type { Decider, Decision, EventBus } from "../../events.js";
import { App } from "./App.js";
import type { ViewKind } from "./HumanReviewPrompt.js";

export interface InkSessionOptions {
  bus: EventBus;
  version: string;
  verbose: boolean;
  interactive: boolean;
  onStop(): void;
  onInterrupt(): void;
  views(): ViewKind[];
  readView(kind: ViewKind): Promise<string | null>;
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
}

export interface InkSession {
  decider: Decider;
  close(): Promise<void>;
}

/** Mount the live UI; its Decider resolves when the user answers the human-review prompt. */
export function startInk(o: InkSessionOptions): InkSession {
  const pending: { resolve?: (d: Decision | "defer") => void } = {};
  const decider: Decider = {
    decide: () => (o.interactive ? new Promise((resolve) => { pending.resolve = resolve; }) : Promise.resolve("defer")),
  };
  const onDecision = (d: Decision | "defer") => {
    const resolve = pending.resolve;
    pending.resolve = undefined;
    resolve?.(d);
  };
  const options: RenderOptions = { exitOnCtrlC: false, patchConsole: false };
  if (o.stdout) options.stdout = o.stdout;
  if (o.stdin) options.stdin = o.stdin;
  const instance = render(<App {...o} onDecision={onDecision} />, options);
  return {
    decider,
    close: async () => {
      instance.unmount();
      await instance.waitUntilExit().catch(() => undefined);
    },
  };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/ink.test.tsx && npm run typecheck`
Expected: 8 tests PASS; no type errors. If Ink's key parsing differs in this version (for example, Enter is reported as `"\n"`), adjust the test input rather than the component, then re-run.

- [ ] **Step 5: Commit**

```bash
git add src/ui/ink test/ink.test.tsx
git commit -m "feat: add Ink live UI with step blocks, live footer and decision prompt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: CLI wiring

**Files:**
- Create: `src/cli.ts`, `test/cli.test.ts`, `scripts/demo-ui.mjs`
- Modify: `src/bin.ts` (replace the Task 1 placeholder entirely), `package.json` (add the `demo:ui` script)

**Interfaces:**
- Consumes: `Workflow`, `EXIT`, `DecisionError` (Task 11); `RunStore`, `LockError`, `RunState` (Task 9); `loadConfig`, `validateConfig`, `ConfigError`, `ConfigData` (Task 3); `Git` (Task 4); `resolveBinary` (Task 7); `killAllActive` (Task 5); `runDoctor` (Task 12); `initRepo` (Task 12); `attachPlainRenderer`, `deferDecider` (Task 13); `startInk`, `ViewKind` (Task 14); `findingsMarkdown` (Task 10); `formatCost`, `formatTokens` (Task 13); `packageVersion` (Task 1).
- Produces: `interface CliIO { stdout: { write; isTTY? }; stderr: { write }; stdin: { isTTY? }; env; cwd; onSignal? }`, `processIO(): CliIO`, `main(argv: string[], io?: CliIO): Promise<number>`.
- Commands:
  - `duo [task...]` and `duo run <task...>` take `--task-file`, `--allow-dirty`.
  - `duo resume [runId]` takes `--decision`, `--note`, `--allow-dirty`.
  - `duo status [runId]`, `duo list`, `duo doctor`, `duo init`.
  - Every command takes `--repo`, `--config`, `--plain`, `-v/--verbose`, `--no-color`.
  - `enablePositionalOptions()` is required: it lets a subcommand reuse option names that the program also defines.
- Renderer selection:
  - plain when `--plain`, `CI=true`, or stdout is not a TTY;
  - otherwise Ink, imported dynamically so plain runs never load React;
  - the Ink UI is interactive only when stdin is also a TTY.

- [ ] **Step 1: Write the failing test**

```ts file=test/cli.test.ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, type CliIO } from "../src/cli.js";
import { approval, critique, finding, impl, plan, review } from "./helpers/builders.js";
import { testConfig, type ConfigOverrides } from "./helpers/config.js";
import { FakeClis } from "./helpers/fake-clis.js";
import { git, makeRepo } from "./helpers/repo.js";
import { tempDir } from "./helpers/tmp.js";

let t: { path: string; cleanup(): void };
let fake: FakeClis;
let repo: string;

beforeEach(() => {
  t = tempDir();
  repo = makeRepo(t.path);
  fake = new FakeClis(t.path).install();
});
afterEach(() => {
  fake.restore();
  t.cleanup();
});

function writeRepoConfig(overrides: ConfigOverrides = {}): void {
  mkdirSync(join(repo, ".agentduo"), { recursive: true });
  writeFileSync(join(repo, ".agentduo", "config.yaml"), YAML.stringify(testConfig(fake, overrides)));
}

async function cli(args: string[], cwd = repo): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io: CliIO = {
    stdout: { write: (s: string) => { out += s; } },
    stderr: { write: (s: string) => { err += s; } },
    stdin: {},
    env: { ...process.env, XDG_CONFIG_HOME: join(t.path, "xdg"), CI: "" },
    cwd,
  };
  const code = await main(args, io);
  return { code, out, err };
}

const happy = () => ({
  planner: [{ output: plan() }],
  plan_reviewer: [{ output: critique(true) }],
  plan_finalizer: [{ output: approval(true) }],
  implementer: [{ write: { "app.txt": "fixed\n" }, output: impl() }],
  code_reviewer: [{ output: review(true) }],
});

describe("cli", () => {
  it("prints the version", async () => {
    const r = await cli(["--version"]);
    expect([r.code, r.out.trim()]).toEqual([0, "0.1.0"]);
  });

  it("init detects gates and ignores run data", async () => {
    const other = makeRepo(join(t.path, "other"), { ignoreRuns: false });
    writeFileSync(join(other, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const r = await cli(["init"], other);
    expect(r.code).toBe(0);
    for (const s of ["created", "gate test: npm run test", "added .agentduo/runs/ to .gitignore"]) expect(r.out).toContain(s);
    expect(existsSync(join(other, ".agentduo", "config.yaml"))).toBe(true);
  });

  it("runs a task end to end from a subdirectory with plain output", async () => {
    writeRepoConfig();
    fake.setScenario(happy());
    mkdirSync(join(repo, "sub"));
    const r = await cli(["Make app.txt fixed"], join(repo, "sub"));
    expect(r.code, r.err).toBe(0);
    for (const s of ["agentduo 0.1.0 · run", "▶ planner", "Codex → Claude  Plan v1", "Claude → Codex  approved", "✓ gate check", "[DONE]"]) {
      expect(r.out).toContain(s);
    }
    expect((await cli(["list"])).out).toContain("DONE");
    expect((await cli(["status"])).out).toMatch(/Run \S+ — DONE/);
  });

  it("refuses bad starts before calling any agent", async () => {
    writeRepoConfig();
    fake.setScenario(happy());
    expect((await cli([])).err).toContain("a task description is required");
    writeFileSync(join(repo, "README.md"), "local edit\n");
    const dirty = await cli(["Fix"]);
    expect([dirty.code, dirty.err.includes("uncommitted")]).toEqual([1, true]);
    git(repo, "checkout", "README.md");
    const outside = await cli(["Fix", "--repo", join(t.path, "nowhere")]);
    expect([outside.code, outside.err.includes("not a git repository")]).toEqual([1, true]);
    writeRepoConfig({ codex: { bin: join(t.path, "missing") } });
    expect((await cli(["Fix"])).err).toContain("CLI not found: codex");
    expect(fake.calls()).toEqual([]);
  });

  it("waits for a decision in plain mode and resumes with flags", async () => {
    writeRepoConfig({ limits: { max_review_rounds: 1 } });
    fake.setScenario({ ...happy(), code_reviewer: [{ output: review(false, [finding("F1")]) }] });
    const first = await cli(["Make app.txt fixed"]);
    expect(first.code).toBe(2);
    expect(first.out).toContain("HUMAN_REVIEW needed (max_review_rounds)");
    expect(first.out).toContain("duo resume");
    expect((await cli(["resume", "--note", "x"])).err).toContain("--note is only accepted together with --decision");
    expect((await cli(["resume", "--decision", "bogus"])).code).toBe(1);
    expect((await cli(["resume", "--decision", "abort"])).code).toBe(3);
    const again = await cli(["resume", "--decision", "resume"]);
    expect([again.code, again.err.includes("not waiting for a decision")]).toEqual([1, true]);
  });

  it("runs doctor", async () => {
    writeRepoConfig();
    const ok = await cli(["doctor"]);
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toContain("✓ codex CLI:");
    expect(ok.out).toContain("doctor: ready");
    writeRepoConfig({ claude: { bin: join(t.path, "missing") } });
    const bad = await cli(["doctor"]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("✗ claude CLI not found");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL, cannot resolve `../src/cli.js`.

- [ ] **Step 3: Implement**

```ts file=src/cli.ts
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Command, CommanderError, Option } from "commander";
import { killAllActive } from "./agents/process.js";
import { resolveBinary } from "./agents/resolve.js";
import { ConfigError, loadConfig, validateConfig, type ConfigData } from "./core/config.js";
import { runDoctor } from "./core/doctor.js";
import { Git } from "./core/git.js";
import { initRepo } from "./core/init.js";
import type { Review } from "./core/outputs.js";
import { findingsMarkdown } from "./core/render.js";
import { LockError, RunStore, type RunState } from "./core/state.js";
import { DecisionError, EXIT, Workflow } from "./core/workflow.js";
import { EventBus, type Decider, type Decision } from "./events.js";
import { packageVersion } from "./paths.js";
import { formatCost, formatTokens } from "./ui/format.js";
import type { ViewKind } from "./ui/ink/HumanReviewPrompt.js";
import { attachPlainRenderer, deferDecider } from "./ui/plain.js";

export interface CliIO {
  stdout: { write(text: string): unknown; isTTY?: boolean };
  stderr: { write(text: string): unknown };
  stdin: { isTTY?: boolean };
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Subscribe to SIGINT/SIGTERM; returns an unsubscribe function. */
  onSignal?: (handler: () => void) => () => void;
}

export function processIO(): CliIO {
  return {
    stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, env: process.env, cwd: process.cwd(),
    onSignal: (handler) => {
      process.on("SIGINT", handler);
      process.on("SIGTERM", handler);
      return () => {
        process.off("SIGINT", handler);
        process.off("SIGTERM", handler);
      };
    },
  };
}

interface CommonOptions { repo?: string; config?: string; plain?: boolean; verbose?: boolean; color?: boolean; allowDirty?: boolean }
interface RunOptions extends CommonOptions { taskFile?: string }
interface ResumeOptions extends CommonOptions { decision?: Decision["decision"]; note?: string }

class CliExit extends Error {
  constructor(readonly code: number, message = "") {
    super(message);
  }
}

interface Env { repo: string; isRepo: boolean; git: Git; cfg: ConfigData; sources: string[]; runsDir: string }

/** Resolve the repo (walking up to the git toplevel) and load config without validating it yet. */
async function prepare(io: CliIO, opts: CommonOptions): Promise<Env> {
  const start = resolve(io.cwd, opts.repo ?? ".");
  const probe = new Git(start);
  const isRepo = await probe.isRepo();
  const repo = isRepo ? await probe.toplevel() : start;
  const loaded = loadConfig({ repo, configPath: opts.config ? resolve(io.cwd, opts.config) : undefined, env: io.env, validate: false });
  for (const warning of loaded.warnings) io.stderr.write(`warning: ${warning}\n`);
  const runsDir = isAbsolute(loaded.data.paths.runs_dir) ? loaded.data.paths.runs_dir : join(repo, loaded.data.paths.runs_dir);
  return { repo, isRepo, git: new Git(repo), cfg: loaded.data, sources: loaded.sources, runsDir };
}

function requireRunnable(env: Env, io: CliIO): void {
  if (!env.isRepo) throw new CliExit(EXIT.ERROR, `${env.repo} is not a git repository (run 'git init' and commit first)`);
  validateConfig(env.cfg, env.sources.at(-1));
  const missing = (["codex", "claude"] as const).filter((b) => Object.values(env.cfg.agents).includes(b) && !resolveBinary(env.cfg[b].bin, b, io.env));
  if (missing.length) {
    throw new CliExit(EXIT.ERROR, `CLI not found: ${missing.join(", ")}. Install it or set '<backend>.bin' in the config; run 'duo doctor' for details.`);
  }
}

function openStore(runsDir: string, runId?: string): RunStore {
  try {
    return RunStore.open(runsDir, runId);
  } catch (e) {
    throw new CliExit(EXIT.ERROR, (e as Error).message);
  }
}

function availableViews(store: RunStore, st: RunState): ViewKind[] {
  const views: ViewKind[] = [];
  if (store.exists("plan.final.md") || store.exists("plan.md")) views.push("plan");
  if (store.exists("review.json")) views.push("review");
  if (store.exists("plan-feedback.md")) views.push("feedback");
  if (st.base && st.lastSnapshot) views.push("diffstat");
  return views;
}

async function readView(kind: ViewKind, store: RunStore, st: RunState, git: Git): Promise<string | null> {
  switch (kind) {
    case "plan":
      return store.exists("plan.final.md") ? store.readText("plan.final.md") : store.exists("plan.md") ? store.readText("plan.md") : null;
    case "review": {
      if (!store.exists("review.json")) return null;
      const r = store.readJson<{ output: Review }>("review.json").output;
      return `${r.status}: ${r.summary}\n\n${findingsMarkdown(r.findings)}`;
    }
    case "feedback":
      return store.exists("plan-feedback.md") ? store.readText("plan-feedback.md") : null;
    case "diffstat":
      return st.base && st.lastSnapshot ? (await git.diffStat(st.base.commit, st.lastSnapshot.commit)) || "(no changes)" : null;
  }
}

async function execute(io: CliIO, env: Env, store: RunStore, state: RunState, opts: CommonOptions, allowDirty: boolean, decision?: Decision): Promise<number> {
  const bus = new EventBus();
  const plain = !!opts.plain || io.env.CI === "true" || !io.stdout.isTTY;
  const interactive = !plain && !!io.stdin.isTTY;
  const version = packageVersion();
  let workflow: Workflow | undefined;
  let presses = 0;
  const onInterrupt = () => {
    presses += 1;
    if (presses === 1) {
      workflow?.interrupt();
      return;
    }
    killAllActive();
    process.exit(EXIT.INTERRUPTED);
  };
  const onStop = () => workflow?.requestStop();
  let decider: Decider = deferDecider;
  let closeUi: () => Promise<void>;
  if (plain) {
    const detach = attachPlainRenderer(bus, io.stdout, { color: opts.color !== false && !io.env.NO_COLOR && !!io.stdout.isTTY, verbose: !!opts.verbose, version });
    closeUi = async () => detach();
  } else {
    const { startInk } = await import("./ui/ink/session.js");
    const session = startInk({
      bus, version, verbose: !!opts.verbose, interactive, onStop, onInterrupt,
      views: () => availableViews(store, workflow?.state ?? state),
      readView: (kind) => readView(kind, store, workflow?.state ?? state, env.git),
      stdout: io.stdout as NodeJS.WriteStream, stdin: io.stdin as NodeJS.ReadStream,
    });
    decider = session.decider;
    closeUi = session.close;
  }
  workflow = new Workflow({ cfg: env.cfg, repo: env.repo, store, state, bus, decider, allowDirty });
  const offSignal = io.onSignal?.(onInterrupt);
  let locked = false;
  try {
    store.lock();
    locked = true;
    if (decision) await workflow.applyDecision(decision.decision, decision.note);
    return await workflow.run();
  } catch (e) {
    if (e instanceof LockError || e instanceof DecisionError) throw new CliExit(EXIT.ERROR, e.message);
    throw e;
  } finally {
    if (locked) store.unlock();
    offSignal?.();
    await closeUi();
  }
}

async function runCommand(io: CliIO, words: string[], opts: RunOptions): Promise<number> {
  let task = words.join(" ").trim();
  if (opts.taskFile) task = `${task}\n\n${readFileSync(resolve(io.cwd, opts.taskFile), "utf8")}`.trim();
  if (!task) throw new CliExit(EXIT.ERROR, 'a task description is required, e.g. duo "Add JWT auth" (other commands: resume, status, list, doctor, init)');
  const env = await prepare(io, opts);
  requireRunnable(env, io);
  const allowDirty = !!opts.allowDirty || env.cfg.safety.allow_dirty_worktree;
  const dirty = await env.git.statusPorcelain([".agentduo"]);
  if (dirty.length && !allowDirty) {
    throw new CliExit(EXIT.ERROR, `working tree has ${dirty.length} uncommitted change(s); commit or stash them first, or pass --allow-dirty\n`
      + dirty.slice(0, 10).map((l) => `    ${l}`).join("\n"));
  }
  const { store, state } = RunStore.create(env.runsDir, task, env.cfg.limits);
  return execute(io, env, store, state, opts, allowDirty);
}

async function resumeCommand(io: CliIO, runId: string | undefined, opts: ResumeOptions): Promise<number> {
  if (opts.note && !opts.decision) throw new CliExit(EXIT.ERROR, "--note is only accepted together with --decision");
  const env = await prepare(io, opts);
  requireRunnable(env, io);
  const store = openStore(env.runsDir, runId);
  return execute(io, env, store, store.loadState(), opts, !!opts.allowDirty, opts.decision ? { decision: opts.decision, note: opts.note } : undefined);
}

async function statusCommand(io: CliIO, runId: string | undefined, opts: CommonOptions): Promise<number> {
  const env = await prepare(io, opts);
  const store = openStore(env.runsDir, runId);
  const st = store.loadState();
  const out = (s: string) => io.stdout.write(`${s}\n`);
  out(`Run ${st.taskId} — ${st.phase}`);
  out(`  task: ${st.task.split("\n")[0]!.slice(0, 100)}`);
  out(`  planning round ${st.planningRound}/${st.limits.planningRounds}, plan v${st.planVersion}, final ${st.finalPlanVersion ? `v${st.finalPlanVersion}` : "—"}`);
  out(`  implementation round ${st.implRound}/${st.limits.reviewRounds}, open findings ${st.openFindings.length}`);
  out(`  usage: ${[formatCost(st.costUsd), formatTokens(st.tokens)].filter(Boolean).join(" · ") || "none"}`);
  if (st.inProgress) out(`  interrupted during ${st.inProgress.phase} (resume to re-run it)`);
  for (const h of st.history.slice(-12)) {
    out(`  [${String(h.step).padStart(2, "0")}] ${`${h.phase} r${h.round}`.padEnd(16)} ${h.agent.padEnd(12)} ${h.status}: ${h.summary}`);
  }
  if (st.phase === "HUMAN_REVIEW" && st.humanReview) {
    out(`  waiting for a decision (${st.humanReview.reason}): ${st.humanReview.message}`);
    out(`  continue: duo resume ${st.taskId} --decision resume|revise|abort [--note "..."]`);
  }
  out(`  files: ${store.dir}`);
  return EXIT.DONE;
}

async function listCommand(io: CliIO, opts: CommonOptions): Promise<number> {
  const env = await prepare(io, opts);
  const runs = RunStore.list(env.runsDir);
  if (!runs.length) io.stdout.write(`no runs in ${env.runsDir}\n`);
  for (const st of runs) io.stdout.write(`${st.taskId}  ${st.phase.padEnd(13)} ${st.updatedAt}  ${st.task.split("\n")[0]!.slice(0, 60)}\n`);
  return EXIT.DONE;
}

async function doctorCommand(io: CliIO, opts: CommonOptions): Promise<number> {
  const env = await prepare(io, opts);
  let configError: string | undefined;
  try {
    validateConfig(env.cfg, env.sources.at(-1));
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    configError = e.message.replace(/\n\s*/g, " ");
  }
  const checks = await runDoctor({ repo: env.repo, cfg: env.cfg, sources: env.sources, configError, env: io.env });
  let failed = false;
  for (const c of checks) {
    if (c.ok) io.stdout.write(`  ✓ ${c.message}\n`);
    else if (c.required) {
      failed = true;
      io.stdout.write(`  ✗ ${c.message}\n`);
    } else io.stdout.write(`  ! ${c.message}\n`);
  }
  io.stdout.write(`doctor: ${failed ? "problems found" : "ready"}\n`);
  return failed ? EXIT.ERROR : EXIT.DONE;
}

async function initCommand(io: CliIO, opts: CommonOptions): Promise<number> {
  const env = await prepare(io, opts);
  const r = initRepo(env.repo);
  if (r.created) {
    io.stdout.write(`created ${r.configPath}\n`);
    for (const g of r.gates) io.stdout.write(`  gate ${g.name}: ${g.command}  (${g.reason})\n`);
    if (!r.gates.length) io.stdout.write("  no quality gates detected: add your test/lint/typecheck commands under 'gates' before running\n");
  } else {
    io.stdout.write(`kept existing ${r.configPath}\n`);
  }
  io.stdout.write(r.gitignoreUpdated ? "added .agentduo/runs/ to .gitignore\n" : ".agentduo/runs/ is already ignored\n");
  if (!env.isRepo) io.stderr.write(`warning: ${env.repo} is not a git repository yet\n`);
  return EXIT.DONE;
}

export async function main(argv: string[], io: CliIO = processIO()): Promise<number> {
  let exitCode: number = EXIT.DONE;
  const program = new Command()
    .name("duo")
    .description("Codex plans and reviews; Claude Code critiques and implements. Start a run with a task description.")
    .version(packageVersion(), "-V, --version")
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.stdout.write(s), writeErr: (s) => io.stderr.write(s) })
    .showHelpAfterError();
  const common = (cmd: Command) => cmd
    .option("--repo <path>", "target git repository (default: the one containing the current directory)")
    .option("--config <path>", "config file (default: <repo>/.agentduo/config.yaml)")
    .option("--plain", "plain line output (default when stdout is not a TTY or CI=true)")
    .option("-v, --verbose", "show every agent activity, including thoughts")
    .option("--no-color", "disable colors");
  const dirtyOption = () => new Option("--allow-dirty", "allow implementing on top of uncommitted changes");

  common(program.argument("[task...]", "task description for a new run").option("--task-file <file>", "read the task description from a file").addOption(dirtyOption()))
    .action(async (words: string[], opts: RunOptions) => {
      exitCode = await runCommand(io, words, opts);
    });
  common(program.command("run").description("start a new run").argument("<task...>").option("--task-file <file>", "read the task description from a file").addOption(dirtyOption()))
    .action(async (words: string[], opts: RunOptions) => {
      exitCode = await runCommand(io, words, opts);
    });
  common(program.command("resume").description("continue a run (default: the latest), optionally answering a pending decision").argument("[runId]")
    .addOption(new Option("--decision <decision>", "answer a run waiting in HUMAN_REVIEW").choices(["resume", "revise", "abort"]))
    .option("--note <text>", "instruction for the agents, recorded with the decision").addOption(dirtyOption()))
    .action(async (runId: string | undefined, opts: ResumeOptions) => {
      exitCode = await resumeCommand(io, runId, opts);
    });
  common(program.command("status").description("show a run's state").argument("[runId]"))
    .action(async (runId: string | undefined, opts: CommonOptions) => {
      exitCode = await statusCommand(io, runId, opts);
    });
  common(program.command("list").description("list runs in this repository"))
    .action(async (opts: CommonOptions) => {
      exitCode = await listCommand(io, opts);
    });
  common(program.command("doctor").description("check CLIs, config and repository (no agent calls)"))
    .action(async (opts: CommonOptions) => {
      exitCode = await doctorCommand(io, opts);
    });
  common(program.command("init").description("create .agentduo/config.yaml with detected quality gates"))
    .action(async (opts: CommonOptions) => {
      exitCode = await initCommand(io, opts);
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return exitCode;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode === 0 ? EXIT.DONE : EXIT.ERROR;
    if (err instanceof CliExit) {
      if (err.message) io.stderr.write(`error: ${err.message}\n`);
      return err.code;
    }
    if (err instanceof ConfigError) {
      io.stderr.write(`error: ${err.message}\n`);
      return EXIT.ERROR;
    }
    throw err;
  }
}
```

```ts file=src/bin.ts
import { main } from "./cli.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
    // Ink can leave stdin referenced after unmounting; never let that keep the process alive.
    setTimeout(() => process.exit(code), 200).unref();
  },
  (err: unknown) => {
    process.stderr.write(`agentduo crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);
```

- [ ] **Step 4: Run the CLI tests, the whole suite, typecheck and build**

Run: `npx vitest run test/cli.test.ts && npm test && npm run typecheck && npm run build && node dist/cli.js --help`
Expected: 6 CLI tests PASS; full suite PASS; no type errors; the help output lists `run`, `resume`, `status`, `list`, `doctor`, `init`.

- [ ] **Step 5: Add a free UI demo and look at it in a real terminal**

```js file=scripts/demo-ui.mjs
// Shows the live UI with scripted fake agents (no model calls, no cost): npm run demo:ui
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "agentduo-demo-"));
const repo = join(dir, "repo");
mkdirSync(join(repo, ".agentduo"), { recursive: true });
const git = (...args) => execFileSync("git", args, { cwd: repo });
git("init", "-q", "-b", "main");
writeFileSync(join(repo, "check.mjs"), 'import { readFileSync } from "node:fs";\nprocess.exit(readFileSync("app.txt", "utf8").includes("fixed") ? 0 : 1);\n');
writeFileSync(join(repo, ".gitignore"), ".agentduo/runs/\n");
git("add", "-A");
git("-c", "user.email=demo@example.com", "-c", "user.name=demo", "commit", "-qm", "init");
for (const name of ["codex", "claude"]) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${join(root, "test", "fake-agent.mjs")}" ${name} "$@"\n`);
  chmodSync(path, 0o755);
}
writeFileSync(join(repo, ".agentduo", "config.yaml"), [
  `codex:\n  bin: ${JSON.stringify(join(dir, "codex"))}`,
  `claude:\n  bin: ${JSON.stringify(join(dir, "claude"))}`,
  `gates:\n  - name: check\n    command: ${JSON.stringify(`"${process.execPath}" check.mjs`)}`,
].join("\n") + "\n");
const plan = { title: "Make app.txt fixed", summary: "Write app.txt.", goals: ["app.txt says fixed"], scope_in: ["app.txt"], scope_out: [],
  architecture: "single file", steps: [{ id: "S1", description: "write app.txt", files: ["app.txt"] }], acceptance_criteria: ["check.mjs exits 0"],
  risks: [{ risk: "none", mitigation: "n/a" }], test_strategy: "run check.mjs", open_questions: [], feedback_resolution: [] };
const verdict = (approved, issues = []) => ({ status: approved ? "approved" : "changes_requested", approved, summary: approved ? "looks good" : "needs work", issues });
const issue = { id: "C1", severity: "high", description: "no test strategy for edge cases", suggestion: "add one" };
writeFileSync(join(dir, "scenario.json"), JSON.stringify({
  planner: [{ activities: [{ command: "ls" }, { command: "cat check.mjs" }], sleep: 1500, output: plan }],
  plan_reviewer: [
    { activities: [{ tool: "Read", input: { file_path: join(repo, "check.mjs") } }], sleep: 1500, output: { ...verdict(false, [issue]), accepted: [], disputed: [], proposed_changes: ["add an edge-case test"] } },
    { sleep: 1000, output: { ...verdict(true), accepted: ["C1"], disputed: [], proposed_changes: [] } },
  ],
  plan_finalizer: [{ sleep: 800, output: verdict(true) }],
  implementer: [{ activities: [{ tool: "Write", input: { file_path: join(repo, "app.txt"), content: "fixed\n" } }, { tool: "Bash", input: { command: "node check.mjs" } }],
    sleep: 2000, write: { "app.txt": "fixed\n" },
    output: { status: "completed", summary: "wrote app.txt", files_changed: ["app.txt"], tests_run: [{ command: "node check.mjs", passed: true, notes: "" }], addressed_findings: [], blocking_reason: null } }],
  code_reviewer: [{ activities: [{ command: "git diff" }], sleep: 1500, output: { status: "approved", approved: true, reviewed_commit: "$SNAPSHOT", summary: "good", findings: [], resolved_findings: [] } }],
}));
const env = { ...process.env, FAKE_SCENARIO: join(dir, "scenario.json"), FAKE_COUNTS: join(dir, "counts.json"), FAKE_LOG: join(dir, "calls.jsonl") };
const result = spawnSync(process.execPath, [join(root, "dist", "cli.js"), "Make app.txt fixed", "--repo", repo, ...process.argv.slice(2)], { stdio: "inherit", env });
process.exitCode = result.status ?? 1;
```

Add the script to `package.json` (`"demo:ui": "npm run build && node scripts/demo-ui.mjs"`). Then run `npm run demo:ui` in a real terminal and confirm by eye:
- each finished step prints a block with its activities and a `Codex → Claude …` line, and the blocks stay in scrollback;
- the live footer shows the pipeline, a spinner with the agent's role and elapsed time, the last activities and the totals;
- the run ends with `[DONE]` on a plain line.

Run `npm run demo:ui -- --plain` to see the CI output. Without a TTY, do only the `--plain` check, and say so in the task report.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/bin.ts test/cli.test.ts scripts/demo-ui.mjs package.json
git commit -m "feat: add duo CLI commands with Ink or plain rendering

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Docs, CI, packaging smoke tests, retire the Python version

**Files:**
- Create: `README.vi.md`, `scripts/pack-smoke.mjs`, `scripts/smoke-real.mjs`, `.github/workflows/ci.yml`
- Modify (rewrite): `README.md`, `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-10-27-agentduo-npm-cli-design.md` (Node version row, test:pack note), `.gitignore` (drop the Python lines)
- Delete: `.orchestrator/`, `tests/`

**Interfaces:**
- Consumes: the built CLI (`dist/cli.js`) and `package.json` scripts from Task 1.

- [ ] **Step 1: Write the packaging smoke test**

```js file=scripts/pack-smoke.mjs
// Builds, packs and installs agentduo into a temporary prefix, then runs the installed binaries.
// Proves the published tarball works on its own: bin entries, bundled schemas, runtime dependencies.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts });
const tmp = mkdtempSync(join(tmpdir(), "agentduo-pack-"));
try {
  run("npm", ["run", "build"], { cwd: root });
  const [{ filename }] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", tmp], { cwd: root }));
  const prefix = join(tmp, "prefix");
  run("npm", ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", join(tmp, filename)]);
  const bin = process.platform === "win32" ? prefix : join(prefix, "bin");
  for (const name of ["duo", "agentduo"]) {
    const out = run(join(bin, name), ["--version"]).trim();
    if (out !== version) throw new Error(`${name} --version printed '${out}', expected '${version}'`);
  }
  const repo = join(tmp, "repo");
  mkdirSync(repo);
  run("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "x\n");
  run("git", ["add", "-A"], { cwd: repo });
  run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
  const doctor = spawnSync(join(bin, "duo"), ["doctor", "--repo", repo], { encoding: "utf8" });
  if (!doctor.stdout.includes("✓ schema plan")) throw new Error(`doctor output is missing the schema check:\n${doctor.stdout}${doctor.stderr}`);
  console.log(`pack smoke OK: ${filename}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run it**

Run: `npm run test:pack`
Expected: `pack smoke OK: agentduo-0.1.0.tgz`. A FAIL here usually means `files` in `package.json` misses something, or `packageRoot()` cannot find `package.json` in the installed layout.

- [ ] **Step 3: Write the real-agent smoke script**

```js file=scripts/smoke-real.mjs
// Runs agentduo against the REAL Codex and Claude CLIs on a tiny demo repository.
// This spends real usage (roughly $0.5 with default models). Run manually: npm run smoke:real
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const repo = mkdtempSync(join(tmpdir(), "agentduo-smoke-"));
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
git("init", "-q", "-b", "main");
mkdirSync(join(repo, "test"));
writeFileSync(join(repo, "calc.mjs"), "export function add(a, b) {\n  return a + b;\n}\n");
writeFileSync(join(repo, "test", "calc.test.mjs"),
  'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../calc.mjs";\n\ntest("add", () => {\n  assert.equal(add(2, 3), 5);\n});\n');
writeFileSync(join(repo, ".gitignore"), ".agentduo/runs/\n");
mkdirSync(join(repo, ".agentduo"));
writeFileSync(join(repo, ".agentduo", "config.yaml"), 'gates:\n  - name: tests\n    command: "node --test"\n    required: true\n');
git("add", "-A");
git("-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-qm", "init");

const task = "Add a subtract(a, b) function to calc.mjs, with a unit test in test/calc.test.mjs";
const result = spawnSync(process.execPath, [cli, "--plain", task, "--repo", repo], { stdio: "inherit" });
console.log(`\nexit code: ${result.status}\nrepo kept for inspection: ${repo}`);
console.log(git("diff", "--stat"));
process.exitCode = result.status === 0 ? 0 : 1;
```

- [ ] **Step 4: Write CI**

```yaml file=.github/workflows/ci.yml
name: ci
on:
  push:
  pull_request:
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: [22, 24]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run test:pack
```

- [ ] **Step 5: Rewrite the docs**

````markdown file=README.md
# agentduo

Two coding agents, one loop: **Codex** plans and reviews, **Claude Code** critiques the plan and implements it. Your project's own tests are the referee. A live terminal UI shows what each agent is doing and what they hand each other.

```text
● PLAN r1  Codex (planner)                                      32s · 33k tok
  │ exec  rg --files ✓
  │ exec  cat src/calc.ts ✓
  └ Codex → Claude  Plan v1 "Add subtraction" · 3 steps · 6 criteria · 1 risks

● PLAN_REVIEW r1  Claude (plan critic)                          48s · $0.17
  │ Read  src/calc.ts ✓
  └ Claude → Codex  approved · 2 suggestion(s)
      [low] C1 add a negative-number test
──────────────────────────────────────────────────────────────────────────────
 PLAN ✓ › CRITIQUE ✓ › FINALIZE ✓ › IMPLEMENT ● r1 › VERIFY › REVIEW    plan 1/4 · impl 1/5
 ⠋ Claude (implementer) · 0:21
   │ Edit  src/calc.ts  +4 −0 ✓
   │ Bash  npm test ⠋
 $0.33 · 67k tok                  [v] details  [q] stop after this step  [ctrl-c] stop now
```

## How it works

1. **Plan and debate.** Codex writes a plan: goals, scope, steps, acceptance criteria and risks. Claude checks that the plan is feasible in your codebase. Codex revises it until Claude approves, then signs off on the final plan.
2. **Implement and review.** Claude implements the plan. agentduo runs your quality gates (tests, lint, typecheck) itself. Codex reviews the diff and the gate results, and Claude fixes the findings, round after round, until the run reaches `DONE`.

The agents never talk to each other directly. agentduo relays schema-validated JSON between them, and agreement between agents is never accepted as proof. `DONE` requires all three:
- Codex approves;
- every required gate passes;
- no blocking finding is left.

When a limit is reached, a safety rule is broken or an agent fails, the run pauses in `HUMAN_REVIEW` and asks you what to do.

## Requirements

- Node.js ≥ 22.12 and git. The target project must be a git repository.
- [Codex CLI](https://developers.openai.com/codex/cli/): run `npm i -g @openai/codex`, then `codex login`.
- [Claude Code](https://code.claude.com/docs/en/overview): the `claude` command. If Claude Code is installed only through the VS Code, Cursor or Windsurf extension, agentduo finds the bundled binary.

Both agents run under your own accounts. agentduo does not call model APIs itself.

## Install

```bash
npm i -g agentduo
```

## Quick start

```bash
cd my-project
duo init      # writes .agentduo/config.yaml with detected gates and git-ignores .agentduo/runs/
duo doctor    # checks CLIs, flags, config and gates; makes no model calls
duo "Add JWT authentication with refresh tokens"
```

`agentduo` is the same command as `duo`. Use `agentduo` if another tool on your machine already owns the name `duo`.

## Commands

| Command | What it does |
|---|---|
| `duo "<task>"`, `duo run "<task>"` | Start a run (`--task-file F`, `--allow-dirty`) |
| `duo resume [id]` | Continue the latest (or given) run; `--decision resume\|revise\|abort [--note "..."]` answers a pending decision |
| `duo status [id]`, `duo list` | Show progress, history and where the files are |
| `duo doctor` | Check the environment without calling models |
| `duo init` | Create `.agentduo/config.yaml` |

Every command also takes `--repo PATH`, `--config PATH`, `--plain`, `-v/--verbose` and `--no-color`.

Output is the live UI in a terminal. It switches to plain timestamped lines with `--plain`, when `CI=true`, or when stdout is not a TTY.

agentduo **never commits or pushes**. Changes stay uncommitted in your working tree, so review them with `git diff` and commit them yourself.

## When a run needs you

In an interactive terminal, agentduo shows the reason and a menu. You can resume, revise with a note, view the final plan, the last review, the plan feedback or the diff stat, abort, or decide later. In plain mode the run exits with code 2, and you answer with `duo resume --decision …`.

| Reason | What `resume` does |
|---|---|
| `max_planning_rounds` | Implements the latest plan, recorded as accepted by you |
| `plan_ready` (with `safety.pause_before_implement`) | Starts implementing |
| `max_review_rounds`, `critical_finding`, `gates_failing` | Starts another fix round |
| `implementer_blocked`, `dirty_worktree` | Re-runs the implementation round (add `--allow-dirty` if needed) |
| `guard_violation` | Accepts the changes after your inspection and runs the gates |
| `readonly_violation`, `agent_error`, `orchestrator_error` | Re-runs the failed step |

`revise` always goes back to planning with your note. `abort` ends the run. Notes are added to every later prompt as top-priority instructions.

## Configuration

Settings are merged in this order, later sources winning: built-in defaults, then `~/.config/agentduo/config.yaml` (or `$XDG_CONFIG_HOME/agentduo/` or `%APPDATA%\agentduo\` on Windows), then `<repo>/.agentduo/config.yaml` or `--config`, then CLI flags. A misspelled key produces a warning. An unsafe configuration is rejected, for example one where the implementer is not Claude, a reviewer can write, or no gate is required.

```yaml
gates:                        # run by agentduo after every implementation round
  - name: tests
    command: "npm test"
    required: true
limits:
  max_planning_rounds: 4
  max_review_rounds: 5
  agent_timeout_sec: 1800
safety:
  pause_before_implement: false
  protected_paths: [".agentduo/**", ".env", ".env.*", "**/*.pem", "**/*.key", "**/secrets/**", ".github/workflows/**"]
codex:
  model: null                 # e.g. a cheaper model
claude:
  model: null
  max_budget_usd: null        # per call
```

## Safety model

Permissions are enforced by the CLIs themselves, not only stated in prompts:

| Role | Invocation | Limits |
|---|---|---|
| Codex planner / reviewer | `codex exec --json --sandbox read-only --output-schema …` | read-only sandbox |
| Claude plan critic | `claude -p --output-format stream-json --tools Read,Grep,Glob --permission-mode dontAsk --permission-prompts none` | read tools only |
| Claude implementer | `claude -p … --permission-mode acceptEdits --allowedTools … --disallowedTools …` | edits files and runs allowlisted commands (your gates, read-only git); `git commit/push/reset`, `rm -rf`, `curl` and web access are denied |

agentduo also checks independently:

- It snapshots the whole working tree into `refs/agentduo/<run>/…` through a temporary index, leaving your index, HEAD and branch untouched. Every review therefore targets an exact SHA, and the state before every round can be restored.
- It hashes the working tree before and after each read-only step. Any change, or any movement of HEAD or the branch, stops the run.
- After each implementation round it checks that HEAD and the branch did not move (no commits), that no protected path changed, and that the number of deleted files stays within a limit.
- It refuses to start on uncommitted changes unless you pass `--allow-dirty`.

## Run files

Everything about a run lives in `.agentduo/runs/<run-id>/`:

- `state.json`: rewritten after every step, which makes a run resumable;
- `report.md`: timeline, gate results, diff stat, unresolved issues, cost;
- `plan.vN.md`, `plan.final.md` and `plan-feedback.md`;
- the per-round JSON from every agent, wrapped with task id, round, timestamp, git SHA and plan version;
- `gates/` logs;
- `logs/`: for every CLI call, the prompt, the command line, the raw event stream and stderr.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | done |
| 1 | config or environment error |
| 2 | waiting for your decision |
| 3 | aborted |
| 130 | stopped (resumable) |

## Platforms

macOS and Linux are supported. Windows is experimental and not covered by CI.

## Costs

Each round makes a few agent calls against your own Codex and Claude accounts. A small task took about 3 minutes, $0.33 of Claude usage and 67k Codex tokens. The live UI shows running totals. Use `claude.model`, `codex.model` and `claude.max_budget_usd` to keep costs down.

## Development

```bash
npm install
npm test             # unit + end-to-end (fake agents) + UI tests
npm run typecheck
npm run test:pack    # build, pack, install into a temp prefix, run the binaries
npm run smoke:real   # REAL agents on a demo repo — costs money
```

## License

MIT
````

````markdown file=README.vi.md
# agentduo (tiếng Việt)

Hai agent lập trình chạy chung một vòng lặp. **Codex** lập kế hoạch và review. **Claude Code** phản biện kế hoạch rồi implement. Bộ test của chính dự án đóng vai trọng tài. Giao diện terminal hiển thị live từng hành động của mỗi agent và những gì hai agent chuyển cho nhau.

## Cách hoạt động

1. **Lập kế hoạch và tranh luận.** Codex viết plan gồm mục tiêu, phạm vi, các bước, acceptance criteria và rủi ro. Claude kiểm tra xem plan có khả thi trong codebase của bạn không. Codex sửa plan cho đến khi Claude chấp thuận, rồi chốt bản cuối.
2. **Implement và review.** Claude implement theo plan. agentduo tự chạy các quality gate (test, lint, typecheck). Codex review diff cùng kết quả gate, Claude sửa theo các finding, lặp lại cho đến `DONE`.

Hai agent không nói chuyện trực tiếp với nhau. agentduo chuyển JSON đã kiểm tra theo schema giữa hai bên, và việc hai agent đồng ý với nhau không được tính là bằng chứng. `DONE` cần đủ cả ba điều kiện:
- Codex approve;
- mọi gate bắt buộc đều đạt;
- không còn finding nào ở mức blocking.

Khi vượt giới hạn, vi phạm quy tắc an toàn hoặc agent gặp lỗi, run dừng ở `HUMAN_REVIEW` và hỏi bạn.

## Yêu cầu và cài đặt

- Node.js ≥ 22.12 và git. Dự án phải là một git repository.
- Codex CLI (`npm i -g @openai/codex`, sau đó `codex login`) và Claude Code. Nếu Claude Code chỉ được cài qua extension VS Code, Cursor hoặc Windsurf, agentduo tự tìm binary đi kèm.

```bash
npm i -g agentduo
cd my-project
duo init      # tạo .agentduo/config.yaml với các gate tự đoán, thêm .agentduo/runs/ vào .gitignore
duo doctor    # kiểm tra môi trường, không gọi model
duo "Thêm xác thực JWT với refresh token"
```

`agentduo` là cùng một lệnh với `duo`. Hãy dùng `agentduo` nếu trên máy bạn đã có một công cụ khác tên là `duo`.

## Lệnh

| Lệnh | Tác dụng |
|---|---|
| `duo "<task>"` | Tạo run mới (`--task-file`, `--allow-dirty`) |
| `duo resume [id] [--decision resume\|revise\|abort --note "..."]` | Chạy tiếp, hoặc trả lời một quyết định đang chờ |
| `duo status`, `duo list` | Xem tiến độ |
| `duo doctor`, `duo init` | Kiểm tra môi trường, tạo config |

Giao diện:
- **Trong terminal:** giao diện live. Phím `v` bật/tắt chi tiết, `q` dừng sau bước hiện tại, `Ctrl-C` dừng ngay (run vẫn resume được).
- **Log dạng dòng:** dùng khi có `--plain`, khi `CI=true`, hoặc khi stdout không phải TTY.

agentduo không bao giờ commit hay push. Thay đổi được để lại trong working tree cho bạn review rồi tự commit.

## Khi run cần bạn quyết định

Trong terminal, agentduo hiện lý do kèm menu:
- Resume;
- Revise (kèm ghi chú);
- xem plan cuối, review gần nhất, phản biện plan hoặc diff stat;
- Abort;
- Để sau.

Ở chế độ plain, run thoát với exit code 2, và bạn trả lời bằng `duo resume --decision …`. Tác dụng của `resume` theo từng lý do được liệt kê trong [README.md](README.md#when-a-run-needs-you).

## An toàn

- **Quyền được áp ở mức CLI:**
  - Codex chạy `--sandbox read-only`.
  - Claude khi phản biện chỉ có các tool đọc.
  - Claude khi implement dùng allowlist/denylist (chặn commit, push, `rm -rf`, `curl`, truy cập web).
- **agentduo tự kiểm chứng thêm:**
  - Snapshot toàn bộ working tree vào `refs/agentduo/...` mà không đụng vào index, HEAD hay branch của bạn.
  - Hash working tree trước và sau mỗi bước read-only.
  - Chặn mọi commit của agent và mọi thay đổi trên `protected_paths`.
  - Giới hạn số file bị xoá.
  - Mặc định từ chối chạy khi working tree có thay đổi chưa commit.

## Exit code

| Code | Ý nghĩa |
|---|---|
| 0 | DONE |
| 1 | lỗi cấu hình hoặc môi trường |
| 2 | đang chờ bạn quyết định |
| 3 | đã huỷ |
| 130 | đã dừng (resume được) |

Hỗ trợ macOS và Linux. Windows ở mức thử nghiệm.
````

```markdown file=AGENTS.md
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
```

- [ ] **Step 6: Update the spec, drop the Python version, and tidy .gitignore**

In `docs/superpowers/specs/2026-10-27-agentduo-npm-cli-design.md`:
- Replace the table row `| Ngôn ngữ / runtime | Viết lại bằng TypeScript (strict, ESM) trên Node ≥ 20, build bằng \`tsup\` |` with `| Ngôn ngữ / runtime | Viết lại bằng TypeScript (strict, ESM) trên Node ≥ 22.12 (Node 20 đã EOL từ 04/2026; Ink 8 và commander 15 yêu cầu Node 22), build bằng \`tsup\` |`.
- Replace `trên \`ubuntu-latest\` và \`macos-latest\`, Node 20 và 22` with `trên \`ubuntu-latest\` và \`macos-latest\`, Node 22 và 24`.
- Replace `Dùng vitest. Lệnh \`npm test\` chạy toàn bộ những gì dưới đây, trừ smoke test thật.` with `Dùng vitest. Lệnh \`npm test\` chạy unit, e2e và UI; smoke test đóng gói chạy riêng bằng \`npm run test:pack\` (cần mạng); smoke test thật chạy bằng \`npm run smoke:real\`.`

Then:

```bash
git rm -r -q .orchestrator tests
printf 'node_modules/\ndist/\n*.tgz\n.DS_Store\n.agentduo/runs/\n' > .gitignore
```

- [ ] **Step 7: Full verification**

Run: `npm run typecheck && npm test && npm run build && npm run test:pack && npm publish --dry-run`
Expected: no type errors; all test files PASS; `pack smoke OK`; the dry run lists only `dist/`, `schemas/`, `README.md`, `README.vi.md`, `LICENSE` and `package.json`, and publishes nothing.

Run: `npm run smoke:real`
Expected: the run reaches `[DONE]` with exit code 0, and the printed `git diff --stat` shows `calc.mjs` and `test/calc.test.mjs` changed. This costs real usage (about $0.5).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "docs: document agentduo, add CI and smoke tests; retire the Python orchestrator

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** §3 commands map to Task 15 and `init` gate detection to Task 12. §4 architecture, boundaries and config layering map to Tasks 2, 3 and 15. §5 agent invocations map to Tasks 6 and 8. §6 events, the activity mapping and the message table map to Tasks 2, 6 and 11. §7 UI maps to Tasks 13 and 14. §8 errors, safety and doctor map to Tasks 4, 11 and 12. §9 tests: every task has tests, `test:pack` is in Task 16 and CI is in Task 16. §10 release and the Python retirement map to Task 16. §11 risks: fixtures, doctor flags and `--plain` are covered.
- **Deviations from the spec:** Node ≥ 22.12 instead of ≥ 20 (Global Constraints); `test:pack` runs separately from `npm test` because it needs the network. Task 16 updates the spec for both.
