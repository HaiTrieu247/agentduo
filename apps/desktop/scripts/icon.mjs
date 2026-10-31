// Renders the app icon's source (resources/icon.svg) into resources/icon.png, 1024×1024, from which electron-builder
// makes every platform's icon (icns, ico, Linux PNGs). It draws with the Chromium of apps/desktop's Electron, so it
// needs no image tool. Run it after changing icon.svg, and commit both files.
//   node scripts/icon.mjs [<svg> <png> [<size>]]
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const [svg = join(desktop, "resources", "icon.svg"), png = join(desktop, "resources", "icon.png"), size = "1024"] = process.argv.slice(2);

if (!process.versions.electron) {
  const electron = createRequire(join(desktop, "package.json"))("electron");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(electron, [fileURLToPath(import.meta.url), resolve(svg), resolve(png), size], { stdio: "inherit", env });
  process.exit(r.status ?? 1);
}

// Electron emits "ready" only once this module's top-level awaits settle, so the rendering must not await it here.
const { app, BrowserWindow } = await import("electron");
app.dock?.hide();
app.whenReady().then(render).then(() => app.quit(), (e) => {
  console.error(e);
  app.exit(1);
});

async function render() {
  const n = Number(size);
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } });
  await win.loadURL("about:blank");
  const source = `data:image/svg+xml;base64,${readFileSync(svg).toString("base64")}`;
  const data = await win.webContents.executeJavaScript(`new Promise((done, fail) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = ${n};
      const g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(img, 0, 0, ${n}, ${n});
      done(c.toDataURL("image/png"));
    };
    img.onerror = () => fail(new Error("the SVG did not load"));
    img.src = ${JSON.stringify(source)};
  })`);
  writeFileSync(png, Buffer.from(data.slice(data.indexOf(",") + 1), "base64"));
  console.log(`wrote ${png} (${n}×${n})`);
}
