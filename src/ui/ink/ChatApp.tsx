import { EventEmitter } from "node:events";
import { Box, Static, Text, useInput, useStdout } from "ink";
import { useEffect, useReducer, useRef, useState } from "react";
import type { ChatStatus } from "../../chat.js";
import { attachmentDetail, type Attachment } from "../../core/attachment-types.js";
import { AGENT_NAMES, complete, type Backend, type Completion } from "../../core/commands.js";
import type { UsageReport } from "../../core/usage.js";
import type { Decision, EventBus, ModelMap, PermissionAnswer } from "../../events.js";
import { modelText, PROVIDERS } from "../format.js";
import { StaticItemView } from "./App.js";
import { HumanReviewPrompt, VIEWS, type ViewKind } from "./HumanReviewPrompt.js";
import { LiveFooter, TurnFooter } from "./LiveFooter.js";
import { PermissionPrompt } from "./PermissionPrompt.js";
import { initialView, reduce } from "./store.js";
import { UsagePanel } from "./UsagePanel.js";

type ChatLine =
  | { type: "user" | "info"; text: string }
  | { type: "status"; status: ChatStatus }
  | { type: "edits"; mode: string }
  | { type: "recipient"; backend: Backend }
  | { type: "models"; models: ModelMap }
  | { type: "usage"; report: UsageReport }
  | { type: "attachments"; files: Attachment[] };

/** What the chat controller shows besides the agents' own events: your messages, its lines, and its state. */
export class ChatChannel {
  private readonly emitter = new EventEmitter();

  user(text: string): void {
    this.emitter.emit("line", { type: "user", text });
  }

  info(text: string): void {
    this.emitter.emit("line", { type: "info", text });
  }

  edits(mode: string): void {
    this.emitter.emit("line", { type: "edits", mode });
  }

  status(status: ChatStatus): void {
    this.emitter.emit("line", { type: "status", status });
  }

  recipient(backend: Backend): void {
    this.emitter.emit("line", { type: "recipient", backend });
  }

  models(models: ModelMap): void {
    this.emitter.emit("line", { type: "models", models });
  }

  /** /usage: a new report opens the usage panel; the same report again updates it. */
  usage(report: UsageReport): void {
    this.emitter.emit("line", { type: "usage", report });
  }

  /** The files waiting to go with the next message. */
  attachments(files: Attachment[]): void {
    this.emitter.emit("line", { type: "attachments", files });
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
  /** Shift+Tab, as in Claude Code: switch Claude between asking before edits and editing automatically. */
  onCycleEdits?(): void;
  /** r in the usage panel: look the usage up again. */
  onUsageRefresh?(): void;
  onDecision(d: Decision | "defer"): void;
  onPermission(id: string, answer: PermissionAnswer): void;
  views(): ViewKind[];
  readView(kind: ViewKind): Promise<string | null>;
}

function placeholder(status: ChatStatus, to: Backend): string {
  const name = AGENT_NAMES[to];
  switch (status) {
    case "idle":
      return `Ask ${name}… (/pipeline <task> runs the workflow; / lists commands)`;
    case "running":
      return "A note for the agents: they get it from the next step";
    case "answering":
      return `${name} is answering… Esc stops it`;
    case "paused":
      return `Ask ${name}… or /resume to continue the stopped run`;
  }
}

const HINTS: Record<ChatStatus, string> = {
  idle: "Enter send · / commands · Ctrl-C twice quit",
  running: "Enter send a note · Esc stops this step · Ctrl-C twice quit",
  answering: "Esc stops the answer · Ctrl-C twice quit",
  paused: "Enter ask · /resume continue the run · /new leave it · Ctrl-C twice quit",
};
const MENU_ROWS = 8;

/** The completion list under the input: commands, then their words, each with what it does. */
function Suggestions({ items, selected }: { items: Completion[]; selected: number }) {
  const start = Math.max(0, Math.min(selected - Math.floor(MENU_ROWS / 2), items.length - MENU_ROWS));
  const shown = items.slice(start, start + MENU_ROWS);
  return (
    <Box flexDirection="column" paddingX={1}>
      {shown.map((c, i) => {
        const on = start + i === selected;
        return (
          <Text key={`${c.label}-${start + i}`} wrap="truncate-end">
            <Text color={on ? "cyan" : undefined} bold={on}>{`${on ? "❯ " : "  "}${c.label}`}</Text>
            <Text dimColor>{`  ${c.description}`}</Text>
          </Text>
        );
      })}
      <Text dimColor>{`  ↑↓ choose · Tab/Enter fill in · Esc close${items.length > MENU_ROWS ? ` · ${items.length} in all` : ""}`}</Text>
    </Box>
  );
}

/** The files waiting to go with the next message, numbered as /detach takes them. */
function Attachments({ files }: { files: Attachment[] }) {
  return (
    <Box flexDirection="column" paddingX={1}>
      {files.map((a, i) => (
        <Text key={a.id} wrap="truncate-end">
          <Text color="cyan">{`📎 ${i + 1}. `}</Text>
          {a.name}
          <Text dimColor>{`  ${attachmentDetail(a)}`}</Text>
        </Text>
      ))}
      <Text dimColor>{`  ${files.length === 1 ? "goes" : "go"} with your next message (Enter alone sends ${files.length === 1 ? "it" : "them"}) · /detach <n|all> removes`}</Text>
    </Box>
  );
}

function ChatInput({ status, edits, to, models, files, onSubmit, onEscape, onCycleEdits }: {
  status: ChatStatus; edits: string | null; to: Backend; models: ModelMap | null; files: Attachment[]; onSubmit(text: string): void; onEscape(): void; onCycleEdits?(): void;
}) {
  const [text, setText] = useState("");
  const [selected, setSelected] = useState(0);
  /** The text the list was closed for (Esc, or filled in with Enter): it stays closed until the text changes. */
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const suggestions = text === closedFor ? [] : complete(text);
  const menu = suggestions.length > 0;
  useEffect(() => setSelected(0), [text]);
  const send = (value: string) => {
    onSubmit(value);
    setText("");
    setClosedFor(null);
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") return; // handled by the app, which counts presses
    if (key.tab && key.shift) {
      onCycleEdits?.();
      return;
    }
    if (menu) {
      const choice = suggestions[Math.min(selected, suggestions.length - 1)]!;
      if (key.upArrow) return setSelected((i) => (i - 1 + suggestions.length) % suggestions.length);
      if (key.downArrow) return setSelected((i) => (i + 1) % suggestions.length);
      if (key.escape) return setClosedFor(text);
      if (key.tab || key.return) {
        if (choice.insert && choice.insert !== text) {
          setText(choice.insert);
          // Enter fills in and closes the list, so the next Enter sends; Tab keeps it open for the next word.
          if (key.return) setClosedFor(choice.insert);
          return;
        }
        if (key.tab) return;
      }
    }
    if (key.tab) return;
    if (key.escape) {
      if (status === "running" || status === "answering") onEscape();
      else setText("");
      return;
    }
    if (key.return) send(text);
    else if (key.backspace || key.delete) setText((t) => t.slice(0, -1));
    else if (input && !key.ctrl && !key.meta) {
      // A paste (or fast typing) arrives as one chunk: line breaks inside it stay, an Enter at its end sends.
      const chunk = input.replace(/\r\n?/g, "\n");
      if (chunk.endsWith("\n")) send(text + chunk.slice(0, -1));
      else setText((t) => t + chunk);
    }
  });
  const model = (b: Backend) => `${PROVIDERS[b].mark} ${PROVIDERS[b].agent} ${models ? modelText(models[b], { short: true }) : "…"}`;
  return (
    <Box flexDirection="column" marginTop={1}>
      {files.length ? <Attachments files={files} /> : null}
      <Box borderStyle="round" borderColor={status === "paused" ? "yellow" : "gray"} paddingX={1}>
        <Text wrap="wrap">
          <Text color="cyan">{"› "}</Text>
          {text ? text : <Text dimColor>{placeholder(status, to)}</Text>}
          <Text inverse> </Text>
        </Text>
      </Box>
      {menu ? <Suggestions items={suggestions} selected={Math.min(selected, suggestions.length - 1)} /> : null}
      <Text dimColor wrap="truncate-end">
        {"  to: "}
        <Text bold>{AGENT_NAMES[to]}</Text>
        {` · ${model("claude")} · ${model("codex")}${edits ? ` · edits: ${edits} (Shift+Tab)` : ""}`}
      </Text>
      <Text dimColor wrap="truncate-end">{`  ${HINTS[status]}`}</Text>
    </Box>
  );
}

