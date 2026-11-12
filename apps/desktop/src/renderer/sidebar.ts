// The left column: New conversation first; Conversations (chats without a project) and the projects agentduo knows,
// the open one's conversations grouped under it (what each is doing, what waits for the user, when it last changed)
// with its resumable runs; and at the bottom the app's update when it needs the user (restart into it, or download
// it), both agents' accounts and limits (Account & Usage), and Settings. A project or conversation where an agent
// works now has a slowly pulsing dot; nothing marks the others. Drawn again whole on each change; it is small.
import { ACCOUNT_AGENTS, limitRows, updatedText } from "@agentduo/webview/account";
import { providerMark } from "@agentduo/webview/dom";
import type { UsageState } from "@agentduo/engine/system/usage";
import type { Agent } from "@agentduo/engine/events";
import { CONVERSATIONS_PROJECT_ID } from "../shared/protocol.js";
import type { AppSnapshot, ArchivedConversation, ConversationItem, RunItem, UpdateState } from "../shared/protocol.js";
import { button, el, icon, meter, relativeTime } from "./bridge.js";
import { updateNotice } from "./update.js";
import type { UsageAnswer } from "./usage.js";

export interface SidebarModel {
  snapshot: AppSnapshot | null;
  conversations: Map<string, ConversationItem[]>;
  runs: RunItem[] | null;
  runsOpen: boolean;
  runsError: string | null;
  /** The Conversations list shows the archived ones instead (the archive button beside +), as main last listed them. */
  archivedOpen: boolean;
  archived: ArchivedConversation[] | null;
  archivedError: string | null;
  account: SidebarAccount;
  update: UpdateState;
}

/** What the Account & Usage box shows: the latest answer (for any project, until this one's comes), and when it is now. */
export interface SidebarAccount {
  open: boolean;
  answer: UsageAnswer | null;
  looking: boolean;
  now: number;
}

export interface SidebarHandlers {
  openProject(): void;
  selectProject(projectId: string): void;
  forgetProject(projectId: string): void;
  restartProject(projectId: string): void;
  newConversation(): void;
  openConversation(conversationId: string): void;
  archiveConversation(conversationId: string): void;
  toggleArchived(): void;
  /** Back in the list; `open`: and shown. */
  restoreConversation(conversationId: string, open: boolean): void;
  deleteConversation(conversation: ArchivedConversation): void;
  toggleRuns(): void;
  resume(runId: string): void;
  toggleAccount(): void;
  refreshAccount(): void;
  update(action: "install" | "download"): void;
  settings(): void;
}

/** The Conversations heading: the archived list's toggle beside +; in the archived list, + is not there. */
function conversationsHead(archived: boolean, h: SidebarHandlers): HTMLElement {
  const toggle = button("", h.toggleArchived, { class: "icon-btn archive-toggle", icon: "archive", title: archived ? "Back to the conversations" : "Archived conversations" });
  toggle.setAttribute("aria-pressed", String(archived));
  return el("div", { class: "nav-head" }, el("span", { text: archived ? "Archived" : "Conversations" }), toggle,
    archived ? null : button("", h.newConversation, { class: "icon-btn", icon: "add", title: "New conversation" }));
}

/** An agent works in one of the project's conversations now (a chat turn, a discussion or a pipeline). */
export function projectBusy(items: readonly ConversationItem[] | undefined): boolean {
  return !!items?.some((c) => c.running);
}

const busyDot = (what: string): HTMLElement => el("span", { class: "busy-dot", title: what, attrs: { role: "img", "aria-label": what } });

/** The refresh button's tooltip: what it does, and how old the numbers are. */
export function accountRefreshTitle(a: Pick<SidebarAccount, "answer" | "looking" | "now">): string {
  if (a.looking) return "Looking up usage…";
  const age = a.answer ? updatedText(a.answer.at, a.now) : "";
  return age ? `Refresh · ${age}` : "Refresh";
}

