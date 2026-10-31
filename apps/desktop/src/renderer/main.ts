// The desktop window: projects and conversations on the left, the active conversation's chat in the middle (the VS
// Code tab's own UI), its run on the right (plan, changes, checks), Settings and the first-run setup over them. The
// page has no Node and no Electron: it asks main through the preload, and main pushes what changed.
import type { WebviewCommand } from "../../../../extensions/vscode/src/protocol.js";
import { CONVERSATIONS_PROJECT_ID } from "../shared/protocol.js";
import type { AppSnapshot, ConversationItem, DesktopEvent, Preferences, UpdateState } from "../shared/protocol.js";
import { updatedText } from "../../../../extensions/vscode/webview/account.js";
import { button, call, el, errorText, onEvent } from "./bridge.js";
import { ChatHost, chatStatus, type Mount } from "./chat.js";
import { Inspector, type InspectorTab } from "./inspector.js";
import { Onboarding } from "./onboarding.js";
import { SettingsPanel, type SettingsSection } from "./settings.js";
import { renderSidebar, type SidebarModel } from "./sidebar.js";
import { applyAppearance } from "./theme.js";
import { restartQuestion } from "./update.js";
import { turnEnded, USAGE_PERIOD_MS, USAGE_STALE_MS, UsageStore } from "./usage.js";

const NARROW = 900;

const root = document.getElementById("root")!;
const sidebar = el("aside", { class: "sidebar", attrs: { "aria-label": "Projects and conversations" } });
const topTitle = el("span", { class: "top-title" });
const topStatus = el("span", { class: "top-status", attrs: { role: "status", "aria-live": "polite" } });
const inspectorToggle = button("", () => void toggleInspector(), { class: "icon-btn", icon: "layout-sidebar-right", title: "Plan, changes and checks" });
const topbar = el("header", { class: "topbar" }, topTitle, topStatus, el("span", { class: "spacer" }), inspectorToggle);
const chatArea = el("div", { class: "chat-area" });
const empty = el("div", { class: "center-empty" });
const center = el("main", { class: "center" }, topbar, chatArea, empty);
const inspectorEl = el("aside", { class: "inspector", attrs: { "aria-label": "Run inspector" } });
const settingsEl = el("section", { class: "overlay settings", attrs: { role: "dialog", "aria-label": "Settings" } });
const onboardEl = el("section", { class: "overlay onboarding" });
const toast = el("div", { class: "toast", attrs: { role: "alert" } });
settingsEl.hidden = true;
onboardEl.hidden = true;
toast.hidden = true;
root.replaceChildren(el("div", { class: "workbench" }, sidebar, center, inspectorEl), settingsEl, onboardEl, toast);

let snapshot: AppSnapshot | null = null;
const current = (): AppSnapshot | null => snapshot;
const model: SidebarModel = {
  snapshot: null, conversations: new Map<string, ConversationItem[]>(), runs: null, runsOpen: false, runsError: null,
  account: { open: true, answer: null, looking: false, now: Date.now() },
  update: { status: "idle" },
};
const usage = new UsageStore((projectId) => call({ method: "account.usage", projectId }));
let inspectorOpen = true;
let narrowOverride: boolean | null = null;

function showError(e: unknown): void {
  toast.textContent = errorText(e);
  toast.hidden = false;
  setTimeout(() => (toast.hidden = true), 6000);
}

const chats = new ChatHost(chatArea, {
  command: (name: WebviewCommand, mount: Mount) => {
    const artifacts: Partial<Record<WebviewCommand, [InspectorTab, "plan" | "review" | "feedback" | "report"]>> = {
      openPlan: ["plan", "plan"], openReview: ["report", "review"], openFeedback: ["report", "feedback"], openReport: ["report", "report"],
    };
    const a = artifacts[name];
    if (a) {
      openInspector(a[0], a[1]);
      return true;
    }
    switch (name) {
      case "openChanges":
        openInspector("changes");
        return true;
      case "doctor":
        openSettings("diagnostics");
        return true;
      case "openConfiguration":
        openSettings("configuration");
        return true;
      case "chooseWorkspace":
        void openProject();
        return true;
      default:
        void mount;
        return false;
    }
  },
  changed: (mount) => {
    if (chats.active() === mount) drawTop();
  },
});

