# agentduo: Team mode (a department of agents)

Status: implemented. Builds on `2026-10-27-agentduo-channel-design.md` (agentduo enforces nothing),
`2026-11-03-agentduo-run-budget-design.md`, `2026-11-03-agentduo-scope-design.md` and
`2026-11-07-agentduo-window-handoff-design.md`. The pipeline (`/pipeline`, `duo run`) is unchanged.

The design was agreed in chat on 2026-11-12, one question at a time; the spec and plan review gates were skipped at the
user's request (implementation started right after the design was approved).

## Problem

The pipeline has four fixed roles and one implementer, run one after the other in the user's own folder. A larger task
cannot be split between several agents working at once, the user cannot shape who does what (seniority, specialists,
testers), and the requirements are only as clear as the task line the user typed.

## What the user gets

- **A team.** A PM, a techlead, and any number of members in roles of two kinds: *worker* (takes tasks: `dev`,
  `frontend-dev`…) and *checker* (checks tasks: `qa`, `security`…). Each member has a level (`junior`, `mid`,
  `senior`… the user's own list) and runs on Claude or Codex.
- **One voice.** The user talks only to the PM. Everything an agent says to the user is the PM's; the techlead and the
  members talk to each other and to the PM. Notices no agent wrote (budget reached, an agent failed) stay agentduo's.
- **Three approvals, all through the PM:** the PM's brief, the techlead's plan (the PM checks it against the brief
  first), and the final acceptance.
- **Parallel work in isolation.** Every agent works in a git worktree of its own under agentduo's data root. The user's
  folder is read once (the base snapshot) and written once, after the user accepts the result.
- **Levels that matter:** the techlead assigns work by level, each level has its own model and effort per CLI, each
  level has its own identity file (autonomy), and `can_review` decides who reviews whom.
- **Identity files** in layers: `roles/<role>/IDENTITY.md` + `levels/<level>/IDENTITY.md` + `agents/<name>/AGENT.md`
  (optional). Defaults ship with agentduo; the user's files (user config and project) are appended, or replace the
  default with `replace: true` front matter.

## Flow

```
INTAKE ──(you approve the brief)──▶ PLANNING ──(PM checks, you approve the plan)──▶ EXECUTION
   ▲                                                                                   │ all tasks merged
   │ brief v2 (scope change)                                                          ▼
   └──────────────────────────── ACCEPTANCE ◀──(QA passes)── INTEGRATION ◀────────────┘
                                     │ you accept                 │ failures: techlead adds fix tasks
                                     ▼                            └──▶ EXECUTION
                                   APPLY ──▶ DONE
```

- **INTAKE.** The PM asks until goal, users, scope, out of scope, constraints and acceptance criteria are clear, in prose
  or with a question form. It ends with a brief (`goal`, `scope`, `out_of_scope`, `constraints`, `criteria: [{id, criterion}]`).
  The user approves it or asks for changes (the PM revises).
- **PLANNING.** The techlead writes a plan: tasks with an id, a description, an `assignee` (a worker member by name),
  `testers` (checker members, at least one), the files or areas it touches, `depends_on`, the `criteria` it serves and
  a test focus. agentduo checks its structure (names, kinds, acyclic dependencies, known criteria). The PM checks it
  against the brief (every criterion covered, nothing out of scope) and sends it back with issues, or presents a
  summary to the user, who approves it or asks for changes (the PM relays them to the techlead).
- **EXECUTION.** A task is ready when its dependencies are merged and its assignee is free. At most `team.max_parallel`
  member calls run at once (the PM's turns do not count: the user waits for them).
  1. *Code and tests in parallel.* The assignee codes in its worktree, reset to the integration head (`task.base`). At
     the same time the tester writes tests from the plan and the criteria in its own worktree, without seeing the code.
  2. *Review.* A member whose level cannot review is reviewed by a free member whose level can (same role first, never
     themselves); a member whose level can review is reviewed by the techlead. Changes requested go back to the same
     assignee, at most `team.limits.max_review_rounds` times.
  3. *Test run.* agentduo merges the code and the tests into a candidate commit (`git merge-tree --write-tree`). The
     tester runs the task's tests and the configured gates there and may add tests for edge cases it now sees. Other
     checkers the plan names check the same candidate.
  4. *Triage.* On a failure the techlead decides: `retry` (same assignee, with guidance), `reassign` (another worker,
     possibly a higher level), `fix_tests` (the test is wrong), `add_tasks`, or `escalate` (a question for the PM).
     A task gets at most `team.limits.max_task_attempts` attempts.
  5. *Merge.* A passing candidate is merged into the integration branch with a 3-way merge (the head may have moved).
     A conflict becomes a merge job for the techlead in its worktree (the integration head with the task merged in and
     the markers left); the resolution is refused while a marker remains or if the head moved meanwhile. The gates run
     on every candidate and on the whole result, not after each merge; the check of the whole covers what a merge or a
     resolution could break.
- **INTEGRATION.** Once every task is merged, the testers run every test and gate on the integration head. Failures go
  to the techlead, who adds fix tasks (back to EXECUTION).
- **ACCEPTANCE.** The PM reports each criterion with its evidence. The user accepts, or asks for changes: within the
  scope the techlead adds tasks; outside it the PM writes brief v2 for approval and the techlead plans the rest.
- **APPLY.** agentduo snapshots the user's folder (a backup ref, `duo team undo <run>`), then writes the integration
  tree into it: the changed, added and deleted files, nothing committed. If the folder changed since the base, it is a
  3-way merge (base, the folder now, the team's result); a clean merge is a tree nobody tested, so the testers run every
  test and gate on it first; conflicts are reported by the PM, and the user chooses: the techlead resolves them on top of
  the folder's current state, or the user resolves the markers. DONE only when the folder holds the tree that passed.

**Questions inside the team:** a worker asks the techlead; the techlead answers or asks the PM; the PM answers or asks
the user. The answer goes back down the same chain.

**Messages from the user while the team works** go to the PM, who answers at once (the team keeps working). A
clarification becomes a note for the techlead; a scope change becomes a new brief to approve, then a plan change.

**Reports by milestone.** The techlead's outputs (plan, triage, answers) carry a one-line report; agentduo writes the
others (task merged, the whole passes). Reports go to the PM's inbox. The PM is called when there are new reports and it
is free, at most once a minute (`REPORT_INTERVAL_MS`), with every report since its last turn, and tells the user in its
own words. An escalation has a stable id (`T1-E1` for a task's, `E1` for the run's) that the PM answers with
`team_answer`.

**Files.** Files attached to the request or to a message for the PM go with it (`TeamMessage.attachments`): the run
copies them into its own folder (`<runs>/teams/<id>/attachments/`) and every member is given them, as the pipeline gives
every step its files: the images the CLI takes as images, the others by path (`filesSection`, with `attachmentLines`).
A fresh session gets them all; a session that goes on gets only those it was not given (`MemberSession.files`). The PM's
transcript says which message brought which files.

**When the team stops to ask the user (through the PM):** the budget is reached; a task ran out of review rounds or
attempts; a review or test loop made no progress twice in a row; a merge conflict cannot be resolved; an agent keeps
failing; a question nobody on the way up could answer.

## Groups (added 2026-11-12, after the first trial)

A member may have a `group` (an area of the work). With groups:

- The one PM in no group is the head PM, the only one who talks with the user. Each group has exactly one techlead,
  at least one worker and one checker, and at most one PM of its own; every other member is in a group.
- Names: `techlead-frontend`, `pm-backend`, `dev-frontend-1`… (or the member's own `name`).
- After the brief is approved the head PM gives each group its part (`areas`: what it builds, the criteria it answers
  for; every criterion is some group's). The techleads plan their parts at the same time, each giving tasks to its own
  group only (dependencies inside the group). A group's PM checks its plan (`area_review`), then the head PM the whole
  set (`plan_review`, issues by group); the user approves the set once (`planSignature`). A change of the brief replans
  only the groups whose criteria no task serves yet.
- A task's review, triage, answers and merge conflicts are its group's techlead's; the reviewer of a junior's or mid's
  code is a senior of the same group first, then of another group, else the group's techlead.
- Questions go up: worker → its techlead → the group's PM (`team_answer`, or `escalate` to the head PM) → the head PM
  → the user. A failure of the whole goes to the groups answering for its criteria (none: the first group), each adding
  the tasks that fix its share; the team goes back to work once every such group answered.

## Git

- **Base.** When the brief is approved, agentduo snapshots the workspace (dirty and untracked files included, the runs
  directory and `.claude/settings.local.json` left out, as every snapshot does) into a commit `base`, kept under
  `refs/agentduo/team/<run>/base`. The integration branch `refs/agentduo/team/<run>/integration` starts there.
- **Worktrees.** `<dataRoot>/teams/<run>/<member>/`, created with `git worktree add --detach` from the run's repository
  (the workspace's own, or agentduo's internal bare repository for a folder without git), so nothing appears in the
  user's repository. An agent runs in the worktree's copy of the workspace (`<worktree>/<prefix>` when the workspace is
  a subfolder of its repository). The workspace's `.claude/settings.local.json` is linked into each worktree, so the
  user's "always allow" rules hold there and new ones are saved to the user's file.
- **Snapshots.** After each member turn agentduo snapshots the worktree into the task's ref
  (`refs/agentduo/team/<run>/task/<task>/<member>`). Agents need not commit; one that does changes nothing.
- **Merges** use `git merge-tree --write-tree` (git ≥ 2.38, which `duo doctor` checks) and `commit-tree`; no working
  tree is involved unless there is a conflict.
- **Dependencies in worktrees.** `team.worktree.setup` (commands run once in a new worktree, e.g. `npm ci`) and
  `team.worktree.link` (ignored folders shared from the workspace by symlink, e.g. `node_modules`). Both are empty by
  default; agents install what they need.
- **Clean-up.** Worktrees are removed after APPLY or ABORT; refs stay until the run is deleted.

## Configuration

`team:` in `config.yaml`, layered like every other key (defaults → user config → project). Structure and identity
files are `next-run` (fixed when a run starts and copied into the run); a member's model, effort and args are
`next-call`.

```yaml
team:
  levels:                    # lowest first
    junior: { can_review: false, claude: { model: sonnet, effort: low },    codex: { effort: low } }
    mid:    { can_review: false, claude: { model: sonnet, effort: medium }, codex: { effort: medium } }
    senior: { can_review: true,  claude: { model: opus,   effort: high },   codex: { effort: high } }
  roles:
    pm: { kind: pm }
    techlead: { kind: lead }
    dev: { kind: worker }
    qa: { kind: checker }
  members:
    - { role: pm, level: senior, cli: codex }
    - { role: techlead, level: senior, cli: codex }
    - { role: dev, level: senior, cli: claude }
    - { role: dev, level: mid, cli: claude }
    - { role: qa, level: mid, cli: claude }
  max_parallel: 3
  limits: { max_review_rounds: 3, max_task_attempts: 3 }
  worktree: { setup: [], link: [] }
```

- A member is `{ role, level, cli, count?, name?, model?, effort?, args? }`. `count` makes `<role>-1`, `<role>-2`…
  (numbered per role across entries); `name` names one member. A member's model and effort win over its level's.
- Exactly one member of kind `pm`, exactly one of kind `lead`, at least one worker and at least one checker; names are
  unique words; every role and level a member names exists. Errors are config errors: no team starts.
- The run's budget is the pipeline's `limits.max_run_*`, counted over every member.

## Identities and prompts

A member's prompt is, in order: agentduo's protocol section for the turn (the role in the flow, what to do now, the
output contract; not editable), `roles/<role>/IDENTITY.md`, `levels/<level>/IDENTITY.md`, `agents/<name>/AGENT.md`.
Each is one whole text: the project's file (`.agentduo/team/…`), else the user config's (`<user config dir>/team/…`), else
agentduo's (`packages/engine/src/team/defaults.ts`, in the code so every bundle has it). A file starts as agentduo's
text and you add to it or rewrite it (amended after the first trial: files used to be appended to the default); front
matter and HTML comments are left out. A role with no
file of its own uses its kind's default and a warning says so; a level without one has none. The run keeps what it
started with in `identities.json`. A continued session gets the turn's section without the identities, and only what
changed in it (below).

**Sessions** (amended 2026-11-13, after the first real run used a Claude Pro plan's 5 hours by task 2): a member's CLI
session holds one task, kept under `sessionKey` (`<member>@<task>`): its work and fixes, its tests and checks, the
techlead's review, triage, answer or resolution of it. A turn of no task (the PM's conversation, the techlead's plan,
the check and triage of the whole result) goes on in the member's own session (`<member>`). A new task starts a fresh
session with the whole prompt, so no call carries another task's history: in that run each new job of a member had
started with all its earlier ones (dev-1's review of another task at 290k tokens of context, a fresh call at 44k),
about a third of the run's Claude tokens. A techlead's notes from the PM are counted per session
(`MemberSession.notes`): a fresh one gets all of its group's.

**A worker's review is a session of its own** (amended 2026-11-16): `<member>@<task>:review`. A worker can review a
task it built in an earlier attempt (a reassigned task). In its work session that review started with the whole
implementation in its context (dev-1's review of T5 at 313k tokens, of T1 at 269k; a fresh review of the same size
near 50k), and with its own reasoning about the code it now judges. Its review session holds its reviews of that
task only, so its next round goes on there. The techlead's review stays in `techlead@<task>`: the techlead never
builds a task, and its triage and answers of the task use what its review found.

**Continued prompts carry only what changed** (amended 2026-11-16, as the pipeline's do:
`2026-11-03-agentduo-context-sharing-design.md`). Measured in the runs of 13 and 14 November, a continued prompt repeated
what its session already held: 91–93% of the PM's (the team, the whole brief, the plan, the board and the whole
conversation, every turn), 72% of a review's (the whole change again each round, about 35k tokens), 72–88% of work,
triage and answer prompts. The PM's single session grew 4.5–4.7k tokens a call, so about 95 calls would fill Codex's
window. Now:

- A prompt is a list of parts (`render`, `team/prompts.ts`). Some parts come in every prompt: the role line, the team's
  rules, the exceptions for this work and the guidance about them, the work to act on (the review's findings, the
  techlead's guidance, the question and its answer, what failed, the new reports, the questions for the PM, the PM's
  incidents and requests) and what to do now with the output contract. These are short, and they keep the decisions
  exact after a CLI compacts the session. The others are kept parts: the introduction, the team, the brief, the task,
  the plan, the groups' parts, the board, a task's history, why a worker's earlier attempt failed, the assignee's
  report, the change under review.
- Each session's record keeps a digest of every kept part it was given (`MemberSession.seen`; a list's items one by
  one). A continued call gets a kept part again only when its digest changed, a list only its new or changed items. So
  the PM gets the tasks that changed on the board, with where the board stands ("5 tasks: 3 merged, 2 review"). A
  triage gets the task's history since its last turn. The PM's conversation goes by its own count (`pmSeen`): a
  continued turn gets the messages after it, or none.
- What a turn wrote itself is in its session, so its later prompts leave it out (`TeamRun.knows`, with `authored`):
  the PM's brief and the groups' parts, a techlead's plan.
- A continued review gets the diff from the commit it reviewed last (its record's `change`) to the one under review,
  with the stat of the whole change and how to see all of it in its worktree. It is told to judge the whole change all
  the same, and to check that its earlier findings were dealt with. When that commit cannot be diffed any more, it
  gets the whole diff, as a fresh review does.
- A continued prompt says so in place of the introduction: what its earlier turns gave still holds, and only what is
  new or changed follows. A continued call that fails falls back to a fresh session with the whole prompt (the runner).
  That session's record holds that prompt's parts only. A session that went on keeps what it held before as well. A
  session recorded before this change has no digests and gets every part but the identity, as before.

## The team's rules (added 2026-11-14)

A team learns from what it settled, and keeps it beyond its runs; the user grants every departure from it.

- **Where.** `team.id` (default `default`, a name like a member's) names the team. Its rules are one append-only file,
  `<data root>/team-rules/<workspaceKey>/<team id>/RULES.md` (`team/rules.ts`: `workspaceKey` is the canonical folder's
  name and a hash of its path), outside every run, worktree and undo. `TeamRun.create` creates it (a team whose file
  cannot be made does not start, and leaves no run) and records `state.rulesStore` (team id, workspace key), so a resumed
  run reads the same team whatever the configuration says now. Writes take the folder's lock; a rule is a block with a
  marker (`<!-- agentduo-rule id=R<n> op=<opId> at=… -->`), its text and its `Source:`; the same operation id adds it once
  (`lesson:<run>:<incident>`), and whatever the file held, the user's own lines too, stays byte for byte.
- **Every call.** `TeamRun.call` reads the rules once per call (`promptRules`); every prompt's frame carries them
  (`rulesSection`), the full prompt, the continued one and the fresh session a lost resume falls back to alike, with the
  decisions about exceptions for that very work (`exceptionsSection`) and how a member raises a problem
  (`memberGovernanceGuidance`). Every member schema has `governance: { issues, exception }`.
- **Incidents and lessons** (`team/rule-governance.ts`, pure). The flow records incidents itself: a review that asked
  for changes and a failed check (per attempt and round), a failed check of the whole result, a PM that sent a plan back,
  an escalation of planning or of a task or integration that did not converge (once answered), the user asking to change
  the brief, plan or result; and a member's `governance.issues`. Each is keyed by its occurrence, so a retried turn
  records it once. The run marks one resolved when what it was about is settled (`settledBy`: the review approved, the task
  merged or cancelled, a later plan approved, the whole passes, the user approved), and the head PM's `rule_lesson` turn
  appends a rule for it or says why none is needed (`rule: null`). One turn answers every incident due (`lessons`, one
  entry each, checked against the incidents its prompt listed; the same rule twice is refused, the other entry names it):
  in EXECUTION and INTEGRATION the turn is decided after the jobs that can start have started (`schedule`), and waits
  while other jobs run, up to the report interval since the first was due (`lessonOwed`), so that incidents settling
  meanwhile join it; elsewhere it is at once. A lesson is saved `recording` before RULES.md is
  written and `recorded` after, so a stop between the two is finished on resume without the PM and never doubles the
  rule. The apply waits for the lessons owed, and so does the end of a run already written; a PM that settles none in two
  turns stops the run `waiting` (resume asks again).
- **Exceptions.** A member's `governance.exception` (rules, reason, alternative) is a request for exactly the work of its
  call (a task, or a unit: a group's planning, the integration, the apply, each with the occurrence it had); its result is
  not used (`Held`), and every job, merge, answer, acceptance and apply of that work waits (`heldByException`,
  `heldTaskIds`, `unitHeld`) until the decision is delivered, while other work goes on. A group's own PM refuses it or
  passes it up (escalation `rule_exception`); the head PM declines it, asks the user (`rule_question`, whose answer is
  information) or proposes it (`exception_proposal`: rules, reason, alternative, a scope within the request). agentduo
  shows the proposal as a request of source `team` with the options `approve` and `reject`; only exactly one of those, in
  answer to that very request, decides; words, a deferral, a closed request or no decider leave it pending, asked again on
  reopening (the same request while its ledger entry is pending). Approved, it covers its scope in this run only
  (`exceptionsFor`), the rule stays as written, and no other task or later run inherits it.

## Engine

`packages/engine/src/team/`:

| File | Purpose |
|---|---|
| `config.ts` | `team:` types, defaults, validation, members from `count`, a member's model/effort/args |
| `identity.ts` | the layered identity files, and the copy kept in the run |
| `board.ts` | the task state machine: readiness, reviewer choice, triage, limits (pure) |
| `scheduler.ts` | the loop that starts member calls up to `max_parallel` and applies their results |
| `worktrees.ts` | worktrees, task refs, merges, applying to the workspace, undo |
| `prompts.ts` | the protocol section of each turn |
| `rules.ts` | the team's RULES.md: where it is, read, append under a lock, once per operation |
| `rule-governance.ts` | incidents, lessons and exception requests, their scopes and decisions (pure) |
| `team.ts` | `TeamRun`: prepare, run, the user's messages to the PM, decisions, resume |

- Schemas `packages/engine/schemas/team_*.schema.json` (OpenAI-strict like the others).
- The runner takes a member call: its backend, model, effort and args are the member's, it runs in the member's
  worktree (Codex gets `--cd <worktree>`), and its events name the member.
- Events: `team.started`, `team.member`, `team.task`, `team.activity`, `team.message` (the PM to the user),
  `team.finished`.
- A team run lives in `<runs>/teams/<id>/` (`state.json`, `config.json`, `team/` identities, logs). On resume, calls
  that were running are queued again and a worktree that is missing or does not match its ref is created again.

## Interfaces

- `duo doctor` says whether git is 2.38 or later.
- Snapshots: a copy of git's index keeps the index's own time, so a file rewritten at the same size in the second the
  index was written is still seen (git's racily-clean check). This was a latent bug of every snapshot (pipeline runs
  too), found by the team's tests.
- The composer's menu (VS Code, desktop) has **Team**: the next message is `/team <message>` (route `team`, host protocol
  13).
- Chat: `/team <request>` starts a team in the conversation; while it is active, plain messages go to the PM (the input
  shows "PM"). `/team status`, `/team members`, `Esc` (stop the running calls; `/resume` continues), `/team undo <run>`.
- CLI: `duo team "<request>"`.
- The three approvals are the PM's question forms (through the broker): approve, or change with your words.
- Terminal: the chat with the PM, and a board in the footer (members, their task and step). VS Code and desktop: the PM's
  messages and documents in the timeline and a read-only team card above the composer (phase, who works on what, the
  task board); the composer says the message goes to the PM. Desktop Settings → Team is one list of members, grouped
  as the team runs (the head PM, then each group), each row with its kind, names, level and what it runs on. One form
  adds or changes a member: its role, level, CLI, model and effort (empty: the level's; only a value that differs is
  the member's own), group, how many and name, with a preview of the names it makes (`memberNames`); it can make a new
  role (with its kind), level (above every other, with "reviews others' code", which is the level's) or group on the
  way. A line above the list says, in words, what the team still needs to start (per group too). With no file setting
  `team.members` (`teamMembersSource`, `TeamInfo.membersFrom`) the list starts empty and agentduo's team runs until one
  is saved; "Start from agentduo's team" fills the list with it. Saved into the user config or the project's file
  (`team.save`, refused while the team could not start); custom roles and levels no member uses are left out. A
project's team wins over the user config's, so saving for every project while the project has a team of its own says
so beside the save and asks whether to remove the project's (`team.reset`, `resetTeam`): kept, the list would show the
project's team again after the save, as if the edit were lost. A row
  opens its role's, level's and own identity texts, edited in place for every project or this project, reset to what
  they fall back to, or opened in the editor (`team.identity.*`, `team.openIdentity`; main acts only on names the saved
  team has); and the default IDENTITY.md files can be written into the project (`team.identity.defaults`). A task's
  history and diff in the card are not there yet.
