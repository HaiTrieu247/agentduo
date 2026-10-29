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

  constructor(readonly conversation: string, readonly panel: vscode.WebviewPanel, extensionUri: vscode.Uri, private readonly host: PanelHost) {
    const root = vscode.Uri.joinPath(extensionUri, "dist", "webview");
    panel.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [root] };
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
      if (message.type === "ready") this.ready = true;
      host.fromWebview(conversation, message);
      if (message.type === "ready") this.flush();
    });
    panel.onDidChangeViewState(() => {
      if (panel.active) host.focused(conversation);
      if (!panel.visible) {
        this.ready = false;
        host.hidden(conversation);
      }
    });
    panel.onDidDispose(() => host.closed(conversation));
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
