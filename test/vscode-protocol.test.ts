import { describe, expect, it } from "vitest";
import { DecisionBroker, PermissionBroker } from "../extensions/vscode/src/decisionBroker.js";
import {
  isWorkspacePath, MAX_UPLOAD_CHARS, parseAccountViewMessage, parseRequestEnvelope, parseWebviewMessage, parseWorkerMessage, PROTOCOL_VERSION, ProtocolError,
} from "../extensions/vscode/src/protocol.js";
import type { HumanReview, PermissionRequest } from "../src/events.js";

const envelope = (request: unknown) => ({ protocol: PROTOCOL_VERSION, generation: 3, id: 7, request });
const COMMITS = { base: "a".repeat(40), snapshot: "b".repeat(64) };

describe("worker requests", () => {
  it("accepts every request type with its fields, and normalises answers", () => {
    expect(parseRequestEnvelope(envelope({ type: "submit", conversation: "c-1", text: "Fix it" })))
      .toEqual({ protocol: PROTOCOL_VERSION, generation: 3, id: 7, request: { type: "submit", conversation: "c-1", text: "Fix it", route: "message", attachments: [] } });
    expect(parseRequestEnvelope(envelope({ type: "decision", requestId: "decision-1-ab", answer: { decision: "revise", note: "  smaller  " } })).request)
      .toEqual({ type: "decision", requestId: "decision-1-ab", answer: { decision: "revise", note: "smaller" } });
    expect(parseRequestEnvelope(envelope({ type: "permissionAnswer", requestId: "perm-0", answer: { decision: "deny", message: " " } })).request)
      .toEqual({ type: "permissionAnswer", requestId: "perm-0", answer: { decision: "deny" } });
    expect(parseRequestEnvelope(envelope({ type: "permissionAnswer", requestId: "perm-0", answer: { decision: "once", message: "ignored" } })).request)
      .toEqual({ type: "permissionAnswer", requestId: "perm-0", answer: { decision: "once" } });
    expect(parseRequestEnvelope(envelope({ type: "readSnapshotFile", runId: "20261028-1-x", ...COMMITS, side: "snapshot", path: "gói pkg/tệp.txt" })).request)
      .toEqual({ type: "readSnapshotFile", runId: "20261028-1-x", ...COMMITS, side: "snapshot", path: "gói pkg/tệp.txt" });
    for (const type of ["interrupt", "cycleMode", "closeConversation", "usage"]) {
      expect(parseRequestEnvelope(envelope({ type, conversation: "c-1", extra: "ignored" })).request).toEqual({ type, conversation: "c-1" });
    }
    // What a run's artifacts and changes are asked for: the run of a conversation, or the workspace's latest.
    for (const type of ["inspectFocusedRun", "listChanges"]) {
      expect(parseRequestEnvelope(envelope({ type, conversation: "c-1" })).request).toEqual({ type, conversation: "c-1" });
      expect(parseRequestEnvelope(envelope({ type })).request).toEqual({ type, conversation: null });
    }
    expect(parseRequestEnvelope(envelope({ type: "readArtifact", artifact: "plan", conversation: null })).request).toEqual({ type: "readArtifact", artifact: "plan", conversation: null });
    for (const type of ["accountUsage", "doctor", "shutdown"]) expect(parseRequestEnvelope(envelope({ type, extra: "ignored" })).request).toEqual({ type });
    // The models are looked up unless the host says not to (the worker that only answers the Account & Usage view).
    const init = (o: object) => parseRequestEnvelope(envelope({ type: "initialize", workspace: "/home/me", configPath: null, ...o })).request;
    expect([init({}), init({ discover: true }), init({ discover: false })].map((r) => r.type === "initialize" && r.discover)).toEqual([true, true, false]);
  });

  it("is protocol 8 (the Account & Usage view's accountUsage); takes only the permission modes the chat offers", () => {
    expect(PROTOCOL_VERSION).toBe(8);
    const setting = (s: unknown) => parseRequestEnvelope(envelope({ type: "setting", conversation: "c-1", setting: s })).request;
    for (const mode of ["manual", "acceptEdits", "auto"]) expect(setting({ target: "mode", mode })).toMatchObject({ setting: { target: "mode", mode } });
    expect(setting({ target: "mode" })).toMatchObject({ setting: { target: "mode" } });
    for (const s of [{ target: "mode", mode: "plan" }, { target: "mode", mode: "bypassPermissions" }, { target: "edits", mode: "auto" }]) {
      expect(() => setting(s), JSON.stringify(s)).toThrow(ProtocolError);
    }
  });

  it("says where a setting is saved, as --save and --global do: nowhere when the request does not say", () => {
    const request = (o: object) => parseRequestEnvelope(envelope({ type: "setting", conversation: "c-1", setting: { target: "claude.model", model: "opus" }, ...o })).request;
    expect(request({})).toMatchObject({ save: false, global: false, yes: false });
    expect(request({ save: true, global: true })).toMatchObject({ save: true, global: true, yes: false });
  });

  it("names the conversation each of its requests is for, with an id that is safe as a directory name", () => {
    for (const conversation of [undefined, "", "../x", "a/b", ".hidden", "x".repeat(201)]) {
      expect(() => parseRequestEnvelope(envelope({ type: "submit", conversation, text: "hi" })), String(conversation)).toThrow(ProtocolError);
    }
    expect(() => parseRequestEnvelope(envelope({ type: "listChanges", conversation: "../x" }))).toThrow(ProtocolError);
  });

  it("refuses unknown requests, paths outside the workspace and malformed fields", () => {
    const bad = [
      envelope({ type: "exec", command: "rm -rf /" }),
      envelope({ type: "submit", conversation: "c", text: 5 }),
      envelope({ type: "submit", conversation: "c", text: "x".repeat(100_001) }),
      envelope({ type: "readArtifact", artifact: "state.json" }),
      envelope({ type: "readSnapshotFile", runId: "r", ...COMMITS, side: "base", path: "../../etc/passwd" }),
      envelope({ type: "readSnapshotFile", runId: "r", ...COMMITS, side: "base", path: "/etc/passwd" }),
      envelope({ type: "readSnapshotFile", runId: "../r", ...COMMITS, side: "base", path: "a.txt" }),
      envelope({ type: "readSnapshotFile", runId: "r", ...COMMITS, side: "HEAD", path: "a.txt" }),
      envelope({ type: "readSnapshotFile", runId: "r", side: "base", path: "a.txt" }),
      envelope({ type: "readSnapshotFile", runId: "r", ...COMMITS, base: "HEAD", side: "base", path: "a.txt" }),
      envelope({ type: "readSnapshotFile", runId: "r", ...COMMITS, snapshot: "--output=x", side: "snapshot", path: "a.txt" }),
      envelope({ type: "decision", requestId: "d1", answer: { decision: "merge" } }),
      envelope({ type: "decision", requestId: "bad\nid", answer: { decision: "abort" } }),
      { ...envelope({ type: "interrupt", conversation: "c" }), generation: -1 },
      { ...envelope({ type: "interrupt", conversation: "c" }), id: "1" },
      [],
      null,
    ];
    for (const raw of bad) expect(() => parseRequestEnvelope(raw), JSON.stringify(raw)?.slice(0, 80)).toThrow(ProtocolError);
  });

  it("knows a workspace-relative path when it sees one", () => {
    for (const ok of ["a.txt", "src/a b.ts", "tệp.txt", ".github/ci.yml"]) expect(isWorkspacePath(ok), ok).toBe(true);
    for (const bad of ["", "/abs", "\\abs", "C:/x", "a/../b", "..", "a//b", "a\0b"]) expect(isWorkspacePath(bad), bad).toBe(false);
  });
});

