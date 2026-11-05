// The desktop app end to end: the built app (main, preload, renderer, the engine worker run by Electron's own Node)
// started by Playwright with a profile, a user config and a git repository of its own, and the fake codex/claude CLIs
// as the agents. Each test drives the window as a user would (clicks, typing, Settings), one after another: first
// run, chat with both agents, a permission prompt, attached files, /discuss, a pipeline with its gate, review and
// decision while Settings change, Stop, a newer version on an update feed of the test's own, then quit mid-run, start
// again, and /resume.
//   npm run build && npm run test:e2e   (in apps/desktop)
// AGENTDUO_E2E_APP=<packaged app> runs the same tests on a package (built with --test-fuses, so Playwright can attach):
// the .app on macOS, the executable elsewhere. On Linux CI without the SUID sandbox helper, AGENTDUO_E2E_NO_SANDBOX=1
// passes --no-sandbox to this test only.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { userConfigPath } from "../../../../src/core/config.js";
import { RunStore, type RunState } from "../../../../src/core/state.js";
import { approval, critique, finding, impl, plan, review } from "../../../../test/helpers/builders.js";
import { CHECK_GATE, userDataEnv } from "../../../../test/helpers/config.js";
import { FakeClis } from "../../../../test/helpers/fake-clis.js";
import { png } from "../../../../test/helpers/images.js";
import { makeRepo } from "../../../../test/helpers/repo.js";
import { tempDir } from "../../../../test/helpers/tmp.js";
import { waitUntil } from "../../../../test/helpers/vscode.js";

// Without its trailing separator: on Windows Playwright quotes each argument into one command line, where a closing
// `\"` is an escaped quote, so Electron got a folder that does not exist and waited on its error box.
const desktop = resolve(fileURLToPath(new URL("../..", import.meta.url)));
/** What runs: a packaged app's executable (AGENTDUO_E2E_APP), or the checkout's Electron with the built app. */
function executable(): { path: string; args: string[] } {
  const packaged = process.env.AGENTDUO_E2E_APP;
  if (!packaged) return { path: createRequire(join(desktop, "package.json"))("electron") as unknown as string, args: [desktop] };
  if (!packaged.endsWith(".app")) return { path: packaged, args: [] };
  const macos = join(packaged, "Contents", "MacOS");
  return { path: join(macos, readdirSync(macos).find((f) => !f.startsWith("."))!), args: [] };
}
const SHOWN = ".chat-mount:not([hidden])";

let scratch: { path: string; cleanup(): void };
let fake: FakeClis;
let repo: string;
let runsDir: string;
let env: Record<string, string>;
let app: ElectronApplication | null = null;
let page: Page;
const log: string[] = [];
/** The update feed (electron-updater's generic provider): every channel file says 99.0.0 is out; what was asked for. */
let feed: Server;
const feedRequests: string[] = [];

/** The app started (or started again) with the test's profile; the first window loaded. */
async function launch(): Promise<void> {
  const run = executable();
  app = await electron.launch({ executablePath: run.path, args: [...run.args, ...(process.env.AGENTDUO_E2E_NO_SANDBOX ? ["--no-sandbox"] : [])], env, timeout: 60_000 });
  const keep = (d: Buffer) => log.push(...String(d).split("\n").filter(Boolean));
  app.process().stdout?.on("data", keep);
  app.process().stderr?.on("data", keep);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
}

/** Quit as the user does (Cmd+Q): main settles the workers' questions, stops their runs and frees their locks. */
async function quit(): Promise<void> {
  if (!app) return;
  const closing = app;
  app = null;
  await closing.close();
}

