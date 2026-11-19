// "Mở" when main must close something (design section 8): quitting, closing the window and restarting into an
// update ask the page about the documents with unsaved edits, and go only on its answer, each time anew.
import { describe, expect, it } from "vitest";
import { DocumentCloseGuard } from "../src/main/document-lifecycle.js";
import type { DesktopEvent } from "../src/shared/protocol.js";

type CloseRequest = Extract<DesktopEvent, { type: "documentCloseRequest" }>;

function setup(o: { dirty?: string[]; page?: boolean } = {}) {
  const dirty = new Set(o.dirty ?? ["d1"]);
  const asked: CloseRequest[] = [];
  const lines: string[] = [];
  let focused = 0;
  let page = o.page ?? true;
  const guard = new DocumentCloseGuard({
    dirtyIds: () => [...dirty],
    isDirty: (id) => dirty.has(id),
    ask: (e) => {
      if (!page) return false;
      asked.push(e);
      return true;
    },
    focus: () => void focused++,
    log: (l) => lines.push(l),
  });
  return {
    guard, dirty, asked, lines,
    focused: () => focused,
    pageGoes: () => (page = false),
  };
}

/** What a pending check settled on, or "waiting". */
async function outcome(p: boolean | Promise<boolean>): Promise<boolean | "waiting"> {
  return Promise.race([Promise.resolve(p), new Promise<"waiting">((r) => setTimeout(() => r("waiting"), 20))]);
}

describe("DocumentCloseGuard", () => {
  it("lets main go at once when no document holds unsaved edits, asking nothing", () => {
    const t = setup({ dirty: [] });
    expect(t.guard.check("quit")).toBe(true);
    expect(t.guard.check("window")).toBe(true);
    expect(t.asked).toEqual([]);
  });

  it("asks the page about every document with unsaved edits, and goes once it settled them", async () => {
    const t = setup({ dirty: ["d1", "d2"] });
    const go = t.guard.check("quit");
    expect(go).toBeInstanceOf(Promise);
    expect(t.asked).toEqual([{ type: "documentCloseRequest", requestId: "q1", reason: "quit", documentIds: ["d1", "d2"] }]);
    expect(await outcome(go)).toBe("waiting");
    // The page saved or discarded both, told main, then answered.
    t.dirty.clear();
    expect(t.guard.respond("q1", "settled")).toBe(true);
    expect(await go).toBe(true);
  });

  it("stays when the user keeps editing or a save fails (cancelled)", async () => {
    const t = setup();
    const go = t.guard.check("window");
    expect(t.asked[0]!.reason).toBe("window");
    expect(t.guard.respond("q1", "cancelled")).toBe(true);
    expect(await go).toBe(false);
  });

  it("stays on a page's settled while main's own record still has a listed document with unsaved edits", async () => {
    const t = setup({ dirty: ["d1", "d2"] });
    const go = t.guard.check("quit");
    t.dirty.delete("d1");
    expect(t.guard.respond("q1", "settled")).toBe(true);
    expect(await go).toBe(false);
    expect(t.lines.join("\n")).toMatch(/d2/);
  });

  it("asks anew on every close: an answer never covers a later quit or window close", async () => {
    const t = setup();
    const first = t.guard.check("quit");
    t.guard.respond("q1", "cancelled");
    expect(await first).toBe(false);
    const second = t.guard.check("quit");
    expect(t.asked.map((e) => e.requestId)).toEqual(["q1", "q2"]);
    // The answer to the first request is not taken for the second.
    expect(t.guard.respond("q1", "settled")).toBe(false);
    expect(await outcome(second)).toBe("waiting");
    t.dirty.clear();
    t.guard.respond("q2", "settled");
    expect(await second).toBe(true);
    // Settled, then edited again: the next close asks again.
    t.dirty.add("d1");
    expect(t.guard.check("window")).toBeInstanceOf(Promise);
    expect(t.asked.map((e) => e.requestId)).toEqual(["q1", "q2", "q3"]);
  });

  it("keeps one request at a time: a close or quit meanwhile brings the window forward and stays", async () => {
    const t = setup();
    const go = t.guard.check("window");
    expect(t.guard.check("quit")).toBe(false);
    expect(t.guard.check("window")).toBe(false);
    expect(t.focused()).toBe(2);
    expect(t.asked).toHaveLength(1);
    t.dirty.clear();
    t.guard.respond("q1", "settled");
    expect(await go).toBe(true);
    expect(t.guard.check("quit")).toBe(true);
  });

  it("ignores an answer it did not ask for, and one answered already", async () => {
    const t = setup();
    expect(t.guard.respond("q1", "settled")).toBe(false);
    const go = t.guard.check("quit");
    expect(t.guard.respond("q9", "settled")).toBe(false);
    expect(t.guard.respond("q1", "cancelled")).toBe(true);
    expect(t.guard.respond("q1", "settled")).toBe(false);
    expect(await go).toBe(false);
  });

  it("goes when there is no page to ask (no window, a crashed or loading renderer)", async () => {
    const t = setup({ page: false });
    expect(await t.guard.check("quit")).toBe(true);
    expect(t.lines.join("\n")).toMatch(/nobody/i);
  });

  it("goes when the page goes while it is asked (the window closed, the renderer crashed)", async () => {
    const t = setup();
    const go = t.guard.check("quit");
    t.pageGoes();
    t.guard.pageGone();
    expect(await go).toBe(true);
    expect(t.guard.respond("q1", "cancelled")).toBe(false);
    // Nothing waits: pageGone with nothing asked changes nothing.
    t.guard.pageGone();
  });
});
