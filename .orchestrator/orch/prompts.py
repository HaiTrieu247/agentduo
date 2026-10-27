"""Prompt templates for each role. Every prompt starts with a machine-readable
role tag so logs (and test doubles) can tell the calls apart."""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from . import gates as gates_mod
from .render import findings_markdown, issues_markdown

SEVERITY_GUIDE = """Severity scale:
- critical: the work cannot succeed as written, or it would cause damage (data loss, security hole, broken build for everyone).
- high: a significant gap or defect that must be fixed before moving on.
- medium: should be fixed, but does not block.
- low: minor improvement or nit."""


def _header(role: str, title: str, ctx: Dict[str, Any]) -> str:
    return (
        f"[orchestrator-role: {role}]\n"
        f"You are the **{title}** in an automated multi-agent software workflow driven by a Python orchestrator.\n"
        "Team: Codex designs and plans, then reviews code (never edits files). Claude Code critiques plans for "
        "feasibility and is the only agent that edits files. Agreement between agents is not proof of "
        "correctness: the orchestrator runs the project's quality gates independently.\n\n"
        f"- Repository: `{ctx['repo']}`\n"
        f"- Task ID: `{ctx['task_id']}`\n"
    )


def _gate_list(gates: List[Dict[str, Any]]) -> str:
    if not gates:
        return "_(none configured)_"
    return "\n".join(f"- `{g['command']}` ({g['name']}, {'required' if g.get('required', True) else 'optional'})"
                     for g in gates)


def _notes(notes: List[Dict[str, Any]]) -> str:
    if not notes:
        return ""
    return "\n## Notes from the human operator (highest priority)\n" + "\n".join(
        f"- ({n['at']}, during {n['phase']}) {n['note']}" for n in notes) + "\n"


READONLY_RULES = (
    "## Hard rules\n"
    "- You are READ-ONLY. Do not create, modify, move or delete any file, and do not run commands that "
    "change the repository, its git state or the network. The orchestrator verifies the working tree "
    "is byte-for-byte unchanged after your turn and escalates to a human if it is not.\n"
    "- Inspect the repository as needed (read files, search, read-only git commands such as "
    "`git log`, `git show`, `git diff <a> <b>`).\n"
    "- Your final message must be a single JSON object matching the provided output schema. "
    "No prose outside the JSON.\n"
)


def planner(ctx: Dict[str, Any], round_no: int, version: int, previous_plan: Optional[Dict[str, Any]],
            feedback: Optional[Dict[str, Any]]) -> str:
    out = [_header("planner", "Planner / Architect", ctx),
           f"- Planning round: {round_no} · Producing plan version: v{version}\n",
           "## Task\n" + ctx["task"] + "\n",
           _notes(ctx["notes"]),
           READONLY_RULES,
           "## Your job\n"
           "Study the repository and produce an implementation plan that another agent (Claude Code) can "
           "execute without further clarification.\n"
           "- Goals and explicit scope (in / out). Keep the scope to what the task needs.\n"
           "- Architecture / design decisions that fit the existing code and conventions.\n"
           "- Ordered, concrete steps; list the files each step creates or changes.\n"
           "- Acceptance criteria that are objective and testable.\n"
           "- Risks with mitigations, and a test strategy (which tests to add or update).\n"
           "- Open questions only for things that truly cannot be decided from the repository; "
           "state the assumption you made for each.\n\n"
           "After implementation the orchestrator will run these quality gates, which must pass:\n"
           + _gate_list(ctx["gates"]) + "\n"]
    if previous_plan is None:
        out.append("\nThis is the first version: return `feedback_resolution` as an empty list.\n")
    else:
        out.append("\n## Previous plan (v{}) as JSON\n```json\n{}\n```\n".format(
            version - 1, json.dumps(previous_plan, indent=2, ensure_ascii=False)))
        out.append(_feedback_section(feedback))
        out.append(
            "\nRevise the plan to address the feedback. In `feedback_resolution`, add one entry per issue id "
            "above with decision `accepted`, `partially_accepted` or `disputed` and a rationale. Dispute only "
            "with a concrete technical reason; disputed critical/high issues will go back to the critic.\n")
    return "\n".join(out)


