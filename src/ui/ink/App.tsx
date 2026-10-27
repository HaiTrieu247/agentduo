import { Box, Static, Text, useInput } from "ink";
import { useEffect, useReducer, useState } from "react";
import type { Decision, EventBus } from "../../events.js";
import { HumanReviewPrompt, VIEWS, type ViewKind } from "./HumanReviewPrompt.js";
import { LiveFooter } from "./LiveFooter.js";
import { StepBlock } from "./StepBlock.js";
import { initialView, reduce, type StaticItem } from "./store.js";

export interface AppProps {
  bus: EventBus;
  version: string;
  verbose: boolean;
  interactive: boolean;
  onStop(): void;
  onInterrupt(): void;
  onDecision(d: Decision | "defer"): void;
  views(): ViewKind[];
  readView(kind: ViewKind): Promise<string | null>;
}

function StaticItemView({ item }: { item: StaticItem }) {
  switch (item.kind) {
    case "header":
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>{`agentduo ${item.version} · run ${item.runId}`}</Text>
          <Text dimColor>{item.repo}</Text>
        </Box>
      );
    case "step":
      return <StepBlock step={item.step} />;
    case "note":
      return <Text color="yellow" wrap="truncate-end">{`warning: ${item.text}`}</Text>;
    case "artifact":
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>{`── ${item.title} ──`}</Text>
          <Text>{item.body}</Text>
        </Box>
      );
  }
}

export function App(p: AppProps) {
  const [view, dispatch] = useReducer(reduce, undefined, () => initialView(p.version, p.verbose));
  const [frame, setFrame] = useState(0);

  useEffect(() => p.bus.on((event) => dispatch({ type: "event", event, now: Date.now() })), [p.bus]);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => f + 1), 100);
    return () => clearInterval(timer);
  }, []);

  // Raw mode swallows SIGINT, so Ctrl-C arrives as input.
  useInput((input, key) => {
    if (key.ctrl && input === "c") p.onInterrupt();
  }, { isActive: p.interactive });
  useInput((input, key) => {
    if (key.ctrl || key.meta) return;
    if (input === "v") dispatch({ type: "toggleVerbose" });
    else if (input === "q" && !view.stopping) {
      dispatch({ type: "stopping" });
      p.onStop();
    }
  }, { isActive: p.interactive && !view.humanReview });

  const onView = (kind: ViewKind) => {
    void p.readView(kind).then((body) => dispatch({ type: "artifact", title: VIEWS[kind].title, body: body ?? "(not available)" }));
  };

  return (
    <>
      <Static items={view.items}>{(item) => <StaticItemView key={item.id} item={item} />}</Static>
      {view.humanReview && p.interactive ? (
        <HumanReviewPrompt review={view.humanReview} views={p.views()} onDecision={p.onDecision} onView={onView} />
      ) : view.finished ? null : (
        <LiveFooter view={view} now={Date.now()} frame={frame} interactive={p.interactive} />
      )}
    </>
  );
}
