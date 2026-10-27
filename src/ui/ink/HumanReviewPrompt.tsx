import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Decision, HumanReview } from "../../events.js";

export type ViewKind = "plan" | "review" | "feedback" | "diffstat";

export const VIEWS: Record<ViewKind, { label: string; title: string }> = {
  plan: { label: "View final plan", title: "Final plan" },
  review: { label: "View last review", title: "Last review" },
  feedback: { label: "View plan feedback", title: "Plan feedback" },
  diffstat: { label: "View diff stat", title: "Diff stat" },
};

const RESUME_HINTS: Record<string, string> = {
  max_planning_rounds: "implement the latest plan as-is",
  plan_ready: "start implementation",
  max_review_rounds: "start another fix round",
  critical_finding: "start another fix round",
  gates_failing: "start another fix round",
  implementer_blocked: "re-run this implementation round",
  // Reasons only agentduo 0.1 runs can be waiting on; kept so those runs can still be resumed from the prompt.
  dirty_worktree: "re-run this implementation round",
  guard_violation: "accept the changes and run the gates",
};

interface Option {
  key: string;
  label: string;
  hint: string;
}

export function HumanReviewPrompt({ review, views, onDecision, onView }: {
  review: HumanReview; views: ViewKind[]; onDecision(d: Decision | "defer"): void; onView(kind: ViewKind): void;
}) {
  const options: Option[] = [
    { key: "resume", label: "Resume", hint: RESUME_HINTS[review.reason] ?? "re-run the step that stopped" },
    { key: "revise", label: "Revise", hint: "re-plan with your note" },
    ...views.map((kind) => ({ key: `view:${kind}`, label: VIEWS[kind].label, hint: "" })),
    { key: "abort", label: "Abort", hint: "end the run" },
    { key: "defer", label: "Decide later", hint: "exit now; continue with `duo resume`" },
  ];
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<"menu" | "note">("menu");
  const [pending, setPending] = useState<"resume" | "revise">("resume");
  const [note, setNote] = useState("");

  useInput((input, key) => {
    if (mode === "menu") {
      if (key.upArrow) setIndex((i) => (i - 1 + options.length) % options.length);
      else if (key.downArrow) setIndex((i) => (i + 1) % options.length);
      else if (key.return) {
        const option = options[index]!;
        if (option.key === "resume" || option.key === "revise") {
          setPending(option.key);
          setMode("note");
        } else if (option.key.startsWith("view:")) {
          onView(option.key.slice(5) as ViewKind);
        } else if (option.key === "abort") {
          onDecision({ decision: "abort" });
        } else {
          onDecision("defer");
        }
      }
      return;
    }
    if (key.return) onDecision({ decision: pending, note: note.trim() || undefined });
    else if (key.escape) {
      setMode("menu");
      setNote("");
    } else if (key.backspace || key.delete) setNote((n) => n.slice(0, -1));
    else if (input && !key.ctrl && !key.meta) setNote((n) => n + input);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold wrap="truncate-end">{`⚠ Your decision is needed: ${review.reason}`}</Text>
      <Text wrap="wrap">{review.message}</Text>
      {review.details.slice(0, 8).map((d, i) => (
        <Text key={i} dimColor wrap="truncate-end">{`  - ${d}`}</Text>
      ))}
      <Box marginTop={1} flexDirection="column">
        {mode === "menu" ? (
          options.map((o, i) => (
            <Text key={o.key} wrap="truncate-end">
              <Text color={i === index ? "cyan" : undefined}>{`${i === index ? "❯ " : "  "}${o.label}`}</Text>
              {o.hint ? <Text dimColor>{`  ${o.hint}`}</Text> : null}
            </Text>
          ))
        ) : (
          <Box flexDirection="column">
            <Text>{`${pending === "resume" ? "Resume" : "Revise"}: note for the agents (Enter to continue, Esc to go back)`}</Text>
            <Text>
              <Text color="cyan">{"› "}</Text>
              {note}
              <Text inverse> </Text>
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
