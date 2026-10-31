import * as vscode from "vscode";
import { parseAccountViewMessage, type AccountHostMessage, type AccountUsage, type AccountViewState } from "./protocol.js";
import { makeNonce, webviewHtml } from "./webviewHtml.js";

/** The Activity Bar's Account & Usage view, above the conversations. */
export const ACCOUNT_VIEW = "agentduo.account";
/** Numbers younger than this are not looked up again when the view shows, nor after an answer. */
export const STALE_MS = 60_000;
/** While the view shows, the numbers are looked up again this often. */
export const PERIOD_MS = 5 * 60_000;

export interface AccountSource {
  /** Both agents' accounts and limits, with the workspace's config; throws what to say when it cannot look. */
  read(): Promise<AccountUsage>;
  /** View details: a tab's usage panel, with all /usage says. */
  details(): void;
  log(line: string): void;
}

/**
 * Both agents' accounts and limits, as Claude Code's sidebar shows its own: looked up (about 2 s, no model call) when
 * the view first shows, when it shows again with numbers older than a minute, on ↻, every 5 minutes while it shows,
 * and after an answer or a run in any tab, at most once a minute. A hidden or collapsed view looks nothing up.
 */
export class AccountView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | null = null;
  private state: AccountViewState = { usage: null, updatedAt: null, refreshing: false, problem: null };
  /** When the latest lookup started (0: none yet). */
  private lookedAt = 0;
  /** Something changed since: the next due lookup is wanted even if the view stays hidden meanwhile. */
  private dirty = false;
  /** Asked again while a lookup was under way (another workspace): one more follows it. */
  private again = false;
  private period: NodeJS.Timeout | null = null;
  private soon: NodeJS.Timeout | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri, private readonly source: AccountSource, private readonly now: () => number = Date.now) {}

  get current(): AccountViewState {
    return this.state;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    view.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [root] };
    view.webview.html = webviewHtml({
      cspSource: view.webview.cspSource, nonce: makeNonce(),
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(root, "sidebar.js")).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(root, "sidebar.css")).toString(),
      iconsUri: view.webview.asWebviewUri(vscode.Uri.joinPath(root, "codicon.css")).toString(),
    });
    this.subscriptions.push(
      view.webview.onDidReceiveMessage((raw: unknown) => {
        try {
          const message = parseAccountViewMessage(raw);
          if (message.type === "ready") this.post();
          else if (message.type === "refresh") this.refresh();
          else this.source.details();
        } catch (e) {
          this.source.log(`ignored a message from the Account & Usage view: ${(e as Error).message}`);
        }
      }),
      view.onDidChangeVisibility(() => this.shown()),
      view.onDidDispose(() => {
        this.view = null;
        this.shown();
      }),
    );
    this.shown();
  }

  /** ↻: look up now (a lookup under way is the one asked for). */
  refresh(): void {
    if (this.state.refreshing) return;
    void this.lookUp();
  }

  /** The workspace changed: its config may run other CLIs, so look up again (after a lookup still under way), or once shown. */
  reset(): void {
    this.lookedAt = 0;
    if (this.state.refreshing) this.again = true;
    else if (this.view?.visible) this.refresh();
  }

  /** An answer or a run just ended somewhere: the limits moved. At most once a minute; a hidden view looks when shown. */
  changed(): void {
    this.dirty = true;
    this.due();
  }

  /** The view showed, hid or went: the 5-minute lookups run only while it shows, and a due lookup runs once it does. */
  private shown(): void {
    if (!this.view?.visible) {
      this.clear();
      return;
    }
    this.period ??= setInterval(() => this.refresh(), PERIOD_MS);
    if (!this.lookedAt || this.now() - this.lookedAt >= STALE_MS) this.refresh();
    else this.due();
  }

  /** A wanted lookup, now or once the latest one is a minute old; nothing while the view is hidden. */
  private due(): void {
    if (!this.dirty || !this.view?.visible || this.state.refreshing) return;
    const wait = this.lookedAt + STALE_MS - this.now();
    if (wait <= 0) return this.refresh();
    this.soon ??= setTimeout(() => {
      this.soon = null;
      this.due();
    }, wait);
  }

  private async lookUp(): Promise<void> {
    this.lookedAt = this.now();
    this.dirty = false;
    this.set({ refreshing: true });
    try {
      const usage = await this.source.read();
      this.set({ usage, updatedAt: this.now(), refreshing: false, problem: null });
    } catch (e) {
      this.set({ refreshing: false, problem: e instanceof Error ? e.message : String(e) });
    }
    if (this.again) {
      this.again = false;
      if (this.view?.visible) void this.lookUp();
    } else {
      this.due();
    }
  }

  private set(change: Partial<AccountViewState>): void {
    this.state = { ...this.state, ...change };
    this.post();
  }

  private post(): void {
    const message: AccountHostMessage = { type: "account", state: this.state };
    void this.view?.webview.postMessage(message);
  }

  private clear(): void {
    if (this.period) clearInterval(this.period);
    if (this.soon) clearTimeout(this.soon);
    this.period = null;
    this.soon = null;
  }

  dispose(): void {
    this.clear();
    for (const s of this.subscriptions.splice(0)) s.dispose();
    this.view = null;
  }
}
