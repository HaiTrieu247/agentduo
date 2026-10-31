export default ({ c, link, code, ext, p, ul, table, note }) => ({
  title: "Contributing",
  description: "Build AgentDuo from source: the CLI, the VS Code extension, the desktop app and this website, the conventions the code follows, and how to report a problem safely.",
  lead: p("AgentDuo is one repository: the " + c("duo") + " CLI in " + c("src/") + ", the VS Code extension in " + c("extensions/vscode") + ", the desktop app in " + c("apps/desktop") + " and this website in " + c("website/") + ". All of them build with Node.js ≥ 22.12 and npm."),
  sections: [
    {
      id: "source",
      title: "Build the CLI from source",
      html: `${code("git clone https://github.com/HaiTrieu247/agentduo.git\ncd agentduo\nnpm ci\nnpm run build", { lang: "sh", label: "Terminal" })}
${p(c("npm run build") + " bundles the CLI into " + c("dist/") + ". Run it as " + c("node dist/cli.js") + ", or " + c("npm link") + " to put " + c("duo") + " and " + c("agentduo") + " on your PATH.")}
${table({
  caption: "Root scripts",
  head: ["Command", "What it does"],
  rows: [
    [c("npm test"), "Unit, workflow and UI tests (Vitest). Workflow scenarios drive a fake agent through real subprocesses, so they cost nothing."],
    [c("npm run typecheck"), "TypeScript, strict."],
    [c("npm run test:pack"), "Builds, packs and installs the package in a temporary prefix, then runs its binaries."],
    [c("npm run demo:ui"), "The live terminal UI with scripted fake agents (free)."],
    [c("npm run smoke:real"), "Real agents on a demo repository. It costs money."],
  ],
})}`,
    },
    {
      id: "vscode",
      title: "The VS Code extension",
      html: `${p("The extension builds from the root, with the root’s toolchain:")}
${table({
  caption: "Extension scripts",
  head: ["Command", "What it does"],
  rows: [
    [c("npm run typecheck:vscode"), "Checks the extension’s TypeScript."],
    [c("npm run build:vscode"), "Builds " + c("extensions/vscode/dist") + " (host and webview) and " + c("runtime/") + " (the engine worker and schemas)."],
    [c("npm run test:vscode"), "A smoke test in a downloaded VS Code; on Linux, run it under " + c("xvfb-run") + "."],
    [c("npm run package:vscode"), "Writes " + c("extensions/vscode/agentduo-vscode-<version>.vsix") + ", for " + c("code --install-extension") + "."],
    [c("npm run test:pack:vscode"), "Packages it, checks the VSIX contents and runs its worker outside the checkout."],
  ],
})}
${p("To develop it, open the repository in VS Code and press " + c("F5") + " (<em>Run agentduo extension</em>): it builds the extension and opens an Extension Development Host.")}`,
    },
    {
      id: "desktop",
      title: "The desktop app",
      html: `${p("The desktop package builds from the checkout with the root toolchain, so install the root first, then the desktop’s own development dependencies (Electron, electron-builder, @electron/fuses, electron-updater, Playwright):")}
${code("npm ci\nnpm ci --prefix apps/desktop", { lang: "sh", label: "Terminal" })}
${table({
  caption: "Desktop scripts (npm --prefix apps/desktop run …)",
  head: ["Script", "What it does"],
  rows: [
    [c("dev"), "Builds, then opens the app from " + c("dist/") + "."],
    [c("build"), "Bundles main, preload, renderer and the engine worker into " + c("dist/") + "."],
    [c("typecheck"), "The desktop’s TypeScript check."],
    [c("test"), "Its unit and integration tests."],
    [c("test:e2e"), "The Electron end-to-end tests (Playwright): the real app with fake CLIs in a scratch Git project, driven as a user."],
    [c("pack:dir"), "An unpacked app for this system under " + c("release/") + "."],
    [c("test:pack"), "Checks that unpacked app away from the checkout."],
    [c("package:mac") + ", " + c("package:win") + ", " + c("package:linux"), "The installers. Packages are native: build each system’s on that system."],
  ],
})}
${p("When you change the desktop app, run " + c("typecheck") + ", " + c("test") + ", " + c("build") + " and " + c("test:e2e") + ". Its version follows the root’s; " + c("npm version") + " keeps them together.")}`,
    },
    {
      id: "website",
      title: "This website",
      html: `${p("The website is static HTML generated from " + c("website/content") + ", in English and Vietnamese. It needs no install:")}
${code("cd website\nnpm run build\nnpm test\nnpm run preview", { lang: "sh", label: "Terminal" })}
${p("While writing a page, " + c("node scripts/check-page.mjs <page id>") + " checks it in every language without building the site. Every section and sub-heading must exist in both languages.")}`,
    },
    {
      id: "conventions",
      title: "Conventions",
      html: `${ul([
  `AgentDuo enforces nothing. It passes protocol flags only, plus your ${c("args")} and ${c("role_args")}; unexpected changes become warnings, never blocks. Permission rules belong to each CLI’s own configuration.`,
  `Runtime dependencies are exactly ${c("ink")}, ${c("react")}, ${c("commander")}, ${c("yaml")} and ${c("ajv")}. Ask before adding one.`,
  `Node ≥ 22.12, ESM, TypeScript strict. Relative imports end in ${c(".js")}, also for ${c(".ts")} and ${c(".tsx")} files.`,
  `${c("src/core")} and ${c("src/agents")} never import from ${c("src/ui")}: what reaches the screen is an event, and human decisions come back through an interface.`,
  `A changed workflow transition gets a scenario in ${c("test/workflow.test.ts")}. Agent output schemas stay OpenAI-strict (every property required, no additional properties), which ${c("test/schema.test.ts")} checks.`,
  `CI runs the tests on Linux, macOS and Windows. Build paths with ${c("join")} in tests, and never name the user config folder with ${c("XDG_CONFIG_HOME")} alone: Windows reads ${c("%APPDATA%")}.`,
])}
${p("The full list is in " + c("AGENTS.md") + " at the root of the repository.")}`,
    },
    {
      id: "report",
      title: "Report a problem",
      html: `${p("Open an issue on " + ext("https://github.com/HaiTrieu247/agentduo/issues", "GitHub") + ". Before you do, check " + link("troubleshooting", "Troubleshooting") + ". Include:")}
${ul([
  `The AgentDuo version (${c("duo --version")}; the extension’s in VS Code’s Extensions view; the desktop app’s in Settings → General) and the versions of ${c("claude")} and ${c("codex")}.`,
  "Your operating system and its version, and which interface you used.",
  `The output of ${c("duo doctor")}, or the desktop app’s Settings → Diagnostics export.`,
  "What you did, what you expected and what happened, with the warning or error text.",
])}
${note(`${p("Issues are public. Before you post anything:")}${ul([
  "Replace email addresses, user names and home folder paths (for example with " + c("/repo") + " or " + c("~") + ").",
  "Remove tokens, API keys and anything from a credential file.",
  "Do not attach a run folder or conversation from private code: it holds your prompts, the agents’ output and diffs of your files. Copy only the lines that show the problem.",
])}`, "warning")}`,
    },
    {
      id: "license",
      title: "License",
      html: p("AgentDuo is released under the MIT License (" + c("LICENSE") + " in the repository)."),
    },
  ],
  related: ["troubleshooting", "docs/data-diagnostics", "docs/cli", "download"],
});
