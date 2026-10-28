// The sidebar's DOM. Every string an agent or the worker produced goes in through text nodes, never as markup,
// and every button sends a named action; nothing here can open a path or run a command of its own choosing.
import type { Activity, Message, PermissionAnswer } from "../../../src/events.js";
import { activityText, formatClock, formatDuration, messageHeadline, partyLabel, permissionAnswerText, roleLabel, statusIcon, usageText } from "../../../src/ui/format.js";
import type { DecisionChoice, WebviewCommand } from "../src/protocol.js";
import {
  canSubmit, decisionChoices, hasPending, permissionChoices, pipelineView, placeholder, type PendingDecision, type PendingPermission, type StageStatus,
  type StepCard, type TimelineItem, type ViewState,
} from "./state.js";

export interface Actions {
  submit(text: string): void;
  interrupt(): void;
  toggleEdits(): void;
  decide(id: string, decision: DecisionChoice, note: string | null): void;
  permit(id: string, answer: PermissionAnswer): void;
  command(name: WebviewCommand): void;
  draft(text: string): void;
}

type Child = Node | string | null | undefined | false;
type Props = { class?: string; title?: string; role?: string; label?: string; attrs?: Record<string, string> };

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.title) el.title = props.title;
  if (props.role) el.setAttribute("role", props.role);
  if (props.label) el.setAttribute("aria-label", props.label);
  for (const [k, v] of Object.entries(props.attrs ?? {})) el.setAttribute(k, v);
  for (const child of children) if (child !== null && child !== undefined && child !== false) el.append(typeof child === "string" ? document.createTextNode(child) : child);
  return el;
}

function button(label: string, onClick: () => void, o: { class?: string; title?: string; disabled?: boolean } = {}): HTMLButtonElement {
  const b = h("button", { class: o.class ?? "btn", title: o.title, attrs: { type: "button" } }, label);
  b.disabled = !!o.disabled;
  b.addEventListener("click", onClick);
  return b;
}

const ICON_CLASS: Record<Activity["status"], string> = { running: "run", ok: "ok", error: "err", denied: "warn" };

function activityRow(a: Activity): HTMLElement {
  const icon = a.status === "running" ? h("span", { class: "icon spin", attrs: { "aria-hidden": "true" } }, "◌") : h("span", { class: `icon ${ICON_CLASS[a.status]}`, attrs: { "aria-hidden": "true" } }, statusIcon(a.status));
  const status = { running: "running", ok: "done", error: "failed", denied: "denied" }[a.status];
  return h("li", { class: `act act-${a.kind}` }, icon, h("span", { class: "sr-only" }, `${status}: `), h("span", { class: "act-label" }, activityText(a)));
}

/** Where a message's artifact can be looked at, as a named command (never the file name the agent wrote). */
const MESSAGE_VIEWS: Partial<Record<Message["kind"], { command: WebviewCommand; label: string }>> = {
  plan: { command: "openPlan", label: "Open plan" },
  critique: { command: "openFeedback", label: "Open feedback" },
  approval: { command: "openFeedback", label: "Open feedback" },
  implementation: { command: "openChanges", label: "Open changes" },
  review: { command: "openReview", label: "Open review" },
};

function messageBlock(m: Message, actions: Actions): HTMLElement {
  const items = m.items.slice(0, 8);
  const view = MESSAGE_VIEWS[m.kind];
  return h("div", { class: "message" },
    h("div", { class: "headline" }, messageHeadline(m)),
    items.length ? h("ul", { class: "items" }, ...items.map((i) => h("li", {}, i))) : null,
    m.items.length > items.length ? h("div", { class: "muted" }, `… ${m.items.length - items.length} more`) : null,
    view ? button(view.label, () => actions.command(view.command), { class: "link" }) : null);
}

function who(step: StepCard): string {
  return [step.agent ? partyLabel(step.agent) : "", step.role ? roleLabel(step.role) : ""].filter(Boolean).join(" · ");
}

