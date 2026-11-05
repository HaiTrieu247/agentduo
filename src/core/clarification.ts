/**
 * Clarifying questions with annotated options: the model every screen shares (terminal, VS Code, desktop), with no Node
 * and no UI, because the webview bundles it. A question comes from Claude's own AskUserQuestion tool (asked inside a
 * turn) or from the planner (asked between turns); the answer is chosen options and/or the user's own words, per
 * question. Ids are agentduo's: a question or an option is never identified by its label or its text.
 *
 * An answer is never a permission: it does not widen the task's scope, waive a gate or a review, or raise a budget.
 */
import type { Role } from "../events.js";

/** Claude's tool; the one structured question agentduo relays from a turn. */
export const ASK_TOOL = "AskUserQuestion";

/** What one request may hold, and how long the user's own words may be. */
export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;
export const MAX_OTHER_CHARS = 4000;
/** How many times in one run the planner may stop to ask before it must plan on stated assumptions (each ask is a budgeted call). */
export const MAX_PLANNER_ASKS = 3;
const MAX_TEXT = 1000;
const MAX_HEADER = 40;

export interface ClarificationOption {
  id: string;
  label: string;
  description: string;
}

export interface ClarificationQuestion {
  id: string;
  /** A short tag for the question ("Auth", "Scope"). */
  header: string;
  question: string;
  multiSelect: boolean;
  options: ClarificationOption[];
}

/** Who asked: the planner between its turns, or Claude inside one. */
export type ClarificationSource = "planner" | "claude";

/**
 * A request for answers. `id` is agentduo's and unique; `callId` names the agent call (attempt) that asked, so an answer
 * to an earlier call's request is never applied to a later one. Owner: a pipeline role (`role`) or a turn of the
 * conversation (`turnId`), never both.
 */
export interface ClarificationRequest {
  id: string;
  source: ClarificationSource;
  callId: string;
  agent: "claude" | "codex";
  role?: Role;
  turnId?: string;
  /** The /discuss the turn belongs to. */
  discussionId?: string;
  questions: ClarificationQuestion[];
  at: string;
  /**
   * Claude's question that outlived its call, asked again by the run that owes it: it can be answered or put off, but not
   * dismissed to an agent that is no longer there. Absent otherwise.
   */
  held?: true;
}

/** What the user chose for one question: options (by id) and/or words of their own. */
export interface ClarificationAnswer {
  questionId: string;
  optionIds: string[];
  otherText: string | null;
}

export type ClarificationStatus = "pending" | "answered" | "cancelled" | "interrupted";

/** A request as the run's or the conversation's ledger keeps it: saved when asked and when answered, never later. */
export interface ClarificationEntry extends ClarificationRequest {
  /** Order of asking in its ledger, from 1. */
  seq: number;
  status: ClarificationStatus;
  answers?: ClarificationAnswer[];
  closedAt?: string;
  /**
   * A conversation's entry whose answer went into one of its exchanges (the turn, or the discussion, ended and carried it on).
   * An answered entry without it belonged to a turn that never ended in this process (a crash): the conversation, reopened,
   * still passes its answer on. Not used by a run's ledger.
   */
  settled?: true;
}

/** Whether a request belongs to a run: put off, it stays saved and the run waits for it. A chat turn's question ends with its call instead. */
export const keptByRun = (r: Pick<ClarificationRequest, "source" | "role">): boolean => r.source === "planner" || r.role !== undefined;

/** Whether the user may dismiss the request to the agent that asked: only Claude's question, while its call is still there to be told. */
export const dismissable = (r: Pick<ClarificationRequest, "source" | "held">): boolean => r.source === "claude" && !r.held;

/** The user's response to a request. defer: asked again later (a pipeline request stays pending; a turn's call ends). */
export type ClarificationResponse =
  | { kind: "answered"; answers: ClarificationAnswer[] }
  | { kind: "cancelled" }
  | { kind: "defer" };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A piece of text as the agent wrote it. It is checked trimmed (not blank) but kept exactly as given: Claude keys its answers by
 * the question's text and by the options' labels, so they must come back unchanged. Too long is refused, never cut.
 */
