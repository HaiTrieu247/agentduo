// T3 acceptance tests: inspect what a member is told, without invoking an agent or depending on identity text.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member, TeamGroup } from "../../src/team/config.js";
import {
  answerPrompt, areaPmPrompt, checkPrompt, integrationCheckPrompt, integrationTriagePrompt, planPrompt,
  pmActions, pmPrompt, resolvePrompt, reviewPrompt, testsPrompt, triagePrompt, workPrompt, type PmOccasion, type PromptParts,
} from "../../src/team/prompts.js";
import {
  decideException, planningUnit, recordIncident, resolveIncident, type WorkRef,
} from "../../src/team/rule-governance.js";
import { TeamRules, type RuleEntry } from "../../src/team/rules.js";
import { TeamStore, type Brief, type TeamState } from "../../src/team/state.js";
import { governanceState, outcomeValue, pendingException, requestedException } from "../helpers/governance-builders.js";
import { brief as makeBrief } from "../helpers/team-builders.js";
import { tempDir } from "../helpers/tmp.js";

const rule = (id: string, text: string): RuleEntry => ({ id, text, incident: "A resolved disagreement.", opId: `lesson-${id}`, at: "2026-11-14T10:00:00.000Z" });
const RULES = [rule("R1", "Use the supported runtime API."), rule("R2", "Verify units against the requirement.")];
const LATEST = rule("R3", "Compare each exported unit with its acceptance criterion.");
const IDENTITY = "IDENTITY_SENTINEL: write concise reports.";
const BRIEF: Brief = { ...makeBrief(), version: 1 };
const member = (name: string, kind: Member["kind"], group: string | null = null): Member => ({
  name, role: kind === "worker" ? "dev" : kind === "checker" ? "qa" : kind === "lead" ? "techlead" : "pm",
  kind, group, level: "senior", levelRank: 2, canReview: true, backend: "codex", model: null, effort: null, args: [],
});
const PM = member("pm", "pm");
const LEAD = member("techlead", "lead");
const DEV = member("dev-1", "worker");
const REVIEWER = member("dev-2", "worker");
const QA = member("qa-1", "checker");
const AREA_PM = member("pm-ui", "pm", "ui");
const AREA_LEAD = member("techlead-ui", "lead", "ui");
const GROUP: TeamGroup = { name: "ui", pm: AREA_PM, lead: AREA_LEAD, members: [AREA_PM, AREA_LEAD, member("dev-ui", "worker", "ui")] };
const MEMBERS = [PM, LEAD, DEV, REVIEWER, QA, ...GROUP.members];

