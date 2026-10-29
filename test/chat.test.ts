import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Chat, type ChatUi } from "../src/chat.js";
import type { ConfigData } from "../src/core/config.js";
import { listConversations } from "../src/core/conversation.js";
import { RunStore } from "../src/core/state.js";
import { EventBus, type Decider, type DuoEvent, type ModelMap } from "../src/events.js";
import { approval, critique, finding, impl, plan, review } from "./helpers/builders.js";
import { testConfig } from "./helpers/config.js";
import { FakeClis } from "./helpers/fake-clis.js";
import { ScriptedDecider } from "./helpers/harness.js";
import { makeRepo } from "./helpers/repo.js";
import { tempDir } from "./helpers/tmp.js";
import { waitUntil } from "./helpers/vscode.js";

class FakeUi implements ChatUi {
  readonly lines: string[] = [];
  readonly errors: string[] = [];
  readonly statuses: string[] = [];
  readonly edits: string[] = [];
  readonly recipients: string[] = [];
  models: ModelMap | null = null;
  exited = false;
  setEdits(mode: string): void {
    this.edits.push(mode);
  }
  info(text: string, tone?: "info" | "error"): void {
    this.lines.push(text);
    if (tone === "error") this.errors.push(text);
  }
  setStatus(status: string): void {
    this.statuses.push(status);
  }
  setRecipient(backend: string): void {
    this.recipients.push(backend);
  }
  setModels(models: ModelMap): void {
    this.models = models;
  }
  exit(): void {
    this.exited = true;
  }
}

let t: { path: string; cleanup(): void };
let fake: FakeClis;
let repo: string;
let runsDir: string;
let bus: EventBus;
let ui: FakeUi;
let events: DuoEvent[];
const chats: Chat[] = [];

beforeEach(() => {
  t = tempDir();
  repo = makeRepo(t.path);
  runsDir = join(repo, ".agentduo", "runs");
  fake = new FakeClis(t.path).install();
  bus = new EventBus();
  events = [];
  bus.on((e) => events.push(e));
  ui = new FakeUi();
});
afterEach(async () => {
  for (const chat of chats.splice(0)) await chat.stop();
  fake.restore();
  t.cleanup();
});

const happy = () => ({
  planner: [{ output: plan() }],
  plan_reviewer: [{ output: critique(true) }],
  plan_finalizer: [{ output: approval(true) }],
  implementer: [{ write: { "app.txt": "fixed\n" }, output: impl() }],
  code_reviewer: [{ output: review(true) }],
});
const newChat = (o: { cfg?: ConfigData; decider?: Decider; env?: NodeJS.ProcessEnv; conversationId?: string; busyElsewhere?: () => string | null } = {}) => {
  const chat = new Chat({
    cfg: o.cfg ?? testConfig(fake), workspace: repo, runsDir, configFile: join(repo, ".agentduo", "config.yaml"), bus, decider: o.decider ?? new ScriptedDecider(), ui,
    env: o.env, conversationId: o.conversationId, busyElsewhere: o.busyElsewhere,
  });
  chats.push(chat);
  return chat;
};
const argsOf = (role: string, call = 0) => fake.calls(role)[call]!.args;
const after = (args: string[], flag: string) => args[args.lastIndexOf(flag) + 1];
const latest = () => RunStore.open(runsDir).loadState();
const answers = () => events.flatMap((e) => (e.type === "turn.finished" ? [e] : []));
const refs = () => execFileSync("git", ["for-each-ref", "refs/agentduo"], { cwd: repo, encoding: "utf8" }).trim();

