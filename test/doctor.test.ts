import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/core/doctor.js";
import { testConfig } from "./helpers/config.js";
import { FakeClis } from "./helpers/fake-clis.js";
import { makeRepo } from "./helpers/repo.js";
import { tempDir } from "./helpers/tmp.js";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (dirs.length) dirs.pop()!.cleanup();
});

describe("runDoctor", () => {
  it("passes with working CLIs and config", async () => {
    const t = tempDir();
    dirs.push(t);
    const repo = makeRepo(t.path);
    const checks = await runDoctor({ repo, cfg: testConfig(new FakeClis(t.path)), sources: ["repo.yaml"] });
    expect(checks.filter((c) => !c.ok && c.required)).toEqual([]);
    const text = checks.map((c) => c.message).join("\n");
    for (const s of ["codex CLI:", "codex-fake 1.0.0", "claude supports --output-format", "schema review", ".agentduo/runs/ is git-ignored", "config: repo.yaml"]) {
      expect(text).toContain(s);
    }
  });

  it("reports missing CLIs, missing flags and config errors", async () => {
    const t = tempDir();
    dirs.push(t);
    const repo = makeRepo(t.path);
    const cfg = testConfig(new FakeClis(t.path));
    cfg.codex.bin = join(t.path, "missing");
    const oldClaude = join(t.path, "old-claude");
    writeFileSync(oldClaude, "#!/bin/sh\necho claude 0.1\n");
    chmodSync(oldClaude, 0o755);
    cfg.claude.bin = oldClaude;
    const checks = await runDoctor({ repo, cfg, sources: [], configError: "bad gates" });
    expect(checks.find((c) => c.message.startsWith("codex CLI not found"))?.ok).toBe(false);
    expect(checks.find((c) => c.message.startsWith("claude supports"))?.message).toContain("missing: --output-format");
    expect(checks.find((c) => c.message.startsWith("config:"))).toMatchObject({ ok: false, message: "config: bad gates" });
  });
});
