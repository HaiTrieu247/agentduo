import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Chat, HOME_NOTE, NOT_REPO_NOTE, type ChatUi } from "../src/chat.js";
import type { Attachment } from "../src/core/attachment-types.js";
import { existingAttachmentFile } from "../src/core/attachments.js";
import { Conversation } from "../src/core/conversation.js";
import type { ConfigData } from "../src/core/config.js";
import { listConversations } from "../src/core/conversation.js";
import { RunStore } from "../src/core/state.js";
import type { UsageReport } from "../src/core/usage.js";
import { ClarificationBroker } from "../src/core/clarification-broker.js";
import { EventBus, type ClarificationDecider, type Decider, type Decision, type DuoEvent, type ModelMap } from "../src/events.js";
import { approval, critique, finding, impl, plan, review } from "./helpers/builders.js";
import { GIT_MISSING } from "../src/core/run-git.js";
import { testConfig, userDataEnv } from "./helpers/config.js";
import { FakeClis } from "./helpers/fake-clis.js";
import { pickFirst, ScriptedClarifier, ScriptedDecider } from "./helpers/harness.js";
import { png } from "./helpers/images.js";
import { makeRepo } from "./helpers/repo.js";
import { tempDir } from "./helpers/tmp.js";
import { pidAlive, waitUntil } from "./helpers/vscode.js";

