import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as vscode from "vscode";
import { ATTACHMENT_LIMITS, formatBytes } from "../../../src/core/attachment-types.js";
import { safeFileName } from "../../../src/core/attachments.js";
import { listConversations } from "../../../src/core/conversation.js";
import { stamp } from "../../../src/core/state.js";
import { shownImages, type ViewState } from "../webview/state.js";
import { ARTIFACT_SCHEME, ChangeRegistry, SNAPSHOT_SCHEME } from "./artifacts.js";
import { ConversationPanel, PANEL_TYPE, type PanelHost } from "./conversationPanel.js";
import { ConversationsView, type ConversationEntry } from "./conversationsView.js";
import { ArtifactContentProvider, changesToShow, openArtifact, openChanges, openDiff, SnapshotContentProvider } from "./diffProvider.js";
import { isConversationId, type ArtifactName, type DecisionChoice, type WebviewCommand, type WebviewMessage } from "./protocol.js";
import { findNode } from "./workerClient.js";
import { emptyState, pickWorkspace, WorkspaceSession, type ConversationHandle } from "./workspaceSession.js";

const REMEMBERED_FOLDER = "agentduo.workspaceFolder";
const CONFIG_TEMPLATE = `# agentduo configuration for this workspace; the keys and their defaults are listed in the agentduo README.
# Settings changed in the chat with --save are written here too.
`;

