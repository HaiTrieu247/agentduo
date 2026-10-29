// What each agent's plan still lets it use, as the CLI's own usage screen shows it, read without calling a model:
// `claude -p /usage` prints Claude Code's /usage. Codex's /status lives only in its TUI (`codex exec "/status"` would
// ask the model), so its app server is asked instead, as Codex's IDE extension does: `account/read` and
// `account/rateLimits/read` over JSON-RPC on stdio. The app server exits as soon as its stdin closes, so stdin stays
// open until both have answered.
import { runProcess, type ChildIO } from "../agents/process.js";
import { resolveBinary } from "../agents/resolve.js";
import { packageVersion } from "../paths.js";
import type { ConfigData } from "./config.js";
import { codexDoctorArgs } from "./models.js";

/** Each CLI gets this long to answer; then its part of the report says so. */
export const USAGE_TIMEOUT_MS = 15_000;

export interface UsageLimit {
  label: string;
  /** 0 to 100. */
  usedPercent: number;
  /** When it resets, as the CLI says it; null when it does not. */
  resets: string | null;
}

export interface UsageGroup {
  /** null: the account's own limits; otherwise what else has limits of its own (a model). */
  title: string | null;
  limits: UsageLimit[];
}

export interface AgentUsage {
  /** The account, as the CLI names it ("subscription", "ChatGPT Plus · a@b.c"); null when it does not say. */
  account: string | null;
  groups: UsageGroup[];
  /** What else the CLI says about the account (credits, a limit reached), or all it printed when that had no limits. */
  notes: string[];
  /** The rest of what it printed, as printed: Claude's "What's contributing to your limits usage?". */
  details: { title: string; lines: string[] } | null;
}

export type UsageState = { status: "loading" } | { status: "ready"; usage: AgentUsage } | { status: "error"; error: string };

export interface UsageReport {
  /** Each /usage (or refresh) has its own: a view opens its panel for a new one and updates it for the same one. */
  id: number;
  claude: UsageState;
  codex: UsageState;
}

export interface UsageOptions {
  cfg: ConfigData;
  workspace: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** For reset times (Codex gives timestamps); default: this process's. */
  timeZone?: string;
}

const firstLine = (text: string) => text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
const failed = (what: string, r: { code: number | null; stderr: string; stdout: string }) => {
  const said = firstLine(r.stderr) || firstLine(r.stdout);
  return `${what} failed (exit code ${r.code})${said ? `: ${said}` : ""}`;
};
const seconds = (ms: number) => `${Math.round(ms / 100) / 10}s`;

// ------------------------------------------------------------------ Claude
const ACCOUNT = /^You are currently using your (.+?) to power your Claude Code usage\.?$/;
const LIMIT = /^(\S.*?):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*(.+))?$/;

/**
 * Claude Code's /usage: the account line, a block of "<limit>: N% used · resets …" lines, then the rest (what
 * contributes to the usage), kept as printed. Text without any limit line is kept whole, as notes.
 */
export function claudeUsage(stdout: string): AgentUsage {
  const lines = stdout.replace(/\r/g, "").split("\n").map((l) => l.trimEnd());
  const trim = (list: string[]) => {
    const from = list.findIndex(Boolean);
    return from < 0 ? [] : list.slice(from, list.findLastIndex(Boolean) + 1);
  };
  const first = lines.findIndex((l) => LIMIT.test(l));
  if (first < 0) return { account: null, groups: [], notes: trim(lines), details: null };
  let account: string | null = null;
  const notes: string[] = [];
  for (const line of lines.slice(0, first).filter(Boolean)) {
    const m = ACCOUNT.exec(line);
    if (m && !account) account = m[1]!;
    else notes.push(line);
  }
  const limits: UsageLimit[] = [];
  let end = first;
  for (; end < lines.length; end++) {
    const m = LIMIT.exec(lines[end]!);
    if (!m) break;
    const resets = m[3]?.trim() ?? null;
    limits.push({ label: m[1]!, usedPercent: Number(m[2]), resets: resets ? resets.charAt(0).toUpperCase() + resets.slice(1) : null });
  }
  const rest = trim(lines.slice(end));
  return { account, groups: [{ title: null, limits }], notes, details: rest.length ? { title: rest[0]!, lines: rest.slice(1) } : null };
}

