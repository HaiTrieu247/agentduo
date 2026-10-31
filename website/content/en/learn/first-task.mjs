import { FIRST_TASK_PROMPT, firstTaskScript } from "../../../lib/tutorial.mjs";

export default ({ c, kbd, link, code, ex, p, ul, steps, note }) => ({
  title: "Your first task, start to finish",
  description: "A complete AgentDuo pipeline run on a tiny Node.js project: create it, add a test gate, run the pipeline, watch the agents, review the diff, resume, and commit.",
  lead: p("You will create a small project with one failing test, give AgentDuo a test gate, and let the two agents plan, fix, check and review the bug. It takes a few minutes and a handful of agent calls on your accounts."),
  sections: [
    {
      id: "before",
      title: "Before you begin",
      html: ul([
        `Claude Code and Codex installed and signed in, and AgentDuo installed: the ${link("learn/desktop", "desktop app")}, ${link("learn/cli", c("duo"))} or ${link("learn/vscode", "the VS Code extension")}.`,
        `Node.js and Git on your machine: the project’s test runs with ${c("node --test")}, and the pipeline needs a Git repository.`,
      ]),
    },
    {
      id: "create-project",
      title: "Create the project",
      html: `${p("The project has a function that formats seconds as “1h 02m 05s”, and a bug: for an hour or more it counts every minute since the start. Create these three files in a new folder named " + c("duo-first-task") + ", with any editor:")}
${ex("first-task/initial/package.json", { label: "package.json" })}
${ex("first-task/initial/src/duration.js", { label: "src/duration.js" })}
${ex("first-task/initial/test/duration.test.js", { label: "test/duration.test.js" })}
${p("Then the AgentDuo configuration, with one gate: AgentDuo runs " + c("npm test") + " after every implementation round and shows the result to the reviewer.")}
${ex("config/first-task.yaml", { label: ".agentduo/config.yaml" })}
${p("On macOS, Linux, WSL or Git Bash, this script creates all four files at once:")}
${code(firstTaskScript(), { lang: "sh", label: "Terminal (POSIX shell)" })}`,
    },
    {
      id: "commit-start",
      title: "Start a Git repository",
      html: `${p("In the " + c("duo-first-task") + " folder (the same commands work in PowerShell):")}
${code('git init\ngit add .\ngit commit -m "Start: formatDuration with a failing test"', { lang: "sh", label: "Terminal" })}
${p("If Git asks who you are, set " + c('git config user.name "Your Name"') + " and " + c('git config user.email "you@example.com"') + ", then commit again.")}`,
    },
    {
      id: "see-it-fail",
      title: "See the test fail",
      html: `${code("npm test", { lang: "sh", label: "Terminal" })}
${p("Two tests pass and one fails. Among the output:")}
${code(`✖ hours, minutes and seconds
  + '1h 62m 05s'
  - '1h 02m 05s'
ℹ tests 3
ℹ pass 2
ℹ fail 1`, { label: "Output (excerpt)" })}
${p("With the terminal command, " + c("duo doctor") + " now also lists the gate: " + c("gate 'tests': npm test") + ".")}`,
    },
    {
      id: "run",
      title: "Run the pipeline",
      html: `${p("The implementer has to edit a file. To let it do so without a prompt for each edit, switch Claude’s mode to <em>Edit automatically</em> first. If you keep <em>Manual</em>, answer each permission prompt with <em>Allow once</em>.")}
${steps([
  ["Terminal", `${p("Open the chat in the project folder, switch the mode, and give the task:")}${code(`duo\n/mode acceptEdits\n/pipeline ${FIRST_TASK_PROMPT.en}`, { label: "Terminal, then the chat" })}${p("Or, without the chat, in one command: " + c(`duo --accept-edits "${FIRST_TASK_PROMPT.en}"`))}`],
  ["Desktop app", p("Choose <em>Open project…</em> and pick " + c("duo-first-task") + ". Set the permission mode under the input to <em>Edit automatically</em>, choose <em>Pipeline</em> in the recipient menu (or type " + c("/pipeline") + " before the task), and send the task above.")],
  ["VS Code", p("Open the folder, open the chat, pick <em>Edit automatically</em> on the mode chip and <em>Pipeline</em> on the recipient chip, and send the task.")],
])}`,
    },
    {
      id: "watch",
      title: "What happens",
      html: `${p("The steps appear one by one, each with the agent working on it and what it hands to the next. The exact text differs from run to run; the sequence is:")}
${steps([
  ["PLAN", p("Codex reads the project and writes a plan: the goal, the steps, the acceptance criteria (the three tests pass, the format is kept) and the risks.")],
  ["PLAN_REVIEW", p("Claude Code checks the plan against the code. If it requests changes, Codex revises it.")],
  ["PLAN_FINALIZE", p("Codex signs off the final plan.")],
  ["IMPLEMENT", p("Claude Code changes " + c("src/duration.js") + " and reports what it did.")],
  ["VERIFY", p("AgentDuo runs " + c("npm test") + ". If the gate fails, the work goes back to Claude Code before any review.")],
  ["CODE_REVIEW", p("Codex reviews the diff with the gate result. It approves, or sends findings back for another round.")],
])}
${p("The run ends with " + c("DONE") + " when Codex approves, no blocking finding is left and the gate passes. If it stops to ask you instead, see " + link("docs/decisions-resume", "Decisions, stop and resume") + ".")}`,
    },
    {
      id: "review",
      title: "Review the result",
      html: `${p("AgentDuo changed the working tree and committed nothing. Look at the change:")}
${code("git diff\nnpm test", { lang: "sh", label: "Terminal" })}
${p("Expect a change to the minutes line, something like:")}
${code(`-  const minutes = Math.floor(totalSeconds / 60);
+  const minutes = Math.floor((totalSeconds % 3600) / 60);`, { label: "git diff (excerpt)", lang: "diff" })}
${p("and " + c("ℹ pass 3") + ", " + c("ℹ fail 0") + " from the tests. The agents may write the fix differently; the tests are what must hold.")}
${ul([
  `In the chat, ${c("/diff")} shows what the run changed and ${c("/plan")} its final plan. In the desktop app and VS Code, open <em>Changes</em> and <em>Plan</em>.`,
  `${c("duo status")} shows the run’s steps and cost; ${c("duo list")} lists the workspace’s runs. Each run’s ${c("report.md")} is in ${c(".agentduo/runs/<run-id>/")}.`,
])}`,
    },
    {
      id: "stop-resume",
      title: "Try stopping and resuming",
      html: `${p("Run the task again on a fresh copy (or another small task), and press " + kbd("Esc") + " (or Stop) while a step is running. The step ends and the run keeps its state. Then:")}
${code("/resume", { label: "duo" })}
${p("re-runs the stopped step. After you close the chat, " + c("duo resume") + " in the same folder continues the latest run, and the desktop app lists it under <em>Resumable runs</em>. " + c("/resume <note>") + " adds a note for the agents.")}`,
    },
    {
      id: "commit",
      title: "Commit the fix",
      html: `${p("When the diff looks right, commit it yourself. Run data under " + c(".agentduo/runs/") + " has its own " + c(".gitignore") + ", so it stays out of the commit.")}
${code('git add -A\ngit commit -m "Fix minutes in formatDuration"', { lang: "sh", label: "Terminal" })}
${note(p("Use your own project next. Add your test command as a gate, start with a small task, and keep Manual mode until you know which tools you want Claude to use without asking. " + link("docs/permissions", "Permissions") + " shows how to allow them."), "tip")}`,
    },
  ],
  related: ["docs/pipeline", "docs/decisions-resume", "docs/configuration", "docs/permissions"],
  next: p(link("docs", "Read the documentation") + ", starting with " + link("docs/concepts", "how AgentDuo works") + "."),
});
