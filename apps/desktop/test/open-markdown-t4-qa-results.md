# T4 — independent QA tests

QA owns `test/e2e/open-markdown-qa.test.ts`, `test/e2e/fixtures/open-markdown-main.ts`, this report, and `packages/webview/test/markdown-open-qa.test.ts`. These names are separate from the designer's `test/document-view.test.ts` and the existing parser tests (R19/R36). No product code changed.

## Historical preimplementation check

The results through "Coverage and limits" below are historical, from checkout `281dd1d7ca9da685fa6bc5e9b5a709f984cc13f7`, when T4's new renderer files were absent. The integrated recheck at the end supersedes them where it says so.

## Commands from the repository root

```sh
node node_modules/vitest/vitest.mjs run packages/webview/test/markdown-open-qa.test.ts packages/webview/test/markdown.test.ts
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop test
npm --prefix apps/desktop run build
npm --prefix apps/desktop run test:e2e -- open-markdown-qa
```

Always rebuild before E2E: the existing E2E launcher otherwise reuses `dist`.

## Observed results

- Parser: **31 passed**, including **14 new QA cases** and 17 existing cases.
- Desktop typecheck: **passed** after fixing an incorrect test-fixture update-state value.
- Existing desktop unit tests: **958 passed**, 27 files. The E2E directory is intentionally excluded from this command.
- Desktop build: **passed**.
- New E2E: **51 collected, 51 failed in setup**, before any UI assertion ran. These are not 51 product findings.

Failure reproduction: run the E2E command above. Expected: Electron starts and the actual renderer receives a PM snapshot. Observed: `electron.launch: Process failed to launch!`; Playwright's child-process call log reports `exitCode=null, signal=SIGABRT` and an `EPERM` while attempting cleanup. The separate existing baseline command `npm --prefix apps/desktop run test:e2e -- shell -t 'at 1360×860 shows'` fails at the same launch step. This establishes that the baseline also cannot start here; it does **not** establish the cause of the abort. Child stdout/stderr streams were not available because launch never returned. Playwright also reports three unhandled launch rejections per attempted launch.

Available launch logs were retained before subsequent attempts at `/private/tmp/agentduo-t4-qa-electron.log` and `/private/tmp/agentduo-t4-baseline-electron.log`. They are local diagnostic artifacts, not portable test fixtures; the normalized evidence above omits personal paths and transient PIDs. The test captures the launch exception and, after a successful launch, child stdout/stderr for failed cases (R26).

## Coverage and limits

- C1–C5: rendered PM link, exact worktree target rather than a workspace decoy, direct edits of each AC2 structure, explicit-save-only disk writes, reopen, preservation of untouched bytes and immutable unsupported structures.
- C6–C10: missing/unreadable open, failed-save retry, editing during a delayed save, late open delivery, changed-on-disk conflict.
- C11–C13: Save/Discard/Keep editing for close, another document, conversation, project and Settings; failed leave-save; renderer responses for window/quit close requests.
- C14–C21: keyboard and focus trapping, Vietnamese paste and synthetic composition, 720×480 in both themes, hostile HTML and local/remote resource URLs, unsupported formats, no-hook webview regression, and end-to-end link targets with spaces, parentheses, escapes, titles and file URLs.
- Parser QA independently covers targets and their ordinal order, code exclusions, malformed input and ambiguity (R28/R29/R37).

The Electron fixture runs the **production renderer entry, chat, preload, Markdown model and DocumentService**. It supplies controlled PM `host` snapshots and app navigation responses; no PM model or worker subprocess runs. It validates renderer-side close requests, not T5's native close/quit wiring. The primary link uses a real click; the alternate-document guard uses the rendered link's DOM click event so this test imposes no requirement that a document panel leave the chat uncovered.

UI selectors use existing chat/shell classes, semantic contenteditable/formatting elements, and accessible action names (Vietnamese or English). Link-destination editing expects a named destination/URL field and an Apply/Update/OK action. If the approved UI uses a different accessible interaction, adapt the test to that interaction without weakening the requirement. No runtime UI result is claimed until Electron runs these assertions.

Real OS Vietnamese IME behavior, visual appearance/contrast, a real PM/worker stream, and full-app T5 close/quit integration remain to be checked in a desktop-capable environment. Synthetic composition and geometry assertions do not replace those checks. AC8 design/code review belongs to the integration review and is not claimed here.

## Integrated recheck — current evidence

Base checkout: `2c7db31fa05aa02a29dcb6f743758165150ddcf7`, with T4 and the designer's caret/reload fixes integrated. QA owns the additional `test/document-controller-qa.test.ts`. No product code changed in this recheck.

Commands (repository root):

