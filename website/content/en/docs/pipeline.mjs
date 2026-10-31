export default ({ c, link, code, ex, p, ul, table, steps, note, h3 }) => ({
  title: "The pipeline",
  description: "Every step of an AgentDuo pipeline run: planning and critique rounds, sign-off, implementation, command gates, code review, the review policy, DONE and warnings.",
  lead: p("A pipeline run takes one task through plan → critique → finalize → implement → verify → review, with each step done by the agent configured for its role, until the review approves or the run asks you."),
  sections: [
    {
      id: "start",
      title: "Starting a run",
      html: `${table({
  caption: "Ways to start a pipeline run",
  head: ["Where", "How"],
  rows: [
    ["Chat (any interface)", c("/pipeline <task>") + ", or <em>Pipeline</em> in the recipient menu of the desktop app and VS Code"],
    ["Terminal, one run then exit", c('duo "<task>"') + ", " + c('duo run "<task>"') + ", " + c("duo --task-file task.md")],
  ],
})}
${ul([
  "The workspace must be inside a Git repository, and the CLIs of every role must be found. The configuration is checked before anything starts.",
  "A workspace runs one pipeline at a time, guarded by a lock in its runs folder.",
  `The run gets an id such as ${c("20261031-101500-add-refresh-tokens")} and a folder of its own: ${link("docs/data-diagnostics#run-files", "run files")}.`,
])}`,
    },
    {
      id: "roles",
      title: "Roles",
      html: `${table({
  caption: "Roles and their default agents",
  head: ["Step", "Role", "Default agent"],
  rows: [
    [c("PLAN"), "planner", "Codex"],
    [c("PLAN_REVIEW"), "plan critic (" + c("plan_reviewer") + ")", "Claude Code"],
    [c("PLAN_FINALIZE"), "planner, signing off", "Codex"],
    [c("IMPLEMENT"), "implementer", "Claude Code"],
    [c("VERIFY"), "your gates", "AgentDuo runs the commands"],
    [c("CODE_REVIEW"), "code reviewer", "Codex"],
  ],
})}
${p("Change who plays a role with the " + c("agents") + " keys; each agent gets " + c("role_args") + " of its own per role:")}
${ex("config/codex-implementer.yaml", { label: ".agentduo/config.yaml" })}`,
    },
    {
      id: "planning",
      title: "Planning and critique rounds",
      html: `${steps([
  ["PLAN", p("The planner writes a plan with goals, scope, steps, acceptance criteria and risks (" + c("plan.v1.md") + ").")],
  ["PLAN_REVIEW", p("The critic checks that the plan is feasible and lists issues by severity. It approves only when no issue is blocking; an approval that still lists a blocking issue counts as changes requested, with a warning.")],
  ["PLAN_FINALIZE", p("The planner answers the critique and signs off the final plan (" + c("plan.final.md") + "), or requests another round. With " + c("quality_gates.require_plan_approval: false") + " this step is skipped: the plan the critic approved is final.")],
])}
${p("Changes requested start the next planning round. After " + c("limits.max_planning_rounds") + " rounds (4 by default) without agreement, the run stops with " + c("max_planning_rounds") + " and asks you: resume implements the latest plan, recorded as accepted by you. With " + c("safety.pause_before_implement: true") + " the run also stops with " + c("plan_ready") + " once the plan is final, so you can read it first.")}`,
    },
    {
      id: "implementation",
      title: "Implementation rounds",
      html: `${ul([
  "Before the first round AgentDuo snapshots the workspace as the baseline; after each round it snapshots it again.",
  `The implementer builds the plan (round 1) or fixes the open findings (later rounds), and reports ${c("completed")} or ${c("blocked")} with a reason. ${c("blocked")} stops the run with ${c("implementer_blocked")}.`,
  "An implementer that does not answer every open finding gets a warning in the report.",
  `Rounds continue until the review approves, up to ${c("limits.max_review_rounds")} (5 by default); then the run stops with ${c("max_review_rounds")}.`,
])}`,
    },
    {
      id: "gates",
      title: "Command gates (VERIFY)",
      html: `${p("Gates are commands of yours that AgentDuo runs itself after each implementation round, in the workspace, through the shell. They are optional; without any, the run goes from IMPLEMENT straight to CODE_REVIEW.")}
${ex("config/gates.yaml", { label: ".agentduo/config.yaml" })}
${ul([
  `A gate passes when its command exits with 0. ${c("required")} is true unless you set it to false; an optional gate is only reported.`,
  `Each gate has ${c("timeout_sec")}, or ${c("limits.gate_timeout_sec")} (900 seconds). Its output is logged in the run’s ${c("gates/")} folder, and its last ${c("limits.max_gate_output_chars")} characters (6,000) go to the reviewer.`,
  `When a required gate fails, the work goes back to the implementer for another round, without a review (unless ${c("quality_gates.review_on_gate_failure")} is true). After ${c("limits.max_consecutive_gate_failures")} failing rounds in a row (3), the run stops with ${c("gates_failing")}.`,
  "If a gate changes files in the working tree, AgentDuo warns and snapshots again, so the reviewer sees the tree as the gates left it.",
  `${c("duo init")} suggests gates it detects (package.json scripts, pytest, go test, cargo test, a Makefile test target), commented out.`,
])}
${note(p("Gates are not the same as " + c("quality_gates") + ": " + c("gates") + " are commands that run; " + c("quality_gates") + " is the review policy below, which runs nothing."))}`,
    },
    {
      id: "review",
      title: "Code review",
      html: `${p("The reviewer gets the final plan, the diff from the baseline to the latest snapshot (up to " + c("limits.max_diff_chars") + ", 120,000 characters; longer diffs are cut and it is told so), the diff stat, the gate results, the open findings and the implementer’s report. It must name the snapshot it reviewed.")}
${p("It answers with findings, each with a severity (" + c("critical") + ", " + c("high") + ", " + c("medium") + ", " + c("low") + "), and approves or not. A run is " + c("DONE") + " when all of these hold:")}
${ul([
  `the reviewer approves (or ${c("quality_gates.require_codex_approval")} is false);`,
  `no finding has a blocking severity (${c("quality_gates.blocking_severities")}, by default critical and high);`,
  `every required gate passed, if you have gates (and ${c("quality_gates.require_tests_pass")} is true).`,
])}
${p("Otherwise the implementer gets another round. A critical finding stops the run with " + c("critical_finding") + " first, while " + c("quality_gates.stop_on_critical_issue") + " is true. An approval that still lists blocking findings counts as changes requested, with a warning.")}`,
    },
    {
      id: "review-policy",
      title: "The review policy (quality_gates)",
      html: `${table({
  caption: "quality_gates keys",
  head: ["Key", "Default", "Effect"],
  rows: [
    [c("require_plan_approval"), c("true"), "The planner signs off the plan after the critic approves it (PLAN_FINALIZE)."],
    [c("require_tests_pass"), c("true"), "A failing required gate keeps the run from DONE and sends the work back."],
    [c("require_codex_approval"), c("true"), "The code reviewer must approve. The name is historical: it applies to whichever agent reviews."],
    [c("stop_on_critical_issue"), c("true"), "A critical finding stops the run and asks you."],
    [c("blocking_severities"), c("[critical, high]"), "Findings and issues of these severities block approval."],
    [c("review_on_gate_failure"), c("false"), "Review a round even though a required gate failed."],
  ],
})}
${ex("config/review-policy.yaml", { label: ".agentduo/config.yaml" })}`,
    },
    {
      id: "warnings",
      title: "Warnings",
      html: `${p("AgentDuo blocks nothing, but it reports. Warnings appear on screen as they happen and in the run’s " + c("report.md") + ":")}
${ul([
  "files changed by a planning or reviewing agent;",
  "files changed outside the workspace during a step, with paths relative to the workspace (" + c("../shared/x.ts") + ");",
  "tool calls Claude was denied, naming the tools;",
  "gates that changed the working tree;",
  "an approval with blocking issues, an implementer that skipped findings, a step re-run after an interruption.",
])}`,
    },
    {
      id: "when-done",
      title: "When the run ends",
      html: `${p("Nothing is committed or pushed. The changes are in your working tree:")}
${code("git status\ngit diff", { lang: "sh", label: "Terminal" })}
${p("The run’s " + c("report.md") + " has the timeline, gate results, diff stat, unresolved issues, warnings, cost and tokens. " + c("/diff") + ", " + c("/plan") + " and " + c("/status") + " show them in the chat; the desktop app’s inspector and VS Code’s ⋯ menu open them.")}`,
    },
  ],
  related: ["docs/decisions-resume", "docs/config-reference#quality-gates", "docs/permissions", "learn/first-task"],
});
