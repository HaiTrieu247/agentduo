// The desktop's projects and conversations with real engine workers (built as the extension's, run by this Node) and
// the fake CLIs: what main says is selected, Settings reaching every open project's chats, and the default recipient.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { ConfigurationView } from "../../../src/core/configuration.js";
import { userConfigEnv } from "../../../test/helpers/config.js";
import { fakeShim, FakeClis } from "../../../test/helpers/fake-clis.js";
import { makeRepo } from "../../../test/helpers/repo.js";
import { tempDir } from "../../../test/helpers/tmp.js";
import { buildWorker, waitUntil } from "../../../test/helpers/vscode.js";
import { LogBuffer } from "../src/main/diagnostics.js";
import { Dispatcher } from "../src/main/ipc.js";
import { PreferencesStore } from "../src/main/preferences.js";
import { ProjectManager } from "../src/main/projects.js";
import { ResourceTokens } from "../src/main/resources.js";
import { CONVERSATIONS_PROJECT_ID } from "../src/shared/protocol.js";
import type { Answer, DesktopEvent, SenderInfo } from "../src/shared/protocol.js";

const good: SenderInfo = { senderId: 3, windowId: 3, mainFrame: true, url: "agentduo://app/index.html" };

let t: { path: string; cleanup(): void };
const managers: ProjectManager[] = [];
beforeEach(() => {
  t = tempDir();
});
afterEach(async () => {
  for (const m of managers.splice(0)) await m.dispose();
  t.cleanup();
});

interface Harness {
  d: Dispatcher;
  projects: ProjectManager;
  prefs: PreferencesStore;
  /** What the native folder and binary pickers answer next. */
  pick: { folder: string | null; binary: string | null };
  /** What main sent the window. */
  events: DesktopEvent[];
}

function harness(o: { worker?: string; env?: NodeJS.ProcessEnv } = {}): Harness {
  const prefsFile = join(t.path, "prefs.json");
  const prefs = new PreferencesStore(prefsFile);
  const env = o.env ?? { HOME: t.path, ...userConfigEnv(join(t.path, "xdg")) };
  const events: DesktopEvent[] = [];
  const projects = new ProjectManager({
    prefs, tokens: new ResourceTokens(), host: { pickFiles: async () => [], copy: () => undefined }, workerScript: o.worker ?? join(t.path, "none.js"), env: () => env,
    resolveNode: () => (o.worker ? { ok: true, path: process.execPath, version: process.versions.node } : { ok: false, message: "no worker in this test" }),
    stagingDir: join(t.path, "staging"), post: (e) => events.push(e), log: () => undefined,
  });
  managers.push(projects);
  const pick = { folder: null as string | null, binary: null as string | null };
  const d = new Dispatcher({
    projects, prefs, logs: new LogBuffer(), userData: t.path, logsDir: join(t.path, "logs"), env: () => env, launcher: () => null,
    snapshot: () => ({ prefs: prefs.prefs, projects: projects.summaries(), active: projects.active, platform: process.platform, versions: { app: "0", electron: "0", chrome: "0", node: "0" }, userData: t.path, dark: false, update: { status: "off", reason: "test" } }),
    shell: { chooseFolder: async () => pick.folder, chooseBinary: async () => pick.binary, saveFile: async () => null, openPath: async () => undefined, openExternal: async () => undefined },
  });
  return { d, projects, prefs, pick, events };
}

async function ok<T>(answer: Promise<Answer<unknown>>): Promise<T> {
  const a = await answer;
  if (!a.ok) throw new Error(a.error);
  return a.result as T;
}

describe("the selected conversation", () => {
  it("follows the window back to a conversation it still shows, through a preference change and a restart", async () => {
    const folder = join(t.path, "project");
    mkdirSync(folder);
    const { d, pick } = harness();
    pick.folder = folder;
    const { id: projectId } = await ok<{ id: string }>(d.handle(good, { method: "project.open" }));
    const { conversationId: a } = await ok<{ conversationId: string }>(d.handle(good, { method: "conversation.new", projectId }));
    const { conversationId: b } = await ok<{ conversationId: string }>(d.handle(good, { method: "conversation.new", projectId }));
    const active = async () => (await ok<{ active: { conversationId: string | null } }>(d.handle(good, { method: "app.state" }))).active.conversationId;
    expect(await active()).toBe(b);
    // A → B → A: the window shows A again (its chat stays mounted), and main's selection follows.
    expect(await ok(d.handle(good, { method: "conversation.select", projectId, conversationId: a }))).toEqual({ selected: true });
    expect(await active()).toBe(a);
    // A preference change sends the window main's snapshot: it names A, so the window stays on A.
    const prefs = await ok<{ theme: string }>(d.handle(good, { method: "prefs.set", patch: { theme: "dark" } }));
    expect(prefs.theme).toBe("dark");
    expect(await active()).toBe(a);
    // The next start comes back to A.
    expect(harness().projects.active).toEqual({ projectId, conversationId: a });
    // A conversation the window does not show cannot be selected: it is opened (a view of its own) instead.
    expect(await d.handle(good, { method: "conversation.select", projectId, conversationId: "20261031-120000-tab-deadbeef" })).toMatchObject({ ok: false });
    // Closed, it is not the one the next start comes back to.
    await ok(d.handle(good, { method: "conversation.close", projectId, conversationId: a }));
    expect(harness().projects.active.conversationId).not.toBe(a);
  });
});

