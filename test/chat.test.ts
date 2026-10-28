import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Chat, type ChatUi } from "../src/chat.js";
import type { ConfigData } from "../src/core/config.js";
import { RunStore } from "../src/core/state.js";
import { EventBus, type Decider } from "../src/events.js";
import { approval, critique, finding, impl, plan, review } from "./helpers/builders.js";
import { testConfig } from "./helpers/config.js";
import { FakeClis } from "./helpers/fake-clis.js";
import { ScriptedDecider } from "./helpers/harness.js";
import { makeRepo } from "./helpers/repo.js";
import { tempDir } from "./helpers/tmp.js";

class FakeUi implements ChatUi {
  readonly lines: string[] = [];
  readonly statuses: string[] = [];
  readonly edits: string[] = [];
  exited = false;
  setEdits(mode: string): void {
    this.edits.push(mode);
  }
  info(text: string): void {
    this.lines.push(text);
  }
  setStatus(status: "idle" | "running" | "paused"): void {
    this.statuses.push(status);
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

beforeEach(() => {
  t = tempDir();
  repo = makeRepo(t.path);
  runsDir = join(repo, ".agentduo", "runs");
  fake = new FakeClis(t.path).install();
  bus = new EventBus();
  ui = new FakeUi();
});
afterEach(() => {
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
const newChat = (o: { cfg?: ConfigData; decider?: Decider } = {}) =>
  new Chat({ cfg: o.cfg ?? testConfig(fake), workspace: repo, runsDir, configFile: join(repo, ".agentduo", "config.yaml"), bus, decider: o.decider ?? new ScriptedDecider(), ui });
const argsOf = (role: string, call = 0) => fake.calls(role)[call]!.args;
const after = (args: string[], flag: string) => args[args.lastIndexOf(flag) + 1];
const latest = () => RunStore.open(runsDir).loadState();

describe("Chat", () => {
  it("starts a run per message and tells each new run what the earlier ones did", async () => {
    const chat = newChat();
    fake.setScenario(happy());
    await chat.submit("Make app.txt fixed");
    await chat.idle();
    expect(ui.statuses).toEqual(["running", "idle"]);
    await chat.submit("Now make it say fixed twice");
    await chat.idle();
    expect(RunStore.list(runsDir)).toHaveLength(2);
    expect(fake.calls("planner")[0]!.prompt).not.toContain("Earlier in this conversation");
    const second = fake.calls("planner")[1]!.prompt;
    expect(second).toContain("## Earlier in this conversation");
    expect(second).toMatch(/1\. Make app\.txt fixed — done; .*files: app\.txt/);
    expect(latest().task).toBe("Now make it say fixed twice");
  });

  it("turns a message sent during a run into a note for the next step", async () => {
    const chat = newChat();
    fake.setScenario({ ...happy(), planner: [{ sleep: 1500, output: plan() }] });
    bus.on((e) => {
      if (e.type === "phase.started" && e.phase === "PLAN") setTimeout(() => void chat.submit("keep it short"), 300);
    });
    await chat.submit("Make app.txt fixed");
    await chat.idle();
    expect(fake.calls("planner")).toHaveLength(1);
    expect(fake.calls("plan_reviewer")[0]!.prompt).toContain("keep it short");
    expect(ui.lines.some((l) => l.includes("from the next step"))).toBe(true);
  });

  it("stops the step on Esc and re-runs it with the next message as a note", async () => {
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
    await chat.submit("Make app.txt fixed");
    await chat.idle();
    expect(ui.statuses.at(-1)).toBe("paused");
    expect(ui.lines.some((l) => l.includes("Stopped IMPLEMENT"))).toBe(true);
    await chat.submit("only touch app.txt");
    await chat.idle();
    expect(fake.calls("implementer")).toHaveLength(2);
    expect(fake.calls("implementer")[1]!.prompt).toContain("only touch app.txt");
    expect(latest().phase).toBe("DONE");
    expect(RunStore.list(runsDir)).toHaveLength(1);
  });

  it("leaves a stopped run resumable when the next message is /new", async () => {
    const chat = newChat();
    fake.setScenario({ ...happy(), implementer: [{ activities: [{ tool: "Read", input: { file_path: "app.txt" } }], sleep: 10_000, output: impl() }] });
    bus.on((e) => {
      if (e.type === "agent.activity" && e.role === "implementer") chat.escape();
    });
    await chat.submit("Make app.txt fixed");
    await chat.idle();
    await chat.submit("/new");
    expect(ui.statuses.at(-1)).toBe("idle");
    expect(latest().inProgress?.phase).toBe("IMPLEMENT");
  });

  it("answers slash commands", async () => {
    const chat = newChat();
    await chat.submit("/help");
    expect(ui.lines.join("\n")).toMatch(/\/plan[\s\S]*\/diff[\s\S]*\/status[\s\S]*\/resume[\s\S]*\/new[\s\S]*\/quit/);
    await chat.submit("/plan");
    expect(ui.lines.at(-1)).toContain("no plan yet");
    fake.setScenario(happy());
    await chat.submit("Make app.txt fixed");
    await chat.idle();
    await chat.submit("/plan");
    expect(ui.lines.at(-1)).toContain("Demo plan");
    await chat.submit("/diff");
    expect(ui.lines.at(-1)).toContain("app.txt");
    await chat.submit("/status");
    expect(ui.lines.at(-1)).toContain("DONE");
    await chat.submit("/bogus");
    expect(ui.lines.at(-1)).toContain("unknown command /bogus");
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
    await chat.submit("Make app.txt fixed");
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
    await chat.submit("Make app.txt fixed");
    await chat.idle();
    expect(after(argsOf("plan_reviewer"), "--model")).toBe("opus");
    expect(ui.lines.some((l) => l.includes("from the next agent call"))).toBe(true);
    expect(JSON.parse(readFileSync(RunStore.open(runsDir).path("config.json"), "utf8")).claude.model).toBe("opus");
  });

  it("mirrors the settings commands of Claude Code and Codex", async () => {
    const chat = newChat();
    for (const command of ["/claude effort high", "/claude permissions allow Bash(npm test:*)", "/claude permissions deny Bash(git push:*)",
      "/claude add-dir ../shared", "/codex model gpt-5.5 high", "/codex permissions auto"]) {
      await chat.submit(command);
    }
    await chat.submit("/claude permissions");
    expect(ui.lines.at(-1)).toMatch(/allow: Bash\(npm test:\*\)[\s\S]*deny: Bash\(git push:\*\)/);
    await chat.submit("/claude effort huge");
    expect(ui.lines.at(-1)).toContain("low|medium|high|xhigh|max|default");
    await chat.submit("/codex permissions full-access");
    expect(ui.lines.at(-1)).toContain("--yes");
    fake.setScenario(happy());
    await chat.submit("Make app.txt fixed");
    await chat.idle();
    const claude = argsOf("implementer");
    expect([after(claude, "--effort"), after(claude, "--allowedTools"), after(claude, "--disallowedTools"), after(claude, "--add-dir")])
      .toEqual(["high", "Bash(npm test:*)", "Bash(git push:*)", "../shared"]);
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
    for (const command of ["/plan", "/diff", "/status", "/resume", "/new", "/quit", "Esc", "Shift+Tab", "/edits", "/claude model", "/claude effort",
      "/claude permissions", "/claude add-dir", "/codex model", "/codex permissions", "/config", "/help", "--save"]) {
      expect(help, command).toContain(command);
    }
    for (const line of help.split("\n").filter((l) => l.trimStart().startsWith("/"))) expect(line.trim(), line).toMatch(/^\S+(?: \S+)*\s{2,}\S/);
  });

  it("offers to resume a run left waiting in an earlier session, and asks for the decision again", async () => {
    const cfg = testConfig(fake, { limits: { max_review_rounds: 1 } });
    fake.setScenario({ ...happy(), code_reviewer: [{ output: review(false, [finding("F1")]) }] });
    const first = newChat({ cfg });
    await first.submit("Make app.txt fixed");
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
