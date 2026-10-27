"""Non-interactive CLI backends (Codex CLI, Claude Code CLI) and the runner
that invokes them with tool-level permissions, timeouts, schema validation
and retries."""
from __future__ import annotations

import glob
import json
import os
import re
import shutil
import signal
import subprocess
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, NamedTuple, Optional, Tuple

from . import schema as schemas
from .config import Config

READ_ONLY = "read-only"
WORKSPACE_WRITE = "workspace-write"


class AgentFailure(Exception):
    """The agent ran but its output was unusable."""

    def __init__(self, message: str, meta: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.meta = meta or {}


class AgentResult(NamedTuple):
    ok: bool
    data: Optional[Dict[str, Any]]
    error: Optional[str]
    attempts: int
    duration_sec: float
    cost_usd: Optional[float]
    meta: Dict[str, Any]
    backend: str


def extract_json(text: str) -> Any:
    text = (text or "").strip()
    fence = re.match(r"^```(?:json)?\s*\n(.*)\n```$", text, re.S)
    if fence:
        text = fence.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                pass
    raise AgentFailure("output is not valid JSON: " + (text[:300] + "..." if len(text) > 300 else text))


def _version_key(path: str) -> Tuple[int, ...]:
    m = re.search(r"claude-code-(\d+(?:\.\d+)*)", path)
    return tuple(int(x) for x in m.group(1).split(".")) if m else ()


def resolve_bin(configured: str, backend: str) -> Optional[str]:
    expanded = os.path.expanduser(configured)
    if os.sep in expanded:
        return expanded if os.access(expanded, os.X_OK) else None
    found = shutil.which(expanded)
    if found or backend != "claude" or configured != "claude":
        return found
    # Claude Code installed only through an IDE extension is not on PATH.
    home = os.path.expanduser("~")
    candidates = [os.path.join(home, ".claude", "local", "claude")]
    for editor in (".vscode", ".vscode-insiders", ".cursor", ".windsurf"):
        pattern = os.path.join(home, editor, "extensions", "anthropic.claude-code-*",
                               "resources", "native-binary", "claude")
        candidates.extend(sorted(glob.glob(pattern), key=_version_key))
    existing = [c for c in candidates if os.access(c, os.X_OK)]
    return existing[-1] if existing else None


class Backend:
    name = ""

    def __init__(self, cfg: Config, repo: Path):
        self.cfg = cfg
        self.repo = repo
        self.section = cfg[self.name]

    def binary(self) -> str:
        found = resolve_bin(self.section["bin"], self.name)
        if not found:
            raise FileNotFoundError(f"{self.name} CLI not found (configured bin: {self.section['bin']!r})")
        return found

    def build_command(self, schema_name: str, permission: str, out_file: Path,
                      extra_allowed: List[str]) -> List[str]:
        raise NotImplementedError

    def parse(self, stdout: str, stderr: str, out_file: Path) -> Tuple[Any, Dict[str, Any]]:
        raise NotImplementedError


class CodexBackend(Backend):
    name = "codex"

    def build_command(self, schema_name, permission, out_file, extra_allowed):
        cmd = [
            self.binary(), "exec",
            "--sandbox", permission,
            "--color", "never",
            "--output-schema", str(schemas.schema_path(schema_name)),
            "--output-last-message", str(out_file),
            "--cd", str(self.repo),
        ]
        if self.section.get("model"):
            cmd += ["--model", str(self.section["model"])]
        cmd += [str(a) for a in self.section.get("extra_args") or []]
        cmd.append("-")  # read the prompt from stdin
        return cmd

    def parse(self, stdout, stderr, out_file):
        text = out_file.read_text(encoding="utf-8") if out_file.is_file() else ""
        data = extract_json(text if text.strip() else stdout)
        meta: Dict[str, Any] = {}
        m = re.search(r"tokens used\s*\n\s*([\d,]+)", stderr or "")
        if m:
            meta["tokens_used"] = int(m.group(1).replace(",", ""))
        return data, meta


class ClaudeBackend(Backend):
    name = "claude"

    def build_command(self, schema_name, permission, out_file, extra_allowed):
        schema_json = json.dumps(schemas.load_schema(schema_name), separators=(",", ":"))
        if permission == WORKSPACE_WRITE:
            tools = self.section["implementation_tools"]
            allowed = list(self.section["implementation_allowed_tools"]) + list(extra_allowed)
            disallowed = list(self.section["implementation_disallowed_tools"])
            mode = "acceptEdits"
        else:
            tools = self.section["read_only_tools"]
            allowed = list(tools)
            disallowed = []
            mode = "dontAsk"
        cmd = [
            self.binary(), "-p",
            "--output-format", "json",
            "--json-schema", schema_json,
            "--permission-mode", mode,
            "--permission-prompts", "none",
            "--tools", ",".join(tools),
            "--allowedTools", *allowed,
        ]
        if disallowed:
            cmd += ["--disallowedTools", *disallowed]
        if self.section.get("model"):
            cmd += ["--model", str(self.section["model"])]
        if self.section.get("max_budget_usd"):
            cmd += ["--max-budget-usd", str(self.section["max_budget_usd"])]
        cmd += [str(a) for a in self.section.get("extra_args") or []]
        return cmd

    def parse(self, stdout, stderr, out_file):
        text = (stdout or "").strip()
        try:
            envelope = json.loads(text)
        except json.JSONDecodeError:
            last = text.splitlines()[-1] if text else ""
            try:
                envelope = json.loads(last)
            except json.JSONDecodeError:
                raise AgentFailure("claude did not return a JSON result envelope: " + text[:300]) from None
        if not isinstance(envelope, dict):
            raise AgentFailure("unexpected claude output: " + text[:300])
        meta = {
            "cost_usd": envelope.get("total_cost_usd"),
            "session_id": envelope.get("session_id"),
            "num_turns": envelope.get("num_turns"),
            "permission_denials": envelope.get("permission_denials") or [],
        }
        if envelope.get("is_error") or envelope.get("subtype") not in (None, "success"):
            raise AgentFailure(f"claude reported an error (subtype={envelope.get('subtype')}): "
                               f"{str(envelope.get('result'))[:500]}", meta)
        data = envelope.get("structured_output")
        if data is None:
            try:
                data = extract_json(envelope.get("result") or "")
            except AgentFailure as exc:
                raise AgentFailure(str(exc), meta) from None
        return data, meta


def _execute(cmd: List[str], prompt: str, cwd: Path, timeout: int) -> Tuple[Optional[int], str, str, bool]:
    proc = subprocess.Popen(
        cmd, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", start_new_session=True,
    )
    try:
        out, err = proc.communicate(prompt, timeout=timeout)
        return proc.returncode, out, err, False
    except subprocess.TimeoutExpired:
        _kill_group(proc)
        out, err = proc.communicate()
        return None, out, err, True
    except BaseException:
        _kill_group(proc)
        raise


def _kill_group(proc: subprocess.Popen) -> None:
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            return
        try:
            proc.wait(timeout=5)
            return
        except subprocess.TimeoutExpired:
            continue


class AgentRunner:
    def __init__(self, cfg: Config, repo: Path, log_dir: Path, ui: Any):
        self.cfg = cfg
        self.repo = repo
        self.log_dir = log_dir
        self.ui = ui
        self.backends: Dict[str, Backend] = {
            "codex": CodexBackend(cfg, repo),
            "claude": ClaudeBackend(cfg, repo),
        }

    def backend_for(self, role: str) -> Backend:
        return self.backends[self.cfg.agents[role]]

    def call(self, role: str, prompt: str, schema_name: str, log_prefix: str,
             check: Optional[Callable[[Dict[str, Any]], List[str]]] = None,
             extra_allowed: Optional[List[str]] = None) -> AgentResult:
        backend = self.backend_for(role)
        permission = self.cfg.permission_for(role)
        schema = schemas.load_schema(schema_name)
        timeout = int(self.cfg.limits["agent_timeout_sec"])
        attempts_allowed = int(self.cfg.limits["max_retries"]) + 1
        self.log_dir.mkdir(parents=True, exist_ok=True)
        started = time.monotonic()
        total_cost = 0.0
        cost_seen = False
        last_error = None
        meta: Dict[str, Any] = {}
        for attempt in range(1, attempts_allowed + 1):
            stem = self.log_dir / f"{log_prefix}.a{attempt}"
            full_prompt = prompt
            if last_error:
                full_prompt += (
                    "\n\n## Previous attempt was rejected by the orchestrator\n"
                    f"{last_error}\n"
                    "Return ONLY a JSON object that matches the required schema exactly.\n"
                )
            out_file = Path(f"{stem}.last.json")
            try:
                cmd = backend.build_command(schema_name, permission, out_file, extra_allowed or [])
            except FileNotFoundError as exc:
                return AgentResult(False, None, str(exc), attempt, time.monotonic() - started,
                                   None, meta, backend.name)
            Path(f"{stem}.prompt.md").write_text(full_prompt, encoding="utf-8")
            Path(f"{stem}.cmd.json").write_text(json.dumps(cmd, indent=1), encoding="utf-8")
            with self.ui.waiting(f"{backend.name} ({role}, attempt {attempt}/{attempts_allowed})"):
                try:
                    code, out, err, timed_out = _execute(cmd, full_prompt, self.repo, timeout)
                except OSError as exc:
                    return AgentResult(False, None, f"cannot start {backend.name}: {exc}", attempt,
                                       time.monotonic() - started, None, meta, backend.name)
            Path(f"{stem}.stdout.txt").write_text(out or "", encoding="utf-8")
            Path(f"{stem}.stderr.txt").write_text(err or "", encoding="utf-8")
            if timed_out:
                last_error = f"{backend.name} timed out after {timeout}s"
                continue
            try:
                data, meta = backend.parse(out, err, out_file)
                parse_error = None
            except AgentFailure as exc:
                data, meta, parse_error = None, exc.meta, str(exc)
            if isinstance(meta.get("cost_usd"), (int, float)):
                total_cost += meta["cost_usd"]
                cost_seen = True
            if parse_error:
                last_error = parse_error if code == 0 else (
                    f"{backend.name} exited with code {code}: {(err or out or '').strip()[-800:]}")
                continue
            if code != 0:
                last_error = f"{backend.name} exited with code {code}: {(err or '').strip()[-800:]}"
                continue
            errors = schemas.validate(data, schema)
            if not errors and check:
                errors = check(data)
            if errors:
                last_error = "output failed validation:\n- " + "\n- ".join(errors[:20])
                continue
            Path(f"{stem}.output.json").write_text(json.dumps(data, indent=2, ensure_ascii=False),
                                                   encoding="utf-8")
            return AgentResult(True, data, None, attempt, time.monotonic() - started,
                               total_cost if cost_seen else None, meta, backend.name)
        return AgentResult(False, None, last_error, attempts_allowed, time.monotonic() - started,
                           total_cost if cost_seen else None, meta, backend.name)
