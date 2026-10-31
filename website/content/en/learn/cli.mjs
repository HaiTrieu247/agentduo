export default ({ c, kbd, link, code, p, ul, table, note }) => ({
  title: "Get started in the terminal",
  description: "Install the duo command from npm, set up a workspace with duo init and duo doctor, chat with both agents, run a pipeline, and use duo in scripts and CI.",
  lead: p(`The ${c("agentduo")} npm package installs ${c("duo")}: the chat in your terminal with a live view of both agents, and commands that run the pipeline unattended. ${c("agentduo")} is the same command, for when another tool already owns the name ${c("duo")}.`),
  sections: [
    {
      id: "install",
      title: "Install",
      html: `${p("You need Node.js 22.12 or later, Git, and both CLIs signed in (" + link("learn/prerequisites", "What you need") + ").")}
${code("npm i -g agentduo\nduo --version", { lang: "sh", label: "Terminal" })}`,
    },
    {
      id: "workspace",
      title: "Set up a workspace",
      html: `${p("The workspace is the folder you run " + c("duo") + " in (or the one given with " + c("--dir") + "). It can be a subfolder of a repository: then only that folder’s changes go to the reviewer.")}
${code("cd my-project\nduo init\nduo doctor", { lang: "sh", label: "Terminal" })}
${ul([
  `${c("duo init")} creates ${c(".agentduo/config.yaml")}, where every setting is commented out, with the gates it detected (for example ${c("npm run test")} from ${c("package.json")}) as suggestions. It also creates ${c(".agentduo/.gitignore")}, which keeps run data out of Git, and offers ${c("git init")} when the folder is not a repository yet.`,
  `${c("duo doctor")} checks Node, Git, the configuration and both CLIs, and calls no model. It ends with ${c("doctor: ready")} or ${c("doctor: problems found")}.`,
])}`,
    },
    {
      id: "chat",
      title: "Chat with both agents",
      html: `${p("Run " + c("duo") + " without a task to open the chat. The line under the input says who your message goes to: Codex in a new chat, then whoever you picked last.")}
${code(`duo
› What does src/auth do, in two sentences?
› /claude Would you split it differently?
› /discuss Is the token check safe against replay?`, { label: "duo" })}
${ul([
  `${c("/claude <question>")} and ${c("/codex <question>")} ask one agent; ${c("/claude")} or ${c("/codex")} alone switches who your next messages go to. Both agents see the whole conversation.`,
  `${c("/discuss <question>")} has both agents work out one answer, and Codex sums it up. ${link("docs/discuss", "Discussions")}.`,
  `Typing ${c("/")} opens the list of commands, filtered as you type. ${c("/help")} lists them too.`,
  `${kbd("Esc")} stops what is running. ${c("/quit")} (or ${kbd("Ctrl")}+${kbd("C")} twice) leaves; a running pipeline stops at its step and stays resumable.`,
])}`,
    },
    {
      id: "pipeline",
      title: "Run the pipeline",
      html: `${p("Inside a Git repository, hand a task to the full workflow:")}
${code("/pipeline Add a --json flag to the export command, with tests", { label: "duo" })}
${p("The live view shows each step, the agent working on it and what the agents hand each other. While it runs, a message you type becomes a note for the next step. When it ends, review the changes with " + c("git diff") + " and commit them yourself.")}
${p(link("learn/first-task", "Your first task") + " walks through a complete run; " + link("docs/pipeline", "The pipeline") + " explains every step.")}`,
    },
    {
      id: "scripts",
      title: "In scripts and CI",
      html: `${p("Give " + c("duo") + " a task to run the pipeline once and exit. Without a terminal (in CI, in the background, with output piped) it prints plain timestamped lines.")}
${code(`duo --accept-edits "Fix the failing date test"
echo "exit code: $?"`, { lang: "sh", label: "Terminal" })}
${table({
  caption: "What the exit code means",
  head: ["Exit code", "Meaning"],
  rows: [
    ["0", "The run is done."],
    ["2", "The run waits for your decision. Answer it with " + c('duo resume --decision resume|revise|abort [--note "..."]') + "."],
    ["1, 3, 130", "A configuration or environment error, an aborted run, or a stopped run that can be resumed. " + link("docs/cli#exit-codes", "Exit codes") + "."],
  ],
})}
${note(p(`Nobody can answer a permission prompt in CI, so Claude denies the tool calls its settings do not allow. Allow what the implementer needs in advance: ${link("docs/permissions#unattended", "unattended runs")}.`))}`,
    },
  ],
  related: ["docs/cli", "docs/slash-commands", "docs/configuration", "troubleshooting"],
  next: p(link("learn/first-task", "Run your first task") + " with a test gate, from start to finish."),
});