function given(v: unknown, what: string, max: number, required: boolean): { text: string } | { error: string } {
  if (v === undefined || v === null || (!required && typeof v !== "string")) return required ? { error: `${what} must be a non-empty string` } : { text: "" };
  if (typeof v !== "string" || (required && !v.trim())) return { error: `${what} must be a non-empty string` };
  if (v.trim().length > max) return { error: `${what} is longer than ${max} characters (${v.trim().length}); shorten it` };
  return { text: v };
}

/**
 * Questions as an agent gave them (Claude's `input.questions`, the planner's `questions`): ids are assigned here. Returns
 * what is wrong with them instead when they cannot be shown: the agent is told, or the call is denied, never guessed at.
 */
export function parseQuestions(raw: unknown): { questions: ClarificationQuestion[] } | { error: string } {
  if (!Array.isArray(raw) || !raw.length) return { error: "questions must be a non-empty list" };
  if (raw.length > MAX_QUESTIONS) return { error: `at most ${MAX_QUESTIONS} questions at a time (got ${raw.length})` };
  const questions: ClarificationQuestion[] = [];
  const seen = new Set<string>();
  for (const [i, q] of raw.entries()) {
    const at = `question ${i + 1}`;
    if (!isObject(q)) return { error: `${at} must be an object` };
    const question = given(q.question, `${at}: 'question'`, MAX_TEXT, true);
    if ("error" in question) return question;
    // Claude's answers are keyed by the question's text, so two equal texts could not be told apart.
    if (seen.has(question.text.trim())) return { error: `${at}: the question text repeats an earlier question's (each must be distinct)` };
    seen.add(question.text.trim());
    const header = given(q.header, `${at}: 'header'`, MAX_HEADER, false);
    if ("error" in header) return header;
    const multiSelect = q.multiSelect === true || q.multi_select === true;
    if (!Array.isArray(q.options) || q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) {
      return { error: `${at}: needs ${MIN_OPTIONS} to ${MAX_OPTIONS} options` };
    }
    const labels = new Set<string>();
    const options: ClarificationOption[] = [];
    for (const [j, o] of q.options.entries()) {
      const where = `${at}, option ${j + 1}`;
      const label = given(isObject(o) ? o.label : undefined, `${where}: 'label'`, MAX_TEXT, true);
      if ("error" in label) return label;
      if (labels.has(label.text.trim())) return { error: `${at}: option label '${label.text.trim()}' repeats (each must be distinct)` };
      labels.add(label.text.trim());
      const description = given((o as Record<string, unknown>).description, `${where}: 'description'`, MAX_TEXT, false);
      if ("error" in description) return description;
      options.push({ id: `q${i + 1}o${j + 1}`, label: label.text, description: description.text });
    }
    questions.push({ id: `q${i + 1}`, header: header.text, question: question.text, multiSelect, options });
  }
  return { questions };
}

/**
 * What is wrong with `answers` for `questions`; empty when they are a complete, valid answer: every question answered once,
 * options that belong to it, one option at most for a single-choice question, the user's own words non-empty and bounded.
 * Nothing is filled in for a question left unanswered.
 */
export function answerErrors(questions: ClarificationQuestion[], answers: unknown): string[] {
  if (!Array.isArray(answers)) return ["answers must be a list"];
  const errors: string[] = [];
  const byQuestion = new Map<string, Record<string, unknown>>();
  for (const a of answers) {
    if (!isObject(a) || typeof a.questionId !== "string") {
      errors.push("an answer needs a questionId");
      continue;
    }
    if (byQuestion.has(a.questionId)) errors.push(`question ${a.questionId} is answered twice`);
    byQuestion.set(a.questionId, a);
  }
  for (const id of byQuestion.keys()) if (!questions.some((q) => q.id === id)) errors.push(`there is no question ${id}`);
  for (const q of questions) {
    const a = byQuestion.get(q.id);
    if (!a) {
      errors.push(`question ${q.id} ("${q.question}") is not answered`);
      continue;
    }
    const ids = a.optionIds;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) {
      errors.push(`question ${q.id}: optionIds must be a list of option ids`);
      continue;
    }
    if (new Set(ids).size !== ids.length) errors.push(`question ${q.id}: an option is chosen twice`);
    for (const id of ids as string[]) if (!q.options.some((o) => o.id === id)) errors.push(`question ${q.id}: ${id} is not one of its options`);
    const other = a.otherText;
    if (other !== null && other !== undefined && typeof other !== "string") errors.push(`question ${q.id}: otherText must be text or null`);
    const words = typeof other === "string" ? other.trim() : "";
    if (typeof other === "string" && !words) errors.push(`question ${q.id}: otherText is empty (use null for none)`);
    if (words.length > MAX_OTHER_CHARS) errors.push(`question ${q.id}: otherText is longer than ${MAX_OTHER_CHARS} characters`);
    if (!ids.length && !words) errors.push(`question ${q.id} ("${q.question}") has no choice and no text`);
    if (!q.multiSelect && ids.length + (words ? 1 : 0) > 1) errors.push(`question ${q.id} takes one answer: an option or your own words, not both`);
  }
  return errors;
}

