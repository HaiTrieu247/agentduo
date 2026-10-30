import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
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
    for (const s of ["codex CLI:", "codex-fake 1.0.0", "claude supports --output-format, --verbose, --json-schema, --permission-prompts, --input-format, --permission-prompt-tool",
      "schema review", ".agentduo/runs/ is git-ignored", "config: ws.yaml", "Claude asks you in the terminal before a tool call its settings do not allow"]) {
      expect(text).toContain(s);
    }
    const cfg = testConfig(new FakeClis(join(t.path, "b")));
    cfg.claude.permission_prompts = "deny";
    const denying = (await runDoctor({ dir: repo, cfg, sources: [], runsDir: join(repo, ".agentduo", "runs") })).map((c) => c.message).join("\n");
    expect(denying).toContain("implementer edits rely on your Claude Code permission settings");
    expect(denying).toContain("claude supports --output-format, --verbose, --json-schema, --permission-prompts");
    expect(denying).not.toContain("--permission-prompt-tool");
    cfg.claude.role_args = { implementer: ["--permission-mode", "acceptEdits"] };
    const quiet = await runDoctor({ dir: repo, cfg, sources: [], runsDir: join(repo, ".agentduo", "runs") });
    expect(quiet.map((c) => c.message).join("\n")).not.toContain("implementer edits rely on");
    cfg.claude.role_args = { implementer: ["--permission-mode=acceptEdits"] };
    const equals = await runDoctor({ dir: repo, cfg, sources: [], runsDir: join(repo, ".agentduo", "runs") });
    expect(equals.map((c) => c.message).join("\n")).not.toContain("implementer edits rely on");
  });

  it("notes where a Codex implementer's write access comes from", async () => {
    const t = tempDir();
    dirs.push(t);
    const repo = makeRepo(t.path);
    const cfg = testConfig(new FakeClis(t.path));
    cfg.agents.implementer = "codex";
    const text = (await runDoctor({ dir: repo, cfg, sources: [], runsDir: join(repo, ".agentduo", "runs") })).map((c) => c.message).join("\n");
    expect(text).toContain("implementer edits rely on your Codex sandbox settings");
    expect(text).not.toContain("Claude Code permission settings");
    cfg.codex.role_args = { implementer: ["--sandbox", "workspace-write"] };
    const quiet = (await runDoctor({ dir: repo, cfg, sources: [], runsDir: join(repo, ".agentduo", "runs") })).map((c) => c.message).join("\n");
    expect(quiet).not.toContain("implementer edits rely on");
  });

  it("only notes a folder outside a git repository, where the chat works and a run does not", async () => {
    const t = tempDir();
    dirs.push(t);
    const plain = join(t.path, "plain");
    mkdirSync(plain);
    const checks = await runDoctor({ dir: plain, cfg: testConfig(new FakeClis(t.path)), sources: [], runsDir: join(plain, ".agentduo", "runs") });
    expect(checks.filter((c) => !c.ok && c.required)).toEqual([]);
    expect(checks.find((c) => c.message.startsWith("workspace"))).toEqual({
      ok: false, required: false, message: `workspace not inside a git repository: ${plain} (the chat and /discuss work; a pipeline run needs 'git init' first)`,
    });
    expect(checks.find((c) => c.message.startsWith("codex supports"))).toMatchObject({ ok: true, message: expect.stringContaining("--skip-git-repo-check") });
  });

  it("checks a runs dir anywhere in the repository, which agentduo ignores itself", async () => {
    const t = tempDir();
    dirs.push(t);
    const repo = makeRepo(t.path, { ignoreRuns: false });
    mkdirSync(join(repo, "pkg"));
    const checks = await runDoctor({ dir: join(repo, "pkg"), cfg: testConfig(new FakeClis(t.path)), sources: [], runsDir: join(repo, "shared-runs") });
    expect(checks.find((c) => c.message.startsWith("../shared-runs/"))).toMatchObject({ ok: true, message: "../shared-runs/ gets its own .gitignore on the first run" });
  });

  it("reports missing CLIs, missing flags and config errors, and skips the ignore check outside the repository", async () => {
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
