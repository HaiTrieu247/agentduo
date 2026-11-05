// The published CLI: one ES module with the engine bundled in (@agentduo/* are workspace sources, never installed)
// and the five runtime dependencies left to npm. The schemas go beside package.json, where packageRoot() finds them.
import { cpSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const here = fileURLToPath(new URL(".", import.meta.url));
// tsup takes the externals and the output's extension from the package.json of its working directory: both are set
// here, so the bundle is the same wherever it runs.
const dependencies = Object.keys(JSON.parse(readFileSync(join(here, "package.json"), "utf8")).dependencies);

export default defineConfig({
  entry: { cli: join(here, "src", "bin.ts") },
  outDir: join(here, "dist"),
  format: ["esm"],
  outExtension: () => ({ js: ".js" }),
  target: "node22",
  platform: "node",
  clean: true,
  external: dependencies.map((d) => new RegExp(`^${d}(/|$)`)),
  noExternal: [/^@agentduo\//],
  banner: { js: "#!/usr/bin/env node" },
  onSuccess: async () => {
    rmSync(join(here, "schemas"), { recursive: true, force: true });
    cpSync(join(here, "..", "..", "packages", "engine", "schemas"), join(here, "schemas"), { recursive: true });
  },
});
