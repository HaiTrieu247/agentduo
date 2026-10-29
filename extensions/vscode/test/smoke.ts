// Runs inside an Extension Development Host, started by scripts/test-vscode.mjs on a scratch git repository with fake
// CLIs: activation, command registration, the chat in an editor tab and the worker it starts, the two content
// providers, questions to Codex and Claude (one stopped before its answer), a second conversation in a tab of its own,
// and a two-round pipeline run whose diff follows the run to its newer snapshot.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { approval, critique, finding, impl, plan, review } from "../../../test/helpers/builders.js";
import { png } from "../../../test/helpers/images.js";
import { ARTIFACT_SCHEME, artifactLocation, SNAPSHOT_SCHEME, snapshotLocation } from "../src/artifacts.js";
import type { TestApi } from "../src/extension.js";

const ID = "HaiTrieuThinh.agentduo-vscode";

async function until<T>(what: string, get: () => T | null | undefined | false, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = get();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const read = async (uri: vscode.Uri) => (await vscode.workspace.openTextDocument(uri)).getText();

/** The editor tabs of agentduo's conversations. */
const conversationTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes("agentduo.conversation"));

const answers = (api: TestApi) => (api.state()?.timeline ?? []).flatMap((i) => (i.kind === "answer" ? [i.turn] : []));

/** The fake CLIs' calls so far ($FAKE_LOG). */
const calls = (): Array<{ role?: string; prompt: string }> =>
  readFileSync(process.env.FAKE_LOG!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => typeof c.prompt === "string");

