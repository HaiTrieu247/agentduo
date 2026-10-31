// The desktop's own tests (host logic, renderer helpers, packaging); the Electron E2E runs apart (scripts/test-electron.mjs).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e/**"],
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
