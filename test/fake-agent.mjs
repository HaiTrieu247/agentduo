// Stand-in for the codex / claude CLIs in tests: fake-agent.mjs <codex|claude> <cli args...>. A call logs `leaked`: the
// host variables (ELECTRON_RUN_AS_NODE, NODE_CHANNEL_FD…) that reached it, which none should.
// The prompt arrives on stdin; its "[orchestrator-role: X]" tag selects the next scripted response for
// role X from $FAKE_SCENARIO (the last response repeats). Every call is appended to $FAKE_LOG.
// A conversation prompt ("[agentduo-conversation]") is role "chat_<backend>" (else "chat"); its responses give an
// `answer` in prose, which comes back as is (default: a short answer naming the backend). A /discuss turn
// ("[agentduo-discussion: <step>, …]" on its second line) is role "discuss_<step>" (answer, critique, revise,
// synthesis); an unscripted critique agrees, and an unscripted synthesis is a chat answer.
// Claude in host mode (--permission-prompt-tool stdio) reads the prompt as a stream-json user message, asks
// for each scripted `permissions` entry with a control_request, and applies the answer the way Claude does.
// Claude with --input-format stream-json but no host reads that one message, then stdin must close. A message's
// content may be blocks: its text blocks are the prompt, and its image blocks are logged as `images` (media type,
// base64 length, and the sha256 of the bytes). Codex logs each --image=<path> the same way, from the file.
// `codex doctor --json` prints a report whose config.load model is the last `-c model=…` override, else
// scenario.doctor.model (null: none), after scenario.doctor.sleep ms; scenario.doctor.exit fails it.
// `codex debug models` prints scenario.catalog.models as Codex's model catalog; scenario.catalog.exit fails it.
// `claude -p /usage` prints scenario.usage.claude.text (default: a short /usage); its exit and stderr fail it.
// `claude auth status` prints scenario.usage.claude.auth as JSON (default: signed in to claude.ai with Max), exiting 1
// when it is signed out as Claude does; scenario.usage.claude.authExit fails it with no JSON.
// `codex login status` says it is logged in (scenario.usage.codex.loggedOut: it is not), as the desktop's first-run check asks.
// `codex app-server` answers initialize, account/read (scenario.usage.codex.account) and account/rateLimits/read
// (.rateLimits, or the error .rateLimitsError) until stdin closes; .hang never answers, .exit and .stderr fail it.
// A response's `pid` names a file (relative to the working directory) the agent writes its process id to, the process
// a stop must end: on Windows the agent runs under the cmd.exe of its .cmd shim, so only the tree kill reaches it.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const HELP = {
  codex: "Usage: codex exec [OPTIONS] --json --output-schema --sandbox --output-last-message --cd --skip-git-repo-check",
  claude: "Usage: claude [options] --output-format --input-format --verbose --json-schema --permission-mode --permission-prompts --permission-prompt-tool --tools --allowedTools --disallowedTools",
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
  if (backend === "codex" && args[0] === "doctor") return doctor(args);
  if (backend === "codex" && args[0] === "debug" && args[1] === "models") return catalog(args);
  if (backend === "claude" && args[0] === "-p" && args[1] === "/usage") return claudeUsage(args);
  if (backend === "claude" && args[0] === "auth" && args[1] === "status") return claudeAuth(args);
  if (backend === "codex" && args[0] === "app-server") return appServer(args);
  if (backend === "codex" && args[0] === "login" && args[1] === "status") return codexLogin(args);
  const host = args.includes("--permission-prompt-tool");
  const streamed = backend === "claude" && args.includes("--input-format");
  const stdin = streamed ? createInterface({ input: process.stdin })[Symbol.asyncIterator]() : null;
  const content = streamed ? JSON.parse((await stdin.next()).value).message.content : readFileSync(0, "utf8");
  const blocks = Array.isArray(content) ? content : [{ type: "text", text: content }];
  const prompt = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const sha = (buf) => createHash("sha256").update(buf).digest("hex");
  const images = backend === "claude"
    ? blocks.filter((b) => b.type === "image").map((b) => ({ mediaType: b.source.media_type, base64: b.source.data.length, sha256: sha(Buffer.from(b.source.data, "base64")) }))
    : args.filter((a) => a.startsWith("--image=")).map((a) => {
      const file = a.slice("--image=".length);
      return existsSync(file) ? { file, sha256: sha(readFileSync(file)) } : { file, missing: true };
    });
  // Without a host, stdin closes once the message is in, as real Claude expects (it would wait for more otherwise).
  if (streamed && !host) {
    const closed = await Promise.race([stdin.next().then((r) => r.done), new Promise((r) => setTimeout(() => r(false), 3000).unref())]);
    if (!closed) {
      process.stderr.write("fake-agent: stdin stayed open after the stream-json message\n");
      return 8;
    }
  }
  const chat = prompt.startsWith("[agentduo-conversation]");
  const step = chat ? /^\[agentduo-discussion: (\w+)/m.exec(prompt)?.[1] : undefined;
  const role = step ? `discuss_${step}` : chat ? `chat_${backend}` : /\[orchestrator-role: (\w+)\]/.exec(prompt)?.[1] ?? "unknown";
  const scenario = JSON.parse(readFileSync(process.env.FAKE_SCENARIO, "utf8"));
  const counts = existsSync(process.env.FAKE_COUNTS) ? JSON.parse(readFileSync(process.env.FAKE_COUNTS, "utf8")) : {};
  const n = counts[role] ?? 0;
  counts[role] = n + 1;
  // Whole or not at all: a stop may kill the agent here, and an emptied file would fail every later call.
  writeFileSync(`${process.env.FAKE_COUNTS}.${process.pid}.tmp`, JSON.stringify(counts));
  renameSync(`${process.env.FAKE_COUNTS}.${process.pid}.tmp`, process.env.FAKE_COUNTS);
  const unscripted = step === "critique" ? [{ answer: "Looks right.\nVERDICT: AGREE" }] : chat ? scenario.chat ?? [{ answer: `Answer from ${backend}.` }] : [{ raw: `no scripted response for role ${role}` }];
  const responses = scenario[role] ?? unscripted;
  const resp = responses[Math.min(n, responses.length - 1)];
  // What a host must keep to itself (Electron run as Node, its IPC channel): logged when it reached the agent.
  const leaked = ["ELECTRON_RUN_AS_NODE", "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE"].filter((k) => process.env[k] !== undefined);
  appendFileSync(process.env.FAKE_LOG, JSON.stringify({ backend, role, call: n, args, prompt, ...(images.length ? { images } : {}), ...(leaked.length ? { leaked } : {}) }) + "\n");

  const writeFiles = (files) => {
    for (const [path, content] of Object.entries(files ?? {})) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
  };
  writeFiles(resp.write);
  const denials = [...(resp.denials ?? [])];
  for (const [i, ask] of (host ? resp.permissions ?? [] : []).entries()) {
    const toolUseId = `perm-tool-${i}`;
    const suggestions = [{ type: "addRules", rules: ask.rules ?? [], behavior: "allow", destination: "localSettings" }, { type: "setMode", mode: "acceptEdits", destination: "session" }];
    process.stdout.write(JSON.stringify({ type: "control_request", request_id: `perm-${i}`, request: {
      subtype: "can_use_tool", tool_name: ask.tool, display_name: ask.tool, input: ask.input, description: ask.description ?? null, permission_suggestions: suggestions, tool_use_id: toolUseId,
    } }) + "\n");
    const reply = JSON.parse((await stdin.next()).value).response.response;
    appendFileSync(process.env.FAKE_LOG, JSON.stringify({ backend, role, permission: reply }) + "\n");
    if (reply.behavior !== "allow") {
      denials.push({ tool_name: ask.tool, tool_use_id: toolUseId, tool_input: ask.input });
      continue;
    }
    writeFiles(ask.write);
    const rules = (reply.updatedPermissions ?? []).filter((u) => u.type === "addRules" && u.destination === "localSettings")
      .flatMap((u) => u.rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)));
    if (rules.length) writeFiles({ ".claude/settings.local.json": JSON.stringify({ permissions: { allow: rules } }, null, 2) });
    if ((reply.updatedPermissions ?? []).some((u) => u.type === "setMode")) writeFiles({ "fake-mode-changed.txt": "the session mode was changed\n" });
  }
  for (const path of resp.delete ?? []) rmSync(path);
  if (resp.pid) {
    // Whole once it exists: a test waits for the file, then reads it.
    writeFileSync(`${resp.pid}.tmp`, String(process.pid));
    renameSync(`${resp.pid}.tmp`, resp.pid);
  }
  for (const command of resp.shell ?? []) {
    try {
      execSync(command, { stdio: "ignore" });
    } catch {
      // scripted commands may fail on purpose
    }
  }
  let text;
  const prose = "raw" in resp || "answer" in resp;
  if ("answer" in resp) {
    text = resp.answer;
  } else if ("raw" in resp) {
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
    const model = args.includes("--model") ? args[args.lastIndexOf("--model") + 1] : resp.model ?? "claude-fake-default";
    emit({ type: "system", subtype: "init", session_id: "fake", model });
    const usage = { input_tokens: 10, output_tokens: 5 };
    activities.forEach((a, i) => {
      emit({ type: "assistant", uuid: `u${i}`, message: { id: "m", usage, content: [{ type: "tool_use", id: `t${i}`, name: a.tool, input: a.input ?? {} }] } });
      emit({ type: "user", uuid: `r${i}`, message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, content: a.result ?? "ok", is_error: a.error ?? false }] } });
    });
    await sleep();
    if ("answer" in resp && text) emit({ type: "assistant", uuid: "final", message: { id: "m-final", usage, content: [{ type: "text", text }] } });
    const envelope = { type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0.01, session_id: "fake", num_turns: 1, permission_denials: denials };
    if (!prose) envelope.structured_output = JSON.parse(text);
    emit(envelope);
    // Real Claude keeps reading stdin in host mode until the host closes it.
    if (host) {
      const closed = await Promise.race([stdin.next().then((r) => r.done), new Promise((r) => setTimeout(() => r(false), 3000).unref())]);
      if (!closed) {
        process.stderr.write("fake-agent: stdin was never closed after the result\n");
        return 9;
      }
    }
  }
  return resp.exit ?? 0;
}

