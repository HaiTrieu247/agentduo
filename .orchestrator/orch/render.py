"""Markdown renderings of agent outputs for humans (and for prompts)."""
from __future__ import annotations

from typing import Any, Dict, List

from . import gates as gates_mod


def _bullets(items: List[str], empty: str = "_(none)_") -> str:
    return "\n".join(f"- {x}" for x in items) if items else empty


def plan_markdown(plan: Dict[str, Any], version: int) -> str:
    steps = "\n".join(
        f"{i}. **{s['id']}** {s['description']}" + (f"  \n   Files: {', '.join(f'`{f}`' for f in s['files'])}"
                                                    if s["files"] else "")
        for i, s in enumerate(plan["steps"], 1)
    ) or "_(none)_"
    risks = "\n".join(f"- **{r['risk']}** — {r['mitigation']}" for r in plan["risks"]) or "_(none)_"
    parts = [
        f"# Plan v{version}: {plan['title']}",
        plan["summary"],
        "## Goals\n" + _bullets(plan["goals"]),
        "## Scope\n**In scope**\n" + _bullets(plan["scope_in"]) + "\n\n**Out of scope**\n" + _bullets(plan["scope_out"]),
        "## Architecture\n" + (plan["architecture"] or "_(none)_"),
        "## Steps\n" + steps,
        "## Acceptance criteria\n" + _bullets(plan["acceptance_criteria"]),
        "## Risks\n" + risks,
        "## Test strategy\n" + (plan["test_strategy"] or "_(none)_"),
        "## Open questions\n" + _bullets(plan["open_questions"]),
    ]
    if plan["feedback_resolution"]:
        parts.append("## Response to feedback\n" + "\n".join(
            f"- `{f['issue_id']}` **{f['decision']}** — {f['rationale']}" for f in plan["feedback_resolution"]))
    return "\n\n".join(parts) + "\n"


def issues_markdown(issues: List[Dict[str, Any]]) -> str:
    if not issues:
        return "_(no issues)_"
    return "\n".join(f"- `{i['id']}` [{i['severity']}] {i['description']}"
                     + (f"  \n  Suggestion: {i['suggestion']}" if i["suggestion"] else "") for i in issues)


def critique_markdown(critique: Dict[str, Any], round_no: int, plan_version: int, agent: str) -> str:
    parts = [
        f"## Round {round_no} — {agent} critique of plan v{plan_version}: **{critique['status']}**",
        critique["summary"],
        "### Issues\n" + issues_markdown(critique["issues"]),
    ]
    if critique["accepted"]:
        parts.append("### Accepted planner responses\n" + _bullets(critique["accepted"]))
    if critique["disputed"]:
        parts.append("### Still disputed\n" + _bullets(critique["disputed"]))
    if critique["proposed_changes"]:
        parts.append("### Proposed changes\n" + _bullets(critique["proposed_changes"]))
    return "\n\n".join(parts) + "\n\n"


def approval_markdown(approval: Dict[str, Any], round_no: int, plan_version: int, agent: str) -> str:
    return "\n\n".join([
        f"## Round {round_no} — {agent} final decision on plan v{plan_version}: **{approval['status']}**",
        approval["summary"],
        "### Issues\n" + issues_markdown(approval["issues"]),
    ]) + "\n\n"


def findings_markdown(findings: List[Dict[str, Any]]) -> str:
    if not findings:
        return "_(no findings)_"
    lines = []
    for f in findings:
        loc = f["file"] + (f":{f['line']}" if f.get("line") else "") if f["file"] else "(general)"
        lines.append(f"- `{f['id']}` [{f['severity']}] `{loc}` — {f['issue']}"
                     + (f"  \n  Recommendation: {f['recommendation']}" if f["recommendation"] else ""))
    return "\n".join(lines)


def report_markdown(state: Dict[str, Any], diff_stat: str, last_review: Any,
                    last_critique: Any, run_dir: str) -> str:
    hr = state.get("human_review") or {}
    status = state["phase"]
    lines = [
        f"# Orchestrator report — {state['task_id']}",
        f"- **Status:** {status}" + (f" — {hr.get('reason')}: {hr.get('message')}" if status == "HUMAN_REVIEW" else ""),
        f"- **Task:** {state['task']}",
        f"- **Started:** {state['created_at']} · **Updated:** {state['updated_at']}",
        f"- **Planning rounds:** {state['planning_round']} · **Plan version:** {state['plan_version']}"
        f" · **Final plan:** {('v' + str(state['final_plan_version'])) if state['final_plan_version'] else '—'}",
        f"- **Implementation rounds:** {state['impl_round']}",
        f"- **Claude cost (reported):** ${state.get('cost_usd', 0):.2f}",
        f"- **Run directory:** `{run_dir}`",
    ]
    base = state.get("base") or {}
    snap = state.get("last_snapshot") or {}
    if base and snap:
        lines.append(f"- **Diff:** `git diff {base['commit'][:12]} {snap['commit'][:12]}` "
                     "(changes are left uncommitted in your working tree)")
    lines.append("\n## Timeline")
    for h in state["history"]:
        lines.append(f"{h['step']}. `{h['phase']}` r{h['round']} **{h['agent']}** — {h['status']}: {h['summary']}")
    lines.append("\n## Quality gates (last run)")
    lines.append(gates_mod.describe(state.get("last_gates") or [], with_output=False)
                 if state.get("last_gates") else "_(not run)_")
    if diff_stat.strip():
        lines.append("\n## Diff stat\n```\n" + diff_stat.rstrip() + "\n```")
    unresolved: List[str] = []
    if last_review:
        for f in last_review["findings"]:
            unresolved.append(f"[review {f['severity']}] `{f['id']}` {f['file'] or ''} — {f['issue']}")
    elif last_critique and status != "DONE":
        for i in last_critique["issues"]:
            unresolved.append(f"[plan {i['severity']}] `{i['id']}` {i['description']}")
    for g in state.get("last_gates") or []:
        if not g["passed"]:
            unresolved.append(f"[gate] {g['name']} failed ({'required' if g['required'] else 'optional'})")
    impl = state.get("last_implementation") or {}
    for d in impl.get("permission_denials") or []:
        unresolved.append(f"[permission denied] {d.get('tool_name')}: {str(d.get('tool_input'))[:160]}")
    lines.append("\n## Unresolved issues\n" + _bullets(unresolved))
    if status == "HUMAN_REVIEW":
        lines.append("\n## Next step\n" + hr.get("message", "") + "\n\n```bash\n"
                     "python .orchestrator/orchestrator.py --resume " + state["task_id"]
                     + " --decision resume|revise|abort [--note \"...\"]\n```")
    return "\n".join(lines) + "\n"
