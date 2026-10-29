import { describe, expect, it } from "vitest";
import { EventBus, type DuoEvent } from "../src/events.js";
import { attachPlainRenderer, deferDecider, plainPermissionDecider } from "../src/ui/plain.js";

const now = () => new Date(2026, 9, 27, 12, 0, 0);
const review = { reason: "max_review_rounds", message: "not approved", fromPhase: "CODE_REVIEW" as const, resumePhase: "IMPLEMENT" as const, details: ["F1 bad"], at: "x" };
const EVENTS: DuoEvent[] = [
  { type: "run.started", runId: "run-1", task: "t", repo: "/repo", runDir: "/repo/.agentduo/runs/run-1" },
  { type: "phase.started", step: 1, phase: "PLAN", round: 1, role: "planner", agent: "codex", planning: { round: 1, limit: 4 }, impl: { round: 0, limit: 5 } },
  { type: "agent.activity", role: "planner", agent: "codex", activity: { id: "1", kind: "command", label: "exec  cat README.md", status: "running" } },
  { type: "agent.activity", role: "planner", agent: "codex", activity: { id: "1", kind: "command", label: "exec  cat README.md", status: "ok", exitCode: 0 } },
  { type: "agent.activity", role: "planner", agent: "codex", activity: { id: "2", kind: "think", label: "thinking", status: "ok" } },
  { type: "agent.retry", role: "planner", agent: "codex", attempt: 2, max: 2, reason: "output is not valid JSON\nmore" },
  { type: "message", message: { from: "codex", to: "claude", kind: "plan", headline: 'Plan v1 "Demo" · 1 steps', items: ["[high] C1 problem"] } },
  { type: "step.completed", entry: { step: 1, phase: "PLAN", round: 1, agent: "Codex", status: "plan created", summary: "v1", kind: "info", at: "x", artifact: null }, durationSec: 32, tokens: 1234 },
  { type: "gate.completed", name: "tests", command: "npm test", passed: false, exitCode: 1 },
  { type: "warning", text: "something odd" },
  { type: "permission.requested", role: "implementer", agent: "claude",
    request: { id: "p1", tool: "Bash", label: "Bash  npm test", description: "Run the tests", blockedPath: null, rules: ["Bash(npm test:*)"] } },
  { type: "permission.answered", role: "implementer", agent: "claude", id: "p1", answer: { decision: "always" } },
  { type: "human.required", runId: "run-1", review },
  { type: "run.finished", runId: "run-1", phase: "DONE", reportPath: "/r/report.md", exitCode: 0, summary: "the review approved; no quality gates configured" },
];

function render(verbose: boolean, color = false): string {
  const bus = new EventBus();
  let text = "";
  attachPlainRenderer(bus, { write: (s: string) => { text += s; } }, { color, verbose, version: "0.1.0", now });
  for (const e of EVENTS) bus.emit(e);
  return text;
}

