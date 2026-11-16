// What a member's session that goes on is given (packages/engine/src/team/prompts.ts `render`): the parts it does not
// hold yet, a list's new items, the work to act on and the rules every time; the whole prompt for a fresh session.
import { describe, expect, it } from "vitest";
import { newTask } from "../../src/team/board.js";
import { TEAM_DEFAULTS, teamGroups, teamMembers, type Member } from "../../src/team/config.js";
import { authored, pmPrompt, reviewPrompt, triagePrompt, workPrompt, type PromptParts, type SessionView } from "../../src/team/prompts.js";
import type { RuleEntry } from "../../src/team/rules.js";
import { newTeamState, type Brief, type TeamPlan, type TeamState } from "../../src/team/state.js";
import { brief as briefOutput, task as planTask } from "../helpers/team-builders.js";

const RULES: RuleEntry[] = [{ id: "R1", opId: "op1", text: "State the units in every task description.", incident: "an incident", at: "2026-11-14T00:00:00.000Z" }];
const members = teamMembers(TEAM_DEFAULTS);
const named = (name: string): Member => members.find((m) => m.name === name)!;
const brief: Brief = { version: 1, ...briefOutput() };
const plan: TeamPlan = { version: 1, group: null, briefVersion: 1, summary: "Two tasks.", tasks: [planTask("T1"), planTask("T2")], risks: [] };

const state = (): TeamState => {
  const s = newTeamState("run-1", "Add subtraction");
  s.briefs = [brief];
  s.approvedBrief = 1;
  s.phase = "EXECUTION";
  s.plans = [plan];
  s.tasks = ["T1", "T2"].map((id) => newTask(planTask(id)));
  return s;
};

/** A fresh prompt's text and the view it leaves, and the prompt a session that goes on with that view gets. */
function turns(member: Member, build: (p: PromptParts) => string, s: TeamState, change?: (s: TeamState) => void) {
  const view: SessionView = {};
  const fresh = build({ member, members, state: s, rules: RULES, identity: "IDENTITY", view });
  change?.(s);
  const continued = build({ member, members, state: s, rules: RULES, identity: null, since: view });
  return { fresh, continued };
}

const work = (s: TeamState) => (p: PromptParts) => workPrompt({ ...p, task: s.tasks[0]!, brief, others: s.tasks, cwd: "/w" });

