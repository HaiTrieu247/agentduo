# T2 independent QA fixtures

QA owns `markdown-preservation-qa.test.ts` and the `qa-*` files in this folder. Dev owns `markdown-document.test.ts` and may use separate fixture names (R19).

Sources are JSON string values to preserve BOM, CRLF, LF, Unicode normalization and missing final newlines through Git checkouts on Windows. Tests compare the decoded source and its UTF-8 bytes; no snapshot regeneration or platform newline conversion is needed. There are 16 preservation fixtures and 12 opaque-syntax fixtures.

Run from the repository root, with Node >= 22.12 and npm on PATH:

```sh
npm --prefix apps/desktop test -- test/markdown-preservation-qa.test.ts
```

The desktop's own Vitest configuration collects this file; the root `npm test` does not collect desktop tests. The suite contains 87 cases. To collect the full desktop unit suite, use `npm --prefix apps/desktop test`.

T1 specifies the returned `MarkdownDocument` interface, but does not name its creation export. The single `open()` adapter currently binds `createMarkdownDocument(source)` from `shared/markdown-document.ts`. If dev chooses another export, align only that adapter with the agreed factory before judging behavior. The dynamic import lets all cases run and report a missing module instead of failing collection.

| Acceptance | Independent checks |
| --- | --- |
| AC2 | Paragraphs, ATX/setext headings, ordered/unordered/nested/loose lists, bold/italic/nested formatting, links with destinations and titles, backtick/tilde fenced code remain editable; source changes and structural formatting changes reopen with the expected block types. |
| AC3 | Original model and independent draft branches stay unchanged; dirty state follows the edited model; serializing is repeatable. This tests the pure model. Disk writes and the visible unsaved indicator belong to the service/UI tasks. |
| AC4 | Edits serialize to the specified Markdown and reopen without a further conversion; successive edits, deletion, insertion, and replacing one block with multiple blocks preserve surrounding source. Actual filesystem save belongs to T3. |
| AC5 | Exact byte preservation, UTF-16 spans, stable untouched blocks, BOM, LF/CRLF/mixed endings, terminal newline, Unicode, punctuation escapes, link titles/destinations and safe fences. Opaque syntax survives unchanged or returns a reason with no writable text. Unwritable text drafts (NUL/lone surrogates) are refused, retained and recoverable. |

The `replace`/`insert` contract accepts Markdown source, not DOM text. Safe fence and escaped-text examples therefore exercise already-encoded Markdown; DOM-to-Markdown escaping and semantic equivalence with the formatted editor must also be tested by T4. This suite does not claim UI or disk-save acceptance.

## Execution evidence (2026-11-19, before T2 implementation)

- `npm --prefix apps/desktop test`: 420 cases collected; 333 existing cases passed and all 87 new QA cases failed at import. Actual error: missing `shared/markdown-document.js` (the corresponding TypeScript module is absent). Expected after integration: a factory returning the T1 interface, followed by each case's assertions. This is implementation availability evidence, not 87 distinct product defects.
- `npm --prefix apps/desktop run typecheck`: fails with the existing `TS2366` at `src/main/ipc.ts:84` (function lacks an ending return). No QA-file diagnostic. QA did not change that file.
- `npm --prefix apps/desktop run build`: passed.
- `npm --prefix apps/desktop run test:e2e`: no test body ran; 37 cases pending because setup failed. `desktop.test.ts` hit its 120000ms hook timeout; `settings-ui.test.ts` and `shell.test.ts` reported `electron.launch: Process failed to launch`, process exit `SIGABRT`, and cleanup `kill EPERM`. The available launch/exit information does not establish the underlying cause. Expected: Electron launches and runs the cases. These are baseline execution limitations, not T2 behavioral failures.

Reproduce with the commands above; the missing-module failure also reproduces with the focused QA command. Retest this suite after T2 is merged, and rerun the desktop checks in an environment where Electron setup succeeds. No product code was changed by QA.
