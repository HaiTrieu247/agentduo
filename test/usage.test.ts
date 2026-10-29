import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeUsage, codexUsage, readClaudeUsage, readCodexUsage, resetText } from "../src/core/usage.js";
import { testConfig } from "./helpers/config.js";
import { FakeClis } from "./helpers/fake-clis.js";
import { tempDir } from "./helpers/tmp.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const codexFixture = () => JSON.parse(fixture("codex-account.json")) as { "account/read": unknown; "account/rateLimits/read": Record<string, unknown> };
const TZ = "Asia/Saigon";
const real = () => {
  const f = codexFixture();
  return { account: { result: f["account/read"] }, rateLimits: { result: f["account/rateLimits/read"] } };
};

describe("usage: Claude's /usage", () => {
  it("reads the account, each limit and the rest of a real `claude -p /usage`", () => {
    const u = claudeUsage(fixture("claude-usage.txt"));
    expect(u.account).toBe("subscription");
    expect(u.groups).toEqual([{
      title: null,
      limits: [
        { label: "Current session", usedPercent: 46, resets: "Resets Oct 29 at 3pm (Asia/Saigon)" },
        { label: "Current week (all models)", usedPercent: 35, resets: "Resets Nov 4 at 7am (Asia/Saigon)" },
        { label: "Current week (Fable)", usedPercent: 16, resets: "Resets Nov 4 at 7am (Asia/Saigon)" },
      ],
    }]);
    expect(u.notes).toEqual([]);
    expect(u.details?.title).toBe("What's contributing to your limits usage?");
    expect(u.details?.lines[0]).toBe("Approximate · sessions on this machine only · shares overlap");
    expect(u.details?.lines).toContain("  93%  Start fresh when you switch tasks · run /clear");
    expect(u.details?.lines.at(-1)).toBe("  Top plugins: superpowers 29%, mattpocock-skills 1%");
  });

  it("keeps what it cannot read as limits, verbatim, so nothing Claude says is lost", () => {
    const u = claudeUsage("You are using API billing.\n\n  No plan limits apply.\n");
    expect(u).toEqual({ account: null, groups: [], notes: ["You are using API billing.", "", "  No plan limits apply."], details: null });
  });
});

describe("usage: Codex's account and rate limits", () => {
  it("shows a real ChatGPT account as Codex's /status does: plan, email, then its 5h and weekly limits", () => {
    expect(codexUsage(real(), TZ)).toEqual({
      status: "ready",
      usage: {
        account: "ChatGPT Plus · user@example.com",
        groups: [{
          title: null,
          limits: [
            { label: "5h limit", usedPercent: 0, resets: "Resets Oct 29 at 7:42pm" },
            { label: "Weekly limit", usedPercent: 12, resets: "Resets Nov 4 at 1:41pm" },
          ],
        }],
        notes: [],
        details: null,
      },
    });
  });

  it("shows each further bucket (a model's own limits) as a group of its own, and credits and a reached limit as notes", () => {
    const answers = real();
    const limits = answers.rateLimits.result as Record<string, any>;
    const spark = { ...limits.rateLimits, limitId: "codex_spark", limitName: "GPT-Spark", primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null }, secondary: null };
    limits.rateLimits = { ...limits.rateLimits, credits: { hasCredits: true, unlimited: false, balance: "12.5" }, rateLimitReachedType: "rate_limit_reached" };
    limits.rateLimitsByLimitId = { codex_spark: spark, codex: limits.rateLimits };
    const state = codexUsage(answers, TZ);
    if (state.status !== "ready") throw new Error(state.status);
    expect(state.usage.groups.map((g) => g.title)).toEqual([null, "GPT-Spark"]);
    expect(state.usage.groups[1]!.limits).toEqual([{ label: "5h limit", usedPercent: 100, resets: null }]);
    expect(state.usage.notes).toEqual(["Credits: 12.5", "You have reached a usage limit."]);
  });

  it("says that an API key has no plan limits, rather than failing", () => {
    const state = codexUsage({ account: { result: { account: { type: "apiKey" }, requiresOpenaiAuth: true } }, rateLimits: { error: "chatgpt authentication required" } }, TZ);
    expect(state).toEqual({ status: "ready", usage: { account: "API key", groups: [], notes: ["Codex signs in with an API key: there are no plan limits to show."], details: null } });
  });

  it("fails with what to do when Codex is not signed in", () => {
    const state = codexUsage({ account: { result: { account: null, requiresOpenaiAuth: true } }, rateLimits: { error: "not logged in" } }, TZ);
    expect(state).toEqual({ status: "error", error: "Codex is not signed in: run codex login" });
  });

  it("keeps the account when only the limits could not be read", () => {
    const answers = real();
    const state = codexUsage({ ...answers, rateLimits: { error: "backend unavailable" } }, TZ);
    expect(state).toMatchObject({ status: "ready", usage: { account: "ChatGPT Plus · user@example.com", groups: [], notes: ["Codex could not read its limits: backend unavailable"] } });
  });

  it("says when a limit resets as Claude does: the day, then the hour, with minutes only when they are not :00", () => {
    expect(resetText(1793277742, TZ)).toBe("Resets Oct 29 at 7:42pm");
    expect(resetText(Date.UTC(2026, 10, 4, 0, 0) / 1000, TZ)).toBe("Resets Nov 4 at 7am");
  });
});

