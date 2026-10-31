import { describe, expect, it } from "vitest";
import { diffStats, lineDiff, splitLines } from "../src/renderer/diff.js";

describe("lineDiff", () => {
  it("keeps identical files as same rows, numbered on both sides", () => {
    const d = lineDiff("a\nb\n", "a\nb\n");
    expect(d.tooLarge).toBe(false);
    expect(d.rows).toEqual([
      { kind: "same", oldNo: 1, newNo: 1, text: "a" },
      { kind: "same", oldNo: 2, newNo: 2, text: "b" },
    ]);
  });

  it("marks added and deleted lines and numbers each side on its own", () => {
    const d = lineDiff("a\nb\nc\n", "a\nx\nc\nd\n");
    expect(d.rows.map((r) => `${r.kind}:${r.oldNo ?? "-"}:${r.newNo ?? "-"}:${r.text}`)).toEqual([
      "same:1:1:a", "del:2:-:b", "add:-:2:x", "same:3:3:c", "add:-:4:d",
    ]);
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
  });

  it("treats a missing side as all added or all deleted", () => {
    expect(lineDiff("", "one\ntwo").rows.map((r) => r.kind)).toEqual(["add", "add"]);
    expect(lineDiff("one\ntwo", "").rows.map((r) => r.kind)).toEqual(["del", "del"]);
  });

  it("says too large instead of comparing past its limits", () => {
    expect(lineDiff("a\nb\nc", "d\ne\nf", { maxCells: 4 }).tooLarge).toBe(true);
    expect(lineDiff("a\nb\nc", "a", { maxLines: 2 }).tooLarge).toBe(true);
    // A shared start and end are not compared, so a small change in a long file still fits.
    const long = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
    const changed = [...long];
    changed[500] = "changed";
    const d = lineDiff(long.join("\n"), changed.join("\n"), { maxCells: 4 });
    expect(d.tooLarge).toBe(false);
    expect(diffStats(d)).toEqual({ added: 1, removed: 1 });
  });

  it("cuts the rows it shows and says so", () => {
    const d = lineDiff("", "1\n2\n3\n4", { maxRows: 2 });
    expect(d.rows).toHaveLength(2);
    expect(d.truncated).toBe(true);
  });

  it("splits lines without an empty last one, CRLF too", () => {
    expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
  });
});
