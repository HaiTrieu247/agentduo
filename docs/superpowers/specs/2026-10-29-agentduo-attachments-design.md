# agentduo: attached files

Status: implemented. Amends `2026-10-27-agentduo-channel-design.md` (chat, pipeline) and
`2026-10-28-agentduo-vscode-design.md` (wire protocol, now version 6).

## What the user gets

- Attach any regular file (images, PDFs, text, code, anything else) to a message, `/claude`/`/codex` question,
  `/discuss` question, `/pipeline` task, a note while the pipeline works, or `/resume <note>`.
- Terminal: `/attach <path>`, `/attachments`, `/detach <n|id|all>`; Enter on an empty line sends the waiting files alone.
  The path is read as a shell reads one word (quotes, backslash escapes, no globs or variables), except that a leading
  `~/` means the home directory inside quotes too (`/attach "~/Desktop/My notes.pdf"`); `\~` or `./~` names a folder `~`.
- VS Code: pasted and dropped files keep the order given; a message waits until each is read and attached, and the send
  control sends a file-only note while the pipeline runs (it stops the run only when there is no text and no file).
- VS Code: the paperclip (host `showOpenDialog`, no extension filter), paste of an image, Shift+drag of files from the OS.
  A drag from VS Code's Explorer carries only a URI; the tab says to use the paperclip instead.
- Not in scope: `duo run` outside the chat, the terminal clipboard, Files API or any upload service, OCR or conversion.

## Support matrix (verified 2026-10-29)

| | Claude Code 2.1.311 | codex-cli 0.164.0 |
|---|---|---|
| Native images | base64 `image` blocks before the text block of one `stream-json` user message; answered "red" for a red PNG (`test/fixtures/claude-attachment-stream.jsonl`) | one `--image=<absolute path>` token per image, prompt on stdin via `-`; two images answered "red, blue" (`test/fixtures/codex-attachment-stream.jsonl`) |
| Host and non-host | `--input-format stream-json` with or without `--permission-prompts host`; non-host closes stdin after the message | n/a |
| Larger images | the CLI rescales them; agentduo does not rely on it | the CLI reads the files itself |
| Text, code, PDF by path | read with its Read tool: a text file, a `.ts` file and a one-page PDF gave back their marker words | read with its own tools from the workspace sandbox; binary formats are up to the agent |

Codex's `--image` is variadic: `--image a.png -` reads `-` as an image, hence the `=` form. The API's document blocks
are not used: nothing shows the CLI forwards them.

## Storage

- `AttachmentStore` (`src/core/attachments.ts`) copies the bytes as they are to
  `<runs>/conversations/<conversation>/attachments/<id>/<safe-name>`; a pipeline task's and its notes' files are copied
  again into `<runs>/<run>/attachments/`, so a resume needs neither the original nor the conversation.
- `Attachment` (`src/core/attachment-types.ts`) holds the id, the shown name, the media type, the size, the image header
  (format, width, height) when one was read, and the copy's path relative to the runs directory. No base64 and no
  source path is persisted in `conversation.json`, `view.json` or `state.json`.
- Media type: by signature first (PNG, JPEG, GIF, WebP, PDF…), then by name; dimensions come from a bounds-checked
  header parser, and a truncated or unknown header means "not a native image".
- Limits: 20 files, 20 MiB per file, 50 MiB per message. Directories, special files and unreadable paths are refused;
  a symlink to a file is copied as a regular file; partial writes are removed.
- A conversation keeps the waiting files in `pending.json`, apart from the sent ones. `/new` and closing drop waiting
  files; opening a conversation again removes those a crash left behind and never a sent one.

## Prompts and calls

- `src/core/prompts.ts` alone writes the file list: the current files under "Files the user attached to …", each with
  the absolute path of its copy, and earlier messages' files by path only ("not attached again").
- The runner resolves and checks every copy before each attempt (a missing copy fails before the agent is called),
  picks the native images with `selectNative`, warns for each image that goes as a path only, and serializes the
  input. `prompt.md` is the text sent, without base64.
- Claude's native budget per call: PNG/JPEG/GIF/WebP whose header was read, at most 8000 px a side, 5,000,000 base64
  bytes each, 20 images and 20,000,000 base64 bytes in all, in the order attached. Codex: the same formats and count.
- Every call of a discussion (answer, review, revision, synthesis) carries the question's files. Every pipeline call
  (plan, critique, finalize, implement, review, repair, retries) carries the task's files and those of the notes
  so far, within one budget per call. Each call is independent, so images are sent again each time; the docs say so.
- A later chat message lists an earlier message's files by path and sends no image blocks again.

## Pending files and decisions

- Files are taken from the waiting list only once a submission is accepted and its references are stored; a busy
  workspace, a validation error or a slash command that takes no files leaves them waiting.
- A HUMAN_REVIEW decision never takes waiting files. The chat and the tab say to send them with a message first (a
  note for the next step, through `addNote`) or to defer and `/resume` with a note.

## VS Code transport

- Paste and drop: the webview sends one file at a time as base64 (`upload`), checked against the encoded and decoded
  size limits. The host decodes it, writes it to its own staging directory, and sends the worker that path
  (`stageAttachment`); the picker sends the chosen paths the same way. IPC carries paths, metadata and ids only.
- Answers carry the conversation and key, and count only for the tab and worker generation that asked; a file removed
  meanwhile is removed from the store. Send waits until no file is still uploading.
- The worker reports the conversation's attachment root; the host checks it is `<runsDir>/conversations/<id>/attachments`,
  adds it to `localResourceRoots`, and grants `asWebviewUri` URIs for the copies, again after a restore. A tab opened
  once the root is known gets it from the start. Otherwise the root is added when the first image is shown, and that
  change reloads the webview. A pasted or dropped file lives only in the page until the host shows its chip, so the host
  first sends `prepareReload`. The page answers `readyToReload` once no file is left only in the page, and then takes no
  more files until it reloads. A hidden or loading page holds none, so its options change at once. A preview while
  a file is stored is a `data:` URL of a recognized raster image (the CSP is unchanged). Names are text, never HTML; an
  uploaded SVG is never rendered.
