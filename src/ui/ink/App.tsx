import { Box, Static, Text, useInput, useStdout } from "ink";
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
  /** Called once the finish line has been rendered, so the session can unmount without losing it. */
  onSettled?(): void;
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
    case "finish":
      return <FinishLine phase={item.phase} runId={item.runId} reportPath={item.reportPath} />;
    case "review":
      return (
        <Box flexDirection="column">
          <Text color="yellow" bold wrap="truncate-end">{`⚠ Your decision is needed: ${item.review.reason}`}</Text>
          <Text wrap="wrap">{item.review.message}</Text>
          {item.review.details.slice(0, 8).map((d, i) => (
            <Text key={i} dimColor wrap="truncate-end">{`  - ${d}`}</Text>
          ))}
        </Box>
      );
  }
}

function FinishLine({ phase, runId, reportPath }: { phase: string; runId: string; reportPath: string }) {
  if (phase === "DONE") return <Text><Text color="green" bold>✔ DONE</Text>{` quality gates passed and the review approved. Report: ${reportPath}`}</Text>;
  if (phase === "ABORTED") return <Text><Text color="yellow" bold>Aborted.</Text>{` Report: ${reportPath}`}</Text>;
  if (phase === "INTERRUPTED") return <Text><Text color="yellow" bold>Stopped.</Text>{` Resume with: duo resume ${runId}`}</Text>;
  return (
    <Text>
      <Text color="yellow" bold>Waiting for your decision.</Text>
      {` Continue with: duo resume ${runId} --decision resume|revise|abort [--note "..."]  Report: ${reportPath}`}
    </Text>
  );
}

export function App(p: AppProps) {
  const [view, dispatch] = useReducer(reduce, undefined, () => initialView(p.version, p.verbose));
  const [frame, setFrame] = useState(0);
  // <Static> gives its children no width, so pin each finished item to the terminal width.
  const columns = (useStdout().stdout as NodeJS.WriteStream).columns || 80;

  useEffect(() => p.bus.on((event) => dispatch({ type: "event", event, now: Date.now() })), [p.bus]);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => f + 1), 100);
    return () => clearInterval(timer);
  }, []);

  // Raw mode swallows SIGINT, so Ctrl-C arrives as input.
  useInput((input, key) => {
    if (!(key.ctrl && input === "c")) return;
    // At the decision prompt nothing is running, so Ctrl-C means "decide later".
    if (view.humanReview) p.onDecision("defer");
    else p.onInterrupt();
  }, { isActive: p.interactive });
  useEffect(() => {
    if (view.finished) p.onSettled?.();
  }, [view.finished]);
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
      <Static items={view.items}>
        {(item) => (
          <Box key={item.id} width={columns}>
            <StaticItemView item={item} />
          </Box>
        )}
      </Static>
      {view.humanReview && p.interactive ? (
        <HumanReviewPrompt review={view.humanReview} views={p.views()} onDecision={p.onDecision} onView={onView} />
      ) : view.finished ? null : (
        <LiveFooter view={view} now={Date.now()} frame={frame} interactive={p.interactive} />
      )}
    </>
  );
}