function stepCard(step: StepCard, actions: Actions, live: { now: number } | null): HTMLElement {
  const warn = step.entry?.kind === "warn";
  const meta = live ? formatClock((live.now - step.startedAt) / 1000) : [formatDuration(step.durationSec), usageText(step.costUsd, step.tokens)].filter(Boolean).join(" · ");
  const icon = live ? h("span", { class: "icon spin", attrs: { "aria-hidden": "true" } }, "◌") : h("span", { class: `icon ${warn ? "warn" : "ok"}`, attrs: { "aria-hidden": "true" } }, warn ? "▲" : "●");
  const visible = step.activities.filter((a) => a.kind !== "think");
  const shown = live ? visible.slice(-8) : visible;
  const list = shown.length ? h("ul", { class: "acts" }, ...shown.map(activityRow)) : null;
  const hidden = step.dropped + (visible.length - shown.length);
  const acts = live
    ? h("div", {}, hidden > 0 ? h("div", { class: "muted" }, `… ${hidden} earlier`) : null, list)
    : list ? h("details", { class: "acts-details" }, h("summary", {}, `${visible.length} activit${visible.length === 1 ? "y" : "ies"}${step.dropped ? ` (+${step.dropped} not shown)` : ""}`), list) : null;
  return h("article", { class: `step${live ? " live" : warn ? " warn" : " ok"}`, label: `${step.phase} round ${step.round}` },
    h("header", { class: "step-head" },
      icon,
      h("strong", { class: "phase" }, `${step.phase} r${step.round}`),
      h("span", { class: "who" }, who(step)),
      h("span", { class: "meta" }, meta)),
    acts,
    step.message ? messageBlock(step.message, actions) : null,
    step.entry && (!step.message || warn) ? h("div", { class: `entry${warn ? " warn-text" : ""}` }, `${step.entry.status}: ${step.entry.summary}`) : null);
}

const FINISH: Record<string, { icon: string; cls: string; text: string }> = {
  DONE: { icon: "✓", cls: "ok", text: "Done" },
  ABORTED: { icon: "■", cls: "warn", text: "Aborted" },
  HUMAN_REVIEW: { icon: "⏸", cls: "warn", text: "Waiting for your decision: /resume (or Resume) asks again" },
  INTERRUPTED: { icon: "⏸", cls: "warn", text: "Stopped: the run stays resumable" },
};

function timelineItem(item: TimelineItem, actions: Actions): HTMLElement {
  switch (item.kind) {
    case "user":
      return h("div", { class: "bubble user" }, h("span", { class: "speaker" }, "You"), h("div", { class: "text" }, item.text));
    case "info":
      return h("div", { class: `bubble info${item.tone === "error" ? " error" : ""}`, role: item.tone === "error" ? "alert" : undefined }, h("pre", { class: "text" }, item.text));
    case "run":
      return h("div", { class: "run-divider" }, h("span", { class: "run-id" }, `Run ${item.runId}`), h("span", { class: "run-task" }, item.task.split("\n")[0]!.slice(0, 200)));
    case "step":
      return stepCard(item.step, actions, null);
    case "warning":
      return h("div", { class: "note warn-text" }, h("span", { class: "icon warn", attrs: { "aria-hidden": "true" } }, "⚠"), h("span", { class: "sr-only" }, "warning: "), item.text);
    case "permission":
      return h("div", { class: `note ${item.answer.decision === "deny" ? "warn-text" : ""}` },
        h("span", { class: "icon", attrs: { "aria-hidden": "true" } }, "→"),
        `${partyLabel(item.agent)} (${roleLabel(item.role)}) ${item.label}: ${permissionAnswerText(item.answer, item.rules)}`);
    case "review":
      return h("div", { class: "note warn-text" }, `Decision deferred (${item.review.reason}): ${item.review.message}`);
    case "finish": {
      const f = FINISH[item.phase] ?? { icon: "•", cls: "", text: item.phase };
      return h("div", { class: `finish ${f.cls}`, role: "status" },
        h("div", {}, h("span", { class: `icon ${f.cls}`, attrs: { "aria-hidden": "true" } }, f.icon), ` ${f.text}${item.summary ? `: ${item.summary}` : ""}`),
        h("div", { class: "finish-actions" }, button("Report", () => actions.command("openReport"), { class: "link" }), button("Changes", () => actions.command("openChanges"), { class: "link" })));
    }
  }
}

