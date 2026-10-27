"""Command-line interface."""
from __future__ import annotations

import argparse
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import List, Optional, Tuple

from . import __version__
from . import schema as schemas
from .agents import resolve_bin
from .config import BACKENDS, Config, ConfigError, load_config
from .gitops import Git
from .state import HUMAN_REVIEW, LockError, RunStore
from .ui import UI
from .workflow import Orchestrator

ORCH_DIR = Path(__file__).resolve().parent.parent
SCHEMA_NAMES = ("plan", "plan_critique", "plan_approval", "implementation", "review")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="orchestrator.py",
        description="Codex plans and reviews; Claude Code critiques plans and implements. "
                    "Start a run with a task description, or manage existing runs.",
    )
    p.add_argument("task", nargs="*", help="task description for a new run")
    p.add_argument("--task-file", help="read the task description from a file")
    p.add_argument("--resume", nargs="?", const="latest", metavar="RUN_ID",
                   help="continue a run (default: the latest)")
    p.add_argument("--decision", choices=("resume", "revise", "abort"),
                   help="answer a run waiting in HUMAN_REVIEW (use with --resume)")
    p.add_argument("--note", help="instruction for the agents, recorded with the decision")
    p.add_argument("--status", nargs="?", const="latest", metavar="RUN_ID", help="show a run's state")
    p.add_argument("--list", action="store_true", help="list runs")
    p.add_argument("--doctor", action="store_true", help="check CLIs, config and repository; no agent calls")
    p.add_argument("--repo", help="target git repository (default: the one containing the current directory)")
    p.add_argument("--config", help="config file (default: <repo>/.orchestrator/config.yaml)")
    p.add_argument("--allow-dirty", action="store_true",
                   help="allow implementing on top of uncommitted changes")
    p.add_argument("--no-color", action="store_true")
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return p


def resolve_repo(arg: Optional[str]) -> Path:
    start = Path(arg).expanduser().resolve() if arg else Path.cwd()
    git = Git(start)
    return git.toplevel() if git.is_repo() else start


def resolve_config_path(arg: Optional[str], repo: Path) -> Path:
    if arg:
        return Path(arg).expanduser().resolve()
    in_repo = repo / ".orchestrator" / "config.yaml"
    return in_repo if in_repo.is_file() else ORCH_DIR / "config.yaml"


def runs_dir_for(cfg: Config, repo: Path) -> Path:
    path = Path(cfg["paths"]["runs_dir"]).expanduser()
    return path if path.is_absolute() else repo / path


def command_hint() -> str:
    script = Path(sys.argv[0])
    try:
        script = script.resolve().relative_to(Path.cwd())
    except ValueError:
        pass
    return f"python3 {script}"


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    ui = UI(color=False if args.no_color else None)
    repo = resolve_repo(args.repo)
    try:
        cfg = load_config(resolve_config_path(args.config, repo))
    except ConfigError as exc:
        ui.error(str(exc))
        return 1
    for warning in cfg.warnings:
        ui.warn(warning)

    if args.doctor:
        return doctor(cfg, repo, ui)
    runs_dir = runs_dir_for(cfg, repo)
    if args.list:
        return list_runs(runs_dir, ui)
    if args.status:
        return show_status(runs_dir, args.status, ui)
    if args.decision and not args.resume:
        ui.error("--decision must be used together with --resume")
        return 1

    git = Git(repo)
    if not git.is_repo():
        ui.error(f"{repo} is not a git repository (run 'git init' and commit first)")
        return 1
    missing = [b for b in sorted(set(cfg.agents.values())) if not resolve_bin(cfg[b]["bin"], b)]
    if missing:
        ui.error(f"CLI not found: {', '.join(missing)}. Install it or set '<backend>.bin' in the config; "
                 "run --doctor for details.")
        return 1

    if args.resume:
        if args.task or args.task_file:
            ui.error("give either a new task or --resume, not both")
            return 1
        try:
            store = RunStore.open(runs_dir, args.resume)
        except FileNotFoundError as exc:
            ui.error(str(exc))
            return 1
        state = store.load_state()
    else:
        task = " ".join(args.task).strip()
        if args.task_file:
            task = (task + "\n\n" + Path(args.task_file).read_text(encoding="utf-8")).strip()
        if not task:
            build_parser().print_usage()
            ui.error("a task description is required (or use --resume / --status / --list / --doctor)")
            return 1
        allow_dirty = args.allow_dirty or cfg.safety["allow_dirty_worktree"]
        orch_rel = _relative(ORCH_DIR, repo)
        exclude = [p for p in (_relative(runs_dir, repo), orch_rel) if p and p != "."]
        dirty = git.status_porcelain(exclude)
        if dirty and not allow_dirty:
            ui.error(f"working tree has {len(dirty)} uncommitted change(s); commit or stash them first, "
                     "or pass --allow-dirty")
            for line in dirty[:10]:
                ui.info(f"    {line}")
            return 1
        store, state = RunStore.create(runs_dir, task, cfg.limits)
        ui.banner(f"Run {store.task_id}")
        ui.info(f"  repo: {repo}\n  run dir: {store.dir}")

    orch = Orchestrator(cfg, repo, store, state, ui, ORCH_DIR, args.allow_dirty, command_hint())
    try:
        store.lock()
    except LockError as exc:
        ui.error(str(exc))
        return 1
    try:
        if args.decision:
            try:
                orch.apply_decision(args.decision, args.note)
            except ValueError as exc:
                ui.error(str(exc))
                return 1
        elif args.note:
            ui.error("--note is only accepted together with --decision")
            return 1
        elif state["phase"] == HUMAN_REVIEW:
            orch.print_human_review()
            return 2
        return orch.run()
    finally:
        store.unlock()