/** The answers as stored: only the fields of the model, options in the question's order, words trimmed. */
export function cleanAnswers(questions: ClarificationQuestion[], answers: ClarificationAnswer[]): ClarificationAnswer[] {
  return questions.map((q) => {
    const a = answers.find((x) => x.questionId === q.id)!;
    const words = typeof a.otherText === "string" ? a.otherText.trim() : "";
    return { questionId: q.id, optionIds: q.options.filter((o) => a.optionIds.includes(o.id)).map((o) => o.id), otherText: words || null };
  });
}

/** One answer in words: the labels chosen, then the user's own, as Claude's tool takes them (comma-separated). */
export function answerText(q: ClarificationQuestion, a: ClarificationAnswer): string {
  const chosen = q.options.filter((o) => a.optionIds.includes(o.id)).map((o) => o.label);
  return [...chosen, ...(a.otherText ? [a.otherText] : [])].join(", ");
}

/** Whether `entry` still waits for its answer. */
export const isPending = (entry: { status: ClarificationStatus }): boolean => entry.status === "pending";

/** The request a client may answer: only the pending one that names this id and call. */
export function answerable(entries: readonly ClarificationEntry[], requestId: string, callId?: string): ClarificationEntry | null {
  const entry = entries.find((e) => e.id === requestId);
  return entry && isPending(entry) && (callId === undefined || entry.callId === callId) ? entry : null;
}

/**
 * The questions and answers of `entries` as a prompt section: only what the user answered, in the order asked. Empty
 * when there is none. The wording keeps an answer what it is: information, not an approval of anything else.
 */
export function clarificationSection(entries: readonly ClarificationEntry[], heading = "## The user's answers to questions the agents asked"): string {
  const answered = entries.filter((e) => e.status === "answered" && e.answers);
  if (!answered.length) return "";
  const lines = answered.flatMap((e) => e.questions.map((q) => {
    const a = e.answers!.find((x) => x.questionId === q.id);
    return `- ${q.header ? `[${q.header}] ` : ""}${q.question}\n  → ${a ? answerText(q, a) : "(no answer)"}`;
  }));
  return `${heading}\n${lines.join("\n")}\n` +
    "These answers are information about what the user wants. They do not change the task's agreed scope or acceptance contract by " +
    "themselves, and they never waive a check, a review or a limit: if an answer would change the scope already agreed, say so " +
    "(a blocked report, or an issue) so the user decides it, instead of going on outside it.\n";
}

/** A question the user was asked while an exchange's answer was being written, and what they answered, in words. */
export interface ClarifiedPair {
  asker: "codex" | "claude";
  header: string;
  question: string;
  answer: string;
}

/** The answered entries as pairs of question and answer, in the order asked (what a conversation's prompts carry). */
export function clarifiedPairs(entries: readonly ClarificationEntry[]): ClarifiedPair[] {
  return answeredEntries(entries).flatMap((e) => e.questions.map((q): ClarifiedPair => {
    const a = e.answers!.find((x) => x.questionId === q.id);
    return { asker: e.agent, header: q.header, question: q.question, answer: a ? answerText(q, a) : "(no answer)" };
  }));
}

/** A short line for a screen's timeline: "Auth: OAuth; Scope: only the API". */
export function answerSummary(entry: Pick<ClarificationEntry, "questions" | "answers" | "status">): string {
  if (entry.status === "cancelled") return "dismissed without an answer";
  if (entry.status === "interrupted") return "interrupted before it was answered";
  if (entry.status === "pending") return "waiting for your answer";
  return entry.questions.map((q) => {
    const a = entry.answers?.find((x) => x.questionId === q.id);
    return `${q.header || q.question}: ${a ? answerText(q, a) : "—"}`;
  }).join("; ");
}

