# /discuss: both agents agree on an answer

Amends `2026-10-27-agentduo-channel-design.md`. The chat had three ways to ask: a question for one agent (`/codex`,
`/claude`, or a plain message) and a task for both (`/pipeline`). `/discuss <question>` adds a fourth: the agents
check each other's answer until they agree, and the user gets the agreed answer as the response.

## Behaviour

- The current recipient answers; the other agent reviews. In the sidebar, the recipient chip's menu has **Discuss**,
  for the next message only (like Pipeline, and off while something runs).
- Both CLIs must be found. While a pipeline runs or an answer is under way, `/discuss` is turned away as any question
  is.
- Flow, with `N = limits.max_discussion_rounds` (default 3, a positive integer):

  ```
  answerer  answer, version 1
  critic    review of version 1  → VERDICT: AGREE  → done: version 1 is the answer (agreed)
                                 → VERDICT: REVISE → answerer writes version 2, critic reviews it, …
  after review N still REVISE → answerer writes the final answer, version N+1, with no further review (disputed)
  ```

  A discussion makes 2 to 1 + 2N agent calls.
- The final answer of a disputed discussion ends with a short section on what the agents still disagree on.
- A review's verdict is the last line of its own that says `VERDICT: AGREE` or `VERDICT: REVISE` (case and markdown
  emphasis ignored, `core/discussion.ts`). That line is dropped from the review shown. A review with none counts as
  REVISE, and a `warning` event says so.
- The agreed or final version is the response. It is the only part of the discussion later prompts carry: one
  exchange from the answerer, marked `discussedWith` the critic (`Exchange.discussedWith`). Drafts and reviews stay in
  the discussion and in the conversation's logs.
- Esc stops the call under way, and the discussion ends `interrupted`. A failed call ends it `error`. Either way
  nothing joins the context, and the turns that finished stay visible.
- Agents run as for any chat question: same CLI configuration, no flags or rules added.

## Prompts

Each turn is a conversation turn (`[agentduo-conversation]` first, text mode, no schema). Its second line is
`[agentduo-discussion: <step>, round <n> of <N>]`, with step `answer`, `critique`, `revise` or `final`.
`prompts.discussion` gives, in order:

1. who is who;
2. the conversation as it stood when the discussion began (the same for every step);
3. the user's question, once;
4. the discussion so far, with each review's verdict;
5. what this step asks.

A review is asked to check the latest version (reading code or running what the answer depends on), to say what is
wrong briefly and concretely without rewriting it, and to end with its verdict line. A revision gives the whole answer
again, addressing the review, and keeps its position with a reason where it disagrees.

## Events

Every turn is a normal turn: `turn.started` and `turn.finished`, with `discussion: { id, step, round }`. A review's
`turn.finished` also carries `verdict` (null when it had none), and its `answer` comes without the verdict line.

Around the turns:
- `discussion.started` carries `discussionId`, the question, the answerer and critic, and `maxRounds`.
- `discussion.finished` carries:
  - `status`: `agreed`, `disputed`, `interrupted` or `error`;
  - `rounds`: the number of reviews;
  - `answer`, or null;
  - `error`;
  - the summed duration and usage. Screens do not add this usage to their totals, because each turn already reported
    its own.

## Screens

- **Ink and plain:**
  - a line names who answers and who reviews;
  - each turn is printed as it ends, with its step and the verdict, showing its first 8 lines (`--verbose`: all of
    them);
  - then a line with the outcome, and the final answer whole.
  - Ink's footer says what the turn under way does ("reviewing version 1").
- **Sidebar:**
  - While a discussion runs, its turns show whole in one card, the one under way live.
  - Once it is over, the card says how it ended, folds its turns into "N turns ›", and shows the final answer as
    Markdown.
  - The reducer keeps the discussion in `ViewState.discussion` until `discussion.finished`, then adds one `discussion`
    timeline item, which counts its text toward the answers the view keeps. The `discuss` route goes to
    `Chat.submitDiscuss`.

## Testing

- `test/discussion.test.ts`: verdicts.
- `test/prompts.test.ts`: the prompts.
- `test/conversation.test.ts`: the context keeps the final answer only.
- `test/commands.test.ts`, `test/config.test.ts`: parsing and the round limit.
- `test/chat.test.ts`, with the fake agents' `discuss_<step>` roles: agreed, revised then agreed, disputed with a
  final answer, a missing verdict, Esc, and a failed turn.
- `test/plain.test.ts`, `test/ink.test.tsx`, `test/format.test.ts`: the terminal.
- `test/vscode-view-state.test.ts`, `test/vscode-protocol.test.ts`, `test/vscode-worker.test.ts`: the sidebar's
  reducer, the route, and a discussion through a real worker.
