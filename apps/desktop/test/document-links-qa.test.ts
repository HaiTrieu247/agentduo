// QA owns this file (R19). The real ProjectManager, Dispatcher and DocumentService receive a controlled host stream.
// No Electron/worker subprocess: snapshots and onChange use the actual host contract, with fake timers for batching.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@agentduo/engine/testing/tmp";
import { userConfigEnv } from "@agentduo/engine/testing/config";
import type { HostMessage } from "@agentduo/host/protocol";
import { initialState, type ViewState } from "@agentduo/host/viewState";
import type { WorkspaceSessionOptions } from "@agentduo/host/workspaceSession";
import { DocumentService } from "../src/main/documents.js";
import { LogBuffer } from "../src/main/diagnostics.js";
import { Dispatcher } from "../src/main/ipc.js";
import { PreferencesStore } from "../src/main/preferences.js";
import { ProjectManager } from "../src/main/projects.js";
import { ResourceTokens } from "../src/main/resources.js";
import { CONVERSATIONS_PROJECT_ID, type DesktopEvent, type SenderInfo } from "../src/shared/protocol.js";
import type { DocumentOpened, DocumentSaved } from "../src/shared/documents.js";

interface ControlledHost {
  snapshot(conversationId: string, state: ViewState): void;
  change(conversationId: string, state: ViewState): void;
}
const hosts = vi.hoisted(() => new Map<string, ControlledHost>());
vi.mock("@agentduo/host/workspaceSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentduo/host/workspaceSession")>();
  const { initialState } = await import("@agentduo/host/viewState");
  class ControlledSession {
    private readonly states = new Map<string, ViewState>();
    private readonly pages = new Map<string, (m: HostMessage) => void>();
    readonly workerPid = null;
    readonly runsDirectory = null;
    constructor(private readonly options: WorkspaceSessionOptions) { hosts.set(options.workspace, this); }
    get conversations() { return [...this.states.keys()]; }
    conversation(id: string) {
      if (!this.states.has(id)) this.states.set(id, initialState("active", this.options.workspace));
      const self = this;
      return {
        get state() { return self.states.get(id)!; },
        attach: (post: (m: HostMessage) => void) => {
          this.pages.set(id, post);
          post({ type: "snapshot", state: this.states.get(id)! });
        },
        close: async () => { this.pages.delete(id); },
        selectRecipient: async () => undefined,
      };
    }
    snapshot(id: string, state: ViewState) {
      this.states.set(id, state);
      this.pages.get(id)?.({ type: "snapshot", state });
    }
    change(id: string, state: ViewState) {
      this.states.set(id, state);
      this.options.onChange?.(id, state);
    }
    async start() { return null; }
    async restart() {}
    async dispose() { this.pages.clear(); }
  }
  return { ...actual, WorkspaceSession: ControlledSession };
});

const C = "20261118-120000-tab-abcd1234";
const sender: SenderInfo = { senderId: 3, windowId: 3, mainFrame: true, url: "agentduo://app/index.html" };
type Links = Extract<DesktopEvent, { type: "documentLinks" }>;
let scratch: ReturnType<typeof tempDir>;
let events: DesktopEvent[];
let manager: ProjectManager;
let documents: DocumentService;
let dispatcher: Dispatcher;
let shell: { openPath: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>; openExternal: ReturnType<typeof vi.fn<(url: string) => Promise<void>>> };
beforeEach(() => {
  vi.useFakeTimers();
  hosts.clear();
  scratch = tempDir();
  events = [];
  const prefs = new PreferencesStore(join(scratch.path, "prefs.json"));
  documents = new DocumentService({ post: (event) => events.push(event) });
  const env = { HOME: scratch.path, ...userConfigEnv(join(scratch.path, "config")) };
  manager = new ProjectManager({
    prefs, documents, tokens: new ResourceTokens(), host: { pickFiles: async () => [], copy() {} },
    workerScript: join(scratch.path, "unused-worker.js"), env: () => env,
    resolveNode: () => ({ ok: false, message: "controlled host" }), stagingDir: join(scratch.path, "staging"),
    post: (event) => events.push(event), log() {},
  });
  shell = { openPath: vi.fn(async () => undefined), openExternal: vi.fn(async () => undefined) };
  dispatcher = new Dispatcher({
    projects: manager, prefs, logs: new LogBuffer(), userData: scratch.path, logsDir: join(scratch.path, "logs"),
    env: () => env, launcher: () => null, snapshot: () => { throw new Error("not needed"); },
    shell: { ...shell, chooseFolder: async () => null, chooseBinary: async () => null, saveFile: async () => null },
  });
});
afterEach(async () => {
  await manager.dispose();
  vi.useRealTimers();
  scratch.cleanup();
});
const mappings = () => events.filter((e): e is Links => e.type === "documentLinks");
function state(workspace: string | null, ...links: string[]): ViewState {
  return { ...initialState("active", workspace), timeline: links.map((text, n) => ({ id: `pm-${n}`, kind: "pm", text })) };
}
function folder(name: string): string {
  const path = join(scratch.path, name);
  mkdirSync(path, { recursive: true });
  return path;
}
function attach(workspace: string) {
  const { id } = manager.open(workspace);
  manager.openConversation(id, C);
  return { id, host: hosts.get(workspace)! };
}
async function invoke<T>(request: unknown): Promise<T> {
  const result = await dispatcher.handle(sender, request);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.error);
  return result.result as T;
}

