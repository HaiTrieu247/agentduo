import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { WorkerMessage } from "../../extensions/vscode/src/protocol.js";
import { WorkerClient } from "../../extensions/vscode/src/workerClient.js";
import type { DuoEvent } from "../../src/events.js";
import { testConfig, type ConfigOverrides } from "./config.js";
import type { FakeClis } from "./fake-clis.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Builds the extension's engine worker into a fresh directory outside the repository, laid out as in the VSIX. */
export function buildWorker(): { script: string; cleanup(): void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentduo-worker-")));
  execFileSync(process.execPath, [join(ROOT, "scripts", "build-vscode.mjs"), "--out", dir, "--only", "runtime"], { cwd: ROOT, stdio: "pipe" });
  return { script: join(dir, "runtime", "worker.js"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function writeWorkspaceConfig(dir: string, fake: FakeClis, overrides: ConfigOverrides = {}): void {
  mkdirSync(join(dir, ".agentduo"), { recursive: true });
  writeFileSync(join(dir, ".agentduo", "config.yaml"), YAML.stringify(testConfig(fake, overrides)));
}

type Pushed = Exclude<WorkerMessage, { kind: "hello" } | { kind: "response" }>;

/** A real worker over IPC, recording everything it pushes. */
export class WorkerHarness {
  readonly client: WorkerClient;
  readonly messages: Pushed[] = [];
  readonly log: string[] = [];
  private readonly waiters = new Set<() => void>();

  constructor(o: { script: string; workspace: string; env: NodeJS.ProcessEnv; generation?: number }) {
    this.client = new WorkerClient({ node: process.execPath, script: o.script, cwd: o.workspace, env: o.env, generation: o.generation ?? 1, log: (l) => this.log.push(l) });
    this.client.onMessage((m) => {
      this.messages.push(m);
      for (const w of [...this.waiters]) w();
    });
  }

  events(): DuoEvent[] {
    return this.messages.flatMap((m) => (m.kind === "event" ? [m.event] : []));
  }

  statuses(): string[] {
    return this.messages.flatMap((m) => (m.kind === "ui" && m.update.type === "status" ? [m.update.status] : []));
  }

  infos(): string[] {
    return this.messages.flatMap((m) => (m.kind === "ui" && m.update.type === "info" ? [m.update.text] : []));
  }

  /** Resolves with the first pushed message (from the start) that matches. */
  waitFor<T extends Pushed>(match: (m: Pushed) => m is T, timeoutMs?: number): Promise<T>;
  waitFor(match: (m: Pushed) => boolean, timeoutMs?: number): Promise<Pushed>;
  waitFor(match: (m: Pushed) => boolean, timeoutMs = 25_000): Promise<Pushed> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = this.messages.find(match);
        if (!found) return false;
        this.waiters.delete(check);
        clearTimeout(timer);
        resolve(found);
        return true;
      };
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`timed out waiting for a worker message; got: ${this.messages.map((m) => (m.kind === "event" ? m.event.type : m.kind)).join(", ")}`));
      }, timeoutMs);
      if (!check()) this.waiters.add(check);
    });
  }

  /** The n-th (0-based) matching message, waiting for it. */
  async nth(match: (m: Pushed) => boolean, n: number, timeoutMs = 25_000): Promise<Pushed> {
    await this.waitFor(() => this.messages.filter(match).length > n, timeoutMs);
    return this.messages.filter(match)[n]!;
  }

  /** Sends a hand-made envelope over the worker's channel and waits for the reply to `id`. */
  raw(envelope: { id: number } & Record<string, unknown>): Promise<Record<string, unknown>> {
    const child = (this.client as unknown as { child: import("node:child_process").ChildProcess }).child;
    return new Promise((resolve) => {
      const onMessage = (m: Record<string, unknown>) => {
        if (m.kind !== "response" || m.id !== envelope.id) return;
        child.off("message", onMessage);
        resolve(m);
      };
      child.on("message", onMessage);
      child.send(envelope);
    });
  }
}

export const isEvent = <T extends DuoEvent["type"]>(type: T, where: (e: Extract<DuoEvent, { type: T }>) => boolean = () => true) =>
  (m: Pushed): m is Extract<Pushed, { kind: "event" }> => m.kind === "event" && m.event.type === type && where(m.event as Extract<DuoEvent, { type: T }>);

export const finished = (phase?: string) => isEvent("run.finished", (e) => !phase || e.phase === phase);

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function waitUntil(check: () => boolean, timeoutMs = 10_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
