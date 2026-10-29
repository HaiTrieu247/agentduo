import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { AgentRole } from "../core/config.js";
import type { Activity, PermissionAnswer, PermissionRequest } from "../events.js";
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
  /** The model the CLI's own stream named (Claude's init event). */
  model?: string;
  permissionDenials: PermissionDenial[];
}

export type ParsedEvent =
  | { type: "activity"; activity: Activity }
  | { type: "usage"; costUsd?: number; tokens?: number }
  /** A permission prompt in host mode; `raw` is what the backend needs to answer it. */
  | { type: "permission"; request: PermissionRequest; raw: Record<string, unknown> }
  /** The CLI said which model this call runs on. */
  | { type: "model"; model: string }
  /** The final result arrived; in host mode the runner closes stdin so the CLI exits. */
  | { type: "end" };

/** Stateful translator from one CLI's stdout lines to activities. Must never throw. */
export interface StreamParser {
  feed(line: string): ParsedEvent[];
  /** Usage seen so far in the stream (also for attempts that never finished). */
  usage(): { tokens?: number; costUsd?: number };
}

/**
 * structured: a pipeline role's call, whose final message must match a schema; text: a conversation turn, whose
 * final message is the answer as it is, with no schema and no role_args.
 */
export type CallMode = "structured" | "text";

/** An attached image the call sends as an image (not only as a path): its copy, and its media type. */
export interface NativeImage {
  file: string;
  mediaType: string;
}

interface CallArgs {
  lastMessageFile: string;
  /** Route permission prompts to the runner (host mode) instead of denying them. */
  askPermissions?: boolean;
  /** Images to attach to the prompt, in order. */
  images?: NativeImage[];
}

export type BuildArgs =
  | ({
    mode?: "structured";
    schemaName: SchemaName;
    /** Config role of the call (plan sign-off uses "planner"); selects <backend>.role_args. */
    role: AgentRole;
  } & CallArgs)
  | ({ mode: "text" } & CallArgs);

export interface FinalOutput {
  /** structured: the parsed JSON; text: the answer. */
  data: unknown;
  meta: AgentMeta;
}

export interface AgentBackend {
  readonly name: "codex" | "claude";
  binary(): string;
  buildArgs(args: BuildArgs): string[];
  createParser(): StreamParser;
  /** Extract the final JSON (or, in text mode, the answer); throws AgentFailure (carrying whatever meta is known) when unusable. */
  finalize(parser: StreamParser, stdout: string, lastMessageFile: string, mode?: CallMode): FinalOutput;
  /**
   * Backends that read their input as a stream of messages (Claude, in host mode or with images): the prompt, and the
   * images, as the first stdin message. Without it, a backend gets images through buildArgs and the prompt as is.
   */
  hostInput?(prompt: string, images?: NativeImage[]): string;
  /** Host mode: the answer to a permission prompt. */
  permissionReply?(raw: Record<string, unknown>, answer: PermissionAnswer): string;
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

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path)); // a file that does not exist yet
    } catch {
      return path;
    }
  }
}

/** Repo-relative form of an absolute path, also when one side goes through a symlink (macOS /var → /private/var). */
export function relPath(path: string, repo: string): string {
  if (!path || !isAbsolute(path)) return path;
  for (const [base, target] of [[repo, path], [realpathOrSelf(repo), realpathOrSelf(path)]] as const) {
    const rel = relative(base, target);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  }
  return path;
}
