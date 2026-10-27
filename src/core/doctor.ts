import { existsSync } from "node:fs";
import { join } from "node:path";
import { runProcess } from "../agents/process.js";
import { resolveBinary } from "../agents/resolve.js";
import { loadSchema, SCHEMA_NAMES, strictProblems } from "../agents/schema.js";
import type { ConfigData } from "./config.js";
import { Git } from "./git.js";

export interface Check {
  ok: boolean;
  required: boolean;
  message: string;
}

const REQUIRED_FLAGS = {
  codex: { args: ["exec", "--help"], flags: ["--json", "--output-schema", "--sandbox", "--output-last-message", "--cd"] },
  claude: { args: ["--help"], flags: ["--output-format", "--verbose", "--json-schema", "--permission-mode", "--permission-prompts", "--tools", "--allowedTools", "--disallowedTools"] },
} as const;

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
export async function runDoctor(o: { repo: string; cfg: ConfigData; sources: string[]; configError?: string; env?: NodeJS.ProcessEnv }): Promise<Check[]> {
  const env = o.env ?? process.env;
  const checks: Check[] = [];
  const add = (ok: boolean, message: string, required = true) => checks.push({ ok, required, message });

  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  add(major > 22 || (major === 22 && minor >= 12), `node ${process.versions.node} (>= 22.12)`);
  const gitVersion = await probe("git", ["--version"], o.repo);
  add(gitVersion.ok, gitVersion.ok ? gitVersion.out.trim() : "git is not installed");
  const git = new Git(o.repo);
  const isRepo = await git.isRepo();
  add(isRepo, `git repository: ${o.repo}`);
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
    const version = await probe(bin, ["--version"], o.repo);
    add(version.ok, `${backend} CLI: ${bin} (${version.out.trim().split("\n")[0] || "?"})`);
    const spec = REQUIRED_FLAGS[backend];
    const help = await probe(bin, spec.args, o.repo);
    const missing = spec.flags.filter((f) => !help.out.includes(f));
    add(help.ok && !missing.length, `${backend} supports ${spec.flags.join(", ")}${missing.length ? ` — missing: ${missing.join(", ")}` : ""}`);
  }
  if (!o.cfg.gates.length) add(!o.cfg.quality_gates.require_tests_pass, "no quality gates configured (run 'duo init')");
  for (const gate of o.cfg.gates) {
    const exe = firstToken(gate.command);
    const found = !!exe && (resolveBinary(exe, "codex", env) !== null || existsSync(join(o.repo, exe)));
    add(found, `gate '${gate.name}': ${gate.command}${found ? "" : ` — '${exe}' not found`}`, false);
  }
  if (isRepo) {
    const dirty = await git.statusPorcelain([".agentduo"]);
    add(!dirty.length, `working tree clean${dirty.length ? ` (${dirty.length} uncommitted change(s))` : ""}`, false);
    add(await git.isIgnored(o.cfg.paths.runs_dir), `${o.cfg.paths.runs_dir}/ is git-ignored`, false);
  }
  return checks;
}
