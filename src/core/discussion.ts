// /discuss: the reviewer's verdict, as the last line of its own that says one. Pure, so every UI and test shares it.
import type { Verdict } from "../events.js";

const VERDICT_LINE = /^\s*[*_`]*\s*VERDICT\s*:\s*[*_`]*\s*(AGREE|REVISE)\s*[*_`]*\s*\.?\s*$/i;

/** The critique without its VERDICT line, and the verdict; null when no line of its own gives one. */
export function parseVerdict(answer: string): { verdict: Verdict | null; text: string } {
  const lines = answer.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = VERDICT_LINE.exec(lines[i]!);
    if (!m) continue;
    const text = [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n").trim();
    return { verdict: m[1]!.toLowerCase() as Verdict, text };
  }
  return { verdict: null, text: answer };
}
