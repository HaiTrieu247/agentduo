import type { Decider, DuoEvent, EventBus } from "../events.js";
import { activityText, formatDuration, messageHeadline, roleLabel, statusIcon, usageText } from "./format.js";

export interface TextSink {
  write(text: string): unknown;
}

export interface PlainOptions {
  color: boolean;
  verbose: boolean;
  version: string;
  now?: () => Date;
  commandName?: string;
}

/** Plain mode cannot ask questions: every human review becomes "exit 2, resume later". */
export const deferDecider: Decider = { decide: async () => "defer" };

const CODES = { dim: 2, bold: 1, red: 31, green: 32, yellow: 33, cyan: 36 } as const;
const AGENT_WIDTH = 12; // fits "orchestrator"
const INDENT = " ".repeat(8 + 2 + AGENT_WIDTH + 1 + 16 + 1);

export function attachPlainRenderer(bus: EventBus, out: TextSink, o: PlainOptions): () => void {
  const paint = (c: keyof typeof CODES, s: string) => (o.color ? `\u001b[${CODES[c]}m${s}\u001b[0m` : s);
  const now = o.now ?? (() => new Date());
  const cmd = o.commandName ?? "duo";
  let ctx = { agent: "", where: "" };
  const clock = () => {
    const d = now();
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
  };
  const line = (text: string, agent = ctx.agent, where = ctx.where) => {
    out.write(`${paint("dim", clock())}  ${agent.padEnd(AGENT_WIDTH)} ${where.padEnd(16)} ${text}\n`);
  };

  return bus.on((e: DuoEvent) => {
    switch (e.type) {
      case "run.started":
        out.write(`${paint("bold", `agentduo ${o.version} · run ${e.runId}`)}\n  repo: ${e.repo}\n  run dir: ${e.runDir}\n`);
        break;
      case "phase.started":
        ctx = { agent: e.agent ?? "", where: `${e.phase} r${e.round}` };
        line(paint("cyan", `▶ ${e.role ? roleLabel(e.role) : e.phase.toLowerCase()}`));
        break;
      case "agent.activity": {
        const a = e.activity;
        if (a.status === "running") break;
        if (!o.verbose && (a.kind === "think" || a.kind === "say")) break;
        const color = a.status === "ok" ? "green" : a.status === "denied" ? "yellow" : "red";
        line(`${paint(color, statusIcon(a.status))} ${activityText(a)}`, e.agent);
        break;
      }
      case "agent.retry":
        line(paint("yellow", `↻ retry ${e.attempt}/${e.max}: ${e.reason.split("\n")[0]}`), e.agent);
        break;
      case "gate.completed":
        line(`${e.passed ? paint("green", "✓") : paint("red", "✗")} gate ${e.name}${e.passed ? "" : ` (${e.exitCode === null ? "timeout" : `exit ${e.exitCode}`})`}`, "gates");
        break;
      case "message": {
        const m = e.message;
        line(paint("bold", messageHeadline(m)), m.from);
        const max = o.verbose ? m.items.length : 5;
        for (const item of m.items.slice(0, max)) out.write(`${INDENT}- ${item}\n`);
        if (m.items.length > max) out.write(`${INDENT}… ${m.items.length - max} more\n`);
        break;
      }
      case "step.completed": {
        const en = e.entry;
        const tail = [formatDuration(e.durationSec), usageText(e.costUsd, e.tokens)].filter(Boolean).join(" · ");
        const icon = en.kind === "warn" ? paint("yellow", "▲") : paint("green", "●");
        line(`${icon} ${en.status}: ${en.summary}${tail ? paint("dim", ` (${tail})`) : ""}`, en.agent.toLowerCase(), `${en.phase} r${en.round}`);
        break;
      }
      case "warning":
        out.write(`${paint("yellow", "warning: ")}${e.text}\n`);
        break;
      case "human.required": {
        const r = e.review;
        out.write(`${paint("yellow", `⚠ HUMAN_REVIEW needed (${r.reason}): `)}${r.message}\n`);
        for (const d of r.details) out.write(`    - ${d}\n`);
        out.write(`  Continue: ${cmd} resume ${e.runId} --decision resume|revise|abort [--note "..."]\n`);
        break;
      }
      case "run.finished":
        if (e.phase === "DONE") out.write(`${paint("green", "[DONE] quality gates passed and the review approved.")} Report: ${e.reportPath}\n`);
        else if (e.phase === "ABORTED") out.write(`${paint("yellow", "run aborted.")} Report: ${e.reportPath}\n`);
        else if (e.phase === "INTERRUPTED") out.write(`${paint("yellow", "stopped.")} Resume with: ${cmd} resume ${e.runId}\n`);
        else out.write(`  Report: ${e.reportPath}\n`);
        break;
      default:
        break;
    }
  });
}
