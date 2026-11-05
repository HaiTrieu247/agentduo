import { answerSummary, type ClarificationAnswer, type ClarificationQuestion, type ClarificationResponse } from "@agentduo/engine/clarification/clarification";
import { decisionCommand } from "@agentduo/engine/workflow/decisions";
import type { Activity, ClarificationDecider, Decider, DuoEvent, EventBus, PermissionAnswer, PermissionDecider } from "@agentduo/engine/events";
import {
  activityText, DISCUSSION_LINES, discussionAuthor, discussionOutcome, discussionStepText, firstLines, formatDuration, messageHeadline, modelText, permissionAnswerText, PROVIDERS, roleLabel,
  statusIcon, usageText, verdictText, budgetText,
} from "@agentduo/engine/format";

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

/** A question in lines, numbered for a terminal that cannot show a form: what the user types is in `parsePlainReply`. */
export function plainQuestionText(q: ClarificationQuestion, index: number, total: number): string {
  const lines = [`  ${total > 1 ? `Question ${index + 1} of ${total}` : "Question"}${q.header ? ` [${q.header}]` : ""}: ${q.question}`];
  q.options.forEach((o, i) => lines.push(`    ${i + 1}) ${o.label}${o.description ? ` — ${o.description}` : ""}`));
  lines.push(q.multiSelect
    ? "  Reply with numbers separated by commas (e.g. 1,3); add your own words after a |  (e.g. 1,3 | also X), or write only your own words."
    : "  Reply with a number, or write your own answer. (To answer with words that are only a number, start them with 'other:'.)");
  lines.push("  Enter alone = answer later.");
  return lines.join("\n");
}

/**
 * What one reply in a terminal means for one question: option numbers, the user's own words, or nothing yet. Words that are
 * not all option numbers are the user's own; `other:` forces them to be. Nothing is guessed: a number outside the options,
 * or several for a single-choice question, is an error to correct.
 */
export function parsePlainReply(q: ClarificationQuestion, reply: string):
  { kind: "answer"; optionIds: string[]; otherText: string | null } | { kind: "later" } | { kind: "error"; message: string } {
  const text = reply.trim();
  if (!text) return { kind: "later" };
  if (/^other:/i.test(text)) {
    const words = text.slice(text.indexOf(":") + 1).trim();
    return words ? { kind: "answer", optionIds: [], otherText: words } : { kind: "error", message: "write your own answer after 'other:'" };
  }
  const [head = "", ...rest] = q.multiSelect ? text.split("|") : [text];
  const tail = rest.join("|").trim();
  const tokens = head.split(",").map((t) => t.trim()).filter(Boolean);
  if (tokens.length && tokens.every((t) => /^\d+$/.test(t))) {
    const numbers = tokens.map(Number);
    const bad = numbers.find((n) => n < 1 || n > q.options.length);
    if (bad !== undefined) return { kind: "error", message: `${bad} is not one of the options (1 to ${q.options.length})` };
    if (new Set(numbers).size !== numbers.length) return { kind: "error", message: "an option is given twice" };
    if (!q.multiSelect && numbers.length > 1) return { kind: "error", message: "this question takes one answer" };
    return { kind: "answer", optionIds: numbers.map((n) => q.options[n - 1]!.id), otherText: tail || null };
  }
  // Not numbers: the user's own words (a multiple-choice question has no options mixed in without the numbers).
  return { kind: "answer", optionIds: [], otherText: text };
}

/**
 * The agents' questions in plain mode, for a terminal that can answer: one request at a time, each question printed with
 * numbered options. An empty reply is "later"; nothing is ever chosen for the user.
 */
export function plainClarificationDecider(ask: (question: string) => Promise<string>): ClarificationDecider {
  let queue: Promise<unknown> = Promise.resolve();
  const run = async ({ request }: { request: { questions: ClarificationQuestion[] } }, signal?: AbortSignal): Promise<ClarificationResponse> => {
    const answers: ClarificationAnswer[] = [];
    const total = request.questions.length;
    for (const [i, q] of request.questions.entries()) {
      let notice = "";
      for (;;) {
        if (signal?.aborted) return { kind: "defer" };
        const parsed = parsePlainReply(q, await ask(`${plainQuestionText(q, i, total)}\n${notice}  > `));
        if (parsed.kind === "later") return { kind: "defer" };
        if (parsed.kind === "error") {
          notice = `  (${parsed.message})\n`;
          continue;
        }
        answers.push({ questionId: q.id, optionIds: parsed.optionIds, otherText: parsed.otherText });
        break;
      }
    }
    return { kind: "answered", answers };
  };
  return {
    askClarification: (ask, signal) => {
      const next = queue.then(() => (signal?.aborted ? ({ kind: "defer" } as const) : run(ask, signal)));
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
  const asked = new Map<string, ClarificationQuestion[]>(); // an answer line names the questions it answers
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
          const by = discussionAuthor(e);
          const p = PROVIDERS[by];
          line(paint("bold", `${p.mark} Final answer · ${p.agent}`), by, "discuss");
          out.write(`${e.answer.trimEnd()}\n\n`);
        }
        break;
      }
      case "run.started":
        out.write(`${paint("bold", `agentduo ${o.version} · run ${e.runId}`)}\n  workspace: ${e.repo}\n  run dir: ${e.runDir}\n` +
          (e.profile && e.profile !== "standard" ? `  profile: ${e.profile}\n` : ""));
        break;
      case "phase.started":
        ctx = { agent: e.agent ?? "", where: `${e.phase} r${e.round}` };
        line(paint("cyan", `▶ ${e.role ? roleLabel(e.role) : e.phase.toLowerCase()}`) + (e.budget ? paint("dim", ` (${budgetText(e.budget)})`) : ""));
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
      case "clarification.requested": {
        const r = e.request;
        const who = r.role ? roleLabel(r.role) : r.agent;
        asked.set(r.id, r.questions);
        line(paint("cyan", `? asks you ${r.questions.length === 1 ? "a question" : `${r.questions.length} questions`}`), who);
        break;
      }
      case "clarification.answered": {
        const questions = asked.get(e.id);
        if (questions) line(paint("green", `→ answered: ${answerSummary({ questions, answers: e.answers, status: "answered" })}`));
        asked.delete(e.id);
        break;
      }
      case "clarification.closed":
        line(paint("yellow", e.status === "deferred" ? "→ to be answered later" : `→ ${e.status === "cancelled" ? "dismissed without an answer" : "interrupted before it was answered"}`));
        asked.delete(e.id);
        break;
      case "human.required": {
        const r = e.review;
        out.write(`${paint("yellow", `⚠ HUMAN_REVIEW needed (${r.reason}): `)}${r.message}\n`);
        for (const d of r.details) out.write(`    - ${d}\n`);
        out.write(`  Continue: ${decisionCommand(cmd, e.runId, r.reason)}\n`);
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