describe("Chat: one of several conversations", () => {
  it("carries a conversation on by its id: what was said, who it went to, and its pipeline tasks", async () => {
    let chat = newChat({ conversationId: "conv-1" });
    fake.setScenario({ ...happy(), chat_claude: [{ answer: "Claude says A." }, { answer: "Claude says B." }] });
    await chat.submit("/claude What about A?");
    await chat.idle();
    expect(chat.title).toBe("What about A?");
    await chat.submit("/pipeline Make app.txt fixed");
    await chat.idle();
    await chat.stop();

    chat = newChat({ conversationId: "conv-1" });
    expect([chat.conversationId, chat.title, chat.to]).toEqual(["conv-1", "What about A?", "claude"]);
    await chat.submit("And B?");
    await chat.idle();
    const prompt = fake.calls("chat_claude")[1]!.prompt;
    expect(prompt).toContain("Claude says A.");
    expect(prompt).toContain("Make app.txt fixed — done");
    expect(listConversations(runsDir)).toEqual([expect.objectContaining({ id: "conv-1", title: "What about A?" })]);
  });

  it("turns a pipeline or a resume away while another conversation runs one", async () => {
    const chat = newChat({ busyElsewhere: () => "A run is going in the conversation «Fix the queue»." });
    fake.setScenario(happy());
    await chat.submit("/pipeline Make app.txt fixed");
    expect(ui.lines.at(-1)).toBe("A run is going in the conversation «Fix the queue».");
    await chat.submit("/resume");
    expect(ui.lines.at(-1)).toBe("A run is going in the conversation «Fix the queue».");
    expect(fake.calls()).toEqual([]);
    expect(chat.runningPipeline).toBe(false);
  });

  it("applies a setting another conversation changed without a word, and without asking again for full access", () => {
    const chat = newChat();
    const before = ui.lines.length;
    chat.applySetting({ target: "claude.model", model: "opus" }, { quiet: true });
    chat.applySetting({ target: "codex.permissions", preset: "full-access" }, { quiet: true });
    expect(chat.config.claude.model).toBe("opus");
    expect(chat.config.codex.args).toContain("danger-full-access");
    expect(ui.lines.length).toBe(before);
  });
});

describe("Chat: /discuss", () => {
  const discussions = () => events.flatMap((e) => (e.type === "discussion.finished" ? [e] : []));
  const steps = () => fake.calls().map((c) => `${c.role}:${c.backend}`);

  it("has the recipient answer and the other agent review, and gives the agreed version as the response", async () => {
    const chat = newChat();
    fake.setScenario({ discuss_answer: [{ answer: "Use Postgres with SKIP LOCKED." }], discuss_critique: [{ answer: "Right, and it keeps one store.\nVERDICT: AGREE" }] });
    await chat.submit("/discuss Redis or Postgres for the job queue?");
    expect(ui.statuses.at(-1)).toBe("answering");
    await chat.idle();
    expect(steps()).toEqual(["discuss_answer:codex", "discuss_critique:claude"]);
    expect(fake.calls("discuss_critique")[0]!.prompt).toContain("Use Postgres with SKIP LOCKED.");
    expect(discussions()).toEqual([expect.objectContaining({ status: "agreed", answerer: "codex", critic: "claude", rounds: 1, answer: "Use Postgres with SKIP LOCKED.", error: null })]);
    expect(events.find((e) => e.type === "discussion.started")).toMatchObject({ question: "Redis or Postgres for the job queue?", maxRounds: 3 });
    // A review is shown without its VERDICT line, which its verdict says.
    expect(answers().map((a) => a.discussion)).toEqual([
      expect.objectContaining({ step: "answer", round: 1 }), expect.objectContaining({ step: "critique", round: 1, verdict: "agree" }),
    ]);
    expect(answers()[1]!.answer).toBe("Right, and it keeps one store.");
    expect(ui.statuses.at(-1)).toBe("idle");

    // What came of it is context for what follows; the review is not.
    fake.setScenario({ chat_claude: [{ answer: "ok" }] });
    await chat.submit("/claude And the retries?");
    await chat.idle();
    const next = fake.calls("chat_claude")[0]!.prompt;
    expect(next.split("Use Postgres with SKIP LOCKED.")).toHaveLength(2);
    expect(next).toContain("discussed with Claude Code");
    expect(next).not.toContain("it keeps one store");
  });

  it("revises until the reviewer agrees, each version seeing the discussion so far", async () => {
    const chat = newChat();
    await chat.submit("/claude");
    fake.setScenario({
      discuss_answer: [{ answer: "v1: Redis." }], discuss_revise: [{ answer: "v2: Postgres." }],
      discuss_critique: [{ answer: "Redis loses jobs on a restart here.\nVERDICT: REVISE" }, { answer: "Good now.\nVERDICT: AGREE" }],
    });
    await chat.submit("/discuss Which queue?");
    await chat.idle();
    expect(steps()).toEqual(["discuss_answer:claude", "discuss_critique:codex", "discuss_revise:claude", "discuss_critique:codex"]);
    const revise = fake.calls("discuss_revise")[0]!.prompt;
    expect(revise).toContain("v1: Redis.");
    expect(revise).toContain("Redis loses jobs on a restart here.");
    expect(fake.calls("discuss_critique")[1]!.prompt).toContain("v2: Postgres.");
    expect(discussions()[0]).toMatchObject({ status: "agreed", answerer: "claude", critic: "codex", rounds: 2, answer: "v2: Postgres." });
  });

  it("when the last review still asks for changes, has the answerer write a final answer with what is still disputed", async () => {
    const cfg = testConfig(fake);
    cfg.limits.max_discussion_rounds = 2;
    const chat = newChat({ cfg });
    fake.setScenario({
      discuss_answer: [{ answer: "v1" }], discuss_critique: [{ answer: "No.\nVERDICT: REVISE" }], discuss_revise: [{ answer: "v2" }],
      discuss_final: [{ answer: "v3, and what we still disagree on" }],
    });
    await chat.submit("/discuss A hard question?");
    await chat.idle();
    expect(fake.calls().map((c) => c.role)).toEqual(["discuss_answer", "discuss_critique", "discuss_revise", "discuss_critique", "discuss_final"]);
    expect(fake.calls("discuss_final")[0]!.prompt).toMatch(/still disagree/);
    expect(discussions()[0]).toMatchObject({ status: "disputed", rounds: 2, answer: "v3, and what we still disagree on" });
  });

  it("takes a review without a VERDICT line as REVISE, and says so", async () => {
    const chat = newChat();
    fake.setScenario({ discuss_answer: [{ answer: "v1" }], discuss_critique: [{ answer: "Hmm, maybe." }, { answer: "Fine.\nVERDICT: AGREE" }], discuss_revise: [{ answer: "v2" }] });
    await chat.submit("/discuss Q?");
    await chat.idle();
    expect(events.some((e) => e.type === "warning" && e.text.includes("no VERDICT"))).toBe(true);
    expect(answers()[1]!.discussion).toMatchObject({ step: "critique", verdict: null });
    expect(discussions()[0]).toMatchObject({ status: "agreed", rounds: 2, answer: "v2" });
  });

  it("stops at Esc keeping nothing, and turns other questions away meanwhile", async () => {
    const chat = newChat();
    fake.setScenario({
      discuss_answer: [{ answer: "v1" }], discuss_critique: [{ shell: ["echo $PPID > agent.pid"], sleep: 20_000, answer: "late\nVERDICT: AGREE" }], chat_codex: [{ answer: "next" }],
    });
    await chat.submit("/discuss A slow question?");
    await waitUntil(() => existsSync(join(repo, "agent.pid")), 10_000, "the reviewer to start");
    await chat.submit("/codex meanwhile?");
    expect(ui.lines.at(-1)).toContain("discussing");
    chat.escape();
    await chat.idle();
    expect(discussions()).toEqual([expect.objectContaining({ status: "interrupted", answer: null, rounds: 1 })]);
    expect(ui.statuses.at(-1)).toBe("idle");
    await chat.submit("/codex after?");
    await chat.idle();
    expect(fake.calls("chat_codex")).toHaveLength(1);
    expect(fake.calls("chat_codex")[0]!.prompt).not.toContain("A slow question?");
  });

  it("ends with the error of a turn that failed, keeping nothing", async () => {
    const chat = newChat();
    fake.setScenario({ discuss_answer: [{ answer: "", exit: 1 }] });
    await chat.submit("/discuss Q?");
    await chat.idle();
    expect(discussions()[0]).toMatchObject({ status: "error", answer: null, rounds: 0, error: expect.any(String) });
    expect(fake.calls("discuss_critique")).toHaveLength(0);
  });
});

