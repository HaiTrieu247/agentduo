import { describe, expect, it } from "vitest";
import { ClarificationBroker } from "../../src/clarification/broker.js";
import { emptyForm, formAnswers, formComplete, formProblems, formSubmission, isAnswered, setWords, toggleOption } from "../../src/clarification/form.js";
import {
  answeredEntries, answerable, answerErrors, answersTemplate, answerSummary, answerText, cleanAnswers, clarifiedPairs, clarificationSection, ledgerAnswer, ledgerClose, ledgerOpen,
  MAX_OTHER_CHARS, parseAnswersFile, parseQuestions, pendingEntry, type ClarificationAnswer, type ClarificationEntry, type ClarificationQuestion, type ClarificationRequest,
} from "../../src/clarification/clarification.js";

const raw = [
  { question: "Which database?", header: "Database", multiSelect: false, options: [{ label: "SQLite", description: "one file" }, { label: "Postgres", description: "a server" }] },
  { question: "Which targets?", header: "Targets", multiSelect: true, options: [{ label: "web", description: "" }, { label: "cli", description: "" }, { label: "api", description: "" }] },
];
const questions = (): ClarificationQuestion[] => {
  const parsed = parseQuestions(raw);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.questions;
};
const request = (id = "clq-1", callId = "001-plan-r1"): ClarificationRequest => ({
  id, source: "planner", callId, agent: "codex", role: "planner", questions: questions(), at: "2026-11-05T10:00:00.000Z",
});
const answer = (questionId: string, optionIds: string[], otherText: string | null = null): ClarificationAnswer => ({ questionId, optionIds, otherText });
const both = [answer("q1", ["q1o2"]), answer("q2", ["q2o1", "q2o3"])];

describe("parseQuestions", () => {
  it("gives agentduo's own ids and keeps the header, the descriptions and multiple choice", () => {
    expect(questions()).toEqual([
      { id: "q1", header: "Database", question: "Which database?", multiSelect: false, options: [{ id: "q1o1", label: "SQLite", description: "one file" }, { id: "q1o2", label: "Postgres", description: "a server" }] },
      { id: "q2", header: "Targets", question: "Which targets?", multiSelect: true, options: [
        { id: "q2o1", label: "web", description: "" }, { id: "q2o2", label: "cli", description: "" }, { id: "q2o3", label: "api", description: "" }] },
    ]);
  });

  it("says what is wrong instead of guessing", () => {
    const error = (v: unknown) => (parseQuestions(v) as { error: string }).error;
    expect(error(undefined)).toBe("questions must be a non-empty list");
    expect(error([])).toBe("questions must be a non-empty list");
    expect(error("q")).toBe("questions must be a non-empty list");
    expect(error([5])).toBe("question 1 must be an object");
    expect(error([{ question: " ", options: [] }])).toBe("question 1: 'question' must be a non-empty string");
    expect(error([{ question: "q", options: [{ label: "a" }] }])).toBe("question 1: needs 2 to 6 options");
    expect(error([{ question: "q", options: Array.from({ length: 7 }, (_, i) => ({ label: `o${i}` })) }])).toBe("question 1: needs 2 to 6 options");
    expect(error([{ question: "q", options: [{ label: "" }, { label: "b" }] }])).toBe("question 1, option 1: 'label' must be a non-empty string");
    expect(error([{ question: "q", options: [{ label: "a" }, { label: "a" }] }])).toBe("question 1: option label 'a' repeats (each must be distinct)");
    expect(error([...raw, ...raw, raw[0]])).toBe("at most 4 questions at a time (got 5)");
    // Claude answers by the question's text, so two equal texts could not be told apart.
    expect(error([raw[0], raw[0]])).toBe("question 2: the question text repeats an earlier question's (each must be distinct)");
  });
});

