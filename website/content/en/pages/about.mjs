export default ({ c, link, ext, table, p }, d) => ({
  title: "About AgentDuo",
  description: "Why AgentDuo exists, how it relays work between Codex and Claude Code, the default role of each agent, how its three interfaces relate, and its license.",
  lead: p("AgentDuo is a channel between two coding agents. It runs Codex and Claude Code as they are installed on your machine, passes each one’s structured output to the other, and shows you what both are doing."),
  sections: [
    {
      id: "goal",
      title: "The goal",
      html: `${p("A single coding agent plans, writes and judges its own work. AgentDuo splits those jobs between two agents from different vendors, so that the plan is checked before it is built and the diff is read by an agent that did not write it.")}
${p("It does this without adding a layer of its own rules. Permissions, sandboxes and conventions stay where you already keep them: in each CLI’s configuration and in your repository’s " + c("AGENTS.md") + " or " + c("CLAUDE.md") + ". AgentDuo reports what the agents did, warns about unexpected changes, and leaves decisions and commits to you.")}`,
    },
    {
      id: "how-it-works",
      title: "How it works",
      html: `${p("AgentDuo starts each agent as a subprocess: " + c("codex exec") + " for Codex and " + c("claude -p") + " for Claude Code, in the workspace folder. It passes the flags its protocol needs (streaming JSON output, the output schema for the role, the prompt on standard input) plus the arguments you configure, and reads the agent’s event stream to show tools and messages as they happen.")}
${p("In a pipeline run, every role answers with JSON that must match a schema: a plan, a critique, an approval, an implementation report, a review. AgentDuo validates it, saves it under the run’s folder, and hands it to the next role. Between implementation rounds it snapshots your working tree with Git, so the reviewer sees the exact diff of that round.")}
${p("In a conversation there is no schema: you talk with both agents, each sees the conversation so far, and " + c("/pipeline") + " hands a task from the conversation to the workflow. " + link("docs/concepts", "How AgentDuo works") + " goes through the details.")}`,
    },
    {
      id: "roles",
      title: "Default roles",
      html: `${table({
        caption: "Who does what by default",
        head: ["Role", "Default agent", "What it does"],
        rows: [
          ["Planner", "Codex", "Writes the plan: goals, scope, steps, acceptance criteria, risks. Revises it after critique and signs off the final version."],
          ["Plan critic", "Claude Code", "Checks that the plan is feasible against the repository; approves it or lists blocking issues."],
          ["Implementer", "Claude Code", "Builds the final plan, then fixes the reviewer’s findings round by round."],
          ["Code reviewer", "Codex", "Reviews the diff between snapshots with the gate results, and approves or reports findings by severity."],
        ],
      })}
${p("Each role can be given to either agent with the " + c("agents") + " keys of the configuration. In " + c("/discuss") + ", Codex always writes the final synthesis. " + link("docs/pipeline#roles", "Roles in the pipeline") + ".")}`,
    },
    {
      id: "interfaces",
      title: "Three interfaces, one engine",
      html: `${table({
        caption: "The three interfaces",
        head: ["Interface", "What it is", "Engine runs on"],
        rows: [
          ["Desktop app (AgentDuo)", "An Electron app for macOS, Windows and Linux: projects and conversations in a sidebar, the chat, an inspector, Settings.", "The Node.js inside Electron; no Node installation needed"],
          [c("duo") + " / " + c("agentduo"), "The npm package: the terminal chat with a live view, and commands for scripts and CI.", "Your Node.js 22.12 or later"],
          ["VS Code extension", "The chat as editor tabs, with an Account &amp; Usage view and VS Code’s diff editor.", "Your Node.js 22.12 or later (VS Code’s own Node is not used)"],
        ],
      })}
${p("All three read the same configuration (" + c("~/.config/agentduo/config.yaml") + " and the workspace’s " + c(".agentduo/config.yaml") + ") and keep runs in the same runs folder, guarded by the same lock. A run started in the terminal can be resumed in the desktop app or VS Code, and the other way round.")}`,
    },
    {
      id: "what-it-is-not",
      title: "What AgentDuo does not do",
      html: `<ul>
<li>It does not include Claude Code, Codex, a subscription or API credit. You install both CLIs and sign in with your own accounts.</li>
<li>It does not grant permissions. Claude Code and Codex decide what they may do from their own settings; AgentDuo only relays Claude’s permission prompts to you when someone can answer them.</li>
<li>It does not commit, push or deploy. Your changes stay in the working tree.</li>
<li>It sends nothing to a server of its own. The agents talk to their providers as they always do; the website you are reading has no analytics.</li>
</ul>`,
    },
    {
      id: "source-and-license",
      title: "Source code and license",
      html: `${p("AgentDuo is open source under the " + ext(d.site.links.license, "MIT license") + ". The source of all three interfaces is in one repository: " + ext(d.site.links.github, "github.com/HaiTrieu247/agentduo") + ". Report problems in its " + ext(d.site.links.issues, "issue tracker") + "; " + link("docs/contributing", "Build and contribute") + " explains how to build from source and send a change.")}
${p("AgentDuo is an independent project and is not affiliated with Anthropic or OpenAI. Claude Code and Codex are their products and trademarks.")}`,
    },
  ],
  related: ["docs/concepts", "download", "releases", "docs/contributing"],
  next: p(link("learn", "Learn AgentDuo") + ": install it and run your first task, one step at a time."),
});
