import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acceptRepoNotes, addRepoNotes, MAX_NOTE_CHARS, MAX_NOTES_PER_TURN, MAX_REPO_NOTES, planTurn, rememberSession, visibleRepoNotes, type TreeChanges,
} from "../src/core/context.js";
import type { Change } from "../src/core/git.js";
import { newState, type RunState } from "../src/core/state.js";
import { tempDir } from "./helpers/tmp.js";

let t: { path: string; cleanup(): void };
beforeEach(() => {
  t = tempDir();
  mkdirSync(join(t.path, "src", "core"), { recursive: true });
  for (const f of ["src/core/a.ts", "src/core/b.ts", "package.json"]) writeFileSync(join(t.path, f), "x");
});
afterEach(() => t.cleanup());

const state = (): RunState => newState("t1", "task", { max_planning_rounds: 4, max_review_rounds: 5 });
/** Trees as names, and what changed between two of them. */
const changesOf = (diffs: Record<string, Change[]>): TreeChanges => async (from, to) => {
  const key = `${from}>${to}`;
  if (!(key in diffs)) throw new Error(`no tree ${from}`);
  return diffs[key]!;
};

describe("acceptRepoNotes", () => {
  it("keeps a sentence about a file or folder of the workspace, by its relative path, each once", () => {
    const kept = acceptRepoNotes([
      { path: "./src/core/a.ts", note: "Builds   the\nprompts." },
      { path: join(t.path, "src", "core", "b.ts"), note: "Parses streams." },
      { path: "src/core/", note: "Engine." },
      { path: "src\\core\\a.ts", note: "Builds the prompts." },
      { path: "", note: "General." },
      { path: "../outside.ts", note: "Outside." },
      { path: "/etc/hosts", note: "Elsewhere." },
      { path: "src/missing.ts", note: "Does not exist." },
      { path: "package.json", note: "   " },
    ], t.path);
    expect(kept).toEqual([
      { path: "src/core/a.ts", note: "Builds the prompts." },
      { path: "src/core/b.ts", note: "Parses streams." },
      { path: "src/core", note: "Engine." },
    ]);
  });

  it("cuts a long note and a long list", () => {
    const many = Array.from({ length: MAX_NOTES_PER_TURN + 5 }, (_, i) => ({ path: "package.json", note: `fact ${i} ${"y".repeat(MAX_NOTE_CHARS)}` }));
    const kept = acceptRepoNotes(many, t.path);
    expect(kept).toHaveLength(MAX_NOTES_PER_TURN);
    expect(kept[0]!.note).toHaveLength(MAX_NOTE_CHARS);
    expect(kept[0]!.note.endsWith("…")).toBe(true);
    expect(acceptRepoNotes(undefined, t.path)).toEqual([]);
  });
});

describe("repository notes", () => {
  it("numbers the notes and keeps the newest", () => {
    const st = state();
    for (let i = 0; i < MAX_REPO_NOTES + 3; i++) addRepoNotes(st, { role: "planner", backend: "codex", round: 1, tree: "T1" }, [{ path: "package.json", note: `n${i}` }]);
    expect(st.repoNotes).toHaveLength(MAX_REPO_NOTES);
    expect(st.repoNotes![0]!.seq).toBe(4);
    expect(st.repoNotes!.at(-1)).toMatchObject({ seq: MAX_REPO_NOTES + 3, note: `n${MAX_REPO_NOTES + 2}`, tree: "T1" });
  });

  it("gives a role the notes that still hold, never those of the author whose work it judges", async () => {
    const st = state();
    addRepoNotes(st, { role: "planner", backend: "codex", round: 1, tree: "T1" }, [{ path: "src/core", note: "engine" }, { path: "package.json", note: "npm test" }]);
    addRepoNotes(st, { role: "plan_reviewer", backend: "claude", round: 1, tree: "T1" }, [{ path: "src/core/b.ts", note: "parser" }]);
    addRepoNotes(st, { role: "implementer", backend: "claude", round: 1, tree: "T2" }, [{ path: "src/core/a.ts", note: "now exports x" }]);
    const changes = changesOf({ "T1>T2": [["M", "src/core/a.ts"]], "T2>T2": [], "T1>T3": [], "T2>T3": [] });
    const paths = async (role: Parameters<typeof visibleRepoNotes>[1], tree: string) => (await visibleRepoNotes(st, role, tree, changes)).map((n) => `${n.role}:${n.path}`);
    // A change to a file under a folder note takes the folder's note too; the file next to it keeps its own.
    expect(await paths("implementer", "T2")).toEqual(["planner:package.json", "plan_reviewer:src/core/b.ts", "implementer:src/core/a.ts"]);
    expect(await paths("code_reviewer", "T2")).toEqual(["planner:package.json", "plan_reviewer:src/core/b.ts"]);
    expect(await paths("plan_reviewer", "T3")).toEqual(["plan_reviewer:src/core/b.ts", "implementer:src/core/a.ts"]);
    // A tree git can no longer diff takes its notes with it.
    expect(await paths("planner", "T4")).toEqual([]);
  });
});