describe("Chat: a conversation with both agents", () => {
  it("sends a plain message to Codex as one text call: no run, no snapshot, no gate", async () => {
    const chat = newChat();
    fake.setScenario({ chat_codex: [{ answer: "Two paragraphs.\n\n```js\nconsole.log(1)\n```" }] });
    await chat.submit("What does this repo do?");
    await chat.idle();
    expect(fake.calls().map((c) => c.role)).toEqual(["chat_codex"]);
    const call = fake.calls("chat_codex")[0]!;
    expect(call.prompt.startsWith("[agentduo-conversation]")).toBe(true);
    expect(call.prompt).not.toContain("[orchestrator-role:");
    expect(call.prompt.split("What does this repo do?")).toHaveLength(2); // the question appears exactly once
    expect(call.args).not.toContain("--output-schema");
    expect(answers()).toEqual([expect.objectContaining({ backend: "codex", status: "success", answer: "Two paragraphs.\n\n```js\nconsole.log(1)\n```" })]);
    expect(ui.statuses).toEqual(["answering", "idle"]);
    expect(RunStore.list(runsDir)).toEqual([]);
    expect(existsSync(join(runsDir, "LATEST"))).toBe(false);
    expect(refs()).toBe("");
    expect(events.some((e) => e.type === "gate.started" || e.type === "run.started")).toBe(false);
  });

  it("asks the agent named by /claude or /codex whatever cfg.agents says, and each sees what the other said", async () => {
    const chat = newChat({ cfg: testConfig(fake, { agents: { planner: "codex", plan_reviewer: "codex", implementer: "codex", code_reviewer: "codex" } }) });
    fake.setScenario({ chat_claude: [{ answer: "Claude thinks A." }, { answer: "Claude again." }], chat_codex: [{ answer: "Codex thinks B." }] });
    await chat.submit("/claude What about A?");
    await chat.idle();
    expect(chat.to).toBe("claude");
    await chat.submit("And more?"); // follows the last agent asked
    await chat.idle();
    await chat.submit("/codex Do you agree?");
    await chat.idle();
    expect(fake.calls().map((c) => c.role)).toEqual(["chat_claude", "chat_claude", "chat_codex"]);
    const codex = fake.calls("chat_codex")[0]!.prompt;
    for (const s of ["What about A?", "Claude thinks A.", "And more?", "Claude again.", "You are Codex"]) expect(codex).toContain(s);
    expect(codex.indexOf("Claude thinks A.")).toBeLessThan(codex.indexOf("Claude again."));
    expect(fake.calls("chat_claude")[0]!.args).not.toContain("--json-schema");
    expect(ui.recipients).toEqual(["claude", "codex"]);
  });

  it("returns from submit before the answer, and Esc stops the agent before it answers", async () => {
    const chat = newChat();
    fake.setScenario({ chat_codex: [{ shell: ["echo $PPID > agent.pid"], sleep: 20_000, answer: "too late" }] });
    const t0 = Date.now();
    await chat.submit("Think hard");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(ui.statuses.at(-1)).toBe("answering");
    await waitUntil(() => existsSync(join(repo, "agent.pid")), 10_000, "the agent to start");
    await chat.submit("/codex another question"); // busy, not queued and not a note
    expect(ui.lines.at(-1)).toContain("still answering");
    chat.escape();
    await chat.idle();
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(answers()).toEqual([expect.objectContaining({ status: "interrupted", answer: null })]);
    expect(ui.statuses.at(-1)).toBe("idle");
    expect(fake.calls("chat_codex")).toHaveLength(1);
  });

  it("keeps a failed or stopped answer out of what later prompts get", async () => {
    const chat = newChat();
    fake.setScenario({ chat_codex: [{ answer: "", exit: 1 }, { answer: "fine" }] });
    await chat.submit("first question");
    await chat.idle();
    expect(answers()[0]).toMatchObject({ status: "error", answer: null, error: expect.any(String) });
    await chat.submit("second question");
    await chat.idle();
    expect(fake.calls("chat_codex")[1]!.prompt).not.toContain("first question");
  });

  it("shows an answer that looks like JSON as it is", async () => {
    const chat = newChat();
    fake.setScenario({ chat_codex: [{ answer: '{"not": "a schema"}\nand then prose' }], chat_claude: [{ answer: "{ starts with a brace" }] });
    await chat.submit("q1");
    await chat.idle();
    await chat.submit("/claude q2");
    await chat.idle();
    expect(answers().map((a) => a.answer)).toEqual(['{"not": "a schema"}\nand then prose', "{ starts with a brace"]);
  });

  it("sends natural questions that start with a setting's name to the agent, unchanged, without touching the config", async () => {
    const chat = newChat();
    const questions = [
      "/claude model nào phù hợp nhất cho repo này?", "/claude effort là gì?", "/claude permissions nào cần?", "/codex model nào tốt hơn?",
      "/codex permissions full-access is it safe? --yes", "/claude -- model opus",
    ];
    for (const q of questions) {
      await chat.submit(q);
      await chat.idle();
    }
    const prompts = fake.calls().map((c) => c.prompt);
    expect(prompts).toHaveLength(questions.length);
    for (const [i, q] of questions.entries()) expect(prompts[i]).toContain(q.replace(/^\/(claude|codex) (-- )?/, ""));
    expect(fake.calls("chat_claude").at(-1)!.args).not.toContain("opus");
    expect(ui.lines.some((l) => l.includes("Sent to Claude as a question") && l.includes("/settings claude model"))).toBe(true);
    await chat.submit("/config");
    expect(ui.lines.at(-1)).toMatch(/Claude {2}model: default · effort: default[\s\S]*Codex {3}model: default · effort: default · permissions: default/);
  });

  it("checks only the CLI of the agent asked, and every role's CLI for /pipeline", async () => {
    const chat = newChat({ cfg: testConfig(fake, { codex: { bin: join(t.path, "missing") } }) });
    await chat.submit("Hello?");
    expect(ui.errors.at(-1)).toContain("CLI not found: codex");
    await chat.submit("/claude Hello?");
    await chat.idle();
    expect(answers()).toHaveLength(1);
    await chat.submit("/pipeline Make app.txt fixed");
    expect(ui.errors.at(-1)).toContain("CLI not found: codex");
    expect(RunStore.list(runsDir)).toEqual([]);
  });

  it("gives Claude in the chat the implementer's edit mode (/edits, Shift+Tab), and no other implementer flag", async () => {
    const cfg = testConfig(fake);
    cfg.claude.role_args.implementer = ["--max-turns", "5"];
    const chat = newChat({ cfg });
    await chat.submit("/edits auto");
    await chat.submit("/claude edit app.txt please");
    await chat.idle();
    const args = argsOf("chat_claude");
    expect(after(args, "--permission-mode")).toBe("acceptEdits");
    expect(args).not.toContain("--max-turns");
    chat.toggleEdits();
    await chat.submit("/claude again");
    await chat.idle();
    expect(argsOf("chat_claude", 1)).not.toContain("--permission-mode");
    expect(ui.lines.some((l) => l.includes("Claude (in the chat and as the pipeline's implementer)"))).toBe(true);
  });

  it("names the model each answer ran on; a setting changed meanwhile only changes the next question", async () => {
    const chat = newChat();
    fake.setScenario({ chat_claude: [{ sleep: 1500, model: "claude-fake-7", answer: "a" }, { answer: "b" }] });
    await chat.greet();
    await chat.submit("/claude first");
    await chat.submit("/claude model opus");
    expect(ui.lines.at(-1)).toContain("Applies from the next question");
    await chat.idle();
    await chat.submit("/claude second");
    await chat.idle();
    const [first, second] = answers();
    expect(first!.model).toMatchObject({ isDefault: true, resolved: "claude-fake-7", source: "observed" });
    expect(second!.model).toMatchObject({ isDefault: false, requested: "opus", resolved: "opus" });
    expect(after(argsOf("chat_claude", 0), "--model")).not.toBe("opus");
    expect(after(argsOf("chat_claude", 1), "--model")).toBe("opus");
  });

  it("shows the models before the first question: Codex's from codex doctor, Claude's from its settings", async () => {
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ model: "sonnet" }));
    fake.setScenario({ doctor: { model: "gpt-doctor-1" } });
    const chat = newChat({ env: { ...process.env, ANTHROPIC_MODEL: "", HOME: join(t.path, "home"), CLAUDE_CONFIG_DIR: join(t.path, "claude-home") } });
    await chat.greet();
    await waitUntil(() => ui.models?.codex.status === "resolved", 10_000, "codex doctor");
    expect(ui.models!.codex).toMatchObject({ isDefault: true, resolved: "gpt-doctor-1", source: "doctor" });
    expect(ui.models!.claude).toMatchObject({ isDefault: true, configured: "sonnet", source: "settings", status: "configured" });
    expect(fake.calls()).toEqual([]);
    expect(fake.doctorCalls()[0]!.slice(0, 2)).toEqual(["doctor", "--json"]);
  });

  it("reads Claude's settings again for each question: one edited since gives the next answer a new model", async () => {
    mkdirSync(join(repo, ".claude"), { recursive: true });
    const settings = join(repo, ".claude", "settings.json");
    writeFileSync(settings, JSON.stringify({ model: "sonnet" }));
    fake.setScenario({ chat_claude: [{ model: "claude-sonnet-old", answer: "a" }, { model: "claude-opus-new", answer: "b" }] });
    const chat = newChat({ env: { ...process.env, ANTHROPIC_MODEL: "", HOME: join(t.path, "home"), CLAUDE_CONFIG_DIR: join(t.path, "claude-home") } });
    await chat.greet();
    await chat.submit("/claude first");
    await chat.idle();
    expect(ui.models!.claude).toMatchObject({ configured: "sonnet", resolved: "claude-sonnet-old" });
    writeFileSync(settings, JSON.stringify({ model: "opus" }));
    await chat.submit("/claude second");
    const started = events.flatMap((e) => (e.type === "turn.started" ? [e] : []));
    expect(started[1]!.model).toMatchObject({ configured: "opus", resolved: null });
    await chat.idle();
    expect(answers()[1]!.model).toMatchObject({ configured: "opus", resolved: "claude-opus-new" });
    expect(ui.models!.claude).toMatchObject({ configured: "opus", resolved: "claude-opus-new" });
  });
});

