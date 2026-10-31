import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountView, PERIOD_MS, STALE_MS } from "../extensions/vscode/src/accountView.js";
import type { AccountHostMessage, AccountUsage } from "../extensions/vscode/src/protocol.js";
import { accountRows, limitRows, meterLevel, updatedText } from "../extensions/vscode/webview/account.js";
import type { AgentUsage } from "../src/core/usage.js";

// The view needs only Uri from VS Code (vi.mock is hoisted above the imports); a WebviewView is faked below.
vi.mock("vscode", () => ({
  Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join("/") }) },
}));

const claude: AgentUsage = {
  account: "Max", email: "claude@example.com", notes: [], details: { title: "What's contributing to your limits usage?", lines: ["Last 24h"] },
  groups: [{ title: null, limits: [{ label: "Current session", usedPercent: 9, resets: "Resets 1:10pm (Asia/Saigon)" }, { label: "Current week (all models)", usedPercent: 68, resets: null }] }],
};
const codex: AgentUsage = {
  account: "ChatGPT Plus", email: "codex@example.com", notes: ["Credits: 12.5", " "], details: null,
  groups: [{ title: null, limits: [{ label: "5h limit", usedPercent: 0, resets: "Resets Oct 29 at 7:28pm" }] }, { title: "GPT-Spark", limits: [{ label: "5h limit", usedPercent: 130, resets: null }] }],
};

describe("Account & Usage view: rows", () => {
  it("shows each agent with its plan and email, then each limit with its percent, a meter and when it resets", () => {
    expect(accountRows("claude", { status: "ready", usage: claude })).toEqual([
      { kind: "agent", text: "Claude Code", value: "Max" },
      { kind: "field", text: "Email", value: "claude@example.com" },
      { kind: "limit", text: "Current session", value: "9%" },
      { kind: "bar", text: "9% used", percent: 9 },
      { kind: "muted", text: "Resets 1:10pm (Asia/Saigon)" },
      { kind: "limit", text: "Current week (all models)", value: "68%" },
      { kind: "bar", text: "68% used", percent: 68 },
    ]);
    expect(accountRows("codex", { status: "ready", usage: codex })).toEqual([
      { kind: "agent", text: "Codex", value: "ChatGPT Plus" },
      { kind: "field", text: "Email", value: "codex@example.com" },
      { kind: "limit", text: "5h limit", value: "0%" },
      { kind: "bar", text: "0% used", percent: 0 },
      { kind: "muted", text: "Resets Oct 29 at 7:28pm" },
      { kind: "group", text: "GPT-Spark" },
      { kind: "limit", text: "5h limit", value: "130%" },
      { kind: "bar", text: "130% used", percent: 100 },
      { kind: "text", text: "Credits: 12.5" },
    ]);
  });

  it("gives the limits alone (as the desktop's cards show them under the account), and colours a meter by how full it is", () => {
    expect(limitRows(claude)).toEqual(accountRows("claude", { status: "ready", usage: claude }).slice(2));
    expect(limitRows({ ...codex, groups: [], notes: [" "] })).toEqual([]);
    expect([0, 69, 70, 89, 90, 100].map(meterLevel)).toEqual(["", "", "high", "high", "full", "full"]);
  });

  it("names both agents whatever happened: still loading, failed, or signed in with no plan or email", () => {
    expect(accountRows("claude", null)).toEqual([{ kind: "agent", text: "Claude Code" }, { kind: "muted", text: "loading…" }]);
    expect(accountRows("codex", { status: "loading" })).toEqual([{ kind: "agent", text: "Codex" }, { kind: "muted", text: "loading…" }]);
    expect(accountRows("codex", { status: "error", error: "Codex is not signed in: run codex login" }))
      .toEqual([{ kind: "agent", text: "Codex" }, { kind: "error", text: "Codex is not signed in: run codex login" }]);
    const apiKey: AgentUsage = { account: "API key", email: null, groups: [], notes: ["Codex signs in with an API key: there are no plan limits to show."], details: null };
    expect(accountRows("codex", { status: "ready", usage: apiKey }))
      .toEqual([{ kind: "agent", text: "Codex", value: "API key" }, { kind: "text", text: "Codex signs in with an API key: there are no plan limits to show." }]);
  });

  it("says how old the numbers are", () => {
    const at = Date.UTC(2026, 9, 31, 12);
    expect([updatedText(null, at), updatedText(at, at + 59_000), updatedText(at, at + 4 * 60_000 + 1), updatedText(at, at + 125 * 60_000)])
      .toEqual(["", "Updated just now", "Updated 4 min ago", "Updated 2 h ago"]);
  });
});

