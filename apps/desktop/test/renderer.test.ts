import { describe, expect, it } from "vitest";
import { initialState } from "../../../extensions/vscode/webview/state.js";
import { chatStatus } from "../src/renderer/chat.js";
import { gateActivities } from "../src/renderer/inspector.js";
import { needsSignIn, readyToGo } from "../src/renderer/onboarding.js";
import { readConfiguration } from "../../../src/core/configuration.js";
import { checkSettingValue, settingKey } from "../../../src/core/settings.js";
import { CLAUDE_MODELS } from "../../../src/core/commands.js";
import { addableOptions, argumentRows, argumentTokens } from "../src/renderer/argumentOptions.js";
import { CHOICES, cliAccount, cliStateWord, editorKind, formatValue, groupOf, modelChoices, parseEditorValue, settingUnit, sourceText } from "../src/renderer/settings.js";
import { accountRefreshTitle, projectBusy } from "../src/renderer/sidebar.js";
import { turnEnded, UsageStore } from "../src/renderer/usage.js";
import type { AccountUsage } from "../../../extensions/vscode/src/protocol.js";
import { clampFontSize, resolveTheme } from "../src/renderer/theme.js";
import { restartQuestion, updateAction, updateLine, updateNotice } from "../src/renderer/update.js";
import type { CliStatus, ConversationItem } from "../src/shared/protocol.js";
import type { UsageState } from "../../../src/core/usage.js";

describe("theme", () => {
  it("resolves system to what the system says, and keeps an explicit choice", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
  });
  it("keeps the font size in range", () => {
    expect(clampFontSize(4)).toBe(11);
    expect(clampFontSize(40)).toBe(20);
    expect(clampFontSize("x")).toBe(13);
  });
});

describe("settings editors", () => {
  it("picks an editor by the setting's kind, not by the value it has now", () => {
    const kinds = Object.fromEntries(readConfiguration({ workspace: null, env: { HOME: "/nowhere", XDG_CONFIG_HOME: "/nowhere/config" } }).entries.map((e) => [e.key, editorKind(e)]));
    expect(kinds).toMatchObject({
      "limits.max_review_rounds": "number", "claude.max_budget_usd": "number", "claude.permission_prompts": "choice", "agents.implementer": "choice",
      "codex.args": "list", "claude.role_args.implementer": "list", "claude.model": "text", "codex.bin": "text",
    });
    expect(CHOICES.prompts).toEqual(["ask", "deny"]);
  });
  it("turns what was typed into the value saved", () => {
    expect(parseEditorValue("list", "--a\n\n --b \n", false)).toEqual(["--a", "--b"]);
    expect(parseEditorValue("text", "  ", true)).toBeNull();
    expect(parseEditorValue("number", "5", false)).toBe(5);
    expect(() => parseEditorValue("number", "five", false)).toThrow();
    expect(() => parseEditorValue("number", " ", false)).toThrow();
    expect(parseEditorValue("choice", "deny", false)).toBe("deny");
  });
  it("saves a budget typed over its null default as a number the config takes", () => {
    const budget = readConfiguration({ workspace: null, env: { HOME: "/nowhere", XDG_CONFIG_HOME: "/nowhere/config" } }).entries.find((e) => e.key === "claude.max_budget_usd")!;
    expect(budget).toMatchObject({ effective: null, defaultValue: null, kind: "budget" });
    const value = parseEditorValue(editorKind(budget), "5", budget.defaultValue === null || budget.removable);
    expect(value).toBe(5);
    expect(checkSettingValue(settingKey("claude.max_budget_usd")!, value)).toBeNull();
    expect(parseEditorValue(editorKind(budget), "", true)).toBeNull();
  });
  it("groups keys and shows values as words", () => {
    expect(groupOf("claude.model")).toBe("claude");
    expect(groupOf("paths.runs_dir")).toBe("other");
    expect(formatValue(null)).toBe("—");
    expect(formatValue(["a", "b"])).toBe("a b");
    expect(formatValue(false)).toBe("off");
  });
});

