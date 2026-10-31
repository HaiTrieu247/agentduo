// The Electron end-to-end tests: the built app started for real (main, preload, renderer, the worker run by
// Electron's own Node), driven through Playwright with a profile, a scratch git project and fake CLIs of its own
// (test/e2e, run with vitest.e2e.mts). Builds the app first when there is no build.
//   node scripts/test-electron.mjs [vitest args]
// On Linux CI without the SUID sandbox helper, AGENTDUO_E2E_NO_SANDBOX=1 passes --no-sandbox to these tests only;
// AGENTDUO_E2E_KEEP=1 keeps the scratch directory (profile, project, the fake agents' log).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const root = join(desktop, "..", "..");
if (!existsSync(join(desktop, "dist", "main", "index.cjs")) || !existsSync(join(desktop, "dist", "runtime", "worker.js"))) {
  const built = spawnSync(process.execPath, [join(desktop, "scripts", "build.mjs")], { cwd: desktop, stdio: "inherit" });
  if (built.status !== 0) process.exit(built.status ?? 1);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(process.execPath, [join(root, "node_modules", "vitest", "vitest.mjs"), "run", "--config", "vitest.e2e.mts", ...process.argv.slice(2)], { cwd: desktop, stdio: "inherit", env });
process.exit(r.status ?? 1);
