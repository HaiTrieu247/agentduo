// `npm version` runs this (the "version" script) after it bumps package.json and before it commits: the extension's
// manifest takes the same version, as build-vscode.mjs requires, and goes into the same commit and tag. Only its
// "version" line changes, so the rest of the manifest keeps its layout.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
const file = `${root}extensions/vscode/package.json`;
const text = readFileSync(file, "utf8");
const next = text.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${version}$2`);
if (next === text && JSON.parse(text).version !== version) throw new Error(`no "version" line in ${file}`);
writeFileSync(file, next);
console.log(`extensions/vscode/package.json is version ${version}`);
