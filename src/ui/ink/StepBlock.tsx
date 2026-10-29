import { Box, Text } from "ink";
import type { Activity, Agent, Message, ModelIdentity } from "../../events.js";
import {
  activityText, DISCUSSION_LINES, discussionAuthor, discussionOutcome, discussionStepText, firstLines, formatDuration, messageHeadline, modelText, partyLabel, PROVIDERS, roleLabel,
  statusIcon, usageText, verdictText,
} from "../format.js";
import type { DiscussionView, StepView, TurnView } from "./store.js";

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

const AGENT_COLOR: Record<Agent, string> = { claude: "magenta", codex: "green" };

/** "✻ Claude · Anthropic · model" — a plain mark and the names, so it reads the same without colour. */
export function Speaker({ backend, model }: { backend: Agent; model: ModelIdentity }) {
  const p = PROVIDERS[backend];
  return (
    <Text wrap="truncate-end">
      <Text color={AGENT_COLOR[backend]} bold>{`${p.mark} ${p.agent}`}</Text>
      <Text dimColor>{` · ${p.company} · model ${modelText(model, { short: true })}`}</Text>
    </Text>
  );
}

/**
 * A finished answer: who answered with which model, what it did, and the answer itself, whole. A /discuss turn also
 * says its step and verdict, and shows its first lines only (the discussion's final answer follows, whole).
 */
export function AnswerBlock({ turn }: { turn: TurnView }) {
  const shown = turn.verbose ? turn.activities : turn.activities.filter((a) => a.kind !== "think").slice(-MAX_ACTIVITIES);
  const hidden = turn.activities.filter((a) => turn.verbose || a.kind !== "think").length - shown.length;
  const right = [formatDuration(turn.durationSec), usageText(turn.costUsd, turn.tokens)].filter(Boolean).join(" · ");
  const place = turn.discussion;
  const text = place && !turn.verbose ? firstLines(turn.answer ?? "", DISCUSSION_LINES) : { shown: turn.answer ?? "", more: 0 };
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1} width="100%">
      <Box>
        <Box flexShrink={1}>
          <Speaker backend={turn.backend} model={turn.model} />
        </Box>
        {place ? (
          <Text>
            <Text dimColor>{` · ${discussionStepText(place)}`}</Text>
            {place.step === "critique" ? <Text color={place.verdict === "agree" ? "green" : "yellow"} bold>{` · ${verdictText(place.verdict)}`}</Text> : null}
          </Text>
        ) : null}
        <Box flexGrow={1} />
        {right ? <Text dimColor>{` ${right}`}</Text> : null}
      </Box>
      {hidden > 0 ? <Text dimColor>{`  │ … ${hidden} more`}</Text> : null}
      {shown.map((a) => (
        <ActivityLine key={a.id} activity={a} />
      ))}
      {turn.status === "success" ? (
        // Not indented, so code in the answer copies as it is.
        <Box flexDirection="column">
          <Text wrap="wrap">{text.shown}</Text>
          {text.more ? <Text dimColor>{`… ${text.more} more line${text.more === 1 ? "" : "s"} (--verbose shows them; the logs keep them)`}</Text> : null}
        </Box>
      ) : turn.status === "interrupted" ? (
        <Text color="yellow">{"  ■ Stopped before it answered."}</Text>
      ) : (
        <Text color="red" wrap="wrap">{`  ✗ No answer: ${turn.error ?? "the call failed"}`}</Text>
      )}
    </Box>
  );
}

const OUTCOME: Record<DiscussionView["status"], { mark: string; color: string }> = {
  agreed: { mark: "✓", color: "green" }, disputed: { mark: "▲", color: "yellow" }, interrupted: { mark: "■", color: "yellow" }, error: { mark: "✗", color: "red" },
};

/** A /discuss once it is over: how it ended, then its answer, the response, whole. */
export function DiscussionBlock({ discussion: d }: { discussion: DiscussionView }) {
  const o = OUTCOME[d.status];
  const right = [formatDuration(d.durationSec), usageText(d.costUsd, d.tokens)].filter(Boolean).join(" · ");
  const by = discussionAuthor(d);
  const p = PROVIDERS[by];
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1} width="100%">
      <Box>
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            <Text color={o.color}>{`${o.mark} `}</Text>
            <Text bold>{`Discussion: ${discussionOutcome(d)}`}</Text>
          </Text>
        </Box>
        <Box flexGrow={1} />
        {right ? <Text dimColor>{` ${right}`}</Text> : null}
      </Box>
      {d.answer !== null ? (
        <Box flexDirection="column">
          <Text color={AGENT_COLOR[by]} bold>{`${p.mark} Final answer · ${p.agent}`}</Text>
          <Text wrap="wrap">{d.answer}</Text>
        </Box>
      ) : d.error ? <Text color="red" wrap="wrap">{`  ✗ ${d.error}`}</Text> : null}
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