// `rules` is call input, separate from the fresh-session identity. Older prompt implementations ignore it,
// producing an ordinary assertion failure rather than preventing this acceptance suite from loading.
type Input = PromptParts & { rules: readonly RuleEntry[] };
const parts = (state: TeamState, m: Member, identity: string | null, rules: readonly RuleEntry[]): Input => ({ state, member: m, members: MEMBERS, identity, rules });
type PromptCase = { name: string; pm?: boolean; work?: WorkRef; render: (p: Input) => string; member: Member };
const taskOf = (p: Input) => p.state.tasks[0]!;
const headPrompt = (p: Input, occasion: PmOccasion = { kind: "conversation" }) => pmPrompt({ ...p, occasion, seenMessages: 0, reports: [], openEscalations: [], groups: [GROUP], plans: [], areas: [] });
const groupPrompt = (p: Input) => areaPmPrompt({ ...p, occasion: { kind: "area_escalation" }, brief: BRIEF, group: GROUP, area: null, plan: null, openEscalations: [], head: PM });
const CASES: PromptCase[] = [
  { name: "head PM", pm: true, member: PM, render: headPrompt },
  { name: "group PM", pm: true, member: AREA_PM, render: groupPrompt },
  { name: "techlead planning", member: LEAD, work: { unit: planningUnit(null) }, render: (p) => planPrompt({ ...p, brief: BRIEF, feedback: null, previous: null, existing: [], additions: false, area: null, group: null }) },
  { name: "group techlead planning", member: AREA_LEAD, work: { unit: planningUnit("ui") }, render: (p) => planPrompt({ ...p, brief: BRIEF, feedback: null, previous: null, existing: [], additions: false, area: { briefVersion: 1, group: "ui", area: "UI", criteria: ["AC1"] }, group: GROUP }) },
  { name: "worker", member: DEV, work: { task: "T1" }, render: (p) => workPrompt({ ...p, task: taskOf(p), brief: BRIEF, others: [], cwd: join("repo", "worker") }) },
  { name: "test author", member: QA, work: { task: "T1" }, render: (p) => testsPrompt({ ...p, task: taskOf(p), brief: BRIEF, cwd: join("repo", "qa"), failures: [] }) },
  { name: "reviewer", member: REVIEWER, work: { task: "T1" }, render: (p) => reviewPrompt({ ...p, task: taskOf(p), brief: BRIEF, diff: "+result", blocking: ["critical", "high"] }) },
  { name: "task checker", member: QA, work: { task: "T1" }, render: (p) => checkPrompt({ ...p, task: taskOf(p), brief: BRIEF, cwd: join("repo", "qa") }) },
  { name: "task triage", member: LEAD, work: { task: "T1" }, render: (p) => triagePrompt({ ...p, task: taskOf(p), brief: BRIEF, maxAttempts: 3, workers: [DEV] }) },
  { name: "techlead answer", member: LEAD, work: { task: "T1" }, render: (p) => answerPrompt({ ...p, task: taskOf(p), brief: BRIEF }) },
  { name: "task conflict resolver", member: LEAD, work: { task: "T1" }, render: (p) => resolvePrompt({ ...p, task: taskOf(p), brief: BRIEF, cwd: join("repo", "integration"), files: ["app.ts"] }) },
  { name: "integration checker", member: QA, work: { unit: { kind: "integration", id: "run" } }, render: (p) => integrationCheckPrompt({ ...p, brief: BRIEF, cwd: join("repo", "integration") }) },
  { name: "integration triage", member: LEAD, work: { unit: { kind: "integration", id: "run" } }, render: (p) => integrationTriagePrompt({ ...p, brief: BRIEF, trouble: "A check failed.", checks: [] }) },
  { name: "apply conflict resolver", member: LEAD, work: { unit: { kind: "apply", id: "run" } }, render: (p) => resolvePrompt({ ...p, task: null, brief: BRIEF, cwd: join("repo", "integration"), files: ["app.ts"] }) },
];
const TASK_CASES = CASES.filter((c) => c.work?.task !== undefined);
const UNIT_CASES = CASES.filter((c) => c.work?.unit !== undefined);
const MEMBER_CASES = CASES.filter((c) => !c.pm);

function state(): TeamState {
  const s = governanceState();
  s.briefs = [BRIEF];
  s.approvedBrief = 1;
  s.tasks[0]!.question = { id: "Q1", from: DEV.name, text: "Which unit does the API return?", escalated: false, answer: null };
  s.integration = { commit: "integration-1", checks: [], triage: false, trouble: null, triageGroups: [] };
  s.verifiedTree = "verified-1";
  return s;
}

function approve(s: TeamState, work: WorkRef = { task: "T1" }) {
  const ex = pendingException(s, "exception-request-1", work);
  outcomeValue(decideException(s, { requestId: "exception-request-1", source: "user", approved: true }));
  return ex;
}

