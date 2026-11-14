// AC1/AC3 contract tests, adapted to the public TeamRules API after implementation.
// Assertions cover persistence, isolation and append semantics without assuming the private workspace-key algorithm.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { configFromLayers } from "../../src/config/config.js";
import { dataRoot } from "../../src/paths.js";
import { TEAM_DEFAULTS, teamId } from "../../src/team/config.js";
import { RulesError, TeamRules, teamRulesDir, type NewRule } from "../../src/team/rules.js";
import { userConfigEnv, userDataEnv } from "../helpers/config.js";
import { tempDir } from "../helpers/tmp.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const storeAt = (path: string) => new TeamRules(dirname(path));
const teamRulesPath = (workspace: string, id: string | undefined, env: NodeJS.ProcessEnv) =>
  new TeamRules(teamRulesDir(env, workspace, teamId({ id }))).path;
const initTeamRules = (path: string) => storeAt(path).init();
const readTeamRules = (path: string) => storeAt(path).read();
const appendTeamRule = (path: string, input: NewRule) => storeAt(path).append(input);

function fixture() {
  const tmp = tempDir();
  cleanups.push(tmp.cleanup);
  const workspace = join(tmp.path, "workspace");
  mkdirSync(workspace);
  const env = { ...userDataEnv(join(tmp.path, "data")), ...userConfigEnv(join(tmp.path, "config")) };
  return { base: tmp.path, workspace, env, path: teamRulesPath(workspace, undefined, env) };
}

const rule = (n: number) => ({
  opId: `run-a:incident-${n}:append`,
  incident: `run-a:incident-${n}`,
  text: `Prevent recurrence of incident ${n}: confirm the acceptance criteria before changing behavior.`,
});

