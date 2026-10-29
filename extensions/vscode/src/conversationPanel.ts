import * as vscode from "vscode";
import { parseWebviewMessage, type HostMessage, type WebviewMessage } from "./protocol.js";
import { makeNonce, webviewHtml } from "./webviewHtml.js";

/** The webview panels of agentduo's conversations: one editor tab each, restored after a reload by its serializer. */
export const PANEL_TYPE = "agentduo.conversation";

export interface PanelHost {
  /** The tab's webview said something: it is ready (it needs its snapshot), or the user acted. */
  fromWebview(conversation: string, message: WebviewMessage): void;
  /** The tab is hidden: its content is gone until it says "ready" again. */
  hidden(conversation: string): void;
  /** The tab became the active one: the commands act on it. */
  focused(conversation: string): void;
  /** The tab was closed. */
  closed(conversation: string): void;
  log(line: string): void;
}

/** One conversation's editor tab: the chat webview, which the host feeds through `post`. */
export class ConversationPanel {
  private ready = false;
  /** For the webview once it is ready again (Settings asked for while it loads). */
  private waiting: HostMessage[] = [];
  private readonly bundle: vscode.Uri;
  /** Where else the tab may load from: its conversation's attached files, once the host checked where they are. */
  private readonly roots: string[];
  /** Roots the tab is to get with its next reload, which waits for its page to hand over its files. */
  private wanted: string[] = [];
  /** The page was asked to hand them over (`prepareReload`), and has not answered yet. */
  private asked = false;

  /** `roots`: the attachment roots known already, which the page gets from the start (no reload for them). */
  constructor(readonly conversation: string, readonly panel: vscode.WebviewPanel, extensionUri: vscode.Uri, private readonly host: PanelHost, roots: string[] = []) {
    const root = vscode.Uri.joinPath(extensionUri, "dist", "webview");
    this.bundle = root;
    this.roots = [...roots];
    panel.webview.options = this.options();
    panel.iconPath = { light: vscode.Uri.joinPath(extensionUri, "media", "agentduo-light.svg"), dark: vscode.Uri.joinPath(extensionUri, "media", "agentduo-dark.svg") };
    panel.webview.html = webviewHtml({
      cspSource: panel.webview.cspSource, nonce: makeNonce(),
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "main.js")).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "styles.css")).toString(),
      iconsUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "codicon.css")).toString(),
    });
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      let message: WebviewMessage;
      try {
        message = parseWebviewMessage(raw);
      } catch (e) {
        host.log(`ignored a message from a conversation tab: ${(e as Error).message}`);
        return;
      }
      if (message.type === "readyToReload") {
        if (this.asked) this.reload(true);
        return;
      }
      if (message.type === "ready") {
        this.ready = true;
        this.asked = false;
      }
      host.fromWebview(conversation, message);
      if (message.type === "ready") {
        this.flush();
        this.reload();
      }
    });
    panel.onDidChangeViewState(() => {
      if (panel.active) host.focused(conversation);
      if (!panel.visible) {
        this.ready = false;
        this.asked = false;
        host.hidden(conversation);
        // Its page is gone, and the files only it held with it: nothing more to wait for.
        this.reload();
      }
    });
    panel.onDidDispose(() => host.closed(conversation));
  }

  /**
   * Lets the tab load files from `root` (its conversation's attachments) besides its own bundle; true once it may.
   * VS Code reloads the webview when its options change, and the page holds the files its composer is still reading
   * (or handing over) and nowhere else: a page that is up is asked to hand them over first, and the options change
   * once it says it has (`readyToReload`); one that is not up has none. The host grants its URIs as it comes back.
   */
  allow(root: string): boolean {
    if (this.roots.includes(root)) return true;
    if (!this.wanted.includes(root)) this.wanted.push(root);
    this.reload();
    return false;
  }

  /** The wanted roots take effect: at once when no page is up, or once the page said it may go (`released`). */
  private reload(released = false): void {
    if (!this.wanted.length) return;
    if (this.ready && !released) {
      if (!this.asked) this.post({ type: "prepareReload" });
      this.asked = true;
      return;
    }
    this.roots.push(...this.wanted);
    this.wanted = [];
    this.asked = false;
    this.ready = false;
    this.panel.webview.options = this.options();
  }

  private options(): vscode.WebviewOptions {
    return { enableScripts: true, enableCommandUris: false, localResourceRoots: [this.bundle, ...this.roots.map((r) => vscode.Uri.file(r))] };
  }

  get visible(): boolean {
    return this.panel.visible;
  }

  post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  /** For a message the webview must see even if it is still loading: it goes once the webview says "ready". */
  postWhenReady(message: HostMessage): void {
    if (this.ready) this.post(message);
    else this.waiting.push(message);
  }

  private flush(): void {
    const waiting = this.waiting;
    this.waiting = [];
    for (const message of waiting) this.post(message);
  }

  setTitle(title: string): void {
    if (this.panel.title !== title) this.panel.title = title;
  }

  reveal(): void {
    this.panel.reveal(this.panel.viewColumn, false);
  }
}