describe("Chat: the pipeline", () => {
  it("starts a run per /pipeline and tells each new run what the earlier ones did", async () => {
    const chat = newChat();
    fake.setScenario(happy());
    await chat.submit("/pipeline Make app.txt fixed");
    await chat.idle();
    expect(ui.statuses).toEqual(["running", "idle"]);
    await chat.submit("/pipeline Now make it say fixed twice");
    await chat.idle();
    expect(RunStore.list(runsDir)).toHaveLength(2);
    expect(fake.calls("planner")[0]!.prompt).not.toContain("Previous pipeline tasks");
    const second = fake.calls("planner")[1]!.prompt;
    expect(second).toContain("## Previous pipeline tasks");
    expect(second).toMatch(/1\. Make app\.txt fixed — done; .*files: app\.txt/);
    expect(latest().task).toBe("Now make it say fixed twice");
  });

  it("gives every role the conversation before the task, and each earlier outcome once", async () => {
    const chat = newChat();
    fake.setScenario({ ...happy(), chat_codex: [{ answer: "Use a constant for the word fixed." }] });
    await chat.submit("/pipeline Make app.txt fixed");
    await chat.idle();
    await chat.submit("How should the second task be done?");
    await chat.idle();
    await chat.submit("/pipeline Now make it say fixed twice");
    await chat.idle();
    for (const role of ["planner", "plan_reviewer", "plan_finalizer", "implementer", "code_reviewer"]) {
      const prompt = fake.calls(role).at(-1)!.prompt;
      expect(prompt, role).toContain("## Conversation before this task");
      expect(prompt, role).toContain("How should the second task be done?");
      expect(prompt, role).toContain("Use a constant for the word fixed.");
      expect(prompt.match(/Make app\.txt fixed — done/g), role).toHaveLength(1);
    }
    expect(latest().conversationContext?.exchanges).toHaveLength(1);
    // The question after the first run knows how it ended, once.
    expect(fake.calls("chat_codex")[0]!.prompt.match(/Make app\.txt fixed — done/g)).toHaveLength(1);
  });

  it("turns a plain message sent during a run into a note for the next step; /claude is busy", async () => {
    const chat = newChat();
    fake.setScenario({ ...happy(), planner: [{ sleep: 1500, output: plan() }] });
    bus.on((e) => {
      if (e.type === "phase.started" && e.phase === "PLAN") {
        setTimeout(() => {
          void chat.submit("keep it short");
          void chat.submit("/claude are you there?");
        }, 300);
      }
    });
    await chat.submit("/pipeline Make app.txt fixed");
    await chat.idle();
    expect(fake.calls("planner")).toHaveLength(1);
    expect(fake.calls("plan_reviewer")[0]!.prompt).toContain("keep it short");
    expect(fake.calls("plan_reviewer")[0]!.prompt).not.toContain("are you there");
    expect(fake.calls("chat_claude")).toEqual([]);
    expect(ui.lines.some((l) => l.includes("from the next step"))).toBe(true);
    expect(ui.lines.some((l) => l.includes("A pipeline run is going"))).toBe(true);
  });

  it("stops the step on Esc; questions still go to the agents, and /resume continues it with a note", async () => {
    const chat = newChat();
    fake.setScenario({ ...happy(), implementer: [{ activities: [{ tool: "Read", input: { file_path: "app.txt" } }], sleep: 10_000, output: impl() }, { write: { "app.txt": "fixed\n" }, output: impl() }] });
    let escaped = false;
    bus.on((e) => {
      // Once the agent is really working: a fixed delay can fire before it has even started on a busy machine.
      if (e.type === "agent.activity" && e.role === "implementer" && !escaped) {
        escaped = true;
        chat.escape();
      }
    });
    await chat.submit("/pipeline Make app.txt fixed");
    await chat.idle();
    expect(ui.statuses.at(-1)).toBe("paused");
    expect(ui.lines.some((l) => l.includes("Stopped IMPLEMENT"))).toBe(true);
    await chat.submit("");
    expect(ui.lines.at(-1)).toContain("/resume continues it");
    expect(fake.calls("implementer")).toHaveLength(1);
    await chat.submit("Why did it stop?");
    await chat.idle();
    expect(fake.calls("chat_codex")).toHaveLength(1);
    expect(ui.statuses.at(-1)).toBe("paused");
    await chat.submit("/resume only touch app.txt");
    await chat.idle();
    expect(fake.calls("implementer")).toHaveLength(2);
    expect(fake.calls("implementer")[1]!.prompt).toContain("only touch app.txt");
    expect(latest().phase).toBe("DONE");
    expect(RunStore.list(runsDir)).toHaveLength(1);
  });

  it("/pipeline while a run is stopped starts a new one; the stopped one stays resumable by its id", async () => {
    const chat = newChat();
    fake.setScenario({ ...happy(), implementer: [{ activities: [{ tool: "Read", input: { file_path: "app.txt" } }], sleep: 10_000, output: impl() }, { write: { "app.txt": "fixed\n" }, output: impl() }] });
    let escaped = false;
    bus.on((e) => {
      if (e.type === "agent.activity" && e.role === "implementer" && !escaped) {
        escaped = true;
        chat.escape();
      }
    });
    await chat.submit("/pipeline First task");
    await chat.idle();
    const first = latest().taskId;
    await chat.submit("/pipeline Second task");
    expect(ui.lines.some((l) => l.includes(`Run ${first} stays stopped and resumable: /resume ${first}`))).toBe(true);
    await chat.idle();
    expect(latest().phase).toBe("DONE");
    await chat.submit(`/resume ${first}`);
    await chat.idle();
    expect(RunStore.open(runsDir, first).loadState().phase).toBe("DONE");
  });

  it("leaves a stopped run resumable on /new, and forgets the conversation", async () => {
    const chat = newChat();
    fake.setScenario({ ...happy(), chat_claude: [{ answer: "remember me" }], implementer: [{ activities: [{ tool: "Read", input: { file_path: "app.txt" } }], sleep: 10_000, output: impl() }] });
    await chat.submit("/claude Something to remember");
    await chat.idle();
    bus.on((e) => {
      if (e.type === "agent.activity" && e.role === "implementer") chat.escape();
    });
    await chat.submit("/pipeline Make app.txt fixed");
    await chat.idle();
    await chat.submit("/new");
    expect(ui.statuses.at(-1)).toBe("idle");
    expect(chat.to).toBe("codex");
    expect(latest().inProgress?.phase).toBe("IMPLEMENT");
    await chat.submit("Fresh question");
    await chat.idle();
    const prompt = fake.calls("chat_codex")[0]!.prompt;
    expect(prompt).not.toContain("Something to remember");
    expect(prompt).not.toContain("Previous pipeline tasks");
  });

  it("answers slash commands", async () => {
    const chat = newChat();
    await chat.submit("/help");
    expect(ui.lines.join("\n")).toMatch(/\/plan[\s\S]*\/diff[\s\S]*\/status[\s\S]*\/resume[\s\S]*\/new[\s\S]*\/quit/);
    await chat.submit("/plan");
    expect(ui.lines.at(-1)).toContain("no plan yet");
    await chat.submit("/pipeline");
    expect(ui.lines.at(-1)).toContain("usage: /pipeline <task>");
    fake.setScenario(happy());
    await chat.submit("/pipeline Make app.txt fixed");
    await chat.idle();
    await chat.submit("/plan");
    expect(ui.lines.at(-1)).toContain("Demo plan");
    await chat.submit("/diff");
    expect(ui.lines.at(-1)).toContain("app.txt");
    await chat.submit("/status");
    expect(ui.lines.at(-1)).toContain("DONE");
    await chat.submit("/bogus");
    expect(ui.lines.at(-1)).toContain("unknown command /bogus");
    await chat.submit("/codex");
    expect([chat.to, ui.lines.at(-1)]).toEqual(["codex", expect.stringContaining("go to Codex")]);
    await chat.submit("/quit");
    expect(ui.exited).toBe(true);
  });

  it("switches the implementer's edits with /edits or Shift+Tab, for this chat only", async () => {
    const chat = newChat();
    await chat.greet();
    expect(ui.edits.at(-1)).toBe("ask");
    await chat.submit("/edits auto");
    expect(ui.edits.at(-1)).toBe("auto");
    expect(ui.lines.at(-1)).toContain("this chat only");
    fake.setScenario(happy());
    await chat.submit("/pipeline Make app.txt fixed");
    await chat.idle();
    expect(after(argsOf("implementer"), "--permission-mode")).toBe("acceptEdits");
    expect(argsOf("plan_reviewer")).not.toContain("--permission-mode");
    expect(JSON.parse(readFileSync(RunStore.open(runsDir).path("config.json"), "utf8")).claude.role_args.implementer).toEqual(["--permission-mode", "acceptEdits"]);
    chat.toggleEdits();
    expect(ui.edits.at(-1)).toBe("ask");
    await chat.submit("/edits");
    expect(ui.lines.at(-1)).toContain("ask");
    await chat.submit("/edits sometimes");
    expect(ui.lines.at(-1)).toContain("/edits auto|ask");
  });

  it("applies a change made during a run from that run's next agent call", async () => {
    const chat = newChat();
    fake.setScenario({ ...happy(), planner: [{ sleep: 1500, output: plan() }] });
    bus.on((e) => {
      if (e.type === "phase.started" && e.phase === "PLAN") setTimeout(() => void chat.submit("/claude model opus"), 300);
    });
    await chat.submit("/pipeline Make app.txt fixed");
    await chat.idle();
    expect(after(argsOf("plan_reviewer"), "--model")).toBe("opus");
    expect(ui.lines.some((l) => l.includes("from the next agent call"))).toBe(true);
    expect(JSON.parse(readFileSync(RunStore.open(runsDir).path("config.json"), "utf8")).claude.model).toBe("opus");
  });

  it("mirrors the settings commands of Claude Code and Codex, as /settings and as shortcuts that fit exactly", async () => {
    const chat = newChat();
    for (const command of ["/claude effort high", "/claude permissions allow Bash(npm test:*)", "/settings claude permissions deny Bash(git push:*)",
      "/claude add-dir \"../shared dir\"", "/codex model gpt-5.5 high", "/settings codex permissions auto"]) {
      await chat.submit(command);
    }
    expect(fake.calls()).toEqual([]);
    await chat.submit("/claude permissions");
    expect(ui.lines.at(-1)).toMatch(/allow: Bash\(npm test:\*\)[\s\S]*deny: Bash\(git push:\*\)/);
    await chat.submit("/settings claude effort huge");
    expect(ui.lines.at(-1)).toContain("low|medium|high|xhigh|max|default");
    await chat.submit("/codex permissions full-access");
    expect(ui.lines.at(-1)).toContain("--yes");
    fake.setScenario(happy());
    await chat.submit("/pipeline Make app.txt fixed");
    await chat.idle();
    const claude = argsOf("implementer");
    expect([after(claude, "--effort"), after(claude, "--allowedTools"), after(claude, "--disallowedTools"), after(claude, "--add-dir")])
      .toEqual(["high", "Bash(npm test:*)", "Bash(git push:*)", "../shared dir"]);
    const codex = argsOf("planner");
    expect([after(codex, "--model"), after(codex, "--sandbox")]).toEqual(["gpt-5.5", "workspace-write"]);
    expect(codex).toContain("model_reasoning_effort=high");
    await chat.submit("/codex permissions full-access --yes");
    await chat.submit("/config");
    expect(ui.lines.at(-1)).toMatch(/Claude {2}model: default · effort: high[\s\S]*Codex {3}model: gpt-5\.5 · effort: high · permissions: full-access/);
  });

  it("saves a change to config.yaml with --save, keeping the file's comments", async () => {
    mkdirSync(join(repo, ".agentduo"), { recursive: true });
    writeFileSync(join(repo, ".agentduo", "config.yaml"), "# team settings\ngates: []\n");
    const chat = newChat();
    await chat.submit("/edits auto --save");
    await chat.submit("/codex model gpt-5.5 --save");
    const text = readFileSync(join(repo, ".agentduo", "config.yaml"), "utf8");
    for (const s of ["# team settings", "acceptEdits", "model: gpt-5.5"]) expect(text).toContain(s);
    expect(ui.lines.at(-1)).toContain("saved to");
  });

  it("lists every command with what it does", async () => {
    const chat = newChat();
    await chat.submit("/help");
    const help = ui.lines.at(-1)!;
    for (const command of ["/claude", "/codex", "/pipeline", "/plan", "/diff", "/status", "/resume", "/new", "/quit", "Esc", "Shift+Tab", "/edits",
      "/settings claude model", "/settings claude effort", "/settings claude permissions", "/settings claude add-dir", "/settings codex model",
      "/settings codex permissions", "/claude -- <question>", "/config", "/help", "--save"]) {
      expect(help, command).toContain(command);
    }
    for (const line of help.split("\n").filter((l) => l.trimStart().startsWith("/"))) expect(line.trim(), line).toMatch(/^\S+(?: \S+)*\s{2,}\S/);
  });

  it("offers to resume a run left waiting in an earlier session, and asks for the decision again", async () => {
    const cfg = testConfig(fake, { limits: { max_review_rounds: 1 } });
    fake.setScenario({ ...happy(), code_reviewer: [{ output: review(false, [finding("F1")]) }] });
    const first = newChat({ cfg });
    await first.submit("/pipeline Make app.txt fixed");
    await first.idle();
    expect(latest().phase).toBe("HUMAN_REVIEW");
    const decider = new ScriptedDecider([{ decision: "abort" }]);
    const second = newChat({ cfg, decider });
    await second.greet();
    expect(ui.lines.at(-1)).toContain("/resume");
    await second.submit("/resume");
    await second.idle();
    expect(decider.seen).toEqual(["max_review_rounds"]);
    expect(latest().phase).toBe("ABORTED");
  });
});
