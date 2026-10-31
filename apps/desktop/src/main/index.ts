// The desktop app's main process: one window, the projects and their workers, the app's own protocol, the menu, the
// app's own updates, and the requests of the renderer (checked in ipc.ts). The engine runs in a worker per project,
// started with this very executable as Node (ELECTRON_RUN_AS_NODE), so the app needs no Node installed.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, Notification, protocol, shell, type MenuItemConstructorOptions } from "electron";
import { AppImageUpdater, autoUpdater, type AppUpdater } from "electron-updater";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { EVENT_CHANNEL, INVOKE_CHANNEL, type AppSnapshot, type DesktopEvent, type LauncherInfo, type MenuCommand } from "../shared/protocol.js";
import { LogBuffer } from "./diagnostics.js";
import { launcherEnvironment } from "./environment.js";
import { Dispatcher } from "./ipc.js";
import { PreferencesStore } from "./preferences.js";
import { ProjectManager } from "./projects.js";
import { appFile, CONTENT_SECURITY_POLICY, ResourceTokens } from "./resources.js";
import { bundledNode, runtimeDir, runtimeProblems } from "./runtime.js";
import { macDeveloperId, updateMode, Updates, type UpdateMode, type Updater } from "./updates.js";
import { createWindow } from "./window.js";

// Tests give the app a profile of its own, so they never touch the user's.
if (process.env.AGENTDUO_DESKTOP_USER_DATA) app.setPath("userData", process.env.AGENTDUO_DESKTOP_USER_DATA);

protocol.registerSchemesAsPrivileged([{ scheme: "agentduo", privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false } }]);

const logs = new LogBuffer();
const log = (line: string) => {
  logs.add(line);
  if (!app.isPackaged || process.env.AGENTDUO_DESKTOP_LOG) console.log(`[agentduo] ${line}`);
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}

/** electron-updater's updater for this build, logging to the app's log; null when the build never looks for updates. */
function createUpdater(mode: UpdateMode, testFeed: string | null): Updater | null {
  if (mode.kind === "off") return null;
  // An AppImage updates as an AppImage, whatever package-type file a .deb built from the same folder left behind.
  const u: AppUpdater = process.platform === "linux" && process.env.APPIMAGE ? new AppImageUpdater() : autoUpdater;
  const line = (m: unknown) => log(`updater: ${String(m).split("\n")[0]!.slice(0, 300)}`);
  u.logger = { info: line, warn: line, error: line, debug: () => undefined };
  // A .deb installs with pkexec: only when the user restarts into the update, never as a surprise at quit.
  u.autoInstallOnAppQuit = !(process.platform === "linux" && !process.env.APPIMAGE);
  if (testFeed) {
    u.forceDevUpdateConfig = true;
    u.updateConfigPath = testFeed;
  }
  return u;
}