describe("with real workers", () => {
  let worker: { script: string; cleanup(): void };
  let fake: FakeClis;
  beforeAll(() => {
    worker = buildWorker();
  }, 120_000);
  afterAll(() => worker.cleanup());
  beforeEach(() => {
    fake = new FakeClis(t.path).install();
  });
  afterEach(() => fake.restore());

  const env = () => ({ ...process.env, HOME: t.path, ...userConfigEnv(join(t.path, "xdg")) });
  const userConfig = () => join(t.path, "xdg", "agentduo", "config.yaml");
  const writeYaml = (file: string, data: unknown) => {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, YAML.stringify(data));
  };

  /** A git repository opened as a project, with `config` as its .agentduo/config.yaml (none when null). */
  async function project(h: Harness, name: string, config: Record<string, unknown> | null): Promise<{ id: string; path: string }> {
    const path = makeRepo(join(t.path, name));
    if (config) writeYaml(join(path, ".agentduo", "config.yaml"), config);
    h.pick.folder = path;
    const { id } = await ok<{ id: string }>(h.d.handle(good, { method: "project.open" }));
    return { id, path };
  }

  /** A conversation of the project with a chat in its worker: it asked Codex something, and got the answer. */
  async function chatting(h: Harness, projectId: string, text = "hello"): Promise<string> {
    const { conversationId } = await ok<{ conversationId: string }>(h.d.handle(good, { method: "conversation.new", projectId }));
    await say(h, projectId, conversationId, text);
    return conversationId;
  }

  /** `calls`: how many agent calls were made so far (the fake CLIs' log, unless the call goes to another binary). */
  async function say(h: Harness, projectId: string, conversationId: string, text: string, calls = () => fake.calls().length): Promise<void> {
    const before = calls();
    await h.projects.session(projectId).conversation(conversationId).submit(text);
    await waitUntil(() => calls() > before, 30_000, `an answer to «${text}»`);
    await waitUntil(() => h.projects.session(projectId).conversation(conversationId).state.status === "idle", 30_000, "the answer to finish");
  }

  const entry = (view: ConfigurationView, key: string) => view.entries.find((e) => e.key === key)!;
  const read = (h: Harness, projectId: string) => ok<ConfigurationView>(h.d.handle(good, { method: "settings.read", projectId }));
  /** Until the project's Settings show `key` as `expected` (what its chats get), or the time is up. */
  async function shows(h: Harness, projectId: string, key: string, expected: Record<string, unknown>): Promise<void> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const got = entry(await read(h, projectId), key);
      if (Object.entries(expected).every(([k, v]) => JSON.stringify(got[k as keyof typeof got]) === JSON.stringify(v))) return;
      if (Date.now() > deadline) throw new Error(`${key} in ${h.projects.path(projectId)} is ${JSON.stringify(got)}, not ${JSON.stringify(expected)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it("brings every open project's chats up to date with a user config change, keeping each project's and session's own values", async () => {
    writeYaml(userConfig(), { claude: { bin: fake.path("claude") }, codex: { bin: fake.path("codex") } });
    const h = harness({ worker: worker.script, env: env() });
    const a = await project(h, "a", null);
    const b = await project(h, "b", { codex: { model: "b-model" } });
    const inA = await chatting(h, a.id);
    const inB = await chatting(h, b.id);
    expect(h.projects.liveProjects().sort()).toEqual([a.id, b.id].sort());

    // From project A's Settings (through A's worker): B's worker follows too, and B's own codex.model keeps winning there.
    await ok(h.d.handle(good, { method: "settings.update", projectId: a.id, scope: "global", key: "codex.model", value: "g-model" }));
    expect(entry(await read(h, a.id), "codex.model")).toMatchObject({ effective: "g-model", source: "global", session: null });
    expect(entry(await read(h, b.id), "codex.model")).toMatchObject({ effective: "b-model", source: "project", projectOverridesGlobal: true, session: null });

    // With no project (written by main itself): both workers follow; a session value of B's own keeps winning in B.
    await ok(h.d.handle(good, { method: "settings.update", projectId: b.id, scope: "session", key: "claude.model", value: "b-session" }));
    await ok(h.d.handle(good, { method: "settings.update", projectId: null, scope: "global", key: "claude.model", value: "g-claude" }));
    expect(entry(await read(h, a.id), "claude.model")).toMatchObject({ effective: "g-claude", source: "global", session: null });
    expect(entry(await read(h, b.id), "claude.model")).toMatchObject({ effective: "b-session", source: "session" });
    expect(YAML.parse(readFileSync(userConfig(), "utf8")).claude.model).toBe("g-claude");

    // Reset in the user config: back to the default in A (deleted from the file, not written as null); B keeps its session's.
    await ok(h.d.handle(good, { method: "settings.clear", projectId: null, scope: "global", key: "claude.model" }));
    expect(entry(await read(h, a.id), "claude.model")).toMatchObject({ effective: null, source: "default", session: null });
    expect(entry(await read(h, b.id), "claude.model")).toMatchObject({ effective: "b-session", source: "session" });
    expect(YAML.parse(readFileSync(userConfig(), "utf8")).claude).not.toHaveProperty("model");

    // The CLI picker writes claude.bin to the user config: both chats' next Claude call runs the binary picked.
    const picked = join(t.path, "picked");
    mkdirSync(picked);
    const altLog = join(t.path, "picked-calls.jsonl");
    const shim = fakeShim("claude", { exec: process.execPath, env: { FAKE_LOG: altLog } });
    h.pick.binary = join(picked, shim.file);
    writeFileSync(h.pick.binary, shim.text);
    chmodSync(h.pick.binary, 0o755);
    await ok(h.d.handle(good, { method: "cli.pick", backend: "claude" }));
    for (const p of [a, b]) expect(entry(await read(h, p.id), "claude.bin")).toMatchObject({ effective: h.pick.binary, source: "global", session: null });

    // What the chats' next calls get: A's Codex the user config's model, B's its own; both Claudes the binary picked.
    await say(h, a.id, inA, "again");
    await say(h, b.id, inB, "again");
    const codex = fake.calls("chat_codex");
    expect(codex.at(-2)!.args.join(" ")).toContain("g-model");
    expect(codex.at(-1)!.args.join(" ")).toContain("b-model");
    const picks = () => (existsSync(altLog) ? readFileSync(altLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { role: string; args: string[] }) : []);
    await say(h, a.id, inA, "/claude hi", () => picks().length);
    await say(h, b.id, inB, "/claude hi", () => picks().length);
    const viaPicked = picks();
    expect(viaPicked.filter((c) => c.role === "chat_claude")).toHaveLength(2);
    expect(viaPicked.at(-1)!.args.join(" ")).toContain("b-session");
  }, 120_000);

  it("brings the other open projects up to date with a user config change the composer made", async () => {
    writeYaml(userConfig(), { claude: { bin: fake.path("claude") }, codex: { bin: fake.path("codex"), model: "g-model" } });
    const h = harness({ worker: worker.script, env: env() });
    const a = await project(h, "a", null);
    const b = await project(h, "b", { claude: { model: "b-claude" } });
    const inA = await chatting(h, a.id);
    const inB = await chatting(h, b.id);
    expect(fake.calls("chat_codex").at(-1)!.args.join(" ")).toContain("g-model");
    // What A's composer sends, as its window does: from the view main gave it.
    const view = h.events.filter((e) => e.type === "host" && e.projectId === a.id && e.conversationId === inA).map((e) => (e as { view: number }).view).at(-1)!;
    const composer = (message: unknown) => ok(h.d.handle(good, { method: "chat.message", projectId: a.id, conversationId: inA, view, message }));
    const userYaml = () => YAML.parse(readFileSync(userConfig(), "utf8")) as { codex: { model?: string }; claude: { model?: string } };

    // A command typed with --global: written to the user config by A's worker, and B's chat follows it.
    expect(await composer({ type: "submit", text: "/codex model gpt-5.5 --global", route: "message", attachments: [] })).toEqual({ accepted: true });
    await waitUntil(() => userYaml().codex.model === "gpt-5.5", 20_000, "the user config to be written");
    await shows(h, b.id, "codex.model", { effective: "gpt-5.5", source: "global", session: null });
    // The chat's settings menu with Global: B follows too, but its own file's claude.model keeps winning there.
    await composer({ type: "setting", setting: { target: "claude.model", model: "g-claude" }, save: false, global: true, yes: false });
    await waitUntil(() => userYaml().claude.model === "g-claude", 20_000, "the user config to be written");
    await shows(h, b.id, "claude.model", { effective: "b-claude", source: "project", projectOverridesGlobal: true, session: null });
    // Saved to A's own file (--save): B's chat keeps the user config's model.
    await composer({ type: "submit", text: "/codex model a-model --save", route: "message", attachments: [] });
    await waitUntil(() => existsSync(join(a.path, ".agentduo", "config.yaml")) && readFileSync(join(a.path, ".agentduo", "config.yaml"), "utf8").includes("a-model"), 20_000, "A's config to be written");
    await shows(h, a.id, "codex.model", { effective: "a-model", source: "project", session: null });
    await shows(h, b.id, "codex.model", { effective: "gpt-5.5", source: "global", session: null });

    // What B's next calls get: Codex the model typed in A, Claude its own file's.
    await say(h, b.id, inB, "again");
    expect(fake.calls("chat_codex").at(-1)!.args.join(" ")).toContain("gpt-5.5");
    await say(h, b.id, inB, "/claude hi");
    expect(fake.calls("chat_claude").at(-1)!.args.join(" ")).toContain("b-claude");
  }, 120_000);

  it("keeps conversations without a project through switching and restarting, with chat and discuss outside git", async () => {
    writeYaml(userConfig(), { claude: { bin: fake.path("claude") }, codex: { bin: fake.path("codex") } });
    const h = harness({ worker: worker.script, env: env() });
    const general = CONVERSATIONS_PROJECT_ID;
    expect(h.projects.active.projectId).toBe(general);
    expect(h.prefs.projects).toEqual([]);
    expect(h.projects.summaries()).toMatchObject([{ id: general, name: "Conversations", path: t.path }]);
    const conversation = await chatting(h, general, "A general question");
    expect(fake.calls("chat_codex").at(-1)!.args).toContain("--skip-git-repo-check");
    await say(h, general, conversation, "/claude Hello");
    await say(h, general, conversation, "/discuss A general discussion");
    expect(fake.calls("discuss_synthesis")).toHaveLength(1);
    h.projects.saveDraft(general, conversation, "A draft");
    const p = await project(h, "p", null);
    const projectChat = await chatting(h, p.id, "Project question");
    await ok(h.d.handle(good, { method: "project.select", projectId: general }));
    expect(h.projects.active).toEqual({ projectId: general, conversationId: conversation });
    expect(h.projects.conversations(general).some((c) => c.id === conversation && c.title === "A general question")).toBe(true);
    expect(h.projects.conversations(p.id).some((c) => c.id === conversation)).toBe(false);
    expect(h.projects.conversations(general).some((c) => c.id === projectChat)).toBe(false);
    await ok(h.d.handle(good, { method: "settings.update", projectId: null, scope: "global", key: "codex.model", value: "general-model" }));
    await say(h, general, conversation, "/codex Next question");
    expect(fake.calls("chat_codex").at(-1)!.args).toContain("general-model");
    await h.projects.dispose();
    const restarted = harness({ worker: worker.script, env: env() });
    expect(restarted.projects.active).toEqual({ projectId: general, conversationId: conversation });
    await ok(restarted.d.handle(good, { method: "conversation.open", projectId: general, conversationId: conversation }));
    await restarted.projects.session(general).start();
    expect(restarted.projects.draft(general, conversation)).toBe("A draft");
    await waitUntil(() => restarted.projects.session(general).conversation(conversation).state.timeline.some((i) => i.kind === "user" && i.text === "A general question"), 20_000, "the restored general conversation");
    expect(restarted.prefs.projects).toHaveLength(1);
  }, 120_000);

  it("starts a new conversation with the default recipient, and keeps a saved one's", async () => {
    writeYaml(userConfig(), { claude: { bin: fake.path("claude") }, codex: { bin: fake.path("codex") } });
    const h = harness({ worker: worker.script, env: env() });
    const p = await project(h, "p", null);
    // Saved with Codex (the default before the preference changed), then closed.
    const saved = await chatting(h, p.id, "first");
    expect(fake.calls("chat_codex")).toHaveLength(1);
    await ok(h.d.handle(good, { method: "conversation.close", projectId: p.id, conversationId: saved }));

    await ok(h.d.handle(good, { method: "prefs.set", patch: { defaultRecipient: "claude" } }));
    const { conversationId: fresh } = await ok<{ conversationId: string }>(h.d.handle(good, { method: "conversation.new", projectId: p.id }));
    const handle = h.projects.session(p.id).conversation(fresh);
    await waitUntil(() => handle.state.recipient === "claude", 20_000, "the new conversation's recipient");
    await say(h, p.id, fresh, "to whom?");
    expect(fake.calls("chat_claude")).toHaveLength(1);

    // The saved one, opened again from the history: still Codex's.
    await ok(h.d.handle(good, { method: "conversation.open", projectId: p.id, conversationId: saved }));
    await say(h, p.id, saved, "and you?");
    expect(fake.calls("chat_codex")).toHaveLength(2);
    expect(h.projects.session(p.id).conversation(saved).state.recipient).toBe("codex");
  }, 120_000);
});