/** Account & Usage, compact: each agent's email, then each limit as its name, percent and a thin meter; the plan and
 * when a limit resets are in tooltips. Settings → Claude & Codex has the full cards. */
function accountBox(a: SidebarAccount, h: SidebarHandlers): HTMLElement {
  const toggle = el("button", { class: "nav-head toggle", attrs: { type: "button", "aria-expanded": String(a.open) } },
    icon(a.open ? "chevron-down" : "chevron-right"), el("span", { text: "Account & Usage" }));
  toggle.addEventListener("click", h.toggleAccount);
  const refresh = a.open ? button("", h.refreshAccount, { class: a.looking ? "icon-btn spin" : "icon-btn", icon: "refresh", title: accountRefreshTitle(a), disabled: a.looking }) : null;
  const box = el("section", { class: "account-box", attrs: { "aria-label": "Account & Usage" } }, el("div", { class: "account-head" }, toggle, refresh));
  if (!a.open) return box;
  for (const agent of ["claude", "codex"] as const) {
    box.append(accountAgent(agent, a.answer?.value[agent] ?? (a.looking ? { status: "loading" } : null)));
  }
  return box;
}

function accountAgent(agent: Agent, state: UsageState | null): HTMLElement {
  const usage = state?.status === "ready" ? state.usage : null;
  const name = ACCOUNT_AGENTS[agent];
  const who = el("div", { class: "account-who", title: [name, usage?.email, usage?.account].filter(Boolean).join(" · ") },
    providerMark(agent),
    el("span", { class: "account-email", text: usage?.email ?? name }));
  const rows: Node[] = [];
  if (!state || state.status === "loading") rows.push(el("div", { class: "account-note", text: "Loading…" }));
  else if (state.status === "error") rows.push(el("div", { class: "account-note error", text: state.error, title: state.error }));
  else {
    // The extension's rows, folded: a limit's meter goes under its name, and when it resets becomes its tooltip.
    let limit: HTMLElement | null = null;
    for (const r of limitRows(state.usage)) {
      if (r.kind === "group") rows.push(el("div", { class: "account-group", text: r.text }));
      else if (r.kind === "limit") {
        limit = el("div", { class: "account-limit", title: r.text },
          el("div", { class: "account-line" }, el("span", { class: "usage-label", text: r.text }), el("span", { class: "usage-value", text: r.value ?? "" })));
        rows.push(limit);
      } else if (r.kind === "bar") limit?.append(meter(r.text, r.percent ?? 0));
      else if (r.kind === "muted" && limit) limit.title = `${limit.title}\n${r.text}`;
    }
    if (!rows.length) rows.push(el("div", { class: "account-note", text: "No limits to show." }));
  }
  return el("div", { class: "account-agent", attrs: { "data-backend": agent } }, who, ...rows);
}

/** The conversations of the open project (or of Conversations, outside one), as a group under it: their heading (the
 * archived list's toggle and +), the list or the archived list, and the project's resumable runs. */
