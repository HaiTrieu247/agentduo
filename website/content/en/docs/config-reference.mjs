export default ({ c, link, ex, p, ul, table, note }) => ({
  title: "Configuration reference",
  description: "Every key of AgentDuo's config.yaml with its type, default and effect: agents, limits, quality_gates, command gates, safety, claude, codex and paths.",
  lead: p("Every key AgentDuo reads, with its type and built-in default. All keys are optional; " + link("docs/configuration", "Configuration") + " explains where the files live and how they merge."),
  sections: [
    {
      id: "overview",
      title: "Top-level keys",
      html: `${table({
  caption: "Top-level keys",
  head: ["Key", "What it holds"],
  rows: [
    [c("agents"), "Which CLI plays each pipeline role"],
    [c("limits"), "Rounds, retries, timeouts and sizes"],
    [c("quality_gates"), "The review policy: when a run is DONE or stops for you. It runs nothing"],
    [c("gates"), "Commands AgentDuo runs after each implementation round (VERIFY)"],
    [c("safety"), "Whether to stop before implementing"],
    [c("claude"), "How Claude Code is called"],
    [c("codex"), "How Codex is called"],
    [c("paths"), "Where runs and conversations are kept"],
  ],
})}
${p("Every key set to its default:")}
${ex("config/defaults.yaml", { label: "config.yaml" })}
${ul([
  `An unknown key is a warning and is ignored. ${c("codex.extra_args")} and ${c("claude.extra_args")}, from agentduo v1, are now ${c("codex.args")} and ${c("claude.args")}: the old names are ignored with a warning that says so.`,
  `A value of the wrong type is an error that names the file. Flags must be ${c("true")} or ${c("false")}: YAML reads ${c("yes")} and ${c("no")} as text, and those are rejected.`,
])}`,
    },
    {
      id: "agents",
      title: "agents",
      html: `${p("Each role takes " + c("codex") + " or " + c("claude") + ". Both may be the same agent. A change applies to the next run, never to one that is going (" + link("docs/configuration#when-it-applies", "when a change applies") + ").")}
${table({
  caption: "agents keys",
  head: ["Key", "Default", "Role"],
  rows: [
    [c("agents.planner"), c("codex"), "Writes the plan (PLAN) and signs it off (PLAN_FINALIZE)"],
    [c("agents.plan_reviewer"), c("claude"), "Critiques the plan (PLAN_REVIEW)"],
    [c("agents.implementer"), c("claude"), "Implements the plan and fixes findings (IMPLEMENT)"],
    [c("agents.code_reviewer"), c("codex"), "Reviews the changes (CODE_REVIEW)"],
  ],
})}
${ex("config/codex-implementer.yaml", { label: ".agentduo/config.yaml" })}`,
    },
    {
      id: "limits",
      title: "limits",
      html: `${p("Every limit applies to the next run, discussion or question; work that is going keeps the limits it started with.")}
${table({
  caption: "limits keys",
  head: ["Key", "Type", "Default", "Effect"],
  rows: [
    [c("max_planning_rounds"), "integer ≥ 1", c("4"), "Planning rounds without agreement before the run stops with " + c("max_planning_rounds") + " and asks you"],
    [c("max_review_rounds"), "integer ≥ 1", c("5"), "Implementation and review rounds before the run stops with " + c("max_review_rounds")],
    [c("max_discussion_rounds"), "integer ≥ 1", c("3"), c("/discuss") + ": reviews at most before Codex writes the final answer"],
    [c("max_retries"), "integer ≥ 0", c("1"), "Extra attempts for a pipeline step’s agent call that failed (timed out, went silent, or gave an answer that could not be read). Conversation turns get one attempt"],
    [c("max_consecutive_gate_failures"), "integer ≥ 1", c("3"), "Rounds in a row with a failing required gate before the run stops with " + c("gates_failing")],
    [c("agent_timeout_sec"), "integer ≥ 1", c("1800"), "Longest an agent call may take"],
    [c("agent_idle_timeout_sec"), "integer ≥ 0", c("900"), "Stops an agent that prints nothing for this long; " + c("0") + " turns the check off"],
    [c("gate_timeout_sec"), "integer ≥ 1", c("900"), "Timeout of a gate without a " + c("timeout_sec") + " of its own"],
    [c("max_diff_chars"), "integer ≥ 1", c("120000"), "Characters of the diff the code reviewer gets; a longer diff is cut, and the reviewer is told"],
    [c("max_gate_output_chars"), "integer ≥ 1", c("6000"), "Last characters of each gate’s output that go to the reviewer"],
  ],
})}
${p("The agents’ timeouts stop while a permission prompt waits for you.")}`,
    },
    {
      id: "quality-gates",
      title: "quality_gates",
      html: `${p("The review policy. These keys decide when a run is DONE, goes back to the implementer or stops for you. They run no commands; commands are under " + c("gates") + ".")}
${table({
  caption: "quality_gates keys",
  head: ["Key", "Type", "Default", "Effect"],
  rows: [
    [c("require_plan_approval"), "boolean", c("true"), "The planner signs off the plan after the critic approves it (PLAN_FINALIZE). With " + c("false") + ", the plan the critic approved is final"],
    [c("require_tests_pass"), "boolean", c("true"), "A failing required gate keeps the run from DONE and sends the work back"],
    [c("require_codex_approval"), "boolean", c("true"), "The code reviewer must approve. The name is historical: it applies to whichever agent reviews"],
    [c("stop_on_critical_issue"), "boolean", c("true"), "A critical finding stops the run with " + c("critical_finding") + " and asks you"],
    [c("blocking_severities"), "list of " + c("critical") + ", " + c("high") + ", " + c("medium") + ", " + c("low"), c("[critical, high]"), "Findings and plan issues of these severities block approval. A list: it replaces the earlier value"],
    [c("review_on_gate_failure"), "boolean", c("false"), "Review a round even though a required gate failed"],
  ],
})}
${ex("config/review-policy.yaml", { label: ".agentduo/config.yaml" })}
${p("How these decide the end of a run: " + link("docs/pipeline#review", "Code review") + ".")}`,
    },
    {
      id: "gates",
      title: "gates",
      html: `${p("A list of commands AgentDuo runs in the workspace, through the shell, after each implementation round (the VERIFY step). Default: none, and the run goes from IMPLEMENT straight to CODE_REVIEW.")}
${table({
  caption: "Fields of a gate",
  head: ["Field", "Type", "Default", "Effect"],
  rows: [
    [c("name"), "string, required", "—", "The gate’s name in the report and the logs; unique within " + c("gates")],
    [c("command"), "string, required", "—", "The command; it passes when it exits with 0"],
    [c("required"), "boolean", c("true"), "A failing required gate sends the work back; an optional one is only reported"],
    [c("timeout_sec"), "integer ≥ 1", c("limits.gate_timeout_sec"), "Timeout of this gate"],
  ],
})}
${p("Any other field is an error. " + c("gates") + " is a list, so a project’s list replaces the user config’s.")}
${ex("config/gates.yaml", { label: ".agentduo/config.yaml" })}
${note(p(c("gates") + " are commands that run; " + c("quality_gates") + " is the review policy, which runs nothing. More in " + link("docs/pipeline#gates", "Command gates") + "."))}`,
    },
    {
      id: "safety",
      title: "safety",
      html: `${table({
  caption: "safety keys",
  head: ["Key", "Type", "Default", "Effect"],
  rows: [
    [c("pause_before_implement"), "boolean", c("false"), "Once the plan is final, the run stops with " + c("plan_ready") + " so you can read it before anything is implemented"],
  ],
})}`,
    },
    {
      id: "claude",
      title: "claude",
      html: `${table({
  caption: "claude keys",
  head: ["Key", "Type", "Default", "Effect"],
  rows: [
    [c("bin"), "string", c("claude"), "The executable: a name looked up on the PATH, or a path"],
    [c("model"), "string or " + c("null"), c("null"), "Passed as " + c("--model") + "; " + c("null") + " lets Claude Code’s own settings decide"],
    [c("max_budget_usd"), "number &gt; 0 or " + c("null"), c("null"), "Passed as " + c("--max-budget-usd") + ": Claude stops a call that would cost more"],
    [c("permission_prompts"), c("ask") + " or " + c("deny"), c("ask"), c("ask") + " relays Claude’s permission prompts to you when someone can answer; " + c("deny") + " never asks, and Claude denies what its settings do not allow"],
    [c("args"), "list of strings", c("[--no-session-persistence]"), "Flags for every call to Claude. A list: it replaces the default, so list " + c("--no-session-persistence") + " again if you keep it"],
    [c("role_args"), "mapping of role to list of strings", c("{}"), "Flags for one role’s pipeline calls, after " + c("args") + ". Merged role by role across files. A conversation call gets only the implementer’s " + c("--permission-mode")],
  ],
})}
${p("The chat’s settings commands write " + c("--effort") + ", " + c("--allowedTools") + ", " + c("--disallowedTools") + " and " + c("--add-dir") + " into " + c("claude.args") + ", and " + c("/mode") + " writes " + c("--permission-mode") + " into " + c("claude.role_args.implementer") + ".")}`,
    },
    {
      id: "codex",
      title: "codex",
      html: `${table({
  caption: "codex keys",
  head: ["Key", "Type", "Default", "Effect"],
  rows: [
    [c("bin"), "string", c("codex"), "The executable: a name looked up on the PATH, or a path"],
    [c("model"), "string or " + c("null"), c("null"), "Passed as " + c("--model") + "; " + c("null") + " lets " + c("~/.codex/config.toml") + " decide"],
    [c("args"), "list of strings", c("[--ephemeral]"), "Flags for every call to Codex. A list: it replaces the default"],
    [c("role_args"), "mapping of role to list of strings", c("{}"), "Flags for one role’s pipeline calls, after " + c("args") + ". Merged role by role across files. Conversation calls do not get them"],
  ],
})}
${p(c("/codex model <name> <effort>") + " writes " + c("-c model_reasoning_effort=<effort>") + " into " + c("codex.args") + ", and " + c("/codex permissions") + " writes " + c("--sandbox") + ". " + c("codex exec") + " is read-only unless told otherwise, so a Codex implementer needs " + c("codex.role_args.implementer: [--sandbox, workspace-write]") + " or a sandbox set in Codex’s own config.")}`,
    },
    {
      id: "paths",
      title: "paths",
      html: `${table({
  caption: "paths keys",
  head: ["Key", "Type", "Default", "Effect"],
  rows: [
    [c("runs_dir"), "non-empty string", c(".agentduo/runs"), "Where runs, conversations and the workspace lock live. Relative to the workspace; " + c("~") + " is your home folder"],
  ],
})}
${p("Change it with every AgentDuo closed: the workspace lock lives there. The desktop app shows it but does not edit it. What is in it: " + link("docs/data-diagnostics#run-files", "Run files") + ".")}`,
    },
  ],
  related: ["docs/configuration", "docs/pipeline", "docs/permissions", "docs/cli"],
});
