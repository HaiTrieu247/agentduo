export default ({ c, kbd, link, code, p, ul, table, note }) => ({
  title: "Decisions, stop and resume",
  description: "When an AgentDuo run stops to ask you, what resume, revise, abort and decide later do, how Stop and Esc work, and how to resume a run from any interface.",
  lead: p("A run stops in two ways: it asks you a question (" + c("HUMAN_REVIEW") + "), or you stop it. Either way its state is saved, and it continues from the step it was in."),
  sections: [
    {
      id: "reasons",
      title: "When a run asks you",
      html: `${table({
  caption: "Reasons a run stops for a decision, and what resume does",
  head: ["Reason", "When", "Resume does"],
  rows: [
    [c("max_planning_rounds"), "No agreed plan after the planning round limit", "Implements the latest plan, recorded as accepted by you"],
    [c("plan_ready"), "The plan is final and " + c("safety.pause_before_implement") + " is on", "Starts implementing"],
    [c("max_review_rounds"), "Not approved after the review round limit", "Starts another fix round"],
    [c("critical_finding"), "The reviewer reported a critical finding", "Starts another fix round"],
    [c("gates_failing"), "Required gates failed several rounds in a row", "Starts another fix round"],
    [c("implementer_blocked"), "The implementer reported it is blocked", "Re-runs the implementation round"],
    [c("agent_error") + ", " + c("orchestrator_error"), "An agent call failed after its retries, or AgentDuo hit an error", "Re-runs the failed step"],
  ],
})}`,
    },
    {
      id: "answers",
      title: "Your answers",
      html: `${table({
  caption: "The four answers",
  head: ["Answer", "Effect"],
  rows: [
    ["Resume", "Continues as the table above says, optionally with a note for the agents."],
    ["Revise", "Goes back to planning with your note, which should settle the disagreement."],
    ["Abort", "Ends the run. Its files stay; the working tree keeps whatever changes were made."],
    ["Decide later", "Leaves the run waiting. Answer it later from any interface."],
  ],
})}
${ul([
  `<strong>Terminal chat and a ${c('duo "<task>"')} run in a terminal</strong>: a menu shows the reason with Resume, Revise (with a note), views of the plan, the review, the plan feedback and the diff stat, Abort, and Decide later. ${kbd("Ctrl")}+${kbd("C")} at the menu also means Decide later.`,
  "<strong>Desktop app and VS Code</strong>: the decision appears above the composer, with a note field. It stays there when you switch conversations.",
  `<strong>Plain mode</strong> (CI, background, piped output): the run exits with code 2. Answer with ${c("duo resume --decision …")}.`,
])}
${code(`duo resume --decision resume
duo resume --decision revise --note "Keep the public API; change only the parser"
duo resume 20261031-101500-add-refresh-tokens --decision abort`, { lang: "sh", label: "Terminal" })}
${note(p("Files waiting to be attached do not go with a decision. Send them with a message first (a note for the run’s next step), or choose Decide later and resume with a note."))}`,
    },
    {
      id: "stop",
      title: "Stop and Esc",
      html: `${table({
  caption: "What stopping does to each kind of work",
  head: ["Work", "Stopped with Esc or Stop", "Afterwards"],
  rows: [
    ["An answer", "It ends; nothing of it joins the conversation", "Ask again"],
    ["A discussion", "It ends; nothing of it joins the conversation", "Ask again"],
    ["A pipeline step", "The step ends; the run is saved as interrupted", c("/resume [note]") + " re-runs that step"],
  ],
})}
${ul([
  `In a pipeline run in the terminal (${c('duo "<task>"')}), ${kbd("q")} stops after the current step and ${kbd("Ctrl")}+${kbd("C")} stops now. A second ${kbd("Ctrl")}+${kbd("C")} ends the process at once; the exit code is 130.`,
  `Enter on an empty line only reminds you of ${c("/resume")}. ${c("/pipeline")} while a run is stopped starts a new run; the stopped one keeps its id and stays resumable.`,
  "Closing the chat, quitting the desktop app or reloading VS Code stops the current step the same way: decisions are deferred, unanswered permission prompts are denied, the lock is freed, and the run stays resumable.",
])}`,
    },
    {
      id: "resume",
      title: "Resuming a run",
      html: `${table({
  caption: "Ways to resume",
  head: ["Where", "How"],
  rows: [
    ["Chat", c("/resume") + " continues the stopped or waiting run; " + c("/resume <note>") + " adds a note; " + c("/resume <run id>") + " picks a run, also one from an earlier session"],
    ["Terminal", c("duo resume") + " (the latest run) or " + c("duo resume <run id>")],
    ["Desktop app", "<em>Resumable runs</em> in the sidebar lists the project’s stopped and waiting runs; one click resumes one"],
    ["VS Code", "<em>Resume</em> in a tab’s title bar continues the latest run"],
  ],
})}
${ul([
  "Runs are shared: a run started in one interface can be resumed in another, in the same workspace. A run belongs to its workspace; resuming it from another folder is refused.",
  `A resumed run keeps the configuration it started with (its ${c("config.json")}). ${c("duo resume --reload-config")} uses today’s ${c("config.yaml")} instead; Claude Code’s and Codex’s own settings always apply as they are now.`,
  `Settings changed in the chat that apply from the next call (model, effort, permission mode and the like) reach a resumed run too; settings that apply from the next run (${c("agents.*")}, ${c("limits.*")}) do not. ${link("docs/configuration#when-it-applies", "When a change applies")}.`,
])}`,
    },
    {
      id: "conversation-vs-run",
      title: "Continuing a conversation is not resuming a run",
      html: `${p("Opening an earlier conversation (in the desktop app’s sidebar or VS Code’s Conversations view) lets you keep talking: the next question carries what was said. It does not restart any work. Resuming continues a pipeline run from its saved step; it does not need the conversation, nor the original attached files, which the run copied.")}`,
    },
  ],
  related: ["docs/pipeline", "docs/cli#resume", "docs/conversations#history", "docs/configuration"],
});
