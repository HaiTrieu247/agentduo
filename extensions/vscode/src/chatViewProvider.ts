import * as vscode from "vscode";
import { parseWebviewMessage, type HostMessage, type WebviewMessage } from "./protocol.js";
import { makeNonce, webviewHtml } from "./webviewHtml.js";

export interface ChatViewHost {
  fromWebview(message: WebviewMessage): void;
  /** The webview went away or was hidden (its content is gone until it says "ready" again). */
  viewHidden(): void;
  log(line: string): void;
}

/** The sidebar. Its content is recreated whenever it is shown again; the host's state survives and is re-sent. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "agentduo.chat";
  private view: vscode.WebviewView | undefined;

  constructor(private readonly extensionUri: vscode.Uri, private readonly host: ChatViewHost) {}

  get visible(): boolean {
    return !!this.view?.visible;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    view.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [root] };
    view.webview.html = webviewHtml({
      cspSource: view.webview.cspSource, nonce: makeNonce(),
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(root, "main.js")).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(root, "styles.css")).toString(),
    });
    view.webview.onDidReceiveMessage((raw: unknown) => {
      let message: WebviewMessage;
      try {
        message = parseWebviewMessage(raw);
      } catch (e) {
        this.host.log(`ignored a message from the sidebar: ${(e as Error).message}`);
        return;
      }
      this.host.fromWebview(message);
    });
    view.onDidChangeVisibility(() => {
      if (!view.visible) this.host.viewHidden();
    });
    view.onDidDispose(() => {
      if (this.view !== view) return;
      this.view = undefined;
      this.host.viewHidden();
    });
  }

  post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  setBadge(count: number): void {
    if (this.view) this.view.badge = count ? { value: count, tooltip: `${count} question(s) from agentduo waiting for you` } : undefined;
  }
}
