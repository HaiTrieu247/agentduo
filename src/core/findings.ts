import { touched, workspacePath } from "./context.js";
import type { Change } from "./git.js";
import type { Finding, Implementation, Review } from "./outputs.js";
import type { FindingResponse, FindingsSource, RunState, TrackedFinding } from "./state.js";

/**
 * The open review findings as they stand now. A finding holds for the revision its review was of (`findingsSource`),
 * not necessarily for the code in the workspace: since then the implementer may have answered it (a claim the next
 * review verifies, also from an attempt that ended blocked), and its file may have changed (it may be fixed already,
 * or its line may have moved). Only a review gives fresh evidence: its findings replace the open ones and their
 * answers. See docs/superpowers/specs/2026-11-03-agentduo-review-state-design.md.
 */

/** One open finding, with the implementer's latest answer since its review and how its file changed since that revision. */
export interface FindingItem {
  finding: Finding;
  /** null: not answered since the review. */
  answer: FindingResponse | null;
  /** The change to its file (or folder) since that revision ("M", "D", "A"); null when it did not change or names no file. */
  fileChange: string | null;
}

/** The open findings for a prompt: the review that raised them, what changed since its revision, and each finding. */
export interface ReviewFindings {
  round: number;
  /** The revision they were raised on; null when the run does not know it. */
  revision: string | null;
  summary: string;
  /** Files changed between that revision and the code the prompt is about; null when git cannot tell. */
  changedSince: Change[] | null;
  items: FindingItem[];
}

/** How a finding's file changed among `changes`: its own status, "M" for a folder with a change under it, else null. */
export function fileChange(file: string, changes: Change[] | null, workspace: string): string | null {
  const path = workspacePath(file, workspace);
  if (!path || !changes?.length) return null;
  const own = changes.find(([, p]) => p === path);
  if (own) return own[0];
  return touched(path, new Set(changes.map(([, p]) => p))) ? "M" : null;
}

export function reviewFindings(o: {
  state: RunState; source: FindingsSource | null; summary: string; changedSince: Change[] | null; workspace: string;
}): ReviewFindings {
  const answers = new Map((o.state.findingResponses ?? []).map((r) => [r.id, r]));
  return {
    round: o.source?.round ?? 0, revision: o.source?.revision ?? null, summary: o.summary, changedSince: o.changedSince,
    items: o.state.openFindings.map((finding) => ({
      finding, answer: answers.get(finding.id) ?? null, fileChange: fileChange(finding.file, o.changedSince, o.workspace),
    })),
  };
}

/**
 * Keeps what an implementation report answered about the open findings (the latest answer per finding wins), whether
 * the attempt completed or was blocked: a re-run of the round, or the round after it, is not asked again.
 */
export function recordResponses(state: RunState, report: Implementation, round: number): void {
  const open = new Set(state.openFindings.map((f) => f.id));
  const kept = new Map((state.findingResponses ?? []).map((r) => [r.id, r]));
  for (const a of report.addressed_findings) {
    if (!open.has(a.finding_id)) continue;
    kept.set(a.finding_id, { id: a.finding_id, resolution: a.resolution, notes: a.notes, round, status: report.status });
  }
  state.findingResponses = state.openFindings.flatMap((f) => (kept.has(f.id) ? [kept.get(f.id)!] : []));
}

/** The open findings the implementer has not answered since their review. */
export function unanswered(state: RunState): Finding[] {
  const answered = new Set((state.findingResponses ?? []).map((r) => r.id));
  return state.openFindings.filter((f) => !answered.has(f.id));
}

/** A review just raised these on `revision`: they are the open findings now, with no answer yet. */
export function setFindings(state: RunState, findings: Finding[], source: FindingsSource | null): void {
  state.openFindings = findings;
  state.findingsSource = findings.length ? source : null;
  state.findingResponses = [];
}

