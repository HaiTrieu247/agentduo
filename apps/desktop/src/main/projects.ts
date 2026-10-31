// The projects the desktop knows and the session of each one opened: one WorkspaceSession (one worker) per project,
// kept while the user looks at another one, so its conversations go on in the background. A conversation's view is
// numbered each time it is attached: what the renderer sends names the view it came from, and a stale one is refused.
// No Electron import (dialogs and the clipboard come in through `DesktopHost`), so it is tested with a real worker.
import { homeFolder } from "../../../../src/paths.js";
import { CONVERSATIONS_PROJECT_ID } from "../shared/protocol.js";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { WorkspaceSession, type ConversationHandle } from "../../../../extensions/vscode/src/workspaceSession.js";
import type { ChangeList, HostMessage, WebviewMessage } from "../../../../extensions/vscode/src/protocol.js";
import type { NodeLookup } from "../../../../extensions/vscode/src/workerClient.js";
import type { ConfigScope } from "../../../../src/core/configuration.js";
import { listConversations } from "../../../../src/core/conversation.js";
import { RunStore, stamp } from "../../../../src/core/state.js";
import { safeFileName } from "../../../../src/core/attachments.js";
import { ATTACHMENT_LIMITS } from "../../../../src/core/attachment-types.js";
import { shownImages, type ViewState } from "../../../../extensions/vscode/webview/state.js";
import type { ConversationItem, DesktopEvent, ProjectSummary, RunItem } from "../shared/protocol.js";
import type { PreferencesStore } from "./preferences.js";
import type { ResourceTokens } from "./resources.js";

/** What the host does for a session that needs the window: pick files, copy text. */
export interface DesktopHost {
  pickFiles(): Promise<string[]>;
  copy(text: string): void;
  notify?(title: string, body: string): void;
}

export interface ProjectManagerOptions {
  prefs: PreferencesStore;
  tokens: ResourceTokens;
  host: DesktopHost;
  workerScript: string;
  /** The environment the worker and the agents get (the launcher PATH resolved). */
  env(): NodeJS.ProcessEnv;
  resolveNode(): NodeLookup;
  /** Where pasted and dropped files are written before the worker copies them. */
  stagingDir: string;
  post(event: DesktopEvent): void;
  log(line: string): void;
}

