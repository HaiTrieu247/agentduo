// What crosses between the desktop's renderer and its main process, and how main checks it. The renderer is isolated
// (no Node, a sandboxed preload): it names projects, conversations, artifacts and listed changes by the ids main gave
// it, never by a path, and every request is checked here before main acts on it. Pure, so it is tested as is.
import type { ConfigScope, ConfigurationView } from "../../../../src/core/configuration.js";
import type { Backend } from "../../../../src/core/commands.js";
import {
  ARTIFACTS, BACKENDS, CONFIG_SCOPES, isConversationId, parseWebviewMessage, ProtocolError, type ArtifactContent, type ArtifactName, type Change, type FocusedRun,
  type HostMessage, type SnapshotFile, type WebviewMessage,
} from "../../../../extensions/vscode/src/protocol.js";
import type { AccountUsage } from "../../../../extensions/vscode/src/protocol.js";
import type { Check } from "../../../../src/core/doctor.js";

export { ProtocolError };

/** renderer → main: one request, answered (ipcRenderer.invoke / ipcMain.handle). */
export const INVOKE_CHANNEL = "agentduo:invoke";
/** main → renderer: what the host pushes (webContents.send). */
export const EVENT_CHANNEL = "agentduo:event";

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export const FONT_SIZES = { min: 11, max: 20, default: 13 } as const;

/** The desktop's own preferences (userData/preferences.json); agentduo's engine settings live in its config files. */
export interface Preferences {
  theme: Theme;
  fontSize: number;
  /** The right-hand panel (plan, changes, checks) is open. */
  inspector: boolean;
  /** Who a new conversation's plain messages go to; a desktop preference, not the engine's role mapping. */
  defaultRecipient: Backend;
  /** The first-run setup was finished (or skipped) once. */
  onboarded: boolean;
  /** The sidebar's Account & Usage box is open (its limits shown, and looked up). */
  accountOpen: boolean;
  /** Look for a new version of the app on a timer (main/updates.ts); a check can always be asked for. */
  autoUpdate: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = { theme: "system", fontSize: FONT_SIZES.default, inspector: true, defaultRecipient: "codex", onboarded: false, accountOpen: true, autoUpdate: true };

/** The persistent conversation group used before a project is opened. */
export const CONVERSATIONS_PROJECT_ID = "0000000000000000";

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  /** Its folder is gone (moved, deleted, an unplugged drive). */
  missing: boolean;
}

export interface ConversationItem {
  id: string;
  title: string;
  updatedAt: string | null;
  /** It has a view in this window now. */
  open: boolean;
  running: boolean;
  /** Questions waiting for the user: decisions and permission prompts. */
  waiting: number;
  /** What is going on, in a few words ("Claude implementing · round 2"), or null. */
  activity: string | null;
}

/** A run of the project that is stopped or waiting, which /resume <id> continues. */
export interface RunItem {
  id: string;
  task: string;
  phase: string;
  updatedAt: string | null;
}

/** Where the app's own update is (main/updates.ts). */
export type UpdateState =
  /** This build never looks: a development build, a test profile, a copy no AgentDuo installer put there. */
  | { status: "off"; reason: string }
  /** Not checked yet. */
  | { status: "idle" }
  | { status: "checking" }
  | { status: "latest"; checkedAt: string }
  | { status: "downloading"; version: string; percent: number }
  /** Downloaded: a restart installs it (so does quitting). */
  | { status: "ready"; version: string }
  /** A newer version is out, but this build cannot install it itself: the user downloads it from the release page. */
  | { status: "manual"; version: string; reason: string }
  | { status: "error"; message: string; checkedAt: string };

export interface AppSnapshot {
  prefs: Preferences;
  projects: ProjectSummary[];
  active: { projectId: string | null; conversationId: string | null };
  platform: NodeJS.Platform;
  versions: { app: string; electron: string; chrome: string; node: string };
  userData: string;
  /** What "system" resolves to now. */
  dark: boolean;
  update: UpdateState;
}

export type CliState = "missing" | "installed" | "signed-in" | "signed-out" | "unknown" | "error";

/** How a signed-in CLI signs in: the agent's own account (claude.ai, ChatGPT) or an API (a key, a cloud provider). */
export interface CliAuth {
  kind: "account" | "api";
  /** The plan, or what it signs in with ("Max", "ChatGPT", "API key", "Amazon Bedrock"); never a key. */
  plan: string | null;
  /** The email it signs in with, when the check says it (`codex login status` does not: the usage lookup does). */
  email: string | null;
}

