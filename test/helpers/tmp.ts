import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh directory whose path contains a space (Review Focus #1). */
export function tempDir(): { path: string; cleanup(): void } {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "agentduo test-")));
  return { path, cleanup: () => removeDir(path) };
}

/**
 * Windows refuses to remove a folder while a process still has a file or its working directory there, and a CLI a
 * test stopped may take a moment to exit: removing tries again for a few seconds. (rmSync's own maxRetries does not
 * cover EBUSY on Node 22.)
 */
function removeDir(path: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 25 || !(code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY")) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}