describe("persistent team RULES.md (AC1, AC3)", () => {
  it("creates RULES.md under the data root, with one workspace key and the default team id", async () => {
    const f = fixture();
    const parts = relative(join(dataRoot(f.env)!, "team-rules"), f.path).split(sep);
    expect(parts).toHaveLength(3);
    expect(parts[0]).not.toBe("");
    expect(parts[0]).not.toBe("..");
    expect(parts.slice(1)).toEqual(["default", "RULES.md"]);
    expect(f.path).toBe(teamRulesPath(f.workspace, "default", f.env));
    await initTeamRules(f.path);
    expect(existsSync(f.path)).toBe(true);
    const before = readFileSync(f.path);
    await initTeamRules(f.path);
    expect(readFileSync(f.path)).toEqual(before);
    expect(await readTeamRules(f.path)).toBe(before.toString("utf8"));
    expect(existsSync(join(f.workspace, "RULES.md"))).toBe(false);
  });

  it.each(["", "\uFEFF---\r\nreplace: true\r\n---\r\n<!-- keep this note -->\r\n# Quy tắc\r\nGiữ nguyên nội dung.  \r\n\r\n", "An existing rule without a final newline"])(
    "never overwrites or normalizes an existing file on initialization or reading (%j)", async (original) => {
      const f = fixture();
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, original);
      await initTeamRules(f.path);
      expect(await readTeamRules(f.path)).toBe(original);
      expect(readFileSync(f.path)).toEqual(Buffer.from(original));
    },
  );

  it("keeps every old byte when appending, including front matter, comments and a missing final newline", async () => {
    const f = fixture();
    const original = "\uFEFF---\r\nreplace: true\r\n---\r\n<!-- source note -->\r\nQuy tắc cũ.  ";
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, original);
    const added = await appendTeamRule(f.path, rule(1));
    const first = readFileSync(f.path);
    expect(first.subarray(0, Buffer.byteLength(original))).toEqual(Buffer.from(original));
    expect(added.rule.id).toMatch(/^R\d+$/);
    expect(first.toString("utf8")).toContain(added.rule.id);
    expect(first.toString("utf8")).toContain(rule(1).incident);
    expect(first.toString("utf8")).toContain(rule(1).text);
    await appendTeamRule(f.path, rule(2));
    expect(readFileSync(f.path).subarray(0, first.length)).toEqual(first);
    expect(await readTeamRules(f.path)).toBe(readFileSync(f.path, "utf8"));
  });

  it("reopens the same rules in a later run, also after the previous run's files are removed", async () => {
    const f = fixture();
    const runs = join(f.base, "runs");
    mkdirSync(join(runs, "run-a"), { recursive: true });
    await initTeamRules(f.path);
    await appendTeamRule(f.path, rule(1));
    const saved = readFileSync(f.path, "utf8");
    rmSync(runs, { recursive: true });
    mkdirSync(join(runs, "run-b"), { recursive: true });
    const reopened = teamRulesPath(f.workspace, undefined, { ...f.env });
    await initTeamRules(reopened);
    expect(await readTeamRules(reopened)).toBe(saved);
  });

  it("isolates both teams in one workspace and same-named teams in different workspaces", async () => {
    const f = fixture();
    const other = join(f.base, "other", "workspace");
    mkdirSync(other, { recursive: true });
    const paths = [f.path, teamRulesPath(f.workspace, "billing", f.env), teamRulesPath(other, "default", f.env)];
    expect(new Set(paths).size).toBe(3);
    for (const [i, path] of paths.entries()) {
      await initTeamRules(path);
      await appendTeamRule(path, rule(i));
    }
    for (const [i, path] of paths.entries()) {
      const text = await readTeamRules(path);
      for (const j of [0, 1, 2]) expect(text.includes(rule(j).text)).toBe(i === j);
    }
  });

  it("uses the canonical workspace, including a directory alias, instead of creating another store", async () => {
    const f = fixture();
    const alias = join(f.base, "workspace-alias");
    symlinkSync(f.workspace, alias, process.platform === "win32" ? "junction" : "dir");
    const aliasPath = teamRulesPath(alias, "default", f.env);
    expect(aliasPath).toBe(f.path);
    expect(teamRulesPath(join(f.workspace, "..", "workspace"), undefined, f.env)).toBe(f.path);
    await initTeamRules(f.path);
    await appendTeamRule(f.path, rule(1));
    expect(await readTeamRules(aliasPath)).toContain(rule(1).text);
  });

  it("retains rules after model and member changes, without reading an identity file instead", async () => {
    const f = fixture();
    const before = configFromLayers([{ team: { id: "payments" } }]);
    const after = configFromLayers([{ team: {
      id: "payments",
      levels: { senior: { codex: { model: "another-model" } } },
      members: TEAM_DEFAULTS.members.map((m, i) => i === 2 ? { ...m, name: "replacement-dev", model: "haiku" } : m),
    } }]);
    const path = teamRulesPath(f.workspace, before.team.id, f.env);
    await initTeamRules(path);
    await appendTeamRule(path, rule(1));
    const identity = join(f.workspace, ".agentduo", "team", "roles", "pm", "IDENTITY.md");
    mkdirSync(dirname(identity), { recursive: true });
    writeFileSync(identity, "---\nreplace: true\n---\nIdentity text, not the team's learned rules.");
    const reopened = teamRulesPath(f.workspace, after.team.id, f.env);
    expect(reopened).toBe(path);
    expect(await readTeamRules(reopened)).toContain(rule(1).text);
    expect(await readTeamRules(reopened)).not.toContain("Identity text");
  });

  it("makes an identical retry a byte-for-byte no-op even after another operation was appended", async () => {
    const f = fixture();
    await initTeamRules(f.path);
    const first = await appendTeamRule(f.path, rule(1));
    await appendTeamRule(f.path, rule(2));
    const before = readFileSync(f.path);
    const retry = await appendTeamRule(teamRulesPath(f.workspace, "default", { ...f.env }), { ...rule(1) });
    expect(retry).toEqual({ added: false, rule: first.rule });
    expect(readFileSync(f.path)).toEqual(before);
  });

  it("scopes deduplication to one workspace and team, rather than suppressing another team's operation", () => {
    const f = fixture();
    const otherWorkspace = join(f.base, "second-workspace");
    mkdirSync(otherWorkspace);
    const paths = [f.path, teamRulesPath(f.workspace, "billing", f.env), teamRulesPath(otherWorkspace, "default", f.env)];
    for (const path of paths) {
      const store = storeAt(path);
      expect(store.append(rule(1)).added).toBe(true);
      expect(store.rules()).toHaveLength(1);
      expect(store.rules()[0]!.text).toBe(rule(1).text);
    }
  });

  it("leaves existing rules intact on rejection and lets a corrected operation be retried", () => {
    const f = fixture();
    const store = storeAt(f.path);
    store.append(rule(1));
    const before = readFileSync(f.path);
    expect(() => store.append({ ...rule(2), text: " " })).toThrow(RulesError);
    expect(readFileSync(f.path)).toEqual(before);
    expect(store.append(rule(2)).added).toBe(true);
    expect(store.rules().map((entry) => entry.opId)).toEqual([rule(1).opId, rule(2).opId]);
  });

  it("releases the lock after an error while appending, keeping the failed operation retryable", () => {
    const f = fixture();
    const store = storeAt(f.path);
    const original = store.append(rule(1));
    const before = readFileSync(f.path);
    const broken = new TeamRules(dirname(f.path), { clock: () => { throw new Error("clock unavailable"); } });
    expect(() => broken.append(rule(2))).toThrow("clock unavailable");
    expect(readFileSync(f.path)).toEqual(before);
    const reopened = new TeamRules(dirname(f.path), { lockWaitMs: 0 });
    expect(reopened.append(rule(2)).added).toBe(true);
    expect(reopened.rules()[0]).toEqual(original.rule);
    expect(reopened.rules()).toHaveLength(2);
  });
});

