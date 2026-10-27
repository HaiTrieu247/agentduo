import { isAbsolute, relative } from "node:path";
import type { Permission } from "../core/config.js";
import type { Activity } from "../events.js";
import type { SchemaName } from "./schema.js";

export interface PermissionDenial {
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
}

export interface AgentMeta {
  costUsd?: number;
  tokens?: number;
  sessionId?: string;
  numTurns?: number;
  permissionDenials: PermissionDenial[];
}

export type ParsedEvent =
  | { type: "activity"; activity: Activity }
  | { type: "usage"; costUsd?: number; tokens?: number };

/** Stateful translator from one CLI's stdout lines to activities. Must never throw. */
export interface StreamParser {
  feed(line: string): ParsedEvent[];
}

export interface BuildArgs {
  schemaName: SchemaName;
  permission: Permission;
  lastMessageFile: string;
  extraAllowed: string[];
}

export interface FinalOutput {
  data: unknown;
  meta: AgentMeta;
}

export interface AgentBackend {
  readonly name: "codex" | "claude";
  binary(): string;
  buildArgs(args: BuildArgs): string[];
  createParser(): StreamParser;
  /** Extract the final JSON; throws AgentFailure (carrying whatever meta is known) when unusable. */
  finalize(parser: StreamParser, stdout: string, lastMessageFile: string): FinalOutput;
}

export class AgentFailure extends Error {
  override name = "AgentFailure";
  constructor(message: string, readonly meta: Partial<AgentMeta> = {}) {
    super(message);
  }
}

export class BinaryNotFound extends Error {
  override name = "BinaryNotFound";
}

export function extractJson(text: string): unknown {
  let body = (text ?? "").trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(body);
  if (fence) body = fence[1]!.trim();
  try {
    return JSON.parse(body);
  } catch {
    // fall through to the brace search
  }
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      // fall through to the error
    }
  }
  throw new AgentFailure(`output is not valid JSON: ${body.length > 300 ? `${body.slice(0, 300)}...` : body}`);
}

export function firstLine(text: string, max = 120): string {
  const line = String(text ?? "").trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function relPath(path: string, repo: string): string {
  if (!path || !isAbsolute(path)) return path;
  const rel = relative(repo, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}
