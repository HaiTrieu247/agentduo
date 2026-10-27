"""Git helpers: working-tree snapshots without touching the user's index,
HEAD or branches.

A snapshot stages the whole working tree (tracked + untracked, honouring
.gitignore) into a temporary index, writes a tree and an unreferenced commit,
and optionally pins it under refs/orchestrator/... so it survives gc. This
gives every implementation round a real git SHA that reviewers can diff.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path
from typing import Dict, List, NamedTuple, Optional, Sequence, Tuple

_IDENTITY = {
    "GIT_AUTHOR_NAME": "orchestrator",
    "GIT_AUTHOR_EMAIL": "orchestrator@localhost",
    "GIT_COMMITTER_NAME": "orchestrator",
    "GIT_COMMITTER_EMAIL": "orchestrator@localhost",
}


class GitError(RuntimeError):
    pass


class Snapshot(NamedTuple):
    commit: str
    tree: str


class Git:
    def __init__(self, repo: Path):
        self.repo = Path(repo)

    def run(self, *args: str, env: Optional[Dict[str, str]] = None, check: bool = True) -> str:
        full_env = dict(os.environ)
        full_env.update(env or {})
        proc = subprocess.run(
            ["git", *args], cwd=self.repo, env=full_env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        if check and proc.returncode != 0:
            raise GitError(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
        return proc.stdout

    def is_repo(self) -> bool:
        try:
            return self.run("rev-parse", "--is-inside-work-tree", check=False).strip() == "true"
        except FileNotFoundError:
            return False

    def toplevel(self) -> Path:
        return Path(self.run("rev-parse", "--show-toplevel").strip())

    def head(self) -> Optional[str]:
        out = self.run("rev-parse", "--verify", "-q", "HEAD", check=False).strip()
        return out or None

    def branch(self) -> Optional[str]:
        out = self.run("symbolic-ref", "-q", "--short", "HEAD", check=False).strip()
        return out or None

    def is_ignored(self, path: str) -> bool:
        for candidate in (path, f"{path.rstrip('/')}/probe"):
            proc = subprocess.run(["git", "check-ignore", "-q", candidate], cwd=self.repo,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if proc.returncode == 0:
                return True
        return False

    def _pathspec(self, exclude: Sequence[str]) -> List[str]:
        # `git add` fails when an exclude pathspec names an already-ignored
        # path, and ignored paths are skipped anyway, so leave those out.
        return ["--", "."] + [f":(exclude){p}" for p in exclude if not self.is_ignored(p)]

    def status_porcelain(self, exclude: Sequence[str] = ()) -> List[str]:
        out = self.run("status", "--porcelain", "--untracked-files=all", *self._pathspec(exclude))
        return [line for line in out.splitlines() if line.strip()]

    def worktree_tree(self, exclude: Sequence[str] = ()) -> str:
        """Hash of the current working tree as a git tree object."""
        fd, index_path = tempfile.mkstemp(prefix="orch-index-")
        os.close(fd)
        os.unlink(index_path)  # git refuses an empty pre-existing index file
        env = {"GIT_INDEX_FILE": index_path}
        try:
            head = self.head()
            if head:
                self.run("read-tree", head, env=env)
            self.run("add", "-A", *self._pathspec(exclude), env=env)
            return self.run("write-tree", env=env).strip()
        finally:
            if os.path.exists(index_path):
                os.unlink(index_path)

    def snapshot(self, exclude: Sequence[str] = (), ref: Optional[str] = None,
                 message: str = "orchestrator snapshot") -> Snapshot:
        tree = self.worktree_tree(exclude)
        head = self.head()
        parents = ["-p", head] if head else []
        commit = self.run("commit-tree", tree, *parents, "-m", message, env=_IDENTITY).strip()
        if ref:
            self.run("update-ref", ref, commit)
        return Snapshot(commit, tree)

    def name_status(self, a: str, b: str) -> List[Tuple[str, str]]:
        out = self.run("diff", "--no-renames", "--name-status", a, b)
        result = []
        for line in out.splitlines():
            if not line.strip():
                continue
            status, _, path = line.partition("\t")
            result.append((status.strip(), path.strip()))
        return result

    def diff(self, a: str, b: str) -> str:
        return self.run("diff", "--no-color", a, b)

    def diff_stat(self, a: str, b: str) -> str:
        return self.run("diff", "--no-color", "--stat", a, b)
