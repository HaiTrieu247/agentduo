// Stand-in for the codex / claude CLIs in tests: fake-agent.mjs <codex|claude> <cli args...>.
// The prompt arrives on stdin; its "[orchestrator-role: X]" tag selects the next scripted response for
// role X from $FAKE_SCENARIO (the last response repeats). Every call is appended to $FAKE_LOG.
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const HELP = {
  codex: "Usage: codex exec [OPTIONS] --json --output-schema --sandbox --output-last-message --cd",
  claude: "Usage: claude [options] --output-format --verbose --json-schema --permission-mode --permission-prompts --tools --allowedTools --disallowedTools",
};

async function main() {
  const [backend, ...args] = process.argv.slice(2);
  if (args.includes("--version")) {
    process.stdout.write(`${backend}-fake 1.0.0\n`);
    return 0;
  }
  if (args.includes("--help")) {
    process.stdout.write(`${HELP[backend]}\n`);
    return 0;
  }
  const prompt = readFileSync(0, "utf8");
  const role = /\[orchestrator-role: (\w+)\]/.exec(prompt)?.[1] ?? "unknown";
  const scenario = JSON.parse(readFileSync(process.env.FAKE_SCENARIO, "utf8"));
  const counts = existsSync(process.env.FAKE_COUNTS) ? JSON.parse(readFileSync(process.env.FAKE_COUNTS, "utf8")) : {};
  const n = counts[role] ?? 0;
  counts[role] = n + 1;
  writeFileSync(process.env.FAKE_COUNTS, JSON.stringify(counts));
  const responses = scenario[role] ?? [{ raw: `no scripted response for role ${role}` }];
  const resp = responses[Math.min(n, responses.length - 1)];
  appendFileSync(process.env.FAKE_LOG, JSON.stringify({ backend, role, call: n, args, prompt }) + "\n");

  for (const [path, content] of Object.entries(resp.write ?? {})) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  for (const path of resp.delete ?? []) rmSync(path);
  for (const command of resp.shell ?? []) {
    try {
      execSync(command, { stdio: "ignore" });
    } catch {
      // scripted commands may fail on purpose
    }
  }
  let text;
  if ("raw" in resp) {
    text = resp.raw;
  } else {
    const output = structuredClone(resp.output);
    if (output.reviewed_commit === "$SNAPSHOT") output.reviewed_commit = /Revision under review: `([0-9a-f]{40})`/.exec(prompt)[1];
    text = JSON.stringify(output);
  }
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  const activities = resp.activities ?? [];
  const sleep = () => (resp.sleep ? new Promise((r) => setTimeout(r, resp.sleep)) : Promise.resolve());
  if (backend === "codex") {
    emit({ type: "thread.started", thread_id: "fake" });
    emit({ type: "turn.started" });
    activities.forEach((a, i) => {
      const item = { id: `item_${i}`, type: "command_execution", command: `/bin/zsh -lc '${a.command}'`, aggregated_output: "", exit_code: null, status: "in_progress" };
      emit({ type: "item.started", item });
      emit({ type: "item.completed", item: { ...item, exit_code: a.exit ?? 0, status: "completed" } });
    });
    await sleep();
    emit({ type: "item.completed", item: { id: "item_final", type: "agent_message", text } });
    emit({ type: "turn.completed", usage: { input_tokens: 1000, output_tokens: 234 } });
    if (!resp.noLastMessage) writeFileSync(args[args.indexOf("--output-last-message") + 1], text);
  } else {
    emit({ type: "system", subtype: "init", session_id: "fake" });
    const usage = { input_tokens: 10, output_tokens: 5 };
    activities.forEach((a, i) => {
      emit({ type: "assistant", uuid: `u${i}`, message: { id: "m", usage, content: [{ type: "tool_use", id: `t${i}`, name: a.tool, input: a.input ?? {} }] } });
      emit({ type: "user", uuid: `r${i}`, message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, content: a.result ?? "ok", is_error: a.error ?? false }] } });
    });
    await sleep();
    const envelope = { type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0.01, session_id: "fake", num_turns: 1, permission_denials: resp.denials ?? [] };
    if (!("raw" in resp)) envelope.structured_output = JSON.parse(text);
    emit(envelope);
  }
  return resp.exit ?? 0;
}

process.exitCode = await main();
