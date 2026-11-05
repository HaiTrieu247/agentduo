import { createHash } from "node:crypto";
import { answeredEntries, type ClarificationEntry } from "../clarification/clarification.js";
import type { ConfigData } from "../config/config.js";
import { touched, workspacePath } from "../workflow/context.js";
import type { Change } from "../git/git.js";
import { claudeSettingsSignature, codexLocalSignature } from "../config/models.js";
import { trackReview } from "./findings.js";
import type { Finding, Issue, Plan } from "../workflow/outputs.js";
import type { Blocker, PlanCycle, ProgressMark, ReviewCycle, Stall, TrackedFinding } from "../workflow/state.js";

/**
 * The run's circuit breaker for a blocked implementer. A blocker (an implementation report with status "blocked")
 * needs something from you: running the implementer again with what it already had would be the same call, at the same
 * cost, with the same answer. So a `resume` runs it again only when something it is given changed since it reported
 * the blocker: the workspace's files, your notes (a note with the decision is one), the plan, the open findings, or its
 * settings. Otherwise the run stays waiting (`no_progress`), and no agent is called. A failed call (`agent_error`) is
 * not a blocker: `resume` retries it as before. See docs/superpowers/specs/2026-11-03-agentduo-no-progress-design.md.
 */

/** Each part of a mark as the messages name it, in the order they list them. */
export const MARK_PARTS: Record<keyof ProgressMark, string> = {
  tree: "the workspace's files",
  notes: "your notes",
  plan: "the final plan",
  findings: "the open review findings",
  settings: "the implementer's settings (agentduo's and its CLI's)",
  answers: "your answers to the agents' questions",
};

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A blocker's identity: its reason with case, punctuation and spacing left out. */
export function blockerKey(reason: string): string {
  return reason.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export const findingsDigest = (findings: Finding[]): string => digest(findings);

/**
 * What the user answered to the agents' questions, as a digest: each answered request once, by id, so a duplicate
 * answer, an unanswered or dismissed question never changes it. "" when nothing was answered, which is also what a mark
 * of a run from before questions holds (it has none).
 */
export function answersDigest(entries: readonly ClarificationEntry[] | undefined): string {
  const answered = answeredEntries(entries);
  return answered.length ? digest(answered.map((e) => [e.id, e.answers])) : "";
}

/**
 * The implementer's settings as far as a blocker can depend on them: which CLI plays it and what agentduo passes it
 * (the config's cost cap aside), and that CLI's own settings files, which snapshots leave out (a permission rule Claude
 * saved to .claude/settings.local.json, ~/.claude/settings.json, ~/.codex/config.toml…).
 */
export function implementerSettings(cfg: ConfigData, workspace: string, env: NodeJS.ProcessEnv): string {
  const backend = cfg.agents.implementer;
  const step = ownStep(cfg[backend]);
  if (backend === "claude") {
    const { bin, model, permission_prompts, args, role_args } = cfg.claude;
    const own = role_args.implementer ?? [];
    // Whether it may ask questions changes its run; the default (on) adds nothing, so a mark taken before the setting existed holds.
    const questions = cfg.clarification?.enabled === false ? [{ clarification: false }] : [];
    return digest([backend, bin, model, permission_prompts, args, own, claudeSettingsSignature({ args: [...args, ...own], workspace, env }), ...step, ...questions]);
  }
  const { bin, model, args, role_args } = cfg.codex;
  return digest([backend, bin, model, args, role_args.implementer ?? [], codexLocalSignature(workspace, env), ...step]);
}

/** The implementer's own model and effort on its CLI; nothing when it has neither, so a mark taken before they existed holds. */
function ownStep(cli: ConfigData["claude"] | ConfigData["codex"]): unknown[] {
  const model = cli.role_models?.implementer ?? null;
  const effort = cli.role_efforts?.implementer ?? null;
  return model || effort ? [{ model, effort }] : [];
}

/** The parts of what the implementer is given that differ between two marks, in MARK_PARTS order. */
export function changedParts(before: ProgressMark, now: ProgressMark): Array<keyof ProgressMark> {
  // A mark from before the answers existed has none, as a run that was answered nothing.
  const value = (m: ProgressMark, k: keyof ProgressMark) => (k === "answers" ? m.answers ?? "" : m[k]);
  return (Object.keys(MARK_PARTS) as Array<keyof ProgressMark>).filter((k) => value(before, k) !== value(now, k));
}

/**
 * The blocker after an attempt of round `round` reported `reason`, with `mark` what that attempt was given: one more in
 * a row when it is the blocker before and the attempt changed no file (no progress at all), else a first one.
 */
export function nextBlocker(previous: Blocker | null | undefined, reason: string, round: number, mark: ProgressMark, changedFiles: boolean): Blocker {
  const key = blockerKey(reason);
  const again = !!previous && previous.key === key && previous.round === round && !changedFiles;
  return { reason, key, round, repeats: again ? previous.repeats + 1 : 1, mark };
}

const said = (reason: string) => reason.trim().replace(/[\s.;:,]+$/, "");
const OTHERS = "'revise' re-plans with your note; 'abort' ends the run.";

/** Why the run stops on a blocker, and what unblocks it. */
export function blockedReview(b: Blocker): { message: string; details: string[] } {
  return {
    message: `the implementer is blocked: ${said(b.reason)}. It needs something from you: 'resume' with a --note that gives it what it asks ` +
      `for, or after you change the files it needs, re-runs round ${b.round}; 'resume' with nothing new does not run it again. ${OTHERS}`,
    details: b.repeats > 1
      ? [`the same blocker ${b.repeats} times in a row, the last attempt changing no file: what it was given since did not unblock it (consider 'revise' or 'abort')`]
      : [],
  };
}

/** Why a `resume` did not run the implementer: nothing it is given changed since its blocker. */
export function heldReview(b: Blocker): { message: string; details: string[] } {
  return {
    message: `nothing the implementer is given changed since it reported its blocker, so it was not run again (that would repeat the same call): ` +
      `${said(b.reason)}. Give it what it needs: 'resume' with a --note (also to say you fixed something agentduo cannot see, such as a ` +
      `credential, a service or a tool), or change the files it needs, then 'resume'. ${OTHERS}`,
    details: [
      `blocked in round ${b.round}${b.repeats > 1 ? `, ${b.repeats} times in a row` : ""}`,
      `unchanged since: ${Object.values(MARK_PARTS).join(", ")}`,
    ],
  };
}

// --------------------------------------------------------------- review cycles that do not converge
/**
 * The run's circuit breaker for a review loop. Each review closes a cycle (fix round, gates, review); the cycle made
 * progress when something that could change the review's outcome moved since the review before it, under the same
 * plan: the review resolved a blocking finding, one no longer blocks, a required gate the task had to fix passes, or a
 * file of a blocking finding changed. Repeated reports, renumbered findings and new wording are not progress. A run
 * whose fix rounds stop making progress stops (`review_stalled`) instead of reviewing the same findings again: after
 * STALL_CYCLES cycles in a row without progress, or after one in which no file changed at all. `resume` starts another
 * round only on something new, as after a blocker. See docs/superpowers/specs/2026-11-03-agentduo-convergence-design.md.
 */

/** Cycles in a row without progress (each with files changed) before the run stops. */
export const STALL_CYCLES = 2;

/** What a review leaves, for comparing it with the review before it. */
export type CycleState = Pick<ReviewCycle, "plan" | "tree" | "blocking" | "failingGates">;

/**
 * What moved in the cycle that ended with `now`, since `prev` (the review before it): an empty list when nothing did,
 * null when there is nothing to compare (no earlier review of this plan, or nothing blocked after it). `resolved`: the
 * tracked findings this review resolved; `changed`: the files changed since `prev`'s revision (null: git cannot tell).
 */
export function cycleProgress(prev: ReviewCycle | undefined, now: CycleState, o: { resolved: string[]; changed: Change[] | null; workspace: string }): string[] | null {
  if (!prev || prev.plan !== now.plan || (!prev.blocking.length && !prev.failingGates.length)) return null;
  const nowKeys = new Set(now.blocking.map((b) => b.key));
  const resolved = prev.blocking.filter((b) => o.resolved.includes(b.key)).map((b) => b.key);
  const unblocked = prev.blocking.filter((b) => !o.resolved.includes(b.key) && !nowKeys.has(b.key)).map((b) => b.key);
  const gates = prev.failingGates.filter((g) => !now.failingGates.includes(g));
  const out = [
    ...(resolved.length ? [`the review resolved ${resolved.join(", ")}`] : []),
    ...unblocked.map((k) => `${k} no longer blocks`),
    ...gates.map((g) => `required gate '${g}' passes now`),
  ];
  if (o.changed === null) {
    if (prev.tree !== now.tree) out.push("the code changed");
  } else if (prev.blocking.some((b) => !b.file) && o.changed.length) {
    out.push(`files changed: ${o.changed.slice(0, 5).map(([, p]) => p).join(", ")}`);
  } else {
    const paths = new Set(o.changed.map(([, p]) => p));
    const byFile = new Map<string, string[]>();
    for (const b of prev.blocking) {
      const file = workspacePath(b.file, o.workspace);
      if (file && touched(file, paths)) byFile.set(b.file, [...byFile.get(b.file) ?? [], b.key]);
    }
    for (const [file, keys] of byFile) out.push(`${file} changed (the file of ${keys.join(", ")})`);
  }
  return out;
}

/**
 * The stall after a cycle: one more in a row when it made no progress, none when it did (or could not be judged).
 * `stop` when the run should stop on it: STALL_CYCLES in a row, or one in which no file changed (`treeUnchanged`).
 */
export function nextStall(previous: Stall | null | undefined, cycle: { round: number; progress: string[] | null; keys: string[] }, treeUnchanged: boolean): { stall: Stall | null; stop: boolean } {
  if (cycle.progress === null || cycle.progress.length) return { stall: null, stop: false };
  const count = (previous?.count ?? 0) + 1;
  const stall: Stall = { count, since: previous?.since ?? cycle.round, round: cycle.round, keys: cycle.keys, mark: null };
  return { stall, stop: count >= STALL_CYCLES || treeUnchanged };
}

/** Why the run stops on a review loop that does not converge, and what each choice does; `items`: what holds it, line by line. */
export function stallReview(s: Stall, items: string[]): { message: string; details: string[] } {
  return {
    message: `the review loop is not converging: round ${s.round}'s review leaves the same blocking finding(s) (${s.keys.join(", ")}) as the review ` +
      "before it, and nothing that could change them moved in between: no blocking finding resolved, no required gate fixed, none of their " +
      "files changed, the plan unchanged. Another fix round would most likely repeat the same work. 'resume' with a --note (for the " +
      "implementer, or saying why the review is wrong), or after you change the files, starts another fix round; 'resume' with nothing new " +
      `does not. ${OTHERS.replace("re-plans with your note", "re-plans with your note, keeping the implementation in your files")} Nothing is ` +
      "waived: the findings stay open.",
    details: [...items, `${s.count} review round(s) in a row without progress (since round ${s.since})`],
  };
}

/** Why a `resume` did not start a fix round: nothing the implementer is given changed since the loop stalled. */
export function stallHeldReview(s: Stall): { message: string; details: string[] } {
  return {
    message: "nothing changed since the review loop stalled, so no fix round was started (it would repeat the same work). Give it something " +
      `new: 'resume' with a --note, or change the files, then 'resume'. ${OTHERS}`,
    details: [`stalled at round ${s.round} on ${s.keys.join(", ")}`, `unchanged since: ${Object.values(MARK_PARTS).join(", ")}`],
  };
}

// --------------------------------------------------------------- planning that does not converge
/**
 * The planning loop's circuit breaker, on the review loop's terms: each critique that sends the plan back closes a
 * planning cycle, and the cycle made progress when a blocking issue of the critique before it was resolved (left out)
 * or no longer blocks. A rewritten plan, renumbered or reworded issues are not progress: the critic's issues are
 * tracked by identity across critiques as review findings are (an issue is a finding about no file). After
 * STALL_CYCLES critiques in a row without progress, or one whose plan did not change at all, the run stops
 * (`planning_stalled`) instead of spending its remaining planning rounds. See
 * docs/superpowers/specs/2026-11-03-agentduo-profiles-design.md.
 */

/** A critique issue as the finding tracker takes it: about no file, outside the task's scope or not. */
const issueAsFinding = (i: Issue): Finding => ({
  id: i.id, severity: i.severity, file: "", line: null, issue: i.description, recommendation: i.suggestion, origin: i.scope === "out_of_scope" ? "out_of_scope" : "in_scope",
  criteria: [], evidence: "", late_reason: null,
});

/** The critique's issues by identity: the ledger after it, each issue's key by its id, and the keys it resolved. */
export function trackCritique(ledger: TrackedFinding[], issues: Issue[], at: { round: number; plan: string | null }):
  { ledger: TrackedFinding[]; keys: Record<string, string>; resolved: string[] } {
  const { ledger: next, tracking } = trackReview(ledger, issues.map(issueAsFinding), { round: at.round, revision: at.plan ?? "" });
  return { ledger: next, keys: Object.fromEntries(Object.entries(tracking.findings).map(([id, t]) => [id, t.key])), resolved: tracking.resolved };
}

/**
 * What moved since the critique before (`prev`) that sent the plan back: its blocking issues resolved or no longer
 * blocking. Null when there is nothing to compare with (no such critique, or it blocked on nothing).
 */
export function planProgress(prev: PlanCycle | undefined, blocking: string[], resolved: string[]): string[] | null {
  if (!prev || !prev.blocking.length) return null;
  const now = new Set(blocking);
  return [
    ...prev.blocking.filter((k) => resolved.includes(k)).map((k) => `the critic resolved ${k}`),
    ...prev.blocking.filter((k) => !resolved.includes(k) && !now.has(k)).map((k) => `${k} no longer blocks`),
  ];
}

/** Why the run stops on a planning loop that does not converge, and what each choice does; `items`: what holds it. */
export function planStallReview(s: Stall, items: string[]): { message: string; details: string[] } {
  return {
    message: `planning is not converging: round ${s.round}'s critique blocks on the same issue(s) (${s.keys.join(", ")}) as the critique before ` +
      "it, and the plan's revision resolved none of them. Another planning round would most likely repeat it. 'resume' implements the latest " +
      "plan as it is, recorded as accepted by you (the issues stay listed); 'revise' with a --note that settles them re-plans; 'abort' ends " +
      "the run. Nothing is waived without your decision.",
    details: [...items, `${s.count} critique(s) in a row without progress (since round ${s.since})`],
  };
}

/** A plan's answer to a critique issue, for the stall's details. */
export function planAnswer(plan: Plan, ids: string[]): string {
  const r = plan.feedback_resolution.find((f) => ids.includes(f.issue_id));
  return r ? `${r.decision}${r.rationale ? ` (${r.rationale})` : ""}` : "nothing";
}
