// Messages between the extension host, the engine worker (IPC) and the webview (postMessage). Everything that
// crosses a boundary is checked here; the webview in particular can only name things, never paths, URIs or commands.
import type { ChatStatus } from "../../../src/chat.js";
import type { Check } from "../../../src/core/doctor.js";
import type { DuoEvent, HumanReview, Party, PermissionAnswer, Phase, Role } from "../../../src/events.js";
import type { ViewAction, ViewState } from "../webview/state.js";

export const PROTOCOL_VERSION = 1;

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
export type WorkerRequest =
  | { type: "initialize"; workspace: string; configPath: string | null }
  | { type: "submit"; text: string }
  | { type: "interrupt" }
  | { type: "toggleEdits" }
  | { type: "decision"; requestId: string; answer: DecisionAnswer }
  | { type: "permissionAnswer"; requestId: string; answer: PermissionAnswer }
  | { type: "inspectFocusedRun" }
  | { type: "readArtifact"; artifact: ArtifactName }
  | { type: "listChanges" }
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
  edits: string;
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
  interrupt: { accepted: true };
  toggleEdits: { accepted: true };
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
  | { type: "info"; text: string }
  | { type: "status"; status: ChatStatus }
  | { type: "edits"; mode: string }
  /** dormant: no lock held; active: a chat session holds the workspace lock; ended: /quit released it. */
  | { type: "session"; session: "dormant" | "active" | "ended" }
  | { type: "pipeline"; pipeline: PipelineStep[] };

export type WorkerMessage =
  | { kind: "hello"; protocol: number; pid: number; node: string; version: string }
  | { kind: "response"; protocol: number; generation: number; id: number; ok: true; result: unknown }
  | { kind: "response"; protocol: number; generation: number; id: number; ok: false; error: WorkerErrorData }
  | { kind: "event"; protocol: number; generation: number; event: DuoEvent }
  | { kind: "ui"; protocol: number; generation: number; update: UiUpdate }
  | { kind: "decision"; protocol: number; generation: number; requestId: string; review: HumanReview; views: ArtifactName[] }
  | { kind: "decisionClosed"; protocol: number; generation: number; requestId: string };

// ------------------------------------------------------------------ webview ↔ host
export const WEBVIEW_COMMANDS = [
  "newTask", "resume", "stop", "openPlan", "openReview", "openFeedback", "openChanges", "openReport", "doctor", "openConfiguration",
  "chooseWorkspace", "restart", "configureNode",
] as const;
export type WebviewCommand = (typeof WEBVIEW_COMMANDS)[number];

export type WebviewMessage =
  | { type: "ready" }
  | { type: "submit"; text: string }
  | { type: "interrupt" }
  | { type: "toggleEdits" }
  | { type: "decision"; generation: number; id: string; decision: DecisionChoice; note: string | null }
  | { type: "permission"; generation: number; id: string; answer: PermissionAnswer }
  | { type: "command"; name: WebviewCommand };

export type HostMessage =
  | { type: "snapshot"; state: ViewState }
  | { type: "actions"; actions: ViewAction[] }
  | { type: "focusComposer" };

// ------------------------------------------------------------------ validation
export class ProtocolError extends Error {
  override name = "ProtocolError";
}

const MAX_TEXT = 100_000;
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

export function parseRequest(v: unknown): WorkerRequest {
  const o = obj(v, "request");
  const type = oneOf(o.type, [
    "initialize", "submit", "interrupt", "toggleEdits", "decision", "permissionAnswer", "inspectFocusedRun", "readArtifact", "listChanges",
    "readSnapshotFile", "doctor", "shutdown",
  ] as const, "request.type");
  switch (type) {
    case "initialize":
      return { type, workspace: text(o.workspace, "workspace", 4096), configPath: optionalText(o.configPath, "configPath") };
    case "submit":
      return { type, text: text(o.text, "text") };
    case "decision":
      return { type, requestId: requestId(o.requestId, "requestId"), answer: decisionAnswer(o.answer) };
    case "permissionAnswer":
      return { type, requestId: requestId(o.requestId, "requestId"), answer: permissionAnswer(o.answer) };
    case "readArtifact":
      return { type, artifact: oneOf(o.artifact, ARTIFACTS, "artifact") };
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
      text(obj(o.event, "event").type, "event.type", 64);
      break;
    case "ui":
      text(obj(o.update, "update").type, "update.type", 64);
      break;
    case "decision":
      requestId(o.requestId, "requestId");
      obj(o.review, "review");
      if (!Array.isArray(o.views)) throw new ProtocolError("views must be a list");
      break;
    case "decisionClosed":
      requestId(o.requestId, "requestId");
      break;
  }
  return o as unknown as WorkerMessage;
}

export function parseWebviewMessage(v: unknown): WebviewMessage {
  const o = obj(v, "webview message");
  const type = oneOf(o.type, ["ready", "submit", "interrupt", "toggleEdits", "decision", "permission", "command"] as const, "type");
  switch (type) {
    case "submit":
      return { type, text: text(o.text, "text") };
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
