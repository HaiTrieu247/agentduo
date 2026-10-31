// Builds the desktop app into apps/desktop/dist with the checkout's own toolchain (esbuild from the root's
// node_modules): main and preload (CJS, Electron), the renderer (a browser bundle, no Node), and the engine worker
// (ESM, every dependency bundled) beside a package.json named agentduo and the schemas, in dist/runtime, which the
// package keeps outside the ASAR archive so packageRoot() finds them.
//   node scripts/build.mjs [--only main,preload,renderer,runtime]
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const root = join(desktop, "..", "..");
const require = createRequire(join(root, "package.json"));
const esbuild = require("esbuild");
const args = process.argv.slice(2);
const i = args.indexOf("--only");
const only = (i >= 0 ? args[i + 1] : "main,preload,renderer,runtime").split(",");
const out = join(desktop, "dist");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
if (manifest.version !== pkg.version) throw new Error(`apps/desktop/package.json is version ${manifest.version}, agentduo is ${pkg.version}; keep them the same`);
if (manifest.dependencies && Object.keys(manifest.dependencies).length) throw new Error("apps/desktop has no runtime dependencies: everything it runs is bundled");

const common = { bundle: true, logLevel: "warning", legalComments: "none", sourcemap: false, absWorkingDir: root };
const builds = {
  main: {
    entryPoints: [join(desktop, "src", "main", "index.ts")], outfile: join(out, "main", "index.cjs"), format: "cjs", platform: "node", target: "node22", external: ["electron"],
    // Shared modules that look for agentduo's files from import.meta.url get this file's URL in the CommonJS bundle.
    banner: { js: "const __agentduoImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" }, define: { "import.meta.url": "__agentduoImportMetaUrl" },
  },
  preload: { entryPoints: [join(desktop, "src", "preload", "index.ts")], outfile: join(out, "preload", "index.cjs"), format: "cjs", platform: "node", target: "node22", external: ["electron"] },
  renderer: { entryPoints: [join(desktop, "src", "renderer", "main.ts")], outfile: join(out, "renderer", "main.js"), format: "iife", platform: "browser", target: "es2022" },
  runtime: {
    entryPoints: [join(root, "extensions", "vscode", "src", "worker.ts")], outfile: join(out, "runtime", "worker.js"), format: "esm", platform: "node", target: "node22",
    // CommonJS dependencies (ajv) call require() for Node built-ins, which an ES module does not have by itself.
    banner: { js: "import { createRequire as __agentduoCreateRequire } from 'node:module'; const require = __agentduoCreateRequire(import.meta.url);" },
  },
};

for (const name of only) {
  const b = builds[name];
  if (!b) throw new Error(`unknown build ${name}`);
  rmSync(join(out, name), { recursive: true, force: true });
  await esbuild.build({ ...common, ...b });
}

// The app icon, for the window on Windows and Linux and the Dock of a Mac dev build (a package has its own).
if (only.includes("main")) copyFileSync(join(desktop, "resources", "icon.png"), join(out, "main", "icon.png"));
if (only.includes("renderer")) {
  const dir = join(out, "renderer");
  const js = readFileSync(join(dir, "main.js"), "utf8");
  if (/\brequire\(["']node:|from ["']node:/.test(js)) throw new Error("the renderer bundle imports Node; it must not");
  copyFileSync(join(desktop, "src", "renderer", "index.html"), join(dir, "index.html"));
  copyFileSync(join(desktop, "src", "renderer", "styles.css"), join(dir, "styles.css"));
  copyFileSync(join(root, "extensions", "vscode", "webview", "styles.css"), join(dir, "webview.css"));
  // VS Code's icon font, which the reused chat UI draws its icons with. The font is CC BY 4.0: its licence goes along.
  const codicons = join(root, "node_modules", "@vscode", "codicons");
  for (const file of ["codicon.css", "codicon.ttf"]) copyFileSync(join(codicons, "dist", file), join(dir, file));
  copyFileSync(join(codicons, "LICENSE"), join(dir, "codicon-LICENSE.txt"));
}
if (only.includes("runtime")) {
  writeFileSync(join(out, "runtime", "package.json"), `${JSON.stringify({
    name: "agentduo", version: pkg.version, private: true, type: "module", description: "agentduo's engine, bundled for the desktop app", license: pkg.license,
  }, null, 2)}\n`);
  cpSync(join(root, "schemas"), join(out, "runtime", "schemas"), { recursive: true });
  mkdirSync(join(out, "runtime"), { recursive: true });
}
console.log(`built ${only.join(", ")} into ${out}`);
