import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  archiveConversation, Conversation, ConversationError, deleteConversation, isArchivedConversation, listConversations, restoreConversation,
} from "../../src/chat/conversation.js";
import { acquireLockFile } from "../../src/workflow/state.js";
import { conversationBusy, conversationLockPath } from "../../src/workflow/lease.js";
import { CONVERSATION_MARKER } from "../../src/workflow/prompts.js";
import { tempDir } from "../helpers/tmp.js";

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

  it("lists the workspace paths a message or a discussion question tags with @, in its prompts", () => {
    const ws = join(t.path, "ws");
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "src", "a.ts"), "x\n");
    const c = new Conversation(join(t.path, "runs"));
    const { prompt } = c.begin("claude", "What does @src/a.ts do? And @missing.ts?", [], ws);
    expect(prompt).toContain("### Workspace paths the user tagged\n");
    expect(prompt).toContain("- `src/a.ts` (file)");
    expect(prompt).not.toContain("`missing.ts`");
    const d = c.beginDiscussion("codex", "claude", "Is @src right?", 1);
    expect(c.discussionTurn(d.id, "answer", 1, [], ws).prompt).toContain("- `src/` (folder)");
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

  it("has Codex write the synthesis, whoever answered, and keeps it as Codex's answer discussed with the other agent", () => {
    const c = new Conversation(t.path, { id: "conv-s" });
    const earlier = [{ task: "Add the queue", outcome: "done" }];
    const q = c.begin("claude", "Earlier question?", [], "/repo");
    c.finish(q.turn.id, "success", "EARLIER-ANSWER");
    const d = c.beginDiscussion("claude", "codex", "Which queue?", 3);
    const first = c.discussionTurn(d.id, "answer", 1, earlier, "/repo");
    c.finish(first.turn.id, "success", "DRAFT-ONE");
    const review = c.discussionTurn(d.id, "critique", 1, earlier, "/repo");
    expect(review.turn.backend).toBe("codex");
    c.finish(review.turn.id, "success", "REVIEW-ONE", "agree");
    const synthesis = c.discussionTurn(d.id, "synthesis", 1, earlier, "/repo");
    expect(synthesis.turn.backend).toBe("codex");
    expect(synthesis.turn.discussion).toEqual({ id: d.id, step: "synthesis", round: 1 });
    expect(synthesis.turn.logPrefix).toBe("004-codex-synthesis1");
    for (const part of ["You are Codex.", "EARLIER-ANSWER", "Add the queue", "DRAFT-ONE", "REVIEW-ONE", "(verdict: AGREE)"]) expect(synthesis.prompt).toContain(part);
    c.finish(synthesis.turn.id, "success", "SYNTHESIS");
    c.finishDiscussion(d.id, "SYNTHESIS", "codex");
    expect(c.context().exchanges.at(-1)).toEqual({ backend: "codex", question: "Which queue?", answer: "SYNTHESIS", discussedWith: "claude" });

    const next = Conversation.open(t.path, "conv-s").begin("claude", "And then?", [], "/repo").prompt;
    expect(next).toContain("**Codex, after discussing it with Claude Code:**\nSYNTHESIS");
    for (const draft of ["DRAFT-ONE", "REVIEW-ONE"]) expect(next).not.toContain(draft);
  });

  it("keeps the answerer's own version, discussed with the reviewer, when the response is not a synthesis", () => {
    const c = new Conversation(t.path);
    const d = c.beginDiscussion("claude", "codex", "Which queue?", 3);
    c.finishDiscussion(d.id, "CLAUDE-VERSION", "claude");
    const e = c.beginDiscussion("codex", "claude", "And the retries?", 3);
    c.finishDiscussion(e.id, "CODEX-SYNTHESIS", "codex");
    expect(c.context().exchanges).toEqual([
      { backend: "claude", question: "Which queue?", answer: "CLAUDE-VERSION", discussedWith: "codex" },
      { backend: "codex", question: "And the retries?", answer: "CODEX-SYNTHESIS", discussedWith: "claude" },
    ]);
  });

  it("keeps nothing of a discussion that ended without an answer", () => {
    const c = new Conversation(t.path);
    const d = c.beginDiscussion("claude", "codex", "Unanswered question?", 3);
    const first = c.discussionTurn(d.id, "answer", 1, [], "/repo");
    c.finish(first.turn.id, "success", "a draft");
    c.finishDiscussion(d.id, null);
    expect(c.begin("codex", "Next?", [], "/repo").prompt).not.toContain("Unanswered question?");
  });

  it("saves what it needs to go on, and a conversation opened by its id carries on from there", () => {
    const c = new Conversation(t.path, { id: "conv-a" });
    expect(c.id).toBe("conv-a");
    c.title = "Which queue?";
    const { turn } = c.begin("codex", "Which queue?", [], "/repo");
    c.finish(turn.id, "success", "Postgres with SKIP LOCKED.");
    c.recipient = "claude";
    c.addEarlier({ task: "Add the queue", outcome: "done" });
    const d = c.beginDiscussion("claude", "codex", "And the retries?", 3);
    c.finishDiscussion(d.id, "Three, with backoff.");

    const again = Conversation.open(t.path, "conv-a");
    expect([again.id, again.title, again.recipient]).toEqual(["conv-a", "Which queue?", "claude"]);
    expect(again.earlier).toEqual([{ task: "Add the queue", outcome: "done" }]);
    const next = again.begin("claude", "Next?", again.earlier, "/repo");
    expect(next.prompt).toContain("Postgres with SKIP LOCKED.");
    expect(next.prompt).toContain("Three, with backoff.");
    expect(next.prompt).toContain("Add the queue");
    expect(next.turn.logPrefix).toBe("002-claude"); // its logs go on from the turns it had
    // A conversation nobody said anything in leaves no file behind.
    expect(Conversation.open(t.path, "conv-new").title).toBe("");
    expect(existsSync(join(t.path, "conversations", "conv-new", "conversation.json"))).toBe(false);
  });

  it("lists the conversations it saved, the most recently changed first", () => {
    let tick = 0;
    const clock = () => new Date(2026, 9, 28, 10, 0, tick++);
    const a = new Conversation(t.path, { id: "conv-a", clock });
    a.title = "First";
    const b = new Conversation(t.path, { id: "conv-b", clock });
    b.title = "Second";
    a.recipient = "claude"; // a later change moves it up
    expect(listConversations(t.path).map((x) => x.id)).toEqual(["conv-a", "conv-b"]);
    expect(listConversations(t.path)[1]).toMatchObject({ id: "conv-b", title: "Second" });
    expect(listConversations(join(t.path, "missing"))).toEqual([]);
  });
});

