export default ({ c, link, code, ex, p, ul, table, note, h3 }) => ({
  title: "Configuration",
  description: "Where AgentDuo's configuration lives, the order in which files override each other, changing settings from the chat or the desktop app, and when a change applies.",
  lead: p("AgentDuo reads YAML files: built-in defaults, your user config for every workspace, and a project config for one workspace. The chat, the desktop app’s Settings and VS Code change the same files, and each change says when it reaches work that is already going."),
  sections: [
    {
      id: "files",
      title: "Where the configuration lives",
      html: `${table({
  caption: "Configuration files",
  head: ["Layer", "Where", "Applies to"],
  rows: [
    ["Built-in defaults", "In AgentDuo itself (" + link("docs/config-reference", "every key and its default") + ")", "Everything"],
    ["User config", c("~/.config/agentduo/config.yaml") + "; " + c("$XDG_CONFIG_HOME/agentduo/config.yaml") + " when that variable is set; " + c("%APPDATA%\\agentduo\\config.yaml") + " on Windows", "Every workspace, and conversations outside a project"],
    ["Project config", c("<workspace>/.agentduo/config.yaml") + ", or the file given with " + c("--config PATH"), "One workspace"],
  ],
})}
${ul([
  `Every key is optional: write only the ones you change. ${c("duo init")} creates ${c(".agentduo/config.yaml")} with everything commented out, and ${c(".agentduo/.gitignore")} so the runs folder stays out of Git.`,
  `${c("--config PATH")} replaces the project file, not the user config: the user config is still read first.`,
  "The terminal, the desktop app and the VS Code extension read the same files, so a setting saved in one applies in the others.",
  `A misspelled or unknown key produces a warning and is ignored. A value of the wrong type is an error that names the file; ${c("duo doctor")} checks the configuration without calling a model.`,
])}`,
    },
    {
      id: "order",
      title: "Which value wins",
      html: `${p("Later layers win over earlier ones:")}
${code("built-in defaults  <  user config  <  project config (or --config)  <  this session", { label: "Override order" })}
${p("“This session” is a change made in the chat without " + c("--save") + " or " + c("--global") + ", or one made in the desktop app with <em>Until app closes</em>. It lasts until the chat or the app closes.")}
${h3("merge-rules", "How layers merge")}
${ul([
  `<strong>Mappings</strong> merge key by key: a project file that sets only ${c("claude.model")} keeps the rest of ${c("claude")} from the user config.`,
  `<strong>${c("role_args")}</strong> merge role by role, so a user-level ${c("implementer")} entry survives a project’s ${c("plan_reviewer")} entry.`,
  `<strong>Lists</strong> (${c("args")}, ${c("gates")}, ${c("blocking_severities")}) replace the earlier value. ${c("claude.args: [--strict-mcp-config]")} drops the default ${c("--no-session-persistence")} unless you list it too.`,
  `A key with no body (${c("codex:")} or ${c("gates:")} alone) keeps the earlier value.`,
  `${c("null")} is a value of its own: ${c("model: null")} in a project file means “the CLI decides” and hides a model set in the user config. To inherit, leave the key out.`,
])}
${code(`# ~/.config/agentduo/config.yaml
claude:
  role_args:
    implementer: [--permission-mode, acceptEdits]

# .agentduo/config.yaml
claude:
  model: opus
  role_args:
    plan_reviewer: [--permission-mode, plan]

# in effect: model opus, and both role_args entries`, { lang: "yaml", label: "Two layers" })}`,
    },
    {
      id: "chat-settings",
      title: "Changing settings from the chat",
      html: `${p("The chat has the settings commands of Claude Code and Codex. Each one changes flags in " + c("claude") + " or " + c("codex") + " and nothing else. " + c("/settings claude …") + " and " + c("/settings codex …") + " are the canonical forms; " + c("/claude …") + " and " + c("/codex …") + " are shortcuts, taken as a setting only when the words fit one exactly (otherwise they are a question for that agent).")}
${table({
  caption: "Chat settings commands",
  head: ["Command", "What it changes in the config"],
  rows: [
    ["Shift+Tab, " + c("/mode manual|acceptEdits|auto"), c("--permission-mode") + " in " + c("claude.role_args.implementer") + " (Claude in the chat and as the pipeline’s implementer)"],
    [c("/claude model <name|default>"), c("claude.model")],
    [c("/claude effort low|medium|high|xhigh|max|default"), c("--effort") + " in " + c("claude.args")],
    [c("/claude permissions [allow|deny|remove <rule>]"), c("--allowedTools") + " / " + c("--disallowedTools") + " in " + c("claude.args")],
    [c("/claude add-dir <path>"), c("--add-dir") + " in " + c("claude.args")],
    [c("/codex model <name|default> [effort]"), c("codex.model") + ", and " + c("-c model_reasoning_effort=…") + " in " + c("codex.args")],
    [c("/codex permissions read-only|auto|full-access|default"), c("--sandbox") + " in " + c("codex.args") + "; " + c("full-access") + " needs " + c("--yes")],
    [c("/config"), "Shows what both agents run with now, and which files " + c("--save") + " and " + c("--global") + " write"],
  ],
})}
${h3("save-global", "--save and --global")}
${ul([
  `Without a flag, a change lasts for this chat only.`,
  `${c("--save")} writes it to the project config (${c(".agentduo/config.yaml")}, or the ${c("--config")} file).`,
  `${c("--global")} writes it to the user config, for every workspace. It saves the change as made to that file alone, so nothing of this workspace’s config goes along.`,
  `If the project config sets the same key, the project still wins there: the chat says so. ${c("--save --global")} writes both files.`,
  "Writing a file keeps its comments and every other key as they were.",
])}
${code("/claude model opus --save\n/codex model gpt-5.5 high --global\n/mode acceptEdits --save --global", { label: "duo" })}
${p("Every command and its options: " + link("docs/slash-commands", "Slash commands") + ".")}`,
    },
    {
      id: "when-it-applies",
      title: "When a change applies",
      html: `${p("Each setting is either <em>next call</em> or <em>next run</em>. The difference matters only for work that is already going: a pipeline run, a discussion, or a run you resume.")}
${table({
  caption: "When settings apply",
  head: ["Kind", "Settings", "Reaches"],
  rows: [
    ["Next call", "model, effort, permission mode, allow and deny rules, " + c("add_dirs") + " (" + c("--add-dir") + "), " + c("args") + ", " + c("role_args") + ", " + c("bin") + ", " + c("max_budget_usd") + ", " + c("permission_prompts"), "The agent’s next call, including the next step of a run that is going; the run’s saved " + c("config.json") + " is updated, so a resume keeps it"],
    ["Next run", c("agents.*") + " (who plays which role) and every " + c("limits.*"), "Only work started after the change: the next run, question or discussion. A run that is going, a discussion under way and a resumed run keep the values they started with"],
  ],
})}
${p("A run never changes agents or limits halfway. When the chat resumes a stopped run, it starts from the run’s own " + c("config.json") + " and replays the chat’s next-call changes on top; next-run changes are never replayed onto it.")}
${h3("resume-config", "Config files and duo resume")}
${p(c("duo resume") + " in the terminal continues a run with the config it started with, so an edit to " + c("config.yaml") + " has no effect on it. Pass " + c("--reload-config") + " to use the current files instead. Changes to Claude Code’s or Codex’s own settings apply either way. More in " + link("docs/decisions-resume", "Decisions and resume") + ".")}`,
    },
    {
      id: "desktop-settings",
      title: "Settings in the desktop app",
      html: `${p("Open Settings with the gear at the bottom of the sidebar. <em>Configuration</em> edits the same keys as the files, with a tab for each group:")}
${table({
  caption: "Configuration tabs",
  head: ["Tab", "Keys", "Applies"],
  rows: [
    ["Claude Code", c("claude.model") + ", " + c("claude.permission_prompts") + ", " + c("claude.max_budget_usd") + ", " + c("claude.args") + "; under <em>Advanced</em>, " + c("claude.bin") + " and each role’s " + c("role_args"), "Next call"],
    ["Codex", c("codex.model") + ", " + c("codex.args") + "; under <em>Advanced</em>, " + c("codex.bin") + " and each role’s " + c("role_args"), "Next call"],
    ["Workflow roles", c("agents.*"), "Next run"],
    ["Rounds & limits", "Every " + c("limits.*") + ", grouped as Rounds, Time and Size", "Next run"],
  ],
})}
${p("At the top, <em>Apply changes to</em> picks where a change is saved. It saves at once.")}
${table({
  caption: "Settings scopes",
  head: ["Scope", "Writes", "Reaches"],
  rows: [
    ["All projects", "The user config", "Every project, and conversations outside one; a project that sets its own value still wins there"],
    ["This project", "The project’s " + c(".agentduo/config.yaml"), "That project only"],
    ["Until app closes", "No file", "Only this project’s open conversations, until the app closes (it needs a conversation open)"],
  ],
})}
${ul([
  "Each value shows where it comes from (the default, all projects, this project, until the app closes), and warns when the project overrides your user config.",
  `<em>Reset</em> removes the key from that file, so it inherits again. It never writes ${c("null")}, which would mean the built-in default and hide the user config.`,
  "A change that would make the configuration invalid is not written. A file that is not valid YAML is left alone: Settings shows the error and its line, and opens the file for you.",
  `Options added from a menu (reasoning effort, permission mode or sandbox, allowed and denied tools, extra folders…) are written as flags into ${c("args")}; <em>Other flag…</em> takes any other one.`,
  `${c("paths.runs_dir")} is shown under <em>Data &amp; storage</em> but not edited there: the workspace lock lives in it. Change it in the file with every AgentDuo closed.`,
  "A change made in Settings, or saved from a chat, reaches the other projects’ open chats too.",
])}`,
    },
    {
      id: "vscode",
      title: "VS Code",
      html: `${ul([
  `The chat’s <em>Settings</em> panel changes what the chat’s settings commands change. Two boxes below it save the changes to ${c(".agentduo/config.yaml")} or to the user config, as ${c("--save")} and ${c("--global")} do.`,
  `<em>agentduo: Open Configuration</em> opens ${c(".agentduo/config.yaml")}.`,
  `VS Code has one setting of its own, ${c("agentduo.nodePath")}: the Node (22.12 or later) that runs AgentDuo’s engine. Agents, models and permissions are in the config files.`,
])}`,
    },
    {
      id: "examples",
      title: "Examples",
      html: `${p("Models and effort for AgentDuo’s calls only; your own Claude Code and Codex settings are unchanged:")}
${ex("config/models.yaml", { label: ".agentduo/config.yaml" })}
${p("Runs nobody watches, where Claude cannot ask:")}
${ex("config/unattended.yaml", { label: ".agentduo/config.yaml" })}
${note(p("AgentDuo adds no permission rules of its own. What each agent may do comes from its CLI’s configuration and the flags you pass: " + link("docs/permissions", "Permissions") + "."))}`,
    },
  ],
  related: ["docs/config-reference", "docs/slash-commands", "docs/permissions", "docs/decisions-resume"],
  next: p(link("docs/config-reference", "Every configuration key, with its type and default →")),
});
