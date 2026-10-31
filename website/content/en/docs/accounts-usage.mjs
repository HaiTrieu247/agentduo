export default ({ c, kbd, link, p, ul, table, note, h3 }) => ({
  title: "Accounts and usage",
  description: "How AgentDuo shows which accounts Claude Code and Codex use and how much of each plan’s limits is used: /usage, the Account & Usage views, and where the numbers come from.",
  lead: p("AgentDuo uses your own Claude Code and Codex sign-ins. " + c("/usage") + " and the Account & Usage views show each agent’s account and how much of its plan’s limits it has used, read from the CLIs themselves, without a model call."),
  sections: [
    {
      id: "accounts",
      title: "Your accounts, not AgentDuo’s",
      html: `${ul([
  "AgentDuo includes no subscription and no API credit, and holds no credential. Each CLI signs in its own way: " + c("claude") + " then " + c("/login") + ", and " + c("codex login") + ".",
  "Every agent call counts against that CLI’s plan or API key, as if you had run the CLI yourself.",
  "The account and limit lookups ask the CLIs on your machine; AgentDuo sends the numbers nowhere else.",
])}
${p("Signing in and installing the CLIs: " + link("learn/prerequisites", "prerequisites") + ".")}`,
    },
    {
      id: "usage-command",
      title: "/usage",
      html: `${p("In the chat, " + c("/usage") + " opens a panel in place of the input, like Claude Code’s own " + c("/usage") + ":")}
${ul([
  "each agent’s account: its plan and email;",
  "how much of each plan’s limits it has used, with a bar per limit and when it resets;",
  "then Claude’s “What’s contributing to your limits usage?”.",
])}
${p("The panel opens at once and each agent’s part fills in as it answers, in about two seconds (each gets 15 seconds). If one fails, only its part says why. " + kbd("↑") + kbd("↓") + " scroll, " + kbd("r") + " looks again, and " + kbd("Esc") + " closes the panel and nothing else: an answer under way goes on. In VS Code, " + c("/usage") + " or <em>Usage</em> in the tab’s ⋯ menu opens the same panel above the composer.")}`,
    },
    {
      id: "sources",
      title: "Where the numbers come from",
      html: `${table({
  caption: "How each agent is asked",
  head: ["Agent", "Account", "Limits"],
  rows: [
    ["Claude Code", c("claude auth status") + " (JSON): the plan for a claude.ai login, otherwise how it signs in, and the email", c("claude -p /usage") + ", which prints Claude Code’s " + c("/usage") + " without a model call"],
    ["Codex", c("account/read"), c("account/rateLimits/read") + ", both asked of " + c("codex app-server") + " over JSON-RPC on stdio, as Codex’s IDE extension does, with your " + c("-c") + "/" + c("--enable") + "/" + c("--disable") + " overrides"],
  ],
})}
${note(p("Codex’s own " + c("/status") + " exists only in its terminal interface, and " + c('codex exec "/status"') + " would send the words to the model, so AgentDuo asks the app server instead."))}`,
    },
    {
      id: "desktop",
      title: "In the desktop app",
      html: `${h3("sidebar-box", "The sidebar’s Account & Usage box")}
${ul([
  "At the bottom of the sidebar, above Settings: each agent’s email and its limits, a percent and a thin meter each. The plan and when a limit resets are in tooltips.",
  "Click its title to fold it; it stays folded.",
  "It looks the numbers up when the app starts and when you switch project (unless they are a minute old), every 5 minutes while the window shows, after each turn an agent finishes, and on its refresh button. Folded, it looks nothing up.",
])}
${h3("settings-cards", "Settings → Claude & Codex")}
${ul([
  "A card per CLI: the email it signs in with, its plan, path and version, and its limits with a meter each and when they reset.",
  "An API key or a cloud provider shows as <em>API</em> instead of an email.",
  "The limits are looked up when the page opens (unless a minute old), every 5 minutes while it shows, and on <em>Recheck</em>.",
])}
${p("A meter turns amber (the warning colour) from 70% and red (the error colour) from 90%. The VS Code extension’s meters use the same thresholds.")}`,
    },
    {
      id: "vscode",
      title: "In VS Code",
      html: `${p("The AgentDuo view in the Activity Bar has an <strong>Account & Usage</strong> view above the conversations: both accounts (plan and email) and a meter per limit with when it resets.")}
${ul([
  "It looks them up when it shows (again once they are a minute old), on <strong>↻</strong>, every 5 minutes while it shows, and after an answer or a run in any tab, at most once a minute. A collapsed or hidden view looks nothing up.",
  "If one agent cannot say, only its part says why.",
  "<strong>View details</strong> opens the tab’s Usage panel, with Claude’s “What’s contributing to your limits usage?”.",
])}`,
    },
  ],
  related: ["learn/prerequisites", "docs/slash-commands", "docs/data-diagnostics", "learn/vscode"],
});