function conversationGroup(m: SidebarModel, h: SidebarHandlers, projectId: string, activeConversation: string | null): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  if (m.archivedOpen) {
    const list = el("ul", { class: "nav-list conversations archived", attrs: { role: "list", "aria-label": "Archived conversations" } });
    if (m.archivedError) list.append(el("li", { class: "nav-empty error", text: m.archivedError }));
    else if (!m.archived) list.append(el("li", { class: "nav-empty", text: "Loading…" }));
    else if (!m.archived.length) list.append(el("li", { class: "nav-empty", text: "No archived conversations." }));
    for (const c of m.archived ?? []) {
      const main = el("button", { class: "nav-main", title: "Restore and open", attrs: { type: "button" } },
        el("span", { class: "nav-text" },
          el("span", { class: "nav-title", text: c.title }),
          el("span", { class: "nav-sub", text: c.archivedAt ? `Archived ${relativeTime(c.archivedAt)}` : "Archived" })));
      main.addEventListener("click", () => h.restoreConversation(c.id, true));
      const more = el("span", { class: "nav-actions" },
        button("", () => h.restoreConversation(c.id, false), { class: "icon-btn", icon: "discard", title: "Restore: back in the list" }),
        button("", () => h.deleteConversation(c), { class: "icon-btn delete", icon: "trash", title: "Delete with its logs and files…" }));
      list.append(el("li", { class: "nav-item conversation has-actions" }, main, more));
    }
    nodes.push(conversationsHead(true, h), list);
  } else {
    const items = m.conversations.get(projectId) ?? [];
    const list = el("ul", { class: "nav-list conversations", attrs: { role: "list", "aria-label": "Conversations" } });
    for (const c of items) {
      const isActive = c.id === activeConversation;
      // What needs the user first, then an agent at work; otherwise when it last changed.
      const status = c.waiting ? el("span", { class: "tag warn", text: `${c.waiting} waiting`, title: "Questions waiting for you" })
        : c.running ? busyDot("An agent is working")
        : el("span", { class: "nav-meta", text: relativeTime(c.updatedAt) });
      const main = el("button", { class: "nav-main", attrs: { type: "button", "aria-current": isActive ? "true" : null } },
        el("span", { class: "nav-text" },
          el("span", { class: "nav-title", text: c.title || "New conversation" }),
          c.activity ? el("span", { class: "nav-sub", text: c.activity }) : null),
        status);
      main.addEventListener("click", () => h.openConversation(c.id));
      // A conversation with something in it can be archived, once no agent works in it and nothing waits for you.
      const more = c.saved && !c.running && !c.waiting
        ? el("span", { class: "nav-actions" }, button("", () => h.archiveConversation(c.id), { class: "icon-btn", icon: "archive", title: "Archive" }))
        : null;
      list.append(el("li", { class: `nav-item conversation${isActive ? " active" : ""}${more ? " has-actions" : ""}` }, main, more));
    }
    if (!items.length) list.append(el("li", { class: "nav-empty", text: "No conversations yet." }));
    nodes.push(conversationsHead(false, h), list);
  }

  if (projectId !== CONVERSATIONS_PROJECT_ID) {
    const runsHead = el("button", { class: "nav-head toggle", attrs: { type: "button", "aria-expanded": String(m.runsOpen) } },
      icon(m.runsOpen ? "chevron-down" : "chevron-right"), el("span", { text: "Resumable runs" }));
    runsHead.addEventListener("click", h.toggleRuns);
    nodes.push(runsHead);
    if (m.runsOpen) {
      const runs = el("ul", { class: "nav-list runs", attrs: { role: "list", "aria-label": "Resumable runs" } });
      if (m.runsError) runs.append(el("li", { class: "nav-empty error", text: m.runsError }));
      else if (!m.runs) runs.append(el("li", { class: "nav-empty", text: "Loading…" }));
      else if (!m.runs.length) runs.append(el("li", { class: "nav-empty", text: "No stopped or waiting runs." }));
      for (const r of m.runs ?? []) {
        const b = el("button", { class: "nav-main", title: `Resume ${r.id}`, attrs: { type: "button" } },
          el("span", { class: "nav-text" }, el("span", { class: "nav-title", text: r.task || r.id }), el("span", { class: "nav-sub", text: `${r.phase} · ${relativeTime(r.updatedAt) || r.id}` })),
          icon("debug-continue"));
        b.addEventListener("click", () => h.resume(r.id));
        runs.append(el("li", { class: "nav-item run" }, b));
      }
      nodes.push(runs);
    }
  }
  return nodes;
}

