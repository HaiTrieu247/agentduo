// Figures shared by the languages; each passes its own words.
import { esc } from "./render.mjs";

/**
 * The pipeline with its default roles, as two stages of three steps. It is an ordered list, so it reads in order
 * without the picture; the colours say which agent does a step (teal Codex, orange Claude Code, dashed: your gates).
 * With JavaScript, site.js runs a dot through it in a run's order and gives it a button with `t.motion`'s labels.
 * `t`: { label, plan: { title, back }, build: { title, back }, steps: [[name, who] × 6], handoff, done, legend: [codex, claude, gates], motion: [pause, play] }
 */
export function flowFigure(t, id = "flow") {
  const kinds = ["codex", "claude", "codex", "claude", "gates", "codex"];
  const step = (i) => `<li class="flow-step agent-${kinds[i]}"><span class="flow-name">${esc(t.steps[i][0])}</span><span class="flow-who">${esc(t.steps[i][1])}</span></li>`;
  return `<figure class="flow" aria-labelledby="${id}-caption" data-pause="${esc(t.motion[0])}" data-play="${esc(t.motion[1])}">
<div class="flow-stage flow-plan"><p class="flow-stage-title">${esc(t.plan.title)}</p><ol class="flow-steps">${[0, 1, 2].map(step).join("")}</ol><p class="flow-back"><span>${esc(t.plan.back)}</span></p></div>
<p class="flow-handoff">${esc(t.handoff)}</p>
<div class="flow-stage flow-build"><p class="flow-stage-title">${esc(t.build.title)}</p><ol class="flow-steps" start="4">${[3, 4, 5].map(step).join("")}</ol><p class="flow-back"><span>${esc(t.build.back)}</span></p></div>
<p class="flow-done">${esc(t.done)}</p>
<figcaption id="${id}-caption">${esc(t.label)}<ul class="flow-legend"><li class="agent-codex">${esc(t.legend[0])}</li><li class="agent-claude">${esc(t.legend[1])}</li><li class="agent-gates">${esc(t.legend[2])}</li></ul></figcaption>
</figure>`;
}
