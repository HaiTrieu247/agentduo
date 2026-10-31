import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A fresh directory whose path contains a space (Review Focus #1). Windows refuses to remove a folder while a process
 * still has a file or its working directory there: a CLI a test stopped may take a moment to exit, so removing retries.
 */
export function tempDir(): { path: string; cleanup(): void } {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "agentduo test-")));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) };
}
