import { Box, Static, Text, useInput, useStdout } from "ink";
import { useEffect, useReducer, useState } from "react";
import type { Decision, EventBus, PermissionAnswer } from "../../events.js";
import { partyLabel, permissionAnswerText, roleLabel } from "../format.js";
import { HumanReviewPrompt, VIEWS, type ViewKind } from "./HumanReviewPrompt.js";
import { LiveFooter } from "./LiveFooter.js";
import { PermissionPrompt } from "./PermissionPrompt.js";
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
  /** The user's answer to a relayed permission prompt. */
  onPermission?(id: string, answer: PermissionAnswer): void;
  views(): ViewKind[];
  readView(kind: ViewKind): Promise<string | null>;
  /** Called once the finish line has been rendered, so the session can unmount without losing it. */
  onSettled?(): void;
}

export function StaticItemView({ item }: { item: StaticItem }) {
  switch (item.kind) {
    case "header":
      return item.chat ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>{`agentduo ${item.version} · chat`}</Text>
          <Text dimColor>{item.repo}</Text>
          <Text dimColor>Type a task and press Enter. /help lists the commands.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>{`agentduo ${item.version} · run ${item.runId}`}</Text>
          <Text dimColor>{item.repo}</Text>
        </Box>
      );
    case "user":
      return (
        <Box marginTop={1}>
          <Text bold wrap="wrap">{`› ${item.text}`}</Text>
        </Box>
      );
    case "info":
      return <Text dimColor wrap="wrap">{item.text}</Text>;
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
      return <FinishLine phase={item.phase} runId={item.runId} reportPath={item.reportPath} summary={item.summary} chat={item.chat} />;
    case "permission":
      return (
        <Text dimColor wrap="truncate-end">
          <Text color={item.answer.decision === "deny" ? "yellow" : "green"}>{item.answer.decision === "deny" ? "⊘" : "✓"}</Text>
          {` ${partyLabel(item.agent)} (${roleLabel(item.role)}) ${item.label} — ${permissionAnswerText(item.answer, item.rules)}`}
        </Text>
      );
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

function FinishLine({ phase, runId, reportPath, summary, chat }: { phase: string; runId: string; reportPath: string; summary?: string; chat?: boolean }) {
  if (phase === "DONE") return <Text><Text color="green" bold>✔ DONE</Text>{` ${summary ?? "finished"}. Report: ${reportPath}`}</Text>;
  if (phase === "ABORTED") return <Text><Text color="yellow" bold>Aborted.</Text>{` Report: ${reportPath}`}</Text>;
  // In a chat the next steps are typed, not shell commands; the chat says which.
  if (chat) return <Text color="yellow" bold>{phase === "INTERRUPTED" ? "■ Stopped." : "Waiting for your decision."}</Text>;
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
  }, { isActive: p.interactive && !view.humanReview && !view.permissions.length });

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
      {view.permissions[0] && p.interactive ? (
        <PermissionPrompt key={view.permissions[0].request.id} ask={view.permissions[0]}
          onAnswer={(answer) => p.onPermission?.(view.permissions[0]!.request.id, answer)} />
      ) : view.humanReview && p.interactive ? (
        <HumanReviewPrompt review={view.humanReview} views={p.views()} onDecision={p.onDecision} onView={onView} />
      ) : view.finished ? null : (
        <LiveFooter view={view} now={Date.now()} frame={frame} interactive={p.interactive} />
      )}
    </>
  );
}
