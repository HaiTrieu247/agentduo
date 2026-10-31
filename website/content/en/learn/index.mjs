export default ({ link, p, steps }) => ({
  title: "Learn AgentDuo",
  description: "A step-by-step path for new users: what you need, installing the desktop app, the duo command or the VS Code extension, and a first task from start to finish.",
  lead: p("Five short lessons take you from nothing installed to a finished task reviewed by both agents. Read them in order, or skip to the interface you want."),
  sections: [
    {
      id: "path",
      title: "The path",
      html: steps([
        [link("learn/prerequisites", "What you need"), p("Install Claude Code and Codex, sign in to both, and know when you need Node.js and Git. About ten minutes if neither CLI is installed yet.")],
        ["Pick an interface", p(`${link("learn/desktop", "The desktop app")} if you want a window of its own; ${link("learn/cli", "the terminal")} for ${"<code>duo</code>"} and scripts; ${link("learn/vscode", "VS Code")} for the chat beside your editor. You can use more than one: they share configuration and runs.`)],
        [link("learn/first-task", "Your first task"), p("Create a tiny project with a failing test, configure a test gate, run the pipeline, review the diff, and commit. Every command can be copied.")],
      ]),
    },
    {
      id: "words",
      title: "Four words you will meet",
      html: `<dl class="defs">
<dt>Workspace</dt><dd>The folder AgentDuo works in: where both agents run, where ${"<code>.agentduo/</code>"} lives, and the only place whose changes go to the reviewer.</dd>
<dt>Conversation</dt><dd>The three-way chat between you, Claude Code and Codex. Plain messages go to one agent; both see what was said.</dd>
<dt>Pipeline run</dt><dd>The workflow started with ${"<code>/pipeline</code>"}: plan, critique, finalize, implement, verify, review. It has an id, files of its own and can be resumed.</dd>
<dt>Gate</dt><dd>A command of yours, such as ${"<code>npm test</code>"}, that AgentDuo runs after each implementation round. Its result decides as much as the reviewer does.</dd>
</dl>
${p(link("docs/concepts", "How AgentDuo works") + " explains each of them in more depth.")}`,
    },
  ],
  related: ["docs", "faq", "download"],
});