function decisionCard(d: PendingDecision, generation: number, actions: Actions): HTMLElement {
  const note = h("textarea", { class: "input note-input", attrs: { rows: "2", placeholder: "Note for the agents (optional; with Resume or Revise)", "aria-label": "Note for the agents" } });
  const VIEW: Record<string, { command: WebviewCommand; label: string }> = {
    plan: { command: "openPlan", label: "Plan" }, review: { command: "openReview", label: "Review" }, feedback: { command: "openFeedback", label: "Feedback" },
    report: { command: "openReport", label: "Report" },
  };
  const choices = decisionChoices(d.review).map((c) => {
    const b = button(c.label, () => actions.decide(d.id, c.key, note.value.trim() || null), {
      class: c.key === "resume" ? "btn primary" : c.key === "abort" ? "btn danger" : "btn secondary", title: c.hint,
    });
    b.append(h("small", { class: "hint" }, c.hint));
    return b;
  });
  return h("section", { class: "card decision", role: "group", label: "Decision needed", attrs: { "data-generation": String(generation) } },
    h("h2", {}, h("span", { class: "icon warn", attrs: { "aria-hidden": "true" } }, "⚠"), ` Your decision is needed · ${d.review.reason}`),
    h("p", { class: "text" }, d.review.message),
    d.review.details.length ? h("ul", { class: "items" }, ...d.review.details.slice(0, 8).map((x) => h("li", {}, x))) : null,
    h("div", { class: "row wrap" },
      ...d.views.map((v) => (VIEW[v] ? button(VIEW[v]!.label, () => actions.command(VIEW[v]!.command), { class: "link" }) : null)),
      button("Changes", () => actions.command("openChanges"), { class: "link" })),
    note,
    h("div", { class: "choices" }, ...choices));
}

function permissionCard(p: PendingPermission, actions: Actions): HTMLElement {
  const r = p.request;
  const message = h("input", { class: "input", attrs: { type: "text", placeholder: "Message for the agent if you deny (optional)", "aria-label": "Message for the agent if you deny" } });
  const answer = (key: PermissionAnswer["decision"]): PermissionAnswer => (key === "deny" ? (message.value.trim() ? { decision: "deny", message: message.value.trim() } : { decision: "deny" }) : { decision: key });
  return h("section", { class: "card permission", role: "group", label: "Permission request" },
    h("h2", {}, h("span", { class: "icon warn", attrs: { "aria-hidden": "true" } }, "?"), ` ${partyLabel(p.agent)} (${roleLabel(p.role)}) asks to use ${r.tool}`),
    h("code", { class: "code" }, r.label),
    r.description ? h("p", { class: "text" }, r.description) : null,
    r.blockedPath ? h("p", { class: "muted" }, `path: ${r.blockedPath}`) : null,
    message,
    h("div", { class: "choices" }, ...permissionChoices(r).map((c) => button(c.label, () => actions.permit(r.id, answer(c.key)), {
      class: c.key === "once" ? "btn primary" : c.key === "deny" ? "btn secondary" : "btn", title: c.hint || undefined,
    }))));
}

const STATUS_TEXT: Record<string, string> = { idle: "Ready", running: "Running", paused: "Stopped" };
const STAGE_MARK: Record<StageStatus, string> = { done: " ✓", active: " ●", stopped: " ⏸", pending: "" };
const SESSION_TEXT: Partial<Record<ViewState["session"], string>> = {
  "no-folder": "No folder", "choose-folder": "Choose a folder", starting: "Starting…", stopped: "Not running", ended: "Session ended",
};

const PROBLEM_ACTIONS: Record<string, Array<{ command: WebviewCommand; label: string }>> = {
  node: [{ command: "configureNode", label: "Set Node path" }, { command: "restart", label: "Retry" }],
  worker: [{ command: "restart", label: "Retry" }, { command: "doctor", label: "Doctor" }],
  config: [{ command: "openConfiguration", label: "Open configuration" }, { command: "doctor", label: "Doctor" }],
  missing_cli: [{ command: "doctor", label: "Doctor" }, { command: "openConfiguration", label: "Open configuration" }],
  not_repo: [{ command: "doctor", label: "Doctor" }],
  environment: [{ command: "chooseWorkspace", label: "Choose folder" }],
  locked: [{ command: "restart", label: "Check again" }],
};

