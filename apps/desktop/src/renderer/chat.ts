// The conversations' chats, each the VS Code tab's own UI (createUi, reduce) fed as the extension feeds its webview:
// a snapshot, then batches of actions. One mount per open conversation; switching hides the others, so each keeps its
// state, its scroll and its half-typed message. What a chat sends goes to main with the view it was shown by, so an
// answer meant for an earlier view is refused there.
import type { HostMessage, WebviewCommand, WebviewMessage } from "../../../../extensions/vscode/src/protocol.js";
import { createUi } from "../../../../extensions/vscode/webview/render.js";
import { reduce, type ViewState } from "../../../../extensions/vscode/webview/state.js";
import type { CodexCatalog } from "../../../../src/core/models.js";
import type { DesktopEvent } from "../shared/protocol.js";
import { call, el, errorText } from "./bridge.js";

type Ui = ReturnType<typeof createUi>;

export interface Mount {
  projectId: string;
  conversationId: string;
  view: number;
  state: ViewState | null;
  ui: Ui | null;
  root: HTMLElement;
  /** Host messages that came before the UI was made (it waits for the conversation's saved draft). */
  queue: HostMessage[];
  frame: number;
  draftTimer: ReturnType<typeof setTimeout> | null;
}

export interface ChatHooks {
  /** A chat's command the window handles itself (the inspector, Settings, the folder picker); false: main handles it. */
  command(name: WebviewCommand, mount: Mount): boolean;
  /** A chat's state changed: the top bar and the inspector follow it. */
  changed(mount: Mount): void;
}

export const mountKey = (projectId: string, conversationId: string): string => `${projectId}/${conversationId}`;

const DRAFT_MS = 400;

export class ChatHost {
  private readonly mounts = new Map<string, Mount>();
  private activeKey: string | null = null;

  constructor(private readonly area: HTMLElement, private readonly hooks: ChatHooks) {
    setInterval(() => this.active()?.ui?.tick(), 1000);
  }

  active(): Mount | null {
    return this.activeKey ? (this.mounts.get(this.activeKey) ?? null) : null;
  }

  /** Codex's model catalog, as a chat's worker read it (the active chat's first); null until one listed models. */
  codexCatalog(): CodexCatalog | null {
    for (const m of [this.active(), ...this.mounts.values()]) {
      const codex = m?.state?.catalog?.codex;
      if (codex?.models.length) return codex;
    }
    return null;
  }

  has(projectId: string, conversationId: string): boolean {
    return this.mounts.has(mountKey(projectId, conversationId));
  }

  /** Shows the conversation, opening it with main the first time; the others stay as they are, hidden. */
  async show(projectId: string, conversationId: string): Promise<Mount> {
    const key = mountKey(projectId, conversationId);
    let mount = this.mounts.get(key);
    const opening = !mount;
    if (!mount) {
      const root = el("div", { class: "app chat-mount", attrs: { "aria-busy": "true" } });
      mount = { projectId, conversationId, view: 0, state: null, ui: null, root, queue: [], frame: 0, draftTimer: null };
      this.mounts.set(key, mount);
      this.area.append(root);
    }
    this.activeKey = key;
    for (const m of this.mounts.values()) m.root.hidden = m !== mount;
    if (opening) {
      let draft = "";
      try {
        const opened = (await call({ method: "conversation.open", projectId, conversationId })) as { conversationId: string; draft?: unknown };
        if (typeof opened.draft === "string") draft = opened.draft;
      } catch (e) {
        mount.queue.push({ type: "actions", actions: [{ type: "note", text: `Could not open the conversation: ${errorText(e)}`, tone: "error" }] });
      }
      if (this.mounts.get(key) === mount) this.makeUi(mount, draft);
    } else {
      mount.ui?.focusComposer();
      // Shown again: main's selection follows (it is what a preference change, the next start and notifications go by).
      await call({ method: "conversation.select", projectId, conversationId }).catch(() => undefined);
    }
    return mount;
  }

  private makeUi(mount: Mount, draft: string): void {
    const send = (message: WebviewMessage) => this.send(mount, message);
    mount.ui = createUi(mount.root, {
      submit: (text, route, attachments) => send({ type: "submit", text, route, attachments }),
      attach: () => send({ type: "attach" }),
      upload: (file) => send({ type: "upload", ...file }),
      removeFile: (key) => send({ type: "detach", key }),
      recipient: (backend) => send({ type: "recipient", backend }),
      setting: (request) => send({ type: "setting", ...request }),
      interrupt: () => send({ type: "interrupt" }),
      cycleMode: () => send({ type: "cycleMode" }),
      usage: () => send({ type: "usage" }),
      decide: (id, decision, note) => mount.state && send({ type: "decision", generation: mount.state.generation, id, decision, note }),
      permit: (id, answer) => mount.state && send({ type: "permission", generation: mount.state.generation, id, answer }),
      command: (name) => {
        if (!this.hooks.command(name, mount)) send({ type: "command", name });
      },
      copy: (text) => send({ type: "copy", text }),
      draft: (text) => {
        if (mount.draftTimer) clearTimeout(mount.draftTimer);
        mount.draftTimer = setTimeout(() => {
          mount.draftTimer = null;
          void call({ method: "chat.draft", projectId: mount.projectId, conversationId: mount.conversationId, text }).catch(() => undefined);
        }, DRAFT_MS);
      },
    }, draft);
    mount.root.removeAttribute("aria-busy");
    for (const m of mount.queue.splice(0)) this.receive(mount, m);
    if (!mount.root.hidden) mount.ui.focusComposer();
  }

