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

  setScenario(scenario: Record<string, unknown[]>): void {
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

  calls(role?: string): FakeCall[] {
    return this.entries().filter((e) => !e.permission).map((e) => e as unknown as FakeCall).filter((c) => !role || c.role === role);
  }

  /** The answers the fake Claude received to its permission prompts, in order. */
  permissionAnswers(): Array<{ behavior: string; message?: string; updatedPermissions?: unknown[] }> {
    return this.entries().flatMap((e) => (e.permission ? [e.permission as { behavior: string; message?: string }] : []));
  }
}
