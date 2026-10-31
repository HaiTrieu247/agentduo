// The Electron end-to-end tests (scripts/test-electron.mjs runs them): the built app, started for real by Playwright,
// one test after another in a single process, since they share the app and its scratch project.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["test/e2e/**/*.test.ts"],
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
