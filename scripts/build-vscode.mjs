// Builds the VS Code extension into extensions/vscode (or --out <dir>): dist/ (host + webview) and runtime/ (the
// engine worker, beside a package.json named agentduo and the schemas, so packageRoot() finds them once installed).
//   node scripts/build-vscode.mjs [--out <dir>] [--only host,webview,runtime] [--package [<file.vsix>]]
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const ext = join(root, "extensions", "vscode");
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};
const out = resolve(option("--out") ?? ext);
const only = (option("--only") ?? "host,webview,runtime").split(",");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(ext, "package.json"), "utf8"));
if (manifest.version !== pkg.version) {
  throw new Error(`extensions/vscode/package.json is version ${manifest.version}, agentduo is ${pkg.version}; keep them the same`);
}

if (only.includes("host") || only.includes("webview")) rmSync(join(out, "dist"), { recursive: true, force: true });
if (only.includes("runtime")) rmSync(join(out, "runtime"), { recursive: true, force: true });
execFileSync(process.execPath, [join(root, "node_modules", "tsup", "dist", "cli-default.js"), "--config", join(ext, "tsup.config.ts")], {
  cwd: root, stdio: "inherit", env: { ...process.env, AGENTDUO_VSCODE_OUT: out, AGENTDUO_VSCODE_ONLY: only.join(",") },
});
if (only.includes("webview")) {
  mkdirSync(join(out, "dist", "webview"), { recursive: true });
  copyFileSync(join(ext, "webview", "styles.css"), join(out, "dist", "webview", "styles.css"));
}
if (only.includes("runtime")) {
  writeFileSync(join(out, "runtime", "package.json"), `${JSON.stringify({
    name: "agentduo", version: pkg.version, private: true, type: "module", description: "agentduo's engine, bundled for the VS Code extension", license: pkg.license,
  }, null, 2)}\n`);
  cpSync(join(root, "schemas"), join(out, "runtime", "schemas"), { recursive: true });
}
if (out === ext) copyFileSync(join(root, "LICENSE"), join(ext, "LICENSE"));

if (args.includes("--package")) {
  if (out !== ext || only.length < 3) throw new Error("--package needs a full build into extensions/vscode");
  const target = resolve(option("--package") ?? join(ext, `agentduo-vscode-${pkg.version}.vsix`));
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) rmSync(target);
  execFileSync(process.execPath, [join(root, "node_modules", "@vscode", "vsce", "vsce"), "package", "--no-dependencies", "--out", target], { cwd: ext, stdio: "inherit" });
  console.log(`packaged ${target}`);
}
