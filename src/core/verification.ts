import { createHash } from "node:crypto";
import type { GateConfig } from "./config.js";
import type { GateResult } from "./gates.js";
import type { Change } from "./git.js";
import type { FinalCheck, GateOutcome, GateSpec, ReviewApproval, RunState, Verification } from "./state.js";

/**
 * The final verification invariant: DONE says that the code in the workspace when the run ends passed every required
 * quality gate (or failed only where you accepted it) and is the code the last review approved. Gate results and a
 * review's approval are evidence about one revision: the snapshot tree they were about (the workspace's files, dirty,
 * untracked and deleted ones included, never a commit id alone) and, for the gates, the configuration they ran with.
 * Before DONE, agentduo checks that evidence against the workspace and the configuration as they are then. When it is
 * out of date, the run goes back to the gates (and to a review when the code changed), at most FINAL_REFRESHES times in
 * a row; then it stops (`verification_stale`) instead of ending on evidence about other code. This module holds the
 * rules and does no I/O. See docs/superpowers/specs/2026-11-03-agentduo-final-verification-design.md.
 */

/** Times in a row the final check may send the run back for fresh evidence before it stops for your decision. */
export const FINAL_REFRESHES = 2;
/** The reasons a run keeps for the escalation's details. */
const MAX_REASONS = 10;

/** The gate configuration as far as a gate's outcome can depend on it, in the order the gates run. */
export const gateSpecs = (gates: GateConfig[], defaultTimeoutSec: number): GateSpec[] =>
  gates.map((g) => ({ name: g.name, command: g.command, required: g.required !== false, timeoutSec: g.timeout_sec ?? defaultTimeoutSec }));

export const configDigest = (specs: GateSpec[]): string =>
  createHash("sha256").update(JSON.stringify(specs.map((s) => [s.name, s.command, s.required, s.timeoutSec]))).digest("hex");

/** What changed in the gate configuration from `before` to `now`, one entry each; empty when nothing did. */
export function configChanges(before: GateSpec[], now: GateSpec[]): string[] {
  const out: string[] = [];
  for (const g of now) {
    const b = before.find((x) => x.name === g.name);
    if (!b) {
      out.push(`gate '${g.name}' added`);
      continue;
    }
    if (b.command !== g.command) out.push(`gate '${g.name}': command changed`);
    if (b.required !== g.required) out.push(`gate '${g.name}' is ${g.required ? "required" : "optional"} now`);
    if (b.timeoutSec !== g.timeoutSec) out.push(`gate '${g.name}': timeout ${b.timeoutSec}s → ${g.timeoutSec}s`);
  }
  for (const b of before) if (!now.some((g) => g.name === b.name)) out.push(`gate '${b.name}' removed`);
  if (!out.length && configDigest(before) !== configDigest(now)) out.push("the gates' order changed");
  return out;
}

/** A gate's outcome; `accepted`: the required gates whose failure you accepted as pre-existing (and that still hold so). */
export function gateOutcome(r: GateResult, accepted: Set<string>): GateOutcome {
  if (r.passed) return "passed";
  if (r.required && accepted.has(r.name)) return "accepted";
  if (r.timedOut) return "timed_out";
  // Killed by a signal, or a shell that could not run the command (126 not executable, 127 not found).
  if (r.exitCode === null || r.exitCode === 126 || r.exitCode === 127) return "error";
  return "failed";
}

const OUTCOME_TEXT: Record<GateOutcome, string> = {
  passed: "passed", failed: "failed", timed_out: "timed out", error: "could not run", accepted: "failing as before the task, accepted by you",
};

/** "check passed", "lint (optional) failed (exit 1)", "layout failing as before the task, accepted by you". */
export function gateText(g: { name: string; required: boolean; outcome: GateOutcome; exitCode: number | null }): string {
  const exit = (g.outcome === "failed" || g.outcome === "error") && g.exitCode !== null ? ` (exit ${g.exitCode})` : "";
  return `${g.name}${g.required ? "" : " (optional)"} ${OUTCOME_TEXT[g.outcome]}${exit}`;
}

