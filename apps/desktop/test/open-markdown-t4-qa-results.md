# T4 — independent QA tests

QA owns `test/e2e/open-markdown-qa.test.ts`, `test/e2e/fixtures/open-markdown-main.ts`, this report, and `packages/webview/test/markdown-open-qa.test.ts`. These names are separate from the designer's `test/document-view.test.ts` and the existing parser tests (R19/R36). No product code changed.

Base checkout: `281dd1d7ca9da685fa6bc5e9b5a709f984cc13f7`. T4's new `renderer/documents.ts` and `renderer/markdown-editor.ts` are not present in this checkout. These tests specify acceptance behavior ahead of that implementation.

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