const checks: Array<[string, (api: TestApi, ext: vscode.Extension<TestApi>) => Promise<void>]> = [
  ["activates without starting a worker", async (api) => {
    assert.equal(api.workerPid(), undefined);
    assert.equal(api.state(), null);
  }],
  ["registers every command in its manifest", async (_api, ext) => {
    const contributed = (ext.packageJSON.contributes.commands as Array<{ command: string }>).map((c) => c.command);
    const registered = new Set(await vscode.commands.getCommands(true));
    assert.deepEqual(contributed.filter((c) => !registered.has(c)), []);
  }],
  ["opens the chat in an editor tab, whose worker initializes the folder without creating a run", async (api) => {
    const folder = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    await vscode.commands.executeCommand("agentduo.openChat");
    await until("the conversation's tab", () => conversationTabs().length === 1);
    const state = await until("the session to start", () => {
      const s = api.state();
      return s && s.session !== "starting" ? s : null;
    });
    assert.equal(state.problem, null, `the session reports a problem: ${state.problem?.message}`);
    assert.equal(state.workspace, folder);
    assert.equal(state.status, "idle");
    assert.equal(state.run, null);
    assert.ok(api.workerPid(), "the worker runs");
    const runs = join(folder, ".agentduo", "runs");
    assert.deepEqual(existsSync(runs) ? readdirSync(runs).filter((f) => !f.startsWith(".")) : [], []);
  }],
  ["serves artifacts and snapshots only for what agentduo itself opened", async () => {
    const artifact = await read(vscode.Uri.from({ scheme: ARTIFACT_SCHEME, ...artifactLocation("20260101-000000-none", "plan") }));
    assert.match(artifact, /^\(.+\)\n$/);
    const pair = { runId: "20260101-000000-none", base: "0".repeat(40), snapshot: "1".repeat(40) };
    const snapshot = await read(vscode.Uri.from({ scheme: SNAPSHOT_SCHEME, ...snapshotLocation(pair, "base", "README.md") }));
    assert.match(snapshot, /no longer available/);
  }],
  ["answers Open Plan and Open Changes with no run yet, without throwing", async () => {
    await vscode.commands.executeCommand("agentduo.openPlan");
    await vscode.commands.executeCommand("agentduo.openChanges");
  }],
  ["answers a plain message with Codex, then a /claude question with what Codex said, without starting a run", async (api) => {
    writeFileSync(process.env.FAKE_SCENARIO!, JSON.stringify({
      chat_codex: [{ answer: "Codex: keep app.txt short.\n\n```\nround 1\n```" }], chat_claude: [{ answer: "Claude: agreed." }],
    }));
    await api.submit("How should app.txt look?");
    const codex = await until("Codex's answer", () => answers(api).find((t) => t.backend === "codex"));
    assert.equal(codex.status, "success");
    assert.equal(codex.answer, "Codex: keep app.txt short.\n\n```\nround 1\n```");
    assert.ok(api.state()!.models?.codex, "the composer knows Codex's model");

    await api.submit("/claude Do you agree?");
    const claude = await until("Claude's answer", () => answers(api).find((t) => t.backend === "claude"));
    assert.equal(claude.status, "success");
    assert.equal(claude.answer, "Claude: agreed.");
    assert.equal(claude.model.resolved, "claude-fake-default", "Claude's stream names the model of its answer");
    const asked = calls().filter((c) => c.role === "chat_claude").at(-1);
    assert.ok(asked?.prompt.includes("Codex: keep app.txt short."), "Claude's prompt carries Codex's answer");
    assert.equal(api.state()!.run, null, "a question starts no run");
    assert.equal(api.state()!.recipient, "claude", "the next plain message goes to Claude");
    await api.selectRecipient("codex");
  }],
  ["shows /usage in the tab's usage panel, and looks it up again from the title bar's Usage, with no line in the conversation", async (api) => {
    const items = api.state()!.timeline.length;
    await api.submit("/usage");
    const first = await until("the usage", () => {
      const u = api.state()?.usage;
      return u && u.claude.status !== "loading" && u.codex.status !== "loading" ? u : null;
    }, 15_000);
    assert.equal(first.claude.status, "ready", JSON.stringify(first.claude));
    assert.equal(first.codex.status, "ready", JSON.stringify(first.codex));
    await vscode.commands.executeCommand("agentduo.usage");
    const again = await until("the usage looked up again", () => {
      const u = api.state()?.usage;
      return u && u.id > first.id && u.claude.status === "ready" && u.codex.status === "ready" ? u : null;
    }, 15_000);
    assert.ok(again.id > first.id);
    // Only what was typed (/usage) joins the conversation; the report stays in the panel.
    assert.deepEqual(api.state()!.timeline.slice(items).map((i) => i.kind), ["user"]);
  }],
  ["attaches a picked file and a pasted image, and sends both with a message: Codex gets the images, the tab keeps no bytes", async (api) => {
    writeFileSync(process.env.FAKE_SCENARIO!, JSON.stringify({ chat_codex: [{ answer: "Two grey squares." }] }));
    const picked = join(mkdtempSync(join(tmpdir(), "agentduo-smoke-")), "picked.png");
    writeFileSync(picked, png(32, 32));
    const before = calls().length;
    await api.attach(picked);
    await api.upload("pasted.png", png(16, 16));
    const ready = await until("both files", () => {
      const a = api.state()?.attachments ?? [];
      return a.length === 2 && a.every((c) => c.status === "ready") ? a : null;
    });
    assert.deepEqual(ready.map((c) => c.name), ["picked.png", "pasted.png"]);
    await api.submitWithFiles("What are these?");
    await until("Codex's answer", () => answers(api).some((t) => t.answer === "Two grey squares."));
    const call = calls().slice(before).find((c) => c.role === "chat_codex") as { args: string[]; prompt: string } | undefined;
    assert.ok(call, "Codex was asked");
    assert.equal(call.args.filter((a) => a.startsWith("--image=")).length, 2, call.args.join(" "));
    assert.equal(call.args.at(-1), "-", "the prompt still goes on stdin");
    assert.ok(call.prompt.includes("pasted.png") && call.prompt.includes("picked.png"), "the prompt lists the files");
    const user = api.state()!.timeline.filter((i) => i.kind === "user").at(-1);
    assert.equal(user?.kind === "user" ? user.attachments?.length : 0, 2);
    assert.deepEqual(api.state()!.attachments, []);
    assert.ok(!JSON.stringify(api.state()).includes(png(16, 16).toString("base64").slice(0, 40)), "the tab's state has no file bytes");
  }],
  ["stops an answer before it arrives, and the chat is idle again", async (api) => {
    writeFileSync(process.env.FAKE_SCENARIO!, JSON.stringify({ chat_codex: [{ answer: "too late", sleep: 30_000 }] }));
    const before = answers(api).length;
    const started = Date.now();
    await api.submit("A slow question");
    await until("the answer to start", () => api.state()?.status === "answering");
    await vscode.commands.executeCommand("agentduo.stop");
    const stopped = await until("the stopped answer", () => answers(api).slice(before).find((t) => t.backend === "codex"), 15_000);
    assert.equal(stopped.status, "interrupted");
    assert.equal(stopped.answer ?? null, null);
    assert.ok(Date.now() - started < 30_000, "stopped before the agent would have answered");
    await until("the chat to be idle", () => api.state()?.status === "idle");
  }],
  ["opens a new conversation in a tab of its own, and the first tab keeps its conversation", async (api) => {
    const [first] = api.conversations();
    assert.ok(first, "the first conversation has a tab");
    const said = answers(api).length;
    await vscode.commands.executeCommand("agentduo.newTask");
    await until("a second tab", () => conversationTabs().length === 2 && api.conversations().length === 2);
    assert.notEqual(api.conversations()[1], first);
    assert.equal(api.state()?.timeline.length ?? 0, 0, "a new conversation starts empty");
    await vscode.commands.executeCommand("agentduo.openConversation", first);
    await until("the first conversation again", () => answers(api).length === said);
  }],
  ["opens a diff, and after the run's next round shows that round's snapshot, not the editor's cached document", async (api) => {
    writeFileSync(process.env.FAKE_SCENARIO!, JSON.stringify({
      planner: [{ output: plan() }], plan_reviewer: [{ output: critique(true) }], plan_finalizer: [{ output: approval(true) }],
      implementer: [{ write: { "app.txt": "round 1\n" }, output: impl() }, { write: { "app.txt": "round 2\n" }, output: impl("completed", ["F1"]) }],
      code_reviewer: [{ output: review(false, [finding("F1")]) }, { output: review(true, [], ["F1"]) }],
    }));
    await api.submit("Make app.txt fixed", "pipeline");
    await until("the decision after round 1", () => api.state()?.decision, 60_000);
    const first = await api.openDiff("app.txt");
    assert.equal(await read(first.base), "");
    assert.equal(await read(first.snapshot), "round 1\n");

    await api.decide("resume");
    await until("DONE after round 2", () => api.state()?.timeline.some((i) => i.kind === "finish" && i.phase === "DONE"), 60_000);
    const second = await api.openDiff("app.txt");
    assert.notEqual(second.snapshot.toString(), first.snapshot.toString());
    assert.equal(await read(second.snapshot), "round 2\n");
    assert.equal(await read(first.snapshot), "round 1\n", "an open diff of round 1 keeps showing round 1");
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(tab instanceof vscode.TabInputTextDiff, "a diff editor is active");
    assert.equal(tab.modified.toString(), second.snapshot.toString());
    const shown = vscode.workspace.textDocuments.find((d) => d.uri.toString() === tab.modified.toString());
    assert.equal(shown?.getText(), "round 2\n");
  }],
];

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<TestApi>(ID);
  assert.ok(ext, `${ID} is not loaded in the test host`);
  const api = await ext.activate();
  assert.ok(api, "the extension returns its test API in test mode");
  const failures: string[] = [];
  for (const [name, check] of checks) {
    try {
      await check(api, ext);
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failures.push(name);
      console.log(`  ✗ ${name}\n    ${(e as Error).stack ?? e}`);
    }
  }
  if (failures.length) throw new Error(`${failures.length} of ${checks.length} smoke checks failed`);
  console.log(`extension host smoke OK: ${checks.length} checks`);
}
