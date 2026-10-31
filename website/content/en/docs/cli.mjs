export default ({ c, kbd, link, code, p, ul, table, note, h3 }) => ({
  title: "Command line",
  description: "Every duo command and option: the chat, run, resume, status, list, doctor and init, the common options, the keys of a terminal run, and the exit codes.",
  lead: p("The npm package installs one program under two names, " + c("duo") + " and " + c("agentduo") + ". " + c("duo") + " alone opens the chat; with a task it runs the pipeline once and exits."),
  sections: [
    {
      id: "commands",
      title: "Commands",
      html: `${table({
  caption: "duo commands",
  head: ["Command", "What it does"],
  rows: [
    [c("duo"), "Opens the " + link("docs/conversations", "chat") + " in this workspace (an interactive terminal only)."],
    [c('duo "<task>"') + ", " + c('duo run "<task>"'), "Starts a pipeline run with the task, shows it until it ends, and exits with its " + link("docs/cli#exit-codes", "exit code") + "."],
    [c("duo resume [runId]"), "Continues the latest run, or the one named, optionally answering its pending decision."],
    [c("duo status [runId]"), "Shows a run’s phase, rounds, cost and tokens, its last steps, and where its files are."],
    [c("duo list"), "Lists the runs of this workspace: id, phase, last update and task."],
    [c("duo doctor"), "Checks the CLIs, the config and the workspace, without calling any model."],
    [c("duo init"), "Creates " + c(".agentduo/config.yaml") + " and " + c(".agentduo/.gitignore") + ", and offers " + c("git init") + "."],
    [c("duo --help") + ", " + c("duo <command> --help"), "Prints the usage."],
    [c("duo -V") + ", " + c("duo --version"), "Prints the version."],
  ],
})}
${p(c("duo") + " and " + c("agentduo") + " are the same program: every example on this site works with either name.")}`,
    },
    {
      id: "options",
      title: "Common options",
      html: `${p("Every command takes these options, before or after the command name (" + c("duo --dir ../api list") + " and " + c("duo list --dir ../api") + " are the same).")}
${table({
  caption: "Options every command takes",
  head: ["Option", "Effect"],
  rows: [
    [c("--dir <path>"), "The workspace: this directory, not the repository root above it. Default: the current directory."],
    [c("--config <path>"), "The config file to use instead of " + c("<dir>/.agentduo/config.yaml") + ". The user config is still read first."],
    [c("--plain"), "Plain timestamped lines instead of the live terminal UI. It is the default when stdout is not a terminal, when " + c("CI=true") + ", or when the process runs in the background (" + c("duo … &") + ")."],
    [c("-v") + ", " + c("--verbose"), "Shows every agent activity, thoughts included."],
    [c("--no-color"), "No colours. Setting " + c("NO_COLOR") + " in the environment does the same."],
  ],
})}
${table({
  caption: "Options of the commands that start or continue a run",
  head: ["Option", "Commands", "Effect"],
  rows: [
    [c("--task-file <file>"), c("duo") + ", " + c("duo run"), "Reads the task from a file. With words as well, the file’s text comes after them."],
    [c("--accept-edits"), c("duo") + ", " + c("duo run") + ", " + c("duo resume"), "The implementer edits files without asking: Claude’s " + c("acceptEdits") + " mode, as " + c("/mode acceptEdits") + " in the chat. On " + c("duo") + " alone it sets the chat’s mode."],
    [c("--decision <decision>"), c("duo resume"), "Answers a run waiting for you: " + c("resume") + ", " + c("revise") + " or " + c("abort") + "."],
    [c("--note <text>"), c("duo resume"), "An instruction for the agents, recorded with the decision. Only together with " + c("--decision") + "."],
    [c("--reload-config"), c("duo resume"), "Uses the current config instead of the one the run started with."],
  ],
})}`,
    },
    {
      id: "chat",
      title: "The chat: duo",
      html: `${p(c("duo") + " with no task opens the chat, but only where someone can type: an interactive terminal, in the foreground, outside CI, without " + c("--plain") + ". Anywhere else it stops with exit code 1 and asks for a task.")}
${ul([
  "The chat opens in any folder, even without the CLIs or a Git repository; each question checks its agent’s CLI, and " + c("/pipeline") + " also checks for a repository.",
  "It holds the workspace’s lock until you leave, so a " + c("duo run") + " in the same workspace meanwhile is refused.",
  "Leaving (" + c("/quit") + ", or " + kbd("Ctrl") + "+" + kbd("C") + " twice) stops a running pipeline at its current step; it stays resumable. The exit code is 0.",
])}
${p("Everything you type in it is described in " + link("docs/slash-commands", "Slash commands") + ".")}`,
    },
    {
      id: "run",
      title: "Starting a run: duo \"<task>\" and duo run",
      html: `${code('duo "Add refresh tokens to the auth service"\nduo run "Fix the flaky upload test" --accept-edits\nduo --task-file task.md\nduo -- "-x is ignored by the parser"', { lang: "sh", label: "Terminal" })}
${ul([
  "The task is every word after the command, joined. A task that starts with " + c("-") + " would be read as an option: put " + c("--") + " before it.",
  "A single word close to a command name (" + c("duo stauts") + ") is refused rather than sent as a paid task; " + c("duo run <word>") + " runs it anyway.",
  "Before anything starts, the workspace must be in a Git repository and the CLI of every role must be found; otherwise the run does not start (exit code 1).",
  "A workspace runs one pipeline at a time. A second " + c("duo run") + " while one runs, or while the chat is open there, is refused.",
  "The run gets a folder of its own under the runs directory (" + link("docs/data-diagnostics#run-files", "run files") + ") and keeps the config it started with in " + c("config.json") + ".",
])}
${p("What happens next is described in " + link("docs/pipeline", "The pipeline") + ".")}`,
    },
    {
      id: "terminal-run",
      title: "Watching a run in the terminal",
      html: `${p("In an interactive terminal a run shows a live view. These keys work while it runs:")}
${table({
  caption: "Keys of a terminal run",
  head: ["Key", "Effect"],
  rows: [
    [kbd("v"), "Shows or hides every agent activity, as " + c("--verbose") + "."],
    [kbd("q"), "Stops after the step that is running now. The run stays resumable (exit code 130)."],
    [kbd("Ctrl") + "+" + kbd("C"), "Stops the running agent or gate now; that step runs again on resume (exit code 130)."],
    [kbd("Ctrl") + "+" + kbd("C") + " twice", "Kills the agents and exits at once (exit code 130)."],
  ],
})}
${ul([
  "When the run needs you, a menu replaces the view: Resume, Revise (with a note), view the plan, the review, the plan feedback or the diff stat, Abort, or Decide later. " + kbd("Ctrl") + "+" + kbd("C") + " at the menu also means Decide later (exit code 2). See " + link("docs/decisions-resume", "Decisions and resume") + ".",
  "In a terminal Claude’s permission prompts come to you, in plain mode too. Where nobody can answer (CI, a pipe, the background), Claude denies them itself and the run reports the denied tools: " + link("docs/permissions", "Permissions") + ".",
  "In plain mode a run that needs a decision exits with code 2; answer it with " + c("duo resume --decision …") + ".",
])}`,
    },
    {
      id: "resume",
      title: "Continuing a run: duo resume",
      html: `${code('duo resume\nduo resume 20261031-101500-add-refresh-tokens\nduo resume --decision revise --note "Keep the old endpoint until v2"\nduo resume --reload-config', { lang: "sh", label: "Terminal" })}
${ul([
  "Without an id it continues the latest run of the runs directory. A step that was interrupted runs again.",
  "The run keeps the config it started with (its " + c("config.json") + "). " + c("--reload-config") + " uses your current config files instead, and saves it as the run’s config.",
  c("--decision") + " answers a run waiting in " + c("HUMAN_REVIEW") + ": " + c("resume") + " goes on, " + c("revise") + " goes back to planning with your note, " + c("abort") + " ends the run (exit code 3). A run that is not waiting refuses a decision (exit code 1).",
  c("--note") + " is accepted only with " + c("--decision") + ".",
  "A run belongs to the workspace it started in. Resuming it from another one is refused; run it from there, or pass " + c("--dir") + ".",
  "Like a new run, it needs a Git repository and the CLIs, and takes the workspace’s lock.",
])}
${note(p("In the chat, " + c("/resume") + " does the same, and takes a note or a run id: " + link("docs/slash-commands#runs", "/resume") + "."))}`,
    },
    {
      id: "inspect",
      title: "Looking at runs: duo status and duo list",
      html: `${p(c("duo status [runId]") + " shows the latest run, or the one named: its phase, the planning and implementation rounds against their limits, open findings, cost and tokens, its last twelve steps, its warnings and its folder. A run waiting for you also shows the reason and the " + c("duo resume … --decision") + " command that answers it.")}
${p(c("duo list") + " prints one line per run of this workspace’s runs directory. Neither command calls an agent or needs a Git repository.")}`,
    },
    {
      id: "setup",
      title: "Setting up: duo doctor and duo init",
      html: `${h3("doctor", "duo doctor")}
${p("Checks the CLIs, the config and the workspace without calling a model, and prints one line per check: " + c("✓") + " passed, " + c("✗") + " a required check failed, " + c("!") + " a warning. It ends with " + c("doctor: ready") + " (exit code 0) or " + c("doctor: problems found") + " (exit code 1). Run it after upgrading Codex or Claude Code.")}
${h3("init", "duo init")}
${ul([
  "Creates " + c(".agentduo/config.yaml") + " in the workspace, or keeps the one that exists.",
  "Suggests gates it detects (package.json scripts, pytest, go test, cargo test, a Makefile test target), commented out.",
  "Creates " + c(".agentduo/.gitignore") + ", which keeps run data out of Git.",
  "Outside a Git repository it offers to run " + c("git init") + " (in a terminal), or says to run it before " + c("duo run") + ".",
])}`,
    },
    {
      id: "exit-codes",
      title: "Exit codes",
      html: `${table({
  caption: "Exit codes",
  head: ["Code", "Meaning"],
  rows: [
    [c("0"), "Done: the run reached " + c("DONE") + ", or the command (" + c("status") + ", " + c("list") + ", " + c("init") + ", a ready " + c("doctor") + ", the chat, " + c("--help") + ") succeeded."],
    [c("1"), "Config or environment error: an invalid option or config, no task, an unreadable task file, a missing CLI, no Git repository, a workspace that is busy, " + c("doctor") + " problems, a decision the run cannot take. Nothing new ran."],
    [c("2"), "The run waits for your decision (" + c("HUMAN_REVIEW") + "): in plain mode, or after Decide later. Answer with " + c("duo resume") + "."],
    [c("3"), "The run was aborted."],
    [c("130"), "The run was stopped (" + kbd("q") + ", " + kbd("Ctrl") + "+" + kbd("C") + ", a signal). It is resumable."],
  ],
})}
${code('duo --plain "Upgrade the logger"\ncase $? in\n  0) echo done ;;\n  2) duo status ;;          # waiting for a decision\n  130) duo resume ;;        # stopped; continue it\nesac', { lang: "sh", label: "Terminal" })}`,
    },
  ],
  related: ["learn/cli", "docs/slash-commands", "docs/decisions-resume", "docs/pipeline", "troubleshooting"],
});
