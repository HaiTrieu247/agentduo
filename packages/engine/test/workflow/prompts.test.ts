import { describe, expect, it } from "vitest";
import type { ReviewFindings } from "../../src/quality/findings.js";
import type { GateResult } from "../../src/quality/gates.js";
import type { Change } from "../../src/git/git.js";
import type { PathEntry } from "../../src/inputs/mention-text.js";
import * as prompts from "../../src/workflow/prompts.js";
import { critique, finding, impl, issue, plan } from "../helpers/builders.js";

const agents = { planner: "codex", plan_reviewer: "claude", implementer: "claude", code_reviewer: "codex" } as const;
const ctx: prompts.PromptContext = {
  repo: "/ws", taskId: "t1", task: "Sửa app.txt cho đúng", agents,
  gates: [{ name: "tests", command: "npm test", required: true }, { name: "lint", command: "npm run lint", required: false }],
  notes: [{ at: "2026-10-27T13:00:00+07:00", phase: "PLAN_REVIEW", note: "use redis" }],
};
const noGates: prompts.PromptContext = { ...ctx, gates: [] };
const failedGate: GateResult = { name: "tests", command: "npm test", required: true, exitCode: 1, timedOut: false, passed: false, durationSec: 1, log: "/x", outputTail: "check failed: boom" };
/** The open findings of a review of `revision`; `answered` ids carry the implementer's `fixed`. */
const findingsOf = (ids: string[], o: { answered?: string[]; revision?: string; changedSince?: Change[] | null } = {}): ReviewFindings => ({
  round: 1, revision: o.revision ?? "a".repeat(40), summary: "REVIEW-SUMMARY", changedSince: o.changedSince === undefined ? [] : o.changedSince,
  items: ids.map((id) => ({
    finding: finding(id), fileChange: o.changedSince?.some(([, p]) => p === "app.txt") ? "M" : null,
    answer: o.answered?.includes(id) ? { id, resolution: "fixed" as const, notes: "done", round: 2, status: "completed" as const } : null,
  })),
});
const RULE_WORDS = ["READ-ONLY", "Hard rules", "protected paths", "Chained commands", "Never commit", "byte-for-byte"];

