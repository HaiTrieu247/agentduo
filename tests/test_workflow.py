"""End-to-end runs of the orchestrator against fake codex/claude CLIs."""
import json
import unittest

import support
from support import (FakeCLIs, TempDir, approval, critique, finding, impl, issue, make_repo, plan,
                     review, run_cli, write_config)

from orch.state import RunStore


class WorkflowTest(unittest.TestCase):
    def setUp(self):
        self._tmp = TempDir()
        self.tmp = self._tmp.__enter__()
        self.repo = make_repo(self.tmp)
        self.fake = FakeCLIs(self.tmp).__enter__()
        self.head = support.git(self.repo, "rev-parse", "HEAD")

    def tearDown(self):
        self.fake.__exit__()
        self._tmp.__exit__()

    def start(self, scenario, task="Make app.txt fixed", **config):
        self.fake.set_scenario(scenario)
        self.config = write_config(self.tmp, self.fake, **config)
        return run_cli(task, "--repo", str(self.repo), "--config", str(self.config))

    def resume(self, *extra):
        return run_cli("--resume", *extra, "--repo", str(self.repo), "--config", str(self.config))

    def state(self):
        return RunStore.open(self.repo / ".orchestrator" / "runs").load_state()

    def run_dir(self):
        return RunStore.open(self.repo / ".orchestrator" / "runs").dir

    # ----------------------------------------------------------------- tests
    def test_full_debate_and_fix_loop_reaches_done(self):
        code, out = self.start({
            "planner": [{"output": plan("v1")}, {"output": plan("v2", feedback_resolution=[
                {"issue_id": "C1", "decision": "accepted", "rationale": "ok"}])}],
            "plan_reviewer": [{"output": critique(False, [issue("C1")])}, {"output": critique(True)}],
            "plan_finalizer": [{"output": approval(True)}],
            "implementer": [
                {"write": {"app.txt": "buggy\n"}, "output": impl()},
                {"write": {"app.txt": "fixed\n"}, "output": impl()},
                {"write": {"app.txt": "fixed\nedge case handled\n"}, "output": impl(addressed=["F1"])},
            ],
            "code_reviewer": [{"output": review(False, [finding("F1")])},
                              {"output": review(True, resolved=["F1"])}],
        })
        self.assertEqual(code, 0, out)
        st = self.state()
        self.assertEqual(st["phase"], "DONE")
        self.assertEqual((st["planning_round"], st["plan_version"], st["final_plan_version"]), (2, 2, 2))
        self.assertEqual(st["impl_round"], 3)
        self.assertEqual(st["open_findings"], [])
        phases = [(h["phase"], h["status"]) for h in st["history"]]
        self.assertEqual(phases, [
            ("PLAN", "plan created"), ("PLAN_REVIEW", "changes requested"),
            ("PLAN", "plan revised"), ("PLAN_REVIEW", "approved"), ("PLAN_FINALIZE", "plan finalized"),
            ("IMPLEMENT", "completed"), ("VERIFY", "failed"),            # gate failure skips review
            ("IMPLEMENT", "completed"), ("VERIFY", "passed"), ("CODE_REVIEW", "changes requested"),
            ("IMPLEMENT", "completed"), ("VERIFY", "passed"), ("CODE_REVIEW", "approved"),
        ])
        # Changes stay uncommitted; HEAD and branch untouched; snapshots pinned under refs/orchestrator.
        self.assertEqual(support.git(self.repo, "rev-parse", "HEAD"), self.head)
        self.assertEqual((self.repo / "app.txt").read_text(), "fixed\nedge case handled\n")
        refs = support.git(self.repo, "for-each-ref", "--format=%(refname)", "refs/orchestrator")
        self.assertIn("/base", refs)
        self.assertIn("/impl-r3", refs)
        # Artifacts and report.
        run_dir = self.run_dir()
        for name in ("plan.md", "plan.final.md", "plan-feedback.md", "review.json", "report.md",
                     "plan.v1.json", "critique.r1.json", "implementation.r3.json", "gates.r1.json"):
            self.assertTrue((run_dir / name).is_file(), name)
        envelope = json.loads((run_dir / "review.json").read_text())
        for key in ("task_id", "round", "timestamp", "git_sha", "plan_version"):
            self.assertIn(key, envelope)
        self.assertEqual(envelope["output"]["reviewed_commit"], st["last_snapshot"]["commit"])
        self.assertIn("DONE", (run_dir / "report.md").read_text())
        # Feedback is threaded through the prompts.
        impl_calls = self.fake.calls("implementer")
        self.assertIn("Failing quality gates", impl_calls[1]["prompt"])
        self.assertIn("check failed", impl_calls[1]["prompt"])
        self.assertIn("`F1`", impl_calls[2]["prompt"])
        self.assertIn("C1", self.fake.calls("planner")[1]["prompt"])
        self.assertIn("`F1`", self.fake.calls("code_reviewer")[1]["prompt"])

    def test_cli_permissions_per_role(self):
        self.start({
            "planner": [{"output": plan()}],
            "plan_reviewer": [{"output": critique(True)}],
            "plan_finalizer": [{"output": approval(True)}],
            "implementer": [{"write": {"app.txt": "fixed\n"}, "output": impl()}],
            "code_reviewer": [{"output": review(True)}],
        })
        for role in ("planner", "plan_finalizer", "code_reviewer"):
            args = self.fake.calls(role)[0]["args"]
            self.assertEqual(args[0], "exec")
            self.assertEqual(args[args.index("--sandbox") + 1], "read-only", role)
            self.assertIn("--output-schema", args)
        reviewer = self.fake.calls("plan_reviewer")[0]["args"]
        self.assertEqual(reviewer[reviewer.index("--tools") + 1], "Read,Grep,Glob")
        self.assertEqual(reviewer[reviewer.index("--permission-mode") + 1], "dontAsk")
        implementer = self.fake.calls("implementer")[0]["args"]
        self.assertEqual(implementer[implementer.index("--permission-mode") + 1], "acceptEdits")
        self.assertIn("Bash(git push*)", implementer)
        self.assertTrue(any(a.startswith("Bash(") and "check.py" in a for a in implementer))

    def test_max_planning_rounds_then_human_accepts_latest_plan(self):
        code, out = self.start({
            "planner": [{"output": plan()}],
            "plan_reviewer": [{"output": critique(False, [issue("C1")])}],
            "plan_finalizer": [{"output": approval(True)}],
            "implementer": [{"write": {"app.txt": "fixed\n"}, "output": impl()}],
            "code_reviewer": [{"output": review(True)}],
        }, limits={"max_planning_rounds": 2})
        self.assertEqual(code, 2, out)
        st = self.state()
        self.assertEqual(st["phase"], "HUMAN_REVIEW")
        self.assertEqual(st["human_review"]["reason"], "max_planning_rounds")
        self.assertEqual(st["plan_version"], 2)
        self.assertTrue((self.run_dir() / "report.md").is_file())

        code, out = self.resume()  # no decision: just prints what is needed
        self.assertEqual(code, 2)
        self.assertIn("--decision", out)

        code, out = self.resume("--decision", "resume", "--note", "C1 is acceptable, go ahead")
        self.assertEqual(code, 0, out)
        st = self.state()
        self.assertEqual((st["phase"], st["final_plan_version"]), ("DONE", 2))
        self.assertIn("accepted by the human operator", (self.run_dir() / "plan.final.md").read_text())
        self.assertIn("C1 is acceptable", self.fake.calls("implementer")[0]["prompt"])

    def test_revise_decision_replans_with_note(self):
        self.start({
            "planner": [{"output": plan()}],
            "plan_reviewer": [{"output": critique(False, [issue("C1")])}, {"output": critique(False, [issue("C1")])},
                              {"output": critique(True)}],
            "plan_finalizer": [{"output": approval(True)}],
            "implementer": [{"write": {"app.txt": "fixed\n"}, "output": impl()}],
            "code_reviewer": [{"output": review(True)}],
        }, limits={"max_planning_rounds": 2})
        code, out = self.resume("--decision", "revise", "--note", "drop the cache layer")
        self.assertEqual(code, 0, out)
        st = self.state()
        self.assertEqual(st["planning_round"], 3)
        self.assertEqual(st["phase"], "DONE")
        self.assertIn("drop the cache layer", self.fake.calls("planner")[2]["prompt"])

    def test_readonly_violation_escalates_and_rerun_after_revert(self):
        code, out = self.start({
            "planner": [{"write": {"sneaky.txt": "x"}, "output": plan()}, {"output": plan()}],
            "plan_reviewer": [{"output": critique(True)}],
            "plan_finalizer": [{"output": approval(True)}],
            "implementer": [{"write": {"app.txt": "fixed\n"}, "output": impl()}],
            "code_reviewer": [{"output": review(True)}],
        })
        self.assertEqual(code, 2, out)
        st = self.state()
        self.assertEqual(st["human_review"]["reason"], "readonly_violation")
        self.assertIn("sneaky.txt", " ".join(st["human_review"]["details"]))
        self.assertEqual(st["plan_version"], 0)  # the tainted plan was not accepted
        (self.repo / "sneaky.txt").unlink()
        code, out = self.resume("--decision", "resume")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.state()["phase"], "DONE")

    def test_invalid_output_is_retried(self):
        self.start({
            "planner": [{"output": plan()}],
            "plan_reviewer": [{"raw": "I think the plan is fine!"},
                              {"output": critique(True)}],
            "plan_finalizer": [{"output": {**approval(True), "status": "changes_requested"}},
                               {"output": approval(True)}],
            "implementer": [{"write": {"app.txt": "fixed\n"}, "output": impl()}],
            "code_reviewer": [{"output": review(True, commit="0" * 40)}, {"output": review(True)}],
        })
        st = self.state()
        self.assertEqual(st["phase"], "DONE")
        run_dir = self.run_dir()
        self.assertEqual(json.loads((run_dir / "critique.r1.json").read_text())["attempts"], 2)
        self.assertEqual(json.loads((run_dir / "approval.r1.json").read_text())["attempts"], 2)
        self.assertEqual(json.loads((run_dir / "review.r1.json").read_text())["attempts"], 2)
        retry_prompt = self.fake.calls("code_reviewer")[1]["prompt"]
        self.assertIn("Previous attempt was rejected", retry_prompt)
        self.assertIn("reviewed_commit", retry_prompt)

    def test_persistent_bad_output_escalates_agent_error(self):
        code, out = self.start({"planner": [{"raw": "not json"}]})
        self.assertEqual(code, 2, out)
        st = self.state()
        self.assertEqual(st["human_review"]["reason"], "agent_error")
        self.assertEqual(st["human_review"]["resume_phase"], "PLAN")
        self.assertEqual(len(self.fake.calls("planner")), 2)

    def test_critical_finding_stops_then_resume_starts_fix_round(self):
        code, out = self.start({
            "planner": [{"output": plan()}],
            "plan_reviewer": [{"output": critique(True)}],
            "plan_finalizer": [{"output": approval(True)}],
            "implementer": [{"write": {"app.txt": "fixed\n"}, "output": impl()},
                            {"write": {"app.txt": "fixed safely\n"}, "output": impl(addressed=["F1"])}],
            "code_reviewer": [{"output": review(False, [finding("F1", "critical")])},
                              {"output": review(True, resolved=["F1"])}],
        })
        self.assertEqual(code, 2, out)
        self.assertEqual(self.state()["human_review"]["reason"], "critical_finding")
        code, out = self.resume("--decision", "resume")
        self.assertEqual(code, 0, out)
        st = self.state()
        self.assertEqual((st["phase"], st["impl_round"]), ("DONE", 2))

    def test_protected_path_and_commit_are_guard_violations(self):
        code, out = self.start({
            "planner": [{"output": plan()}],
            "plan_reviewer": [{"output": critique(True)}],
            "plan_finalizer": [{"output": approval(True)}],
            "implementer": [{"write": {"app.txt": "fixed\n", ".env": "TOKEN=1\n"},
                             "shell": ["git add app.txt && git commit -qm sneaky"], "output": impl()}],
        })
        self.assertEqual(code, 2, out)
        hr = self.state()["human_review"]
        self.assertEqual(hr["reason"], "guard_violation")
        details = " ".join(hr["details"])
        self.assertIn(".env", details)
        self.assertIn("HEAD moved", details)

    def test_implementer_blocked(self):
        code, out = self.start({
            "planner": [{"output": plan()}],
            "plan_reviewer": [{"output": critique(True)}],
            "plan_finalizer": [{"output": approval(True)}],
            "implementer": [{"output": impl("blocked", blocking_reason="API key needed")}],
        })
        self.assertEqual(code, 2, out)
        hr = self.state()["human_review"]
        self.assertEqual((hr["reason"], hr["message"]), ("implementer_blocked", "API key needed"))

    def test_gates_failing_repeatedly_escalates(self):
        code, out = self.start({
            "planner": [{"output": plan()}],
            "plan_reviewer": [{"output": critique(True)}],
            "plan_finalizer": [{"output": approval(True)}],
            "implementer": [{"write": {"app.txt": "still broken\n"}, "output": impl()}],
        }, limits={"max_consecutive_gate_failures": 2})
        self.assertEqual(code, 2, out)
        st = self.state()
        self.assertEqual(st["human_review"]["reason"], "gates_failing")
        self.assertEqual(st["impl_round"], 2)
        self.assertEqual(len(self.fake.calls("code_reviewer")), 0)

    def test_max_review_rounds(self):
        code, out = self.start({
            "planner": [{"output": plan()}],
            "plan_reviewer": [{"output": critique(True)}],
            "plan_finalizer": [{"output": approval(True)}],
            "implementer": [{"write": {"app.txt": "fixed\n"}, "output": impl(addressed=["F1"])}],
            "code_reviewer": [{"output": review(False, [finding("F1")])}],
        }, limits={"max_review_rounds": 2})
        self.assertEqual(code, 2, out)
        st = self.state()
        self.assertEqual((st["human_review"]["reason"], st["impl_round"]), ("max_review_rounds", 2))
        self.assertIn("`F1`", (self.run_dir() / "report.md").read_text())
        code, out = self.resume("--decision", "abort")
        self.assertEqual(code, 3, out)
        self.assertEqual(self.state()["phase"], "ABORTED")

    def test_pause_before_implement(self):
        code, out = self.start({
            "planner": [{"output": plan()}],
            "plan_reviewer": [{"output": critique(True)}],
            "plan_finalizer": [{"output": approval(True)}],
            "implementer": [{"write": {"app.txt": "fixed\n"}, "output": impl()}],
            "code_reviewer": [{"output": review(True)}],
        }, safety={"pause_before_implement": True})
        self.assertEqual(code, 2, out)
        self.assertEqual(self.state()["human_review"]["reason"], "plan_ready")
        self.assertEqual(self.fake.calls("implementer"), [])
        code, out = self.resume("--decision", "resume")
        self.assertEqual(code, 0, out)

    def test_dirty_worktree_is_refused_before_any_agent_call(self):
        (self.repo / "README.md").write_text("local edit\n")
        code, out = self.start({"planner": [{"output": plan()}]})
        self.assertEqual(code, 1)
        self.assertIn("uncommitted", out)
        self.assertEqual(self.fake.calls(), [])

    def test_medium_findings_do_not_block_done(self):
        code, out = self.start({
            "planner": [{"output": plan()}],
            "plan_reviewer": [{"output": critique(True, [issue("C1", "low")])}],
            "plan_finalizer": [{"output": approval(True)}],
            "implementer": [{"write": {"app.txt": "fixed\n"}, "output": impl()}],
            "code_reviewer": [{"output": review(True, [finding("F1", "medium")])}],
        })
        self.assertEqual(code, 0, out)
        self.assertIn("F1", (self.run_dir() / "report.md").read_text())

    def test_status_and_list(self):
        self.start({"planner": [{"raw": "x"}]})
        code, out = run_cli("--status", "--repo", str(self.repo), "--config", str(self.config))
        self.assertEqual(code, 0)
        self.assertIn("HUMAN_REVIEW", out)
        code, out = run_cli("--list", "--repo", str(self.repo), "--config", str(self.config))
        self.assertEqual(code, 0)
        self.assertIn("make-app-txt-fixed", out)


if __name__ == "__main__":
    unittest.main()
