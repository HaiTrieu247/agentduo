import * as vscode from "vscode";

/** A conversation as the list shows it: saved ones and open tabs, with whether it runs or waits for the user. */
export interface ConversationEntry {
  id: string;
  title: string;
  updatedAt: string | null;
  open: boolean;
  running: boolean;
  /** Decisions and permission prompts waiting in its tab. */
  waiting: number;
}

/** "just now", "12 min ago", "14:05", "yesterday", "28 Oct": when a conversation last changed. */
export function when(iso: string | null, now = new Date()): string {
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const minutes = Math.floor((now.getTime() - t.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(t)) / 86_400_000);
  if (days === 0) return t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "yesterday";
  return t.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The Activity Bar's list of this workspace's conversations, newest first; a click opens (or shows) its tab. */
export class ConversationsView implements vscode.TreeDataProvider<ConversationEntry> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly entries: () => ConversationEntry[]) {}

  refresh(): void {
    this.changed.fire();
  }

  getChildren(entry?: ConversationEntry): ConversationEntry[] {
    return entry ? [] : this.entries();
  }

  getTreeItem(e: ConversationEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(e.title || "New conversation", vscode.TreeItemCollapsibleState.None);
    item.id = e.id;
    const state = e.waiting ? "needs you" : e.running ? "working…" : e.open ? "open" : "";
    item.description = [state, when(e.updatedAt)].filter(Boolean).join(" · ");
    item.tooltip = e.title || "New conversation";
    item.iconPath = new vscode.ThemeIcon(e.waiting ? "bell-dot" : e.running ? "loading~spin" : e.open ? "comment-discussion" : "comment");
    item.command = { command: "agentduo.openConversation", title: "Open conversation", arguments: [e.id] };
    item.contextValue = e.open ? "conversation.open" : "conversation";
    return item;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