describe("a session that goes on", () => {
  it("is not given again what did not change: the introduction, the identity, the team, the brief, the task", () => {
    const s = state();
    const { fresh, continued } = turns(named("dev-1"), work(s), s);
    for (const part of ["You are dev-1", "IDENTITY", "## The team\n", "## The brief (v1)", "## Task T1"]) {
      expect(fresh, part).toContain(part);
      expect(continued, part).not.toContain(part);
    }
    expect(continued).toMatch(/^\[orchestrator-role: team_work\]\n\[agentduo-member: dev-1\]\nThis message continues your session/);
  });

  it("is given the rules, the governance guidance, the work to act on and what to do now every time", () => {
    const s = state();
    const { continued } = turns(named("dev-1"), work(s), s, (x) => {
      x.tasks[0]!.review = { reviewer: "techlead", verdict: "changes", summary: "Fix it.", findings: [] };
    });
    expect(continued).toContain("- R1: State the units in every task description.");
    expect(continued).toContain("governance.exception");
    expect(continued).toContain("## techlead's review asks for changes\nFix it.");
    expect(continued).toContain("## What to do now");
    expect(continued).toContain("## Your output");
  });

  it("is given a part again, whole, once it changed", () => {
    const s = state();
    const { continued } = turns(named("dev-1"), work(s), s, (x) => {
      x.tasks[0]!.description = "Do T1, in integers.";
    });
    expect(continued).toContain("## Task T1: Task T1\nDo T1, in integers.");
    expect(continued).not.toContain("## The brief (v1)");
  });

  it("is given a list's new items only: a triage the history since its last turn", () => {
    const s = state();
    s.tasks[0]!.history = [{ at: "a", text: "dev-1 started it" }, { at: "b", text: "qa-1: fail" }];
    const lead = named("techlead");
    const triage = (p: PromptParts) => triagePrompt({ ...p, task: s.tasks[0]!, brief, maxAttempts: 3, workers: [named("dev-1")] });
    const { fresh, continued } = turns(lead, triage, s, (x) => x.tasks[0]!.history.push({ at: "c", text: "qa-1: fail again" }));
    expect(fresh).toContain("## The task's history\n- dev-1 started it\n- qa-1: fail");
    expect(continued).toContain("## The task's history since your last turn\n- qa-1: fail again");
    expect(continued).not.toContain("dev-1 started it");
  });

  it("gives the PM the board's changes and where it stands, and no conversation when nothing was said", () => {
    const s = state();
    s.pmSeen = 1;
    const pm = named("pm");
    const build = (p: PromptParts) => pmPrompt({
      ...p, occasion: { kind: "reports" }, seenMessages: p.identity ? 0 : s.pmSeen, reports: [], openEscalations: [], groups: teamGroups(members), plans: [plan], areas: [],
    });
    const { fresh, continued } = turns(pm, build, s, (x) => {
      x.tasks[1]!.status = "merged";
    });
    expect(fresh).toContain("## The board\n- T1 [pending]");
    expect(fresh).toContain("## The conversation with the user\nUser: Add subtraction");
    expect(continued).toContain("## The board: what changed since your last turn (2 tasks: 1 pending, 1 merged)\n- T2 [merged]");
    expect(continued).not.toContain("- T1 [pending]");
    expect(continued).not.toContain("## Plan v1");
    expect(continued).not.toContain("conversation with the user");
  });

  it("does not send a member back what it wrote itself: the PM's brief", () => {
    const s = state();
    const pm = named("pm");
    const build = (p: PromptParts) => pmPrompt({
      ...p, occasion: { kind: "conversation" }, seenMessages: p.identity ? 0 : 1, reports: [], openEscalations: [], groups: teamGroups(members), plans: [], areas: [],
    });
    const v2: Brief = { ...brief, version: 2, goal: "Subtract, and multiply." };
    // The PM wrote brief v2 in its last turn (`TeamRun.knows`): its next prompt does not carry it back.
    s.briefs.push(v2);
    const since: SessionView = { team: "an older roster", ...authored.brief(v2) };
    const continued = build({ member: pm, members, state: s, rules: RULES, identity: null, since });
    expect(continued).not.toContain("Subtract, and multiply.");
    expect(continued).toContain("## The team\n"); // what it was not given is given
  });

  it("is given the review's change since the commit it reviewed, or the whole diff when that cannot be diffed", () => {
    const s = state();
    const t = s.tasks[0]!;
    t.code = "c2";
    t.base = "b0";
    const dev = named("dev-1");
    const review = (previous: { from: string; diff: string } | null) => (p: PromptParts) => reviewPrompt({
      ...p, task: t, brief, diff: "+whole", blocking: ["high"], change: { head: "c2", base: "b0", stat: " app.txt | 1 +", previous },
    });
    const since: SessionView = { change: "c1" };
    const base = { member: dev, members, state: s, rules: RULES, identity: null };
    const later = review({ from: "c1", diff: "+later" })({ ...base, since });
    expect(later).toContain("## The change since the commit you last reviewed (`c1` → `c2`)");
    expect(later).toContain("+later");
    expect(later).not.toContain("+whole");
    expect(later).toContain(" app.txt | 1 +");
    expect(review(null)({ ...base, since })).toContain("## The change\n```diff\n+whole");
    expect(review(null)({ ...base, since: { change: "c2" } })).toContain("The same commit (`c2`) is the one you reviewed last");
    const view: SessionView = {};
    review(null)({ ...base, identity: "IDENTITY", view });
    expect(view.change).toBe("c2");
  });

  it("without a record of what it holds (a session of an older run), is given every part but the identity, as before", () => {
    const s = state();
    const text = work(s)({ member: named("dev-1"), members, state: s, rules: RULES, identity: null });
    expect(text).not.toContain("IDENTITY");
    expect(text).not.toContain("This message continues your session");
    for (const part of ["You are dev-1", "## The team\n", "## The brief (v1)", "## Task T1"]) expect(text, part).toContain(part);
  });
});
