// The app's own update as the window shows it (main/updates.ts does the work): a line and a button in Settings →
// General, and a button at the foot of the sidebar when there is something to do: restart into a downloaded version,
// or download one this build cannot install itself.
import type { UpdateState } from "../shared/protocol.js";
import { relativeTime } from "./bridge.js";

/** What the update is doing, in a sentence. */
export function updateLine(s: UpdateState, now = Date.now()): string {
  switch (s.status) {
    case "off":
      return s.reason;
    case "idle":
      return "Not checked yet.";
    case "checking":
      return "Checking for updates…";
    case "latest":
      return `AgentDuo is up to date. Checked ${relativeTime(s.checkedAt, now)}.`;
    case "downloading":
      return `Downloading AgentDuo ${s.version}… ${s.percent}%`;
    case "ready":
      return `AgentDuo ${s.version} is downloaded. Restart to install it; quitting installs it too.`;
    case "manual":
      return `AgentDuo ${s.version} is out. ${s.reason} Download it from GitHub.`;
    case "error":
      return `Could not update: ${s.message}`;
  }
}

export type UpdateAction = "install" | "download" | "check";

/** The button next to that line: restart, download, or check (none where the build never looks). */
export function updateAction(s: UpdateState): UpdateAction | null {
  if (s.status === "off") return null;
  if (s.status === "ready") return "install";
  if (s.status === "manual") return "download";
  return "check";
}

/** The sidebar's button, only when the user has something to do; its label and what a tooltip says. */
export function updateNotice(s: UpdateState): { action: "install" | "download"; label: string; title: string } | null {
  if (s.status === "ready") return { action: "install", label: "Restart to update", title: `AgentDuo ${s.version} is downloaded: restart to install it` };
  if (s.status === "manual") return { action: "download", label: `Get AgentDuo ${s.version}`, title: `AgentDuo ${s.version} is out: download it from GitHub` };
  return null;
}

/** Restarting stops what agents are doing: asked first when one is, by how many conversations. */
export function restartQuestion(running: number): string | null {
  if (!running) return null;
  const what = running === 1 ? "an agent is working in 1 conversation" : `agents are working in ${running} conversations`;
  return `Restart to update now? ${what[0]!.toUpperCase()}${what.slice(1)}; restarting stops it. A stopped pipeline can be resumed (/resume) after the restart.`;
}
