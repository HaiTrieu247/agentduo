import { existsSync } from "node:fs";
import { isAbsolute, join, posix, relative } from "node:path";
import { runProcess } from "../agents/process.js";
import { resolveBinary } from "../agents/resolve.js";
import { loadSchema, SCHEMA_NAMES, strictProblems } from "../agents/schema.js";
import { isHomeFolder } from "../paths.js";
import type { ConfigData } from "./config.js";
import { Git } from "./git.js";

export interface Check {
  ok: boolean;
  required: boolean;
  message: string;
}

/** Flags agentduo itself needs (the protocol); permissions are the CLIs' own business. */
const PROTOCOL_FLAGS = {
  codex: { args: ["exec", "--help"], flags: ["--json", "--output-schema", "--output-last-message", "--cd", "--skip-git-repo-check"] },
  claude: { args: ["--help"], flags: ["--output-format", "--verbose", "--json-schema", "--permission-prompts"] },
} as const;
/** Relaying permission prompts (claude.permission_prompts: ask) needs Claude's host protocol. */
const CLAUDE_HOST_FLAGS = ["--input-format", "--permission-prompt-tool"];
const EDIT_PERMISSION_FLAGS = ["--permission-mode", "--allowedTools", "--allowed-tools", "--dangerously-skip-permissions"];
const CODEX_WRITE_FLAGS = ["--sandbox", "-s", "--full-auto", "--dangerously-bypass-approvals-and-sandbox"];
/** "--permission-mode=acceptEdits" counts like "--permission-mode acceptEdits". */
const flagName = (arg: string) => arg.split("=")[0]!;

async function probe(bin: string, args: readonly string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await runProcess(bin, [...args], { cwd, timeoutMs: 60_000 });
    return { ok: r.code === 0, out: r.stdout + r.stderr };
  } catch (e) {
    return { ok: false, out: (e as Error).message };
  }
}

function firstToken(command: string): string {
  const m = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
}

/** Environment checks for `duo doctor`. Never calls a model. */
export async function runDoctor(o: { dir: string; cfg: ConfigData; sources: string[]; configError?: string; env?: NodeJS.ProcessEnv; runsDir: string }): Promise<Check[]> {
  const env = o.env ?? process.env;
  const checks: Check[] = [];
  const add = (ok: boolean, message: string, required = true) => checks.push({ ok, required, message });

  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  add(major > 22 || (major === 22 && minor >= 12), `node ${process.versions.node} (>= 22.12)`);
  const gitVersion = await probe("git", ["--version"], o.dir);
  add(gitVersion.ok, gitVersion.ok ? gitVersion.out.trim() : "git is not installed");
  const git = new Git(o.dir);
  const isRepo = await git.isRepo();
  add(isRepo, isRepo ? `workspace inside a git repository: ${o.dir}`
    : isHomeFolder(o.dir, env) ? `workspace is your home folder, not a git repository: ${o.dir} (the chat and /discuss work; a pipeline run needs a project folder inside one)`
      : `workspace not inside a git repository: ${o.dir} (the chat and /discuss work; a pipeline run needs 'git init' first)`, false);
  add(!o.configError, o.configError ? `config: ${o.configError}` : `config: ${o.sources.length ? o.sources.join(", ") : "built-in defaults"}`);
  for (const name of SCHEMA_NAMES) {
    const problems = strictProblems(loadSchema(name));
    add(!problems.length, `schema ${name}${problems.length ? `: ${problems.join("; ")}` : ""}`);
  }
  for (const backend of ["codex", "claude"] as const) {
    if (!Object.values(o.cfg.agents).includes(backend)) continue;
    const bin = resolveBinary(o.cfg[backend].bin, backend, env);
    if (!bin) {
      add(false, `${backend} CLI not found (bin: '${o.cfg[backend].bin}')`);
      continue;
    }
    const version = await probe(bin, ["--version"], o.dir);
    add(version.ok, `${backend} CLI: ${bin} (${version.out.trim().split("\n")[0] || "?"})`);
    const spec = PROTOCOL_FLAGS[backend];
    const flags = [...spec.flags, ...(backend === "claude" && o.cfg.claude.permission_prompts === "ask" ? CLAUDE_HOST_FLAGS : [])];
    const help = await probe(bin, spec.args, o.dir);
    const missing = flags.filter((f) => !help.out.includes(f));
    add(help.ok && !missing.length, `${backend} supports ${flags.join(", ")}${missing.length ? ` — missing: ${missing.join(", ")}` : ""}`);
  }
  if (o.cfg.agents.implementer === "claude") {
    const args = [...o.cfg.claude.args, ...(o.cfg.claude.role_args.implementer ?? [])];
    if (!args.some((a) => EDIT_PERMISSION_FLAGS.includes(flagName(a)))) {
      add(false, o.cfg.claude.permission_prompts === "ask"
        ? "Claude asks you in the terminal before a tool call its settings do not allow; without a terminal (CI, background, piped output) " +
          'such calls are denied, so allow them in your Claude Code settings (e.g. permissions.defaultMode "acceptEdits") for unattended runs'
        : 'implementer edits rely on your Claude Code permission settings (e.g. permissions.defaultMode "acceptEdits"); ' +
          "without them every edit is denied in non-interactive mode", false);
    }
  } else {
    const args = [...o.cfg.codex.args, ...(o.cfg.codex.role_args.implementer ?? [])];
    if (!args.some((a, i) => CODEX_WRITE_FLAGS.includes(flagName(a)) || (a === "-c" && /^sandbox_mode\s*=/.test(args[i + 1] ?? "")))) {
      add(false, "implementer edits rely on your Codex sandbox settings (sandbox_mode in ~/.codex/config.toml, or " +
        "codex.role_args.implementer: [--sandbox, workspace-write]); codex exec is read-only unless configured otherwise", false);
    }
  }
  for (const gate of o.cfg.gates) {
    const exe = firstToken(gate.command);
    const found = !!exe && (resolveBinary(exe, "codex", env) !== null || existsSync(join(o.dir, exe)));
    add(found, `gate '${gate.name}': ${gate.command}${found ? "" : ` — '${exe}' not found`}`, false);
  }
  if (isRepo) {
    // Run data anywhere in the repository would show up in `git status` and in the outside-workspace warnings.
    // Resolved through the workspace prefix rather than the toplevel, which git reports with symlinks resolved.
    const shown = relative(o.dir, o.runsDir).split("\\").join("/");
    const inRepo = posix.normalize(posix.join(await git.prefix(), shown));
    if (shown && !isAbsolute(shown) && inRepo !== "." && !inRepo.startsWith("..")) {
      add(true, (await git.isIgnored(shown)) ? `${shown}/ is git-ignored` : `${shown}/ gets its own .gitignore on the first run`, false);
    }
  }
  return checks;
}