const inspector = new Inspector(inspectorEl, () => {
  const m = chats.active();
  return { projectId: snapshot?.active.projectId ?? null, conversationId: snapshot?.active.conversationId ?? m?.conversationId ?? null, state: m?.state ?? null };
}, () => void toggleInspector(false));

const settings = new SettingsPanel(settingsEl, {
  snapshot: () => snapshot,
  setPrefs: (patch) => setPrefs(patch),
  codexModels: () => chats.codexCatalog()?.models ?? null,
  usage,
  update: () => model.update,
  checkUpdate: () => checkUpdate(),
  installUpdate: () => installUpdate(),
  downloadUpdate: () => void call({ method: "link.open", link: "agentduo-releases" }).catch(showError),
  close: () => {
    settingsEl.hidden = true;
    chats.focus();
  },
});

const onboarding = new Onboarding(onboardEl, {
  usage,
  openProject: () => openProject(),
  done: async () => {
    await setPrefs({ onboarded: true });
    onboardEl.hidden = true;
    chats.focus();
  },
});

// ------------------------------------------------------------------ state
function setSnapshot(next: AppSnapshot): void {
  document.body.classList.toggle("platform-darwin", next.platform === "darwin");
  const before = snapshot?.active;
  snapshot = next;
  model.snapshot = next;
  setUpdate(next.update);
  inspectorOpen = next.prefs.inspector;
  applyAppearance({ theme: next.prefs.theme, dark: next.dark, fontSize: next.prefs.fontSize });
  if (before?.projectId !== next.active.projectId) {
    model.runs = null;
    model.runsError = null;
    if (model.runsOpen && snapshot?.active.projectId !== CONVERSATIONS_PROJECT_ID) void loadRuns();
  }
  if (before?.projectId !== next.active.projectId) freshenUsage(USAGE_STALE_MS);
  if (before?.projectId !== next.active.projectId || before?.conversationId !== next.active.conversationId) {
    void showActive().catch(showError);
    inspector.reset();
  }
  layout();
  drawSidebar();
  drawTop();
}

// ------------------------------------------------------------------ the app's update
// Main pushes each step (checking, downloading, ready…); the snapshot keeps the latest, so a later copy of it (a
// preference saved) does not bring an older step back.
function setUpdate(state: UpdateState): void {
  model.update = state;
  if (snapshot && snapshot.update !== state) snapshot = model.snapshot = { ...snapshot, update: state };
  settings.updateChanged();
}

async function checkUpdate(): Promise<void> {
  await call({ method: "update.check" }).catch(showError);
}

/** Restarts into the downloaded version: asked first when agents are working (restarting stops them). */
function installUpdate(): void {
  let running = 0;
  for (const items of model.conversations.values()) running += items.filter((c) => c.running).length;
  const question = restartQuestion(running);
  if (question && !confirm(question)) return;
  void call({ method: "update.install" }).catch(showError);
}

async function setPrefs(patch: Partial<Preferences>): Promise<void> {
  const prefs = await call({ method: "prefs.set", patch });
  if (snapshot) setSnapshot({ ...snapshot, prefs });
}

/** The active project's active conversation in the middle; a project with none opens a new one. */
async function showActive(): Promise<void> {
  const projectId = snapshot?.active.projectId ?? null;
  let conversationId = snapshot?.active.conversationId ?? null;
  if (!projectId) {
    chats.hideAll();
    drawEmpty();
    return;
  }
  empty.hidden = true;
  chatArea.hidden = false;
  try {
    if (!conversationId) {
      conversationId = (await call({ method: "conversation.new", projectId })).conversationId;
      if (snapshot && snapshot.active.projectId === projectId) snapshot = { ...snapshot, active: { projectId, conversationId } };
    }
    await chats.show(projectId, conversationId);
  } catch (e) {
    showError(e);
  }
  drawTop();
}

