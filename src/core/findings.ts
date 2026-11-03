import { touched, workspacePath } from "./context.js";
import type { Change } from "./git.js";
import type { Finding, Implementation } from "./outputs.js";
import type { FindingResponse, FindingsSource, RunState } from "./state.js";

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
