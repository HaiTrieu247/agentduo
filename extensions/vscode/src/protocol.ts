// Messages between the extension host, the engine worker (IPC) and the webview (postMessage). Everything that
// crosses a boundary is checked here; the webview in particular can only name things, never paths, URIs or commands.
import type { ChatStatus } from "../../../src/chat.js";
import { ATTACHMENT_LIMITS, base64Size, isAttachmentId, type Attachment } from "../../../src/core/attachment-types.js";
import {
  CLAUDE_EFFORTS, CODEX_EFFORTS, CODEX_PRESETS, PERMISSION_MODES, RULE_KINDS, type Backend, type SettingCommand,
} from "../../../src/core/commands.js";
import type { Check } from "../../../src/core/doctor.js";
import type { CodexCatalog } from "../../../src/core/models.js";
import type { SettingsView } from "../../../src/core/settings.js";
import type { UsageReport } from "../../../src/core/usage.js";
import type { DuoEvent, HumanReview, ModelMap, Party, PermissionAnswer, Phase, Role } from "../../../src/events.js";
import type { ViewAction, ViewState } from "../webview/state.js";

/**
 * 2: the chat is a conversation (direct answers, recipient, models, settings and the Pipeline route).
 * 3: Codex's model catalog for the settings' model picker (`catalog` updates).
 * 4: several conversations (the extension's tabs) in one worker: each request, event and question names its own.
 * 5: /usage: `usage` updates for a tab's usage panel, and the `usage` request that looks it up again.
 * 6: attachments: the host stages a file by path (one the user picked, or one it wrote from a paste or a drop) and the
 *    worker copies it into the conversation; a submit names the files it sends by id. No bytes ever cross IPC.
 * 7: Claude Code's permission modes (manual, acceptEdits, auto) in place of edits ask|auto: `cycleMode`, `mode` updates.
 */
export const PROTOCOL_VERSION = 7;

export const BACKENDS = ["codex", "claude"] as const;
/** How the composer's text is meant: a message (to the recipient, or a slash command), a pipeline task, or a question to discuss. */
export const ROUTES = ["message", "pipeline", "discuss"] as const;
export type Route = (typeof ROUTES)[number];

/** A setting changed from the sidebar's controls; the worker applies it as the chat's own command would. */
export interface SettingRequest {
  setting: SettingCommand;
  /** Writes it to the workspace's config file, as --save does. */
  save: boolean;
  /** Writes it to the user config file, for every workspace, as --global does. */
  global: boolean;
  /** Confirms full access for Codex, as --yes does. */
  yes: boolean;
}

/** The run artifacts the extension can show; each maps to fixed files of the run directory, in the worker. */
export const ARTIFACTS = ["plan", "review", "feedback", "report"] as const;
export type ArtifactName = (typeof ARTIFACTS)[number];

export const DECISIONS = ["resume", "revise", "abort", "defer"] as const;
export type DecisionChoice = (typeof DECISIONS)[number];
export interface DecisionAnswer {
  decision: DecisionChoice;
  note: string | null;
}

export type SnapshotSide = "base" | "snapshot";

/** One phase of the flow as the config sets it up: who plays it. */
export interface PipelineStep {
  phase: Phase;
  label: string;
  role: Role | null;
  agent: Party | null;
}

export interface Problem {
  kind: "environment" | "config" | "not_repo" | "missing_cli" | "locked" | "node" | "worker";
  message: string;
}

// ------------------------------------------------------------------ host → worker
/**
 * Requests for a conversation name it: an id the host chose for a tab, which also names the conversation's directory.
 * A run's artifacts and changes are asked for a conversation's run, or with null for the workspace's latest.
 */
