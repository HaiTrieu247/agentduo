import { describe, expect, it } from "vitest";
import {
  activityText, discussionAuthor, discussionDoing, discussionOutcome, discussionStepText, formatClock, formatCost, formatDuration, formatTokens, messageHeadline, partyLabel, roleLabel,
  usageText, verdictText,
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
