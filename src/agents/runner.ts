import { appendFileSync, createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRole, ConfigData } from "../core/config.js";
import type { EventBus, Party, PermissionAnswer, PermissionDecider, Role } from "../events.js";
import { ClaudeBackend } from "./claude.js";
import { CodexBackend } from "./codex.js";
import { runProcess, type ChildIO, type RunResult } from "./process.js";
import { validateOutput, type SchemaName } from "./schema.js";
import { AgentFailure, BinaryNotFound, type AgentBackend, type AgentMeta, type ParsedEvent } from "./types.js";

export interface CallOptions {
  role: Role;
  agentRole: AgentRole;
  prompt: string;
  schemaName: SchemaName;
  logPrefix: string;
  check?: (data: any) => string[];
  signal?: AbortSignal;
}

export interface AgentResult {
  ok: boolean;
  data: any;
  error: string | null;
  attempts: number;
  durationSec: number;
  costUsd: number | null;
  tokens: number | null;
  meta: AgentMeta;
  backend: "codex" | "claude";
  interrupted: boolean;
}

export interface RunnerOptions {
  backends?: Record<"codex" | "claude", AgentBackend>;
  /** Who answers permission prompts; absent when nobody can (CI, background), so prompts are denied by the CLI. */
  permissions?: PermissionDecider;
}

type PermissionEvent = Extract<ParsedEvent, { type: "permission" }>;

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
  private async answerPermission(ev: PermissionEvent, o: CallOptions, agent: Party, backend: AgentBackend, io: ChildIO,
    deniedByUser: Set<string>, answersLog: string): Promise<void> {
    this.bus.emit({ type: "permission.requested", role: o.role, agent, request: ev.request });
    io.pause();
    let answer: PermissionAnswer;
    try {
      answer = await this.permissions!.askPermission({ role: o.role, agent, request: ev.request }, o.signal);
    } catch {
      answer = { decision: "deny" };
    }
    if (answer.decision === "deny" && typeof ev.raw.tool_use_id === "string") deniedByUser.add(ev.raw.tool_use_id);
    const reply = backend.permissionReply!(ev.raw, answer);
    appendFileSync(answersLog, reply);
    io.write(reply);
    io.resume();
    this.bus.emit({ type: "permission.answered", role: o.role, agent, id: ev.request.id, answer });
  }

  async call(o: CallOptions): Promise<AgentResult> {
    const backend = this.backends[this.cfg.agents[o.agentRole]];
    const agent: Party = backend.name;
    const attemptsAllowed = this.cfg.limits.max_retries + 1;
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
    let lastError: string | null = null;
    const finish = (ok: boolean, attempts: number, data: unknown, error: string | null, interrupted = false): AgentResult => ({
      ok, data, error, attempts, durationSec: (Date.now() - started) / 1000,
      costUsd: costSeen ? cost : null, tokens: tokensSeen ? tokens : null, meta, backend: backend.name, interrupted,
    });

    for (let attempt = 1; attempt <= attemptsAllowed; attempt++) {
      if (attempt > 1) this.bus.emit({ type: "agent.retry", role: o.role, agent, attempt, max: attemptsAllowed, reason: lastError ?? "" });
      const stem = join(this.logDir, `${prefix}.a${attempt}`);
      const prompt = lastError
        ? `${o.prompt}\n\n## Previous attempt was rejected by the orchestrator\n${lastError}\nReturn ONLY a JSON object that matches the required schema exactly.\n`
        : o.prompt;
      const lastMessageFile = `${stem}.last.json`;
      let binary: string;
      let args: string[];
      try {
        binary = backend.binary();
        args = backend.buildArgs({ schemaName: o.schemaName, lastMessageFile, role: o.agentRole, askPermissions: this.hosts(backend) });
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
      const host = this.hosts(backend);
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
              if (ev.type === "activity") this.bus.emit({ type: "agent.activity", role: o.role, agent, activity: ev.activity });
              else if (ev.type === "end") {
                if (host) io?.end(); // host mode keeps stdin open; closing it lets the CLI exit
              } else if (ev.type === "permission") {
                if (host && io) void this.answerPermission(ev, o, agent, backend, io, deniedByUser, `${stem}.answers.jsonl`);
              } else this.bus.emit({
                type: "agent.usage", agent,
                costUsd: ev.costUsd !== undefined ? baseCost + ev.costUsd : undefined,
                tokens: ev.tokens !== undefined ? baseTokens + ev.tokens : undefined,
              });
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
        ({ data, meta } = backend.finalize(parser, run.stdout, lastMessageFile));
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
