export default ({ c, link, code, p, ul, table, note, h3 }) => ({
  title: "Data and diagnostics",
  description: "Where AgentDuo keeps runs, conversations and attached files, what each run file holds, and how to check a setup with duo doctor and the desktop app’s Diagnostics.",
  lead: p("AgentDuo keeps everything it writes in your workspace’s runs directory, as plain files you can read: each run’s plans, reviews, report and the logs of every CLI call. Nothing is sent anywhere but to the two CLIs."),
  sections: [
    {
      id: "runs-dir",
      title: "The runs directory",
      html: `${p("By default it is " + c(".agentduo/runs") + " in the workspace; " + c("paths.runs_dir") + " moves it. AgentDuo creates it with a " + c(".gitignore") + " of " + c("*") + ", so its data stays out of Git, and every snapshot excludes it.")}
${table({
  caption: "What the runs directory holds",
  head: ["Path", "What it is"],
  rows: [
    [c("<run id>/"), "one pipeline run, e.g. " + c("20261031-101500-add-refresh-tokens")],
    [c("conversations/<id>/"), "one chat conversation: " + c("conversation.json") + " once something was said, its logs, and its " + c("attachments/")],
    [c("LATEST"), "the id of the latest run, which " + c("duo resume") + " picks"],
    [c(".lock"), "the workspace lock: one pipeline at a time, holding the process id"],
  ],
})}
${note(p("Change " + c("paths.runs_dir") + " only with every AgentDuo closed: the workspace lock lives there."), "warning")}`,
    },
    {
      id: "run-files",
      title: "Run files",
      html: `${p("Everything about a run lives in " + c(".agentduo/runs/<run id>/") + ":")}
${table({
  caption: "Files of one run",
  head: ["File", "What it holds"],
  rows: [
    [c("state.json"), "the run’s state, rewritten after every step; it makes the run resumable"],
    [c("config.json"), "the configuration the run started with (" + c("duo resume --reload-config") + " replaces it)"],
    [c("report.md"), "timeline, gate results, diff stat, unresolved issues, warnings, cost and tokens"],
    [c("events.jsonl"), "the run’s events, one JSON object per line, each with its time"],
    [c("plan.v<n>.md") + ", " + c("plan.v<n>.json") + ", " + c("plan.md"), "each version of the plan, and the latest one"],
    [c("critique.r<n>.json") + ", " + c("plan-feedback.md"), "each round’s critique, and all of them as Markdown"],
    [c("approval.r<n>.json") + ", " + c("plan.final.md"), "the planner’s sign-off and the final plan"],
    [c("review.r<n>.json") + ", " + c("review.json"), "each code review, and the latest one"],
    [c("gates/"), "the output of each gate, one " + c(".log") + " per gate and round"],
    [c("attachments/"), "copies of the files attached to the task"],
    [c("logs/"), "every CLI call, below"],
  ],
})}
${p("Each agent JSON carries the task id, round, timestamp, Git SHA and plan version.")}
${h3("call-logs", "The logs of each call")}
${p("Each CLI call writes files named after its step, round and attempt (" + c("<step>.a<attempt>.*") + ") in " + c("logs/") + ":")}
${ul([
  `${c(".prompt.md")}: the prompt as the agent got it (attached images are listed, never their bytes);`,
  `${c(".cmd.json")}: the command line;`,
  `${c(".events.jsonl")}: the CLI’s raw event stream; ${c(".stderr.txt")}: its error output;`,
  `${c(".output.json")} or ${c(".answer.md")}: the answer AgentDuo read;`,
  `${c(".answers.jsonl")}: your answers to Claude’s permission prompts; ${c(".attachments.json")}: the files the call got.`,
])}
${p("A step that failed with an error leaves " + c("logs/error-step<n>.txt") + ". Conversations keep the same call logs in their own folder.")}`,
    },
    {
      id: "attachments",
      title: "Attached files",
      html: `${ul([
  `AgentDuo copies each attached file, bytes unchanged, into ${c("conversations/<id>/attachments/")}, or into a run’s ${c("attachments/")} for a pipeline task, so ${c("/resume")} needs neither the original nor the chat.`,
  "The copies are never part of a snapshot or of the diff the reviewer sees.",
  "A file waiting to be sent is dropped by " + c("/new") + " and when the chat closes; a sent one stays.",
])}
${p("More: " + link("docs/attachments", "attached files") + ".")}`,
    },
    {
      id: "doctor",
      title: "duo doctor",
      html: `${code("duo doctor", { lang: "sh", label: "Terminal" })}
${p("Checks your setup without calling a model:")}
${ul([
  "Node (22.12 or later), Git, and whether the workspace is inside a Git repository;",
  "the configuration files and the output schemas;",
  "each CLI: found, its version, and the protocol flags AgentDuo needs;",
  "permission notes, such as a Codex implementer relying on your Codex sandbox;",
  "each gate’s command, and whether the runs directory is ignored by Git.",
])}
${p("Run it after installing or upgrading Claude Code or Codex. The desktop app shows the same checks in Settings → Diagnostics.")}`,
    },
    {
      id: "desktop",
      title: "Desktop app diagnostics",
      html: `${ul([
  "<strong>Settings → Diagnostics</strong> shows the versions, the PATH the agents get and where each entry came from, both CLIs’ status, " + c("duo doctor") + "’s checks and the app’s recent log lines, including the updater’s.",
  "<strong>Export</strong> writes exactly what the preview shows. It leaves out credentials, prompts, attachments and the environment; your home folder is written as " + c("~") + ", and long tokens become " + c("[redacted]") + ".",
  "<strong>Settings → Storage</strong> (read only) shows where runs and conversations live and where the app keeps its own data.",
])}
${table({
  caption: "The desktop app’s own data (preferences, known projects, drafts, logs)",
  head: ["System", "Folder"],
  rows: [
    ["macOS", c("~/Library/Application Support/AgentDuo")],
    ["Windows", c("%APPDATA%\\AgentDuo")],
    ["Linux", c("~/.config/AgentDuo")],
  ],
})}`,
    },
  ],
  related: ["docs/pipeline", "docs/decisions-resume", "docs/attachments", "docs/permissions"],
});
