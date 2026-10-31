export default ({ c, link, code, ex, p, ul, table, note, h3 }) => ({
  title: "Permissions and scope",
  description: "What AgentDuo lets agents do: nothing beyond what Claude Code and Codex already allow. Protocol flags, permission prompts, Always allow, warnings and unattended runs.",
  lead: p("AgentDuo enforces nothing. What each agent may do comes from that CLI’s own configuration: Claude Code’s settings and permission mode, Codex’s sandbox and approvals. AgentDuo passes the flags its protocol needs, relays Claude’s permission prompts when someone can answer, and reports what the agents did."),
  sections: [
    {
      id: "model",
      title: "Who decides what",
      html: `${p("AgentDuo passes only the flags its protocol needs: streaming JSON, the output schema, and the prompt on stdin. None of them grants a permission. Everything else comes from you:")}
${ul([
  `<strong>Claude Code</strong>: your settings (${c("~/.claude/settings.json")}, ${c(".claude/settings.json")}, ${c(".claude/settings.local.json")}). In non-interactive mode Claude can only use a tool your settings allow, or one you allow when it asks.`,
  `<strong>Codex</strong>: ${c("~/.codex/config.toml")}, for example ${c("sandbox_mode")}. ${c("codex exec")} is read-only unless configured otherwise.`,
  `<strong>Your flags for AgentDuo’s calls only</strong>: ${c("args")} for every call of an agent, ${c("role_args")} per role, in ${c(".agentduo/config.yaml")}. They reach the CLI as written; your own Claude Code and Codex settings stay unchanged.`,
  `<strong>Your repository’s instructions</strong>: ${c("AGENTS.md")} and ${c("CLAUDE.md")}, which the CLIs read themselves.`,
])}
${code(`claude:
  role_args:
    implementer: [--permission-mode, acceptEdits]
codex:
  role_args:
    code_reviewer: [--sandbox, read-only]`, { lang: "yaml", label: ".agentduo/config.yaml" })}
${note(p("A Codex implementer needs write access: " + c('sandbox_mode = "workspace-write"') + " in Codex’s config, or " + c("codex.role_args.implementer: [--sandbox, workspace-write]") + "."))}`,
    },
    {
      id: "prompts",
      title: "Claude’s permission prompts",
      html: `${p("When Claude wants a tool its settings do not allow, the run pauses and AgentDuo shows Claude’s own prompt, in the terminal, the desktop app or VS Code:")}
${code(`⚠ Claude (implementer) asks to use Bash
  Bash  npm test
❯ Allow once
  Always allow Bash(npm test:*)  saved by Claude to .claude/settings.local.json
  Deny
  Deny with a message…`, { label: "duo" })}
${ul([
  `<strong>Always allow</strong> hands Claude back the rule it suggested, and Claude saves it in ${c(".claude/settings.local.json")}, as it does when you answer its prompt directly. That file is never part of a snapshot or of the diff the reviewer sees.`,
  "<strong>Deny with a message</strong> tells Claude what to do instead.",
  "The agent’s timeouts stop while the prompt waits for you.",
])}
${h3("host-mode", "When AgentDuo relays prompts")}
${p("Claude runs in host mode (" + c("--permission-prompts host --permission-prompt-tool stdio") + ") only when someone can answer: a chat, a run in the desktop app or VS Code, a run in a terminal. Where nobody can (CI, the background, output piped elsewhere) every call gets " + c("--permission-prompts none") + ", and Claude denies such tool calls itself instead of waiting forever. " + c("claude.permission_prompts: deny") + " does that everywhere; the default is " + c("ask") + ".")}`,
    },
    {
      id: "chat-settings",
      title: "Changing permissions from the chat",
      html: `${table({
  caption: "Permission commands in the chat",
  head: ["Command", "What it changes"],
  rows: [
    [c("/mode manual|acceptEdits|auto") + ", Shift+Tab", "Claude’s permission mode, in the chat and as the pipeline’s implementer; the plan critic is not affected"],
    [c("/claude permissions [allow|deny|remove <rule>]"), "Claude’s tool rules for AgentDuo’s calls, e.g. " + c("Bash(npm test:*)")],
    [c("/claude add-dir <path>"), "another directory Claude may work in"],
    [c("/codex permissions read-only|auto|full-access|default"), "Codex’s sandbox; " + c("full-access") + " asks you to confirm with " + c("--yes")],
  ],
})}
${p("They change only flags, and apply from the agent’s next call. Outside the chat, " + c('duo --accept-edits "<task>"') + " does what " + c("/mode acceptEdits") + " does. All commands: " + link("docs/slash-commands", "slash commands") + ".")}`,
    },
    {
      id: "warnings",
      title: "What AgentDuo reports",
      html: `${p("AgentDuo does not block what an agent does; it warns, on screen and in the run’s " + c("report.md") + ":")}
${ul([
  `tool calls Claude was denied: each shows as ${c("⊘ denied")}, then a warning names the tools;`,
  "files changed by a planning or reviewing agent;",
  `files changed outside the workspace (elsewhere in the same repository), with paths relative to the workspace, such as ${c("../shared/x.ts")}.`,
])}
${p("Nothing is ever committed or pushed: review the changes with " + c("git diff") + " and commit them yourself.")}`,
    },
    {
      id: "unattended",
      title: "Unattended runs",
      html: `${p("A run nobody watches (CI, a background job) cannot answer a prompt, so whatever the implementer needs must be allowed before it starts. Without that, its tool calls are denied and the warning names them.")}
${ul([
  `<strong>Edits</strong> (${c("Edit")}, ${c("Write")}): ${c('"permissions": { "defaultMode": "acceptEdits" }')} in your Claude Code settings, or ${c("--permission-mode acceptEdits")} in the implementer’s ${c("role_args")}. It allows edits, not commands.`,
  `<strong>Commands</strong> (${c("Bash")}): allow rules such as ${c('"Bash(npm test:*)"')}. Without gates the implementer runs the project’s checks itself, so allow those commands.`,
  `<strong>Codex as implementer</strong>: a sandbox that can write, as above.`,
  `<strong>Never ask</strong>: ${c("claude.permission_prompts: deny")} makes Claude deny anything its settings do not allow, even with someone watching.`,
])}
${ex("config/unattended.yaml", { label: ".agentduo/config.yaml" })}
${p("Gates run your checks whatever the agents may do: " + link("docs/pipeline", "the pipeline") + ".")}`,
    },
  ],
  related: ["docs/pipeline", "docs/slash-commands", "docs/configuration", "docs/data-diagnostics"],
});
