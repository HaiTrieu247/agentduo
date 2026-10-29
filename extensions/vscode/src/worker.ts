// The engine process of the VS Code extension: runs agentduo's Chat and Workflow under a real Node (>= 22.12),
// forked by the extension host with an IPC channel. stdout/stderr only ever reach the extension's output channel.
import { killAllActive } from "../../../src/agents/process.js";
import { packageVersion } from "../../../src/paths.js";
import {
  parseRequestEnvelope, PROTOCOL_VERSION, ProtocolError, type RequestEnvelope, type WorkerErrorData, type WorkerMessage, type WorkerRequest,
  type WorkerResults,
} from "./protocol.js";
import { RuntimeSession, SessionError } from "./runtimeSession.js";

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  process.stderr.write(`agentduo needs Node >= 22.12; this is ${process.versions.node}\n`);
  process.exit(3);
}
if (!process.send) {
  process.stderr.write("the agentduo worker is started by the VS Code extension, with an IPC channel\n");
  process.exit(2);
}

let generation = -1;
let session: RuntimeSession | null = null;
let exiting = false;

function send(message: WorkerMessage): Promise<void> {
  return new Promise((resolve) => {
    if (!process.connected) return resolve();
    process.send!(message, undefined, undefined, () => resolve());
  });
}

const tag = () => ({ protocol: PROTOCOL_VERSION, generation });

function errorData(e: unknown): WorkerErrorData {
  if (e instanceof SessionError) return { code: e.code, message: e.message };
  if (e instanceof ProtocolError) return { code: "bad_request", message: e.message };
  return { code: "internal", message: e instanceof Error ? e.message : String(e) };
}

async function dispatch(s: RuntimeSession, request: WorkerRequest): Promise<WorkerResults[keyof WorkerResults]> {
  switch (request.type) {
    case "initialize":
      throw new SessionError("bad_request", "already initialized");
    case "submit":
      await s.submit(request.conversation, request.text, request.route, request.attachments);
      return { accepted: true };
    case "stageAttachment":
      return s.stageAttachment(request.conversation, request.key, request.path, request.name);
    case "removeAttachment":
      await s.removeAttachment(request.conversation, request.id);
      return { removed: true };
    case "recipient":
      await s.selectRecipient(request.conversation, request.backend);
      return { accepted: true };
    case "setting":
      await s.applySetting(request.conversation, { setting: request.setting, save: request.save, yes: request.yes });
      return { accepted: true };
    case "interrupt":
      await s.interrupt(request.conversation);
      return { accepted: true };
    case "toggleEdits":
      await s.toggleEdits(request.conversation);
      return { accepted: true };
    case "usage":
      await s.usage(request.conversation);
      return { accepted: true };
    case "closeConversation":
      await s.closeConversation(request.conversation);
      return { closed: true };
    case "decision":
      s.answerDecision(request.requestId, request.answer);
      return { applied: true };
    case "permissionAnswer":
      s.answerPermission(request.requestId, request.answer);
      return { applied: true };
    case "inspectFocusedRun":
      return s.inspectFocusedRun(request.conversation);
    case "readArtifact":
      return s.readArtifact(request.artifact, request.conversation);
    case "listChanges":
      return s.listChanges(request.conversation);
    case "readSnapshotFile":
      return s.readSnapshotFile(request.runId, { base: request.base, snapshot: request.snapshot }, request.side, request.path);
    case "doctor":
      return { checks: await s.doctor() };
    case "shutdown":
      await s.shutdown();
      return { stopped: true };
  }
}

async function handle(raw: unknown): Promise<void> {
  let envelope: RequestEnvelope;
  try {
    envelope = parseRequestEnvelope(raw);
  } catch (e) {
    const id = typeof (raw as { id?: unknown })?.id === "number" ? (raw as { id: number }).id : -1;
    await send({ kind: "response", ...tag(), id, ok: false, error: errorData(e) });
    return;
  }
  const { id, request } = envelope;
  const reply = (result: unknown) => send({ kind: "response", ...tag(), id, ok: true, result });
  const fail = (e: unknown) => send({ kind: "response", ...tag(), id, ok: false, error: errorData(e) });
  if (envelope.protocol !== PROTOCOL_VERSION) return void fail(new SessionError("protocol", `protocol ${envelope.protocol} is not ${PROTOCOL_VERSION}`));
  if (request.type === "initialize") {
    if (session) return void fail(new SessionError("bad_request", "already initialized"));
    generation = envelope.generation;
    session = new RuntimeSession({
      workspace: request.workspace, configPath: request.configPath, env: process.env,
      sink: {
        event: (conversation, event) => void send({ kind: "event", ...tag(), conversation, event }),
        ui: (update, conversation) => void send({ kind: "ui", ...tag(), conversation, update }),
        decisionOpened: (conversation, requestId, review, views) => void send({ kind: "decision", ...tag(), conversation, requestId, review, views }),
        decisionClosed: (conversation, requestId) => void send({ kind: "decisionClosed", ...tag(), conversation, requestId }),
      },
    });
    try {
      await reply(await session.initialize());
      // Only once the answer is on its way: a model found later then arrives as an update after it, never before.
      session.startDiscovery();
    } catch (e) {
      await fail(e);
    }
    return;
  }
  if (!session) return void fail(new SessionError("not_initialized", "the worker is not initialized"));
  // A request meant for an earlier worker (a stale view) must not act on this one.
  if (envelope.generation !== generation) return void fail(new SessionError("stale", "this request belongs to an earlier session"));
  try {
    await reply(await dispatch(session, request));
  } catch (e) {
    await fail(e);
  }
  if (request.type === "shutdown") await exit(0);
}

/** Shutdown, a lost IPC channel or a signal: settle what waits on the user, stop the run, free the lock, then leave. */
async function exit(code: number): Promise<void> {
  if (exiting) return;
  exiting = true;
  try {
    await session?.shutdown();
  } catch (e) {
    process.stderr.write(`agentduo worker: shutdown failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  }
  killAllActive();
  // A moment for the last messages to reach the host.
  setTimeout(() => process.exit(code), 100);
}

process.on("message", (raw) => void handle(raw));
process.on("disconnect", () => void exit(0));
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => void exit(0));
// Agents run in their own process groups, so they do not die with us unless we kill them.
process.once("exit", () => killAllActive());
process.on("uncaughtException", (e) => {
  process.stderr.write(`agentduo worker crashed: ${e.stack ?? e.message}\n`);
  void exit(1);
});

void send({ kind: "hello", protocol: PROTOCOL_VERSION, pid: process.pid, node: process.versions.node, version: packageVersion() });