describe("archiving and deleting conversations", () => {
  const saved = (id: string, title: string) => {
    const c = new Conversation(t.path, { id });
    c.title = title;
    return c;
  };

  it("hides an archived conversation from the list and keeps it whole, until it is restored", () => {
    saved("conv-a", "First");
    saved("conv-b", "Second");
    archiveConversation(t.path, "conv-a");
    expect(isArchivedConversation(t.path, "conv-a")).toBe(true);
    expect(listConversations(t.path).map((x) => x.id)).toEqual(["conv-b"]);
    const archived = listConversations(t.path, "archived");
    expect(archived.map((x) => x.id)).toEqual(["conv-a"]);
    expect(archived[0]!.archivedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(listConversations(t.path, "all").map((x) => x.id).sort()).toEqual(["conv-a", "conv-b"]);
    // Its own file: a save of the record by any window keeps it archived.
    const reopened = Conversation.open(t.path, "conv-a");
    reopened.recipient = "claude";
    expect(isArchivedConversation(t.path, "conv-a")).toBe(true);
    expect(reopened.title).toBe("First");
    restoreConversation(t.path, "conv-a");
    expect(listConversations(t.path).map((x) => x.id).sort()).toEqual(["conv-a", "conv-b"]);
    expect(listConversations(t.path)[0]!.archivedAt).toBeNull();
  });

  it("deletes a conversation with its files, and a window that still has it open never writes it back", () => {
    const open = saved("conv-a", "First");
    saved("conv-b", "Second");
    deleteConversation(t.path, "conv-a");
    expect(existsSync(join(t.path, "conversations", "conv-a"))).toBe(false);
    expect(readdirSync(join(t.path, "conversations"))).toEqual(["conv-b"]);
    expect(open.deleted).toBe(true);
    open.recipient = "codex";
    open.title = "Back?";
    expect(existsSync(join(t.path, "conversations", "conv-a"))).toBe(false);
    // One never saved is not deleted: it has nothing on disk yet.
    expect(new Conversation(t.path, { id: "conv-new" }).deleted).toBe(false);
  });

  it("refuses what it cannot do: an unknown conversation, a bad id, one another agentduo works in", () => {
    saved("conv-a", "First");
    for (const act of [archiveConversation, restoreConversation, deleteConversation]) {
      expect(() => act(t.path, "conv-missing")).toThrow(ConversationError);
      expect(() => act(t.path, "../conv-a")).toThrow(ConversationError);
    }
    const release = acquireLockFile(conversationLockPath(t.path, "conv-a"), conversationBusy);
    try {
      expect(() => archiveConversation(t.path, "conv-a")).toThrow(/in use/);
      expect(() => deleteConversation(t.path, "conv-a")).toThrow(/in use/);
    } finally {
      release();
    }
    expect(existsSync(join(t.path, "conversations", "conv-a", "conversation.json"))).toBe(true);
    expect(isArchivedConversation(t.path, "conv-a")).toBe(false);
  });
});
