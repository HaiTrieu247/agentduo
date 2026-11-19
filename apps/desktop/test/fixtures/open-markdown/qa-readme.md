# T2 independent QA fixtures

**Scoped T2 conclusion: PASS.** The latest section records a fresh verification of revision `9e07a1b9`, with the established QA assertions restored unchanged. The earlier report-only classification correction and its historical evidence are retained below. Overall desktop typecheck/E2E status is reported separately; this is not whole-product acceptance or a check exemption.

QA owns `markdown-preservation-qa.test.ts`, `markdown-tree-qa.test.ts`, `markdown-fence-qa.test.ts` and the `qa-*` files in this folder. Dev owns `markdown-document.test.ts` and may use separate fixture names (R19). The execution sections below retain historical results; the latest recheck is at the end.

Sources are JSON string values to preserve BOM, CRLF, LF, Unicode normalization and missing final newlines through Git checkouts on Windows. Tests compare the decoded source and its UTF-8 bytes; no snapshot regeneration or platform newline conversion is needed. There are 16 preservation fixtures and 12 opaque-syntax fixtures.

Run from the repository root, with Node >= 22.12 and npm on PATH:

```sh
npm --prefix apps/desktop test -- test/markdown-preservation-qa.test.ts
npm --prefix apps/desktop test -- test/markdown-preservation-qa.test.ts test/markdown-tree-qa.test.ts
npm --prefix apps/desktop test -- test/markdown-preservation-qa.test.ts test/markdown-tree-qa.test.ts test/markdown-fence-qa.test.ts test/markdown-document.test.ts
```

The desktop's own Vitest configuration collects these files; the root `npm test` does not collect desktop tests. The preservation file contains 87 cases, the tree file 31, and the fence file now 17, for 135 QA cases. To collect the full desktop unit suite, use `npm --prefix apps/desktop test`.

T1 specifies the returned `MarkdownDocument` interface. After integration the QA adapter binds T2's actual export, `parseMarkdownDocument(source)`. The initially guessed factory name was scaffolding, not a behavior requirement. Two test mistakes were corrected before evaluating behavior: `blockSource()` is editor-facing LF text while spans address original source, and the old marker `changed` collided with `Unchanged` in the untouched tail. These corrections leave byte-for-byte serialization assertions intact.

| Acceptance | Independent checks |
| --- | --- |
| AC2 | Paragraphs, ATX/setext headings, ordered/unordered/nested/loose lists, bold/italic/nested formatting, links with destinations and titles, backtick/tilde fenced code remain editable; source changes and structural formatting changes reopen with the expected block types. |
| AC3 | Original model and independent draft branches stay unchanged; dirty state follows the edited model; serializing is repeatable. This tests the pure model. Disk writes and the visible unsaved indicator belong to the service/UI tasks. |
| AC4 | Edits serialize to the specified Markdown and reopen without a further conversion; successive edits, deletion, insertion, and replacing one block with multiple blocks preserve surrounding source. Actual filesystem save belongs to T3. |
| AC5 | Exact byte preservation, UTF-16 spans, stable untouched blocks, BOM, LF/CRLF/mixed endings, terminal newline, Unicode, punctuation escapes, link titles/destinations and safe fences. Opaque syntax survives unchanged or returns a reason with no writable text. Unwritable text drafts (NUL/lone surrogates) are refused, retained and recoverable. |

The `replace`/`insert` contract accepts Markdown source, not DOM text. The added tree suite exercises `replaceNodes`/`insertNodes` with semantic values, including escaping literal syntax, bold/italic/link/code edits, safe delimiters, nested edits and preserving raw inline regions. DOM-to-tree conversion must also be tested by T4. These suites do not claim UI or disk-save acceptance.

## Execution evidence (2026-11-19, before T2 implementation)

