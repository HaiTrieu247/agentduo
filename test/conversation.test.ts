import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Conversation } from "../src/core/conversation.js";
import { CONVERSATION_MARKER } from "../src/core/prompts.js";
import { tempDir } from "./helpers/tmp.js";

let t: ReturnType<typeof tempDir>;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

const count = (text: string, part: string) => text.split(part).length - 1;

describe("Conversation", () => {
  it("opens each prompt with its marker, says who answers, and carries the question once, last", () => {
    const c = new Conversation(t.path);
    const { turn, prompt } = c.begin("claude", "What does src/chat.ts do?", [], "/repo");
    expect(prompt.startsWith(CONVERSATION_MARKER)).toBe(true);
    expect(prompt).not.toContain("[orchestrator-role:");
    expect(prompt).toContain("You are Claude Code");
    expect(count(prompt, "What does src/chat.ts do?")).toBe(1);
    expect(prompt.trimEnd().endsWith("What does src/chat.ts do?")).toBe(true);
    expect(turn.status).toBe("running");
    expect(existsSync(join(t.path, "state.json"))).toBe(false);
    expect(c.dir.startsWith(join(t.path, "conversations"))).toBe(true);
  });

  it("passes on only the answered turns, from both agents, and the pipeline tasks once", () => {
    const c = new Conversation(t.path);
    const a = c.begin("codex", "first?", [], "/repo");
    c.finish(a.turn.id, "success", "codex says one");
    const b = c.begin("claude", "second?", [], "/repo");
    c.finish(b.turn.id, "error", "never shown");
    const d = c.begin("claude", "third?", [], "/repo");
    c.finish(d.turn.id, "interrupted", null);
    const { prompt } = c.begin("claude", "fourth?", [{ task: "Add JWT auth", outcome: "done" }], "/repo");
    expect(prompt).toContain("codex says one");
    expect(prompt).not.toContain("second?");
    expect(prompt).not.toContain("never shown");
    expect(prompt).not.toContain("third?");
    expect(count(prompt, "Add JWT auth")).toBe(1);
    expect(c.context().exchanges).toEqual([{ backend: "codex", question: "first?", answer: "codex says one" }]);
  });

  it("drops the oldest exchanges whole past the budget, and never cuts the question", () => {
    const c = new Conversation(t.path);
    for (const n of [1, 2, 3]) {
      const { turn } = c.begin("codex", `q${n}`, [], "/repo");
      c.finish(turn.id, "success", `a${n}`.padEnd(50, "x"));
    }
    expect(c.context(120)).toMatchObject({ omitted: 1, exchanges: [{ question: "q2" }, { question: "q3" }] });
    const long = "y".repeat(200_000);
    const { prompt, omitted } = c.begin("claude", long, [], "/repo");
    expect(omitted).toBe(0);
    expect(prompt).toContain(long);
  });

  it("keeps a discussion's final answer as one exchange from the answerer, and none of its drafts", () => {
    const c = new Conversation(t.path);
    const d = c.beginDiscussion("codex", "claude", "Which queue?", 3);
    const first = c.discussionTurn(d.id, "answer", 1, [], "/repo");
    expect(first.prompt).toContain("[agentduo-discussion: answer, round 1 of 3]");
    expect(first.turn.logPrefix).toBe("001-codex-answer1");
    c.finish(first.turn.id, "success", "DRAFT-ONE");
    const review = c.discussionTurn(d.id, "critique", 1, [], "/repo");
    expect(review.turn.backend).toBe("claude");
    expect(review.prompt).toContain("DRAFT-ONE");
    c.finish(review.turn.id, "success", "REVIEW-ONE", "revise");
    const second = c.discussionTurn(d.id, "revise", 2, [], "/repo");
    expect(second.prompt).toContain("REVIEW-ONE");
    c.finish(second.turn.id, "success", "FINAL-TWO");
    c.finishDiscussion(d.id, "FINAL-TWO");

    const next = c.begin("claude", "And then?", [], "/repo").prompt;
    expect(count(next, "FINAL-TWO")).toBe(1);
    expect(next).toContain("discussed with Claude Code");
    expect(next).not.toContain("DRAFT-ONE");
    expect(next).not.toContain("REVIEW-ONE");
  });

  it("keeps nothing of a discussion that ended without an answer", () => {
    const c = new Conversation(t.path);
    const d = c.beginDiscussion("claude", "codex", "Unanswered question?", 3);
    const first = c.discussionTurn(d.id, "answer", 1, [], "/repo");
    c.finish(first.turn.id, "success", "a draft");
    c.finishDiscussion(d.id, null);
    expect(c.begin("codex", "Next?", [], "/repo").prompt).not.toContain("Unanswered question?");
  });
});
