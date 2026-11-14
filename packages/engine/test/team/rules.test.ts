import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRules, RULES_HEADER, RulesError, teamRulesDir, TeamRules, workspaceKey } from "../../src/team/rules.js";
import { userDataEnv } from "../helpers/config.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rules-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const env = () => userDataEnv(join(tmp, "data"));
const ws = (name: string) => {
  const d = join(tmp, name);
  mkdirSync(d, { recursive: true });
  return d;
};
const store = (workspace: string, id = "default") => new TeamRules(teamRulesDir(env(), workspace, id), { clock: () => new Date("2026-11-14T10:00:00Z") });
const rule = (n: number) => ({ opId: `op-${n}`, text: `Rule number ${n}\nsecond line`, incident: `disagreement ${n}` });

describe("team rules store", () => {
  it("places RULES.md under the data root by workspace and team id, outside every run", () => {
    const dir = teamRulesDir(env(), ws("proj"), "alpha");
    expect(dir.startsWith(join(tmp, "data", "agentduo", "team-rules", workspaceKey(ws("proj"))))).toBe(true);
    expect(dir.endsWith(join("", "alpha"))).toBe(true);
    expect(new TeamRules(dir).path).toBe(join(dir, "RULES.md"));
  });

  it("refuses a team id that is not a name", () => {
    expect(() => teamRulesDir(env(), ws("proj"), "../x")).toThrow(RulesError);
  });

  it("initializes a missing file once and never overwrites an existing one", () => {
    const s = store(ws("proj"));
    expect(s.init()).toBe(true);
    expect(readFileSync(s.path, "utf8")).toBe(RULES_HEADER);
    writeFileSync(s.path, "my own rules\n");
    expect(s.init()).toBe(false);
    expect(s.read()).toBe("my own rules\n");
  });

  it("reading creates the file for a team that has none", () => {
    expect(store(ws("proj")).read()).toBe(RULES_HEADER);
  });

  it("appends rules with stable ids and the incident, keeping earlier content byte for byte", () => {
    const s = store(ws("proj"));
    s.init();
    writeFileSync(s.path, "# Mine\nno trailing newline");
    const before = readFileSync(s.path, "utf8");
    const a = s.append(rule(1));
    const afterOne = readFileSync(s.path, "utf8");
    expect(afterOne.startsWith(before)).toBe(true);
    const b = s.append(rule(2));
    expect(readFileSync(s.path, "utf8").startsWith(afterOne)).toBe(true);
    expect([a.rule.id, b.rule.id]).toEqual(["R1", "R2"]);
    expect(s.rules()).toEqual([
      { id: "R1", opId: "op-1", text: "Rule number 1\nsecond line", incident: "disagreement 1", at: "2026-11-14T10:00:00.000Z" },
      { id: "R2", opId: "op-2", text: "Rule number 2\nsecond line", incident: "disagreement 2", at: "2026-11-14T10:00:00.000Z" },
    ]);
  });

  it("a retry with the same operation id adds nothing, also from another store instance (a resumed run)", () => {
    const w = ws("proj");
    const first = store(w).append(rule(1));
    const text = readFileSync(store(w).path, "utf8");
    const again = store(w).append({ ...rule(1), text: "other words" });
    expect(again).toEqual({ rule: first.rule, added: false });
    expect(first.added).toBe(true);
    expect(readFileSync(store(w).path, "utf8")).toBe(text);
  });

  it("two stores on one folder lose no addition and give no id twice", () => {
    const w = ws("proj");
    const a = store(w);
    const b = store(w);
    for (let i = 0; i < 10; i++) (i % 2 ? a : b).append(rule(i));
    expect(a.rules().map((r) => r.id)).toEqual(Array.from({ length: 10 }, (_, i) => `R${i + 1}`));
    expect(new Set(a.rules().map((r) => r.opId)).size).toBe(10);
  });

  it("numbers after the highest id in the file, even when the file was edited", () => {
    const s = store(ws("proj"));
    s.append(rule(1));
    writeFileSync(s.path, readFileSync(s.path, "utf8") + "\nsome note by the user\n");
    expect(s.append(rule(2)).rule.id).toBe("R2");
    expect(s.read()).toContain("some note by the user");
  });

  it("keeps teams and workspaces apart", () => {
    const w1 = ws("one");
    const w2 = ws("two");
    store(w1, "alpha").append(rule(1));
    expect(store(w1, "beta").rules()).toEqual([]);
    expect(store(w2, "alpha").rules()).toEqual([]);
    expect(store(w1, "alpha").rules()).toHaveLength(1);
    expect(workspaceKey(w1)).not.toBe(workspaceKey(w2));
  });

  it("two workspaces with one folder name do not share (the key hashes the whole path)", () => {
    const a = join(ws("x"), "app");
    const b = join(ws("y"), "app");
    mkdirSync(a);
    mkdirSync(b);
    expect(workspaceKey(a)).not.toBe(workspaceKey(b));
  });

  it("rejects an empty rule, a bad operation id, and text that holds agentduo's marker", () => {
    const s = store(ws("proj"));
    expect(() => s.append({ ...rule(1), text: "  " })).toThrow(RulesError);
    expect(() => s.append({ ...rule(1), incident: "" })).toThrow(RulesError);
    expect(() => s.append({ ...rule(1), opId: "has space" })).toThrow(RulesError);
    expect(() => s.append({ ...rule(1), text: "x\n<!-- agentduo-rule id=R9 op=z at=t -->" })).toThrow(RulesError);
    expect(s.rules()).toEqual([]);
  });

  it("takes over a lock left by a dead process, and fails clearly when a live one holds it", () => {
    const s = new TeamRules(teamRulesDir(env(), ws("proj"), "default"), { lockWaitMs: 100 });
    s.init();
    writeFileSync(join(s.dir, ".lock"), "999999999");
    expect(s.append(rule(1)).added).toBe(true);
    writeFileSync(join(s.dir, ".lock"), String(process.ppid));
    expect(() => s.append(rule(2))).toThrow(RulesError);
    expect(s.rules()).toHaveLength(1);
  });

  it("parseRules ignores text outside rules", () => {
    expect(parseRules(RULES_HEADER + "\nfree text\n")).toEqual([]);
  });
});
