// A team's RULES.md: the lessons a team keeps from disagreements and mistakes it has settled, for the work that follows.
// It belongs to the team (`team.id`) in a workspace, not to a run or a worktree, so every run of that team reads it again
// and a team with another id, or another workspace, never sees it. Append-only: a rule is never deleted or rewritten, and
// whatever is already in the file (the user's own lines too) stays byte for byte. Each rule has a stable id (`R1`…) and
// the incident it came from; an operation id makes a retry (or a resumed run) add it once.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { canonicalPath, dataRoot } from "../paths.js";
import { acquireLockFile, atomicWrite, LockError } from "../workflow/state.js";

export class RulesError extends Error {
  override name = "RulesError";
}

/** One rule as RULES.md records it. */
export interface RuleEntry {
  /** Stable: `R<n>`, numbered in the order they were added. */
  id: string;
  /** The operation that added it; adding again with the same one changes nothing. */
  opId: string;
  text: string;
  /** Where it came from: the disagreement or the mistake, in one line. */
  incident: string;
  at: string;
}

export interface NewRule {
  opId: string;
  text: string;
  incident: string;
}

export interface AppendResult {
  rule: RuleEntry;
  /** False: this operation had already added it. */
  added: boolean;
}

const MARKER = "<!-- agentduo-rule";
const MARKER_LINE = /^<!-- agentduo-rule id=(R\d+) op=(\S+) at=(\S+) -->$/;
const OP_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const MAX_TEXT = 4000;
const MAX_INCIDENT = 500;
const LOCK_WAIT_MS = 10_000;

export const RULES_HEADER =
  "# Team rules\n\nWhat this team learned from disagreements and mistakes it has settled. The PM appends a rule after each; " +
  "nothing here is deleted or rewritten. An exception to a rule needs the user's approval and does not change it.\n";

/** A folder name for a workspace: its canonical path's last name and a hash of the whole path (two workspaces never share one). */
export function workspaceKey(workspace: string, platform: NodeJS.Platform = process.platform): string {
  const canon = canonicalPath(workspace, platform);
  const name = basename(canon).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "workspace";
  return `${name}-${createHash("sha256").update(canon).digest("hex").slice(0, 12)}`;
}

/** `<data root>/team-rules/<workspace key>/<team id>`: the folder of one team's rules, apart from every run. */
export function teamRulesDir(env: NodeJS.ProcessEnv, workspace: string, teamId: string): string {
  const root = dataRoot(env);
  if (!root) throw new RulesError("there is no place for the team's rules: agentduo's data folder is not set (LOCALAPPDATA or APPDATA)");
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(teamId)) throw new RulesError(`team id '${teamId}' is not a valid name`);
  return join(root, "team-rules", workspaceKey(workspace), teamId);
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const busy = (pid: number | null): string => pid
  ? `the team's rules are being written by another agentduo (pid ${pid})`
  : "another agentduo is starting to write the team's rules";

/** Runs `fn` holding the folder's lock, waiting for another process that holds it (a writer is quick). */
function locked<T>(dir: string, waitMs: number, fn: () => T): T {
  mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    let release: (() => void) | null = null;
    try {
      release = acquireLockFile(join(dir, ".lock"), busy);
    } catch (e) {
      if (!(e instanceof LockError) || Date.now() > deadline) throw new RulesError((e as Error).message);
      pause(20);
      continue;
    }
    try {
      return fn();
    } finally {
      release();
    }
  }
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** What is wrong with a rule's text and incident (the first problem, said so that its writer can correct it), or null: `append` takes it. */
export function ruleInputProblem(input: { text: string; incident: string }): string | null {
  const text = input.text.replace(/\r\n?/g, "\n").trim();
  const incident = oneLine(input.incident);
  if (!text) return "a rule needs a text";
  if (!incident) return "a rule needs the incident it came from";
  if (text.length > MAX_TEXT) return `a rule's text is at most ${MAX_TEXT} characters`;
  if (incident.length > MAX_INCIDENT) return `a rule's incident is at most ${MAX_INCIDENT} characters`;
  if (text.includes(MARKER) || incident.includes(MARKER)) return "a rule's text cannot hold agentduo's own marker";
  return null;
}

export class TeamRules {
  readonly path: string;

  constructor(readonly dir: string, private readonly o: { clock?: () => Date; lockWaitMs?: number } = {}) {
    this.path = join(dir, "RULES.md");
  }

  /** Creates RULES.md when the team has none; one that exists is left as it is. True when it created it. */
  init(): boolean {
    if (existsSync(this.path)) return false;
    return locked(this.dir, this.o.lockWaitMs ?? LOCK_WAIT_MS, () => {
      if (existsSync(this.path)) return false;
      writeFileSync(this.path, RULES_HEADER, { flag: "wx" });
      return true;
    });
  }

  /** The whole text of RULES.md, as stored (created first when the team has none). */
  read(): string {
    this.init();
    return readFileSync(this.path, "utf8");
  }

  /** The rules the file records, in order. Text the file holds outside a rule is not one. */
  rules(): RuleEntry[] {
    return parseRules(this.read());
  }

  /**
   * Adds a rule at the end, under the folder's lock. The same `opId` again returns the rule it added and writes nothing.
   * Everything already in the file stays as it is: the new block is appended.
   */
  append(input: NewRule): AppendResult {
    if (!OP_ID.test(input.opId)) throw new RulesError("a rule needs an operation id of letters, digits and . _ : @ - (at most 160)");
    const problem = ruleInputProblem(input);
    if (problem) throw new RulesError(problem);
    const text = input.text.replace(/\r\n?/g, "\n").trim();
    const incident = oneLine(input.incident);
    return locked(this.dir, this.o.lockWaitMs ?? LOCK_WAIT_MS, () => {
      const current = existsSync(this.path) ? readFileSync(this.path, "utf8") : RULES_HEADER;
      const known = parseRules(current);
      const same = known.find((r) => r.opId === input.opId);
      if (same) return { rule: same, added: false };
      const n = Math.max(0, ...[...current.matchAll(/^<!-- agentduo-rule id=R(\d+) /gm)].map((m) => Number(m[1]))) + 1;
      const rule: RuleEntry = { id: `R${n}`, opId: input.opId, text, incident, at: (this.o.clock?.() ?? new Date()).toISOString() };
      const lead = current.endsWith("\n") ? "\n" : "\n\n";
      const block = `${lead}${MARKER} id=${rule.id} op=${rule.opId} at=${rule.at} -->\n### ${rule.id}\n\n${text}\n\nSource: ${incident}\n`;
      atomicWrite(this.path, current + block);
      return { rule, added: true };
    });
  }
}

/** The rules in a RULES.md text. */
export function parseRules(content: string): RuleEntry[] {
  const out: RuleEntry[] = [];
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const m = MARKER_LINE.exec(lines[i]!);
    i++;
    if (!m) continue;
    const body: string[] = [];
    while (i < lines.length && !lines[i]!.startsWith(MARKER)) body.push(lines[i++]!);
    let end = body.length;
    while (end > 0 && !body[end - 1]!.trim()) end--;
    let incident = "";
    if (end > 0 && body[end - 1]!.startsWith("Source: ")) incident = body[--end]!.slice("Source: ".length);
    let start = 0;
    if (body[start] === `### ${m[1]}`) start++;
    const text = body.slice(start, end).join("\n").trim();
    out.push({ id: m[1]!, opId: m[2]!, text, incident, at: m[3]! });
  }
  return out;
}
