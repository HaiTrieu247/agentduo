// Build-time highlighting for code blocks: each token kind becomes a <span class="tk-…">, so pages need no script,
// the site's CSP (no inline styles) holds, and the copy button and the search index still read the plain text.
// The rules cover what the site shows: shell commands, the chat's slash commands, YAML, JSON, JavaScript and diffs.
// Anything else stays plain. Highlighting only wraps text in spans; it never adds, drops or reorders a character.
import { esc } from "./render.mjs";

const span = (kind, text) => (text ? `<span class="tk-${kind}">${esc(text)}</span>` : "");

/** Runs sticky rules over `text` in order; the first that matches at the current position emits its HTML. */
function scan(text, rules) {
  let html = "";
  let i = 0;
  while (i < text.length) {
    let matched = false;
    for (const [re, emit] of rules) {
      re.lastIndex = i;
      const m = re.exec(text);
      if (!m || !m[0]) continue;
      html += emit(m);
      i += m[0].length;
      matched = true;
      break;
    }
    if (!matched) html += esc(text[i++]);
  }
  return html;
}

// ------------------------------------------------------------------ shell

const SH_KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "case", "esac", "in", "for", "while", "until", "do", "done"]);
// After these keywords the next word is a command again ("then npm test").
const SH_KEYWORDS_BEFORE_COMMAND = new Set(["if", "then", "else", "elif", "while", "until", "do"]);
// Commands that run the next word as a command ("sudo apt install").
const SH_PREFIXES = new Set(["sudo", "env", "time", "exec"]);