/** `codex doctor --json [-c key=value…]`: a report shaped like codex 0.164's (see fixtures/codex-doctor.json). */
async function doctor(args) {
  const scenario = existsSync(process.env.FAKE_SCENARIO ?? "") ? JSON.parse(readFileSync(process.env.FAKE_SCENARIO, "utf8")) : {};
  const d = scenario.doctor ?? {};
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ backend: "codex", doctor: true, args }) + "\n");
  if (d.sleep) await new Promise((r) => setTimeout(r, d.sleep));
  if (d.exit) {
    process.stderr.write("doctor failed\n");
    return d.exit;
  }
  const overrides = args.flatMap((a, i) => ((a === "-c" || a === "--config") && args[i + 1]?.startsWith("model=") ? [args[i + 1].slice(6).replace(/^"|"$/g, "")] : []));
  const model = overrides.at(-1) ?? ("model" in d ? d.model : "gpt-fake-default");
  const details = { "config.toml parse": "ok", "model provider": "openai", ...(model ? { model } : {}) };
  process.stdout.write(JSON.stringify({ schemaVersion: 1, overallStatus: "ok", checks: { "config.load": { id: "config.load", status: "ok", summary: "config loaded", details } } }, null, 2) + "\n");
  return 0;
}

/** `codex debug models [-c key=value…]`: scenario.catalog as Codex's catalog (see fixtures/codex-models.json); its exit fails it. */
function catalog(args) {
  const scenario = existsSync(process.env.FAKE_SCENARIO ?? "") ? JSON.parse(readFileSync(process.env.FAKE_SCENARIO, "utf8")) : {};
  const c = scenario.catalog ?? { models: [{ slug: "gpt-fake-default", display_name: "GPT Fake", description: "the fake's model", priority: 1 }] };
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ backend: "codex", catalog: true, args }) + "\n");
  if (c.exit) {
    process.stderr.write("catalog failed\n");
    return c.exit;
  }
  process.stdout.write(JSON.stringify({ models: c.models }) + "\n");
  return 0;
}

