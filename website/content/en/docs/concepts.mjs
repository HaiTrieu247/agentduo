import { flowFigure } from "../../../lib/figures.mjs";
import { FLOW } from "../pages/home.mjs";

export default ({ c, link, p, ul, table }) => ({
  title: "How AgentDuo works",
  description: "The ideas behind AgentDuo: two agents run as CLIs, roles, the workspace, conversations and pipeline runs, snapshots, and why AgentDuo enforces nothing itself.",
  lead: p("AgentDuo is a relay. It starts Codex and Claude Code as processes in your workspace, gives each the right prompt for its role, checks what comes back, and passes it on. These are the pieces it works with."),
  sections: [
    {
      id: "agents",
      title: "Two agents, run as CLIs",
      html: `${p("Each agent is the CLI you installed: " + c("codex") + " (run as " + c("codex exec") + ") and " + c("claude") + " (run as " + c("claude -p") + "). AgentDuo does not talk to a model API itself, holds no credentials, and adds nothing to the agents’ own tools.")}
${p("For each call AgentDuo passes only the flags its protocol needs: streaming JSON events, the output schema of the role (" + c("--output-schema") + " for Codex, " + c("--json-schema") + " for Claude), and the prompt on standard input. Your configured " + c("args") + " and " + c("role_args") + " come along. Everything else (model defaults, permissions, sandboxes, MCP servers) is each CLI’s own configuration.")}`,
    },
    {
      id: "roles",
      title: "Roles",
      html: `${table({
        caption: "The four roles of a pipeline run",
        head: ["Role", "Config key", "Default", "Answers with"],
        rows: [
          ["Planner (and plan sign-off)", c("agents.planner"), "Codex", "a plan; later an approval of the final plan"],
          ["Plan critic", c("agents.plan_reviewer"), "Claude Code", "a critique: approved, or issues by severity"],
          ["Implementer", c("agents.implementer"), "Claude Code", "an implementation report: completed or blocked"],
          ["Code reviewer", c("agents.code_reviewer"), "Codex", "a review: approved, or findings by severity"],
        ],
      })}
${p("Each answer is JSON that must match a strict schema (the repository’s " + c("packages/engine/schemas/") + " folder). A call that fails, or whose answer does not match, is tried again with the reason, up to " + c("limits.max_retries") + " more times (1 by default).")}`,
    },
    {
      id: "workspace",
      title: "The workspace",
      html: `${p("The workspace is the folder AgentDuo runs in: the folder you started " + c("duo") + " in (or " + c("--dir") + "), the project you opened in the desktop app, or the VS Code folder. With no folder, the desktop app and the extension use your home folder.")}
${ul([
  "Both agents run there.",
  `${c(".agentduo/")} lives there: the project configuration and, by default, the runs folder.`,
  "Only changes inside it go to the reviewer. A change elsewhere in the same repository produces a warning, with its path relative to the workspace.",
])}`,
    },
    {
      id: "conversation-and-run",
      title: "Conversations and pipeline runs",
      html: `${p("There are two kinds of work, and they are kept apart:")}
${table({
  caption: "Conversation and run compared",
  head: ["", "Conversation", "Pipeline run"],
  rows: [
    ["Started by", "a message, a question to an agent, " + c("/discuss"), c("/pipeline <task>") + " or " + c('duo "<task>"')],
    ["Answers", "plain text, shown whole", "JSON per role, validated"],
    ["Needs Git", "no", "yes: it snapshots and diffs the workspace"],
    ["Saved in", c("<runs>/conversations/<id>/"), c("<runs>/<run-id>/")],
    ["Stopped with Esc", "the answer ends; nothing of it is kept", "the step ends; the run can be resumed"],
  ],
})}
${p("A pipeline run started from a conversation is told what was said before the task, and what the conversation’s earlier pipeline tasks did. " + link("docs/conversations", "Conversations") + " and " + link("docs/pipeline", "The pipeline") + " go into each.")}`,
    },
    {
      id: "flow",
      title: "The pipeline at a glance",
      html: `${flowFigure(FLOW, "concepts-flow")}
${p("A run reaches " + c("DONE") + " when the reviewer approves, no blocking finding is left, and every required gate passes. When a limit is reached, an agent fails or blocks, or a critical finding appears, it stops in " + c("HUMAN_REVIEW") + " and asks you. " + link("docs/decisions-resume", "Decisions, stop and resume") + ".")}`,
    },
    {
      id: "snapshots",
      title: "Snapshots and the diff",
      html: `${p("Before the first implementation round, AgentDuo records the state of the workspace as a Git snapshot, and records another after each round. Snapshots are commit objects kept under " + c("refs/agentduo/<run-id>/") + "; they use a temporary index, so your branch, your index and your staged changes are left alone. The reviewer gets the diff between the baseline and the latest snapshot, up to " + c("limits.max_diff_chars") + " characters. Changes you made before the run are part of the baseline, so they are not in the diff.")}
${p("Run data, attachments and " + c(".claude/settings.local.json") + " are excluded from every snapshot. Nothing is ever committed to your branch or pushed.")}`,
    },
    {
      id: "no-rules",
      title: "AgentDuo enforces nothing",
      html: `${p("AgentDuo has no permission system of its own and blocks nothing. What an agent may do is decided by its CLI’s settings; what it should do, by your prompt and your repository’s " + c("AGENTS.md") + " or " + c("CLAUDE.md") + ".")}
${p("What AgentDuo does is report. Files changed by a planning or reviewing agent, and files changed outside the workspace, produce a " + c("warning") + " on screen and in the run’s report; tool calls Claude was denied are listed. " + link("docs/permissions", "Permissions") + ".")}`,
    },
  ],
  related: ["docs/pipeline", "docs/conversations", "docs/permissions", "about"],
});