describe("prompts", () => {
  it("describe roles and the output contract, with no rules of agentduo's own", () => {
    const all = [
      prompts.planner(ctx, 1, 1, null, null),
      prompts.planReviewer(ctx, 1, 1, "# Plan", null),
      prompts.planFinalizer(ctx, 1, 1, "# Plan", critique(true)),
      prompts.implementer(ctx, 1, "# Plan", null, [], null),
      prompts.codeReviewer(ctx, 1, "# Plan", "a".repeat(40), "b".repeat(40), [], "", "", false, null, impl()),
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
      prompts.implementer(withEarlier, 1, "# Plan", null, [], null),
      prompts.codeReviewer(withEarlier, 1, "# Plan", "a".repeat(40), "b".repeat(40), [], "", "", false, null, impl()),
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
    const p = prompts.codeReviewer(ctx, 1, "# Plan", "a".repeat(40), "b".repeat(40), [], " ```weird``` | 1 +", "", false, null, impl());
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
    const first = prompts.implementer(ctx, 1, "# Final plan", null, [], null);
    expect(first).toContain("Implement the plan now");
    expect(first).toContain("After your turn agentduo runs these commands");
    expect(prompts.implementer(noGates, 1, "# Final plan", null, [], null)).toContain("Run the project's checks yourself");
    const fix = prompts.implementer(ctx, 2, "# Final plan", findingsOf(["F1"]), [failedGate], { summary: "did the thing" });
    for (const s of ["This is a fix round", "raised on revision `aaaaaaaaaaaa`", "`F1` [high] `app.txt:1`", "Failing quality gates", "check failed: boom", "did the thing"]) {
      expect(fix).toContain(s);
    }
  });

  it("tells the implementer which findings are still open, which it answered since, and which may be out of date", () => {
    const p = prompts.implementer(ctx, 3, "# Final plan", findingsOf(["F1", "F2"], { answered: ["F1"], changedSince: [["M", "app.txt"]] }), [], null);
    for (const s of ["### Code review findings (review round 1, raised on revision `aaaaaaaaaaaa`)", "REVIEW-SUMMARY",
      "Since `aaaaaaaaaaaa` these files changed (A added, M modified, D deleted):\n- M `app.txt`\nA finding about one of them may be fixed already",
      "#### Open: not answered since that review\n- `F2` [high] `app.txt:1` — bad", "its file changed since that revision",
      "#### Answered since that review, not verified yet\nThe next review verifies these", "Your answer: fixed: done (round 2)",
      "answer every open finding", "answer an already answered one again only if your answer changes."]) {
      expect(p).toContain(s);
    }
    expect(p.indexOf("`F2` [high]")).toBeLessThan(p.indexOf("`F1` [high]"));
    expect(prompts.implementer(ctx, 3, "# Final plan", findingsOf(["F1"], { answered: ["F1"] }), [failedGate], null))
      .toContain("Every finding is answered: add an entry to `addressed_findings` only for one whose answer changes.");
    expect(prompts.implementer(ctx, 3, "# Final plan", findingsOf(["F1"]), [], null)).toContain("No file changed since `aaaaaaaaaaaa`.");
    expect(prompts.implementer(ctx, 3, "# Final plan", findingsOf(["F1"], { changedSince: null }), [], null))
      .toContain("agentduo cannot tell what changed since `aaaaaaaaaaaa`: check each finding against the current code");
  });

  it("tells a re-run of a round what its earlier attempt left in the working tree", () => {
    const rerun = { status: "blocked", summary: "EARLIER-SUMMARY", blockingReason: "API key needed", changes: [["M", "app.txt"]] as Change[] };
    const p = prompts.implementer(ctx, 1, "# Final plan", null, [], { summary: "EARLIER-SUMMARY", rerun });
    for (const s of ["## An earlier attempt of this round\nIt ended blocked: API key needed.\nIts report: EARLIER-SUMMARY", "by it or by the user since",
      "- M `app.txt`", "These changes are in the working tree: continue from them.", "Finish implementing the plan."]) {
      expect(p).toContain(s);
    }
    expect(p).not.toContain("Implement the plan now");
    expect(p.match(/EARLIER-SUMMARY/g)).toHaveLength(1);
    const stopped = prompts.implementer(ctx, 2, "# Final plan", findingsOf(["F1"]), [], { summary: "ROUND-1", rerun: { status: null, summary: null, blockingReason: null, changes: [] } });
    for (const s of ["It did not finish: it failed, or the run was stopped.", "No file changed in this round so far.", "This is a fix round"]) expect(stopped).toContain(s);
    expect(stopped).not.toContain("ROUND-1");
  });

  it("tells the planner and the critic what fails before any change, and to keep the task as it states it", () => {
    const passing: GateResult = { ...failedGate, name: "lint", command: "npm run lint", required: false, passed: true, exitCode: 0 };
    const withBaseline: prompts.PromptContext = { ...ctx, baseline: [failedGate, passing] };
    const p = prompts.planner(withBaseline, 1, 1, null, null);
    for (const s of ["## Quality gates before any change (baseline)", "- [FAIL] tests (required)", "check failed: boom", "- [PASS] lint (optional)",
      "## Required gates that fail before any change\n- `tests`\n\nIn `baseline_failures`, give one entry for each", "Never drop, relax or reinterpret what the task asks"]) {
      expect(p).toContain(s);
    }
    expect(prompts.planner(ctx, 1, 1, null, null)).toContain("No required gate fails before any change that agentduo knows of: `baseline_failures` is an empty list.");
    const c = prompts.planReviewer(withBaseline, 1, 1, "# Plan", null);
    for (const s of ["## Consistency check", "list it in `conflicts` (ids `K1`, `K2`, ...)", "never suggest settling one by bending the task", "## Quality gates before any change"]) {
      expect(c).toContain(s);
    }
    // A continued session was given it already.
    expect(prompts.planReviewer({ ...withBaseline, continued: { changed: [], knowsPlan: false } }, 2, 2, "# Plan", null)).not.toContain("## Quality gates before any change");
  });

  it("asks the reviewer where each problem comes from, which gates to attribute, and what the user accepted", () => {
    const sha = "b".repeat(40);
    const contract = { attribute: ["layout"], accepted: [{ kind: "finding" as const, id: "F2", text: "[high] a.css: bad", evidence: "e" }], kept: [] };
    const p = prompts.codeReviewer(ctx, 2, "# Plan", "a".repeat(40), sha, [], "", "", false, null, impl(), undefined, contract);
    for (const s of ["## Where each problem stands against the task", "- `pre_existing`: it was there before the task", "never call a problem pre-existing without that evidence",
      "## Required gates that failed before the task too\n- `layout`", "## Pre-existing failures the user accepted for this run\n- finding `F2`: [high] a.css: bad"]) {
      expect(p).toContain(s);
    }
    expect(prompts.codeReviewer(ctx, 1, "# Plan", "a".repeat(40), sha, [], "", "", false, null, impl())).toContain("`gate_failures` is an empty list.");
  });

  it("holds every role to the task's acceptance contract: criteria with ids, and nothing outside the task without the user", () => {
    const planner = prompts.planner(ctx, 1, 1, null, null);
    expect(planner).toContain("each with an `id` (`AC1`, `AC2`, ...)");
    expect(planner).toContain("they are the task's acceptance contract");
    const revision = prompts.planner(ctx, 2, 2, plan("Old plan"), { critique: critique(false, [issue("C2", "medium", "also verify landscape", "out_of_scope")]) });
    expect(revision).toContain("`C2` [medium] (outside the task's scope) also verify landscape");
    expect(revision).toContain("do not adopt them");
    const critic = prompts.planReviewer(ctx, 1, 1, "# Plan", null);
    for (const s of ["## The task's scope", "- `task`:", "- `out_of_scope`: asks for more than the task needs", "only if no critical or high issue of the task's scope remains"]) {
      expect(critic).toContain(s);
    }
    expect(prompts.planReviewer(ctx, 2, 2, "# Plan", null, [{ kind: "suggestion", id: "C2", text: "[medium] also verify landscape", evidence: "accepted: ok" }]))
      .toContain("## Scope the user approved\n- suggestion `C2`: [medium] also verify landscape");
    expect(prompts.planFinalizer(ctx, 1, 1, "# Plan", critique(true))).toContain("`out_of_scope`");
    const reviewer = prompts.codeReviewer(ctx, 1, "# Plan", "a".repeat(40), "b".repeat(40), [], "", "", false, null, impl(), undefined,
      { attribute: [], accepted: [], kept: [{ kind: "finding", id: "F3", text: "[critical] ui.css: bad", evidence: "leaks" }] });
    for (const s of ["## Where each problem stands against the task", "the task's acceptance contract: hold the change to them, never to more",
      "- `out_of_scope`: an improvement or concern beyond what the task and its criteria ask", "Only a critical one blocks completion",
      "Out-of-scope findings never hold back your approval", "## Findings the user kept outside the task's scope\n- finding `F3`: [critical] ui.css: bad"]) {
      expect(reviewer).toContain(s);
    }
    const extra = { ...findingsOf(["F1"]), items: [{ finding: finding("F5", "high", "ui.css", "out_of_scope"), answer: null, fileChange: null }] };
    expect(prompts.implementer(ctx, 2, "# Plan", extra, [], null)).toContain("The reviewer marks it outside the task's scope (a suggestion, not part of the task): do not act on it");
    const traced = { ...findingsOf(["F1"]), items: [{ finding: finding("F6", "high", "app.txt", "in_scope", ["AC1", "AC2"]), answer: null, fileChange: null }] };
    expect(prompts.implementer(ctx, 2, "# Plan", traced, [], null)).toContain("Fails acceptance criteria: AC1, AC2");
  });

  it("asks the reviewer to keep a finding's id, to say why a late one comes late, and lists what earlier reviews resolved", () => {
    const sha = "b".repeat(40);
    const resolved = [{ key: "F2", ids: ["F2", "F5"], file: "db.ts", issue: "x".repeat(130), severity: "high" as const, origin: "regression" as const, criteria: [],
      status: "resolved" as const, seen: [{ round: 1, revision: "a" }], resolvedRound: 2, reopened: 0 }];
    const p = prompts.codeReviewer(ctx, 3, "# Plan", "a".repeat(40), sha, [], "", "", false, null, impl(), undefined, { attribute: [], accepted: [], kept: [], resolved });
    expect(p).toContain("Keep a finding's id when you raise it again, even in other words: a new id says the issue is new.");
    expect(p).toContain("must say in `late_reason` why it was not reported then");
    expect(p).toContain(`## Findings earlier reviews resolved\nRaise one again only if it is back, under its id:\n- \`F5\` (resolved in round 2) db.ts: ${"x".repeat(119)}…\n`);
    expect(prompts.codeReviewer(ctx, 1, "# Plan", "a".repeat(40), sha, [], "", "", false, null, impl())).not.toContain("## Findings earlier reviews resolved");
  });

  it("code reviewer sees the revision, gates, diff and previous findings, fenced safely", () => {
    const sha = "b".repeat(40);
    const diff = "+```js\n+code\n+```";
    const p = prompts.codeReviewer(ctx, 2, "# Final plan", "a".repeat(40), sha, [failedGate], " app.txt | 1 +", diff, true, findingsOf(["F1"], { answered: ["F1"] }), impl("completed", ["F1"]));
    for (const s of [`Revision under review: \`${sha}\``, "[FAIL] tests", "TRUNCATED", `\`reviewed_commit\` must be exactly \`${sha}\``, "````diff\n+```js",
      "## Findings from the previous review (round 1, raised on revision `aaaaaaaaaaaa`) and the implementer's answers\nNo file changed since `aaaaaaaaaaaa`.",
      "Implementer: fixed: done (round 2)  \n  its file did not change since that revision", `Verify each finding against the revision under review (\`${sha}\`)`]) {
      expect(p).toContain(s);
    }
    const changed = prompts.codeReviewer(ctx, 2, "# Final plan", "a".repeat(40), sha, [], "", "", false, findingsOf(["F1"], { changedSince: [["M", "app.txt"]] }), impl());
    expect(changed).toContain("Implementer: no answer  \n  its file changed since that revision");
    expect(prompts.fenceFor("no backticks")).toBe("```");
    expect(prompts.fenceFor("a ````` b")).toBe("``````");
  });

  it("tells every role of a run with agentduo's own snapshots, and points the reviewer at the whole diff, never at git in the workspace", () => {
    const sha = "b".repeat(40);
    const internal = { ...ctx, internalSnapshots: true };
    const cut = prompts.codeReviewer(internal, 1, "# Final plan", "a".repeat(40), sha, [], " app.txt | 1 +", "+x", true, null, impl(), "/runs/r/diff.r1.patch");
    for (const s of ["- Snapshots: agentduo keeps this run's snapshots in a Git repository of its own", "TRUNCATED: read the whole diff in `/runs/r/diff.r1.patch`",
      "in agentduo's own repository: review it from the diff below"]) expect(cut).toContain(s);
    expect(cut).not.toContain("run `git diff");
    expect(prompts.planner(internal, 1, 1, null, null)).toContain("- Snapshots: agentduo keeps");
    // A native run's prompts are as they were.
    const native = prompts.codeReviewer(ctx, 1, "# Final plan", "a".repeat(40), sha, [], " app.txt | 1 +", "+x", true, null, impl(), "/runs/r/diff.r1.patch");
    expect(native).toContain("TRUNCATED: run `git diff " + "a".repeat(40) + " " + sha + " -- .` for the full diff");
    expect(native).not.toContain("Snapshots:");
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

describe("attachment manifests", () => {
  const file = (id: string, name: string, image: boolean) => ({
    id, name, mediaType: image ? "image/png" : "application/pdf", size: 2048, image: image ? { format: "png" as const, width: 64, height: 32 } : null,
    path: `conversations/c1/attachments/${id}/${name}`,
  });
  const shot = file("a1", "shot `1`.png", true);
  const spec = file("a2", "spec.pdf", false);
  const locate: prompts.Locate = (a) => (a.id === "gone" ? null : `/ws/.agentduo/runs/${a.path}`);
  const count = (text: string, part: string) => text.split(part).length - 1;

  it("list each file of the message once, with its path, after the message; history lists paths only", () => {
    const context = { exchanges: [{ backend: "codex" as const, question: "What is this?", answer: "A chart.", attachments: [shot] }], omitted: 0 };
    const p = prompts.conversation({ workspace: "/ws", backend: "claude", context, earlier: [], question: "And this one?", attachments: [spec], locate });
    expect(count(p, "/attachments/a2/")).toBe(1);
    expect(p).toContain("- `spec.pdf` (application/pdf, 2 KB): `/ws/.agentduo/runs/conversations/c1/attachments/a2/spec.pdf`");
    expect(p.indexOf("And this one?")).toBeLessThan(p.indexOf("### Files the user attached to this message"));
    expect(p).toContain("The images your CLI can take are also attached to this message as images");
    // An earlier message's file: named with its path, never as attached to this message.
    expect(p).toContain("Files attached to that message (not attached again; read them at their paths if you need them):\n- ``shot `1`.png`` (PNG 64×32, 2 KB)");
    expect(count(p, "/attachments/a1/")).toBe(1);
    expect(prompts.conversation({ workspace: "/ws", backend: "claude", context: { exchanges: [], omitted: 0 }, earlier: [], question: "hi" })).not.toContain("Files");
  });

  it("give every discussion step the question's files, and the pipeline the task's and the notes'", () => {
    const steps = (["answer", "critique", "revise", "synthesis"] as const).map((step) => prompts.discussion({
      workspace: "/ws", context: { exchanges: [], omitted: 0 }, earlier: [], question: "Is the chart right?", answerer: "codex", critic: "claude", maxRounds: 2,
      step, round: 1, history: [], attachments: [shot], locate,
    }));
    for (const p of steps) expect(count(p, "/attachments/a1/")).toBe(1);
    const withFiles: prompts.PromptContext = {
      ...ctx, attachments: [spec], locate,
      notes: [{ at: "2026-10-29T10:00:00+07:00", phase: "IMPLEMENT", note: "match this mockup", attachments: [shot] }, { ...ctx.notes[0]!, attachments: [{ ...shot, id: "gone" }] }],
    };
    for (const p of [prompts.planner(withFiles, 1, 1, null, null), prompts.implementer(withFiles, 1, "# Plan", null, [], null)]) {
      expect(count(p, "/attachments/a2/spec.pdf")).toBe(1);
      expect(p.indexOf("### Files the user attached to the task")).toBeGreaterThan(p.indexOf("## Task"));
      expect(p).toContain("- (2026-10-29T10:00:00+07:00, during IMPLEMENT) match this mockup\n  Files:\n  - ``shot `1`.png``");
      expect(p).toContain("no longer available");
    }
    expect(prompts.planner(ctx, 1, 1, null, null)).not.toContain("Files");
  });
});

describe("tagged workspace paths", () => {
  const entries: Record<string, PathEntry[]> = {
    "Explain @src/a.ts and @src": [{ path: "src/a.ts", kind: "file" }, { path: "src/", kind: "folder" }],
    "Fix @app.txt": [{ path: "app.txt", kind: "file" }],
    "look at @docs/x.md": [{ path: "docs/x.md", kind: "file" }],
  };
  const tagged = (text: string) => entries[text] ?? [];
  const empty = { exchanges: [], omitted: 0 };

  it("list the message's tagged files and folders once, after it", () => {
    const p = prompts.conversation({ workspace: "/ws", backend: "claude", context: empty, earlier: [], question: "Explain @src/a.ts and @src", tagged });
    expect(p).toContain("### Workspace paths the user tagged\n");
    expect(p).toContain("- `src/a.ts` (file)\n- `src/` (folder)");
    expect(p.indexOf("Explain @src/a.ts")).toBeLessThan(p.indexOf("### Workspace paths the user tagged"));
    expect(prompts.conversation({ workspace: "/ws", backend: "claude", context: empty, earlier: [], question: "hi", tagged })).not.toContain("tagged");
    expect(prompts.conversation({ workspace: "/ws", backend: "claude", context: empty, earlier: [], question: "Explain @src/a.ts and @src" })).not.toContain("tagged");
  });

  it("give every discussion step the question's, and the pipeline the task's and the notes'", () => {
    for (const step of ["answer", "critique", "revise", "synthesis"] as const) {
      const p = prompts.discussion({
        workspace: "/ws", context: empty, earlier: [], question: "Explain @src/a.ts and @src", answerer: "codex", critic: "claude", maxRounds: 2, step, round: 1, history: [], tagged,
      });
      expect(p).toContain("- `src/a.ts` (file)\n- `src/` (folder)");
    }
    const withTags: prompts.PromptContext = {
      ...ctx, task: "Fix @app.txt", tagged, notes: [{ at: "2026-11-04T10:00:00+07:00", phase: "IMPLEMENT", note: "look at @docs/x.md" }],
    };
    for (const p of [prompts.planner(withTags, 1, 1, null, null), prompts.implementer(withTags, 1, "# Plan", null, [], null)]) {
      expect(p.indexOf("### Workspace paths the user tagged in the task")).toBeGreaterThan(p.indexOf("## Task"));
      expect(p).toContain("- `app.txt` (file)");
      expect(p).toContain("- (2026-11-04T10:00:00+07:00, during IMPLEMENT) look at @docs/x.md\n  Tagged: `docs/x.md`");
    }
  });
});

describe("prompts shared between the agents of a run", () => {
  const conversation = { exchanges: [{ backend: "codex" as const, question: "Which file?", answer: "CONVERSATION-ANSWER" }], omitted: 0 };
  const full: prompts.PromptContext = { ...ctx, conversation, earlier: [{ task: "EARLIER-TASK", outcome: "done" }], planFile: "/runs/t1/plan.final.md" };
  /** A turn that continues the role's session: only the note it has not seen, and the files changed since its last turn. */
  const continued = (extra: Partial<prompts.ContinuedTurn> = {}): prompts.PromptContext => ({
    ...full, notes: [{ at: "2026-11-03T09:00:00+07:00", phase: "CODE_REVIEW", note: "NEW-NOTE" }],
    continued: { changed: [["M", "app.txt"], ["A", "docs/new.md"]], knowsPlan: true, ...extra },
  });
  const planMd = "# Plan v2: PLAN-BODY";
  const base = "a".repeat(40);
  const snap = "b".repeat(40);
  const all = (c: prompts.PromptContext) => ({
    planner: prompts.planner(c, 2, 2, plan("PREVIOUS-PLAN"), { critique: critique(false, [issue("C1", "high", "CRITIQUE-ISSUE")]) }),
    plan_reviewer: prompts.planReviewer(c, 2, 2, planMd, critique(false, [issue("C1", "high", "MY-OLD-ISSUE")])),
    plan_finalizer: prompts.planFinalizer(c, 2, 2, planMd, critique(true)),
    implementer: prompts.implementer(c, 2, planMd, findingsOf(["F1"]), [], { summary: "MY-OLD-REPORT" }),
    code_reviewer: prompts.codeReviewer(c, 2, planMd, base, snap, [], " app.txt | 1 +", "WHOLE-DIFF", false, findingsOf(["F1"], { answered: ["F1"] }), impl("completed", ["F1"])),
  });

  it("give a continued session only what is new: what changed, the notes it has not seen, and the work to judge", () => {
    for (const [role, p] of Object.entries(all(continued()))) {
      expect(p.split("\n")[0], role).toBe(`[orchestrator-role: ${role}]`);
      expect(p, role).toContain("this message continues your session");
      expect(p, role).toContain("## Files changed since your last turn");
      expect(p, role).toContain("- M `app.txt`\n- A `docs/new.md`");
      expect(p, role).toContain("## New notes from the human operator (highest priority)\n- (2026-11-03T09:00:00+07:00, during CODE_REVIEW) NEW-NOTE");
      expect(p, role).toContain("single JSON object");
      // What the session holds already: the task, what came before it, the roles, and the agent's own earlier answers.
      for (const old of ["## Task", "Sửa app.txt cho đúng", "CONVERSATION-ANSWER", "EARLIER-TASK", "Roles: planner", "PREVIOUS-PLAN", "MY-OLD-ISSUE", "MY-OLD-REPORT"]) {
        expect(p, `${role}: ${old}`).not.toContain(old);
      }
    }
    const p = all(continued());
    expect(p.planner).toContain("CRITIQUE-ISSUE");
    expect(p.planner).toContain("The plan you returned earlier in this session. It is also in `/runs/t1/plan.final.md`.");
    expect(p.plan_reviewer).toContain(planMd);
    expect(p.plan_reviewer).toContain("Your last answer in this session");
    for (const role of ["plan_finalizer", "implementer", "code_reviewer"] as const) {
      expect(p[role], role).not.toContain("PLAN-BODY");
      expect(p[role], role).toContain("It is also in `/runs/t1/plan.final.md`.");
    }
    expect(p.implementer).toContain("`F1`");
    expect(p.code_reviewer).toContain("Implementer: fixed");
    // Without the revision it last reviewed, a continued review gets the whole diff, as a fresh one does.
    expect(p.code_reviewer).toContain("## Diff\n```diff\nWHOLE-DIFF\n```");
  });

  it("give a continued session the plan again when it changed, and its own answers when it does not have them", () => {
    const p = all(continued({ knowsPlan: false }));
    for (const role of ["plan_finalizer", "implementer", "code_reviewer"] as const) expect(p[role], role).toContain(`(new since your last turn)\n${planMd}`);
    expect(p.planner).toContain("## Previous plan (v1) as JSON");
    expect(prompts.planner(continued({ changed: [] }), 1, 1, null, null)).toContain("None: the workspace is as your last turn left it.");
    const many = Array.from({ length: 103 }, (_, i): [string, string] => ["M", `f${i}.ts`]);
    expect(prompts.implementer(continued({ changed: many }), 2, planMd, null, [], null)).toContain("- … and 3 more");
  });

  it("tell the implementer that goes on in the critic's session that it is the implementer now, with the final plan, the decisions since, and its role's whole job", () => {
    const handoff: prompts.PlanHandoff = {
      version: 2, signOff: "SIGN-OFF-SUMMARY", byHuman: false,
      accepted: { conflicts: ["K1: CONFLICT-TEXT"], scope: [{ kind: "suggestion", id: "C9", text: "SCOPE-TEXT", evidence: "" }] },
    };
    const p = prompts.implementer(continued({ from: "plan_reviewer" }), 1, planMd, null, [], null, handoff);
    expect(p.split("\n")[0]).toBe("[orchestrator-role: implementer]");
    expect(p).toContain("This message continues the session in which you were the **plan critic** until now. From this turn on you are the **Implementer**: " +
      "what you were asked as plan critic no longer applies");
    // The plan is the implementer's contract: given whole, even when it is the version the critic reviewed.
    expect(p).toContain("## Final approved plan (v2)\nThe version you reviewed in your last turn as plan critic, now final. Its scope and acceptance " +
      "criteria are what you implement and what the code reviewer holds the change to. It is also in `/runs/t1/plan.final.md`.\n\n" + planMd);
    expect(p).toContain("## Decisions since your last turn as plan critic\n- The planner signed the plan off: SIGN-OFF-SUMMARY");
    for (const part of ["CONFLICT-TEXT", "SCOPE-TEXT", "are not instructions"]) expect(p, part).toContain(part);
    // What is new since the session's last turn, and the whole of the implementer's own instructions and output.
    for (const part of ["## Files changed since your last turn", "NEW-NOTE", "## How to work", "Implement the plan now", "In `repo_notes`", "single JSON object"]) {
      expect(p, part).toContain(part);
    }
    for (const old of ["## Task", "Sửa app.txt cho đúng", "CONVERSATION-ANSWER", "EARLIER-TASK", "Roles: planner"]) expect(p, old).not.toContain(old);
    const changed = prompts.implementer(continued({ from: "plan_reviewer", knowsPlan: false }), 1, planMd, null, [], null, handoff);
    expect(changed).toContain("## Final approved plan (v2) (new since your last turn)\nIt changed after your last turn as plan critic: work from this version, " +
      "not the one you reviewed.");
    expect(changed).toContain(planMd);
    const byHuman = prompts.implementer(continued({ from: "plan_reviewer" }), 1, planMd, null, [], null, { version: 3, signOff: null, byHuman: true });
    expect(byHuman).toContain("- The human operator accepted the plan as it was, without a further review.");
    expect(prompts.implementer(continued({ from: "plan_reviewer" }), 1, planMd, null, [], null, { version: 1, signOff: null, byHuman: false }))
      .toContain("- Your approval made the plan final: there was no sign-off round.");
    // Its own earlier report, which this session does not hold, is given again; not when it does, as in its own session.
    const fix = prompts.implementer(continued({ from: "plan_reviewer", knowsAnswer: false }), 2, planMd, findingsOf(["F1"]), [], { summary: "MY-OLD-REPORT" }, handoff);
    expect(fix).toContain("### Your previous report\nMY-OLD-REPORT");
    const own = prompts.implementer(continued(), 2, planMd, findingsOf(["F1"]), [], { summary: "MY-OLD-REPORT" }, handoff);
    for (const part of ["MY-OLD-REPORT", "Decisions since", "until now"]) expect(own, part).not.toContain(part);
    expect(own).toContain("this message continues your session");
  });

  it("tell the critic that goes on in the implementer's session that it is the critic again, with its last critique when the session lacks it", () => {
    const previous = critique(false, [issue("C1", "high", "MY-OLD-ISSUE")]);
    const p = prompts.planReviewer(continued({ from: "implementer" }), 3, 3, planMd, previous);
    expect(p).toContain("This message continues the session in which you were the **implementer** until now. From this turn on you are the **Plan Critic**");
    expect(p).toContain("## Your critique from the previous round\nYour last critique, earlier in this session.");
    expect(p).not.toContain("MY-OLD-ISSUE");
    expect(p).toContain(planMd);
    for (const lacks of [continued({ from: "implementer", knowsAnswer: false }), continued({ knowsAnswer: false })]) {
      expect(prompts.planReviewer(lacks, 3, 3, planMd, previous)).toContain("MY-OLD-ISSUE");
    }
  });

  it("give a continued code review the changes since the revision it reviewed, and say where the whole diff is", () => {
    const since = { from: "c".repeat(40), stat: " app.txt | 2 +-", diff: "SINCE-DIFF", truncated: false };
    const p = prompts.codeReviewer(continued({ sinceReviewed: since }), 2, planMd, base, snap, [], " app.txt | 1 +", "WHOLE-DIFF", false, null, impl());
    expect(p).toContain("## Changes since the revision you last reviewed (`" + since.from + "` → `" + snap + "`)");
    expect(p).toContain("SINCE-DIFF");
    expect(p).not.toContain("WHOLE-DIFF");
    expect(p).toContain("Judge the whole change all the same: run `git diff " + base + " " + snap + " -- .` for the full diff.");
    expect(p).toContain("## Diff stat (base → revision)");
    const internal = prompts.codeReviewer({ ...continued({ sinceReviewed: { ...since, truncated: true } }), internalSnapshots: true }, 2, planMd, base, snap, [], "", "WHOLE-DIFF",
      false, null, impl(), "/runs/t1/diff.r2.patch");
    expect(internal).toContain("read the whole diff in `/runs/t1/diff.r2.patch`. This diff is TRUNCATED.");
  });

  it("pass on what earlier agents recorded about the repository, and ask the exploring roles for theirs", () => {
    const repoNotes = [{ seq: 1, role: "planner" as const, backend: "codex" as const, round: 1, path: "src/x.ts", note: "Builds the prompts.", tree: "T" }];
    const fresh = all({ ...full, repoNotes });
    for (const [role, p] of Object.entries(fresh)) {
      expect(p, role).toContain("## Repository notes from earlier agents");
      expect(p, role).toContain("- `src/x.ts`: Builds the prompts. (Codex, planner)");
      expect(p.indexOf("## Repository notes from earlier agents"), role).toBeGreaterThan(p.indexOf("## Notes from the human operator"));
      // The sign-off's schema has no notes; every other role leaves its own.
      expect(p.includes("In `repo_notes`, leave the facts"), role).toBe(role !== "plan_finalizer");
    }
    expect(all({ ...continued(), repoNotes }).implementer).toContain("## New repository notes\nRecorded by other agents of this run since your last turn");
    expect(all(full).implementer).not.toContain("Repository notes from");
  });
});