export interface CliStatus {
  backend: Backend;
  /** The binary agentduo is configured with (claude.bin / codex.bin) and where that resolved; null: not found. */
  configured: string;
  path: string | null;
  version: string | null;
  state: CliState;
  /** Signed in, and the CLI said how; null otherwise. */
  auth: CliAuth | null;
  /** What went wrong, or what to know (a CLI installed with npm that needs a Node on the PATH). */
  detail: string | null;
  /** Where its bin setting comes from: the default name, the user config, or a project. */
  source: "default" | "global" | "project" | "session";
}

export interface LauncherInfo {
  /** Where the PATH the agents get came from: as the app was started, plus the login shell's, plus common install dirs. */
  sources: string[];
  /** The login shell did not answer in time or failed; the PATH is the app's own plus the common dirs. */
  shellProblem: string | null;
  entries: number;
}

export interface ChangeListView {
  /** Names this list: a file is asked for by the list and its index, never by path. */
  listId: string;
  runId: string;
  hasSnapshots: boolean;
  base: string | null;
  snapshot: string | null;
  changes: Change[];
}

export interface ChangeFile {
  path: string;
  status: string;
  before: SnapshotFile;
  after: SnapshotFile;
}

export interface Diagnostics {
  /** What the export holds, exactly as it is written: shown first, so nothing leaves without being seen. */
  text: string;
}

/** Links the host opens in the user's browser: only these, by name. */
export const LINKS = {
  "claude-install": "https://code.claude.com/docs/en/setup",
  "codex-install": "https://developers.openai.com/codex/cli",
  "agentduo-readme": "https://github.com/HaiTrieu247/agentduo#readme",
  "agentduo-desktop": "https://github.com/HaiTrieu247/agentduo/tree/main/apps/desktop#readme",
  /** The latest release's page, where a build that cannot update itself gets the new version. */
  "agentduo-releases": "https://github.com/HaiTrieu247/agentduo/releases/latest",
} as const;
export type LinkName = keyof typeof LINKS;

export type Folder = "runs" | "userData" | "logs" | "project";

/** renderer → main. Every request names what it acts on by ids main handed out. */
export type DesktopRequest =
  | { method: "app.state" }
  | { method: "prefs.set"; patch: Partial<Preferences> }
  /** The native folder picker; the project chosen becomes the active one. */
  | { method: "project.open" }
  | { method: "project.select"; projectId: string }
  | { method: "project.forget"; projectId: string }
  | { method: "project.restart"; projectId: string }
  | { method: "project.runs"; projectId: string }
  | { method: "conversation.new"; projectId: string }
  | { method: "conversation.open"; projectId: string; conversationId: string }
  /** A conversation the window shows already becomes the selected one again (kept as it is: same view, same chat). */
  | { method: "conversation.select"; projectId: string; conversationId: string }
  | { method: "conversation.close"; projectId: string; conversationId: string }
  /** What a conversation's chat sends, as the VS Code webview sends it (`view`: the attachment it was shown by). */
  | { method: "chat.message"; projectId: string; conversationId: string; view: number; message: WebviewMessage }
  | { method: "chat.draft"; projectId: string; conversationId: string; text: string }
  | { method: "run.inspect"; projectId: string; conversationId: string | null }
  | { method: "artifact.read"; projectId: string; conversationId: string | null; artifact: ArtifactName }
  | { method: "changes.list"; projectId: string; conversationId: string | null }
  | { method: "changes.file"; projectId: string; listId: string; index: number }
  | { method: "settings.read"; projectId: string | null }
  | { method: "settings.update"; projectId: string | null; scope: ConfigScope; key: string; value: unknown }
  | { method: "settings.clear"; projectId: string | null; scope: ConfigScope; key: string }
  /** Opens that config file in the user's editor (creating an empty one when there is none). */
  | { method: "settings.openFile"; projectId: string | null; scope: "global" | "project" }
  | { method: "folder.open"; projectId: string | null; folder: Folder }
  | { method: "cli.status"; projectId: string | null }
  /** A binary picked with the native file dialog becomes `<backend>.bin` in the user config. */
  | { method: "cli.pick"; backend: Backend }
  | { method: "doctor.run"; projectId: string }
  | { method: "account.usage"; projectId: string | null }
  | { method: "diagnostics.collect"; projectId: string | null }
  | { method: "diagnostics.export"; projectId: string | null }
  | { method: "link.open"; link: LinkName }
  /** Looks for a new version of the app now. */
  | { method: "update.check" }
  /** Quits (as Quit does: runs stopped, locks freed) and restarts into the downloaded version. */
  | { method: "update.install" };

export type DesktopMethod = DesktopRequest["method"];