/** A new conversation's id: also the name of its directory, so safe as a run id. */
const newConversationId = () => `${stamp(new Date())}-tab-${randomBytes(4).toString("hex")}`;
/** The host's name for a file it picked, until the worker gives it an id. */
const newFileKey = () => `h${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;

/** A tab's title: what its conversation is about (its first message, without a leading /claude, /codex…). */
export function titleOf(state: ViewState): string {
  const first = state.timeline.find((i) => i.kind === "user");
  if (!first || first.kind !== "user") return "agentduo";
  // A message of files alone is about the files.
  const said = first.text || (first.attachments ?? []).map((a) => a.name).join(", ");
  const text = said.replace(/^\/(claude|codex|discuss|pipeline)\s+/, "").split("\n")[0]!.trim();
  return text.length > 32 ? `${text.slice(0, 31)}…` : text || "agentduo";
}

/** Which folder agentduo works in, its session, its conversations' tabs, and everything that reaches them. */
class Controller implements vscode.Disposable, PanelHost {
  session: WorkspaceSession | null = null;
  readonly registry = new ChangeRegistry();
  readonly artifacts: ArtifactContentProvider;
  readonly panels = new Map<string, ConversationPanel>();
  readonly list: ConversationsView;
  tree!: vscode.TreeView<ConversationEntry>;
  /** The tab the commands act on: the one last active. */
  private lastActive: string | null = null;
  private generation = 0;
  private refreshTimer: NodeJS.Timeout | null = null;
  /** What each tab's title, status and questions were, so that streaming activity does not redraw the list. */
  private readonly shown = new Map<string, string>();
  /** The URIs each tab was given for its attached images (null: the copy is gone), so each goes once per webview. */
  private readonly granted = new Map<string, Map<string, string | null>>();

  constructor(private readonly context: vscode.ExtensionContext, readonly output: vscode.OutputChannel) {
    this.artifacts = new ArtifactContentProvider(() => this.session, () => this.active());
    this.list = new ConversationsView(() => this.entries());
  }

  private folders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath);
  }

  /** The chosen folder's session, created on first need; null while there is no folder, or several and none chosen. */
  current(): WorkspaceSession | null {
    const choice = pickWorkspace(this.folders(), this.context.workspaceState.get<string>(REMEMBERED_FOLDER) ?? null);
    if (choice.kind !== "folder") return null;
    if (this.session?.workspace === choice.path) return this.session;
    if (this.session) return this.session; // a switch is under way (switchTo replaces it)
    this.session = this.create(choice.path);
    return this.session;
  }

  /** The session for a command; asks for a folder when it has to. */
  async need(): Promise<WorkspaceSession | null> {
    const session = this.current();
    if (session) return session;
    if (!this.folders().length) {
      void vscode.window.showInformationMessage("agentduo needs a folder: open the folder to work in.");
      return null;
    }
    await this.chooseWorkspace();
    return this.session;
  }

  private create(path: string): WorkspaceSession {
    if (this.tree) this.tree.description = basename(path);
    return new WorkspaceSession({
      workspace: path, configPath: null, workerScript: this.context.asAbsolutePath(join("runtime", "worker.js")), env: process.env,
      resolveNode: () => findNode({ configured: vscode.workspace.getConfiguration("agentduo").get<string>("nodePath")?.trim() || null, env: process.env }),
      nextGeneration: () => ++this.generation,
      log: (line) => this.output.appendLine(line),
      onChange: (conversation, state) => this.onState(conversation, state),
      onQuestion: (conversation, kind, text) => this.onQuestion(conversation, kind, text),
      onNewConversation: () => void this.openConversation(null),
    });
  }

  // ------------------------------------------------------------------ tabs
  /** The conversation the commands act on: the tab last active, if it is still open. */
  active(): string | null {
    if (this.lastActive && this.panels.has(this.lastActive)) return this.lastActive;
    return [...this.panels.keys()].at(-1) ?? null;
  }

  /** The tab of `id` (a conversation from the list) or of a new conversation, beside the editors or with the other tabs. */
  async openConversation(id: string | null): Promise<string> {
    const conversation = id ?? newConversationId();
    const open = this.panels.get(conversation);
    if (open) {
      open.reveal();
      return conversation;
    }
    const near = this.active();
    const column = (near && this.panels.get(near)?.panel.viewColumn) || vscode.ViewColumn.Beside;
    const panel = vscode.window.createWebviewPanel(PANEL_TYPE, "agentduo", { viewColumn: column, preserveFocus: false }, {});
    this.adopt(conversation, panel);
    const saved = id ? this.entries().find((e) => e.id === id)?.title : null;
    if (saved) this.panels.get(conversation)?.setTitle(saved.length > 32 ? `${saved.slice(0, 31)}…` : saved);
    return conversation;
  }

  /** A tab of `conversation`: new, or one VS Code restored after a reload. */
  adopt(conversation: string, panel: vscode.WebviewPanel): void {
    // Where its attached files are, when the session knows already: the page may show them from the start.
    const root = this.session?.attachmentRoot(conversation);
    this.panels.set(conversation, new ConversationPanel(conversation, panel, this.context.extensionUri, this, root ? [root] : []));
    this.lastActive = conversation;
    this.refreshList();
  }

  /** The tab of the command, or a new one when none is open. */
  private async target(): Promise<string> {
    return this.active() ?? this.openConversation(null);
  }

  fromWebview(conversation: string, message: WebviewMessage): void {
    if (message.type === "ready") return this.attach(conversation);
    if (message.type === "command") return void this.command(message.name, conversation);
    void (async () => {
      const session = await this.need();
      if (!session) return;
      const c = session.conversation(conversation);
      switch (message.type) {
        case "submit":
          return c.submit(message.text, message.route, message.attachments);
        case "attach":
          return this.pickFiles(c);
        case "upload":
          return this.upload(c, message);
        case "detach":
          return c.removeFile(message.key);
        case "recipient":
          return c.selectRecipient(message.backend);
        case "setting":
          return c.applySetting({ setting: message.setting, save: message.save, yes: message.yes });
        case "interrupt":
          return c.interrupt();
        case "cycleMode":
          return c.cycleMode();
        case "usage":
          return c.usage();
        case "decision":
          return c.answerDecision(message.generation, message.id, message.decision, message.note);
        case "permission":
          return c.answerPermission(message.generation, message.id, message.answer);
      }
    })();
  }

  /** The tab's webview (re)loaded: it gets its whole state. Opening a tab starts the worker, which only reads. */
  private attach(conversation: string): void {
    const panel = this.panels.get(conversation);
    if (!panel) return;
    const session = this.current();
    if (!session) {
      panel.post({ type: "snapshot", state: emptyState(this.folders().length ? "choose-folder" : "no-folder"), conversation });
      return;
    }
    session.conversation(conversation).attach((message) => {
      panel.post(message);
      // A new webview knows no URI: it gets those of what it shows.
      if (message.type === "snapshot") this.grantImages(conversation, message.state, true);
    });
    void session.start();
  }

  // ------------------------------------------------------------------ attachments
  /** Attach: the user picks files on this computer; the worker copies each from where it is. */
  private async pickFiles(c: ConversationHandle): Promise<void> {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, canSelectFolders: false, openLabel: "Attach", title: "Attach files to your next message" });
    for (const uri of uris ?? []) {
      if (uri.scheme !== "file") c.failed(newFileKey(), basename(uri.path), "only files on this computer can be attached");
      else void c.stage({ key: newFileKey(), path: uri.fsPath, name: basename(uri.fsPath) });
    }
  }

  /** Where pasted and dropped files are written for the worker to copy: the extension's storage, or the temporary directory. */
  private stagingRoot(): vscode.Uri {
    const base = this.context.globalStorageUri.scheme === "file" ? this.context.globalStorageUri : vscode.Uri.file(join(tmpdir(), "agentduo-vscode"));
    return vscode.Uri.joinPath(base, "attachment-staging");
  }

  /** Removes every staged file (at start, a crash may have left some). */
  async clearStaging(): Promise<void> {
    await Promise.resolve(vscode.workspace.fs.delete(this.stagingRoot(), { recursive: true, useTrash: false })).catch(() => undefined);
  }

  /**
   * A file the tab pasted or dropped, as base64: decoded and checked here, written to a file of its own in the staging
   * directory, which the worker copies by path (bytes never go to the worker), then removed whatever happened. Its chip
   * comes first, before anything is awaited, so files keep the order the tab sent them in and a message waits for them.
   */
  async upload(c: ConversationHandle, m: Extract<WebviewMessage, { type: "upload" }>): Promise<void> {
    c.uploading(m.key, m.name);
    const data = Buffer.from(m.data, "base64");
    if (data.length > ATTACHMENT_LIMITS.fileBytes) {
      return c.failed(m.key, m.name, `it is ${formatBytes(data.length)}; a file can be at most ${formatBytes(ATTACHMENT_LIMITS.fileBytes)}`);
    }
    const dir = vscode.Uri.joinPath(this.stagingRoot(), `${m.key}-${randomBytes(4).toString("hex")}`);
    const file = vscode.Uri.joinPath(dir, safeFileName(m.name));
    try {
      await vscode.workspace.fs.writeFile(file, data);
      // Removed while it was written: nothing to stage.
      if (c.state.attachments.some((x) => x.key === m.key)) await c.stage({ key: m.key, path: file.fsPath, name: m.name });
    } catch (e) {
      c.failed(m.key, m.name, (e as Error).message);
    } finally {
      await Promise.resolve(vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false })).catch(() => undefined);
    }
  }

  /**
   * The tab may show its attached images: their copies under its conversation's attachment root (checked by the
   * session) become webview URIs, each sent once per webview; a copy that is gone gets null (a placeholder). A tab
   * that may not load from that root yet reloads first (once its page has handed over its files), and gets them then.
   */
  private grantImages(conversation: string, state: ViewState, fresh: boolean): void {
    const panel = this.panels.get(conversation);
    const session = this.session;
    if (!panel || !session) return;
    if (fresh) this.granted.delete(conversation);
    const images = shownImages(state);
    const root = images.length ? session.attachmentRoot(conversation) : null;
    if (!root || !panel.allow(root)) return;
    const known = this.granted.get(conversation) ?? new Map<string, string | null>();
    this.granted.set(conversation, known);
    const uris: Record<string, string | null> = {};
    for (const a of images) {
      if (known.has(a.id)) continue;
      const file = session.attachmentPath(conversation, a);
      const uri = file ? panel.panel.webview.asWebviewUri(vscode.Uri.file(file)).toString() : null;
      known.set(a.id, uri);
      uris[a.id] = uri;
    }
    if (Object.keys(uris).length) panel.post({ type: "attachmentUris", uris });
  }

  hidden(conversation: string): void {
    this.session?.conversation(conversation).detach();
  }

  focused(conversation: string): void {
    this.lastActive = conversation;
  }

  closed(conversation: string): void {
    this.panels.delete(conversation);
    this.shown.delete(conversation);
    this.granted.delete(conversation);
    if (this.lastActive === conversation) this.lastActive = null;
    void this.session?.conversation(conversation).close();
    this.refreshList();
    this.updateContext();
  }

  log(line: string): void {
    this.output.appendLine(line);
  }

  private onState(conversation: string, state: ViewState): void {
    this.grantImages(conversation, state, false);
    const title = titleOf(state);
    const seen = `${title}\n${state.status}\n${state.decision?.id ?? ""}\n${state.permissions.length}\n${state.timeline.length > 0}`;
    if (this.shown.get(conversation) === seen) return;
    this.shown.set(conversation, seen);
    this.panels.get(conversation)?.setTitle(title);
    this.updateContext();
    this.refreshList();
  }

  private updateContext(): void {
    const states = this.session ? [...this.panels.keys()].map((id) => this.session!.conversation(id).state) : [];
    void vscode.commands.executeCommand("setContext", "agentduo.running", states.some((s) => s.status === "running" || s.status === "answering"));
    const waiting = states.reduce((n, s) => n + (s.decision ? 1 : 0) + s.permissions.length, 0);
    if (this.tree) this.tree.badge = waiting ? { value: waiting, tooltip: `${waiting} question(s) from agentduo waiting for you` } : undefined;
  }

  private onQuestion(conversation: string, kind: "decision" | "permission", text: string): void {
    const panel = this.panels.get(conversation);
    if (panel?.visible) return;
    const what = kind === "decision" ? "agentduo needs your decision" : "Claude asks for permission";
    void vscode.window.showInformationMessage(`${what}: ${text.slice(0, 160)}`, "Open").then((answer) => {
      if (answer) void this.openConversation(conversation);
    });
  }

  // ------------------------------------------------------------------ the list
  /** The saved conversations and the open tabs, newest first. */
  private entries(): ConversationEntry[] {
    const session = this.session;
    const runsDir = session?.runsDirectory ?? null;
    const saved = runsDir ? listConversations(runsDir) : [];
    const state = (id: string) => (session && (this.panels.has(id) || session.conversations.includes(id)) ? session.conversation(id).state : null);
    const entry = (id: string, title: string, updatedAt: string | null): ConversationEntry => {
      const st = state(id);
      return {
        id, title: st && st.timeline.length ? titleOf(st) : title, updatedAt, open: this.panels.has(id),
        running: !!st && (st.status === "running" || st.status === "answering"), waiting: st ? (st.decision ? 1 : 0) + st.permissions.length : 0,
      };
    };
    const known = new Set(saved.map((c) => c.id));
    const unsaved = [...this.panels.keys()].filter((id) => !known.has(id)).reverse().map((id) => entry(id, "", null));
    return [...unsaved, ...saved.map((c) => entry(c.id, c.title, c.updatedAt))];
  }

  /** The list follows the tabs, at most every 300 ms while answers stream in. */
  private refreshList(): void {
    this.refreshTimer ??= setTimeout(() => {
      this.refreshTimer = null;
      this.list.refresh();
    }, 300);
  }

  // ------------------------------------------------------------------ workspace
  /** Changing folder closes the old session completely (its run stops and stays resumable, its lock is freed). */
  async switchTo(path: string | null): Promise<void> {
    const old = this.session;
    this.session = null;
    if (old) {
      for (const id of this.panels.keys()) old.conversation(id).detach();
      await old.dispose();
    }
    if (path) this.session = this.create(path);
    else if (this.tree) this.tree.description = undefined;
    for (const id of this.panels.keys()) this.attach(id);
    this.refreshList();
  }

  async chooseWorkspace(): Promise<void> {
    const folders = this.folders();
    if (!folders.length) {
      void vscode.window.showInformationMessage("agentduo needs a folder: open one first.");
      return;
    }
    const pick = await vscode.window.showQuickPick(folders.map((path) => ({ label: basename(path), description: path, path })), {
      title: "agentduo: workspace folder", placeHolder: "The folder agentduo works in (its runs, config and lock live there)",
    });
    if (!pick || pick.path === this.session?.workspace) return;
    await this.context.workspaceState.update(REMEMBERED_FOLDER, pick.path);
    await this.switchTo(pick.path);
  }

  async foldersChanged(): Promise<void> {
    const choice = pickWorkspace(this.folders(), this.context.workspaceState.get<string>(REMEMBERED_FOLDER) ?? null);
    const wanted = choice.kind === "folder" ? choice.path : null;
    if (wanted !== (this.session?.workspace ?? null)) await this.switchTo(wanted);
  }

  /** The list is shown: it needs the worker to say where the conversations are (the worker only reads). */
  listShown(): void {
    void this.current()?.start().then(() => this.refreshList());
  }

  // ------------------------------------------------------------------ commands
  async command(name: WebviewCommand, conversation: string | null = this.active()): Promise<void> {
    const artifacts: Partial<Record<WebviewCommand, ArtifactName>> = { openPlan: "plan", openReview: "review", openFeedback: "feedback", openReport: "report" };
    const artifact = artifacts[name];
    if (artifact) return this.openArtifact(artifact, conversation);
    switch (name) {
      case "configureNode":
        return void vscode.commands.executeCommand("workbench.action.openSettings", "agentduo.nodePath");
      case "restart":
        return void (await this.need())?.restart();
      case "openChanges": {
        const session = await this.need();
        return session ? openChanges(session, this.registry, conversation) : undefined;
      }
      case "resume":
        return this.submitTo(conversation, "/resume");
      case "stop":
        return void (conversation && this.session?.conversation(conversation).interrupt());
      default:
        return void vscode.commands.executeCommand(`agentduo.${name}`);
    }
  }

  /** A message for a tab (a new one when none is open), as if typed there. */
  async submitTo(conversation: string | null, text: string, route?: "message" | "pipeline"): Promise<void> {
    const session = await this.need();
    if (!session) return;
    const id = conversation ?? (await this.target());
    this.panels.get(id)?.reveal();
    await session.conversation(id).submit(text, route);
  }

  async openArtifact(artifact: ArtifactName, conversation: string | null = this.active()): Promise<void> {
    const session = await this.need();
    if (session) await openArtifact(session, this.artifacts, artifact, conversation);
  }

  async openSettings(): Promise<void> {
    const id = await this.target();
    const panel = this.panels.get(id);
    panel?.reveal();
    panel?.postWhenReady({ type: "showSettings" });
  }

  /** The title bar's Usage: the tab's usage panel opens, as /usage opens it. */
  async usage(): Promise<void> {
    const session = await this.need();
    if (!session) return;
    const id = await this.target();
    this.panels.get(id)?.reveal();
    await session.conversation(id).usage();
  }

  async doctor(): Promise<void> {
    const session = await this.need();
    if (!session) return;
    const out = this.output;
    const node = findNode({ configured: vscode.workspace.getConfiguration("agentduo").get<string>("nodePath")?.trim() || null, env: process.env });
    out.appendLine(`── agentduo doctor · ${session.workspace}`);
    out.appendLine(`  ✓ extension ${this.context.extension.packageJSON.version} in VS Code ${vscode.version}`);
    out.appendLine(node.ok ? `  ✓ engine Node ${node.version} (${node.path})` : `  ✗ ${node.message}`);
    let failed = !node.ok;
    if (node.ok) {
      try {
        const { checks } = await session.request({ type: "doctor" });
        for (const c of checks) {
          out.appendLine(`  ${c.ok ? "✓" : c.required ? "✗" : "!"} ${c.message}`);
          if (!c.ok && c.required) failed = true;
        }
      } catch (e) {
        failed = true;
        out.appendLine(`  ✗ ${(e as Error).message}`);
      }
    }
    out.appendLine(`doctor: ${failed ? "problems found" : "ready"}`);
    out.show(true);
    session.note(`doctor: ${failed ? "problems found" : "ready"} (details in the agentduo output)`, failed ? "error" : "info", this.active());
  }

  async openConfiguration(): Promise<void> {
    const session = await this.need();
    if (!session) return;
    const file = join(session.workspace, ".agentduo", "config.yaml");
    if (!existsSync(file)) {
      const answer = await vscode.window.showInformationMessage(
        `There is no ${join(".agentduo", "config.yaml")} in ${basename(session.workspace)} yet; agentduo uses its defaults (and your user config). Create one?`,
        "Create", "Cancel",
      );
      if (answer !== "Create") return;
      await vscode.workspace.fs.writeFile(vscode.Uri.file(file), new TextEncoder().encode(CONFIG_TEMPLATE));
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  }

  async dispose(): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const session = this.session;
    this.session = null;
    await session?.dispose();
    this.artifacts.dispose();
    this.list.dispose();
  }
}

let controller: Controller | undefined;

export interface TestApi {
  /** The state of the tab the commands act on (the last active one), or null when no tab is open. */
  state(): ViewState | null;
  /** As that tab's composer sends it: Send ("message") or the Pipeline route ("pipeline"); opens a tab if none is. */
  submit(text: string, route?: "message" | "pipeline"): Promise<void>;
  /** As that tab's recipient chip does. */
  selectRecipient(backend: "claude" | "codex"): Promise<void>;
  /** The conversations that have a tab open. */
  conversations(): string[];
  workerPid(): number | undefined;
  /** Answers that tab's pending HUMAN_REVIEW decision as its buttons do. */
  decide(decision: DecisionChoice): Promise<void>;
  /** Open Changes, with `path` picked from its list; the two sides' URIs. */
  openDiff(path: string): Promise<{ base: vscode.Uri; snapshot: vscode.Uri }>;
  /** As Attach does with a file the user picked: the active tab's next message gets a copy of the file at `path`. */
  attach(path: string): Promise<void>;
  /** As the composer does with a pasted or dropped file: its bytes go to the host as base64, which stages them. */
  upload(name: string, data: Buffer): Promise<void>;
  /** As the composer sends a message with every file that is ready. */
  submitWithFiles(text: string): Promise<void>;
}

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  const output = vscode.window.createOutputChannel("agentduo");
  const c = new Controller(context, output);
  controller = c;
  void c.clearStaging();
  c.tree = vscode.window.createTreeView("agentduo.conversations", { treeDataProvider: c.list });
  context.subscriptions.push(
    output,
    c.tree,
    c.tree.onDidChangeVisibility((e) => e.visible && c.listShown()),
    vscode.window.registerWebviewPanelSerializer(PANEL_TYPE, {
      // A tab VS Code restores after a reload: the conversation its webview kept, which carries on.
      deserializeWebviewPanel: async (panel, state: unknown) => {
        const kept = (state as { conversation?: unknown } | undefined)?.conversation;
        c.adopt(isConversationId(kept) ? kept : newConversationId(), panel);
      },
    }),
    vscode.workspace.registerTextDocumentContentProvider(ARTIFACT_SCHEME, c.artifacts),
    vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, new SnapshotContentProvider(() => c.session, c.registry)),
    // The editor title's agentduo button: back to the tab last used, or a new conversation beside the editors.
    vscode.commands.registerCommand("agentduo.openChat", async () => {
      const id = c.active();
      if (id) c.panels.get(id)?.reveal();
      else await c.openConversation(null);
    }),
    vscode.commands.registerCommand("agentduo.newTask", () => c.openConversation(null)),
    vscode.commands.registerCommand("agentduo.openConversation", (id: unknown) => c.openConversation(isConversationId(id) ? id : null)),
    vscode.commands.registerCommand("agentduo.stop", () => c.command("stop")),
    vscode.commands.registerCommand("agentduo.resume", () => c.command("resume")),
    vscode.commands.registerCommand("agentduo.openSettings", () => c.openSettings()),
    vscode.commands.registerCommand("agentduo.openPlan", () => c.openArtifact("plan")),
    vscode.commands.registerCommand("agentduo.openReport", () => c.openArtifact("report")),
    vscode.commands.registerCommand("agentduo.openChanges", () => c.command("openChanges")),
    vscode.commands.registerCommand("agentduo.usage", () => c.usage()),
    vscode.commands.registerCommand("agentduo.doctor", () => c.doctor()),
    vscode.commands.registerCommand("agentduo.openConfiguration", () => c.openConfiguration()),
    vscode.commands.registerCommand("agentduo.chooseWorkspace", () => c.chooseWorkspace()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void c.foldersChanged()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      // A fixed agentduo.nodePath takes effect at once for a session that could not start.
      if (e.affectsConfiguration("agentduo.nodePath") && c.session?.workspaceState.problem?.kind === "node") void c.session.restart();
    }),
  );
  if (context.extensionMode !== vscode.ExtensionMode.Test) return undefined;
  const tab = () => {
    const id = c.active();
    return id && c.session ? c.session.conversation(id) : null;
  };
  return {
    state: () => tab()?.state ?? null,
    submit: (text, route = "message") => c.submitTo(c.active(), text, route),
    selectRecipient: async (backend) => {
      await c.need();
      await tab()?.selectRecipient(backend);
    },
    conversations: () => [...c.panels.keys()],
    workerPid: () => c.session?.workerPid,
    decide: async (decision) => {
      const t = tab();
      const pending = t?.state.decision;
      if (!t || !pending) throw new Error("no decision is pending");
      await t.answerDecision(t.state.generation, pending.id, decision, null);
    },
    attach: async (path) => {
      const session = await c.need();
      const id = c.active() ?? (await c.openConversation(null));
      await session?.conversation(id).stage({ key: newFileKey(), path, name: basename(path) });
    },
    upload: async (name, data) => {
      const session = await c.need();
      const id = c.active() ?? (await c.openConversation(null));
      if (session) await c.upload(session.conversation(id), { type: "upload", key: newFileKey(), name, data: data.toString("base64") });
    },
    submitWithFiles: async (text) => {
      const t = tab();
      if (!t) throw new Error("no tab is open");
      const ids = t.state.attachments.flatMap((a) => (a.status === "ready" && a.attachment ? [a.attachment.id] : []));
      await t.submit(text, "message", ids);
    },
    openDiff: async (path) => {
      const session = await c.need();
      const list = session && (await changesToShow(session, c.registry, c.active()));
      const change = list?.changes.find((ch) => ch.path === path);
      if (!list || !change) throw new Error(`${path} is not among the focused run's changes`);
      return openDiff(list, change);
    },
  };
}

/** VS Code waits for this: the worker gets its shutdown grace, then is killed. */
export async function deactivate(): Promise<void> {
  await controller?.dispose();
  controller = undefined;
}
