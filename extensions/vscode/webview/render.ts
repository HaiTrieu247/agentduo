// The sidebar's DOM. Every string an agent or the worker produced goes in through text nodes, never as markup,
// and every button sends a named action; nothing here can open a path or run a command of its own choosing.
import {
  AGENT_NAMES, CODEX_PRESETS, COMMANDS, complete, isPermissionMode, MODE_INFO, modeLabel, PERMISSION_MODES, type Backend, type Completion, type PermissionMode,
  type SettingCommand,
} from "../../../src/core/commands.js";
import { ATTACHMENT_LIMITS, attachmentDetail, formatBytes, type Attachment } from "../../../src/core/attachment-types.js";
import type { UsageReport } from "../../../src/core/usage.js";
import type { Activity, Agent, Message, ModelIdentity, Party, PermissionAnswer } from "../../../src/events.js";
import {
  discussionAuthor, discussionDoing, discussionOutcome, discussionStepText, formatClock, formatDuration, modelText, partyLabel, permissionAnswerText, PROVIDERS, roleLabel, usageRows,
  usageText, verdictText, whoLabel,
} from "../../../src/ui/format.js";
import type { DecisionChoice, Route, SettingRequest, WebviewCommand } from "../src/protocol.js";
import { h, icon, providerMark, type Child } from "./dom.js";
import { parseInline, parseMarkdown, type Block, type Inline } from "./markdown.js";
import {
  activityParts, canSubmit, decisionChoices, effortOptions, hasPending, isBusy, modelOptions, permissionChoices, pipelineView, placeholder, readyAttachments, runInProgress,
  sendStops, uploading, type AttachmentChip, type DiscussionCard, type PendingDecision, type PendingPermission, type PickOption, type StageStatus, type StepCard, type TimelineItem,
  type TurnCard, type ViewState,
} from "./state.js";
import { FileQueue } from "./uploads.js";

export interface Actions {
  /** `attachments`: the ids of the ready files that go with it. */
  submit(text: string, route: Route, attachments: string[]): void;
  /** Attach: the host asks for files. */
  attach(): void;
  /** A file pasted or dropped, as base64. */
  upload(file: { key: string; name: string; data: string }): void;
  /** A file of the composer removed (its ✕). */
  removeFile(key: string): void;
  recipient(backend: Backend): void;
  setting(request: SettingRequest): void;
  interrupt(): void;
  /** Shift+Tab: Claude's next permission mode. */
  cycleMode(): void;
  /** The usage panel's Refresh: look the usage up again. */
  usage(): void;
  decide(id: string, decision: DecisionChoice, note: string | null): void;
  permit(id: string, answer: PermissionAnswer): void;
  command(name: WebviewCommand): void;
  draft(text: string): void;
}

function button(label: string, onClick: () => void, o: { class?: string; title?: string; disabled?: boolean } = {}): HTMLButtonElement {
  const b = h("button", { class: o.class ?? "btn", title: o.title, attrs: { type: "button" } }, label);
  b.disabled = !!o.disabled;
  b.addEventListener("click", onClick);
  return b;
}

/** A text button that opens something, with an icon before its label. */
function linkButton(label: string, iconName: string, onClick: () => void): HTMLButtonElement {
  const b = h("button", { class: "link", attrs: { type: "button" } }, icon(iconName), label);
  b.addEventListener("click", onClick);
  return b;
}

const isAgent = (p: Party | undefined): p is Agent => p === "claude" || p === "codex";

/** The mark, the agent and its maker: the identity of an answer, also without colour or the mark. */
function speaker(agent: Agent): HTMLElement {
  const p = PROVIDERS[agent];
  return h("span", { class: `speaker-id speaker-${agent}` }, providerMark(agent), h("strong", {}, p.agent), h("span", { class: "company" }, p.company));
}

/** Who plays a step: an agent with its mark, or the gates and agentduo itself with an icon. */
function party(p: Party | undefined): HTMLElement {
  if (isAgent(p)) return speaker(p);
  return h("span", { class: "speaker-id" }, icon(p === "gates" ? "checklist" : "hubot"), h("strong", {}, partyLabel(p) || "agentduo"));
}

function modelTitle(m: ModelIdentity): string {
  const source = m.source ? `source: ${m.source}` : "";
  return [modelText(m), source, m.reason ?? ""].filter(Boolean).join("\n");
}

/** The model's own name, short enough for a chip; modelTitle tells the rest. */
function shortModel(m: ModelIdentity | null | undefined): string {
  if (!m || m.status === "resolving") return "…";
  return m.resolved ?? m.configured ?? m.requested ?? "default";
}

// ------------------------------------------------------------------ markdown
function inlineNodes(nodes: Inline[]): Node[] {
  return nodes.map((n): Node => {
    switch (n.type) {
      case "text":
        return document.createTextNode(n.text);
      case "break":
        return h("br");
      case "code":
        return h("code", { class: "md-code" }, n.text);
      case "strong":
        return h("strong", {}, ...inlineNodes(n.children));
      case "em":
        return h("em", {}, ...inlineNodes(n.children));
      case "del":
        return h("del", {}, ...inlineNodes(n.children));
      case "link":
        // Shown, never followed: the target is only its tooltip.
        return h("span", { class: "md-link", title: n.href }, ...inlineNodes(n.children));
    }
  });
}

const HEADINGS = ["h3", "h4", "h5", "h6"] as const;

function blockNodes(blocks: Block[]): HTMLElement[] {
  return blocks.map((b): HTMLElement => {
    switch (b.type) {
      case "paragraph":
        return h("p", {}, ...inlineNodes(b.children));
      case "heading":
        return h(HEADINGS[Math.min(b.level, HEADINGS.length) - 1]!, { class: `md-h md-h${b.level}` }, ...inlineNodes(b.children));
      case "code":
        return h("pre", { class: "md-pre", label: b.lang ? `${b.lang} code` : "code", attrs: { tabindex: "0" } }, h("code", {}, b.text));
      case "list": {
        const el = h(b.ordered ? "ol" : "ul", { class: "md-list" }, ...b.items.map((item) => h("li", {}, ...blockNodes(item))));
        if (b.ordered && b.start !== 1) el.setAttribute("start", String(b.start));
        return el;
      }
      case "quote":
        return h("blockquote", { class: "md-quote" }, ...blockNodes(b.children));
      case "rule":
        return h("hr", { class: "md-rule" });
      case "table": {
        const cell = (tag: "th" | "td", content: Inline[], n: number) => h(tag, { class: b.align[n] ? `align-${b.align[n]}` : undefined }, ...inlineNodes(content));
        return h("div", { class: "md-table-wrap", attrs: { tabindex: "0" } }, h("table", { class: "md-table" },
          h("thead", {}, h("tr", {}, ...b.head.map((c, n) => cell("th", c, n)))),
          h("tbody", {}, ...b.rows.map((r) => h("tr", {}, ...r.map((c, n) => cell("td", c, n)))))));
      }
    }
  });
}

/** An answer as the agent wrote it: its Markdown as elements and text nodes, never as markup. */
export function markdownBody(text: string): HTMLElement {
  return h("div", { class: "md" }, ...blockNodes(parseMarkdown(text)));
}

const inlineText = (text: string): Node[] => inlineNodes(parseInline(text));

// ------------------------------------------------------------------ the rail: activities, steps, answers
const STATUS_CLASS: Record<Activity["status"], string> = { running: "s-run", ok: "s-ok", error: "s-err", denied: "s-warn" };
const STATUS_WORD: Record<Activity["status"], string> = { running: "running", ok: "done", error: "failed", denied: "denied" };

/** One stop on an answer's or a step's rail: a dot on the line, then what happened. */
function row(cls: string, ...children: Child[]): HTMLElement {
  return h("li", { class: `row ${cls}` }, h("span", { class: "dot", attrs: { "aria-hidden": "true" } }), h("div", { class: "row-body" }, ...children));
}

function activityRow(a: Activity): HTMLElement {
  const p = activityParts(a);
  return row(`row-act act-${a.kind} ${STATUS_CLASS[a.status]}`,
    h("span", { class: "sr-only" }, `${STATUS_WORD[a.status]}: `),
    p.tool ? h("strong", { class: "tool" }, p.tool) : null,
    h("span", { class: "tool-text" }, p.text),
    p.diff ? h("span", { class: "diff" }, h("span", { class: "diff-add" }, `+${p.diff.added}`), h("span", { class: "diff-del" }, `−${p.diff.removed}`)) : null);
}

/** A step's or an answer's activities: the latest ones while it works, folded into one row once it is done. */
function activityRows(activities: Activity[], dropped: number, live: boolean): HTMLElement[] {
  const visible = activities.filter((a) => a.kind !== "think");
  if (live) {
    const shown = visible.slice(-8);
    const hidden = dropped + visible.length - shown.length;
    return [...(hidden > 0 ? [row("row-more", h("span", { class: "muted" }, `${hidden} earlier`))] : []), ...shown.map(activityRow)];
  }
  if (!visible.length) return [];
  const n = visible.length;
  return [row("row-fold", h("details", {},
    h("summary", {}, `${n} action${n === 1 ? "" : "s"}${dropped ? ` (+${dropped} not shown)` : ""}`, icon("chevron-right", "fold-chevron")),
    h("ol", { class: "rail" }, ...visible.map(activityRow))))];
}

