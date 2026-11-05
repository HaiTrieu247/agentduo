// The repository's layout as a contract: which package may import which, and how. A package names another by its
// package name (@agentduo/engine/…), never by a relative path out of its own folder; the engine imports no other
// package; the host no webview; the CLI only the engine; and no app imports another app.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

/** Each package's folder, its name, and the @agentduo packages it may import. */
const PACKAGES = [
  { dir: "packages/engine", name: "@agentduo/engine", may: [] },
  { dir: "packages/host", name: "@agentduo/host", may: ["@agentduo/engine"] },
  { dir: "packages/webview", name: "@agentduo/webview", may: ["@agentduo/engine", "@agentduo/host"] },
  { dir: "apps/cli", name: "agentduo", may: ["@agentduo/engine"], testsMay: ["@agentduo/host"] },
  { dir: "apps/vscode", name: "agentduo-vscode", may: ["@agentduo/engine", "@agentduo/host", "@agentduo/webview"] },
  { dir: "apps/desktop", name: "agentduo-desktop", may: ["@agentduo/engine", "@agentduo/host", "@agentduo/webview"] },
];

/** The folders of a package that hold code: src/, the extension's page entries (apps/vscode/webview) and test/. */
const CODE_DIRS = ["src", "webview", "test"];

function sources(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(join(root, dir))) return out;
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!["node_modules", "dist", "release", "runtime", "fixtures"].includes(entry.name)) out.push(...sources(path));
    } else if (/\.(ts|tsx|mts|mjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Every module specifier a file imports, re-exports or loads dynamically. */
const specifiers = (text: string) =>
  [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\1/g)].map((m) => m[2]!);

describe("the repository's packages", () => {
  it("are the root's workspaces, apart from the desktop app, which has its own lockfile", () => {
    expect(json("package.json").workspaces).toEqual(PACKAGES.filter((p) => p.dir !== "apps/desktop").map((p) => p.dir));
    for (const p of PACKAGES) expect(json(`${p.dir}/package.json`).name, p.dir).toBe(p.name);
  });

  it("refuse `npm publish` at the root, naming the command that publishes the CLI", () => {
    const pkg = json("package.json");
    expect(pkg.private).toBe(true);
    expect(pkg.scripts.prepublishOnly).toBe("node scripts/publish-guard.mjs");
    const guard = spawnSync(process.execPath, [join(root, "scripts", "publish-guard.mjs")], { encoding: "utf8" });
    expect(guard.status).toBe(1);
    expect(guard.stderr).toContain("npm publish -w agentduo");
  });

  for (const p of PACKAGES) {
    it(`${p.dir} imports only what it may, by package name`, () => {
      const wrong: string[] = [];
      const files = CODE_DIRS.flatMap((d) => sources(join(p.dir, d)));
      expect(files.length, p.dir).toBeGreaterThan(0);
      for (const file of files) {
        const inTests = file.startsWith(join(p.dir, "test") + sep);
        const may = new Set([p.name, ...p.may, ...(inTests ? (p.testsMay ?? []) : [])]);
        for (const spec of specifiers(readFileSync(join(root, file), "utf8"))) {
          if (spec.startsWith(".")) {
            const target = relative(join(root, p.dir), resolve(root, file, "..", spec));
            if (target.startsWith("..")) wrong.push(`${file}: ${spec} leaves ${p.dir}`);
          } else if (spec.startsWith("@agentduo/")) {
            const name = spec.split("/").slice(0, 2).join("/");
            if (!may.has(name)) wrong.push(`${file}: ${spec}`);
            if (!inTests && spec.split("/")[2] === "testing") wrong.push(`${file}: ${spec} is a test helper`);
          }
        }
      }
      expect(wrong).toEqual([]);
    });
  }

  it("declare the workspace packages they import (the desktop app finds them through the root's node_modules)", () => {
    for (const p of PACKAGES.filter((k) => k.dir !== "apps/desktop")) {
      const pkg = json(`${p.dir}/package.json`);
      const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => d.startsWith("@agentduo/"));
      expect(declared.sort(), p.dir).toEqual([...p.may, ...(p.testsMay ?? [])].sort());
    }
  });
});
