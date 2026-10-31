// Builds the app, then packages it with electron-builder for this OS (native targets: build each OS on that OS).
//   node scripts/package.mjs [--mac|--win|--linux] [--dir] [--test-fuses] [-- <more electron-builder args>]
// --dir: an unpacked app only (release/<os>-unpacked, release/mac*), as test:pack checks it. --test-fuses: the
// inspector-enabled profile for Playwright (scripts/fuses.mjs); never for a release.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const pass = args.includes("--") ? args.slice(args.indexOf("--") + 1) : [];
const own = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
const builder = join(here, "node_modules", "electron-builder", "cli.js");
if (!existsSync(builder)) throw new Error("electron-builder is not installed: run `npm ci` at the repository root, then `npm ci --prefix apps/desktop`");

const env = { ...process.env };
if (own.includes("--test-fuses")) env.AGENTDUO_FUSES = "test";
const targets = [];
for (const flag of ["--mac", "--win", "--linux"]) if (own.includes(flag)) targets.push(flag);
if (own.includes("--dir")) targets.push("--dir");
const extra = [];
// A Developer ID build names its certificate; without one the config's ad-hoc identity ("-") applies.
const identity = process.env.AGENTDUO_MAC_IDENTITY || process.env.CSC_NAME;
if (identity) extra.push(`-c.mac.identity=${identity}`);
// AGENTDUO_NOTARIZE=1: notarize a Developer ID build (with APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID).
if (process.env.AGENTDUO_NOTARIZE === "1") extra.push("-c.mac.notarize=true");

if (!own.includes("--no-build")) execFileSync(process.execPath, [join(here, "scripts", "build.mjs")], { cwd: here, stdio: "inherit", env });
execFileSync(process.execPath, [builder, ...targets, "--publish", "never", ...extra, ...pass], { cwd: here, stdio: "inherit", env });
