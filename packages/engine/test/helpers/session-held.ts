import type { FakeCall } from "./fake-clis.js";

/**
 * What each call's CLI session holds once the call was given its prompt, aligned with `calls` (the fake agents' whole log,
 * in order: a session's calls come one after the other): the prompts of the session's earlier calls, then its own. A
 * continued team prompt leaves out what its session already holds (the rules it was given among them), so whether a call
 * has a rule is a question about this text, not about its prompt alone. A lost resume reached no session: its prompt only.
 */
export function sessionHeld(calls: readonly FakeCall[]): string[] {
  const held = new Map<string, string>();
  return calls.map((c) => {
    if (c.lost || !c.session) return c.prompt;
    const text = c.resumed ? `${held.get(c.resumed) ?? ""}\n\n${c.prompt}` : c.prompt;
    held.set(c.session, text);
    return text;
  });
}

/** The rule ids a continued prompt says are in force (`In force: R1–R3, R5.`), or null when it says none. */
export function rulesInForce(prompt: string): string[] | null {
  const m = /^In force: (.+?)\. The rules you were given earlier/m.exec(prompt);
  if (!m) return null;
  return m[1]!.split(", ").flatMap((part) => {
    const range = /^R(\d+)–R(\d+)$/.exec(part);
    if (!range) return [part];
    const ids: string[] = [];
    for (let n = Number(range[1]); n <= Number(range[2]); n++) ids.push(`R${n}`);
    return ids;
  });
}