describe("parseQuestions keeps what the agent wrote", () => {
  const options = [{ label: " --fast ", description: "  quick  " }, { label: "--safe", description: "" }];
  const error = (v: unknown) => (parseQuestions(v) as { error: string }).error;

  it("keeps the question's text and the labels exactly as given: they are the keys of Claude's answers, never trimmed", () => {
    const parsed = parseQuestions([{ question: "  Which flag?  ", header: " Flag ", options }]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.questions[0]).toMatchObject({ question: "  Which flag?  ", header: " Flag ", options: [{ label: " --fast ", description: "  quick  " }, { label: "--safe" }] });
  });

  it("refuses text that is too long, and says which, instead of cutting it", () => {
    const long = (n: number) => "x".repeat(n);
    expect(error([{ question: long(1001), options }])).toBe("question 1: 'question' is longer than 1000 characters (1001); shorten it");
    expect(error([{ question: "q", options: [{ label: long(1001) }, { label: "b" }] }])).toBe("question 1, option 1: 'label' is longer than 1000 characters (1001); shorten it");
    expect(error([{ question: "q", options: [{ label: "a", description: long(1001) }, { label: "b" }] }])).toBe("question 1, option 1: 'description' is longer than 1000 characters (1001); shorten it");
    expect(error([{ question: "q", header: long(41), options }])).toBe("question 1: 'header' is longer than 40 characters (41); shorten it");
    // At the limit it is kept whole.
    const parsed = parseQuestions([{ question: long(1000), header: long(40), options: [{ label: long(1000) }, { label: "b" }] }]);
    expect(parsed).toMatchObject({ questions: [{ question: long(1000), header: long(40), options: [{ label: long(1000) }, { label: "b" }] }] });
  });

  it("still tells two texts apart that differ only in their edges' spaces: they would look the same to the user", () => {
    expect(error([{ question: "Which?", options }, { question: "Which? ", options }])).toBe("question 2: the question text repeats an earlier question's (each must be distinct)");
    expect(error([{ question: "q", options: [{ label: "a" }, { label: " a" }] }])).toBe("question 1: option label 'a' repeats (each must be distinct)");
  });
});

describe("answerErrors", () => {
  it("accepts a complete answer and nothing else", () => {
    expect(answerErrors(questions(), both)).toEqual([]);
    expect(answerErrors(questions(), [answer("q1", [], "something else"), answer("q2", [], "just this")])).toEqual([]);
    expect(answerErrors(questions(), [answer("q1", ["q1o1"]), answer("q2", ["q2o2"], "and more")])).toEqual([]);
  });

  it("never fills in a question left unanswered, nor takes an empty answer", () => {
    expect(answerErrors(questions(), [])).toEqual(['question q1 ("Which database?") is not answered', 'question q2 ("Which targets?") is not answered']);
    expect(answerErrors(questions(), [answer("q1", ["q1o1"])])).toEqual(['question q2 ("Which targets?") is not answered']);
    expect(answerErrors(questions(), [answer("q1", []), answer("q2", ["q2o1"])])).toEqual(['question q1 ("Which database?") has no choice and no text']);
    expect(answerErrors(questions(), [answer("q1", [], "  "), answer("q2", ["q2o1"])])).toEqual(["question q1: otherText is empty (use null for none)", 'question q1 ("Which database?") has no choice and no text']);
  });

  it("holds an answer to its own question: options that belong to it, once, one for a single choice", () => {
    expect(answerErrors(questions(), [answer("q1", ["q2o1"]), answer("q2", ["q2o1"])])).toEqual(["question q1: q2o1 is not one of its options"]);
    expect(answerErrors(questions(), [answer("q1", ["q1o1", "q1o2"]), answer("q2", ["q2o1"])])).toEqual(["question q1 takes one answer: an option or your own words, not both"]);
    expect(answerErrors(questions(), [answer("q1", ["q1o1"], "and words"), answer("q2", ["q2o1"])])).toEqual(["question q1 takes one answer: an option or your own words, not both"]);
    expect(answerErrors(questions(), [answer("q1", ["q1o1"]), answer("q2", ["q2o1", "q2o1"])])).toEqual(["question q2: an option is chosen twice"]);
    expect(answerErrors(questions(), [...both, answer("q1", ["q1o1"])])).toContain("question q1 is answered twice");
    expect(answerErrors(questions(), [...both, answer("q9", ["q9o1"])])).toEqual(["there is no question q9"]);
    expect(answerErrors(questions(), [answer("q1", [], "x".repeat(MAX_OTHER_CHARS + 1)), answer("q2", ["q2o1"])]))
      .toEqual([`question q1: otherText is longer than ${MAX_OTHER_CHARS} characters`]);
  });

  it("refuses what is not a list of answers, with a name for each", () => {
    expect(answerErrors(questions(), "yes")).toEqual(["answers must be a list"]);
    expect(answerErrors(questions(), [null])).toEqual(["an answer needs a questionId", ...answerErrors(questions(), [])]);
    expect(answerErrors(questions(), [{ questionId: "q1", optionIds: "q1o1" }, answer("q2", ["q2o1"])])).toEqual(["question q1: optionIds must be a list of option ids"]);
    expect(answerErrors(questions(), [{ questionId: "q1", optionIds: ["q1o1"], otherText: 4 }, answer("q2", ["q2o1"])])).toEqual(["question q1: otherText must be text or null"]);
  });
});

