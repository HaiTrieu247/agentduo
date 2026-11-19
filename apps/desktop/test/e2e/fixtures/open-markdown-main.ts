// QA-owned T4 harness. Runs the actual renderer and preload against the actual DocumentService. Only the app's
// workspace/worker shell is controlled: PM messages enter as host snapshots, exactly as ChatHost receives them.
// Faults and pending promises are explicit controls, never timing sleeps or permission-dependent chmod tests.
import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { initialState } from "@agentduo/host/viewState";
import { DocumentService } from "../../../src/main/documents.js";
import { documentError } from "../../../src/shared/documents.js";
import {
  DEFAULT_PREFERENCES, EVENT_CHANNEL, INVOKE_CHANNEL, parseDesktopRequest,
  type AppSnapshot, type DesktopEvent, type DesktopRequest,
} from "../../../src/shared/protocol.js";

const project = "1111111111111111";
const secondProject = "2222222222222222";
const conversation = "20261118-120000-open-qa";
const otherConversation = "20261118-120001-other-qa";
const workspace = process.env.AGENTDUO_OPEN_QA_WORKSPACE!;
const renderer = process.env.AGENTDUO_OPEN_QA_RENDERER!;
const preload = process.env.AGENTDUO_OPEN_QA_PRELOAD!;
const pmText = process.env.AGENTDUO_OPEN_QA_MESSAGE!;
let win: BrowserWindow;
const post = (event: DesktopEvent) => win.webContents.send(EVENT_CHANNEL, event);
const documents = new DocumentService({ post });
const requests: DesktopRequest[] = [];
let openFault: "unreadable" | null = null;
let saveFault = false;
let holdOpen = false;
let holdSave = false;
const pending = new Map<"open" | "save", () => void>();
let view = 0;
let active = { projectId: project, conversationId: conversation };
let prefs = { ...DEFAULT_PREFERENCES, onboarded: true, inspector: false, accountOpen: false, autoUpdate: false };
const snapshot = (): AppSnapshot => ({
  prefs, projects: [
    { id: project, name: "QA workspace", path: workspace, missing: false },
    { id: secondProject, name: "Other project", path: join(workspace, "other"), missing: false },
  ], active, platform: process.platform, arch: process.arch, userData: app.getPath("userData"), dark: false,
  versions: { app: "0.0.0", electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
  update: { status: "idle" },
});
const list = (projectId: string) => post({ type: "conversations", projectId, items: [
  { id: conversation, title: "PM documents", updatedAt: null, running: false, waiting: 0, activity: null, saved: true },
  { id: otherConversation, title: "Other conversation", updatedAt: null, running: false, waiting: 0, activity: null, saved: true },
] });
function attach(projectId: string, conversationId: string): void {
  const number = ++view;
  const state = { ...initialState("active", workspace), timeline: [{ id: "pm-qa", kind: "pm" as const, text: pmText }] };
  post({ type: "host", projectId, conversationId, view: number, message: { type: "snapshot", state } });
  documents.syncLinks(projectId, conversationId, number, state.timeline, true);
  list(projectId);
}
async function waitForRelease(kind: "open" | "save"): Promise<void> {
  if ((kind === "open" && !holdOpen) || (kind === "save" && !holdSave)) return;
  await new Promise<void>((resolve) => pending.set(kind, resolve));
  pending.delete(kind);
}
async function handle(r: DesktopRequest): Promise<unknown> {
  requests.push(r);
  switch (r.method) {
    case "app.state": return snapshot();
    case "prefs.set": prefs = { ...prefs, ...r.patch }; return prefs;
    case "conversation.open":
      active = { projectId: r.projectId, conversationId: r.conversationId };
      attach(r.projectId, r.conversationId);
      return { conversationId: r.conversationId, draft: "" };
    case "conversation.select": active = { projectId: r.projectId, conversationId: r.conversationId }; return { selected: true };
    case "conversation.new": return { conversationId: otherConversation };
    case "project.select":
      active = { projectId: r.projectId, conversationId: conversation };
      list(r.projectId);
      return snapshot();
    case "document.open": {
      const result = openFault ? { ok: false as const, error: documentError(openFault, "QA document") }
        : await documents.open({ ...r, workspace });
      // Delay delivery, keeping the real read and its result. This models an old open response arriving late.
      await waitForRelease("open");
      return result;
    }
    case "document.save":
      await waitForRelease("save");
      return saveFault ? { ok: false, error: documentError("save-failed", "QA document", "controlled disk write failure") }
        : documents.save(r.documentId, r.revision, r.text, r.overwrite);
    case "document.reload": return documents.reload(r.documentId);
    case "document.dirty": documents.setDirty(r.documentId, r.dirty); return { recorded: true };
    case "document.close": documents.close(r.documentId); return { closed: true };
    case "document.closeResponse": return { accepted: true };
    case "chat.message":
    case "chat.draft": return { accepted: true };
    case "project.runs": return [];
    case "run.inspect": return null;
    case "changes.list": return [];
    case "account.usage": return { codex: null, claude: null };
    default: throw new Error(`QA harness has no response for ${r.method}`);
  }
}

export interface OpenMarkdownQa {
  requests: DesktopRequest[];
  dirtyIds(): string[];
  sessions(): string[];
  fault(kind: "save" | "unreadable" | null): void;
  hold(kind: "open" | "save", enabled: boolean): void;
  waiting(kind: "open" | "save"): boolean;
  release(kind: "open" | "save"): void;
  post(event: DesktopEvent): void;
}
(globalThis as typeof globalThis & { openMarkdownQa: OpenMarkdownQa }).openMarkdownQa = {
  requests, dirtyIds: () => documents.dirtyIds(), sessions: () => documents.ids(), post,
  fault(kind) { saveFault = kind === "save"; openFault = kind === "unreadable" ? "unreadable" : null; },
  hold(kind, enabled) { if (kind === "save") holdSave = enabled; else holdOpen = enabled; },
  waiting: (kind) => pending.has(kind),
  release(kind) { this.hold(kind, false); pending.get(kind)?.(); },
};

app.setPath("userData", process.env.AGENTDUO_DESKTOP_USER_DATA!);
void app.whenReady().then(async () => {
  ipcMain.handle(INVOKE_CHANNEL, async (_event, raw: unknown) => {
    try { return { ok: true, result: await handle(parseDesktopRequest(raw)) }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  win = new BrowserWindow({ width: 1360, height: 860, minWidth: 720, minHeight: 480,
    webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(join(renderer, "index.html"));
});
app.on("window-all-closed", () => app.quit());
