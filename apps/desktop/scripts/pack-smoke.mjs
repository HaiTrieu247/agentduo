// Checks an unpacked app as it would be installed, away from the checkout (so nothing comes from its node_modules):
//   node scripts/pack-smoke.mjs [--app <path>] [--test-fuses] [--in-place] [--no-launch]
// --app: the .app (macOS), the folder holding AgentDuo.exe / agentduo (Windows, Linux); by default the one
// `npm run pack:dir` wrote under release/. It checks the runtime outside the ASAR archive, the fuses, the bundled
// Node (>= 22.12), that the engine worker starts on Electron-as-Node and says hello, and (unless --no-launch) that
// the app itself starts, with a profile of its own, and opens its window: no inspector needed, as a release has none.
// Linux needs a display for that (xvfb-run); AGENTDUO_E2E_NO_SANDBOX=1 passes --no-sandbox where CI has no SUID helper.
import { execFileSync, fork, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";

const here = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};
const testFuses = args.includes("--test-fuses") || process.env.AGENTDUO_FUSES === "test";
const pass = (what) => console.log(`PASS ${what}`);
const fail = (what) => {
  throw new Error(what);
};

function findApp() {
  const release = join(here, "release");
  if (!existsSync(release)) fail(`no ${release}: run npm run pack:dir first`);
  for (const dir of ["mac-arm64", "mac", "mac-universal", "win-unpacked", "linux-unpacked"]) {
    const d = join(release, dir);
    if (!existsSync(d)) continue;
    const app = readdirSync(d).find((f) => f.endsWith(".app"));
    return app ? join(d, app) : d;
  }
  fail(`no unpacked app under ${release}`);
}

/** The app's executable and its resources directory, for an .app or an unpacked folder. */
function layout(app) {
  if (app.endsWith(".app")) {
    const macos = join(app, "Contents", "MacOS");
    const exe = join(macos, readdirSync(macos).find((f) => !f.startsWith(".")));
    return { exe, fuseTarget: app, resources: join(app, "Contents", "Resources") };
  }
  const exe = ["AgentDuo.exe", "agentduo"].map((f) => join(app, f)).find((f) => existsSync(f));
  if (!exe) fail(`no AgentDuo executable in ${app}`);
  return { exe, fuseTarget: exe, resources: join(app, "resources") };
}

/**
 * Removes a folder, trying again for a few seconds: Windows refuses while a process still holds a file there, and the
 * app's Chromium helpers and worker exit a moment after the app.
 */