/** Builds the sidebar once, then updates it in place, re-creating only what changed (by identity, the reducer is immutable). */
export function createUi(root: HTMLElement, actions: Actions, initialDraft = ""): { update(s: ViewState): void; focusComposer(): void; tick(): void } {
  const wsName = h("span", { class: "ws-name" });
  const chip = h("span", { class: "chip", role: "status" });
  const header = h("header", { class: "top" },
    h("div", { class: "row" }, wsName, chip, h("span", { class: "spacer" }),
      button("New", () => actions.command("newTask"), { class: "btn small", title: "Leave a stopped run as it is and start a new task (/new)" }),
      button("Resume", () => actions.command("resume"), { class: "btn small", title: "Continue the latest stopped or waiting run (/resume)" })));
  const pipeline = h("ol", { class: "pipeline", label: "Workflow" });
  const rounds = h("div", { class: "rounds muted" });
  const problem = h("div", { class: "banner", role: "alert" });
  const timeline = h("main", { class: "timeline", attrs: { tabindex: "0", "aria-label": "Conversation and agent activity", "aria-live": "off" } });
  const live = h("div", { class: "live-slot" });
  const empty = h("div", { class: "empty muted" });
  const jump = button("New activity ↓", () => {
    pinned = true;
    timeline.scrollTop = timeline.scrollHeight;
    jump.hidden = true;
  }, { class: "btn small jump" });
  jump.hidden = true;
  const pending = h("div", { class: "pending" });
  const announce = h("div", { class: "sr-only", attrs: { "aria-live": "polite" } });
  const editsBtn = button("", () => actions.toggleEdits(), { class: "btn small toggle", title: "Switch Claude's edits between ask and auto (/edits)" });
  const toolbar = h("div", { class: "toolbar row wrap" },
    button("Plan", () => actions.command("openPlan"), { class: "link" }),
    button("Changes", () => actions.command("openChanges"), { class: "link" }),
    button("Report", () => actions.command("openReport"), { class: "link" }),
    h("span", { class: "spacer" }), editsBtn);
  const input = h("textarea", { class: "input composer-input", attrs: { rows: "3", "aria-label": "Message to agentduo" } });
  input.value = initialDraft;
  const stop = button("Stop", () => actions.interrupt(), { class: "btn secondary", title: "Stop the current step (Esc); your next message re-runs it" });
  const send = button("Send", () => submit(), { class: "btn primary" });
  const hint = h("span", { class: "muted hint-line" });
  const composer = h("footer", { class: "composer" }, toolbar, input, h("div", { class: "row" }, hint, h("span", { class: "spacer" }), stop, send));
  root.replaceChildren(header, pipeline, rounds, problem, timeline, pending, composer, announce);
  // The jump button floats at the bottom of the timeline (sticky), over the content, never pushing the composer.
  timeline.append(empty, live, jump);
  root.setAttribute("aria-busy", "false");

  let state: ViewState | null = null;
  let composing = false;
  // The reader is at the bottom: keep them there while the timeline grows or changes size (a question card opens,
  // the sidebar is resized). Scrolling up unpins it; scrolling back down pins it again.
  let pinned = true;
  const items = new Map<string, { item: TimelineItem; el: HTMLElement }>();
  let lastPending: { decision: unknown; permissions: unknown } = { decision: undefined, permissions: undefined };

  function submit(): void {
    if (!state || !canSubmit(state)) return;
    const text = input.value;
    // An empty message only means something for a stopped step (re-run it as is).
    if (!text.trim() && state.status !== "paused") return;
    actions.submit(text);
    input.value = "";
    actions.draft("");
  }

  input.addEventListener("compositionstart", () => {
    composing = true;
  });
  input.addEventListener("compositionend", () => {
    composing = false;
  });
  input.addEventListener("input", () => actions.draft(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || composing || e.keyCode === 229) return; // an IME is still composing: Enter picks a candidate
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && state?.status === "running") {
      e.preventDefault();
      actions.interrupt();
    }
  });
  timeline.addEventListener("scroll", () => {
    pinned = nearBottom();
    if (pinned) jump.hidden = true;
  });
  new ResizeObserver(() => {
    if (pinned) timeline.scrollTop = timeline.scrollHeight;
  }).observe(timeline);

  const nearBottom = () => timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 40;

  function renderHeader(s: ViewState): void {
    const name = s.workspace ? s.workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? s.workspace : "agentduo";
    wsName.textContent = name;
    wsName.title = s.workspace ?? "";
    const text = SESSION_TEXT[s.session] ?? (hasPending(s) ? "Needs you" : STATUS_TEXT[s.status]);
    chip.textContent = text;
    chip.className = `chip chip-${hasPending(s) ? "ask" : s.session === "stopped" ? "off" : s.status}`;
    const stages = pipelineView(s);
    pipeline.replaceChildren(...stages.map((p) => h("li", { class: `stage ${p.status}`, attrs: p.status === "active" ? { "aria-current": "step" } : {} },
      h("span", { class: "stage-label" }, `${p.label}${STAGE_MARK[p.status]}`),
      h("span", { class: "stage-who" }, [p.agent ? partyLabel(p.agent) : "", p.role ? roleLabel(p.role) : ""].filter(Boolean).join(" · ")))));
    pipeline.hidden = !stages.length;
    const usage = usageText(s.totals.costUsd + s.live.costUsd || undefined, s.totals.tokens + s.live.tokens || undefined);
    rounds.textContent = s.run
      ? [`plan ${s.planning.round}/${s.planning.limit || "–"}`, `impl ${s.impl.round}/${s.impl.limit || "–"}`, usage].filter(Boolean).join(" · ")
      : s.version ? `agentduo ${s.version}` : "";
  }

  function renderProblem(s: ViewState): void {
    problem.hidden = !s.problem;
    if (!s.problem) return;
    problem.replaceChildren(h("div", { class: "text" }, s.problem.message),
      h("div", { class: "row wrap" }, ...(PROBLEM_ACTIONS[s.problem.kind] ?? []).map((a) => button(a.label, () => actions.command(a.command), { class: "btn small" }))));
  }

  function renderTimeline(s: ViewState): void {
    const keep = new Set(s.timeline.map((i) => i.id));
    for (const [id, entry] of items) {
      if (!keep.has(id)) {
        entry.el.remove();
        items.delete(id);
      }
    }
    let before: Element = live;
    for (let i = s.timeline.length - 1; i >= 0; i--) {
      const item = s.timeline[i]!;
      let entry = items.get(item.id);
      if (!entry || entry.item !== item) {
        const el = timelineItem(item, actions);
        entry?.el.replaceWith(el);
        entry = { item, el };
        items.set(item.id, entry);
      }
      if (entry.el.nextElementSibling !== before || entry.el.parentElement !== timeline) timeline.insertBefore(entry.el, before);
      before = entry.el;
    }
    empty.hidden = s.timeline.length > 0 || !!s.current;
    empty.textContent = s.session === "no-folder" ? "Open a folder (inside a git repository) to work in."
      : s.session === "choose-folder" ? "This window has several folders: choose the one agentduo works in."
        : "Type a task below. Codex plans and reviews it; Claude critiques the plan and implements it. Nothing runs until you send one.";
    if (s.session === "choose-folder") empty.append(h("div", {}, button("Choose folder", () => actions.command("chooseWorkspace"), { class: "btn" })));
    renderLive(s);
  }

  function renderLive(s: ViewState): void {
    live.replaceChildren(...(s.current && (s.current.activities.length || s.status === "running" || s.current.message) ? [stepCard(s.current, actions, { now: Date.now() })] : []));
  }

  function renderPending(s: ViewState): void {
    if (lastPending.decision === s.decision && lastPending.permissions === s.permissions) return;
    const hadFocus = pending.contains(document.activeElement);
    lastPending = { decision: s.decision, permissions: s.permissions };
    const cards = [...s.permissions.map((p) => permissionCard(p, actions)), ...(s.decision ? [decisionCard(s.decision, s.generation, actions)] : [])];
    pending.replaceChildren(...cards);
    if (cards.length) {
      announce.textContent = s.permissions.length ? `${partyLabel(s.permissions[0]!.agent)} asks to use ${s.permissions[0]!.request.tool}` : "Your decision is needed";
      if (hadFocus || document.activeElement === input || document.activeElement === document.body) cards[0]!.querySelector<HTMLButtonElement>("button.primary")?.focus();
    } else if (hadFocus) input.focus();
  }

  function renderComposer(s: ViewState): void {
    input.placeholder = placeholder(s);
    input.disabled = !canSubmit(s);
    send.disabled = !canSubmit(s);
    stop.hidden = s.status !== "running";
    editsBtn.textContent = `Edits: ${s.edits}`;
    editsBtn.setAttribute("aria-pressed", String(s.edits === "auto"));
    hint.textContent = s.status === "running" ? "Enter: note · Esc: stop step" : s.status === "paused" ? "Enter: re-run · /new: leave it" : "Enter: send · Shift+Enter: new line";
  }

  return {
    update(s: ViewState): void {
      const prev = state;
      const grew = !prev || prev.timeline !== s.timeline || prev.current !== s.current;
      state = s;
      renderHeader(s);
      renderProblem(s);
      renderTimeline(s);
      renderPending(s);
      renderComposer(s);
      const last = s.timeline.at(-1);
      if (prev && last && prev.timeline.at(-1) !== last && (last.kind === "finish" || last.kind === "step")) {
        announce.textContent = last.kind === "finish" ? `Run ${last.phase.toLowerCase()}` : `${last.step.phase} ${last.step.entry?.status ?? "finished"}`;
      }
      if (!grew) return;
      if (pinned) timeline.scrollTop = timeline.scrollHeight;
      else jump.hidden = false;
    },
    focusComposer: () => input.focus(),
    tick(): void {
      if (state?.current) {
        renderLive(state);
        if (pinned) timeline.scrollTop = timeline.scrollHeight;
      }
    },
  };
}
