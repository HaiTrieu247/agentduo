# agentduo: context shared between the agents of a run

Status: implemented. Amends `2026-10-27-agentduo-channel-design.md` (§4 calls and config, §5 prompts) and the output
schemas of `2026-10-27-agentduo-npm-cli-design.md`.

## Problem

Every pipeline call was a CLI process with a session of its own that was never kept (`codex.args: [--ephemeral]`,
`claude.args: [--no-session-persistence]` by default). So each call started cold:

- **Within a role.** The implementer's fix round, the critic's second round, the reviewer's re-review and the
  planner's revision all re-read the files the same role had read one call earlier. Each prompt also repeated the
  whole task, the chat before it, every note, and the agent's own previous answer (the previous plan as JSON, the
  previous report).
- **Across roles.** The planner explored the repository; then the critic, the implementer and the reviewer each found
  the same files again. Only the artifacts passed on (the plan, critique, report, diff and review). What an agent had
  learned about the code was lost at every handoff.

## Goals and limits

- Reuse what an agent already learned, within its role and, where that is safe, across roles.
- Send each turn what is new since the last one, not the full history again.
- Keep the judging roles independent. The code reviewer must never see the implementer's reasoning, and the plan
  critic must never take the planner's word for the code.
- Stay accurate when files change: tell an agent what changed, and drop shared facts about changed files.
- Stay compatible. Same phases, artifacts and decisions; older runs and saved configs keep working. A lost session
  costs one cheap failed call, never a failed step.
- Not in scope: chat and `/discuss` turns (they still start fresh), and sharing a session between roles.

## Two mechanisms

### 1. Each role continues its own session

`state.sessions[<config role>]` (`RoleSession`) records the CLI session of the role's last successful call, and how far
that session has been told about the run:

| Field | Meaning |
|---|---|
| `backend`, `id` | the CLI and its session: Claude's `session_id`, Codex's `thread_id` (from `thread.started`) |
| `tree` | the workspace tree when its last turn ended |
| `notes` | how many human notes it was given |
| `repoNotes` | the newest repository note (`seq`) it knows, its own included |
| `planHash` | the plan its last turn had (the one it wrote, critiqued, signed or worked from) |
| `reviewed` | code reviewer: the revision it last reviewed |

The key is the config role, so plan sign-off (config role `planner`) continues the planner's session. It is the planner
signing off its own plan. No session ever goes from one role to another.

A role's next call (`planTurn` in `src/core/context.ts`) continues that session when all of these hold:

1. the user's args keep sessions for the role (`AgentBackend.keepsSessions`: no `--ephemeral` /
   `--no-session-persistence` in `args` or the role's `role_args`);
2. the role still runs on the same CLI (a `--reload-config` that moves it starts fresh);
3. git can still diff the session's `tree` against the workspace now.

Otherwise the call is fresh, exactly as before.

**CLI protocol** (verified 2026-11-03 against codex-cli 0.164.0 and Claude Code 2.1.314; real calls, schema-constrained):

| | Codex | Claude Code |
|---|---|---|
| keep a session | omit `--ephemeral` | omit `--no-session-persistence` |
| continue it | `codex exec <exec options> resume <id> [--image=…] -`: exec's options (`--json`, `--output-schema`, `--output-last-message`, `--cd`, `--skip-git-repo-check`, args, role_args) go before the subcommand | `claude -p … --resume <id>` |
| on resume | same `thread_id` in `thread.started`; the schema and the last-message file apply | same `session_id`; `--json-schema` applies (`structured_output`); `total_cost_usd` is this call's |
| unknown session | exit 1, stderr `no rollout found for thread id …`, no turn | exit 1, result `error_during_execution`, `No conversation found with session ID: …`, cost 0 |

The persistence flags are now protocol flags. The defaults no longer list them in `args`. agentduo passes them itself
to every call it will not continue: conversation turns, `/discuss` turns, and pipeline calls whose sessions the user
turned off. It never repeats a flag the user's args already pass, since Codex rejects a repeated `--ephemeral`.
`duo doctor` checks for `--ephemeral` and `resume` (Codex) and for `--no-session-persistence` and `--resume` (Claude).

**Fallback.** The runner tries the continued call first. If that attempt fails for any reason (the session is gone,
the answer is unusable, a timeout), it starts a fresh session with the whole prompt and all the files. That fresh
attempt carries no rejection note, because the new session never saw the failed one, and it keeps its full retry
budget. The failed attempt is shown as a retry ("the earlier session could not be continued (…); starting a new
one"). Interrupts behave as before.

A session is recorded only after its turn succeeded. An interrupted or failed turn leaves the previous record, and a
call whose CLI named no session removes it.

### 2. Continued turns get only what is new

A continued prompt (`PromptContext.continued`) keeps the first line `[orchestrator-role: <role>]`. After it come a
short reminder that the session holds the task, the conversation, the earlier notes, the roles and what the agent
read, and then only:

- **Files changed since your last turn**: `Git.nameStatus(session.tree, now)`, at most 100 listed, with the
  instruction to re-read before relying on memory. Files the agent changed itself are in its session, not in the
  list. This is how a continued session stays accurate when a gate, another agent or the user edits files.
- **New notes from the human operator**, with their files. Only those files go with the call; the session already
  has the earlier ones.
- **New repository notes** (below).
- **The work to act on**, as before: the critique to address, the plan version to critique, the findings and
  failing gates to fix, the implementer's report and responses to review.
- **The role's instructions and output rules**, repeated. They are short, and they keep the decision rules exact
  after a CLI compacts the session.

It leaves out what the session already has: the task and its files, earlier tasks, the conversation, the notes it saw,
and the agent's own previous answers (previous plan JSON, previous critique's issue list, previous report). A plan
it already has (`knowsPlan`: `session.planHash` equals the plan the turn is about) becomes a pointer to the plan's
file. A changed plan, for example after a re-plan, is sent in full, marked "(new since your last turn)".

