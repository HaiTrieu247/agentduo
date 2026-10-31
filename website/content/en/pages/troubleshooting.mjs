export default ({ c, link, code, ext, p, ul, steps, note, table }) => ({
  title: "Troubleshooting",
  description: "Fix common AgentDuo problems: a CLI not found or not signed in, denied tool calls, config errors, Git, Windows paths, unsigned installers, the Linux sandbox and updates.",
  lead: p("Most problems come from the two CLIs AgentDuo runs: where they are, how they sign in, and what their own settings allow. Start with " + c("duo doctor") + " (or Settings → Diagnostics in the desktop app): it checks all of that without calling a model."),
  sections: [
    {
      id: "cli-not-found",
      title: "Claude Code or Codex is not found",
      html: `${p(c("duo doctor") + " lists " + c("claude CLI not found (bin: 'claude')") + " or the same for " + c("codex") + " when it cannot find a CLI. It checks only the CLIs your roles use.")}
${ul([
  `A name such as ${c("claude")} is looked up on the ${c("PATH")} that ${c("duo")} (or the app) was started with. A value with a slash, or starting with ${c("~")}, is taken as a path to the file itself.`,
  `If Claude Code is not on the PATH, AgentDuo also looks in ${c("~/.claude/local")} and in the Claude Code extension of VS Code, Cursor or Windsurf.`,
  `Run ${c("claude --version")} and ${c("codex --version")} in the same terminal. If they work there and AgentDuo still cannot find them, set the full path in your configuration:`,
])}
${code("claude:\n  bin: /opt/homebrew/bin/claude\ncodex:\n  bin: ~/.npm-global/bin/codex", { lang: "yaml", label: "~/.config/agentduo/config.yaml" })}
${p("In the desktop app, the first-run check and Settings → Claude &amp; Codex let you pick the binary instead; it is saved as " + c("claude.bin") + " or " + c("codex.bin") + " in your user configuration, which every interface reads.")}
${note(p("A line such as " + c("codex supports --json, … — missing: --output-schema") + " means the CLI is found but too old or too new for the flags AgentDuo passes. Update the CLI, then run " + c("duo doctor") + " again."))}`,
    },
    {
      id: "not-signed-in",
      title: "A CLI is not signed in",
      html: `${p("AgentDuo holds no credential: each CLI signs in on its own. When one is signed out, its calls fail, and " + c("/usage") + ", the desktop app’s first-run check and its Account &amp; Usage box say so.")}
${table({
  caption: "How each CLI signs in",
  head: ["CLI", "Sign in", "Check"],
  rows: [
    ["Claude Code", c("claude") + ", then " + c("/login") + " (or " + c("claude auth login") + ")", c("claude auth status")],
    ["Codex", c("codex login"), c("/usage") + " in a chat"],
  ],
})}
${p("Sign in in a terminal, then choose <em>Recheck</em> in the app, or start the chat again. " + link("docs/accounts-usage", "Accounts and usage") + ".")}`,
    },
    {
      id: "launcher-path",
      title: "The app cannot find a CLI the terminal finds",
      html: `${p("An app opened from the Dock, Finder, the Start menu or a desktop launcher does not get your terminal’s PATH. The desktop app therefore builds the PATH the agents get from:")}
${ul([
  "the PATH it was started with;",
  `on macOS and Linux, your login shell’s PATH (it asks ${c("$SHELL")} once, with a 5-second timeout);`,
  `the usual install folders: Homebrew, ${c("~/.local/bin")}, npm’s global folder, ${c("%APPDATA%\\npm")}, nvm’s Node versions and others.`,
])}
${p("A binary picked in Settings always wins. Settings → Diagnostics shows the PATH the agents get and where each entry came from. If your shell takes longer than the timeout to start, or the CLI lives somewhere unusual, pick the binary instead.")}
${p("A CLI installed with npm may also need its own Node.js on that PATH, even though the app itself needs none; Diagnostics shows that separately.")}`,
    },
    {
      id: "denied",
      title: "Tool calls are denied",
      html: `${p("AgentDuo passes no permission flags of its own: what an agent may do comes from Claude Code’s and Codex’s own settings. When a call is denied, the run shows a warning that names the tools and where to allow them, for example:")}
${code('Claude was denied 2 tool call(s) (Edit, Bash); allow them in your Claude Code settings (permissions.defaultMode "acceptEdits" for edits; permissions.allow rules for Bash (e.g. "Bash(npm test:*)")) or via claude.role_args.implementer (a resumed run picks up config changes only with --reload-config)', { label: "Warning" })}
${ul([
  `Without a terminal to ask in (CI, background, piped output), Claude Code denies every tool call its settings do not allow. ${c("duo doctor")} warns when the implementer has no edit permission configured.`,
  `${c("codex exec")} is read-only unless configured otherwise: set ${c("sandbox_mode")} in ${c("~/.codex/config.toml")}, or ${c("codex.role_args.implementer: [--sandbox, workspace-write]")}.`,
  `A resumed run keeps the configuration it started with; pass ${c("--reload-config")} to use your changes.`,
])}
${p(link("docs/permissions", "Permissions") + " explains each mode and the prompts in the chat.")}`,
    },
    {
      id: "config-errors",
      title: "Configuration errors",
      html: `${p("A configuration file that is not valid YAML, or holds a value AgentDuo does not accept, stops a run before anything starts. " + c("duo doctor") + " prints the error on its " + c("config:") + " line; otherwise that line lists the files it read.")}
${table({
  caption: "Where the configuration files are",
  head: ["File", "Path"],
  rows: [
    ["User (macOS, Linux)", c("~/.config/agentduo/config.yaml") + " (or " + c("$XDG_CONFIG_HOME/agentduo/config.yaml") + ")"],
    ["User (Windows)", c("%APPDATA%\\agentduo\\config.yaml")],
    ["Project", c(".agentduo/config.yaml") + " in the workspace"],
  ],
})}
${p("The desktop app leaves a file that is not valid YAML alone: Settings shows the error and its line, and opens the file for you. It never writes a change that would make the configuration invalid. " + link("docs/configuration", "Configuration") + ".")}`,
    },
    {
      id: "git",
      title: "Git repository errors",
      html: `${ul([
  `The chat and ${c("/discuss")} work in any folder. Only a pipeline (${c("/pipeline")}, ${c("duo run")}) and ${c("/resume")} need the workspace to be inside a Git repository, because they snapshot and diff it. Run ${c("git init")} first, or ${c("duo init")}, which offers it.`,
  `In your home folder (the desktop app’s and the VS Code extension’s chats with no folder open), open a project folder for a pipeline instead.`,
  `${c("codex exec")} refuses to start outside a repository, so AgentDuo passes ${c("--skip-git-repo-check")} for conversation turns. It changes nothing inside a repository and grants no permission.`,
  `${c("duo doctor")} checks that Git is installed and whether the workspace is inside a repository.`,
])}`,
    },
    {
      id: "windows-paths",
      title: "Windows paths",
      html: `${ul([
  `In ${c("/attach")}, a backslash is the path separator on Windows, never an escape: ${c("/attach C:\\Users\\me\\shot.png")} reads as typed. Put a path with spaces in quotes: ${c('/attach "C:\\Users\\me\\My notes.pdf"')}. ${c("~\\")} is your home folder. Attach one path at a time.`,
  `Windows reads environment variable names in any case, and a copied environment may say ${c("Path")} rather than ${c("PATH")}. AgentDuo reads them the same way, including ${c("PATHEXT")}.`,
  `npm installs Codex as ${c("codex.cmd")} (beside a ${c("codex")} script for Git Bash that Windows cannot start). AgentDuo finds the ${c(".cmd")} through ${c("PATHEXT")} and starts it through the shell, as Node requires for ${c(".cmd")} and ${c(".bat")} files.`,
  `To set a path in YAML, use single quotes or no quotes: in double quotes, YAML reads a backslash as an escape.`,
])}
${code("codex:\n  bin: 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd'", { lang: "yaml", label: "%APPDATA%\\agentduo\\config.yaml" })}`,
    },
    {
      id: "unsigned-app",
      title: "The installer or app is blocked",
      html: `${p("The published Mac app is not notarized and the Windows installer is not code-signed, so the system warns the first time. Do this only for a file you downloaded from the project’s " + ext("https://github.com/HaiTrieu247/agentduo/releases", "GitHub releases") + ".")}
${steps([
  ["macOS: Gatekeeper", p("Open <em>System Settings → Privacy &amp; Security</em>, find the message about AgentDuo, choose <em>Open Anyway</em> and confirm. For a build you trust, " + c("xattr -dr com.apple.quarantine /Applications/AgentDuo.app") + " does the same.")],
  ["Windows: SmartScreen", p("On <em>Windows protected your PC</em>, choose <em>More info</em>, check the file, then <em>Run anyway</em>.")],
])}
${p(link("download#desktop", "The download page") + " walks through each system.")}`,
    },
    {
      id: "linux-sandbox",
      title: "The app does not start on Linux (sandbox)",
      html: `${p("Ubuntu 24.04 and later restrict unprivileged user namespaces, which Chromium’s sandbox needs. AgentDuo never turns its sandbox off by itself, so an app that cannot start it does not open.")}
${ul([
  `The ${c(".deb")} installs to ${c("/opt/AgentDuo")} with an AppArmor profile that allows user namespaces and confines nothing else, and makes ${c("chrome-sandbox")} ${c("root:root")} mode ${c("4755")} where user namespaces are unavailable. Install it if the AppImage fails.`,
  "An AppImage gets neither. Install the .deb instead, or add an AppArmor profile for the AppImage’s path.",
  `As a last resort, and less safe, allow unprivileged user namespaces for the whole system: ${c("sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0")}.`,
])}`,
    },
    {
      id: "updates",
      title: "Update errors",
      html: `${table({
  caption: "Update messages",
  head: ["Message", "What it means"],
  rows: [
    ["<em>No AgentDuo release is published on GitHub yet.</em>", "There is nothing to update to yet."],
    ["<em>Could not reach GitHub. Check your connection.</em>", "The check could not connect. It runs again later, or choose <em>Check now</em>."],
    ["<em>GitHub is limiting requests for now. Try again later.</em>", "GitHub rate-limited the check."],
    ["<em>Get AgentDuo x.y.z</em>", "A Mac app without a Developer ID signature cannot replace itself: it opens the release page so you can download the new .dmg."],
  ],
})}
${ul([
  `A development build (${c("npm run dev")}) and an app started with a profile of its own (${c("AGENTDUO_DESKTOP_USER_DATA")}) never update from GitHub.`,
  `The .deb installs only when you choose <em>Restart to update</em>, through ${c("pkexec")}, which asks for your password.`,
  "The updater writes its lines to the app’s log, which Settings → Diagnostics shows.",
])}
${p(link("docs/desktop-updates", "How updates work") + ".")}`,
    },
    {
      id: "still-stuck",
      title: "Still stuck",
      html: `${p("Each run keeps its prompts, the agents’ raw output and an event log in its own folder: " + link("docs/data-diagnostics#run-files", "run files") + ". The desktop app’s Settings → Diagnostics can export what it shows, without credentials, prompts or attachments.")}
${p("Then " + link("docs/contributing#report", "report the problem") + ", with the details it lists and nothing private.")}`,
    },
  ],
  related: ["learn/prerequisites", "docs/permissions", "docs/configuration", "docs/data-diagnostics", "docs/desktop-updates"],
});