/** While nothing it does shows yet, a live card says it is at work. */
function working(activities: Activity[], text: string): HTMLElement[] {
  return activities.some((a) => a.status === "running" && a.kind !== "think") ? [] : [row("row-text s-run", h("span", { class: "muted" }, text))];
}

/** Where a message's artifact can be looked at, as a named command (never the file name the agent wrote). */
const MESSAGE_VIEWS: Partial<Record<Message["kind"], { command: WebviewCommand; label: string }>> = {
  plan: { command: "openPlan", label: "Open plan" },
  critique: { command: "openFeedback", label: "Open feedback" },
  approval: { command: "openFeedback", label: "Open feedback" },
  implementation: { command: "openChanges", label: "Open changes" },
  review: { command: "openReview", label: "Open review" },
};

function messageRow(m: Message, actions: Actions): HTMLElement {
  const items = m.items.slice(0, 8);
  const view = MESSAGE_VIEWS[m.kind];
  return row("row-msg",
    h("div", { class: "handoff" }, `${partyLabel(m.from)} → ${partyLabel(m.to)}`),
    h("div", { class: "headline" }, ...inlineText(m.headline)),
    items.length ? h("ul", { class: "md-list items" }, ...items.map((i) => h("li", {}, ...inlineText(i)))) : null,
    m.items.length > items.length ? h("div", { class: "muted small" }, `… ${m.items.length - items.length} more`) : null,
    view ? linkButton(view.label, "go-to-file", () => actions.command(view.command)) : null);
}

/** PLAN_FINALIZE → Plan finalize: phases and the configured labels are upper case. */
const stageName = (label: string) => label.charAt(0) + label.slice(1).toLowerCase().replace(/_/g, " ");

function cardHead(who: HTMLElement, extra: Child[], meta: string): HTMLElement {
  return h("header", { class: "turn-head" }, who, ...extra, h("span", { class: "meta" }, meta));
}

function stepCard(step: StepCard, actions: Actions, live: { now: number } | null): HTMLElement {
  const warn = step.entry?.kind === "warn";
  const time = live ? formatClock((live.now - step.startedAt) / 1000) : formatDuration(step.durationSec);
  const meta = [`${stageName(step.phase)} r${step.round}`, time, live ? "" : usageText(step.costUsd, step.tokens)].filter(Boolean).join(" · ");
  const rows = [
    ...activityRows(step.activities, step.dropped, !!live),
    ...(live && !step.message ? working(step.activities, "Working…") : []),
    step.message ? messageRow(step.message, actions) : null,
    step.entry && (!step.message || warn) ? row(`row-text ${warn ? "s-warn" : "s-ok"}`, h("span", { class: warn ? "warn-text" : "" }, `${step.entry.status}: ${step.entry.summary}`)) : null,
  ];
  return h("article", { class: `turn${live ? " live" : warn ? " warn" : ""}`, label: `${step.phase} round ${step.round}` },
    cardHead(party(step.agent), step.role ? [h("span", { class: "role" }, roleLabel(step.role))] : [], meta),
    h("ol", { class: "rail" }, ...rows));
}

/** A review's verdict, as a word: it never relies on its colour. */
function verdictChip(place: NonNullable<TurnCard["discussion"]>): HTMLElement | null {
  if (place.step !== "critique") return null;
  return h("span", { class: `verdict verdict-${place.verdict ?? "none"}` }, verdictText(place.verdict));
}

function answerCard(t: TurnCard, live: { now: number } | null): HTMLElement {
  const p = PROVIDERS[t.backend];
  const time = live ? formatClock((live.now - t.startedAt) / 1000) : formatDuration(t.durationSec);
  const meta = [time, live ? "" : usageText(t.costUsd, t.tokens)].filter(Boolean).join(" · ");
  const place = t.discussion;
  // In a discussion the step says what the turn is; the model is in the tooltip.
  const head = place
    ? [h("span", { class: "role", title: modelTitle(t.model) }, live ? discussionDoing(place) : discussionStepText(place)), verdictChip(place)]
    : [h("span", { class: "model", title: modelTitle(t.model) }, shortModel(t.model))];
  const body = live ? working(t.activities, place?.step === "critique" ? "Reviewing…" : place?.step === "synthesis" ? "Synthesizing…" : "Thinking…")
    : t.status === "success" ? [row("row-text row-answer", markdownBody(t.answer ?? ""))]
      : t.status === "interrupted" ? [row("row-text s-warn", h("span", { class: "warn-text" }, "Stopped before it answered."))]
        : [row("row-text s-err", h("span", { class: "err-text", role: "alert" }, `No answer: ${t.error ?? "the call failed"}`))];
  return h("article", { class: `turn turn-${t.backend}${live ? " live" : ""}${!live && t.status !== "success" ? " failed" : ""}`, label: `${p.agent} (${p.company}) answer` },
    cardHead(speaker(t.backend), head, meta),
    h("ol", { class: "rail" }, ...activityRows(t.activities, t.dropped, !!live), ...body));
}

const OUTCOME_ICON: Record<NonNullable<DiscussionCard["status"]>, { icon: string; tone: string }> = {
  agreed: { icon: "pass-filled", tone: "ok" }, disputed: { icon: "warning", tone: "warn" }, interrupted: { icon: "debug-pause", tone: "warn" }, error: { icon: "error", tone: "err" },
};

/**
 * A /discuss: while it goes on, each turn whole as it finishes and the one under way; once it is over, how it ended,
 * its turns folded, and its answer (the response) whole.
 */
function discussionCard(d: DiscussionCard, live: { now: number; turn: TurnCard | null } | null): HTMLElement {
  const who = `${PROVIDERS[d.answerer].agent} answers · ${PROVIDERS[d.critic].agent} reviews`;
  const title = h("span", { class: "speaker-id" }, icon("comment-discussion"), h("strong", {}, "Discussion"));
  if (live) {
    const meta = [formatClock((live.now - d.startedAt) / 1000), `at most ${d.maxRounds} review${d.maxRounds === 1 ? "" : "s"}`].join(" · ");
    return h("article", { class: "turn discussion live", label: "Discussion" },
      cardHead(title, [h("span", { class: "role" }, who)], meta),
      h("div", { class: "discussion-turns" }, ...d.turns.map((t) => answerCard(t, null)), live.turn ? answerCard(live.turn, live) : null));
  }
  const o = OUTCOME_ICON[d.status ?? "error"];
  const status = { status: d.status ?? "error", answerer: d.answerer, critic: d.critic, rounds: d.rounds ?? 0 };
  const meta = [formatDuration(d.durationSec), usageText(d.costUsd, d.tokens)].filter(Boolean).join(" · ");
  const n = d.turns.length;
  const by = discussionAuthor(d);
  return h("article", { class: `turn discussion outcome-${o.tone}`, label: `Discussion: ${discussionOutcome(status)}` },
    cardHead(title, [h("span", { class: "role" }, who)], meta),
    h("div", { class: `discussion-outcome note-${o.tone}` }, icon(o.icon, "note-icon"), h("span", {}, discussionOutcome(status)), d.error ? h("span", { class: "err-text" }, `: ${d.error}`) : null),
    n ? h("details", { class: "discussion-fold" }, h("summary", {}, `${n} turn${n === 1 ? "" : "s"}`, icon("chevron-right", "fold-chevron")),
      h("div", { class: "discussion-turns" }, ...d.turns.map((t) => answerCard(t, null)))) : null,
    d.answer !== null && d.answer !== undefined
      ? h("section", { class: "discussion-final", label: "Final answer" },
        h("div", { class: "final-head" }, providerMark(by), h("strong", {}, "Final answer"), h("span", { class: "muted" }, `· ${PROVIDERS[by].agent}`)),
        markdownBody(d.answer))
      : null);
}

/** A line of its own in the timeline: what happened around the agents' work. */
function note(iconName: string, tone: "" | "ok" | "warn" | "err", ...children: Child[]): HTMLElement {
  return h("div", { class: `note${tone ? ` note-${tone}` : ""}` }, icon(iconName, "note-icon"), h("div", { class: "note-text" }, ...children));
}

const FINISH: Record<string, { icon: string; tone: "ok" | "warn"; text: string }> = {
  DONE: { icon: "pass-filled", tone: "ok", text: "Done" },
  ABORTED: { icon: "circle-slash", tone: "warn", text: "Aborted" },
  HUMAN_REVIEW: { icon: "debug-pause", tone: "warn", text: "Waiting for your decision: Resume (or /resume) asks again" },
  INTERRUPTED: { icon: "debug-pause", tone: "warn", text: "Stopped: Resume (or /resume) continues the run" },
};

