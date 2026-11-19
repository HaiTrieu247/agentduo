# "Mở" (Open): view and edit Markdown in the desktop app

Status: implemented (desktop). Built by an agentduo team run (T1–T4: the contract, the Markdown model, the file service, the page), finished by hand (T5: quit, window close and restart into an update). Code: `apps/desktop/src/shared/documents.ts` (types, link rules, the table of link ids, the Markdown model's API), `apps/desktop/src/shared/protocol.ts` (requests, results, events, validation), `shared/markdown-document.ts`, `main/documents.ts`, `main/document-lifecycle.ts`, `renderer/documents.ts`, `renderer/markdown-editor.ts`. Tests: `apps/desktop/test/document-*.test.ts`, `documents*.test.ts`, `markdown-*.test.ts`, and the Electron suites `test/e2e/open-markdown-qa.test.ts`, `open-markdown-editor.test.ts` (the page against the real file service) and `open-lifecycle.test.ts` (the whole app: quit and window close). What was run: `apps/desktop/VERIFICATION.md`.

Brief: a user clicks a link to a `.md` file in a message of the chat (the PM's, an agent's), sees it as formatted Markdown in the app, edits it in place, and saves it on purpose into the file the link points to. The feature is called "Mở". Desktop only; other file types come later without redesigning the click on a link.

Out of scope: VS Code and the CLI; types other than `.md`; autosave, collaboration, history; creating a file or "save as".

## 1. Parts and who owns them

| Part | Owner | Does |
| --- | --- | --- |
| `shared/documents.ts`, `shared/protocol.ts` | T1 | The contract: no Node, no DOM. |
| `shared/markdown-document.ts` | T2 | The Markdown model (section 7). |
| `main/documents.ts`, `main/ipc.ts`, `main/projects.ts` | T3 | The file service: reads, writes, sessions, grants link ids. |
| `renderer/documents.ts`, `renderer/markdown-editor.ts`, `chat.ts`, `main.ts`, `dialog.ts`, styles, `packages/webview` (links) | T4 | The page: clickable links, the document view, the unsaved-changes dialogs. |
| `main/index.ts`, `main/window.ts`, `main/document-lifecycle.ts` | T5 | Quit and window close; wiring. |

## 2. Boundary: the renderer never names a path

The renderer is sandboxed and talks to main only through `invoke`/`onEvent`; every request is checked by `parseDesktopRequest` after `trustedSender` (the app's window, its top frame, the app's origin). No document request carries a path. A request names:

- a link by `linkId` (`k<n>`), with `projectId`, `conversationId` and `view` (as `chat.message` does), or
- a document by `documentId` (`d<n>`), which main gave its session.

`parseDesktopRequest` drops every other field, so a `path` sent along never reaches main. Ids are not secrets: they are looked up in tables main owns, so a made-up id finds nothing (`link-stale`, `session-unknown`).

The target of a link comes from the chat text **main** owns, never from the renderer: main already receives each conversation's `ViewState` (`ProjectManager.onChange`, the `snapshot` message) and reads the links of its timeline.

## 3. From a link in the chat to an id

1. Which text has clickable links. `linkParts(item)` lists, per timeline item, the parts the chat draws with its Markdown renderer: the PM's `text`, an agent's `answer`, a discussion's final `answer` and each turn's `turn.<n>`. The user's own messages, `document` cards (drawn as plain text) and notes are not sources. A new source is one more case there and the same part name in the renderer.
2. Which links. `markdownLinks(text)` lists a part's links in document order (inline links of a paragraph or heading, list items in order, a quote's blocks, a table's head cells then rows; links in code are not links). It uses the chat's own parser (`@agentduo/webview/markdown`), so the numbering matches what is drawn. That parser reads the target as written: `<…>` may hold spaces (`[x](<docs/my notes.md>)`), a bare target may hold balanced parentheses (`docs/a(1).md`), a title (`"…"`, `'…'`) is dropped, a backslash stays (a Windows path), and nothing is percent-decoded there (that is `resolveLink`'s one decoding). Links are never read by a second extractor in `documents.ts`: main and the renderer share this one, so their ordinals agree. The renderer must number the links it draws in the same order: a link's **ordinal** is its index in that list.
3. Which of them open. `documentLinkSites(timeline)` keeps those whose file name has an extension in `DOCUMENT_FORMATS` (`linkFormat`: the extension of the path the link names, after the scheme, query, fragment and `:line` are taken off). A link to anything else gets no id and is drawn as it is today. This is what makes new formats free: the filter is the registry.
4. Ids. `DocumentLinkTable.sync(owner, view, sites, fresh)` gives each site an id and returns `{ grants, revoked }`. Main posts a `documentLinks` event `{ projectId, conversationId, view, links: [{ linkId, itemId, part, ordinal }], revoked }`. The event never carries the target. The page matches a drawn link to its id by `(itemId, part, ordinal)`; a link with an id is drawn as clickable, and clicking sends `document.open { projectId, conversationId, view, linkId }`. No other behaviour depends on the kind of file.

Mapping and revocation (`DocumentLinkTable`; owner is `<projectId>/<conversationId>`):

- An owner's ids belong to **one view** (the number `openConversation` gives each attachment). Attaching it again revokes every id of the earlier view; `document.open` with the old view or an id of another conversation finds nothing.
- While the chat grows, a link keeps its id (same item, part, ordinal and target). A link whose target at that place changed, or whose text is gone (the timeline drops old items), is revoked and, if still there, gets a new id. An id is never reused for a different target.
- A snapshot (`fresh`) tells the page every live id again; later syncs only the new ones.
- Closing, archiving or deleting a conversation calls `revoke(owner)`; restarting or forgetting a project calls `revokeProject(projectId)`. At most `MAX_LINKS_PER_VIEW` (500) links, the latest ones.
- Revoking ids never closes a document session: the user may be editing it.
- Main calls `sync` when a conversation's state changes (a link appears with a streamed answer). It may debounce; it must call it for every snapshot.

## 4. Where a link points

Main resolves the link text it kept at grant time, when the user clicks, with `linkTarget(href, { workspace })`, where `workspace` is the conversation's own workspace: `ViewState.workspace`, else the project's folder (not for the Conversations group, which has none). The rules (`splitHref`, `resolveLink`; table-driven tests in `document-protocol.test.ts`):

- **Absolute path or file URL: exactly that file**, wherever it is: a team worktree, an attachment folder outside the workspace. Main never looks for a file of the same name in the workspace and never swaps the target for a workspace copy.
- **Relative path: from the conversation's workspace**; `..` may leave it (that is what the link says). No workspace, or a workspace that is not absolute: error `link-unresolved`.
- **`..` is not collapsed on POSIX.** `LinkTarget.path` drops empty and `.` segments (they change nothing) but keeps every `..` as written, because the kernel resolves `..` against the *real* folder of a symlink: with `workspace/link -> outside/child`, `workspace/link/../note.md` is `outside/note.md`, while collapsing it to `workspace/note.md` would open, and on save overwrite, another file. Only the file system can resolve it, so main (T3) must open the path with `fs.realpath.native` (`fs.promises.realpath` is also native), and must not pass it through `path.resolve`, `path.normalize`, `new URL` or the JS `fs.realpathSync` first: all of them collapse `..` lexically. The resolved real path that comes back is what the session reads, writes, deduplicates on and compares extensions on; the unresolved path is never used again after that. On Windows `..` is resolved in `linkTarget` because Windows does the same before it looks at links (and stops at a drive's or share's root). A link whose last segment is `.` or `..` names a folder: `link-invalid`. Regression test: `document-protocol.test.ts` (two files with different content, one behind a symlink).
- **No search by label or name.** A bare `README.md` means `<workspace>/README.md` only.
- **Not resolved, on purpose**: `~/…` (a full path is needed), `C:name` (drive-relative): `link-unresolved`. `http:`, `mailto:`… : `link-not-file`. Empty, control characters (also after decoding), longer than 4096, a trailing separator (a folder), a file URL without a path: `link-invalid`. Nothing is guessed; the error message names the link and why.
- **Position and fragment are not part of the name.** `…ext:12` or `…ext:12:3` after an extension, and `#L12`, `#L12C3`, `#L12-L20` give `position` (the first line; a range's end is ignored; line 0 is refused). Any other fragment is the `anchor` (a heading id), decoded once. A suffix beats a fragment position. The fragment starts at the first `#`, so a `#` in a file name is written `%23`; an encoded `%3A` is a letter of the name, never a position. In a file URL a `?query` is dropped; in a plain path `?` is a letter of the name. `<…>` around the whole link is dropped.
- **Percent-decoding once.** `a%20b.md` is `a b.md`; `%2520` is `%20`. An invalid escape (a file named `100%.md`) leaves the text as written. Decoding comes before the path is read, so `%2E%2E` is a `..` of the path that was written (kept, like any `..`).
- **Windows.** `C:\x`, `C:/x` (drive letter made capital, separators made `\`), `\\server\share\x`, `file:///C:/x`, `file://C:/x`, `file://server/share/x` (a UNC path). `..` is resolved and stops at a drive's or share's root. A relative path in a Windows workspace takes both separators and the workspace's style; in a POSIX workspace a backslash is a letter of the name. The rules read the shape of the paths, not the OS the app runs on, so they are tested on every OS; a Windows path on a Mac simply is not found.

Checks that need the file system belong to main (T3), after `linkTarget`:

- `realpath` the target **with the native realpath** (see the `..` rule above); pick the format by the extension of the **resolved** path as well as the link's: both must be the same registered format, or `format-unsupported` (a `notes.md` symlink to a private key is not opened).
- Not a regular file → `not-a-file`; missing → `not-found`; unreadable → `unreadable`; over the format's `maxBytes` → `too-large`; bytes not valid UTF-8, or with NUL → `not-text` (`decodeUtf8Strict`). Nothing is changed in any of these cases.
- Opening is a user's click on a link in the chat, and only registered types open. Any readable path may be a target (a worktree must be); that is why the extension check on the resolved file matters.

## 5. Formats: the extension point (AC8)

`DOCUMENT_FORMATS` is the one registry: `{ id, label, extensions, maxBytes }`, today only `markdown` / `.md`. A format has three parts, all keyed by its `id`:

1. its entry in `DOCUMENT_FORMATS` (shared; decides which links get ids and which file opens with it);
2. a **codec** in main: bytes ↔ text, and its save rules. For Markdown: strict UTF-8, BOM kept as U+FEFF, line endings untouched (`decodeUtf8Strict`, `encodeUtf8`);
3. a **viewer** in the renderer: given a `DocumentInfo` it shows the document, reports unsaved edits and produces the text to save.

Adding a type never changes: the link click, `document.open`, the session requests, the close protocol or the id table. The renderer picks the viewer by `DocumentInfo.format`; a format with no viewer is shown as an error, not a blank page. `test`: the registry test adds a text format and shows the same sites and the same requests serve it.

## 6. Sessions, revisions and saving

A **session** is main's record of one opened file: its `documentId`, format, the resolved real path, the `revision` of the content it last read or wrote, `dirty` as the page last said, and the origin (project, conversation). Sessions do not depend on link ids or on the conversation's lifetime.

- `document.open` → `DocumentOpened = { ok: true, document: DocumentInfo, existing } | { ok: false, error }`. One session per real path: opening a file that is open returns the same `documentId` with `existing: true` and the session's last read/written text and revision; the page keeps the edits it has. `DocumentInfo`: `documentId, format, name, location` (shown, never sent back), `revision, text, position, anchor, save` (`allowed`, or why not: a read-only file opens for reading), `origin`.
- `document.reload` re-reads the file (the page chose to discard its edits, or to start from what is on disk after a conflict) and answers like `open`; the revision is new.
- `document.save { documentId, revision, text, overwrite }` writes `text` to the session's file, **only if the file's content is still `revision`** (the revision the page holds: the session's last). Otherwise `changed-on-disk` and nothing is written. `overwrite: true` is the user's explicit choice to replace what is there now. `revision` is required: a request without it, or in the wrong form (`^[a-f0-9]{16,64}$`), is refused by validation. The file must still exist: a missing file is `not-found` (this feature never creates a file). On success: `{ ok: true, revision }`, the new revision; the session's base is the text just written. On failure: `{ ok: false, error }` (`save-failed`, `changed-on-disk`, `not-found`, `session-unknown`); the page keeps the text it has and may try again. Only an explicit save writes; there is no autosave and main writes at no other time.
- Writing (T3): to the resolved real path, through a temporary file in the same folder and a rename, keeping the file's mode (falling back to an in-place write when the folder cannot be written to), so a failure leaves the old file whole. `text` is written exactly: no BOM added, no line ending changed. `parseDesktopRequest` refuses text with NUL or a half surrogate pair (it would not write back as typed) and more than `MAX_DOCUMENT_CHARS`; main also checks the format's byte limit.
- `document.dirty { documentId, dirty }` tells main whether the page holds unsaved edits. Main uses it only to decide whether quitting must ask; main never holds edited text.
- `document.close { documentId }` ends a session (idempotent). The page settles unsaved edits first (section 8).
- Errors that are about a file are **results** (`DocumentError { code, message, retryable }`, `documentError(code, subject, detail)` makes the same words on both sides), not `Answer` errors, so the page can offer the right action (retry a save, reload, overwrite). `Answer` errors remain for refused requests: wrong sender, malformed.

| code | when |
| --- | --- |
| `link-stale` | id unknown, revoked, or of another view |
| `link-invalid`, `link-not-file`, `link-unresolved` | the link text (section 4) |
| `format-unsupported` | extension (of the link or the resolved file) not registered; the message lists what opens |
| `not-found`, `not-a-file`, `unreadable`, `too-large`, `not-text` | the file |
| `session-unknown` | `documentId` unknown or closed |
| `changed-on-disk` | save with an old revision |
| `save-failed` | the write failed (the edits are kept) |
| `unsafe-to-save` | decided by the Markdown model in the renderer (section 7); never sent to main |

## 7. The Markdown model (AC5), implemented by T2

The editor edits formatted content, but the file's text is the truth. The API is `MarkdownDocument` in `shared/documents.ts`:

- `source` is the file exactly as read; `blocks` lists top-level blocks, each with its `span` in the source, `kind`, `edited`, `editable` and the `construct` that makes it not editable.
- `replace(blockId, markdown)`, `insert(afterBlockId, markdown)` return a new document (immutable); the editor converts an edited block of the page to Markdown and replaces that block only.
- `serialize()` is `{ ok: true, text } | { ok: false, blocks: SaveBlock[] }`.

Guarantees (T2 tests them with fixtures, `test/fixtures/open-markdown/`):

1. Unedited, `serialize()` returns the source byte for byte: BOM, CRLF or LF, a missing final newline, front matter, HTML, tables, reference definitions, constructs the editor cannot show.
2. An edit replaces the source of the blocks it names and nothing else; the new text's line endings follow the source's.
3. If an edit cannot be written without loss (it lies in a block that is not `editable`; the written block does not read back as the editor showed it; the text is not writable), `serialize()` returns `ok: false` with the reasons and **no text**. The page then shows `documentError("unsafe-to-save", …)` naming the construct and line, writes nothing, and keeps the edits. There is never a lossy conversion to write.
4. `notices` lists constructs kept as they are, shown when the document opens (blocks that are not editable are drawn as such). Saving is allowed: they are written back unchanged.

Because the page can only produce `text` by `serialize()`, and the page's save is only enabled for an `ok: true` result, main needs no Markdown knowledge: it checks that `text` is writable, within size and for the right revision.

## 8. Closing with unsaved changes (AC6)

Inside the page (switching conversation, opening another document, closing the document's view): the page asks the user itself with `confirmDialog` (never the browser's `confirm()`), with three choices: **Save**, **Discard**, **Keep editing**. Save with a failure keeps the document open and shows the error. This needs no protocol.

When main must close something (quit, closing the window): the page cannot be assumed to have answered, so main asks:

1. Main knows from `document.dirty` which sessions are dirty. None: it proceeds. Some: it posts `documentCloseRequest { requestId (q<n>), reason: "quit" | "window", documentIds }` and does **not** proceed yet. One request is in flight at a time; a second quit meanwhile only focuses the window.
2. The page shows the same three choices for those documents (one prompt for several), saves or discards them, reports `document.dirty { false }` for each, and answers `document.closeResponse { requestId, outcome }`: `settled` (every listed document was saved or discarded) or `cancelled` (the user chose Keep editing, or a save failed and they stopped).
3. On `settled`, main checks its own record: any listed session still `dirty` makes it a `cancelled` (nothing is lost on a page's word). Then it proceeds, ending the sessions it still holds. On `cancelled`, quit or window close is aborted.
4. A response with an unknown or already answered `requestId` is ignored (`accepted: false`). If the window is gone or its renderer crashed there is nobody to ask, and main proceeds.

In main this is `DocumentCloseGuard` (`main/document-lifecycle.ts`, no Electron; `index.ts` wires it):

- `check(reason)` answers `true` (no session is dirty: go at once), `false` (a request already waits: the window comes forward, this close stays) or a promise of the page's decision. Each close asks anew with its own `requestId`: a decision covers the close that asked for it, never a later one.
- The window's `close` event is prevented while it waits, and only the close it settled goes through. `before-quit` is prevented as before; on a decision to go it ends every session and disposes the workers as it did; on one to stay, a restart into an update is forgotten (`Updates.stay`), so a later quit never restarts on that old request.
- Only a page that has loaded can be asked. When the window closes, its renderer crashes or its page loads again, the sessions end (`DocumentService.dispose`: no page holds their edits any more) and a waiting request goes on.

`documentClosed { documentId }` tells the page that main ended a session.

## 9. Decisions and what the techlead should know

- Chosen: ids granted by main for links, instead of the renderer sending `(item, ordinal)` for main to resolve, so a request names only something main handed out and it can be revoked. The table lives in `shared` (pure) so main (T3) uses it as is and it is tested here.
- A link is clickable only if its extension is a registered format, so unsupported links look as before; the alternative (all file links clickable, error on click) was refused because it would change how every `.ts` link in an answer behaves.
- A document session outlives link ids and conversation switches, so edits are never lost when a view is attached again.
- `ipc.ts` must add a case for each `document.*` method (the dispatcher's switch is exhaustive); that is T3's. `document-protocol.test.ts` already covers the refusal paths through the `Dispatcher`.
- Not decided here: how the editor turns an edited block into Markdown (T2/T4), the revision's digest (T3; any content digest as hex of 16 to 64 characters), the exact dialog texts (T4).