const invoke = <T>(request: Record<string, unknown>) => page.evaluate(async (r) => {
  const a = await (window as unknown as { agentduo: { invoke(r: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> } }).agentduo.invoke(r);
  if (!a.ok) throw new Error(a.error);
  return a.result;
}, request) as Promise<T>;

const activeConversation = async () => (await invoke<{ active: { projectId: string | null; conversationId: string | null } }>({ method: "app.state" })).active;

/** Types in the shown chat's composer and sends with Enter, as the user does. */
async function send(text: string): Promise<void> {
  const input = page.locator(`${SHOWN} .composer-input`);
  await input.fill(text);
  await input.press("Enter");
  await expect.poll(() => input.inputValue(), { timeout: 5000 }).toBe("");
}

const seeInChat = (text: string, timeout = 30_000) => page.locator(SHOWN).getByText(text).first().waitFor({ timeout });

async function openSettings(section: string): Promise<void> {
  await page.locator(".side-foot button", { hasText: "Settings" }).click();
  await page.locator(".settings-nav .settings-tab", { hasText: section }).click();
}

const closeSettings = () => page.locator(".settings-head button", { hasText: "Done" }).click();

const GROUP_TABS: Record<string, string> = { claude: "Claude Code", codex: "Codex", agents: "Workflow roles", limits: "Rounds & limits" };

/** What new work gets for `key` now, as Settings reads the configuration of the active project (or of none). */
async function effective(key: string): Promise<unknown> {
  const { projectId } = await activeConversation();
  const view = await invoke<{ entries: Array<{ key: string; effective: unknown }> }>({ method: "settings.read", projectId: projectId === "0000000000000000" ? null : projectId });
  return view.entries.find((e) => e.key === key)?.effective;
}

/** Settings' tab of `key` in `scope`, and the row of that setting in it (a step's model and effort sit with who plays it). */
async function settingRow(scope: string, key: string) {
  await page.locator(".settings .seg", { hasText: scope }).click();
  const group = /^(claude|codex)\.role_(models|efforts)\./.test(key) ? "agents" : key.split(".")[0]!;
  await page.locator(".settings .config-tab", { hasText: GROUP_TABS[group]! }).click();
  return page.locator(`.settings .setting-row[data-key="${key}"]`);
}

/** One configuration setting changed in `scope` as the user does (it saves at once), waiting until it took. */
async function setEntry(scope: string, key: string, value: string, how: "fill" | "select" | "model" = "fill"): Promise<void> {
  const row = await settingRow(scope, key);
  const id = `#cfg-${key.replace(/[^a-z0-9]/gi, "-")}`;
  if (how === "select") await row.locator(id).selectOption(value);
  else if (how === "model") {
    // A model the CLI does not list: "Other model…", then its name.
    await row.locator(id).selectOption({ label: "Other model…" });
    await row.locator(`${id}-custom`).fill(value);
    await row.locator(`${id}-custom`).press("Enter");
  } else {
    await row.locator(id).fill(value);
    await row.locator(id).press("Enter");
  }
  await expect.poll(async () => String(await effective(key)), { timeout: 10_000 }).toBe(value);
}

async function resetEntry(scope: string, key: string): Promise<void> {
  const row = await settingRow(scope, key);
  await row.getByRole("button", { name: "Reset" }).click();
  await expect.poll(() => page.locator(`.settings .setting-row[data-key="${key}"]`).getByRole("button", { name: "Reset" }).count(), { timeout: 10_000 }).toBe(0);
}

const runs = (): RunState[] => RunStore.list(runsDir);
const runOf = (task: string) => runs().find((r) => r.task.startsWith(task));

const happyPlan = () => ({ planner: [{ output: plan() }], plan_reviewer: [{ output: critique(true) }], plan_finalizer: [{ output: approval(true) }] });

beforeAll(async () => {
  scratch = tempDir();
  fake = new FakeClis(scratch.path).install();
  repo = makeRepo(scratch.path);
  runsDir = join(repo, ".agentduo", "runs");
  // The agents and the gate come from the project; the CLIs from the user config, as onboarding's CLI picker writes them.
  mkdirSync(join(repo, ".agentduo"), { recursive: true });
  writeFileSync(join(repo, ".agentduo", "config.yaml"), YAML.stringify({ gates: [CHECK_GATE], limits: { agent_timeout_sec: 60, gate_timeout_sec: 60 } }));
  const config = join(scratch.path, "config");
  feed = createServer((req, res) => {
    // electron-updater adds ?noCache=… to each request.
    const path = new URL(req.url ?? "/", "http://feed").pathname;
    feedRequests.push(path);
    if (!path.endsWith(".yml")) return void res.writeHead(404).end();
    const file = "AgentDuo-99.0.0-test.zip";
    const sha512 = Buffer.alloc(64).toString("base64");
    res.writeHead(200, { "content-type": "text/yaml" }).end(YAML.stringify({ version: "99.0.0", files: [{ url: file, sha512, size: 1 }], path: file, sha512, releaseDate: "2026-10-31T00:00:00.000Z" }));
  });
  await new Promise<void>((resolve) => feed.listen(0, "127.0.0.1", resolve));
  const updateConfig = join(scratch.path, "app-update.yml");
  writeFileSync(updateConfig, YAML.stringify({ provider: "generic", url: `http://127.0.0.1:${(feed.address() as { port: number }).port}/`, updaterCacheDirName: "agentduo-e2e-updater" }));
  env = Object.fromEntries(Object.entries({
    ...process.env, AGENTDUO_DESKTOP_USER_DATA: join(scratch.path, "profile"), AGENTDUO_DESKTOP_TEST_FOLDER: repo, AGENTDUO_DESKTOP_LOG: "1",
    AGENTDUO_DESKTOP_UPDATE_CONFIG: updateConfig,
    HOME: join(scratch.path, "home"), USERPROFILE: join(scratch.path, "home"), XDG_CONFIG_HOME: config, APPDATA: config,
    // Snapshot repositories of folders with no git repository: the test's own, never the user's.
    ...userDataEnv(join(scratch.path, "data")),
  }).filter((e): e is [string, string] => typeof e[1] === "string" && e[0] !== "ELECTRON_RUN_AS_NODE"));
  mkdirSync(env.HOME!, { recursive: true });
  const user = userConfigPath(env);
  mkdirSync(join(user, ".."), { recursive: true });
  writeFileSync(user, YAML.stringify({ claude: { bin: fake.path("claude") }, codex: { bin: fake.path("codex") } }));
  await launch();
});

// A failed test prints the app's log (main and its workers): on CI that is all there is to say why.
beforeEach(({ onTestFailed }) => onTestFailed(() => console.log(`the app's log:\n${log.slice(-200).join("\n")}`)));

afterAll(async () => {
  await quit().catch(() => undefined);
  feed?.close();
  fake.restore();
  if (process.env.AGENTDUO_E2E_KEEP) console.log(`kept ${scratch.path}`);
  else scratch.cleanup();
});

describe("agentduo desktop", () => {
  it("opens isolated: no Node in the page, only the bridge, which refuses what it does not know", async () => {
    expect(await page.title()).toBe("AgentDuo");
    expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require === "undefined" && typeof (window as unknown as { process?: unknown }).process === "undefined")).toBe(true);
    const refused = await page.evaluate(() => (window as unknown as { agentduo: { invoke(r: unknown): Promise<{ ok: boolean }> } }).agentduo.invoke({ method: "fs.read", path: "/etc/passwd" }));
    expect(refused.ok).toBe(false);
    const state = await invoke<{ versions: { node: string } }>({ method: "app.state" });
    expect(Number(state.versions.node.split(".")[0])).toBeGreaterThanOrEqual(22);
  });

  it("first run: checks both CLIs, then Settings work with no project, then a project opens", async () => {
    const onboarding = page.locator(".overlay.onboarding");
    await onboarding.waitFor();
    await expect.poll(() => onboarding.locator(".cli-card .pill").allTextContents(), { timeout: 30_000 }).toEqual(["fake@anthropic.example", "fake@example.com"]);
    // Neither CLI was asked anything but its version, sign-in and usage.
    expect(fake.calls()).toHaveLength(0);
    await onboarding.getByRole("button", { name: "Continue without a project" }).click();
    await expect.poll(() => onboarding.isHidden()).toBe(true);
    await page.locator(`${SHOWN} .composer-input`).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Conversations", exact: true }).waitFor();

    // The sidebar's Account & Usage box: each agent's email and its limits; shut, it stays shut (a preference).
    const account = page.locator(".sidebar .account-box");
    await expect.poll(() => account.locator(".account-email").allTextContents(), { timeout: 30_000 }).toEqual(["fake@anthropic.example", "fake@example.com"]);
    await expect.poll(() => account.locator(".usage-label").allTextContents(), { timeout: 30_000 }).toEqual(["Current session", "5h limit", "Weekly limit"]);
    expect(await account.locator("[role=meter]").evaluateAll((m) => m.map((e) => e.getAttribute("aria-valuenow")))).toEqual(["10", "5", "20"]);
    await account.getByRole("button", { name: "Account & Usage" }).click();
    await expect.poll(() => account.locator(".account-agent").count()).toBe(0);
    expect((await invoke<{ prefs: { accountOpen: boolean } }>({ method: "app.state" })).prefs.accountOpen).toBe(false);
    await account.getByRole("button", { name: "Account & Usage" }).click();
    await expect.poll(() => account.locator(".account-agent").count()).toBe(2);

    // Settings without a project: only the user config can change.
    await openSettings("Configuration");
    expect(await page.locator(".settings .seg", { hasText: "This project" }).isDisabled()).toBe(true);
    await setEntry("All projects", "limits.max_review_rounds", "1");
    // The budget's default is null: its editor is still a number, and 5 is saved as the number 5.
    await setEntry("All projects", "claude.max_budget_usd", "5");
    const user = YAML.parse(readFileSync(userConfigPath(env), "utf8"));
    expect(user.limits.max_review_rounds).toBe(1);
    expect(user.claude.max_budget_usd).toBe(5);
    // Claude & Codex: each card names the email it signs in with, its plan and its limits.
    await page.locator(".settings-nav .settings-tab", { hasText: "Claude & Codex" }).click();
    const cards = page.locator(".settings .cli-card");
    await expect.poll(() => cards.locator(".pill").allTextContents(), { timeout: 30_000 }).toEqual(["fake@anthropic.example", "fake@example.com"]);
    await expect.poll(() => cards.locator(".usage-label").allTextContents(), { timeout: 30_000 }).toEqual(["Current session", "5h limit", "Weekly limit"]);
    expect(await cards.locator(".cli-usage [role=meter]").evaluateAll((m) => m.map((e) => e.getAttribute("aria-valuenow")))).toEqual(["10", "5", "20"]);
    expect(await cards.locator(".facts dt:text-is('Plan') + dd").allTextContents()).toEqual(["Max", "ChatGPT Plus"]);
    expect(fake.calls()).toHaveLength(0);
    await closeSettings();

    fake.setScenario({ chat_codex: [{ answer: "A reply without a project" }] });
    await send("Chat without a folder");
    await seeInChat("A reply without a project");
    const general = await activeConversation();
    await quit();
    await launch();
    await seeInChat("A reply without a project");
    expect(await activeConversation()).toEqual(general);
    await page.locator(".sidebar").getByTitle("Open project…").first().click();
    await page.locator(`${SHOWN} .composer-input`).waitFor({ timeout: 30_000 });
    await expect.poll(async () => (await activeConversation()).conversationId).not.toBeNull();
    await page.locator(".sidebar .nav-item.project", { hasText: "repo" }).waitFor();
    const project = await activeConversation();
    await page.getByRole("button", { name: "Conversations", exact: true }).click();
    await seeInChat("A reply without a project");
    expect(await activeConversation()).toEqual(general);
    await page.locator(".sidebar .nav-item.project .nav-main").click();
    await expect.poll(() => activeConversation()).toEqual(project);
  });

  it("chats with Codex and with Claude, answers Claude's permission prompt, and sends attached files", async () => {
    fake.setScenario({
      chat_codex: [{ answer: "Codex says hello" }],
      chat_claude: [
        { answer: "Claude says hi" },
        { answer: "Claude listed the files", permissions: [{ tool: "Bash", input: { command: "ls" }, rules: [] }] },
        { answer: "Claude read both files" },
      ],
    });
    await send("Hello Codex");
    await seeInChat("Codex says hello");
    await send("/claude Hello Claude");
    await seeInChat("Claude says hi");
    expect(fake.calls().map((c) => c.role)).toEqual(["chat_codex", "chat_codex", "chat_claude"]);

    await send("/claude List the files");
    const permission = page.locator(`${SHOWN} .card.permission`);
    await permission.waitFor({ timeout: 30_000 });
    expect(await permission.textContent()).toContain("ls");
    await permission.getByRole("button", { name: "Allow once" }).click();
    await seeInChat("Claude listed the files");
    expect(fake.permissionAnswers().map((a) => a.behavior)).toEqual(["allow"]);

    // A file from the picker (the native dialog answered here) and an image pasted into the composer.
    const notes = join(scratch.path, "notes.txt");
    writeFileSync(notes, "remember the milk\n");
    await app!.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as unknown as typeof dialog.showOpenDialog;
    }, notes);
    await page.locator(`${SHOWN} .attach`).click();
    await page.locator(`${SHOWN} .composer-files .file-chip.file-ready`, { hasText: "notes.txt" }).waitFor({ timeout: 20_000 });
    await page.evaluate(([selector, b64]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], "shot.png", { type: "image/png" }));
      document.querySelector(selector)!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, [`${SHOWN} .composer-input`, png(8, 6).toString("base64")] as const);
    await page.locator(`${SHOWN} .composer-files .file-chip.file-ready`, { hasText: "shot.png" }).waitFor({ timeout: 20_000 });
    await send("/claude What is in these files?");
    await seeInChat("Claude read both files");
    const call = fake.calls("chat_claude").at(-1)!;
    expect(call.prompt).toContain("notes.txt");
    expect(call.images).toHaveLength(1);
    // The image the message shows is served by a resource token of this view, and loads.
    const img = page.locator(`${SHOWN} .user-msg img`).last();
    await img.waitFor({ timeout: 20_000 });
    expect(await img.getAttribute("src")).toMatch(/^agentduo:\/\/resource\//);
    await expect.poll(() => img.evaluate((i) => (i as HTMLImageElement).naturalWidth), { timeout: 10_000 }).toBe(8);
  });

  it("discusses a question until both agents agree, and shows the final answer", async () => {
    fake.setScenario({ discuss_answer: [{ answer: "Use SQLite." }], discuss_synthesis: [{ answer: "Final: SQLite it is." }] });
    await send("/discuss Which database should the demo use?");
    await page.locator(`${SHOWN} .discussion-final`, { hasText: "Final: SQLite it is." }).waitFor({ timeout: 45_000 });
    expect(fake.calls().map((c) => c.role)).toEqual(expect.arrayContaining(["discuss_answer", "discuss_synthesis"]));
  });

  it("suggests the project's files and folders after an @, narrows them as the user types, and tags the ones picked", async () => {
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "docs", "guide.md"), "# Guide\n");
    const input = page.locator(`${SHOWN} .composer-input`);
    const shown = () => page.locator(`${SHOWN} .completions:not([hidden]) .completion.mention`).evaluateAll((l) => l.map((e) => (e as HTMLElement).dataset.path));
    // A bare @: the project's top level, folders first.
    await input.fill("Summarise @");
    await expect.poll(shown, { timeout: 15_000 }).toEqual(expect.arrayContaining(["docs/", "README.md", "check.mjs"]));
    expect((await shown()).indexOf("docs/")).toBeLessThan((await shown()).indexOf("README.md"));
    // More letters narrow it, best first; Enter puts the path in with a space after it, and the list closes.
    await input.pressSequentially("gui");
    await expect.poll(async () => (await shown())[0], { timeout: 15_000 }).toBe("docs/guide.md");
    await input.press("Enter");
    expect(await input.inputValue()).toBe("Summarise @docs/guide.md ");
    await expect.poll(shown).toEqual([]);
    // Tab on a folder opens it: its own entries are listed, and typing goes on inside it.
    await input.pressSequentially("and @do");
    await expect.poll(async () => (await shown())[0], { timeout: 15_000 }).toBe("docs/");
    await input.press("Tab");
    expect(await input.inputValue()).toBe("Summarise @docs/guide.md and @docs/");
    await expect.poll(shown, { timeout: 15_000 }).toEqual(["docs/guide.md"]);
    await input.press("Escape");
    await expect.poll(shown).toEqual([]);
    // It goes to the recipient the chat has now (an earlier /claude chose Claude).
    fake.setScenario({ chat_codex: [{ answer: "The agent read the guide" }], chat_claude: [{ answer: "The agent read the guide" }] });
    await input.pressSequentially(" too");
    await input.press("Enter");
    await seeInChat("The agent read the guide");
    const prompt = fake.calls().filter((c) => c.role.startsWith("chat_")).at(-1)!.prompt;
    expect(prompt).toContain("Summarise @docs/guide.md and @docs/ too");
    expect(prompt).toContain("### Workspace paths the user tagged\n");
    expect(prompt).toContain("- `docs/guide.md` (file)\n- `docs/` (folder)");
  });

  it("keeps main's selection with the conversation shown: A, then B, then A again, through a preference change", async () => {
    const a = (await activeConversation()).conversationId!;
    await page.locator(".sidebar .nav-head", { hasText: "Conversations" }).getByTitle("New conversation").click();
    await expect.poll(async () => (await activeConversation()).conversationId, { timeout: 10_000 }).not.toBe(a);
    expect(await page.locator(".chat-mount").count()).toBe(3);
    // A conversation has no ✕ in the list: closing one only opened a new one in its place.
    expect(await page.locator(".sidebar .nav-item.conversation button:not(.nav-main)").count()).toBe(0);
    await page.locator(".sidebar .nav-item.conversation .nav-main", { hasText: "Hello Codex" }).click();
    await seeInChat("Codex says hello", 10_000);
    await expect.poll(async () => (await activeConversation()).conversationId, { timeout: 10_000 }).toBe(a);
    // A preference change sends main's snapshot to the window: it still names A, so A stays on screen.
    await openSettings("General");
    await page.locator("#pref-theme").selectOption("dark");
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    await closeSettings();
    expect((await activeConversation()).conversationId).toBe(a);
    await seeInChat("Codex says hello", 5000);
  });

  it("runs a pipeline: gate, review, a decision, Settings changed meanwhile, and its changes as a line diff", async () => {
    fake.setScenario({
      ...happyPlan(),
      implementer: [{ sleep: 9000, write: { "app.txt": "fixed\n" }, output: impl() }, { write: { "app.txt": "fixed\nand tidy\n" }, output: impl() }],
      code_reviewer: [{ output: review(false, [finding("F1")]) }, { output: review(true) }],
    });
    await send("/pipeline Make app.txt fixed");
    await waitUntil(() => fake.calls("implementer").length === 1, 45_000, "the implementer");
    await expect.poll(() => page.locator(".top-status").textContent(), { timeout: 10_000 }).toMatch(/implement/i);

    // While Claude implements: next-call settings (the reviewer's model, the review step's effort and the implementer's
    // model) and a next-run one (who reviews). The review step's rows are Codex's while Codex plays it.
    await openSettings("Configuration");
    await setEntry("This project", "codex.model", "e2e-model", "model");
    await setEntry("This project", "codex.role_efforts.code_reviewer", "high", "select");
    await setEntry("This project", "claude.role_models.implementer", "e2e-implementer", "model");
    await setEntry("This project", "agents.code_reviewer", "claude", "select");
    // Claude plays the review step for new runs now: its rows are Claude's, and Codex's effort stays saved.
    expect(await page.locator('.settings .setting-row[data-key="claude.role_efforts.code_reviewer"]').count()).toBe(1);
    expect(await page.locator('.settings .setting-row[data-key="codex.role_efforts.code_reviewer"]').count()).toBe(0);
    await closeSettings();

    // max_review_rounds is 1 (the user config, set at first run): the rejected review asks for a decision.
    const decision = page.locator(`${SHOWN} .card.decision`);
    await decision.waitFor({ timeout: 60_000 });
    expect(await decision.textContent()).toContain("max_review_rounds");
    await decision.getByRole("button", { name: /Resume/ }).click();
    await waitUntil(() => runOf("Make app.txt fixed")?.phase === "DONE", 60_000, "the run to finish");

    // The run kept who reviews (next run), and its reviews used the model set meanwhile (next call); so did its config.json.
    const reviews = fake.calls("code_reviewer");
    expect(reviews.map((c) => c.backend)).toEqual(["codex", "codex"]);
    for (const r of reviews) expect(r.args.join(" ")).toContain("e2e-model");
    for (const r of reviews) expect(r.args).toContain("model_reasoning_effort=high");
    // The implementer's second round ran on the step's own model.
    expect(fake.calls("implementer").at(-1)!.args.join(" ")).toContain("--model e2e-implementer");
    const run = runOf("Make app.txt fixed")!;
    const saved = JSON.parse(readFileSync(join(RunStore.open(runsDir, run.taskId).dir, "config.json"), "utf8"));
    expect(saved.agents.code_reviewer).toBe("codex");
    expect(saved.codex.model).toBe("e2e-model");

    // The inspector: the gate passed, and app.txt's change as a line diff.
    const inspector = page.locator(".inspector");
    if (await inspector.isHidden()) await page.locator(".topbar .icon-btn").click();
    await inspector.locator(".tab", { hasText: "Checks" }).click();
    await inspector.locator(".gates li", { hasText: "check" }).first().waitFor({ timeout: 10_000 });
    expect(await inspector.locator(".gates").textContent()).toMatch(/pass/i);
    await inspector.locator(".tab", { hasText: "Changes" }).click();
    await inspector.locator(".change-list .change", { hasText: "app.txt" }).click();
    const added = inspector.locator("table.diff tr", { has: page.locator('td.mk[aria-label="added"]') });
    await added.first().waitFor({ timeout: 10_000 });
    expect(await added.locator("td.tx").allTextContents()).toEqual(["fixed", "and tidy"]);
    await inspector.locator(".tab", { hasText: "Plan" }).click();
    await inspector.getByText("Demo plan").first().waitFor({ timeout: 10_000 });

    // Back to what the user config and the defaults say: deleted from the project's file, not written as null.
    await openSettings("Configuration");
    await resetEntry("This project", "codex.model");
    await resetEntry("This project", "agents.code_reviewer");
    await resetEntry("This project", "codex.role_efforts.code_reviewer");
    await resetEntry("This project", "claude.role_models.implementer");
    await closeSettings();
    const project = YAML.parse(readFileSync(join(repo, ".agentduo", "config.yaml"), "utf8"));
    expect(project.codex ?? {}).not.toHaveProperty("model");
    expect(project.agents ?? {}).not.toHaveProperty("code_reviewer");
    expect(project.codex ?? {}).not.toHaveProperty("role_efforts");
    expect(project.claude ?? {}).not.toHaveProperty("role_models");
  });

  it("stops an answer with the Stop button", async () => {
    fake.setScenario({ chat_codex: [{ sleep: 60_000, answer: "too late" }] });
    const before = fake.calls("chat_codex").length;
    // /claude earlier made Claude this conversation's recipient: /codex names Codex again.
    await send("/codex A slow question");
    await waitUntil(() => fake.calls("chat_codex").length > before, 30_000, "the slow answer to start");
    // While it works, its conversation and its project pulse; nothing else does.
    const dots = page.locator(".sidebar .busy-dot");
    await expect.poll(() => page.locator(".sidebar .nav-item.conversation.active .busy-dot").count(), { timeout: 10_000 }).toBe(1);
    expect(await page.locator(".sidebar .nav-item.project.active .busy-dot").count()).toBe(1);
    expect(await dots.count()).toBe(2);
    if (process.env.AGENTDUO_E2E_SHOTS) {
      mkdirSync(process.env.AGENTDUO_E2E_SHOTS, { recursive: true });
      await page.locator(".sidebar").screenshot({ path: join(process.env.AGENTDUO_E2E_SHOTS, "working.png") });
    }
    await page.locator(`${SHOWN} .send-btn`).click();
    await seeInChat("Stopped before it answered.", 20_000);
    // Nothing works any more (the status line goes back to the conversation's last run).
    await expect.poll(() => page.locator(".top-status").getAttribute("class"), { timeout: 10_000 }).toBe("top-status");
    expect(await page.locator(".top-status").textContent()).not.toMatch(/answering|working/);
    await expect.poll(() => dots.count(), { timeout: 10_000 }).toBe(0);
  });

  it("keeps Enter for the IME while it composes, hides the inspector in a narrow window, and draws light and dark", async () => {
    const shots = process.env.AGENTDUO_E2E_SHOTS;
    const shot = async (name: string) => {
      if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
    };
    if (shots) mkdirSync(shots, { recursive: true });
    await shot("dark");
    // Enter that commits an IME word sends nothing; the Enter after it sends the message.
    fake.setScenario({ chat_codex: [{ answer: "Codex read 日本語" }] });
    const input = page.locator(`${SHOWN} .composer-input`);
    const sent = await page.locator(`${SHOWN} .user-msg`).count();
    await input.fill("/codex 日本語");
    await input.evaluate((el) => {
      el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true, cancelable: true }));
      el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本語" }));
    });
    expect(await input.inputValue()).toBe("/codex 日本語");
    expect(await page.locator(`${SHOWN} .user-msg`).count()).toBe(sent);
    await input.press("Enter");
    await seeInChat("Codex read 日本語");

    // Narrow: the inspector gives the chat its room, and its button brings it back over it.
    const resize = (width: number) => app!.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0]!.setSize(w, 760), width);
    await resize(820);
    await expect.poll(() => page.evaluate(() => document.body.classList.contains("narrow"))).toBe(true);
    expect(await page.locator(".inspector").isHidden()).toBe(true);
    await shot("narrow");
    await page.locator(".topbar .icon-btn").click();
    expect(await page.locator(".inspector").isVisible()).toBe(true);
    await resize(1360);
    await expect.poll(() => page.evaluate(() => document.body.classList.contains("narrow"))).toBe(false);

    await openSettings("General");
    await page.locator("#pref-theme").selectOption("light");
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
    await closeSettings();
    await shot("light");
    await openSettings("General");
    await page.locator("#pref-theme").selectOption("dark");
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    await closeSettings();
  });

  it("resizes the sidebar by dragging its edge or with the keyboard, resets it with a double-click, and keeps the width after a restart", async () => {
    const width = () => page.locator(".sidebar").evaluate((e) => Math.round(e.getBoundingClientRect().width));
    const saved = async () => (await invoke<{ prefs: { sidebarWidth: number } }>({ method: "app.state" })).prefs.sidebarWidth;
    const edge = page.locator(".sidebar-edge");
    const drag = async (by: number) => {
      const box = (await edge.boundingBox())!;
      const x = box.x + box.width / 2;
      await page.mouse.move(x, box.y + 300);
      await page.mouse.down();
      await page.mouse.move(x + by / 2, box.y + 300, { steps: 3 });
      await page.mouse.move(x + by, box.y + 300, { steps: 3 });
      await page.mouse.up();
    };
    expect(await width()).toBe(248);
    await drag(100);
    expect(await width()).toBe(348);
    await expect.poll(saved).toBe(348);
    // No wider than its limit, however far it goes.
    await drag(400);
    expect(await width()).toBe(480);
    await edge.focus();
    await edge.press("ArrowLeft");
    expect(await edge.getAttribute("aria-valuenow")).toBe("464");
    await expect.poll(saved).toBe(464);
    await edge.dblclick();
    expect(await width()).toBe(248);
    await expect.poll(saved).toBe(248);
    await drag(72);
    await expect.poll(saved).toBe(320);
    await quit();
    await launch();
    await page.locator(`${SHOWN} .composer-input`).waitFor({ timeout: 30_000 });
    expect(await width()).toBe(320);
    await page.locator(".sidebar-edge").dblclick();
    await expect.poll(saved).toBe(248);
  });

  it("finds a newer version on its update feed and says how to get it, in Settings and the sidebar", async () => {
    await openSettings("General");
    const row = page.locator(".settings .update-row");
    expect(await row.locator(".setting-label").textContent()).toMatch(/^AgentDuo \d+\.\d+\.\d+/);
    // The first automatic check may have come already; otherwise Check now asks.
    const check = row.getByRole("button", { name: "Check now" });
    if (await check.isVisible()) await check.click();
    await expect.poll(() => row.getAttribute("data-status"), { timeout: 30_000 }).toBe("manual");
    expect(await row.locator(".setting-help").textContent()).toBe("AgentDuo 99.0.0 is out. This run checks a test feed and installs nothing. Download it from GitHub.");
    expect(await row.getByRole("button", { name: "Download" }).isVisible()).toBe(true);
    expect(feedRequests.some((u) => /latest.*\.yml/.test(u))).toBe(true);
    // Only told: nothing was downloaded.
    expect(feedRequests.some((u) => u.includes(".zip"))).toBe(false);
    // The timer is a preference; a check can still be asked for.
    const auto = page.locator("#pref-auto-update");
    expect(await auto.isChecked()).toBe(true);
    await auto.uncheck();
    await expect.poll(async () => (await invoke<{ prefs: { autoUpdate: boolean } }>({ method: "app.state" })).prefs.autoUpdate).toBe(false);
    await auto.check();
    await expect.poll(async () => (await invoke<{ prefs: { autoUpdate: boolean } }>({ method: "app.state" })).prefs.autoUpdate).toBe(true);
    await closeSettings();
    const notice = page.locator(".side-foot .update-notice");
    expect(await notice.textContent()).toBe("Get AgentDuo 99.0.0");
    expect(await notice.getAttribute("title")).toBe("AgentDuo 99.0.0 is out: download it from GitHub");
  });

  it("shows About from the menu: the version, what it runs on, and the website in the browser", async () => {
    // The browser is main's shell.openExternal: recorded here instead of opened.
    await app!.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as unknown as { opened: string[] }).opened = opened;
      shell.openExternal = async (url: string) => void opened.push(url);
    });
    await app!.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById("about")!.click());
    await page.locator(".settings .about-head").waitFor({ timeout: 10_000 });
    expect(await page.locator(".settings-nav .settings-tab.active").textContent()).toBe("About");
    const state = await invoke<{ versions: { app: string; electron: string } }>({ method: "app.state" });
    expect(await page.locator(".settings .about-head").textContent()).toContain(`Version ${state.versions.app}`);
    expect(await page.locator(".settings .about-facts").textContent()).toContain(state.versions.electron);
    expect(await page.locator(".settings .about-icon").evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    if (process.env.AGENTDUO_E2E_SHOTS) await page.screenshot({ path: join(process.env.AGENTDUO_E2E_SHOTS, "about.png") });
    await page.locator(".settings .about-links").getByRole("button", { name: "Website" }).click();
    await expect.poll(() => app!.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)).toEqual(["https://agentduo.netlify.app/"]);
    await closeSettings();
  });

  it("quits mid-run (freeing the lock), starts again on the same conversation, and resumes the run", async () => {
    const before = await activeConversation();
    fake.setScenario({ ...happyPlan(), implementer: [{ sleep: 60_000, write: { "app.txt": "fixed\n" }, output: impl() }], code_reviewer: [{ output: review(true) }] });
    const implementing = fake.calls("implementer").length;
    await send("/pipeline Tidy app.txt");
    await waitUntil(() => fake.calls("implementer").length > implementing, 45_000, "the implementer");
    await quit();
    expect(existsSync(join(runsDir, ".lock"))).toBe(false);
    const stopped = runOf("Tidy app.txt")!;
    expect(["DONE", "ABORTED"]).not.toContain(stopped.phase);

    fake.setScenario({ ...happyPlan(), implementer: [{ write: { "app.txt": "fixed\n" }, output: impl() }], code_reviewer: [{ output: review(true) }] });
    await launch();
    // The same project and conversation as before the quit, with its history; the dark theme too.
    await page.locator(`${SHOWN} .composer-input`).waitFor({ timeout: 30_000 });
    expect(await activeConversation()).toEqual(before);
    await seeInChat("Codex says hello", 20_000);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    expect(await page.locator(".overlay.onboarding").isHidden()).toBe(true);

    await page.locator(".sidebar .nav-head.toggle", { hasText: "Resumable runs" }).click();
    await page.locator(".sidebar .nav-item.run", { hasText: "Tidy app.txt" }).click();
    await waitUntil(() => runOf("Tidy app.txt")?.phase === "DONE", 90_000, "the resumed run to finish");
    await quit();
    expect(existsSync(join(runsDir, ".lock"))).toBe(false);
    expect(log.some((l) => / up: agentduo .* on Node \d+/.test(l))).toBe(true);
  });

  it("runs a pipeline in a project folder with no git repository, and shows its changes again after a restart", async () => {
    const plain = join(scratch.path, "plain project");
    mkdirSync(plain);
    writeFileSync(join(plain, "old.txt"), "old\n");
    const plainRuns = join(plain, ".agentduo", "runs");
    env.AGENTDUO_DESKTOP_TEST_FOLDER = plain;
    fake.setScenario({ ...happyPlan(), implementer: [{ write: { "app.txt": "fixed\n" }, delete: ["old.txt"], output: impl() }], code_reviewer: [{ output: review(true) }] });
    await launch();
    await page.locator(`${SHOWN} .composer-input`).waitFor({ timeout: 30_000 });
    const before = await activeConversation();
    await page.locator(".sidebar").getByTitle("Open project…").first().click();
    await page.locator(".sidebar .nav-item.project", { hasText: "plain project" }).waitFor({ timeout: 30_000 });
    await expect.poll(async () => (await activeConversation()).projectId, { timeout: 30_000 }).not.toBe(before.projectId);
    await expect.poll(async () => (await activeConversation()).conversationId, { timeout: 30_000 }).not.toBeNull();
    await page.locator(`${SHOWN} .composer-input`).waitFor({ timeout: 30_000 });
    await send("/pipeline Make app.txt fixed");
    await waitUntil(() => RunStore.list(plainRuns).some((r) => r.phase === "DONE"), 90_000, "the run in the folder with no git repository");
    expect(RunStore.list(plainRuns)[0]!.git?.mode).toBe("internal");
    expect(existsSync(join(plain, ".git"))).toBe(false);

    const showsChange = async () => {
      const inspector = page.locator(".inspector");
      if (await inspector.isHidden()) await page.locator(".topbar .icon-btn").click();
      await inspector.locator(".tab", { hasText: "Changes" }).click();
      await inspector.locator(".change-list .change", { hasText: "app.txt" }).click();
      const added = inspector.locator("table.diff tr", { has: page.locator('td.mk[aria-label="added"]') });
      await added.first().waitFor({ timeout: 10_000 });
      expect(await added.locator("td.tx").allTextContents()).toEqual(["fixed"]);
    };
    await showsChange();
    // Started again, its changes still come from the repository the run recorded.
    const shown = await activeConversation();
    await quit();
    await launch();
    await page.locator(`${SHOWN} .composer-input`).waitFor({ timeout: 30_000 });
    expect(await activeConversation()).toEqual(shown);
    await showsChange();
    await quit();
  });
});