const short = (id: string) => id.slice(0, 12);

function changesText(changes: Change[] | null, max = 8): string {
  if (!changes?.length) return "";
  return `: ${changes.slice(0, max).map(([s, p]) => `${s} ${p}`).join(", ")}${changes.length > max ? `, … (${changes.length - max} more)` : ""}`;
}

/** The last gate run as evidence: the tree it ran on and the configuration it ran with (undefined: an older run's, unknown). */
export interface GateRun {
  tree: string | null | undefined;
  config: GateSpec[] | null | undefined;
  results: GateResult[] | null;
}

/**
 * Why the last gate results are no evidence about `tree` under the gates configured now (`gates`), one reason each;
 * empty when they are. `changed`: the files changed since the tree they ran on, when known. What cannot be told (an
 * older run's) is out of date: agentduo never assumes the evidence holds.
 */
export function gatesStale(ran: GateRun, tree: string, gates: GateSpec[], changed: Change[] | null = null): string[] {
  if (!gates.length) return [];
  if (!ran.results) return ["the quality gates have not run on this code"];
  const out: string[] = [];
  if (ran.tree == null) out.push("it is not known which files the quality gates ran on (a run of an older agentduo)");
  else if (ran.tree !== tree) out.push(`the quality gates ran on an earlier revision${changed?.length ? `; changed since${changesText(changed)}` : ""}`);
  if (ran.config == null) {
    out.push("it is not known which gate configuration they ran with (a run of an older agentduo)");
  } else {
    const c = configChanges(ran.config, gates);
    if (c.length) out.push(`the gate configuration changed since they ran: ${c.join("; ")}`);
  }
  return out;
}

/**
 * What keeps the run from DONE, by kind. code: the code changed after the review approved it, which needs the gates and
 * a review again; review: no approval of this plan's code stands; gates: the gate results are out of date (the run
 * keeps the approval: same code, fresh gates); blocked: something DONE cannot rest on, with fresh evidence.
 */
export interface FinalProblem {
  kind: "code" | "review" | "gates" | "blocked";
  text: string;
}

export function finalProblems(o: {
  /** The workspace as it is now (a snapshot tree), and the final plan's hash. */
  tree: string;
  plan: string | null;
  approval: ReviewApproval | null;
  /** The files changed between the approved tree and `tree`, when known. */
  changedSinceApproval: Change[] | null;
  /** The gates configured now. */
  gates: GateSpec[];
  ran: GateRun;
  changedSinceGates: Change[] | null;
  /** The required gates whose failure blocks DONE (neither passing nor accepted), on the last results. */
  blockingGates: string[];
  /** Decisions still waiting (conflicts, pre-existing failures, scope items). */
  pending: number;
}): FinalProblem[] {
  const out: FinalProblem[] = [];
  const a = o.approval;
  if (!a || a.plan !== o.plan) out.push({ kind: "review", text: "no review approved the code under the final plan" });
  else if (a.tree !== o.tree) {
    out.push({ kind: "code", text: `the code changed after the review of round ${a.round} approved it${changesText(o.changedSinceApproval)}` });
  }
  const stale = gatesStale(o.ran, o.tree, o.gates, o.changedSinceGates);
  out.push(...stale.map((text): FinalProblem => ({ kind: "gates", text })));
  if (!stale.length && o.blockingGates.length) {
    out.push({ kind: "blocked", text: `required gate(s) failing on this code: ${o.blockingGates.map((g) => `'${g}'`).join(", ")}` });
  }
  if (o.pending) out.push({ kind: "blocked", text: `${o.pending} item(s) still wait for your decision` });
  return out;
}

