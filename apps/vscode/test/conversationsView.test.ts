// The Activity Bar's conversation list: what each row says, and which rows carry the archive button.
import { describe, expect, it, vi } from "vitest";
import { ConversationsView, type ConversationEntry } from "../src/conversationsView.js";

// A tree item is all the list needs from VS Code (vi.mock is hoisted above the imports).
vi.mock("vscode", () => ({
  EventEmitter: class { event = () => undefined; fire(): void {} dispose(): void {} },
  TreeItem: class { constructor(public label: string, public collapsibleState: number) {} },
  TreeItemCollapsibleState: { None: 0 },
  ThemeIcon: class { constructor(public id: string) {} },
}));

const entry = (over: Partial<ConversationEntry> = {}): ConversationEntry => ({
  id: "c1", title: "Fix the login", updatedAt: null, open: false, running: false, waiting: 0, elsewhere: false, saved: true, ...over,
});

describe("the conversations view", () => {
  it("offers Archive only on a saved row nobody works in and nothing waits on", () => {
    const view = new ConversationsView(() => []);
    const ctx = (e: ConversationEntry) => view.getTreeItem(e).contextValue;
    expect(ctx(entry())).toBe("conversation.archivable");
    expect(ctx(entry({ open: true }))).toBe("conversation.open.archivable");
    for (const busy of [{ saved: false }, { running: true }, { waiting: 1 }, { elsewhere: true }]) expect(ctx(entry(busy)), JSON.stringify(busy)).not.toMatch(/archivable/);
  });
});
