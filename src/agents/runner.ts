import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { permissionFor, type AgentRole, type ConfigData } from "../core/config.js";
import type { EventBus, Party, Role } from "../events.js";
import { ClaudeBackend } from "./claude.js";
import { CodexBackend } from "./codex.js";
import { runProcess, type RunResult } from "./process.js";
import { validateOutput, type SchemaName } from "./schema.js";
import { AgentFailure, BinaryNotFound, type AgentBackend, type AgentMeta } from "./types.js";

export interface CallOptions {
  role: Role;
  agentRole: AgentRole;
  prompt: string;
  schemaName: SchemaName;
  logPrefix: string;
  check?: (data: any) => string[];
  extraAllowed?: string[];
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

export class AgentRunner {
  readonly backends: Record<"codex" | "claude", AgentBackend>;

  constructor(private readonly cfg: ConfigData, private readonly repo: string, private readonly logDir: string,
    private readonly bus: EventBus, backends?: Record<"codex" | "claude", AgentBackend>) {
    this.backends = backends ?? { codex: new CodexBackend(cfg.codex, repo), claude: new ClaudeBackend(cfg.claude, repo) };
  }

  async call(o: CallOptions): Promise<AgentResult> {
    const backend = this.backends[this.cfg.agents[o.agentRole]];
    const agent: Party = backend.name;
    const permission = permissionFor(this.cfg, o.agentRole);
    const attemptsAllowed = this.cfg.limits.max_retries + 1;
    const timeoutMs = this.cfg.limits.agent_timeout_sec * 1000;
    mkdirSync(this.logDir, { recursive: true });
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
      const stem = join(this.logDir, `${o.logPrefix}.a${attempt}`);
      const prompt = lastError
        ? `${o.prompt}\n\n## Previous attempt was rejected by the orchestrator\n${lastError}\nReturn ONLY a JSON object that matches the required schema exactly.\n`
        : o.prompt;
      const lastMessageFile = `${stem}.last.json`;
      let binary: string;
      let args: string[];
      try {
        binary = backend.binary();
        args = backend.buildArgs({ schemaName: o.schemaName, permission, lastMessageFile, extraAllowed: o.extraAllowed ?? [] });
      } catch (e) {
        if (e instanceof BinaryNotFound) return finish(false, attempt, null, e.message);
        throw e;
      }
      writeFileSync(`${stem}.prompt.md`, prompt);
      writeFileSync(`${stem}.cmd.json`, JSON.stringify([binary, ...args], null, 1));
      const eventsLog = createWriteStream(`${stem}.events.jsonl`);
      const parser = backend.createParser();
      const baseCost = cost;
      const baseTokens = tokens;
      let run: RunResult;
      try {
        run = await runProcess(binary, args, {
          cwd: this.repo, input: prompt, timeoutMs, signal: o.signal,
          onStdoutLine: (line) => {
            eventsLog.write(`${line}\n`);
            for (const ev of parser.feed(line)) {
              if (ev.type === "activity") this.bus.emit({ type: "agent.activity", role: o.role, agent, activity: ev.activity });
              else this.bus.emit({
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
      if (run.aborted) return finish(false, attempt, null, "interrupted", true);
      if (run.timedOut) {
        lastError = `${backend.name} timed out after ${this.cfg.limits.agent_timeout_sec}s`;
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
