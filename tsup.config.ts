import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/bin.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
