# T3 attempt 3 — dev-1's handoff to qa-1 (separate from the historical `documents-qa-results.md`)

## QA suites restored unchanged
The four QA files were not in this worktree and were restored byte for byte from snapshot `01e3a54d080168d63f38c9b6d15d3dc6727ad13e`
(copied from `/private/tmp/agentduo-t3-fix-handoff-y823jD/`, then compared with the same snapshot's blobs). SHA-256, equal to `manifest.json`:

| file | sha256 |
| --- | --- |
| documents-qa.test.ts | 7e10b7d3b9c4ff7736c54da037dd220395aa62666b2cdd48fc59f8304187b611 |
| document-links-qa.test.ts | 9f778e241763e02adc407883845e62a03bddedd81ad5a71be61fcdf148a27b05 |
| documents-handle-qa.test.ts (the 8 added cases) | f3bb32b81d53d4246e3b20435c0fac7b953a5c0daec64efe6c7da6a5c8e37bef |
| documents-qa-results.md (historical, untouched) | 78cd05dbbc63ca5c50523a57e51d15caaeeff1e4996783717a28866ab2fb5931 |

No assertion of QA was edited, skipped or weakened.

## Changes in `src/main/documents.ts` (dev's results, not yet a QA result)
- Q2 (AC7): a session keeps the identity (`dev:ino`, from `fh.stat({bigint:true})` of the handle that read the file) taken at open, at reload and after each save.
  `verify` (before writing and again right before the rename) and `writeInPlace` (handle, path and session) refuse another identity with `changed-on-disk`, `overwrite` or not,
  also for a replacement with the same bytes; nothing of the replacement is touched and the session stays. After a replace-save the file at the path is read back through its handle:
  it must hold the bytes written, and its identity becomes the session's. Reload adopts the file on disk now.
- Q3 (AC4): `saveAllowance` is awaited before the last `byKey` check, so nothing is awaited between that check and `sessions.set`; two overlapping opens get the same id (one new, one existing) and both owners.
  `reopened` adds the owner only if the session is still registered. A failed open registers nothing.
- Q4 (AC7): `writeInPlace` refuses before the first byte when the current file is over the limit (no full backup possible): `save-failed` with `overwrite`, `changed-on-disk` without. The rollback now always has the whole original.

## Run (dev, this worktree, base commit f1f8aa8 + uncommitted changes; not a QA run)
- `npm --prefix apps/desktop test -- test/documents-qa.test.ts test/document-links-qa.test.ts test/documents-handle-qa.test.ts`: 50 collected, 49 passed, 1 failed.
  The one failure is Q1 (`registers the same target the user sees: escaped parentheses`): the link parser in T1's `shared/documents.ts`, outside T3; not fixed, not skipped. Left for the PM.
- Whole desktop suite: 430 collected, 429 passed, 1 failed (the same Q1). `typecheck` and `build` of apps/desktop passed (root and desktop `npm ci --offline --ignore-scripts`).
- `test:e2e` (Electron) was not run, so it is not recorded as passed.
- qa-1 must run from the candidate's root and record the commit and tree actually tested.

## Follow-up after the techlead's review (R5)
- A replace-save now takes the identity of the temporary file from the handle that wrote it (`fh.stat({bigint:true})` after the flush). After the rename the path is read back through its own handle: a different identity is `changed-on-disk` (session kept, old identity kept, so no later save, `overwrite` or not, goes into the file found there until the user reloads); then the bytes must equal what was written.
- Regression in `documents.test.ts`: a real rename, then the saved file is moved to `published.md` and a separate file with the same bytes put at the path. The first save reports `changed-on-disk`, later saves too (both `overwrite` values), the replacement is untouched, and a reload takes it as the document.
- Dev run (worktree on 1d997d3 + uncommitted `documents.ts` / `documents.test.ts`): desktop suite 430 collected, 429 passed, 1 failed (Q1, T1 parser, not fixed); typecheck passed. Not a QA run; `test:e2e` not run.

## Q1 fixed in the chat's link parser (dev-1, the one product-fix turn approved by the PM as T3-E4)
Origin: T1 (`packages/webview/src/markdown.ts`, read by the page and by main's `documentLinkSites` alike); the PM allowed the fix in this T3 turn. The restored QA report `documents-qa-attempt3-results.md` comes from snapshot `038c5eb24df78ab004d6b6ef945a3029a8b90dc6` (compared byte for byte with `git show`); it and the other QA files/reports are untouched (R36: dev notes stay in this file).
- Cause: `plan\(1\).md` was kept with its backslashes, and the path rules then split the name at them (`).md`).
- Fix: in a bare target `\(` and `\)` are Markdown escapes when the link then closes cleanly at its own `)`; the target holds the parenthesis (`plan(1).md`). Kept as written: a drive or UNC path, a relative Windows path in which a `\(` is closed by a bare `)` (`dir\(x)\a.md`), the `<…>` form, and every other backslash. No fix in main, no lookup of another file; `main/documents.ts` is unchanged.
- Tests (dev-owned): `document-links.test.ts` (pairs, single `\(`/`\)`, title, text after, Windows path forms, ids in step) and `documents.test.ts` (opens `plan(1).md`, `plan(1.md`, `plan).md` from escaped links among same-named decoys; a missing name is `not-found`).
- Dev run (worktree on eeaa546 + uncommitted changes; not a QA run): the three QA suites 50 collected, 50 passed; desktop 22 files, 434 tests passed; `packages/webview` 30 passed; root `test` + `packages/host` 1557 passed, 4 skipped; desktop typecheck and build passed. `test:e2e` not run.