export type WorkerRequest =
  | { type: "initialize"; workspace: string; configPath: string | null }
  /** `attachments`: the ids of the waiting files the message sends (the tab's ready ones); absent: none. */
  | { type: "submit"; conversation: string; text: string; route: Route; attachments?: string[] }
  /**
   * A file for the conversation's next message: `path` is one the host chose (the user picked it, or the host wrote
   * it from what the tab pasted or dropped), `name` what to call it; `key` is the tab's, and comes back with the result.
   */
  | { type: "stageAttachment"; conversation: string; key: string; path: string; name: string }
  /** A waiting file removed (its ✕), or all of them. */
  | { type: "removeAttachment"; conversation: string; id: string }
  | { type: "recipient"; conversation: string; backend: Backend }
  | ({ type: "setting"; conversation: string } & SettingRequest)
  | { type: "interrupt"; conversation: string }
  /** Shift+Tab or the mode menu's ⇧+Tab: Claude's next permission mode, as in Claude Code. */
  | { type: "cycleMode"; conversation: string }
  /** The usage panel's Refresh, and the title bar's Usage: the tab's chat looks the usage up again, as /usage does. */
  | { type: "usage"; conversation: string }
  /** The tab was closed: what runs in it stops (a run stays resumable), and the worker lets the conversation go. */
  | { type: "closeConversation"; conversation: string }
  | { type: "decision"; requestId: string; answer: DecisionAnswer }
  | { type: "permissionAnswer"; requestId: string; answer: PermissionAnswer }
  | { type: "inspectFocusedRun"; conversation: string | null }
  | { type: "readArtifact"; artifact: ArtifactName; conversation: string | null }
  | { type: "listChanges"; conversation: string | null }
  | { type: "readSnapshotFile"; runId: string; base: string; snapshot: string; side: SnapshotSide; path: string }
  | { type: "doctor" }
  | { type: "shutdown" };
export type RequestType = WorkerRequest["type"];

export interface RequestEnvelope {
  protocol: number;
  generation: number;
  id: number;
  request: WorkerRequest;
}

export interface InitializeResult {
  version: string;
  node: string;
  workspace: string;
  runsDir: string | null;
  configFile: string | null;
  configSources: string[];
  pipeline: PipelineStep[];
  /** Claude's permission mode: manual, acceptEdits, auto, or another one Claude Code has. */
  mode: string;
  /** Who a plain message goes to. */
  recipient: Backend;
  /** As far as known now; codex doctor's answer follows as a `models` update, never holding up initialize. */
  models: ModelMap;
  settings: SettingsView | null;
  warnings: string[];
  /** Why a task could not start now (it is checked again when one does). */
  problem: Problem | null;
  /** A run an earlier session left stopped or waiting, as the CLI's chat says it. */
  hint: string | null;
}

export interface FocusedRun {
  runId: string;
  task: string;
  phase: Phase;
  artifacts: ArtifactName[];
  hasSnapshots: boolean;
}

export interface ArtifactContent {
  runId: string;
  artifact: ArtifactName;
  text: string;
}

export interface Change {
  status: string;
  path: string;
}

export interface ChangeList {
  runId: string;
  /** False until the implementer has run once: there is nothing to compare yet. */
  hasSnapshots: boolean;
  /**
   * The snapshot commits compared (null without snapshots). A diff names both, so it keeps showing exactly what was
   * listed after the run takes a newer snapshot, and a newer list never reuses an older diff's documents.
   */
  base: string | null;
  snapshot: string | null;
  changes: Change[];
}

export interface SnapshotFile {
  /** The file does not exist on this side (added or deleted by the run). */
  missing: boolean;
  binary: boolean;
  tooLarge: boolean;
  text: string | null;
}

export interface WorkerResults {
  initialize: InitializeResult;
  submit: { accepted: true };
  /** `root`: where the conversation keeps its copies, so the host can let the tab show images from there (once it checked it). */
  stageAttachment: { key: string; conversation: string; attachment: Attachment; root: string };
  removeAttachment: { removed: true };
  recipient: { accepted: true };
  setting: { accepted: true };
  interrupt: { accepted: true };
  cycleMode: { accepted: true };
  usage: { accepted: true };
  closeConversation: { closed: true };
  decision: { applied: true };
  permissionAnswer: { applied: true };
  inspectFocusedRun: FocusedRun | null;
  readArtifact: ArtifactContent;
  listChanges: ChangeList;
  readSnapshotFile: SnapshotFile;
  doctor: { checks: Check[] };
  shutdown: { stopped: true };
}

// ------------------------------------------------------------------ worker → host
export type WorkerErrorCode =
  | "bad_request" | "protocol" | "not_initialized" | "stale" | "shutting_down" | "not_found" | "no_run" | "internal" | Problem["kind"];

export interface WorkerErrorData {
  code: WorkerErrorCode;
  message: string;
}

