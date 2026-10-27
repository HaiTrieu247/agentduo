"""Unit tests for the orchestrator's building blocks."""
import json
import unittest
from pathlib import Path

import support
from support import TempDir, make_repo

from orch import agents, guards, schema, yamlish
from orch.config import ConfigError, load_config
from orch.gitops import Git

ORCH = support.ROOT / ".orchestrator"


class YamlishTest(unittest.TestCase):
    def test_subset(self):
        text = """
# comment
agents:
  planner: codex   # trailing comment
limits:
  max: 4
  ratio: 0.5
flags: [critical, "high", 'x y']
empty: []
none: null
on: true
gates:
  - name: tests
    command: python3 -m unittest discover -s tests
    required: false
  - name: lint
    command: "ruff check ."
paths:
- "**/*.pem"
- .env
url: http://example.com/#anchor
"""
        self.assertEqual(yamlish.loads(text), {
            "agents": {"planner": "codex"},
            "limits": {"max": 4, "ratio": 0.5},
            "flags": ["critical", "high", "x y"],
            "empty": [],
            "none": None,
            "on": True,
            "gates": [{"name": "tests", "command": "python3 -m unittest discover -s tests", "required": False},
                      {"name": "lint", "command": "ruff check ."}],
            "paths": ["**/*.pem", ".env"],
            "url": "http://example.com/#anchor",
        })

    def test_errors(self):
        for bad in ("a:\n  b: 1\n c: 2\n", "a: |\n  text\n", "a: 1\na: 2\n", "a: [1, 2\n"):
            with self.assertRaises(yamlish.YamlError, msg=bad):
                yamlish.loads(bad)

    def test_shipped_config_matches_pyyaml_semantics(self):
        cfg = yamlish.loads((ORCH / "config.yaml").read_text())
        self.assertEqual(cfg["agents"]["implementer"], "claude")
        self.assertEqual(cfg["quality_gates"]["blocking_severities"], ["critical", "high"])
        self.assertIn("**/*.pem", cfg["safety"]["protected_paths"])
        self.assertIsNone(cfg["claude"]["max_budget_usd"])


class ConfigTest(unittest.TestCase):
    def test_shipped_config_is_valid(self):
        cfg = load_config(ORCH / "config.yaml")
        self.assertEqual(cfg.warnings, [])
        self.assertEqual(cfg.permission_for("planner"), "read-only")
        self.assertEqual(cfg.permission_for("plan_reviewer"), "read-only")
        self.assertEqual(cfg.permission_for("implementer"), "workspace-write")

    def test_rejects_unsafe_settings(self):
        cases = {
            "agents:\n  implementer: codex\n": "only agent allowed",
            "permissions:\n  codex: workspace-write\n": "must run read-only",
            "gates: []\n": "no required gate",
            "limits:\n  max_review_rounds: 0\n": "max_review_rounds",
        }
        with TempDir() as tmp:
            for text, expected in cases.items():
                path = tmp / "c.yaml"
                path.write_text(text)
                with self.assertRaises(ConfigError, msg=text) as ctx:
                    load_config(path)
                self.assertIn(expected, str(ctx.exception))

    def test_unknown_keys_warn(self):
        with TempDir() as tmp:
            path = tmp / "c.yaml"
            path.write_text("limits:\n  max_planing_rounds: 3\ngates:\n  - name: t\n    command: 'true'\n")
            self.assertEqual(load_config(path).warnings, ["unknown config key 'limits.max_planing_rounds' (ignored)"])


class SchemaTest(unittest.TestCase):
    NAMES = ("plan", "plan_critique", "plan_approval", "implementation", "review")

    def test_schemas_are_strict_mode_compatible(self):
        for name in self.NAMES:
            self.assertEqual(schema.strict_problems(schema.load_schema(name)), [], name)

    def test_builders_validate(self):
        samples = {
            "plan": support.plan(), "plan_critique": support.critique(False, [support.issue("C1")]),
            "plan_approval": support.approval(True), "implementation": support.impl(addressed=["F1"]),
            "review": support.review(False, [support.finding("F1")], commit="a" * 40),
        }
        for name, sample in samples.items():
            self.assertEqual(schema.validate(sample, schema.load_schema(name)), [], name)

    def test_validation_errors(self):
        s = schema.load_schema("review")
        bad = support.review(True, [dict(support.finding("F1"), severity="urgent", line="7")], commit="x")
        bad["extra"] = 1
        del bad["summary"]
        errors = " | ".join(schema.validate(bad, s))
        for fragment in ("missing required property 'summary'", "unexpected property 'extra'",
                         "'urgent' is not one of", "$.findings[0].line: expected integer|null"):
            self.assertIn(fragment, errors)
        self.assertEqual(schema.validate(True, {"type": "integer"}), ["$: expected integer, got bool"])


class GuardsTest(unittest.TestCase):
    def test_protected_globs(self):
        patterns = [".orchestrator/**", ".env", ".env.*", "**/*.pem", "**/secrets/**"]
        for path in (".orchestrator/config.yaml", ".env", ".env.local", "key.pem", "a/b/key.pem",
                     "secrets/x", "app/secrets/y.txt"):
            self.assertIsNotNone(guards.match_protected(path, patterns), path)
        for path in ("src/env.py", "README.md", "pem.txt", "src/.envrc.md"):
            self.assertIsNone(guards.match_protected(path, patterns), path)

    def test_check_changes(self):
        changes = [("M", "src/a.py"), ("A", ".env")] + [("D", f"f{i}") for i in range(3)]
        violations = guards.check_changes(changes, [".env"], max_deleted=2)
        self.assertEqual(len(violations), 2)
        self.assertIn(".env", violations[0])
        self.assertIn("deleted 3 files", violations[1])
        self.assertEqual(guards.check_changes(changes[:1], [".env"], 2), [])


