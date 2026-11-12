import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDesktopRequest, ProtocolError, trustedSender, type SenderInfo } from "../src/shared/protocol.js";
import { Dispatcher, type DispatcherOptions } from "../src/main/ipc.js";
import { LogBuffer } from "../src/main/diagnostics.js";
import { PreferencesStore } from "../src/main/preferences.js";
import { ProjectManager } from "../src/main/projects.js";
import { ResourceTokens } from "../src/main/resources.js";
import { userConfigEnv } from "@agentduo/engine/testing/config";

const good: SenderInfo = { senderId: 3, windowId: 3, mainFrame: true, url: "agentduo://app/index.html" };

describe("parseDesktopRequest", () => {
  it("accepts the requests the renderer sends", () => {
    expect(parseDesktopRequest({ method: "app.state" })).toEqual({ method: "app.state" });
    expect(parseDesktopRequest({ method: "prefs.set", patch: { theme: "dark", fontSize: 14 } })).toEqual({ method: "prefs.set", patch: { theme: "dark", fontSize: 14 } });
    expect(parseDesktopRequest({ method: "prefs.set", patch: { accountOpen: false } })).toEqual({ method: "prefs.set", patch: { accountOpen: false } });
    expect(parseDesktopRequest({ method: "settings.update", projectId: null, scope: "global", key: "claude.model", value: "opus" }))
      .toEqual({ method: "settings.update", projectId: null, scope: "global", key: "claude.model", value: "opus" });
    expect(parseDesktopRequest({ method: "changes.file", projectId: "0123456789abcdef", listId: "l3", index: 2 }).method).toBe("changes.file");
    expect(parseDesktopRequest({ method: "prefs.set", patch: { autoUpdate: false } })).toEqual({ method: "prefs.set", patch: { autoUpdate: false } });
    expect(parseDesktopRequest({ method: "update.check", url: "https://evil.example/feed.yml" })).toEqual({ method: "update.check" });
    expect(parseDesktopRequest({ method: "update.install" })).toEqual({ method: "update.install" });
    expect(parseDesktopRequest({ method: "link.open", link: "agentduo-releases" })).toEqual({ method: "link.open", link: "agentduo-releases" });
    expect(parseDesktopRequest({ method: "team.read", projectId: null })).toEqual({ method: "team.read", projectId: null });
    const conversation = { projectId: "0123456789abcdef", conversationId: "20261031-120000-tab-abcd1234" };
    for (const method of ["conversation.archive", "conversation.restore", "conversation.delete"]) {
      expect(parseDesktopRequest({ method, ...conversation, path: "/etc" })).toEqual({ method, ...conversation });
    }
    expect(parseDesktopRequest({ method: "conversation.archived", projectId: "0123456789abcdef" })).toEqual({ method: "conversation.archived", projectId: "0123456789abcdef" });
    const team = { members: [{ role: "dev", level: "mid", cli: "claude", count: 2, group: "web", model: null }], roles: { dev: { kind: "worker" } }, levels: { mid: { can_review: false, claude: { model: "sonnet" } } }, max_parallel: 3 };
    expect(parseDesktopRequest({ method: "team.save", projectId: null, scope: "project", team })).toEqual({ method: "team.save", projectId: null, scope: "project", team });
    expect(parseDesktopRequest({ method: "team.openIdentity", projectId: null, scope: "global", kind: "role", name: "frontend-dev" }))
      .toEqual({ method: "team.openIdentity", projectId: null, scope: "global", kind: "role", name: "frontend-dev" });
  });

  it("refuses unknown methods, paths for ids, bad preferences and chat messages that mean nothing here", () => {
    const bad = [
      { method: "fs.read", path: "/etc/passwd" },
      { method: "project.select", projectId: "../../etc" },
      { method: "conversation.open", projectId: "0123456789abcdef", conversationId: "../x" },
      { method: "conversation.delete", projectId: "0123456789abcdef", conversationId: "../x" },
      { method: "conversation.archive", projectId: "0123456789abcdef" },
      { method: "prefs.set", patch: { theme: "neon" } },
      { method: "prefs.set", patch: { fontSize: 99 } },
      { method: "prefs.set", patch: { sidebarWidth: 100 } },
      { method: "prefs.set", patch: { sidebarWidth: 900 } },
      { method: "prefs.set", patch: { sidebarWidth: 250.5 } },
      { method: "prefs.set", patch: { accountOpen: "no" } },
      { method: "prefs.set", patch: { autoUpdate: 1 } },
      { method: "prefs.set", patch: { nodeIntegration: true } },
      { method: "settings.update", projectId: null, scope: "global", key: "paths/../x", value: 1 },
      { method: "settings.update", projectId: null, scope: "global", key: "claude.model", value: { $where: 1 } },
      { method: "chat.message", projectId: "0123456789abcdef", conversationId: "20261031-120000-tab-abcd1234", view: 1, message: { type: "ready" } },
      { method: "changes.file", projectId: "0123456789abcdef", listId: "/tmp/x", index: 0 },
      { method: "link.open", link: "https://evil.example" },
      { method: "folder.open", projectId: null, folder: "/" },
      { method: "team.openIdentity", projectId: null, scope: "global", kind: "role", name: "../../etc" },
      { method: "team.openIdentity", projectId: null, scope: "global", kind: "secrets", name: "dev" },
      { method: "team.openIdentity", projectId: null, scope: "/", kind: "role", name: "dev" },
      { method: "team.identity.write", projectId: null, scope: "global", kind: "role", name: "dev", text: "x".repeat(60_000) },
      { method: "team.save", projectId: null, scope: "global", team: { members: [{ role: "../x", level: "mid", cli: "claude" }], roles: {}, levels: {}, max_parallel: 1 } },
      { method: "team.save", projectId: null, scope: "global", team: { members: [{ role: "dev", level: "mid", cli: "gemini" }], roles: {}, levels: {}, max_parallel: 1 } },
      { method: "team.save", projectId: null, scope: "global", team: { members: [], roles: { "a/b": { kind: "worker" } }, levels: {}, max_parallel: 1 } },
      "app.state",
      null,
    ];
    for (const r of bad) expect(() => parseDesktopRequest(r), JSON.stringify(r)).toThrow(ProtocolError);
  });
});

