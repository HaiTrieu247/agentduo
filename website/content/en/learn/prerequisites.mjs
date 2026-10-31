export default ({ c, link, ext, code, p, ul, table, note }, d) => ({
  title: "What you need",
  description: "Before AgentDuo runs: install Claude Code and Codex CLI, sign in to both, and see when Node.js and Git are needed. AgentDuo includes no subscription or API credit.",
  lead: p("AgentDuo runs two CLIs made by other companies, with your accounts. Install and sign in to both once; every AgentDuo interface then uses them."),
  sections: [
    {
      id: "accounts",
      title: "Your accounts and what they cost",
      html: `${p("AgentDuo is free, but it does not include Claude Code, Codex, a subscription or API credit. Each agent runs with the sign-in its own CLI has: a plan with the provider, or an API key. Every question, discussion and pipeline step uses that plan or key.")}
${ul([
  `A pipeline run makes several agent calls: at least one per step, more with critique and review rounds. ${c("/discuss")} makes 3 to 2N+1 calls, N being the review limit (3 by default).`,
  `Images you attach are sent again with each call of a discussion or a pipeline, which costs tokens each time.`,
  `${link("docs/accounts-usage", "Account &amp; Usage")} shows how much of your plans’ limits is used; ${c("claude.max_budget_usd")} caps the cost of one Claude call.`,
])}`,
    },
    {
      id: "claude-code",
      title: "Install and sign in to Claude Code",
      html: `${p("Follow Anthropic’s " + ext(d.site.links.claudeCodeSetup, "Claude Code setup guide") + " for your system; it lists the current installers. Then start Claude Code once in a terminal and sign in:")}
${code("claude\n# then, inside Claude Code:\n/login", { lang: "sh", label: "Terminal" })}
${p("Check that the command works and is signed in. " + c("claude auth status") + " prints your sign-in as JSON; when you are signed out it exits with an error but still prints it.")}
${code("claude --version\nclaude auth status", { lang: "sh", label: "Terminal" })}
${note(p("If Claude Code is installed only through its VS Code, Cursor or Windsurf extension, AgentDuo still finds the binary that extension bundles. You can also point AgentDuo at any binary with " + c("claude.bin") + "."))}`,
    },
    {
      id: "codex",
      title: "Install and sign in to Codex CLI",
      html: `${p("Follow OpenAI’s " + ext(d.site.links.codexCli, "Codex CLI documentation") + " for the current installers. With npm, for example:")}
${code("npm i -g @openai/codex\ncodex login", { lang: "sh", label: "Terminal" })}
${p(c("codex login") + " signs in with ChatGPT or another method Codex offers. Check it with:")}
${code("codex --version\ncodex login status", { lang: "sh", label: "Terminal" })}`,
    },
    {
      id: "node-and-git",
      title: "When you need Node.js and Git",
      html: `${table({
        caption: "What each interface needs besides the two CLIs",
        head: ["Interface", "Node.js 22.12 or later", "Git"],
        rows: [
          ["Desktop app", "Not for AgentDuo: its engine runs on the Node inside the app. A CLI you installed with npm still needs its own Node on the PATH.", "For pipeline runs"],
          [`Terminal (${c("duo")})`, "Yes: the npm package runs on your Node", "For pipeline runs"],
          ["VS Code extension", `Yes: it takes the first suitable ${c("node")} on VS Code’s PATH, or ${c("agentduo.nodePath")}`, "For pipeline runs"],
          ["Building from source", "Yes, with npm", "Yes"],
        ],
      })}
${p("A pipeline run snapshots and diffs your files, so its workspace must be inside a Git repository. Chat and " + c("/discuss") + " work in any folder, including your home folder. Download Node.js from " + ext(d.site.links.nodeDownload, "nodejs.org") + ".")}`,
    },
    {
      id: "check",
      title: "Check everything at once",
      html: `${p("Each interface checks the CLIs without calling a model:")}
${ul([
  "Desktop app: the first-run screen checks both CLIs: found or missing, signed in or out. Settings → Diagnostics shows the details later.",
  `Terminal: ${c("duo doctor")} checks Node, Git, the configuration, both CLIs and the flags AgentDuo needs from them.`,
  `VS Code: the command <em>agentduo: Doctor</em> writes the same checks to the agentduo output channel.`,
])}
${code("duo doctor", { lang: "sh", label: "Terminal" })}
${p("A line starting with ✗ must be fixed before a pipeline can run; a line with ! is advice. " + link("troubleshooting#cli-not-found", "If a CLI is not found") + ".")}`,
    },
  ],
  related: ["download", "docs/accounts-usage", "docs/permissions", "troubleshooting"],
  next: p("Install your interface: " + link("learn/desktop", "the desktop app") + ", " + link("learn/cli", "the terminal command") + " or " + link("learn/vscode", "the VS Code extension") + "."),
});
