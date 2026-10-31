// Builds the app (unless --no-build) and starts it with the Electron of apps/desktop/node_modules.
//   node scripts/dev.mjs [--no-build] [-- <electron args>]
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
if (!args.includes("--no-build")) execFileSync(process.execPath, [join(desktop, "scripts", "build.mjs")], { stdio: "inherit" });
const electron = createRequire(join(desktop, "package.json"))("electron");
const extra = args.includes("--") ? args.slice(args.indexOf("--") + 1) : [];
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [desktop, ...extra], { stdio: "inherit", env });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill(s));
