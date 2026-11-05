import { flowFigure } from "../../../lib/figures.mjs";

export const FLOW = {
  label: "The pipeline with its default roles. Each agent's role can be changed in the configuration.",
  plan: { title: "Plan and agree", back: "changes requested: back to Plan" },
  build: { title: "Build and review", back: "findings: back to Implement" },
  steps: [["Plan", "Codex"], ["Critique", "Claude Code"], ["Finalize", "Codex"], ["Implement", "Claude Code"], ["Verify", "your gates"], ["Review", "Codex"]],
  handoff: "the final plan goes to the implementer",
  done: "Approved, no blocking finding, required gates pass: done. You review and commit.",
  legend: ["Codex", "Claude Code", "your commands (optional)"],
  motion: ["Pause the animation", "Play the animation"],
};

export default ({ c, link, btn, code, table }, d) => ({
  htmlTitle: "AgentDuo: Codex and Claude Code, checking each other's work",
  title: "Let Codex and Claude Code check each other’s work",
  description: "AgentDuo connects Codex and Claude Code: one plans and reviews, the other critiques and implements. Desktop app, terminal command and VS Code extension.",
  lead: `<div class="lead"><p>AgentDuo connects the two coding CLIs you already use. Codex writes the plan and reviews the diff; Claude Code critiques the plan and implements it. You see every handoff and make the calls that need a person.</p></div>`,
  actions: `<div class="actions">${btn("download", d.release ? `Download AgentDuo ${d.release.version}` : "Download", true)}${btn("learn", "Get started")}</div>
<p class="hero-meta">A desktop app for macOS, Windows and Linux, the ${c("duo")} command for your terminal, and a VS Code extension. Free and open source; you bring your own Claude Code and Codex accounts.</p>`,
  visual: flowFigure(FLOW),
  sections: [
    {
      id: "why",
      title: "What two agents give you that one does not",
      html: `<ul class="benefits">
<li><strong>A plan before any code</strong>Codex writes goals, scope, steps, acceptance criteria and risks. Claude Code checks that the plan can be built before a file changes, and Codex signs off the final version.</li>
<li><strong>A second reader for every diff</strong>The reviewer gets the real diff of your workspace between snapshots, not the implementer’s summary of it, and reports findings by severity.</li>
<li><strong>Your checks, not the agents’ word</strong>Add your own commands as gates (${c("npm test")}, a linter). They run after each implementation round and their results go to the reviewer.</li>
<li><strong>You decide what a person should decide</strong>When a round limit is reached, an agent blocks, or a critical finding appears, the run stops and asks you: resume, revise with a note, or abort.</li>
<li><strong>No new rules to trust</strong>AgentDuo passes only the flags its protocol needs. What each agent may do comes from its own CLI settings and your repository’s ${c("AGENTS.md")} or ${c("CLAUDE.md")}.</li>
<li><strong>Nothing is committed for you</strong>The changes stay in your working tree. Review them with ${c("git diff")} or the diff view, then commit them yourself.</li>
</ul>`,
    },
    {
      id: "how-they-work-together",
      title: "How the two agents work together",
      html: `<p class="band-lead">A pipeline run has two stages. In the first, the agents agree on a plan; in the second, one builds it and the other reviews it until the review approves.</p>
<div class="split">
<div>
<p><strong>Plan and agree.</strong> Codex (the planner) writes a plan. Claude Code (the plan critic) checks it against the repository and either approves it or requests changes. Codex revises and, once the critic approves, finalizes it. If they do not agree within ${c("limits.max_planning_rounds")} rounds (4 by default), the run asks you.</p>
</div>
<div>
<p><strong>Build and review.</strong> Claude Code (the implementer) builds the final plan. Your gates run, if you configured any. Codex (the code reviewer) reviews the diff; Claude Code fixes the findings, round after round, for up to ${c("limits.max_review_rounds")} rounds (5 by default).</p>
</div>
</div>
<p>Each agent is a real CLI process with your settings, run by AgentDuo in your workspace. Which CLI plays which role is configurable: you can make Codex implement and Claude Code review. ${link("docs/concepts", "Read how AgentDuo works")}.</p>`,
    },
    {
      id: "interfaces",
      className: "band-wide",
      title: "Three ways to run it, one engine",
      html: `<p class="band-lead">The desktop app, the terminal command and the VS Code extension run the same engine, read the same configuration files and keep runs in the same folder, so a run stopped in one can be resumed in another.</p>
<div class="interfaces">
<div class="interface"><h3>Desktop app</h3><p>A window with your projects and conversations, the three-way chat, an inspector for the plan, the diff and the checks, and Settings. Chat without opening a folder; open a project when you want to work on code.</p><p class="needs">Needs Claude Code and Codex installed and signed in. No Node installation of its own.</p><p>${link("learn/desktop", "Start with the desktop app")}</p></div>
<div class="interface"><h3>Terminal: ${c("duo")}</h3><p>The chat in your terminal with a live view of both agents, plus commands for scripts and CI: ${c('duo "<task>"')}, ${c("duo resume")}, ${c("duo status")}.</p><p class="needs">Needs Node.js 22.12 or later: ${c("npm i -g agentduo")}.</p><p>${link("learn/cli", "Start in the terminal")}</p></div>
<div class="interface"><h3>VS Code extension</h3><p>Each conversation in an editor tab, decisions and permission prompts above the composer, and the run’s changes in VS Code’s diff editor.</p><p class="needs">Needs VS Code 1.95 or later and Node.js 22.12 or later.</p><p>${link("learn/vscode", "Start in VS Code")}</p></div>
</div>`,
    },
    {
      id: "example",
      className: "band-wide",
      title: "What a session looks like",
      html: `<p class="band-lead">Ask either agent a question, let both discuss it, then hand the task to the pipeline. This is the terminal chat; the desktop app and the extension show the same conversation.</p>
<div class="split">
<div>
${code(`› /claude What would it take to add refresh tokens here?
  … Claude Code answers, with the whole conversation in context …
› Is that plan safe for the existing sessions?
  … Codex answers, with Claude's answer in its context …
› /discuss Should refresh tokens rotate on every use?
  … one answers, the other reviews until they agree; Codex sums up …
› /pipeline Add refresh tokens as discussed
  … Codex plans, Claude critiques, Claude implements, Codex reviews …`, { label: "duo" })}
</div>
<div>
${code(`● PLAN r1  Codex (planner)                      32s · 33k tok
  └ Codex → Claude  Plan v1 "Add subtraction" · 3 steps
● PLAN_REVIEW r1  Claude (plan critic)          48s · $0.17
  └ Claude → Codex  approved · 2 suggestion(s)
 PLAN ✓ › CRITIQUE ✓ › FINALIZE ✓ › IMPLEMENT ● r1 › VERIFY › REVIEW`, { label: "The live view of a run (from the repository README)" })}
<p>Messages go to the agent named under the input. ${c("/claude")} and ${c("/codex")} pick who answers, ${c("/discuss")} has both work out one answer, and ${c("/pipeline")} runs the full workflow. ${link("docs/conversations", "Learn the chat")}.</p>
</div>
</div>`,
    },
    {
      id: "before-you-start",
      title: "Before you start",
      html: `${table({
        caption: "What AgentDuo needs",
        head: ["You need", "Why"],
        rows: [
          ["Claude Code CLI, signed in", "Claude Code is one of the two agents. AgentDuo runs your installed CLI with your account."],
          ["Codex CLI, signed in", "Codex is the other agent, also run as your installed CLI with your account."],
          ["A Claude and an OpenAI plan or API access", "AgentDuo includes no subscription and no API credit. Each agent’s usage counts against your own plan or key."],
          ["Git, for the pipeline", "A pipeline run snapshots and diffs your files, so the workspace must be inside a Git repository. Chat and discussions work in any folder."],
          ["Node.js 22.12 or later, for the terminal and VS Code", "The desktop app brings its own runtime for the engine; the npm package and the extension use your Node."],
        ],
      })}
<div class="actions">${btn("learn/prerequisites", "Check what you need", true)}${btn("download", "See all downloads")}</div>`,
    },
  ],
});