```sh
node node_modules/vitest/vitest.mjs run packages/webview/test/markdown-open-qa.test.ts packages/webview/test/markdown.test.ts test/boundaries.test.ts
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop run build
npm --prefix apps/desktop test
node node_modules/vitest/vitest.mjs run --config apps/desktop/vitest.config.mts apps/desktop/test/document-controller-qa.test.ts
npm --prefix apps/desktop run test:e2e -- open-markdown-qa
npm --prefix apps/desktop run test:e2e -- open-markdown-editor
```

Observed results:

- Parser/boundary selection: **40 passed** across 3 files.
- Typecheck and build: **passed**.
- Desktop before the new controller QA: **1004 passed**. After adding it: **1010 passed, 4 failed** across 29 files.
- Independent controller QA: **6 passed, 4 failed**, representing the two code defects below. Passing cases cover retention after a newer document wins, deduplicated reopen of an already displayed file, editing during save with revision updates, unsafe serialization refusal, failed native-close Save and retry, and retention after a late reload answer. The late-reload regression therefore reproduces the designer's reported fix independently.
- QA E2E: **51 setup failures**, again before any UI assertion. The separate designer-owned `open-markdown-editor` suite also fails in setup and skips its 9 assertions. Both logs show `Process failed to launch`, `exitCode=null, signal=SIGABRT`; QA's log also records `EPERM` during attempted cleanup. Child stdout/stderr streams were unavailable before launch returned. Logs were retained before another suite was attempted at `/private/tmp/agentduo-t4-qa-recheck.log` and `/private/tmp/agentduo-t4-editor-baseline-recheck.log`. The reason Electron aborts here remains unconfirmed; this is not evidence against the designer's results in a different execution context (R26).

Corrections to the earlier E2E tests (test errors, not product findings): preview links are inert `.doc-link` spans, not navigable anchors; code fields use `contenteditable="plaintext-only"`; link targets update live and Enter returns to the label rather than requiring an Apply action. A synthetic ClipboardEvent cannot trigger default browser paste, so the test now supplies the editor's handled `beforeinput/insertFromPaste` event with both clipboard MIME types and an explicit selection. A second opening through the covered chat uses its DOM handler, and the late-result test waits for session cleanup instead of assuming two animation frames are enough. These revised UI assertions are typechecked but remain unexecuted because of Electron launch failure.

### Q1 — completed navigation does not invalidate a pending open

Evidence: the three `does not reopen a document after … navigation completed` cases in `document-controller-qa.test.ts` fail for a clean document, dirty Discard and dirty Save.

Reproduce: open A; begin opening B with its response held; call and await `leave("leave")` (the boundary `main.ts` awaits before project/conversation/Settings navigation); confirm that the document is gone; release B's response.

Expected: the completed leave remains in effect, B is not displayed and its unused session is released. Actual: `controller.document` becomes B and its layer is shown again. `documents.ts:340` invalidates `opening` only when there is no current document; leaving an existing one (`close`, line 367) does not do so. Its earlier token is consequently still accepted at line 160, followed by `show` at line 182.

Assessment: code defect against AC6 and T4's late-response handling; deterministic controller-level evidence, with navigation wiring confirmed by code review. An overlapping open while another document is displayed is exercised at the controller boundary; the current covered-chat layout has not been driven in Electron. Fix direction: distinguish a completed user navigation/close from the internal leave performed by a winning open, and invalidate earlier open work on that completed navigation. Verify all three new cases plus normal document switching; simply incrementing the token in every leave could cancel the intended switch too.

### Q2 — stale response cleanup closes the winning shared session

Evidence: `two concurrent opens of the same file leave the winning session usable for an explicit save` fails. This case uses the **real DocumentService and a real temporary Markdown file**, with only response delivery controlled.

Reproduce: concurrently open two granted links to the same path; wait until main has returned the same document ID to both (R39); deliver the older result first; deliver the winning result; edit the shown viewer and call Save.

Expected: the winning shared session remains valid and saves the edited text to the original file. Actual: Save returns false with `session-unknown`; the original file remains unchanged. At `documents.ts:162`, the stale result closes the shared document ID because the winner has not yet become `current`. The winning response later displays that already-closed session.

Assessment: code defect against AC4/AC7 and the shared-session lifecycle of R39. This is deterministic controller/service evidence; a physical overlapping-click sequence is not claimed. Fix direction: coordinate disposal of stale open results with every still-pending candidate sharing that session, rather than checking only the displayed ID. Verify the real-service regression and the existing stale-result cleanup case so a fix neither closes the winner nor leaks abandoned sessions.

### Acceptance status

**Fail.** Q1/Q2 are unresolved. AC8's renderer extension point is present (`VIEWERS` keyed by `DocumentInfo.format`, with an explicit unsupported-viewer error); DOM review shows text-node rendering and inert document links. These source checks do not substitute for UI execution. PM-link editing/reopen, all UI leave dialogs, focus, both themes/minimum window, real OS IME/paste and full-app close/quit still need runtime verification in an environment that can launch Electron. No RAM/process-measurement conclusions are made.
