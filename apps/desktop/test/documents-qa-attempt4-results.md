# T3 — independent QA of candidate b268a9b

Owner: qa-1 only (R36). This is a fresh report. All three earlier QA reports and the developer's handoff remain untouched. No product code or existing test assertion was changed.

## Tested source

- Commit: `b268a9bca685f3329ca4b5108a38108329090f30`.
- Tracked candidate tree: `5952b1f0c038377b31d3f8b66d56109e8228f745`.
- The original three QA suites ran first from a clean worktree, directly against this candidate, with no source overlay: **50 collected, 50 passed**.
- Extended QA uses the same candidate plus the new QA-only `document-escapes-qa.test.ts` (SHA-256 `2e765e8ca864824cc83211ae8e2558f8f169e5a4ada01894537fd62558819c49`). This is an added test artifact, not a product change.
- `git diff --exit-code 406c87c057e70b0cf6d6226ce86ba6335a4c6509 HEAD --` over the original three QA suites passed: the earlier assertions were not weakened, skipped or changed.
- Runtime: macOS, Node 24.20.0, Vitest 5.0.5. Windows was not executed.

## Commands and results

From the candidate root, with Node/npm on PATH:

```sh
npm --prefix apps/desktop test -- test/documents-qa.test.ts test/document-links-qa.test.ts test/documents-handle-qa.test.ts
npm --prefix apps/desktop test -- test/documents-qa.test.ts test/document-links-qa.test.ts test/documents-handle-qa.test.ts test/document-escapes-qa.test.ts
```

| Check | Fresh result |
| --- | --- |
| Original QA | 3 files, **50/50 passed**, exit 0. |
| New escape QA alone | **6/6 passed**, exit 0. |
| Extended QA together | 4 files, **56/56 passed**, exit 0. |
| Full desktop `npm --prefix apps/desktop test` | 23 files, **444/444 passed**, exit 0. |
| Desktop typecheck | Passed, exit 0. |
| Desktop build | Passed, exit 0. |
| Full root `npm test` with installed entrypoints | **1557 passed, 4 skipped** (1561 collected); 87 files passed, 1 skipped; exit 0. |
| Webview `node node_modules/vitest/vitest.mjs run packages/webview/test` | 3 files, **30/30 passed**, exit 0. |
| Root/workspace typecheck | Passed, exit 0, using the installed TypeScript entrypoint as described below. |
| Desktop E2E | Attempted: exit 1, 3 setup failures, 37 tests skipped, 7 unhandled errors. The recorded errors are localhost `listen EPERM`, a 120-second hook timeout and Electron `Process failed to launch!` (plus `kill EPERM` during cleanup). No UI behavior was reached. |

The initial root `npm test` / `npm run typecheck` attempts ended with exit 127 (`vitest` / `tsc` not found). This checkout lacks `node_modules/.bin` shims. Those logs are preserved. Temporary executable wrappers under `/private/tmp/agentduo-t3-attempt4-bin-aBB64u` invoke the already-installed Node Vitest/TypeScript entrypoints with `"$@"`, preserving arguments. The root scripts were then run with that directory and Node's bin prepended to PATH. No dependency was installed or changed.

Logs: `/private/tmp/agentduo-t3-attempt4-original-qa.log`, `agentduo-t3-attempt4-all-qa.log`, `agentduo-t3-attempt4-desktop.log`, `agentduo-t3-attempt4-typecheck.log`, `agentduo-t3-attempt4-build.log`, `agentduo-t3-attempt4-root.log`, `agentduo-t3-attempt4-root-typecheck.log`, `agentduo-t3-attempt4-root-with-entrypoints.log`, `agentduo-t3-attempt4-root-typecheck-with-entrypoints.log` and `agentduo-t3-attempt4-webview.log` (all under `/private/tmp`).

E2E combined output is retained at `/private/tmp/agentduo-t3-attempt4-e2e.log`. No more specific Electron launch cause is inferred, no E2E pass is claimed, and this E2E attempt was not retried.

## Findings and added coverage

Q1–Q4 all pass their original QA reproductions on this candidate. In particular, the ordinary escaped-parenthesis link now opens the intended file. The identity, concurrent-open and safe in-place-overwrite fixes remain passing.

The six new independent cases cover the changed parser/main boundary (AC1, AC4, R28–R29):

- Three nested escape spellings open and save the intended `report(a(b))c.md` while a real file named with each literal-backslash spelling remains unchanged. They verify file bytes, not just parser output.
- Two ambiguous targets return `link-invalid` with disambiguation instructions before any filesystem lookup, and create no document session. These injected filesystem checks run on every OS.
- Replacing a bare ambiguous link with an explicit angle-bracket link to the same written href revokes the old ID. The stale ID fails; the new ID opens/saves the literal file and leaves the folder decoy unchanged.

The four real-file cases requiring POSIX backslash-containing filenames are skipped on Windows by design; Windows was not run in this session. The original target/encoding/symlink/ID/revision/failure/retry, exact-byte preservation, no-write-before-save, main IPC/registration and format-adapter checks all pass. These tests certify T3's main-process scope, not T2/T4/T5's formatted editing and dialog UX.

**Verdict: PASS for T3's assigned main-process QA cases (56/56).** No open product finding remains from this QA run. E2E startup was blocked and Windows was not executed; neither UI/Electron behavior nor Windows runtime behavior is claimed as verified. Product source and the three original QA suites remain unchanged; the only worktree additions in this turn are the six-case QA test file and this report.

## Product and historical artifact provenance (SHA-256)

| Artifact | Digest |
| --- | --- |
| `packages/webview/src/markdown.ts` | `87126c4990886cbd0a966a57bb43b80cb6a127173536de9470528a03242c9966` |
| `apps/desktop/src/shared/documents.ts` | `ca286268fd973498961431fba9c4c2eaa8e267ed5bbe1daf20e3097bbe3e2c93` |
| `apps/desktop/src/main/documents.ts` | `890c27a9faf0d4e9e8a4bfa733841bb3f63a445ed991afdb6be28a0fe7b1ba27` |
| Preserved `documents-qa-results.md` | `27783cf13ea59d391e8006887129c44778b3e0edd4bce62cffe8c9e4bcea391d` |
| Preserved `documents-qa-attempt2-results.md` | `78cd05dbbc63ca5c50523a57e51d15caaeeff1e4996783717a28866ab2fb5931` |
| Preserved `documents-qa-attempt3-results.md` | `d861b3134b7ef13c907a07728de55e5f1221db9b23ef5381b7b0d18c051b6516` |