function remove(path) {
  for (let attempt = 1; ; attempt++) {
    try {
      return rmSync(path, { recursive: true, force: true });
    } catch (e) {
      if (attempt >= 50 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

let scratch = null;
try {
  let app = resolve(option("--app") ?? findApp());
  if (!args.includes("--in-place")) {
    scratch = mkdtempSync(join(tmpdir(), "agentduo-pack-smoke-"));
    const copy = join(scratch, app.split(/[\\/]/).pop());
    // verbatimSymlinks: an .app's frameworks are symlinks into themselves; they must stay links, not copies.
    cpSync(app, copy, { recursive: true, verbatimSymlinks: true });
    app = copy;
    pass(`copied the app outside the checkout (${app})`);
  }

  const { exe, fuseTarget, resources } = layout(app);
  const runtime = join(resources, "runtime");
  for (const f of ["worker.js", "package.json", "schemas"]) if (!existsSync(join(runtime, f))) fail(`${join(runtime, f)} is missing`);
  if (!readdirSync(join(runtime, "schemas")).some((f) => f.endsWith(".schema.json"))) fail("the runtime has no schemas");
  if (!statSync(join(resources, "app.asar")).isFile()) fail("app.asar is missing");
  if (existsSync(join(resources, "app.asar.unpacked", "node_modules")) || existsSync(join(resources, "app", "node_modules"))) fail("node_modules were packaged");
  pass("runtime (worker.js, package.json, schemas) is outside the ASAR archive");

  const wire = await getCurrentFuseWire(fuseTarget);
  const on = (fuse) => wire[fuse] === FuseState.ENABLE;
  if (!on(FuseV1Options.RunAsNode)) fail("the RunAsNode fuse is off: the worker cannot run");
  if (on(FuseV1Options.EnableNodeOptionsEnvironmentVariable)) fail("the NODE_OPTIONS fuse is on");
  if (on(FuseV1Options.EnableNodeCliInspectArguments) !== testFuses) fail(`the inspector fuse is ${on(FuseV1Options.EnableNodeCliInspectArguments) ? "on" : "off"}, expected ${testFuses ? "on (test profile)" : "off (release)"}`);
  pass(`fuses: RunAsNode on, NODE_OPTIONS off, inspector ${testFuses ? "on (test profile)" : "off"}`);

  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete env.NODE_OPTIONS;
  const node = execFileSync(exe, ["-e", "process.stdout.write(process.versions.node)"], { env, encoding: "utf8", timeout: 30_000 }).trim();
  const [major, minor] = node.split(".").map(Number);
  if (!(major > 22 || (major === 22 && minor >= 12))) fail(`the bundled Node is ${node}; agentduo needs >= 22.12`);
  const pkg = JSON.parse(execFileSync(exe, ["-e", `process.stdout.write(require("fs").readFileSync(${JSON.stringify(join(runtime, "package.json"))}, "utf8"))`], { env, encoding: "utf8", timeout: 30_000 }));
  if (pkg.name !== "agentduo" || pkg.type !== "module") fail("the runtime package.json is not agentduo's");
  pass(`bundled Node ${node} runs as Node (ELECTRON_RUN_AS_NODE), runtime package agentduo ${pkg.version}`);

  const hello = await new Promise((done, reject) => {
    const child = fork(join(runtime, "worker.js"), [], { execPath: exe, env, cwd: scratch ?? tmpdir(), stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let err = "";
    child.stderr?.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no hello from the worker in 30 s ${err}`));
    }, 30_000);
    child.once("message", (m) => {
      clearTimeout(timer);
      child.kill();
      done(m);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the worker exited (${code}) before its hello ${err}`));
    });
  });
  if (hello?.kind !== "hello" || hello.node !== node) fail(`unexpected first message ${JSON.stringify(hello)}`);
  pass(`the worker started on the bundled Node and said hello (protocol ${hello.protocol}, agentduo ${hello.version})`);

  if (!args.includes("--no-launch")) {
    const profile = mkdtempSync(join(tmpdir(), "agentduo-pack-profile-"));
    const appEnv = { ...process.env, AGENTDUO_DESKTOP_USER_DATA: profile, AGENTDUO_DESKTOP_LOG: "1" };
    delete appEnv.ELECTRON_RUN_AS_NODE;
    delete appEnv.NODE_OPTIONS;
    try {
      const line = await new Promise((done, reject) => {
        const child = spawn(exe, process.env.AGENTDUO_E2E_NO_SANDBOX ? ["--no-sandbox"] : [], { env: appEnv, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        // Settles once, after the app has exited.
        let settled = false;
        const finish = (f) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (child.exitCode !== null || child.signalCode !== null) return f();
          child.once("exit", () => f());
          child.kill();
          setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
        };
        const timer = setTimeout(() => finish(() => reject(new Error(`the app did not start in 60 s:\n${out.slice(-2000)}`))), 60_000);
        const read = (d) => {
          out += d;
          const started = /\[agentduo\] (agentduo desktop .* on Electron .*)/.exec(out);
          if (started && /\[agentduo\] window shown/.test(out)) finish(() => done(started[1]));
        };
        child.stdout.on("data", read);
        child.stderr.on("data", read);
        child.once("exit", (code) => finish(() => reject(new Error(`the app exited (${code}) as it started:\n${out.slice(-2000)}`))));
      });
      pass(`the app started and showed its window: ${line}`);
    } finally {
      remove(profile);
    }
  }
} catch (e) {
  console.error(`FAIL ${e.message}`);
  process.exitCode = 1;
} finally {
  if (scratch) remove(scratch);
}
