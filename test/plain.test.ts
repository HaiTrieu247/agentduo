import { describe, expect, it } from "vitest";
import { EventBus, type DuoEvent } from "../src/events.js";
import { attachPlainRenderer, deferDecider } from "../src/ui/plain.js";

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

  it("defers every decision", async () => {
    expect(await deferDecider.decide(review)).toBe("defer");
  });
});
