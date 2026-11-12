// /team in the chat: a team run in the background, plain messages to its PM, Esc and /resume, the board, and undo.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Chat, type ChatUi } from "../../src/chat/chat.js";
import { parseInput } from "../../src/chat/commands.js";
import { EventBus, type DuoEvent, type ModelMap } from "../../src/events.js";
import type { Attachment } from "../../src/inputs/attachment-types.js";
import { TeamStore } from "../../src/team/state.js";
import { testConfig } from "../helpers/config.js";
import { FakeClis } from "../helpers/fake-clis.js";
import { pickFirst, ScriptedClarifier, ScriptedDecider } from "../helpers/harness.js";
import { png } from "../helpers/images.js";
import { git, makeRepo } from "../helpers/repo.js";
import { brief, task, teamCheck, teamPlan, teamPm, teamReview, teamTests, teamWork } from "../helpers/team-builders.js";
import { tempDir } from "../helpers/tmp.js";
import { waitUntil } from "../helpers/wait.js";

class FakeUi implements ChatUi {
  readonly lines: string[] = [];
  readonly statuses: string[] = [];
  /** The names of the files each accepted message took. */
  readonly sentFiles: string[][] = [];
  info(text: string): void {
    this.lines.push(text);
  }
  setStatus(status: string): void {
    this.statuses.push(status);
  }
  setMode(): void {}
  setRecipient(): void {}
  setModels(_m: ModelMap): void {}
  sent(files: Attachment[]): void {
    this.sentFiles.push(files.map((f) => f.name));
  }
  exit(): void {}
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

const newChat = () => {
  const cfg = testConfig(fake, { gates: [] });
  const chat = new Chat({
    cfg, workspace: repo, runsDir, configFile: join(repo, ".agentduo", "config.yaml"), userConfigFile: join(t.path, "xdg", "agentduo", "config.yaml"),
    bus, decider: new ScriptedDecider(), ui, clarifier: new ScriptedClarifier([pickFirst]),
  });
  chats.push(chat);
  return chat;
};

const scenario = (work: Record<string, unknown> = { output: teamWork(), write: { "app.txt": "fixed\n" } }) => ({
  team_pm_conversation: [{ output: teamPm.brief(brief()) }, { output: teamPm.none("We are on it: one task, dev-1 is coding.") }],
  team_plan: [{ output: teamPlan([task("T1")]) }],
  team_pm_plan_review: [{ output: teamPm.planReview(true) }],
  team_pm_reports: [{ output: teamPm.none("Progress.") }],
  team_pm_acceptance: [{ output: teamPm.acceptance() }],
  team_work: [work],
  team_tests: [{ output: teamTests(), write: { "test/qa.txt": "tests\n" } }],
  team_review: [{ output: teamReview("approve") }],
  team_check: [{ output: teamCheck("pass") }],
});

describe("/team in the chat", () => {
  it("parses a request and the team's own words", () => {
    expect(parseInput("/team Add a CSV export")).toEqual({ kind: "team", action: "start", request: "Add a CSV export" });
    expect(parseInput("/team status")).toEqual({ kind: "team", action: "status" });
    expect(parseInput("/team members")).toEqual({ kind: "team", action: "members" });
    expect(parseInput("/team undo")).toEqual({ kind: "team", action: "undo", runId: null });
    expect(parseInput("/team undo 2026-x")).toEqual({ kind: "team", action: "undo", runId: "2026-x" });
    // A request may start with one of those words.
    expect(parseInput("/team status page for the API")).toEqual({ kind: "team", action: "start", request: "status page for the API" });
    expect(parseInput("/team")).toMatchObject({ kind: "usage" });
  });

  it("runs the team in the background, sends plain messages to the PM, and writes the accepted result", async () => {
    fake.setScenario(scenario({ output: teamWork(), write: { "app.txt": "fixed\n" }, sleep: 1500 }));
    const chat = newChat();
    await chat.submit("/team Make app.txt fixed");
    expect(ui.lines.at(-1)).toContain("Your messages now go to the PM");
    await waitUntil(() => events.some((e) => e.type === "team.member" && e.member === "dev-1" && e.state === "busy"));
    await chat.submit("How is it going?");
    await chat.idle();
    expect(fake.calls("team_pm_conversation")[1]!.prompt).toContain("User: How is it going?");
    expect(events.some((e) => e.type === "team.message" && e.from === "pm" && e.text.startsWith("We are on it"))).toBe(true);
    expect(readFileSync(join(repo, "app.txt"), "utf8")).toBe("fixed\n");
    expect(ui.lines.at(-1)).toContain("The team's result is in your folder");
    expect(ui.statuses.at(-1)).toBe("idle");
    // Nothing waits: the workspace is free again, and a question goes to an agent as before.
    fake.setScenario({ chat_codex: [{ answer: "Hi." }] });
    await chat.submit("/codex hello");
    await chat.idle();
    expect(fake.calls("chat_codex")).toHaveLength(1);
  });

  it("sends the waiting files with the request and with a message to the PM, files alone too", async () => {
    fake.setScenario(scenario({ output: teamWork(), write: { "app.txt": "fixed\n" }, sleep: 1500 }));
    const chat = newChat();
    mkdirSync(join(t.path, "home"), { recursive: true });
    const file = (name: string, data: Buffer) => {
      writeFileSync(join(t.path, "home", name), data);
      return join(t.path, "home", name);
    };
    await chat.submit(`/attach "${file("mockup.png", png(32, 32))}"`);
    await chat.submit("/team Make the page look like the mockup");
    expect(chat.pending).toEqual([]);
    expect(ui.sentFiles).toEqual([["mockup.png"]]);
    await waitUntil(() => events.some((e) => e.type === "team.member" && e.member === "dev-1" && e.state === "busy"));
    await chat.submit(`/attach "${file("detail.png", png(8, 8))}"`);
    await chat.submit("");
    expect(chat.pending).toEqual([]);
    expect(ui.sentFiles).toEqual([["mockup.png"], ["detail.png"]]);
    await chat.idle();
    expect(ui.lines.some((l) => l.includes("takes no files"))).toBe(false);
    const pm = fake.calls("team_pm_conversation");
    expect(pm[0]!.images).toHaveLength(1);
    expect(pm[0]!.prompt).toContain("User: Make the page look like the mockup\n(attached: `mockup.png`)");
    expect(pm[1]!.images).toHaveLength(1);
    expect(pm[1]!.prompt).toContain("User: Look at the attached file(s).\n(attached: `detail.png`)");
  });

  it("takes the Team route's text as the request, and a message to the running team's PM", async () => {
    fake.setScenario(scenario({ output: teamWork(), write: { "app.txt": "fixed\n" }, sleep: 1200 }));
    const chat = newChat();
    await chat.submitTeam("Make app.txt fixed");
    expect(ui.lines.at(-1)).toContain("Your messages now go to the PM");
    await waitUntil(() => events.some((e) => e.type === "team.member" && e.member === "dev-1" && e.state === "busy"));
    await chat.submitTeam("How is it going?");
    await chat.idle();
    expect(fake.calls("team_pm_conversation")[1]!.prompt).toContain("User: How is it going?");
    await chat.submitTeam("");
    expect(ui.lines.at(-1)).toContain("usage: a request for the team");
  });

  it("stops the team on Esc, and /resume continues it", async () => {
    fake.setScenario(scenario({ output: teamWork(), write: { "app.txt": "fixed\n" }, sleep: 3000 }));
    const chat = newChat();
    await chat.submit("/team Make app.txt fixed");
    await waitUntil(() => events.some((e) => e.type === "team.member" && e.member === "dev-1" && e.job === "work"));
    chat.escape();
    await chat.idle();
    expect(ui.lines.at(-1)).toContain("The team stopped. /resume continues it");
    expect(ui.statuses.at(-1)).toBe("paused");
    await chat.submit("/team status");
    expect(ui.lines.at(-1)).toMatch(/Team .* — EXECUTION/);
    expect(ui.lines.at(-1)).toContain("T1 Task T1 — dev-1, coding");
    await chat.submit("/resume");
    await chat.idle();
    expect(readFileSync(join(repo, "app.txt"), "utf8")).toBe("fixed\n");
    expect(TeamStore.open(runsDir, "latest").load().phase).toBe("DONE");
  });

  it("shows the team, and takes a result back out with /team undo", async () => {
    fake.setScenario(scenario());
    const chat = newChat();
    await chat.submit("/team members");
    expect(ui.lines.at(-1)).toContain("dev-2 — dev (mid), Claude sonnet · medium");
    await chat.submit("/team Make app.txt fixed");
    await chat.idle();
    expect(readFileSync(join(repo, "app.txt"), "utf8")).toBe("fixed\n");
    await chat.submit("/team undo");
    expect(ui.lines.at(-1)).toContain("is taken back out");
    expect(() => readFileSync(join(repo, "app.txt"), "utf8")).toThrow();
    expect(git(repo, "status", "--porcelain")).toBe("");
  });
});