// Real processes have independent module state. An IPC barrier releases them only once they all loaded the API,
// so these cases cover filesystem locking and persistent deduplication rather than just one process's mutex/cache.
const RULES_SOURCE = fileURLToPath(new URL("../../src/team/rules.ts", import.meta.url)).replace(/\\/g, "/");
let childScript: string;
let childCleanup: (() => void) | undefined;

beforeAll(async () => {
  const tmp = tempDir();
  childCleanup = tmp.cleanup;
  const entry = join(tmp.path, "rules-child.ts");
  writeFileSync(entry, `
    import { dirname } from "node:path";
    import { TeamRules } from ${JSON.stringify(RULES_SOURCE)};
    const [path, ruleJson] = process.argv.slice(2);
    process.once("message", async () => {
      try {
        const store = new TeamRules(dirname(path));
        store.init();
        store.append(JSON.parse(ruleJson));
      } catch (e) {
        console.error(e);
        process.exitCode = 1;
      } finally { process.disconnect(); }
    });
    process.send("ready");
  `);
  const outDir = join(tmp.path, "out");
  await build({ entry: { "rules-child": entry }, outDir, format: ["esm"], platform: "node", target: "node22", bundle: true, silent: true, config: false });
  childScript = join(outDir, readdirSync(outDir).find((name) => /^rules-child\.(m?js)$/.test(name))!);
}, 60_000);
afterAll(() => childCleanup?.());

async function writeInProcesses(path: string, entries: ReturnType<typeof rule>[]) {
  const children: ChildProcess[] = [];
  const ready: Promise<void>[] = [];
  const done: Promise<void>[] = [];
  try {
    for (const entry of entries) {
      const child = spawn(process.execPath, [childScript, path, JSON.stringify(entry)], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
      children.push(child);
      let stderr = "";
      child.stderr!.on("data", (chunk) => { stderr += chunk; });
      const finished = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error(`rules writer timed out: ${stderr}`));
        }, 15_000);
        child.once("error", reject);
        child.once("close", (code) => {
          clearTimeout(timeout);
          code === 0 ? resolve() : reject(new Error(`rules writer exited ${code}: ${stderr}`));
        });
      });
      // Register handlers immediately: an early child failure is reported while the barrier is waiting too.
      done.push(finished);
      ready.push(new Promise<void>((resolve, reject) => {
        child.once("message", (message) => message === "ready" ? resolve() : reject(new Error(`unexpected child message: ${message}`)));
        finished.then(() => reject(new Error("rules writer exited before release")), reject);
      }));
    }
    await Promise.all(ready);
    for (const child of children) child.send("go");
    await Promise.all(done);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.allSettled(done);
  }
}

describe("rules writes across processes (AC3)", () => {
  it("preserves every concurrent distinct append, including initialization races", async () => {
    const f = fixture();
    const entries = Array.from({ length: 6 }, (_, i) => ({ ...rule(i), text: `${rule(i).text}\n${String(i).repeat(2_048)}` }));
    await writeInProcesses(f.path, entries);
    const text = await readTeamRules(f.path);
    for (const entry of entries) {
      expect(text.split(entry.text)).toHaveLength(2);
      expect(text).toContain(entry.incident);
    }
    const stored = storeAt(f.path).rules();
    expect(stored).toHaveLength(entries.length);
    expect(new Set(stored.map((entry) => entry.id)).size).toBe(entries.length);
    expect(stored.map((entry) => entry.opId).sort()).toEqual(entries.map((entry) => entry.opId).sort());
  });

  it("deduplicates simultaneous retries and a retry from a new process after reopening", async () => {
    const f = fixture();
    await writeInProcesses(f.path, Array.from({ length: 6 }, () => rule(1)));
    const saved = readFileSync(f.path);
    expect(saved.toString("utf8").split(rule(1).text)).toHaveLength(2);
    await writeInProcesses(f.path, [rule(1)]);
    expect(readFileSync(f.path)).toEqual(saved);
  });
});