/** The ledger entry for a request just asked. */
export function openEntry(request: ClarificationRequest, seq: number): ClarificationEntry {
  return { ...request, seq, status: "pending" };
}

/** What `--answers <file>` holds: one request's answers, by question id and option id. */
export interface AnswersFile {
  requestId: string;
  answers: Record<string, { options?: string[]; other?: string | null }>;
}

/** The file `duo resume --answers` takes, empty, for `entry`; the user fills in `options` (ids) and/or `other`. */
export function answersTemplate(entry: ClarificationEntry): AnswersFile {
  return { requestId: entry.id, answers: Object.fromEntries(entry.questions.map((q) => [q.id, { options: [], other: null }])) };
}

/**
 * The answers an `--answers` file gives for `entry`, or what is wrong with it. It names the request it answers: a file
 * for another request, or one already answered, is refused, never applied.
 */
export function parseAnswersFile(raw: unknown, entry: ClarificationEntry): { answers: ClarificationAnswer[] } | { errors: string[] } {
  if (!isObject(raw) || typeof raw.requestId !== "string" || !isObject(raw.answers)) {
    return { errors: ["the answers file must be an object with 'requestId' and 'answers' (by question id)"] };
  }
  if (raw.requestId !== entry.id) return { errors: [`the file answers request ${raw.requestId}, but the run waits for ${entry.id}`] };
  const answers: ClarificationAnswer[] = [];
  for (const [questionId, a] of Object.entries(raw.answers)) {
    if (!isObject(a)) return { errors: [`the answer to ${questionId} must be an object with 'options' and/or 'other'`] };
    const other = a.other === undefined || a.other === null ? null : a.other;
    answers.push({ questionId, optionIds: (a.options ?? []) as string[], otherText: other as string | null });
  }
  const errors = answerErrors(entry.questions, answers);
  return errors.length ? { errors } : { answers: cleanAnswers(entry.questions, answers) };
}

// ------------------------------------------------------------------ the ledger
// A run's or a conversation's list of entries: every change is idempotent and refuses what is not for the entry it names.

/** Adds the request as pending, once: an id already in the ledger is left as it was. Returns the entry. */
export function ledgerOpen(list: ClarificationEntry[], request: ClarificationRequest): ClarificationEntry {
  const known = list.find((e) => e.id === request.id);
  if (known) return known;
  const entry = openEntry(request, (list.at(-1)?.seq ?? 0) + 1);
  list.push(entry);
  return entry;
}

/**
 * Records the answers of a pending request, once. Refused (false) when the request is unknown, already closed, from
 * another call than `callId`, or when the answers are not a complete valid answer to its questions: an old, duplicate or
 * foreign answer changes nothing.
 */
export function ledgerAnswer(list: ClarificationEntry[], id: string, callId: string | undefined, answers: ClarificationAnswer[], at: string): boolean {
  const entry = answerable(list, id, callId);
  if (!entry || answerErrors(entry.questions, answers).length) return false;
  entry.status = "answered";
  entry.answers = cleanAnswers(entry.questions, answers);
  entry.closedAt = at;
  return true;
}

/** Closes a pending request without an answer (dismissed, or its call ended first). False when it is not pending. */
export function ledgerClose(list: ClarificationEntry[], id: string, status: "cancelled" | "interrupted", at: string, callId?: string): boolean {
  const entry = answerable(list, id, callId);
  if (!entry) return false;
  entry.status = status;
  entry.closedAt = at;
  return true;
}

/** The answered entries, in the order they were asked. */
export const answeredEntries = (list: readonly ClarificationEntry[] | undefined): ClarificationEntry[] =>
  (list ?? []).filter((e) => e.status === "answered" && !!e.answers);

/** The entry of the ledger that still waits for the user, if any (a pipeline has at most one). */
export const pendingEntry = (list: readonly ClarificationEntry[] | undefined, source?: ClarificationSource): ClarificationEntry | null =>
  (list ?? []).find((e) => isPending(e) && (!source || e.source === source)) ?? null;