describe("attachments", () => {
  it("since protocol 6, the worker stages files by a path the host chose, and a submit names files by id", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(6);
    const stage = { type: "stageAttachment", conversation: "c-1", key: "w1a", path: "/tmp/staging/w1a-0/shot.png", name: "shot.png" };
    expect(parseRequestEnvelope(envelope(stage)).request).toEqual(stage);
    expect(parseRequestEnvelope(envelope({ type: "stageAttachment", conversation: "c-1", key: "k", path: "C:\\Users\\me\\a.pdf", name: "a.pdf" })).request).toMatchObject({ path: "C:\\Users\\me\\a.pdf" });
    for (const path of ["relative/a.png", "", "/a\0b"]) expect(() => parseRequestEnvelope(envelope({ ...stage, path }))).toThrow(/path/);
    for (const key of ["", "../x", "a b", "k".repeat(65)]) expect(() => parseRequestEnvelope(envelope({ ...stage, key }))).toThrow(/key/);
    expect(() => parseRequestEnvelope(envelope({ ...stage, name: "a\nb" }))).toThrow(/name/);
    expect(parseRequestEnvelope(envelope({ type: "removeAttachment", conversation: "c-1", id: "all" })).request).toEqual({ type: "removeAttachment", conversation: "c-1", id: "all" });
    expect(() => parseRequestEnvelope(envelope({ type: "removeAttachment", conversation: "c-1", id: "../x" }))).toThrow();
    expect(parseRequestEnvelope(envelope({ type: "submit", conversation: "c-1", text: "", attachments: ["lx1-a1b2c3d4"] })).request)
      .toEqual({ type: "submit", conversation: "c-1", text: "", route: "message", attachments: ["lx1-a1b2c3d4"] });
    expect(() => parseRequestEnvelope(envelope({ type: "submit", conversation: "c-1", text: "x", attachments: ["/etc/passwd"] }))).toThrow(/attachment/);
    expect(() => parseRequestEnvelope(envelope({ type: "submit", conversation: "c-1", text: "x", attachments: Array.from({ length: 21 }, (_, i) => `a${i}`) }))).toThrow(/at most 20/);
  });

  it("takes uploads from the webview only as base64 within the size of one file, never a path", () => {
    expect(parseWebviewMessage({ type: "attach" })).toEqual({ type: "attach" });
    expect(parseWebviewMessage({ type: "upload", key: "w1", name: "shot.png", data: "iVBORw0KGgo=" })).toEqual({ type: "upload", key: "w1", name: "shot.png", data: "iVBORw0KGgo=" });
    expect(parseWebviewMessage({ type: "upload", key: "w1", name: "empty.txt", data: "" })).toMatchObject({ data: "" });
    expect(() => parseWebviewMessage({ type: "upload", key: "w1", name: "a", data: "not base64!" })).toThrow(/base64/);
    expect(() => parseWebviewMessage({ type: "upload", key: "w1", name: "a", data: "abc" })).toThrow(/base64/);
    expect(() => parseWebviewMessage({ type: "upload", key: "w1", name: "a", data: "A".repeat(MAX_UPLOAD_CHARS + 4) })).toThrow(/too large/);
    expect(parseWebviewMessage({ type: "upload", key: "w1", name: "a", data: "A".repeat(MAX_UPLOAD_CHARS) })).toMatchObject({ type: "upload" });
    expect(parseWebviewMessage({ type: "upload", key: "w1", name: "a", data: "", path: "/etc/passwd" })).not.toHaveProperty("path");
    expect(parseWebviewMessage({ type: "detach", key: "w1" })).toEqual({ type: "detach", key: "w1" });
    expect(() => parseWebviewMessage({ type: "detach", key: "../../x" })).toThrow();
    expect(parseWebviewMessage({ type: "submit", text: "", attachments: ["lx1-a1b2c3d4"] })).toEqual({ type: "submit", text: "", route: "message", attachments: ["lx1-a1b2c3d4"] });
    // The page's answer to prepareReload: nothing but its type.
    expect(parseWebviewMessage({ type: "readyToReload", roots: ["/"] })).toEqual({ type: "readyToReload" });
  });
});

