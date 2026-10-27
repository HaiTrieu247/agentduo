import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runProcess } from "../agents/process.js";
import type { EventBus } from "../events.js";
import type { GateConfig } from "./config.js";

export interface GateResult {
  name: string;
  command: string;
  required: boolean;
  exitCode: number | null;
  timedOut: boolean;
  passed: boolean;
  durationSec: number;
  log: string;
  outputTail: string;
}

export class GatesInterrupted extends Error {
  override name = "GatesInterrupted";
}

const tail = (text: string, limit: number) => (text.length <= limit ? text : `...[truncated]...\n${text.slice(-limit)}`);

/** Run the project's own checks; the orchestrator trusts these, not what the agents report. */
export async function runGates(o: {
  gates: GateConfig[]; repo: string; logDir: string; label: string; defaultTimeoutSec: number;
  maxOutputChars: number; bus: EventBus; signal?: AbortSignal;
}): Promise<GateResult[]> {
  mkdirSync(o.logDir, { recursive: true });
  const results: GateResult[] = [];
  for (const gate of o.gates) {
    const log = join(o.logDir, `${o.label}-gate-${gate.name}.log`);
    o.bus.emit({ type: "gate.started", name: gate.name, command: gate.command });
    const started = Date.now();
    const run = await runProcess(gate.command, [], {
      cwd: o.repo, shell: true, timeoutMs: (gate.timeout_sec ?? o.defaultTimeoutSec) * 1000, signal: o.signal, killGraceMs: 2000,
    });
    if (run.aborted) throw new GatesInterrupted(`gate '${gate.name}' interrupted`);
    const separator = run.stdout && run.stderr && !run.stdout.endsWith("\n") ? "\n" : "";
    const output = run.stdout + separator + run.stderr;
    const exitCode = run.timedOut ? null : run.code;
    writeFileSync(log, `$ ${gate.command}\n${output}\n[exit code: ${exitCode}]\n`);
    const result: GateResult = {
      name: gate.name, command: gate.command, required: gate.required !== false, exitCode, timedOut: run.timedOut,
      passed: exitCode === 0, durationSec: Math.round((Date.now() - started) / 10) / 100, log, outputTail: tail(output, o.maxOutputChars),
    };
    o.bus.emit({ type: "gate.completed", name: gate.name, command: gate.command, passed: result.passed, exitCode });
    results.push(result);
  }
  return results;
}

export function requiredPassed(results: GateResult[]): boolean {
  return results.every((r) => r.passed || !r.required);
}

export function describeGates(results: GateResult[], withOutput = true): string {
  if (!results.length) return "(no quality gates configured)";
  const lines: string[] = [];
  for (const r of results) {
    const verdict = r.passed ? "PASS" : r.timedOut ? "TIMEOUT" : "FAIL";
    lines.push(`- [${verdict}] ${r.name} (${r.required ? "required" : "optional"}): \`${r.command}\` exit=${r.exitCode} in ${r.durationSec}s`);
    if (withOutput && !r.passed && r.outputTail.trim()) {
      lines.push("  ```\n" + r.outputTail.split("\n").map((l) => `  ${l}`).join("\n") + "\n  ```");
    }
  }
  return lines.join("\n");
}