/** The view's WebviewView: what the host posts goes to `posted`; `show` and `hide` change its visibility as VS Code does. */
function fakeView() {
  const heard: Array<(m: unknown) => void> = [];
  const visibility: Array<() => void> = [];
  const posted: AccountHostMessage[] = [];
  const view = {
    visible: true,
    webview: {
      cspSource: "vscode-webview:", html: "", options: {} as { localResourceRoots?: Array<{ fsPath: string }> },
      asWebviewUri: (u: { fsPath: string }) => ({ toString: () => `webview:${u.fsPath}` }),
      postMessage: (m: AccountHostMessage) => {
        posted.push(m);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (cb: (m: unknown) => void) => (heard.push(cb), { dispose() {} }),
    },
    onDidChangeVisibility: (cb: () => void) => (visibility.push(cb), { dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
  };
  const set = (visible: boolean) => {
    view.visible = visible;
    for (const cb of visibility) cb();
  };
  return { view, posted, say: (m: unknown) => heard.forEach((cb) => cb(m)), show: () => set(true), hide: () => set(false) };
}

const answer: AccountUsage = { claude: { status: "ready", usage: claude }, codex: { status: "ready", usage: codex } };

describe("Account & Usage view: when it looks up", () => {
  let reads: Array<{ resolve(u: AccountUsage): void; reject(e: Error): void }>;
  let details: number;
  let account: AccountView;
  const settle = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 31, 12) });
    reads = [];
    details = 0;
    account = new AccountView({ fsPath: "/ext" } as never, {
      read: () => new Promise<AccountUsage>((resolve, reject) => reads.push({ resolve, reject })),
      details: () => details++,
      log: () => undefined,
    });
  });
  afterEach(() => {
    account.dispose();
    vi.useRealTimers();
  });

  /** Answers the lookup under way. */
  const answerRead = async (u: AccountUsage = answer) => {
    reads.at(-1)!.resolve(u);
    await settle();
  };

  it("loads only its own bundle, and looks up as soon as it shows: loading first, then both agents", async () => {
    const f = fakeView();
    account.resolveWebviewView(f.view as never);
    expect(f.view.webview.options).toEqual({ enableScripts: true, enableCommandUris: false, localResourceRoots: [{ fsPath: "/ext/dist/webview" }] });
    expect(f.view.webview.html).toContain("webview:/ext/dist/webview/sidebar.js");
    expect(f.view.webview.html).toContain("webview:/ext/dist/webview/sidebar.css");
    expect(reads).toHaveLength(1);
    expect(f.posted.at(-1)!.state).toEqual({ usage: null, updatedAt: null, refreshing: true, problem: null });
    await answerRead();
    expect(f.posted.at(-1)!.state).toEqual({ usage: answer, updatedAt: Date.now(), refreshing: false, problem: null });
    // A page that (re)loads gets what there is, with no new lookup.
    f.say({ type: "ready" });
    expect(f.posted.at(-1)!.state.usage).toEqual(answer);
    expect(reads).toHaveLength(1);
  });

  it("looks up again on ↻ (not while it already does), and opens the details when asked", async () => {
    const f = fakeView();
    account.resolveWebviewView(f.view as never);
    f.say({ type: "refresh" });
    account.refresh();
    expect(reads).toHaveLength(1);
    await answerRead();
    f.say({ type: "refresh" });
    expect(reads).toHaveLength(2);
    f.say({ type: "details" });
    f.say({ type: "open", path: "/etc/passwd" });
    expect(details).toBe(1);
  });

  it("looks up again when shown after a minute, every 5 minutes while it shows, and never while hidden", async () => {
    const f = fakeView();
    account.resolveWebviewView(f.view as never);
    await answerRead();
    f.hide();
    f.show();
    expect(reads).toHaveLength(1); // still fresh
    f.hide();
    await vi.advanceTimersByTimeAsync(PERIOD_MS * 2);
    expect(reads).toHaveLength(1);
    f.show();
    expect(reads).toHaveLength(2);
    await answerRead();
    await vi.advanceTimersByTimeAsync(PERIOD_MS);
    expect(reads).toHaveLength(3);
  });

  it("after answers and runs, looks up at most once a minute, and a hidden view only once it shows", async () => {
    const f = fakeView();
    account.resolveWebviewView(f.view as never);
    await answerRead();
    account.changed();
    account.changed();
    expect(reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(STALE_MS);
    expect(reads).toHaveLength(2);
    await answerRead();
    f.hide();
    account.changed();
    await vi.advanceTimersByTimeAsync(STALE_MS * 2);
    expect(reads).toHaveLength(2);
    f.show();
    expect(reads).toHaveLength(3);
  });

  it("keeps the numbers it had when a lookup cannot run, and says why", async () => {
    const f = fakeView();
    account.resolveWebviewView(f.view as never);
    await answerRead();
    const updatedAt = Date.now();
    account.refresh();
    reads.at(-1)!.reject(new Error("agentduo needs Node >= 22.12"));
    await settle();
    expect(f.posted.at(-1)!.state).toEqual({ usage: answer, updatedAt, refreshing: false, problem: "agentduo needs Node >= 22.12" });
  });

  it("looks up again for another workspace, after the lookup under way", async () => {
    const f = fakeView();
    account.resolveWebviewView(f.view as never);
    account.reset();
    expect(reads).toHaveLength(1);
    await answerRead();
    expect(reads).toHaveLength(2);
  });
});
