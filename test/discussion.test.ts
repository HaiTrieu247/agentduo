import { describe, expect, it } from "vitest";
import { parseVerdict } from "../src/core/discussion.js";

describe("discussion: the reviewer's verdict", () => {
  it("reads the critique's own VERDICT line and leaves it out of the critique", () => {
    expect(parseVerdict("Two points are wrong.\n\n- A\n\nVERDICT: REVISE\n")).toEqual({ verdict: "revise", text: "Two points are wrong.\n\n- A" });
    expect(parseVerdict("Correct.\n**VERDICT: agree**")).toEqual({ verdict: "agree", text: "Correct." });
  });

  it("takes the last verdict when there are several", () => {
    expect(parseVerdict("VERDICT: REVISE\nOn second thought it holds.\nVERDICT: AGREE")).toEqual({ verdict: "agree", text: "VERDICT: REVISE\nOn second thought it holds." });
  });

  it("gives no verdict when no line of its own says one, and keeps the text as it is", () => {
    expect(parseVerdict("I would add tests. Verdict: it depends")).toEqual({ verdict: null, text: "I would add tests. Verdict: it depends" });
    expect(parseVerdict("VERDICT: MAYBE")).toEqual({ verdict: null, text: "VERDICT: MAYBE" });
  });
});