const usageScenario = (backend) => (existsSync(process.env.FAKE_SCENARIO ?? "") ? JSON.parse(readFileSync(process.env.FAKE_SCENARIO, "utf8")).usage?.[backend] : null) ?? {};

/** `claude -p /usage`: Claude Code's /usage as text (see fixtures/claude-usage.txt), with no model call. */
async function claudeUsage(args) {
  const u = usageScenario("claude");
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ backend: "claude", usage: true, args }) + "\n");
  if (u.sleep) await new Promise((r) => setTimeout(r, u.sleep));
  if (u.exit) {
    process.stderr.write(`${u.stderr ?? "usage failed"}\n`);
    return u.exit;
  }
  process.stdout.write(u.text ?? "You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 10% used · resets Oct 29 at 3pm (UTC)\n");
  return 0;
}

/** `claude auth status`: the account Claude Code signs in with, as JSON (Claude Code 2.1.31x), with no model call. */
function claudeAuth(args) {
  const u = usageScenario("claude");
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ backend: "claude", usage: true, args }) + "\n");
  if (u.authExit) {
    process.stderr.write("error: unknown command 'auth'\n");
    return u.authExit;
  }
  const status = u.auth ?? { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "fake@anthropic.example", orgId: "org", orgName: "Org", subscriptionType: "max" };
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  return status.loggedIn === false ? 1 : 0;
}

