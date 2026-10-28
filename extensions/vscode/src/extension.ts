import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import * as vscode from "vscode";
import type { ViewState } from "../webview/state.js";
import { ARTIFACT_SCHEME, ChangeRegistry, SNAPSHOT_SCHEME } from "./artifacts.js";
import { ChatViewProvider } from "./chatViewProvider.js";
import { ArtifactContentProvider, changesToShow, openArtifact, openChanges, openDiff, SnapshotContentProvider } from "./diffProvider.js";
import type { ArtifactName, DecisionChoice, WebviewCommand, WebviewMessage } from "./protocol.js";
import { findNode } from "./workerClient.js";
import { emptyState, pickWorkspace, WorkspaceSession } from "./workspaceSession.js";

const REMEMBERED_FOLDER = "agentduo.workspaceFolder";
const CONFIG_TEMPLATE = `# agentduo configuration for this workspace; the keys and their defaults are listed in the agentduo README.
# Settings changed in the chat with --save are written here too.
`;

/** Which folder agentduo works in, its session, and everything that reaches the sidebar. */
class Controller implements vscode.Disposable {
  session: WorkspaceSession | null = null;
  readonly registry = new ChangeRegistry();
  readonly artifacts: ArtifactContentProvider;
  view!: ChatViewProvider;
  private generation = 0;
  private attached = false;

  constructor(private readonly context: vscode.ExtensionContext, readonly output: vscode.OutputChannel) {
    this.artifacts = new ArtifactContentProvider(() => this.session);
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
      void vscode.window.showInformationMessage("agentduo needs a folder: open the folder (inside a git repository) to work in.");
      return null;
    }
    await this.chooseWorkspace();
    return this.session;
  }

  private create(path: string): WorkspaceSession {
    return new WorkspaceSession({
      workspace: path, configPath: null, workerScript: this.context.asAbsolutePath(join("runtime", "worker.js")), env: process.env,
      resolveNode: () => findNode({ configured: vscode.workspace.getConfiguration("agentduo").get<string>("nodePath")?.trim() || null, env: process.env }),
      nextGeneration: () => ++this.generation,
      log: (line) => this.output.appendLine(line),
      onChange: (state) => this.onState(state),
      onQuestion: (kind, text) => this.onQuestion(kind, text),
    });
  }

  private onState(state: ViewState): void {
    void vscode.commands.executeCommand("setContext", "agentduo.running", state.status === "running");
    this.view.setBadge((state.decision ? 1 : 0) + state.permissions.length);
  }

  private onQuestion(kind: "decision" | "permission", text: string): void {
    if (this.view.visible) return;
    const what = kind === "decision" ? "agentduo needs your decision" : "Claude asks for permission";
    void vscode.window.showInformationMessage(`${what}: ${text.slice(0, 160)}`, "Open agentduo").then((answer) => {
      if (answer) void vscode.commands.executeCommand("agentduo.chat.focus");
    });
  }

  /** Changing folder closes the old session completely (its run stops and stays resumable, its lock is freed). */
  async switchTo(path: string | null): Promise<void> {
    const old = this.session;
    this.session = null;
    if (old) {
      old.detach();
      await old.dispose();
    }
    if (path) this.session = this.create(path);
    if (this.attached) this.viewReady();
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

  /** The webview (re)loaded: it gets the whole state. Opening the sidebar starts the worker, which only reads. */
  viewReady(): void {
    this.attached = true;
    const session = this.current();
    if (!session) {
      const none = !this.folders().length;
      this.view.post({ type: "snapshot", state: emptyState(none ? "no-folder" : "choose-folder") });
      return;
    }
    session.attach((message) => this.view.post(message));
    void session.start();
  }

  viewHidden(): void {
    this.attached = false;
    this.session?.detach();
  }

  fromWebview(message: WebviewMessage): void {
    if (message.type === "ready") return this.viewReady();
    if (message.type === "command") return void this.command(message.name);
    void (async () => {
      const session = await this.need();
      if (!session) return;
      switch (message.type) {
        case "submit":
          return session.submit(message.text);
        case "interrupt":
          return session.interrupt();
        case "toggleEdits":
          return session.toggleEdits();
        case "decision":
          return session.answerDecision(message.generation, message.id, message.decision, message.note);
        case "permission":
          return session.answerPermission(message.generation, message.id, message.answer);
      }
    })();
  }

  async command(name: WebviewCommand): Promise<void> {
    const artifacts: Partial<Record<WebviewCommand, ArtifactName>> = { openPlan: "plan", openReview: "review", openFeedback: "feedback", openReport: "report" };
    const artifact = artifacts[name];
    if (artifact) return this.openArtifact(artifact);
    switch (name) {
      case "configureNode":
        return void vscode.commands.executeCommand("workbench.action.openSettings", "agentduo.nodePath");
      case "restart":
        return void (await this.need())?.restart();
      default:
        return void vscode.commands.executeCommand(`agentduo.${name}`);
    }
  }

  async openArtifact(artifact: ArtifactName): Promise<void> {
    const session = await this.need();
    if (session) await openArtifact(session, this.artifacts, artifact);
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
    session.note(`doctor: ${failed ? "problems found" : "ready"} (details in the agentduo output)`, failed ? "error" : "info");
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
    const session = this.session;
    this.session = null;
    await session?.dispose();
    this.artifacts.dispose();
  }
}

