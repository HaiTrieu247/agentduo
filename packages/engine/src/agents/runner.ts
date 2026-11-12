import { randomUUID } from "node:crypto";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IMAGE_MEDIA_TYPES, selectNative, type Attachment } from "../inputs/attachment-types.js";
import { AttachmentError, existingAttachmentFile } from "../inputs/attachments.js";
import {
  answerErrors, clarificationSection, cleanAnswers, openEntry, type ClarificationEntry, type ClarificationRequest, type ClarificationResponse,
} from "../clarification/clarification.js";
import type { AgentRole, Backend, ConfigData } from "../config/config.js";
import type { CallProfile } from "../team/config.js";
import type { Activity, CallContext, ClarificationDecider, EventBus, Party, PermissionAnswer, PermissionDecider, Role } from "../events.js";
import { ClaudeBackend } from "./claude.js";
import { CodexBackend } from "./codex.js";
import { runProcess, type ChildIO, type RunResult } from "./process.js";
import { validateOutput, type SchemaName } from "./schema.js";
import { AgentFailure, BinaryNotFound, type AgentBackend, type AgentMeta, type ClarificationReply, type NativeImage, type ParsedEvent } from "./types.js";

/**
 * The files attached to what the call answers. Its prompt already lists them with their paths (prompts.ts does); the
 * runner checks their copies before each attempt and sends the images the backend takes as images too.
 */
interface WithAttachments {
  attachments?: Attachment[];
}

/** What every structured call has: its final message must match `schemaName` (and `check`), with retries. */
interface StructuredBase extends WithAttachments {
  mode?: "structured";
  prompt: string;
  schemaName: SchemaName;
  logPrefix: string;
  check?: (data: any) => string[];
  signal?: AbortSignal;
  /** The workspace may be in no git repository (its snapshots are agentduo's own): Codex must start there anyway. */
  skipGitRepoCheck?: boolean;
  /** The role's CLI session; absent: a session of its own that is not kept. */
  session?: CallSession;
  /** The run's budget, consulted before every attempt; absent: none. */
  budget?: CallBudget;
}

/** A pipeline role's call. */
export interface StructuredCall extends StructuredBase {
  role: Role;
  agentRole: AgentRole;
  member?: undefined;
}

/**
 * A team member's call (packages/engine/src/team): the member's CLI with its model, effort and args, run in the member's
 * worktree, its events naming the member. A member never asks the user: its questions go to the techlead, in its output.
 */
export interface MemberCall {
  name: string;
  /** The task it works on, which its events carry; null for a turn about no task (the PM's, a plan). */
  task: string | null;
  backend: Backend;
  profile: CallProfile;
  /** Where the CLI runs: the member's copy of the workspace. */
  cwd: string;
}

export interface MemberStructuredCall extends StructuredBase {
  member: MemberCall;
  role?: undefined;
  agentRole?: undefined;
}

/** What a pipeline run may still spend, asked before each attempt of a call with what the call used so far. */
export interface CallBudget {
  /**
   * Why no further attempt may start (a limit of the run reached); null when one may. `waitedSec`: the seconds this call
   * has spent waiting for the user, which are not work.
   */
  stop(call: { tokens: number; costUsd: number; calls: number; waitedSec: number }): string | null;
  /** The most the next attempt may cost, for a CLI that caps a call itself (Claude's --max-budget-usd); null: no cap. */
  costCap(callCostUsd: number): number | null;
}

/**
 * keep: leave the call's session on disk, for the role's next call to continue. resume: continue that session first,
 * with a prompt that gives only what changed (and the files it was not given yet). A resumed attempt that fails (the
 * CLI lost the session, or its answer is unusable) is followed by a fresh session with the whole `prompt` and its
 * `attachments`, which keeps every attempt of its own.
 */
export interface CallSession {
  keep: boolean;
  resume?: { id: string; prompt: string; attachments?: Attachment[] };
}

/**
 * A conversation turn: `backend` answers in prose; no schema, no role, one attempt (the user asks again if it fails).
 * A continued session that fails is asked again once in a new one, with the whole prompt, which a warning says; not
 * after a timeout or silence: a CLI that hangs has not lost its session, and a new one would make the user wait again.
 */
