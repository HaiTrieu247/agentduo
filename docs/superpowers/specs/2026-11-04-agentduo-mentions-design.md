# agentduo: tagging workspace files with @

Status: implemented. Written after an in-chat design the user approved (2026-11-04); no separate spec review.

## What the user gets

- Typing `@` in a chat input (the terminal chat, the VS Code tab, the desktop app) opens a list of the workspace's
  files and folders: the top level for a bare `@`, folders first. Typing more narrows it to the paths that have the
  letters in order, best first (fzy's scoring: a match at the start of a name or a word, a run of letters and a short
  path rank higher). Typing a folder's whole path with its `/` lists that folder's entries.
- ↑↓ choose; Tab (or a click in the tabs) opens a folder, so its entries come next, or puts a file in; Enter puts the
  path in, followed by a space, and closes the list; Esc closes it until the text changes. `/` commands keep their
  own completion; a `@` word wins where the caret is in one.
- A path with spaces is written `@"my docs/notes.md"`. An `@` after a letter (`a@b.com`) is no mention.
- The message keeps `@path` as typed. Its prompt adds the tagged files and folders that exist inside the workspace,
  for the agent to read with its own tools. Nothing is copied, unlike `/attach`: a folder could not be, and a file is
  read where it is.

## Pieces

- `src/core/mention-text.ts`, with no Node (the webview bundles it): `mentionAt` (the `@` word around the caret),
  `mentionText` / `insertMention`, `mentionedPaths` (every `@path` of a text) and `rankPaths` / `fuzzyScore`.
- `src/core/mentions.ts`: `listWorkspacePaths` lists what `git ls-files --cached --others --exclude-standard` gives in
  the workspace (minus `--deleted`), with every folder of those files; outside a repository, or without git, it walks
  the folder level by level without `.git` and `node_modules`, up to 20,000 entries. The runs directory is always left
  out (`workspaceExcludes`). `WorkspacePaths` keeps a listing for 10 s, so typing does not list the workspace each
  time, and lists again after that. `taggedPaths` resolves what a text mentions, each once: only existing paths inside
  the workspace (the workspace itself, `..` and absolute paths elsewhere are left out), with trailing punctuation tried
  without when the path is not found with it.
- Prompts (`src/core/prompts.ts`): `PromptContext.tagged` and the `tagged` option of `conversation` / `discussion`
  are resolvers (`text → PathEntry[]`), as `locate` is for attachments. The section *Workspace paths the user tagged*
  follows the message, the question or the task (every role's first prompt), and a note gets a `Tagged:` line. They
  are resolved when the prompt is built, so the run's state records nothing, and a path deleted since is left out.
- Protocol 10: the worker request `findFiles { query }` → `{ matches }`; the webview message `findFiles { seq, query }`
  and the host message `fileMatches { seq, matches }`. The query is one line of at most 200 characters, and the
  webview never names a path: it only shows the relative ones the worker found. The host posts the answer to the tab
  that asked; a failure is logged and answers an empty list. The webview asks once typing pauses for 50 ms, and drops an
  answer whose `seq` is not its latest. A new `@` asks again, since files come and go.
- The terminal chat gets `findFiles` from the CLI (`WorkspacePaths` for the workspace and its runs directory). The
  caret is always at the end of its input.

## Tests

`test/mention-text.test.ts`, `test/mentions.test.ts`, the prompt, conversation and workflow cases for the tagged
section, the protocol and worker cases for `findFiles`, `WorkspaceSession` and the desktop's routing, the Ink chat, and
the desktop's end-to-end test (typing, narrowing, Tab into a folder, Enter, and the prompt the agent got).
