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
}

/** Executables named codex/claude that run fake-agent.mjs against a scripted scenario. */
export class FakeClis {
  readonly bin: string;
  private readonly files: { FAKE_SCENARIO: string; FAKE_COUNTS: string; FAKE_LOG: string };
  private saved: Record<string, string | undefined> = {};

  constructor(readonly dir: string) {
    this.bin = join(dir, "bin");
    mkdirSync(this.bin, { recursive: true });
    for (const name of ["codex", "claude"]) {
      const path = join(this.bin, name);
      writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGENT}" ${name} "$@"\n`);
      chmodSync(path, 0o755);
    }
    this.files = { FAKE_SCENARIO: join(dir, "scenario.json"), FAKE_COUNTS: join(dir, "counts.json"), FAKE_LOG: join(dir, "calls.jsonl") };
    this.setScenario({});
  }

  path(name: "codex" | "claude"): string {
    return join(this.bin, name);
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

  /** Every `claude -p /usage` and finished `codex app-server` run: its arguments, and the methods the app server was asked. */
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