function drawEmpty(): void {
  chatArea.hidden = true;
  empty.hidden = false;
  empty.replaceChildren(
    el("div", { class: "brand-mark big", attrs: { "aria-hidden": "true" } }, el("span", { class: "dot dot-codex" }), el("span", { class: "dot dot-claude" })),
    el("h2", { text: "Start a conversation" }),
    el("p", { class: "muted", text: "Chat with Claude Code and Codex, /discuss a question until they agree, or run a /pipeline: Codex plans and reviews, Claude implements." }),
    button("New conversation", () => void call({ method: "project.select", projectId: CONVERSATIONS_PROJECT_ID }).then(setSnapshot, showError), { class: "primary", icon: "add" }),
    button("Open project…", () => void openProject(), { class: "ghost", icon: "folder-opened" }),
    button("Set up the CLIs", () => void showOnboarding(), { class: "ghost", icon: "checklist" }));
}

// ------------------------------------------------------------------ account & usage
/** The project whose config usage is looked up with: the active one, or the user config's CLIs outside a project. */
function usageProject(): string | null {
  const id = snapshot?.active.projectId ?? null;
  return id === CONVERSATIONS_PROJECT_ID ? null : id;
}

/** Looks usage up again for the sidebar when its numbers are older than maxAgeMs, unless the box is shut or the window hidden. */
function freshenUsage(maxAgeMs: number): void {
  if (!snapshot?.prefs.accountOpen || document.hidden) return;
  void usage.ensure(usageProject(), maxAgeMs);
}

let usageAge = "";
usage.subscribe(() => drawSidebar());
// Every 30 seconds: the numbers are looked up again once they are 5 minutes old, and the tooltip's "Updated 3 min
// ago" keeps its age (the sidebar is drawn again only when that changes).
window.setInterval(() => {
  freshenUsage(USAGE_PERIOD_MS);
  const a = usage.latest();
  if (a && updatedText(a.at, Date.now()) !== usageAge) drawSidebar();
}, 30_000);
document.addEventListener("visibilitychange", () => freshenUsage(USAGE_PERIOD_MS));

/** Each project's conversations an agent worked in at its last update. */
const working = new Map<string, Set<string>>();

function drawSidebar(): void {
  const answer = usage.latest();
  model.account = { open: snapshot?.prefs.accountOpen ?? true, answer, looking: usage.looking(usageProject()), now: Date.now() };
  usageAge = answer ? updatedText(answer.at, model.account.now) : "";
  renderSidebar(sidebar, model, {
    openProject: () => void openProject(),
    selectProject: (projectId) => void call({ method: "project.select", projectId }).then(setSnapshot, showError),
    forgetProject: (projectId) => {
      if (!confirm("Remove this project from the list? Its files and conversations stay where they are.")) return;
      chats.dropProject(projectId);
      void call({ method: "project.forget", projectId }).then(setSnapshot, showError);
    },
    restartProject: (projectId) => void call({ method: "project.restart", projectId }).catch(showError),
    newConversation: () => void newConversation(),
    openConversation: (conversationId) => void openConversation(conversationId),
    closeConversation: (conversationId) => {
      const projectId = snapshot?.active.projectId;
      if (!projectId) return;
      void chats.close(projectId, conversationId).then(() => {
        if (snapshot?.active.conversationId === conversationId) setSnapshot({ ...snapshot, active: { projectId, conversationId: null } });
      });
    },
    toggleRuns: () => {
      model.runsOpen = !model.runsOpen;
      if (model.runsOpen && snapshot?.active.projectId !== CONVERSATIONS_PROJECT_ID) void loadRuns();
      drawSidebar();
    },
    resume: (runId) => {
      if (!chats.submit(`/resume ${runId}`)) showError("Open a conversation first.");
    },
    toggleAccount: () => {
      const open = !(snapshot?.prefs.accountOpen ?? true);
      void setPrefs({ accountOpen: open }).then(() => freshenUsage(USAGE_STALE_MS), showError);
    },
    refreshAccount: () => void usage.refresh(usageProject()),
    update: (action) => (action === "install" ? installUpdate() : void call({ method: "link.open", link: "agentduo-releases" }).catch(showError)),
    settings: () => openSettings(),
  });
}

function drawTop(): void {
  const project = snapshot?.projects.find((p) => p.id === snapshot?.active.projectId);
  const items = project ? (model.conversations.get(project.id) ?? []) : [];
  const conv = items.find((c) => c.id === snapshot?.active.conversationId);
  topTitle.replaceChildren(
    el("strong", { text: project?.name ?? "AgentDuo" }),
    project ? el("span", { class: "muted", text: ` · ${conv?.title || "New conversation"}` }) : "");
  const m = chats.active();
  const s = m?.state ?? null;
  const busy = s ? s.status === "running" || s.status === "answering" : false;
  topStatus.className = `top-status${busy ? " running" : s?.decision || s?.permissions.length ? " waiting" : ""}`;
  topStatus.textContent = project ? chatStatus(s) : "";
  inspectorToggle.setAttribute("aria-pressed", String(inspectorShown()));
}