function timelineItem(item: TimelineItem, actions: Actions): HTMLElement {
  switch (item.kind) {
    case "user": {
      const to = item.pipeline ? "Pipeline" : item.discuss ? "Discuss" : item.to ? AGENT_NAMES[item.to] : null;
      return h("div", { class: "user-msg" },
        h("div", { class: "user-to" }, h("span", { class: "sr-only" }, "You"), to ? ` → ${to}` : ""),
        item.text ? h("div", { class: "user-text" }, item.text) : null,
        item.attachments?.length ? h("ul", { class: "files sent", label: "Attached files" }, ...item.attachments.map((a) => fileChip({ name: a.name, detail: attachmentDetail(a), attachment: a }))) : null);
    }
    case "info":
      return h("div", { class: `info-note${item.tone === "error" ? " error" : ""}`, role: item.tone === "error" ? "alert" : undefined },
        icon(item.tone === "error" ? "error" : "info", "note-icon"), h("pre", { class: "text" }, item.text));
    case "run":
      return h("div", { class: "run-divider" }, h("span", { class: "run-id" }, `Run ${item.runId}`), h("span", { class: "run-task" }, item.task.split("\n")[0]!.slice(0, 200)));
    case "step":
      return stepCard(item.step, actions, null);
    case "answer":
      return answerCard(item.turn, null);
    case "discussion":
      return discussionCard(item.discussion, null);
    case "warning":
      return note("warning", "warn", h("span", { class: "sr-only" }, "warning: "), item.text);
    case "permission":
      return note(item.answer.decision === "deny" ? "circle-slash" : "pass", item.answer.decision === "deny" ? "warn" : "",
        `${whoLabel(item.agent, item.role)} ${item.label}: ${permissionAnswerText(item.answer, item.rules)}`);
    case "review":
      return note("debug-pause", "warn", `Decision deferred (${item.review.reason}): ${item.review.message}`);
    case "finish": {
      const f = FINISH[item.phase] ?? { icon: "circle-outline", tone: "warn", text: item.phase };
      return h("div", { class: `finish finish-${f.tone}`, role: "status" },
        icon(f.icon, "note-icon"),
        h("div", { class: "note-text" }, h("strong", {}, f.text), item.summary ? `: ${item.summary}` : "",
          h("div", { class: "finish-actions" }, linkButton("Report", "output", () => actions.command("openReport")), linkButton("Changes", "git-compare", () => actions.command("openChanges")))));
    }
  }
}

// ------------------------------------------------------------------ attached files
/** The image URIs the host granted, by attachment id (null: the copy is gone); the previews of files still being stored, by key. */
const imageUris = new Map<string, string | null>();
const previews = new Map<string, string>();

const FILE_ICONS: Array<[RegExp, string]> = [[/^image\//, "file-media"], [/^application\/pdf$/, "file-pdf"], [/^(text\/|application\/(json|xml|yaml|toml))/, "file-code"]];
const fileIcon = (mediaType: string | null) => icon(FILE_ICONS.find(([re]) => mediaType && re.test(mediaType))?.[1] ?? "file");

/** A thumbnail: the image, once the host granted its copy, or a preview while it is stored; an icon otherwise. */
function paintThumb(thumb: HTMLElement): void {
  const id = thumb.dataset.attachment;
  const key = thumb.dataset.key;
  const src = (id ? imageUris.get(id) : undefined) ?? (key ? previews.get(key) : undefined);
  const gone = !!id && imageUris.get(id) === null;
  thumb.classList.toggle("missing", gone);
  thumb.title = gone ? "This copy is no longer there" : "";
  if (src) {
    const img = thumb.querySelector("img") ?? h("img", { attrs: { alt: "" } });
    if (img.getAttribute("src") !== src) img.setAttribute("src", src);
    thumb.replaceChildren(img);
  } else thumb.replaceChildren(icon(gone ? "warning" : thumb.dataset.icon ?? "file"));
}

/** One attached file: its thumbnail or icon, its name (as text), what it is, and a remove control when it can go. */
function fileChip(o: { name: string; detail: string; attachment: Attachment | null; key?: string; status?: AttachmentChip["status"]; remove?: () => void }): HTMLElement {
  const a = o.attachment;
  const thumb = h("span", { class: "file-thumb", attrs: { "aria-hidden": "true" } });
  if (a?.image) thumb.dataset.attachment = a.id;
  if (o.key) thumb.dataset.key = o.key;
  const iconEl = o.status === "uploading" ? icon("loading", "codicon-modifier-spin") : o.status === "error" ? icon("error") : fileIcon(a?.mediaType ?? null);
  thumb.dataset.icon = iconEl.className.replace(/^codicon codicon-/, "").split(" ")[0]!;
  thumb.append(iconEl);
  if (a?.image || (o.key && previews.has(o.key))) paintThumb(thumb);
  const x = o.remove ? h("button", { class: "icon-btn file-x", title: `Remove ${o.name}`, label: `Remove ${o.name}`, attrs: { type: "button" } }, icon("close")) : null;
  x?.addEventListener("click", o.remove!);
  return h("li", { class: `file-chip${o.status ? ` file-${o.status}` : ""}`, title: o.name },
    thumb, h("span", { class: "file-text" }, h("span", { class: "file-name" }, o.name), h("span", { class: `file-detail${o.status === "error" ? " err-text" : ""}` }, o.detail)), x);
}

/**
 * The media type of the raster image whose base64 `data` this is, by its first bytes, or null: only such an image is
 * previewed, never SVG or HTML, whatever the file says it is.
 */
export function rasterType(data: string): string | null {
  let head = "";
  try {
    head = atob(data.slice(0, 16));
  } catch {
    return null;
  }
  const b = [...head].map((c) => c.charCodeAt(0));
  if (b[0] === 0x89 && head.slice(1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (head.startsWith("GIF8")) return "image/gif";
  return head.startsWith("RIFF") && head.slice(8, 12) === "WEBP" ? "image/webp" : null;
}

/** Dropped from VS Code's Explorer or an editor: a URI, no file the webview can read. */
const URI_TYPES = ["text/uri-list", "application/vnd.code.uri-list", "codefiles", "resourceurls"];

// ------------------------------------------------------------------ questions for you
function decisionCard(d: PendingDecision, generation: number, actions: Actions, files: number): HTMLElement {
  const note = h("textarea", { class: "input note-input", attrs: { rows: "2", placeholder: "Note for the agents (optional; with Resume or Revise)", "aria-label": "Note for the agents" } });
  const VIEW: Record<string, { command: WebviewCommand; label: string; icon: string }> = {
    plan: { command: "openPlan", label: "Plan", icon: "go-to-file" }, review: { command: "openReview", label: "Review", icon: "go-to-file" },
    feedback: { command: "openFeedback", label: "Feedback", icon: "go-to-file" }, report: { command: "openReport", label: "Report", icon: "output" },
  };
  const choices = decisionChoices(d.review).map((c) => {
    const b = h("button", { class: c.key === "resume" ? "btn primary" : c.key === "abort" ? "btn danger" : "btn secondary", title: c.hint, attrs: { type: "button" } },
      h("span", { class: "choice-label" }, c.label), h("small", { class: "hint" }, c.hint));
    b.addEventListener("click", () => actions.decide(d.id, c.key, note.value.trim() || null));
    return b;
  });
  return h("section", { class: "card decision", role: "group", label: "Decision needed", attrs: { "data-generation": String(generation) } },
    h("h2", {}, icon("warning", "card-icon"), `Your decision is needed · ${d.review.reason}`),
    h("p", { class: "text" }, d.review.message),
    d.review.details.length ? h("ul", { class: "items" }, ...d.review.details.slice(0, 8).map((x) => h("li", {}, x))) : null,
    h("div", { class: "row-links" },
      ...d.views.map((v) => (VIEW[v] ? linkButton(VIEW[v]!.label, VIEW[v]!.icon, () => actions.command(VIEW[v]!.command)) : null)),
      linkButton("Changes", "git-compare", () => actions.command("openChanges"))),
    note,
    // A decision never takes the composer's files: they would be lost to the run without a word.
    files ? h("p", { class: "muted small files-hint" }, icon("attach"), ` ${files} file${files === 1 ? "" : "s"} below ${files === 1 ? "does" : "do"} not go with a decision. ` +
      "To give them to the run, send them with a message first (a note for its next step), or choose Decide later, then /resume with a note.") : null,
    h("div", { class: "choices" }, ...choices));
}

function permissionCard(p: PendingPermission, actions: Actions): HTMLElement {
  const r = p.request;
  const message = h("input", { class: "input", attrs: { type: "text", placeholder: "Message for the agent if you deny (optional)", "aria-label": "Message for the agent if you deny" } });
  const answer = (key: PermissionAnswer["decision"]): PermissionAnswer => (key === "deny" ? (message.value.trim() ? { decision: "deny", message: message.value.trim() } : { decision: "deny" }) : { decision: key });
  return h("section", { class: "card permission", role: "group", label: "Permission request" },
    h("h2", {}, icon("shield", "card-icon"), `${whoLabel(p.agent, p.role)} asks to use ${r.tool}`),
    h("code", { class: "code" }, r.label),
    r.description ? h("p", { class: "text" }, r.description) : null,
    r.blockedPath ? h("p", { class: "muted" }, `path: ${r.blockedPath}`) : null,
    message,
    h("div", { class: "choices" }, ...permissionChoices(r).map((c) => {
      // "Always allow" names the rules it saves: shown under it, a few lines at most; the tooltip has them all.
      const always = c.key === "always";
      const b = h("button", {
        class: c.key === "once" ? "btn primary" : c.key === "deny" ? "btn secondary" : "btn", label: c.label,
        title: [always ? c.label : "", c.hint].filter(Boolean).join("\n") || undefined, attrs: { type: "button" },
      }, h("span", { class: "choice-label" }, always ? "Always allow" : c.label), always ? h("span", { class: "choice-rules" }, r.rules.join(", ")) : null);
      b.addEventListener("click", () => actions.permit(r.id, answer(c.key)));
      return b;
    })));
}

// ------------------------------------------------------------------ settings panel
/**
 * A picker in the manner of Claude Code's model menu: the choice and what it is; a click drops the list of choices
 * down below it, and picking one applies it at once. `key` names it, so it keeps the focus when the panel is rebuilt.
 */
function picker(o: { key: string; label: string; value: string; options: PickOption[]; note?: string | null; pick(value: string): void }): HTMLElement {
  const current = o.options.find((x) => x.value === o.value) ?? { value: o.value, label: o.value, detail: "" };
  const id = `agentduo-pick-${o.key.replace(/\W/g, "-")}`;
  const value = h("span", { class: "pick-value", attrs: { id: `${id}-value` } }, current.label);
  const trigger = h("button", { class: "pick-trigger", attrs: { type: "button", "aria-haspopup": "listbox", "aria-expanded": "false", "aria-labelledby": `${id} ${id}-value`, "data-key": o.key } },
    value, current.detail ? h("span", { class: "pick-detail" }, current.detail) : null, icon("chevron-down", "pick-chevron"));
  const list = h("ul", { class: "pick-list", role: "listbox", attrs: { "aria-labelledby": id } });
  list.hidden = true;
  const field = h("div", { class: "field pick" }, h("span", { class: "field-label", attrs: { id } }, o.label), trigger, list, o.note ? h("div", { class: "muted small" }, o.note) : null);
  const close = (focus: boolean) => {
    list.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (focus) trigger.focus();
  };
  const open = () => {
    list.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    (list.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? list.querySelector("button"))?.focus();
    list.scrollIntoView?.({ block: "nearest" });
  };
  list.append(...o.options.map((x) => {
    const chosen = x.value === o.value;
    const b = h("button", { class: "menu-item", role: "option", attrs: { type: "button", "aria-selected": String(chosen) } },
      h("span", { class: "menu-text" }, h("span", { class: "menu-label" }, x.label), x.detail ? h("span", { class: "menu-detail" }, x.detail) : null),
      chosen ? icon("check", "menu-check") : null);
    b.addEventListener("click", () => {
      close(true);
      if (chosen) return;
      value.textContent = x.label;
      o.pick(x.value);
    });
    return h("li", { role: "none" }, b);
  }));
  trigger.addEventListener("click", () => (list.hidden ? open() : close(false)));
  trigger.addEventListener("keydown", (e) => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && list.hidden) {
      e.preventDefault();
      open();
    }
  });
  menuKeys(list, () => close(true));
  // Tab, or a click anywhere else, closes it.
  field.addEventListener("focusout", (e) => {
    if (!list.hidden && !field.contains(e.relatedTarget as Node | null)) close(false);
  });
  return field;
}

/** Values as tags, each with a remove control when it can be removed; a new one is typed, and Enter adds it. */
function tagList(o: { key: string; label: string; items: string[]; placeholder: string; add(value: string): void; remove?(value: string): void }): HTMLElement {
  const input = h("input", { class: "input", label: o.label, attrs: { type: "text", placeholder: o.placeholder } });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return; // Enter that commits an IME word adds nothing
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    o.add(text);
    input.value = "";
  });
  const tags = o.items.map((item) => {
    const remove = o.remove;
    const x = remove ? h("button", { class: "tag-x", title: `Remove ${item}`, label: `Remove ${item}`, attrs: { type: "button" } }, icon("close")) : null;
    x?.addEventListener("click", () => remove!(item));
    return h("li", { class: `tag${x ? " removable" : ""}` }, h("span", { class: "tag-text" }, item), x);
  });
  return h("div", { class: "field", attrs: { "data-key": o.key } }, h("span", { class: "field-label" }, o.label),
    tags.length ? h("ul", { class: "tags", label: o.label }, ...tags) : null, input);
}