def _feedback_section(feedback: Optional[Dict[str, Any]]) -> str:
    if not feedback:
        return ""
    parts = ["\n## Feedback to address"]
    critique = feedback.get("critique")
    if critique:
        parts.append(f"### Plan critique (status: {critique['status']})\n{critique['summary']}\n\n"
                     + issues_markdown(critique["issues"]))
        if critique["proposed_changes"]:
            parts.append("Proposed changes:\n" + "\n".join(f"- {c}" for c in critique["proposed_changes"]))
        if critique["disputed"]:
            parts.append("Critic still disputes:\n" + "\n".join(f"- {c}" for c in critique["disputed"]))
    approval = feedback.get("approval")
    if approval:
        parts.append(f"### Final-approval review (status: {approval['status']})\n{approval['summary']}\n\n"
                     + issues_markdown(approval["issues"]))
    return "\n\n".join(parts) + "\n"


def plan_reviewer(ctx: Dict[str, Any], round_no: int, version: int, plan_md: str,
                  previous_critique: Optional[Dict[str, Any]]) -> str:
    out = [_header("plan_reviewer", "Plan Critic", ctx),
           f"- Planning round: {round_no} · Plan under review: v{version}\n",
           "## Task\n" + ctx["task"] + "\n",
           _notes(ctx["notes"]),
           READONLY_RULES,
           "## Plan under review\n" + plan_md + "\n",
           "## Your job\n"
           "You will implement this plan later, so judge whether it is feasible in THIS codebase:\n"
           "- Do the files, modules, APIs and commands it relies on actually exist and work as assumed?\n"
           "- Missing steps, wrong ordering, hidden dependencies, migration or compatibility concerns.\n"
           "- Are the acceptance criteria objective and testable with the quality gates below?\n"
           "- Risks the planner missed; unnecessary scope; ambiguity that would force guessing.\n\n"
           "Quality gates that must pass after implementation:\n" + _gate_list(ctx["gates"]) + "\n\n"
           + SEVERITY_GUIDE + "\n\n"
           "Decision rules:\n"
           "- Set `approved: true` and `status: \"approved\"` only if no critical or high issue remains. "
           "Medium/low issues may accompany an approval as suggestions.\n"
           "- Give each issue a stable id (`C1`, `C2`, ...). Reuse the same id when you re-raise an issue "
           "from a previous round.\n"
           "- `accepted`: planner responses (by issue id and short reason) you now agree with. `disputed`: "
           "planner responses you still disagree with, with your reasoning; re-raise any still-blocking one "
           "in `issues`.\n"
           "- `proposed_changes`: concrete edits to the plan you recommend.\n"]
    if previous_critique:
        out.append("\n## Your critique from the previous round\n" + issues_markdown(previous_critique["issues"])
                   + "\n\nCheck how the new plan version addressed each of these (see its 'Response to "
                   "feedback' section).\n")
    return "\n".join(out)


def plan_finalizer(ctx: Dict[str, Any], round_no: int, version: int, plan_md: str,
                   critique: Dict[str, Any]) -> str:
    return "\n".join([
        _header("plan_finalizer", "Planner / Architect (final plan sign-off)", ctx),
        f"- Planning round: {round_no} · Plan up for sign-off: v{version}\n",
        "## Task\n" + ctx["task"] + "\n",
        _notes(ctx["notes"]),
        READONLY_RULES,
        "## Plan\n" + plan_md + "\n",
        "## The critic approved this version\n" + critique["summary"] + "\n\nRemaining suggestions:\n"
        + issues_markdown(critique["issues"]) + "\n",
        "## Your job\n"
        "Confirm whether this exact plan version is final and ready for implementation. Approve "
        "(`approved: true`, `status: \"approved\"`) unless you find a critical or high problem; then return "
        "`changes_requested` with issues (ids `A1`, `A2`, ...) and the plan goes through another revision "
        "round. Do not request changes for style or wording alone.\n\n" + SEVERITY_GUIDE + "\n",
    ])


