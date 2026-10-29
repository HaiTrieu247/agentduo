# /discuss: both agents agree on an answer

Amends `2026-10-27-agentduo-channel-design.md`. The chat had three ways to ask: a question for one agent (`/codex`,
`/claude`, or a plain message) and a task for both (`/pipeline`). `/discuss <question>` adds a fourth: the agents
check each other's answer until they agree, and Codex synthesizes the discussion into the response the user gets.

## Behaviour

- The current recipient answers; the other agent reviews. In the sidebar, the recipient chip's menu has **Discuss**,
  for the next message only (like Pipeline, and off while something runs).
- Both CLIs must be found. While a pipeline runs or an answer is under way, `/discuss` is turned away as any question
  is.
- Flow, with `N = limits.max_discussion_rounds` (default 3, a positive integer):

  ```
  answerer  answer, version 1
  critic    review of version 1  → VERDICT: AGREE  → the reviews are over (agreed)
                                 → VERDICT: REVISE → answerer writes version 2, critic reviews it, …
  after review N still REVISE → the reviews are over (disputed)
  codex     final answer (synthesis), after the r reviews there were
  ```

  A discussion makes 3 to 2N + 1 agent calls: 2r + 1 when the critic agrees at review r, 2N + 1 when it never does.
- The synthesis is a fresh Codex call, whoever answered and reviewed. It gets the question, the conversation as the
  discussion found it, every version and every review with its verdict. It writes one direct answer for the user:
  what holds up from both agents, the review points the last version still misses, without what the discussion showed
  to be wrong, and without naming versions, reviews or who said what. After a disputed discussion it ends with a short
  section on what is still disputed, both positions put neutrally, titled "Còn bất đồng" in Vietnamese (the same in
  the answer's language otherwise). When Codex also answered, the synthesis comes from the same model: the prompt asks
  it to be neutral, nothing more is claimed. The synthesizer is fixed, not a setting.
- Before synthesis existed, a disputed discussion ended with the answerer's own final version (step `final`). New
  discussions never take that step; the step and its labels stay so the discussions saved by then still show.
- A review's verdict is the last line of its own that says `VERDICT: AGREE` or `VERDICT: REVISE` (case and markdown
  emphasis ignored, `core/discussion.ts`). That line is dropped from the review shown. A review with none counts as
  REVISE, and a `warning` event says so.
- The synthesis is the response. It is the only part of the discussion later prompts carry: one exchange from Codex,
  marked `discussedWith` Claude (`Exchange.discussedWith`: the other agent of the discussion). Drafts, reviews and the
  synthesis turn itself stay in the discussion and in the conversation's logs.
- A failed synthesis does not lose the answer the reviews ended on: the latest version is the response, from the
  answerer and `discussedWith` the critic, the status stays `agreed` or `disputed` with no error, and a `warning`
  event says Codex could not synthesize. What the failed call wrote never joins the context.
- Esc stops the call under way, and the discussion ends `interrupted`; also during the synthesis, even one that
  finishes as Esc comes, or between the last review and it (then no synthesis starts). A failed call before the
  synthesis ends it `error`, and no synthesis starts. Either way nothing joins the context, and the turns that
  finished stay visible.
- Agents run as for any chat question: same CLI configuration, no flags or rules added.

## Prompts

Each turn is a conversation turn (`[agentduo-conversation]` first, text mode, no schema). Its second line is
`[agentduo-discussion: <step>, round <n> of <N>]`, with step `answer`, `critique`, `revise` or `synthesis` (whose
round is the number of reviews). Every step is told that Codex synthesizes the response. `prompts.discussion` gives, in order:

1. who is who;
2. the conversation as it stood when the discussion began (the same for every step);
3. the user's question, once;
4. the discussion so far, with each review's verdict;
5. what this step asks.

A review is asked to check the latest version (reading code or running what the answer depends on), to say what is
wrong briefly and concretely without rewriting it, and to end with its verdict line. A revision gives the whole answer
again, addressing the review, and keeps its position with a reason where it disagrees. The synthesis is asked what
the Behaviour section says, as Codex, and told it replaces the last version as the response.

## Events

Every turn is a normal turn: `turn.started` and `turn.finished`, with `discussion: { id, step, round }`. A review's
`turn.finished` also carries `verdict` (null when it had none), and its `answer` comes without the verdict line.

Around the turns:
- `discussion.started` carries `discussionId`, the question, the answerer and critic, and `maxRounds`.
- `discussion.finished` carries:
  - `status`: `agreed`, `disputed`, `interrupted` or `error`;
  - `rounds`: the number of reviews (the synthesis is not one);
  - `answer`, or null;
  - `answerBackend`: who wrote `answer` (Codex for a synthesis, the answerer when the synthesis failed). Events and
    saved views from before synthesis have none: their answer is the answerer's;
  - `error`;
  - the summed duration and usage, the synthesis turn's included. Screens do not add this usage to their totals,
    because each turn already reported its own.

## Screens

- **Ink and plain:**
  - a line names who answers and who reviews;
  - each turn is printed as it ends, with its step and the verdict, showing its first 8 lines (`--verbose`: all of
    them);
  - the synthesis is a turn like the others, "final answer (synthesis)";
  - then a line with the outcome, and the final answer whole, under the name and mark of `answerBackend`.
  - Ink's footer says what the turn under way does ("reviewing version 1", "synthesizing the final answer").
- **Sidebar:**
  - While a discussion runs, its turns show whole in one card, the one under way live.
  - Once it is over, the card says how it ended, folds its turns into "N turns ›", and shows the final answer as
    Markdown, under the name and mark of `answerBackend` (a card saved without one: the answerer's).
  - The reducer keeps the discussion in `ViewState.discussion` until `discussion.finished`, then adds one `discussion`
    timeline item, which counts its text toward the answers the view keeps. The `discuss` route goes to
    `Chat.submitDiscuss`.

## Testing

- `test/discussion.test.ts`: verdicts.
- `test/prompts.test.ts`: the prompts.
- `test/conversation.test.ts`: the synthesis is Codex's turn, and the context keeps the response only, by its author.
- `test/commands.test.ts`, `test/config.test.ts`: parsing and the round limit.
- `test/chat.test.ts`, with the fake agents' `discuss_<step>` roles: agreed, revised then agreed (Claude answering),
  disputed, a missing verdict, a failed synthesis, Esc during a review, during the synthesis, as it finishes and
  before it, and a failed turn; each with its calls in order, and what later prompts and a reopened conversation carry.
- `test/workflow.test.ts`: a pipeline started after a discussion gets the synthesis, not the drafts.
- `test/plain.test.ts`, `test/ink.test.tsx`, `test/format.test.ts`: the terminal, the synthesis turn and the answer's
  author, also for a discussion from before synthesis.
- `test/vscode-view-state.test.ts`, `test/vscode-protocol.test.ts`, `test/vscode-worker.test.ts`: the sidebar's
  reducer, the route, and a discussion through a real worker.
