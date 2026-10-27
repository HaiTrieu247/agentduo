import type { ConfigData } from "../core/config.js";
import type { Activity } from "../events.js";
import { resolveBinary } from "./resolve.js";
import { loadSchema } from "./schema.js";
import {
  AgentFailure, BinaryNotFound, extractJson, firstLine, relPath,
  type AgentBackend, type AgentMeta, type BuildArgs, type FinalOutput, type ParsedEvent, type StreamParser,
} from "./types.js";

const DENIAL_RE = /permission|denied|haven't granted|not allowed/i;
const countLines = (text: unknown): number => (typeof text === "string" && text.length ? text.split("\n").length : 0);

type Block = Record<string, unknown> & { type?: unknown };

export class ClaudeParser implements StreamParser {
  result: Record<string, any> | null = null;
  private readonly tools = new Map<string, Activity>();

  constructor(private readonly repo: string) {}

  feed(line: string): ParsedEvent[] {
    let event: Record<string, any>;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) return [];
    if (event.type === "result") return this.onResult(event);
    const content = event.message?.content;
    if (!Array.isArray(content)) return [];
    const out: ParsedEvent[] = [];
    content.forEach((block: Block, i: number) => {
      if (event.type === "assistant") {
        const id = `${event.uuid ?? event.message.id ?? "msg"}-${i}`;
        if (block.type === "text" && String(block.text ?? "").trim()) {
          out.push({ type: "activity", activity: { id, kind: "say", label: firstLine(String(block.text)), status: "ok" } });
        } else if (block.type === "thinking") {
          out.push({ type: "activity", activity: { id, kind: "think", label: "thinking", status: "ok" } });
        } else if (block.type === "tool_use") {
          const activity = this.toolActivity(block);
          this.tools.set(activity.id, activity);
          out.push({ type: "activity", activity: { ...activity } });
        }
      } else if (event.type === "user" && block.type === "tool_result") {
        const activity = this.tools.get(String(block.tool_use_id));
        if (!activity) return;
        const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
        activity.status = block.is_error ? (DENIAL_RE.test(text) ? "denied" : "error") : "ok";
        out.push({ type: "activity", activity: { ...activity } });
      }
    });
    return out;
  }

  private onResult(event: Record<string, any>): ParsedEvent[] {
    this.result = event;
    const out: ParsedEvent[] = [];
    for (const denial of Array.isArray(event.permission_denials) ? event.permission_denials : []) {
      const activity = denial?.tool_use_id ? this.tools.get(String(denial.tool_use_id)) : undefined;
      if (activity && activity.status !== "denied") {
        activity.status = "denied";
        out.push({ type: "activity", activity: { ...activity } });
      }
    }
    if (typeof event.total_cost_usd === "number") out.push({ type: "usage", costUsd: event.total_cost_usd });
    return out;
  }

  private toolActivity(block: Block): Activity {
    const input = (block.input ?? {}) as Record<string, any>;
    const id = String(block.id);
    const path = (p: unknown) => relPath(String(p ?? ""), this.repo);
    switch (block.name) {
      case "Read":
        return { id, kind: "read", label: `Read  ${path(input.file_path)}`, status: "running" };
      case "Grep":
        return { id, kind: "search", label: `Grep  "${firstLine(String(input.pattern ?? ""), 60)}"${input.path ? ` in ${path(input.path)}` : ""}`, status: "running" };
      case "Glob":
        return { id, kind: "search", label: `Glob  ${firstLine(String(input.pattern ?? ""), 60)}`, status: "running" };
      case "Edit":
        return { id, kind: "edit", label: `Edit  ${path(input.file_path)}`, status: "running", added: countLines(input.new_string), removed: countLines(input.old_string) };
      case "MultiEdit": {
        const edits: Array<Record<string, unknown>> = Array.isArray(input.edits) ? input.edits : [];
        return {
          id, kind: "edit", label: `Edit  ${path(input.file_path)}`, status: "running",
          added: edits.reduce((n, e) => n + countLines(e.new_string), 0),
          removed: edits.reduce((n, e) => n + countLines(e.old_string), 0),
        };
      }
      case "Write":
        return { id, kind: "edit", label: `Write ${path(input.file_path)}`, status: "running", added: countLines(input.content), removed: 0 };
      case "NotebookEdit":
        return { id, kind: "edit", label: `Edit  ${path(input.notebook_path)}`, status: "running" };
      case "Bash":
        return { id, kind: "command", label: `Bash  ${firstLine(String(input.command ?? ""))}`, status: "running" };
      case "StructuredOutput":
        return { id, kind: "submit", label: "submitting result", status: "running" };
      case "TodoWrite":
        return { id, kind: "other", label: "update todos", status: "running" };
      default:
        return { id, kind: "other", label: String(block.name ?? "tool"), status: "running" };
    }
  }
}

export class ClaudeBackend implements AgentBackend {
  readonly name = "claude" as const;

  constructor(private readonly cfg: ConfigData["claude"], private readonly repo: string) {}

  binary(): string {
    const found = resolveBinary(this.cfg.bin, "claude");
    if (!found) throw new BinaryNotFound(`claude CLI not found (configured bin: '${this.cfg.bin}')`);
    return found;
  }

  buildArgs({ schemaName, permission, extraAllowed }: BuildArgs): string[] {
    const write = permission === "workspace-write";
    const tools = write ? this.cfg.implementation_tools : this.cfg.read_only_tools;
    const allowed = write ? [...this.cfg.implementation_allowed_tools, ...extraAllowed] : [...tools];
    const disallowed = write ? this.cfg.implementation_disallowed_tools : [];
    return [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--json-schema", JSON.stringify(loadSchema(schemaName)),
      "--permission-mode", write ? "acceptEdits" : "dontAsk",
      "--permission-prompts", "none",
      "--tools", tools.join(","),
      "--allowedTools", ...allowed,
      ...(disallowed.length ? ["--disallowedTools", ...disallowed] : []),
      ...(this.cfg.model ? ["--model", this.cfg.model] : []),
      ...(this.cfg.max_budget_usd ? ["--max-budget-usd", String(this.cfg.max_budget_usd)] : []),
      ...this.cfg.extra_args.map(String),
    ];
  }

  createParser(): ClaudeParser {
    return new ClaudeParser(this.repo);
  }

  finalize(parser: StreamParser, stdout: string, _lastMessageFile = ""): FinalOutput {
    let envelope = (parser as ClaudeParser).result;
    if (!envelope) {
      try {
        const parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) envelope = parsed;
      } catch {
        // handled below
      }
    }
    if (!envelope) throw new AgentFailure(`claude did not return a result envelope: ${stdout.trim().slice(0, 300)}`);
    const meta: AgentMeta = {
      costUsd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : undefined,
      sessionId: envelope.session_id, numTurns: envelope.num_turns,
      permissionDenials: Array.isArray(envelope.permission_denials) ? envelope.permission_denials : [],
    };
    if (envelope.is_error || (envelope.subtype !== undefined && envelope.subtype !== "success")) {
      throw new AgentFailure(`claude reported an error (subtype=${envelope.subtype}): ${String(envelope.result ?? "").slice(0, 500)}`, meta);
    }
    if (envelope.structured_output != null) return { data: envelope.structured_output, meta };
    try {
      return { data: extractJson(String(envelope.result ?? "")), meta };
    } catch (e) {
      throw new AgentFailure((e as Error).message, meta);
    }
  }
}