- `npm --prefix apps/desktop test`: 420 cases collected; 333 existing cases passed and all 87 new QA cases failed at import. Actual error: missing `shared/markdown-document.js` (the corresponding TypeScript module is absent). Expected after integration: a factory returning the T1 interface, followed by each case's assertions. This is implementation availability evidence, not 87 distinct product defects.
- `npm --prefix apps/desktop run typecheck`: fails with the existing `TS2366` at `src/main/ipc.ts:84` (function lacks an ending return). No QA-file diagnostic. QA did not change that file.
- `npm --prefix apps/desktop run build`: passed.
- `npm --prefix apps/desktop run test:e2e`: no test body ran; 37 cases pending because setup failed. `desktop.test.ts` hit its 120000ms hook timeout; `settings-ui.test.ts` and `shell.test.ts` reported `electron.launch: Process failed to launch`, process exit `SIGABRT`, and cleanup `kill EPERM`. The available launch/exit information does not establish the underlying cause. Expected: Electron launches and runs the cases. These are baseline execution limitations, not T2 behavioral failures.

Reproduce with the commands above; the missing-module failure also reproduces with the focused QA command. Retest this suite after T2 is merged, and rerun the desktop checks in an environment where Electron setup succeeds. No product code was changed by QA.

## Historical first integrated recheck (2026-11-19)

The preceding section is historical evidence from before implementation. It is not the current result.

- Full desktop unit suite: **667 collected, 664 passed, 3 failed**. QA: **118 collected, 115 passed, 3 failed**. The dev model suite passes all **216** cases (including 7 variants of this Markdown README, which its fixture glob collects).
- All 31 new tree cases pass. The long reference-definition and mixed-EOL regressions pass independently through the tree API. Unedited sources, supported Markdown editing, escaped literals, links and safe code delimiters pass.
- Build passes; standalone browser bundling of `shared/markdown-document.ts` also passes. Typecheck still fails only at `src/main/ipc.ts:84` with `TS2366`, outside the T2 code and QA tests.
- E2E was run again: 37 pending, no test body ran. The same 120000ms setup timeout and Electron launch failures (`SIGABRT`, cleanup `EPERM`) remain. No cause is inferred from those messages.

The remaining failures are source-fidelity failures, not factory-binding or marker failures:

| Finding | Reproduction after parsing the shown source | Expected | Actual |
| --- | --- | --- | --- |
| Q1: unclosed code fence loses payload newlines | Source `"\u0060\u0060\u0060md\nORIGINAL\n\n"`; replace `b1` with its `blockSource` after replacing `ORIGINAL` with `CHANGED` | Preserve `"\u0060\u0060\u0060md\nCHANGED\n\n"`, or refuse with a reason | Returns success with `"\u0060\u0060\u0060md\nCHANGED"`. Reopened code value lost both terminal newlines. `withEdit` trims them before validation. |
| Q2: deleting one block removes bytes outside its span | Source `"# Keep\n\nRemove ORIGINAL.\n\nTail.\n"`; replace the middle block with `""` | `"# Keep\n\n\n\nTail.\n"`, the original source minus only that block's span | `"# Keep\n\nTail.\n"`; the deleted block's following gap is dropped too. |
| Q3: insertion into an empty file adds an unrequested final newline | Parse `""`; call `insert(null, "# New\n\n**content**")` | `"# New\n\n**content**"` | `"# New\n\n**content**\n"`. |

At that revision all three reproduced in `markdown-preservation-qa.test.ts`. The historical verdict was **fail**. The latest recheck below supersedes that verdict's evidence; the reproductions are retained to track the fixes.

## Historical recheck after unclosed-fence fixes (2026-11-19)

