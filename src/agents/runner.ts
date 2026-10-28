import { appendFileSync, createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRole, Backend, ConfigData } from "../core/config.js";
import type { Activity, CallContext, EventBus, Party, PermissionAnswer, PermissionDecider, Role } from "../events.js";
import { ClaudeBackend } from "./claude.js";
import { CodexBackend } from "./codex.js";
import { runProcess, type ChildIO, type RunResult } from "./process.js";
import { validateOutput, type SchemaName } from "./schema.js";
import { AgentFailure, BinaryNotFound, type AgentBackend, type AgentMeta, type ParsedEvent } from "./types.js";

/** A pipeline role's call: its final message must match `schemaName` (and `check`), with retries. */
export interface StructuredCall {
  mode?: "structured";
  role: Role;
  agentRole: AgentRole;
  prompt: string;
  schemaName: SchemaName;
  logPrefix: string;
  check?: (data: any) => string[];
  signal?: AbortSignal;
}

/** A conversation turn: `backend` answers in prose; no schema, no role, one attempt (the user asks again if it fails). */
export interface TextCall {
  mode: "text";
  backend: Backend;
  prompt: string;
  logPrefix: string;
  conversationId: string;
  turnId: string;
  signal?: AbortSignal;
}

export type CallOptions = StructuredCall | TextCall;

export interface AgentResult {
  ok: boolean;
  /** structured: the validated JSON; text: the answer. */
  data: any;
  error: string | null;
  attempts: number;
  durationSec: number;
  costUsd: number | null;
  tokens: number | null;
  meta: AgentMeta;
  backend: "codex" | "claude";
  interrupted: boolean;
  /** The model the CLI's stream named, also for an attempt that never finished. */
  model: string | null;
}

export interface RunnerOptions {
  backends?: Record<"codex" | "claude", AgentBackend>;
  /** Who answers permission prompts; absent when nobody can (CI, background), so prompts are denied by the CLI. */
  permissions?: PermissionDecider;
}

type PermissionEvent = Extract<ParsedEvent, { type: "permission" }>;

/** Where one call's activities, usage and permission prompts go: a pipeline role, or a conversation turn. */
interface Channel {
  context: CallContext;
  activity(activity: Activity): void;
  usage(costUsd?: number, tokens?: number): void;
  model(model: string): void;
}

export class AgentRunner {
  readonly backends: Record<"codex" | "claude", AgentBackend>;
  private readonly permissions?: PermissionDecider;

  constructor(private readonly cfg: ConfigData, private readonly repo: string, private readonly logDir: string,
    private readonly bus: EventBus, o: RunnerOptions = {}) {
    this.backends = o.backends ?? { codex: new CodexBackend(cfg.codex, repo), claude: new ClaudeBackend(cfg.claude, repo) };
    this.permissions = o.permissions;
  }

  /** Host mode: the backend can relay permission prompts, the config asks for it, and someone can answer. */
  private hosts(backend: AgentBackend): boolean {
    return !!this.permissions && backend.name === "claude" && this.cfg.claude.permission_prompts === "ask"
      && !!backend.hostInput && !!backend.permissionReply;
  }

  /** Asks the user while the agent's clocks are stopped, then answers on its stdin. */
  private async answerPermission(ev: PermissionEvent, channel: Channel, signal: AbortSignal | undefined, agent: Party, backend: AgentBackend,
    io: ChildIO, deniedByUser: Set<string>, answersLog: string): Promise<void> {
    this.bus.emit({ type: "permission.requested", ...channel.context, agent, request: ev.request });
    io.pause();
    let answer: PermissionAnswer;
    try {
      answer = await this.permissions!.askPermission({ ...channel.context, agent, request: ev.request }, signal);
    } catch {
      answer = { decision: "deny" };
    }
    if (answer.decision === "deny" && typeof ev.raw.tool_use_id === "string") deniedByUser.add(ev.raw.tool_use_id);
    const reply = backend.permissionReply!(ev.raw, answer);
    appendFileSync(answersLog, reply);
    io.write(reply);
    io.resume();
    this.bus.emit({ type: "permission.answered", ...channel.context, agent, id: ev.request.id, answer });
  }

