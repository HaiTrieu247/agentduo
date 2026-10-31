export default ({ c, kbd, link, code, p, ul, table, note, h3 }) => ({
  title: "Slash commands",
  description: "Every command the AgentDuo chat accepts, from /claude, /codex, /pipeline and /discuss to /resume, /attach, /usage, /mode and /settings, with their flags and keys.",
  lead: p("A line that starts with " + c("/") + " is a command; any other line is a message for the agent named below the input, or a note for a running pipeline. The terminal chat, the desktop app and VS Code read commands the same way."),
  sections: [
    {
      id: "typing",
      title: "Messages and commands",
      html: `${ul([
  "A plain message goes to the current recipient: Codex when a conversation starts, until " + c("/claude") + " or " + c("/codex") + " switches it.",
  "While a pipeline runs, a plain message is a note for it: the agents get it from the next step. See " + link("docs/conversations#notes", "Notes") + ".",
  "Typing " + c("/") + " lists the commands, and the words each one takes as you go on.",
  "A command the chat does not know is not sent anywhere: it answers " + c("unknown command … — /help lists the commands") + ".",
])}`,
    },
    {
      id: "agents",
      title: "Asking an agent",
      html: `${table({
  caption: "Commands that ask an agent",
  head: ["Command", "Effect"],
  rows: [
    [c("/claude <question>"), "Asks Claude Code, whoever the recipient is."],
    [c("/codex <question>"), "Asks Codex, whoever the recipient is."],
    [c("/claude") + ", " + c("/codex"), "Alone: your next messages go to that agent."],
    [c("/claude -- <question>"), "Always a question, even when it starts with a setting’s name (" + c("/claude -- model of the cache?") + ")."],
  ],
})}
${p("Words after " + c("/claude") + " or " + c("/codex") + " are a setting only when they have exactly a setting’s shape (" + link("docs/slash-commands#settings", "below") + "); anything else is a question. When the words start like a setting but do not fit it, they go as a question and the chat says how to set it instead.")}`,
    },
    {
      id: "work",
      title: "Handing work to both agents",
      html: `${table({
  caption: "Commands that start work",
  head: ["Command", "Effect"],
  rows: [
    [c("/pipeline <task>"), "Runs the full workflow: plan → critique → finalize → implement → verify → review. Needs a Git repository. " + link("docs/pipeline", "The pipeline") + "."],
    [c("/discuss <question>"), "The recipient answers, the other agent reviews, they revise until they agree, then Codex sums it up. Works in any folder. " + link("docs/discuss", "Discussions") + "."],
  ],
})}
${p("Without words both print their usage. Files waiting to be sent go with the task or the question.")}`,
    },
    {
      id: "runs",
      title: "Runs",
      html: `${table({
  caption: "Commands about the current run",
  head: ["Command", "Effect"],
  rows: [
    [c("/resume"), "Continues the run stopped with " + kbd("Esc") + ", or else the workspace’s latest run, unless it has ended (" + c("DONE") + " or " + c("ABORTED") + ")."],
    [c("/resume <note>"), "The same, with a note for the agents (and the waiting files)."],
    [c("/resume <run id>"), "Continues that run of this workspace."],
    [c("/plan"), "Shows the final plan of the current run (or its latest plan)."],
    [c("/diff"), "Shows the diff stat of what the current run changed."],
    [c("/status"), "Shows the run’s phase, its planning and implementation rounds, and its cost and tokens; also who is answering or discussing now."],
  ],
})}
${p("The current run is the one going, else the one stopped, else the last one of this chat. " + c("/resume") + " needs a Git repository; see " + link("docs/decisions-resume", "Decisions and resume") + " for what it does at each kind of stop.")}`,
    },
    {
      id: "files",
      title: "Files",
      html: `${table({
  caption: "Commands for attached files",
  head: ["Command", "Effect"],
  rows: [
    [c("/attach <path>"), "Attaches a copy of a file (image, PDF, text, code…) to your next message. One file at a time; quote a path with spaces or escape them. " + c("~/") + " is your home folder."],
    [c("/attachments"), "Lists the files waiting to go with your next message, numbered."],
    [c("/detach <n>") + ", " + c("/detach all"), "Removes one waiting file (by its number) or all of them."],
  ],
})}
${code('/attach screenshots/bug.png\n/attach "~/Desktop/My notes.pdf"\n/detach 1', { label: "Chat" })}
${p("More in " + link("docs/attachments", "Attachments") + ".")}`,
    },
    {
      id: "settings",
      title: "Settings: /mode, /claude, /codex and /settings",
      html: `${p("These commands mirror the CLIs’ own " + c("/model") + ", " + c("/effort") + ", " + c("/permissions") + " and " + c("/add-dir") + ", and change only the flags AgentDuo passes. Without a value, each one shows the current setting.")}
${table({
  caption: "Setting commands",
  head: ["Command", "Effect"],
  rows: [
    [c("/mode manual|acceptEdits|auto"), "Claude’s permission mode, in the chat and as the pipeline’s implementer: Manual (asks before each edit), Edit automatically, or Auto. " + kbd("Shift") + "+" + kbd("Tab") + " cycles through them."],
    [c("/claude model <name|default>"), "Claude’s model or alias (" + c("opus") + ", " + c("sonnet") + ", " + c("haiku") + ", a full name)."],
    [c("/claude effort low|medium|high|xhigh|max|default"), "Claude’s effort level."],
    [c("/claude permissions allow|deny <rule>"), "A tool rule for AgentDuo’s calls, on top of Claude Code’s own settings, e.g. " + c("Bash(npm test:*)") + "."],
    [c("/claude permissions remove <rule>"), "Drops an allow or deny rule. Alone, " + c("/claude permissions") + " lists the rules."],
    [c("/claude add-dir <path>"), "Another directory Claude may work in."],
    [c("/codex model <name|default> [effort]"), "Codex’s model, and optionally its reasoning effort: " + c("minimal") + ", " + c("low") + ", " + c("medium") + ", " + c("high") + ", " + c("xhigh") + ", " + c("max") + "."],
    [c("/codex permissions read-only|auto|full-access|default"), "What Codex may do: read only, change files in the workspace, or change any file and use the network. " + c("full-access") + " needs " + c("--yes") + "."],
    [c("/settings claude|codex <setting> …"), "The canonical form of the same settings: a mistake gets the usage instead of becoming a question. " + c("/settings mode …") + " is " + c("/mode") + "."],
    [c("/settings") + ", " + c("/config"), "Shows the settings both agents run with now, and their models."],
  ],
})}
${h3("scope", "This chat, this workspace, or every workspace")}
${table({
  caption: "Where a setting is kept",
  head: ["Flag", "Kept"],
  rows: [
    ["(none)", "In this chat only, until it ends."],
    [c("--save"), "Also written to the workspace’s " + c(".agentduo/config.yaml") + "."],
    [c("--global"), "Also written to your user config (" + c("~/.config/agentduo/config.yaml") + ", or " + c("%APPDATA%\\agentduo\\config.yaml") + " on Windows), for every workspace. If the workspace’s config sets the same key, the chat says that it wins there."],
    [c("--yes"), "Confirms " + c("/codex permissions full-access") + "."],
  ],
})}
${code("/claude model opus --save\n/codex permissions auto --global\n/mode acceptEdits\n/claude permissions allow Bash(npm test:*)", { label: "Chat" })}
${h3("reset", "Going back to the default")}
${p(c("default") + " as a model, an effort or Codex’s permissions leaves the choice to the CLI’s own configuration: AgentDuo passes no flag. " + c("/mode manual") + " is Claude’s default mode, and " + c("/claude permissions remove <rule>") + " drops a rule.")}
${h3("when", "When a change applies")}
${p("A change from these commands reaches the run or discussion going now from its next agent call, and its saved config, so a later resume keeps it. Questions take it from the next question.")}
${note(p("Settings that only start with new work (the " + c("agents") + " roles and every " + c("limits") + " key) are not chat commands; they are in the config files: " + link("docs/config-reference", "Configuration reference") + "."))}`,
    },
    {
      id: "session",
      title: "The chat itself",
      html: `${table({
  caption: "Commands about the chat",
  head: ["Command", "Effect"],
  rows: [
    [c("/usage"), "How much of their plans’ limits Claude Code and Codex have used, without calling a model. " + link("docs/accounts-usage", "Accounts and usage") + "."],
    [c("/new"), "A new conversation: the agents no longer see what was said before. A stopped run stays resumable. In VS Code it opens in a tab of its own."],
    [c("/help"), "Lists the commands, the settings and the keys."],
    [c("/quit") + ", " + c("/exit"), "Leaves; a running pipeline stops at its step and stays resumable."],
  ],
})}`,
    },
    {
      id: "keys",
      title: "Keys",
      html: `${table({
  caption: "Keys in the chat",
  head: ["Key", "Effect"],
  rows: [
    [kbd("Enter"), "Sends the line. With files waiting and no words, the files go on their own."],
    [kbd("Esc"), "Stops what is running: an answer or a discussion ends there; a pipeline’s current step stops and " + c("/resume") + " continues it."],
    [kbd("Shift") + "+" + kbd("Tab"), "Switches Claude’s mode: Manual, Edit automatically, Auto (as in Claude Code)."],
    [kbd("Ctrl") + "+" + kbd("C") + " twice", "Leaves the terminal chat."],
  ],
})}
${p("In the desktop app and VS Code the recipient menu also offers " + c("Discuss") + " and " + c("Pipeline") + ": the text you send is then the question or the task. A typed command still goes as typed.")}`,
    },
  ],
  related: ["docs/conversations", "docs/cli", "docs/permissions", "docs/config-reference"],
});
