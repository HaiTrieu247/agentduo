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
  gitignoreUpdated: boolean;
  gates: DetectedGate[];
}

const read = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);

function packageManager(repo: string): "npm" | "pnpm" | "yarn" | "bun" {
  if (existsSync(join(repo, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repo, "yarn.lock"))) return "yarn";
  if (existsSync(join(repo, "bun.lockb")) || existsSync(join(repo, "bun.lock"))) return "bun";
  return "npm";
}

export function detectGates(repo: string): DetectedGate[] {
  const gates: DetectedGate[] = [];
  const pkg = read(join(repo, "package.json"));
  if (pkg) {
    let scripts: Record<string, unknown> = {};
    try {
      scripts = JSON.parse(pkg).scripts ?? {};
    } catch {
      // unreadable package.json: no script gates
    }
    const pm = packageManager(repo);
    const wanted: Array<[string, string[]]> = [["test", ["test"]], ["lint", ["lint"]], ["typecheck", ["typecheck", "type-check"]]];
    for (const [name, candidates] of wanted) {
      const script = candidates.find((c) => typeof scripts[c] === "string");
      if (!script) continue;
      if (script === "test" && /no test specified/.test(String(scripts.test))) continue;
      gates.push({ name, command: `${pm} run ${script}`, reason: `package.json script "${script}"` });
    }
  }
  if (existsSync(join(repo, "pyproject.toml")) || existsSync(join(repo, "pytest.ini")) || (read(join(repo, "setup.cfg"))?.includes("[tool:pytest]") ?? false)) {
    gates.push({ name: "pytest", command: "python3 -m pytest", reason: "Python project (pyproject.toml / pytest.ini / setup.cfg)" });
  }
  if (existsSync(join(repo, "go.mod"))) gates.push({ name: "go-test", command: "go test ./...", reason: "go.mod" });
  if (existsSync(join(repo, "Cargo.toml"))) gates.push({ name: "cargo-test", command: "cargo test", reason: "Cargo.toml" });
  const makefile = read(join(repo, "Makefile"));
  if (makefile && /^test\s*:/m.test(makefile)) gates.push({ name: "make-test", command: "make test", reason: "Makefile target 'test'" });
  return gates;
}

export function renderConfigYaml(gates: DetectedGate[]): string {
  const lines = [
    "# agentduo configuration for this repository.",
    "# Every key is optional; anything not set here uses the built-in defaults (run `duo doctor` to check).",
    "",
    "# Quality gates: commands agentduo runs itself after every implementation round.",
  ];
  if (gates.length) {
    lines.push("gates:");
    for (const g of gates) lines.push(`  - name: ${g.name}`, `    command: ${JSON.stringify(g.command)}   # detected: ${g.reason}`, "    required: true");
  } else {
    lines.push(
      "# None were detected. Add your test/lint/typecheck commands, for example:",
      "#   - name: tests",
      '#     command: "npm test"',
      "#     required: true",
      "gates: []",
    );
  }
  lines.push("", "# limits:", "#   max_planning_rounds: 4", "#   max_review_rounds: 5", "# safety:", "#   pause_before_implement: false",
    "# codex:", "#   model: null", "# claude:", "#   model: null", "#   max_budget_usd: null", "");
  return lines.join("\n");
}

const IGNORE_LINES = [".agentduo/runs/", ".agentduo/runs", "/.agentduo/runs/", ".agentduo/", ".agentduo", "/.agentduo/"];

export function initRepo(repo: string): InitResult {
  const configPath = join(repo, ".agentduo", "config.yaml");
  const gates = detectGates(repo);
  let created = false;
  if (!existsSync(configPath)) {
    mkdirSync(join(repo, ".agentduo"), { recursive: true });
    writeFileSync(configPath, renderConfigYaml(gates));
    created = true;
  }
  const gitignore = join(repo, ".gitignore");
  const current = read(gitignore) ?? "";
  let gitignoreUpdated = false;
  if (!current.split(/\r?\n/).some((line) => IGNORE_LINES.includes(line.trim()))) {
    writeFileSync(gitignore, `${current}${current && !current.endsWith("\n") ? "\n" : ""}.agentduo/runs/\n`);
    gitignoreUpdated = true;
  }
  return { configPath, created, gitignoreUpdated, gates };
}