describe("an agent's question", () => {
  const ids = { projectId: "0123456789abcdef", conversationId: "20261031-120000-tab-abcd1234", view: 3 };
  const question = (reply: unknown, extra: object = {}) => ({ method: "chat.message", ...ids, message: { type: "question", generation: 2, id: "clar-1", callId: "call-1", reply, ...extra } });

  it("takes the user's reply as the chat message that names its request and call, and only ids and bounded words", () => {
    const answered = { kind: "answered", answers: [{ questionId: "q1", optionIds: ["q1o1", "q1o3"], otherText: null }, { questionId: "q2", optionIds: [], otherText: "something else" }] };
    expect(parseDesktopRequest(question(answered))).toMatchObject({ method: "chat.message", message: { type: "question", id: "clar-1", callId: "call-1", reply: answered } });
    expect(parseDesktopRequest(question({ kind: "defer" }))).toMatchObject({ message: { reply: { kind: "defer" } } });
    expect(parseDesktopRequest(question({ kind: "cancelled", answers: [{ questionId: "x" }] }))).toMatchObject({ message: { reply: { kind: "cancelled" } } });
  });

  it("refuses a reply without its call, with an unprintable id, with no answers, or with a huge text", () => {
    const bad = [
      question({ kind: "defer" }, { callId: undefined }),
      question({ kind: "defer" }, { id: "bad\u0000id" }),
      question({ kind: "answered", answers: [] }),
      question({ kind: "answered", answers: [{ questionId: "../q", optionIds: [] }] }),
      question({ kind: "answered", answers: [{ questionId: "q1", optionIds: ["/etc/passwd"] }] }),
      question({ kind: "answered", answers: [{ questionId: "q1", optionIds: [], otherText: "x".repeat(200_000) }] }),
      question({ kind: "pick-for-me" }),
    ];
    for (const r of bad) expect(() => parseDesktopRequest(r), JSON.stringify(r).slice(0, 120)).toThrow(ProtocolError);
  });
});

