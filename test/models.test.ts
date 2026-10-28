import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import {
  claudeIdentity, claudeLocalSignature, claudeSettingsModel, codexCatalog, codexDoctorArgs, doctorModel, explicitModel, ModelRegistry, withObserved,
  type CodexCatalog,
} from "../src/core/models.js";
import type { ModelMap } from "../src/events.js";
import { FakeClis } from "./helpers/fake-clis.js";
import { tempDir } from "./helpers/tmp.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

let t: ReturnType<typeof tempDir>;
beforeEach(() => {
  t = tempDir();
});
afterEach(() => t.cleanup());

describe("models: Codex", () => {
  it("reads the model from a real codex doctor --json report", () => {
    expect(doctorModel(fixture("codex-doctor.json"))).toEqual({ model: "gpt-6.1-sol", reason: null });
  });

  it("lists what a real codex debug models offers as Codex's /model does: the listed models, by priority", () => {
    const c = codexCatalog(fixture("codex-models.json"));
    expect(c.reason).toBeNull();
    expect(c.models.map((m) => m.id)).toEqual(["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    expect(c.models[0]).toEqual({
      id: "gpt-6.1-sol", label: "GPT-6.1-Sol", description: "Latest workhorse model for coding and everyday work.",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "low",
    });
  });

  it("gives a reason, not a list, when codex debug models prints no catalog", () => {
    expect(codexCatalog("not json")).toMatchObject({ models: [], reason: expect.any(String) });
    expect(codexCatalog(JSON.stringify({ models: [{ slug: "x", visibility: "hide" }] }))).toMatchObject({ models: [], reason: expect.any(String) });
  });

  it("gives a reason, not a name, when the report has none or is not JSON", () => {
    expect(doctorModel("not json").model).toBeNull();
    expect(doctorModel("not json").reason).toBeTruthy();
    expect(doctorModel(JSON.stringify({ checks: { "config.load": { details: {} } } }))).toMatchObject({ model: null, reason: expect.any(String) });
  });

  it("forwards config overrides and feature switches in order, and nothing else", () => {
    expect(codexDoctorArgs(["-c", "model=a", "--search", "--enable", "x", "--config=foo=1", "--profile", "p", "--disable", "y"]))
      .toEqual(["-c", "model=a", "--enable", "x", "--config=foo=1", "--disable", "y"]);
  });

  it("lets a --model in args win over the config's model, as it comes later on the command line", () => {
    expect(explicitModel({ model: "a", args: ["--model", "b"] }, ["--model", "-m"])).toEqual({ model: "b", source: "args" });
    expect(explicitModel({ model: "a", args: [] }, ["--model", "-m"])).toEqual({ model: "a", source: "config" });
    expect(explicitModel({ model: null, args: [] }, ["--model", "-m"])).toBeNull();
  });
});