/** The checkpoint's refreshes after one more, with its reasons (the latest kept). */
export function nextFinalCheck(previous: FinalCheck | null | undefined, reasons: string[]): FinalCheck {
  return { refreshes: (previous?.refreshes ?? 0) + 1, reasons: [...previous?.reasons ?? [], ...reasons].slice(-MAX_REASONS) };
}

/** Why the run stops instead of ending on out-of-date evidence, and what each choice does. */
export function staleReview(check: FinalCheck, gates: boolean): { message: string; details: string[] } {
  const evidence = gates ? "the quality gates' results and the review's approval" : "the review's approval";
  return {
    message: `the final code could not be verified: ${check.refreshes} time(s) in a row, the evidence DONE would rest on (${evidence}) was out of ` +
      `date by the time the run could end, because the files${gates ? " or the gate configuration" : ""} kept changing. agentduo does not end on ` +
      "evidence about other code, and nothing is waived. Stop whatever keeps changing them (an editor or a watcher, another tool, or a gate " +
      "that writes files the snapshots include: have it write ignored files), then 'resume' verifies the files as they are then " +
      `(${gates ? "the gates run again, and the code is reviewed again if it changed" : "the code is reviewed again"}). 'revise' re-plans with ` +
      "your note; 'abort' ends the run.",
    details: check.reasons,
  };
}

/** What DONE rests on, from the evidence the final check found current. */
export function finalVerification(o: {
  snapshot: { commit: string; tree: string };
  gates: GateSpec[];
  results: GateResult[];
  /** The required gates whose failure you accepted, and that the approving review still attributes to before the task. */
  acceptedGates: Set<string>;
  gatesAt: string | null;
  approval: ReviewApproval;
  /** The accepted findings the approving review still raises, as "finding F2". */
  findings: string[];
  at: string;
}): Verification {
  const gates = o.gates.length ? o.results.map((r) => ({ name: r.name, required: r.required, outcome: gateOutcome(r, o.acceptedGates), exitCode: r.exitCode })) : [];
  const failing = gates.filter((g) => g.required && g.outcome !== "passed" && g.outcome !== "accepted");
  const exceptions = [...gates.filter((g) => g.outcome === "accepted").map((g) => `gate '${g.name}'`), ...o.findings];
  return {
    status: failing.length ? "not_enforced" : exceptions.length ? "exceptions" : o.gates.length ? "verified" : "no_gates",
    commit: o.snapshot.commit, tree: o.snapshot.tree, gates, config: o.gates.length ? configDigest(o.gates) : null, gatesAt: o.gates.length ? o.gatesAt : null,
    review: { round: o.approval.round, revision: o.approval.revision, approved: o.approval.approved }, exceptions, at: o.at,
  };
}

const reviewText = (v: Verification) => (v.review.approved ? "the review approved" : "the review did not approve (require_codex_approval is off)");

/** DONE's summary from its verification record; `accepted` names what you accepted in the run, if anything. */
export function doneText(v: Verification, accepted: string): string {
  const failing = v.gates.filter((g) => g.required && g.outcome !== "passed" && g.outcome !== "accepted");
  const acceptedGates = v.gates.filter((g) => g.outcome === "accepted");
  const optional = v.gates.filter((g) => !g.required && g.outcome !== "passed");
  const extra = optional.length ? ` (optional ${optional.map((g) => `'${g.name}'`).join(", ")} not passing)` : "";
  const gates = !v.gates.length ? null
    : failing.length ? `required gates failing on the final code: ${failing.map(gateText).join(", ")} (require_tests_pass is off)`
      : acceptedGates.length ? `quality gates passed on the final code, except ${acceptedGates.map((g) => `'${g.name}'`).join(", ")}, failing as before the task${extra}`
        : `quality gates passed on the final code${extra}`;
  const head = v.status === "exceptions" ? "with accepted exceptions: " : "";
  const core = gates ? `${gates}${acceptedGates.length ? "," : ""} and ${reviewText(v)}` : `${reviewText(v)}; no quality gates configured`;
  return `${head}${core}${accepted ? `; ${accepted}` : ""}`;
}