function shellLine(line, state) {
  let command = true;
  let loop = false; // after "case" or "for", whose "in" is a keyword too
  const word = (w) => {
    if (!command) {
      if (loop && w === "in") return span("kw", w);
      return w.startsWith("-") ? span("flag", w) : esc(w);
    }
    if (SH_KEYWORDS.has(w)) {
      loop = w === "case" || w === "for";
      command = SH_KEYWORDS_BEFORE_COMMAND.has(w);
      return span("kw", w);
    }
    // A case pattern ("0)", "*)") or an assignment ("NAME=value") comes before the command.
    if (/\)$/.test(w) || /^[A-Za-z_]\w*=/.test(w)) return esc(w);
    command = SH_PREFIXES.has(w);
    return span("cmd", w);
  };
  return scan(line, [
    [/\s+/y, (m) => m[0]],
    [/#.*/y, (m) => span("com", m[0])],
    [/"(?:[^"\\]|\\.)*"|'[^']*'/y, (m) => { command = false; return span("str", m[0]); }],
    [/\$(?:[?#@*!$0-9]|\{[^}]*\}|[A-Za-z_]\w*)/y, (m) => { command = false; return span("var", m[0]); }],
    [/<<-?\s*(['"]?)(\w+)\1/y, (m) => { state.heredoc = m[2]; command = false; return span("punct", m[0]); }],
    [/&&|\|\||;;|[|;]/y, (m) => { command = true; return span("punct", m[0]); }],
    [/[<>&]+/y, (m) => { command = false; return span("punct", m[0]); }],
    [/[^\s"'|;&<>$]+/y, (m) => word(m[0])],
  ]);
}

function shell(text) {
  const state = { heredoc: null };
  return text.split("\n").map((line) => {
    // A here-document's body is the file being written, not commands: it stays plain until its terminator.
    if (state.heredoc) {
      if (line.trim() !== state.heredoc) return esc(line);
      state.heredoc = null;
      return span("punct", line);
    }
    return shellLine(line, state);
  }).join("\n");
}

// ------------------------------------------------------------------ chat

// The chat's input lines: an optional prompt (› or ❯), then a slash command and its arguments. A line that starts
// with duo is the shell command that opens the chat, and narration lines ("… Codex answers …") are comments. Lines of
// any other shape (output, the live view) stay plain.
function chat(text) {
  return text.split("\n").map((line) => {
    if (/^duo(?:\s|$)/.test(line)) return shellLine(line, { heredoc: null });
    if (/^\s*…/.test(line)) return span("com", line);
    const m = /^(\s*)([›❯]\s+)?(\/[a-z][\w-]*)?(.*)$/.exec(line);
    if (!m[2] && !m[3]) return esc(line);
    const rest = m[3] ? scan(m[4], [
      [/\s+/y, (x) => x[0]],
      [/"(?:[^"\\]|\\.)*"/y, (x) => span("str", x[0])],
      [/--?[A-Za-z][\w-]*/y, (x) => span("flag", x[0])],
      [/\S+/y, (x) => esc(x[0])],
    ]) : esc(m[4]);
    return esc(m[1]) + span("punct", m[2] ?? "") + span("cmd", m[3] ?? "") + rest;
  }).join("\n");
}

// ------------------------------------------------------------------ YAML

const yamlValue = (text) => scan(text, [
  [/\s+/y, (m) => m[0]],
  [/#.*/y, (m) => span("com", m[0])],
  [/"(?:[^"\\]|\\.)*"|'[^']*'/y, (m) => span("str", m[0])],
  [/(?:true|false|null|~|-?\d+(?:\.\d+)?)(?=[\s,\]}]|$)/y, (m) => span("lit", m[0])],
  [/[[\]{},]/y, (m) => span("punct", m[0])],
  [/[^\s[\]{},#]+(?:#[^\s[\]{},]*)*/y, (m) => esc(m[0])],
]);

function yaml(text) {
  return text.split("\n").map((line) => {
    if (/^\s*#/.test(line)) return span("com", line);
    const m = /^(\s*)(-\s+)?([A-Za-z_][\w.-]*)(:)(?=\s|$)(.*)$/.exec(line);
    if (m) return esc(m[1]) + span("punct", m[2] ?? "") + span("key", m[3]) + span("punct", m[4]) + yamlValue(m[5]);
    const item = /^(\s*)(-\s+)(.*)$/.exec(line);
    if (item) return esc(item[1]) + span("punct", item[2]) + yamlValue(item[3]);
    return yamlValue(line);
  }).join("\n");
}

// ------------------------------------------------------------------ JSON and JavaScript

const json = (text) => scan(text, [
  [/"(?:[^"\\]|\\.)*"(?=\s*:)/y, (m) => span("key", m[0])],
  [/"(?:[^"\\]|\\.)*"/y, (m) => span("str", m[0])],
  [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y, (m) => span("lit", m[0])],
]);

const JS_KEYWORDS = new Set(["import", "export", "from", "default", "function", "const", "let", "var", "return", "if", "else",
  "for", "of", "in", "new", "await", "async", "class", "extends", "throw", "try", "catch", "typeof"]);
const JS_LITERALS = new Set(["true", "false", "null", "undefined"]);

const js = (text) => scan(text, [
  [/\/\/.*|\/\*[\s\S]*?\*\//y, (m) => span("com", m[0])],
  [/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/y, (m) => span("str", m[0])],
  [/[A-Za-z_$][\w$]*/y, (m) => (JS_KEYWORDS.has(m[0]) ? span("kw", m[0]) : JS_LITERALS.has(m[0]) ? span("lit", m[0]) : esc(m[0]))],
  [/\d+(?:\.\d+)?/y, (m) => span("lit", m[0])],
]);

// ------------------------------------------------------------------ diff

const diff = (text) => text.split("\n").map((line) =>
  line.startsWith("+") ? span("add", line) : line.startsWith("-") ? span("del", line) : line.startsWith("@@") ? span("punct", line) : esc(line)).join("\n");

const BY_LANG = { sh: shell, yaml, json, js, diff, "": chat };

/** `text` as HTML for a code block of language `lang` ("" for chat input and plain output). */
export function highlight(text, lang = "") {
  const fn = BY_LANG[lang];
  return fn ? fn(String(text)) : esc(text);
}
