# T3 — independent QA of candidate 406c87c

This report is owned by qa-1 for this candidate (R36). It is a new run report. `documents-qa-results.md`, `documents-qa-attempt2-results.md` and the developer's `documents-t3-attempt3.md` are historical/handoff artifacts and were not edited. No product code, test file or assertion was changed in this QA turn.

## Candidate actually tested

- Commit: `406c87c057e70b0cf6d6226ce86ba6335a4c6509`.
- Tracked tree: `3d32ee5c777cfad18ef0e560dd212a00c47bf746`.
- Worktree was clean before testing; tests ran directly from this candidate, with no source overlay.
- The product source and the three QA suites have no differences from approved commit `3585893d1118c7abe0456490d78dcf83a75ab965` (`git diff --exit-code` over `apps/desktop/src`, `packages/webview/src` and the three test files passed).
- Node 24.20.0; Vitest 5.0.5; macOS. Windows was not run.

## Fresh commands and results

From the candidate repository root, with Node/npm on PATH:

```sh
npm --prefix apps/desktop test -- test/documents-qa.test.ts test/document-links-qa.test.ts test/documents-handle-qa.test.ts
```

Exactly **50 cases collected: 49 passed, 1 failed**, across the three expected files (2 passed, 1 failed). Log: `/private/tmp/agentduo-t3-attempt3-qa.log`. Exit 1.

| Check | Fresh result |
| --- | --- |
| Full `npm --prefix apps/desktop test` | 430 collected: 429 passed, 1 failed; 22 files: 21 passed, 1 failed; exit 1. The failure is the same Q1. |
| `npm --prefix apps/desktop run typecheck` | Passed, exit 0. |
| `npm --prefix apps/desktop run build` | Passed, exit 0. |
| `npm --prefix apps/desktop run test:e2e` | Attempted on this candidate: exit 1, 3 setup failures, 37 tests skipped, 7 unhandled errors. Startup reported localhost `listen EPERM`, a 120-second hook timeout and Electron `Process failed to launch!`. No UI test executed. |

Logs: `/private/tmp/agentduo-t3-attempt3-desktop.log`, `/private/tmp/agentduo-t3-attempt3-typecheck.log`, `/private/tmp/agentduo-t3-attempt3-build.log`.

The fresh E2E runner's combined output is retained at `/private/tmp/agentduo-t3-attempt3-e2e.log`, including available launch/cleanup errors. No more specific Electron launch cause is inferred and no E2E pass is claimed. This attempt was not retried.

## Finding status

**Q1 remains open (AC1, R29): escaped-parenthesis link.**

```sh
npm --prefix apps/desktop test -- test/documents-qa.test.ts -t 'escaped parentheses'
```

The fixture creates `plan(1).md`, registers `[open](plan\(1\).md)` after a web link and opens the ID granted at ordinal 1. Expected: the existing `plan(1).md` opens. Actual: a grant exists, but opening returns `not-found` with `).md does not exist.`. Suspect: code in the shared link-target parsing/resolution path (T1 dependency), not the test or the file service's save fixes. `shared/documents.ts` obtains hrefs through the webview Markdown parser; `readDestination` retains backslashes, and the resulting path is not the intended POSIX filename. Preserve Windows separators while correcting Markdown escapes. This issue is not waived because it belongs to T1; the complete T3 acceptance/test set remains **FAIL**.

**Q2 verified fixed:** replacing the opened file with another file holding equal bytes is refused with `changed-on-disk`; the replacement remains unchanged and reload keeps the session. Source review confirms the session records handle-derived `dev:ino` independently of content (R35), compares it during verification and adopts a new identity only after successful save verification or explicit reload. The full suite also passes the regression that swaps in a same-content file just after rename and confirms it is not adopted as the saved document.

**Q3 verified fixed:** concurrent opens return the same document ID, with one new and one existing response. `saveAllowance` now completes before the last lookup, with no await between that lookup and registration.

**Q4 verified fixed:** an oversized current file is refused before the first in-place write even with `overwrite:true`, so the injected partial-write failure cannot corrupt it. The file and session remain intact. Existing handle identity, non-regular handle, read-error, short-write, zero-progress and rollback checks pass (R30–R31).

Other passing coverage: exact workspace/worktree/attachment target despite same-name decoys; relative/absolute/file-URL links; spaces, Unicode, one-pass URL decoding, fragments and native path behavior; symlink preservation and POSIX symlink/.. resolution; fabricated/stale/other-conversation IDs; snapshot and chat-change grants; no write before explicit save; exact Markdown bytes; revision conflicts; missing/unreadable/unwritable files; injected write/flush/rename failures and retry; registry/codec extension point; renderer requests cannot substitute paths, and opening a document does not call the shell.

The eight handle QA cases and four ProjectManager/Dispatcher QA cases all passed. Main-process tests do not certify formatted preview editing or unsaved-change dialogs from T2/T4/T5. No new tests were needed in this turn.

## Provenance (SHA-256)

| Artifact | Digest |
| --- | --- |
| `apps/desktop/src/main/documents.ts` | `97f753a5ed319e0d81d2d29d643c265e81bfb98c94c9f88d57541b5dd76f880f` |
| `apps/desktop/test/documents-qa.test.ts` | `7e10b7d3b9c4ff7736c54da037dd220395aa62666b2cdd48fc59f8304187b611` |
| `apps/desktop/test/document-links-qa.test.ts` | `9f778e241763e02adc407883845e62a03bddedd81ad5a71be61fcdf148a27b05` |
| `apps/desktop/test/documents-handle-qa.test.ts` | `f3bb32b81d53d4246e3b20435c0fac7b953a5c0daec64efe6c7da6a5c8e37bef` |
| Historical `documents-qa-results.md` (preserved) | `27783cf13ea59d391e8006887129c44778b3e0edd4bce62cffe8c9e4bcea391d` |
| Historical `documents-qa-attempt2-results.md` (preserved) | `78cd05dbbc63ca5c50523a57e51d15caaeeff1e4996783717a28866ab2fb5931` |
