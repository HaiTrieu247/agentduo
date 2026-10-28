// Which run documents the editor can open and how their read-only URIs look. The host builds every URI from
// names it chose; nothing the webview or an agent sends becomes a path. No `vscode` import.
import { posix } from "node:path";
import { ARTIFACTS, isObjectId, isRunId, isWorkspacePath, type ArtifactName, type Change, type ChangeList, type SnapshotSide } from "./protocol.js";

export const ARTIFACT_SCHEME = "agentduo-artifact";
export const SNAPSHOT_SCHEME = "agentduo-snapshot";

/** `file` only names the document (and its language); the worker maps each artifact to the run's own files. */
export const ARTIFACT_INFO: Record<ArtifactName, { title: string; file: string }> = {
  plan: { title: "Final plan", file: "plan.md" },
  review: { title: "Last code review", file: "review.md" },
  feedback: { title: "Plan feedback", file: "plan-feedback.md" },
  report: { title: "Run report", file: "report.md" },
};

export interface Location {
  path: string;
  query: string;
}

export function artifactLocation(runId: string, artifact: ArtifactName): Location {
  return { path: `/${runId}/${ARTIFACT_INFO[artifact].file}`, query: new URLSearchParams({ run: runId, artifact }).toString() };
}

export function parseArtifactLocation(location: Location): { runId: string; artifact: ArtifactName } | null {
  const q = new URLSearchParams(location.query);
  const runId = q.get("run");
  const artifact = q.get("artifact");
  if (!isRunId(runId) || !(ARTIFACTS as readonly string[]).includes(artifact ?? "")) return null;
  return { runId, artifact: artifact as ArtifactName };
}

/** The two snapshots a diff compares, as a change list named them. */
export interface SnapshotPair {
  runId: string;
  base: string;
  snapshot: string;
}

export interface SnapshotLocation extends SnapshotPair {
  side: SnapshotSide;
  file: string;
}

/**
 * The path is the file's own, so the editor picks its language; run, side and both snapshot commits ride in the query.
 * The editor keeps a document per URI, so naming the snapshots gives a later round's diff its own documents.
 */
export function snapshotLocation(pair: SnapshotPair, side: SnapshotSide, file: string): Location {
  return { path: `/${file}`, query: new URLSearchParams({ run: pair.runId, base: pair.base, snapshot: pair.snapshot, side }).toString() };
}

export function parseSnapshotLocation(location: Location): SnapshotLocation | null {
  const q = new URLSearchParams(location.query);
  const runId = q.get("run");
  const base = q.get("base");
  const snapshot = q.get("snapshot");
  const side = q.get("side");
  const file = location.path.replace(/^\//, "");
  if (!isRunId(runId) || !isObjectId(base) || !isObjectId(snapshot) || (side !== "base" && side !== "snapshot") || !isWorkspacePath(file)) return null;
  return { runId, base, snapshot, side, file };
}

/** The pair a change list compares; null when it has no snapshots. */
export function snapshotPair(list: ChangeList): SnapshotPair | null {
  return list.base && list.snapshot ? { runId: list.runId, base: list.base, snapshot: list.snapshot } : null;
}

const CHANGE_LABELS: Record<string, string> = { A: "added", M: "modified", D: "deleted", T: "type changed", U: "unmerged" };

export function changeLabel(status: string): string {
  return CHANGE_LABELS[status[0] ?? ""] ?? status;
}

export function diffTitle(pair: SnapshotPair, change: Change): string {
  return `${posix.basename(change.path)} (${changeLabel(change.status)}) · before ↔ after run ${pair.runId} (snapshot ${pair.snapshot.slice(0, 7)})`;
}

/** What a side of a diff shows when it has no text: an added file's "before" is empty, a binary file says so. */
export function snapshotText(file: { missing: boolean; binary: boolean; tooLarge: boolean; text: string | null }): string {
  if (file.missing) return "";
  if (file.binary) return "(binary file: no text diff)\n";
  if (file.tooLarge) return "(file too large for a text diff)\n";
  return file.text ?? "";
}

const pairKey = (pair: SnapshotPair) => `${pair.runId} ${pair.base} ${pair.snapshot}`;

/** The change lists the user was shown, per run and snapshot pair: only a file listed there can be opened as a diff. */
export class ChangeRegistry {
  private readonly lists = new Map<string, Set<string>>();

  remember(list: ChangeList): void {
    const pair = snapshotPair(list);
    if (pair) this.lists.set(pairKey(pair), new Set(list.changes.map((c) => c.path)));
  }

  has(pair: SnapshotPair, path: string): boolean {
    return this.lists.get(pairKey(pair))?.has(path) ?? false;
  }
}
