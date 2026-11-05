// Opt-in probe of AskUserQuestion against the REAL Claude Code installed here (it spends a few cents on the smallest model):
//   AGENTDUO_REAL_CLAUDE=1 npx vitest run packages/engine/test/agents/real-claude-question.test.ts
// It drives the same classes a call uses (ClaudeBackend's args, ClaudeParser, clarificationReply) and shows that Claude gets the
// answer, and goes on in the same turn. The questions are synthetic. When the CLI changes, run it before trusting the adapter.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { ClaudeBackend, ClaudeParser } from "../../src/agents/claude.js";
import type { ClarificationAnswer, ClarificationQuestion } from "../../src/clarification/clarification.js";
import { defaultConfig } from "../../src/config/config.js";
import { tempDir } from "../helpers/tmp.js";

const REAL = process.env.AGENTDUO_REAL_CLAUDE === "1";

interface Probe {
  result: { subtype?: string; is_error?: boolean; result?: string; num_turns?: number; permission_denials?: unknown[] };
  asked: ClarificationQuestion[][];
  replies: string[];
  toolResults: string[];
}

async function probe(prompt: string, respond: (questions: ClarificationQuestion[]) => ClarificationAnswer[] | string): Promise<Probe> {
  const cfg = defaultConfig().claude;
  cfg.model = "haiku";
  const backend = new ClaudeBackend(cfg, process.cwd());
  const t = tempDir();
  try {
    const args = backend.buildArgs({ mode: "text", lastMessageFile: "", askPermissions: true, session: { keep: false } });
    const child = spawn(backend.binary(), args, { cwd: t.path, stdio: ["pipe", "pipe", "pipe"] });
    const parser = new ClaudeParser(t.path);
    const out: Probe = { result: {}, asked: [], replies: [], toolResults: [] };
    child.stdin.write(backend.hostInput(prompt));
    const lines = createInterface({ input: child.stdout });
    const finished = new Promise<void>((resolve) => child.on("close", () => resolve()));
    lines.on("line", (line) => {
      try {
        const json = JSON.parse(line);
        if (json.type === "user") for (const b of json.message?.content ?? []) if (b.type === "tool_result") out.toolResults.push(String(b.content));
        if (json.type === "result") out.result = json;
      } catch {
        // not JSON: not ours to read
      }
      for (const ev of parser.feed(line)) {
        if (ev.type === "question" && ev.questions) {
          out.asked.push(ev.questions);
          const given = respond(ev.questions);
          const reply = backend.clarificationReply(ev.raw, typeof given === "string" ? { deny: given } : { questions: ev.questions, answers: given });
          out.replies.push(reply);
          child.stdin.write(reply);
        } else if (ev.type === "permission") {
          child.stdin.write(backend.permissionReply(ev.raw, { decision: "deny" }));
        } else if (ev.type === "end") child.stdin.end();
      }
    });
    await Promise.race([finished, new Promise((_, reject) => setTimeout(() => { child.kill("SIGKILL"); reject(new Error("the probe timed out")); }, 120_000))]);
    return out;
  } finally {
    t.cleanup();
  }
}

const ASK = (question: string, header: string, multi: boolean, options: string[]) =>
  `Call the AskUserQuestion tool exactly once with one question: question "${question}", header "${header}", multiSelect ${multi}, ` +
  `options ${options.map((o) => `{label: "${o}", description: "the ${o} option"}`).join(", ")}. Do nothing else first. ` +
  "After the tool returns, reply with exactly ANSWER_WAS= followed by the answer you got, and nothing more.";

describe.skipIf(!REAL)("real Claude Code: AskUserQuestion (opt in)", () => {
  it("asks through a control_request, takes the chosen label back as updatedInput.answers, and goes on in the same turn", async () => {
    const r = await probe(ASK("Which colour?", "Colour", false, ["Red", "Blue"]), (qs) => [{ questionId: qs[0]!.id, optionIds: [qs[0]!.options[1]!.id], otherText: null }]);
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]![0]).toMatchObject({ header: "Colour", question: "Which colour?", multiSelect: false });
    expect(r.asked[0]![0]!.options.map((o) => o.label)).toEqual(["Red", "Blue"]);
    expect(JSON.parse(r.replies[0]!).response.response.updatedInput.answers).toEqual({ "Which colour?": "Blue" });
    expect(r.result).toMatchObject({ subtype: "success", is_error: false });
    expect(r.result.result).toContain("ANSWER_WAS=Blue");
    expect(r.result.num_turns).toBeGreaterThanOrEqual(2);
    expect(r.toolResults.join("\n")).toContain('"Which colour?"="Blue"');
  }, 150_000);

  it("takes several chosen labels, comma-separated", async () => {
    const r = await probe(ASK("Which sizes?", "Sizes", true, ["S", "M", "L"]), (qs) => [{ questionId: qs[0]!.id, optionIds: [qs[0]!.options[0]!.id, qs[0]!.options[2]!.id], otherText: null }]);
    expect(JSON.parse(r.replies[0]!).response.response.updatedInput.answers).toEqual({ "Which sizes?": "S, L" });
    expect(r.result.result).toContain("ANSWER_WAS=S, L");
  }, 150_000);

  it("takes the user's own words", async () => {
    const r = await probe(ASK("Which animal?", "Animal", false, ["Cat", "Dog"]), (qs) => [{ questionId: qs[0]!.id, optionIds: [], otherText: "an axolotl" }]);
    expect(r.result.result).toContain("ANSWER_WAS=an axolotl");
  }, 150_000);

  it("tells Claude why when it is refused, and Claude carries on without an answer", async () => {
    const r = await probe(ASK("Which number?", "Number", false, ["One", "Two"]), () => "The user dismissed the question without answering. Do not assume an answer.");
    expect(r.result).toMatchObject({ subtype: "success" });
    expect(r.toolResults.join("\n")).toContain("dismissed");
  }, 150_000);
});
