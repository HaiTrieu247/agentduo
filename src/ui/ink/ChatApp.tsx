import { EventEmitter } from "node:events";
import { Box, Static, Text, useInput, useStdout } from "ink";
import { useEffect, useReducer, useState } from "react";
import type { ChatStatus } from "../../chat.js";
import type { Decision, EventBus, PermissionAnswer } from "../../events.js";
import { StaticItemView } from "./App.js";
import { HumanReviewPrompt, VIEWS, type ViewKind } from "./HumanReviewPrompt.js";
import { LiveFooter } from "./LiveFooter.js";
import { PermissionPrompt } from "./PermissionPrompt.js";
import { initialView, reduce } from "./store.js";

type ChatLine = { type: "user" | "info"; text: string } | { type: "status"; status: ChatStatus };

/** What the chat controller shows besides the agents' own events: your messages, its lines, and its status. */
export class ChatChannel {
  private readonly emitter = new EventEmitter();

  user(text: string): void {
    this.emitter.emit("line", { type: "user", text });
  }

  info(text: string): void {
    this.emitter.emit("line", { type: "info", text });
  }

  status(status: ChatStatus): void {
    this.emitter.emit("line", { type: "status", status });
  }

  on(listener: (line: ChatLine) => void): () => void {
    this.emitter.on("line", listener);
    return () => {
      this.emitter.off("line", listener);
    };
  }
}

export interface ChatAppProps {
  bus: EventBus;
  channel: ChatChannel;
  version: string;
  workspace: string;
  verbose: boolean;
  onSubmit(text: string): void;
  onEscape(): void;
  onCtrlC(): void;
  onDecision(d: Decision | "defer"): void;
  onPermission(id: string, answer: PermissionAnswer): void;
  views(): ViewKind[];
  readView(kind: ViewKind): Promise<string | null>;
}

const PLACEHOLDERS: Record<ChatStatus, string> = {
  idle: "Type a task…",
  running: "A message for the agents: they get it from the next step",
  paused: "What should change? Enter re-runs the stopped step",
};
const HINTS: Record<ChatStatus, string> = {
  idle: "Enter send · /help commands · Ctrl-C twice quit",
  running: "Enter send a note · Esc stops this step · Ctrl-C twice quit",
  paused: "Enter re-run · /new leave it · Ctrl-C twice quit",
};

function ChatInput({ status, onSubmit, onEscape }: { status: ChatStatus; onSubmit(text: string): void; onEscape(): void }) {
  const [text, setText] = useState("");
  useInput((input, key) => {
    if (key.ctrl && input === "c") return; // handled by the app, which counts presses
    if (key.escape) {
      if (status === "running") onEscape();
      else setText("");
      return;
    }
    if (key.return) {
      onSubmit(text);
      setText("");
    } else if (key.backspace || key.delete) setText((t) => t.slice(0, -1));
    else if (input && !key.ctrl && !key.meta) {
      // A paste (or fast typing) arrives as one chunk: line breaks inside it stay, an Enter at its end sends.
      const chunk = input.replace(/\r\n?/g, "\n");
      if (chunk.endsWith("\n")) {
        onSubmit(text + chunk.slice(0, -1));
        setText("");
      } else setText((t) => t + chunk);
    }
  });
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="round" borderColor={status === "paused" ? "yellow" : "gray"} paddingX={1}>
        <Text wrap="wrap">
          <Text color="cyan">{"› "}</Text>
          {text ? text : <Text dimColor>{PLACEHOLDERS[status]}</Text>}
          <Text inverse> </Text>
        </Text>
      </Box>
      <Text dimColor>{`  ${HINTS[status]}`}</Text>
    </Box>
  );
}

/** `duo` with no task: one live UI for a whole session of runs, with an input line at the bottom. */
export function ChatApp(p: ChatAppProps) {
  const [view, dispatch] = useReducer(reduce, undefined, () => initialView(p.version, p.verbose, { workspace: p.workspace }));
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [frame, setFrame] = useState(0);
  const columns = (useStdout().stdout as NodeJS.WriteStream).columns || 80;

  useEffect(() => p.bus.on((event) => dispatch({ type: "event", event, now: Date.now() })), [p.bus]);
  useEffect(() => p.channel.on((line) => {
    if (line.type === "status") setStatus(line.status);
    else dispatch({ type: "chat", kind: line.type, text: line.text });
  }), [p.channel]);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => f + 1), 100);
    return () => clearInterval(timer);
  }, []);
  // Raw mode swallows SIGINT, so Ctrl-C arrives as input, whichever prompt has the focus.
  useInput((input, key) => {
    if (key.ctrl && input === "c") p.onCtrlC();
  });

  const onView = (kind: ViewKind) => {
    void p.readView(kind).then((body) => dispatch({ type: "artifact", title: VIEWS[kind].title, body: body ?? "(not available)" }));
  };
  const ask = view.permissions[0];

  return (
    <>
      <Static items={view.items}>
        {(item) => (
          <Box key={item.id} width={columns}>
            <StaticItemView item={item} />
          </Box>
        )}
      </Static>
      {ask ? (
        <PermissionPrompt key={ask.request.id} ask={ask} onAnswer={(answer) => p.onPermission(ask.request.id, answer)} />
      ) : view.humanReview ? (
        <HumanReviewPrompt review={view.humanReview} views={p.views()} onDecision={p.onDecision} onView={onView} />
      ) : (
        <>
          {status === "running" && view.current ? <LiveFooter view={view} now={Date.now()} frame={frame} interactive={false} /> : null}
          <ChatInput status={status} onSubmit={p.onSubmit} onEscape={p.onEscape} />
        </>
      )}
    </>
  );
}
