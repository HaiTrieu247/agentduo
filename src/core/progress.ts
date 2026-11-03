import { createHash } from "node:crypto";
import type { ConfigData } from "./config.js";
import { claudeSettingsSignature, codexLocalSignature } from "./models.js";
import type { Finding } from "./outputs.js";
import type { Blocker, ProgressMark } from "./state.js";

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
};

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A blocker's identity: its reason with case, punctuation and spacing left out. */
export function blockerKey(reason: string): string {
  return reason.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export const findingsDigest = (findings: Finding[]): string => digest(findings);

/**
 * The implementer's settings as far as a blocker can depend on them: which CLI plays it and what agentduo passes it
 * (the config's cost cap aside), and that CLI's own settings files, which snapshots leave out (a permission rule Claude
 * saved to .claude/settings.local.json, ~/.claude/settings.json, ~/.codex/config.toml…).
 */
export function implementerSettings(cfg: ConfigData, workspace: string, env: NodeJS.ProcessEnv): string {
  const backend = cfg.agents.implementer;
  if (backend === "claude") {
    const { bin, model, permission_prompts, args, role_args } = cfg.claude;
    const own = role_args.implementer ?? [];
    return digest([backend, bin, model, permission_prompts, args, own, claudeSettingsSignature({ args: [...args, ...own], workspace, env })]);
  }
  const { bin, model, args, role_args } = cfg.codex;
  return digest([backend, bin, model, args, role_args.implementer ?? [], codexLocalSignature(workspace, env)]);
}

/** The parts of what the implementer is given that differ between two marks, in MARK_PARTS order. */
export function changedParts(before: ProgressMark, now: ProgressMark): Array<keyof ProgressMark> {
  return (Object.keys(MARK_PARTS) as Array<keyof ProgressMark>).filter((k) => before[k] !== now[k]);
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