describe("T3 QA — real desktop link registration and IPC (AC1, AC3, AC4, AC7)", () => {
  it("registers both a snapshot and subsequent chat changes, then reissues live IDs for a fresh snapshot", async () => {
    const workspace = folder("workspace");
    writeFileSync(join(workspace, "first.md"), "first");
    writeFileSync(join(workspace, "second.md"), "second");
    const { id, host } = attach(workspace);
    host.snapshot(C, state(workspace, "[first](first.md)"));
    const first = mappings().at(-1)!;
    expect(first).toMatchObject({ projectId: id, conversationId: C, links: [{ itemId: "pm-0", ordinal: 0 }] });
    host.change(C, state(workspace, "[first](first.md)", "[web](https://example.test) [second](second.md)"));
    await vi.advanceTimersByTimeAsync(500);
    const delta = mappings().at(-1)!;
    expect(delta.links).toEqual([{ linkId: expect.any(String), itemId: "pm-1", part: "text", ordinal: 1 }]);
    const opened = await invoke<DocumentOpened>({ method: "document.open", projectId: id, conversationId: C, view: delta.view, linkId: delta.links[0]!.linkId });
    expect(opened).toMatchObject({ ok: true, document: { text: "second" } });
    host.snapshot(C, state(workspace, "[first](first.md)", "[web](https://example.test) [second](second.md)"));
    expect(new Set(mappings().at(-1)!.links.map((l) => l.linkId))).toEqual(new Set([first.links[0]!.linkId, delta.links[0]!.linkId]));
    expect(JSON.stringify(mappings())).not.toContain(workspace);
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("uses the conversation workspace and ignores substitute paths supplied in open/save IPC", async () => {
    const project = folder("project");
    const conversation = folder("worktree");
    const decoy = join(project, "notes.md");
    const target = join(conversation, "notes.md");
    writeFileSync(decoy, "workspace decoy");
    writeFileSync(target, "worktree target");
    const { id, host } = attach(project);
    host.snapshot(C, state(conversation, "[notes](notes.md)"));
    const map = mappings().at(-1)!;
    const opened = await invoke<DocumentOpened>({ method: "document.open", projectId: id, conversationId: C, view: map.view, linkId: map.links[0]!.linkId, path: decoy });
    expect(opened).toMatchObject({ ok: true, document: { text: "worktree target", location: target } });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(readFileSync(target, "utf8")).toBe("worktree target");
    const saved = await invoke<DocumentSaved>({ method: "document.save", documentId: opened.document.documentId, revision: opened.document.revision, text: "edited", path: decoy, href: decoy });
    expect(saved).toMatchObject({ ok: true });
    expect(readFileSync(target, "utf8")).toBe("edited");
    expect(readFileSync(decoy, "utf8")).toBe("workspace decoy");
  });

  it("revokes stale views on reattachment without losing the document being edited", async () => {
    const workspace = folder("workspace");
    writeFileSync(join(workspace, "notes.md"), "base");
    const { id, host } = attach(workspace);
    host.snapshot(C, state(workspace, "[notes](notes.md)"));
    const old = mappings().at(-1)!;
    const request = { method: "document.open", projectId: id, conversationId: C, view: old.view, linkId: old.links[0]!.linkId };
    const opened = await invoke<DocumentOpened>(request);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.error.message);
    await invoke({ method: "document.dirty", documentId: opened.document.documentId, dirty: true });
    manager.openConversation(id, C);
    expect(await invoke(request)).toMatchObject({ ok: false, error: { code: "link-stale" } });
    expect(await invoke({ method: "document.save", documentId: opened.document.documentId, revision: opened.document.revision, text: "still editing" })).toMatchObject({ ok: true });
    expect(readFileSync(join(workspace, "notes.md"), "utf8")).toBe("still editing");
  });

  it("does not resolve a relative link from Conversations against the home directory", async () => {
    manager.openConversation(CONVERSATIONS_PROJECT_ID, C);
    const host = hosts.get(scratch.path)!;
    host.snapshot(C, state(null, "[missing](notes.md)"));
    const map = mappings().at(-1)!;
    expect(await invoke({ method: "document.open", projectId: CONVERSATIONS_PROJECT_ID, conversationId: C, view: map.view, linkId: map.links[0]!.linkId }))
      .toMatchObject({ ok: false, error: { code: "link-unresolved" } });
  });
});
