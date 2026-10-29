// Releases agentduo: the npm package and the VS Code extension, at one version.
//   npm version patch|minor|major   preversion runs `check`, version syncs the extension's manifest, postversion runs `publish`
//   npm run release                 runs `publish` again after a step failed; what is already out is skipped
//   node scripts/release.mjs check  the checks alone, without a version bump
// `check` runs before the bump, so a failing test or a missing login leaves no version commit behind. `publish` packages
// the VSIX before anything goes out, then publishes to npm and to the Marketplace, and pushes the commit and tag last.
// The Marketplace token comes from VSCE_PAT or `vsce login HaiTrieuThinh` (vsce asks for it once and keeps it); with
// VSCE_AZURE_CREDENTIAL set, vsce signs in with Microsoft Entra ID (`az login`) instead.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const ext = join(root, "extensions", "vscode");
const branch = "main";
const { name, version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(ext, "package.json"), "utf8"));
const tag = `v${version}`;
const vsix = join(ext, `agentduo-vscode-${version}.vsix`);

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
const read = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};
const vsce = (args) => run(process.execPath, [join(root, "node_modules", "@vscode", "vsce", "vsce"), ...args,
  ...(process.env.VSCE_AZURE_CREDENTIAL ? ["--azure-credential"] : [])], { cwd: ext });
const onNpm = () => {
  const view = spawnSync("npm", ["view", `${name}@${version}`, "version"], { cwd: root, encoding: "utf8" });
  if (view.status === 0) return view.stdout.trim() === version;
  if (view.stderr.includes("E404")) return false;
  process.stderr.write(view.stderr);
  return fail(`could not ask npm whether ${name}@${version} is published`);
};

const mode = process.argv[2];
if (mode === "check") {
  if (read("git", ["branch", "--show-current"]) !== branch) fail(`release from ${branch}`);
  run("git", ["fetch", "--quiet", "origin", branch]);
  // The push comes after both publishes, so a branch that cannot fast-forward origin has to stop the release here.
  if (read("git", ["rev-list", "--count", `HEAD..origin/${branch}`]) !== "0") fail(`${branch} is behind origin/${branch}; pull first`);
  try {
    console.log(`npm: logged in as ${read("npm", ["whoami"])}`);
  } catch {
    fail("log in to npm first (npm login)");
  }
  vsce(["verify-pat", manifest.publisher]);
  for (const script of ["typecheck", "test", "typecheck:vscode", "test:pack", "test:pack:vscode"]) run("npm", ["run", script]);
} else if (mode === "publish") {
  if (read("git", ["status", "--porcelain", "--untracked-files=no"])) fail("commit or stash your changes first");
  if (!read("git", ["tag", "--points-at", "HEAD"]).split("\n").includes(tag)) fail(`HEAD is not tagged ${tag}; run npm version patch|minor|major`);
  run(process.execPath, [join(root, "scripts", "build-vscode.mjs"), "--package", vsix]);
  if (onNpm()) console.log(`${name}@${version} is already on npm`);
  else run("npm", ["publish"]);
  vsce(["publish", "--packagePath", vsix, "--skip-duplicate"]);
  run("git", ["push", "--atomic", "origin", branch, tag]);
  console.log(`released ${name} ${version}: npm, the Marketplace (${manifest.publisher}.${manifest.name}) and origin`);
} else {
  fail("usage: node scripts/release.mjs check|publish");
}
