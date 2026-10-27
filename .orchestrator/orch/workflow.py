"""The orchestration state machine.

PLAN -> PLAN_REVIEW -> PLAN_FINALIZE -> IMPLEMENT -> VERIFY -> CODE_REVIEW -> DONE
with loops back to PLAN / IMPLEMENT, and HUMAN_REVIEW whenever a limit, a
safety rule or an agent failure needs a person to decide.
"""
from __future__ import annotations

import hashlib
import json
import traceback
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from . import gates as gates_mod
from . import guards, prompts, render
from .agents import AgentResult, AgentRunner
from .config import Config
from .gitops import Git
from .state import (ABORTED, CODE_REVIEW, DONE, HUMAN_REVIEW, IMPLEMENT, PLAN, PLAN_FINALIZE,
                    PLAN_REVIEW, VERIFY, RunStore, now_iso)
from .ui import UI

EXIT_DONE = 0
EXIT_HUMAN_REVIEW = 2
EXIT_ABORTED = 3
EXIT_INTERRUPTED = 130

# Where "--decision resume" goes after an escalation raised in these phases:
# a new implementation round (VERIFY/CODE_REVIEW) or a re-run of the same one.
_NEW_ROUND_FROM = (VERIFY, CODE_REVIEW)


def _relative_to(path: Path, root: Path) -> Optional[str]:
    try:
        return Path(path).resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return None


def _plan_hash(plan: Dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(plan, sort_keys=True).encode()).hexdigest()


def _consistent_status(data: Dict[str, Any]) -> List[str]:
    if data["approved"] != (data["status"] == "approved"):
        return [f"'approved' ({data['approved']}) contradicts 'status' ({data['status']!r})"]
    return []


