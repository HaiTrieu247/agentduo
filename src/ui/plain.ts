import type { Activity, Decider, DuoEvent, EventBus, PermissionAnswer, PermissionDecider } from "../events.js";
import {
  activityText, DISCUSSION_LINES, discussionOutcome, discussionStepText, firstLines, formatDuration, messageHeadline, modelText, permissionAnswerText, PROVIDERS, roleLabel,
  statusIcon, usageText, verdictText,
} from "./format.js";

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

/**
 * Permission prompts in plain mode, for a terminal that can answer: one question at a time (an agent may ask for
 * several tools at once), and anything but a clear yes is a deny.
 */
export function plainPermissionDecider(ask: (question: string) => Promise<string>): PermissionDecider {
  let queue: Promise<unknown> = Promise.resolve();
  const answer = async (rules: string[]): Promise<PermissionAnswer> => {
    const choices = `[o]nce, ${rules.length ? "[a]lways, " : ""}[d]eny, deny with a [m]essage`;
    for (;;) {
      const reply = (await ask(`  Allow? ${choices} (Enter = deny): `)).trim().toLowerCase();
      if (reply === "o" || reply === "once") return { decision: "once" };
      if (rules.length && (reply === "a" || reply === "always")) return { decision: "always" };
      if (reply === "" || reply === "d" || reply === "deny") return { decision: "deny" };
      if (reply === "m" || reply === "message") {
        const message = (await ask("  Your message for the agent: ")).trim();
        return { decision: "deny", message: message || undefined };
      }
    }
  };
  return {
    askPermission: ({ request }, signal) => {
      const next = queue.then(() => (signal?.aborted ? { decision: "deny" as const } : answer(request.rules)));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

const CODES = { dim: 2, bold: 1, red: 31, green: 32, yellow: 33, cyan: 36 } as const;
const AGENT_WIDTH = 12; // fits "orchestrator"
const INDENT = " ".repeat(8 + 2 + AGENT_WIDTH + 1 + 16 + 1);

export function attachPlainRenderer(bus: EventBus, out: TextSink, o: PlainOptions): () => void {
  const paint = (c: keyof typeof CODES, s: string) => (o.color ? `\u001b[${CODES[c]}m${s}\u001b[0m` : s);
  const now = o.now ?? (() => new Date());
  const cmd = o.commandName ?? "duo";
  let ctx = { agent: "", where: "" };
  const rulesFor = new Map<string, string[]>(); // an answer line names the rules its request offered
  const clock = () => {
    const d = now();
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
  };
  const line = (text: string, agent = ctx.agent, where = ctx.where) => {
    out.write(`${paint("dim", clock())}  ${agent.padEnd(AGENT_WIDTH)} ${where.padEnd(16)} ${text}\n`);
  };
  const activity = (a: Activity, agent: string, where?: string) => {
    if (a.status === "running") return;
    if (!o.verbose && (a.kind === "think" || a.kind === "say")) return;
    const color = a.status === "ok" ? "green" : a.status === "denied" ? "yellow" : "red";
    line(`${paint(color, statusIcon(a.status))} ${activityText(a)}`, agent, where);
  };

  return bus.on((e: DuoEvent) => {
    switch (e.type) {
      case "turn.started": {
        const p = PROVIDERS[e.backend];
        const step = e.discussion ? ` · ${discussionStepText(e.discussion)}` : "";
        line(paint("cyan", `▶ ${p.mark} ${p.agent} (${p.company}) · model ${modelText(e.model)}${step}`), e.backend, e.discussion ? "discuss" : "chat");
        break;
      }
      case "turn.activity":
        // An answer's prose is printed whole when the turn ends; its stream lines would only repeat it.
        if (e.activity.kind !== "submit") activity(e.activity, e.backend, "chat");
        break;
      case "turn.finished": {
        const p = PROVIDERS[e.backend];
        const tail = [formatDuration(e.durationSec), usageText(e.costUsd, e.tokens)].filter(Boolean).join(" · ");
        const place = e.discussion;
        const step = place ? ` · ${discussionStepText(place)}${place.step === "critique" ? ` · ${verdictText(place.verdict)}` : ""}` : "";
        const head = `${p.mark} ${p.agent} (${p.company}) · model ${modelText(e.model)}${step}${tail ? paint("dim", ` (${tail})`) : ""}`;
        const where = place ? "discuss" : "chat";
        if (e.status === "success") {
          line(paint("bold", head), e.backend, where);
          // The answer as it is, not indented, so its paragraphs and code read and copy as written. A discussion's turn
          // shows its first lines: its final answer follows, whole.
          const text = place && !o.verbose ? firstLines(e.answer ?? "", DISCUSSION_LINES) : { shown: (e.answer ?? "").trimEnd(), more: 0 };
          out.write(`${text.shown}\n${text.more ? paint("dim", `… ${text.more} more line${text.more === 1 ? "" : "s"} (--verbose shows them)\n`) : ""}\n`);
        } else if (e.status === "interrupted") line(paint("yellow", `■ ${head}: stopped before it answered`), e.backend, where);
        else line(paint("red", `✗ ${head}: no answer: ${e.error ?? "the call failed"}`), e.backend, where);
        break;
      }
      case "discussion.started": {
        const n = e.maxRounds;
        line(paint("cyan", `▶ discussion: ${PROVIDERS[e.answerer].agent} answers, ${PROVIDERS[e.critic].agent} reviews (at most ${n} review${n === 1 ? "" : "s"})`), "", "discuss");
        break;
      }
      case "discussion.finished": {
        const tail = [formatDuration(e.durationSec), usageText(e.costUsd, e.tokens)].filter(Boolean).join(" · ");
        const mark = e.status === "agreed" ? paint("green", "✓") : e.status === "error" ? paint("red", "✗") : paint("yellow", e.status === "disputed" ? "▲" : "■");
        line(`${mark} ${paint("bold", `discussion: ${discussionOutcome(e)}`)}${tail ? paint("dim", ` (${tail})`) : ""}${e.error ? `: ${e.error}` : ""}`, "", "discuss");
        if (e.answer !== null) {
          const p = PROVIDERS[e.answerer];
          line(paint("bold", `${p.mark} Final answer · ${p.agent}`), e.answerer, "discuss");
          out.write(`${e.answer.trimEnd()}\n\n`);
        }
        break;
      }
      case "run.started":
        out.write(`${paint("bold", `agentduo ${o.version} · run ${e.runId}`)}\n  workspace: ${e.repo}\n  run dir: ${e.runDir}\n`);
        break;
      case "phase.started":
        ctx = { agent: e.agent ?? "", where: `${e.phase} r${e.round}` };
        line(paint("cyan", `▶ ${e.role ? roleLabel(e.role) : e.phase.toLowerCase()}`));
        break;
      case "agent.activity":
        activity(e.activity, e.agent);
        break;
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
      case "permission.requested": {
        const r = e.request;
        rulesFor.set(r.id, r.rules);
        line(paint("yellow", `⚠ asks to use ${r.tool}: ${r.label}`), e.agent);
        if (r.description) out.write(`${INDENT}${r.description}\n`);
        if (r.blockedPath) out.write(`${INDENT}path: ${r.blockedPath}\n`);
        if (r.rules.length) out.write(`${INDENT}always allow would save: ${r.rules.join(", ")}\n`);
        break;
      }
      case "permission.answered":
        line(paint(e.answer.decision === "deny" ? "yellow" : "green", `→ ${permissionAnswerText(e.answer, rulesFor.get(e.id) ?? [])}`), e.agent);
        rulesFor.delete(e.id);
        break;
      case "human.required": {
        const r = e.review;
        out.write(`${paint("yellow", `⚠ HUMAN_REVIEW needed (${r.reason}): `)}${r.message}\n`);
        for (const d of r.details) out.write(`    - ${d}\n`);
        out.write(`  Continue: ${cmd} resume ${e.runId} --decision resume|revise|abort [--note "..."]\n`);
        break;
      }
      case "run.finished":
        if (e.phase === "DONE") out.write(`${paint("green", `[DONE] ${e.summary ?? "finished"}.`)} Report: ${e.reportPath}\n`);
        else if (e.phase === "ABORTED") out.write(`${paint("yellow", "run aborted.")} Report: ${e.reportPath}\n`);
        else if (e.phase === "INTERRUPTED") out.write(`${paint("yellow", "stopped.")} Resume with: ${cmd} resume ${e.runId}\n`);
        else out.write(`  Report: ${e.reportPath}\n`);
        break;
      default:
        break;
    }
  });
}
