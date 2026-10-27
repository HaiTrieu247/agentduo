import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, defaultConfig, loadConfig, permissionFor, userConfigPath } from "../src/core/config.js";
import { tempDir } from "./helpers/tmp.js";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (dirs.length) dirs.pop()!.cleanup();
});

function setup(repoYaml?: string, userYaml?: string) {
  const t = tempDir();
  dirs.push(t);
  const repo = join(t.path, "repo");
  const xdg = join(t.path, "xdg");
  mkdirSync(join(repo, ".agentduo"), { recursive: true });
  if (repoYaml !== undefined) writeFileSync(join(repo, ".agentduo", "config.yaml"), repoYaml);
  if (userYaml !== undefined) {
    mkdirSync(join(xdg, "agentduo"), { recursive: true });
    writeFileSync(join(xdg, "agentduo", "config.yaml"), userYaml);
  }
  return { repo, env: { XDG_CONFIG_HOME: xdg, HOME: t.path } as NodeJS.ProcessEnv };
}

const GATES = "gates:\n  - name: t\n    command: npm test\n";

describe("loadConfig", () => {
  it("layers defaults, user config and repo config", () => {
    const { repo, env } = setup(`${GATES}codex:\n  model: gpt-repo\n`, "codex:\n  model: gpt-user\nclaude:\n  model: opus\n");
    const { data, sources, warnings } = loadConfig({ repo, env });
    expect(data.codex.model).toBe("gpt-repo");
    expect(data.claude.model).toBe("opus");
    expect(data.limits.max_planning_rounds).toBe(4);
    expect(data.safety.protected_paths).toContain(".agentduo/**");
    expect(data.paths.runs_dir).toBe(".agentduo/runs");
    expect(sources).toHaveLength(2);
    expect(warnings).toEqual([]);
  });

  it("warns about unknown keys and names the file", () => {
    const { repo, env } = setup(`${GATES}limits:\n  max_planing_rounds: 3\n`);
    const { warnings } = loadConfig({ repo, env });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("config.yaml: unknown config key 'limits.max_planing_rounds' (ignored)");
  });

  it("keeps defaults when a section is present but empty", () => {
    const { repo, env } = setup(`${GATES}codex:\nclaude:\n`);
    const { data } = loadConfig({ repo, env });
    expect(data.codex.bin).toBe("codex");
    expect(data.claude.read_only_tools).toEqual(["Read", "Grep", "Glob"]);
  });

  it("rejects wrong types with a clear message", () => {
    const cases: Array<[string, string]> = [
      ["gates: npm test\n", "gates must be a list"],
      [`limits: 5\n${GATES}`, "'limits' must be a mapping"],
      ["- a\n- b\n", "top level must be a mapping"],
      ["a: [1\n", "config.yaml"],
      [`${GATES}safety:\n  protected_paths: .env\n`, "safety.protected_paths must be a list"],
    ];
    for (const [yaml, expected] of cases) {
      const { repo, env } = setup(yaml);
      expect(() => loadConfig({ repo, env }), yaml).toThrow(ConfigError);
      expect(() => loadConfig({ repo, env }), yaml).toThrow(expected);
    }
  });

  it("rejects unsafe settings", () => {
    const cases: Array<[string, string]> = [
      [`${GATES}agents:\n  implementer: codex\n`, "only agent allowed"],
      [`${GATES}permissions:\n  codex: workspace-write\n`, "must run read-only"],
      ["gates: []\n", "no required gate"],
      [`${GATES}limits:\n  max_review_rounds: 0\n`, "limits.max_review_rounds must be a positive integer"],
      [`${GATES}quality_gates:\n  blocking_severities: [urgent]\n`, "unknown severity 'urgent'"],
    ];
    for (const [yaml, expected] of cases) {
      const { repo, env } = setup(yaml);
      expect(() => loadConfig({ repo, env }), yaml).toThrow(expected);
    }
  });

  it("errors when --config points to a missing file", () => {
    const { repo, env } = setup();
    expect(() => loadConfig({ repo, env, configPath: join(repo, "missing.yaml") })).toThrow("config file not found");
  });

  it("can skip validation for read-only commands", () => {
    const { repo, env } = setup();
    expect(loadConfig({ repo, env, validate: false }).data.gates).toEqual([]);
    expect(() => loadConfig({ repo, env })).toThrow("no required gate");
  });
});

describe("permissions and paths", () => {
  it("maps roles to permissions", () => {
    const cfg = defaultConfig();
    expect(permissionFor(cfg, "planner")).toBe("read-only");
    expect(permissionFor(cfg, "plan_reviewer")).toBe("read-only");
    expect(permissionFor(cfg, "code_reviewer")).toBe("read-only");
    expect(permissionFor(cfg, "implementer")).toBe("workspace-write");
  });

  it("finds the user config file per platform", () => {
    expect(userConfigPath({ XDG_CONFIG_HOME: "/x" }, "linux")).toBe(join("/x", "agentduo", "config.yaml"));
    expect(userConfigPath({ HOME: "/h" }, "darwin")).toBe(join("/h", ".config", "agentduo", "config.yaml"));
    expect(userConfigPath({ APPDATA: "C:\\AppData" }, "win32")).toContain("agentduo");
  });
});