describe("models: Claude", () => {
  const env = () => ({ HOME: join(t.path, "home"), CLAUDE_CONFIG_DIR: join(t.path, "claude-home") });

  it("shows a settings alias as configured, awaiting the name Claude's first answer gives", () => {
    mkdirSync(join(t.path, ".claude"), { recursive: true });
    writeFileSync(join(t.path, ".claude", "settings.json"), JSON.stringify({ model: "sonnet" }));
    const cfg = defaultConfig().claude;
    const m = claudeIdentity(cfg, t.path, env(), undefined, []);
    expect(m).toMatchObject({ isDefault: true, configured: "sonnet", source: "settings", status: "configured", resolved: null });
    expect(withObserved(m, "claude-sonnet-9")).toMatchObject({ resolved: "claude-sonnet-9", source: "observed", status: "resolved" });
  });

  it("puts local settings before project settings, and ANTHROPIC_MODEL before both", () => {
    mkdirSync(join(t.path, ".claude"), { recursive: true });
    writeFileSync(join(t.path, ".claude", "settings.json"), JSON.stringify({ model: "sonnet" }));
    writeFileSync(join(t.path, ".claude", "settings.local.json"), JSON.stringify({ model: "opus" }));
    expect(claudeSettingsModel({ args: [], workspace: t.path, env: env(), managed: [] }).model).toBe("opus");
    expect(claudeSettingsModel({ args: ["--setting-sources", "project"], workspace: t.path, env: env(), managed: [] }).model).toBe("sonnet");
    expect(claudeSettingsModel({ args: ["--settings", '{"model":"haiku"}'], workspace: t.path, env: env(), managed: [] }).model).toBe("haiku");
    expect(claudeIdentity(defaultConfig().claude, t.path, { ...env(), ANTHROPIC_MODEL: "claude-x" }, undefined, [])).toMatchObject({ configured: "claude-x", source: "env" });
  });

  it("leaves a permission rule out of what the model depends on, but not a settings file's model or env", () => {
    const o = { args: [], workspace: t.path, env: env(), managed: [] };
    mkdirSync(join(t.path, ".claude"), { recursive: true });
    const before = claudeLocalSignature(o);
    writeFileSync(join(t.path, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } }));
    expect(claudeLocalSignature(o)).toBe(before);
    writeFileSync(join(t.path, ".claude", "settings.local.json"), JSON.stringify({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "x" } }));
    expect(claudeLocalSignature(o)).not.toBe(before);
    expect(claudeLocalSignature({ ...o, env: { ...env(), ANTHROPIC_MODEL: "claude-x" } })).not.toBe(claudeLocalSignature(o));
  });

  it("names an explicit model as requested, and says why a source it cannot read gives no name", () => {
    expect(claudeIdentity({ ...defaultConfig().claude, model: "opus" }, t.path, env(), undefined, [])).toMatchObject({ isDefault: false, requested: "opus", source: "config" });
    expect(claudeIdentity({ ...defaultConfig().claude, args: ["--setting-sources", "cloud"] }, t.path, env(), undefined, [])).toMatchObject({ status: "unresolved", reason: expect.stringContaining("cloud") });
    expect(claudeIdentity(defaultConfig().claude, t.path, env(), undefined, [])).toMatchObject({ isDefault: true, configured: null, reason: expect.any(String) });
  });
});

