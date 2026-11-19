# T3 independent QA

QA owns `documents-qa.test.ts` and `document-links-qa.test.ts`. Dev's test files are untouched (R19). No product code was changed.

## Run after integrating T3

From the repository root:

```sh
npm --prefix apps/desktop test -- test/documents-qa.test.ts test/document-links-qa.test.ts
```

This collects 42 cases: 38 service cases and 4 ProjectManager/Dispatcher integration cases. The integration suite controls host snapshots and `onChange`, runs the real main services and uses fake timers for batching. It does not launch Electron or an agent. Two tests containing three symlink scenarios run on POSIX; Windows runs the native-path/file-URL case and all injected filesystem-error cases. Windows was not executed in this QA session.

## Observed results

The QA worktree does not yet contain `src/main/documents.ts` or T3's project/IPC wiring. Its normal test command fails during import; no QA cases execute there. The existing desktop suite passed 333 cases across 17 files; the 2 new suites fail to load. The worktree's typecheck also reports the missing T3 API and the unhandled document requests. Build passed.

The required existing `npm --prefix apps/desktop run test:e2e` was attempted. `desktop.test.ts` setup timed out and reported `listen EPERM` on `127.0.0.1`; the other two suites reported Electron `Process failed to launch!`. All 3 suites failed and all 37 tests were skipped. The run ended with exit code 1. Combined runner output was retained at `/private/tmp/agentduo-t3-qa-desktop-e2e.log`; it does not establish a more specific Electron launch cause. No E2E pass is claimed and no retry was made.

To validate the tests before the product merge, QA copied dev-2's in-progress desktop source into an isolated temporary harness at 2026-11-18T17:21:40Z, together with the parser and host dependencies used by the harness. Product files in either worktree were not modified. The harness compiled with strict TypeScript. It collected all 42 tests: **39 passed, 3 failed**. These are provisional observations of that source snapshot, not results for a final integrated build.

Provenance (SHA-256):

| Source from dev-2 | Digest |
| --- | --- |
| `apps/desktop/src/main/documents.ts` | `5fd7d7bf0ce5685ed1f94db0269b3032e175941d4857d3e3093e4de0f6b5e3da` |
| `apps/desktop/src/main/projects.ts` | `d4ab84db799b98f3014a0d5683dcf09b916126682d0008b2fad15020ca5a2f2d` |
| `apps/desktop/src/main/ipc.ts` | `89d8066ca0d981a6edad620614d4efbbe7bae8ed8599c08a1f9637d315469ef9` |
| `packages/webview/src/markdown.ts` | `9ffbd1184617dfe97359da5867bd1d39c03d1ae39f8c92314bae121f0d2673d0` |

## Failures to triage

### F1: Escaped-parenthesis link fails to open (AC1, R29)

Reproduce: run the service suite with `-t 'escaped parentheses'`. The fixture creates `plan(1).md`, registers the valid Markdown link `[open](plan\(1\).md)` after a web link, and opens its granted ID.

Expected: ordinal 1 opens the real `plan(1).md`, preserving the target across Markdown parsing, main registration and file resolution.

Observed: the grant exists, but opening returns `not-found` (`).md does not exist.`). The other eight filename/encoding cases pass. Review the shared Markdown target parser and escape handling; retain literal Windows separators.

### F2: Replacing a file with equal bytes is not detected (T3 file-replacement requirement, AC7)

Reproduce: run with `-t 'replacement file'`. Open `replaced.md`; move it to `original.md`; move a separately created `replacement.md` with identical content into the opened path; save using the original revision, with overwrite disabled.

Expected: `changed-on-disk`, replacement untouched, session retained for reload/retry.

Observed: save returns `ok: true`. Content equality does not establish that this is still the opened file. Record and compare filesystem identity, updating it after the service's own atomic save and an explicit reload.

### F3: Concurrent opens create two sessions for the same file (T1 section 6, AC4)

Reproduce: run with `-t 'two clicks'`. Grant one link, then call `open` twice through `Promise.all` before either finishes.

Expected: one document ID and one fresh/one existing response, as required by the single-session-per-real-path contract.

Observed: the two requests return `d1` and `d2`, both fresh. Deduplicate in-flight opens as well as completed sessions.

The partial-write, flush, rename, short-write, rollback, external-edit-during-save, multibyte limit, exact-byte preservation, session retry and all four main integration cases pass in the recorded harness. Renderer preview editing, dirty UI and quit dialogs belong to T2/T4/T5 and are not certified by these main-process tests.