/** The panel's checkboxes, kept across its rebuilds (each setting changed rebuilds it). */
interface SettingsPrefs {
  save: boolean;
  global: boolean;
  yes: boolean;
}

/** Claude Code's permission modes, with the icons of its mode menu (no codicon has its hand: a person approves). */
const MODE_ICONS: Record<PermissionMode, string> = { manual: "person", acceptEdits: "code", auto: "zap" };
const MODES: PickOption[] = PERMISSION_MODES.map((mode) => ({ value: mode, label: MODE_INFO[mode].label, detail: MODE_INFO[mode].description }));
const PERMISSIONS: Record<string, PickOption> = {
  default: { value: "default", label: "Default", detail: "Codex's own setting (~/.codex/config.toml)" },
  "read-only": { value: "read-only", label: "Read only", detail: "reads the workspace, changes nothing" },
  auto: { value: "auto", label: "Auto", detail: "works in the workspace (sandbox workspace-write)" },
  "full-access": { value: "full-access", label: "Full access", detail: "may change any file and use the network" },
};

function checkbox(key: string, checked: boolean, text: string, change: (checked: boolean) => void): HTMLElement {
  const box = h("input", { attrs: { type: "checkbox", "data-key": key } });
  box.checked = checked;
  box.addEventListener("change", () => change(box.checked));
  return h("label", { class: "check" }, box, text);
}

/** Every setting the chat's commands change, as pickers and tags; each change goes to the worker as that command would. */
function settingsPanel(s: ViewState, actions: Actions, prefs: SettingsPrefs): HTMLElement[] {
  const v = s.settings;
  if (!v) return [h("p", { class: "muted" }, "The settings show once agentduo has read the configuration.")];
  const send = (setting: SettingCommand, o: { yes?: boolean } = {}) => actions.setting({ setting, save: prefs.save, global: prefs.global, yes: !!o.yes });
  const orNull = (value: string) => (value === "default" ? null : value);
  const claudeModel = modelOptions(s, "claude");
  const codexModel = modelOptions(s, "codex");
  const modes = MODES.some((m) => m.value === v.claude.mode) ? MODES : [...MODES, { value: v.claude.mode, label: v.claude.mode, detail: "set in the configuration" }];
  const rule = (kind: "allow" | "deny" | "remove") => (text: string) => send({ target: "claude.permissions", rule: { kind, rule: text } });
  return [
    h("fieldset", { class: "group" },
      h("legend", {}, speaker("claude")),
      picker({ key: "claude.model", label: "Model", ...claudeModel, pick: (m) => send({ target: "claude.model", model: orNull(m) }) }),
      picker({ key: "claude.effort", label: "Effort", ...effortOptions(s, "claude"), pick: (e) => send({ target: "claude.effort", effort: orNull(e) }) }),
      picker({ key: "mode", label: "Mode (chat and pipeline implementer)", value: v.claude.mode, options: modes, pick: (m) => isPermissionMode(m) && send({ target: "mode", mode: m }) }),
      tagList({ key: "claude.allow", label: "Allowed tools", items: v.claude.allow, placeholder: "Add a rule and press Enter, e.g. Bash(npm test:*)", add: rule("allow"), remove: rule("remove") }),
      tagList({ key: "claude.deny", label: "Denied tools", items: v.claude.deny, placeholder: "Add a rule and press Enter, e.g. Bash(git push:*)", add: rule("deny"), remove: rule("remove") }),
      tagList({ key: "claude.dirs", label: "Extra directories", items: v.claude.addDirs, placeholder: "Add a path Claude may also work in, then Enter", add: (dir) => send({ target: "claude.add-dir", dir }) })),
    h("fieldset", { class: "group" },
      h("legend", {}, speaker("codex")),
      // A new model keeps the effort set (as /codex model does); the effort goes with the model set now.
      picker({ key: "codex.model", label: "Model", ...codexModel, pick: (m) => send({ target: "codex.model", model: orNull(m), effort: null }) }),
      picker({ key: "codex.effort", label: "Reasoning", ...effortOptions(s, "codex"), pick: (e) => e !== "default" && send({ target: "codex.model", model: v.codex.model, effort: e }) }),
      picker({
        key: "codex.permissions", label: "Permissions", value: PERMISSIONS[v.codex.permissions] ? v.codex.permissions : "default", options: CODEX_PRESETS.map((p) => PERMISSIONS[p]!),
        pick: (p) => send({ target: "codex.permissions", preset: p as (typeof CODEX_PRESETS)[number] }, { yes: prefs.yes }),
      }),
      checkbox("codex.yes", prefs.yes, " confirm full access (Codex may change any file and use the network)", (c) => (prefs.yes = c))),
    checkbox("save", prefs.save, " save changes to .agentduo/config.yaml (otherwise for this session only)", (c) => (prefs.save = c)),
    checkbox("global", prefs.global, " save changes for every workspace, in ~/.config/agentduo/config.yaml", (c) => (prefs.global = c)),
  ];
}

