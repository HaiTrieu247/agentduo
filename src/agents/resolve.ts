/** Implemented in Task 7. */
export function resolveBinary(configured: string, _backend: "codex" | "claude"): string | null {
  return configured.includes("/") ? configured : null;
}
