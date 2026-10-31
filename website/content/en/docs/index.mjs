import { SECTIONS } from "../../navigation.mjs";

const BLURBS = {
  "docs/concepts": "Agents, roles, workspace, conversations and runs: the model behind every interface.",
  "docs/conversations": "The three-way chat: recipients, models, notes, history, and continuing a conversation.",
  "docs/discuss": "How /discuss has one agent answer, the other review, and Codex write the final answer.",
  "docs/pipeline": "Every step of /pipeline, the roles, critique and review rounds, gates and warnings.",
  "docs/decisions-resume": "When a run stops to ask you, what each answer does, and how Stop, Esc and resume work.",
  "docs/attachments": "Files and images in messages: formats, limits, where the copies go, what each agent receives.",
  "docs/configuration": "Global, project and session settings, how they override each other, reset, and when a change applies.",
  "docs/permissions": "What each agent may do comes from its own CLI; what AgentDuo passes, relays and warns about.",
  "docs/accounts-usage": "Each agent’s account and plan limits in the chat, the desktop app and VS Code.",
  "docs/desktop-updates": "How the desktop app checks GitHub Releases, and what each kind of package can install.",
  "docs/data-diagnostics": "Run files, logs, conversation history, the desktop app’s data, and exporting diagnostics.",
  "docs/cli": "Every duo command and option, plain output, and exit codes.",
  "docs/slash-commands": "Every command of the chat, its settings commands and the keys that control it.",
  "docs/config-reference": "Every key of config.yaml with its type, default and meaning.",
  troubleshooting: "Missing CLIs, sign-in, PATH from a launcher, denied tools, config errors, Git, Windows paths, signing and updates.",
  "docs/contributing": "Build from source, run the tests, send a change, and report a problem.",
};

export default ({ link, p }, d) => ({
  title: "Documentation",
  description: "The AgentDuo documentation: concepts, conversations, discussions, the pipeline, configuration, permissions, data, desktop updates and the command reference.",
  lead: p("Everything AgentDuo does, by topic. It applies to the desktop app, the " + "<code>duo</code>" + " command and the VS Code extension alike, unless a section says otherwise. New here? Start with " + link("learn", "Learn") + "."),
  sections: SECTIONS.docs.filter((g) => g.key !== "overview" || true).map((g) => ({
    id: `group-${g.key}`,
    title: { overview: "Overview", using: "Using AgentDuo", configure: "Configure", reference: "Reference", help: "Help" }[g.key],
    html: `<dl class="defs">${g.pages.filter((id) => id !== "docs").map((id) => `<dt>${link(id, d.titles?.[id] ?? id)}</dt><dd>${BLURBS[id]}</dd>`).join("")}</dl>`,
  })),
  related: ["learn", "faq", "troubleshooting"],
});
