"""Stand-in for the codex / claude CLIs in end-to-end tests.

Usage (via a wrapper script): fake_agent.py <codex|claude> <cli args...>
The prompt arrives on stdin; its "[orchestrator-role: X]" tag selects the
next scripted response for role X from the JSON file in $FAKE_SCENARIO.
A response may contain:
  output   object returned as the agent's final JSON
  raw      text returned instead of JSON (to simulate bad output)
  write    {path: content} files to create in the working directory
  delete   [paths] files to delete
  shell    [commands] shell commands to run (e.g. a forbidden git commit)
  exit     process exit code (default 0)
The last response of a role repeats when the script runs out.
"""
import json
import os
import re
import subprocess
import sys


def main() -> int:
    backend, args = sys.argv[1], sys.argv[2:]
    prompt = sys.stdin.read()
    role = re.search(r"\[orchestrator-role: (\w+)\]", prompt).group(1)
    with open(os.environ["FAKE_SCENARIO"], encoding="utf-8") as fh:
        scenario = json.load(fh)
    counts_path = os.environ["FAKE_COUNTS"]
    counts = json.load(open(counts_path)) if os.path.exists(counts_path) else {}
    n = counts.get(role, 0)
    counts[role] = n + 1
    with open(counts_path, "w") as fh:
        json.dump(counts, fh)
    responses = scenario[role]
    resp = responses[min(n, len(responses) - 1)]
    with open(os.environ["FAKE_LOG"], "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"backend": backend, "role": role, "call": n, "args": args,
                             "prompt": prompt}) + "\n")

    for path, content in (resp.get("write") or {}).items():
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(content)
    for path in resp.get("delete") or []:
        os.remove(path)
    for command in resp.get("shell") or []:
        subprocess.run(command, shell=True, check=False)

    if "raw" in resp:
        text = resp["raw"]
    else:
        output = json.loads(json.dumps(resp["output"]))
        if output.get("reviewed_commit") == "$SNAPSHOT":
            output["reviewed_commit"] = re.search(r"Revision under review: `([0-9a-f]{40})`", prompt).group(1)
        text = json.dumps(output)

    if backend == "codex":
        out_file = args[args.index("--output-last-message") + 1]
        with open(out_file, "w", encoding="utf-8") as fh:
            fh.write(text)
        print(text)
        print("tokens used\n1,234", file=sys.stderr)
    else:
        envelope = {"type": "result", "subtype": "success", "is_error": False, "result": text,
                    "total_cost_usd": 0.01, "session_id": "fake", "num_turns": 1,
                    "permission_denials": []}
        if "raw" not in resp:
            envelope["structured_output"] = json.loads(text)
        print(json.dumps(envelope))
    return int(resp.get("exit", 0))


if __name__ == "__main__":
    sys.exit(main())
