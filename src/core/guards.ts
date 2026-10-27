import type { Change } from "./git.js";

// Glob to RegExp: "*" stays inside a segment, "**/" matches zero or more directories,
// and a trailing "/**" matches everything below.
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const atSegmentStart = i === 0 || glob[i - 1] === "/";
        const next = glob[i + 2];
        if (atSegmentStart && next === "/") {
          re += "(?:.*/)?";
          i += 2;
          continue;
        }
        if (atSegmentStart && next === undefined && re.endsWith("/")) {
          re = re.slice(0, -1) + "(?:/.*)?";
          i += 1;
          continue;
        }
        re += ".*";
        i += 1;
        continue;
      }
      re += "[^/]*";
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      continue;
    }
    re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchProtected(path: string, patterns: Iterable<string>): string | null {
  for (const pattern of patterns) if (globToRegExp(pattern).test(path)) return pattern;
  return null;
}

export function checkChanges(changes: Change[], protectedPaths: Iterable<string>, maxDeleted: number): string[] {
  const patterns = [...protectedPaths];
  const violations: string[] = [];
  for (const [status, path] of changes) {
    const rule = matchProtected(path, patterns);
    if (rule) violations.push(`modified protected path '${path}' (${status}, rule '${rule}')`);
  }
  const deleted = changes.filter(([status]) => status.startsWith("D")).map(([, path]) => path);
  if (deleted.length > maxDeleted) {
    violations.push(`deleted ${deleted.length} files (limit ${maxDeleted}): ${deleted.slice(0, 10).join(", ")}${deleted.length > 10 ? " ..." : ""}`);
  }
  return violations;
}

/** before/after are [HEAD sha, branch name]. */
export function checkGitPosition(before: [string | null, string | null], after: [string | null, string | null]): string[] {
  const violations: string[] = [];
  if (before[0] !== after[0]) violations.push(`HEAD moved from ${before[0]} to ${after[0]} (agents must not commit or reset)`);
  if (before[1] !== after[1]) violations.push(`branch changed from ${before[1]} to ${after[1]}`);
  return violations;
}
