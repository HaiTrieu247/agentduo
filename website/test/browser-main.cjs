// A minimal Electron main for scripts/browser-check.mjs: one isolated window on the website preview, nothing else.
// It is not the AgentDuo desktop app. The profile lives in the folder given with --user-data-dir.
const { app, BrowserWindow } = require("electron");

const url = process.argv.find((a) => a.startsWith("http://127.0.0.1:"));
const profile = process.argv.find((a) => a.startsWith("--user-data-dir="));
if (profile) app.setPath("userData", profile.slice("--user-data-dir=".length));

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadURL(url);
});

app.on("window-all-closed", () => app.quit());
