import { describe, expect, it } from "vitest";
import type { AgentUsage } from "../src/core/usage.js";
import {
  activityText, discussionAuthor, discussionDoing, discussionOutcome, discussionStepText, formatClock, formatCost, formatDuration, formatTokens, messageHeadline, partyLabel, roleLabel,
  usageBar, usageReportText, usageRows, usageText, verdictText,
} from "../src/ui/format.js";

describe("format", () => {
  it("formats durations, money and tokens", () => {
    expect([formatDuration(48), formatDuration(72), formatDuration(undefined)]).toEqual(["48s", "1m12s", ""]);
    expect(formatClock(72.9)).toBe("1:12");
    expect([formatCost(0.171), formatCost(0), formatCost(null)]).toEqual(["$0.17", "", ""]);
    expect([formatTokens(67_400), formatTokens(512), formatTokens(0)]).toEqual(["67k tok", "512 tok", ""]);
    expect(usageText(0.5, 2000)).toBe("$0.50 · 2k tok");
  });

  it("labels parties, roles, activities and messages", () => {
    expect([partyLabel("codex"), partyLabel("human"), roleLabel("plan_reviewer")]).toEqual(["Codex", "You", "plan critic"]);
    expect(activityText({ id: "1", kind: "edit", label: "Edit  a.ts", status: "ok", added: 4, removed: 0 })).toBe("Edit  a.ts  +4 −0");
    expect(activityText({ id: "2", kind: "command", label: "Bash  npm test", status: "error", exitCode: 1 })).toBe("Bash  npm test (exit 1)");
    expect(activityText({ id: "3", kind: "command", label: "Bash  git push", status: "denied" })).toBe("Bash  git push denied");
    expect(messageHeadline({ from: "codex", to: "claude", kind: "plan", headline: "Plan v1", items: [] })).toBe("Codex → Claude  Plan v1");
  });

  it("names a discussion's steps, verdicts and outcome", () => {
    expect([discussionStepText({ step: "answer", round: 1 }), discussionStepText({ step: "critique", round: 2 }), discussionStepText({ step: "revise", round: 3 }),
      discussionStepText({ step: "synthesis", round: 2 }), discussionStepText({ step: "final", round: 4 })])
      .toEqual(["answer, version 1", "review of version 2", "answer, version 3", "final answer (synthesis)", "final answer, version 4"]);
    expect([discussionDoing({ step: "critique", round: 1 }), discussionDoing({ step: "synthesis", round: 2 }), discussionDoing({ step: "final", round: 3 })])
      .toEqual(["reviewing version 1", "synthesizing the final answer", "writing the final answer"]);
    expect([verdictText("agree"), verdictText("revise"), verdictText(null)]).toEqual(["AGREE", "REVISE", "no verdict, taken as REVISE"]);
    const d = { answerer: "codex", critic: "claude", rounds: 2 } as const;
    expect(discussionOutcome({ ...d, status: "agreed" })).toBe("Claude agreed after 2 reviews");
    expect(discussionOutcome({ ...d, rounds: 1, status: "agreed" })).toBe("Claude agreed after 1 review");
    expect(discussionOutcome({ ...d, status: "disputed" })).toBe("no agreement after 2 reviews");
    // Codex wrote a synthesis; a discussion from before synthesis has no author but its answerer.
    expect([discussionAuthor({ answerer: "claude", answerBackend: "codex" }), discussionAuthor({ answerer: "claude" })]).toEqual(["codex", "claude"]);
    expect(discussionOutcome({ ...d, status: "interrupted" })).toBe("stopped");
    expect(discussionOutcome({ ...d, status: "error" })).toBe("failed");
  });
});

describe("format: /usage", () => {
  const claude: AgentUsage = {
    account: "Max",
    email: "claude@example.com",
    groups: [{ title: null, limits: [{ label: "Current session", usedPercent: 46, resets: "Resets Oct 29 at 3pm (Asia/Saigon)" }] }],
    notes: [],
    details: { title: "What's contributing to your limits usage?", lines: ["Last 24h · 546 requests", "  93%  Start fresh when you switch tasks"] },
  };
  const codex: AgentUsage = {
    account: "ChatGPT Plus",
    email: "user@example.com",
    groups: [{ title: null, limits: [{ label: "5h limit", usedPercent: 0, resets: null }] }, { title: "GPT-Spark", limits: [{ label: "5h limit", usedPercent: 100, resets: null }] }],
    notes: ["Credits: 12.5"],
    details: null,
  };

  it("draws a bar of blocks as wide as asked, full at 100% and empty at 0%", () => {
    expect([usageBar(46, 10), usageBar(0, 4), usageBar(100, 4), usageBar(130, 4)]).toEqual(["█████░░░░░", "░░░░", "████", "████"]);
  });

  it("lays out both agents' limits first, each under its plan and email, then what contributes to Claude's usage", () => {
    const rows = usageRows({ id: 1, claude: { status: "ready", usage: claude }, codex: { status: "ready", usage: codex } });
    expect(rows).toEqual([
      { kind: "agent", text: "Claude Code · Max · claude@example.com", indent: 0 },
      { kind: "limit", text: "Current session", indent: 2 },
      { kind: "bar", text: "46% used", percent: 46, indent: 2 },
      { kind: "muted", text: "Resets Oct 29 at 3pm (Asia/Saigon)", indent: 2 },
      { kind: "blank", text: "", indent: 0 },
      { kind: "agent", text: "Codex · ChatGPT Plus · user@example.com", indent: 0 },
      { kind: "limit", text: "5h limit", indent: 2 },
      { kind: "bar", text: "0% used", percent: 0, indent: 2 },
      { kind: "group", text: "GPT-Spark", indent: 2 },
      { kind: "limit", text: "5h limit", indent: 4 },
      { kind: "bar", text: "100% used", percent: 100, indent: 4 },
      { kind: "text", text: "Credits: 12.5", indent: 2 },
      { kind: "blank", text: "", indent: 0 },
      { kind: "heading", text: "Claude Code · What's contributing to your limits usage?", indent: 0 },
      { kind: "text", text: "Last 24h · 546 requests", indent: 0 },
      { kind: "text", text: "  93%  Start fresh when you switch tasks", indent: 0 },
    ]);
  });

  it("says which part is still loading and which failed, each on its own", () => {
    const rows = usageRows({ id: 2, claude: { status: "loading" }, codex: { status: "error", error: "codex app-server did not answer within 15s" } });
    expect(rows).toEqual([
      { kind: "agent", text: "Claude Code", indent: 0 },
      { kind: "muted", text: "loading…", indent: 2 },
      { kind: "blank", text: "", indent: 0 },
      { kind: "agent", text: "Codex", indent: 0 },
      { kind: "error", text: "codex app-server did not answer within 15s", indent: 2 },
    ]);
  });

  it("writes the report as text for a screen without a usage panel", () => {
    const text = usageReportText({ id: 1, claude: { status: "ready", usage: claude }, codex: { status: "error", error: "Codex is not signed in: run codex login" } });
    expect(text.split("\n")).toEqual([
      "── usage ──",
      "Claude Code · Max · claude@example.com",
      "  Current session",
      `  ${"█".repeat(9)}${"░".repeat(11)}  46% used`,
      "  Resets Oct 29 at 3pm (Asia/Saigon)",
      "",
      "Codex",
      "  Codex is not signed in: run codex login",
      "",
      "Claude Code · What's contributing to your limits usage?",
      "Last 24h · 546 requests",
      "  93%  Start fresh when you switch tasks",
    ]);
  });
});
