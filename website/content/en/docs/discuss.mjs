export default ({ c, link, code, p, ul, steps, note }) => ({
  title: "Discussions with /discuss",
  description: "How /discuss works: one agent answers, the other reviews with a verdict, revisions until they agree, and a final answer synthesized by Codex. Limits and cost.",
  lead: p(c("/discuss <question>") + " has both agents work out one answer instead of each giving its own. Use it for a design question, a review of an approach, or anything where a second opinion should shape the answer."),
  sections: [
    {
      id: "how",
      title: "How a discussion runs",
      html: `${steps([
  ["Answer", p("The agent named under the input answers the question.")],
  ["Review", p("The other agent reviews that answer and ends with " + c("VERDICT: AGREE") + " or " + c("VERDICT: REVISE") + ". A review without a verdict counts as REVISE.")],
  ["Revise", p("Until the reviewer agrees, the first agent revises its answer and the other reviews again, for at most " + c("limits.max_discussion_rounds") + " reviews (3 by default).")],
  ["Synthesize", p("Codex, in a call of its own, writes the final answer from the whole discussion: it keeps what held up from both agents, adds the points of the reviews the last version still misses, and leaves out what the discussion showed to be wrong.")],
])}
${code("/discuss Should the cache be invalidated on write or with a TTL here?", { label: "duo" })}`,
    },
    {
      id: "result",
      title: "What you get",
      html: `${ul([
  "Each turn is shown as it ends, with the reviewer’s verdict. In the terminal you see each turn’s first lines (" + c("--verbose") + " shows them whole); in the desktop app and VS Code the turns fold into one row once the discussion is over.",
  "Then the final answer, whole. Only that answer joins the conversation, as Codex’s answer discussed with Claude.",
  "If the last review still asked for changes, the answer ends with a short section on what is still disputed.",
  "If the synthesis fails, a warning says so, and the latest version is the answer, from the agent that wrote it.",
])}
${note(p("Codex always writes the synthesis. When Codex also answered, the synthesis comes from the same model, in a fresh call asked to be neutral."))}`,
    },
    {
      id: "cost",
      title: "Calls and limits",
      html: `${ul([
  `A discussion makes 3 to 2N+1 agent calls, N being ${c("limits.max_discussion_rounds")}: at least an answer, a review and the synthesis.`,
  `${c("limits.max_discussion_rounds")} is read when a discussion starts: changing it while one is under way applies to the next one.`,
  `Attached images are sent again with every call of the discussion. ${link("docs/attachments#cost", "Images and cost")}.`,
  `${c("Esc")} stops a discussion; nothing of it joins the conversation.`,
])}`,
    },
    {
      id: "when",
      title: "When to use it",
      html: `${ul([
  `<strong>${c("/discuss")}</strong> for a question whose answer should be checked: a design choice, a risk assessment, a plan you want to refine before ${c("/pipeline")}.`,
  `<strong>A plain message</strong> for a quick answer from one agent.`,
  `<strong>${c("/pipeline")}</strong> when the answer is a change to the code: the pipeline plans, implements, checks and reviews it.`,
])}`,
    },
  ],
  related: ["docs/conversations", "docs/pipeline", "docs/config-reference#limits"],
});
