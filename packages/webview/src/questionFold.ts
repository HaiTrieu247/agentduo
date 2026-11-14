// An agent's question folded away while the user reads what it is about (a long plan, the messages above it), and shown
// again to answer. Only the page's view changes: the request stays open with the broker, nothing is answered, put off or
// dismissed, the agent keeps waiting, and what the user chose and typed stays in the form's draft.
import type { ClarificationQuestion } from "@agentduo/engine/clarification/clarification";
import { formComplete, isAnswered, type FormState } from "@agentduo/engine/clarification/form";

/** The open questions whose form the user has hidden, by request id; kept while the cards are rebuilt. */
export class QuestionFolds {
  readonly #hidden = new Set<string>();

  isHidden(id: string): boolean {
    return this.#hidden.has(id);
  }

  /** Hides `id`'s form, or shows it again; whether it is hidden now. */
  toggle(id: string): boolean {
    if (this.#hidden.delete(id)) return false;
    this.#hidden.add(id);
    return true;
  }

  /** `open`: the questions still waiting. The others are let go, so a question shown again later starts shown. */
  keep(open: readonly string[]): void {
    for (const id of [...this.#hidden]) if (!open.includes(id)) this.#hidden.delete(id);
  }
}

/** The fold button: the word it shows, its accessible name (which holds that word) and its tooltip. */
export function foldButton(hidden: boolean, count: number): { text: string; label: string; title: string } {
  const what = count === 1 ? "the question" : "the questions";
  return hidden
    ? { text: "Show", label: `Show ${what}`, title: `Show ${what} again, with your choices and what you typed` }
    : { text: "Hide", label: `Hide ${what}`, title: `Hide ${what} to read the conversation. Nothing is sent: it keeps waiting, with your choices` };
}

/** What the folded card says beside who asks: that the question waits, and how far the answer got (never sent). */
export function waitingText(questions: readonly ClarificationQuestion[], form: FormState, sending: boolean): string {
  if (sending) return "Sending your answer…";
  const answered = questions.filter((q) => isAnswered(q, form)).length;
  if (!answered) return "Waiting for your answer";
  if (answered === questions.length && formComplete(questions, form)) {
    return questions.length === 1 ? "Answered, not submitted yet" : `All ${questions.length} answered, not submitted yet`;
  }
  return `${answered} of ${questions.length} answered, not submitted yet`;
}