class GitOpsTest(unittest.TestCase):
    def test_snapshot_includes_untracked_and_leaves_repo_untouched(self):
        for ignore_runs in (True, False):
            with self.subTest(ignore_runs=ignore_runs):
                self._check_snapshot(ignore_runs)

    def _check_snapshot(self, ignore_runs):
        with TempDir() as tmp:
            repo = make_repo(tmp, ignore_runs=ignore_runs)
            g = Git(repo)
            head, index = g.head(), (repo / ".git" / "index").read_bytes()
            base = g.snapshot(exclude=[".orchestrator/runs"])
            (repo / "new.txt").write_text("n\n")
            (repo / "README.md").unlink()
            (repo / ".orchestrator" / "runs").mkdir(parents=True)
            (repo / ".orchestrator" / "runs" / "log.txt").write_text("ignored\n")
            snap = g.snapshot(exclude=[".orchestrator/runs"], ref="refs/orchestrator/t/r1")
            self.assertEqual(sorted(g.name_status(base.tree, snap.tree)), [("A", "new.txt"), ("D", "README.md")])
            self.assertEqual(g.worktree_tree([".orchestrator/runs"]), snap.tree)
            self.assertEqual((g.head(), (repo / ".git" / "index").read_bytes()), (head, index))
            self.assertEqual(support.git(repo, "rev-parse", "refs/orchestrator/t/r1"), snap.commit)
            self.assertIn("?? new.txt", g.status_porcelain([".orchestrator/runs"]))
            self.assertIn("new.txt", g.diff_stat(base.commit, snap.commit))


class AgentsTest(unittest.TestCase):
    def setUp(self):
        self.cfg = load_config(ORCH / "config.yaml")

    def test_extract_json(self):
        self.assertEqual(agents.extract_json('```json\n{"a": 1}\n```'), {"a": 1})
        self.assertEqual(agents.extract_json('Here you go: {"a": {"b": 2}} done'), {"a": {"b": 2}})
        with self.assertRaises(agents.AgentFailure):
            agents.extract_json("no json here")

    def test_claude_commands(self):
        backend = agents.ClaudeBackend(self.cfg, Path("/repo"))
        backend.binary = lambda: "claude"
        ro = backend.build_command("plan_critique", "read-only", Path("/tmp/x"), [])
        self.assertEqual(ro[:2], ["claude", "-p"])
        self.assertEqual(ro[ro.index("--tools") + 1], "Read,Grep,Glob")
        self.assertEqual(ro[ro.index("--permission-mode") + 1], "dontAsk")
        self.assertNotIn("--disallowedTools", ro)
        self.assertEqual(json.loads(ro[ro.index("--json-schema") + 1]), schema.load_schema("plan_critique"))
        rw = backend.build_command("implementation", "workspace-write", Path("/tmp/x"), ["Bash(make test*)"])
        self.assertEqual(rw[rw.index("--permission-mode") + 1], "acceptEdits")
        self.assertIn("Bash(make test*)", rw)
        self.assertIn("Bash(git push*)", rw[rw.index("--disallowedTools"):])
        self.assertEqual(rw[rw.index("--permission-prompts") + 1], "none")

    def test_codex_command(self):
        backend = agents.CodexBackend(self.cfg, Path("/repo"))
        backend.binary = lambda: "codex"
        cmd = backend.build_command("review", "read-only", Path("/tmp/last.json"), [])
        self.assertEqual(cmd[:2], ["codex", "exec"])
        self.assertEqual(cmd[cmd.index("--sandbox") + 1], "read-only")
        self.assertEqual(cmd[cmd.index("--output-last-message") + 1], "/tmp/last.json")
        self.assertTrue(cmd[cmd.index("--output-schema") + 1].endswith("review.schema.json"))
        self.assertEqual(cmd[-1], "-")

    def test_claude_parse(self):
        backend = agents.ClaudeBackend(self.cfg, Path("/repo"))
        env = {"type": "result", "subtype": "success", "is_error": False, "result": '{"a": 1}',
               "structured_output": {"a": 2}, "total_cost_usd": 0.5}
        data, meta = backend.parse(json.dumps(env), "", Path("/nope"))
        self.assertEqual((data, meta["cost_usd"]), ({"a": 2}, 0.5))
        del env["structured_output"]
        self.assertEqual(backend.parse(json.dumps(env), "", Path("/nope"))[0], {"a": 1})
        env.update(subtype="error_max_budget_usd", is_error=True)
        with self.assertRaises(agents.AgentFailure) as ctx:
            backend.parse(json.dumps(env), "", Path("/nope"))
        self.assertEqual(ctx.exception.meta["cost_usd"], 0.5)

    def test_resolve_bin_finds_ide_bundled_claude(self):
        with TempDir() as tmp:
            for version in ("2.1.9", "2.1.310"):
                path = tmp / ".vscode" / "extensions" / f"anthropic.claude-code-{version}-darwin-arm64" \
                    / "resources" / "native-binary" / "claude"
                path.parent.mkdir(parents=True)
                path.write_text("#!/bin/sh\n")
                path.chmod(0o755)
            import os
            old_home, old_path = os.environ["HOME"], os.environ.get("PATH", "")
            os.environ["HOME"], os.environ["PATH"] = str(tmp), "/nonexistent"
            try:
                found = agents.resolve_bin("claude", "claude")
            finally:
                os.environ["HOME"], os.environ["PATH"] = old_home, old_path
            self.assertIn("2.1.310", found)


if __name__ == "__main__":
    unittest.main()
