import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { blockedReview, blockerKey, changedParts, findingsDigest, heldReview, implementerSettings, nextBlocker } from "../src/core/progress.js";
import type { ProgressMark } from "../src/core/state.js";
import { finding } from "./helpers/builders.js";
import { tempDir } from "./helpers/tmp.js";

const mark = (extra: Partial<ProgressMark> = {}): ProgressMark => ({ tree: "t1", notes: 0, plan: "p1", findings: "f1", settings: "s1", ...extra });

describe("progress: a blocker's identity and repeats", () => {
  it("knows a blocker by its words, whatever their case, punctuation or spacing", () => {
    expect(blockerKey("  API key needed. ")).toBe("api key needed");
    expect(blockerKey("api  KEY — needed!")).toBe(blockerKey("API key needed"));
    expect(blockerKey("Thiếu khóa API")).toBe("thiếu khóa api");
    expect(blockerKey("API key needed")).not.toBe(blockerKey("API token needed"));
  });

  it("counts the same blocker in a row only when the attempt changed no file, in the same round", () => {
    const first = nextBlocker(null, "API key needed", 1, mark(), true);
    expect(first).toEqual({ reason: "API key needed", key: "api key needed", round: 1, repeats: 1, mark: mark() });
    const again = nextBlocker(first, "api key needed.", 1, mark({ notes: 1 }), false);
    expect([again.repeats, again.reason, again.mark.notes]).toEqual([2, "api key needed.", 1]);
    expect(nextBlocker(again, "API key needed", 1, mark(), false).repeats).toBe(3);
    // Progress or another blocker starts the count again.
    expect(nextBlocker(again, "API key needed", 1, mark(), true).repeats).toBe(1);
    expect(nextBlocker(again, "the database is down", 1, mark(), false).repeats).toBe(1);
    expect(nextBlocker(again, "API key needed", 2, mark(), false).repeats).toBe(1);
  });

  it("names what changed between two marks, in a fixed order", () => {
    expect(changedParts(mark(), mark())).toEqual([]);
    expect(changedParts(mark(), mark({ settings: "s2", tree: "t2", notes: 1 }))).toEqual(["tree", "notes", "settings"]);
    expect(changedParts(mark(), mark({ plan: null, findings: "f2" }))).toEqual(["plan", "findings"]);
    expect(findingsDigest([finding("F1")])).toBe(findingsDigest([finding("F1")]));
    expect(findingsDigest([finding("F1")])).not.toBe(findingsDigest([finding("F1", "critical")]));
  });

  it("says what a blocker needs, and why a resume with nothing new did not run the implementer", () => {
    const b = nextBlocker(null, "API key needed.", 2, mark(), false);
    const blocked = blockedReview(b);
    expect(blocked.message).toBe("the implementer is blocked: API key needed. It needs something from you: 'resume' with a --note that gives it what it " +
      "asks for, or after you change the files it needs, re-runs round 2; 'resume' with nothing new does not run it again. " +
      "'revise' re-plans with your note; 'abort' ends the run.");
    expect(blocked.details).toEqual([]);
    const repeated = { ...b, repeats: 3 };
    expect(blockedReview(repeated).details).toEqual(["the same blocker 3 times in a row, the last attempt changing no file: what it was given since " +
      "did not unblock it (consider 'revise' or 'abort')"]);
    const held = heldReview(repeated);
    expect(held.message).toContain("so it was not run again (that would repeat the same call): API key needed. Give it what it needs: 'resume' with a --note");
    expect(held.message).toContain("such as a credential, a service or a tool");
    expect(held.details).toEqual(["blocked in round 2, 3 times in a row",
      "unchanged since: the workspace's files, your notes, the final plan, the open review findings, the implementer's settings (agentduo's and its CLI's)"]);
  });
});

describe("progress: the implementer's settings", () => {
  let t: { path: string; cleanup(): void };
  let env: NodeJS.ProcessEnv;
  let workspace: string;
  beforeEach(() => {
    t = tempDir();
    workspace = join(t.path, "ws");
    mkdirSync(workspace);
    env = { HOME: join(t.path, "home"), CLAUDE_CONFIG_DIR: join(t.path, "claude"), CODEX_HOME: join(t.path, "codex") };
  });
  afterEach(() => t.cleanup());

  it("changes with what agentduo passes the implementer, and only that", () => {
    const cfg = defaultConfig();
    const base = implementerSettings(cfg, workspace, env);
    expect(implementerSettings(defaultConfig(), workspace, env)).toBe(base);
    const changed = (edit: (c: ReturnType<typeof defaultConfig>) => void) => {
      const c = defaultConfig();
      edit(c);
      return implementerSettings(c, workspace, env) !== base;
    };
    expect(changed((c) => { c.claude.role_args.implementer = ["--permission-mode", "acceptEdits"]; })).toBe(true);
    expect(changed((c) => { c.claude.args = ["--allowedTools", "Bash(npm test:*)"]; })).toBe(true);
    expect(changed((c) => { c.claude.model = "opus"; })).toBe(true);
    expect(changed((c) => { c.agents.implementer = "codex"; })).toBe(true);
    // Not the implementer's: the cost cap, other roles' arguments, the other CLI.
    expect(changed((c) => { c.claude.max_budget_usd = 2; })).toBe(false);
    expect(changed((c) => { c.claude.role_args.plan_reviewer = ["--effort", "high"]; })).toBe(false);
    expect(changed((c) => { c.codex.args = ["--sandbox", "workspace-write"]; })).toBe(false);
  });

  it("changes with the CLI's own settings files, which snapshots leave out", () => {
    const cfg = defaultConfig();
    const base = implementerSettings(cfg, workspace, env);
    mkdirSync(join(workspace, ".claude"));
    writeFileSync(join(workspace, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(npm test:*)"] } }));
    const local = implementerSettings(cfg, workspace, env);
    expect(local).not.toBe(base);
    mkdirSync(env.CLAUDE_CONFIG_DIR!);
    writeFileSync(join(env.CLAUDE_CONFIG_DIR!, "settings.json"), JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }));
    expect(implementerSettings(cfg, workspace, env)).not.toBe(local);
    // Codex reads its own config.toml; Claude's files are not its.
    cfg.agents.implementer = "codex";
    const codex = implementerSettings(cfg, workspace, env);
    writeFileSync(join(workspace, ".claude", "settings.local.json"), "{}");
    expect(implementerSettings(cfg, workspace, env)).toBe(codex);
    mkdirSync(env.CODEX_HOME!);
    writeFileSync(join(env.CODEX_HOME!, "config.toml"), 'sandbox_mode = "workspace-write"\n');
    expect(implementerSettings(cfg, workspace, env)).not.toBe(codex);
  });
});