describe("models: the registry follows the CLIs' own config", () => {
  let clis: FakeClis;
  beforeEach(() => {
    clis = new FakeClis(join(t.path, "fake")).install();
  });
  afterEach(() => clis.restore());

  function setup(o: { catalog?: CodexCatalog[] } = {}) {
    const home = join(t.path, "home");
    const ws = join(t.path, "ws");
    mkdirSync(join(ws, ".claude"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude") };
    for (const k of Object.keys(env)) if (k.startsWith("ANTHROPIC_")) delete env[k];
    const cfg = defaultConfig();
    cfg.codex.bin = clis.path("codex");
    cfg.claude.bin = clis.path("claude");
    const seen: ModelMap[] = [];
    const registry = new ModelRegistry({
      cfg: () => cfg, workspace: ws, env, managedSettings: [], onChange: (m) => seen.push(m), ...(o.catalog ? { onCatalog: (c: CodexCatalog) => o.catalog!.push(c) } : {}),
    });
    return { registry, env, seen, cfg, claudeSettings: join(ws, ".claude", "settings.json"), codexConfig: join(home, ".codex", "config.toml") };
  }

  it("drops the model Claude named once its settings or environment name another", () => {
    const { registry, env, claudeSettings } = setup();
    writeFileSync(claudeSettings, JSON.stringify({ model: "sonnet" }));
    registry.refresh();
    const sonnet = registry.signature("claude");
    registry.observe("claude", "claude-sonnet-old", sonnet);
    expect(registry.identity("claude")).toMatchObject({ configured: "sonnet", resolved: "claude-sonnet-old" });

    writeFileSync(claudeSettings, JSON.stringify({ model: "opus" }));
    registry.refresh();
    expect(registry.identity("claude")).toMatchObject({ configured: "opus", resolved: null, status: "configured" });
    // A call started with the old settings names its model after they changed: not the model of the new ones.
    registry.observe("claude", "claude-sonnet-late", sonnet);
    expect(registry.identity("claude")).toMatchObject({ configured: "opus", resolved: null });

    registry.observe("claude", "claude-opus-9", registry.signature("claude"));
    env.ANTHROPIC_MODEL = "claude-haiku-x";
    registry.refresh();
    expect(registry.identity("claude")).toMatchObject({ configured: "claude-haiku-x", source: "env", resolved: null });
    registry.close();
  });

  it("reads Codex's model catalog only for a view that shows it, once per binary, overrides and config", async () => {
    const plain = setup();
    plain.registry.refresh();
    await vi.waitFor(() => expect(plain.registry.identity("codex").status).toBe("resolved"), { timeout: 10_000 });
    expect(clis.catalogCalls()).toHaveLength(0); // the terminal chat has no model picker
    plain.registry.close();

    const catalogs: CodexCatalog[] = [];
    const { registry, cfg, codexConfig } = setup({ catalog: catalogs });
    cfg.codex.args = ["-c", "model_provider=fake", "--sandbox", "read-only"];
    clis.setScenario({ catalog: { models: [{ slug: "gpt-b", display_name: "B", priority: 2 }, { slug: "gpt-a", display_name: "A", priority: 1 }] } });
    registry.refresh();
    await vi.waitFor(() => expect(catalogs).toHaveLength(1), { timeout: 10_000 });
    expect(catalogs[0]!.models.map((m) => m.id)).toEqual(["gpt-a", "gpt-b"]);
    expect(clis.catalogCalls()).toEqual([["debug", "models", "-c", "model_provider=fake"]]);
    registry.refresh();
    expect(clis.catalogCalls()).toHaveLength(1);

    writeFileSync(codexConfig, 'model_provider = "other"\n');
    clis.setScenario({ catalog: { exit: 1 } });
    registry.refresh();
    await vi.waitFor(() => expect(catalogs).toHaveLength(2), { timeout: 10_000 });
    expect(catalogs[1]).toMatchObject({ models: [], reason: expect.stringContaining("codex debug models") });
    registry.close();
  });

  it("asks codex doctor again once Codex's config file changes, and only then", async () => {
    const { registry, codexConfig } = setup();
    writeFileSync(codexConfig, 'model = "gpt-a"\n');
    clis.setScenario({ doctor: { model: "gpt-a" } });
    registry.refresh();
    await vi.waitFor(() => expect(registry.identity("codex").resolved).toBe("gpt-a"), { timeout: 10_000 });
    registry.refresh();
    expect(clis.doctorCalls()).toHaveLength(1);

    writeFileSync(codexConfig, 'model = "gpt-b"\n');
    clis.setScenario({ doctor: { model: "gpt-b" } });
    registry.refresh();
    expect(registry.identity("codex")).toMatchObject({ status: "resolving", resolved: null });
    await vi.waitFor(() => expect(registry.identity("codex").resolved).toBe("gpt-b"), { timeout: 10_000 });
    expect(clis.doctorCalls()).toHaveLength(2);
    registry.close();
  });

  it("never shows what codex doctor said for a config file that changed while it ran, and asks again", async () => {
    const { registry, seen, codexConfig } = setup();
    writeFileSync(codexConfig, 'model = "gpt-a"\n');
    clis.setScenario({ doctor: { model: "gpt-a", sleep: 600 } });
    registry.refresh();
    await vi.waitFor(() => expect(clis.doctorCalls()).toHaveLength(1), { timeout: 10_000 });
    writeFileSync(codexConfig, 'model = "gpt-b"\n');
    clis.setScenario({ doctor: { model: "gpt-b" } });
    await vi.waitFor(() => expect(registry.identity("codex").resolved).toBe("gpt-b"), { timeout: 10_000 });
    expect(seen.map((m) => m.codex.resolved)).not.toContain("gpt-a");
    expect(clis.doctorCalls()).toHaveLength(2);
    registry.close();
  });
});
