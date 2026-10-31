// The app's one window: an isolated, sandboxed renderer on the app's own origin, with the preload as its only bridge.
// It navigates nowhere and opens no other window; links go to the user's browser only through the host's LINKS.
import { BrowserWindow, nativeTheme, screen, type BrowserWindowConstructorOptions } from "electron";
import { join } from "node:path";
import { APP_ORIGIN } from "../shared/protocol.js";

export function windowOptions(o: { preload: string; icon: string; dark: boolean; platform: NodeJS.Platform }): BrowserWindowConstructorOptions {
  return {
    width: 1360, height: 860, minWidth: 720, minHeight: 480, show: false, title: "AgentDuo",
    // Windows and Linux show the window's own icon (a Mac shows the app bundle's).
    ...(o.platform === "darwin" ? {} : { icon: o.icon }),
    backgroundColor: o.dark ? "#16171b" : "#fbfbfa",
    titleBarStyle: o.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: o.preload, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, spellcheck: true, devTools: true,
    },
  };
}

export function createWindow(o: { dir: string; platform: NodeJS.Platform }): BrowserWindow {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const options = windowOptions({ preload: join(o.dir, "preload", "index.cjs"), icon: join(o.dir, "main", "icon.png"), dark: nativeTheme.shouldUseDarkColors, platform: o.platform });
  options.width = Math.min(options.width!, width);
  options.height = Math.min(options.height!, height);
  const win = new BrowserWindow(options);
  const contents = win.webContents;
  contents.on("will-navigate", (e, url) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) e.preventDefault();
  });
  contents.on("will-redirect", (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-attach-webview", (e) => e.preventDefault());
  contents.session.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === "clipboard-sanitized-write"));
  win.once("ready-to-show", () => win.show());
  void win.loadURL(`${APP_ORIGIN}/index.html`);
  return win;
}
