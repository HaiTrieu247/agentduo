import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Party, PermissionAnswer, PermissionRequest, Role } from "../../events.js";
import { partyLabel, roleLabel } from "../format.js";

export interface PermissionAsk {
  role: Role;
  agent: Party;
  request: PermissionRequest;
}

interface Option {
  key: "once" | "always" | "deny" | "message";
  label: string;
  hint: string;
}

/** The agent's own permission prompt, relayed: answering lets the agent continue in the same turn. */
export function PermissionPrompt({ ask, onAnswer }: { ask: PermissionAsk; onAnswer(answer: PermissionAnswer): void }) {
  const { request } = ask;
  const options: Option[] = [
    { key: "once", label: "Allow once", hint: "" },
    ...(request.rules.length
      ? [{ key: "always" as const, label: `Always allow ${request.rules.join(", ")}`, hint: "saved by Claude to .claude/settings.local.json" }]
      : []),
    { key: "deny", label: "Deny", hint: "" },
    { key: "message", label: "Deny with a message…", hint: "tell the agent what to do instead" },
  ];
  const [index, setIndex] = useState(0);
  const [typing, setTyping] = useState(false);
  const [message, setMessage] = useState("");

  useInput((input, key) => {
    if (!typing) {
      if (key.upArrow) setIndex((i) => (i - 1 + options.length) % options.length);
      else if (key.downArrow) setIndex((i) => (i + 1) % options.length);
      else if (key.return) {
        const choice = options[index]!.key;
        if (choice === "message") setTyping(true);
        else onAnswer(choice === "deny" ? { decision: "deny" } : { decision: choice });
      }
      return;
    }
    if (key.return) onAnswer({ decision: "deny", message: message.trim() || undefined });
    else if (key.escape) {
      setTyping(false);
      setMessage("");
    } else if (key.backspace || key.delete) setMessage((m) => m.slice(0, -1));
    else if (input && !key.ctrl && !key.meta) setMessage((m) => m + input);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold wrap="truncate-end">{`⚠ ${partyLabel(ask.agent)} (${roleLabel(ask.role)}) asks to use ${request.tool}`}</Text>
      <Text wrap="truncate-end">{`  ${request.label}`}</Text>
      {request.description ? <Text dimColor wrap="truncate-end">{`  ${request.description}`}</Text> : null}
      {request.blockedPath ? <Text dimColor wrap="truncate-end">{`  path: ${request.blockedPath}`}</Text> : null}
      <Box marginTop={1} flexDirection="column">
        {typing ? (
          <Box flexDirection="column">
            <Text>Message for the agent (Enter to deny, Esc to go back)</Text>
            <Text>
              <Text color="cyan">{"› "}</Text>
              {message}
              <Text inverse> </Text>
            </Text>
          </Box>
        ) : (
          options.map((o, i) => (
            <Text key={o.key} wrap="truncate-end">
              <Text color={i === index ? "cyan" : undefined}>{`${i === index ? "❯ " : "  "}${o.label}`}</Text>
              {o.hint ? <Text dimColor>{`  ${o.hint}`}</Text> : null}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}
