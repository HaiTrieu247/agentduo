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
  it("passes with working CLIs and notes where Claude's edit permission comes from", async () => {
    const t = tempDir();
    dirs.push(t);
    const repo = makeRepo(t.path);
    const checks = await runDoctor({ dir: repo, cfg: testConfig(new FakeClis(t.path)), sources: ["ws.yaml"], runsDir: join(repo, ".agentduo", "runs") });
    expect(checks.filter((c) => !c.ok && c.required)).toEqual([]);
    const text = checks.map((c) => c.message).join("\n");
    for (const s of ["codex CLI:", "codex-fake 1.0.0", "claude supports --output-format, --verbose, --json-schema, --permission-prompts", "schema review",
      ".agentduo/runs/ is git-ignored", "config: ws.yaml", "implementer edits rely on your Claude Code permission settings"]) {
      expect(text).toContain(s);
    }
    const cfg = testConfig(new FakeClis(join(t.path, "b")));
    cfg.claude.role_args = { implementer: ["--permission-mode", "acceptEdits"] };
    const quiet = await runDoctor({ dir: repo, cfg, sources: [], runsDir: join(repo, ".agentduo", "runs") });
    expect(quiet.map((c) => c.message).join("\n")).not.toContain("implementer edits rely on");
  });

  it("reports missing CLIs, missing flags and config errors, and skips the ignore check outside the workspace", async () => {
    const t = tempDir();
    dirs.push(t);
    const repo = makeRepo(t.path);
    const cfg = testConfig(new FakeClis(t.path));
    cfg.codex.bin = join(t.path, "missing");
    const oldClaude = join(t.path, "old-claude");
    writeFileSync(oldClaude, "#!/bin/sh\necho claude 0.1\n");
    chmodSync(oldClaude, 0o755);
    cfg.claude.bin = oldClaude;
    const checks = await runDoctor({ dir: repo, cfg, sources: [], configError: "bad gates", runsDir: join(t.path, "elsewhere") });
    expect(checks.find((c) => c.message.startsWith("codex CLI not found"))?.ok).toBe(false);
    expect(checks.find((c) => c.message.startsWith("claude supports"))?.message).toContain("missing: --output-format");
    expect(checks.find((c) => c.message.startsWith("config:"))).toMatchObject({ ok: false, message: "config: bad gates" });
    expect(checks.some((c) => c.message.includes("git-ignored"))).toBe(false);
  });
});
