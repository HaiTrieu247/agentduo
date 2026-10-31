// Builds, packs and installs agentduo into a temporary prefix, then runs the installed binaries.
// Proves the published tarball works on its own: bin entries, bundled schemas, runtime dependencies.
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const windows = process.platform === "win32";
// On Windows npm, and the bins it installs, are .cmd shims, which Node starts only through cmd.exe: their command line.
const commandLine = (cmd, args) => [cmd, ...args].map((a) => (/[\s"&|<>^%]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(" ");
const run = (cmd, args, opts = {}) => {
  const o = { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts };
  return windows ? execSync(commandLine(cmd, args), o) : execFileSync(cmd, args, o);
};
const tmp = mkdtempSync(join(tmpdir(), "agentduo-pack-"));
try {
  run("npm", ["run", "build"], { cwd: root });
  const [{ filename }] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", tmp], { cwd: root }));
  const prefix = join(tmp, "prefix");
  run("npm", ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", join(tmp, filename)]);
  const bin = (name) => (windows ? join(prefix, `${name}.cmd`) : join(prefix, "bin", name));
  for (const name of ["duo", "agentduo"]) {
    const out = run(bin(name), ["--version"]).trim();
    if (out !== version) throw new Error(`${name} --version printed '${out}', expected '${version}'`);
  }
  const repo = join(tmp, "repo");
  mkdirSync(repo);
  run("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "x\n");
  run("git", ["add", "-A"], { cwd: repo });
  run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
  const doctorArgs = ["doctor", "--dir", repo];
  const doctor = windows ? spawnSync(commandLine(bin("duo"), doctorArgs), { encoding: "utf8", shell: true }) : spawnSync(bin("duo"), doctorArgs, { encoding: "utf8" });
  if (!doctor.stdout.includes("✓ schema plan")) throw new Error(`doctor output is missing the schema check:\n${doctor.stdout}${doctor.stderr}`);
  console.log(`pack smoke OK: ${filename}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
