// Code block highlighting (lib/highlight.mjs): which tokens get a class, and that highlighting never changes the text.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { highlight } from "../lib/highlight.mjs";
import { esc } from "../lib/render.mjs";
import { build } from "../scripts/build.mjs";

const plain = (html) => html.replace(/<\/?span[^>]*>/g, "");
/** The tokens of one kind, in order. */
const tokens = (html, kind) => [...html.matchAll(new RegExp(`<span class="tk-${kind}">([^<]*)</span>`, "g"))].map((m) => m[1]);

test("shell: the command of each line, its flags, strings, variables and comments", () => {
  const html = highlight(`npm i -g agentduo\nduo resume --decision revise --note "Keep the old endpoint"\necho "exit code: $?" # print it\ngit diff | less`, "sh");
  assert.deepEqual(tokens(html, "cmd"), ["npm", "duo", "echo", "git", "less"]);
  assert.deepEqual(tokens(html, "flag"), ["-g", "--decision", "--note"]);
  assert.deepEqual(tokens(html, "str"), ["&quot;Keep the old endpoint&quot;", "&quot;exit code: $?&quot;"]);
  assert.deepEqual(tokens(html, "com"), ["# print it"]);
});

test("shell: case patterns, keywords and sudo come before the command they run", () => {
  const html = highlight(`case $? in\n  2) duo status ;;          # waiting\nesac\nsudo apt install ./app.deb`, "sh");
  assert.deepEqual(tokens(html, "kw"), ["case", "in", "esac"]);
  assert.deepEqual(tokens(html, "var"), ["$?"]);
  assert.deepEqual(tokens(html, "cmd"), ["duo", "sudo", "apt"]);
});

test("shell: a here-document's body stays plain until its terminator", () => {
  const html = highlight(`cat > src/a.js <<'EOF'\nconst a = "b"; // c\nEOF\nnpm test`, "sh");
  assert.equal(html.split("\n")[1], esc(`const a = "b"; // c`));
  assert.deepEqual(tokens(html, "cmd"), ["cat", "npm"]);
});

test("chat: the duo command, slash commands and their flags; narration is a comment; other lines stay plain", () => {
  const html = highlight(`duo\n› /claude model opus --save\n  … Claude Code answers …\n/attach "it's.png"\n● PLAN r1  Codex (planner)`, "");
  assert.deepEqual(tokens(html, "cmd"), ["duo", "/claude", "/attach"]);
  assert.deepEqual(tokens(html, "flag"), ["--save"]);
  assert.deepEqual(tokens(html, "punct"), ["› "]);
  assert.deepEqual(tokens(html, "com"), ["  … Claude Code answers …"]);
  assert.equal(html.split("\n")[4], esc("● PLAN r1  Codex (planner)"));
});

test("YAML: keys, comments, strings and literals", () => {
  const html = highlight(`# gates\ngates:\n  - name: tests\n    command: "npm test"   # runs after each round\n    required: true\nargs: [--ephemeral]`, "yaml");
  assert.deepEqual(tokens(html, "key"), ["gates", "name", "command", "required", "args"]);
  assert.deepEqual(tokens(html, "com"), ["# gates", "# runs after each round"]);
  assert.deepEqual(tokens(html, "str"), ["&quot;npm test&quot;"]);
  assert.deepEqual(tokens(html, "lit"), ["true"]);
});

test("JSON, JavaScript and diffs", () => {
  const j = highlight(`{ "private": true, "name": "x" }`, "json");
  assert.deepEqual(tokens(j, "key"), ["&quot;private&quot;", "&quot;name&quot;"]);
  assert.deepEqual(tokens(j, "str"), ["&quot;x&quot;"]);
  const s = highlight("// note\nexport const pad = (n) => `${n}`;", "js");
  assert.deepEqual(tokens(s, "kw"), ["export", "const"]);
  assert.deepEqual(tokens(s, "com"), ["// note"]);
  const d = highlight("-  old\n+  new\n   same", "diff");
  assert.deepEqual([tokens(d, "del"), tokens(d, "add")], [["-  old"], ["+  new"]]);
});

test("an unknown language stays plain, and an unclosed quote neither hangs nor drops text", () => {
  assert.equal(highlight("# Title <b>", "md"), esc("# Title <b>"));
  assert.equal(plain(highlight(`echo it's "open`, "sh")), esc(`echo it's "open`));
});

test("highlighting every code block of the built site keeps its text exactly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentduo-site-"));
  try {
    const { outDir } = await build({ outDir: join(dir, "dist"), env: {}, log: () => {} });
    const dec = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    let blocks = 0;
    for (const file of readdirSync(outDir, { recursive: true }).filter((f) => f.endsWith(".html"))) {
      const html = readFileSync(join(outDir, file), "utf8");
      for (const m of html.matchAll(/<div class="code"(?: data-lang="([^"]*)")?>(?:<p class="code-label">[^<]*<\/p>)?<pre tabindex="0"><code>([\s\S]*?)<\/code>/g)) {
        const text = dec(plain(m[2]));
        assert.equal(plain(highlight(text, m[1] ?? "")), esc(text), `${file}: ${text.slice(0, 60)}`);
        blocks++;
      }
    }
    assert.ok(blocks > 100, `only ${blocks} code blocks found`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