async function loadRuns(): Promise<void> {
  const projectId = snapshot?.active.projectId;
  if (!projectId) return;
  try {
    model.runs = await call({ method: "project.runs", projectId });
    model.runsError = null;
  } catch (e) {
    model.runsError = errorText(e);
  }
  drawSidebar();
}

async function openProject(): Promise<boolean> {
  try {
    const p = await call({ method: "project.open" });
    if (!p) return false;
    setSnapshot(await call({ method: "app.state" }));
    return true;
  } catch (e) {
    showError(e);
    return false;
  }
}

async function newConversation(): Promise<void> {
  const projectId = snapshot?.active.projectId;
  if (!projectId) return void openProject();
  try {
    const { conversationId } = await call({ method: "conversation.new", projectId });
    await openConversation(conversationId);
  } catch (e) {
    showError(e);
  }
}

async function openConversation(conversationId: string): Promise<void> {
  const projectId = snapshot?.active.projectId;
  if (!projectId || !snapshot) return;
  setSnapshot({ ...snapshot, active: { projectId, conversationId } });
}

// ------------------------------------------------------------------ panels
function inspectorShown(): boolean {
  if (window.innerWidth < NARROW) return narrowOverride ?? false;
  return inspectorOpen;
}

function layout(): void {
  const shown = inspectorShown();
  inspectorEl.hidden = !shown;
  document.body.classList.toggle("narrow", window.innerWidth < NARROW);
  inspectorToggle.setAttribute("aria-pressed", String(shown));
}

async function toggleInspector(force?: boolean): Promise<void> {
  const next = force ?? !inspectorShown();
  if (window.innerWidth < NARROW) narrowOverride = next;
  else {
    inspectorOpen = next;
    await setPrefs({ inspector: next }).catch(showError);
  }
  layout();
  if (next) void inspector.refresh();
}

function openInspector(tab: InspectorTab, artifact?: "plan" | "review" | "feedback" | "report"): void {
  if (!inspectorShown()) void toggleInspector(true);
  inspector.show(tab, artifact);
}

function openSettings(section?: SettingsSection): void {
  settingsEl.hidden = false;
  settings.open(section);
  settingsEl.querySelector<HTMLElement>("button")?.focus();
}

async function showOnboarding(): Promise<void> {
  onboardEl.hidden = false;
  await onboarding.open();
}

window.addEventListener("resize", () => {
  if (window.innerWidth >= NARROW) narrowOverride = null;
  layout();
});

// ------------------------------------------------------------------ events
function onDesktopEvent(e: DesktopEvent): void {
  switch (e.type) {
    case "app":
      return setSnapshot(e.snapshot);
    case "conversations":
      model.conversations.set(e.projectId, e.items);
      if (turnEnded(working, e.projectId, e.items)) freshenUsage(0);
      drawSidebar();
      return drawTop();
    case "host":
      return chats.onHost(e);
    case "update":
      setUpdate(e.state);
      return drawSidebar();
    case "theme":
      if (snapshot) {
        snapshot = { ...snapshot, dark: e.dark };
        applyAppearance({ theme: snapshot.prefs.theme, dark: e.dark, fontSize: snapshot.prefs.fontSize });
      }
      return;
    case "menu":
      switch (e.command) {
        case "newConversation":
          return void newConversation();
        case "openProject":
          return void openProject();
        case "settings":
          return openSettings();
        case "toggleInspector":
          return void toggleInspector();
        case "stop":
          return chats.interrupt();
        case "diagnostics":
          return openSettings("diagnostics");
        case "checkUpdates":
          openSettings("general");
          return void checkUpdate();
      }
  }
}

onEvent(onDesktopEvent);

void (async () => {
  try {
    setSnapshot(await call({ method: "app.state" }));
  } catch (e) {
    showError(e);
    drawEmpty();
    return;
  }
  const now = current();
  if (!now?.prefs.onboarded) await showOnboarding();
})();
