import { Box, Text, useInput, useStdout } from "ink";
import type { Dispatch, SetStateAction } from "react";
import type { UsageReport } from "../../core/usage.js";
import { usageBar, usageRows, type UsageRow } from "../format.js";

/** Lines of `text` no wider than `width`, broken at spaces; a continuation keeps the line's indentation, plus two. */
function wrap(text: string, width: number): string[] {
  if ([...text].length <= width) return [text];
  const indent = " ".repeat((/^ */.exec(text)?.[0].length ?? 0) + 2);
  const out: string[] = [];
  let rest = text;
  while ([...rest].length > width) {
    const head = [...rest].slice(0, width).join("");
    const cut = head.lastIndexOf(" ");
    const at = cut > indent.length ? cut : width;
    out.push(rest.slice(0, at).trimEnd());
    rest = indent + rest.slice(at).trimStart();
  }
  return [...out, rest];
}

const barColor = (percent: number) => (percent >= 90 ? "red" : percent >= 70 ? "yellow" : "cyan");

/** One screen line of the panel; a long row of text becomes several. */
type Line = { key: string; row: UsageRow; text: string };

function RowView({ line, barWidth }: { line: Line; barWidth: number }) {
  const { row, text } = line;
  const pad = " ".repeat(row.indent);
  switch (row.kind) {
    case "agent":
    case "heading":
      return <Text bold>{text}</Text>;
    case "group":
      return <Text bold dimColor>{text}</Text>;
    case "bar":
      return <Text>{pad}<Text color={barColor(row.percent ?? 0)}>{usageBar(row.percent ?? 0, barWidth)}</Text>{`  ${row.text}`}</Text>;
    case "muted":
      return <Text dimColor>{text}</Text>;
    case "error":
      return <Text color="red">{text}</Text>;
    case "blank":
      return <Text> </Text>;
    default:
      // Ink gives an empty Text no height, and Claude's blank lines part its blocks.
      return <Text>{text || " "}</Text>;
  }
}

/**
 * /usage: both agents' limits in a box where the input was, as Claude Code's /usage dialog. ↑↓ scroll it when it is
 * taller than the terminal, r asks again, Esc closes it (and only it: an answer under way goes on).
 */
export function UsagePanel({ report, top, setTop, onRefresh, onClose }: {
  report: UsageReport;
  /** The first line shown, kept by the app so a prompt shown meanwhile leaves the panel where it was. */
  top: number;
  setTop: Dispatch<SetStateAction<number>>;
  onRefresh(): void;
  onClose(): void;
}) {
  const out = useStdout().stdout as NodeJS.WriteStream;
  const columns = out.columns || 80;
  const inner = Math.max(20, columns - 4);
  const barWidth = Math.max(10, Math.min(40, inner - 14));
  const height = Math.max(6, (out.rows || 24) - 8);
  const lines: Line[] = usageRows(report).flatMap((row, i) => (row.kind === "bar" || row.kind === "blank"
    ? [{ key: `${i}`, row, text: row.text }]
    : wrap(`${" ".repeat(row.indent)}${row.text}`, inner).map((text, j) => ({ key: `${i}.${j}`, row, text }))));
  const most = Math.max(0, lines.length - height);
  const at = Math.min(top, most);
  // Keys can come faster than renders: each one moves from where the last one left the panel.
  const scroll = (by: number) => setTop((t) => Math.max(0, Math.min(most, Math.min(t, most) + by)));
  useInput((input, key) => {
    if (key.ctrl && input === "c") return; // handled by the app, which counts presses
    if (key.escape) onClose();
    else if (key.upArrow) scroll(-1);
    else if (key.downArrow) scroll(1);
    else if (key.pageUp) scroll(-height);
    else if (key.pageDown || input === " ") scroll(height);
    else if (input === "r") onRefresh();
  });
  const shown = lines.slice(at, at + height);
  const more = lines.length - at - shown.length;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Text bold color="cyan">{`Usage${at ? `  ↑ ${at} more` : ""}`}</Text>
        {shown.map((line) => <RowView key={line.key} line={line} barWidth={barWidth} />)}
        {more > 0 ? <Text dimColor>{`↓ ${more} more`}</Text> : null}
      </Box>
      <Text dimColor wrap="truncate-end">{`  ${most ? "↑↓ scroll · " : ""}r refresh · Esc close`}</Text>
    </Box>
  );
}