  /** A chat's message for main; a refusal shows in that chat. */
  send(mount: Mount, message: WebviewMessage): void {
    void call({ method: "chat.message", projectId: mount.projectId, conversationId: mount.conversationId, view: mount.view, message }).catch((e) => {
      this.receive(mount, { type: "actions", actions: [{ type: "note", text: errorText(e), tone: "error" }] });
    });
  }

  /** What main pushed for a conversation's chat. */
  onHost(e: Extract<DesktopEvent, { type: "host" }>): void {
    const mount = this.mounts.get(mountKey(e.projectId, e.conversationId));
    if (!mount) return;
    if (e.view < mount.view) return; // an earlier view's: the conversation was opened again since
    mount.view = e.view;
    if (!mount.ui) mount.queue.push(e.message);
    else this.receive(mount, e.message);
  }

  private receive(mount: Mount, m: HostMessage): void {
    if (!mount.ui) {
      mount.queue.push(m);
      return;
    }
    if (m.type === "snapshot") mount.state = m.state;
    else if (m.type === "actions" && mount.state) for (const action of m.actions) mount.state = reduce(mount.state, action);
    else if (m.type === "focusComposer") mount.ui.focusComposer();
    else if (m.type === "showSettings") mount.ui.showSettings();
    else if (m.type === "attachmentUris") mount.ui.setUris(m.uris);
    else if (m.type === "prepareReload") mount.ui.release(() => undefined);
    this.schedule(mount);
  }

  private schedule(mount: Mount): void {
    if (mount.frame) return;
    mount.frame = requestAnimationFrame(() => {
      mount.frame = 0;
      if (mount.state && mount.ui) mount.ui.update(mount.state);
      this.hooks.changed(mount);
    });
  }

  /** Sends a line as if typed in the active chat (Resume from the sidebar). */
  submit(text: string): boolean {
    const mount = this.active();
    if (!mount) return false;
    this.send(mount, { type: "submit", text, route: "message", attachments: [] });
    return true;
  }

  interrupt(): void {
    const mount = this.active();
    if (mount) this.send(mount, { type: "interrupt" });
  }

  showSettings(): void {
    this.active()?.ui?.showSettings();
  }

  focus(): void {
    this.active()?.ui?.focusComposer();
  }

  /** A conversation's chat goes (closed): main is told, the mount is removed. */
  async close(projectId: string, conversationId: string): Promise<void> {
    const key = mountKey(projectId, conversationId);
    const mount = this.mounts.get(key);
    if (mount) {
      if (mount.draftTimer) clearTimeout(mount.draftTimer);
      mount.root.remove();
      this.mounts.delete(key);
    }
    if (this.activeKey === key) this.activeKey = null;
    await call({ method: "conversation.close", projectId, conversationId }).catch(() => undefined);
  }

  /** Every chat of a project goes from the page (the project was forgotten); main closes them itself. */
  dropProject(projectId: string): void {
    for (const [key, mount] of this.mounts) {
      if (mount.projectId !== projectId) continue;
      mount.root.remove();
      this.mounts.delete(key);
      if (this.activeKey === key) this.activeKey = null;
    }
  }

  /** Nothing is shown (another project without an open conversation, or none). */
  hideAll(): void {
    this.activeKey = null;
    for (const m of this.mounts.values()) m.root.hidden = true;
  }
}

/** A few words on what a chat is doing, for the top bar. */
export function chatStatus(s: ViewState | null): string {
  if (!s) return "starting…";
  if (s.decision) return "waiting for your decision";
  if (s.permissions.length) return `${s.permissions.length} permission question(s) waiting`;
  if (s.discussion && !s.discussion.status) return `discussing · round ${Math.max(1, s.discussion.turns.length)} of ${s.discussion.maxRounds}`;
  if (s.current) {
    const who = s.current.agent ? `${s.current.agent}` : "AgentDuo";
    return `${who} · ${s.current.phase.toLowerCase()}${s.current.round ? ` · round ${s.current.round}` : ""}`;
  }
  if (s.turn) return `${s.turn.backend} answering`;
  if (s.status === "running" || s.status === "answering") return "working";
  if (s.ended) return `run ${s.ended.toLowerCase()}`;
  if (s.session === "stopped") return "worker stopped";
  return "ready";
}