def implementer(ctx: Dict[str, Any], round_no: int, plan_md: str, protected: List[str],
                findings: List[Dict[str, Any]], review: Optional[Dict[str, Any]],
                failed_gates: List[Dict[str, Any]], previous_report: Optional[Dict[str, Any]]) -> str:
    out = [_header("implementer", "Implementer", ctx),
           f"- Implementation round: {round_no}\n",
           "## Task\n" + ctx["task"] + "\n",
           _notes(ctx["notes"]),
           "## Final approved plan\n" + plan_md + "\n",
           "## Hard rules\n"
           "- You are the only agent allowed to edit files. Stay within the plan's scope.\n"
           "- Never commit, push, reset, stash, switch branches or rewrite git history; the orchestrator "
           "snapshots your changes itself and leaves them uncommitted for the human.\n"
           "- Do not touch these protected paths: " + ", ".join(f"`{p}`" for p in protected) + ".\n"
           "- Do not delete files unless the plan requires it. No network access, no deploys, no secrets.\n"
           "- Run the quality gates yourself before finishing and fix what fails:\n"
           + _gate_list(ctx["gates"]) + "\n"
           "- Shell access is an allowlist matched per command: run each check as its own Bash call, "
           "exactly as written above. Chained commands (`;`, `&&`, `|`) do not match and are denied.\n"
           "- If you cannot proceed (missing information, contradictory requirements, missing permissions), "
           "stop and return `status: \"blocked\"` with a precise `blocking_reason`.\n"
           "- Your final message must be a single JSON object matching the output schema: summary, "
           "files_changed, tests_run (what you actually ran and whether it passed) and addressed_findings.\n"]
    if round_no == 1 and not findings and not failed_gates:
        out.append("\nImplement the plan now. `addressed_findings` should be an empty list.\n")
    else:
        out.append("\n## This is a fix round\nYour previous implementation is already in the working tree. "
                   "Address the problems below without redoing unrelated work.\n")
        if findings:
            sha = review["reviewed_commit"][:12] if review else "?"
            out.append(f"### Code review findings (reviewed revision `{sha}`)\n"
                       + (review["summary"] + "\n\n" if review else "") + findings_markdown(findings)
                       + "\n\nFor every finding id, add an entry to `addressed_findings`: `fixed`, "
                       "`not_applicable`, or `disputed` with a concrete technical justification.\n")
        if failed_gates:
            out.append("### Failing quality gates (run by the orchestrator)\n"
                       + gates_mod.describe(failed_gates) + "\n")
        if previous_report and previous_report.get("summary"):
            out.append("### Your previous report\n" + previous_report["summary"] + "\n")
    return "\n".join(out)


def code_reviewer(ctx: Dict[str, Any], round_no: int, plan_md: str, base: str, snapshot: str,
                  gate_results: List[Dict[str, Any]], diff_stat: str, diff: str, diff_truncated: bool,
                  previous_findings: List[Dict[str, Any]], impl_report: Dict[str, Any]) -> str:
    out = [_header("code_reviewer", "Code Reviewer", ctx),
           f"- Review round: {round_no}\n"
           f"- Revision under review: `{snapshot}` (orchestrator snapshot of the working tree)\n"
           f"- Base revision: `{base}`\n",
           "## Task\n" + ctx["task"] + "\n",
           _notes(ctx["notes"]),
           READONLY_RULES,
           "## Final approved plan\n" + plan_md + "\n",
           "## Quality gate results (authoritative, run by the orchestrator on this revision)\n"
           + gates_mod.describe(gate_results) + "\n",
           "## Implementer's report\n" + impl_report["summary"] + "\n\nTests the implementer says it ran:\n"
           + ("\n".join(f"- `{t['command']}` passed={t['passed']} {t['notes']}" for t in impl_report["tests_run"])
              or "_(none)_") + "\n",
           "## Diff stat (base → revision)\n```\n" + (diff_stat.rstrip() or "(no changes)") + "\n```\n",
           "## Diff" + (" (TRUNCATED: run `git diff {} {}` for the full diff)".format(base, snapshot)
                        if diff_truncated else "") + "\n```diff\n" + diff + "\n```\n"]
    if previous_findings:
        responses = {a["finding_id"]: a for a in impl_report["addressed_findings"]}
        lines = []
        for f in previous_findings:
            r = responses.get(f["id"])
            reply = f"{r['resolution']}: {r['notes']}" if r else "no response"
            lines.append(f"- `{f['id']}` [{f['severity']}] {f['file']} — {f['issue']}  \n  Implementer: {reply}")
        out.append("## Findings from the previous review and the implementer's responses\n"
                   + "\n".join(lines) + "\n\nVerify each one against the new revision. List ids that are now "
                   "resolved in `resolved_findings`; re-raise unresolved ones in `findings` with the same id. "
                   "Accept a dispute only if the justification is technically sound.\n")
    out.append(
        "## Your job\n"
        "Review the change against the plan and its acceptance criteria: correctness, edge cases, error "
        "handling, security, test adequacy, scope creep, and consistency with the codebase's conventions. "
        "The working tree currently equals the revision under review, so you may read files directly.\n\n"
        + SEVERITY_GUIDE + "\n\n"
        "Decision rules:\n"
        "- Approve (`approved: true`, `status: \"approved\"`) only if there is no critical or high finding, "
        "the acceptance criteria are met and the required quality gates pass.\n"
        f"- `reviewed_commit` must be exactly `{snapshot}`.\n"
        "- New finding ids continue the sequence `F1`, `F2`, ...; `file` is repo-relative (empty string if "
        "general) and `line` may be null.\n")
    return "\n".join(out)