export type UiUpdate =
  | { type: "info"; text: string; tone?: "info" | "error" }
  | { type: "status"; status: ChatStatus }
  | { type: "mode"; mode: string }
  | { type: "recipient"; backend: Backend }
  | { type: "models"; models: ModelMap }
  | { type: "settings"; settings: SettingsView }
  /** The models Codex offers, once `codex debug models` answered (Claude Code's aliases are known without asking). */
  | { type: "catalog"; codex: CodexCatalog }
  /** /usage in a tab: a report with a new id opens its usage panel; the same id again fills it in. */
  | { type: "usage"; report: UsageReport }
  /** The files waiting to go with the conversation's next message, whenever they change. */
  | { type: "attachments"; files: Attachment[] }
  /** The files that went with the message just accepted. */
  | { type: "sent"; files: Attachment[] }
  /** dormant: no lock held; active: a chat session holds the workspace lock; ended: /quit released it. */
  | { type: "session"; session: "dormant" | "active" | "ended" }
  | { type: "pipeline"; pipeline: PipelineStep[] };

export type WorkerMessage =
  | { kind: "hello"; protocol: number; pid: number; node: string; version: string }
  | { kind: "response"; protocol: number; generation: number; id: number; ok: true; result: unknown }
  | { kind: "response"; protocol: number; generation: number; id: number; ok: false; error: WorkerErrorData }
  | { kind: "event"; protocol: number; generation: number; conversation: string; event: DuoEvent }
  /** `conversation` null: an update for the whole workspace (models, settings, the session), for every tab. */
  | { kind: "ui"; protocol: number; generation: number; conversation: string | null; update: UiUpdate }
  | { kind: "decision"; protocol: number; generation: number; conversation: string; requestId: string; review: HumanReview; views: ArtifactName[] }
  | { kind: "decisionClosed"; protocol: number; generation: number; conversation: string; requestId: string };

// ------------------------------------------------------------------ webview ↔ host
export const WEBVIEW_COMMANDS = [
  "newTask", "resume", "stop", "openPlan", "openReview", "openFeedback", "openChanges", "openReport", "doctor", "openConfiguration",
  "chooseWorkspace", "restart", "configureNode",
] as const;
export type WebviewCommand = (typeof WEBVIEW_COMMANDS)[number];

export type WebviewMessage =
  | { type: "ready" }
  | { type: "submit"; text: string; route: Route; attachments: string[] }
  /** Attach: the host asks the user for files (its own dialog). */
  | { type: "attach" }
  /** A file pasted or dropped on the composer, as base64 (one per message); `key` names it until it is stored. */
  | { type: "upload"; key: string; name: string; data: string }
  /** A file of the composer removed: one waiting (by its key), or one that failed. */
  | { type: "detach"; key: string }
  | { type: "recipient"; backend: Backend }
  | ({ type: "setting" } & SettingRequest)
  | { type: "interrupt" }
  | { type: "cycleMode" }
  /** The usage panel's Refresh. */
  | { type: "usage" }
  | { type: "decision"; generation: number; id: string; decision: DecisionChoice; note: string | null }
  | { type: "permission"; generation: number; id: string; answer: PermissionAnswer }
  | { type: "command"; name: WebviewCommand }
  /** The answer to `prepareReload`: the files the page read are all with the host, so a reload loses none. */
  | { type: "readyToReload" };

export type HostMessage =
  /** `conversation`: the tab's own, which the webview keeps, so the tab is restored with it after a reload. */
  | { type: "snapshot"; state: ViewState; conversation?: string }
  | { type: "actions"; actions: ViewAction[] }
  | { type: "focusComposer" }
  /** The title bar's Settings: open the settings panel above the composer. */
  | { type: "showSettings" }
  /**
   * Where the tab may show attached images from: a webview URI per attachment id, null for a copy that is gone. Sent
   * after each snapshot and as attachments appear; never saved with the view (a restored tab is granted them again).
   */
  | { type: "attachmentUris"; uris: Record<string, string | null> }
  /**
   * The host is to reload the page (new resource roots): it answers `readyToReload` once no pasted or dropped file is
   * left only in the page, and takes no more files until it is reloaded.
   */
  | { type: "prepareReload" };

// ------------------------------------------------------------------ validation
export class ProtocolError extends Error {
  override name = "ProtocolError";
}