class Orchestrator:
    def __init__(self, cfg: Config, repo: Path, store: RunStore, state: Dict[str, Any], ui: UI,
                 orchestrator_dir: Path, allow_dirty: bool = False, command_hint: str = ""):
        self.cfg = cfg
        self.repo = Path(repo)
        self.store = store
        self.state = state
        self.ui = ui
        self.git = Git(self.repo)
        self.runner = AgentRunner(cfg, self.repo, store.dir / "logs", ui)
        self.allow_dirty = allow_dirty or bool(cfg.safety["allow_dirty_worktree"])
        self.command_hint = command_hint or "python .orchestrator/orchestrator.py"
        runs_rel = _relative_to(store.runs_dir, self.repo)
        self.snapshot_exclude = [runs_rel] if runs_rel else []
        orch_rel = _relative_to(orchestrator_dir, self.repo)
        self.dirty_exclude = self.snapshot_exclude + ([orch_rel] if orch_rel and orch_rel != "." else [])
        self.handlers: Dict[str, Callable[[], None]] = {
            PLAN: self.step_plan,
            PLAN_REVIEW: self.step_plan_review,
            PLAN_FINALIZE: self.step_plan_finalize,
            IMPLEMENT: self.step_implement,
            VERIFY: self.step_verify,
            CODE_REVIEW: self.step_code_review,
        }

    # ------------------------------------------------------------------ loop
    def run(self) -> int:
        st = self.state
        if st.get("in_progress"):
            self.ui.warn(f"previous run was interrupted during {st['in_progress']['phase']}; re-running it")
        while True:
            phase = st["phase"]
            if phase == DONE:
                self._finish()
                self.ui.ok(f"[DONE] quality gates passed and the review approved. Report: {self.store.path('report.md')}")
                return EXIT_DONE
            if phase == ABORTED:
                self._finish()
                self.ui.warn(f"run aborted. Report: {self.store.path('report.md')}")
                return EXIT_ABORTED
            if phase == HUMAN_REVIEW:
                self._finish()
                self.print_human_review()
                return EXIT_HUMAN_REVIEW
            st["in_progress"] = {"phase": phase, "started_at": now_iso()}
            self.save()
            try:
                self.handlers[phase]()
            except KeyboardInterrupt:
                self.save()
                self.ui.warn(f"interrupted. Resume with: {self.command_hint} --resume {st['task_id']}")
                return EXIT_INTERRUPTED
            except Exception as exc:  # orchestrator bug or environment failure: hand to a human
                trace = traceback.format_exc()
                self.store.write_text(f"logs/error-step{st['step'] + 1:03d}.txt", trace)
                self._escalate("orchestrator_error", f"{type(exc).__name__}: {exc}", resume_phase=phase)
            st["in_progress"] = None
            self.save()

    def save(self) -> None:
        self.store.save_state(self.state)

    def _finish(self) -> None:
        self.state["in_progress"] = None
        self.save()
        self.write_report()

    # -------------------------------------------------------------- helpers
    def _ctx(self) -> Dict[str, Any]:
        st = self.state
        return {"repo": str(self.repo), "task_id": st["task_id"], "task": st["task"],
                "gates": self.cfg.gates, "notes": st["human_notes"]}

    def _agent(self, role: str) -> str:
        return self.cfg.agents[role].capitalize()

    def _log_prefix(self, label: str, round_no: int) -> str:
        return f"{self.state['step'] + 1:03d}-{label}-r{round_no}"

    def _record(self, phase: str, round_no: int, agent: str, status: str, summary: str,
                kind: str = "info", artifact: Optional[str] = None) -> None:
        st = self.state
        st["step"] += 1
        entry = {"step": st["step"], "phase": phase, "round": round_no, "agent": agent,
                 "status": status, "summary": summary, "at": now_iso(), "artifact": artifact}
        st["history"].append(entry)
        self.store.append_event({"type": "step", **entry})
        self.ui.step(st["step"], phase, round_no, agent, f"{status}: {summary}", kind)

    def _escalate(self, reason: str, message: str, resume_phase: str,
                  details: Optional[List[str]] = None) -> None:
        st = self.state
        from_phase = st["phase"]
        st["human_review"] = {"reason": reason, "message": message, "from_phase": from_phase,
                              "resume_phase": resume_phase, "details": details or [], "at": now_iso()}
        st["phase"] = HUMAN_REVIEW
        round_no = st["impl_round"] if from_phase in (IMPLEMENT, VERIFY, CODE_REVIEW) else st["planning_round"]
        self._record(HUMAN_REVIEW, round_no, "orch", reason, message, kind="warn")

    def _envelope(self, role: str, round_no: int, result: AgentResult, **extra: Any) -> Dict[str, Any]:
        st = self.state
        return {
            "task_id": st["task_id"], "role": role, "agent": result.backend, "round": round_no,
            "timestamp": now_iso(), "git_sha": self.git.head(), "plan_version": st["plan_version"],
            "attempts": result.attempts, "duration_sec": round(result.duration_sec, 1),
            "cost_usd": result.cost_usd, "meta": result.meta, **extra, "output": result.data,
        }

    def _add_cost(self, result: AgentResult) -> None:
        if result.cost_usd:
            self.state["cost_usd"] = round(self.state.get("cost_usd", 0.0) + result.cost_usd, 4)

    def _blocking(self, issues: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        severities = set(self.cfg.gates_cfg["blocking_severities"] or [])
        return [i for i in issues if i["severity"] in severities]

    def _tree(self) -> str:
        return self.git.worktree_tree(self.snapshot_exclude)

    def _ref(self, name: str) -> str:
        return f"refs/orchestrator/{self.state['task_id']}/{name}"

    def _readonly_call(self, role: str, label: str, prompt: str, schema: str, round_no: int,
                       check: Optional[Callable[[Dict[str, Any]], List[str]]] = None) -> Optional[AgentResult]:
        """Run a read-only role and verify, independently of the agent's own
        sandbox, that the working tree and git position did not change."""
        before_tree = self._tree()
        before_pos = (self.git.head(), self.git.branch())
        result = self.runner.call(role, prompt, schema, self._log_prefix(label, round_no), check=check)
        self._add_cost(result)
        after_tree = self._tree()
        violations = guards.check_git_position(before_pos, (self.git.head(), self.git.branch()))
        if after_tree != before_tree:
            changed = self.git.name_status(before_tree, after_tree)
            violations.insert(0, "working tree changed during a read-only step: "
                              + ", ".join(f"{s} {p}" for s, p in changed[:20]))
        agent = f"{role} ({result.backend})"
        if violations:
            self._escalate("readonly_violation",
                           f"{agent} changed the repository although it must be read-only. Inspect and revert "
                           "the changes, then resume to re-run this step.", resume_phase=self.state["phase"],
                           details=violations)
            return None
        if not result.ok:
            self._escalate("agent_error", f"{agent} failed after {result.attempts} attempt(s): {result.error}",
                           resume_phase=self.state["phase"])
            return None
        return result

    # ------------------------------------------------------------- planning
    def step_plan(self) -> None:
        st = self.state
        r, v = st["planning_round"], st["plan_version"] + 1
        previous = self.store.read_json(f"plan.v{v - 1}.json")["output"] if v > 1 else None
        prompt = prompts.planner(self._ctx(), r, v, previous, st["plan_feedback"])

        def check(plan: Dict[str, Any]) -> List[str]:
            return [f"'{k}' must not be empty" for k in ("goals", "scope_in", "steps", "acceptance_criteria")
                    if not plan[k]]

        result = self._readonly_call("planner", "plan", prompt, "plan", r, check)
        if not result:
            return
        plan = result.data
        self.store.write_json(f"plan.v{v}.json", self._envelope("planner", r, result, plan_version=v))
        md = render.plan_markdown(plan, v)
        self.store.write_text(f"plan.v{v}.md", md)
        self.store.write_text("plan.md", md)
        st["plan_version"] = v
        st["plan_hash"] = _plan_hash(plan)
        self._record(PLAN, r, self._agent("planner"), "plan created" if v == 1 else "plan revised",
                     f"v{v} '{plan['title']}' ({len(plan['steps'])} steps, "
                     f"{len(plan['acceptance_criteria'])} acceptance criteria, {len(plan['risks'])} risks)",
                     artifact=f"plan.v{v}.md")
        st["phase"] = PLAN_REVIEW

    def _last_critique(self, before_round: int) -> Optional[Dict[str, Any]]:
        for r in range(before_round - 1, 0, -1):
            path = self.store.path(f"critique.r{r}.json")
            if path.is_file():
                return self.store.read_json(path.name)["output"]
        return None

    def step_plan_review(self) -> None:
        st = self.state
        r, v = st["planning_round"], st["plan_version"]
        plan_md = self.store.path(f"plan.v{v}.md").read_text(encoding="utf-8")
        prompt = prompts.plan_reviewer(self._ctx(), r, v, plan_md, self._last_critique(r))
        result = self._readonly_call("plan_reviewer", "plan_review", prompt, "plan_critique", r,
                                     _consistent_status)
        if not result:
            return
        critique = result.data
        self.store.write_json(f"critique.r{r}.json", self._envelope("plan_reviewer", r, result))
        self.store.append_text("plan-feedback.md",
                               render.critique_markdown(critique, r, v, self._agent("plan_reviewer")))
        blocking = self._blocking(critique["issues"])
        approved = critique["approved"] and not blocking
        if critique["approved"] and blocking:
            self.ui.warn("the critic approved but raised blocking issues; treating as changes requested")
        self._record(PLAN_REVIEW, r, self._agent("plan_reviewer"),
                     "approved" if approved else "changes requested",
                     f"{len(critique['issues'])} issue(s), {len(blocking)} blocking",
                     kind="ok" if approved else "warn", artifact=f"critique.r{r}.json")
        if not approved:
            st["plan_feedback"] = {"critique": critique}
            self._next_planning_round()
        elif self.cfg.gates_cfg["require_plan_approval"]:
            st["phase"] = PLAN_FINALIZE
        else:
            self._freeze_plan(v)

    def step_plan_finalize(self) -> None:
        st = self.state
        r, v = st["planning_round"], st["plan_version"]
        plan_md = self.store.path(f"plan.v{v}.md").read_text(encoding="utf-8")
        critique = self.store.read_json(f"critique.r{r}.json")["output"]
        prompt = prompts.plan_finalizer(self._ctx(), r, v, plan_md, critique)
        result = self._readonly_call("planner", "plan_finalize", prompt, "plan_approval", r, _consistent_status)
        if not result:
            return
        approval = result.data
        self.store.write_json(f"approval.r{r}.json", self._envelope("planner", r, result))
        self.store.append_text("plan-feedback.md",
                               render.approval_markdown(approval, r, v, self._agent("planner")))
        blocking = self._blocking(approval["issues"])
        approved = approval["approved"] and not blocking
        self._record(PLAN_FINALIZE, r, self._agent("planner"),
                     "plan finalized" if approved else "changes requested",
                     f"v{v}: {approval['summary'][:120]}", kind="ok" if approved else "warn",
                     artifact=f"approval.r{r}.json")
        if approved:
            self._freeze_plan(v)
        else:
            st["plan_feedback"] = {"critique": critique, "approval": approval}
            self._next_planning_round()

    def _next_planning_round(self) -> None:
        st = self.state
        if st["planning_round"] >= st["limits"]["planning_rounds"]:
            self._escalate(
                "max_planning_rounds",
                f"no agreed plan after {st['planning_round']} planning round(s). Read plan.md and "
                "plan-feedback.md, then 'resume' to implement the latest plan as-is, or 'revise' with a "
                "--note that settles the disagreement.", resume_phase=IMPLEMENT)
            return
        st["planning_round"] += 1
        st["phase"] = PLAN

    def _freeze_plan(self, version: int, by_human: bool = False) -> None:
        st = self.state
        st["final_plan_version"] = version
        st["final_plan_hash"] = st["plan_hash"]
        md = self.store.path(f"plan.v{version}.md").read_text(encoding="utf-8")
        header = f"<!-- final plan v{version}, sha256 {st['plan_hash']}"
        header += ", accepted by the human operator -->\n" if by_human else " -->\n"
        self.store.write_text("plan.final.md", header + md)
        if st["base"] is not None:
            # Re-planned after implementation started: continue in a new round.
            st["impl_round"] += 1
            st["open_findings"] = []
            self._ensure_review_budget()
        if self.cfg.safety["pause_before_implement"] and not by_human:
            self._escalate("plan_ready", f"final plan v{version} is ready for your review "
                           f"({self.store.path('plan.final.md')}). Resume to start implementation.",
                           resume_phase=IMPLEMENT)
            return
        st["phase"] = IMPLEMENT

    # ------------------------------------------------------- implementation
    def _ensure_review_budget(self) -> None:
        st = self.state
        if st["impl_round"] > st["limits"]["review_rounds"]:
            st["limits"]["review_rounds"] = st["impl_round"] + int(self.cfg.limits["max_review_rounds"]) - 1

    def _next_impl_round(self) -> None:
        st = self.state
        if st["impl_round"] >= st["limits"]["review_rounds"]:
            self._escalate(
                "max_review_rounds",
                f"not approved after {st['impl_round']} implementation round(s). Inspect review.json and the "
                "working tree, then 'resume' for more fix rounds (optionally with a --note), 'revise' to "
                "re-plan, or 'abort'.", resume_phase=IMPLEMENT)
            return
        st["impl_round"] += 1
        st["phase"] = IMPLEMENT

    def step_implement(self) -> None:
        st = self.state
        if st["base"] is None:
            dirty = self.git.status_porcelain(self.dirty_exclude)
            if dirty and not self.allow_dirty:
                self._escalate(
                    "dirty_worktree",
                    f"the working tree has {len(dirty)} uncommitted change(s). Commit or stash them, then "
                    "resume (or resume with --allow-dirty to let the implementer work on top of them).",
                    resume_phase=IMPLEMENT, details=dirty[:20])
                return
            base = self.git.snapshot(self.snapshot_exclude, ref=self._ref("base"),
                                     message=f"orchestrator {st['task_id']}: base")
            st["base"] = {"commit": base.commit, "tree": base.tree, "head": self.git.head(),
                          "branch": self.git.branch(), "dirty": bool(dirty)}
            st["impl_round"] = max(st["impl_round"], 1)
        k = st["impl_round"]
        protected = list(self.cfg.safety["protected_paths"])
        pre = self.git.snapshot(self.snapshot_exclude, ref=self._ref(f"impl-r{k}-pre"),
                                message=f"orchestrator {st['task_id']}: before implementation round {k}")
        before_pos = (self.git.head(), self.git.branch())
        plan_md = self.store.path("plan.final.md").read_text(encoding="utf-8")
        review = self.store.read_json("review.json")["output"] if self.store.path("review.json").is_file() else None
        failed = [g for g in (st["last_gates"] or []) if not g["passed"]] if k > 1 else []
        previous = st["last_implementation"]
        prompt = prompts.implementer(self._ctx(), k, plan_md, protected, st["open_findings"], review,
                                     failed, previous)

        def check(report: Dict[str, Any]) -> List[str]:
            if report["status"] == "blocked" and not (report["blocking_reason"] or "").strip():
                return ["status is 'blocked' but blocking_reason is empty"]
            return []

        extra_allowed = [f"Bash({g['command']}*)" for g in self.cfg.gates]
        result = self.runner.call("implementer", prompt, "implementation", self._log_prefix("implement", k),
                                  check=check, extra_allowed=extra_allowed)
        self._add_cost(result)
        post = self.git.snapshot(self.snapshot_exclude, ref=self._ref(f"impl-r{k}"),
                                 message=f"orchestrator {st['task_id']}: implementation round {k}")
        changes = self.git.name_status(pre.tree, post.tree)
        violations = guards.check_git_position(before_pos, (self.git.head(), self.git.branch()))
        violations += guards.check_changes(changes, protected, int(self.cfg.safety["max_deleted_files"]))
        denials = result.meta.get("permission_denials") or []
        report = result.data
        missing = []
        if report and st["open_findings"]:
            answered = {a["finding_id"] for a in report["addressed_findings"]}
            missing = [f["id"] for f in st["open_findings"] if f["id"] not in answered]
        self.store.write_json(f"implementation.r{k}.json", self._envelope(
            "implementer", k, result, pre_snapshot=pre.commit, snapshot=post.commit,
            changes=[{"status": s, "path": p} for s, p in changes], violations=violations,
            unanswered_findings=missing))
        st["last_snapshot"] = {"commit": post.commit, "tree": post.tree}
        st["last_implementation"] = {"round": k, "summary": report["summary"] if report else None,
                                     "status": report["status"] if report else None,
                                     "permission_denials": denials}
        if not result.ok:
            self._escalate("agent_error", f"implementer ({result.backend}) failed after {result.attempts} "
                           f"attempt(s): {result.error}", resume_phase=IMPLEMENT)
            return
        if violations:
            self._escalate(
                "guard_violation",
                f"the implementer broke a safety rule. Inspect the working tree; the state before this round "
                f"is pinned at {self._ref(f'impl-r{k}-pre')} ({pre.commit[:12]}). Resume to accept the changes "
                "and continue with the quality gates, or abort.", resume_phase=VERIFY, details=violations)
            return
        kind = "ok" if report["status"] == "completed" else "warn"
        self._record(IMPLEMENT, k, self._agent("implementer"), report["status"],
                     f"{len(changes)} file(s) changed; {report['summary'][:140]}", kind=kind,
                     artifact=f"implementation.r{k}.json")
        if missing:
            self.ui.warn(f"implementer did not respond to finding(s): {', '.join(missing)}")
        if denials:
            self.ui.warn(f"{len(denials)} tool call(s) were denied by permissions (see implementation.r{k}.json)")
        if report["status"] == "blocked":
            self._escalate("implementer_blocked", report["blocking_reason"], resume_phase=IMPLEMENT)
            return
        st["phase"] = VERIFY

    def step_verify(self) -> None:
        st = self.state
        k = st["impl_round"]
        limits = self.cfg.limits
        results = gates_mod.run_gates(self.cfg.gates, self.repo, self.store.dir / "gates", f"r{k}",
                                      int(limits["gate_timeout_sec"]), int(limits["max_gate_output_chars"]),
                                      self.ui)
        tree = self._tree()
        if tree != st["last_snapshot"]["tree"]:
            changed = self.git.name_status(st["last_snapshot"]["tree"], tree)
            self.ui.warn("quality gates modified the working tree: "
                         + ", ".join(f"{s} {p}" for s, p in changed[:10]) + " (re-snapshotting)")
            snap = self.git.snapshot(self.snapshot_exclude, ref=self._ref(f"impl-r{k}"),
                                     message=f"orchestrator {st['task_id']}: round {k} after gates")
            st["last_snapshot"] = {"commit": snap.commit, "tree": snap.tree}
        self.store.write_json(f"gates.r{k}.json", {"round": k, "snapshot": st["last_snapshot"]["commit"],
                                                   "timestamp": now_iso(), "results": results})
        st["last_gates"] = results
        passed = gates_mod.required_passed(results)
        st["consecutive_gate_failures"] = 0 if passed else st["consecutive_gate_failures"] + 1
        summary = ", ".join(f"{g['name']} {'PASS' if g['passed'] else 'FAIL'}" for g in results) or "no gates"
        self._record(VERIFY, k, "gates", "passed" if passed else "failed", summary,
                     kind="ok" if passed else "warn", artifact=f"gates.r{k}.json")
        enforce = bool(self.cfg.gates_cfg["require_tests_pass"])
        if not passed and enforce:
            limit = int(limits["max_consecutive_gate_failures"])
            if st["consecutive_gate_failures"] >= limit:
                self._escalate("gates_failing", f"required quality gates failed {limit} round(s) in a row. "
                               "Check the logs under gates/, then resume (optionally with a --note) or abort.",
                               resume_phase=IMPLEMENT)
                return
            if not self.cfg.gates_cfg["review_on_gate_failure"]:
                self._next_impl_round()  # back to the implementer without spending a review
                return
        st["phase"] = CODE_REVIEW

    def step_code_review(self) -> None:
        st = self.state
        k = st["impl_round"]
        base, snap = st["base"]["commit"], st["last_snapshot"]["commit"]
        diff = self.git.diff(base, snap)
        max_chars = int(self.cfg.limits["max_diff_chars"])
        truncated = len(diff) > max_chars
        plan_md = self.store.path("plan.final.md").read_text(encoding="utf-8")
        impl_report = self.store.read_json(f"implementation.r{k}.json")["output"]
        prompt = prompts.code_reviewer(self._ctx(), k, plan_md, base, snap, st["last_gates"] or [],
                                       self.git.diff_stat(base, snap), diff[:max_chars], truncated,
                                       st["open_findings"], impl_report)

        def check(review: Dict[str, Any]) -> List[str]:
            errors = _consistent_status(review)
            if review["reviewed_commit"] != snap:
                errors.append(f"reviewed_commit is {review['reviewed_commit']!r}, expected {snap!r}")
            return errors

        result = self._readonly_call("code_reviewer", "code_review", prompt, "review", k, check)
        if not result:
            return
        review = result.data
        envelope = self._envelope("code_reviewer", k, result, base=base, snapshot=snap)
        self.store.write_json(f"review.r{k}.json", envelope)
        self.store.write_json("review.json", envelope)
        st["open_findings"] = review["findings"]
        blocking = self._blocking(review["findings"])
        critical = [f for f in review["findings"] if f["severity"] == "critical"]
        gates_ok = gates_mod.required_passed(st["last_gates"] or []) or not self.cfg.gates_cfg["require_tests_pass"]
        approved = review["approved"] or not self.cfg.gates_cfg["require_codex_approval"]
        done = approved and not blocking and gates_ok
        if review["approved"] and blocking:
            self.ui.warn("the reviewer approved but reported blocking findings; continuing with a fix round")
        self._record(CODE_REVIEW, k, self._agent("code_reviewer"),
                     "approved" if done else "changes requested",
                     f"{len(review['findings'])} finding(s), {len(blocking)} blocking"
                     + ("" if gates_ok else ", required gates failing"),
                     kind="ok" if done else "warn", artifact=f"review.r{k}.json")
        if done:
            st["phase"] = DONE
            return
        if critical and self.cfg.gates_cfg["stop_on_critical_issue"]:
            self._escalate("critical_finding",
                           "the reviewer reported critical finding(s): "
                           + "; ".join(f"{f['id']} {f['issue']}" for f in critical)
                           + ". Inspect them, then resume to let the implementer fix them, revise, or abort.",
                           resume_phase=IMPLEMENT)
            return
        self._next_impl_round()

    # --------------------------------------------------------- human review
    def apply_decision(self, decision: str, note: Optional[str]) -> None:
        st = self.state
        if st["phase"] != HUMAN_REVIEW:
            raise ValueError(f"run {st['task_id']} is not waiting for a decision (phase {st['phase']})")
        hr = st["human_review"]
        if note:
            st["human_notes"].append({"at": now_iso(), "phase": hr["from_phase"], "note": note})
        if decision == "abort":
            st["phase"] = ABORTED
        elif decision == "revise":
            if hr["from_phase"] in (IMPLEMENT, VERIFY, CODE_REVIEW):
                st["plan_feedback"] = None  # planning-era critique is stale; the note drives the revision
            st["final_plan_version"] = None
            st["final_plan_hash"] = None
            st["planning_round"] += 1
            budget = st["planning_round"] + int(self.cfg.limits["max_planning_rounds"]) - 1
            st["limits"]["planning_rounds"] = max(st["limits"]["planning_rounds"], budget)
            st["phase"] = PLAN
        elif decision == "resume":
            target = hr["resume_phase"]
            if target == IMPLEMENT and st["final_plan_version"] is None:
                if not st["plan_version"]:
                    raise ValueError("there is no plan yet; use --decision revise")
                self._freeze_plan(st["plan_version"], by_human=True)
            elif target == IMPLEMENT and hr["from_phase"] in _NEW_ROUND_FROM:
                st["impl_round"] += 1
                self._ensure_review_budget()
            st["consecutive_gate_failures"] = 0
            st["phase"] = target
        else:
            raise ValueError(f"unknown decision {decision!r}")
        st["human_review"] = None
        self._record(HUMAN_REVIEW, st["impl_round"] or st["planning_round"], "human", decision,
                     note or f"after {hr['reason']}")
        self.save()

    def print_human_review(self) -> None:
        hr = self.state["human_review"] or {}
        self.ui.warn(f"HUMAN_REVIEW needed ({hr.get('reason')}): {hr.get('message')}")
        for d in hr.get("details") or []:
            self.ui.info(f"    - {d}")
        self.ui.info(f"  Report: {self.store.path('report.md')}")
        self.ui.info(f"  Continue: {self.command_hint} --resume {self.state['task_id']} "
                     "--decision resume|revise|abort [--note \"...\"]")

    # --------------------------------------------------------------- report
    def write_report(self) -> Path:
        st = self.state
        last_review = self.store.read_json("review.json")["output"] if self.store.path("review.json").is_file() else None
        last_critique = self._last_critique(st["planning_round"] + 1)
        diff_stat = ""
        if st.get("base") and st.get("last_snapshot"):
            try:
                diff_stat = self.git.diff_stat(st["base"]["commit"], st["last_snapshot"]["commit"])
            except Exception:
                diff_stat = ""
        text = render.report_markdown(st, diff_stat, last_review, last_critique, str(self.store.dir))
        return self.store.write_text("report.md", text)

