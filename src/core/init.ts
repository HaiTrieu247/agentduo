import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DetectedGate {
  name: string;
  command: string;
  reason: string;
}

export interface InitResult {
  configPath: string;
  created: boolean;
  /** True when .agentduo/.gitignore was written (it ignores runs/ without touching the root .gitignore). */
  ignoreCreated: boolean;
  gates: DetectedGate[];
}

const read = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);

function packageManager(dir: string): "npm" | "pnpm" | "yarn" | "bun" {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
  return "npm";
}

export function detectGates(dir: string): DetectedGate[] {
  const gates: DetectedGate[] = [];
  const pkg = read(join(dir, "package.json"));
  if (pkg) {
    let scripts: Record<string, unknown> = {};
    try {
      scripts = JSON.parse(pkg).scripts ?? {};
    } catch {
      // unreadable package.json: no script gates
    }
    const pm = packageManager(dir);
    const wanted: Array<[string, string[]]> = [["test", ["test"]], ["lint", ["lint"]], ["typecheck", ["typecheck", "type-check"]]];
    for (const [name, candidates] of wanted) {
      const script = candidates.find((c) => typeof scripts[c] === "string");
      if (!script) continue;
      if (script === "test" && /no test specified/.test(String(scripts.test))) continue;
      gates.push({ name, command: `${pm} run ${script}`, reason: `package.json script "${script}"` });
    }
  }
  if (existsSync(join(dir, "pyproject.toml")) || existsSync(join(dir, "pytest.ini")) || (read(join(dir, "setup.cfg"))?.includes("[tool:pytest]") ?? false)) {
    gates.push({ name: "pytest", command: "python3 -m pytest", reason: "Python project (pyproject.toml / pytest.ini / setup.cfg)" });
  }
  if (existsSync(join(dir, "go.mod"))) gates.push({ name: "go-test", command: "go test ./...", reason: "go.mod" });
  if (existsSync(join(dir, "Cargo.toml"))) gates.push({ name: "cargo-test", command: "cargo test", reason: "Cargo.toml" });
  const makefile = read(join(dir, "Makefile"));
  if (makefile && /^test\s*:/m.test(makefile)) gates.push({ name: "make-test", command: "make test", reason: "Makefile target 'test'" });
  return gates;
}

/** Everything is commented out: agentduo's defaults apply until the user opts in. */
export function renderConfigYaml(gates: DetectedGate[]): string {
  const lines = [
    "# agentduo configuration for this workspace. Every key is optional (run `duo doctor` to check the setup).",
    "# Permissions are not set here: Codex and Claude Code use their own configuration.",
    "",
    "# Quality gates (optional): commands agentduo runs after every implementation round and shows to the code reviewer.",
  ];
  if (gates.length) {
    lines.push("# Detected for this project; uncomment to have agentduo run them after every implementation round:", "# gates:");
    for (const g of gates) lines.push(`#   - name: ${g.name}`, `#     command: ${JSON.stringify(g.command)}   # ${g.reason}`, "#     required: true");
  } else {
    lines.push("# gates:", "#   - name: tests", '#     command: "npm test"', "#     required: true");
  }
  lines.push(
    "",
    "# Extra CLI arguments, for every call or per role (planner, plan_reviewer, implementer, code_reviewer):",
    "# claude:",
    "#   role_args:",
    "#     implementer: [--permission-mode, acceptEdits]",
    "# codex:",
    "#   args: [--ephemeral]",
    "",
    "# limits:",
    "#   max_planning_rounds: 4",
    "#   max_review_rounds: 5",
    "#   agent_idle_timeout_sec: 900",
    "",
  );
  return lines.join("\n");
}

export function initRepo(dir: string): InitResult {
  const configPath = join(dir, ".agentduo", "config.yaml");
  const gates = detectGates(dir);
  let created = false;
  if (!existsSync(configPath)) {
    mkdirSync(join(dir, ".agentduo"), { recursive: true });
    writeFileSync(configPath, renderConfigYaml(gates));
    created = true;
  }
  const ignoreFile = join(dir, ".agentduo", ".gitignore");
  let ignoreCreated = false;
  if (!existsSync(ignoreFile)) {
    mkdirSync(join(dir, ".agentduo"), { recursive: true });
    writeFileSync(ignoreFile, "runs/\n");
    ignoreCreated = true;
  }
  return { configPath, created, ignoreCreated, gates };
}
