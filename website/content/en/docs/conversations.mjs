export default ({ c, kbd, link, p, ul, table, note, h3 }) => ({
  title: "Conversations",
  description: "The three-way chat between you, Claude Code and Codex: choosing who answers, models, notes during a run, history, home-folder chats and continuing a conversation.",
  lead: p("A conversation is the chat between you and both agents. Each message goes to one agent, both agents see what was said, and the full pipeline runs only when you ask for it."),
  sections: [
    {
      id: "recipient",
      title: "Who answers",
      html: `${p("A plain message goes to the agent named under the input: Codex in a new conversation, then whoever you picked last.")}
${table({
  caption: "Choosing the recipient",
  head: ["You type or pick", "What happens"],
  rows: [
    [c("/claude <question>"), "Asks Claude Code this once."],
    [c("/codex <question>"), "Asks Codex this once."],
    [c("/claude") + " or " + c("/codex") + " alone", "Your next messages go to that agent."],
    [c("/claude -- <question>"), "Always a question, even when it starts like a setting (see below)."],
    ["The recipient menu (desktop, VS Code)", "Codex, Claude, <em>Discuss</em> or <em>Pipeline</em> for the next message. A typed command wins over the menu."],
  ],
})}
${p("Each answer is shown whole, once, with the provider’s mark (Anthropic or OpenAI) and the model it ran on.")}
${note(p(c("/claude model opus") + " changes Claude’s model, because the words fit that setting exactly. " + c("/claude model which is best for this repo?") + " does not fit, so it goes to Claude as a question, word for word. " + link("docs/slash-commands#settings", "Settings commands") + "."))}`,
    },
    {
      id: "context",
      title: "What each agent sees",
      html: `${ul([
  `Both agents get the whole conversation, up to 120,000 characters of it. Older exchanges are dropped whole, and the chat says so.`,
  `${c("/pipeline <task>")} gives every role of the run what was said before the task, and what the conversation’s earlier pipeline tasks did.`,
  `A workspace runs one pipeline at a time. In VS Code, conversation tabs answer side by side; a second ${c("/pipeline")} says which conversation’s run is going.`,
])}`,
    },
    {
      id: "models",
      title: "Models",
      html: `${p("The input shows both agents’ models. Before the first answer AgentDuo looks them up without a model call: Codex’s with " + c("codex doctor --json") + " (with your " + c("-c") + ", " + c("--enable") + " and " + c("--disable") + " overrides), Claude’s from " + c("--model") + ", " + c("ANTHROPIC_MODEL") + " and Claude Code’s settings files.")}
${ul([
  `A Claude settings alias shows as ${c("default → sonnet (configured alias)")} until Claude’s first answer names the exact model.`,
  `With a Codex ${c("--profile")}, the model shows as unresolved, with the reason: ${c("codex doctor")} does not take a profile.`,
  `Each question and run looks again, so an edited ${c("~/.codex/config.toml")} or Claude settings file shows from the next one.`,
  `Change a model for AgentDuo only with ${c("/claude model <name>")} or ${c("/codex model <name> [effort]")}. ${link("docs/configuration", "Configuration")}.`,
])}`,
    },
    {
      id: "notes",
      title: "Messages while a pipeline runs",
      html: `${p("While a pipeline step runs, what you type is a note: every step from the next one on carries it. " + c("/claude") + ", " + c("/codex") + ", " + c("/pipeline") + " and " + c("/discuss") + " say the workspace is busy instead. Files you attach go with the note.")}`,
    },
    {
      id: "stop",
      title: "Stopping an answer",
      html: `${p(kbd("Esc") + " (or Stop in the desktop app and VS Code) stops what runs. A stopped answer or discussion just ends, and nothing of it joins the conversation. A stopped pipeline step stays resumable: " + link("docs/decisions-resume#stop", "Stop and resume") + ".")}`,
    },
    {
      id: "history",
      title: "History and continuing a conversation",
      html: `${p("Conversations are saved under the runs folder, in " + c(".agentduo/runs/conversations/<id>/") + ": what was said, the attached files, and the logs of each call.")}
${h3("history-desktop", "Desktop app")}
${ul([
  "The sidebar lists each project’s conversations; <em>Conversations</em> at the top holds the chats without a project. Click one to go on with it: its next question carries what was said before.",
  "Conversations come back after a restart with what they showed and their drafts.",
])}
${h3("history-vscode", "VS Code")}
${ul([
  "Each conversation is a tab; VS Code reopens them after a reload or restart. The Conversations view lists the workspace’s conversations, open and closed; open a closed one to go on.",
  "A tab keeps up to 400 entries and about 2,000,000 characters of answers; older turns are dropped whole, with a notice of where the full logs are, and the newest answer always stays.",
])}
${h3("history-terminal", "Terminal")}
${ul([
  `Each ${c("duo")} session starts a new conversation; ${c("/new")} starts another one in the same session. Earlier sessions stay on disk, but the terminal chat does not reopen them.`,
  `What the terminal does continue is a pipeline run: ${c("/resume")} or ${c("duo resume")}, also for a run started from the desktop app or VS Code.`,
])}`,
    },
    {
      id: "home-folder",
      title: "Chats without a project",
      html: `${p("Conversations and " + c("/discuss") + " need no Git repository. With no folder open, the desktop app and the VS Code extension work in your home folder, as " + c("duo") + " does when you start it there, so those conversations and their configuration go to " + c("~/.agentduo") + ". A pipeline needs a project folder inside a Git repository; from the home folder you are asked to open one.")}`,
    },
  ],
  related: ["docs/discuss", "docs/pipeline", "docs/attachments", "docs/slash-commands"],
});
