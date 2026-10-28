import { render, type RenderOptions } from "ink";
import type { ChatStatus, ChatUi } from "../../chat.js";
import type { Decider, Decision, EventBus, PermissionDecider } from "../../events.js";
import { ChatApp, ChatChannel } from "./ChatApp.js";
import type { ViewKind } from "./HumanReviewPrompt.js";
import { permissionBroker } from "./session.js";

export interface ChatInkOptions {
  bus: EventBus;
  version: string;
  verbose: boolean;
  workspace: string;
  onSubmit(text: string): void;
  /** Esc, or the first Ctrl-C while a run is going: stop its current step. */
  onEscape(): void;
  /** Shift+Tab: switch the implementer's edit mode. */
  onCycleEdits?(): void;
  views(): ViewKind[];
  readView(kind: ViewKind): Promise<string | null>;
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
}

export interface ChatInkSession {
  decider: Decider;
  permissions: PermissionDecider;
  ui: ChatUi;
  /** Resolves when the user leaves: /quit, or Ctrl-C twice. */
  exited: Promise<void>;
  close(): Promise<void>;
}

/** Two Ctrl-C presses this close together leave the chat. */
const DOUBLE_PRESS_MS = 2000;

/** Mount the chat UI for a whole session; the Chat controller drives it through `ui`. */
export function startChatInk(o: ChatInkOptions): ChatInkSession {
  const channel = new ChatChannel();
  let exit: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => {
    exit = resolve;
  });
  let status: ChatStatus = "idle";
  let pendingDecision: ((d: Decision | "defer") => void) | undefined;
  const decider: Decider = { decide: () => new Promise((resolve) => { pendingDecision = resolve; }) };
  const onDecision = (d: Decision | "defer") => {
    const resolve = pendingDecision;
    pendingDecision = undefined;
    resolve?.(d);
  };
  const broker = permissionBroker(true);
  const ui: ChatUi = {
    info: (text) => channel.info(text),
    setStatus: (next) => {
      status = next;
      channel.status(next);
    },
    setEdits: (mode) => channel.edits(mode),
    exit: () => exit(),
  };
  let lastCtrlC = 0;
  const onCtrlC = () => {
    // At a decision nothing is running, so Ctrl-C means "decide later", as in a single run.
    if (pendingDecision) {
      onDecision("defer");
      return;
    }
    const now = Date.now();
    if (now - lastCtrlC < DOUBLE_PRESS_MS) {
      exit();
      return;
    }
    lastCtrlC = now;
    if (status === "running") o.onEscape();
    channel.info("Press Ctrl-C again to quit.");
  };
  const onSubmit = (text: string) => {
    if (text.trim()) channel.user(text.trim());
    o.onSubmit(text);
  };
  const options: RenderOptions = { exitOnCtrlC: false, patchConsole: false };
  if (o.stdout) options.stdout = o.stdout;
  if (o.stdin) options.stdin = o.stdin;
  const instance = render(
    <ChatApp bus={o.bus} channel={channel} version={o.version} workspace={o.workspace} verbose={o.verbose} onSubmit={onSubmit}
      onEscape={o.onEscape} onCtrlC={onCtrlC} onCycleEdits={o.onCycleEdits} onDecision={onDecision} onPermission={broker.answer} views={o.views} readView={o.readView} />,
    options,
  );
  return {
    decider,
    permissions: broker.permissions,
    ui,
    exited,
    close: async () => {
      instance.unmount();
      await instance.waitUntilExit().catch(() => undefined);
    },
  };
}
