"""Quality gates: project commands (tests, lint, typecheck...) run by the
orchestrator itself, independent of what the agents claim."""
from __future__ import annotations

import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List


def _tail(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return "...[truncated]...\n" + text[-limit:]


def run_gates(gates: List[Dict[str, Any]], repo: Path, log_dir: Path, label: str,
              default_timeout: int, max_output_chars: int, ui: Any) -> List[Dict[str, Any]]:
    log_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for gate in gates:
        timeout = int(gate.get("timeout_sec") or default_timeout)
        log_path = log_dir / f"{label}-gate-{gate['name']}.log"
        started = time.monotonic()
        timed_out = False
        with ui.waiting(f"gate '{gate['name']}': {gate['command']}"):
            proc = subprocess.Popen(
                gate["command"], shell=True, cwd=repo, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                start_new_session=True,
            )
            try:
                output, _ = proc.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                output, _ = proc.communicate()
        duration = time.monotonic() - started
        exit_code = None if timed_out else proc.returncode
        log_path.write_text(f"$ {gate['command']}\n{output or ''}\n[exit code: {exit_code}]\n",
                            encoding="utf-8")
        results.append({
            "name": gate["name"],
            "command": gate["command"],
            "required": bool(gate.get("required", True)),
            "exit_code": exit_code,
            "timed_out": timed_out,
            "passed": exit_code == 0,
            "duration_sec": round(duration, 2),
            "log": str(log_path),
            "output_tail": _tail(output or "", max_output_chars),
        })
    return results


def required_passed(results: List[Dict[str, Any]]) -> bool:
    return all(r["passed"] for r in results if r["required"])


def describe(results: List[Dict[str, Any]], with_output: bool = True) -> str:
    if not results:
        return "(no quality gates configured)"
    lines = []
    for r in results:
        verdict = "PASS" if r["passed"] else ("TIMEOUT" if r["timed_out"] else "FAIL")
        kind = "required" if r["required"] else "optional"
        lines.append(f"- [{verdict}] {r['name']} ({kind}): `{r['command']}` "
                     f"exit={r['exit_code']} in {r['duration_sec']}s")
        if with_output and not r["passed"] and r["output_tail"].strip():
            lines.append("  ```\n" + "\n".join("  " + l for l in r["output_tail"].splitlines()) + "\n  ```")
    return "\n".join(lines)
