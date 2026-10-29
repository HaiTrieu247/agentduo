import { describe, expect, it } from "vitest";
import type { GateResult } from "../src/core/gates.js";
import * as prompts from "../src/core/prompts.js";
import { critique, finding, impl, issue, plan, review } from "./helpers/builders.js";

const agents = { planner: "codex", plan_reviewer: "claude", implementer: "claude", code_reviewer: "codex" } as const;
const ctx: prompts.PromptContext = {
  repo: "/ws", taskId: "t1", task: "Sửa app.txt cho đúng", agents,
  gates: [{ name: "tests", command: "npm test", required: true }, { name: "lint", command: "npm run lint", required: false }],
  notes: [{ at: "2026-10-27T13:00:00+07:00", phase: "PLAN_REVIEW", note: "use redis" }],
};
const noGates: prompts.PromptContext = { ...ctx, gates: [] };
const failedGate: GateResult = { name: "tests", command: "npm test", required: true, exitCode: 1, timedOut: false, passed: false, durationSec: 1, log: "/x", outputTail: "check failed: boom" };
const RULE_WORDS = ["READ-ONLY", "Hard rules", "protected paths", "Chained commands", "Never commit", "byte-for-byte"];

describe("prompts", () => {
  it("describe roles and the output contract, with no rules of agentduo's own", () => {
    const all = [
      prompts.planner(ctx, 1, 1, null, null),
      prompts.planReviewer(ctx, 1, 1, "# Plan", null),
      prompts.planFinalizer(ctx, 1, 1, "# Plan", critique(true)),
      prompts.implementer(ctx, 1, "# Plan", [], null, [], null),
      prompts.codeReviewer(ctx, 1, "# Plan", "a".repeat(40), "b".repeat(40), [], "", "", false, [], impl()),
    ];
    for (const p of all) {
      for (const word of RULE_WORDS) expect(p).not.toContain(word);
      expect(p).toContain("Follow your own configuration and the repository's instructions");
      expect(p).toContain("implementer: Claude Code");
      expect(p).toContain("single JSON object");
    }
  });

  it("tells every agent what the previous pipeline tasks did, and stays quiet without any", () => {
    const earlier = [{ task: "Add JWT auth", outcome: "done; files: src/auth.ts" }, { task: "Add refresh tokens", outcome: "stopped" }];
    const withEarlier = { ...ctx, earlier };
    const all = [
      prompts.planner(withEarlier, 1, 1, null, null),
      prompts.planReviewer(withEarlier, 1, 1, "# Plan", null),
      prompts.planFinalizer(withEarlier, 1, 1, "# Plan", critique(true)),
      prompts.implementer(withEarlier, 1, "# Plan", [], null, [], null),
      prompts.codeReviewer(withEarlier, 1, "# Plan", "a".repeat(40), "b".repeat(40), [], "", "", false, [], impl()),
    ];
    for (const p of all) {
      expect(p).toContain("## Previous pipeline tasks");
      expect(p).toContain("1. Add JWT auth — done; files: src/auth.ts");
      expect(p).toContain("2. Add refresh tokens — stopped");
    }
    expect(prompts.planner(ctx, 1, 1, null, null)).not.toContain("Previous pipeline tasks");
  });

  it("planner v1 states the task, notes and the gates when there are any", () => {
    const p = prompts.planner(ctx, 1, 1, null, null);
    expect(p.startsWith("[orchestrator-role: planner]")).toBe(true);
    for (const s of ["Sửa app.txt cho đúng", "use redis", "- `npm test` (tests, required)", "- `npm run lint` (lint, optional)", "return `feedback_resolution` as an empty list"]) {
      expect(p).toContain(s);
    }
    expect(prompts.planner(noGates, 1, 1, null, null)).not.toContain("npm test");
  });

  it("planner revisions include the previous plan and the feedback", () => {
    const c = { ...critique(false, [issue("C1", "high", "missing migration")]), proposed_changes: ["add a migration step"] };
    const p = prompts.planner(ctx, 2, 2, plan("Old plan"), { critique: c });
    for (const s of ["## Previous plan (v1) as JSON", "Old plan", "`C1` [high] missing migration", "add a migration step", "one entry per issue id"]) expect(p).toContain(s);
  });

  it("fences the previous plan and the diff stat by their content", () => {
    const fenced = { ...plan("Old plan"), summary: "run ```npm test``` first" };
    expect(prompts.planner(ctx, 2, 2, fenced, null)).toContain("````json\n");
    const p = prompts.codeReviewer(ctx, 1, "# Plan", "a".repeat(40), "b".repeat(40), [], " ```weird``` | 1 +", "", false, [], impl());
    expect(p).toContain("## Diff stat (base → revision)\n````\n");
  });

  it("plan reviewer and finalizer see the plan and previous issues", () => {
    const r = prompts.planReviewer(ctx, 2, 2, "# Plan v2", critique(false, [issue("C1")]));
    expect(r).toContain("[orchestrator-role: plan_reviewer]");
    expect(r).toContain("Your critique from the previous round");
    const f = prompts.planFinalizer(ctx, 2, 2, "# Plan v2", critique(true, [issue("C2", "low")]));
    expect(f).toContain("`C2` [low]");
    expect(f).toContain("`A1`");
  });

  it("implementer prompts for the first round and fix rounds", () => {
    const first = prompts.implementer(ctx, 1, "# Final plan", [], null, [], null);
    expect(first).toContain("Implement the plan now");
    expect(first).toContain("After your turn agentduo runs these commands");
    expect(prompts.implementer(noGates, 1, "# Final plan", [], null, [], null)).toContain("Run the project's checks yourself");
    const fix = prompts.implementer(ctx, 2, "# Final plan", [finding("F1")], review(false, [finding("F1")], [], "a".repeat(40)), [failedGate], { summary: "did the thing" });
    for (const s of ["This is a fix round", "reviewed revision `aaaaaaaaaaaa`", "`F1` [high] `app.txt:1`", "Failing quality gates", "check failed: boom", "did the thing"]) {
      expect(fix).toContain(s);
    }
  });

  it("code reviewer sees the revision, gates, diff and previous findings, fenced safely", () => {
    const sha = "b".repeat(40);
    const diff = "+```js\n+code\n+```";
    const p = prompts.codeReviewer(ctx, 2, "# Final plan", "a".repeat(40), sha, [failedGate], " app.txt | 1 +", diff, true, [finding("F1")], impl("completed", ["F1"]));
    for (const s of [`Revision under review: \`${sha}\``, "[FAIL] tests", "TRUNCATED", "Implementer: fixed", `\`reviewed_commit\` must be exactly \`${sha}\``, "````diff\n+```js"]) {
      expect(p).toContain(s);
    }
    expect(prompts.fenceFor("no backticks")).toBe("```");
    expect(prompts.fenceFor("a ````` b")).toBe("``````");
  });
});