describe("plain renderer", () => {
  it("prints one line per event with time, agent and phase columns", () => {
    const text = render(false);
    expect(text.split("\n")).toContain("12:00:00  codex        PLAN r1          ▶ planner");
    expect(text.split("\n")).toContain(`${" ".repeat(40)}- [high] C1 problem`);
    for (const s of ["agentduo 0.1.0 · run run-1", "✓ exec  cat README.md", "↻ retry 2/2: output is not valid JSON", "Codex → Claude  Plan v1",
      "- [high] C1 problem", "● plan created: v1 (32s · 1k tok)", "✗ gate tests (exit 1)", "warning: something odd",
      "⚠ asks to use Bash: Bash  npm test", `${" ".repeat(40)}Run the tests`, `${" ".repeat(40)}always allow would save: Bash(npm test:*)`,
      "→ always allowed: Bash(npm test:*)",
      "⚠ HUMAN_REVIEW needed (max_review_rounds): not approved", "    - F1 bad", "duo resume run-1 --decision resume|revise|abort",
      "[DONE] the review approved; no quality gates configured. Report: /r/report.md"]) {
      expect(text).toContain(s);
    }
    expect(text).not.toContain("thinking");
    expect(text).not.toContain("\u001b[");
  });

  it("shows thoughts in verbose mode and colors when asked", () => {
    expect(render(true)).toContain("thinking");
    expect(render(false, true)).toContain("\u001b[");
  });

  it("asks on the terminal for permission, one prompt at a time", async () => {
    const questions: string[] = [];
    const replies = ["x", "a", "m", "use the npm script", ""];
    const decider = plainPermissionDecider(async (q) => {
      questions.push(q);
      await new Promise((r) => setTimeout(r, 5));
      return replies.shift() ?? "";
    });
    const request = { id: "p1", tool: "Bash", label: "Bash  npm test", description: null, blockedPath: null, rules: ["Bash(npm test:*)"] };
    const asks = [
      decider.askPermission({ role: "implementer", agent: "claude", request }),
      decider.askPermission({ role: "implementer", agent: "claude", request: { ...request, id: "p2", rules: [] } }),
      decider.askPermission({ role: "implementer", agent: "claude", request: { ...request, id: "p3" } }),
    ];
    expect(await Promise.all(asks)).toEqual([{ decision: "always" }, { decision: "deny", message: "use the npm script" }, { decision: "deny" }]);
    expect(questions[0]).toContain("[a]lways");
    expect(questions[2]).not.toContain("[a]lways"); // p2 has no rule to save
    expect(questions[3]).toContain("message for the agent");
  });

  it("defers every decision", async () => {
    expect(await deferDecider.decide(review)).toBe("defer");
  });

  it("prints a discussion: each turn's step and verdict, its first lines, then the final answer whole", () => {
    const bus = new EventBus();
    let text = "";
    attachPlainRenderer(bus, { write: (s: string) => { text += s; } }, { color: false, verbose: false, version: "0.1.0", now });
    const model = { backend: "codex", requested: null, configured: null, resolved: "gpt-x", source: "doctor", isDefault: true, status: "resolved", reason: null } as const;
    const claude = { ...model, backend: "claude" as const };
    const turn = (id: string, backend: "codex" | "claude", place: { step: "answer" | "critique" | "revise"; round: number; verdict?: "agree" | "revise" | null }, answer: string): DuoEvent[] => [
      { type: "turn.started", conversationId: "c", turnId: id, backend, question: "Q?", model: backend === "codex" ? model : claude, discussion: { id: "d", step: place.step, round: place.round } },
      { type: "turn.finished", conversationId: "c", turnId: id, backend, status: "success", answer, error: null, model: backend === "codex" ? model : claude, durationSec: 3, logDir: "/logs", discussion: { id: "d", ...place } },
    ];
    const long = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    for (const e of [
      { type: "discussion.started", conversationId: "c", discussionId: "d", question: "Q?", answerer: "codex", critic: "claude", maxRounds: 3 },
      ...turn("t1", "codex", { step: "answer", round: 1 }, long),
      ...turn("t2", "claude", { step: "critique", round: 1, verdict: "revise" }, "Missing the retry story."),
      ...turn("t3", "codex", { step: "revise", round: 2 }, "FINAL TEXT"),
      ...turn("t4", "claude", { step: "critique", round: 2, verdict: "agree" }, "Good."),
      { type: "discussion.finished", conversationId: "c", discussionId: "d", status: "agreed", answerer: "codex", critic: "claude", rounds: 2, answer: "FINAL TEXT", error: null, durationSec: 12, logDir: "/logs" },
    ] as DuoEvent[]) bus.emit(e);
    expect(text).toContain("discussion: Codex answers, Claude reviews (at most 3 reviews)");
    expect(text).toContain("answer, version 1");
    expect(text).toContain("review of version 1 · REVISE");
    expect(text).toContain("line 8");
    expect(text).not.toContain("line 9\n");
    expect(text).toContain("… 4 more lines");
    expect(text).toContain("✓ discussion: Claude agreed after 2 reviews");
    expect(text.trimEnd().endsWith("FINAL TEXT")).toBe(true);
  });

  it("prints a discussion's synthesis as a turn, then the whole final answer as Codex's, and an older discussion's as its answerer's", () => {
    const bus = new EventBus();
    let text = "";
    attachPlainRenderer(bus, { write: (s: string) => { text += s; } }, { color: false, verbose: false, version: "0.1.0", now });
    const model = { backend: "codex", requested: null, configured: null, resolved: "gpt-x", source: "doctor", isDefault: true, status: "resolved", reason: null } as const;
    const long = Array.from({ length: 12 }, (_, i) => `synthesis line ${i + 1}`).join("\n");
    for (const e of [
      { type: "discussion.started", conversationId: "c", discussionId: "d", question: "Q?", answerer: "claude", critic: "codex", maxRounds: 1 },
      { type: "turn.started", conversationId: "c", turnId: "t3", backend: "codex", question: "Q?", model, discussion: { id: "d", step: "synthesis", round: 1 } },
      { type: "turn.finished", conversationId: "c", turnId: "t3", backend: "codex", status: "success", answer: long, error: null, model, durationSec: 3, logDir: "/logs", discussion: { id: "d", step: "synthesis", round: 1 } },
      { type: "discussion.finished", conversationId: "c", discussionId: "d", status: "disputed", answerer: "claude", critic: "codex", rounds: 1, answer: long, answerBackend: "codex", error: null, durationSec: 9, logDir: "/logs" },
    ] as DuoEvent[]) bus.emit(e);
    expect(text).toContain("▶ ◎ Codex (OpenAI) · model default → gpt-x · final answer (synthesis)");
    expect(text).toContain("… 4 more lines");
    expect(text).toContain("▲ discussion: no agreement after 1 review");
    expect(text).toContain("◎ Final answer · Codex");
    expect(text.trimEnd().endsWith("synthesis line 12")).toBe(true);

    text = "";
    bus.emit({ type: "discussion.finished", conversationId: "c", discussionId: "e", status: "agreed", answerer: "claude", critic: "codex", rounds: 1, answer: "Old.", error: null, durationSec: 1, logDir: "/logs" });
    expect(text).toContain("✻ Final answer · Claude");
  });
});