// ------------------------------------------------------------------ usage
/** /usage as the panel shows it: each limit with a meter (its words say the same), then the rest as Claude prints it. */
function usageNodes(r: UsageReport): HTMLElement[] {
  return usageRows(r).map((row) => {
    const indent = row.indent ? ` indent-${row.indent}` : "";
    switch (row.kind) {
      case "agent":
      case "heading":
        return h("div", { class: `usage-${row.kind}` }, row.text);
      case "group":
        return h("div", { class: `usage-group${indent}` }, row.text);
      case "limit":
        return h("div", { class: `usage-limit${indent}` }, row.text);
      case "bar": {
        const percent = Math.min(100, Math.max(0, row.percent ?? 0));
        const fill = h("span", { class: `usage-fill${percent >= 90 ? " full" : percent >= 70 ? " high" : ""}` });
        fill.style.width = `${percent}%`;
        return h("div", { class: `usage-meter${indent}` },
          h("span", { class: "usage-track", role: "meter", label: row.text, attrs: { "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(percent) } }, fill),
          h("span", { class: "usage-percent" }, row.text));
      }
      case "muted":
        return h("div", { class: `usage-muted muted${indent}` }, row.text);
      case "error":
        return h("div", { class: `usage-error${indent}` }, icon("error", "note-icon"), h("span", {}, row.text));
      case "blank":
        return h("div", { class: "usage-gap", attrs: { "aria-hidden": "true" } });
      default:
        return h("div", { class: `usage-text${indent}` }, row.text);
    }
  });
}

// ------------------------------------------------------------------ the view
const STAGE_ICON: Record<StageStatus, string> = { done: "check", active: "circle-filled", stopped: "debug-pause", pending: "circle-outline" };
const STAGE_WORD: Record<StageStatus, string> = { done: "done", active: "running", stopped: "stopped", pending: "to do" };

const PROBLEM_ACTIONS: Record<string, Array<{ command: WebviewCommand; label: string }>> = {
  node: [{ command: "configureNode", label: "Set Node path" }, { command: "restart", label: "Retry" }],
  worker: [{ command: "restart", label: "Retry" }, { command: "doctor", label: "Doctor" }],
  config: [{ command: "openConfiguration", label: "Open configuration" }, { command: "doctor", label: "Doctor" }],
  missing_cli: [{ command: "doctor", label: "Doctor" }, { command: "openConfiguration", label: "Open configuration" }],
  not_repo: [{ command: "doctor", label: "Doctor" }],
  environment: [{ command: "chooseWorkspace", label: "Choose folder" }],
  locked: [{ command: "restart", label: "Check again" }],
};

/** Where the composer's next message goes: an agent, or the pipeline for this one message. */
type Target = Backend | "pipeline" | "discuss";
/** A route the recipient menu sets for the next message only. */
type Once = "pipeline" | "discuss";
const ONCE: Record<Once, { icon: string; label: string }> = { pipeline: { icon: "run-all", label: "Pipeline" }, discuss: { icon: "comment-discussion", label: "Discuss" } };
const otherAgent = (b: Backend): Backend => (b === "codex" ? "claude" : "codex");
type Panel = "settings" | "usage" | "commands" | "target" | "mode";

/** Shift+Tab alone: in the message box and the mode menu it switches Claude's mode, as in Claude Code. */
const shiftTab = (e: KeyboardEvent) => e.key === "Tab" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;

/** Arrow keys, Home and End move between a menu's items; Escape closes it. */
function menuKeys(menu: HTMLElement, close: () => void): void {
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = { ArrowDown: at + 1, ArrowUp: at - 1 + items.length, Home: 0, End: items.length - 1 }[e.key];
    if (move !== undefined) {
      e.preventDefault();
      items[move % items.length]!.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
}

/** Builds the sidebar once, then updates it in place, re-creating only what changed (by identity, the reducer is immutable). */
export function createUi(root: HTMLElement, actions: Actions, initialDraft = ""): {
  update(s: ViewState): void; focusComposer(): void; showSettings(): void; tick(): void; setUris(uris: Record<string, string | null>): void;
  /** The host is to reload the page: `done` once the files read here are all with the host (none is lost with it). */
  release(done: () => void): void;
} {
  const stages = h("ol", { class: "stages" });
  const progressMeta = h("span", { class: "progress-meta" });
  const progress = h("nav", { class: "progress", label: "Workflow" }, stages, progressMeta);
  const problem = h("div", { class: "banner", role: "alert" });
  const timeline = h("main", { class: "timeline", attrs: { tabindex: "0", "aria-label": "Conversation and agent activity", "aria-live": "off" } });
  const notice = h("div", { class: "notice muted", role: "note" });
  const live = h("div", { class: "live-slot" });
  const empty = h("div", { class: "empty" });
  const jump = h("button", { class: "btn small jump", attrs: { type: "button" } }, icon("arrow-down"), "New activity");
  jump.addEventListener("click", () => {
    pinned = true;
    timeline.scrollTop = timeline.scrollHeight;
    jump.hidden = true;
  });
  jump.hidden = true;
  const pending = h("div", { class: "pending" });
  const announce = h("div", { class: "sr-only", attrs: { "aria-live": "polite" } });

  // Composer: the panels it opens, the completion list, then one box with the input and its controls.
  const settingsBody = h("div", { class: "sheet-body" });
  const settingsSheet = h("section", { class: "sheet", role: "region", label: "Settings", attrs: { id: "agentduo-settings" } },
    h("header", { class: "sheet-head" }, h("strong", {}, "Settings"), h("span", { class: "spacer" }),
      (() => {
        const b = h("button", { class: "icon-btn", title: "Close settings", label: "Close settings", attrs: { type: "button" } }, icon("close"));
        b.addEventListener("click", () => setPanel(null, true));
        return b;
      })()),
    settingsBody);
  // /usage: a sheet like the settings', opened by a new report, refreshed or closed by the user.
  const usageBody = h("div", { class: "sheet-body usage-body", attrs: { "aria-live": "polite" } });
  const sheetButton = (name: string, label: string, onClick: () => void) => {
    const b = h("button", { class: "icon-btn", title: label, label, attrs: { type: "button" } }, icon(name));
    b.addEventListener("click", onClick);
    return b;
  };
  const usageSheet = h("section", { class: "sheet usage-sheet", role: "region", label: "Usage", attrs: { id: "agentduo-usage", tabindex: "-1" } },
    h("header", { class: "sheet-head" }, h("strong", {}, "Usage"), h("span", { class: "muted usage-hint" }, "Claude Code and Codex plan limits"), h("span", { class: "spacer" }),
      sheetButton("refresh", "Refresh usage", () => actions.usage()),
      sheetButton("close", "Close usage", () => setPanel(null, true))),
    usageBody);
  const commandsMenu = h("ul", { class: "menu commands", role: "menu", label: "Commands", attrs: { id: "agentduo-commands" } });
  const targetMenu = h("ul", { class: "menu target-menu", role: "menu", label: "Send to", attrs: { id: "agentduo-target" } });
  const modeMenu = h("ul", { class: "menu mode-menu", role: "menu", label: "Modes", attrs: { id: "agentduo-mode" } });
  const menu = h("ul", { class: "menu completions", role: "listbox", label: "Commands", attrs: { id: "agentduo-completions" } });
  menu.hidden = true;
  const input = h("textarea", {
    class: "composer-input",
    attrs: { rows: "1", "aria-label": "Message to agentduo", role: "combobox", "aria-autocomplete": "list", "aria-controls": "agentduo-completions", "aria-expanded": "false" },
  });
  input.value = initialDraft;
  const commandsBtn = h("button", { class: "icon-btn slash", title: "Commands (/)", label: "Commands", attrs: { type: "button", "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": "agentduo-commands" } },
    h("span", { attrs: { "aria-hidden": "true" } }, "/"));
  const targetIcon = h("span", { class: "chip-icon" });
  const targetName = h("span", { class: "chip-name" });
  const targetDetail = h("span", { class: "chip-detail" });
  const targetBtn = h("button", { class: "chip target", attrs: { type: "button", "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": "agentduo-target" } },
    targetIcon, targetName, targetDetail, icon("chevron-down", "chip-chevron"));
  const modeIcon = h("span", { class: "chip-icon" });
  const modeName = h("span", { class: "chip-name" });
  const modeBtn = h("button", { class: "chip mode", attrs: { type: "button", "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": "agentduo-mode" } },
    modeIcon, modeName, icon("chevron-down", "chip-chevron"));
  const sendIcon = icon("arrow-up");
  const sendBtn = h("button", { class: "send-btn", attrs: { type: "button" } }, sendIcon);
  const attachBtn = h("button", { class: "icon-btn attach", title: "Attach files: images, PDFs, text, code… (or paste an image, or Shift+drag files from your system here)", label: "Attach files", attrs: { type: "button" } }, icon("attach"));
  attachBtn.addEventListener("click", () => actions.attach());
  const files = h("ul", { class: "files composer-files", label: "Files for your next message" });
  files.hidden = true;
  const fileHint = h("div", { class: "file-hint muted small", role: "status" });
  fileHint.hidden = true;
  // The menus float over the timeline, just above the box they belong to; the settings take room of their own.
  const box = h("div", { class: "composer-box" }, files, input, h("div", { class: "composer-bar" }, attachBtn, commandsBtn, targetBtn, modeBtn, h("span", { class: "spacer" }), sendBtn));
  const composer = h("footer", { class: "composer" }, settingsSheet, usageSheet, h("div", { class: "composer-anchor" }, commandsMenu, targetMenu, modeMenu, menu, fileHint, box));
  root.replaceChildren(progress, problem, timeline, pending, composer, announce);
  // The jump button floats at the bottom of the timeline (sticky), over the content, never pushing the composer.
  timeline.append(notice, empty, live, jump);
  root.setAttribute("aria-busy", "false");

  let state: ViewState | null = null;
  let composing = false;
  // The reader is at the bottom: keep them there while the timeline grows or changes size (a question card opens,
  // the sidebar is resized). Scrolling up unpins it; scrolling back down pins it again.
  let pinned = true;
  const items = new Map<string, { item: TimelineItem; el: HTMLElement }>();
  let lastPending: { decision: unknown; permissions: unknown; files: number } = { decision: undefined, permissions: undefined, files: 0 };
  let lastSettings: unknown[] = [];
  const prefs: SettingsPrefs = { save: false, global: false, yes: false };
  let completions: Completion[] = [];
  let selected = 0;
  /** The text the list was closed for (Esc, or a pick with Enter): it stays closed until the text changes. */
  let closedFor: string | null = null;
  /** The next message is a pipeline task or a question to discuss (picked in the menu); it goes back to the recipient once sent. */
  let once: Once | null = null;
  let panel: Panel | null = null;
  /** The usage report the panel last opened for, and the one it shows (a new id opens it; one seen before never does). */
  let usageSeen: number | null = null;
  let usageShown: UsageReport | null = null;
  setPanel(null, false);

  const target = (): Target => once ?? state?.recipient ?? "codex";
  /** Stop instead of send: something runs, and there is neither text nor a file to send it as a note. */
  const stopMode = () => !!state && sendStops(state, input.value, reads.size);

  function submit(): void {
    if (!state || !canSubmit(state)) return;
    const route: Route = once ?? "message";
    const text = input.value;
    if (uploading(state) || reads.size) return hint("Some files are still being attached: send once they are ready.");
    const ready = readyAttachments(state);
    // An empty message only means something with files, for a stopped run (the chat says how to continue it), or as a usage hint.
    if (!text.trim() && !ready.length && route === "message" && state.status !== "paused") return;
    actions.submit(text, route, ready);
    input.value = "";
    actions.draft("");
    closedFor = null;
    once = null;
    renderCompletions();
    renderComposer(state);
  }

  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  /** A line above the composer about its files, for a few seconds. */
  function hint(text: string): void {
    fileHint.textContent = text;
    fileHint.hidden = false;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => (fileHint.hidden = true), 8000);
  }

  let fileSeq = 0;
  /** Pasted and dropped files, read here and handed to the host in the order given; a message waits for them. */
  const reads = new FileQueue({
    reader: () => new FileReader(),
    send: (file) => actions.upload(file),
    // A raster image keeps a preview until its copy is shown.
    read: (key, data) => {
      const type = data.length <= 12 * 1024 * 1024 ? rasterType(data) : null;
      if (type) previews.set(key, `data:${type};base64,${data}`);
    },
    failed: (name) => hint(`${name} could not be read.`),
    changed: () => {
      shownFiles = null;
      if (!state) return;
      renderFiles(state);
      renderSend(state);
    },
  });

  /** Pasted or dropped files go to the host one by one, as base64. */
  function uploadFiles(list: File[]): void {
    for (const file of list) {
      const name = file.name || `pasted-${Date.now()}.${(file.type.split("/")[1] ?? "bin").replace(/[^a-z0-9]/gi, "") || "bin"}`;
      if (file.size > ATTACHMENT_LIMITS.fileBytes) {
        hint(`${name} is ${formatBytes(file.size)}; a file can be at most ${formatBytes(ATTACHMENT_LIMITS.fileBytes)}.`);
        continue;
      }
      if (!reads.add(`w${Date.now().toString(36)}${(++fileSeq).toString(36)}`, name, file)) {
        return hint("This tab is reloading to show attached images: paste or drop the files again in a moment.");
      }
    }
  }

  let shownFiles: unknown = null;
  function renderFiles(s: ViewState): void {
    if (shownFiles === s.attachments) return;
    shownFiles = s.attachments;
    // The files still read here come after the host's, until it shows them.
    const local = reads.waiting.filter((f) => !s.attachments.some((c) => c.key === f.key));
    for (const key of previews.keys()) if (!s.attachments.some((c) => c.key === key && !c.attachment) && !local.some((f) => f.key === key)) previews.delete(key);
    files.replaceChildren(...s.attachments.map((c) => fileChip({
      name: c.name, key: c.key, attachment: c.attachment, status: c.status, remove: () => actions.removeFile(c.key),
      detail: c.status === "uploading" ? "attaching…" : c.status === "error" ? c.error ?? "could not be attached" : c.attachment ? attachmentDetail(c.attachment) : "",
    })), ...local.map((f) => fileChip({
      name: f.name, key: f.key, attachment: null, status: "uploading", detail: f.sent ? "attaching…" : "reading…",
      remove: () => {
        if (reads.remove(f.key)) actions.removeFile(f.key);
      },
    })));
    files.hidden = !s.attachments.length && !local.length;
  }

  // Paste: files on the clipboard (a screenshot) are attached; its text, if it has any, is pasted as usual.
  input.addEventListener("paste", (e) => {
    const list = [...(e.clipboardData?.files ?? [])];
    if (!list.length) return;
    if (!e.clipboardData?.getData("text/plain")) e.preventDefault();
    uploadFiles(list);
  });
  // VS Code lets a drop reach the webview only with Shift held; files from the system come with their bytes, those from
  // its Explorer only as URIs, which a webview cannot read.
  const dragKind = (e: DragEvent) => {
    const types = [...(e.dataTransfer?.types ?? [])];
    return types.includes("Files") ? "files" : types.some((t) => URI_TYPES.includes(t)) ? "uris" : null;
  };
  composer.addEventListener("dragover", (e) => {
    if (!dragKind(e)) return;
    e.preventDefault();
    box.classList.add("drop");
  });
  composer.addEventListener("dragleave", () => box.classList.remove("drop"));
  composer.addEventListener("drop", (e) => {
    box.classList.remove("drop");
    const kind = dragKind(e);
    if (!kind) return;
    e.preventDefault();
    const list = [...(e.dataTransfer?.files ?? [])];
    if (list.length) uploadFiles(list);
    else hint("Files from VS Code's Explorer cannot be dropped here: use Attach (the paperclip), or hold Shift and drag the file from Finder or your file manager.");
  });

  function setPanel(next: Panel | null, focusBack: boolean): void {
    const was = panel;
    panel = next;
    settingsSheet.hidden = next !== "settings";
    showUsage();
    commandsMenu.hidden = next !== "commands";
    targetMenu.hidden = next !== "target";
    modeMenu.hidden = next !== "mode";
    commandsBtn.setAttribute("aria-expanded", String(next === "commands"));
    targetBtn.setAttribute("aria-expanded", String(next === "target"));
    modeBtn.setAttribute("aria-expanded", String(next === "mode"));
    if (next === "target" || next === "mode") {
      const list = next === "target" ? targetMenu : modeMenu;
      if (next === "target") renderTargetMenu();
      else renderModeMenu();
      (list.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? list.querySelector("button"))?.focus();
    } else if (next === "commands") commandsMenu.querySelector("button")?.focus();
    else if (next === "settings") settingsBody.querySelector<HTMLElement>("button, input")?.focus();
    else if (next === "usage") {
      // Opened by a report, it takes the focus only from the composer, so Esc closes it; typing elsewhere is left alone.
      if (document.activeElement === input || document.activeElement === document.body) usageSheet.focus();
    } else if (focusBack) (was === "target" ? targetBtn : was === "commands" ? commandsBtn : was === "mode" ? modeBtn : input).focus();
  }

  /** A question for the user (a permission, a decision) goes before the usage panel, which comes back once it is answered. */
  function showUsage(): void {
    usageSheet.hidden = panel !== "usage" || (!!state && hasPending(state));
  }

  function renderUsage(s: ViewState): void {
    const report = s.usage ?? null;
    if (report === usageShown) return;
    usageShown = report;
    if (!report) return;
    usageBody.replaceChildren(...usageNodes(report));
    if (report.id === usageSeen) return;
    usageSeen = report.id;
    setPanel("usage", false);
  }

  function menuItem(o: { radio?: boolean; checked?: boolean; disabled?: boolean; mark: Node; label: string; detail: string; pick: () => void }): HTMLElement {
    const b = h("button", { class: "menu-item", role: o.radio ? "menuitemradio" : "menuitem", attrs: { type: "button", ...(o.radio ? { "aria-checked": String(!!o.checked) } : {}) } },
      h("span", { class: "menu-icon" }, o.mark),
      h("span", { class: "menu-text" }, h("span", { class: "menu-label" }, o.label), h("span", { class: "menu-detail" }, o.detail)),
      o.checked ? icon("check", "menu-check") : null);
    b.disabled = !!o.disabled;
    b.addEventListener("click", () => o.pick());
    return h("li", { role: "none" }, b);
  }

  function renderTargetMenu(): void {
    if (!state) return;
    const s = state;
    const now = target();
    const agent = (b: Backend) => menuItem({
      radio: true, checked: now === b, mark: providerMark(b), label: AGENT_NAMES[b],
      detail: [shortModel(s.models?.[b]), s.settings?.[b].effort].filter(Boolean).join(" · "),
      pick: () => {
        once = null;
        setPanel(null, true);
        if (s.recipient !== b) actions.recipient(b);
        else renderComposer(s);
      },
    });
    const oneOff = (route: Once, detail: string) => menuItem({
      radio: true, checked: now === route, disabled: isBusy(s), mark: icon(ONCE[route].icon), label: ONCE[route].label,
      detail: isBusy(s) ? "something runs: Esc stops it first" : detail,
      pick: () => {
        once = route;
        setPanel(null, true);
        renderComposer(s);
      },
    });
    const answerer = AGENT_NAMES[s.recipient];
    targetMenu.replaceChildren(agent("codex"), agent("claude"),
      oneOff("discuss", `a question: ${answerer} answers, ${AGENT_NAMES[otherAgent(s.recipient)]} reviews, until they agree`),
      oneOff("pipeline", "a task: Codex plans and reviews, Claude critiques and implements"),
      h("li", { class: "menu-sep", role: "separator" }),
      menuItem({ mark: icon("settings-gear"), label: "Models, effort and permissions…", detail: "both agents' settings", pick: () => setPanel("settings", false) }));
  }

  /** Claude Code's mode menu: its three modes, the one in use checked; ⇧+Tab in the message box goes through them too. */
  function renderModeMenu(): void {
    if (!state) return;
    const now = state.mode;
    const focused = modeMenu.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.mode : undefined;
    modeMenu.replaceChildren(
      h("li", { class: "menu-head", role: "presentation" }, h("span", {}, "Modes"), h("span", { class: "menu-keys" }, "⇧+Tab to switch")),
      ...PERMISSION_MODES.map((mode) => {
        const item = menuItem({
          radio: true, checked: now === mode, mark: icon(MODE_ICONS[mode]), label: MODE_INFO[mode].label, detail: MODE_INFO[mode].description,
          pick: () => {
            setPanel(null, true);
            if (state && state.mode !== mode) actions.setting({ setting: { target: "mode", mode }, save: false, global: false, yes: false });
          },
        });
        item.querySelector("button")!.dataset.mode = mode;
        return item;
      }));
    // Rebuilt by a mode changed meanwhile (⇧+Tab in the menu): the item that had the focus keeps it.
    if (focused) modeMenu.querySelector<HTMLButtonElement>(`[data-mode="${focused}"]`)?.focus();
  }

  function renderCompletions(): void {
    const text = input.value;
    completions = composing || text === closedFor ? [] : complete(text);
    if (selected >= completions.length) selected = 0;
    menu.replaceChildren(...completions.map((c, i) => {
      const li = h("li", { class: `completion${i === selected ? " selected" : ""}${c.insert ? "" : " hint-only"}`, role: "option", attrs: { id: `agentduo-completion-${i}`, "aria-selected": String(i === selected) } },
        h("span", { class: "completion-label" }, c.label), h("span", { class: "completion-desc" }, c.description));
      li.addEventListener("mousedown", (e) => e.preventDefault()); // keep the focus in the input
      li.addEventListener("click", () => pick(i, false));
      return li;
    }));
    menu.hidden = !completions.length;
    input.setAttribute("aria-expanded", String(!!completions.length));
    if (completions.length) input.setAttribute("aria-activedescendant", `agentduo-completion-${selected}`);
    else input.removeAttribute("aria-activedescendant");
    menu.querySelector(".selected")?.scrollIntoView?.({ block: "nearest" });
  }

  /** Fills the input with a suggestion; `close`: Enter picked it, so the next Enter sends. */
  function pick(i: number, close: boolean): boolean {
    const c = completions[i];
    if (!c?.insert || c.insert === input.value) return false;
    input.value = c.insert;
    actions.draft(input.value);
    closedFor = close ? c.insert : null;
    selected = 0;
    renderCompletions();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    return true;
  }

  input.addEventListener("compositionstart", () => {
    composing = true;
    renderCompletions();
  });
  input.addEventListener("compositionend", () => {
    composing = false;
    renderCompletions();
  });
  input.addEventListener("input", () => {
    actions.draft(input.value);
    selected = 0;
    renderCompletions();
    if (state) renderSend(state);
  });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || composing || e.keyCode === 229) return; // an IME is still composing: Enter picks a candidate
    const plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
    // As in Claude Code, Shift+Tab in the message box switches Claude's mode instead of moving the focus back.
    if (shiftTab(e)) {
      e.preventDefault();
      actions.cycleMode();
      return;
    }
    if (completions.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        selected = (selected + (e.key === "ArrowDown" ? 1 : completions.length - 1)) % completions.length;
        renderCompletions();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closedFor = input.value;
        renderCompletions();
        return;
      }
      if ((e.key === "Tab" || e.key === "Enter") && plain) {
        if (pick(selected, e.key === "Enter") || e.key === "Tab") {
          e.preventDefault();
          return;
        }
      }
    }
    if (e.key === "Enter" && plain) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && panel === "usage") {
      // The usage panel closes first: an answer under way goes on.
      e.preventDefault();
      setPanel(null, true);
    } else if (e.key === "Escape" && state && isBusy(state)) {
      e.preventDefault();
      actions.interrupt();
    } else if (e.key === "Escape" && once && state) {
      e.preventDefault();
      once = null;
      renderComposer(state);
    }
  });
  input.addEventListener("blur", () => {
    menu.hidden = true;
    input.setAttribute("aria-expanded", "false");
  });
  input.addEventListener("focus", () => renderCompletions());

  sendBtn.addEventListener("click", () => (stopMode() ? actions.interrupt() : submit()));
  commandsBtn.addEventListener("click", () => setPanel(panel === "commands" ? null : "commands", true));
  targetBtn.addEventListener("click", () => setPanel(panel === "target" ? null : "target", true));
  modeBtn.addEventListener("click", () => setPanel(panel === "mode" ? null : "mode", true));
  menuKeys(commandsMenu, () => setPanel(null, true));
  menuKeys(targetMenu, () => setPanel(null, true));
  menuKeys(modeMenu, () => setPanel(null, true));
  modeMenu.addEventListener("keydown", (e) => {
    if (!shiftTab(e)) return;
    e.preventDefault();
    actions.cycleMode();
  });
  for (const sheet of [settingsSheet, usageSheet]) {
    sheet.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setPanel(null, true);
      }
    });
  }
  // A click elsewhere closes an open menu (the settings stay until closed: they hold half-typed values).
  document.addEventListener("pointerdown", (e) => {
    if (panel !== "commands" && panel !== "target" && panel !== "mode") return;
    const t = e.target as Node;
    if (![commandsMenu, targetMenu, modeMenu, commandsBtn, targetBtn, modeBtn].some((el) => el.contains(t))) setPanel(null, false);
  });
  commandsMenu.append(...COMMANDS.map((c) => {
    const item = h("button", { class: "menu-item", role: "menuitem", attrs: { type: "button" } },
      h("span", { class: "menu-text" }, h("span", { class: "menu-label mono" }, c.usage), h("span", { class: "menu-detail" }, c.description)));
    item.addEventListener("click", () => {
      setPanel(null, false);
      // A command that takes words goes into the input to be completed; the others run at once.
      if (c.args) {
        input.value = `${c.name} `;
        actions.draft(input.value);
        input.focus();
        renderCompletions();
      } else actions.submit(c.name, "message", []);
    });
    return h("li", { role: "none" }, item);
  }));

  timeline.addEventListener("scroll", () => {
    pinned = nearBottom();
    if (pinned) jump.hidden = true;
  });
  new ResizeObserver(() => {
    if (pinned) timeline.scrollTop = timeline.scrollHeight;
  }).observe(timeline);

  const nearBottom = () => timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 40;

  function renderProgress(s: ViewState): void {
    const shown = runInProgress(s) ? pipelineView(s) : [];
    progress.hidden = !shown.length;
    if (!shown.length) return;
    stages.replaceChildren(...shown.map((p) => h("li", {
      class: `stage stage-${p.status}`, title: [p.agent ? partyLabel(p.agent) : "", p.role ? roleLabel(p.role) : ""].filter(Boolean).join(" · ") || undefined,
      attrs: p.status === "active" ? { "aria-current": "step" } : {},
    }, icon(STAGE_ICON[p.status], "stage-icon"), h("span", { class: "sr-only" }, `${STAGE_WORD[p.status]}: `), stageName(p.label))));
    const usage = usageText(s.totals.costUsd + s.live.costUsd || undefined, s.totals.tokens + s.live.tokens || undefined);
    progressMeta.textContent = [`plan ${s.planning.round}/${s.planning.limit || "–"}`, `impl ${s.impl.round}/${s.impl.limit || "–"}`, usage].filter(Boolean).join(" · ");
  }

  function renderProblem(s: ViewState): void {
    problem.hidden = !s.problem;
    if (!s.problem) return;
    problem.replaceChildren(h("div", { class: "banner-text" }, icon("error", "note-icon"), h("span", {}, s.problem.message)),
      h("div", { class: "row-links" }, ...(PROBLEM_ACTIONS[s.problem.kind] ?? []).map((a) => button(a.label, () => actions.command(a.command), { class: "btn small" }))));
  }

  function renderEmpty(s: ViewState): void {
    empty.hidden = s.timeline.length > 0 || !!s.current || !!s.turn || !!s.discussion;
    if (empty.hidden) return;
    const text = s.session === "choose-folder" ? "This window has several folders: choose the one agentduo works in."
      : "Ask Codex or Claude anything. The menu under the input picks who answers, or hands a task to the Pipeline: Codex plans and reviews it, Claude critiques the plan and implements it. / lists the commands.";
    empty.replaceChildren(
      h("div", { class: "empty-title" }, "agentduo", s.version ? h("span", { class: "empty-version" }, s.version) : null),
      h("p", { class: "muted" }, text));
    if (s.session === "choose-folder") empty.append(button("Choose folder", () => actions.command("chooseWorkspace"), { class: "btn" }));
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
    notice.hidden = !s.dropped;
    notice.textContent = s.dropped
      ? `${s.dropped} earlier item(s) are no longer shown here, to keep the view light. ${s.logs ? `Every answer is kept in full in ${s.logs}` : "The runs' files keep their steps"}.`
      : "";
    renderEmpty(s);
    renderLive(s);
  }

  function renderLive(s: ViewState): void {
    const now = { now: Date.now() };
    const step = s.current && (s.current.activities.length || s.status === "running" || s.current.message) ? [stepCard(s.current, actions, now)] : [];
    const answering = s.discussion ? [discussionCard(s.discussion, { ...now, turn: s.turn })] : s.turn ? [answerCard(s.turn, now)] : [];
    live.replaceChildren(...step, ...answering);
  }

  function renderPending(s: ViewState): void {
    const waiting = readyAttachments(s).length;
    if (lastPending.decision === s.decision && lastPending.permissions === s.permissions && lastPending.files === waiting) return;
    const hadFocus = pending.contains(document.activeElement);
    lastPending = { decision: s.decision, permissions: s.permissions, files: waiting };
    const cards = [...s.permissions.map((p) => permissionCard(p, actions)), ...(s.decision ? [decisionCard(s.decision, s.generation, actions, waiting)] : [])];
    pending.replaceChildren(...cards);
    if (cards.length) {
      announce.textContent = s.permissions.length ? `${partyLabel(s.permissions[0]!.agent)} asks to use ${s.permissions[0]!.request.tool}` : "Your decision is needed";
      if (hadFocus || document.activeElement === input || document.activeElement === document.body) cards[0]!.querySelector<HTMLButtonElement>("button.primary")?.focus();
    } else if (hadFocus) input.focus();
  }

  function renderSend(s: ViewState): void {
    const stopping = stopMode();
    sendIcon.className = `codicon codicon-${stopping ? "debug-stop" : "arrow-up"}`;
    sendBtn.classList.toggle("stop", stopping);
    const label = stopping ? "Stop (Esc): /resume continues a stopped run" : once === "pipeline" ? "Hand the task to the pipeline (Enter)"
      : once === "discuss" ? "Start the discussion (Enter)" : s.status === "running" ? "Send the note (Enter)" : "Send (Enter)";
    sendBtn.title = (uploading(s) || reads.size) && !stopping ? "Files are still being attached…" : label;
    sendBtn.setAttribute("aria-label", label);
    sendBtn.disabled = !canSubmit(s);
    attachBtn.disabled = !canSubmit(s);
  }

  function renderComposer(s: ViewState): void {
    if (once && isBusy(s)) once = null; // something started meanwhile (Resume): messages are notes for it, or wait
    input.placeholder = placeholder(s, once);
    input.disabled = !canSubmit(s);
    const t = target();
    const agentTarget = t === "pipeline" || t === "discuss" ? null : t;
    targetIcon.replaceChildren(agentTarget ? providerMark(agentTarget) : icon(ONCE[t as Once].icon));
    targetName.textContent = agentTarget ? AGENT_NAMES[agentTarget] : ONCE[t as Once].label;
    targetDetail.textContent = agentTarget ? shortModel(s.models?.[agentTarget]) : t === "discuss" ? `${AGENT_NAMES[s.recipient]} answers` : "";
    targetDetail.hidden = !targetDetail.textContent;
    const m = agentTarget ? s.models?.[agentTarget] : null;
    const session = usageText(s.totals.costUsd || undefined, s.totals.tokens || undefined);
    const says = t === "pipeline" ? "The next message is a task for the pipeline"
      : t === "discuss" ? `The next message is a question to discuss: ${AGENT_NAMES[s.recipient]} answers, ${AGENT_NAMES[otherAgent(s.recipient)]} reviews (/discuss)`
        : `Plain messages go to ${AGENT_NAMES[t]} (/${t})`;
    targetBtn.title = [says,
      m ? modelTitle(m) : "", session ? `this session: ${session}` : ""].filter(Boolean).join("\n");
    targetBtn.setAttribute("aria-label", `Send to: ${targetName.textContent}${m ? `, ${modelText(m, { short: true })}` : ""}`);
    targetBtn.classList.toggle("resolving", m?.status === "resolving");
    targetBtn.disabled = !canSubmit(s);
    if (panel === "target") renderTargetMenu();
    const mode = isPermissionMode(s.mode) ? s.mode : null;
    modeIcon.replaceChildren(icon(mode ? MODE_ICONS[mode] : "shield"));
    modeName.textContent = modeLabel(s.mode);
    modeBtn.title = `${modeLabel(s.mode)}: ${mode ? MODE_INFO[mode].description : "Claude's permission mode, set in the configuration"}\n`
      + "Claude in the chat and as the pipeline's implementer. Click to choose, or Shift+Tab in the message box (/mode)";
    modeBtn.setAttribute("aria-label", `Mode: ${modeLabel(s.mode)}`);
    if (panel === "mode") renderModeMenu();
    renderSend(s);
    const inputs = [s.settings, s.catalog, s.models];
    if (inputs.some((x, i) => x !== lastSettings[i])) {
      lastSettings = inputs;
      // The control that had the focus keeps it (by its key): a change rebuilds the panel with the new values.
      const key = (document.activeElement as HTMLElement | null)?.closest("[data-key]")?.getAttribute("data-key");
      const typed = settingsBody.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement && document.activeElement.type === "text";
      settingsBody.replaceChildren(...settingsPanel(s, actions, prefs));
      const again = key ? settingsBody.querySelector<HTMLElement>(`[data-key="${key}"]`) : null;
      (again?.matches("button, input") ? again : again?.querySelector<HTMLElement>(typed ? "input" : "input, button"))?.focus();
    }
  }

  return {
    update(s: ViewState): void {
      const prev = state;
      const grew = !prev || prev.timeline !== s.timeline || prev.current !== s.current || prev.turn !== s.turn || prev.discussion !== s.discussion;
      // The report a reloaded or re-shown tab already had was seen then: only a new one opens the panel.
      if (!prev) usageSeen = s.usage?.id ?? null;
      state = s;
      // A file the host shows now (attaching, stored or failed) is the host's to show; the composer stops waiting for it.
      reads.settle(new Set(s.attachments.map((c) => c.key)));
      renderProgress(s);
      renderProblem(s);
      renderTimeline(s);
      renderPending(s);
      renderComposer(s);
      renderFiles(s);
      renderUsage(s);
      showUsage();
      const last = s.timeline.at(-1);
      if (prev && last && prev.timeline.at(-1) !== last && (last.kind === "finish" || last.kind === "step" || last.kind === "answer" || last.kind === "discussion")) {
        announce.textContent = last.kind === "finish" ? `Run ${last.phase.toLowerCase()}`
          : last.kind === "answer" ? `${PROVIDERS[last.turn.backend].agent} ${last.turn.status === "success" ? "answered" : "did not answer"}`
            : last.kind === "discussion" ? `Discussion: ${discussionOutcome({ status: last.discussion.status ?? "error", answerer: last.discussion.answerer, critic: last.discussion.critic, rounds: last.discussion.rounds ?? 0 })}`
            : `${last.step.phase} ${last.step.entry?.status ?? "finished"}`;
      }
      if (!grew) return;
      if (pinned) timeline.scrollTop = timeline.scrollHeight;
      else jump.hidden = false;
    },
    focusComposer: () => input.focus(),
    setUris(uris: Record<string, string | null>): void {
      for (const [id, uri] of Object.entries(uris)) imageUris.set(id, uri);
      for (const thumb of root.querySelectorAll<HTMLElement>(".file-thumb[data-attachment]")) if (thumb.dataset.attachment! in uris) paintThumb(thumb);
    },
    showSettings: () => setPanel("settings", false),
    release: (done) => reads.release(done),
    tick(): void {
      if (state?.current || state?.turn || state?.discussion) {
        renderLive(state);
        if (pinned) timeline.scrollTop = timeline.scrollHeight;
      }
    },
  };
}
