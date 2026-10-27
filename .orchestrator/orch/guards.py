"""Safety checks applied to what an agent actually changed, independent of
the permissions it was given."""
from __future__ import annotations

import fnmatch
from typing import Iterable, List, Optional, Sequence, Tuple


def match_protected(path: str, patterns: Iterable[str]) -> Optional[str]:
    """Return the first glob that matches path. '**/' also matches zero
    directories, so '**/*.pem' matches both 'key.pem' and 'a/b/key.pem'."""
    for pattern in patterns:
        candidates = [pattern]
        if pattern.startswith("**/"):
            candidates.append(pattern[3:])
        if pattern.endswith("/**"):
            candidates.append(pattern[:-3])
        if any(fnmatch.fnmatchcase(path, c) for c in candidates):
            return pattern
    return None


def check_changes(changes: Sequence[Tuple[str, str]], protected: Iterable[str],
                  max_deleted: int) -> List[str]:
    protected = list(protected)
    violations = []
    for status, path in changes:
        pattern = match_protected(path, protected)
        if pattern:
            violations.append(f"modified protected path '{path}' ({status}, rule '{pattern}')")
    deleted = [p for s, p in changes if s.startswith("D")]
    if len(deleted) > max_deleted:
        preview = ", ".join(deleted[:10]) + (" ..." if len(deleted) > 10 else "")
        violations.append(f"deleted {len(deleted)} files (limit {max_deleted}): {preview}")
    return violations


def check_git_position(before: Tuple[Optional[str], Optional[str]],
                       after: Tuple[Optional[str], Optional[str]]) -> List[str]:
    """before/after are (HEAD sha, branch name)."""
    violations = []
    if before[0] != after[0]:
        violations.append(f"HEAD moved from {before[0]} to {after[0]} (agents must not commit or reset)")
    if before[1] != after[1]:
        violations.append(f"branch changed from {before[1]} to {after[1]}")
    return violations
