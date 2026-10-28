import { existsSync, readFileSync } from "node:fs";
import type { ConfigData } from "../core/config.js";
import type { Activity } from "../events.js";
import { resolveBinary } from "./resolve.js";
import { schemaPath } from "./schema.js";
import {
  AgentFailure, BinaryNotFound, extractJson, firstLine,
  type AgentBackend, type AgentMeta, type BuildArgs, type FinalOutput, type ParsedEvent, type StreamParser,
} from "./types.js";

/** "/bin/zsh -lc 'cat a.txt'" → "cat a.txt" */
export function unwrapShell(command: string): string {
  const quoted = /^\S*?(?:ba|z)?sh -lc '([\s\S]*)'$/.exec(command);
  if (quoted) return quoted[1]!.replace(/'\\''/g, "'");
  const doubleQuoted = /^\S*?(?:ba|z)?sh -lc "([\s\S]*)"$/.exec(command);
  if (doubleQuoted) return doubleQuoted[1]!.replace(/\\(["\\$`])/g, "$1");
  const bare = /^\S*?(?:ba|z)?sh -lc (.+)$/.exec(command);
  return bare ? bare[1]! : command;
}

type Item = Record<string, unknown> & { id?: unknown; type?: unknown };

export class CodexParser implements StreamParser {
  tokens = 0;
  lastAgentMessage: string | null = null;
  error: string | null = null;
  /** The turn itself failed (not just a reported error the CLI recovered from). */
  failed = false;

  usage(): { tokens?: number } {
    return { tokens: this.tokens || undefined };
  }

  feed(line: string): ParsedEvent[] {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) return [];
    if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
      const usage = event.usage as { input_tokens?: number; output_tokens?: number };
      this.tokens += (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0);
      return [{ type: "usage", tokens: this.tokens }];
    }
    if (event.type === "turn.failed" || event.type === "error") {
      const err = event.error as { message?: string } | undefined;
      this.error = String(err?.message ?? event.message ?? "codex reported an error");
      if (event.type === "turn.failed") this.failed = true;
      return [];
    }
    if (typeof event.type !== "string" || !/^item\.(started|updated|completed)$/.test(event.type) || !event.item) return [];
    const activity = this.toActivity(event.item as Item, event.type === "item.completed");
    return activity ? [{ type: "activity", activity }] : [];
  }

  private toActivity(item: Item, completed: boolean): Activity | null {
    const id = String(item.id ?? "");
    const failed = item.status === "failed";
    switch (item.type) {
      case "command_execution": {
        const done = completed || item.status === "completed" || failed;
        const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
        return {
          id, kind: "command", label: `exec  ${firstLine(unwrapShell(String(item.command ?? "")))}`,
          status: !done ? "running" : exitCode === 0 && !failed ? "ok" : "error", exitCode,
        };
      }
      case "agent_message": {
        if (!completed) return null;
        const text = String(item.text ?? "");
        this.lastAgentMessage = text;
        return text.trim().startsWith("{")
          ? { id, kind: "submit", label: "submitting result", status: "ok" }
          : { id, kind: "say", label: firstLine(text), status: "ok" };
      }
      case "reasoning":
        return { id, kind: "think", label: item.text ? firstLine(String(item.text)) : "thinking", status: completed ? "ok" : "running" };
      case "file_change": {
        const changes = Array.isArray(item.changes) ? (item.changes as Array<{ path?: string }>).map((c) => c.path).join(", ") : "";
        return { id, kind: "edit", label: `edit  ${firstLine(changes)}`, status: !completed ? "running" : failed ? "error" : "ok" };
      }
      case "web_search":
        return { id, kind: "search", label: `search  ${firstLine(String(item.query ?? ""))}`, status: completed ? "ok" : "running" };
      case "mcp_tool_call":
        return { id, kind: "other", label: `${String(item.server ?? "mcp")}.${String(item.tool ?? "tool")}`, status: !completed ? "running" : failed ? "error" : "ok" };
      case "todo_list":
        return { id, kind: "other", label: "update plan", status: "ok" };
      case "error":
        return { id, kind: "other", label: firstLine(String(item.message ?? "error")), status: "error" };
      default:
        return null;
    }
  }
}

export class CodexBackend implements AgentBackend {
  readonly name = "codex" as const;

  constructor(private readonly cfg: ConfigData["codex"], private readonly repo: string) {}

  binary(): string {
    const found = resolveBinary(this.cfg.bin, "codex");
    if (!found) throw new BinaryNotFound(`codex CLI not found (configured bin: '${this.cfg.bin}')`);
    return found;
  }

  /** A conversation turn (text mode) gets no schema and no role_args: only the args every call gets. */
  buildArgs(a: BuildArgs): string[] {
    return [
      "exec", "--json",
      "--color", "never",
      ...(a.mode === "text" ? [] : ["--output-schema", schemaPath(a.schemaName)]),
      "--output-last-message", a.lastMessageFile,
      "--cd", this.repo,
      ...(this.cfg.model ? ["--model", this.cfg.model] : []),
      ...this.cfg.args,
      ...(a.mode === "text" ? [] : this.cfg.role_args[a.role] ?? []),
      "-", // read the prompt from stdin
    ];
  }

  createParser(): CodexParser {
    return new CodexParser();
  }

  finalize(parser: StreamParser, _stdout: string, lastMessageFile: string, mode: "structured" | "text" = "structured"): FinalOutput {
    const p = parser as CodexParser;
    const fromFile = lastMessageFile && existsSync(lastMessageFile) ? readFileSync(lastMessageFile, "utf8") : "";
    const text = fromFile.trim() ? fromFile : p.lastAgentMessage ?? "";
    const meta: AgentMeta = { tokens: p.tokens || undefined, permissionDenials: [] };
    if (mode === "text" && p.failed) throw new AgentFailure(`codex failed: ${p.error}`, meta);
    if (!text.trim()) throw new AgentFailure(p.error ? `codex failed: ${p.error}` : "codex produced no final message", meta);
    // An answer is shown as Codex wrote it, also when it happens to look like JSON.
    if (mode === "text") return { data: text, meta };
    try {
      return { data: extractJson(text), meta };
    } catch (e) {
      throw new AgentFailure((e as Error).message, meta);
    }
  }
}
