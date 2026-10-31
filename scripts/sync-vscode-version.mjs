// `npm version` runs this (the "version" script) after it bumps package.json and before it commits: the extension's
// manifest and the desktop app's (with its lockfile) take the same version, as build-vscode.mjs and the desktop's
// packaging test require, and go into the same commit and tag. Only "version" lines change, so the manifests keep
// their layout; the lockfile is npm's own JSON, written back as npm writes it.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(readFileSync(`${root}package.json`, "utf8"));

for (const name of ["extensions/vscode/package.json", "apps/desktop/package.json"]) {
  const file = `${root}${name}`;
  const text = readFileSync(file, "utf8");
  const next = text.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${version}$2`);
  if (next === text && JSON.parse(text).version !== version) throw new Error(`no "version" line in ${file}`);
  writeFileSync(file, next);
  console.log(`${name} is version ${version}`);
}

const lockFile = `${root}apps/desktop/package-lock.json`;
const lock = JSON.parse(readFileSync(lockFile, "utf8"));
lock.version = version;
if (lock.packages?.[""]) lock.packages[""].version = version;
writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`apps/desktop/package-lock.json is version ${version}`);