async function main(): Promise<void> {
  await app.whenReady();
  const dir = join(__dirname, "..");
  // A packaged Mac app shows its bundle's icon; a dev build is Electron's own bundle, so its Dock gets agentduo's.
  if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(join(dir, "main", "icon.png"));
  const rendererDir = join(dir, "renderer");
  const runtime = runtimeDir({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
  const userData = app.getPath("userData");
  const logsDir = app.getPath("logs");
  const prefs = new PreferencesStore(join(userData, "preferences.json"));
  const tokens = new ResourceTokens();
  let win: BrowserWindow | null = null;
  const post = (event: DesktopEvent) => {
    if (win && !win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, event);
  };

  // The PATH the agents get: an app opened from the Dock, the Start menu or a launcher has a short one.
  let env: NodeJS.ProcessEnv = { ...process.env };
  let launcher: LauncherInfo | null = null;
  const resolved = launcherEnvironment({ env: process.env }).then((r) => {
    env = r.env;
    launcher = r.info;
    log(`PATH from ${r.info.sources.join(", ")} (${r.info.entries} entries)${r.info.shellProblem ? `; login shell: ${r.info.shellProblem}` : ""}`);
  }).catch((e) => log(`could not resolve the launcher PATH: ${(e as Error).message}`));

  const problems = runtimeProblems(runtime);
  if (problems.length) log(`the engine runtime is incomplete: ${problems.join("; ")}`);
  const staging = join(app.getPath("temp"), `agentduo-staging-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const testFolder = process.env.AGENTDUO_DESKTOP_TEST_FOLDER || null;

  // Updates: what this build can do is known once codesign has said how a packaged Mac app is signed.
  const testProfile = !!process.env.AGENTDUO_DESKTOP_USER_DATA;
  const testFeed = testProfile ? process.env.AGENTDUO_DESKTOP_UPDATE_CONFIG || null : null;
  let updates: Updates | null = null;
  const updatesReady = (process.platform === "darwin" && app.isPackaged ? macDeveloperId(join(process.execPath, "..", "..", "..")) : Promise.resolve(false)).then((developerId) => {
    const mode = updateMode({ packaged: app.isPackaged, platform: process.platform, testProfile, testFeed, developerId });
    log(`updates: ${mode.kind === "install" ? "installed by the app" : `${mode.kind} (${mode.reason})`}`);
    updates = new Updates({ mode, updater: createUpdater(mode, testFeed), log, post: (state) => post({ type: "update", state }), quit: () => app.quit() });
    updates.setAuto(prefs.prefs.autoUpdate);
    post({ type: "update", state: updates.state });
    return updates;
  });
  let autoUpdate = prefs.prefs.autoUpdate;

  const projects = new ProjectManager({
    prefs, tokens, post, log, stagingDir: staging, workerScript: join(runtime, "worker.js"), env: () => env,
    resolveNode: () => (problems.length ? { ok: false, message: `AgentDuo's engine is missing from this build: ${problems.join("; ")}` } : bundledNode({ execPath: process.execPath, node: process.versions.node })),
    host: {
      pickFiles: async () => {
        const r = win ? await dialog.showOpenDialog(win, { title: "Attach files to your next message", properties: ["openFile", "multiSelections"] }) : null;
        return r && !r.canceled ? r.filePaths : [];
      },
      copy: (text) => clipboard.writeText(text),
      notify: (title, body) => {
        if (Notification.isSupported() && !win?.isFocused()) new Notification({ title, body }).show();
      },
    },
  });

  const snapshot = (): AppSnapshot => ({
    prefs: prefs.prefs, projects: projects.summaries(), active: projects.active, platform: process.platform, userData, dark: nativeTheme.shouldUseDarkColors,
    versions: { app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    update: updates?.state ?? { status: "idle" },
  });

  const applyTheme = () => {
    nativeTheme.themeSource = prefs.prefs.theme;
  };
  applyTheme();
  nativeTheme.on("updated", () => post({ type: "theme", dark: nativeTheme.shouldUseDarkColors }));

  const dispatcher = new Dispatcher({
    projects, prefs, logs, userData, logsDir, env: () => env, launcher: () => launcher, snapshot,
    prefsChanged: () => {
      applyTheme();
      if (prefs.prefs.autoUpdate !== autoUpdate) {
        autoUpdate = prefs.prefs.autoUpdate;
        updates?.setAuto(autoUpdate);
      }
      post({ type: "app", snapshot: snapshot() });
    },
    updates: {
      check: () => updatesReady.then((u) => u.check()),
      install: () => {
        if (!updates) throw new Error("No update is ready to install.");
        updates.install();
      },
    },
    shell: {
      chooseFolder: async () => {
        if (testFolder) return testFolder;
        const r = win ? await dialog.showOpenDialog(win, { title: "Open a project", properties: ["openDirectory", "createDirectory"] }) : null;
        return r && !r.canceled ? r.filePaths[0] ?? null : null;
      },
      chooseBinary: async (backend) => {
        const r = win ? await dialog.showOpenDialog(win, { title: `Choose the ${backend} CLI`, properties: ["openFile", "showHiddenFiles"] }) : null;
        return r && !r.canceled ? r.filePaths[0] ?? null : null;
      },
      saveFile: async (name) => {
        const r = win ? await dialog.showSaveDialog(win, { title: "Export diagnostics", defaultPath: join(app.getPath("downloads"), name) }) : null;
        return r && !r.canceled ? r.filePath ?? null : null;
      },
      openPath: async (path) => {
        const error = await shell.openPath(path);
        if (error) throw new Error(error);
      },
      openExternal: (url) => shell.openExternal(url),
    },
  });

  protocol.handle("agentduo", async (request) => {
    const url = new URL(request.url);
    const found = url.host === "app" ? appFile(rendererDir, url.pathname) : url.host === "resource" ? tokens.resolve(url.pathname.replace(/^\//, "")) : null;
    if (!found) return new Response("not found", { status: 404 });
    const headers: Record<string, string> = { "content-type": found.type, "x-content-type-options": "nosniff", "cache-control": "no-store" };
    if (found.type.startsWith("text/html")) headers["content-security-policy"] = CONTENT_SECURITY_POLICY;
    return new Response(readFileSync(found.file), { status: 200, headers });
  });

  ipcMain.handle(INVOKE_CHANNEL, async (e, raw: unknown) => {
    await resolved;
    return dispatcher.handle({ senderId: e.sender.id, windowId: win && !win.isDestroyed() ? win.webContents.id : null, mainFrame: e.senderFrame?.parent === null, url: e.senderFrame?.url ?? "" }, raw);
  });

  const menuCommand = (command: MenuCommand) => () => post({ type: "menu", command });
  const checkUpdates: MenuItemConstructorOptions = { label: "Check for Updates…", click: menuCommand("checkUpdates") };
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{
      label: app.name,
      submenu: [
        { role: "about" }, checkUpdates, { type: "separator" }, { role: "services" }, { type: "separator" },
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" },
      ] satisfies MenuItemConstructorOptions[],
    }] : []),
    {
      label: "File",
      submenu: [
        { label: "New Conversation", accelerator: "CmdOrCtrl+N", click: menuCommand("newConversation") },
        { label: "Open Project…", accelerator: "CmdOrCtrl+O", click: menuCommand("openProject") },
        { type: "separator" },
        { label: "Settings…", accelerator: "CmdOrCtrl+,", click: menuCommand("settings") },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Toggle Inspector", accelerator: "CmdOrCtrl+Alt+I", click: menuCommand("toggleInspector") },
        { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" as const }]),
      ],
    },
    { label: "Run", submenu: [{ label: "Stop", accelerator: "CmdOrCtrl+.", click: menuCommand("stop") }] },
    { role: "windowMenu" },
    {
      label: "Help",
      submenu: [
        ...(process.platform === "darwin" ? [] : [checkUpdates, { type: "separator" as const }]),
        { label: "Diagnostics", click: menuCommand("diagnostics") },
        { label: "AgentDuo Guide", click: () => void shell.openExternal("https://github.com/HaiTrieu247/agentduo/tree/main/apps/desktop#readme") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  const open = () => {
    win = createWindow({ dir, platform: process.platform });
    win.once("ready-to-show", () => log("window shown"));
    win.on("closed", () => (win = null));
  };
  open();
  app.on("second-instance", () => {
    if (!win) return open();
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on("activate", () => {
    if (!win) open();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // Quit waits for every worker to settle its open questions, stop its run and free its lock (bounded by its grace).
  // Restarting into an update quits the same way; then the updater's installer quits the app and starts the new one.
  let quitting = false;
  app.on("before-quit", (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    updates?.dispose();
    void projects.dispose().catch((err) => log(`shutdown: ${(err as Error).message}`)).finally(() => {
      rmSync(staging, { recursive: true, force: true });
      if (updates?.installAtQuit()) {
        // The installer quits the app itself; should it not, the app still goes.
        setTimeout(() => app.exit(0), 20_000).unref();
        return;
      }
      app.exit(0);
    });
  });
  log(`agentduo desktop ${app.getVersion()} on Electron ${process.versions.electron} (Node ${process.versions.node}), runtime ${runtime}`);
}
