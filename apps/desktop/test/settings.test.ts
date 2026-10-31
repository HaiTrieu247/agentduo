import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliStatus, needsNode, readSettings, updateSetting, clearSetting, type Runner } from "../src/main/settings.js";
import { diagnosticsText, redact } from "../src/main/diagnostics.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentduo-desktop-settings-"));
  mkdirSync(join(dir, "bin"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function bin(name: string, text = "#!/bin/sh\necho 1.0\n"): string {
  const file = join(dir, "bin", name);
  writeFileSync(file, text);
  chmodSync(file, 0o755);
  return file;
}

const env = () => ({ PATH: join(dir, "bin"), HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), APPDATA: join(dir, "config") });

describe.skipIf(process.platform === "win32")("cliStatus", () => {
  it("tells missing, signed in and signed out apart, without a model call", async () => {
    bin("claude");
    bin("codex");
    const calls: string[][] = [];
    const run = (claudeIn: boolean, codexIn: boolean): Runner => async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === "--version") return { code: 0, stdout: "2.1.31 (Claude Code)\n", stderr: "", timedOut: false };
      if (args.join(" ") === "auth status") return { code: claudeIn ? 0 : 1, stdout: JSON.stringify({ loggedIn: claudeIn }), stderr: "", timedOut: false };
      return codexIn ? { code: 0, stdout: "Logged in using ChatGPT\n", stderr: "", timedOut: false } : { code: 1, stdout: "", stderr: "Not logged in\n", timedOut: false };
    };
    const signedIn = await cliStatus({ backend: "claude", configured: "claude", source: "default", env: env(), cwd: dir, run: run(true, true) });
    expect(signedIn).toMatchObject({ state: "signed-in", version: "2.1.31 (Claude Code)", path: join(dir, "bin", "claude") });
    expect((await cliStatus({ backend: "claude", configured: "claude", source: "default", env: env(), cwd: dir, run: run(false, true) })).state).toBe("signed-out");
    expect((await cliStatus({ backend: "codex", configured: "codex", source: "default", env: env(), cwd: dir, run: run(true, true) })).state).toBe("signed-in");
    expect((await cliStatus({ backend: "codex", configured: "codex", source: "default", env: env(), cwd: dir, run: run(true, false) })).state).toBe("signed-out");
    expect((await cliStatus({ backend: "codex", configured: "codex-nope", source: "global", env: env(), cwd: dir, run: run(true, true) })).state).toBe("missing");
    expect(calls.every((c) => ["--version", "auth", "login"].includes(c[1]!))).toBe(true);
  });

  it("says how each CLI signs in: its own account or an API, never the key", async () => {
    bin("claude");
    bin("codex");
    const run = (auth: string): Runner => async (_cmd, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "1.0\n", stderr: "", timedOut: false };
      return { code: 0, stdout: args[0] === "auth" ? auth : "", stderr: args[0] === "login" ? auth : "", timedOut: false };
    };
    const probe = async (backend: "claude" | "codex", auth: string) =>
      (await cliStatus({ backend, configured: backend, source: "default", env: env(), cwd: dir, run: run(auth) })).auth;
    const claude = (o: object) => JSON.stringify({ loggedIn: true, ...o });
    expect(await probe("claude", claude({ authMethod: "claude.ai", subscriptionType: "max", email: "me@example.com" }))).toEqual({ kind: "account", plan: "Max", email: "me@example.com" });
    expect(await probe("claude", claude({ authMethod: "api_key" }))).toEqual({ kind: "api", plan: "API key", email: null });
    expect(await probe("claude", claude({ authMethod: "third_party", apiProvider: "bedrock" }))).toEqual({ kind: "api", plan: "Amazon Bedrock", email: null });
    expect(await probe("claude", claude({}))).toBeNull();
    expect(await probe("codex", "Logged in using ChatGPT\n")).toEqual({ kind: "account", plan: "ChatGPT", email: null });
    const key = await probe("codex", "Logged in using an API key - sk-proj-abc***xyz\n");
    expect(key).toEqual({ kind: "api", plan: "API key", email: null });
    expect(JSON.stringify(key)).not.toContain("sk-");
    expect(await probe("codex", "Not logged in\n")).toBeNull();
  });

  it("reports a CLI whose --version fails, and an npm-installed one with no node on the PATH", async () => {
    const shim = bin("claude", "#!/usr/bin/env node\nconsole.log(1)\n");
    expect(needsNode(shim, "darwin")).toBe(true);
    expect(needsNode("C:\\npm\\codex.cmd", "win32")).toBe(true);
    const r = await cliStatus({ backend: "claude", configured: "claude", source: "default", env: env(), cwd: dir, run: async () => ({ code: 2, stdout: "", stderr: "boom\n", timedOut: false }) });
    expect(r).toMatchObject({ state: "error", detail: "boom" });
  });
});

describe("configuration with no project and no worker", () => {
  it("writes the user config only, and clears back to the default", async () => {
    const t = { workspace: null, session: null, env: env() };
    const before = await readSettings(t);
    expect(before.workspace).toBeNull();
    const set = await updateSetting(t, "global", "limits.max_review_rounds", 7);
    expect(set.entries.find((e) => e.key === "limits.max_review_rounds")).toMatchObject({ effective: 7, source: "global" });
    const cleared = await clearSetting(t, "global", "limits.max_review_rounds");
    expect(cleared.entries.find((e) => e.key === "limits.max_review_rounds")?.source).toBe("default");
    await expect(updateSetting(t, "project", "limits.max_review_rounds", 7)).rejects.toThrow(/only the user config/);
    await expect(updateSetting({ ...t, workspace: dir }, "session", "claude.model", "opus")).rejects.toThrow(/worker/);
  });

  it("refuses a value that would make the config invalid, and writes nothing", async () => {
    const t = { workspace: dir, session: null, env: env() };
    await expect(updateSetting(t, "project", "limits.max_review_rounds", -3)).rejects.toThrow();
    const view = await readSettings(t);
    expect(view.files.find((f) => f.scope === "project")?.exists).toBe(false);
  });
});

describe("diagnostics", () => {
  it("writes the home folder as ~ and hides long base64 and credentials", () => {
    expect(redact("/Users/me/x token=abc123 " + "A".repeat(200), "/Users/me")).toBe("~/x token=[redacted] [redacted]");
    const text = diagnosticsText({ versions: { app: "1" }, platform: "darwin", arch: "arm64", userData: "/Users/me/ud", project: null, launcher: null, clis: [], config: null, configError: "bad", log: ["a"], home: "/Users/me" });
    expect(text).toContain("app data: ~/ud");
    expect(text).toContain("could not read it: bad");
  });
});
