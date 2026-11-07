# agentduo: taking turns between `duo`, the extension and the desktop app

Amends `2026-10-27-agentduo-channel-design.md` (the workspace lock), `2026-10-28-agentduo-vscode-design.md` (a lock
taken on first use and held until /quit) and `2026-10-31-agentduo-desktop-design.md` (a lock per project's worker).
User documentation: "Working from several windows" in `README.md`.

## Problem

The chat held the workspace lock for its whole session: `duo` from the moment its chat opened, the extension's and the
desktop's worker from the first message until /quit or shutdown. An idle window therefore kept every other one from
working, and the user had to /quit the desktop app (or close VS Code) before `duo` could start. A conversation could be
reopened only in the kind of window that started it in practice, and an idle tab never saw what was said elsewhere.

## Goals and non-goals

- The three hosts can be open on one workspace together, and an idle host keeps no other from working.
- A conversation goes on in another host with its history, the answered questions and the agents' sessions that still
  hold; back and forth, without losing or doubling an exchange.
- Not: a shared daemon or runtime, moving work that is running to another host, or several pieces of work running at
  once in one workspace across hosts (within one worker, tabs still answer side by side, as before).

## The lease: locks held while work runs

- `<runs>/.lock` (the workspace) and `<runs>/conversations/<id>/.lock` (a conversation) hold the pid of the process
  that works there, and nothing else, as every agentduo reads it. `WorkspaceLease`
  (`packages/engine/src/workflow/lease.ts`) takes them for one piece of work, re-entrant within a process (the
  extension's tabs share one lease), and gives each back when the last work holding it is released.
- `Chat` (`packages/engine/src/chat/chat.ts`) takes the lease in `takeWorkspace` before an answer, a `/discuss`, a
  pipeline run and `/resume`, and keeps it in its `Execution` until `settled`: after the turn's or the discussion's last
  write, or after `workflow.run()` returned, the run lock was given back and the conversation has the run's outcome.
  Waits for the user happen inside that work (a question or a permission inside a turn, a decision inside
  `workflow.run()`), so they keep it. *Decide later*, Esc and a closed tab end the wait, which ends the work.
- Writes outside work: the recipient is the only conversation field written while idle. `saveRecipient` writes it
  under the lease for that moment; while another process holds the conversation the choice stays in memory
  (`unsavedRecipient`) and is written with the next work. Waiting attachments are per process (below), settings write
  config files as before (no lock), and a closed tab, /new and shutdown write only this process's own files.
- Busy: `LockError` makes `takeWorkspace` say so (the holder's pid, "Nothing was sent, and nothing there is
  interrupted") and call `ChatUi.refused(line)` with the line as typed (a route's text as `/pipeline …` or
  `/discuss …`). The files stay waiting. The worker sends it as the `refused` update (protocol 12); the host takes the
  unsent message off the timeline and posts `restoreDraft`, which puts it back into an empty composer. The CLI's input
  gets it the same way. `duo run` and `duo resume` still take the workspace lock for the whole run, and fail with the
  holder's pid.
- The session updates follow the lease: `active` while one of the worker's chats holds it, `dormant` once none does.

### Dead holders

`acquireLock` (`packages/engine/src/workflow/state.ts`) creates the lock exclusively. A lock naming a live pid is busy.
A lock whose pid is gone, or which has held no pid for more than 5 s (a creator that crashed between creating and
writing), is taken over under `<lock>.reclaim`, a guard created exclusively, and only if it still holds what was found
stale. Two processes that both found it stale never both take it: the second one sees the first one's lock, alive. A
lock with no pid yet is waited for (at most 1 s). A process releases only a lock that names its own pid. A guard older
than 10 s was left by a process that died while reclaiming, and goes.

## Reading again before writing

- `Conversation.reload({ settle })` reads the record again: exchanges, tasks, title, recipient, sessions and the
  clarification ledger, keeping only what is this process's own (the files waiting in its composer). `settle` (the lease
  is held, so nobody else works in it) marks a question still `pending` as interrupted and passes on answers of a turn
  that never ended, as opening a conversation did; without the lease it does neither. `takeWorkspace` calls it (through
  `catchUp`) before every piece of work, so a host never writes over what another one saved: its prompt, its sessions
  (`takeSession`/`keepSession`) and its ledger start from the record on disk.
- Continuation and invalidation are unchanged: a session carries the exchanges it has seen (`exchanges`, `earlier`),
  so an agent that goes on in another host's session is told only what is new to it. A failed resume falls back to the
  full prompt, as before.
- Each exchange carries the id of its turn (or discussion), and each pipeline task its run id, so a view can tell which
  ones it shows. Prompts and run state carry exchanges without it (`Conversation.context`).
- The record says which process wrote it last (`writer`); `changedOnDisk` compares the file's time and size with what
  this process last read or wrote.

## Waiting attachments

A conversation's waiting files are listed per process (`attachments/pending-<pid>-<nonce>.json`), so opening a
conversation (`recover`) removes only what a process that is gone left waiting. An older agentduo's single
`pending.json` counts as such. A copy that was never finished is removed only once it is an hour old: another host
may be copying a large file into the same conversation right now.

## Config

`fileChanges` and `ConfigFiles` (`packages/engine/src/config/configuration.ts`) say which keys a session follows when
the files changed: each key whose value in the files moved, unless the session has a value of its own. `Chat` calls
`beforeWork` once it holds the lease: the worker runs `followFiles` (every tab follows, as with `syncConfiguration`,
which stays), and `duo chat` follows through its own `ConfigFiles`. A change made without `--save` lives in that host's
memory only. The `next-call`/`next-run` timing of `Chat.follow` is unchanged.

## Views (the extension and the desktop)

`WorkspaceSession` (`packages/host/src/workspaceSession.ts`) looks every 1.5 s, while it has tabs:

- who holds the workspace: another process gets the `locked` problem banner (with the conversation it works in, from
  the conversation locks), which goes when it is free;
- for each idle tab (nothing running or waiting in it here), whether the conversation's record or its view.json
  changed. A view.json another host saved that shows every exchange, discussion and run this tab shows replaces this
  tab's timeline (`adoptedView` keeps the composer's files and this host's workspace state); then `withRecord`
  (`packages/host/src/viewState.ts`) appends what the record holds after the last exchange the view shows, by id, as a
  message and its answer (and runs as a run item and a note). Exchanges without ids, and a view that dropped older
  items, add nothing, so nothing shows twice. The questions come from the ledger (`withLedger`), as before;
- whether the saved conversations changed, for the lists (`onConversationsChanged`).

Before a message is sent, its tab is brought up to date, so the message follows what was said elsewhere. A tab opened
for a conversation with no view.json (one `duo` had) shows its history from the record. view.json names the host that
wrote it; a host writes over a view.json another host saved since its own last write only when its own view shows
something that one does not: closing an idle tab never puts an older view over a newer one. The composer's draft lives
in the page and is never in a snapshot.

## The CLI

`duo chat [conversation]` opens a saved conversation (its id, the start of one, or `latest`); `duo chat --list` lists
them, newest first, with the pid of a process working in one. An unknown or ambiguous id, or a conversation another
process holds, is an error before anything opens. `duo` alone opens a new conversation, and holds nothing until it
works. The chat greets with the conversation's history (`ChatUi.history`) and, while idle, calls `Chat.refresh` every
2 s to show what another host said.

## Tests

- `packages/engine/test/workflow/lease.test.ts`: processes racing for the lock (never two at once), a stale lock taken
  over by several racing processes, an unwritten lock, a lock taken over meanwhile not released, the lease's counts.
- `packages/engine/test/chat/chat.test.ts` ("other agentduo windows"): held through a question to the user and given
  back after, refused lines with their files kept, two chats on one conversation in turn (sessions, no overwrite,
  `refresh`), a deferred recipient, config read again before work.
- `packages/host/test/workspaceSession.test.ts` ("other agentduo windows"): an idle tab following another host (files
  kept, nothing twice), closing an idle tab, a conversation from `duo`, the banner and the message given back.
- `apps/cli/test/worker-lock.test.ts`: real workers and the real CLI: `duo` while a worker is idle; refused while a
  worker works or waits on a question or a decision; two workers sending at once; a conversation back and forth; a
  killed worker's locks taken over; saved and unsaved settings across workers; `duo chat --list` and its errors.
- The desktop e2e: idle, the app holds no lock; the banner and the message given back while another process holds it; a
  conversation `duo` saved, listed and opened with its history.

## Limits

- A pid reused by another process after a crash keeps a stale lock alive until that process exits.
- Idle tabs and `duo chat` notice another host's writes by polling (1.5 s and 2 s), not by file events.
- An answer given in a host that saved no view shows without its tool activity elsewhere.
- A recipient chosen while another host holds the conversation shows in this tab, but the tab follows the record's
  until this host's next work saves it.