export interface DesktopResults {
  "app.state": AppSnapshot;
  "prefs.set": Preferences;
  "project.open": ProjectSummary | null;
  "project.select": AppSnapshot;
  "project.forget": AppSnapshot;
  "project.restart": { restarted: true };
  "project.runs": RunItem[];
  "conversation.new": { conversationId: string };
  "conversation.open": { conversationId: string; draft: string };
  "conversation.select": { selected: true };
  "conversation.close": { closed: true };
  "chat.message": { accepted: boolean };
  "chat.draft": { saved: true };
  "run.inspect": FocusedRun | null;
  "artifact.read": ArtifactContent;
  "changes.list": ChangeListView;
  "changes.file": ChangeFile;
  "settings.read": ConfigurationView;
  "settings.update": ConfigurationView;
  "settings.clear": ConfigurationView;
  "settings.openFile": { opened: string };
  "folder.open": { opened: string };
  "cli.status": { clis: CliStatus[]; launcher: LauncherInfo };
  "cli.pick": { clis: CliStatus[]; launcher: LauncherInfo } | null;
  "doctor.run": { checks: Check[] };
  "account.usage": AccountUsage;
  "diagnostics.collect": Diagnostics;
  "diagnostics.export": { file: string } | null;
  "link.open": { opened: true };
  "update.check": UpdateState;
  "update.install": { restarting: true };
}

/** What main answers: a result, or an error the renderer shows (never an exception crossing IPC). */
export type Answer<T> = { ok: true; result: T } | { ok: false; error: string };

/** main → renderer. */
export type DesktopEvent =
  | { type: "app"; snapshot: AppSnapshot }
  | { type: "conversations"; projectId: string; items: ConversationItem[] }
  /** A conversation's chat, as the VS Code host feeds its webview: a snapshot, then batches of actions. */
  | { type: "host"; projectId: string; conversationId: string; view: number; message: HostMessage }
  | { type: "theme"; dark: boolean }
  /** The application menu: what the renderer does for it. */
  | { type: "menu"; command: MenuCommand }
  | { type: "update"; state: UpdateState };

export const MENU_COMMANDS = ["newConversation", "openProject", "settings", "toggleInspector", "stop", "diagnostics", "checkUpdates"] as const;
export type MenuCommand = (typeof MENU_COMMANDS)[number];

// ------------------------------------------------------------------ validation
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Projects use a hash of their canonical path; Conversations uses its reserved id above. */
export const PROJECT_ID = /^[a-f0-9]{16}$/;
const LIST_ID = /^l[0-9]{1,9}$/;

function obj(v: unknown, what: string): Obj {
  if (!isObj(v)) throw new ProtocolError(`${what} must be an object`);
  return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new ProtocolError(`${what} must be one of ${allowed.join(", ")}`);
  return v as T;
}

function projectId(v: unknown): string {
  if (typeof v !== "string" || !PROJECT_ID.test(v)) throw new ProtocolError("projectId is not a project id");
  return v;
}

const maybeProject = (v: unknown): string | null => (v === null || v === undefined ? null : projectId(v));

function conversationId(v: unknown): string {
  if (!isConversationId(v)) throw new ProtocolError("conversationId is not a conversation id");
  return v;
}

const maybeConversation = (v: unknown): string | null => (v === null || v === undefined ? null : conversationId(v));

function int(v: unknown, what: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > max) throw new ProtocolError(`${what} must be a non-negative integer`);
  return v as number;
}

const SETTING_KEY = /^[a-z_]+(\.[a-z_]+){1,2}$/;

function settingKey(v: unknown): string {
  if (typeof v !== "string" || v.length > 200 || !SETTING_KEY.test(v)) throw new ProtocolError("key is not a setting key");
  return v;
}

function settingValue(v: unknown): unknown {
  if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return v;
  if (typeof v === "string" && v.length <= 4096) return v;
  if (Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === "string" && x.length <= 4096)) return [...v];
  throw new ProtocolError("value must be a string, a number, a boolean, null or a list of strings");
}

/** The preferences a request may change, each checked; unknown keys are refused, not ignored. */
export function parsePreferences(v: unknown): Partial<Preferences> {
  const o = obj(v, "patch");
  const out: Partial<Preferences> = {};
  for (const [key, value] of Object.entries(o)) {
    switch (key) {
      case "theme":
        out.theme = oneOf(value, THEMES, "theme");
        break;
      case "fontSize":
        if (!Number.isInteger(value) || (value as number) < FONT_SIZES.min || (value as number) > FONT_SIZES.max) throw new ProtocolError(`fontSize must be ${FONT_SIZES.min} to ${FONT_SIZES.max}`);
        out.fontSize = value as number;
        break;
      case "inspector":
      case "onboarded":
      case "accountOpen":
      case "autoUpdate":
        if (typeof value !== "boolean") throw new ProtocolError(`${key} must be true or false`);
        out[key] = value;
        break;
      case "defaultRecipient":
        out.defaultRecipient = oneOf(value, BACKENDS, "defaultRecipient");
        break;
      default:
        throw new ProtocolError(`${key} is not a preference`);
    }
  }
  return out;
}