export async function readClaudeUsage(o: UsageOptions): Promise<UsageState> {
  const bin = resolveBinary(o.cfg.claude.bin, "claude", o.env);
  if (!bin) return { status: "error", error: "claude CLI not found" };
  const timeoutMs = o.timeoutMs ?? USAGE_TIMEOUT_MS;
  try {
    const r = await runProcess(bin, ["-p", "/usage"], { cwd: o.workspace, env: o.env, timeoutMs, signal: o.signal, killGraceMs: 500, maxBufferChars: 1024 * 1024 });
    if (r.aborted) return { status: "error", error: "stopped" };
    if (r.timedOut) return { status: "error", error: `claude -p /usage did not answer within ${seconds(timeoutMs)}` };
    if (r.code !== 0) return { status: "error", error: failed("claude -p /usage", r) };
    return { status: "ready", usage: claudeUsage(r.stdout) };
  } catch (e) {
    return { status: "error", error: `cannot run claude: ${(e as Error).message}` };
  }
}

// ------------------------------------------------------------------ Codex
/** An answer of the app server: its result, or the message of its error. */
export type RpcReply = { result: unknown } | { error: string };

export interface CodexAnswers {
  account: RpcReply;
  rateLimits: RpcReply;
}

const PLANS: Record<string, string> = { prolite: "Pro Lite", promax: "Pro Max", edu_plus: "Edu Plus", edu_pro: "Edu Pro", sci_plus: "Sci Plus" };
const planName = (plan: string) => PLANS[plan] ?? plan.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

const REACHED: Record<string, string> = {
  rate_limit_reached: "You have reached a usage limit.",
  workspace_owner_credits_depleted: "Your workspace is out of credits.",
  workspace_member_credits_depleted: "Your workspace is out of credits.",
  workspace_owner_usage_limit_reached: "Your workspace has reached its usage limit.",
  workspace_member_usage_limit_reached: "Your workspace has reached its usage limit.",
};

/** A window's name as Codex's /status gives it: "5h limit", "Weekly limit". */
function windowLabel(mins: unknown): string {
  if (typeof mins !== "number" || mins <= 0) return "Limit";
  if (mins < 60) return `${mins}m limit`;
  if (mins <= 24 * 60 + 3) return `${Math.round(mins / 60)}h limit`;
  if (mins <= 7 * 24 * 60 + 3) return "Weekly limit";
  if (mins <= 31 * 24 * 60) return "Monthly limit";
  return "Annual limit";
}

/** "Resets Nov 4 at 1:41pm", as Claude's /usage says it (":00" left out). */
export function resetText(epochSec: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone })
    .formatToParts(new Date(epochSec * 1000));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const minute = part("minute");
  return `Resets ${part("month")} ${part("day")} at ${part("hour")}${minute === "00" ? "" : `:${minute}`}${part("dayPeriod").toLowerCase()}`;
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

function limitsOf(snapshot: Record<string, any>, timeZone?: string): UsageLimit[] {
  return [snapshot.primary, snapshot.secondary].filter(isObj).map((w) => ({
    label: windowLabel(w.windowDurationMins),
    usedPercent: Number.isFinite(w.usedPercent) ? w.usedPercent : 0,
    resets: Number.isFinite(w.resetsAt) ? resetText(w.resetsAt, timeZone) : null,
  }));
}