describe("webview messages", () => {
  it("only names things: submit text, answers to pending ids, and commands from a fixed list", () => {
    expect(parseWebviewMessage({ type: "submit", text: "hi" })).toEqual({ type: "submit", text: "hi", route: "message", attachments: [] });
    expect(parseWebviewMessage({ type: "submit", text: "Which queue?", route: "discuss" })).toEqual({ type: "submit", text: "Which queue?", route: "discuss", attachments: [] });
    expect(() => parseWebviewMessage({ type: "submit", text: "x", route: "debate" })).toThrow();
    expect(parseWebviewMessage({ type: "command", name: "openChanges" })).toEqual({ type: "command", name: "openChanges" });
    expect(parseWebviewMessage({ type: "usage", extra: "ignored" })).toEqual({ type: "usage" });
    expect(parseWebviewMessage({ type: "decision", generation: 2, id: "decision-1-x", decision: "defer", note: "" }))
      .toEqual({ type: "decision", generation: 2, id: "decision-1-x", decision: "defer", note: null });
    expect(parseWebviewMessage({ type: "permission", generation: 2, id: "perm-1", answer: { decision: "always" } }))
      .toEqual({ type: "permission", generation: 2, id: "perm-1", answer: { decision: "always" } });
    for (const raw of [
      { type: "command", name: "workbench.action.terminal.new" }, { type: "command", name: "openFile", path: "/etc/passwd" },
      { type: "open", uri: "file:///etc/passwd" }, { type: "permission", generation: 1, id: "p", answer: { decision: "yes" } }, { type: "submit" }, "ready",
    ]) {
      expect(() => parseWebviewMessage(raw), JSON.stringify(raw)).toThrow(ProtocolError);
    }
  });
});