describe("usage: asking the CLIs", () => {
  let t: ReturnType<typeof tempDir>;
  let fake: FakeClis;
  beforeEach(() => {
    t = tempDir();
    fake = new FakeClis(t.path).install();
  });
  afterEach(() => {
    fake.restore();
    t.cleanup();
  });
  const options = (cfg = testConfig(fake)) => ({ cfg, workspace: t.path, env: process.env, timeZone: TZ });

  it("runs `claude -p /usage`, which calls no model", async () => {
    fake.setScenario({ usage: { claude: { text: fixture("claude-usage.txt") } } });
    const state = await readClaudeUsage(options());
    expect(state).toMatchObject({ status: "ready", usage: { account: "subscription" } });
    expect(fake.usageCalls()).toEqual([{ backend: "claude", args: ["-p", "/usage"] }]);
    expect(fake.calls()).toEqual([]);
  });

  it("says why Claude's usage is missing: a failed call, or no CLI", async () => {
    fake.setScenario({ usage: { claude: { exit: 1, stderr: "Not logged in · Please run /login" } } });
    expect(await readClaudeUsage(options())).toEqual({ status: "error", error: "claude -p /usage failed (exit code 1): Not logged in · Please run /login" });
    const cfg = testConfig(fake);
    cfg.claude.bin = join(t.path, "missing", "claude");
    expect(await readClaudeUsage(options(cfg))).toEqual({ status: "error", error: "claude CLI not found" });
  });

  it("asks Codex's app server for the account and its limits, with the config overrides of its args, and closes it", async () => {
    const f = codexFixture();
    fake.setScenario({ usage: { codex: { account: f["account/read"], rateLimits: f["account/rateLimits/read"] } } });
    const cfg = testConfig(fake);
    cfg.codex.args = ["-c", "model_provider=\"openai\"", "--profile", "work", "--enable", "x"];
    const state = await readCodexUsage(options(cfg));
    expect(state).toMatchObject({ status: "ready", usage: { account: "ChatGPT Plus · user@example.com" } });
    const [call] = fake.usageCalls();
    expect(call).toEqual({ backend: "codex", args: ["app-server", "-c", "model_provider=\"openai\"", "--enable", "x"], methods: ["initialize", "initialized", "account/read", "account/rateLimits/read"] });
  });

  it("gives up on an app server that does not answer, and says so", async () => {
    fake.setScenario({ usage: { codex: { hang: true } } });
    const state = await readCodexUsage({ ...options(), timeoutMs: 400 });
    expect(state).toEqual({ status: "error", error: "codex app-server did not answer within 0.4s" });
  });

  it("says what a failing app server printed", async () => {
    fake.setScenario({ usage: { codex: { exit: 2, stderr: "error: unknown subcommand app-server" } } });
    expect(await readCodexUsage(options())).toEqual({ status: "error", error: "codex app-server failed (exit code 2): error: unknown subcommand app-server" });
  });

  it("stops both when asked to", async () => {
    fake.setScenario({ usage: { codex: { hang: true }, claude: { sleep: 5000 } } });
    const abort = new AbortController();
    const both = Promise.all([readClaudeUsage({ ...options(), signal: abort.signal }), readCodexUsage({ ...options(), signal: abort.signal })]);
    setTimeout(() => abort.abort(), 200);
    expect(await both).toEqual([{ status: "error", error: "stopped" }, { status: "error", error: "stopped" }]);
  });
});
