// The tests of every workspace package, and the repository's own (test/). The desktop app runs its own:
// npm --prefix apps/desktop test.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "packages/*/test/**/*.test.{ts,tsx}", "apps/cli/test/**/*.test.{ts,tsx}", "apps/vscode/test/**/*.test.ts"],
    setupFiles: ["packages/engine/test/setup.ts"],
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
