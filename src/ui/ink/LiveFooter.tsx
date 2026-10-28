import { Box, Text } from "ink";
import { IMPL_PHASES, PIPELINE, SPINNER, discussionDoing, formatClock, partyLabel, roleLabel, usageText } from "../format.js";
import { ActivityLine, Speaker } from "./StepBlock.js";
import type { ViewState } from "./store.js";

/** While an agent answers a question: who, with which model, for how long, and its latest activities. */
export function TurnFooter({ view, now, frame }: { view: ViewState; now: number; frame: number }) {
  const turn = view.turn;
  if (!turn) return null;
  const spinner = SPINNER[frame % SPINNER.length]!;
  const usage = usageText(view.live.costUsd || undefined, view.live.tokens || undefined);
  return (
    <Box flexDirection="column" borderStyle="single" borderLeft={false} borderRight={false} borderBottom={false} borderDimColor>
      <Box>
        <Text color="cyan">{`${spinner} `}</Text>
        <Box flexShrink={1}>
          <Speaker backend={turn.backend} model={turn.model} />
        </Box>
        <Text dimColor>{` · ${turn.discussion ? discussionDoing(turn.discussion) : "answering"} · ${formatClock((now - turn.startedAt) / 1000)}${usage ? ` · ${usage}` : ""}`}</Text>
      </Box>
      {turn.activities.filter((a) => a.kind !== "think").slice(-3).map((a) => (
        <ActivityLine key={a.id} activity={a} spinner={spinner} />
      ))}
    </Box>
  );
}

function Pipeline({ view }: { view: ViewState }) {
  const current = view.current?.phase;
  return (
    <Text wrap="truncate-end">
      {PIPELINE.map((p, i) => {
        const active = p.phase === current;
        const done = !active && view.reached.includes(p.phase);
        const round = active && IMPL_PHASES.includes(p.phase) ? ` r${view.current!.round}` : "";
        return (
          <Text key={p.phase}>
            {i > 0 ? <Text dimColor>{" › "}</Text> : " "}
            <Text color={active ? "cyan" : done ? "green" : undefined} dimColor={!active && !done} bold={active}>
              {`${p.label}${active ? ` ●${round}` : done ? " ✓" : ""}`}
            </Text>
          </Text>
        );
      })}
      <Text dimColor>{`    plan ${view.planning.round}/${view.planning.limit} · impl ${view.impl.round}/${view.impl.limit}`}</Text>
    </Text>
  );
}

export function LiveFooter({ view, now, frame, interactive }: { view: ViewState; now: number; frame: number; interactive: boolean }) {
  const cur = view.current;
  const spinner = SPINNER[frame % SPINNER.length]!;
  const total = usageText(view.totals.costUsd + view.live.costUsd || undefined, view.totals.tokens + view.live.tokens || undefined);
  const hints = view.stopping ? "stopping after this step…" : interactive ? "[v] details  [q] stop after this step  [ctrl-c] stop now" : "";
  return (
    <Box flexDirection="column" borderStyle="single" borderLeft={false} borderRight={false} borderBottom={false} borderDimColor>
      <Pipeline view={view} />
      {cur ? (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text color="cyan">{spinner}</Text>
            {` ${cur.agent ? partyLabel(cur.agent) : cur.phase}${cur.role ? ` (${roleLabel(cur.role)})` : ""} · ${formatClock((now - cur.startedAt) / 1000)}`}
          </Text>
          {cur.activities.filter((a) => a.kind !== "think").slice(-3).map((a) => (
            <ActivityLine key={a.id} activity={a} spinner={spinner} />
          ))}
        </Box>
      ) : (
        <Text dimColor>waiting…</Text>
      )}
      <Box>
        <Text dimColor wrap="truncate-end">{total || "no usage yet"}</Text>
        <Box flexGrow={1} />
        <Text dimColor wrap="truncate-end">{hints}</Text>
      </Box>
    </Box>
  );
}
