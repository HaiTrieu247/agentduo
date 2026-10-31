// Three bundles, built by scripts/build-vscode.mjs: the extension host (CJS, inside VS Code), the webviews (browser:
// a conversation's tab and the Account & Usage view) and the engine worker (ESM, run by an external Node >= 22.12,
// with every dependency bundled). A fourth, the Extension Development Host smoke test, is built only when asked for
// (scripts/test-vscode.mjs).
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Options } from "tsup";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = process.env.AGENTDUO_VSCODE_OUT || here;
const only = process.env.AGENTDUO_VSCODE_ONLY?.split(",").filter(Boolean);

const common: Options = { tsconfig: join(here, "tsconfig.json"), clean: false, splitting: false, sourcemap: false, dts: false, silent: true };

const builds: Options[] = [
  {
    ...common, name: "host", entry: { extension: join(here, "src", "extension.ts") }, outDir: join(out, "dist"),
    format: ["cjs"], platform: "node", target: "node20", outExtension: () => ({ js: ".cjs" }),
    external: ["vscode"], noExternal: [/^(?!vscode$)/],
  },
  {
    ...common, name: "webview", entry: { main: join(here, "webview", "main.ts"), sidebar: join(here, "webview", "sidebar.ts") }, outDir: join(out, "dist", "webview"),
    format: ["iife"], platform: "browser", target: "es2022", outExtension: () => ({ js: ".js" }),
  },
  {
    ...common, name: "runtime", entry: { worker: join(here, "src", "worker.ts") }, outDir: join(out, "runtime"),
    format: ["esm"], platform: "node", target: "node22", outExtension: () => ({ js: ".js" }), noExternal: [/.*/],
    // CommonJS dependencies (ajv) call require() for Node built-ins, which an ES module does not have by itself.
    banner: { js: "import { createRequire as __agentduoCreateRequire } from 'node:module'; const require = __agentduoCreateRequire(import.meta.url);" },
  },
  {
    ...common, name: "smoke", entry: { smoke: join(here, "test", "smoke.ts") }, outDir: join(out, "test"),
    format: ["cjs"], platform: "node", target: "node20", outExtension: () => ({ js: ".cjs" }),
    external: ["vscode"], noExternal: [/^(?!vscode$)/],
  },
];

export default defineConfig(builds.filter((b) => (only ? only.includes(b.name!) : b.name !== "smoke")));
