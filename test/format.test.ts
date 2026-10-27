import { describe, expect, it } from "vitest";
import { activityText, formatClock, formatCost, formatDuration, formatTokens, messageHeadline, partyLabel, roleLabel, usageText } from "../src/ui/format.js";

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
});