describe("planTurn", () => {
  const session = { backend: "claude" as const, id: "s-1", tree: "T1", notes: 1, repoNotes: 1, planHash: "P1", reviewed: null };
  const changes = changesOf({ "T1>T2": [["M", "app.txt"]] });

  it("continues the role's session with what is new since its last turn", async () => {
    const st = state();
    const file = { id: "f1", name: "x.png" } as never;
    st.humanNotes = [{ at: "a", phase: "PLAN", note: "old" }, { at: "b", phase: "IMPLEMENT", note: "new", attachments: [file, file] }];
    addRepoNotes(st, { role: "planner", backend: "codex", round: 1, tree: "T2" }, [{ path: "package.json", note: "seen" }, { path: "package.json", note: "unseen" }]);
    st.sessions = { implementer: session };
    const turn = await planTurn({ state: st, role: "implementer", backend: "claude", keep: true, tree: "T2", planHash: "P1", changes });
    expect(turn.repoNotes.map((n) => n.note)).toEqual(["seen", "unseen"]);
    expect(turn.notesGiven).toBe(2);
    expect(turn.continuation).toMatchObject({ changed: [["M", "app.txt"]], knowsPlan: true, attachments: [file] });
    expect(turn.continuation!.notes.map((n) => n.note)).toEqual(["new"]);
    expect(turn.continuation!.repoNotes.map((n) => n.note)).toEqual(["unseen"]);
    expect((await planTurn({ state: st, role: "implementer", backend: "claude", keep: true, tree: "T2", planHash: "P2", changes })).continuation!.knowsPlan).toBe(false);
  });

  it("starts fresh when sessions are not kept, the role moved to the other CLI, or the change since cannot be told", async () => {
    const st = state();
    st.sessions = { implementer: session };
    const fresh = (o: { keep?: boolean; backend?: "codex" | "claude"; tree?: string }) =>
      planTurn({ state: st, role: "implementer", backend: o.backend ?? "claude", keep: o.keep ?? true, tree: o.tree ?? "T2", planHash: null, changes })
        .then((turn) => turn.continuation);
    expect(await fresh({})).not.toBeNull();
    expect(await fresh({ keep: false })).toBeNull();
    expect(await fresh({ backend: "codex" })).toBeNull();
    expect(await fresh({ tree: "T9" })).toBeNull();
    expect((await planTurn({ state: st, role: "code_reviewer", backend: "claude", keep: true, tree: "T2", planHash: null, changes })).continuation).toBeNull();
  });

  it("remembers the session a turn ran in, with the notes it now knows, and forgets one it cannot continue", async () => {
    const st = state();
    st.humanNotes = [{ at: "a", phase: "PLAN", note: "n" }];
    const turn = await planTurn({ state: st, role: "planner", backend: "codex", keep: true, tree: "T1", planHash: null, changes });
    // The turn's own notes come in before its session is remembered: its next turn is not given them again.
    addRepoNotes(st, { role: "planner", backend: "codex", round: 1, tree: "T1" }, [{ path: "package.json", note: "mine" }]);
    st.humanNotes.push({ at: "b", phase: "PLAN", note: "added while it ran" });
    rememberSession(st, "planner", { sessionId: "th-1", backend: "codex" }, turn, { tree: "T1b", planHash: "P1" });
    expect(st.sessions?.planner).toEqual({ backend: "codex", id: "th-1", tree: "T1b", notes: 1, repoNotes: 1, planHash: "P1", reviewed: null });
    rememberSession(st, "planner", { sessionId: null, backend: "codex" }, turn, { tree: "T1c", planHash: "P1" });
    expect(st.sessions?.planner).toBeUndefined();
    rememberSession(st, "planner", { sessionId: "th-2", backend: "codex" }, { ...turn, keep: false }, { tree: "T1c", planHash: "P1" });
    expect(st.sessions?.planner).toBeUndefined();
  });
});