def _relative(path: Path, root: Path) -> Optional[str]:
    try:
        return Path(path).resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return None


# ----------------------------------------------------------------- commands
def list_runs(runs_dir: Path, ui: UI) -> int:
    if not runs_dir.is_dir():
        ui.info(f"no runs in {runs_dir}")
        return 0
    rows = []
    for d in sorted(runs_dir.iterdir()):
        if (d / "state.json").is_file():
            try:
                st = RunStore(runs_dir, d.name).load_state()
            except (ValueError, OSError):
                continue
            rows.append((d.name, st["phase"], st["updated_at"], st["task"].splitlines()[0][:60]))
    if not rows:
        ui.info(f"no runs in {runs_dir}")
    for name, phase, updated, task in rows:
        ui.info(f"{name}  {phase:<13} {updated}  {task}")
    return 0


def show_status(runs_dir: Path, run_id: str, ui: UI) -> int:
    try:
        store = RunStore.open(runs_dir, run_id)
    except FileNotFoundError as exc:
        ui.error(str(exc))
        return 1
    st = store.load_state()
    ui.banner(f"Run {st['task_id']} — {st['phase']}")
    ui.info(f"  task: {st['task'].splitlines()[0][:100]}")
    ui.info(f"  planning round {st['planning_round']}/{st['limits']['planning_rounds']}, plan v{st['plan_version']}"
            f", final {('v' + str(st['final_plan_version'])) if st['final_plan_version'] else '—'}")
    ui.info(f"  implementation round {st['impl_round']}/{st['limits']['review_rounds']}, "
            f"open findings {len(st['open_findings'])}, Claude cost ${st.get('cost_usd', 0):.2f}")
    if st.get("in_progress"):
        ui.warn(f"interrupted during {st['in_progress']['phase']} (resume to re-run it)")
    for h in st["history"][-12:]:
        ui.step(h["step"], h["phase"], h["round"], h["agent"], f"{h['status']}: {h['summary']}")
    if st["phase"] == HUMAN_REVIEW and st.get("human_review"):
        hr = st["human_review"]
        ui.warn(f"waiting for a decision ({hr['reason']}): {hr['message']}")
    ui.info(f"  files: {store.dir}")
    return 0


def _probe(cmd: List[str]) -> Tuple[bool, str]:
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, str(exc)
    return proc.returncode == 0, proc.stdout


def doctor(cfg: Config, repo: Path, ui: UI) -> int:
    results: List[Tuple[bool, bool, str]] = []  # (ok, required, message)

    def add(ok: bool, message: str, required: bool = True) -> None:
        results.append((ok, required, message))

    add(sys.version_info >= (3, 9), f"python {sys.version.split()[0]} (>= 3.9)")
    add(shutil.which("git") is not None, "git installed")
    git = Git(repo)
    is_repo = git.is_repo()
    add(is_repo, f"git repository: {repo}")
    add(True, f"config: {cfg.source or 'built-in defaults'}")
    for name in SCHEMA_NAMES:
        try:
            problems = schemas.strict_problems(schemas.load_schema(name))
            add(not problems, f"schema {name}" + (f": {problems}" if problems else ""))
        except (OSError, ValueError) as exc:
            add(False, f"schema {name}: {exc}")

    needed = {
        "codex": (["exec", "--help"], ["--output-schema", "--sandbox", "--output-last-message", "--cd"]),
        "claude": (["--help"], ["--json-schema", "--permission-mode", "--permission-prompts", "--tools",
                                "--allowedTools", "--disallowedTools", "--output-format"]),
    }
    used = set(cfg.agents.values())
    for backend in BACKENDS:
        if backend not in used:
            continue
        binary = resolve_bin(cfg[backend]["bin"], backend)
        if not binary:
            add(False, f"{backend} CLI not found (bin: {cfg[backend]['bin']!r})")
            continue
        ok, out = _probe([binary, "--version"])
        add(ok, f"{backend} CLI: {binary} ({out.strip().splitlines()[0] if out.strip() else '?'})")
        help_args, flags = needed[backend]
        ok, out = _probe([binary, *help_args])
        lacking = [f for f in flags if f not in out]
        add(ok and not lacking, f"{backend} supports {', '.join(flags)}"
            + (f" — missing: {', '.join(lacking)}" if lacking else ""))

    if not cfg.gates:
        add(not cfg.gates_cfg["require_tests_pass"], "no quality gates configured")
    for gate in cfg.gates:
        try:
            exe = shlex.split(gate["command"])[0]
        except (ValueError, IndexError):
            exe = ""
        found = bool(exe) and (shutil.which(exe) is not None or (repo / exe).exists())
        add(found, f"gate '{gate['name']}': {gate['command']}" + ("" if found else f" — '{exe}' not found"),
            required=False)

    if is_repo:
        runs_rel = _relative(runs_dir_for(cfg, repo), repo)
        orch_rel = _relative(ORCH_DIR, repo)
        exclude = [p for p in (runs_rel, orch_rel) if p and p != "."]
        dirty = git.status_porcelain(exclude)
        add(not dirty, "working tree clean" + (f" ({len(dirty)} uncommitted change(s))" if dirty else ""),
            required=False)
        if runs_rel:
            ignored = subprocess.run(["git", "check-ignore", "-q", f"{runs_rel}/probe"], cwd=repo).returncode == 0
            add(ignored, f"{runs_rel}/ is git-ignored", required=False)

    failed = False
    for ok, required, message in results:
        if ok:
            ui.ok(f"  ✓ {message}")
        elif required:
            failed = True
            ui.error(f"✗ {message}")
        else:
            ui.warn(f"{message}")
    ui.info("doctor: " + ("problems found" if failed else "ready"))
    return 1 if failed else 0