export interface TextCall extends WithAttachments {
  mode: "text";
  backend: Backend;
  prompt: string;
  logPrefix: string;
  conversationId: string;
  turnId: string;
  session?: CallSession;
  signal?: AbortSignal;
}

export type CallOptions = StructuredCall | MemberStructuredCall | TextCall;

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
  /** The CLI session the last attempt ran in (what a later call can resume), when the CLI named it. */
  sessionId: string | null;
  /** The answer came from the session the call continued, not from a fresh one. */
  resumed: boolean;
  /** CLI processes the call started (every attempt that ran, also one that failed). */
  calls: number;
  /** Of those, the ones whose CLI reported no cost (every Codex call): `costUsd` does not include them. */
  unpricedCalls: number;
  /** The run's budget stopped the call before an attempt: why. */
  budgetStop: string | null;
  /** Every answer agentduo rejected (not JSON, or failing the schema or the role's check), by attempt; empty for a text call. */
  rejections: Rejection[];
  /** Seconds the call waited for the user (permission prompts and questions, together, never counted twice): not work. */
  waitedSec: number;
}

/** An answer agentduo rejected, and why: the next attempt is told, also when it runs in a fresh session. */
export interface Rejection {
  attempt: number;
  errors: string[];
}

/** The longest rejected answer a retry is shown again, to correct it rather than redo it. */
const MAX_REJECTED_CHARS = 20_000;

/**
 * What a retry is told about the answer agentduo rejected: exactly what to correct, and the answer itself (when it was
 * JSON and not too long), so that it corrects that answer instead of redoing the work. Only the role's own answer and
 * agentduo's reasons: nothing of another agent's. `unseen`: the retry runs in a session that never saw that answer.
 */
export function rejectionNote(errors: string[], answer: unknown, unseen: boolean): string {
  const json = answer == null ? null : JSON.stringify(answer, null, 2);
  const shown = json == null ? ""
    : json.length > MAX_REJECTED_CHARS
      ? `\nYour rejected answer is ${json.length} characters long, too long to repeat here: give it again with these corrections.\n`
      : `\nYour rejected answer:\n\`\`\`\`json\n${json}\n\`\`\`\`\n`;
  return `\n\n## Your previous answer was rejected\nagentduo checked your previous answer to this request${unseen ? ", given in a session you cannot see," : ""} ` +
    `and rejected it:\n${errors.map((e) => `- ${e}`).join("\n")}\n` +
    "Correct exactly these points. Keep the rest of the answer as it was, unless a correction needs a change elsewhere: there is no need to redo " +
    "the work. Return the whole corrected answer as a single JSON object that matches the required schema.\n" + shown;
}

/** An error's first line, short enough for a warning. */
const brief = (error: string) => {
  const line = error.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
};

const sameErrors = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((e, i) => e === [...b].sort()[i]);

export interface RunnerOptions {
  backends?: Record<"codex" | "claude", AgentBackend>;
  /** Who answers permission prompts; absent when nobody can (CI, background), so prompts are denied by the CLI. */
  permissions?: PermissionDecider;
  /** Who answers an agent's structured questions; absent when nobody can, so Claude is not offered the question tool. */
  clarifications?: ClarificationDecider;
  /** Where attachments' copies are (their paths are relative to it); needed only by calls with attachments. */
  runsDir?: string;
}

type PermissionEvent = Extract<ParsedEvent, { type: "permission" }>;
type QuestionEvent = Extract<ParsedEvent, { type: "question" }>;

/** The time a call waited for the user, with overlapping waits counted once. */
class HumanWaits {
  ms = 0;
  private open = 0;
  private since = 0;

  start(): void {
    if (this.open++ === 0) this.since = Date.now();
  }

  end(): void {
    if (this.open > 0 && --this.open === 0) this.ms += Date.now() - this.since;
  }

  /** The attempt is over: whatever still waits stops counting. */
  close(): void {
    if (this.open > 0) {
      this.open = 0;
      this.ms += Date.now() - this.since;
    }
  }
}

