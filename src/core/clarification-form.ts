/**
 * What a screen holds while the user fills in a question: the options picked and the words written, per question. Pure and
 * Node-free (the webview bundles it), so the terminal, VS Code and the desktop share one set of rules: a single-choice
 * question takes an option or the user's own words (the latest wins), a multiple-choice one takes both; nothing is
 * picked for the user, and nothing can be submitted until every question has an answer.
 */
import { answerErrors, cleanAnswers, type ClarificationAnswer, type ClarificationQuestion } from "./clarification.js";

export interface FormState {
  /** Option ids picked, by question id. */
  picked: Record<string, string[]>;
  /** The user's own words, by question id. */
  words: Record<string, string>;
}

export const emptyForm = (): FormState => ({ picked: {}, words: {} });

/** Picks or unpicks an option. A single-choice question holds only that option (and drops words written before). */
export function toggleOption(questions: readonly ClarificationQuestion[], form: FormState, questionId: string, optionId: string): FormState {
  const q = questions.find((x) => x.id === questionId);
  if (!q || !q.options.some((o) => o.id === optionId)) return form;
  const now = form.picked[questionId] ?? [];
  if (q.multiSelect) {
    const next = now.includes(optionId) ? now.filter((id) => id !== optionId) : [...now, optionId];
    return { ...form, picked: { ...form.picked, [questionId]: next } };
  }
  // Choosing the option already chosen takes it back.
  const next = now.includes(optionId) ? [] : [optionId];
  return { picked: { ...form.picked, [questionId]: next }, words: next.length ? { ...form.words, [questionId]: "" } : form.words };
}

/** Sets the user's own words. In a single-choice question, words replace the option picked. */
export function setWords(questions: readonly ClarificationQuestion[], form: FormState, questionId: string, text: string): FormState {
  const q = questions.find((x) => x.id === questionId);
  if (!q) return form;
  const words = { ...form.words, [questionId]: text };
  return !q.multiSelect && text.trim() ? { picked: { ...form.picked, [questionId]: [] }, words } : { ...form, words };
}

/** The answers as they would be sent now (questions with nothing picked or written have empty ones, which do not validate). */
export function formAnswers(questions: readonly ClarificationQuestion[], form: FormState): ClarificationAnswer[] {
  return questions.map((q) => {
    const words = (form.words[q.id] ?? "").trim();
    return { questionId: q.id, optionIds: q.options.filter((o) => (form.picked[q.id] ?? []).includes(o.id)).map((o) => o.id), otherText: words || null };
  });
}

/** Whether a question has an answer yet. */
export function isAnswered(q: ClarificationQuestion, form: FormState): boolean {
  return (form.picked[q.id] ?? []).length > 0 || !!(form.words[q.id] ?? "").trim();
}

/** What keeps the form from being submitted, in words for the user; empty when it can be. */
export function formProblems(questions: readonly ClarificationQuestion[], form: FormState): string[] {
  const missing = questions.flatMap((q, i) => (isAnswered(q, form) ? [] : [`question ${i + 1}${q.header ? ` (${q.header})` : ""} has no answer yet`]));
  return missing.length ? missing : answerErrors([...questions], formAnswers(questions, form));
}

export const formComplete = (questions: readonly ClarificationQuestion[], form: FormState): boolean => formProblems(questions, form).length === 0;

/** The answers to submit, cleaned; null while the form is not complete. */
export function formSubmission(questions: readonly ClarificationQuestion[], form: FormState): ClarificationAnswer[] | null {
  return formComplete(questions, form) ? cleanAnswers([...questions], formAnswers(questions, form)) : null;
}