/** `duo` with no task: one live UI for a whole session of questions and runs, with an input line at the bottom. */
export function ChatApp(p: ChatAppProps) {
  const [view, dispatch] = useReducer(reduce, undefined, () => initialView(p.version, p.verbose, { workspace: p.workspace }));
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [edits, setEdits] = useState<string | null>(null);
  const [to, setTo] = useState<Backend>("codex");
  const [models, setModels] = useState<ModelMap | null>(null);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [usageTop, setUsageTop] = useState(0);
  const [files, setFiles] = useState<Attachment[]>([]);
  /** The report the usage panel shows, and the one it was closed on: what still arrives for that one stays closed. */
  const shownUsage = useRef(0);
  const closedUsage = useRef(0);
  const [frame, setFrame] = useState(0);
  const columns = (useStdout().stdout as NodeJS.WriteStream).columns || 80;

  useEffect(() => p.bus.on((event) => dispatch({ type: "event", event, now: Date.now() })), [p.bus]);
  useEffect(() => p.channel.on((line) => {
    if (line.type === "status") setStatus(line.status);
    else if (line.type === "edits") setEdits(line.mode);
    else if (line.type === "recipient") setTo(line.backend);
    else if (line.type === "models") setModels(line.models);
    else if (line.type === "attachments") setFiles(line.files);
    else if (line.type === "usage") {
      if (line.report.id <= closedUsage.current) return;
      // A new report (a refresh) starts at its top.
      if (line.report.id !== shownUsage.current) setUsageTop(0);
      shownUsage.current = line.report.id;
      setUsage(line.report);
    } else dispatch({ type: "chat", kind: line.type, text: line.text });
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
          {status === "answering" && view.turn ? <TurnFooter view={view} now={Date.now()} frame={frame} /> : null}
          {usage ? (
            <UsagePanel report={usage} top={usageTop} setTop={setUsageTop} onRefresh={() => p.onUsageRefresh?.()} onClose={() => {
              closedUsage.current = usage.id;
              setUsage(null);
            }} />
          ) : (
            <ChatInput status={status} edits={edits} to={to} models={models} files={files} onSubmit={p.onSubmit} onEscape={p.onEscape} onCycleEdits={p.onCycleEdits} />
          )}
        </>
      )}
    </>
  );
}