describe("answers as stored and shown", () => {
  it("keeps only the model's fields, in the question's order, trimmed", () => {
    const messy = [{ ...answer("q2", ["q2o3", "q2o1"], "  more  "), extra: "x" }, answer("q1", ["q1o2"])] as ClarificationAnswer[];
    expect(cleanAnswers(questions(), messy)).toEqual([answer("q1", ["q1o2"]), answer("q2", ["q2o1", "q2o3"], "more")]);
  });

  it("says an answer in words: the labels chosen, then the user's own", () => {
    const [q1, q2] = questions();
    expect(answerText(q1!, answer("q1", ["q1o2"]))).toBe("Postgres");
    expect(answerText(q2!, answer("q2", ["q2o1", "q2o3"], "and the docs"))).toBe("web, api, and the docs");
    expect(answerText(q1!, answer("q1", [], "neither"))).toBe("neither");
  });

  it("builds the prompt section from the answered requests only, in the order asked, and says what an answer is not", () => {
    const list: ClarificationEntry[] = [];
    ledgerOpen(list, request("a"));
    ledgerOpen(list, request("b"));
    ledgerAnswer(list, "b", undefined, both, "t");
    const section = clarificationSection(list);
    expect(section).toContain("## The user's answers to questions the agents asked\n- [Database] Which database?\n  → Postgres\n- [Targets] Which targets?\n  → web, api");
    expect(section).toContain("they never waive a check, a review or a limit");
    expect(section).toContain("do not change the task's agreed scope or acceptance contract by themselves");
    expect(clarificationSection([])).toBe("");
    expect(clarificationSection(list.slice(0, 1))).toBe("");
    expect(clarificationSection(list, "## New")).toMatch(/^## New\n/);
  });

  it("makes pairs of question and answer for a conversation's prompts, and a line for a screen", () => {
    const list: ClarificationEntry[] = [];
    ledgerOpen(list, { ...request("a"), agent: "claude", source: "claude" });
    ledgerAnswer(list, "a", undefined, both, "t");
    expect(clarifiedPairs(list)).toEqual([
      { asker: "claude", header: "Database", question: "Which database?", answer: "Postgres" },
      { asker: "claude", header: "Targets", question: "Which targets?", answer: "web, api" },
    ]);
    expect(answerSummary(list[0]!)).toBe("Database: Postgres; Targets: web, api");
    expect(answerSummary({ ...list[0]!, status: "cancelled" })).toBe("dismissed without an answer");
    expect(answerSummary({ ...list[0]!, status: "interrupted" })).toBe("interrupted before it was answered");
    expect(answerSummary({ ...list[0]!, status: "pending" })).toBe("waiting for your answer");
  });
});

describe("the ledger", () => {
  it("opens a request once, numbering in the order asked", () => {
    const list: ClarificationEntry[] = [];
    const first = ledgerOpen(list, request("a"));
    ledgerOpen(list, request("b"));
    expect(ledgerOpen(list, request("a"))).toBe(first);
    expect(list.map((e) => [e.id, e.seq, e.status])).toEqual([["a", 1, "pending"], ["b", 2, "pending"]]);
    expect(pendingEntry(list)!.id).toBe("a");
    expect(pendingEntry(list, "claude")).toBeNull();
  });

  it("records an answer once: a duplicate, an answer of another call, a partial or a foreign one change nothing", () => {
    const list: ClarificationEntry[] = [];
    ledgerOpen(list, request("a", "call-1"));
    expect(ledgerAnswer(list, "a", "call-2", both, "t")).toBe(false);
    expect(ledgerAnswer(list, "nope", "call-1", both, "t")).toBe(false);
    expect(ledgerAnswer(list, "a", "call-1", [answer("q1", ["q1o1"])], "t")).toBe(false);
    expect(ledgerAnswer(list, "a", "call-1", [answer("q1", ["q2o1"]), answer("q2", ["q2o1"])], "t")).toBe(false);
    expect(list[0]!.status).toBe("pending");
    expect(ledgerAnswer(list, "a", "call-1", both, "t1")).toBe(true);
    expect(ledgerAnswer(list, "a", "call-1", [answer("q1", ["q1o1"]), answer("q2", ["q2o2"])], "t2")).toBe(false);
    expect(list[0]).toMatchObject({ status: "answered", closedAt: "t1", answers: both });
    expect(answeredEntries(list)).toHaveLength(1);
    expect(answerable(list, "a")).toBeNull();
  });

  it("closes a pending request without an answer, only while it is pending", () => {
    const list: ClarificationEntry[] = [];
    ledgerOpen(list, request("a", "call-1"));
    expect(ledgerClose(list, "a", "interrupted", "t", "call-2")).toBe(false);
    expect(ledgerClose(list, "a", "interrupted", "t", "call-1")).toBe(true);
    expect(ledgerClose(list, "a", "cancelled", "t2")).toBe(false);
    expect(ledgerAnswer(list, "a", "call-1", both, "t3")).toBe(false);
    expect(list[0]).toMatchObject({ status: "interrupted", closedAt: "t" });
  });
});

describe("--answers files", () => {
  const entry = (): ClarificationEntry => ledgerOpen([], request("clq-7"));

  it("offers a template naming the request and every question", () => {
    expect(answersTemplate(entry())).toEqual({ requestId: "clq-7", answers: { q1: { options: [], other: null }, q2: { options: [], other: null } } });
  });

  it("reads a file for the request, option ids and own words", () => {
    expect(parseAnswersFile({ requestId: "clq-7", answers: { q1: { options: ["q1o2"] }, q2: { options: ["q2o1"], other: " more " } } }, entry()))
      .toEqual({ answers: [answer("q1", ["q1o2"]), answer("q2", ["q2o1"], "more")] });
  });

  it("refuses another request's file, a file that is not one, and answers that do not fit", () => {
    const errors = (v: unknown) => (parseAnswersFile(v, entry()) as { errors: string[] }).errors;
    expect(errors({ requestId: "clq-other", answers: {} })).toEqual(["the file answers request clq-other, but the run waits for clq-7"]);
    expect(errors("x")[0]).toContain("must be an object with 'requestId' and 'answers'");
    expect(errors({ requestId: "clq-7", answers: { q1: 5 } })).toEqual(["the answer to q1 must be an object with 'options' and/or 'other'"]);
    expect(errors({ requestId: "clq-7", answers: { q1: { options: ["q1o1"] } } })).toEqual(['question q2 ("Which targets?") is not answered']);
    expect(errors({ requestId: "clq-7", answers: { q1: { options: ["q1o1"] }, q2: { options: ["zz"] } } })).toEqual(["question q2: zz is not one of its options"]);
  });
});

describe("the form every screen shares", () => {
  const qs = questions();

  it("starts with nothing chosen: no default, nothing to submit", () => {
    const form = emptyForm();
    expect(qs.map((q) => isAnswered(q, form))).toEqual([false, false]);
    expect(formComplete(qs, form)).toBe(false);
    expect(formSubmission(qs, form)).toBeNull();
    expect(formProblems(qs, form)).toEqual(["question 1 (Database) has no answer yet", "question 2 (Targets) has no answer yet"]);
  });

  it("picks one option for a single choice, and takes it back when chosen again", () => {
    let form = toggleOption(qs, emptyForm(), "q1", "q1o1");
    form = toggleOption(qs, form, "q1", "q1o2");
    expect(form.picked.q1).toEqual(["q1o2"]);
    expect(toggleOption(qs, form, "q1", "q1o2").picked.q1).toEqual([]);
    // An option that is not the question's changes nothing.
    expect(toggleOption(qs, form, "q1", "q2o1")).toBe(form);
    expect(toggleOption(qs, form, "q9", "q1o1")).toBe(form);
  });

  it("picks any number for a multiple choice, and lets words stand beside them", () => {
    let form = toggleOption(qs, emptyForm(), "q2", "q2o1");
    form = toggleOption(qs, form, "q2", "q2o3");
    form = setWords(qs, form, "q2", " and the docs ");
    expect(form.picked.q2).toEqual(["q2o1", "q2o3"]);
    expect(formAnswers(qs, form)[1]).toEqual(answer("q2", ["q2o1", "q2o3"], "and the docs"));
    expect(toggleOption(qs, form, "q2", "q2o1").picked.q2).toEqual(["q2o3"]);
  });

  it("makes your own words and an option exclusive for a single choice: the latest wins", () => {
    let form = toggleOption(qs, emptyForm(), "q1", "q1o1");
    form = setWords(qs, form, "q1", "neither");
    expect(formAnswers(qs, form)[0]).toEqual(answer("q1", [], "neither"));
    form = toggleOption(qs, form, "q1", "q1o2");
    expect(formAnswers(qs, form)[0]).toEqual(answer("q1", ["q1o2"], null));
    // Blanking the words leaves the option alone.
    expect(formAnswers(qs, setWords(qs, form, "q1", "   "))[0]).toEqual(answer("q1", ["q1o2"], null));
  });

  it("submits only when every question has an answer, as the cleaned answers", () => {
    let form = toggleOption(qs, emptyForm(), "q1", "q1o2");
    expect(formComplete(qs, form)).toBe(false);
    expect(formProblems(qs, form)).toEqual(["question 2 (Targets) has no answer yet"]);
    form = setWords(qs, form, "q2", "only this");
    expect(formSubmission(qs, form)).toEqual([answer("q1", ["q1o2"]), answer("q2", [], "only this")]);
    expect(answerErrors(qs, formSubmission(qs, form))).toEqual([]);
  });
});

describe("ClarificationBroker", () => {
  const ask = (broker: ClarificationBroker, r = request(), signal?: AbortSignal) => broker.askClarification({ request: r }, signal);

  it("settles a request once, with the answers, and tells a second answer it is stale", async () => {
    const broker = new ClarificationBroker();
    const waiting = ask(broker);
    expect(broker.pending().map((r) => r.id)).toEqual(["clq-1"]);
    expect(broker.answer("clq-1", "001-plan-r1", both)).toEqual({ ok: true });
    expect(await waiting).toEqual({ kind: "answered", answers: both });
    expect(broker.answer("clq-1", "001-plan-r1", both)).toEqual({ ok: false, reason: "stale" });
    expect(broker.pending()).toEqual([]);
  });

  it("keeps the question waiting when the answer does not fit, with why", async () => {
    const broker = new ClarificationBroker();
    const waiting = ask(broker);
    expect(broker.answer("clq-1", undefined, [answer("q1", ["q1o1"])])).toEqual({ ok: false, reason: "invalid", errors: ['question q2 ("Which targets?") is not answered'] });
    expect(broker.answer("clq-1", undefined, [])).toMatchObject({ ok: false, reason: "invalid" });
    expect(broker.has("clq-1")).toBe(true);
    broker.answer("clq-1", undefined, both);
    expect(await waiting).toMatchObject({ kind: "answered" });
  });

  it("applies an answer to the call that asked, not to another's", async () => {
    const broker = new ClarificationBroker();
    const waiting = ask(broker, request("clq-1", "call-A"));
    expect(broker.answer("clq-1", "call-B", both)).toEqual({ ok: false, reason: "stale" });
    expect(broker.cancel("clq-1", "call-B")).toBe(false);
    expect(broker.defer("clq-1", "call-B")).toBe(false);
    expect(broker.answer("nope", "call-A", both)).toEqual({ ok: false, reason: "stale" });
    expect(broker.has("clq-1")).toBe(true);
    broker.cancel("clq-1", "call-A");
    expect(await waiting).toEqual({ kind: "cancelled" });
  });

  it("cleans the answers it passes on", async () => {
    const broker = new ClarificationBroker();
    const waiting = ask(broker);
    broker.answer("clq-1", undefined, [answer("q2", ["q2o3", "q2o1"], " x "), answer("q1", ["q1o1"])]);
    expect(await waiting).toEqual({ kind: "answered", answers: [answer("q1", ["q1o1"]), answer("q2", ["q2o1", "q2o3"], "x")] });
  });

  it("is 'later' for a call that is aborted, before or while it waits, with nothing left behind", async () => {
    const broker = new ClarificationBroker();
    const aborted = new AbortController();
    aborted.abort();
    expect(await ask(broker, request("a"), aborted.signal)).toEqual({ kind: "defer" });
    const controller = new AbortController();
    const waiting = ask(broker, request("b"), controller.signal);
    expect(broker.has("b")).toBe(true);
    controller.abort();
    expect(await waiting).toEqual({ kind: "defer" });
    expect(broker.pending()).toEqual([]);
    expect(broker.answer("b", undefined, both)).toEqual({ ok: false, reason: "stale" });
  });

  it("is 'later' for everything when nobody can answer, once closed, and for a request that already waits", async () => {
    expect(await ask(new ClarificationBroker({ interactive: false }))).toEqual({ kind: "defer" });
    const broker = new ClarificationBroker();
    const first = ask(broker);
    expect(await ask(broker)).toEqual({ kind: "defer" });
    expect(broker.has("clq-1")).toBe(true);
    broker.deferAll(true);
    expect(await first).toEqual({ kind: "defer" });
    expect(await ask(broker, request("later"))).toEqual({ kind: "defer" });
    expect(broker.pending()).toEqual([]);
  });

  it("tells whoever watches when a question opens and how it closes", async () => {
    const log: string[] = [];
    const broker = new ClarificationBroker({ opened: (r) => log.push(`open ${r.id}`), closed: (r, how) => log.push(`close ${r.id} ${how}`) });
    const a = ask(broker, request("a"));
    const b = ask(broker, request("b"));
    broker.defer("a");
    broker.cancel("b");
    await Promise.all([a, b]);
    expect(log).toEqual(["open a", "open b", "close a defer", "close b cancelled"]);
  });
});