/**
 * The run's verification as `duo status`, the report and the apps say it, one line each. Results about other code are
 * never said to pass: what ran on an earlier revision, or with another gate configuration, is out of date.
 * `configured`: the run's gates (null: not known, the last run's are taken); `workspaceTree`: the workspace as it is
 * now, when known (else the run's last snapshot stands for it).
 */
export function verificationLines(st: RunState, o: { configured?: GateSpec[] | null; workspaceTree?: string | null; acceptedGates?: Set<string> } = {}): string[] {
  const accepted = o.acceptedGates ?? new Set((st.accepted?.failures ?? []).filter((f) => f.kind === "gate").map((f) => f.id));
  const v = st.verification;
  if (st.phase === "DONE" && v) {
    const lines = [verificationText(v)];
    if (v.gates.length) lines.push(`gates: ${v.gates.map(gateText).join(", ")}${v.gatesAt ? ` (ran ${v.gatesAt})` : ""}`);
    if (o.workspaceTree && o.workspaceTree !== v.tree) lines.push("the workspace has changed since DONE verified it: the files there now are not verified");
    return lines;
  }
  const configured = o.configured ?? st.gatesConfig ?? null;
  if (configured && !configured.length) return ["no quality gates configured: nothing is verified automatically"];
  if (!st.lastGates) return [st.phase === "DONE" ? "no quality gate ran" : "quality gates not run yet"];
  const rows = st.lastGates.map((r) => ({ name: r.name, required: r.required, outcome: gateOutcome(r, accepted), exitCode: r.exitCode }));
  const text = rows.map(gateText).join(", ");
  const tree = o.workspaceTree ?? st.lastSnapshot?.tree ?? null;
  // Without the configuration (an older run's status), the gates that ran stand for it; their tree must still match.
  const stale = tree ? gatesStale({ tree: st.gatesTree, config: st.gatesConfig, results: st.lastGates }, tree, configured ?? st.gatesConfig ?? gateSpecsOf(st.lastGates)) : ["the run has no snapshot of the code yet"];
  if (stale.length) return [`quality gates ran on an earlier revision or configuration, not on the current code: ${text}`, ...stale.map((s) => `out of date: ${s}`)];
  const failing = rows.filter((g) => g.required && g.outcome !== "passed" && g.outcome !== "accepted");
  const exceptions = rows.some((g) => g.outcome === "accepted");
  return [`${failing.length ? "required quality gates failing" : exceptions ? "required quality gates passed, except failures you accepted," : "required quality gates passed"} ` +
    `on the current revision: ${text}`];
}

/** An older run's gate specs, from the results it kept (timeouts unknown: the digest never matches a configuration's). */
const gateSpecsOf = (results: GateResult[]): GateSpec[] => results.map((r) => ({ name: r.name, command: r.command, required: r.required, timeoutSec: -1 }));

/** A DONE's verification record, in one line. */
export function verificationText(v: Verification): string {
  const where = `the final code (\`${short(v.commit)}\`)`;
  const review = v.review.approved ? `the review of round ${v.review.round} approved it` : `the review of round ${v.review.round} did not approve it (require_codex_approval is off)`;
  switch (v.status) {
    case "verified":
      return `verified: every required quality gate passed on ${where}, and ${review}`;
    case "exceptions":
      return `DONE with accepted exceptions (${v.exceptions.join(", ")}): ${v.gates.length ? `the other required quality gates passed on ${where}` : `no quality gates configured for ${where}`}, and ${review}`;
    case "not_enforced":
      return `not verified: required gate(s) ${v.gates.filter((g) => g.required && g.outcome !== "passed" && g.outcome !== "accepted").map((g) => `'${g.name}'`).join(", ")} ` +
        `fail on ${where} (require_tests_pass is off), and ${review}`;
    case "no_gates":
      return `no quality gates configured: nothing was verified automatically; ${review} (${where})`;
  }
}