describe("options picked from a list", () => {
  it("reads args as named options, an unknown flag with its value as one, and writes them back token for token", () => {
    const args = ["--effort", "high", "--verbose", "--no-session-persistence", "--allowedTools=Read", "--mcp-config", "a.json", "-x", "--add-dir", "../lib"];
    const rows = argumentRows(args, "claude");
    expect(rows.map((r) => [r.option, r.flag ?? null, r.value])).toEqual([
      ["effort", null, "high"], [null, "--verbose", ""], ["no-sessions", null, ""], ["allow", null, "Read"], [null, "--mcp-config", "a.json"], [null, "-x", ""], ["directory", null, "../lib"],
    ]);
    expect(argumentTokens(rows, "claude")).toEqual(args);
  });
  it("writes an edited or added option with agentduo's flag, and refuses one with nothing in it", () => {
    const rows = argumentRows(["-c", "model_reasoning_effort=low", "-c", "foo=bar"], "codex");
    expect(rows.map((r) => r.option)).toEqual(["effort", null]);
    rows[0]!.value = "high";
    rows.push({ option: "permissions", value: "read-only" }, { option: "ephemeral", value: "" }, { option: null, flag: " --json ", value: "" });
    expect(argumentTokens(rows, "codex")).toEqual(["-c", "model_reasoning_effort=high", "-c", "foo=bar", "--sandbox", "read-only", "--ephemeral", "--json"]);
    expect(() => argumentTokens([{ option: "directory", value: " " }], "codex")).toThrow(/additional folder/);
    expect(() => argumentTokens([{ option: null, flag: "", value: "x" }], "codex")).toThrow(/flag/);
  });
  it("offers each one-off option once, and the repeatable ones again", () => {
    const offered = (args: string[]) => addableOptions(argumentRows(args, "claude"), "claude").map((s) => s.id);
    expect(offered([])).toEqual(["effort", "permissions", "allow", "deny", "directory", "no-mcp", "no-sessions"]);
    expect(offered(["--effort", "low", "--allowedTools", "Read", "--no-session-persistence"])).toEqual(["permissions", "allow", "deny", "directory", "no-mcp"]);
  });
});

describe("configuration rows", () => {
  it("offers Default, the listed models and the one set now, and Other model…", () => {
    const values = (current: string | null) => modelChoices(CLAUDE_MODELS, current).map((c) => c.value);
    expect(values(null)[0]).toBe("");
    expect(values(null).at(-1)).not.toBe("opus");
    expect(modelChoices(CLAUDE_MODELS, null).at(-1)!.label).toBe("Other model…");
    expect(values("opus").filter((v) => v === "opus")).toHaveLength(1);
    expect(values("claude-custom-1")[1]).toBe("claude-custom-1");
  });
  it("says where a value comes from, and when the project's own value wins over the one being edited", () => {
    expect(sourceText({ source: "default", projectOverridesGlobal: false }, "global")).toBeNull();
    expect(sourceText({ source: "global", projectOverridesGlobal: false }, "global")).toEqual({ text: "Set for all projects", warn: false });
    expect(sourceText({ source: "project", projectOverridesGlobal: true }, "global")).toMatchObject({ warn: true });
    expect(sourceText({ source: "project", projectOverridesGlobal: true }, "project")).toEqual({ text: "Set for this project", warn: false });
    expect(sourceText({ source: "session", projectOverridesGlobal: false }, "session")?.text).toMatch(/app closes/);
  });
  it("names the unit of a number", () => {
    expect(settingUnit("limits.agent_timeout_sec")).toBe("seconds");
    expect(settingUnit("limits.max_diff_chars")).toBe("characters");
    expect(settingUnit("claude.max_budget_usd")).toBe("USD");
    expect(settingUnit("limits.max_review_rounds")).toBe("");
  });
});