/** A project's id: a hash of its canonical path. */
export function projectIdOf(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

/** The folder as the projects list keeps it: absolute, symlinks resolved; null when it is not a directory. */
export function canonicalProject(path: string): string | null {
  try {
    const real = realpathSync(resolve(path));
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export const newConversationId = (): string => `${stamp(new Date())}-tab-${randomBytes(4).toString("hex")}`;
const newFileKey = (): string => `h${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;

/** A conversation's title: its first message, without a leading /claude, /codex… (as the extension's tabs). */
export function titleOf(state: ViewState): string {
  const first = state.timeline.find((i) => i.kind === "user");
  if (!first || first.kind !== "user") return "New conversation";
  const said = first.text || (first.attachments ?? []).map((a) => a.name).join(", ");
  const text = said.replace(/^\/(claude|codex|discuss|pipeline)\s+/, "").split("\n")[0]!.trim();
  return text.length > 48 ? `${text.slice(0, 47)}…` : text || "New conversation";
}

/** What a conversation is doing, in a few words, for the sidebar. */
export function activityOf(state: ViewState): string | null {
  if (state.decision) return "Waiting for your decision";
  if (state.permissions.length) return "Waiting for permission";
  if (state.status !== "running" && state.status !== "answering") return null;
  const last = [...state.timeline].reverse().find((i) => i.kind === "step" || i.kind === "answer" || i.kind === "discussion");
  const who = (agent: string | undefined) => (agent === "claude" ? "Claude" : agent === "codex" ? "Codex" : "AgentDuo");
  if (last?.kind === "step") {
    const s = last.step;
    return `${who(s.agent)}${s.role ? ` ${s.role.replace(/_/g, " ")}` : ""} · ${s.phase.toLowerCase()}${s.round ? ` · round ${s.round}` : ""}`.slice(0, 80);
  }
  if (last?.kind === "answer") return `${who(last.turn.backend)} answering`;
  if (last?.kind === "discussion") return `Discussing · ${who(last.discussion.answerer)} and ${who(last.discussion.critic)}`;
  return "Working";
}

interface Project {
  id: string;
  path: string;
  session: WorkspaceSession | null;
  /** The view number each attached conversation was last attached with. */
  views: Map<string, number>;
  /** Attachment URIs given to each view, by attachment id. */
  granted: Map<string, Map<string, string | null>>;
  listTimer: NodeJS.Timeout | null;
  /** Change lists handed out, by id: a file of one is asked for by the list and its index, never by path. */
  lists: Map<string, ChangeList>;
  /** Conversations made here and not opened yet: they start with the desktop's default recipient (a saved one keeps its own). */
  fresh: Set<string>;
}

export class ProjectManager {
  private readonly projects = new Map<string, Project>();
  private generation = 0;
  private viewCounter = 0;
  private listCounter = 0;
  private activeProject: string | null = null;
  private activeConversation: string | null = null;

  constructor(private readonly o: ProjectManagerOptions) {
    this.entry(homeFolder(o.env()), CONVERSATIONS_PROJECT_ID);
    this.activeProject = CONVERSATIONS_PROJECT_ID;
    for (const p of o.prefs.projects) this.entry(p.path);
    const active = o.prefs.active;
    if (active) this.activeProject = projectIdOf(active);
  }

  private entry(path: string, id = projectIdOf(path)): Project {
    let p = this.projects.get(id);
    if (!p) {
      p = { id, path, session: null, views: new Map(), granted: new Map(), listTimer: null, lists: new Map(), fresh: new Set() };
      this.projects.set(id, p);
    }
    return p;
  }

  get active(): { projectId: string | null; conversationId: string | null } {
    const projectId = this.activeProject && this.projects.has(this.activeProject) ? this.activeProject : null;
    const known = projectId === CONVERSATIONS_PROJECT_ID ? this.o.prefs.conversation : projectId ? this.o.prefs.projects.find((p) => projectIdOf(p.path) === projectId)?.conversation ?? null : null;
    return { projectId, conversationId: this.activeConversation ?? known };
  }

  summaries(): ProjectSummary[] {
    const general = this.project(CONVERSATIONS_PROJECT_ID);
    return [{ id: general.id, name: "Conversations", path: general.path, missing: false }, ...this.o.prefs.projects.flatMap((k) => {
      const p = this.projects.get(projectIdOf(k.path));
      if (!p) return [];
      return [{ id: p.id, name: basename(p.path) || p.path, path: p.path, missing: !existsSync(p.path) }];
    })];
  }

  /** The project, known to the list; throws for an id main never handed out. */
  project(id: string): Project {
    const p = this.projects.get(id);
    if (!p) throw new Error("no such project");
    return p;
  }

  path(id: string): string {
    return this.project(id).path;
  }

  /** A folder becomes a project (or is one already): remembered, made the active one, its worker started. */
  open(folder: string): ProjectSummary {
    const path = canonicalProject(folder);
    if (!path) throw new Error(`${folder} is not a folder`);
    this.o.prefs.remember(path);
    const p = this.entry(path);
    this.select(p.id);
    return this.summaries().find((s) => s.id === p.id)!;
  }

  select(id: string): void {
    const p = this.project(id);
    if (!existsSync(p.path)) throw new Error(`${p.path} is gone (moved or deleted)`);
    this.activeProject = id;
    this.activeConversation = id === CONVERSATIONS_PROJECT_ID ? this.o.prefs.conversation : this.o.prefs.projects.find((k) => k.path === p.path)?.conversation ?? null;
    this.o.prefs.setActive(p.id === CONVERSATIONS_PROJECT_ID ? null : p.path);
    void this.session(id).start().then(() => this.publishList(p));
  }

  /** The project's session, created on first use. */
  session(id: string): WorkspaceSession {
    const p = this.project(id);
    if (p.session) return p.session;
    const session = new WorkspaceSession({
      workspace: p.path,
      configPath: null,
      workerScript: this.o.workerScript,
      env: this.o.env(),
      resolveNode: () => this.o.resolveNode(),
      nextGeneration: () => ++this.generation,
      log: (line) => this.o.log(`[${basename(p.path)}] ${line}`),
      onChange: (conversation, state) => {
        this.scheduleList(p);
        this.grantImages(p, conversation, state, false);
      },
      onQuestion: (conversation, kind, text) => {
        if (this.activeProject === p.id && this.activeConversation === conversation) return;
        this.o.host.notify?.(kind === "decision" ? "AgentDuo needs your decision" : "Claude asks for permission", text.slice(0, 160));
      },
      onNewConversation: () => this.o.post({ type: "menu", command: "newConversation" }),
      // `/codex model … --global` (or the chat's settings menu with Global) in this project: the others read it too.
      onConfigWritten: (scope) => void this.syncConfiguration(scope, p.id, p.id),
    });
    p.session = session;
    return session;
  }

  /** A live session only: no worker is started for it. */
  liveSession(id: string): WorkspaceSession | null {
    return this.project(id).session;
  }

  /** The projects whose worker runs now. */
  liveProjects(): string[] {
    return [...this.projects.values()].filter((p) => p.session?.workerPid).map((p) => p.id);
  }

  /**
   * A config file was written (in Settings, by main or a project's worker, or by a chat command's --global): every
   * worker it concerns reads the files again, so its chats follow, as the writer's did. The user config concerns every
   * open project; each keeps its own file's overrides and its session's values. `except`: the project whose chat wrote
   * it (its chats follow already). A worker that cannot answer reads the files when it restarts.
   */
  async syncConfiguration(scope: ConfigScope, projectId: string | null, except: string | null = null): Promise<void> {
    if (scope === "session") return;
    const ids = scope === "global" ? this.liveProjects() : projectId ? [projectId] : [];
    await Promise.all(ids.filter((id) => id !== except).map(async (id) => {
      const p = this.projects.get(id);
      if (!p?.session?.workerPid) return;
      try {
        await p.session.request({ type: "syncConfiguration", workspace: p.path, configPath: null });
      } catch (e) {
        this.o.log(`${p.path} did not take the config change: ${(e as Error).message}`);
      }
    }));
  }

  private rememberConversation(p: Project, conversationId: string | null): void {
    if (p.id === CONVERSATIONS_PROJECT_ID) this.o.prefs.setGeneralConversation(conversationId);
    else this.o.prefs.setConversation(p.path, conversationId);
  }

  async forget(id: string): Promise<void> {
    if (id === CONVERSATIONS_PROJECT_ID) throw new Error("Conversations cannot be removed");
    const p = this.project(id);
    await this.stopProject(p);
    this.o.prefs.forget(p.path);
    this.projects.delete(id);
    if (this.activeProject === id) {
      this.activeProject = CONVERSATIONS_PROJECT_ID;
      this.activeConversation = null;
      this.o.prefs.setActive(null);
    }
  }

  async restart(id: string): Promise<void> {
    const p = this.project(id);
    this.o.tokens.revokeProject(id);
    p.granted.clear();
    p.lists.clear();
    await this.session(id).restart();
    this.publishList(p);
  }

  // ------------------------------------------------------------------ conversations
  newConversation(projectId: string): string {
    const p = this.project(projectId);
    const id = newConversationId();
    p.fresh.add(id);
    return id;
  }

  /** The conversation is shown: it gets its whole state under a new view number, then batches of actions. */
  openConversation(projectId: string, conversationId: string): void {
    const p = this.project(projectId);
    const session = this.session(projectId);
    const view = ++this.viewCounter;
    const owner = `${p.id}/${conversationId}`;
    const old = p.views.get(conversationId);
    if (old !== undefined) this.o.tokens.revoke(owner, old);
    p.views.set(conversationId, view);
    p.granted.delete(conversationId);
    this.activeProject = projectId;
    this.activeConversation = conversationId;
    this.o.prefs.setActive(p.id === CONVERSATIONS_PROJECT_ID ? null : p.path);
    this.rememberConversation(p, conversationId);
    const handle = session.conversation(conversationId);
    handle.attach((message: HostMessage) => {
      if (p.views.get(conversationId) !== view) return;
      this.o.post({ type: "host", projectId, conversationId, view, message });
      if (message.type === "snapshot") this.grantImages(p, conversationId, message.state, true);
    });
    // A new conversation's plain messages go where Settings says; one from the history keeps the recipient it had.
    if (p.fresh.delete(conversationId)) {
      void handle.selectRecipient(this.o.prefs.prefs.defaultRecipient).catch((e) => this.o.log(`could not choose the recipient: ${(e as Error).message}`));
    }
    void session.start().then(() => this.publishList(p));
    this.scheduleList(p);
  }

  /**
   * A conversation the window still shows is the selected one again: what main says is active (to the window after a
   * preference change, at the next start, for notifications) follows it. Its view and its chat stay as they are.
   */
  selectConversation(projectId: string, conversationId: string): void {
    const p = this.project(projectId);
    if (!p.views.has(conversationId)) throw new Error("that conversation is not open: open it first");
    this.activeProject = projectId;
    this.activeConversation = conversationId;
    this.o.prefs.setActive(p.id === CONVERSATIONS_PROJECT_ID ? null : p.path);
    this.rememberConversation(p, conversationId);
  }

  async closeConversation(projectId: string, conversationId: string): Promise<void> {
    const p = this.project(projectId);
    const view = p.views.get(conversationId);
    p.views.delete(conversationId);
    p.granted.delete(conversationId);
    if (view !== undefined) this.o.tokens.revoke(`${p.id}/${conversationId}`, view);
    if (this.activeConversation === conversationId) this.activeConversation = null;
    // Not the one to come back to at the next start either.
    if ((p.id === CONVERSATIONS_PROJECT_ID ? this.o.prefs.conversation : this.o.prefs.projects.find((k) => k.path === p.path)?.conversation) === conversationId) this.rememberConversation(p, null);
    await p.session?.conversation(conversationId).close();
    this.o.prefs.setDraft(p.path, conversationId, "");
    this.publishList(p);
  }

  /** What the chat of a view sent; false when that view is no longer the conversation's (a stale page). */
  chatMessage(projectId: string, conversationId: string, view: number, message: WebviewMessage): boolean {
    const p = this.project(projectId);
    if (p.views.get(conversationId) !== view) return false;
    const c = this.session(projectId).conversation(conversationId);
    switch (message.type) {
      case "submit":
        void c.submit(message.text, message.route, message.attachments);
        break;
      case "attach":
        void this.pickFiles(c);
        break;
      case "upload":
        void this.upload(c, message);
        break;
      case "detach":
        c.removeFile(message.key);
        break;
      case "recipient":
        void c.selectRecipient(message.backend);
        break;
      case "setting":
        void c.applySetting({ setting: message.setting, save: message.save, global: message.global, yes: message.yes });
        break;
      case "interrupt":
        void c.interrupt();
        break;
      case "cycleMode":
        void c.cycleMode();
        break;
      case "usage":
        void c.usage();
        break;
      case "decision":
        void c.answerDecision(message.generation, message.id, message.decision, message.note);
        break;
      case "permission":
        void c.answerPermission(message.generation, message.id, message.answer);
        break;
      case "copy":
        this.o.host.copy(message.text);
        break;
      case "command":
        switch (message.name) {
          case "stop":
            void c.interrupt();
            break;
          case "restart":
            void this.restart(projectId);
            break;
          case "resume":
            void c.submit("/resume");
            break;
          default:
            this.o.post({ type: "host", projectId, conversationId, view, message: { type: "focusComposer" } });
        }
        break;
      default:
        return false;
    }
    return true;
  }

  saveDraft(projectId: string, conversationId: string, text: string): void {
    this.o.prefs.setDraft(this.path(projectId), conversationId, text);
  }

  draft(projectId: string, conversationId: string): string {
    return this.o.prefs.draft(this.path(projectId), conversationId);
  }

  private async pickFiles(c: ConversationHandle): Promise<void> {
    for (const file of await this.o.host.pickFiles()) void c.stage({ key: newFileKey(), path: file, name: basename(file) });
  }

  /** A pasted or dropped file: decoded and checked here, written to a file of its own, staged, then removed. */
  private async upload(c: ConversationHandle, m: Extract<WebviewMessage, { type: "upload" }>): Promise<void> {
    c.uploading(m.key, m.name);
    const data = Buffer.from(m.data, "base64");
    if (data.length > ATTACHMENT_LIMITS.fileBytes) return c.failed(m.key, m.name, `a file can be at most ${ATTACHMENT_LIMITS.fileBytes} bytes`);
    const dir = join(this.o.stagingDir, `${m.key}-${randomBytes(4).toString("hex")}`);
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, safeFileName(m.name));
      writeFileSync(file, data);
      if (c.state.attachments.some((x) => x.key === m.key)) await c.stage({ key: m.key, path: file, name: m.name });
    } catch (e) {
      c.failed(m.key, m.name, (e as Error).message);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** The images a view shows become resource tokens it may load, each sent once per view. */
  private grantImages(p: Project, conversation: string, state: ViewState, fresh: boolean): void {
    const view = p.views.get(conversation);
    const session = p.session;
    if (view === undefined || !session) return;
    if (fresh) p.granted.delete(conversation);
    const images = shownImages(state);
    const root = images.length ? session.attachmentRoot(conversation) : null;
    if (!root) return;
    const known = p.granted.get(conversation) ?? new Map<string, string | null>();
    p.granted.set(conversation, known);
    const uris: Record<string, string | null> = {};
    for (const a of images) {
      if (known.has(a.id)) continue;
      const file = session.attachmentPath(conversation, a);
      const uri = file ? this.o.tokens.grant({ owner: `${p.id}/${conversation}`, view, root, file }) : null;
      known.set(a.id, uri);
      uris[a.id] = uri;
    }
    if (Object.keys(uris).length) this.o.post({ type: "host", projectId: p.id, conversationId: conversation, view, message: { type: "attachmentUris", uris } });
  }

  // ------------------------------------------------------------------ the list
  conversations(projectId: string): ConversationItem[] {
    const p = this.project(projectId);
    const session = p.session;
    const runsDir = session?.runsDirectory ?? null;
    const saved = runsDir ? listConversations(runsDir) : [];
    const live = new Set(session?.conversations ?? []);
    const item = (id: string, title: string, updatedAt: string | null): ConversationItem => {
      const st = session && live.has(id) ? session.conversation(id).state : null;
      return {
        id, title: st && st.timeline.length ? titleOf(st) : title || "New conversation", updatedAt, open: p.views.has(id),
        running: !!st && (st.status === "running" || st.status === "answering"), waiting: st ? (st.decision ? 1 : 0) + st.permissions.length : 0,
        activity: st ? activityOf(st) : null,
      };
    };
    const known = new Set(saved.map((c) => c.id));
    const unsaved = [...p.views.keys()].filter((id) => !known.has(id)).reverse().map((id) => item(id, "", null));
    return [...unsaved, ...saved.map((c) => item(c.id, c.title, c.updatedAt))];
  }

  /** Runs of the project that stopped or wait for a decision: /resume <id> continues one. */
  runs(projectId: string): RunItem[] {
    const runsDir = this.liveSession(projectId)?.runsDirectory;
    if (!runsDir) return [];
    const path = this.path(projectId);
    return RunStore.list(runsDir)
      .filter((st) => st.phase !== "DONE" && st.phase !== "ABORTED" && (!st.workspace || resolve(st.workspace) === path))
      .map((st) => ({ id: st.taskId, task: st.task.split("\n")[0]!.slice(0, 120), phase: st.phase, updatedAt: st.updatedAt ?? null }))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  private scheduleList(p: Project): void {
    p.listTimer ??= setTimeout(() => {
      p.listTimer = null;
      this.publishList(p);
    }, 300);
  }

  publishList(p: Project | string): void {
    const project = typeof p === "string" ? this.projects.get(p) : p;
    if (!project || !this.projects.has(project.id)) return;
    try {
      this.o.post({ type: "conversations", projectId: project.id, items: this.conversations(project.id) });
    } catch (e) {
      this.o.log(`could not list conversations: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ changes
  /** A run's changes, under an id the renderer names a file of it by. */
  registerChanges(projectId: string, list: ChangeList): string {
    const p = this.project(projectId);
    const id = `l${++this.listCounter}`;
    p.lists.set(id, list);
    while (p.lists.size > 50) p.lists.delete(p.lists.keys().next().value!);
    return id;
  }

  changeList(projectId: string, listId: string): ChangeList {
    const list = this.project(projectId).lists.get(listId);
    if (!list) throw new Error("that list of changes is no longer known; list them again");
    return list;
  }

  // ------------------------------------------------------------------ lifecycle
  private async stopProject(p: Project): Promise<void> {
    if (p.listTimer) clearTimeout(p.listTimer);
    p.listTimer = null;
    this.o.tokens.revokeProject(p.id);
    p.views.clear();
    p.granted.clear();
    p.fresh.clear();
    const session = p.session;
    p.session = null;
    await session?.dispose();
  }

  /** Quit: every view saved, every open question settled by its worker, every run stopped, every lock freed. */
  async dispose(): Promise<void> {
    this.o.prefs.flush();
    await Promise.all([...this.projects.values()].map((p) => this.stopProject(p)));
  }
}