const MAX_TEXT = 100_000;
/** A file of the largest size a message takes, once base64-encoded. */
export const MAX_UPLOAD_CHARS = base64Size(ATTACHMENT_LIMITS.fileBytes);
const MAX_NAME = 255;
const MAX_PATH = 4096;
/** The tab's own name for a file until the worker gives it an id. */
const KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_ID = 200;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function obj(v: unknown, what: string): Obj {
  if (!isObj(v)) throw new ProtocolError(`${what} must be an object`);
  return v;
}

function text(v: unknown, what: string, max = MAX_TEXT): string {
  if (typeof v !== "string") throw new ProtocolError(`${what} must be a string`);
  if (v.length > max) throw new ProtocolError(`${what} is too long`);
  return v;
}

function optionalText(v: unknown, what: string): string | null {
  return v === undefined || v === null ? null : text(v, what);
}

function int(v: unknown, what: string): number {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw new ProtocolError(`${what} must be a non-negative integer`);
  return v as number;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new ProtocolError(`${what} must be one of ${allowed.join(", ")}`);
  return v as T;
}

/** An id chosen by the worker or by the agent CLI: printable, short. */
function requestId(v: unknown, what: string): string {
  const id = text(v, what, MAX_ID);
  if (!id || /[\u0000-\u001f\u007f]/.test(id)) throw new ProtocolError(`${what} is not a valid id`);
  return id;
}

export function isRunId(v: unknown): v is string {
  return typeof v === "string" && RUN_ID.test(v);
}

/** A conversation's id: chosen by the host, and the name of its directory, so it is as safe as a run id. */
export function isConversationId(v: unknown): v is string {
  return isRunId(v);
}

function conversationId(v: unknown): string {
  if (!isConversationId(v)) throw new ProtocolError("conversation is not a conversation id");
  return v;
}

const focusedOn = (v: unknown): string | null => (v === undefined || v === null ? null : conversationId(v));

/** A full git object id (SHA-1 or SHA-256), as snapshot commits are recorded. */
export function isObjectId(v: unknown): v is string {
  return typeof v === "string" && OBJECT_ID.test(v);
}

/** A path relative to the workspace, as `git diff --relative` prints it; never absolute, never leaving the workspace. */
export function isWorkspacePath(v: unknown): v is string {
  if (typeof v !== "string" || !v || v.length > 4096 || v.includes("\0")) return false;
  if (v.startsWith("/") || v.startsWith("\\") || /^[A-Za-z]:/.test(v)) return false;
  return !v.split(/[\\/]/).some((part) => part === ".." || part === "");
}

function attachmentIds(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > ATTACHMENT_LIMITS.files) throw new ProtocolError(`attachments must be a list of at most ${ATTACHMENT_LIMITS.files} ids`);
  return v.map((id) => {
    if (!isAttachmentId(id)) throw new ProtocolError("attachments must be attachment ids");
    return id;
  });
}

function uploadKey(v: unknown): string {
  if (typeof v !== "string" || !KEY.test(v)) throw new ProtocolError("key is not a valid key");
  return v;
}

function fileName(v: unknown): string {
  const name = text(v, "name", MAX_NAME).trim();
  if (!name || /[\u0000-\u001f\u007f]/.test(name)) throw new ProtocolError("name must be a non-empty line");
  return name;
}

/** Base64, at most the size of the largest file a message takes; checked again once decoded. */
function base64(v: unknown): string {
  if (typeof v !== "string") throw new ProtocolError("data must be a string");
  if (v.length > MAX_UPLOAD_CHARS) throw new ProtocolError("the file is too large");
  if (v.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(v)) throw new ProtocolError("data is not base64");
  return v;
}