const METHODS: readonly DesktopMethod[] = [
  "app.state", "prefs.set", "project.open", "project.select", "project.forget", "project.restart", "project.runs", "conversation.new", "conversation.open",
  "conversation.select", "conversation.close", "chat.message", "chat.draft", "run.inspect", "artifact.read", "changes.list", "changes.file", "settings.read", "settings.update",
  "settings.clear", "settings.openFile", "folder.open", "cli.status", "cli.pick", "doctor.run", "account.usage", "diagnostics.collect", "diagnostics.export",
  "link.open", "update.check", "update.install",
];

/** A message the chat may send main: the VS Code webview's, without what has no meaning here. */
function chatMessage(v: unknown): WebviewMessage {
  const m = parseWebviewMessage(v);
  if (m.type === "ready" || m.type === "readyToReload") throw new ProtocolError(`${m.type} is not a chat message here`);
  return m;
}

const MAX_DRAFT = 100_000;

/** Checks a request from the renderer; anything else throws ProtocolError and is refused. */
export function parseDesktopRequest(v: unknown): DesktopRequest {
  const o = obj(v, "request");
  const method = oneOf(o.method, METHODS, "method");
  switch (method) {
    case "app.state":
    case "project.open":
    case "update.check":
    case "update.install":
      return { method };
    case "prefs.set":
      return { method, patch: parsePreferences(o.patch) };
    case "project.select":
    case "project.forget":
    case "project.restart":
    case "project.runs":
    case "conversation.new":
      return { method, projectId: projectId(o.projectId) };
    case "conversation.open":
    case "conversation.select":
    case "conversation.close":
      return { method, projectId: projectId(o.projectId), conversationId: conversationId(o.conversationId) };
    case "chat.message":
      return { method, projectId: projectId(o.projectId), conversationId: conversationId(o.conversationId), view: int(o.view, "view"), message: chatMessage(o.message) };
    case "chat.draft": {
      if (typeof o.text !== "string" || o.text.length > MAX_DRAFT) throw new ProtocolError("text must be a string");
      return { method, projectId: projectId(o.projectId), conversationId: conversationId(o.conversationId), text: o.text };
    }
    case "run.inspect":
    case "changes.list":
      return { method, projectId: projectId(o.projectId), conversationId: maybeConversation(o.conversationId) };
    case "artifact.read":
      return { method, projectId: projectId(o.projectId), conversationId: maybeConversation(o.conversationId), artifact: oneOf(o.artifact, ARTIFACTS, "artifact") };
    case "changes.file": {
      if (typeof o.listId !== "string" || !LIST_ID.test(o.listId)) throw new ProtocolError("listId is not a change list id");
      return { method, projectId: projectId(o.projectId), listId: o.listId, index: int(o.index, "index", 100_000) };
    }
    case "settings.read":
    case "cli.status":
    case "account.usage":
    case "diagnostics.collect":
    case "diagnostics.export":
      return { method, projectId: maybeProject(o.projectId) };
    case "settings.update":
      return { method, projectId: maybeProject(o.projectId), scope: oneOf(o.scope, CONFIG_SCOPES, "scope"), key: settingKey(o.key), value: settingValue(o.value) };
    case "settings.clear":
      return { method, projectId: maybeProject(o.projectId), scope: oneOf(o.scope, CONFIG_SCOPES, "scope"), key: settingKey(o.key) };
    case "settings.openFile":
      return { method, projectId: maybeProject(o.projectId), scope: oneOf(o.scope, ["global", "project"] as const, "scope") };
    case "folder.open":
      return { method, projectId: maybeProject(o.projectId), folder: oneOf(o.folder, ["runs", "userData", "logs", "project"] as const, "folder") };
    case "cli.pick":
      return { method, backend: oneOf(o.backend, BACKENDS, "backend") };
    case "doctor.run":
      return { method, projectId: projectId(o.projectId) };
    case "link.open":
      return { method, link: oneOf(o.link, Object.keys(LINKS) as LinkName[], "link") };
  }
}

/** Who may talk to main: the app's own window, from its top frame, on the app's own origin. */
export interface SenderInfo {
  /** webContents id of the sender, and of the window main created. */
  senderId: number;
  windowId: number | null;
  /** The frame that sent it is the page's top frame (no iframe, no other page). */
  mainFrame: boolean;
  url: string;
}

export const APP_ORIGIN = "agentduo://app";

export function trustedSender(s: SenderInfo): boolean {
  if (s.windowId === null || s.senderId !== s.windowId || !s.mainFrame) return false;
  try {
    const u = new URL(s.url);
    return `${u.protocol}//${u.host}` === APP_ORIGIN;
  } catch {
    return false;
  }
}

export type { ArtifactName, ConfigScope, ConfigurationView, HostMessage, WebviewMessage };