The supplied worktree initially lacked the tree QA file and had the old preservation adapter. Before interpreting results, QA restored preservation, tree QA and this report from verified snapshot `790ebb86ee3f123c25aaddb6f48b443f6c3c9ed9` (the team's previous `T2 checked by qa-1` snapshot). Its three file changes were inspected before recovery. The restored tests were not weakened for this recheck. This recovery is separate from the new fence cases added now.

- The restored QA suite passes **118/118**. Q1, Q2 and Q3 from the historical report are resolved.
- Together with dev's current model tests, the restored three-file command passes **417/417** (87 preservation, 31 tree, 299 dev model). The first whole desktop run, before adding new fence cases, passes **750/750**.
- The new `markdown-fence-qa.test.ts` has **11 cases: 5 pass, 6 fail**. The failures share Q5 below. Controls for a shorter delimiter inside an unclosed fence, a closed fence, and source insertion/tree edits pass. Inserted text into an empty target follows its default LF convention; the test does not demand the inserted input's CRLF convention.
- Desktop build and standalone browser bundling of the Markdown module pass. Typecheck still fails only with baseline `TS2366` at `src/main/ipc.ts:84`, outside T2.
- Final full desktop unit run: **761 collected, 755 passed, 6 failed**. QA contributes **129 collected, 123 passed, 6 failed**; dev's model suite remains **299/299**. All six failures are in the new fence file.
- E2E was executed again: **37 pending**, no body ran; setup hit the same 120000ms timeout or Electron launch failure, with `SIGABRT` and cleanup `EPERM`. These remain execution limitations; the messages do not establish an underlying cause.

### Q5: a valid code edit cannot choose a safe unclosed fence

Reproduce from the repository root:

```sh
npm --prefix apps/desktop test -- test/markdown-fence-qa.test.ts
```

For example, open an unclosed triple-backtick `md` fence containing `ORIGINAL`. Obtain its code node through `structure`, then call `replaceNodes` with that node's `value` changed to `first`, a newline, a line of three backticks, a newline, and `last`. The same issue reproduces with a longer backtick run, tildes, CRLF documents and `insertNodes`.

Expected: select an opening fence that cannot collide with the code payload, allow Save, and reopen with exactly the supplied code value. T2 explicitly requires safe delimiter/fence selection for the basic code editing covered by AC2/AC4. A longer opening fence would represent this payload safely.

Actual: `renderOpenFence` (`shared/markdown-document.ts:1351`) retains the old opener without checking the payload. The inserted line becomes a closing fence. Validation detects the mismatch and returns `ok: false` / `roundtrip-mismatch`; no text is exposed to save. This is a valid-edit rejection, not a silent data-loss finding. Six cases fail; all are suspected product code. Verdict remains **fail** for T2.

## Historical recheck after shared safe-fence selection (2026-11-19)

The earlier sections are historical. For this recheck the supplied worktree again contained the initial preservation adapter and lacked tree/fence QA. QA inspected verified snapshot `704eebf6e97f78a2a09731c1ce7992a805b4a85d` (the preceding `T2 checked by qa-1` snapshot), restored all three test files and this report, and confirmed the restored test hashes before adding new cases. This is the existing handoff issue, not a new product failure. No product code was changed.

- The original four-file command passes **456/456**: dev 327, preservation 87, tree 31, fence 11. Q1–Q3 and Q5's existing regressions pass unchanged. The first whole desktop run passes **789/789**.
- Six independent cases were then added to the existing QA fence file to check R34 against the full document after reopening. All six fail with Q6 below; the old 11 fence cases still pass. Final full desktop result: **795 collected, 789 passed, 6 failed**. QA: **135 collected, 129 passed, 6 failed**. Dev model: **327/327**.
- Build and standalone browser bundle pass. Typecheck still reports only baseline `TS2366` at `src/main/ipc.ts:84`, outside T2 and the QA tests.
- E2E was run again: **37 pending**, no body ran. Setup again timed out at 120000ms or reported Electron launch failure (`SIGABRT`, cleanup `EPERM`); no underlying cause is inferred.

### Q6: success can lose a newline from the supplied code value after reopening

Run from the repository root:

```sh
npm --prefix apps/desktop test -- test/markdown-fence-qa.test.ts -t "whole supplied code payload"
```

Minimal reproduction: open an unclosed triple-backtick `md` fence containing `ORIGINAL`, with **no final newline**. Obtain its code node through `structure('b1')`, set its `value` to `"CHANGED\n"` using `replaceNodes`, and serialize. The result reports success. Reopening that result gives code `value: "CHANGED"`, not the supplied `"CHANGED\n"`. `insertNodes` into an empty document also reports success after changing `"CHANGED\n"` to `"CHANGED"`, or `"\n"` to `""` on reopen. CRLF, BOM/tilde, and two payload newlines reproduce the same loss of one newline.

Expected: a successful save must reopen with the exact supplied payload; if file-ending constraints cannot preserve it, return a refusal with reasons and no text. These cases allow either safe outcome and do not require changing an established file-ending convention. Actual: all six return success with a different code value after reopening, violating AC4/AC5 and R34.

Suspect code: `serialize` checks the intended tree against `parseBlocks` at `shared/markdown-document.ts:1705`, but later checks the final file with an EOF-aware split at `:1784`. The latter comparison no longer checks the supplied code value. The difference is masked in dev's regression at `test/markdown-document.test.ts:1090`, which sets its expected readback to `value.slice(0, -1)` for this case. QA disagrees with that reduced expectation under R34; the product tests were left unchanged.

Current verdict: **fail** due Q6. The initial preservation/tree/fence tests were restored, not newly authored; only the final six fence cases are new in this recheck. The previously reported baseline typecheck and E2E setup limitations remain separate.

## Historical verified run after Q6 payload guard (2026-11-19)

All previous sections are historical. The supplied worktree again lacked tree/fence QA and contained the initial preservation adapter. QA inspected snapshot `d374a72c13762fb33ab6965e31cd6c9243f8642b` (the prior `T2 checked by qa-1` snapshot), restored the three QA test files and this report, and confirmed every test file's hash matches that snapshot. No assertions were weakened, no new test cases were authored, and no product code was changed. The existing handoff issue remains the same issue already reported.

- Four-file model run: **514/514 pass** (dev model 379, preservation 87, tree 31, fence 17). Independent QA contributes **135/135**. Q1–Q3, Q5 and all six Q6 cases pass unchanged.
- Whole desktop unit suite: **847/847 pass**, no pending cases. Build and standalone browser bundling pass.
- Q6 was also checked directly: replacing code with `"CHANGED\n"` now opens with `"CHANGED\n"`; two terminal payload newlines remain two; inserting a code value `"\n"` opens with that value. The serializer adds the necessary file terminator instead of reinterpreting a payload newline. Dev's reduced expectation (`value.slice(0, -1)`) has been removed; the prior disagreement is resolved.
- Typecheck still fails only with baseline `TS2366` at `src/main/ipc.ts:84`, outside T2. No diagnostic points into the Markdown module or QA tests. Reproduce with `npm --prefix apps/desktop run typecheck`; expected: successful typecheck; actual: the IPC handler lacks an ending return.
- E2E was executed again: **37 pending**, zero test bodies ran. The setup again hit its 120000ms timeout or failed to launch Electron (`SIGABRT`, cleanup `EPERM`). No evidence from this run connects that launch failure to T2/Q6.

All T2 acceptance cases now pass; there is no remaining T2 product finding. The complete validation result is still **fail** because typecheck remains failed, with Electron E2E unverified. Q4 remains an independently reported baseline validation failure, not a request to expand T2's scope. No new tests were authored in this turn; the two test files added to this worktree are restored QA artifacts.

## Report-only classification correction (2026-11-19)

The previous response used a combined validation failure as the verdict for task T2. That classification was wrong: Q4 cites no T2 acceptance criterion, and Electron setup failure provides no T2 behavioral finding. Under the PM-approved instruction, the **T2 verdict is PASS** on the verified Q6-fix revision. This is neither acceptance of the whole product nor a waiver of any required check.

### Revision and evidence provenance

- Verified candidate: `88b77edabc4c0d88a9d152b5e6f59996898979c1`.
- Preserved QA snapshot: `709ced2eacd9c1ccd50003a329bff9bced14c157` (`T2 checked by qa-1`). The preceding history was recovered from this snapshot; its old conclusions are historical, not new executions.
- Comparison of that candidate and QA snapshot shows no change under `apps/desktop/src` or in `test/markdown-document.test.ts`. In both, the Markdown product module has blob `2527d596a7d292ab901343be13e60c19bbe0c3bc`.
- Existing local Vitest JSON reports were read and checked, not regenerated. `/tmp/t2-qa-q6-final-model.json` records the run started at `2026-11-19T06:06:33.045Z`; `/tmp/t2-qa-q6-final-desktop.json` records `2026-11-19T06:07:37.741Z`. The QA snapshot records the same counts and Q6 resolution. Temporary JSON paths are supporting local artifacts; the preserved snapshot and this report retain their summarized evidence.
- This report-only worktree is based on `0ed3a7961f804c522de9449239e897601b714e7d` (the initial QA-test snapshot), not the integrated candidate. Its tests and absent product files were left untouched. The PASS applies to the verified candidate/snapshot above, not to a fresh run of this checkout.

### Scoped task T2: PASS

| Evidence from the prior verified run | Result |
| --- | --- |
| Independent QA: preservation 87, tree 31, fence 17 | 135/135 pass, including all six Q6 cases |
| Dev model regression suite | 379/379 pass |
| Combined four model test files | 514/514 pass, zero failed or pending |
| Whole desktop unit suite | 847/847 pass, zero failed or pending |
| Q1–Q3, Q5 and Q6 | Resolved; no remaining in-scope T2 finding |

These cases cover T2's model-level obligations serving AC2–AC5: supported content and formatting edits, immutable drafts, serialization/reopening, exact preservation of untouched source and safe refusal when needed. UI behavior and filesystem writes remain with their own tasks. Assertions were not changed to obtain this conclusion.

To reproduce on the preserved integrated snapshot (from its repository root):

```sh
npm --prefix apps/desktop test -- test/markdown-document.test.ts test/markdown-preservation-qa.test.ts test/markdown-tree-qa.test.ts test/markdown-fence-qa.test.ts
npm --prefix apps/desktop test
```

All four cited test files exist in snapshot `709ced2e`; they are not asserted to exist in this report-only checkout. The commands above were not run in this correction.

### Overall desktop verification: not passed / not fully verified

| Check | Last verified status, retained without a new run |
| --- | --- |
| Typecheck (Q4) | FAIL: `TS2366` at `src/main/ipc.ts:84`, outside T2. Reproduce with `npm --prefix apps/desktop run typecheck` on the integrated revision; expected a successful typecheck, actual handler lacks an ending return. |
| Electron E2E | UNVERIFIED: 37 pending, no test body ran; setup timed out at 120000ms or launch failed with `SIGABRT` and cleanup `EPERM`. Source: `/tmp/t2-qa-q6-e2e.json`, run started at `2026-11-19T06:04:39.185Z`. Reproduce with `npm --prefix apps/desktop run test:e2e`. No underlying cause or link to T2 is inferred. |
| Desktop build / browser bundle | PASS in the preceding verification; not rerun for this correction. |

Q4 and the E2E execution limitation remain open in overall verification. They are not counted as T2 acceptance failures, and they have not been exempted, fixed or declared passed. Only this report and its classification were updated.

## Fresh scoped recheck of revision 9e07a1b9 (2026-11-19)

This section records new executions requested after the report-only correction above. The prior results are not presented as these new runs.

- Starting revision: `9e07a1b9c2d450e1957b7ac7a7e3facf2c4a6f0b`. Its desktop product sources and dev model tests have no diff against the previously verified snapshot `709ced2eacd9c1ccd50003a329bff9bced14c157`.
- The worktree again lacked tree/fence QA and held the initial preservation adapter. QA restored all three test files from `709ced2e` and verified their Git blob hashes exactly. No assertion, product code or review was changed, and no new cases were added. This is the existing handoff issue, not a new product finding.
- All four referenced test files are present in this working tree for the new run. The commands at the top of this report can now be run here from the repository root.

### New results for scoped T2: PASS

| New execution | Result and source |
| --- | --- |
| Four-file model suite | **514/514 pass**, zero failed/pending. Dev 379, preservation 87, tree 31, fence 17. Source: `/tmp/qa-t2-9e07-model.json`, started `2026-11-19T06:15:52.654Z`. |
| Independent QA / Q6 | **135/135 QA pass**, including all six Q6 cases with unchanged assertions. |
| Entire desktop unit suite | **847/847 pass**, zero failed/pending. Source: `/tmp/qa-t2-9e07-unit.json`, started `2026-11-19T06:15:53.707Z`. |
| Build / standalone browser bundle | Both pass in this new verification. |

No remaining T2 finding was observed against the model-level acceptance criteria serving AC2–AC5 and the prescribed preservation/unsafe-save focus. The scoped verdict remains **PASS**, independently of the overall validation rows below.

### New overall desktop verification, outside the T2 verdict

- **Typecheck: FAIL (Q4, baseline).** `npm --prefix apps/desktop run typecheck` again reports `TS2366` at `src/main/ipc.ts:84` (missing ending return). No diagnostic points into T2 or QA tests. This is not waived and is not an in-scope T2 finding.
- **Electron E2E: UNVERIFIED.** The fresh run settled with 37 pending cases and no test body executed. Setup again timed out at 120000ms or reported Electron launch failure (`SIGABRT`, cleanup `EPERM`). Source: `/tmp/qa-t2-9e07-e2e.json`. The cause remains unknown; no causal link to T2 is inferred. This is a separate overall execution limitation, not an in-scope T2 failure.