/** The account and its limits, as Codex's /status shows them: one group per bucket, Codex's own first. */
export function codexUsage(answers: CodexAnswers, timeZone?: string): UsageState {
  const read = "result" in answers.account && isObj(answers.account.result) ? answers.account.result : null;
  if (!read) return { status: "error", error: `Codex could not read its account: ${"error" in answers.account ? answers.account.error : "no answer"}` };
  const account = isObj(read.account) ? read.account : null;
  if (!account) return { status: "error", error: "Codex is not signed in: run codex login" };
  const name = account.type === "chatgpt"
    ? ["ChatGPT" + (typeof account.planType === "string" ? ` ${planName(account.planType)}` : ""), account.email].filter(Boolean).join(" · ")
    : account.type === "apiKey" ? "API key" : account.type === "amazonBedrock" ? "Amazon Bedrock" : String(account.type ?? "unknown account");
  const usage: AgentUsage = { account: name, groups: [], notes: [], details: null };
  if ("error" in answers.rateLimits || !isObj(answers.rateLimits.result)) {
    usage.notes.push(account.type === "chatgpt"
      ? `Codex could not read its limits: ${"error" in answers.rateLimits ? answers.rateLimits.error : "no answer"}`
      : `Codex signs in with ${account.type === "apiKey" ? "an API key" : name}: there are no plan limits to show.`);
    return { status: "ready", usage };
  }
  const limits = answers.rateLimits.result;
  const main = isObj(limits.rateLimits) ? limits.rateLimits : {};
  const buckets = isObj(limits.rateLimitsByLimitId) ? Object.values(limits.rateLimitsByLimitId).filter(isObj) : [];
  const own = (b: Record<string, any>) => b.limitId === (main.limitId ?? "codex");
  const groups = buckets.length ? [...buckets.filter(own), ...buckets.filter((b) => !own(b))] : [main];
  usage.groups = groups
    .map((b) => ({ title: own(b) || !buckets.length ? null : String(b.limitName ?? b.limitId ?? "other"), limits: limitsOf(b, timeZone) }))
    .filter((g) => g.limits.length);
  const credits = isObj(main.credits) ? main.credits : null;
  if (credits?.unlimited) usage.notes.push("Credits: unlimited");
  else if (credits?.hasCredits && credits.balance) usage.notes.push(`Credits: ${credits.balance}`);
  if (typeof main.rateLimitReachedType === "string") usage.notes.push(REACHED[main.rateLimitReachedType] ?? main.rateLimitReachedType.replace(/_/g, " "));
  else if (limits.ordinaryUsageAllowed === false) usage.notes.push("Codex may not use its plan right now.");
  if (main.spendControlReached === true) usage.notes.push("The workspace's spend limit is reached.");
  return { status: "ready", usage };
}

/** Asks the app server for the account and its limits; null replies mean it never answered (see the result). */
async function askAppServer(bin: string, args: string[], o: UsageOptions, timeoutMs: number) {
  const replies: Partial<Record<number, RpcReply>> = {};
  let io: ChildIO | null = null;
  const send = (message: object) => io?.write(`${JSON.stringify(message)}\n`);
  const r = await runProcess(bin, ["app-server", ...args], {
    cwd: o.workspace, env: o.env, timeoutMs, signal: o.signal, killGraceMs: 500, maxBufferChars: 1024 * 1024, holdStdin: true,
    onSpawn: (child) => {
      io = child;
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "agentduo", title: "agentduo", version: packageVersion() }, capabilities: null } });
    },
    onStdoutLine: (line) => {
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        return; // not a JSON-RPC message
      }
      if (!isObj(m) || typeof m.id !== "number" || m.id in replies) return;
      replies[m.id] = "error" in m ? { error: String(m.error?.message ?? "an error") } : { result: m.result };
      if (m.id === 1) {
        if ("error" in replies[1]!) return io?.end();
        send({ method: "initialized" });
        send({ id: 2, method: "account/read", params: { refreshToken: false } });
        send({ id: 3, method: "account/rateLimits/read" });
      }
      if (replies[2] && replies[3]) io?.end();
    },
  });
  return { r, replies };
}

export async function readCodexUsage(o: UsageOptions): Promise<UsageState> {
  const bin = resolveBinary(o.cfg.codex.bin, "codex", o.env);
  if (!bin) return { status: "error", error: "codex CLI not found" };
  const timeoutMs = o.timeoutMs ?? USAGE_TIMEOUT_MS;
  try {
    const { r, replies } = await askAppServer(bin, codexDoctorArgs(o.cfg.codex.args), o, timeoutMs);
    if (r.aborted) return { status: "error", error: "stopped" };
    if (r.timedOut) return { status: "error", error: `codex app-server did not answer within ${seconds(timeoutMs)}` };
    const init = replies[1];
    if (init && "error" in init) return { status: "error", error: `codex app-server refused to start: ${init.error}` };
    if (!replies[2] || !replies[3]) return { status: "error", error: failed("codex app-server", r) };
    return codexUsage({ account: replies[2], rateLimits: replies[3] }, o.timeZone);
  } catch (e) {
    return { status: "error", error: `cannot run codex: ${(e as Error).message}` };
  }
}
