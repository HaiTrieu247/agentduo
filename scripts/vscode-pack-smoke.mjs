// Packages the VS Code extension, checks what the VSIX holds, unpacks it outside the checkout and starts the packaged
// engine worker there with an external Node. Proves the VSIX works on its own: version, schemas, bundled dependencies.
import { execFileSync, fork } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const schemas = readdirSync(join(root, "schemas")).filter((f) => f.endsWith(".schema.json")).sort();
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts });
const fail = (message) => {
  throw new Error(`vscode pack smoke: ${message}`);
};

/** Every file the VSIX may hold, under extension/. vsce adds the manifest files at the top level. */
const allowed = [
  /^package\.json$/, /^readme\.md$/i, /^license(\.txt)?$/i, /^media\/agentduo\.svg$/,
  /^dist\/extension\.cjs$/, /^dist\/webview\/main\.js$/, /^dist\/webview\/styles\.css$/, /^dist\/webview\/codicon(\.css|\.ttf|-LICENSE\.txt)$/,
  /^runtime\/package\.json$/, /^runtime\/worker\.js$/, /^runtime\/schemas\/[a-z_]+\.schema\.json$/,
];

/** Forks the packaged worker, initializes it on `repo` and runs doctor through it, as the extension host does. */
function exerciseWorker(script, repo) {
  return new Promise((resolve, reject) => {
    const child = fork(script, [], { cwd: repo, execPath: process.execPath, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.resume();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the packaged worker did not answer in time\n${stderr}`));
    }, 30_000);
    const pending = new Map();
    let nextId = 1;
    const request = (req) =>
      new Promise((ok, ko) => {
        const id = nextId++;
        pending.set(id, { ok, ko });
        child.send({ protocol: hello.protocol, generation: 1, id, request: req });
      });
    let hello = null;
    child.on("message", async (m) => {
      if (m.kind === "response") {
        const p = pending.get(m.id);
        pending.delete(m.id);
        return m.ok ? p?.ok(m.result) : p?.ko(new Error(m.error.message));
      }
      if (m.kind !== "hello") return;
      hello = m;
      try {
        const init = await request({ type: "initialize", workspace: repo, configPath: null });
        const { checks } = await request({ type: "doctor" });
        await request({ type: "shutdown" });
        resolve({ hello, init, checks });
      } catch (e) {
        reject(e);
      }
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (!hello) reject(new Error(`the packaged worker exited (${code ?? signal}) before saying hello\n${stderr}`));
    });
  });
}

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "agentduo-vsix-")));
try {
  const vsix = join(tmp, `agentduo-vscode-${version}.vsix`);
  run(process.execPath, [join(root, "scripts", "build-vscode.mjs"), "--package", vsix], { cwd: root, stdio: "inherit" });

  const entries = run("unzip", ["-Z1", vsix]).split("\n").filter((e) => e && !e.endsWith("/"));
  const files = entries.filter((e) => e.startsWith("extension/")).map((e) => e.slice("extension/".length));
  const stray = files.filter((f) => !allowed.some((re) => re.test(f)));
  if (stray.length) fail(`the VSIX holds files it should not:\n  ${stray.join("\n  ")}`);
  for (const need of [
    "package.json", "dist/extension.cjs", "dist/webview/main.js", "dist/webview/styles.css", "dist/webview/codicon.css", "dist/webview/codicon.ttf",
    "dist/webview/codicon-LICENSE.txt", "runtime/package.json", "runtime/worker.js",
  ]) {
    if (!files.includes(need)) fail(`the VSIX is missing ${need}`);
  }
  const packed = files.filter((f) => f.startsWith("runtime/schemas/")).map((f) => f.slice("runtime/schemas/".length)).sort();
  if (packed.join() !== schemas.join()) fail(`the VSIX schemas are [${packed}], expected [${schemas}]`);

  const unpacked = join(tmp, "unpacked");
  mkdirSync(unpacked);
  run("unzip", ["-q", vsix, "-d", unpacked]);
  const ext = join(unpacked, "extension");
  const runtimePkg = JSON.parse(readFileSync(join(ext, "runtime", "package.json"), "utf8"));
  if (runtimePkg.name !== "agentduo" || runtimePkg.version !== version || runtimePkg.type !== "module") {
    fail(`runtime/package.json is ${JSON.stringify(runtimePkg)}, expected name agentduo, version ${version}, type module`);
  }
  const manifest = JSON.parse(readFileSync(join(ext, "package.json"), "utf8"));
  if (manifest.version !== version) fail(`the extension manifest is version ${manifest.version}, expected ${version}`);
  // The provider marks are drawn by the bundle itself (no image asset), with the company's name as their text.
  const webview = readFileSync(join(ext, "dist", "webview", "main.js"), "utf8");
  for (const need of ["createElementNS", "http://www.w3.org/2000/svg", "Anthropic", "OpenAI", "mark mark-"]) {
    if (!webview.includes(need)) fail(`the packaged webview bundle has no ${need}, so it cannot draw the provider marks`);
  }

  const repo = join(tmp, "repo");
  mkdirSync(repo);
  run("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "x\n");
  run("git", ["add", "-A"], { cwd: repo });
  run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
  const { hello, init, checks } = await exerciseWorker(join(ext, "runtime", "worker.js"), repo);
  if (hello.version !== version || init.version !== version) fail(`the worker reports version ${hello.version}/${init.version}, expected ${version}`);
  if (init.workspace !== repo) fail(`the worker initialized ${init.workspace}, expected ${repo}`);
  for (const name of schemas.map((f) => f.replace(".schema.json", ""))) {
    const check = checks.find((c) => c.message.startsWith(`schema ${name}`));
    if (!check?.ok) fail(`doctor through the packaged worker did not pass schema ${name}:\n${checks.map((c) => `  ${c.ok ? "✓" : "✗"} ${c.message}`).join("\n")}`);
  }
  console.log(`vscode pack smoke OK: ${files.length} files in ${vsix.split("/").pop()}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
