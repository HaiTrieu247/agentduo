// The first-task tutorial's project, shared by both languages and by the test that runs it: the files come from
// website/examples/first-task, and the shell script that creates them is generated from those same files.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const examples = fileURLToPath(new URL("../examples/", import.meta.url));
export const FIRST_TASK_FILES = ["package.json", "src/duration.js", "test/duration.test.js"];
export const FIRST_TASK_DIR = "duo-first-task";

export const firstTaskFile = (variant, rel) => readFileSync(join(examples, "first-task", variant, rel), "utf8");
export const firstTaskConfig = () => readFileSync(join(examples, "config", "first-task.yaml"), "utf8");

/** A POSIX shell script (macOS, Linux, Git Bash, WSL) that creates the starting project in ./duo-first-task. */
export function firstTaskScript() {
  const lines = [`mkdir -p ${FIRST_TASK_DIR}/src ${FIRST_TASK_DIR}/test ${FIRST_TASK_DIR}/.agentduo`, `cd ${FIRST_TASK_DIR}`];
  for (const rel of FIRST_TASK_FILES) lines.push(`cat > ${rel} <<'EOF'`, firstTaskFile("initial", rel).replace(/\n$/, ""), "EOF");
  lines.push("cat > .agentduo/config.yaml <<'EOF'", firstTaskConfig().replace(/\n$/, ""), "EOF");
  return lines.join("\n");
}

/** The task given to the pipeline, word for word, in each language. */
export const FIRST_TASK_PROMPT = {
  en: "Fix formatDuration in src/duration.js: for an hour or more it shows the wrong minutes (3725 seconds gives 1h 62m 05s instead of 1h 02m 05s). Keep the output format, and make npm test pass.",
  vi: "Sửa formatDuration trong src/duration.js: từ một giờ trở lên, số phút bị sai (3725 giây ra 1h 62m 05s thay vì 1h 02m 05s). Giữ nguyên định dạng đầu ra và làm cho npm test chạy đạt.",
};
