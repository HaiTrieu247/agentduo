// `npm version` runs this (the root's "version" script) after it bumps the root package.json and before it commits:
// every package of the repository takes the same version (the CLI, the extension and the desktop app, which their
// builds and the desktop's packaging test require, and the shared packages), and so do the lockfiles' entries for them,
// so it all goes into the same commit and tag. Only "version" lines change, so the manifests keep their layout; the
// lockfiles are npm's own JSON, written back as npm writes it.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
const workspaces = ["apps/cli", "apps/vscode", "packages/engine", "packages/host", "packages/webview"];

for (const dir of [...workspaces, "apps/desktop"]) {
  const file = `${root}${dir}/package.json`;
  const text = readFileSync(file, "utf8");
  const next = text.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${version}$2`);
  if (next === text && JSON.parse(text).version !== version) throw new Error(`no "version" line in ${file}`);
  writeFileSync(file, next);
  console.log(`${dir}/package.json is version ${version}`);
}

/** Sets the version of the lockfile's entries for `dirs` ("" is the lockfile's own package). */
function syncLock(name, dirs) {
  const file = `${root}${name}`;
  const lock = JSON.parse(readFileSync(file, "utf8"));
  lock.version = version;
  for (const dir of dirs) if (lock.packages?.[dir]) lock.packages[dir].version = version;
  writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`${name} is version ${version}`);
}
syncLock("package-lock.json", ["", ...workspaces]);
syncLock("apps/desktop/package-lock.json", [""]);