describe("Account & Usage view messages", () => {
  it("only asks for its state, a refresh or the details; nothing else gets through", () => {
    for (const type of ["ready", "refresh", "details"]) expect(parseAccountViewMessage({ type, extra: "ignored" })).toEqual({ type });
    for (const raw of [{ type: "command", name: "doctor" }, { type: "usage" }, { type: "open", uri: "file:///etc/passwd" }, "refresh", null]) {
      expect(() => parseAccountViewMessage(raw), JSON.stringify(raw)).toThrow(ProtocolError);
    }
  });
});

describe("worker messages", () => {
  it("checks the protocol version and the shape the host relies on", () => {
    expect(parseWorkerMessage({ kind: "hello", protocol: PROTOCOL_VERSION, pid: 1, node: "24.0.0", version: "0.4.0" }).kind).toBe("hello");
    expect(parseWorkerMessage({ kind: "event", protocol: PROTOCOL_VERSION, generation: 1, conversation: "c-1", event: { type: "warning", text: "x" } }).kind).toBe("event");
    // An event belongs to a conversation; an update may be for the whole workspace (models, settings).
    expect(() => parseWorkerMessage({ kind: "event", protocol: PROTOCOL_VERSION, generation: 1, event: { type: "warning", text: "x" } })).toThrow(ProtocolError);
    expect(parseWorkerMessage({ kind: "ui", protocol: PROTOCOL_VERSION, generation: 1, conversation: null, update: { type: "mode", mode: "manual" } }).kind).toBe("ui");
    expect(() => parseWorkerMessage({ kind: "event", protocol: 1, generation: 1, event: { type: "warning" } })).toThrow(/protocol 1/);
    expect(() => parseWorkerMessage({ kind: "decision", protocol: PROTOCOL_VERSION, generation: 1, requestId: "d", review: {} })).toThrow(ProtocolError);
    expect(() => parseWorkerMessage({ kind: "shell", protocol: 1 })).toThrow(ProtocolError);
  });
});

const review: HumanReview = { reason: "max_review_rounds", message: "m", fromPhase: "CODE_REVIEW", resumePhase: "IMPLEMENT", details: [], at: "now" };
const request = (id: string): PermissionRequest => ({ id, tool: "Bash", label: "Bash  npm test", description: null, blockedPath: null, rules: [] });

describe("brokers", () => {
  it("resolves each decision once, by its own id, and defers what is left on close", async () => {
    const opened: string[] = [];
    const closed: string[] = [];
    const broker = new DecisionBroker({ opened: (id) => opened.push(id), closed: (id) => closed.push(id) });
    const first = broker.decide(review);
    expect(broker.answer("decision-9-zz", { decision: "abort", note: null })).toBe(false);
    expect(broker.answer(opened[0]!, { decision: "resume", note: "go" })).toBe(true);
    expect(broker.answer(opened[0]!, { decision: "abort", note: null })).toBe(false);
    expect(await first).toEqual({ decision: "resume", note: "go" });
    const second = broker.decide(review);
    expect(opened[1]).not.toBe(opened[0]);
    broker.deferAll(true);
    expect(await second).toBe("defer");
    expect(await broker.decide(review)).toBe("defer");
    expect(closed).toEqual(opened);
  });

  it("answers each permission prompt once; an aborted call, a duplicate id or a closed broker denies", async () => {
    const broker = new PermissionBroker();
    const ask = { role: "implementer" as const, agent: "claude" as const };
    const once = broker.askPermission({ ...ask, request: request("p1") });
    expect(await broker.askPermission({ ...ask, request: request("p1") })).toEqual({ decision: "deny" });
    expect(broker.answer("p1", { decision: "once" })).toBe(true);
    expect(broker.answer("p1", { decision: "always" })).toBe(false);
    expect(await once).toEqual({ decision: "once" });
    const abort = new AbortController();
    const aborted = broker.askPermission({ ...ask, request: request("p2") }, abort.signal);
    abort.abort();
    expect(await aborted).toEqual({ decision: "deny" });
    expect(broker.pending()).toEqual([]);
    const left = broker.askPermission({ ...ask, request: request("p3") });
    broker.denyAll(true);
    expect(await left).toEqual({ decision: "deny" });
    expect(await broker.askPermission({ ...ask, request: request("p4") })).toEqual({ decision: "deny" });
  });
});