function expectRules(text: string, rules: readonly RuleEntry[] = RULES) {
  for (const r of rules) {
    expect(text).toContain(r.id);
    expect(text).toContain(r.text);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-14T10:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("AC2: current rules accompany every kind of call", () => {
  describe.each(CASES)("$name", (c) => {
    it.each([IDENTITY, null])("includes every current rule and its id with identity %j", (identity) => {
      const text = c.render(parts(state(), c.member, identity, RULES));
      expectRules(text);
      if (identity) expect(text).toContain(IDENTITY);
      else expect(text).not.toContain(IDENTITY);
      expect(text).not.toMatch(/\bundefined\b/);
    });

    it("provides a PM addition on the next continued call", () => {
      const s = state();
      const first = c.render(parts(s, c.member, IDENTITY, RULES));
      const continued = c.render(parts(s, c.member, null, [...RULES, LATEST]));
      expect(first).not.toContain(LATEST.text);
      expectRules(continued, [...RULES, LATEST]);
      expect(continued).not.toContain(IDENTITY);
    });
  });

  it("reads a durable PM addition again after reopening the run and the rules store", () => {
    const tmp = tempDir();
    try {
      const rulesDir = join(tmp.path, "rules");
      const rules = new TeamRules(rulesDir);
      rules.append({ opId: "lesson-1", incident: "A resolved unit mismatch.", text: "State the required units." });
      const s = state();
      const store = new TeamStore(join(tmp.path, "runs"), s.id);
      mkdirSync(store.dir, { recursive: true });
      store.save(s);
      const first = workPrompt({ ...parts(s, DEV, IDENTITY, rules.rules()), task: s.tasks[0]!, brief: BRIEF, others: [], cwd: tmp.path });
      rules.append({ opId: "lesson-2", incident: "A second disagreement was resolved.", text: "Check exported units before merging." });
      const loaded = TeamStore.open(join(tmp.path, "runs"), s.id).load();
      const content = new TeamRules(rulesDir).rules();
      const next = workPrompt({ ...parts(loaded, DEV, null, content), task: loaded.tasks[0]!, brief: BRIEF, others: [], cwd: tmp.path });
      expect(first).not.toContain("Check exported units before merging.");
      expectRules(next, content);
      expect(next).toContain("State the required units.");
      expect(next).toContain("Check exported units before merging.");
    } finally {
      tmp.cleanup();
    }
  });
});

describe("AC4–AC5: member requests go to the PM and hold dependent work", () => {
  it.each(MEMBER_CASES)("$name explains the structured request and stops before departing", (c) => {
    const text = c.render(parts(state(), c.member, null, RULES));
    expect(text).toContain("governance");
    expect(text).toMatch(/rule_ids|rule ids/i);
    expect(text).toMatch(/reason|why/i);
    expect(text).toMatch(/(?:exception[\s\S]{0,180}PM|PM[\s\S]{0,180}exception)/i);
    expect(text).toMatch(/(?:stop|hold|pause|wait)[\s\S]{0,220}(?:work|part|approval|decision)/i);
    expect(text).toMatch(/(?:do not|never|must not|cannot)[\s\S]{0,100}(?:ask|talk|question)[\s\S]{0,70}user/i);
  });
});

describe("AC5–AC7: only the approved exception for the current work is usable", () => {
  it.each(TASK_CASES)("$name receives an approved task exception, including its alternative and scope", (c) => {
    const s = state();
    const ex = approve(s);
    const text = c.render(parts(s, c.member, null, RULES));
    expect(text).toContain(ex.id);
    expect(text).toContain(ex.assessment!.alternative);
    expect(text).toContain("T1");
    expect(text).toMatch(/approved/i);
    expectRules(text);
  });

  it.each(TASK_CASES)("$name does not receive another task's permission", (c) => {
    const s = state();
    const ex = approve(s, { task: "T2" });
    const text = c.render(parts(s, c.member, null, RULES));
    expect(text).not.toContain(ex.assessment!.alternative);
    expectRules(text);
  });

  it.each(UNIT_CASES)("$name receives only the matching unit's approved alternative", (c) => {
    const s = state();
    if (c.work!.unit?.kind === "apply") {
      s.phase = "APPLY";
      s.applyConflict = { ours: "user-commit", tree: "verified-1", files: ["app.ts"], resolving: true };
    }
    const ex = approve(s, c.work!);
    const matching = c.render(parts(s, c.member, null, RULES));
    expect(matching).toContain(ex.assessment!.alternative);
    expect(matching).toContain(ex.requested.unit!.kind);
    // A new occurrence of the same named work needs a separate approval.
    s.integration!.commit = "integration-2";
    s.verifiedTree = "verified-2";
    if (c.work!.unit?.kind === "planning") s.plans.push({ version: 1, briefVersion: 1, group: c.member.group, summary: "Prior plan", tasks: [], risks: [] });
    expect(c.render(parts(s, c.member, null, RULES))).not.toContain(ex.assessment!.alternative);
  });

  it.each(UNIT_CASES)("$name does not inherit a task approval", (c) => {
    const s = state();
    const ex = approve(s);
    expect(c.render(parts(s, c.member, null, RULES))).not.toContain(ex.assessment!.alternative);
  });

  it("does not give an apply conflict resolver permission granted for integration checks", () => {
    const s = state();
    s.phase = "APPLY";
    s.applyConflict = { ours: "user-commit", tree: "verified-1", files: ["app.ts"], resolving: true };
    const ex = approve(s, { unit: { kind: "integration", id: "run" } });
    const text = CASES.find((c) => c.name === "apply conflict resolver")!.render(parts(s, LEAD, null, RULES));
    expect(text).not.toContain(ex.assessment!.alternative);
  });

  it.each(["requested", "pending", "rejected"] as const)("shows %s as a non-authorizing state", (status) => {
    const s = state();
    const ex = status === "requested" ? requestedException(s) : pendingException(s);
    if (status === "rejected") outcomeValue(decideException(s, { requestId: "exception-request-1", source: "user", approved: false }));
    const text = CASES.find((c) => c.name === "worker")!.render(parts(s, DEV, null, RULES));
    expect(text).toContain(ex.id);
    expect(text).toMatch(status === "rejected" ? /rejected|refused|denied/i : /requested|pending|not decided|waiting/i);
    expect(text).toMatch(/(?:not|no|never|only|must)[\s\S]{0,180}(?:permission|approval|approved|allow|depart)/i);
    expectRules(text);
  });

  it("does not reuse an approval from another run even when the task id is identical", () => {
    const s = state();
    const ex = approve(s);
    s.id = "another-run";
    const text = CASES.find((c) => c.name === "worker")!.render(parts(s, DEV, null, RULES));
    expect(text).not.toContain(ex.assessment!.alternative);
  });

  it.each(["pending", "approved", "rejected"] as const)("keeps %s authority and scope in the prompt after reopening", (status) => {
    const tmp = tempDir();
    try {
      const s = state();
      const ex = pendingException(s);
      if (status !== "pending") outcomeValue(decideException(s, { requestId: "exception-request-1", source: "user", approved: status === "approved" }));
      const store = new TeamStore(join(tmp.path, "runs"), s.id);
      mkdirSync(store.dir, { recursive: true });
      store.save(s);
      const loaded = TeamStore.open(join(tmp.path, "runs"), s.id).load();
      const text = workPrompt({ ...parts(loaded, DEV, null, RULES), task: loaded.tasks[0]!, brief: BRIEF, others: [], cwd: tmp.path });
      expectRules(text);
      expect(text).toContain(ex.id);
      if (status === "approved") expect(text).toContain(ex.assessment!.alternative);
      else expect(text).toMatch(status === "pending" ? /pending|not decided|waiting/i : /rejected|refused|denied/i);
      const otherTask = workPrompt({ ...parts(loaded, DEV, null, RULES), task: loaded.tasks[1]!, brief: BRIEF, others: [], cwd: tmp.path });
      expect(otherTask).not.toContain(ex.assessment!.alternative);
    } finally {
      tmp.cleanup();
    }
  });
});

describe("AC3, AC5, AC6: the PM owns lessons, assessment and unresolved direction", () => {
  it.each([
    ["rule_lesson", ["rule_lesson", "rule_question"]],
    ["rule_exception", ["exception_proposal", "exception_decline", "rule_question"]],
  ] as const)("supports the T2 actions for the %s PM occasion", (kind, actions) => {
    const s = state();
    // These occasions are introduced by T3; the assertion also runs against the pre-T3 union.
    const occasion = { kind } as unknown as PmOccasion;
    expect(pmActions(s, occasion)).toEqual(expect.arrayContaining([...actions]));
    for (const identity of [IDENTITY, null]) {
      const text = headPrompt(parts(s, PM, identity, RULES), occasion);
      expectRules(text);
      const allowed = text.match(/Allowed actions now: ([^.]+)\./)?.[1] ?? "";
      for (const action of actions) expect(allowed).toContain(action);
      expect(allowed).not.toMatch(/exception_(?:approve|grant)/);
    }
  });

  it("does not offer a group PM actions that approve an exception or question the user directly", () => {
    const s = state();
    const allowed = pmActions(s, { kind: "area_escalation" });
    expect(allowed).toContain("escalate");
    expect(allowed).not.toContain("exception_proposal");
    expect(allowed).not.toContain("rule_question");
    expect(allowed).not.toContain("questions");
  });

  it("tells the head PM to append a preventive lesson for a resolved incident without removing rules", () => {
    const s = state();
    const incident = outcomeValue(recordIncident(s, {
      kind: "deviation", source: { kind: "member_report", member: QA.name, task: "T1", occurrence: "qa-call#0" },
      reportedBy: QA.name, summary: "The exported unit violated the requirement.", ruleIds: ["R2"],
    }));
    outcomeValue(resolveIncident(s, incident.id, "Corrected the unit and verified the requirement."));
    const text = headPrompt(parts(s, PM, null, RULES), { kind: "rule_lesson" } as unknown as PmOccasion);
    expect(text).toContain(incident.id);
    expect(text).toContain(incident.summary);
    expect(text).toContain(incident.resolution!);
    expect(text).toContain("rule_lesson");
    expect(text).toMatch(/(?:append|add)[\s\S]{0,150}(?:prevent|recurr|repeat|lesson)|preventive rule/i);
    expect(text).toMatch(/(?:never|do not|must not)[\s\S]{0,90}(?:delet|remov|replac|rewrit)/i);
  });

  it("tells the head PM to present the rule, reason, alternative and scope for user approval", () => {
    const s = state();
    const ex = requestedException(s);
    const text = headPrompt(parts(s, PM, null, RULES), { kind: "rule_exception" } as unknown as PmOccasion);
    expect(text).toContain(ex.id);
    expect(text).toContain(ex.reason);
    expect(text).toContain("exception_proposal");
    expect(text).toMatch(/rule_ids|rules (?:involved|it names)/i);
    expect(text).toMatch(/alternative|what the team (?:does|would do) instead/i);
    expect(text).toMatch(/scope|task_ids|work it covers/i);
    expect(text).toMatch(/user[\s\S]{0,130}(?:approve|approval|decision)/i);
    expect(text).toMatch(/(?:wait|hold|stop|pause)[\s\S]{0,160}(?:work|answer|decision|approval)/i);
  });

  it("tells the head PM to ask for direction when it cannot choose an alternative, without granting an exception", () => {
    const s = state();
    requestedException(s);
    const text = headPrompt(parts(s, PM, null, RULES));
    expect(text).toContain("rule_question");
    expect(text).toMatch(/(?:cannot|can't|unclear|unsure)[\s\S]{0,180}(?:ask|question)[\s\S]{0,80}user/i);
    expect(text).toMatch(/(?:answer|direction|clarification)[\s\S]{0,160}(?:not|never)[\s\S]{0,80}(?:approv|grant|permission)/i);
  });

  it("shows the pending proposal to the PM and leaves its dependent work waiting", () => {
    const s = state();
    const ex = pendingException(s);
    const text = headPrompt(parts(s, PM, null, RULES));
    expect(text).toContain(ex.id);
    expect(text).toContain(ex.assessment!.summary);
    expect(text).toMatch(/pending|not answered|waiting|waits|not decided/i);
    expect(text).toMatch(/(?:unanswered|pending|not decided)[\s\S]{0,160}(?:nothing|no |not |wait)/i);
  });

  it("tells a group PM to send exception approval through the head PM", () => {
    const s = state();
    requestedException(s);
    const text = groupPrompt(parts(s, AREA_PM, null, RULES));
    expect(text).toContain("head PM");
    expect(text).toMatch(/(?:exception[\s\S]{0,220}(?:head PM|escalate)|(?:head PM|escalate)[\s\S]{0,220}exception)/i);
    expect(text).toMatch(/(?:never|do not)[\s\S]{0,80}(?:talk|ask)[\s\S]{0,70}user/i);
    expect(text).toMatch(/(?:cannot|must not|never|do not)[\s\S]{0,120}(?:approv|grant)/i);
  });
});