/** `codex login status`: what codex 0.164 prints (on stderr), with no model call. */
function codexLogin(args) {
  const u = usageScenario("codex");
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ backend: "codex", usage: true, args }) + "\n");
  process.stderr.write(u.loggedOut ? "Not logged in\n" : "Logged in using ChatGPT\n");
  return u.loggedOut ? 1 : 0;
}

/** `codex app-server`: JSON-RPC lines on stdin and stdout, as codex 0.164 speaks it (see fixtures/codex-account.json). */
async function appServer(args) {
  const u = usageScenario("codex");
  if (u.exit) {
    process.stderr.write(`${u.stderr ?? "app-server failed"}\n`);
    return u.exit;
  }
  const account = u.account ?? { account: { type: "chatgpt", email: "fake@example.com", planType: "plus" }, requiresOpenaiAuth: true };
  const window = (usedPercent, windowDurationMins) => ({ usedPercent, windowDurationMins, resetsAt: null });
  const rateLimits = u.rateLimits ?? {
    ordinaryUsageAllowed: true, rateLimitsByLimitId: null,
    rateLimits: { limitId: "codex", limitName: null, primary: window(5, 300), secondary: window(20, 10080), credits: null, planType: "plus", rateLimitReachedType: null },
  };
  const methods = [];
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  for await (const line of createInterface({ input: process.stdin })) {
    const m = JSON.parse(line);
    methods.push(m.method);
    if (u.hang || m.id === undefined) continue;
    if (m.method === "initialize") send({ id: m.id, result: { userAgent: "codex-fake" } });
    else if (m.method === "account/read") send({ id: m.id, result: account });
    else if (m.method === "account/rateLimits/read") send(u.rateLimitsError ? { id: m.id, error: { code: -32600, message: u.rateLimitsError } } : { id: m.id, result: rateLimits });
    else send({ id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } });
  }
  // The real app server exits as soon as its stdin closes.
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ backend: "codex", usage: true, args, methods }) + "\n");
  return 0;
}

process.exitCode = await main();