/** An absolute path the host chose; never one from the webview. */
function hostPath(v: unknown): string {
  const path = text(v, "path", MAX_PATH);
  if (!path || path.includes("\0") || !(path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\"))) throw new ProtocolError("path must be absolute");
  return path;
}

function permissionAnswer(v: unknown): PermissionAnswer {
  const o = obj(v, "answer");
  const decision = oneOf(o.decision, ["once", "always", "deny"] as const, "answer.decision");
  if (decision !== "deny") return { decision };
  const message = optionalText(o.message, "answer.message")?.trim();
  return message ? { decision, message } : { decision };
}

function decisionAnswer(v: unknown): DecisionAnswer {
  const o = obj(v, "answer");
  return { decision: oneOf(o.decision, DECISIONS, "answer.decision"), note: optionalText(o.note, "answer.note")?.trim() || null };
}

const MAX_SETTING = 4096;

/** A setting value: a non-empty single line (a model name, a rule, a path). */
function settingText(v: unknown, what: string): string {
  const s = text(v, what, MAX_SETTING).trim();
  if (!s || /[\u0000-\u001f\u007f]/.test(s)) throw new ProtocolError(`${what} must be a non-empty line`);
  return s;
}

/** A field that is absent (show the setting), null (default) or a value. */
function present(o: Obj, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key) && o[key] !== undefined;
}

export function parseSetting(v: unknown): SettingCommand {
  const o = obj(v, "setting");
  const target = oneOf(o.target, ["mode", "claude.model", "claude.effort", "claude.permissions", "claude.add-dir", "codex.model", "codex.permissions"] as const, "setting.target");
  const nullable = <T>(key: string, read: (x: unknown) => T): T | null | undefined => (!present(o, key) ? undefined : o[key] === null ? null : read(o[key]));
  switch (target) {
    case "mode":
      return present(o, "mode") ? { target, mode: oneOf(o.mode, PERMISSION_MODES, "setting.mode") } : { target };
    case "claude.model": {
      const model = nullable("model", (x) => settingText(x, "setting.model"));
      return model === undefined ? { target } : { target, model };
    }
    case "claude.effort": {
      const effort = nullable("effort", (x) => oneOf(x, CLAUDE_EFFORTS, "setting.effort"));
      return effort === undefined ? { target } : { target, effort };
    }
    case "claude.permissions": {
      if (!present(o, "rule")) return { target };
      const r = obj(o.rule, "setting.rule");
      return { target, rule: { kind: oneOf(r.kind, RULE_KINDS, "setting.rule.kind"), rule: settingText(r.rule, "setting.rule.rule") } };
    }
    case "claude.add-dir":
      return present(o, "dir") ? { target, dir: settingText(o.dir, "setting.dir") } : { target };
    case "codex.model": {
      const model = nullable("model", (x) => settingText(x, "setting.model"));
      if (model === undefined) return { target };
      return { target, model, effort: nullable("effort", (x) => oneOf(x, CODEX_EFFORTS, "setting.effort")) ?? null };
    }
    case "codex.permissions":
      return present(o, "preset") ? { target, preset: oneOf(o.preset, CODEX_PRESETS, "setting.preset") } : { target };
  }
}

function settingRequest(o: Obj): SettingRequest {
  return { setting: parseSetting(o.setting), save: o.save === true, global: o.global === true, yes: o.yes === true };
}

const route = (v: unknown): Route => (v === undefined ? "message" : oneOf(v, ROUTES, "route"));

export function parseRequest(v: unknown): WorkerRequest {
  const o = obj(v, "request");
  const type = oneOf(o.type, [
    "initialize", "submit", "stageAttachment", "removeAttachment", "recipient", "setting", "interrupt", "cycleMode", "usage", "closeConversation", "decision",
    "permissionAnswer", "inspectFocusedRun", "readArtifact", "listChanges", "readSnapshotFile", "doctor", "shutdown",
  ] as const, "request.type");
  switch (type) {
    case "initialize":
      return { type, workspace: text(o.workspace, "workspace", 4096), configPath: optionalText(o.configPath, "configPath") };
    case "submit":
      return { type, conversation: conversationId(o.conversation), text: text(o.text, "text"), route: route(o.route), attachments: attachmentIds(o.attachments) };
    case "stageAttachment":
      return { type, conversation: conversationId(o.conversation), key: uploadKey(o.key), path: hostPath(o.path), name: fileName(o.name) };
    case "removeAttachment": {
      if (o.id !== "all" && !isAttachmentId(o.id)) throw new ProtocolError("id must be an attachment id or all");
      return { type, conversation: conversationId(o.conversation), id: o.id as string };
    }
    case "recipient":
      return { type, conversation: conversationId(o.conversation), backend: oneOf(o.backend, BACKENDS, "backend") };
    case "setting":
      return { type, conversation: conversationId(o.conversation), ...settingRequest(o) };
    case "interrupt":
    case "cycleMode":
    case "usage":
    case "closeConversation":
      return { type, conversation: conversationId(o.conversation) };
    case "inspectFocusedRun":
    case "listChanges":
      return { type, conversation: focusedOn(o.conversation) };
    case "decision":
      return { type, requestId: requestId(o.requestId, "requestId"), answer: decisionAnswer(o.answer) };
    case "permissionAnswer":
      return { type, requestId: requestId(o.requestId, "requestId"), answer: permissionAnswer(o.answer) };
    case "readArtifact":
      return { type, artifact: oneOf(o.artifact, ARTIFACTS, "artifact"), conversation: focusedOn(o.conversation) };
    case "readSnapshotFile": {
      if (!isRunId(o.runId)) throw new ProtocolError("runId is not a run id");
      if (!isObjectId(o.base) || !isObjectId(o.snapshot)) throw new ProtocolError("base and snapshot must be commit ids");
      if (!isWorkspacePath(o.path)) throw new ProtocolError("path must be relative to the workspace");
      return { type, runId: o.runId, base: o.base, snapshot: o.snapshot, side: oneOf(o.side, ["base", "snapshot"] as const, "side"), path: o.path };
    }
    default:
      return { type };
  }
}

export function parseRequestEnvelope(v: unknown): RequestEnvelope {
  const o = obj(v, "message");
  return { protocol: int(o.protocol, "protocol"), generation: int(o.generation, "generation"), id: int(o.id, "id"), request: parseRequest(o.request) };
}

/** The worker is our own code; this only guards against a mismatched or broken worker build. */
export function parseWorkerMessage(v: unknown): WorkerMessage {
  const o = obj(v, "worker message");
  const kind = oneOf(o.kind, ["hello", "response", "event", "ui", "decision", "decisionClosed"] as const, "kind");
  if (int(o.protocol, "protocol") !== PROTOCOL_VERSION) throw new ProtocolError(`worker speaks protocol ${String(o.protocol)}, expected ${PROTOCOL_VERSION}`);
  if (kind !== "hello") int(o.generation, "generation");
  switch (kind) {
    case "response":
      int(o.id, "id");
      if (o.ok !== true) obj(o.error, "error");
      break;
    case "event":
      conversationId(o.conversation);
      text(obj(o.event, "event").type, "event.type", 64);
      break;
    case "ui":
      focusedOn(o.conversation);
      text(obj(o.update, "update").type, "update.type", 64);
      break;
    case "decision":
      conversationId(o.conversation);
      requestId(o.requestId, "requestId");
      obj(o.review, "review");
      if (!Array.isArray(o.views)) throw new ProtocolError("views must be a list");
      break;
    case "decisionClosed":
      conversationId(o.conversation);
      requestId(o.requestId, "requestId");
      break;
  }
  return o as unknown as WorkerMessage;
}

export function parseWebviewMessage(v: unknown): WebviewMessage {
  const o = obj(v, "webview message");
  const type = oneOf(o.type, [
    "ready", "submit", "attach", "upload", "detach", "recipient", "setting", "interrupt", "cycleMode", "usage", "decision", "permission", "command",
    "readyToReload",
  ] as const, "type");
  switch (type) {
    case "submit":
      return { type, text: text(o.text, "text"), route: route(o.route), attachments: attachmentIds(o.attachments) };
    case "upload":
      return { type, key: uploadKey(o.key), name: fileName(o.name), data: base64(o.data) };
    case "detach":
      return { type, key: uploadKey(o.key) };
    case "recipient":
      return { type, backend: oneOf(o.backend, BACKENDS, "backend") };
    case "setting":
      return { type, ...settingRequest(o) };
    case "decision":
      return {
        type, generation: int(o.generation, "generation"), id: requestId(o.id, "id"), decision: oneOf(o.decision, DECISIONS, "decision"),
        note: optionalText(o.note, "note")?.trim() || null,
      };
    case "permission":
      return { type, generation: int(o.generation, "generation"), id: requestId(o.id, "id"), answer: permissionAnswer(o.answer) };
    case "command":
      return { type, name: oneOf(o.name, WEBVIEW_COMMANDS, "name") };
    default:
      return { type };
  }
}
