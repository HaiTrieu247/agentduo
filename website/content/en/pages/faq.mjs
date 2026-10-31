export default ({ c, link, ext, p, ul }, d) => ({
  title: "Frequently asked questions",
  description: "Answers about AgentDuo: cost and accounts, which interface to use, supported systems, signing, what it does with your code, Git, stopping and resuming.",
  lead: p("Short answers, each with a link to the page that has the details. For error messages and fixes, see " + link("troubleshooting", "Troubleshooting") + "."),
  sections: [
    {
      id: "cost",
      title: "Is AgentDuo free? Does it include Claude or Codex?",
      html: `${p("AgentDuo is free and open source under the MIT license. It does not include Claude Code, Codex, a subscription or API credit: it runs the CLIs you installed, signed in with your own accounts, and their usage counts against your own plans or keys.")}
${p("To see how much of your plans’ limits you have used, open " + link("docs/accounts-usage", "Account &amp; Usage") + ". To cap what one Claude call may cost, set " + c("claude.max_budget_usd") + ".")}`,
    },
    {
      id: "both-clis",
      title: "Do I need both Claude Code and Codex?",
      html: `${p("For the default setup, yes: Codex plans and reviews, Claude Code critiques and implements, and " + c("/discuss") + " always has Codex write the final synthesis. Both CLIs must be installed and signed in.")}
${p("The " + c("agents") + " keys can give every pipeline role to the same CLI. A pipeline run then checks only that CLI, but the conversation and " + c("/discuss") + " still use both. " + link("docs/config-reference#agents", "The agents keys") + ".")}`,
    },
    {
      id: "which-interface",
      title: "Desktop app, terminal or VS Code: which should I use?",
      html: `${ul([
  "<strong>Desktop app</strong> if you want a window of its own, conversations without opening a folder, and nothing else to install besides the two CLIs.",
  `<strong>Terminal (${c("duo")})</strong> if you live in a terminal, or want to run the pipeline from scripts and CI (${c('duo "<task>"')}, exit codes).`,
  "<strong>VS Code extension</strong> if you want the chat next to your editor and the changes in VS Code’s diff editor.",
])}
${p("They share configuration and runs, so you can switch at any time. " + link("about#interfaces", "How the interfaces relate") + ".")}`,
    },
    {
      id: "platforms",
      title: "Which systems are supported?",
      html: `${p("The desktop app is published for macOS (Apple silicon and Intel), Windows x64 and Linux x86_64 (AppImage and .deb). There are no Windows on Arm or Linux arm64 builds. " + link("download", "See the installers") + ".")}
${p("What has been verified is recorded in the repository: the desktop app’s tests, its end-to-end tests and its unpacked package passed in CI on all three systems, and the macOS build has been run on an Apple silicon Mac. Installing the Windows and Linux packages, and self-update end to end, have not been verified yet. " + ext(d.site.links.desktopVerification, "VERIFICATION.md") + " lists what ran where.")}
${p("The terminal command needs Node.js 22.12 or later; its tests run in CI on Windows, macOS and Ubuntu with Node 22 and 24. The VS Code extension works in desktop VS Code 1.95 or later with a local folder; Remote SSH, WSL, containers and the web build are not supported.")}`,
    },
    {
      id: "signing",
      title: "Why does my system warn me when I open the app?",
      html: p(`The published Mac app is ad-hoc signed and not notarized, and the Windows installer is not code-signed, so Gatekeeper and SmartScreen warn the first time. ${link("download#desktop", "The download page")} explains how to open it and how to check the file’s checksum. Signing needs certificates the project does not have yet.`),
    },
    {
      id: "your-code",
      title: "Does AgentDuo send my code anywhere?",
      html: `${p("AgentDuo has no server and sends nothing of its own. The agents work as they always do: Claude Code and Codex read files and talk to their providers according to their own settings. AgentDuo passes them prompts on standard input, reads their output, and keeps run files in your workspace.")}
${p("The desktop app contacts GitHub to check for updates, which you can turn off in Settings → General. Account &amp; Usage asks the two CLIs, not a model. " + link("docs/data-diagnostics", "Where data is kept") + ".")}`,
    },
    {
      id: "changes",
      title: "Will it change my files or commit for me?",
      html: p(`The implementer changes files in your working tree, as far as its own permission settings allow. AgentDuo never commits, pushes or deploys: review the changes with ${c("git diff")} or the diff view, then commit them yourself. If a planning or reviewing agent changes files, or anything changes outside the workspace, you get a warning. ${link("docs/permissions", "Permissions")}.`),
    },
    {
      id: "git",
      title: "Why does the pipeline need Git?",
      html: p(`Between rounds the pipeline snapshots your working tree with Git, so the reviewer reads the exact diff of each round and the run can be resumed. Chat and ${c("/discuss")} need no repository and work in any folder, including your home folder. Run ${c("git init")} (or ${c("duo init")}, which offers it) before your first pipeline in a new folder.`),
    },
    {
      id: "stop-resume",
      title: "Can I stop a run and continue later?",
      html: p(`Yes. Esc (or Stop) ends the step that is running; the run keeps its state and ${c("/resume")} re-runs that step, also after a restart and from another interface. A run that stopped to ask you waits for your decision. ${link("docs/decisions-resume", "Decisions, stop and resume")}.`),
    },
    {
      id: "api-keys",
      title: "Can I use API keys instead of a subscription?",
      html: p(`AgentDuo uses whatever sign-in each CLI has. If Claude Code or Codex is set up with an API key or a cloud provider, the desktop app shows <em>API</em> for it instead of an email. AgentDuo never reads or stores the key itself.`),
    },
    {
      id: "offline",
      title: "Does it work offline?",
      html: p("No. Claude Code and Codex need a connection to their providers to answer, so every conversation turn and pipeline step needs one too."),
    },
    {
      id: "affiliation",
      title: "Is AgentDuo made by Anthropic or OpenAI?",
      html: p("No. It is an independent open-source project. Claude Code is a product of Anthropic, Codex a product of OpenAI; AgentDuo runs both as they are installed on your machine."),
    },
    {
      id: "report",
      title: "How do I report a bug or ask for a feature?",
      html: p(`Open an issue on ${ext(d.site.links.issues, "GitHub")}. ${link("docs/contributing#report", "What to include")} lists what helps, and what to leave out (prompts, credentials, private code).`),
    },
  ],
  related: ["troubleshooting", "learn/prerequisites", "docs/concepts", "download"],
  next: p(link("learn", "Start with Learn") + " for a step-by-step introduction."),
});
