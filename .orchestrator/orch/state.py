"""Run state and artifact storage under <runs_dir>/<task_id>/.

state.json is rewritten atomically after every step so an interrupted run can
be resumed from the last completed phase.
"""
from __future__ import annotations

import json
import os
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

STATE_VERSION = 1

PLAN = "PLAN"
PLAN_REVIEW = "PLAN_REVIEW"
PLAN_FINALIZE = "PLAN_FINALIZE"
IMPLEMENT = "IMPLEMENT"
VERIFY = "VERIFY"
CODE_REVIEW = "CODE_REVIEW"
HUMAN_REVIEW = "HUMAN_REVIEW"
DONE = "DONE"
ABORTED = "ABORTED"
TERMINAL_PHASES = (DONE, ABORTED)


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def slugify(text: str, max_len: int = 40) -> str:
    ascii_text = unicodedata.normalize("NFKD", text.replace("đ", "d").replace("Đ", "D"))
    ascii_text = ascii_text.encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", ascii_text).strip("-").lower()
    return slug[:max_len].rstrip("-") or "task"


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


class LockError(RuntimeError):
    pass


class RunStore:
    LATEST = "LATEST"

    def __init__(self, runs_dir: Path, task_id: str):
        self.runs_dir = Path(runs_dir)
        self.task_id = task_id
        self.dir = self.runs_dir / task_id
        self._locked = False

    # -- lifecycle -------------------------------------------------------
    @classmethod
    def create(cls, runs_dir: Path, task: str, limits: Dict[str, int]) -> "tuple[RunStore, Dict[str, Any]]":
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        base_id = f"{stamp}-{slugify(task)}"
        task_id, n = base_id, 2
        while (Path(runs_dir) / task_id).exists():
            task_id, n = f"{base_id}-{n}", n + 1
        store = cls(runs_dir, task_id)
        store.dir.mkdir(parents=True)
        (store.dir / "logs").mkdir()
        state = new_state(task_id, task, limits)
        store.save_state(state)
        atomic_write(store.runs_dir / cls.LATEST, task_id + "\n")
        return store, state

    @classmethod
    def open(cls, runs_dir: Path, task_id: Optional[str] = None) -> "RunStore":
        runs_dir = Path(runs_dir)
        if not task_id or task_id == "latest":
            latest = runs_dir / cls.LATEST
            if not latest.is_file():
                raise FileNotFoundError(f"no runs found in {runs_dir}")
            task_id = latest.read_text(encoding="utf-8").strip()
        store = cls(runs_dir, task_id)
        if not (store.dir / "state.json").is_file():
            raise FileNotFoundError(f"run '{task_id}' not found in {runs_dir}")
        return store

    def lock(self) -> None:
        path = self.dir / "lock"
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            pid = path.read_text().strip()
            if pid.isdigit() and _pid_alive(int(pid)):
                raise LockError(f"run {self.task_id} is already being processed by pid {pid}") from None
            path.unlink()
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        with os.fdopen(fd, "w") as fh:
            fh.write(str(os.getpid()))
        self._locked = True

    def unlock(self) -> None:
        if self._locked:
            try:
                (self.dir / "lock").unlink()
            except FileNotFoundError:
                pass
            self._locked = False

    # -- state -----------------------------------------------------------
    def load_state(self) -> Dict[str, Any]:
        state = json.loads((self.dir / "state.json").read_text(encoding="utf-8"))
        if state.get("version") != STATE_VERSION:
            raise ValueError(f"unsupported state version {state.get('version')}")
        return state

    def save_state(self, state: Dict[str, Any]) -> None:
        state["updated_at"] = now_iso()
        self.write_json("state.json", state)

    # -- artifacts -------------------------------------------------------
    def path(self, name: str) -> Path:
        return self.dir / name

    def write_json(self, name: str, data: Any) -> Path:
        path = self.path(name)
        atomic_write(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
        return path

    def read_json(self, name: str) -> Any:
        return json.loads(self.path(name).read_text(encoding="utf-8"))

    def write_text(self, name: str, text: str) -> Path:
        path = self.path(name)
        atomic_write(path, text)
        return path

    def append_text(self, name: str, text: str) -> None:
        path = self.path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(text)

    def append_event(self, event: Dict[str, Any]) -> None:
        self.append_text("events.jsonl", json.dumps({"at": now_iso(), **event}, ensure_ascii=False) + "\n")


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def new_state(task_id: str, task: str, limits: Dict[str, int]) -> Dict[str, Any]:
    ts = now_iso()
    return {
        "version": STATE_VERSION,
        "task_id": task_id,
        "task": task,
        "phase": PLAN,
        "created_at": ts,
        "updated_at": ts,
        "limits": {
            "planning_rounds": limits["max_planning_rounds"],
            "review_rounds": limits["max_review_rounds"],
        },
        "planning_round": 1,
        "plan_version": 0,
        "plan_hash": None,
        "final_plan_version": None,
        "final_plan_hash": None,
        "plan_feedback": None,
        "impl_round": 0,
        "base": None,
        "last_snapshot": None,
        "last_gates": None,
        "consecutive_gate_failures": 0,
        "open_findings": [],
        "last_implementation": None,
        "human_review": None,
        "human_notes": [],
        "cost_usd": 0.0,
        "step": 0,
        "in_progress": None,
        "history": [],
    }
