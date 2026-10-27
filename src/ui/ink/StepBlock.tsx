import { Box, Text } from "ink";
import type { Activity, Message } from "../../events.js";
import { activityText, formatDuration, messageHeadline, partyLabel, roleLabel, statusIcon, usageText } from "../format.js";
import type { StepView } from "./store.js";

const MAX_ACTIVITIES = 6;
const MAX_ITEMS = 5;
const statusColor = (s: Activity["status"]) => (s === "ok" ? "green" : s === "running" ? "cyan" : s === "denied" ? "yellow" : "red");

export function ActivityLine({ activity, spinner }: { activity: Activity; spinner?: string }) {
  const icon = activity.status === "running" ? spinner ?? "…" : statusIcon(activity.status);
  return (
    <Text wrap="truncate-end">
      <Text dimColor>  │ </Text>
      {activityText(activity)} <Text color={statusColor(activity.status)}>{icon}</Text>
    </Text>
  );
}

export function MessageView({ message, verbose }: { message: Message; verbose: boolean }) {
  const items = verbose ? message.items : message.items.slice(0, MAX_ITEMS);
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text dimColor>  └ </Text>
        <Text bold>{messageHeadline(message)}</Text>
      </Text>
      {items.map((item, i) => (
        <Text key={i} wrap="truncate-end">{`      ${item}`}</Text>
      ))}
      {message.items.length > items.length ? <Text dimColor>{`      … ${message.items.length - items.length} more`}</Text> : null}
    </Box>
  );
}

export function StepBlock({ step }: { step: StepView }) {
  const entry = step.entry;
  const warn = entry?.kind === "warn";
  const visible = step.verbose ? step.activities : step.activities.filter((a) => a.kind !== "think");
  const shown = step.verbose ? visible : visible.slice(-MAX_ACTIVITIES);
  const hidden = step.activities.length - shown.length;
  const who = step.agent ? `${partyLabel(step.agent)}${step.role ? ` (${roleLabel(step.role)})` : ""}` : "";
  const right = [formatDuration(step.durationSec), usageText(step.costUsd, step.tokens)].filter(Boolean).join(" · ");
  return (
    <Box flexDirection="column" marginBottom={1} width="100%">
      <Box>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            <Text color={warn ? "yellow" : "green"}>{warn ? "▲ " : "● "}</Text>
            <Text bold>{`${step.phase} r${step.round}`}</Text>
            {who ? `  ${who}` : ""}
          </Text>
        </Box>
        <Box flexGrow={1} />
        {right ? <Text dimColor>{` ${right}`}</Text> : null}
      </Box>
      {hidden > 0 ? <Text dimColor>{`  │ … ${hidden} more`}</Text> : null}
      {shown.map((a) => (
        <ActivityLine key={a.id} activity={a} />
      ))}
      {step.message ? <MessageView message={step.message} verbose={step.verbose} /> : null}
      {entry && (!step.message || warn) ? (
        <Text wrap="truncate-end" color={warn ? "yellow" : undefined}>{`  └ ${entry.status}: ${entry.summary}`}</Text>
      ) : null}
    </Box>
  );
}