  private channel(o: CallOptions, agent: Party): Channel {
    if (o.mode === "text") {
      const ids = { conversationId: o.conversationId, turnId: o.turnId, backend: o.backend };
      return {
        context: { turnId: o.turnId },
        activity: (activity) => this.bus.emit({ type: "turn.activity", ...ids, activity }),
        usage: (costUsd, tokens) => this.bus.emit({ type: "turn.usage", turnId: o.turnId, backend: o.backend, costUsd, tokens }),
        model: (model) => this.bus.emit({ type: "turn.model", turnId: o.turnId, backend: o.backend, model }),
      };
    }
    return {
      context: { role: o.role },
      activity: (activity) => this.bus.emit({ type: "agent.activity", role: o.role, agent, activity }),
      usage: (costUsd, tokens) => this.bus.emit({ type: "agent.usage", agent, costUsd, tokens }),
      model: () => undefined,
    };
  }

  async call(o: CallOptions): Promise<AgentResult> {
    const text = o.mode === "text";
    const backend = this.backends[o.mode === "text" ? o.backend : this.cfg.agents[o.agentRole]];
    const agent: Party = backend.name;
    const channel = this.channel(o, agent);
    const attemptsAllowed = text ? 1 : this.cfg.limits.max_retries + 1;
    const timeoutMs = this.cfg.limits.agent_timeout_sec * 1000;
    const idleTimeoutMs = this.cfg.limits.agent_idle_timeout_sec * 1000;
    mkdirSync(this.logDir, { recursive: true });
    // A step that re-runs (resume after an interrupt) keeps the earlier attempt's logs.
    let prefix = o.logPrefix;
    for (let n = 2; existsSync(join(this.logDir, `${prefix}.a1.prompt.md`)); n++) prefix = `${o.logPrefix}-${n}`;
    const started = Date.now();
    let cost = 0;
    let costSeen = false;
    let tokens = 0;
    let tokensSeen = false;
    let meta: AgentMeta = { permissionDenials: [] };
    let model: string | null = null;
    let lastError: string | null = null;
    const finish = (ok: boolean, attempts: number, data: unknown, error: string | null, interrupted = false): AgentResult => ({
      ok, data, error, attempts, durationSec: (Date.now() - started) / 1000,
      costUsd: costSeen ? cost : null, tokens: tokensSeen ? tokens : null, meta, backend: backend.name, interrupted, model,
    });

    for (let attempt = 1; attempt <= attemptsAllowed; attempt++) {
      if (attempt > 1 && o.mode !== "text") this.bus.emit({ type: "agent.retry", role: o.role, agent, attempt, max: attemptsAllowed, reason: lastError ?? "" });
      const stem = join(this.logDir, `${prefix}.a${attempt}`);
      const prompt = lastError
        ? `${o.prompt}\n\n## Previous attempt was rejected by the orchestrator\n${lastError}\nReturn ONLY a JSON object that matches the required schema exactly.\n`
        : o.prompt;
      const lastMessageFile = `${stem}.last.${text ? "md" : "json"}`;
      const host = this.hosts(backend);
      let binary: string;
      let args: string[];
      try {
        binary = backend.binary();
        args = o.mode === "text"
          ? backend.buildArgs({ mode: "text", lastMessageFile, askPermissions: host })
          : backend.buildArgs({ schemaName: o.schemaName, lastMessageFile, role: o.agentRole, askPermissions: host });
      } catch (e) {
        if (e instanceof BinaryNotFound) return finish(false, attempt, null, e.message);
        throw e;
      }
      rmSync(lastMessageFile, { force: true }); // never let Codex's previous answer stand in for this one
      writeFileSync(`${stem}.prompt.md`, prompt);
      writeFileSync(`${stem}.cmd.json`, JSON.stringify([binary, ...args], null, 1));
      const eventsLog = createWriteStream(`${stem}.events.jsonl`);
      const parser = backend.createParser();
      const baseCost = cost;
      const baseTokens = tokens;
      let io: ChildIO | undefined;
      const deniedByUser = new Set<string>();
      let run: RunResult;
      try {
        run = await runProcess(binary, args, {
          cwd: this.repo, input: host ? backend.hostInput!(prompt) : prompt, holdStdin: host, timeoutMs, idleTimeoutMs, signal: o.signal,
          onSpawn: (child) => {
            io = child;
          },
          onStdoutLine: (line) => {
            eventsLog.write(`${line}\n`);
            let parsed: ReturnType<typeof parser.feed> = [];
            try {
              parsed = parser.feed(line);
            } catch {
              // a display-only parser bug must never take the run down
            }
            for (const ev of parsed) {
              if (ev.type === "activity") channel.activity(ev.activity);
              else if (ev.type === "end") {
                if (host) io?.end(); // host mode keeps stdin open; closing it lets the CLI exit
              } else if (ev.type === "permission") {
                if (host && io) void this.answerPermission(ev, channel, o.signal, agent, backend, io, deniedByUser, `${stem}.answers.jsonl`);
              } else if (ev.type === "model") {
                model = ev.model;
                channel.model(ev.model);
              } else {
                channel.usage(ev.costUsd !== undefined ? baseCost + ev.costUsd : undefined, ev.tokens !== undefined ? baseTokens + ev.tokens : undefined);
              }
            }
          },
        });
      } catch (e) {
        await new Promise((r) => eventsLog.end(r));
        return finish(false, attempt, null, `cannot start ${backend.name}: ${(e as Error).message}`);
      }
      await new Promise((r) => eventsLog.end(r));
      writeFileSync(`${stem}.stderr.txt`, run.stderr);
      if (run.aborted || run.timedOut || run.idle) {
        const seen = parser.usage().tokens;
        if (seen) {
          tokens += seen;
          tokensSeen = true;
        }
      }
      if (run.aborted) return finish(false, attempt, null, "interrupted", true);
      if (run.timedOut) {
        lastError = `${backend.name} timed out after ${this.cfg.limits.agent_timeout_sec}s`;
        continue;
      }
      if (run.idle) {
        lastError = `${backend.name} produced no output for ${this.cfg.limits.agent_idle_timeout_sec}s`;
        continue;
      }
      let data: unknown = null;
      let parseError: string | null = null;
      try {
        ({ data, meta } = backend.finalize(parser, run.stdout, lastMessageFile, text ? "text" : "structured"));
      } catch (e) {
        if (!(e instanceof AgentFailure)) throw e;
        parseError = e.message;
        meta = { permissionDenials: [], ...e.meta };
      }
      // A call the user denied at the prompt was their choice, not a settings problem worth a hint.
      if (deniedByUser.size) meta.permissionDenials = meta.permissionDenials.filter((d) => !d.tool_use_id || !deniedByUser.has(d.tool_use_id));
      if (typeof meta.costUsd === "number") {
        cost += meta.costUsd;
        costSeen = true;
      }
      if (typeof meta.tokens === "number") {
        tokens += meta.tokens;
        tokensSeen = true;
      }
      if (parseError) {
        lastError = run.code === 0 ? parseError : `${backend.name} exited with code ${run.code}: ${(run.stderr || run.stdout).trim().slice(-800)}`;
        continue;
      }
      if (run.code !== 0) {
        lastError = `${backend.name} exited with code ${run.code}: ${run.stderr.trim().slice(-800)}`;
        continue;
      }
      if (o.mode === "text") {
        writeFileSync(`${stem}.answer.md`, String(data));
        return finish(true, attempt, data, null);
      }
      let errors = validateOutput(o.schemaName, data);
      if (!errors.length && o.check) errors = o.check(data);
      if (errors.length) {
        lastError = `output failed validation:\n- ${errors.slice(0, 20).join("\n- ")}`;
        continue;
      }
      writeFileSync(`${stem}.output.json`, JSON.stringify(data, null, 2));
      return finish(true, attempt, data, null);
    }
    return finish(false, attemptsAllowed, null, lastError);
  }
}