A continued **code review** gets the diff from the revision it last reviewed to the new one, plus the cumulative diff
stat and where the whole diff is (`git diff base snap -- .`, or `diff.r<k>.patch` for internal snapshots). It is
told to judge the whole change all the same. If that revision cannot be diffed, it gets the whole diff, as a fresh
review does.

### 3. Repository notes shared across roles

The plan, plan critique, implementation and review schemas gain a required `repo_notes: [{ path, note }]`. It stays
OpenAI-strict, and an empty list is valid. The prompt asks for facts the agent checked in the files and the next
agents would otherwise look up again. Examples are what a file holds, where something is defined, a convention, or
the test command. Each fact names the file or folder it is about, with at most 12 per turn and one sentence each.
Plans, opinions and verdicts are not facts. Plan sign-off has no notes: its schema is a short decision.

agentduo keeps a note only when its path is in the workspace and exists (`acceptRepoNotes`). It collapses
whitespace, cuts a note to 300 characters and drops duplicates. Each kept note (`RepoNote`) is anchored to the
workspace tree when its turn ended, and the run keeps the newest 60 (`state.repoNotes`).

Before each turn, `visibleRepoNotes` decides which notes the role gets:

- **Independence.** A role never gets the notes of the author whose work it judges. The plan critic gets none of the
  planner's, because its job is to check the planner's assumptions in the code. The code reviewer gets none of the
  implementer's. The reviewer still gets the implementer's report, which is the handoff by design.
- **Accuracy.** A note is passed on only while nothing under its path changed between its anchor tree and the
  workspace now, so a folder note dies with any change inside the folder. A note about a file the implementer
  edited never reaches the reviewer. If git cannot diff a note's anchor any more (a pruned tree), the note is dropped.
  A note is not lost while it is hidden: if the file returns to its content, the note holds again.

A fresh session gets every note it may see. A continued one gets only those newer than its `repoNotes` cursor. The
cursor is set after the turn's own notes are added, so an agent is never sent back what it wrote.

## Compatibility

- Phases, artifacts, decisions, escalations, limits and exit codes are unchanged. Each envelope adds
  `resumed_session`.
- `state.sessions` and `state.repoNotes` are optional, so `STATE_VERSION` stays 1. Older runs resume with fresh
  sessions and no notes. A saved `config.json` that lists the old default flags keeps every call fresh.
- An older artifact without `repo_notes` is still readable (only new outputs are validated). Fake scenarios and
  builders were given `repo_notes: []`.
- **User-visible change:** kept sessions are written by the CLIs and show up in their own session lists
  (`claude --resume`, `codex resume`) for the workspace. Users who do not want that put `--no-session-persistence` /
  `--ephemeral` back in `args` (desktop Settings: "Don't save sessions"), which also turns continuation off.
- Workspace and repository: trees come from the run's own `Git` (native or internal), so folders without a
  repository work the same. A resumed Codex call keeps `--skip-git-repo-check` before `resume`.

## Alternatives considered

- **One session shared by all roles, or a forked one** (`--fork-session`). Rejected: the reviewer would inherit the
  implementer's reasoning, and a Claude session cannot be continued by Codex anyway.
- **A shared context file in the workspace** that agents read and edit. Rejected: it changes the user's tree, shows up
  in snapshots and diffs, and anyone could write anything into it. The notes live in the run's state, outside every
  snapshot.
- **Summaries written by agentduo** (a repository map). Rejected: it would cost a model call of its own, or be a
  shallow file list that tells the agents nothing new.
- **Only notes, no sessions.** That would keep the within-role waste, which is the larger share: fix rounds and plan
  revisions are where repeated exploration piles up.
- **Ending a session after N turns.** Not done: both CLIs compact long sessions themselves, and the cached prefix makes
  a continued turn cheap. It can be added if real runs show sessions growing too large.

## Tests

- `test/context.test.ts`: note acceptance (paths, length, count), the newest-60 cap, visibility (independence,
  folder invalidation, undiffable anchors), turn planning (continue, or start fresh on persistence off, a CLI change or
  an unknown tree), and session cursors.
- `test/backends.test.ts`: the session flags of both CLIs (keep, continue, never repeat the user's flag, text turns),
  and Codex's `thread_id` from a real stream.
- `test/runner.test.ts`: a continued call gets the short prompt and only its new files; a lost session falls back to
  the whole prompt without a rejection note and without spending a retry, on both CLIs; conversation turns keep no
  session.
- `test/prompts.test.ts`: continued prompts for all five roles (what they keep and drop), plan pointers versus a
  changed plan, the reviewer's incremental diff, and the notes sections and their placement.
- `test/workflow.test.ts`, through `fake-agent.mjs`, which now keeps and loses sessions as the CLIs do:
  - per-role continuation and no cross-role session;
  - the changed-files list;
  - the reviewer's incremental diff;
  - lost sessions with `max_retries: 0`;
  - sessions turned off by args;
  - `duo resume` continuing saved sessions, and starting fresh on a new CLI;
  - notes across roles, with independence and invalidation.