// ------------------------------------------------------------------ identity across reviews
/**
 * A review finding's identity across the run's reviews. A reviewer may word, order or number the same issue
 * differently from one review to the next, so a finding is matched to the ones raised before: by its id when that id
 * names an issue about the same file (or in close words), else by its words about the same file and criteria. A match
 * must be unambiguous: when two findings could be the same earlier one, or one could be two earlier ones, they stay
 * apart. Only a review resolves a finding (by leaving it out); the implementer's answers never do.
 * See docs/superpowers/specs/2026-11-03-agentduo-convergence-design.md.
 */

/** How a finding of one review stands against the ones before: new, still open, or raised again after a review resolved it. */
export type FindingStatus = "new" | "open" | "reopened";

/** One review against the findings before it: each of its findings (by its id) with its identity and status, and what it resolved. */
export interface ReviewTracking {
  findings: Record<string, { key: string; status: FindingStatus }>;
  resolved: string[];
}

/** How close two wordings must be to be one issue: about a file, and about none (a general finding). */
const SAME_WORDS = 0.5;
const SAME_GENERAL_WORDS = 0.6;
/** An id reused for another file names the same issue only in words this close. */
const SAME_ID_WORDS = 0.5;
const MAX_SEEN = 20;
const STOPWORDS = new Set(["the", "and", "for", "with", "that", "this", "not", "are", "was", "but", "from", "when", "into", "its", "has", "have",
  "does", "can", "should", "will", "than", "then", "also", "any", "all", "only", "there", "which", "what", "where", "still", "yet", "now", "been"]);

const normalFile = (file: string) => file.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/{2,}/g, "/").replace(/\/$/, "");

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

const words = (text: string) => new Set(text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u)
  .filter((w) => w.length > 2 && !STOPWORDS.has(w)).map(stem));

/** How alike two wordings are (Dice's coefficient of their words): 0 to 1. */
export function wordsAlike(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return (2 * shared) / (x.size + y.size);
}

const criteriaMeet = (a: string[] | undefined, b: string[] | undefined) => !a?.length || !b?.length || a.some((c) => b.includes(c));

/**
 * The earlier finding each finding of a review is, or null when it is new: by id first, then by words, and only where
 * the match is unambiguous (one candidate each way).
 */
export function matchFindings(ledger: TrackedFinding[], findings: Finding[]): Array<TrackedFinding | null> {
  const out: Array<TrackedFinding | null> = findings.map(() => null);
  const taken = new Set<string>();
  findings.forEach((f, i) => {
    const e = ledger.find((x) => x.ids.includes(f.id) && !taken.has(x.key));
    if (!e) return;
    const sameFile = normalFile(e.file) === normalFile(f.file);
    if (!sameFile && wordsAlike(e.issue, f.issue) < SAME_ID_WORDS) return;
    out[i] = e;
    taken.add(e.key);
  });
  const candidates = findings.map((f, i) => (out[i] ? [] : ledger.filter((e) => {
    if (taken.has(e.key) || normalFile(e.file) !== normalFile(f.file) || !criteriaMeet(e.criteria, f.criteria)) return false;
    const alike = Math.max(wordsAlike(e.issue, f.issue), e.firstIssue ? wordsAlike(e.firstIssue, f.issue) : 0);
    return alike >= (normalFile(f.file) ? SAME_WORDS : SAME_GENERAL_WORDS);
  })));
  candidates.forEach((list, i) => {
    if (list.length !== 1) return;
    const e = list[0]!;
    if (candidates.filter((other) => other.includes(e)).length !== 1) return;
    out[i] = e;
  });
  return out;
}

/** The run's tracked findings; an older run's start from its open findings, as the review they came from raised them. */
export function ledgerOf(state: RunState): TrackedFinding[] {
  if (state.trackedFindings) return state.trackedFindings;
  const at = { round: state.findingsSource?.round ?? 0, revision: state.findingsSource?.revision ?? "" };
  return state.openFindings.map((f) => ({
    key: f.id, ids: [f.id], file: f.file, issue: f.issue, severity: f.severity, origin: f.origin, criteria: f.criteria ?? [], status: "open",
    seen: [at], resolvedRound: null, reopened: 0,
  }));
}

