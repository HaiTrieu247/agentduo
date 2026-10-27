import type { ConfigData } from "../core/config.js";
import type { Activity, PermissionAnswer } from "../events.js";
import { resolveBinary } from "./resolve.js";
import { loadSchema } from "./schema.js";
import {
  AgentFailure, BinaryNotFound, extractJson, firstLine, relPath,
  type AgentBackend, type AgentMeta, type BuildArgs, type FinalOutput, type ParsedEvent, type StreamParser,
} from "./types.js";

const DENIAL_RE = /permission|denied|haven't granted|not allowed/i;
const countLines = (text: unknown): number =>
  typeof text === "string" && text.length ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;

type Block = Record<string, unknown> & { type?: unknown };

const USAGE_FIELDS = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"];
const sumUsage = (u: Record<string, unknown>) => USAGE_FIELDS.reduce((sum, k) => sum + (Number(u[k]) || 0), 0);

export class ClaudeParser implements StreamParser {
  result: Record<string, any> | null = null;
  private readonly tools = new Map<string, Activity>();
  private readonly messageTokens = new Map<string, number>();

  /** The result envelope's total; the streamed per-message usage undercounts output (it is reported as each message starts). */
  private resultTokens: number | undefined;

  usage(): { tokens?: number; costUsd?: number } {
    const tokens = this.resultTokens ?? [...this.messageTokens.values()].reduce((a, b) => a + b, 0);
    const cost = this.result?.total_cost_usd;
    return { tokens: tokens || undefined, costUsd: typeof cost === "number" ? cost : undefined };
  }

  /** Assistant events repeat their message's usage once per content block; count each message once. */
  private trackUsage(message: Record<string, any>): ParsedEvent[] {
    const u = message?.usage;
    if (!u || typeof u !== "object" || !message.id) return [];
    const n = sumUsage(u);
    if (this.messageTokens.get(String(message.id)) === n) return [];
    this.messageTokens.set(String(message.id), n);
    return [{ type: "usage", tokens: this.usage().tokens }];
  }

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
    if (event.type === "control_request") return this.onControlRequest(event);
    const out: ParsedEvent[] = event.type === "assistant" ? this.trackUsage(event.message) : [];
    const content = event.message?.content;
    if (!Array.isArray(content)) return out;
    content.forEach((block: Block, i: number) => {
      if (!block || typeof block !== "object") return;
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

  /** Host mode: Claude asks before a tool call its settings do not allow. */
  private onControlRequest(event: Record<string, any>): ParsedEvent[] {
    const r = event.request;
    if (!r || typeof r !== "object" || r.subtype !== "can_use_tool" || !event.request_id) return [];
    const id = String(event.request_id);
    const activity = this.toolActivity({ type: "tool_use", id: String(r.tool_use_id ?? id), name: r.tool_name, input: r.input });
    // Only persistent allow rules: Claude also suggests switching the session to acceptEdits, which is broader than "always allow this".
    const suggestions = (Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [])
      .filter((x: any) => x && x.type === "addRules" && x.behavior === "allow" && Array.isArray(x.rules));
    const rules = suggestions.flatMap((x: any) => x.rules.filter((rule: any) => rule && rule.toolName)
      .map((rule: any) => (rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : String(rule.toolName))));
    return [{
      type: "permission",
      request: {
        id, tool: String(r.display_name ?? r.tool_name ?? "tool"), label: activity.label,
        description: typeof r.description === "string" ? r.description : null,
        blockedPath: typeof r.blocked_path === "string" ? relPath(r.blocked_path, this.repo) : null, rules,
      },
      raw: { request_id: id, tool_use_id: r.tool_use_id ?? null, input: r.input ?? {}, suggestions },
    }];
  }

  private onResult(event: Record<string, any>): ParsedEvent[] {
    this.result = event;
    const out: ParsedEvent[] = [];
    for (const denial of Array.isArray(event.permission_denials) ? event.permission_denials : []) {
      const activity = denial && typeof denial === "object" && denial.tool_use_id ? this.tools.get(String(denial.tool_use_id)) : undefined;
      if (activity && activity.status !== "denied") {
        activity.status = "denied";
        out.push({ type: "activity", activity: { ...activity } });
      }
    }
    if (event.usage && typeof event.usage === "object") this.resultTokens = sumUsage(event.usage) || undefined;
    if (typeof event.total_cost_usd === "number" || this.resultTokens) {
      out.push({
        type: "usage",
        ...(typeof event.total_cost_usd === "number" ? { costUsd: event.total_cost_usd } : {}),
        ...(this.resultTokens ? { tokens: this.resultTokens } : {}),
      });
    }
    out.push({ type: "end" });
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

  /** Protocol flags only; what Claude may do comes from the user's Claude Code settings plus args/role_args. */
  buildArgs({ schemaName, role, askPermissions }: BuildArgs): string[] {
    return [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--json-schema", JSON.stringify(loadSchema(schemaName)),
      // Host mode sends permission prompts to agentduo (the user answers them); without a host, "none" denies
      // them automatically, since nobody could answer and the run would hang. Neither grants anything.
      ...(askPermissions
        ? ["--input-format", "stream-json", "--permission-prompts", "host", "--permission-prompt-tool", "stdio"]
        : ["--permission-prompts", "none"]),
      ...(this.cfg.model ? ["--model", this.cfg.model] : []),
      ...(this.cfg.max_budget_usd ? ["--max-budget-usd", String(this.cfg.max_budget_usd)] : []),
      ...this.cfg.args,
      ...(this.cfg.role_args[role] ?? []),
    ];
  }

  hostInput(prompt: string): string {
    return `${JSON.stringify({ type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null, session_id: "" })}\n`;
  }

  permissionReply(raw: Record<string, unknown>, answer: PermissionAnswer): string {
    const suggestions = Array.isArray(raw.suggestions) ? raw.suggestions : [];
    const response = answer.decision === "deny"
      ? { behavior: "deny", message: answer.message?.trim() || "The user denied this tool call. Do not retry it; continue without it and say so in your report." }
      : { behavior: "allow", updatedInput: raw.input ?? {}, ...(answer.decision === "always" && suggestions.length ? { updatedPermissions: suggestions } : {}) };
    return `${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: raw.request_id, response } })}\n`;
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
    // Without an envelope (a crash), the streamed usage is all we know of what the attempt cost.
    if (!envelope) throw new AgentFailure(`claude did not return a result envelope: ${stdout.trim().slice(0, 300)}`, { tokens: (parser as ClaudeParser).usage?.().tokens });
    const meta: AgentMeta = {
      costUsd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : undefined,
      tokens: (parser as ClaudeParser).usage?.().tokens,
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
