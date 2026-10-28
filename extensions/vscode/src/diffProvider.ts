import * as vscode from "vscode";
import {
  ARTIFACT_INFO, ARTIFACT_SCHEME, artifactLocation, changeLabel, ChangeRegistry, diffTitle, parseArtifactLocation, parseSnapshotLocation,
  SNAPSHOT_SCHEME, snapshotLocation, snapshotPair, snapshotText, type SnapshotPair,
} from "./artifacts.js";
import type { ArtifactName, Change, ChangeList, SnapshotSide } from "./protocol.js";
import type { WorkspaceSession } from "./workspaceSession.js";

type SessionOf = () => WorkspaceSession | null;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Plan, review, feedback and report of the focused run, read-only, through the worker. */
export class ArtifactContentProvider implements vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly session: SessionOf) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const location = parseArtifactLocation({ path: uri.path, query: uri.query });
    const session = this.session();
    if (!location) return "(not an agentduo document)\n";
    if (!session) return "(agentduo has no workspace open)\n";
    try {
      const doc = await session.request({ type: "readArtifact", artifact: location.artifact });
      if (doc.runId !== location.runId) return `(this ${ARTIFACT_INFO[location.artifact].title.toLowerCase()} belonged to run ${location.runId}; open it again from agentduo for run ${doc.runId})\n`;
      return doc.text;
    } catch (e) {
      return `(${message(e)})\n`;
    }
  }

  refresh(uri: vscode.Uri): void {
    this.changed.fire(uri);
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/**
 * Both sides of a diff, from the two snapshots its URIs name; only files the user was shown in that change list.
 * A snapshot never changes, so neither does a document: a later round gets new URIs, hence new documents.
 */
export class SnapshotContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly session: SessionOf, private readonly registry: ChangeRegistry) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const location = parseSnapshotLocation({ path: uri.path, query: uri.query });
    const session = this.session();
    if (!location) return "(not an agentduo snapshot)\n";
    if (!session || !this.registry.has(location, location.file)) return "(this diff is no longer available: open the changes again from agentduo)\n";
    try {
      const { runId, base, snapshot, side, file } = location;
      return snapshotText(await session.request({ type: "readSnapshotFile", runId, base, snapshot, side, path: file }));
    } catch (e) {
      return `(${message(e)})\n`;
    }
  }
}

export async function openArtifact(session: WorkspaceSession, provider: ArtifactContentProvider, artifact: ArtifactName): Promise<void> {
  try {
    const run = await session.request({ type: "inspectFocusedRun" });
    if (!run) {
      void vscode.window.showInformationMessage("agentduo: there is no run yet. Type a task in the chat to start one.");
      return;
    }
    if (!run.artifacts.includes(artifact)) {
      void vscode.window.showInformationMessage(`agentduo: run ${run.runId} has no ${ARTIFACT_INFO[artifact].title.toLowerCase()} yet.`);
      return;
    }
    const uri = vscode.Uri.from({ scheme: ARTIFACT_SCHEME, ...artifactLocation(run.runId, artifact) });
    provider.refresh(uri);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
  } catch (e) {
    void vscode.window.showErrorMessage(`agentduo: ${message(e)}`);
  }
}

/** The focused run's current change list, remembered so its files can be opened; null (after telling why) when empty. */
export async function changesToShow(session: WorkspaceSession, registry: ChangeRegistry): Promise<(ChangeList & SnapshotPair) | null> {
  const list = await session.request({ type: "listChanges" });
  const pair = snapshotPair(list);
  if (!pair) {
    void vscode.window.showInformationMessage(`agentduo: run ${list.runId} has no changes yet (the implementer has not run).`);
    return null;
  }
  if (!list.changes.length) {
    void vscode.window.showInformationMessage(`agentduo: run ${list.runId} changed no files in this workspace.`);
    return null;
  }
  registry.remember(list);
  return { ...list, ...pair };
}

/** One file of a change list in the diff editor: the list's base snapshot ↔ the snapshot it was listed at. */
export async function openDiff(pair: SnapshotPair, change: Change): Promise<{ base: vscode.Uri; snapshot: vscode.Uri }> {
  const side = (s: SnapshotSide) => vscode.Uri.from({ scheme: SNAPSHOT_SCHEME, ...snapshotLocation(pair, s, change.path) });
  const uris = { base: side("base"), snapshot: side("snapshot") };
  await vscode.commands.executeCommand("vscode.diff", uris.base, uris.snapshot, diffTitle(pair, change), { preview: true });
  return uris;
}

/** What the run changed: its base snapshot against its last one (not HEAD), one file at a time in the diff editor. */
export async function openChanges(session: WorkspaceSession, registry: ChangeRegistry): Promise<void> {
  try {
    const list = await changesToShow(session, registry);
    if (!list) return;
    const pick = await vscode.window.showQuickPick(
      list.changes.map((change) => ({ label: change.path, description: changeLabel(change.status), change })),
      { title: `Files run ${list.runId} changed`, placeHolder: "Before the run ↔ its last snapshot", matchOnDescription: true },
    );
    if (pick) await openDiff(list, pick.change);
  } catch (e) {
    void vscode.window.showErrorMessage(`agentduo: ${message(e)}`);
  }
}
