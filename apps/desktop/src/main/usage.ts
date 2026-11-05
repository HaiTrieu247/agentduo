// Both agents' accounts and limits with no project open: the user config's CLIs, asked from the home folder, as
// /usage asks them (no model call).
import { homedir } from "node:os";
import { readConfiguration } from "@agentduo/engine/config/configuration";
import { configFromLayers, defaultConfig, type ConfigData } from "@agentduo/engine/config/config";
import { readClaudeUsage, readCodexUsage } from "@agentduo/engine/system/usage";
import type { AccountUsage } from "@agentduo/host/protocol";

/** The user config's CLI settings over the defaults; the defaults when it cannot be read. */
function userConfig(env: NodeJS.ProcessEnv): ConfigData {
  try {
    const view = readConfiguration({ workspace: null, env });
    const layer: Record<string, Record<string, unknown>> = {};
    for (const e of view.entries) {
      const [section, ...rest] = e.key.split(".");
      if ((section === "claude" || section === "codex") && rest.length === 1) (layer[section] ??= {})[rest[0]!] = e.effective;
    }
    return configFromLayers([layer]);
  } catch {
    return defaultConfig();
  }
}

export async function readAccountUsage(env: NodeJS.ProcessEnv): Promise<AccountUsage> {
  const o = { cfg: userConfig(env), workspace: homedir(), env };
  const [claude, codex] = await Promise.all([readClaudeUsage(o), readCodexUsage(o)]);
  return { claude, codex } as AccountUsage;
}