describe("onboarding", () => {
  const cli = (state: CliStatus["state"], auth: CliStatus["auth"] = null, backend: CliStatus["backend"] = "claude"): CliStatus =>
    ({ backend, configured: backend, path: null, version: null, state, auth, detail: null, source: "default" });
  it("asks to sign in only when a CLI may be signed out", () => {
    expect(needsSignIn(cli("signed-out"))).toBe(true);
    expect(needsSignIn(cli("signed-in"))).toBe(false);
    expect(readyToGo([cli("signed-in"), cli("installed")])).toBe(true);
    expect(readyToGo([cli("missing")])).toBe(false);
  });
  it("says the email a CLI signs in with, its kind of account until that is known, or API", () => {
    const claude = cli("signed-in", { kind: "account", plan: "Max", email: "me@example.com" });
    expect(cliStateWord(claude)).toBe("me@example.com");
    expect(cliStateWord(cli("signed-in", { kind: "account", plan: "Max", email: null }))).toBe("Claude account");
    // codex login status names no email: the usage lookup does, and its plan wins over the check's.
    const codex = cli("signed-in", { kind: "account", plan: "ChatGPT", email: null }, "codex");
    expect(cliStateWord(codex)).toBe("ChatGPT account");
    expect(cliStateWord(codex, { status: "loading" })).toBe("ChatGPT account");
    const ready: UsageState = { status: "ready", usage: { account: "ChatGPT Plus", email: "codex@example.com", groups: [], notes: [], details: null } };
    expect(cliStateWord(codex, ready)).toBe("codex@example.com");
    expect(cliAccount(codex, ready)).toEqual({ plan: "ChatGPT Plus", email: "codex@example.com" });
    expect(cliAccount(codex, { status: "error", error: "no" })).toEqual({ plan: "ChatGPT", email: null });
    expect(cliStateWord(cli("signed-in", { kind: "api", plan: "API key", email: null }, "codex"))).toBe("API");
    expect(cliStateWord(cli("signed-in"))).toBe("Signed in");
    expect(cliStateWord(cli("signed-out", { kind: "account", plan: null, email: "me@example.com" }))).toBe("Signed out");
  });
});

describe("sidebar", () => {
  const item = (running: boolean): ConversationItem => ({ id: "c", title: "t", updatedAt: null, open: false, running, waiting: 0, activity: null });
  it("marks a project busy only while an agent works in one of its conversations", () => {
    expect(projectBusy(undefined)).toBe(false);
    expect(projectBusy([item(false), item(false)])).toBe(false);
    expect(projectBusy([item(false), item(true)])).toBe(true);
  });
  it("says how old the usage shown is on the refresh button", () => {
    const answer = { projectId: null, value: {} as AccountUsage, at: 0 };
    expect(accountRefreshTitle({ answer: null, looking: false, now: 0 })).toBe("Refresh");
    expect(accountRefreshTitle({ answer, looking: false, now: 3 * 60_000 })).toBe("Refresh · Updated 3 min ago");
    expect(accountRefreshTitle({ answer, looking: true, now: 0 })).toBe("Looking up usage…");
  });
  it("tells when an agent stopped working in a conversation, so usage is looked up after a turn", () => {
    const working = new Map<string, Set<string>>();
    const conv = (id: string, running: boolean): ConversationItem => ({ ...item(running), id });
    expect(turnEnded(working, "p", [conv("a", true)])).toBe(false);
    expect(turnEnded(working, "p", [conv("a", true), conv("b", false)])).toBe(false);
    expect(turnEnded(working, "q", [conv("a", false)])).toBe(false);
    expect(turnEnded(working, "p", [conv("a", false), conv("b", false)])).toBe(true);
    expect(turnEnded(working, "p", [conv("a", false)])).toBe(false);
  });
});

describe("the app's update", () => {
  const now = Date.parse("2026-10-31T12:10:00.000Z");

  it("says each step in a sentence", () => {
    expect(updateLine({ status: "off", reason: "This is a development build." })).toBe("This is a development build.");
    expect(updateLine({ status: "idle" })).toBe("Not checked yet.");
    expect(updateLine({ status: "latest", checkedAt: "2026-10-31T12:07:00.000Z" }, now)).toBe("AgentDuo is up to date. Checked 3 min ago.");
    expect(updateLine({ status: "downloading", version: "0.8.0", percent: 42 })).toBe("Downloading AgentDuo 0.8.0… 42%");
    expect(updateLine({ status: "ready", version: "0.8.0" })).toContain("Restart to install it");
    expect(updateLine({ status: "manual", version: "0.8.0", reason: "Not signed." })).toBe("AgentDuo 0.8.0 is out. Not signed. Download it from GitHub.");
    expect(updateLine({ status: "error", message: "Could not reach GitHub.", checkedAt: "2026-10-31T12:00:00.000Z" })).toBe("Could not update: Could not reach GitHub.");
  });

  it("offers restart, download or a check, and nothing where the build never looks", () => {
    expect(updateAction({ status: "off", reason: "" })).toBeNull();
    expect(updateAction({ status: "ready", version: "0.8.0" })).toBe("install");
    expect(updateAction({ status: "manual", version: "0.8.0", reason: "" })).toBe("download");
    expect(updateAction({ status: "latest", checkedAt: "" })).toBe("check");
    expect(updateAction({ status: "error", message: "", checkedAt: "" })).toBe("check");
  });

  it("puts a button in the sidebar only when the user has something to do", () => {
    expect(updateNotice({ status: "ready", version: "0.8.0" })).toMatchObject({ action: "install", label: "Restart to update" });
    expect(updateNotice({ status: "manual", version: "0.8.0", reason: "" })).toMatchObject({ action: "download", label: "Get AgentDuo 0.8.0" });
    for (const s of [{ status: "idle" }, { status: "checking" }, { status: "downloading", version: "0.8.0", percent: 3 }, { status: "latest", checkedAt: "" }] as const) expect(updateNotice(s)).toBeNull();
  });

  it("asks before a restart stops agents at work", () => {
    expect(restartQuestion(0)).toBeNull();
    expect(restartQuestion(1)).toContain("An agent is working in 1 conversation;");
    expect(restartQuestion(3)).toContain("Agents are working in 3 conversations;");
  });
});

