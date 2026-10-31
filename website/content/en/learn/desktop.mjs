export default ({ c, link, p, ul, steps, note, table }) => ({
  title: "Get started with the desktop app",
  description: "Install AgentDuo on macOS, Windows or Linux, pass the first-run check of both CLIs, chat without a project, open a project, and find runs, settings and usage.",
  lead: p("The desktop app is AgentDuo in a window of its own: projects and conversations in a sidebar, the three-way chat in the middle, and an inspector for the plan, the changes and the checks."),
  sections: [
    {
      id: "install",
      title: "Install the app",
      html: `${p("Download the installer for your system from " + link("download#desktop", "the download page") + ": a .dmg for macOS (Apple silicon or Intel), an .exe for Windows x64, an AppImage or .deb for Linux x86_64.")}
${note(p("The published Mac app is not notarized and the Windows installer is not code-signed, so Gatekeeper or SmartScreen warns the first time. The download page shows how to open it."), "warning")}
${p("The app needs no Node.js for itself. It needs Claude Code and Codex installed and signed in: " + link("learn/prerequisites", "What you need") + ".")}`,
    },
    {
      id: "first-run",
      title: "The first-run check",
      html: `${p("On its first start the app checks " + c("claude") + " and " + c("codex") + " without calling a model. Each card says whether the CLI is missing, installed, signed in, signed out, or could not be checked.")}
${ul([
  "Signed in, a card shows the email it signs in with, or <em>API</em> for an API key or a cloud provider, and the plan when the CLI reports one. It never shows a key.",
  `Missing or signed out, it links the install guide and names the sign-in command: ${c("claude")} then ${c("/login")}, or ${c("codex login")}. Sign in in a terminal, then choose <em>Recheck</em>.`,
  `If a CLI is installed somewhere the app does not look, pick its binary on the card. The choice is saved as ${c("claude.bin")} or ${c("codex.bin")} in your user configuration, which every interface reads.`,
])}
${p("Then continue straight to a chat, or pick a project folder first.")}`,
    },
    {
      id: "conversations",
      title: "Chat without a project",
      html: `${p("The app opens a chat without asking for a folder. These chats are listed under <em>Conversations</em> at the top of the sidebar; that button brings you back to them from any project.")}
${ul([
  `They work in your home folder, so their history is saved under ${c("~/.agentduo/runs")} by default, and they come back after a restart with their drafts.`,
  `Plain messages and ${c("/discuss")} work there. A pipeline needs a project inside a Git repository: in the home folder, the app asks you to open one.`,
])}`,
    },
    {
      id: "composer",
      title: "Talk to both agents",
      html: `${p("The composer at the bottom is where you write. Under the input:")}
${table({
  caption: "The composer’s controls",
  head: ["Control", "What it does"],
  rows: [
    ["Recipient and model", "Who your next message goes to (Codex in a new conversation) and on which model. Its menu switches between Codex and Claude, or makes the next message a <em>Discuss</em> question or a <em>Pipeline</em> task."],
    ["Permission mode", "Claude’s mode in the chat and as the pipeline’s implementer: Manual (asks before each edit), Edit automatically, or Auto. Shift+Tab in the composer moves to the next mode."],
    ["Attach", "Adds files and images: pick them, paste an image, or drop files on the composer."],
    ["Send / Stop", "While something runs and the input is empty, Send becomes Stop; Esc does the same."],
  ],
})}
${p("Typed commands win over the menu: " + c("/claude <question>") + ", " + c("/codex <question>") + ", " + c("/discuss <question>") + ", " + c("/pipeline <task>") + ". Type " + c("/") + " to see them all. " + link("docs/conversations", "Conversations") + " covers the chat in full.")}`,
    },
    {
      id: "projects",
      title: "Open a project",
      html: `${steps([
  ["Choose Open project…", p("in the sidebar, and pick a folder with the system’s folder picker. For a pipeline, the folder must be inside a Git repository.")],
  ["Work in it", p("The project gets its own conversations and history. Each project runs its own engine in the background, so switching to another project or conversation leaves the first one working, with its draft kept.")],
  ["Watch the dot", p("A slowly pulsing dot marks a project or conversation where an agent is working. A tag counts the questions waiting for you.")],
])}`,
    },
    {
      id: "inspector",
      title: "Plan, changes and checks",
      html: `${p("The inspector on the right (it folds away) shows the current run:")}
${ul([
  "<strong>Plan</strong>: the plan the agents agreed on.",
  "<strong>Changes</strong>: each changed file as a line diff between the run’s snapshots. A diff you are looking at stays as it is when a new round starts.",
  "<strong>Checks</strong>: your gates’ results, round by round.",
  "The review and the report.",
])}`,
    },
    {
      id: "stop-and-resume",
      title: "Stop, quit and resume",
      html: `${ul([
  "Stop (or Esc) ends what is running. A stopped answer just ends; a stopped pipeline step can be resumed.",
  "The sidebar lists the project’s stopped or waiting runs under <em>Resumable runs</em>. One click resumes one.",
  "Quitting stops every run, answers open questions as a shutdown does, and frees each project’s lock. A run that was going stays resumable, also from the terminal or VS Code.",
])}
${p(link("docs/decisions-resume", "Decisions, stop and resume") + " explains what happens to each kind of work.")}`,
    },
    {
      id: "settings-and-usage",
      title: "Settings, usage and updates",
      html: `${ul([
  "<strong>Settings</strong> (the gear at the bottom of the sidebar): theme and font size, both CLIs and their accounts, the configuration of each agent and of the workflow, storage and diagnostics. " + link("docs/configuration#desktop-settings", "Settings in the desktop app") + ".",
  "<strong>Account &amp; Usage</strong>, above the gear: each agent’s email and how much of its plan’s limits is used. " + link("docs/accounts-usage", "Account &amp; Usage") + ".",
  "<strong>Updates</strong>: the app checks GitHub Releases. Where it cannot install an update itself (a Mac build without a Developer ID), it tells you a new version is out. " + link("docs/desktop-updates", "Desktop updates") + ".",
])}`,
    },
  ],
  related: ["download", "docs/conversations", "docs/configuration", "docs/data-diagnostics"],
  next: p(link("learn/first-task", "Run your first task") + ": a small project, a test gate and a full pipeline run."),
});