export function renderSidebar(root: HTMLElement, m: SidebarModel, h: SidebarHandlers): void {
  const snap = m.snapshot;
  const active = snap?.active ?? { projectId: null, conversationId: null };
  const brand = el("div", { class: "brand" },
    el("span", { class: "brand-mark", attrs: { "aria-hidden": "true" } }, el("span", { class: "dot dot-codex" }), el("span", { class: "dot dot-claude" })),
    el("span", { class: "brand-name", text: "AgentDuo" }));
  // The first thing to reach for, as in the menu (File → New Conversation): in the open project, or a project to open.
  const start = el("div", { class: "side-start" }, button("New conversation", h.newConversation, { class: "nav-main side-new", icon: "add" }));

  const general = button("Conversations", () => h.selectProject(CONVERSATIONS_PROJECT_ID), { class: "nav-main general-conversations", icon: "comment-discussion", title: "Chats without a project" });
  const generalActive = active.projectId === CONVERSATIONS_PROJECT_ID;
  general.setAttribute("aria-current", String(generalActive));
  if (projectBusy(m.conversations.get(CONVERSATIONS_PROJECT_ID))) general.append(busyDot("An agent is working in a conversation"));
  const sections: Node[] = [general];
  if (generalActive) sections.push(el("div", { class: "project-group", attrs: { role: "group", "aria-label": "Conversations without a project" } }, ...conversationGroup(m, h, CONVERSATIONS_PROJECT_ID, active.conversationId)));

  const projects = el("ul", { class: "nav-list projects", attrs: { role: "list", "aria-label": "Projects" } });
  for (const p of snap?.projects ?? []) {
    if (p.id === CONVERSATIONS_PROJECT_ID) continue;
    const isActive = p.id === active.projectId;
    const row = el("li", { class: `nav-item project${isActive ? " active" : ""}${p.missing ? " missing" : ""}` });
    const main = el("button", { class: "nav-main", title: p.path, attrs: { type: "button", "aria-current": isActive ? "true" : null, "aria-expanded": String(isActive) } },
      icon(p.missing ? "warning" : isActive ? "folder-opened" : "folder"),
      el("span", { class: "nav-title", text: p.name }),
      projectBusy(m.conversations.get(p.id)) ? busyDot("An agent is working in this project") : null,
      p.missing ? el("span", { class: "tag warn", text: "missing", title: "The folder is gone" }) : null);
    main.addEventListener("click", () => h.selectProject(p.id));
    const more = el("span", { class: "nav-actions" },
      isActive ? button("", () => h.restartProject(p.id), { class: "icon-btn", icon: "debug-restart", title: "Restart this project's worker" }) : null,
      button("", () => h.forgetProject(p.id), { class: "icon-btn", icon: "close", title: "Remove from the list (its files stay)" }));
    row.append(main, more);
    projects.append(row);
    // The open project's conversations right under it, as its group.
    if (isActive) projects.append(el("li", { class: "project-group", attrs: { "aria-label": `Conversations in ${p.name}` } }, ...conversationGroup(m, h, p.id, active.conversationId)));
  }
  sections.push(el("div", { class: "nav-head" }, el("span", { text: "Projects" }), button("", h.openProject, { class: "icon-btn", icon: "folder-opened", title: "Open project…" })), projects);
  if (!snap?.projects.some((p) => p.id !== CONVERSATIONS_PROJECT_ID)) sections.push(button("Open project…", h.openProject, { class: "primary wide", icon: "folder-opened" }));

  const notice = updateNotice(m.update);
  const update = notice ? button(notice.label, () => h.update(notice.action), { class: "update-notice wide", icon: notice.action === "install" ? "debug-restart" : "cloud-download", title: notice.title }) : null;
  const foot = el("div", { class: "side-foot" }, update, accountBox(m.account, h), button("Settings", h.settings, { class: "ghost wide side-settings", icon: "settings-gear", title: "Settings" }));
  root.replaceChildren(brand, start, el("nav", { class: "side-scroll", attrs: { "aria-label": "Projects and conversations" } }, ...sections), foot);
}