describe("usage store", () => {
  const ready = (email: string): AccountUsage => ({
    claude: { status: "ready", usage: { account: "Max", email, groups: [], notes: [], details: null } }, codex: { status: "loading" },
  });
  /** Lookups that answer when the test says so, in any order. */
  function asks() {
    const pending: Array<{ projectId: string | null; answer(v: AccountUsage): void; fail(e: Error): void }> = [];
    const ask = (projectId: string | null) => new Promise<AccountUsage>((answer, fail) => pending.push({ projectId, answer, fail }));
    return { pending, ask };
  }
  it("looks up once at a time per project, and tells its views when it starts and answers", async () => {
    const { pending, ask } = asks();
    let now = 1000;
    const store = new UsageStore(ask, () => now);
    let changes = 0;
    store.subscribe(() => changes++);
    const first = store.refresh(null);
    expect(store.refresh(null)).toBe(first);
    expect(pending).toHaveLength(1);
    expect(store.looking(null)).toBe(true);
    pending[0]!.answer(ready("me@example.com"));
    await first;
    expect(store.looking(null)).toBe(false);
    expect(store.of(null)).toMatchObject({ projectId: null, at: 1000 });
    expect(store.of("p")).toBeNull();
    expect(changes).toBe(2);
    // Young enough: no lookup; older, or for another project: one.
    now = 1000 + 30_000;
    await store.ensure(null, 60_000);
    expect(pending).toHaveLength(1);
    void store.ensure(null, 10_000);
    void store.ensure("p", 60_000);
    expect(pending.map((p) => p.projectId)).toEqual([null, null, "p"]);
  });
  it("keeps the newer answer when an older lookup answers last, and turns a failure into an error for both", async () => {
    const { pending, ask } = asks();
    const store = new UsageStore(ask);
    const older = store.refresh(null);
    const newer = store.refresh("p");
    pending[1]!.answer(ready("new@example.com"));
    await newer;
    pending[0]!.answer(ready("old@example.com"));
    await older;
    expect(store.latest()?.projectId).toBe("p");
    const failed = store.refresh("p");
    pending[2]!.fail(new Error("no CLI"));
    await failed;
    expect(store.of("p")?.value).toEqual({ claude: { status: "error", error: "no CLI" }, codex: { status: "error", error: "no CLI" } });
  });
});

describe("chat status and gates", () => {
  it("says what a fresh chat is doing", () => {
    expect(chatStatus(null)).toBe("starting…");
    expect(chatStatus(initialState("active", "/repo", 1))).toBe("ready");
  });
  it("lists the gates a view saw, the latest result of each", () => {
    const s = initialState("active", "/repo", 1);
    s.timeline = [{ id: "1", kind: "step", step: { phase: "VERIFY", round: 1, startedAt: 0, dropped: 0, activities: [
      { id: "gate-test", kind: "command", label: "gate  test: npm test", status: "running" },
      { id: "gate-test", kind: "command", label: "gate  test: npm test", status: "ok", exitCode: 0 },
      { id: "x", kind: "read", label: "read a file", status: "ok" },
    ] } }];
    expect(gateActivities(s)).toEqual([{ label: "gate  test: npm test", status: "ok", exitCode: 0 }]);
  });
});