/** What answering the host-mode requests of one attempt needs. */
interface Attempt {
  channel: Channel;
  /** Aborted when the call is interrupted, when a question is deferred, and when the attempt is over. */
  signal: AbortSignal;
  agent: Party;
  backend: AgentBackend;
  io: ChildIO;
  callId: string;
  answersLog: string;
  waits: HumanWaits;
  /** Every question the user answered in any attempt of this call so far, which a later attempt's new session never saw. */
  answered: ClarificationEntry[];
  /** Ends the call: the user would answer later, and a CLI process cannot wait for that. */
  stopCall(): void;
  /** A team member's call, whose questions never reach the user. */
  member: boolean;
}

const NO_QUESTIONS = "The user cannot be asked questions in this run. Decide from the repository, state the assumption you made in your report, and continue.";
const DISMISSED = "The user dismissed the question without answering. Do not assume an answer: continue without it, and say in your report what you could not decide.";
const PROMPTS_OFF = "This tool call needs a permission, and permission prompts are off (claude.permission_prompts: deny). Do not retry it; continue without it and say so in your report.";
const MEMBER_QUESTIONS = "You cannot ask the user: in this team only the PM talks to the user. Finish your turn and put your question in your result (a blocked result with one precise question); it goes to the techlead.";

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
  private readonly clarifications?: ClarificationDecider;
  private readonly runsDir?: string;
  /** Images already said to go only as paths, so each call of a run does not say it again. */
  private readonly warned = new Set<string>();

  constructor(private readonly cfg: ConfigData, private readonly repo: string, private readonly logDir: string,
    private readonly bus: EventBus, o: RunnerOptions = {}) {
    this.backends = o.backends ?? { codex: new CodexBackend(cfg.codex, repo), claude: new ClaudeBackend(cfg.claude, repo) };
    this.permissions = o.permissions;
    this.clarifications = o.clarifications;
    this.runsDir = o.runsDir;
  }

  /**
   * The copies of a call's attachments, as they are now, and the images it sends as images; an error when a copy is
   * gone (nothing is sent then: the agent would read a path that does not exist).
   */
  private located(backend: AgentBackend, attachments: Attachment[]): { files: Map<string, string>; images: NativeImage[] } | string {
    if (!attachments.length) return { files: new Map(), images: [] };
    if (!this.runsDir) return "the call has attachments but agentduo does not know where their copies are";
    const files = new Map<string, string>();
    try {
      for (const a of attachments) files.set(a.id, existingAttachmentFile(this.runsDir, a));
    } catch (e) {
      if (e instanceof AttachmentError) return e.message;
      throw e;
    }
    const { native } = selectNative(backend.name, attachments);
    return { files, images: native.map((a) => ({ file: files.get(a.id)!, mediaType: IMAGE_MEDIA_TYPES[a.image!.format] })) };
  }

  /** Says, before the call and once per image, which images go to this backend as paths only, and why. */
  private warnFallback(backend: AgentBackend, attachments: Attachment[]): void {
    const name = backend.name === "codex" ? "Codex" : "Claude";
    for (const { attachment, reason } of selectNative(backend.name, attachments).fallback) {
      const key = `${backend.name} ${attachment.id} ${reason}`;
      if (this.warned.has(key)) continue;
      this.warned.add(key);
      this.bus.emit({ type: "warning", text: `${attachment.name} goes to ${name} as a file to read, not as an image: ${reason}.` });
    }
  }

  /** Whether permission prompts go to the user: someone can answer and the config asks for it. */
  private asksPermissions(backend: AgentBackend): boolean {
    return !!this.permissions && backend.name === "claude" && this.cfg.claude.permission_prompts === "ask" && !!backend.permissionReply;
  }

  /**
   * Whether the agent's structured questions go to the user: someone can answer and the config allows it. Independent of
   * permissions. A team member's never do (it asks the techlead in its output).
   */
  private asksQuestions(backend: AgentBackend, member = false): boolean {
    return !member && !!this.clarifications && backend.name === "claude" && this.cfg.clarification?.enabled !== false && !!backend.clarificationReply;
  }

  /**
   * Host mode: the backend relays its requests to agentduo, which answers each, because the user can answer permission
   * prompts or questions. It is a transport only: what a request may do stays with the config that allows it, so with
   * only the questions on, every permission prompt is still denied as the CLI itself would.
   */
  private hosts(backend: AgentBackend, member = false): boolean {
    return backend.name === "claude" && !!backend.hostInput && !!backend.permissionReply && (this.asksPermissions(backend) || this.asksQuestions(backend, member));
  }

  /** Writes the answer to a request on the CLI's stdin, and keeps it in the call's log. */
  private send(a: Attempt, reply: string): void {
    appendFileSync(a.answersLog, reply);
    a.io.write(reply);
  }

  /** Asks the user while the agent's clocks are stopped, then answers on its stdin. */
  private async answerPermission(ev: PermissionEvent, a: Attempt, deniedByUser: Set<string>): Promise<void> {
    const { channel, agent, backend } = a;
    if (!this.asksPermissions(backend)) {
      // Host mode only for the questions: a tool that needs permission is denied, as the CLI does with permission prompts off.
      this.send(a, backend.permissionReply!(ev.raw, { decision: "deny", message: PROMPTS_OFF }));
      return;
    }
    this.bus.emit({ type: "permission.requested", ...channel.context, agent, request: ev.request });
    a.io.pause();
    a.waits.start();
    let answer: PermissionAnswer;
    try {
      answer = await this.permissions!.askPermission({ ...channel.context, agent, request: ev.request }, a.signal);
    } catch {
      answer = { decision: "deny" };
    } finally {
      a.waits.end();
      a.io.resume();
    }
    if (answer.decision === "deny" && typeof ev.raw.tool_use_id === "string") deniedByUser.add(ev.raw.tool_use_id);
    this.send(a, backend.permissionReply!(ev.raw, answer));
    this.bus.emit({ type: "permission.answered", ...channel.context, agent, id: ev.request.id, answer });
  }

  /**
   * Claude's question, asked to the user while the agent's clocks are stopped; the answer goes back in the same turn.
   * Nothing is chosen for the user: a dismissed question, or one nobody can answer, is refused with the reason. A question
   * the user would answer later (defer) ends the call, since the CLI cannot wait across a restart; it is recorded interrupted.
   */
  private async answerQuestion(ev: QuestionEvent, a: Attempt): Promise<void> {
    const { channel, agent, backend } = a;
    const reply = (r: ClarificationReply) => this.send(a, backend.clarificationReply!(ev.raw, r));
    if (a.member) return reply({ deny: MEMBER_QUESTIONS });
    if (!this.asksQuestions(backend)) return reply({ deny: NO_QUESTIONS });
    if (!ev.questions) {
      return reply({ deny: `agentduo could not show this question to the user (${ev.error ?? "malformed"}). Ask again with at most 4 questions that each have 2 to 6 distinct options, or continue without asking.` });
    }
    const request: ClarificationRequest = {
      id: `clq-${randomUUID().replaceAll("-", "").slice(0, 12)}`, source: "claude", callId: a.callId, agent: "claude", ...channel.context,
      questions: ev.questions, at: new Date().toISOString(),
    };
    const closed = (status: "cancelled" | "interrupted") => this.bus.emit({ type: "clarification.closed", id: request.id, callId: request.callId, status });
    this.bus.emit({ type: "clarification.requested", request });
    a.io.pause();
    a.waits.start();
    let response: ClarificationResponse;
    // Whoever answers is told to stop when the call ends, but the call does not depend on it: its end settles the question here.
    let onAbort: (() => void) | undefined;
    const ended = new Promise<ClarificationResponse>((resolve) => {
      if (a.signal.aborted) return resolve({ kind: "defer" });
      onAbort = () => resolve({ kind: "defer" });
      a.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      response = await Promise.race([this.clarifications!.askClarification({ request }, a.signal), ended]);
    } catch {
      response = { kind: "defer" };
    } finally {
      if (onAbort) a.signal.removeEventListener("abort", onAbort);
      a.waits.end();
      a.io.resume();
    }
    // The call ended (interrupted, or the CLI exited) while it waited: nothing is written to a process that is going away.
    if (a.signal.aborted || response.kind === "defer") {
      closed("interrupted");
      if (!a.signal.aborted) a.stopCall();
      return;
    }
    if (response.kind === "cancelled") {
      closed("cancelled");
      return reply({ deny: DISMISSED });
    }
    if (answerErrors(request.questions, response.answers).length) {
      closed("cancelled");
      return reply({ deny: "The answers did not match the questions, so none was given. Do not assume an answer; continue without it, or ask again." });
    }
    const answers = cleanAnswers(request.questions, response.answers);
    // Saved before it is sent, so an answer given is never lost to a call that ends right after.
    this.bus.emit({ type: "clarification.answered", id: request.id, callId: request.callId, answers });
    // And kept for the call: if this attempt fails, the attempt that follows runs in a session that never heard it (see earlierAnswers).
    a.answered.push({ ...openEntry(request, a.answered.length + 1), status: "answered", answers, closedAt: new Date().toISOString() });
    reply({ questions: request.questions, answers });
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
    if (o.member) {
      const { name: member, task } = o.member;
      return {
        context: { member },
        activity: (activity) => this.bus.emit({ type: "team.activity", member, task, agent, activity }),
        usage: (costUsd, tokens) => this.bus.emit({ type: "team.usage", member, agent, costUsd, tokens }),
        model: (model) => this.bus.emit({ type: "team.model", member, model }),
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
    const member = o.mode !== "text" && o.member ? o.member : null;
    const backend = this.backends[o.mode === "text" ? o.backend : member ? member.backend : this.cfg.agents[o.agentRole!]];
    const agent: Party = backend.name;
    const channel = this.channel(o, agent);
    const resume = o.session?.resume;
    // A resumed first attempt comes on top of the fresh attempts, so a lost session never costs a retry.
    const attemptsAllowed = (text ? 1 : this.cfg.limits.max_retries + 1) + (resume ? 1 : 0);
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
    // The last answer agentduo rejected, which the next attempt is told about (also a fresh session after a continued one).
    let rejected: { errors: string[]; answer: unknown } | null = null;
    const rejections: Rejection[] = [];
    let resuming: CallSession["resume"];
    let calls = 0;
    let priced = 0;
    const waits = new HumanWaits();
    // What the user answered to Claude's questions during this call's attempts. The prompt was built before any of it existed, so a
    // retry, or the fresh session after a continued one, gets it here: the session that finally answers must have all of it.
    const answered: ClarificationEntry[] = [];
    const earlierAnswers = () => (answered.length
      ? `\n${clarificationSection(answered, "## What the user already answered during an earlier attempt of this request\nAn earlier attempt asked the user these questions, and this session did not see the answers. Do not ask them again.")}`
      : "");
    const finish = (ok: boolean, attempts: number, data: unknown, error: string | null, interrupted = false, budgetStop: string | null = null): AgentResult => ({
      ok, data, error, attempts, durationSec: (Date.now() - started) / 1000,
      costUsd: costSeen ? cost : null, tokens: tokensSeen ? tokens : null, meta, backend: backend.name, interrupted, model,
      sessionId: meta.sessionId ?? null, resumed: ok && !!resuming, calls, unpricedCalls: calls - priced, budgetStop, rejections,
      waitedSec: waits.ms / 1000,
    });
    const budget = o.mode === "text" ? undefined : o.budget;

    this.warnFallback(backend, o.attachments ?? []);
    for (let attempt = 1; attempt <= attemptsAllowed; attempt++) {
      // The run's budget comes before every attempt: a retry or a fresh session after a lost one is a call too.
      const stop = budget?.stop({ tokens, costUsd: cost, calls, waitedSec: waits.ms / 1000 }) ?? null;
      if (stop) return finish(false, attempt - 1, null, stop, false, stop);
      resuming = attempt === 1 ? resume : undefined;
      // The fresh session after a resumed attempt never saw that attempt: a lost session needs no note, but an answer
      // agentduo rejected does, or the new session would repeat it.
      const fellBack = attempt === 2 && !!resume;
      if (fellBack) {
        // A conversation turn shows no retries: the second call, and why, would go unseen.
        if (text) {
          this.bus.emit({
            type: "warning",
            text: `${backend.name === "codex" ? "Codex" : "Claude"} could not answer in this conversation's session (${brief(lastError ?? "no answer")}), so it is ` +
              "asked again in a new one, with the whole conversation.",
          });
        }
        lastError = rejected
          ? `the continued session's answer was rejected (${lastError}); starting a new one, told why`
          : `the earlier session could not be continued (${lastError ?? "no answer"}); starting a new one`;
      }
      if (attempt > 1 && o.mode !== "text") {
        if (member) this.bus.emit({ type: "team.retry", member: member.name, agent, attempt, max: attemptsAllowed, reason: lastError ?? "" });
        else this.bus.emit({ type: "agent.retry", role: o.role!, agent, attempt, max: attemptsAllowed, reason: lastError ?? "" });
      }
      const stem = join(this.logDir, `${prefix}.a${attempt}`);
      // Only a new session needs them: a continued one (attempt 1, nothing answered yet) already holds its own conversation.
      const base = o.prompt + earlierAnswers();
      const prompt = resuming
        ? resuming.prompt
        : rejected
          ? base + rejectionNote(rejected.errors, rejected.answer, fellBack)
          : lastError && !fellBack
            ? `${base}\n\n## Previous attempt was rejected by the orchestrator\n${lastError}\nReturn ONLY a JSON object that matches the required schema exactly.\n`
            : base;
      // A resumed session already has the files of its earlier turns: it gets only the ones it was not given.
      const attachments = resuming ? resuming.attachments ?? [] : o.attachments ?? [];
      const lastMessageFile = `${stem}.last.${text ? "md" : "json"}`;
      const host = this.hosts(backend, !!member);
      // Checked before every attempt: a copy removed meanwhile fails the call before it starts.
      const located = this.located(backend, attachments);
      if (typeof located === "string") return finish(false, attempt, null, located);
      const { images } = located;
      // Stream input carries the images (Claude); a backend without it takes them as arguments (Codex).
      const stream = host || (images.length > 0 && !!backend.hostInput);
      let binary: string;
      let args: string[];
      try {
        binary = backend.binary();
        args = o.mode === "text"
          ? backend.buildArgs({ mode: "text", lastMessageFile, askPermissions: host, images,
            ...(o.session ? { session: { keep: o.session.keep, ...(resuming ? { resume: resuming.id } : {}) } } : {}),
          })
          : backend.buildArgs({
            schemaName: o.schemaName, lastMessageFile, askPermissions: host, images, skipGitRepoCheck: o.skipGitRepoCheck,
            ...(member ? { profile: member.profile, cwd: member.cwd } : { role: o.agentRole! }),
            ...(o.session ? { session: { keep: o.session.keep, ...(resuming ? { resume: resuming.id } : {}) } } : {}),
            ...(budget?.costCap(cost) != null ? { costCap: budget.costCap(cost)! } : {}),
          });
      } catch (e) {
        if (e instanceof BinaryNotFound) return finish(false, attempt, null, e.message);
        throw e;
      }
      rmSync(lastMessageFile, { force: true }); // never let Codex's previous answer stand in for this one
      // The prompt as the agent gets it; the images it got as images are listed beside it, never their bytes.
      writeFileSync(`${stem}.prompt.md`, prompt);
      if (attachments.length) {
        const sent = new Set(images.map((i) => i.file));
        writeFileSync(`${stem}.attachments.json`, JSON.stringify(attachments.map((a) => ({
          id: a.id, name: a.name, mediaType: a.mediaType, size: a.size, file: located.files.get(a.id), image: sent.has(located.files.get(a.id)!),
        })), null, 1));
      }
      writeFileSync(`${stem}.cmd.json`, JSON.stringify([binary, ...args], null, 1));
      const eventsLog = createWriteStream(`${stem}.events.jsonl`);
      const parser = backend.createParser();
      const baseCost = cost;
      const baseTokens = tokens;
      let io: ChildIO | undefined;
      const deniedByUser = new Set<string>();
      let run: RunResult;
      // The attempt's own signals: `stopped` ends the CLI when a question is deferred; `over` releases whoever still waits.
      const stopped = new AbortController();
      const over = new AbortController();
      const processSignal = o.signal ? AbortSignal.any([o.signal, stopped.signal]) : stopped.signal;
      const askSignal = AbortSignal.any([processSignal, over.signal]);
      const inflight = new Set<Promise<void>>();
      const track = (work: Promise<void>) => {
        const done = work.catch(() => undefined).finally(() => inflight.delete(done));
        inflight.add(done);
      };
      const callId = `${prefix}.a${attempt}`;
      try {
        // Only host mode keeps stdin open (for the answers); otherwise it closes after the input.
        const input = stream ? backend.hostInput!(prompt, images) : prompt;
        run = await runProcess(binary, args, {
          cwd: member?.cwd ?? this.repo, input, holdStdin: host, timeoutMs, idleTimeoutMs, signal: processSignal,
          onSpawn: (child) => {
            io = child;
            calls += 1;
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
              } else if (ev.type === "permission" || ev.type === "question") {
                if (!host || !io) continue;
                const here: Attempt = {
                  channel, signal: askSignal, agent, backend, io, callId, answersLog: `${stem}.answers.jsonl`, waits, answered, stopCall: () => stopped.abort(),
                  member: !!member,
                };
                track(ev.type === "permission" ? this.answerPermission(ev, here, deniedByUser) : this.answerQuestion(ev, here));
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
      } finally {
        // The process is over: nobody waits for it any more. Whoever still asks the user is released, and has finished
        // (recording the request as interrupted) before the call reports back, so no late event follows its result.
        over.abort();
        await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, 2000).unref())]);
        waits.close();
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
      // A conversation turn that hung ends here, also in a continued session (see TextCall).
      if (run.timedOut) {
        lastError = `${backend.name} timed out after ${this.cfg.limits.agent_timeout_sec}s`;
        if (text) return finish(false, attempt, null, lastError);
        continue;
      }
      if (run.idle) {
        lastError = `${backend.name} produced no output for ${this.cfg.limits.agent_idle_timeout_sec}s`;
        if (text) return finish(false, attempt, null, lastError);
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
        priced += 1;
      }
      if (typeof meta.tokens === "number") {
        tokens += meta.tokens;
        tokensSeen = true;
      }
      // Each attempt starts over: only the answer it gives can be rejected.
      const before = rejected;
      rejected = null;
      if (parseError) {
        lastError = run.code === 0 ? parseError : `${backend.name} exited with code ${run.code}: ${(run.stderr || run.stdout).trim().slice(-800)}`;
        if (run.code === 0 && o.mode !== "text") {
          rejections.push({ attempt, errors: [parseError] });
          if (before && sameErrors(before.errors, [parseError])) {
            return finish(false, attempt, null, `the same invalid answer came back after it was told what to correct, so no further attempt was made:\n- ${parseError}`);
          }
          rejected = { errors: [parseError], answer: null };
        }
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
        const shown = errors.slice(0, 20);
        lastError = `output failed validation:\n- ${shown.join("\n- ")}`;
        rejections.push({ attempt, errors: shown });
        // Told what to correct, it gave the same invalid answer: another attempt would most likely repeat it again.
        if (before && sameErrors(before.errors, shown)) {
          return finish(false, attempt, null, `the same invalid answer came back after it was told what to correct, so no further attempt was made:\n- ${shown.join("\n- ")}`);
        }
        rejected = { errors: shown, answer: data };
        continue;
      }
      writeFileSync(`${stem}.output.json`, JSON.stringify(data, null, 2));
      return finish(true, attempt, data, null);
    }
    return finish(false, attemptsAllowed, null, lastError);
  }
}
