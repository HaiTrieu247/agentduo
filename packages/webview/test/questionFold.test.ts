// Hiding an agent's question to read the conversation, and showing it again: only the page's view changes. What the page
// keeps between renders, the fold button's words and the line the folded card shows.
import type { ClarificationQuestion } from "@agentduo/engine/clarification/clarification";
import { emptyForm, setWords, toggleOption } from "@agentduo/engine/clarification/form";
import { describe, expect, it } from "vitest";
import { foldButton, QuestionFolds, waitingText } from "../src/questionFold.js";

const auth: ClarificationQuestion = {
  id: "q1", header: "Auth", question: "Which auth should the demo use?", multiSelect: false,
  options: [{ id: "o1", label: "Token", description: "" }, { id: "o2", label: "Session", description: "" }],
};
const pages: ClarificationQuestion = {
  id: "q2", header: "Pages", question: "Which pages need it?", multiSelect: true,
  options: [{ id: "o1", label: "Admin", description: "" }, { id: "o2", label: "Profile", description: "" }],
};

describe("hidden questions", () => {
  it("start shown; a toggle hides one and the next shows it again, leaving the others as they are", () => {
    const folds = new QuestionFolds();
    expect(folds.isHidden("r1")).toBe(false);
    expect(folds.toggle("r1")).toBe(true);
    expect(folds.isHidden("r1")).toBe(true);
    expect(folds.isHidden("r2")).toBe(false);
    expect(folds.toggle("r1")).toBe(false);
    expect(folds.isHidden("r1")).toBe(false);
  });

  it("stay hidden through any number of renders while they wait", () => {
    const folds = new QuestionFolds();
    folds.toggle("r1");
    folds.keep(["r1", "r2"]);
    folds.keep(["r2", "r1"]);
    expect(folds.isHidden("r1")).toBe(true);
    expect(folds.isHidden("r2")).toBe(false);
  });

  it("are let go once over, so the same request shown again later (a resumed run asks it again) starts shown", () => {
    const folds = new QuestionFolds();
    folds.toggle("r1");
    folds.toggle("r2");
    folds.keep(["r2"]);
    expect(folds.isHidden("r1")).toBe(false);
    expect(folds.isHidden("r2")).toBe(true);
    folds.keep([]);
    expect(folds.isHidden("r2")).toBe(false);
  });
});

describe("the fold button", () => {
  it("says what it does, and its accessible name holds the word it shows", () => {
    const shown = foldButton(false, 1);
    expect(shown).toMatchObject({ text: "Hide", label: "Hide the question" });
    const hidden = foldButton(true, 1);
    expect(hidden).toMatchObject({ text: "Show", label: "Show the question" });
    for (const b of [shown, hidden]) expect(b.label).toContain(b.text);
    expect(foldButton(false, 2).label).toBe("Hide the questions");
    expect(foldButton(true, 3).label).toBe("Show the questions");
  });

  it("tells, before hiding, that nothing is sent and the question keeps waiting", () => {
    expect(foldButton(false, 1).title).toMatch(/nothing is sent/i);
    expect(foldButton(false, 1).title).toMatch(/waiting/i);
    expect(foldButton(true, 1).title).toMatch(/your choices/i);
  });
});

describe("the folded card's line", () => {
  it("says the question waits, and how far the answer got, never that anything was sent", () => {
    const questions = [auth, pages];
    let form = emptyForm();
    expect(waitingText(questions, form, false)).toBe("Waiting for your answer");
    form = toggleOption(questions, form, "q1", "o2");
    expect(waitingText(questions, form, false)).toBe("1 of 2 answered, not submitted yet");
    form = setWords(questions, form, "q2", "Billing");
    expect(waitingText(questions, form, false)).toBe("All 2 answered, not submitted yet");
    expect(waitingText([auth], toggleOption([auth], emptyForm(), "q1", "o1"), false)).toBe("Answered, not submitted yet");
  });

  it("says so while an answer is on its way", () => {
    expect(waitingText([auth], toggleOption([auth], emptyForm(), "q1", "o1"), true)).toBe("Sending your answer…");
  });
});
