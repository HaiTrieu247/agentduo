import { describe, expect, it } from "vitest";
import { DecisionBroker, PermissionBroker } from "../extensions/vscode/src/decisionBroker.js";
import {
  isWorkspacePath, parseRequestEnvelope, parseWebviewMessage, parseWorkerMessage, PROTOCOL_VERSION, ProtocolError,
} from "../extensions/vscode/src/protocol.js";
import type { HumanReview, PermissionRequest } from "../src/events.js";

const envelope = (request: unknown) => ({ protocol: PROTOCOL_VERSION, generation: 3, id: 7, request });
const COMMITS = { base: "a".repeat(40), snapshot: "b".repeat(64) };

describe("worker requests", () => {
  it("accepts every request type with its fields, and normalises answers", () => {
    expect(parseRequestEnvelope(envelope({ type: "submit", text: "Fix it" }))).toEqual({ protocol: PROTOCOL_VERSION, generation: 3, id: 7, request: { type: "submit", text: "Fix it", route: "message" } });
    expect(parseRequestEnvelope(envelope({ type: "decision", requestId: "decision-1-ab", answer: { decision: "revise", note: "  smaller  " } })).request)
      .toEqual({ type: "decision", requestId: "decision-1-ab", answer: { decision: "revise", note: "smaller" } });
    expect(parseRequestEnvelope(envelope({ type: "permissionAnswer", requestId: "perm-0", answer: { decision: "deny", message: " " } })).request)
      .toEqual({ type: "permissionAnswer", requestId: "perm-0", answer: { decision: "deny" } });
    expect(parseRequestEnvelope(envelope({ type: "permissionAnswer", requestId: "perm-0", answer: { decision: "once", message: "ignored" } })).request)
      .toEqual({ type: "permissionAnswer", requestId: "perm-0", answer: { decision: "once" } });
    expect(parseRequestEnvelope(envelope({ type: "readSnapshotFile", runId: "20261028-1-x", ...COMMITS, side: "snapshot", path: "gói pkg/tệp.txt" })).request)
      .toEqual({ type: "readSnapshotFile", runId: "20261028-1-x", ...COMMITS, side: "snapshot", path: "gói pkg/tệp.txt" });
    for (const type of ["interrupt", "toggleEdits", "inspectFocusedRun", "listChanges", "doctor", "shutdown"]) {
      expect(parseRequestEnvelope(envelope({ type, extra: "ignored" })).request).toEqual({ type });
    }
  });

  it("refuses unknown requests, paths outside the workspace and malformed fields", () => {
    const bad = [
      envelope({ type: "exec", command: "rm -rf /" }),
      envelope({ type: "submit", text: 5 }),
      envelope({ type: "submit", text: "x".repeat(100_001) }),
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
      { ...envelope({ type: "interrupt" }), generation: -1 },
      { ...envelope({ type: "interrupt" }), id: "1" },
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

describe("webview messages", () => {
  it("only names things: submit text, answers to pending ids, and commands from a fixed list", () => {
    expect(parseWebviewMessage({ type: "submit", text: "hi" })).toEqual({ type: "submit", text: "hi", route: "message" });
    expect(parseWebviewMessage({ type: "submit", text: "Which queue?", route: "discuss" })).toEqual({ type: "submit", text: "Which queue?", route: "discuss" });
    expect(() => parseWebviewMessage({ type: "submit", text: "x", route: "debate" })).toThrow();
    expect(parseWebviewMessage({ type: "command", name: "openChanges" })).toEqual({ type: "command", name: "openChanges" });
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

describe("worker messages", () => {
  it("checks the protocol version and the shape the host relies on", () => {
    expect(parseWorkerMessage({ kind: "hello", protocol: PROTOCOL_VERSION, pid: 1, node: "24.0.0", version: "0.4.0" }).kind).toBe("hello");
    expect(parseWorkerMessage({ kind: "event", protocol: PROTOCOL_VERSION, generation: 1, event: { type: "warning", text: "x" } }).kind).toBe("event");
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