describe("prompts: a discussion", () => {
  const base = {
    workspace: "/ws", context: { exchanges: [], omitted: 0 }, earlier: [], question: "Redis hay Postgres cho job queue?", answerer: "codex" as const, critic: "claude" as const, maxRounds: 3,
  };
  const v1: prompts.DiscussionMessage = { backend: "codex", step: "answer", round: 1, text: "Use Postgres with SKIP LOCKED.", verdict: null };
  const c1: prompts.DiscussionMessage = { backend: "claude", step: "critique", round: 1, text: "It misses the retry story.", verdict: "revise" };

  it("opens as a conversation turn, names its step, and carries the question once", () => {
    const p = prompts.discussion({ ...base, step: "answer", round: 1, history: [] });
    expect(p.startsWith(`${prompts.CONVERSATION_MARKER}\n[agentduo-discussion: answer, round 1 of 3]`)).toBe(true);
    expect(p).toContain("You are Codex");
    expect(p).toContain("Claude Code will review");
    expect(p.split("Redis hay Postgres cho job queue?")).toHaveLength(2);
    expect(p).not.toContain("VERDICT");
  });

  it("gives the reviewer the latest version and asks it to end with its verdict", () => {
    const p = prompts.discussion({ ...base, step: "critique", round: 1, history: [v1] });
    expect(p).toContain("[agentduo-discussion: critique, round 1 of 3]");
    expect(p).toContain("You are Claude Code");
    expect(p).toContain("Use Postgres with SKIP LOCKED.");
    expect(p).toContain("VERDICT: AGREE");
    expect(p).toContain("VERDICT: REVISE");
  });

  it("asks for the whole answer again with the review addressed, and last for a final one that says what is still disputed", () => {
    const revise = prompts.discussion({ ...base, step: "revise", round: 2, history: [v1, c1] });
    expect(revise).toContain("It misses the retry story.");
    expect(revise).toContain("version 2");
    expect(revise).not.toContain("VERDICT: AGREE");
    // The step discussions took before synthesis keeps its prompt.
    const final = prompts.discussion({ ...base, maxRounds: 1, step: "final", round: 2, history: [v1, c1] });
    expect(final).toContain("[agentduo-discussion: final, round 2 of 1]");
    expect(final).toMatch(/final answer/i);
    expect(final).toMatch(/still disagree/i);
  });

  it("tells every step that Codex synthesizes the response", () => {
    for (const step of ["answer", "critique", "revise"] as const) {
      expect(prompts.discussion({ ...base, step, round: 1, history: step === "answer" ? [] : [v1] }), step).toContain("Codex, in a turn of its own, synthesizes the discussion");
    }
  });

  it("asks Codex for a neutral synthesis of the whole discussion, even when Claude answered", () => {
    const v2: prompts.DiscussionMessage = { backend: "claude", step: "revise", round: 2, text: "Postgres, with retries.", verdict: null };
    const c2: prompts.DiscussionMessage = { backend: "codex", step: "critique", round: 2, text: "Right now.", verdict: "agree" };
    const claudeFirst = { ...base, answerer: "claude" as const, critic: "codex" as const };
    const p = prompts.discussion({ ...claudeFirst, step: "synthesis", round: 2, history: [{ ...v1, backend: "claude" }, { ...c1, backend: "codex" }, v2, c2] });
    expect(p.startsWith(`${prompts.CONVERSATION_MARKER}\n[agentduo-discussion: synthesis, round 2 of 3]`)).toBe(true);
    expect(p).toContain("You are Codex.");
    expect(p).not.toContain("You are Claude Code.");
    const order = ["Use Postgres with SKIP LOCKED.", "(verdict: REVISE)", "It misses the retry story.", "Postgres, with retries.", "(verdict: AGREE)", "Right now."].map((x) => p.indexOf(x));
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!)), order.join(",")).toBe(true);
    expect(p).toContain("Codex agreed with version 2 after 2 review(s)");
    expect(p).toMatch(/not defending any version/);
    expect(p).toMatch(/replaces the last version/);
    expect(p).toMatch(/do not mention versions, reviews, or who said what/);
    expect(p).toContain("If a point is still disputed all the same");
    expect(p.split("Redis hay Postgres cho job queue?")).toHaveLength(2);
    expect(p).not.toContain("VERDICT: AGREE");
  });

  it("asks a synthesis after the reviews ran out to end with what is still disputed, titled in the answer's language", () => {
    const p = prompts.discussion({ ...base, maxRounds: 1, step: "synthesis", round: 1, history: [v1, c1] });
    expect(p).toContain("Claude Code still asked for changes after 1 review(s)");
    expect(p).toContain("End with a short closing section on the points still disputed, titled \"Còn bất đồng\" if you answer in Vietnamese");
    expect(p).toMatch(/both positions put neutrally/);
  });

  it("carries the conversation and the pipeline tasks into the synthesis as into any step", () => {
    const context = { exchanges: [{ backend: "codex" as const, question: "Earlier?", answer: "EARLIER-ANSWER" }], omitted: 0 };
    const p = prompts.discussion({ ...base, context, earlier: [{ task: "Add the queue", outcome: "done" }], step: "synthesis", round: 1, history: [v1, { ...c1, verdict: null }] });
    expect(p).toContain("EARLIER-ANSWER");
    expect(p).toContain("Add the queue — done");
    expect(p).toContain("(verdict: none given, taken as REVISE)");
  });
});
