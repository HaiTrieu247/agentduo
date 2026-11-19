# T3 independent QA

QA owns `documents-qa.test.ts`, `document-links-qa.test.ts` and `documents-handle-qa.test.ts`. Dev's test files are untouched (R19). No product code was changed.

## Run

From the repository root:

```sh
npm --prefix apps/desktop test -- test/documents-qa.test.ts test/document-links-qa.test.ts test/documents-handle-qa.test.ts
```

This collects 50 cases: the original 38 service cases and 4 ProjectManager/Dispatcher integration cases, plus 8 handle/write-boundary cases. The integration suite controls host snapshots and `onChange`, runs the real main services and uses fake timers for batching. It does not launch Electron or an agent. Two tests containing three symlink scenarios run on POSIX; Windows runs the native-path/file-URL case and all injected filesystem-error cases. Windows was not executed in this QA session.

## Integrated candidate recheck — 2026-11-19

Fresh execution in the QA worktree at HEAD `29888f5e76245ed3dbfeb7afda47eb5c370ccc43` (T3 candidate), with no source overlays:

- Original QA suites: **39 passed, 3 failed (42)**. F1–F3 below remain open.
- Added handle/write-boundary suite: **7 passed, 1 failed (8)**. F4 below is new.
- All QA suites together: **46 passed, 4 failed (50)**.
- Full `npm --prefix apps/desktop test`: **420 passed, 4 failed (424)** across **22 files** (20 passed, 2 failed). The four failures are the same QA findings. Dev's 374 non-QA cases pass in this combined run.
- `npm --prefix apps/desktop run typecheck`: passed, exit 0.
- `npm --prefix apps/desktop run build`: passed, exit 0.
- A fresh `npm --prefix apps/desktop run test:e2e`: exit 1; 3 suite setup failures, 37 tests skipped, 7 unhandled errors. The recorded errors are a localhost `listen EPERM`, a 120-second hook timeout and Electron `Process failed to launch!` (with `kill EPERM` during launch cleanup). No UI behavior was reached. Combined output is retained at `/private/tmp/agentduo-t3-recheck-e2e.log`; no further launch cause is inferred and this run was not retried.

These are new results on the integrated candidate. The earlier missing-module and temporary-harness observations below are historical. The current product source hashes match the provenance table below. Logs for this recheck are `/private/tmp/agentduo-t3-recheck-qa.log`, `/private/tmp/agentduo-t3-recheck-desktop.log` and `/private/tmp/agentduo-t3-recheck-build.log`.

The additional suite confirms R31 for detached write handles with `overwrite` both false and true, a non-regular write handle, and a read error on the actual write handle. These cases write zero bytes on refusal and keep the session. It also confirms that rollback uses current handle bytes rather than the session's old source, and that temporary-file writes handle both short writes and zero progress safely. All filesystem faults in this suite are injected on real handles, without platform-dependent permission tests.

## Historical observations before T3 integration

At the first QA turn, the QA worktree did not yet contain `src/main/documents.ts` or T3's project/IPC wiring. Its normal test command failed during import; no QA cases executed there. The existing desktop suite passed 333 cases across 17 files; the 2 new suites failed to load. The worktree's typecheck also reported the missing T3 API and the unhandled document requests. Build passed.

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

### F4: Oversized current file is corrupted after a failed in-place overwrite (AC7, R30)

Reproduce: run `npm --prefix apps/desktop test -- test/documents-handle-qa.test.ts -t 'oversized external file'`. Register an 8-byte Markdown limit and open a 4-byte `BASE` file. Externally change it to `EXTERNAL CONTENT LONGER THAN THE LIMIT`. Deny temporary-file creation with injected `EACCES`, then save `EDIT` with `overwrite: true`. Inject a transient `ENOSPC` after the first two bytes of the real write handle are written; subsequent writes would succeed.

Expected: either refuse before writing when no safe backup is available, or restore the complete current file after failure. The session remains available.

Observed: save reports failure, but the file becomes `EDTERNAL CONTENT LONGER THAN THE LIMIT`. `readHandle` returned null because the current file exceeded the limit; `overwrite: true` allowed writing anyway, and the error path skipped rollback because there was no original buffer. The failure is real byte corruption, not an inferred memory effect. Refuse this in-place overwrite before writing, or provide a complete recoverable backup.

The original partial-write, flush, rename, short-write, rollback, external-edit-during-save, multibyte limit, exact-byte preservation, session retry and all four main integration cases also pass in the new integrated recheck. Renderer preview editing, dirty UI and quit dialogs belong to T2/T4/T5 and are not certified by these main-process tests. R32–R34 concern the T2 editor and introduce no new T3 expectations here.
