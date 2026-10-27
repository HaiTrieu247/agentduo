"""Orchestrator configuration: defaults, loading and validation.

This is the orchestrator's own schema, not a Codex or Claude Code config.
"""
from __future__ import annotations

import copy
from pathlib import Path
from typing import Any, Dict, List

from . import yamlish

BACKENDS = ("codex", "claude")
ROLES = ("planner", "plan_reviewer", "implementer", "code_reviewer")
READ_ONLY_ROLES = ("planner", "plan_reviewer", "code_reviewer")
SEVERITIES = ("critical", "high", "medium", "low")

DEFAULTS: Dict[str, Any] = {
    "agents": {
        "planner": "codex",
        "plan_reviewer": "claude",
        "implementer": "claude",
        "code_reviewer": "codex",
    },
    "limits": {
        "max_planning_rounds": 4,
        "max_review_rounds": 5,
        "max_retries": 1,
        "max_consecutive_gate_failures": 3,
        "agent_timeout_sec": 1800,
        "gate_timeout_sec": 900,
        "max_diff_chars": 120000,
        "max_gate_output_chars": 6000,
    },
    "permissions": {
        "codex": "read-only",
        "claude_planning": "read-only",
        "claude_implementation": "workspace-write",
    },
    "quality_gates": {
        "require_plan_approval": True,
        "require_tests_pass": True,
        "require_codex_approval": True,
        "stop_on_critical_issue": True,
        "blocking_severities": ["critical", "high"],
        "review_on_gate_failure": False,
    },
    "gates": [],
    "safety": {
        "allow_dirty_worktree": False,
        "pause_before_implement": False,
        "max_deleted_files": 5,
        "protected_paths": [
            ".orchestrator/**",
            ".git/**",
            ".env",
            ".env.*",
            "**/*.pem",
            "**/*.key",
            "**/secrets/**",
            ".github/workflows/**",
        ],
    },
    "codex": {
        "bin": "codex",
        "model": None,
        "extra_args": ["--ephemeral"],
    },
    "claude": {
        "bin": "claude",
        "model": None,
        "max_budget_usd": None,
        "extra_args": ["--strict-mcp-config", "--no-session-persistence"],
        "read_only_tools": ["Read", "Grep", "Glob"],
        "implementation_tools": ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
        "implementation_allowed_tools": [
            "Read", "Grep", "Glob", "Edit", "Write",
            "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git show*)",
            "Bash(ls*)", "Bash(cat*)", "Bash(pwd)",
        ],
        "implementation_disallowed_tools": [
            "Bash(git push*)", "Bash(git commit*)", "Bash(git reset*)", "Bash(git checkout*)",
            "Bash(git switch*)", "Bash(git rebase*)", "Bash(git merge*)", "Bash(git clean*)",
            "Bash(git stash*)", "Bash(git tag*)", "Bash(git branch*)", "Bash(git update-ref*)",
            "Bash(rm -rf*)", "Bash(rm -fr*)", "Bash(sudo*)", "Bash(curl*)", "Bash(wget*)",
            "WebFetch", "WebSearch",
        ],
    },
    "paths": {
        "runs_dir": ".orchestrator/runs",
    },
}


class ConfigError(ValueError):
    pass


def _merge(base: Dict[str, Any], override: Dict[str, Any], path: str, warnings: List[str]) -> Dict[str, Any]:
    out = copy.deepcopy(base)
    for key, value in override.items():
        where = f"{path}.{key}" if path else key
        if key not in base:
            warnings.append(f"unknown config key '{where}' (ignored)")
            continue
        if isinstance(base[key], dict) and isinstance(value, dict):
            out[key] = _merge(base[key], value, where, warnings)
        else:
            out[key] = value
    return out


def load_config(path: Path) -> "Config":
    raw: Dict[str, Any] = {}
    if path.is_file():
        try:
            raw = yamlish.load(path.read_text(encoding="utf-8")) or {}
        except ValueError as exc:
            raise ConfigError(f"{path}: {exc}") from None
        if not isinstance(raw, dict):
            raise ConfigError(f"{path}: top level must be a mapping")
    warnings: List[str] = []
    data = _merge(DEFAULTS, raw, "", warnings)
    cfg = Config(data, path if path.is_file() else None, warnings)
    cfg.validate()
    return cfg


class Config:
    def __init__(self, data: Dict[str, Any], source: Any = None, warnings: List[str] = None):
        self.data = data
        self.source = source
        self.warnings = warnings or []

    def __getitem__(self, key: str) -> Any:
        return self.data[key]

    @property
    def agents(self) -> Dict[str, str]:
        return self.data["agents"]

    @property
    def limits(self) -> Dict[str, Any]:
        return self.data["limits"]

    @property
    def gates_cfg(self) -> Dict[str, Any]:
        return self.data["quality_gates"]

    @property
    def safety(self) -> Dict[str, Any]:
        return self.data["safety"]

    @property
    def gates(self) -> List[Dict[str, Any]]:
        return self.data["gates"]

    def permission_for(self, role: str) -> str:
        perms = self.data["permissions"]
        if self.agents[role] == "codex":
            return perms["codex"]
        return perms["claude_planning" if role in READ_ONLY_ROLES else "claude_implementation"]

    def validate(self) -> None:
        errors: List[str] = []
        for role in ROLES:
            if self.agents.get(role) not in BACKENDS:
                errors.append(f"agents.{role} must be one of {BACKENDS}")
        if self.agents.get("implementer") != "claude":
            errors.append("agents.implementer must be 'claude' (Claude is the only agent "
                          "allowed to modify source code)")
        if not errors:
            for role in READ_ONLY_ROLES:
                if self.permission_for(role) != "read-only":
                    errors.append(f"role '{role}' must run read-only (check permissions.*)")
            if self.permission_for("implementer") != "workspace-write":
                errors.append("permissions for the implementer must be 'workspace-write'")
        for key in ("max_planning_rounds", "max_review_rounds", "max_consecutive_gate_failures",
                    "agent_timeout_sec", "gate_timeout_sec", "max_diff_chars", "max_gate_output_chars"):
            value = self.limits.get(key)
            if not isinstance(value, int) or isinstance(value, bool) or value < 1:
                errors.append(f"limits.{key} must be a positive integer")
        retries = self.limits.get("max_retries")
        if not isinstance(retries, int) or isinstance(retries, bool) or retries < 0:
            errors.append("limits.max_retries must be an integer >= 0")
        for sev in self.gates_cfg.get("blocking_severities") or []:
            if sev not in SEVERITIES:
                errors.append(f"quality_gates.blocking_severities: unknown severity '{sev}'")
        if not isinstance(self.gates, list):
            errors.append("gates must be a list")
        else:
            names = set()
            for i, gate in enumerate(self.gates):
                if not isinstance(gate, dict) or not gate.get("name") or not gate.get("command"):
                    errors.append(f"gates[{i}] needs 'name' and 'command'")
                    continue
                if gate["name"] in names:
                    errors.append(f"gates[{i}]: duplicate name '{gate['name']}'")
                names.add(gate["name"])
                unknown = set(gate) - {"name", "command", "required", "timeout_sec"}
                if unknown:
                    errors.append(f"gates[{i}]: unknown keys {sorted(unknown)}")
            if self.gates_cfg.get("require_tests_pass") and not any(
                    isinstance(g, dict) and g.get("required", True) for g in self.gates):
                errors.append("quality_gates.require_tests_pass is true but no required gate "
                              "is configured under 'gates'")
        if errors:
            where = f" ({self.source})" if self.source else ""
            raise ConfigError("invalid configuration" + where + ":\n  - " + "\n  - ".join(errors))
