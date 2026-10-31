export default ({ c, link, ext, code, p, ul, note, table }, d) => ({
  title: "Get started in VS Code",
  description: "Install the AgentDuo extension for VS Code, set up Node and the two CLIs, open a conversation, use the composer, Account & Usage, the diff editor and Doctor.",
  lead: p("The extension puts the AgentDuo chat in VS Code: each conversation is an editor tab, decisions and permission prompts appear above the composer, and the run’s changes open in VS Code’s diff editor."),
  sections: [
    {
      id: "install",
      title: "Install",
      html: `${p("Install " + c(d.site.marketplaceId) + " from the " + ext(d.site.links.marketplace, "Visual Studio Marketplace") + " or the Extensions view, or from a terminal:")}
${code(`code --install-extension ${d.site.marketplaceId}`, { lang: "sh", label: "Terminal" })}
${table({
  caption: "What the extension needs",
  head: ["Requirement", "Details"],
  rows: [
    ["VS Code desktop 1.95 or later", "With a local, trusted folder, or no folder (then it works in your home folder). Remote SSH, WSL, containers and the web build are not supported."],
    ["Node.js 22.12 or later", `VS Code’s own Node is not used. The extension takes the first suitable ${c("node")} on the PATH VS Code sees, or the path in the ${c("agentduo.nodePath")} setting.`],
    ["Claude Code and Codex CLI, signed in", `When VS Code’s PATH differs from your terminal’s (common on macOS when VS Code is opened from the Dock), set ${c("claude.bin")} and ${c("codex.bin")} in ${c(".agentduo/config.yaml")}.`],
  ],
})}
${p("The extension carries its own engine: the npm package does not need to be installed.")}`,
    },
    {
      id: "open-chat",
      title: "Open a conversation",
      html: `${ul([
  "Click the agentduo button in an editor’s title bar (beside Claude Code’s and Codex’s), or run <em>agentduo: Open Chat</em> from the Command Palette.",
  "Each conversation is an editor tab named after its first message. ＋ in the tab’s title bar (or " + c("/new") + ") opens another one; tabs answer side by side, but a workspace runs one pipeline at a time.",
  "After a reload or a restart, VS Code reopens the tabs: each shows what it showed, and its next question still carries what was said before.",
  "In a multi-root window, choose the folder first with <em>agentduo: Choose Workspace Folder</em>.",
])}`,
    },
    {
      id: "composer",
      title: "The composer",
      html: `${ul([
  "The chip under the input says who a message goes to and on which model (Codex at first). Its menu switches between Codex and Claude, or makes the next message a <em>Discuss</em> question or a <em>Pipeline</em> task. A slash command typed in the composer wins over the chip.",
  "The mode chip opens Claude Code’s mode menu (Manual, Edit automatically, Auto). Shift+Tab in the composer moves to the next mode.",
  "The paperclip attaches files; you can also paste an image, or hold Shift while dragging files from Finder or Explorer onto the composer.",
  "Enter sends, Shift+Enter starts a new line. While something runs and the input is empty, the send button becomes Stop (Esc does the same). A stopped step continues with " + c("/resume") + " or <em>Resume</em>.",
])}`,
    },
    {
      id: "activity-bar",
      title: "Account & Usage and Conversations",
      html: `${p("The agentduo icon in the Activity Bar has two views:")}
${ul([
  "<strong>Account &amp; Usage</strong>: both agents’ accounts and how much of each plan’s limits is used, with a meter per limit and when it resets. It asks the CLIs, not a model. " + link("docs/accounts-usage", "Account &amp; Usage") + ".",
  "<strong>Conversations</strong>: the workspace’s conversations, newest first. Open a closed one to go on with it; ＋ starts a new one; a badge counts the questions waiting for you.",
])}`,
    },
    {
      id: "runs",
      title: "Plans, changes and reports",
      html: `${ul([
  "The ⋯ menu of a tab, and the links under each step, open the run’s plan, review, feedback and report in an editor.",
  "<strong>Changes</strong> lists the files the run changed and opens each in VS Code’s diff editor, from the run’s baseline snapshot to its latest one, so edits you made before the run are not included.",
  "<strong>Always allow</strong> on a permission prompt saves Claude’s rule to " + c(".claude/settings.local.json") + ", the same file Claude Code uses.",
])}
${note(p("Reloading the window or closing VS Code stops the current step, as Esc does. Pending decisions are deferred, unanswered permission requests are denied, and the run stays resumable. The extension never restarts a task on its own."))}`,
    },
    {
      id: "doctor",
      title: "Doctor and configuration",
      html: ul([
        "<em>agentduo: Doctor</em> checks Node, the CLIs, the configuration and the workspace, and writes the results to the agentduo output channel.",
        "<em>agentduo: Open Configuration</em> opens " + c(".agentduo/config.yaml") + ". The configuration is the same as the terminal’s and the desktop app’s: " + link("docs/configuration", "Configuration") + ".",
        "<em>Settings</em> in a tab’s title bar changes models, effort, mode and permissions, as the chat’s settings commands do, and can save them to the workspace or user configuration.",
      ]),
    },
  ],
  related: ["docs/conversations", "docs/attachments", "docs/configuration", "troubleshooting"],
  next: p(link("learn/first-task", "Run your first task") + ": it works the same in an extension tab."),
});
