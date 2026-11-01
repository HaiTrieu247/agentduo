import { defaultConfig, type ConfigData, type GateConfig } from "../../src/core/config.js";
import type { FakeClis } from "./fake-clis.js";

export type ConfigOverrides = {
  [K in keyof ConfigData]?: ConfigData[K] extends unknown[] ? ConfigData[K] : Partial<ConfigData[K]>;
};

/**
 * The user config folder `dir` for a test's environment: where Linux and macOS look (XDG_CONFIG_HOME) and where
 * Windows does (APPDATA), so no test reads or writes the real user config.
 */
export const userConfigEnv = (dir: string): NodeJS.ProcessEnv => ({ XDG_CONFIG_HOME: dir, APPDATA: dir });

/**
 * agentduo's data root (where the snapshot repositories of folders with no git repository go) in `dir`, on every OS:
 * XDG_DATA_HOME on Linux and macOS, LOCALAPPDATA on Windows, so no test writes the real one.
 */
export const userDataEnv = (dir: string): NodeJS.ProcessEnv => ({ XDG_DATA_HOME: dir, LOCALAPPDATA: dir });

export const CHECK_GATE: GateConfig = { name: "check", command: `"${process.execPath}" check.mjs`, required: true };

/** Defaults pointed at the fake CLIs, with the check.mjs gate and short timeouts. */
export function testConfig(fake: FakeClis, overrides: ConfigOverrides = {}): ConfigData {
  const cfg = defaultConfig();
  cfg.codex.bin = fake.path("codex");
  cfg.claude.bin = fake.path("claude");
  cfg.limits.agent_timeout_sec = 60;
  cfg.limits.gate_timeout_sec = 60;
  cfg.gates = [CHECK_GATE];
  const target = cfg as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (Array.isArray(value)) target[key] = value;
    else Object.assign(target[key] as object, value);
  }
  return cfg;
}