describe("trustedSender", () => {
  it("trusts only the app window's top frame on the app origin", () => {
    expect(trustedSender(good)).toBe(true);
    expect(trustedSender({ ...good, senderId: 4 })).toBe(false);
    expect(trustedSender({ ...good, windowId: null })).toBe(false);
    expect(trustedSender({ ...good, mainFrame: false })).toBe(false);
    expect(trustedSender({ ...good, url: "https://example.com/" })).toBe(false);
    expect(trustedSender({ ...good, url: "file:///tmp/index.html" })).toBe(false);
    expect(trustedSender({ ...good, url: "agentduo://resource/abc" })).toBe(false);
  });
});

describe("Dispatcher", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function dispatcher(extra: Partial<DispatcherOptions> = {}) {
    dir = mkdtempSync(join(tmpdir(), "agentduo-desktop-ipc-"));
    const prefs = new PreferencesStore(join(dir, "prefs.json"));
    const events: unknown[] = [];
    const projects = new ProjectManager({
      prefs, tokens: new ResourceTokens(), host: { pickFiles: async () => [], copy: () => undefined }, workerScript: join(dir, "none.js"), env: () => ({ HOME: dir }),
      resolveNode: () => ({ ok: false, message: "no worker in this test" }), stagingDir: join(dir, "staging"), post: (e) => events.push(e), log: () => undefined,
    });
    const opened: string[] = [];
    const d = new Dispatcher({
      projects, prefs, logs: new LogBuffer(), userData: dir, logsDir: join(dir, "logs"), env: () => ({ HOME: dir, ...userConfigEnv(join(dir, "config")) }), launcher: () => null,
      snapshot: () => ({ prefs: prefs.prefs, projects: projects.summaries(), active: projects.active, platform: process.platform, arch: process.arch, versions: { app: "0", electron: "0", chrome: "0", node: "0" }, userData: dir, dark: false, update: { status: "off", reason: "test" } }),
      shell: { chooseFolder: async () => dir, chooseBinary: async () => null, saveFile: async () => null, openPath: async (p) => void opened.push(p), openExternal: async (u) => void opened.push(u) },
      ...extra,
    });
    return { d, prefs, projects, events, opened };
  }

  it("refuses a request from anything but the app window, and a malformed one, with an answer", async () => {
    const { d } = dispatcher();
    expect(await d.handle({ ...good, url: "https://evil.example" }, { method: "app.state" })).toEqual({ ok: false, error: "refused: not the app's window" });
    const bad = await d.handle(good, { method: "project.select", projectId: "nope" });
    expect(bad.ok).toBe(false);
    const unknown = await d.handle(good, { method: "project.select", projectId: "0123456789abcdef" });
    expect(unknown).toEqual({ ok: false, error: "no such project" });
  });

  it("saves preferences and opens projects by the folder the dialog gave", async () => {
    const { d, prefs } = dispatcher();
    const set = await d.handle(good, { method: "prefs.set", patch: { theme: "dark" } });
    expect(set).toMatchObject({ ok: true, result: { theme: "dark" } });
    expect(new PreferencesStore(join(dir, "prefs.json")).prefs.theme).toBe("dark");
    const open = await d.handle(good, { method: "project.open" });
    expect(open.ok).toBe(true);
    expect(prefs.projects).toHaveLength(1);
    const state = await d.handle(good, { method: "app.state" });
    expect(state).toMatchObject({ ok: true, result: { projects: [{ name: "Conversations", missing: false }, { missing: false }] } });
  });

  it("refuses a chat message from a view that is no longer the conversation's", async () => {
    const { d, events } = dispatcher();
    const open = (await d.handle(good, { method: "project.open" })) as { ok: true; result: { id: string } };
    const projectId = open.result.id;
    const created = (await d.handle(good, { method: "conversation.new", projectId })) as { ok: true; result: { conversationId: string } };
    const conversationId = created.result.conversationId;
    const first = (events.find((e) => (e as { type: string }).type === "host") as { view: number }).view;
    await d.handle(good, { method: "conversation.open", projectId, conversationId });
    const views = events.filter((e) => (e as { type: string }).type === "host").map((e) => (e as { view: number }).view);
    const latest = Math.max(...views);
    expect(latest).toBeGreaterThan(first);
    const stale = await d.handle(good, { method: "chat.message", projectId, conversationId, view: first, message: { type: "copy", text: "x" } });
    expect(stale).toEqual({ ok: true, result: { accepted: false } });
    const fresh = await d.handle(good, { method: "chat.message", projectId, conversationId, view: latest, message: { type: "copy", text: "x" } });
    expect(fresh).toEqual({ ok: true, result: { accepted: true } });
  });

  it("reads and changes the user config with no project and no worker, and refuses a project scope there", async () => {
    const { d } = dispatcher();
    const read = await d.handle(good, { method: "settings.read", projectId: null });
    expect(read.ok).toBe(true);
    const set = await d.handle(good, { method: "settings.update", projectId: null, scope: "global", key: "claude.model", value: "opus" });
    expect(set).toMatchObject({ ok: true });
    const entry = (set as { ok: true; result: { entries: Array<{ key: string; source: string; effective: unknown }> } }).result.entries.find((e) => e.key === "claude.model");
    expect(entry).toMatchObject({ source: "global", effective: "opus" });
    const cleared = await d.handle(good, { method: "settings.clear", projectId: null, scope: "global", key: "claude.model" });
    const back = (cleared as { ok: true; result: { entries: Array<{ key: string; source: string }> } }).result.entries.find((e) => e.key === "claude.model");
    expect(back?.source).toBe("default");
    const project = await d.handle(good, { method: "settings.update", projectId: null, scope: "project", key: "claude.model", value: "opus" });
    expect(project.ok).toBe(false);
  });

  it("reads the team and opens its identity files by name, creating one with a note, and nothing the team does not have", async () => {
    const { d, opened } = dispatcher();
    const read = (await d.handle(good, { method: "team.read", projectId: null })) as
      { ok: true; result: { members: Array<{ name: string }>; identities: Array<{ kind: string; name: string }>; membersFrom: string | null } };
    expect(read.ok).toBe(true);
    // No file has a team yet: agentduo's own runs, and Settings says so.
    expect(read.result.membersFrom).toBeNull();
    expect(read.result.members.map((m) => m.name)).toEqual(["pm", "techlead", "dev-1", "dev-2", "qa-1"]);
    const open = await d.handle(good, { method: "team.openIdentity", projectId: null, scope: "global", kind: "role", name: "dev" });
    expect(open).toMatchObject({ ok: true });
    const file = opened.at(-1)!;
    expect(file).toBe(join(dir, "config", "agentduo", "team", "roles", "dev", "IDENTITY.md"));
    expect(readFileSync(file, "utf8")).toContain("You are a developer on the team.");
    expect(await d.handle(good, { method: "team.openIdentity", projectId: null, scope: "global", kind: "role", name: "designer" }))
      .toEqual({ ok: false, error: "the team has no role 'designer'" });
    expect(await d.handle(good, { method: "team.openIdentity", projectId: null, scope: "project", kind: "level", name: "senior" }))
      .toEqual({ ok: false, error: "no project is open" });
  });

  it("saves the team only when it can start, and edits an identity's whole text, saved, reset and written as defaults", async () => {
    const { d } = dispatcher();
    const read = (await d.handle(good, { method: "team.read", projectId: null })) as { ok: true; result: { config: { members: unknown[]; roles: object; levels: object; max_parallel: number } } };
    const team = structuredClone(read.result.config) as { members: Array<Record<string, unknown>>; roles: object; levels: object; max_parallel: number };
    team.members.push({ role: "qa", level: "senior", cli: "codex", name: "qa-lead" });
    const saved = await d.handle(good, { method: "team.save", projectId: null, scope: "global", team });
    expect(saved).toMatchObject({ ok: true, result: { membersFrom: "global", members: expect.arrayContaining([expect.objectContaining({ name: "qa-lead", backend: "codex" })]) } });
    expect(readFileSync(join(dir, "config", "agentduo", "config.yaml"), "utf8")).toContain("qa-lead");
    const broken = { ...team, members: team.members.filter((m) => m.role !== "pm") };
    const refused = await d.handle(good, { method: "team.save", projectId: null, scope: "global", team: broken });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("exactly one member whose role is of kind pm") });
    const ref = { projectId: null, scope: "global" as const, kind: "role" as const, name: "dev" };
    expect(await d.handle(good, { method: "team.identity.read", ...ref })).toMatchObject({ ok: true, result: { source: "default", text: expect.stringContaining("You are a developer") } });
    expect(await d.handle(good, { method: "team.identity.write", ...ref, text: "Use pnpm." })).toEqual({ ok: true, result: { source: "global", text: "Use pnpm." } });
    expect(await d.handle(good, { method: "team.identity.reset", ...ref })).toMatchObject({ ok: true, result: { source: "default" } });
    expect(await d.handle(good, { method: "team.identity.read", ...ref, name: "designer" })).toEqual({ ok: false, error: "the team has no role 'designer'" });
  });

  it("checks for an update and restarts into one only when it is ready", async () => {
    let ready = false;
    const restarts: string[] = [];
    const { d } = dispatcher({
      updates: {
        check: async () => (ready ? { status: "ready", version: "0.8.0" } : { status: "latest", checkedAt: "2026-10-31T12:00:00.000Z" }),
        install: () => {
          if (!ready) throw new Error("No update is ready to install.");
          restarts.push("0.8.0");
        },
      },
    });
    expect(await d.handle(good, { method: "update.check" })).toEqual({ ok: true, result: { status: "latest", checkedAt: "2026-10-31T12:00:00.000Z" } });
    expect(await d.handle(good, { method: "update.install" })).toEqual({ ok: false, error: "No update is ready to install." });
    ready = true;
    expect(await d.handle(good, { method: "update.install" })).toEqual({ ok: true, result: { restarting: true } });
    expect(restarts).toEqual(["0.8.0"]);
    // Without the app's updates (a test host): the snapshot's state, and nothing to install.
    const bare = dispatcher().d;
    expect(await bare.handle(good, { method: "update.check" })).toEqual({ ok: true, result: { status: "off", reason: "test" } });
    expect((await bare.handle(good, { method: "update.install" })).ok).toBe(false);
  });

  it("opens only named links and known folders", async () => {
    const { d, opened } = dispatcher();
    expect(await d.handle(good, { method: "link.open", link: "codex-install" })).toEqual({ ok: true, result: { opened: true } });
    expect(opened[0]).toMatch(/^https:\/\//);
    await d.handle(good, { method: "link.open", link: "agentduo-releases" });
    expect(opened[1]).toBe("https://github.com/HaiTrieu247/agentduo/releases/latest");
    await d.handle(good, { method: "link.open", link: "agentduo-website" });
    expect(opened[2]).toBe("https://agentduo.netlify.app/");
    expect(await d.handle(good, { method: "folder.open", projectId: null, folder: "userData" })).toEqual({ ok: true, result: { opened: dir } });
  });
});
