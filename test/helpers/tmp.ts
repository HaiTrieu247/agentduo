import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh directory whose path contains a space (Review Focus #1). */
export function tempDir(): { path: string; cleanup(): void } {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "agentduo test-")));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
