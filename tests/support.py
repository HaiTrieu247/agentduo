"""Shared test helpers: import path, temporary git repos, fake CLIs and
builders for agent outputs."""
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / ".orchestrator"))

FAKE_AGENT = Path(__file__).resolve().parent / "fake_agent.py"


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True).stdout.strip()


def make_repo(tmp: Path, ignore_runs: bool = True) -> Path:
    repo = tmp / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.email", "test@example.com")
    git(repo, "config", "user.name", "Test")
    (repo / "README.md").write_text("demo\n")
    if ignore_runs:
        (repo / ".gitignore").write_text(".orchestrator/runs/\n")
    # Gate used by the e2e tests: passes once app.txt says "fixed".
    (repo / "check.py").write_text(
        "import sys, pathlib\n"
        "p = pathlib.Path('app.txt')\n"
        "ok = p.exists() and 'fixed' in p.read_text()\n"
        "print('check ok' if ok else 'check failed: app.txt is not fixed')\n"
        "sys.exit(0 if ok else 1)\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "init")
    return repo


class FakeCLIs:
    """Wrapper executables named codex/claude that run fake_agent.py."""

    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.bin = tmp / "bin"
        self.bin.mkdir()
        for name in ("codex", "claude"):
            path = self.bin / name
            path.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{FAKE_AGENT}" {name} "$@"\n')
            path.chmod(0o755)
        self.scenario = tmp / "scenario.json"
        self.counts = tmp / "counts.json"
        self.log = tmp / "calls.jsonl"
        self._old_env = {}

    def set_scenario(self, scenario: dict) -> None:
        self.scenario.write_text(json.dumps(scenario))

    def __enter__(self):
        env = {"FAKE_SCENARIO": str(self.scenario), "FAKE_COUNTS": str(self.counts),
               "FAKE_LOG": str(self.log)}
        for k, v in env.items():
            self._old_env[k] = os.environ.get(k)
            os.environ[k] = v
        return self

    def __exit__(self, *exc):
        for k, v in self._old_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def calls(self, role=None):
        if not self.log.exists():
            return []
        rows = [json.loads(l) for l in self.log.read_text().splitlines() if l.strip()]
        return [r for r in rows if role is None or r["role"] == role]


def write_config(tmp: Path, fake: FakeCLIs, **overrides) -> Path:
    limits = {"max_planning_rounds": 4, "max_review_rounds": 5, "max_retries": 1,
              "max_consecutive_gate_failures": 3, "agent_timeout_sec": 60, "gate_timeout_sec": 60}
    limits.update(overrides.pop("limits", {}))
    quality = {"stop_on_critical_issue": True}
    quality.update(overrides.pop("quality_gates", {}))
    safety = {"pause_before_implement": False, "max_deleted_files": 5}
    safety.update(overrides.pop("safety", {}))
    assert not overrides, overrides
    lines = ["limits:"] + [f"  {k}: {json.dumps(v)}" for k, v in limits.items()]
    lines += ["quality_gates:"] + [f"  {k}: {json.dumps(v)}" for k, v in quality.items()]
    lines += ["safety:"] + [f"  {k}: {json.dumps(v)}" for k, v in safety.items()]
    lines += [
        "gates:",
        "  - name: check",
        f"    command: {json.dumps(sys.executable + ' check.py')}",
        "codex:",
        f"  bin: {json.dumps(str(fake.bin / 'codex'))}",
        "claude:",
        f"  bin: {json.dumps(str(fake.bin / 'claude'))}",
    ]
    path = tmp / "config.yaml"
    path.write_text("\n".join(lines) + "\n")
    return path


def run_cli(*args):
    from orch.cli import main
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = main(list(args) + ["--no-color"])
    return code, out.getvalue()


class TempDir:
    def __enter__(self) -> Path:
        self.path = Path(tempfile.mkdtemp(prefix="orch-test-")).resolve()
        return self.path

    def __exit__(self, *exc):
        shutil.rmtree(self.path, ignore_errors=True)


# ------------------------------------------------------------ output builders
def plan(title="Demo plan", **kw):
    data = {
        "title": title, "summary": "Do the thing.", "goals": ["make app.txt fixed"],
        "scope_in": ["app.txt"], "scope_out": ["everything else"], "architecture": "single file",
        "steps": [{"id": "S1", "description": "write app.txt", "files": ["app.txt"]}],
        "acceptance_criteria": ["check.py exits 0"], "risks": [{"risk": "none", "mitigation": "n/a"}],
        "test_strategy": "run check.py", "open_questions": [], "feedback_resolution": [],
    }
    data.update(kw)
    return data


def issue(id_, severity="high", description="problem"):
    return {"id": id_, "severity": severity, "description": description, "suggestion": "fix it"}


def critique(approved, issues=()):
    return {"status": "approved" if approved else "changes_requested", "approved": approved,
            "summary": "critique", "issues": list(issues), "accepted": [], "disputed": [],
            "proposed_changes": []}


def approval(approved, issues=()):
    return {"status": "approved" if approved else "changes_requested", "approved": approved,
            "summary": "final decision", "issues": list(issues)}


def impl(status="completed", addressed=(), blocking_reason=None):
    return {"status": status, "summary": f"implementation {status}", "files_changed": ["app.txt"],
            "tests_run": [{"command": "python3 check.py", "passed": True, "notes": ""}],
            "addressed_findings": [{"finding_id": f, "resolution": "fixed", "notes": ""} for f in addressed],
            "blocking_reason": blocking_reason}


def finding(id_, severity="high", file="app.txt"):
    return {"id": id_, "severity": severity, "file": file, "line": 1, "issue": "bad",
            "recommendation": "fix"}


def review(approved, findings=(), resolved=(), commit="$SNAPSHOT"):
    return {"status": "approved" if approved else "changes_requested", "approved": approved,
            "reviewed_commit": commit, "summary": "review", "findings": list(findings),
            "resolved_findings": list(resolved)}
