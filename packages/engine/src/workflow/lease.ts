// Who works in a workspace now. `duo`, the VS Code extension and the desktop app can all be open on one workspace;
// each takes the workspace lock (<runs>/.lock) only while work runs there (an agent's answer, a /discuss, a pipeline
// run, a write to a conversation), and the conversation's own lock (<runs>/conversations/<id>/.lock) beside it, so an
// idle window never keeps another from working, and two never write one conversation at once. A process holds each
// lock once for all its work (the extension's tabs share it) and gives it back when its last piece of work ends.
import { join } from "node:path";
import { acquireLockFile, acquireWorkspaceLock, lockHolder, workspaceLockHolder } from "./state.js";

/** Where conversation `id`'s lock is: beside its conversation.json. */
export const conversationLockPath = (runsDir: string, id: string): string => join(runsDir, "conversations", id, ".lock");

export const conversationBusy = (pid: number | null): string => pid
  ? `this conversation is in use by another agentduo (pid ${pid}); wait for it to finish there, or continue it there`
  : "another agentduo is starting work in this conversation; try again in a moment";

/** The live process (another one, or this one) working in conversation `id` now, or null. */
export function conversationHolder(runsDir: string, id: string): number | null {
  return lockHolder(conversationLockPath(runsDir, id));
}

interface Held {
  count: number;
  release: () => void;
}

export class WorkspaceLease {
  private workspace: Held | null = null;
  private readonly conversations = new Map<string, Held>();

  /** `onChange`: this process starts holding the workspace (true), or gives it back (false). */
  constructor(readonly runsDir: string, private readonly onChange?: (held: boolean) => void) {}

  /** This process holds the workspace for some work now. */
  get held(): boolean {
    return !!this.workspace;
  }

  /** This process holds conversation `id` now. */
  holds(id: string): boolean {
    return this.conversations.has(id);
  }

  /** Another live process that holds the workspace now, or null (nobody, or this lease). */
  holder(): number | null {
    const pid = workspaceLockHolder(this.runsDir);
    return pid && !(pid === process.pid && this.held) ? pid : null;
  }

  /**
   * Takes the workspace for one piece of work, and with `conversation` that conversation too. Throws LockError when
   * another process holds either; nothing is held then. The release is idempotent, and the locks go once the last
   * piece of work that holds them is released.
   */
  take(conversation?: string): () => void {
    const first = !this.workspace;
    const workspace = this.workspace ?? { count: 0, release: acquireWorkspaceLock(this.runsDir) };
    let held: Held | undefined;
    if (conversation) {
      held = this.conversations.get(conversation);
      if (!held) {
        try {
          held = { count: 0, release: acquireLockFile(conversationLockPath(this.runsDir, conversation), conversationBusy) };
        } catch (e) {
          if (first) workspace.release();
          throw e;
        }
        this.conversations.set(conversation, held);
      }
      held.count++;
    }
    workspace.count++;
    this.workspace = workspace;
    if (first) this.onChange?.(true);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (conversation && held && --held.count === 0) {
        this.conversations.delete(conversation);
        held.release();
      }
      if (--workspace.count === 0 && this.workspace === workspace) {
        this.workspace = null;
        workspace.release();
        this.onChange?.(false);
      }
    };
  }
}
