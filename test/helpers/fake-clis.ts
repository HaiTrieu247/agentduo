import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_AGENT = fileURLToPath(new URL("../fake-agent.mjs", import.meta.url));

export interface FakeCall {
  backend: string;
  role: string;
  call: number;
  args: string[];
  prompt: string;
  /** The images the call got as images: Claude's blocks (media type, base64 length), Codex's --image files; and their bytes' sha256. */
  images?: Array<{ mediaType?: string; base64?: number; file?: string; missing?: boolean; sha256?: string }>;
  /** Host variables that reached the agent (ELECTRON_RUN_AS_NODE, NODE_CHANNEL_FD…); absent when none did. */
  leaked?: string[];
}

/**
 * What runs fake-agent.mjs: a Node, or an Electron binary with ELECTRON_RUN_AS_NODE=1 in `env` (the desktop's tests run
 * under Electron, whose process.execPath would otherwise open a window). Never left to process.execPath silently.
 */
export interface FakeRuntime {
  exec: string;
  env?: Record<string, string>;
}

/** The shim's file name and text: a shell script on POSIX, a .cmd on Windows (as npm installs the real CLIs there). */
export function fakeShim(name: "codex" | "claude", runtime: FakeRuntime, platform: NodeJS.Platform = process.platform, agent = FAKE_AGENT): { file: string; text: string } {
  const env = Object.entries(runtime.env ?? {});
  if (platform === "win32") {
    // %* passes the arguments as cmd.exe got them, quotes included; `set "K=V"` keeps a value with spaces whole.
    const sets = env.map(([k, v]) => `set "${k}=${v}"\r\n`).join("");
    return { file: `${name}.cmd`, text: `@echo off\r\n${sets}"${runtime.exec}" "${agent}" ${name} %*\r\n` };
  }
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const sets = env.map(([k, v]) => `${k}=${q(v)} `).join("");
  return { file: name, text: `#!/bin/sh\n${sets}exec "${runtime.exec}" "${agent}" ${name} "$@"\n` };
}

/** Executables named codex/claude that run fake-agent.mjs against a scripted scenario. */
export class FakeClis {
  readonly bin: string;
  private readonly files: { FAKE_SCENARIO: string; FAKE_COUNTS: string; FAKE_LOG: string };
  private saved: Record<string, string | undefined> = {};
  private readonly names = new Map<string, string>();

  /** `runtime`: what runs the fake agent (default: this process's Node, which must be a Node). */
  constructor(readonly dir: string, runtime: FakeRuntime = { exec: process.execPath }) {
    this.bin = join(dir, "bin");
    mkdirSync(this.bin, { recursive: true });
    for (const name of ["codex", "claude"] as const) {
      const shim = fakeShim(name, runtime);
      const path = join(this.bin, shim.file);
      writeFileSync(path, shim.text);
      chmodSync(path, 0o755);
      this.names.set(name, path);
    }
    this.files = { FAKE_SCENARIO: join(dir, "scenario.json"), FAKE_COUNTS: join(dir, "counts.json"), FAKE_LOG: join(dir, "calls.jsonl") };
    this.setScenario({});
  }

  /** The shim's path: `<bin>/codex`, or `<bin>\\codex.cmd` on Windows. */
  path(name: "codex" | "claude"): string {
    return this.names.get(name)!;
  }

  /** What the fake agents read and write their scenario, counts and log through (for a process given its own environment). */
  get env(): Record<string, string> {
    return { ...this.files };
  }

  setScenario(scenario: Record<string, unknown[] | Record<string, unknown>>): void {
    writeFileSync(this.files.FAKE_SCENARIO, JSON.stringify(scenario));
  }

  install(): this {
    for (const [key, value] of Object.entries(this.files)) {
      this.saved[key] = process.env[key];
      process.env[key] = value;
    }
    return this;
  }

  restore(): void {
    for (const [key, value] of Object.entries(this.saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  private entries(): Array<Record<string, unknown>> {
    if (!existsSync(this.files.FAKE_LOG)) return [];
    return readFileSync(this.files.FAKE_LOG, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  /** Agent calls (not permission answers, not codex doctor, its catalog or a usage lookup), optionally of one role ("chat_claude" for a chat answer). */
  calls(role?: string): FakeCall[] {
    return this.entries().filter((e) => !e.permission && !e.doctor && !e.catalog && !e.usage).map((e) => e as unknown as FakeCall).filter((c) => !role || c.role === role);
  }

  /** Every `claude -p /usage`, `claude auth status` and finished `codex app-server` run: its arguments, and the methods the app server was asked. */
  usageCalls(): Array<{ backend: string; args: string[]; methods?: string[] }> {
    return this.entries().flatMap((e) => (e.usage ? [{ backend: e.backend as string, args: e.args as string[], ...(e.methods ? { methods: e.methods as string[] } : {}) }] : []));
  }

  /** The arguments of every `codex doctor` run. */
  doctorCalls(): string[][] {
    return this.entries().flatMap((e) => (e.doctor ? [e.args as string[]] : []));
  }

  /** The arguments of every `codex debug models` run. */
  catalogCalls(): string[][] {
    return this.entries().flatMap((e) => (e.catalog ? [e.args as string[]] : []));
  }

  /** The answers the fake Claude received to its permission prompts, in order. */
  permissionAnswers(): Array<{ behavior: string; message?: string; updatedPermissions?: unknown[] }> {
    return this.entries().flatMap((e) => (e.permission ? [e.permission as { behavior: string; message?: string }] : []));
  }
}