/**
 * The tracked findings after a review of `at.revision`: each of its findings matched to an earlier one (still open, or
 * reopened) or added (new), and every earlier open one it left out resolved by it.
 */
export function trackReview(ledger: TrackedFinding[], findings: Finding[], at: { round: number; revision: string }): { ledger: TrackedFinding[]; tracking: ReviewTracking } {
  const matches = matchFindings(ledger, findings);
  const next = ledger.map((e) => ({ ...e, ids: [...e.ids], seen: [...e.seen] }));
  const byKey = new Map(next.map((e) => [e.key, e]));
  const tracking: ReviewTracking = { findings: {}, resolved: [] };
  const raised = new Set<string>();
  findings.forEach((f, i) => {
    const m = matches[i];
    const fields = { file: f.file, issue: f.issue, severity: f.severity, origin: f.origin, criteria: f.criteria ?? [] };
    if (m) {
      const e = byKey.get(m.key)!;
      const status: FindingStatus = e.status === "resolved" ? "reopened" : "open";
      if (status === "reopened") e.reopened += 1;
      if (e.issue !== f.issue && !e.firstIssue) e.firstIssue = e.issue;
      Object.assign(e, fields, { status: "open" });
      if (!e.ids.includes(f.id)) e.ids.push(f.id);
      e.seen = [...e.seen, at].slice(-MAX_SEEN);
      tracking.findings[f.id] = { key: e.key, status };
      raised.add(e.key);
      return;
    }
    let key = byKey.has(f.id) ? `${f.id}@r${at.round}` : f.id;
    for (let n = 2; byKey.has(key); n++) key = `${f.id}@r${at.round}-${n}`;
    const e: TrackedFinding = { key, ids: [f.id], ...fields, status: "open", seen: [at], resolvedRound: null, reopened: 0 };
    next.push(e);
    byKey.set(key, e);
    tracking.findings[f.id] = { key, status: "new" };
    raised.add(key);
  });
  for (const e of next) {
    if (e.status !== "open" || raised.has(e.key)) continue;
    e.status = "resolved";
    e.resolvedRound = at.round;
    tracking.resolved.push(e.key);
  }
  return { ledger: next, tracking };
}

/**
 * The review's check against churn: a blocking finding raised for the first time after an earlier review, about code
 * that did not change since that review (`since.changed`; null when git cannot tell, and nothing is asked then), must
 * say why it was not reported then, or be given the id of the finding it rewords. A new finding is never refused for
 * coming late: only for coming late without a reason.
 */
export function lateFindingErrors(o: {
  review: Review; ledger: TrackedFinding[]; since: { round: number; changed: Change[] | null } | null; blockingSeverities: string[]; workspace: string;
}): string[] {
  const since = o.since;
  if (!since || !o.ledger.length || !since.changed) return [];
  const changed = since.changed;
  const matches = matchFindings(o.ledger, o.review.findings);
  const known = o.ledger.map((e) => e.ids.at(-1)!).slice(0, 20).join(", ");
  return o.review.findings.flatMap((f, i) => {
    if (matches[i] || !o.blockingSeverities.includes(f.severity) || (f.late_reason ?? "").trim()) return [];
    if (f.origin === "out_of_scope" && f.severity !== "critical") return [];
    if (f.file && !workspacePath(f.file, o.workspace)) return []; // outside the workspace: agentduo cannot tell whether it changed
    const unchanged = f.file ? fileChange(f.file, changed, o.workspace) === null : changed.length === 0;
    if (!unchanged) return [];
    return [`finding '${f.id}' is ${f.severity} and new since your review of round ${since.round}, but ${f.file ? `'${f.file}'` : "no file"} did not ` +
      `change since then: if you reported it before in other words, give it that finding's id (${known}); if it is new, say in 'late_reason' why ` +
      "it was not reported then"];
  });
}