class FakeUi implements ChatUi {
  readonly lines: string[] = [];
  readonly errors: string[] = [];
  readonly statuses: string[] = [];
  readonly modes: string[] = [];
  readonly recipients: string[] = [];
  models: ModelMap | null = null;
  exited = false;
  /** The waiting files after each change, and those that went with each message, by name. */
  readonly waiting: string[][] = [];
  readonly sentFiles: string[][] = [];
  setAttachments(files: Attachment[]): void {
    this.waiting.push(files.map((f) => f.name));
  }
  sent(files: Attachment[]): void {
    this.sentFiles.push(files.map((f) => f.name));
  }
  setMode(mode: string): void {
    this.modes.push(mode);
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
const userConfig = () => join(t.path, "xdg", "agentduo", "config.yaml");
const newChat = (o: { cfg?: ConfigData; decider?: Decider; env?: NodeJS.ProcessEnv; conversationId?: string; busyElsewhere?: () => string | null;
  userConfigFile?: string; clarifier?: ClarificationDecider; } = {}) => {
  const chat = new Chat({
    cfg: o.cfg ?? testConfig(fake), workspace: repo, runsDir, configFile: join(repo, ".agentduo", "config.yaml"), userConfigFile: o.userConfigFile ?? userConfig(),
    bus, decider: o.decider ?? new ScriptedDecider(), ui,
    env: o.env, conversationId: o.conversationId, busyElsewhere: o.busyElsewhere, clarifier: o.clarifier,
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
    expect(prompt).not.toContain("Claude says A.");
    expect(fake.calls("chat_claude")[1]!.resumed).toBe(fake.calls("chat_claude")[0]!.session);
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

describe("Chat: conversation sessions", () => {
  it("shares each backend's session across chat, discussions and reopening, then starts new ones for /new", async () => {
    let chat = newChat({ conversationId: "shared" });
    fake.setScenario({
      chat_codex: [{ answer: "CODEX-INITIAL" }, { answer: "CODEX-FOLLOWUP" }, { answer: "NEW-CODEX" }],
      chat_claude: [{ answer: "CLAUDE-INITIAL" }, { answer: "CLAUDE-FOLLOWUP" }, { answer: "NEW-CLAUDE" }],
      discuss_answer: [{ answer: "DRAFT" }], discuss_critique: [{ answer: "AGREED\nVERDICT: AGREE" }],
      discuss_synthesis: [{ answer: "FINAL" }],
    });
    for (const question of ["/codex first", "/claude second", "/codex", "/discuss choose"]) {
      await chat.submit(question);
      await chat.idle();
    }
    const codex = fake.calls("chat_codex")[0]!.session;
    const claude = fake.calls("chat_claude")[0]!.session;
    expect(codex).toBeTruthy();
    expect(claude).toBeTruthy();
    expect(codex).not.toBe(claude);
    expect(fake.calls("discuss_answer")[0]).toMatchObject({ session: codex, resumed: codex });
    expect(fake.calls("discuss_critique")[0]).toMatchObject({ session: claude, resumed: claude });
    expect(fake.calls("discuss_synthesis")[0]).toMatchObject({ session: codex, resumed: codex });
    expect(fake.calls("discuss_answer")[0]!.prompt).toContain("CLAUDE-INITIAL");
    expect(fake.calls("discuss_answer")[0]!.prompt).not.toContain("CODEX-INITIAL");
    await chat.stop();
    chat = newChat({ conversationId: "shared" });
    for (const question of ["/codex followup", "/claude followup", "/new", "/codex new", "/claude new"]) {
      await chat.submit(question);
      await chat.idle();
    }
    expect(fake.calls("chat_codex")[1]).toMatchObject({ session: codex, resumed: codex });
    expect(fake.calls("chat_claude")[1]).toMatchObject({ session: claude, resumed: claude });
    for (const backend of ["codex", "claude"]) {
      const fresh = fake.calls(`chat_${backend}`)[2]!;
      expect(fresh.resumed).toBeUndefined();
      expect(fresh.session).not.toBe(backend === "codex" ? codex : claude);
      expect(fresh.prompt).not.toContain("FINAL");
    }
  });

  it("recovers lost text sessions using the full conversation and keeps the replacement", async () => {
    const chat = newChat();
    fake.setScenario({ sessions: { lost: true }, chat_codex: [{ answer: "FIRST" }, { answer: "SECOND" }] });
    await chat.submit("/codex first");
    await chat.idle();
    fake.setScenario({ chat_codex: [{ answer: "FIRST" }, { answer: "SECOND" }, { answer: "THIRD" }] });
    await chat.submit("/codex second");
    await chat.idle();
    const calls = fake.calls("chat_codex");
    expect(calls[1]).toMatchObject({ lost: true, resumed: calls[0]!.session });
    expect(calls[1]!.prompt).not.toContain("FIRST");
    expect(calls[2]!.prompt).toContain("FIRST");
    expect(calls[2]!.resumed).toBeUndefined();
    await chat.submit("/codex third");
    await chat.idle();
    expect(fake.calls("chat_codex")[3]!.resumed).toBe(calls[2]!.session);
  });

  it("respects disabled persistence and never resumes a stale session after it is enabled again", async () => {
    const cfg = testConfig(fake);
    const chat = newChat({ cfg });
    fake.setScenario({ chat_codex: [{ answer: "A" }], chat_claude: [{ answer: "B" }] });
    for (const question of ["/codex one", "/claude two"]) { await chat.submit(question); await chat.idle(); }
    chat.config.codex.args.push("--ephemeral");
    chat.config.claude.args.push("--no-session-persistence");
    for (const question of ["/codex three", "/claude four"]) { await chat.submit(question); await chat.idle(); }
    chat.config.codex.args = [];
    chat.config.claude.args = [];
    for (const question of ["/codex five", "/claude six"]) { await chat.submit(question); await chat.idle(); }
    for (const backend of ["codex", "claude"]) {
      const calls = fake.calls(`chat_${backend}`);
      expect(calls).toHaveLength(3);
      expect(calls[1]!.resumed).toBeUndefined();
      expect(calls[2]!.resumed).toBeUndefined();
      expect(calls[1]!.args).toContain(backend === "codex" ? "--ephemeral" : "--no-session-persistence");
    }
  });

  const say = async (chat: Chat, ...questions: string[]) => {
    for (const question of questions) {
      await chat.submit(question);
      await chat.idle();
    }
  };
  /** How many times `part` is in `text`: a continued prompt carries what its session has not seen exactly once. */
  const count = (text: string, part: string) => text.split(part).length - 1;
  const saved = (chat: Chat) => JSON.parse(readFileSync(join(runsDir, "conversations", chat.conversationId, "conversation.json"), "utf8"));

  it("gives each continued prompt, in chat and in every step of a discussion, exactly what its session has not seen", async () => {
    const chat = newChat();
    fake.setScenario({
      chat_codex: [{ answer: "ANS-ONE" }, { answer: "ANS-THREE" }, { answer: "ANS-SIX" }], chat_claude: [{ answer: "ANS-TWO" }, { answer: "ANS-FIVE" }],
      discuss_answer: [{ answer: "DRAFT-V1" }], discuss_critique: [{ answer: "CRIT-OK\nVERDICT: AGREE" }], discuss_synthesis: [{ answer: "FINAL-SYN" }],
    });
    await say(chat, "/codex QQ-ONE", "/claude QQ-TWO", "/codex QQ-THREE", "/discuss QQ-FOUR", "/claude QQ-FIVE", "/codex QQ-SIX");
    const [codex1, codex3, codex6] = fake.calls("chat_codex");
    const [claude2, claude5] = fake.calls("chat_claude");
    const answer = fake.calls("discuss_answer")[0]!;
    const review = fake.calls("discuss_critique")[0]!;
    const synthesis = fake.calls("discuss_synthesis")[0]!;
    expect(claude2!.resumed).toBeUndefined();
    expect(count(claude2!.prompt, "ANS-ONE")).toBe(1);
    expect(codex3!.resumed).toBe(codex1!.session);
    expect([count(codex3!.prompt, "QQ-TWO"), count(codex3!.prompt, "ANS-TWO"), count(codex3!.prompt, "ANS-ONE")]).toEqual([1, 1, 0]);
    // Codex's session has seen the whole chat: its answer gets the question alone.
    expect(answer.resumed).toBe(codex1!.session);
    for (const seen of ["ANS-ONE", "ANS-TWO", "ANS-THREE"]) expect(answer.prompt).not.toContain(seen);
    expect(review.resumed).toBe(claude2!.session);
    expect([count(review.prompt, "ANS-THREE"), count(review.prompt, "DRAFT-V1"), count(review.prompt, "ANS-TWO")]).toEqual([1, 1, 0]);
    expect(synthesis.resumed).toBe(codex1!.session);
    expect([count(synthesis.prompt, "CRIT-OK"), count(synthesis.prompt, "DRAFT-V1")]).toEqual([1, 0]);
    // After the discussion, the reviewer gets its final answer once, and nothing it took part in.
    expect(claude5!.resumed).toBe(claude2!.session);
    expect(count(claude5!.prompt, "FINAL-SYN")).toBe(1);
    for (const seen of ["ANS-THREE", "DRAFT-V1", "CRIT-OK"]) expect(claude5!.prompt).not.toContain(seen);
    expect(codex6!.resumed).toBe(codex1!.session);
    expect(count(codex6!.prompt, "ANS-FIVE")).toBe(1);
  });

  it("starts a discussion after reopening with its whole history, also for sessions that were in an earlier one", async () => {
    let chat = newChat({ conversationId: "again" });
    fake.setScenario({
      discuss_answer: [{ answer: "OLD-DRAFT" }, { answer: "NEW-DRAFT" }],
      discuss_critique: [{ answer: "OLD-REVIEW\nVERDICT: AGREE" }, { answer: "NEW-REVIEW\nVERDICT: AGREE" }],
      discuss_synthesis: [{ answer: "OLD-FINAL" }, { answer: "NEW-FINAL" }],
    });
    await say(chat, "/discuss OLD-Q");
    await chat.stop();
    chat = newChat({ conversationId: "again" });
    await say(chat, "/discuss NEW-Q");
    const review = fake.calls("discuss_critique")[1]!;
    expect(review.resumed).toBe(fake.calls("discuss_critique")[0]!.session);
    expect([count(review.prompt, "NEW-DRAFT"), count(review.prompt, "OLD-FINAL"), count(review.prompt, "OLD-DRAFT")]).toEqual([1, 1, 0]);
    const synthesis = fake.calls("discuss_synthesis")[1]!;
    expect(synthesis.resumed).toBe(fake.calls("discuss_synthesis")[0]!.session);
    expect([count(synthesis.prompt, "NEW-REVIEW"), count(synthesis.prompt, "NEW-DRAFT")]).toEqual([1, 0]);
  });

  it("gives each session a pipeline task of the conversation once, and never gives a pipeline role a conversation session", async () => {
    const chat = newChat();
    fake.setScenario({ ...happy(), chat_codex: [{ answer: "c1" }, { answer: "c2" }, { answer: "c3" }], chat_claude: [{ answer: "k1" }, { answer: "k2" }] });
    await say(chat, "/codex before", "/claude before", "/pipeline Make app.txt fixed", "/codex after", "/codex later", "/claude after");
    const codex = fake.calls("chat_codex");
    const claude = fake.calls("chat_claude");
    expect(codex[1]!.resumed).toBe(codex[0]!.session);
    expect(count(codex[1]!.prompt, "Make app.txt fixed")).toBe(1);
    expect(codex[2]!.prompt).not.toContain("Make app.txt fixed");
    expect(claude[1]!.resumed).toBe(claude[0]!.session);
    expect(count(claude[1]!.prompt, "Make app.txt fixed")).toBe(1);
    const conversation = new Set([codex[0]!.session, claude[0]!.session]);
    for (const call of fake.calls().filter((c) => !c.role.startsWith("chat_"))) {
      expect(conversation.has(call.session ?? ""), call.role).toBe(false);
      expect(conversation.has(call.resumed ?? ""), call.role).toBe(false);
    }
  });

  it("recovers a session lost in a discussion step with the whole prompt, and continues the replacement from there", async () => {
    const chat = newChat();
    fake.setScenario({
      chat_codex: [{ answer: "ANS-ONE" }, { answer: "ANS-FOUR" }], chat_claude: [{ answer: "ANS-TWO" }],
      discuss_answer: [{ answer: "DRAFT-V1" }], discuss_critique: [{ answer: "CRIT-OK\nVERDICT: AGREE" }], discuss_synthesis: [{ answer: "FINAL-SYN" }],
    });
    await say(chat, "/codex QQ-ONE", "/claude QQ-TWO");
    fake.forget(fake.calls("chat_codex")[0]!.session!);
    await say(chat, "/codex", "/discuss QQ-THREE");
    const [lost, fresh] = fake.calls("discuss_answer");
    expect(lost).toMatchObject({ lost: true, resumed: fake.calls("chat_codex")[0]!.session });
    expect(fresh!.resumed).toBeUndefined();
    expect([count(fresh!.prompt, "ANS-ONE"), count(fresh!.prompt, "ANS-TWO")]).toEqual([1, 1]);
    const synthesis = fake.calls("discuss_synthesis")[0]!;
    expect(synthesis.resumed).toBe(fresh!.session);
    expect([count(synthesis.prompt, "CRIT-OK"), count(synthesis.prompt, "DRAFT-V1")]).toEqual([1, 0]);
    await say(chat, "/codex QQ-FOUR");
    const next = fake.calls("chat_codex")[1]!;
    expect(next.resumed).toBe(fresh!.session);
    expect(next.prompt).not.toContain("ANS-TWO");
  });

  it("drops a session whose continued and fresh attempts both failed: the next question starts a new one with the whole conversation", async () => {
    const chat = newChat();
    fake.setScenario({ chat_codex: [{ answer: "ANS-ONE" }, { answer: "", exit: 1 }, { answer: "", exit: 1 }, { answer: "ANS-THREE" }] });
    await say(chat, "/codex QQ-ONE", "/codex QQ-TWO", "/codex QQ-THREE");
    const [one, continued, fresh, three] = fake.calls("chat_codex");
    expect(continued!.resumed).toBe(one!.session);
    expect(fresh!.resumed).toBeUndefined();
    expect(three!.resumed).toBeUndefined();
    expect(count(three!.prompt, "ANS-ONE")).toBe(1);
    expect(three!.prompt).not.toContain("QQ-TWO");
    expect(events.filter((e) => e.type === "warning").map((e) => e.type === "warning" && e.text))
      .toEqual([expect.stringMatching(/^Codex could not answer in this conversation's session \(codex exited with code 1.*\), so it is asked again in a new one, with the whole conversation\.$/)]);
  });

  it("forgets both agents' sessions when a stopped discussion ends without an answer", async () => {
    const chat = newChat();
    fake.setScenario({
      chat_codex: [{ answer: "ANS-ONE" }, { answer: "next" }], chat_claude: [{ answer: "ANS-TWO" }, { answer: "next" }],
      discuss_answer: [{ answer: "ABANDONED-DRAFT" }], discuss_critique: [{ pid: "agent.pid", sleep: 20_000, answer: "late\nVERDICT: AGREE" }],
    });
    await say(chat, "/codex QQ-ONE", "/claude QQ-TWO", "/codex");
    await chat.submit("/discuss ABANDONED-Q");
    await waitUntil(() => existsSync(join(repo, "agent.pid")), 10_000, "the reviewer to start");
    expect(fake.calls("discuss_answer")[0]!.resumed).toBe(fake.calls("chat_codex")[0]!.session);
    chat.escape();
    await chat.idle();
    expect(saved(chat).sessions).toEqual({});
    await say(chat, "/codex after", "/claude after");
    for (const backend of ["codex", "claude"]) {
      const next = fake.calls(`chat_${backend}`)[1]!;
      expect(next.resumed, backend).toBeUndefined();
      expect([count(next.prompt, "ANS-ONE"), count(next.prompt, "ANS-TWO")], backend).toEqual([1, 1]);
      expect(next.prompt, backend).not.toContain("ABANDONED");
    }
  });

  it("forgets the answerer's session too when a review fails and the discussion ends without an answer", async () => {
    const chat = newChat();
    fake.setScenario({ discuss_answer: [{ answer: "DISCARDED-DRAFT" }], discuss_critique: [{ answer: "", exit: 1 }], chat_codex: [{ answer: "next" }] });
    await say(chat, "/discuss DISCARDED-Q", "/codex after");
    expect(discussions()).toEqual([expect.objectContaining({ status: "error", answer: null })]);
    expect(fake.calls("chat_codex")[0]!.resumed).toBeUndefined();
    expect(saved(chat).sessions).toEqual({ codex: expect.objectContaining({ id: fake.calls("chat_codex")[0]!.session }) });
  });

  it("keeps no session on disk while a call continues it, so a conversation reopened after a crash starts a new one", async () => {
    const first = newChat({ conversationId: "crashed" });
    fake.setScenario({ chat_codex: [{ answer: "ANS-ONE" }, { pid: "agent.pid", sleep: 20_000, answer: "never recorded" }, { answer: "ANS-THREE" }] });
    await say(first, "/codex QQ-ONE");
    expect(saved(first).sessions.codex.id).toBe(fake.calls("chat_codex")[0]!.session);
    await first.submit("/codex QQ-TWO");
    await waitUntil(() => existsSync(join(repo, "agent.pid")), 10_000, "the answer to start");
    expect(saved(first).sessions.codex).toBeUndefined();
    // Another process takes the conversation on as its record stands, as after the first one was killed mid-answer.
    const second = newChat({ conversationId: "crashed" });
    await say(second, "/codex QQ-THREE");
    const three = fake.calls("chat_codex")[2]!;
    expect(three.resumed).toBeUndefined();
    expect(count(three.prompt, "ANS-ONE")).toBe(1);
    expect(three.prompt).not.toContain("QQ-TWO");
    first.escape();
    await first.idle();
  });

  it("says how many exchanges it left out when those a session has not seen exceed what a prompt carries", async () => {
    const chat = newChat();
    const big = (tag: string) => `${tag} ${"x".repeat(50_000)}`;
    fake.setScenario({ chat_claude: [{ answer: "k0" }, { answer: "k1" }], chat_codex: [{ answer: big("BIG-ONE") }, { answer: big("BIG-TWO") }, { answer: big("BIG-THREE") }] });
    await say(chat, "/claude zero", "/codex one", "/codex two", "/codex three", "/claude four");
    const next = fake.calls("chat_claude")[1]!;
    expect(next.resumed).toBe(fake.calls("chat_claude")[0]!.session);
    expect([next.prompt.includes("BIG-ONE"), next.prompt.includes("BIG-TWO"), next.prompt.includes("BIG-THREE")]).toEqual([false, true, true]);
    // Of the 2 exchanges no prompt carries any more, the session saw the first: 1 it never saw is left out.
    expect(next.prompt).toContain("(1 older exchange(s) are left out.)");
  });

  it("gives a continued call the settings changed since the session's last turn", async () => {
    const chat = newChat();
    fake.setScenario({ chat_codex: [{ answer: "a" }, { answer: "b" }], chat_claude: [{ answer: "c" }, { answer: "d" }] });
    await say(chat, "/codex one", "/claude two", "/settings codex model gpt-changed", "/settings claude model opus-changed", "/mode acceptEdits", "/codex three", "/claude four");
    const codex = fake.calls("chat_codex")[1]!;
    expect(codex.resumed).toBe(fake.calls("chat_codex")[0]!.session);
    expect(codex.args.slice(codex.args.indexOf("--model"), codex.args.indexOf("--model") + 2)).toEqual(["--model", "gpt-changed"]);
    expect(codex.args.indexOf("--model")).toBeLessThan(codex.args.indexOf("resume"));
    const claude = fake.calls("chat_claude")[1]!;
    expect(claude.resumed).toBe(fake.calls("chat_claude")[0]!.session);
    expect(after(claude.args, "--model")).toBe("opus-changed");
    expect(after(claude.args, "--permission-mode")).toBe("acceptEdits");
  });

  it("passes a backend's own no-persistence flag once, resumes nothing and saves no session", async () => {
    const cfg = testConfig(fake);
    cfg.codex.args = ["--ephemeral"];
    cfg.claude.args = ["--no-session-persistence"];
    const chat = newChat({ cfg });
    fake.setScenario({ chat_codex: [{ answer: "a" }, { answer: "b" }], chat_claude: [{ answer: "c" }, { answer: "d" }] });
    await say(chat, "/codex one", "/codex two", "/claude three", "/claude four");
    for (const call of fake.calls()) {
      expect(call.resumed).toBeUndefined();
      expect(call.args.filter((a) => a === "--ephemeral" || a === "--no-session-persistence")).toHaveLength(1);
    }
    expect(saved(chat).sessions).toEqual({});
  });

  it("sends the image of a continued question with the continued call, and with each continued step of a discussion", async () => {
    const chat = newChat();
    fake.setScenario({ chat_codex: [{ answer: "a" }, { answer: "b" }], chat_claude: [{ answer: "c" }], discuss_answer: [{ answer: "v1" }], discuss_critique: [{ answer: "ok\nVERDICT: AGREE" }] });
    await say(chat, "/codex one", "/claude two");
    const file = join(t.path, "shot.png");
    writeFileSync(file, png(4, 4));
    chat.attach(file);
    await say(chat, "/codex look");
    const look = fake.calls("chat_codex")[1]!;
    expect(look.resumed).toBe(fake.calls("chat_codex")[0]!.session);
    expect(look.images).toHaveLength(1);
    chat.attach(file);
    await chat.submitDiscuss("look again");
    await chat.idle();
    for (const step of ["discuss_answer", "discuss_critique"]) {
      expect(fake.calls(step)[0]!.resumed, step).toBeTruthy();
      expect(fake.calls(step)[0]!.images, step).toHaveLength(1);
    }
  });
});

const discussions = () => events.flatMap((e) => (e.type === "discussion.finished" ? [e] : []));

describe("Chat: /discuss", () => {
  const discussions = () => events.flatMap((e) => (e.type === "discussion.finished" ? [e] : []));
  const steps = () => fake.calls().map((c) => `${c.role}:${c.backend}`);
  const record = (chat: Chat) => JSON.parse(readFileSync(join(runsDir, "conversations", chat.conversationId, "conversation.json"), "utf8"));

  it("has the recipient answer and the other agent review, then Codex synthesize the response", async () => {
    const chat = newChat();
    fake.setScenario({
      discuss_answer: [{ answer: "Use Postgres with SKIP LOCKED." }], discuss_critique: [{ answer: "Right, and it keeps one store.\nVERDICT: AGREE" }],
      discuss_synthesis: [{ answer: "SYNTHESIS: Postgres, one store for jobs and data." }],
    });
    await chat.submit("/discuss Redis or Postgres for the job queue?");
    expect(ui.statuses.at(-1)).toBe("answering");
    await chat.idle();
    expect(steps()).toEqual(["discuss_answer:codex", "discuss_critique:claude", "discuss_synthesis:codex"]);
    expect(fake.calls("discuss_critique")[0]!.prompt).toContain("Use Postgres with SKIP LOCKED.");
    const synthesis = fake.calls("discuss_synthesis")[0]!.prompt;
    expect(synthesis).toContain("[agentduo-discussion: synthesis, round 1 of 3]");
    for (const part of ["You are Codex", "Right, and it keeps one store.", "(verdict: AGREE)"]) expect(synthesis).toContain(part);
    expect(discussions()).toEqual([expect.objectContaining({
      status: "agreed", answerer: "codex", critic: "claude", rounds: 1, answer: "SYNTHESIS: Postgres, one store for jobs and data.", answerBackend: "codex", error: null,
    })]);
    expect(events.find((e) => e.type === "discussion.started")).toMatchObject({ question: "Redis or Postgres for the job queue?", maxRounds: 3 });
    // A review is shown without its VERDICT line, which its verdict says.
    expect(answers().map((a) => a.discussion)).toEqual([
      expect.objectContaining({ step: "answer", round: 1 }), expect.objectContaining({ step: "critique", round: 1, verdict: "agree" }),
      expect.objectContaining({ step: "synthesis", round: 1 }),
    ]);
    expect(answers()[1]!.answer).toBe("Right, and it keeps one store.");
    // The discussion's usage adds up its turns, the synthesis too.
    expect(discussions()[0]!.tokens).toBe(answers().reduce((n, a) => n + (a.tokens ?? 0), 0));
    expect(answers()[2]!.tokens).toBeGreaterThan(0);
    expect(ui.statuses.at(-1)).toBe("idle");

    // What came of it is context for what follows; the drafts and reviews are not.
    fake.setScenario({ chat_claude: [{ answer: "ok" }] });
    await chat.submit("/claude And the retries?");
    await chat.idle();
    const next = fake.calls("chat_claude")[0]!.prompt;
    expect(next.split("SYNTHESIS: Postgres, one store for jobs and data.")).toHaveLength(2);
    expect(next).toContain("**Codex, after discussing it with Claude Code:**");
    expect(next).not.toContain("Use Postgres with SKIP LOCKED.");
    expect(next).not.toContain("it keeps one store");
  });

  it("revises until the reviewer agrees, each version seeing the discussion so far, and Codex synthesizes it all for Claude's question", async () => {
    let chat = newChat({ conversationId: "conv-d" });
    await chat.submit("/claude");
    fake.setScenario({
      discuss_answer: [{ answer: "v1: Redis." }], discuss_revise: [{ answer: "v2: Postgres." }],
      discuss_critique: [{ answer: "Redis loses jobs on a restart here.\nVERDICT: REVISE" }, { answer: "Good now.\nVERDICT: AGREE" }],
      discuss_synthesis: [{ answer: "SYNTHESIS: Postgres, since Redis loses jobs on a restart." }], chat_claude: [{ answer: "ok" }],
    });
    await chat.submit("/discuss Which queue?");
    await chat.idle();
    // Agreement after r reviews: 2r + 1 calls.
    expect(steps()).toEqual(["discuss_answer:claude", "discuss_critique:codex", "discuss_revise:claude", "discuss_critique:codex", "discuss_synthesis:codex"]);
    const revise = fake.calls("discuss_revise")[0]!.prompt;
    expect(revise).not.toContain("v1: Redis.");
    expect(fake.calls("discuss_revise")[0]!.resumed).toBe(fake.calls("discuss_answer")[0]!.session);
    expect(revise).toContain("Redis loses jobs on a restart here.");
    expect(fake.calls("discuss_critique")[1]!.prompt).toContain("v2: Postgres.");
    const synthesis = fake.calls("discuss_synthesis")[0]!.prompt;
    expect(synthesis).toContain("[agentduo-discussion: synthesis, round 2 of 3]");
    expect(synthesis).toContain("You are Codex");
    expect(fake.calls("discuss_synthesis")[0]!.resumed).toBe(fake.calls("discuss_critique")[0]!.session);
    for (const old of ["v1: Redis.", "v2: Postgres.", "Good now."]) expect(synthesis).not.toContain(old);
    expect(synthesis).toContain("agreed with version 2");
    expect(discussions()[0]).toMatchObject({
      status: "agreed", answerer: "claude", critic: "codex", rounds: 2, answer: "SYNTHESIS: Postgres, since Redis loses jobs on a restart.", answerBackend: "codex",
    });
    expect(record(chat).exchanges).toEqual([{ backend: "codex", question: "Which queue?", answer: "SYNTHESIS: Postgres, since Redis loses jobs on a restart.", discussedWith: "claude" }]);
    await chat.stop();

    // Reopened, the conversation carries the synthesis only, as Codex's.
    chat = newChat({ conversationId: "conv-d" });
    await chat.submit("And the retries?");
    await chat.idle();
    const next = fake.calls("chat_claude")[0]!.prompt;
    expect(next).toContain("**Codex, after discussing it with Claude Code:**\nSYNTHESIS: Postgres, since Redis loses jobs on a restart.");
    for (const draft of ["v1: Redis.", "v2: Postgres.", "Good now."]) expect(next).not.toContain(draft);
  });

  it("when the last review still asks for changes, has Codex synthesize the answer with what is still disputed, and no final version", async () => {
    const cfg = testConfig(fake);
    cfg.limits.max_discussion_rounds = 2;
    const chat = newChat({ cfg });
    fake.setScenario({
      discuss_answer: [{ answer: "v1" }], discuss_critique: [{ answer: "No.\nVERDICT: REVISE" }], discuss_revise: [{ answer: "v2" }],
      discuss_synthesis: [{ answer: "SYNTHESIS, and Còn bất đồng" }],
    });
    await chat.submit("/discuss A hard question?");
    await chat.idle();
    // The reviews run out after N: 2N + 1 calls.
    expect(fake.calls().map((c) => c.role)).toEqual(["discuss_answer", "discuss_critique", "discuss_revise", "discuss_critique", "discuss_synthesis"]);
    expect(fake.calls("discuss_final")).toHaveLength(0);
    const synthesis = fake.calls("discuss_synthesis")[0]!.prompt;
    expect(synthesis).toContain("still asked for changes after 2 review(s)");
    expect(synthesis).toContain("Còn bất đồng");
    expect(discussions()[0]).toMatchObject({ status: "disputed", rounds: 2, answer: "SYNTHESIS, and Còn bất đồng", answerBackend: "codex" });
  });

  it("takes a review without a VERDICT line as REVISE, and says so, to the synthesis too", async () => {
    const chat = newChat();
    fake.setScenario({
      discuss_answer: [{ answer: "v1" }], discuss_critique: [{ answer: "Hmm, maybe." }, { answer: "Fine.\nVERDICT: AGREE" }], discuss_revise: [{ answer: "v2" }],
      discuss_synthesis: [{ answer: "SYNTHESIS" }],
    });
    await chat.submit("/discuss Q?");
    await chat.idle();
    expect(events.some((e) => e.type === "warning" && e.text.includes("no VERDICT"))).toBe(true);
    expect(answers()[1]!.discussion).toMatchObject({ step: "critique", verdict: null });
    expect(fake.calls("discuss_revise")[0]!.prompt).toContain("Hmm, maybe.\n");
    expect(fake.calls("discuss_revise")[0]!.prompt).toContain("(verdict: none given, taken as REVISE)");
    expect(discussions()[0]).toMatchObject({ status: "agreed", rounds: 2, answer: "SYNTHESIS" });
  });

  it("gives the latest version as the response when the synthesis fails, by its own author, and says so", async () => {
    const cfg = testConfig(fake);
    cfg.limits.max_discussion_rounds = 1;
    const chat = newChat({ cfg });
    await chat.submit("/claude");
    fake.setScenario({
      discuss_answer: [{ answer: "v1 from Claude" }], discuss_critique: [{ answer: "Not quite.\nVERDICT: REVISE" }],
      discuss_synthesis: [{ answer: "HALF-WRITTEN SYNTHESIS", exit: 1 }], chat_codex: [{ answer: "ok" }],
    });
    await chat.submit("/discuss Which queue?");
    await chat.idle();
    expect(steps()).toEqual(["discuss_answer:claude", "discuss_critique:codex", "discuss_synthesis:codex", "discuss_synthesis:codex"]);
    expect(answers()[2]).toMatchObject({ status: "error", discussion: expect.objectContaining({ step: "synthesis" }) });
    // Codex reviewed, so its synthesis continues that session first, then tries a new one.
    expect(events.filter((e) => e.type === "warning").map((e) => e.type === "warning" && e.text)).toEqual([
      expect.stringMatching(/^Codex could not answer in this conversation's session \(.+\), so it is asked again in a new one, with the whole conversation\.$/),
      expect.stringMatching(/^Codex could not synthesize the discussion \(.+\), so the response is Claude's version 1\.$/),
    ]);
    expect(discussions()[0]).toMatchObject({ status: "disputed", rounds: 1, answer: "v1 from Claude", answerBackend: "claude", error: null });
    expect(record(chat).exchanges).toEqual([{ backend: "claude", question: "Which queue?", answer: "v1 from Claude", discussedWith: "codex" }]);
    await chat.submit("/codex Next?");
    await chat.idle();
    const next = fake.calls("chat_codex")[0]!.prompt;
    expect(next).toContain("**Claude Code, after discussing it with Codex:**\nv1 from Claude");
    expect(next).not.toContain("HALF-WRITTEN SYNTHESIS");
    expect(fake.calls("chat_codex")[0]!.resumed).toBeUndefined();
  });

  it("stops at Esc keeping nothing, and turns other questions away meanwhile", async () => {
    const chat = newChat();
    fake.setScenario({
      discuss_answer: [{ answer: "v1" }], discuss_critique: [{ pid: "agent.pid", sleep: 20_000, answer: "late\nVERDICT: AGREE" }], chat_codex: [{ answer: "next" }],
    });
    await chat.submit("/discuss A slow question?");
    await waitUntil(() => existsSync(join(repo, "agent.pid")), 10_000, "the reviewer to start");
    await chat.submit("/codex meanwhile?");
    expect(ui.lines.at(-1)).toContain("discussing");
    chat.escape();
    await chat.idle();
    expect(discussions()).toEqual([expect.objectContaining({ status: "interrupted", answer: null, rounds: 1 })]);
    expect(fake.calls("discuss_synthesis")).toHaveLength(0);
    expect(ui.statuses.at(-1)).toBe("idle");
    await chat.submit("/codex after?");
    await chat.idle();
    expect(fake.calls("chat_codex")).toHaveLength(1);
    expect(fake.calls("chat_codex")[0]!.prompt).not.toContain("A slow question?");
    // Codex's session has the question and its version 1: it is not continued either.
    expect(fake.calls("chat_codex")[0]!.resumed).toBeUndefined();
  });

  it("stops at Esc during the synthesis, keeping neither it nor the agreed version", async () => {
    const chat = newChat();
    fake.setScenario({
      discuss_answer: [{ answer: "AGREED VERSION" }], discuss_critique: [{ answer: "Yes.\nVERDICT: AGREE" }],
      discuss_synthesis: [{ pid: "agent.pid", sleep: 20_000, answer: "late synthesis" }], chat_codex: [{ answer: "next" }],
    });
    await chat.submit("/discuss A slow synthesis?");
    await waitUntil(() => existsSync(join(repo, "agent.pid")), 10_000, "the synthesis to start");
    chat.escape();
    await chat.idle();
    expect(answers().at(-1)).toMatchObject({ status: "interrupted", discussion: expect.objectContaining({ step: "synthesis" }) });
    expect(discussions()).toEqual([expect.objectContaining({ status: "interrupted", answer: null, rounds: 1, error: null })]);
    expect(events.some((e) => e.type === "warning" && e.text.includes("could not synthesize"))).toBe(false);
    expect(record(chat).exchanges).toEqual([]);
    await chat.submit("/codex after?");
    await chat.idle();
    expect(fake.calls("chat_codex")[0]!.prompt).not.toContain("AGREED VERSION");
  });

  it("starts no synthesis once Esc came between the last review and it", async () => {
    const chat = newChat();
    fake.setScenario({ discuss_answer: [{ answer: "v1" }], discuss_critique: [{ answer: "Yes.\nVERDICT: AGREE" }] });
    bus.on((e) => {
      if (e.type === "turn.finished" && e.discussion?.step === "critique") chat.escape();
    });
    await chat.submit("/discuss Q?");
    await chat.idle();
    expect(steps()).toEqual(["discuss_answer:codex", "discuss_critique:claude"]);
    expect(discussions()).toEqual([expect.objectContaining({ status: "interrupted", answer: null, rounds: 1 })]);
  });

  it("keeps no synthesis that finished once Esc came, and ends interrupted", async () => {
    const chat = newChat();
    fake.setScenario({
      discuss_answer: [{ answer: "v1" }], discuss_critique: [{ answer: "Yes.\nVERDICT: AGREE" }],
      discuss_synthesis: [{ answer: "SYNTHESIS" }], chat_codex: [{ answer: "next" }],
    });
    bus.on((e) => {
      if (e.type === "turn.finished" && e.discussion?.step === "synthesis") chat.escape();
    });
    await chat.submit("/discuss Q?");
    await chat.idle();
    expect(steps()).toEqual(["discuss_answer:codex", "discuss_critique:claude", "discuss_synthesis:codex"]);
    expect(answers().at(-1)).toMatchObject({ status: "success", discussion: expect.objectContaining({ step: "synthesis" }) });
    expect(discussions()).toEqual([expect.objectContaining({ status: "interrupted", answer: null, rounds: 1, error: null })]);
    expect(record(chat).exchanges).toEqual([]);
    await chat.submit("/codex after?");
    await chat.idle();
    const next = fake.calls("chat_codex")[0]!.prompt;
    expect(next).not.toContain("SYNTHESIS");
    expect(next).not.toContain("v1");
    // The session that wrote the synthesis Esc threw away is not continued.
    expect(fake.calls("chat_codex")[0]!.resumed).toBeUndefined();
  });

  it("ends with the error of a turn that failed, keeping nothing, and with no synthesis", async () => {
    const chat = newChat();
    fake.setScenario({ discuss_answer: [{ answer: "", exit: 1 }] });
    await chat.submit("/discuss Q?");
    await chat.idle();
    expect(discussions()[0]).toMatchObject({ status: "error", answer: null, rounds: 0, error: expect.any(String) });
    expect(fake.calls("discuss_critique")).toHaveLength(0);
    expect(fake.calls("discuss_synthesis")).toHaveLength(0);

    fake.setScenario({ discuss_answer: [{ answer: "v1" }], discuss_critique: [{ answer: "", exit: 1 }] });
    await chat.submit("/discuss Again?");
    await chat.idle();
    expect(discussions()[1]).toMatchObject({ status: "error", answer: null, rounds: 1, error: expect.any(String) });
    expect(fake.calls("discuss_synthesis")).toHaveLength(0);
  });
});

describe("Chat: /usage", () => {
  /** A screen with a usage panel: it gets every state of the report. */
  class PanelUi extends FakeUi {
    readonly reports: UsageReport[] = [];
    usage(report: UsageReport): void {
      this.reports.push(report);
    }
  }
  const settled = (r?: UsageReport) => !!r && r.claude.status !== "loading" && r.codex.status !== "loading";

  it("opens the panel at once, fills in each agent's part as it answers, and calls no model", async () => {
    const panel = new PanelUi();
    ui = panel;
    const chat = newChat();
    await chat.submit("/usage");
    expect(panel.reports[0]).toEqual({ id: expect.any(Number), claude: { status: "loading" }, codex: { status: "loading" } });
    await waitUntil(() => settled(panel.reports.at(-1)), 10_000, "both parts of the usage");
    const last = panel.reports.at(-1)!;
    expect(last.id).toBe(panel.reports[0]!.id);
    expect(last.claude).toMatchObject({ status: "ready", usage: { account: "Max", email: "fake@anthropic.example", groups: [{ limits: [{ label: "Current session", usedPercent: 10 }] }] } });
    expect(last.codex).toMatchObject({ status: "ready", usage: { account: "ChatGPT Plus", email: "fake@example.com" } });
    expect(panel.reports).toHaveLength(3);
    expect(fake.calls()).toEqual([]);
    expect(ui.lines).toEqual([]);
  });

  it("shows why one part is missing, and the other part still", async () => {
    const panel = new PanelUi();
    ui = panel;
    const chat = newChat();
    fake.setScenario({ usage: { claude: { exit: 1, stderr: "Not logged in" } } });
    await chat.submit("/usage");
    await waitUntil(() => settled(panel.reports.at(-1)), 10_000, "both parts of the usage");
    expect(panel.reports.at(-1)).toMatchObject({ claude: { status: "error", error: "claude -p /usage failed (exit code 1): Not logged in" }, codex: { status: "ready" } });
  });

  it("gives a screen without a usage panel the report as text once both parts are in", async () => {
    const chat = newChat();
    await chat.submit("/usage");
    await waitUntil(() => ui.lines.length > 0, 10_000, "the usage text");
    expect(ui.lines).toHaveLength(1);
    expect(ui.lines[0]).toMatch(/^── usage ──\nClaude Code · Max · fake@anthropic\.example\n {2}Current session\n[\s\S]*Codex · ChatGPT Plus · fake@example\.com\n {2}5h limit/);
  });

  it("asks again on a refresh, whose report replaces the earlier one, which never shows again", async () => {
    const panel = new PanelUi();
    ui = panel;
    const chat = newChat();
    fake.setScenario({ usage: { claude: { sleep: 1500 } } });
    await chat.submit("/usage");
    chat.usage();
    await waitUntil(() => settled(panel.reports.at(-1)), 10_000, "both parts of the usage");
    await new Promise((r) => setTimeout(r, 300));
    const [first, second] = [panel.reports[0]!.id, panel.reports[1]!.id];
    expect(second).toBeGreaterThan(first);
    expect(panel.reports.slice(1).map((r) => r.id)).toEqual(panel.reports.slice(1).map(() => second));
    expect(panel.reports.at(-1)).toMatchObject({ claude: { status: "ready" }, codex: { status: "ready" } });
  });

  it("gives each report an id later than any earlier chat's, so a view never takes a new one for an old one", async () => {
    const panel = new PanelUi();
    ui = panel;
    newChat().usage();
    newChat().usage();
    const [a, b] = panel.reports.map((r) => r.id);
    expect(b).toBeGreaterThan(a!);
  });

  it("leaves an answer that is going alone", async () => {
    const panel = new PanelUi();
    ui = panel;
    const chat = newChat();
    fake.setScenario({ chat_codex: [{ sleep: 1500, answer: "done thinking" }] });
    await chat.submit("Think about it");
    await chat.submit("/usage");
    await waitUntil(() => settled(panel.reports.at(-1)), 10_000, "both parts of the usage");
    expect(panel.statuses.at(-1)).toBe("answering");
    await chat.idle();
    expect(answers()).toEqual([expect.objectContaining({ status: "success", answer: "done thinking" })]);
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
    fake.setScenario({ chat_codex: [{ pid: "agent.pid", sleep: 20_000, answer: "too late" }] });
    const t0 = Date.now();
    await chat.submit("Think hard");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(ui.statuses.at(-1)).toBe("answering");
    await waitUntil(() => existsSync(join(repo, "agent.pid")), 10_000, "the agent to start");
    const agent = Number(readFileSync(join(repo, "agent.pid"), "utf8"));
    expect(pidAlive(agent)).toBe(true);
    await chat.submit("/codex another question"); // busy, not queued and not a note
    expect(ui.lines.at(-1)).toContain("still answering");
    chat.escape();
    await chat.idle();
    await waitUntil(() => !pidAlive(agent), 5000, "the agent to die");
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

  it("answers, discusses and runs a pipeline outside a git repository, with its snapshots in agentduo's own repository", async () => {
    const plain = join(t.path, "plain");
    mkdirSync(plain);
    const plainRuns = join(plain, ".agentduo", "runs");
    const data = join(t.path, "data");
    // No gate: check.mjs lives in the repository the other tests use.
    const chat = new Chat({ cfg: testConfig(fake, { gates: [] }), workspace: plain, runsDir: plainRuns, configFile: join(plain, ".agentduo", "config.yaml"),
      userConfigFile: userConfig(), bus, decider: new ScriptedDecider(), ui, env: { ...process.env, ...userDataEnv(data) } });
    chats.push(chat);
    await chat.greet();
    expect(ui.lines).toContain(NOT_REPO_NOTE);
    fake.setScenario({
      ...happy(), chat_codex: [{ answer: "Hi." }],
      discuss_answer: [{ answer: "Use Postgres." }], discuss_critique: [{ answer: "Agreed.\nVERDICT: AGREE" }], discuss_synthesis: [{ answer: "Postgres." }],
    });
    await chat.submit("Hello?");
    await chat.idle();
    expect(answers()).toEqual([expect.objectContaining({ backend: "codex", status: "success", answer: "Hi." })]);
    // `codex exec` refuses to start outside a repository without it.
    expect(argsOf("chat_codex")).toContain("--skip-git-repo-check");
    await chat.submit("/discuss Redis or Postgres?");
    await chat.idle();
    expect(events.find((e) => e.type === "discussion.finished")).toMatchObject({ status: "agreed", answer: "Postgres." });
    expect(argsOf("discuss_critique")).not.toContain("--skip-git-repo-check"); // Claude needs no such flag

    // No `git init`: the run's snapshots go to a repository of agentduo's own, and every Codex call says to start anyway.
    await chat.submit("/pipeline Make app.txt fixed");
    await chat.idle();
    const [first] = RunStore.list(plainRuns);
    expect([first!.phase, first!.git?.mode]).toEqual(["DONE", "internal"]);
    expect(first!.git).toMatchObject({ gitDir: expect.stringContaining(join(data, "agentduo", "repositories")) });
    expect(existsSync(join(plain, ".git"))).toBe(false);
    for (const role of ["planner", "plan_finalizer", "code_reviewer"]) expect(argsOf(role)).toContain("--skip-git-repo-check");
    expect(argsOf("implementer")).not.toContain("--skip-git-repo-check");
    expect(events.some((e) => e.type === "warning" && e.text.includes("agentduo's own Git repository"))).toBe(true);
    await chat.submit("/diff");
    expect(ui.lines.at(-1)).toMatch(/── diff stat ──\n app\.txt \| 1 \+/);

    // Checked each time: once the folder is a repository, the next /pipeline snapshots in it, without the flag.
    execFileSync("git", ["init", "-q"], { cwd: plain });
    const planned = fake.calls("planner").length;
    await chat.submit("/pipeline Make app.txt fixed");
    await chat.idle();
    expect(RunStore.list(plainRuns).map((st) => [st.phase, st.git?.mode])).toEqual([["DONE", "internal"], ["DONE", "native"]]);
    expect(argsOf("planner", planned)).not.toContain("--skip-git-repo-check");
  });

  it("in the home folder (VS Code with no folder open), says a pipeline needs a project folder, never to git init the home", async () => {
    const home = join(t.path, "home");
    mkdirSync(home);
    const chat = new Chat({ cfg: testConfig(fake, { gates: [] }), workspace: home, runsDir: join(home, ".agentduo", "runs"), configFile: join(home, ".agentduo", "config.yaml"),
      userConfigFile: userConfig(), bus, decider: new ScriptedDecider(), ui, env: { ...process.env, HOME: home } });
    chats.push(chat);
    await chat.greet();
    expect(ui.lines).toContain(HOME_NOTE);
    expect(ui.lines).not.toContain(NOT_REPO_NOTE);
    await chat.submit("/pipeline Make app.txt fixed");
    expect(ui.errors).toEqual([`A pipeline run cannot start here: ${home} is your home folder: run the pipeline from a project folder (it needs no git repository)`]);
    expect(RunStore.list(join(home, ".agentduo", "runs"))).toEqual([]);
  });

  it("without Git, answers questions and says a pipeline needs it", async () => {
    const plain = join(t.path, "plain");
    mkdirSync(plain);
    const empty = join(t.path, "no-git-bin");
    mkdirSync(empty);
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== "PATH")), PATH: empty };
    const chat = new Chat({ cfg: testConfig(fake, { gates: [] }), workspace: plain, runsDir: join(plain, ".agentduo", "runs"), configFile: join(plain, ".agentduo", "config.yaml"),
      userConfigFile: userConfig(), bus, decider: new ScriptedDecider(), ui, env });
    chats.push(chat);
    await chat.greet();
    expect(ui.lines).toContain(GIT_MISSING);
    fake.setScenario({ chat_codex: [{ answer: "Hi." }] });
    await chat.submit("Hello?");
    await chat.idle();
    expect(answers()).toEqual([expect.objectContaining({ status: "success", answer: "Hi." })]);
    await chat.submit("/pipeline Make app.txt fixed");
    expect(ui.errors).toEqual([`A pipeline run cannot start here: ${GIT_MISSING}`]);
    expect(existsSync(join(plain, ".agentduo", "runs", "LATEST"))).toBe(false);
  });

  it("gives Claude in the chat the implementer's permission mode (/mode, Shift+Tab), and no other implementer flag", async () => {
    const cfg = testConfig(fake);
    cfg.claude.role_args.implementer = ["--max-turns", "5"];
    const chat = newChat({ cfg });
    await chat.submit("/mode acceptEdits");
    await chat.submit("/claude edit app.txt please");
    await chat.idle();
    const args = argsOf("chat_claude");
    expect(after(args, "--permission-mode")).toBe("acceptEdits");
    expect(args).not.toContain("--max-turns");
    chat.cycleMode();
    await chat.submit("/claude again");
    await chat.idle();
    expect(after(argsOf("chat_claude", 1), "--permission-mode")).toBe("auto");
    chat.cycleMode();
    await chat.submit("/claude once more");
    await chat.idle();
    expect(argsOf("chat_claude", 2)).not.toContain("--permission-mode");
    expect(ui.lines.some((l) => l.includes("Mode: Auto") && l.includes("in the chat and as the pipeline's implementer"))).toBe(true);
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
    for (const role of ["planner", "plan_reviewer", "code_reviewer"]) {
      const prompt = fake.calls(role).at(-1)!.prompt;
      expect(prompt, role).toContain("## Conversation before this task");
      expect(prompt, role).toContain("How should the second task be done?");
      expect(prompt, role).toContain("Use a constant for the word fixed.");
      expect(prompt.match(/Make app\.txt fixed — done/g), role).toHaveLength(1);
    }
    // The second run's implementer goes on in that run's critic session (never the first run's), which has all of it already.
    const implementer = fake.calls("implementer").at(-1)!;
    expect(implementer.resumed).toBe(fake.calls("plan_reviewer").at(-1)!.session);
    expect(implementer.resumed).not.toBe(fake.calls("plan_reviewer")[0]!.session);
    expect(implementer.prompt).not.toContain("## Conversation before this task");
    expect(implementer.prompt).not.toContain("Make app.txt fixed — done");
    // Plan sign-off continues the second run's planner session (never the first run's), which has all of it already.
    expect(fake.calls("plan_finalizer").at(-1)!.resumed).toBe(fake.calls("planner").at(-1)!.session);
    expect(fake.calls("plan_finalizer").at(-1)!.prompt).not.toContain("## Conversation before this task");
    expect(fake.calls("planner").at(-1)!.resumed).toBeUndefined();
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
    expect(ui.lines.at(-1)).toContain("usage: /pipeline [--profile lightweight|standard|thorough] <task>");
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

  it("switches the implementer's permission mode with /mode or Shift+Tab, for this chat only", async () => {
    const chat = newChat();
    await chat.greet();
    expect(ui.modes.at(-1)).toBe("manual");
    await chat.submit("/mode acceptEdits");
    expect(ui.modes.at(-1)).toBe("acceptEdits");
    expect(ui.lines.at(-1)).toContain("Mode: Edit automatically");
    expect(ui.lines.at(-1)).toContain("this chat only");
    fake.setScenario(happy());
    await chat.submit("/pipeline Make app.txt fixed");
    await chat.idle();
    expect(after(argsOf("implementer"), "--permission-mode")).toBe("acceptEdits");
    expect(argsOf("plan_reviewer")).not.toContain("--permission-mode");
    expect(JSON.parse(readFileSync(RunStore.open(runsDir).path("config.json"), "utf8")).claude.role_args.implementer).toEqual(["--permission-mode", "acceptEdits"]);
    chat.cycleMode();
    expect(ui.modes.at(-1)).toBe("auto");
    expect(ui.lines.at(-1)).toContain("Mode: Auto");
    expect(ui.lines.at(-1)).toContain("safety check");
    chat.cycleMode();
    expect(ui.modes.at(-1)).toBe("manual");
    await chat.submit("/mode");
    expect(ui.lines.at(-1)).toContain("Mode: Manual");
    await chat.submit("/mode sometimes");
    expect(ui.lines.at(-1)).toContain("/mode manual|acceptEdits|auto");
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
    await chat.submit("/mode acceptEdits --save");
    await chat.submit("/codex model gpt-5.5 --save");
    const text = readFileSync(join(repo, ".agentduo", "config.yaml"), "utf8");
    for (const s of ["# team settings", "acceptEdits", "model: gpt-5.5"]) expect(text).toContain(s);
    expect(ui.lines.at(-1)).toContain("saved to");
  });

  it("saves a change for every workspace with --global, and says when the workspace's config wins over it", async () => {
    const workspaceFile = join(repo, ".agentduo", "config.yaml");
    mkdirSync(join(repo, ".agentduo"), { recursive: true });
    writeFileSync(workspaceFile, "claude:\n  model: sonnet\n");
    const chat = newChat();
    await chat.submit("/claude effort high --global");
    expect(ui.lines.at(-1)).toBe(`Claude's effort: high.; saved to ${userConfig()}`);
    expect(readFileSync(userConfig(), "utf8")).toContain("--effort");
    expect(readFileSync(workspaceFile, "utf8")).toBe("claude:\n  model: sonnet\n");

    await chat.submit("/claude model opus --global");
    expect(ui.lines.at(-1)).toContain(`saved to ${userConfig()}, but ${workspaceFile} sets claude.model too, which wins in this workspace`);
    expect(chat.config.claude.model).toBe("opus");
    expect(readFileSync(userConfig(), "utf8")).toContain("model: opus");
    await chat.submit("/claude model opus --global --save");
    expect(ui.lines.at(-1)).toBe(`Claude's model: opus.; saved to ${workspaceFile} and ${userConfig()}`);

    await chat.submit("/config");
    expect(ui.lines.at(-1)).toContain(`--global (it writes ${userConfig()})`);
    await chat.submit("/codex model gpt-5.5");
    expect(ui.lines.at(-1)).toContain("--global in every workspace");
  });

  it("keeps a change it could not save, and says why", async () => {
    mkdirSync(join(t.path, "xdg", "agentduo"), { recursive: true });
    writeFileSync(userConfig(), "claude: [\n");
    const chat = newChat();
    await chat.submit("/codex model gpt-5.5 --global");
    expect(ui.lines.at(-1)).toMatch(new RegExp(`^Codex's model: gpt-5\\.5\\.; could not save it to ${userConfig().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `));
    expect(chat.config.codex.model).toBe("gpt-5.5");
  });

  it("lists every command with what it does", async () => {
    const chat = newChat();
    await chat.submit("/help");
    const help = ui.lines.at(-1)!;
    for (const command of ["/claude", "/codex", "/pipeline", "/plan", "/diff", "/status", "/usage", "/resume", "/new", "/quit", "Esc", "Shift+Tab", "/mode",
      "/settings claude model", "/settings claude effort", "/settings claude permissions", "/settings claude add-dir", "/settings codex model",
      "/settings codex permissions", "/claude -- <question>", "/config", "/help", "--save", "--global"]) {
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

describe("Chat: attached files", () => {
  /** A file of the user's, outside the workspace: a 64×32 PNG, or text. */
  const userFile = (name: string, data: Buffer | string = png(64, 32)) => {
    mkdirSync(join(t.path, "home"), { recursive: true });
    const path = join(t.path, "home", name);
    writeFileSync(path, data);
    return path;
  };
  const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  const shot = png(64, 32);
  const deciding = (act: () => Promise<void>, decision: Decision | "defer"): Decider => ({ decide: async () => {
    await act();
    return decision;
  } });

  it("sends the waiting files with the next message, natively and listed once, and keeps them with the exchange", async () => {
    const chat = newChat();
    await chat.submit(`/attach "${userFile("Ảnh chụp.png")}"`);
    // Spaces escaped, as a terminal writes a dropped file; Windows has no such escape (a backslash separates folders).
    const notes = userFile("notes.md", "# notes\n");
    await chat.submit(`/attach ${process.platform === "win32" ? `"${notes}"` : notes.replace(/ /g, "\\ ")}`);
    expect(ui.lines.at(-1)).toMatch(/^Attached notes\.md \(text\/markdown, 8 B\)\. The 2 files go with your next message/);
    await chat.submit("/attachments");
    expect(ui.lines.at(-1)).toBe("2 files go with your next message:\n  1. Ảnh chụp.png (PNG 64×32, " + shot.length + " B)\n  2. notes.md (text/markdown, 8 B)\n/detach <n|all> removes one, or all.");
    await chat.submit("What is in these?");
    await chat.idle();
    const call = fake.calls("chat_codex")[0]!;
    expect(call.images).toEqual([expect.objectContaining({ sha256: sha(shot) })]);
    expect(call.prompt.split(`${sep}attachments${sep}`).length - 1).toBe(2);
    expect(call.prompt).toContain("### Files the user attached to this message");
    expect(chat.pending).toEqual([]);
    expect(ui.sentFiles).toEqual([["Ảnh chụp.png", "notes.md"]]);
    expect(ui.waiting.at(-1)).toEqual([]);
    // The next question lists them as files of that earlier message, and attaches nothing.
    await chat.submit("And the second one?");
    await chat.idle();
    const next = fake.calls("chat_codex")[1]!;
    expect(next.images).toBeUndefined();
    expect(next.prompt).not.toContain("Files attached to that message (not attached again");
    expect(next.resumed).toBe(fake.calls("chat_codex")[0]!.session);
    const saved = JSON.parse(readFileSync(join(runsDir, "conversations", chat.conversationId, "conversation.json"), "utf8"));
    expect(saved.exchanges[0].attachments.map((a: Attachment) => a.name)).toEqual(["Ảnh chụp.png", "notes.md"]);
    expect(JSON.stringify(saved)).not.toContain(join(t.path, "home"));
  });

  it("sends files alone on Enter, and keeps them waiting through commands, a busy agent and a missing CLI", async () => {
    const chat = newChat();
    fake.setScenario({ chat: [{ answer: "slow", sleep: 1500 }, { answer: "ok" }] });
    await chat.submit("First?");
    await chat.submit(`/attach "${userFile("a.png")}"`);
    await chat.submit("/status");
    await chat.submit("Second?");
    expect(ui.lines.at(-1)).toContain("is still answering");
    expect(chat.pending.map((a) => a.name)).toEqual(["a.png"]);
    await chat.idle();
    await chat.submit("/claude look", { attachments: ["zz-not-here"] });
    expect(ui.errors.at(-1)).toContain("no longer waiting to be sent in this conversation");
    await chat.submit("");
    await chat.idle();
    const call = fake.calls("chat_codex")[1]!;
    expect(call.prompt).toContain("## The user's message to Codex\nLook at the attached file(s).\n");
    expect(call.images).toHaveLength(1);
    expect(chat.pending).toEqual([]);
    expect(chat.title).toBe("First?");
  });

  it("sends only the files a submit names (the extension's), leaving the others waiting", async () => {
    const chat = newChat();
    const a = chat.attach(userFile("a.png"));
    const b = chat.attach(userFile("b.txt", "b"));
    await chat.submit("Only the text file", { attachments: [b.id] });
    await chat.idle();
    expect(fake.calls("chat_codex")[0]!.images).toBeUndefined();
    expect(fake.calls("chat_codex")[0]!.prompt).toContain("b.txt");
    expect(chat.pending).toEqual([a]);
    await chat.submit("Nothing attached", { attachments: [] });
    await chat.idle();
    expect(fake.calls("chat_codex")[1]!.prompt).not.toContain("a.png");
    chat.detach(a.id, { quiet: true });
    expect(chat.pending).toEqual([]);
    expect(() => existingAttachmentFile(runsDir, a)).toThrow();
  });

  it("reads ~/ as the home directory, in quotes too, as /attach's usage line writes it", async () => {
    const chat = newChat();
    // The home directory: HOME, or USERPROFILE on Windows.
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = process.env.USERPROFILE = join(t.path, "home");
    try {
      userFile("My notes.pdf", "%PDF-1.4\n");
      await chat.submit('/attach "~/My notes.pdf"');
      await chat.submit("/attach ~/'My notes.pdf'");
      expect(chat.pending.map((a) => a.name)).toEqual(["My notes.pdf", "My notes.pdf"]);
      // An escaped ~ (on Windows, .\~) is a folder of the workspace.
      await chat.submit(process.platform === "win32" ? "/attach .\\~\\a.png" : "/attach \\~/a.png");
      expect(ui.errors.at(-1)).toContain(`${join(repo, "~", "a.png")}: no such file`);
      expect(ui.errors.at(-1)).not.toContain(join(t.path, "home"));
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("refuses directories and names what was wrong, and /detach and /new remove waiting files from disk", async () => {
    const chat = newChat();
    await chat.submit(`/attach "${t.path}"`);
    expect(ui.errors.at(-1)).toMatch(/is a directory/);
    await chat.submit("/attach 'missing.png'");
    expect(ui.errors.at(-1)).toMatch(/missing\.png: no such file/);
    const a = chat.attach(userFile("a.png"));
    const b = chat.attach(userFile("b.png"));
    await chat.submit("/detach 1");
    expect(ui.lines.at(-1)).toBe("Removed a.png.");
    expect(() => existingAttachmentFile(runsDir, a)).toThrow();
    await chat.submit("/new");
    expect(ui.lines.some((l) => l.startsWith("Removed 1 attached file that was not sent: b.png"))).toBe(true);
    expect(() => existingAttachmentFile(runsDir, b)).toThrow();
    expect(chat.pending).toEqual([]);
  });

  it("removes the files a crashed session left waiting, when its conversation is opened again, and keeps those sent", async () => {
    const before = new Conversation(runsDir, { id: "conv-crash" });
    const sent = before.stage(userFile("sent.png"));
    before.sent([sent]);
    const left = before.stage(userFile("left.png"));
    const chat = newChat({ conversationId: "conv-crash" });
    expect(chat.pending).toEqual([]);
    expect(() => existingAttachmentFile(runsDir, left)).toThrow();
    expect(existsSync(existingAttachmentFile(runsDir, sent))).toBe(true);
    await chat.stop();
  });

  it("gives every step of a discussion the question's files", async () => {
    const chat = newChat();
    chat.attach(userFile("chart.png"));
    await chat.submit("/discuss Is this chart right?");
    await chat.idle();
    const steps = fake.calls().map((c) => [c.backend, c.role, c.images?.length ?? 0]);
    expect(steps).toEqual([["codex", "discuss_answer", 1], ["claude", "discuss_critique", 1], ["codex", "discuss_synthesis", 1]]);
    expect(fake.calls("discuss_critique")[0]!.images![0]!.mediaType).toBe("image/png");
    expect(chat.pending).toEqual([]);
  });

  it("copies a task's files into its run, gives them to every role, and resumes without the original file or chat", async () => {
    const chat = newChat();
    const source = userFile("mockup.png");
    chat.attach(source);
    fake.setScenario({ ...happy(), implementer: [{ activities: [{ tool: "Read", input: { file_path: "app.txt" } }], sleep: 10_000, output: impl() }, { write: { "app.txt": "fixed\n" }, output: impl() }] });
    let escaped = false;
    bus.on((e) => {
      if (e.type === "agent.activity" && e.role === "implementer" && !escaped) {
        escaped = true;
        chat.escape();
      }
    });
    await chat.submit("/pipeline Make app.txt match the mockup");
    await chat.idle();
    const st = latest();
    expect(st.attachments).toEqual([expect.objectContaining({ name: "mockup.png", path: expect.stringMatching(new RegExp(`^${st.taskId}/attachments/`)) })]);
    rmSync(source);
    rmSync(join(runsDir, "conversations", chat.conversationId), { recursive: true });
    await chat.submit("/resume");
    await chat.idle();
    expect(latest().phase).toBe("DONE");
    const roles = fake.calls().map((c) => [c.role, c.images?.length ?? 0, c.images?.[0]?.sha256 === sha(shot)]);
    // Plan sign-off continues the planner's session, which has the file already. The implementer goes on in the critic's,
    // which has it too; the stopped attempt recorded nothing, so the resumed run goes on from the critic's turn again.
    expect(roles).toEqual([
      ["planner", 1, true], ["plan_reviewer", 1, true], ["plan_finalizer", 0, false], ["implementer", 0, false], ["implementer", 0, false], ["code_reviewer", 1, true],
    ]);
    for (const c of fake.calls()) expect(c.prompt.includes("### Files the user attached to the task"), c.role).toBe(!["plan_finalizer", "implementer"].includes(c.role));
    const critic = fake.calls("plan_reviewer")[0]!.session;
    expect(fake.calls("implementer").map((c) => c.resumed)).toEqual([critic, critic]);
    expect(latest().sessions!["plan_reviewer+implementer"]).toMatchObject({ id: critic, role: "implementer" });
  });

  it("gives a note's files to the steps after it, never to a decision, which leaves them waiting", async () => {
    const cfg = testConfig(fake, { limits: { max_review_rounds: 1 } });
    fake.setScenario({ ...happy(), code_reviewer: [{ output: review(false, [finding("F1")]) }, { output: review(true) }] });
    let chat: Chat;
    // At the decision: a file attached, then a message (a note, with it), then another file, then the decision.
    const decider = deciding(async () => {
      chat.attach(userFile("fix.png"));
      expect(ui.lines.at(-1)).toContain("do not go with a decision");
      await chat.submit("Make it look like this");
      chat.attach(userFile("later.txt", "later"));
    }, { decision: "resume", note: "go on" });
    chat = newChat({ cfg, decider });
    await chat.submit("/pipeline Make app.txt fixed");
    await chat.idle();
    expect(latest().phase).toBe("DONE");
    const notes = latest().humanNotes;
    expect(notes.map((n) => [n.note, n.attachments?.map((a) => a.name)])).toEqual([["Make it look like this", ["fix.png"]], ["go on", undefined]]);
    expect(fake.calls("implementer")[0]!.images).toBeUndefined();
    expect(fake.calls("implementer")[1]!.images).toHaveLength(1);
    expect(fake.calls("implementer")[1]!.prompt).toContain("Make it look like this\n  Files:");
    // The file attached after the note did not go with the decision.
    expect(chat.pending.map((a) => a.name)).toEqual(["later.txt"]);
  });

  it("gives /resume's note the waiting files, after a decision was put off", async () => {
    const cfg = testConfig(fake, { limits: { max_review_rounds: 1 } });
    fake.setScenario({ ...happy(), code_reviewer: [{ output: review(false, [finding("F1")]) }, { output: review(true) }] });
    const chat = newChat({ cfg, decider: new ScriptedDecider(["defer", { decision: "resume" }]) });
    await chat.submit("/pipeline Make app.txt fixed");
    await chat.idle();
    expect(latest().phase).toBe("HUMAN_REVIEW");
    chat.attach(userFile("spec.pdf", "%PDF-1.4\nMARKER\n"));
    await chat.submit("/resume follow the spec");
    await chat.idle();
    expect(latest().phase).toBe("DONE");
    const note = latest().humanNotes.at(-1)!;
    expect(note).toMatchObject({ note: "follow the spec", attachments: [expect.objectContaining({ name: "spec.pdf", path: expect.stringContaining(`${latest().taskId}/attachments/`) })] });
    expect(fake.calls("implementer")[1]!.prompt).toContain("spec.pdf");
    expect(chat.pending).toEqual([]);
  });
});


describe("Chat: the questions Claude asks the user", () => {
  const flag = {
    questions: [{
      question: "Which flag should the build use?", header: "Flag", multiSelect: false,
      options: [{ label: "--fast", description: "skips the slow checks" }, { label: "--safe", description: "keeps every check" }],
    }],
  };
  const pickSafe = (r: { questions: Array<{ id: string; options: Array<{ id: string; label: string }> }> }) =>
    ({ kind: "answered" as const, answers: r.questions.map((q) => ({ questionId: q.id, optionIds: [q.options.find((o) => o.label === "--safe")!.id], otherText: null })) });
  const say = async (chat: Chat, ...questions: string[]) => {
    for (const question of questions) {
      await chat.submit(question);
      await chat.idle();
    }
  };
  const count = (text: string, part: string) => text.split(part).length - 1;
  const saved = (chat: Chat) => JSON.parse(readFileSync(join(runsDir, "conversations", chat.conversationId, "conversation.json"), "utf8"));

  it("saves a question and its answer the moment they happen, keeps them with the exchange, and gives them to Codex in later prompts", async () => {
    const chat = newChat({ conversationId: "ask-1", clarifier: new ScriptedClarifier([pickSafe]) });
    // The answer's text never says what the user chose: only the saved question and answer can tell Codex.
    fake.setScenario({ chat_claude: [{ questions: [flag], answer: "Done: built it." }], chat_codex: [{ answer: "Noted." }] });
    await say(chat, "/claude Build it");
    const record = saved(chat);
    expect(record.clarifications).toMatchObject([{
      status: "answered", source: "claude", agent: "claude", questions: [{ question: "Which flag should the build use?" }], answers: [{ questionId: "q1", optionIds: ["q1o2"], otherText: null }],
    }]);
    expect(record.clarifications[0].turnId).toBe(record.exchanges.length ? `ask-1-t1` : "");
    expect(record.exchanges[0].clarified).toEqual([{ asker: "claude", header: "Flag", question: "Which flag should the build use?", answer: "--safe" }]);
    expect(fake.questionReplies()[0]).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Which flag should the build use?": "--safe" } } });
    expect(fake.calls("chat_claude")[0]!.prompt).toContain("You may use the AskUserQuestion tool");

    await say(chat, "/codex What did we pick?");
    const codex = fake.calls("chat_codex")[0]!.prompt;
    expect(codex).toContain("**Questions asked of the user while that was answered:**\n- Claude Code asked [Flag]: Which flag should the build use?\n  → The user answered: --safe");
    expect(count(codex, "--safe")).toBe(1);
    // Reopened, the conversation still has it, with the answer.
    const again = Conversation.open(runsDir, "ask-1");
    expect(again.clarifications.map((e) => [e.status, answerOf(e)])).toEqual([["answered", "--safe"]]);
    expect(events.filter((e) => e.type.startsWith("clarification.")).map((e) => e.type)).toEqual(["clarification.requested", "clarification.answered"]);
  });

  const answerOf = (e: { answers?: Array<{ optionIds: string[] }> }) => (e.answers?.[0]?.optionIds[0] === "q1o2" ? "--safe" : "?");

  it("keeps a question that was never answered as interrupted, and does not make an exchange of the turn it was in", async () => {
    const broker = new ClarificationBroker();
    const chat = newChat({ conversationId: "ask-2", clarifier: broker });
    fake.setScenario({ chat_claude: [{ questions: [flag], afterQuestion: 10_000, answer: "never" }] });
    await chat.submit("/claude Build it");
    await waitUntil(() => broker.pending().length === 1);
    expect(saved(chat).clarifications).toMatchObject([{ status: "pending" }]);
    // Esc while the question is open: the user answers nothing, the turn is stopped, and the process goes.
    chat.escape();
    await chat.idle();
    const finished = answers().at(-1)!;
    expect(finished.status).toBe("interrupted");
    expect(saved(chat).clarifications).toMatchObject([{ status: "interrupted" }]);
    expect(saved(chat).exchanges).toEqual([]);
    expect(broker.pending()).toEqual([]);
    expect(fake.questionReplies()).toEqual([]);
    expect(events.map((e) => e.type)).toContain("clarification.closed");

    // A conversation reopened after a crash: a question still pending belonged to a process that is gone.
    const file = join(runsDir, "conversations", "ask-2", "conversation.json");
    const record = JSON.parse(readFileSync(file, "utf8"));
    record.clarifications[0].status = "pending";
    delete record.clarifications[0].closedAt;
    writeFileSync(file, JSON.stringify(record));
    expect(Conversation.open(runsDir, "ask-2").clarifications.map((e) => e.status)).toEqual(["interrupted"]);
    expect(Conversation.open(runsDir, "ask-2").pendingClarification(record.clarifications[0].id)).toBeNull();
  });

  it("holds a pipeline step's question that the user put off: /resume asks it again, then runs the step with the answer", async () => {
    const asker = new ScriptedClarifier([{ kind: "defer" }, pickSafe]);
    const chat = newChat({ conversationId: "pipe-ask", clarifier: asker });
    fake.setScenario({
      ...happy(), implementer: [{ questions: [flag], afterQuestion: 5000, write: { "app.txt": "fixed\n" }, output: impl() }, { write: { "app.txt": "fixed\n" }, output: impl() }],
    });
    await say(chat, "/pipeline Make app.txt fixed");
    expect(latest().phase).toBe("HUMAN_REVIEW");
    expect(latest().humanReview).toMatchObject({ reason: "clarification_required", resumePhase: "IMPLEMENT" });
    expect(ui.lines.at(-1)).toContain("waiting for your answers");
    expect(fake.calls("implementer")).toHaveLength(1);
    // The run's question is not the conversation's: the chat's own ledger keeps none of it.
    expect(saved(chat).clarifications).toBeUndefined();
    await say(chat, "/resume");
    // Asked again before anything ran, as a request the user can answer or put off but not dismiss to the agent that is gone.
    expect(asker.seen).toHaveLength(2);
    expect(asker.seen[0]!.held).toBeUndefined();
    expect(asker.seen[1]).toMatchObject({ held: true, source: "claude", role: "implementer", id: asker.seen[0]!.id });
    expect(latest().phase).toBe("DONE");
    expect(fake.calls("implementer")).toHaveLength(2);
    expect(fake.calls("implementer")[1]!.prompt).toContain("Which flag should the build use?\n  → --safe");
  });

  it("says, when Esc stops a pipeline on a question, that /resume asks it first", async () => {
    const broker = new ClarificationBroker();
    const chat = newChat({ conversationId: "pipe-esc", clarifier: broker });
    fake.setScenario({ ...happy(), implementer: [{ questions: [flag], afterQuestion: 10_000, write: { "app.txt": "fixed\n" }, output: impl() }] });
    await chat.submit("/pipeline Make app.txt fixed");
    await waitUntil(() => broker.pending().length === 1);
    chat.escape();
    await chat.idle();
    expect(ui.lines.at(-1)).toContain("question of Claude's");
    expect(latest().humanReview).toMatchObject({ reason: "clarification_required", fromPhase: "IMPLEMENT" });
    expect(latest().clarifications).toMatchObject([{ status: "pending" }]);
  });

  describe("answers given in a turn that does not finish", () => {
    const pairLine = "Claude Code asked [Flag]: Which flag should the build use?\n  → The user answered: --safe";
    const noRetries = () => testConfig(fake, { limits: { max_retries: 0 } });

    it("keeps them when the turn fails afterwards, and gives them to the other agent, in this process and once it is reopened", async () => {
      const chat = newChat({ conversationId: "fail-1", cfg: noRetries(), clarifier: new ScriptedClarifier([pickSafe]) });
      // The failed turn never says what the user chose: only the saved answer can tell Codex.
      fake.setScenario({ chat_claude: [{ questions: [flag], exit: 1 }], chat_codex: [{ answer: "Noted." }, { answer: "Noted again." }] });
      await say(chat, "/claude Build it");
      expect(answers().at(-1)!.status).toBe("error");
      expect(fake.questionReplies()).toHaveLength(1);
      expect(saved(chat).exchanges).toEqual([{
        backend: "claude", question: "Build it", answer: "", unfinished: true,
        clarified: [{ asker: "claude", header: "Flag", question: "Which flag should the build use?", answer: "--safe" }],
      }]);
      await say(chat, "/codex What did we pick?");
      const codex = fake.calls("chat_codex")[0]!.prompt;
      expect(codex).toContain(pairLine);
      expect(codex).toContain("That turn did not finish");
      expect(count(codex, "--safe")).toBe(1);

      // Reopened, the conversation still passes it on, once: Codex's session was given it, so its continued prompt does not repeat it,
      // while Claude, whose failed turn kept no session, gets the whole conversation with it.
      fake.setScenario({ chat_claude: [{ answer: "Built." }], chat_codex: [{ answer: "Noted." }, { answer: "Noted again." }] });
      const again = newChat({ conversationId: "fail-1", cfg: noRetries() });
      await say(again, "/codex And now?");
      const later = fake.calls("chat_codex").at(-1)!;
      expect(later.resumed).toBeTruthy();
      expect(later.prompt).not.toContain("--safe");
      await say(again, "/claude Build it for real");
      const claude = fake.calls("chat_claude").at(-1)!;
      expect(claude.resumed).toBeUndefined();
      expect(count(claude.prompt, pairLine)).toBe(1);
    });

    it("gives the fresh session a continued turn falls back to the answers it was given before it failed, and does not repeat them to that session later", async () => {
      const chat = newChat({ conversationId: "fallback-1", cfg: noRetries(), clarifier: new ScriptedClarifier([pickSafe]) });
      // The continued call asks, is answered, and then fails: the fallback is a new session that never heard the answer.
      fake.setScenario({ chat_claude: [{ answer: "Hello." }, { questions: [flag], exit: 1 }, { answer: "Built it." }, { answer: "Done." }], chat_codex: [{ answer: "Noted." }] });
      await say(chat, "/claude Hello", "/claude Build it");
      const [first, continued, fallback] = fake.calls("chat_claude");
      expect(continued!.resumed).toBe(first!.session);
      expect(continued!.prompt).not.toContain(pairLine);
      expect(fallback!.resumed).toBeUndefined();
      expect(fallback!.prompt).toContain("[Flag] Which flag should the build use?");
      expect(fallback!.prompt).toContain("→ --safe");
      expect(fallback!.prompt).toContain("this session did not see the answers");
      expect(answers().at(-1)).toMatchObject({ status: "success", answer: "Built it." });
      // The turn succeeded in the fallback session, which has the answer: the exchange carries it, once, for every later prompt.
      expect(saved(chat).exchanges[1]).toMatchObject({ backend: "claude", answer: "Built it.", clarified: [{ answer: "--safe" }] });
      await say(chat, "/claude And now?");
      const later = fake.calls("chat_claude").at(-1)!;
      expect(later.resumed).toBe(fallback!.session);
      expect(later.prompt).not.toContain("--safe");
      await say(chat, "/codex What did we pick?");
      expect(count(fake.calls("chat_codex")[0]!.prompt, pairLine)).toBe(1);
    });

    it("keeps them when the turn is stopped (Esc) after the answer, and the next call to the same agent has them in its full prompt", async () => {
      const chat = newChat({ conversationId: "stop-1", cfg: noRetries(), clarifier: new ScriptedClarifier([pickSafe]) });
      fake.setScenario({ chat_claude: [{ questions: [flag], afterQuestion: 10_000, answer: "never" }, { answer: "Built." }], chat_codex: [{ answer: "Noted." }] });
      await chat.submit("/claude Build it");
      await waitUntil(() => saved(chat).clarifications?.[0]?.status === "answered");
      chat.escape();
      await chat.idle();
      expect(answers().at(-1)!.status).toBe("interrupted");
      expect(saved(chat).exchanges).toMatchObject([{ backend: "claude", answer: "", unfinished: true, clarified: [{ answer: "--safe" }] }]);
      // The stopped turn kept no session, so Claude's next call is a whole prompt; Codex's carries the pair too.
      await say(chat, "/claude Go on");
      expect(fake.calls("chat_claude").at(-1)!.resumed).toBeUndefined();
      expect(fake.calls("chat_claude").at(-1)!.prompt).toContain(pairLine);
      await say(chat, "/codex What did we pick?");
      expect(fake.calls("chat_codex")[0]!.prompt).toContain(pairLine);
    });

    it("recovers answers given in a turn whose process went before it ended, once, when the conversation is reopened", async () => {
      const dir = join(runsDir, "conversations", "crash-1");
      mkdirSync(dir, { recursive: true });
      const entry = {
        id: "clq-1", source: "claude", callId: "c1", agent: "claude", turnId: "crash-1-t1", at: "2026-11-05T00:00:00.000Z", seq: 1, status: "answered", closedAt: "2026-11-05T00:00:01.000Z",
        questions: [{ id: "q1", header: "Flag", question: "Which flag should the build use?", multiSelect: false, options: [{ id: "q1o1", label: "--fast", description: "" }, { id: "q1o2", label: "--safe", description: "" }] }],
        answers: [{ questionId: "q1", optionIds: ["q1o2"], otherText: null }],
      };
      writeFileSync(join(dir, "conversation.json"), JSON.stringify({
        version: 1, id: "crash-1", title: "Crash", createdAt: "2026-11-05T00:00:00.000Z", updatedAt: "2026-11-05T00:00:00.000Z", recipient: "codex", turns: 1,
        exchanges: [], earlier: [], clarifications: [entry],
      }));
      fake.setScenario({ chat_codex: [{ answer: "Noted." }, { answer: "Noted again." }] });
      const chat = newChat({ conversationId: "crash-1" });
      await say(chat, "/codex What did we pick?");
      expect(count(fake.calls("chat_codex")[0]!.prompt, pairLine)).toBe(1);
      expect(saved(chat).exchanges[0]).toMatchObject({ unfinished: true, answer: "", clarified: [{ answer: "--safe" }] });
      expect(saved(chat).clarifications[0].settled).toBe(true);
      // Saved with the next message: reopening again does not make a second copy.
      const again = Conversation.open(runsDir, "crash-1");
      expect(again.context().exchanges.filter((e) => e.unfinished)).toHaveLength(1);
    });

    it("keeps them when a /discuss ends without an answer, and gives them to the next question", async () => {
      fake.setScenario({
        discuss_answer: [{ questions: [flag], answer: "DRAFT-1" }], discuss_critique: [{ exit: 1 }], chat_codex: [{ answer: "Noted." }],
      });
      const chat = newChat({ conversationId: "disc-fail", cfg: noRetries(), clarifier: new ScriptedClarifier([pickSafe]) });
      await say(chat, "/claude", "/discuss Which flag?");
      expect(events.some((e) => e.type === "discussion.finished" && e.answer === null)).toBe(true);
      expect(saved(chat).exchanges).toMatchObject([{ backend: "claude", question: "Which flag?", answer: "", unfinished: true, discussedWith: "codex", clarified: [{ answer: "--safe" }] }]);
      await say(chat, "/codex So?");
      expect(count(fake.calls("chat_codex")[0]!.prompt, pairLine)).toBe(1);
    });
  });

  it("opens an older conversation, from before questions, as it was", () => {
    const dir = join(runsDir, "conversations", "old-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "conversation.json"), JSON.stringify({
      version: 1, id: "old-1", title: "Old", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", recipient: "claude", turns: 1,
      exchanges: [{ backend: "claude", question: "Q?", answer: "A." }], earlier: [], sessions: { claude: { id: "s1", exchanges: 1, earlier: 0, discussion: { id: "d", messages: 2 } } },
    }));
    const c = Conversation.open(runsDir, "old-1");
    expect(c.clarifications).toEqual([]);
    expect(c.context().exchanges).toEqual([{ backend: "claude", question: "Q?", answer: "A." }]);
    const next = c.begin("codex", "More?", [], repo);
    expect(next.prompt).toContain("**User → Claude Code:**\nQ?\n\n**Claude Code:**\nA.");
    expect(next.prompt).not.toContain("Questions asked of the user");
  });

  const discussFlag = async (lost: boolean) => {
    fake.setScenario({
      ...(lost ? { sessions: { lost: true } } : {}),
      discuss_answer: [{ questions: [flag], answer: "DRAFT-1" }], discuss_critique: [{ answer: "Fix X\nVERDICT: REVISE" }, { answer: "ok\nVERDICT: AGREE" }],
      discuss_revise: [{ answer: "DRAFT-2" }], discuss_synthesis: [{ answer: "FINAL" }],
    });
    const chat = newChat({ conversationId: "disc", clarifier: new ScriptedClarifier([pickSafe]) });
    await say(chat, "/claude", "/discuss Which flag?");
    // Calls that ran (a resume that failed is logged too, before the fresh call that follows it).
    const ran = (role: string) => fake.calls(role).filter((c) => !c.lost);
    return { chat, answer: ran("discuss_answer"), critiques: ran("discuss_critique"), revise: ran("discuss_revise"), synthesis: ran("discuss_synthesis") };
  };
  const pair = "Claude Code asked [Flag]: Which flag should the build use?\n  → The user answered: --safe";

  it("gives Claude's choice in a /discuss to Codex at its review, and not again at its next steps while its session holds it", async () => {
    const { chat, answer, critiques, revise, synthesis } = await discussFlag(false);
    // Claude asked in its answer step; its own words never say what the user chose, so the pair is what carried it.
    expect(answer).toHaveLength(1);
    expect(answer[0]!.prompt).not.toContain("--safe");
    expect(fake.questionReplies()).toHaveLength(1);
    expect(critiques).toHaveLength(2);
    expect(count(critiques[0]!.prompt, pair)).toBe(1);
    expect(critiques[0]!.prompt).toContain("## Answers from the user to questions asked during this discussion");
    // Codex's session was given it in the first review; the second review and the synthesis continue that session without repeating it.
    expect(critiques[1]!.resumed).toBe(critiques[0]!.session);
    expect(critiques[1]!.prompt).not.toContain("--safe");
    expect(synthesis[0]!.resumed).toBeTruthy();
    expect(synthesis[0]!.prompt).not.toContain("--safe");
    // Claude's revise continues the session in which it asked and was answered.
    expect(revise[0]!.resumed).toBe(answer[0]!.session);
    expect(revise[0]!.prompt).not.toContain("--safe");
    // The response carries the pair into every later prompt.
    expect(saved(chat).exchanges.at(-1).clarified).toEqual([{ asker: "claude", header: "Flag", question: "Which flag should the build use?", answer: "--safe" }]);
    fake.setScenario({ chat_codex: [{ answer: "Right." }] });
    await say(chat, "/codex So?");
    expect(fake.calls("chat_codex").at(-1)!.prompt).toContain(pair);
  });

  it("gives it to every Codex step with the whole prompt when no session can be continued", async () => {
    const { chat, answer, critiques, revise, synthesis } = await discussFlag(true);
    expect(answer[0]!.prompt).not.toContain("--safe");
    expect(critiques).toHaveLength(2);
    for (const call of [...critiques, ...synthesis, ...revise]) expect(count(call.prompt, pair), call.role).toBe(1);
    expect(saved(chat).exchanges.at(-1).clarified).toHaveLength(1);
  });

});