let controller: Controller | undefined;

export interface TestApi {
  state(): ViewState | null;
  submit(text: string): Promise<void>;
  workerPid(): number | undefined;
  /** Answers the pending HUMAN_REVIEW decision as its buttons do. */
  decide(decision: DecisionChoice): Promise<void>;
  /** Open Changes, with `path` picked from its list; the two sides' URIs. */
  openDiff(path: string): Promise<{ base: vscode.Uri; snapshot: vscode.Uri }>;
}

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  const output = vscode.window.createOutputChannel("agentduo");
  const c = new Controller(context, output);
  controller = c;
  c.view = new ChatViewProvider(context.extensionUri, { fromWebview: (m) => c.fromWebview(m), viewHidden: () => c.viewHidden(), log: (line) => output.appendLine(line) });
  const withSession = (run: (session: WorkspaceSession) => unknown) => async () => {
    const session = await c.need();
    if (session) await run(session);
  };
  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, c.view),
    vscode.workspace.registerTextDocumentContentProvider(ARTIFACT_SCHEME, c.artifacts),
    vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, new SnapshotContentProvider(() => c.session, c.registry)),
    vscode.commands.registerCommand("agentduo.openChat", () => vscode.commands.executeCommand("agentduo.chat.focus")),
    vscode.commands.registerCommand("agentduo.stop", withSession((s) => s.interrupt())),
    vscode.commands.registerCommand("agentduo.resume", withSession(async (s) => {
      await vscode.commands.executeCommand("agentduo.chat.focus");
      await s.submit("/resume");
    })),
    vscode.commands.registerCommand("agentduo.newTask", withSession(async (s) => {
      await vscode.commands.executeCommand("agentduo.chat.focus");
      await s.submit("/new");
      c.view.post({ type: "focusComposer" });
    })),
    vscode.commands.registerCommand("agentduo.openPlan", () => c.openArtifact("plan")),
    vscode.commands.registerCommand("agentduo.openReport", () => c.openArtifact("report")),
    vscode.commands.registerCommand("agentduo.openChanges", withSession((s) => openChanges(s, c.registry))),
    vscode.commands.registerCommand("agentduo.doctor", () => c.doctor()),
    vscode.commands.registerCommand("agentduo.openConfiguration", () => c.openConfiguration()),
    vscode.commands.registerCommand("agentduo.chooseWorkspace", () => c.chooseWorkspace()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void c.foldersChanged()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      // A fixed agentduo.nodePath takes effect at once for a session that could not start.
      if (e.affectsConfiguration("agentduo.nodePath") && c.session?.state.problem?.kind === "node") void c.session.restart();
    }),
  );
  if (context.extensionMode !== vscode.ExtensionMode.Test) return undefined;
  return {
    state: () => c.session?.state ?? null,
    submit: async (text) => {
      const session = await c.need();
      await session?.submit(text);
    },
    workerPid: () => c.session?.workerPid,
    decide: async (decision) => {
      const session = c.session;
      const pending = session?.state.decision;
      if (!session || !pending) throw new Error("no decision is pending");
      await session.answerDecision(session.state.generation, pending.id, decision, null);
    },
    openDiff: async (path) => {
      const session = await c.need();
      const list = session && (await changesToShow(session, c.registry));
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
