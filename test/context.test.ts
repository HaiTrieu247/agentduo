import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acceptRepoNotes, addRepoNotes, MAX_NOTE_CHARS, MAX_NOTES_PER_TURN, MAX_REPO_NOTES, planTurn, rememberSession, sessionSlot, SHARED_SESSION, visibleRepoNotes,
  type TreeChanges,
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

describe("the session the plan critic and the implementer share", () => {
  const sameCli = { planner: "codex", plan_reviewer: "claude", implementer: "claude", code_reviewer: "codex" } as const;
  const changes = changesOf({ "T1>T2": [["M", "app.txt"]], "T2>T3": [] });
  /** A turn of `role` against tree `tree`, in the slot the configuration gives it. */
  const turnOf = (st: RunState, role: "plan_reviewer" | "implementer", o: { tree?: string; planHash?: string | null; answer?: string | null; keeps?: boolean } = {}) =>
    planTurn({
      state: st, role, backend: "claude", keep: o.keeps ?? true, slot: sessionSlot(role, sameCli, o.keeps ?? true), tree: o.tree ?? "T2",
      planHash: o.planHash ?? null, answer: o.answer ?? null, changes,
    });

  it("is the slot of both roles when one CLI plays them and each keeps sessions; every other role, or another CLI, keeps its own", () => {
    expect([sessionSlot("plan_reviewer", sameCli, true), sessionSlot("implementer", sameCli, true)]).toEqual([SHARED_SESSION, SHARED_SESSION]);
    expect([sessionSlot("planner", sameCli, true), sessionSlot("code_reviewer", sameCli, true)]).toEqual(["planner", "code_reviewer"]);
    const apart = { ...sameCli, plan_reviewer: "codex" } as const;
    expect([sessionSlot("plan_reviewer", apart, true), sessionSlot("implementer", apart, true)]).toEqual(["plan_reviewer", "implementer"]);
    // A role whose sessions are off runs on its own: no slot at all.
    expect([sessionSlot("implementer", sameCli, false), sessionSlot("planner", sameCli, false)]).toEqual([null, null]);
  });

  it("goes from the critic to the implementer with what is new since the session's last turn, the planner's notes the critic never saw included", async () => {
    const st = state();
    st.humanNotes = [{ at: "a", phase: "PLAN", note: "given to the critic" }];
    addRepoNotes(st, { role: "planner", backend: "codex", round: 1, tree: "T2" }, [{ path: "package.json", note: "PLANNER-NOTE" }]);
    const critic = await turnOf(st, "plan_reviewer", { tree: "T1" });
    expect([critic.slot, critic.continuation, critic.repoNotes]).toEqual([SHARED_SESSION, null, []]);
    addRepoNotes(st, { role: "plan_reviewer", backend: "claude", round: 1, tree: "T1" }, [{ path: "package.json", note: "CRITIC-NOTE" }]);
    rememberSession(st, "plan_reviewer", { sessionId: "s-1", backend: "claude", resumed: false }, critic, { tree: "T1", planHash: "P1", answer: "CRITIQUE-1" });
    expect(st.sessions).toEqual({
      [SHARED_SESSION]: { backend: "claude", id: "s-1", tree: "T1", notes: 1, repoNotes: 2, planHash: "P1", reviewed: null, role: "plan_reviewer", answers: { plan_reviewer: "CRITIQUE-1" }, withheld: [1] },
    });
    addRepoNotes(st, { role: "planner", backend: "codex", round: 2, tree: "T2" }, [{ path: "src/core", note: "PLANNER-LATER" }]);
    st.humanNotes.push({ at: "b", phase: "PLAN_FINALIZE", note: "new to the session" });
    const impl = await turnOf(st, "implementer", { planHash: "P2", answer: null });
    expect(impl.continuation).toMatchObject({ from: "plan_reviewer", knowsPlan: false, knowsAnswer: true, changed: [["M", "app.txt"]] });
    expect(impl.continuation!.session.id).toBe("s-1");
    expect(impl.continuation!.notes.map((n) => n.note)).toEqual(["new to the session"]);
    // Both of the planner's notes (the critic could see neither), and not the critic's own.
    expect(impl.continuation!.repoNotes.map((n) => n.note)).toEqual(["PLANNER-NOTE", "PLANNER-LATER"]);
    rememberSession(st, "implementer", { sessionId: "s-1", backend: "claude", resumed: true }, impl, { tree: "T3", planHash: "P2", answer: "REPORT-1" });
    expect(st.sessions![SHARED_SESSION]).toEqual({
      backend: "claude", id: "s-1", tree: "T3", notes: 2, repoNotes: 3, planHash: "P2", reviewed: null, role: "implementer",
      answers: { plan_reviewer: "CRITIQUE-1", implementer: "REPORT-1" },
    });
    // Back to the critic (a re-plan): the session still holds the critic's last critique, and knows when a later one is not it.
    const again = await turnOf(st, "plan_reviewer", { tree: "T3", answer: "CRITIQUE-1" });
    expect(again.continuation).toMatchObject({ from: "implementer", knowsAnswer: true, changed: [] });
    expect((await turnOf(st, "plan_reviewer", { tree: "T3", answer: "CRITIQUE-OTHER" })).continuation!.knowsAnswer).toBe(false);
    expect((await turnOf(st, "implementer", { tree: "T3", answer: "REPORT-1" })).continuation).toMatchObject({ knowsAnswer: true, knowsPlan: false });
    expect((await turnOf(st, "implementer", { tree: "T3", answer: "REPORT-1" })).continuation!.from).toBeUndefined();
  });

  it("starts the shared record over after a fresh session (a lost one), with the cursors of that fresh turn", async () => {
    const st = state();
    addRepoNotes(st, { role: "planner", backend: "codex", round: 1, tree: "T2" }, [{ path: "package.json", note: "PLANNER-NOTE" }]);
    st.sessions = { [SHARED_SESSION]: { backend: "claude", id: "gone", tree: "T1", notes: 0, repoNotes: 0, planHash: "P1", reviewed: null, role: "implementer", answers: { implementer: "R1" } } };
    const critic = await turnOf(st, "plan_reviewer", { answer: "C0" });
    expect(critic.continuation!.session.id).toBe("gone");
    // The CLI lost it: the runner's fresh attempt answered, with the whole prompt.
    rememberSession(st, "plan_reviewer", { sessionId: "fresh", backend: "claude", resumed: false }, critic, { tree: "T2", planHash: "P2", answer: "C1" });
    expect(st.sessions![SHARED_SESSION]).toEqual({
      backend: "claude", id: "fresh", tree: "T2", notes: 0, repoNotes: 1, planHash: "P2", reviewed: null, role: "plan_reviewer", answers: { plan_reviewer: "C1" }, withheld: [1],
    });
    // A CLI that named no session leaves nothing to continue.
    rememberSession(st, "plan_reviewer", { sessionId: null, backend: "claude", resumed: false }, critic, { tree: "T2", planHash: "P2", answer: "C1" });
    expect(st.sessions![SHARED_SESSION]).toBeUndefined();
  });

  it("leaves the shared session alone for a role whose sessions are off", async () => {
    const st = state();
    const shared = { backend: "claude" as const, id: "s-1", tree: "T1", notes: 0, repoNotes: 0, planHash: "P1", reviewed: null, role: "plan_reviewer" as const, answers: {} };
    st.sessions = { [SHARED_SESSION]: shared };
    const alone = await turnOf(st, "implementer", { keeps: false });
    expect([alone.slot, alone.keep, alone.continuation]).toEqual([null, false, null]);
    rememberSession(st, "implementer", { sessionId: "own", backend: "claude", resumed: false }, alone, { tree: "T2", planHash: "P1", answer: "R1" });
    expect(st.sessions).toEqual({ [SHARED_SESSION]: shared });
  });

  it("continues, in a run from before sharing, only the role's own session with its own cursors, then keeps it as the shared one", async () => {
    const st = state();
    addRepoNotes(st, { role: "planner", backend: "codex", round: 1, tree: "T3" }, [{ path: "package.json", note: "PLANNER-NOTE" }]);
    const legacy =(id: string, tree: string, notes: number) => ({ backend: "claude" as const, id, tree, notes, repoNotes: 1, planHash: "P1", reviewed: null });
    st.humanNotes = [{ at: "a", phase: "PLAN", note: "one" }, { at: "b", phase: "IMPLEMENT", note: "two" }];
    st.sessions = { plan_reviewer: legacy("critic-old", "T1", 0), implementer: legacy("impl-old", "T2", 2) };
    const impl = await turnOf(st, "implementer", { tree: "T3", planHash: "P1", answer: "R1" });
    expect(impl.continuation).toMatchObject({ changed: [], knowsPlan: true, knowsAnswer: true, notes: [] });
    expect(impl.continuation!.session.id).toBe("impl-old");
    expect(impl.continuation!.from).toBeUndefined();
    // The implementer's own old session had the planner's note already.
    expect(impl.continuation!.repoNotes).toEqual([]);
    rememberSession(st, "implementer", { sessionId: "impl-old", backend: "claude", resumed: true }, impl, { tree: "T3", planHash: "P1", answer: "R2" });
    expect(st.sessions).toEqual({
      plan_reviewer: legacy("critic-old", "T1", 0),
      [SHARED_SESSION]: { ...legacy("impl-old", "T3", 2), role: "implementer", answers: { implementer: "R2" } },
    });
    // The critic's old session, from the start of the run, never goes on: its next turn continues the shared one.
    const critic = await turnOf(st, "plan_reviewer", { tree: "T3" });
    expect(critic.continuation!.session.id).toBe("impl-old");
    // A legacy critic session is continued by the critic alone, with the planner's notes withheld from it.
    const old = state();
    addRepoNotes(old, { role: "planner", backend: "codex", round: 1, tree: "T1" }, [{ path: "package.json", note: "PLANNER-NOTE" }]);
    old.sessions = { plan_reviewer: legacy("critic-old", "T1", 0) };
    expect((await turnOf(old, "implementer", { tree: "T1" })).continuation).toBeNull();
    const c = await turnOf(old, "plan_reviewer", { tree: "T1" });
    rememberSession(old, "plan_reviewer", { sessionId: "critic-old", backend: "claude", resumed: true }, c, { tree: "T1", planHash: "P1", answer: "C1" });
    expect(old.sessions![SHARED_SESSION]).toMatchObject({ id: "critic-old", role: "plan_reviewer", withheld: [1] });
    expect((await turnOf(old, "implementer", { tree: "T1" })).continuation!.repoNotes.map((n) => n.note)).toEqual(["PLANNER-NOTE"]);
  });
});
