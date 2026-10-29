// The chat's slash commands: what each one does, how a line of input is read, and what to suggest while it is typed.
// Pure (no Node), so the terminal chat, the extension worker and the sidebar's webview share one catalog.

export type Backend = "claude" | "codex";
export type EditMode = "auto" | "ask";

export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const CODEX_PRESETS = ["read-only", "auto", "full-access", "default"] as const;
export type CodexPermission = (typeof CODEX_PRESETS)[number];
export const RULE_KINDS = ["allow", "deny", "remove"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

/** A model a CLI offers, as its own model picker lists it. */
export interface ModelChoice {
  /** What the CLI takes as the model (`--model`, `-c model=`). */
  id: string;
  label: string;
  description: string;
  /** The reasoning efforts it takes, and its own default; null when the CLI does not say. */
  efforts: string[] | null;
  defaultEffort: string | null;
}

/**
 * The model aliases Claude Code accepts (2.1.31x lists them in its binary; `--help` names fable, opus and sonnet).
 * Each stands for the latest model of its family, so the list holds until Claude Code changes its aliases.
 */
export const CLAUDE_MODELS: ModelChoice[] = [
  ["fable", "Fable", "the latest Fable model"],
  ["opus", "Opus", "the latest Opus model"],
  ["sonnet", "Sonnet", "the latest Sonnet model"],
  ["haiku", "Haiku", "the latest Haiku model, the fastest"],
  ["fable[1m]", "Fable (1M context)", "the latest Fable model with a 1M-token context"],
  ["opus[1m]", "Opus (1M context)", "the latest Opus model with a 1M-token context"],
  ["sonnet[1m]", "Sonnet (1M context)", "the latest Sonnet model with a 1M-token context"],
  ["best", "Best", "the most capable model your account can use"],
  ["opusplan", "Opus Plan", "Opus while planning, Sonnet otherwise"],
].map(([id, label, description]) => ({ id: id!, label: label!, description: description!, efforts: null, defaultEffort: null }));

export const AGENT_NAMES: Record<Backend, string> = { claude: "Claude", codex: "Codex" };

/**
 * A setting to show (its value left out) or change, mirroring the CLIs' own commands. `null` as a model or an effort
 * means "default": agentduo passes nothing and the CLI's own configuration decides.
 */
export type SettingCommand =
  | { target: "edits"; mode?: EditMode }
  | { target: "claude.model"; model?: string | null }
  | { target: "claude.effort"; effort?: string | null }
  | { target: "claude.permissions"; rule?: { kind: RuleKind; rule: string } }
  | { target: "claude.add-dir"; dir?: string }
  | { target: "codex.model"; model?: string | null; effort?: string | null }
  | { target: "codex.permissions"; preset?: CodexPermission };

export type ChatCommand = "help" | "plan" | "diff" | "status" | "usage" | "resume" | "new" | "quit" | "config" | "attachments";

export type ParsedInput =
  | { kind: "empty" }
  /** Plain text: a question for the current recipient, or a note for a running pipeline. */
  | { kind: "message"; text: string }
  /** `hint`: the words looked like a setting but did not fit one, so they went as a question; says how to set it. */
  | { kind: "ask"; backend: Backend; text: string; hint: string | null }
  | { kind: "recipient"; backend: Backend }
  | { kind: "pipeline"; task: string }
  /** /discuss: the current recipient answers, the other agent reviews, until they agree. */
  | { kind: "discuss"; question: string }
  | { kind: "setting"; setting: SettingCommand; save: boolean; yes: boolean }
  /** /attach <path>: `path` as the shell would read the word; `home`: it started with ~ (relative to the home directory). */
  | { kind: "attach"; path: string; home: boolean }
  /** /detach <n|id|all>. */
  | { kind: "detach"; target: string }
  | { kind: "command"; name: ChatCommand; arg: string }
  | { kind: "usage"; text: string }
  | { kind: "unknown"; name: string };

export interface CommandInfo {
  name: string;
  usage: string;
  description: string;
  /** Takes words after the name (completion then adds a space). */
  args: boolean;
}

/** Every command, in the order /help and the completion list show them. */
export const COMMANDS: CommandInfo[] = [
  { name: "/claude", usage: "/claude <question>", description: "ask Claude Code; /claude alone sends your next messages to Claude", args: true },
  { name: "/codex", usage: "/codex <question>", description: "ask Codex; /codex alone sends your next messages to Codex", args: true },
  { name: "/pipeline", usage: "/pipeline <task>", description: "run the full workflow: plan → critique → finalize → implement → verify → review", args: true },
  { name: "/discuss", usage: "/discuss <question>", description: "the recipient answers, the other agent reviews, they revise until they agree, then Codex sums it up", args: true },
  { name: "/plan", usage: "/plan", description: "show the final plan of the current run", args: false },
  { name: "/diff", usage: "/diff", description: "show what the current run changed", args: false },
  { name: "/status", usage: "/status", description: "show where the current run is, and what it has cost", args: false },
  { name: "/usage", usage: "/usage", description: "show how much of their plans' limits Claude Code and Codex have used", args: false },
  { name: "/attach", usage: "/attach <path>", description: "attach a file (image, PDF, text, code…) to your next message; quote a path with spaces, or escape them", args: true },
  { name: "/attachments", usage: "/attachments", description: "list the files waiting to go with your next message", args: false },
  { name: "/detach", usage: "/detach <n|all>", description: "remove a file waiting to go with your next message, or all of them", args: true },
  { name: "/resume", usage: "/resume [note | run id]", description: "continue the stopped or waiting run, optionally with a note for the agents", args: true },
  { name: "/new", usage: "/new", description: "start a new conversation (in VS Code, in a tab of its own); a stopped run stays resumable", args: false },
  { name: "/settings", usage: "/settings claude|codex <setting> …", description: "change a setting: model, effort, permissions, add-dir (add --save to keep it)", args: true },
  { name: "/edits", usage: "/edits auto|ask", description: "Claude (chat and pipeline implementer) edits files without asking (auto), or asks first", args: true },
  { name: "/config", usage: "/config", description: "show the settings both agents run with now", args: false },
  { name: "/help", usage: "/help", description: "list the commands", args: false },
  { name: "/quit", usage: "/quit", description: "leave; a running pipeline stops at its step and stays resumable", args: false },
];

interface SettingInfo {
  name: string;
  usage: string;
  description: string;
}

/** The settings each agent has, as /settings <agent> <name> takes them; /claude <name> and /codex <name> are shortcuts. */
export const SETTINGS: Record<Backend, SettingInfo[]> = {
  claude: [
    { name: "model", usage: "model <name|default>", description: "Claude's model, as /model in Claude Code" },
    { name: "effort", usage: `effort ${[...CLAUDE_EFFORTS, "default"].join("|")}`, description: "Claude's effort level, as /effort" },
    { name: "permissions", usage: "permissions [allow|deny|remove <rule>]", description: "Claude's tool rules for agentduo's calls, e.g. Bash(npm test:*); as /permissions" },
    { name: "add-dir", usage: "add-dir <path>", description: "another directory Claude may work in, as /add-dir" },
  ],
  codex: [
    { name: "model", usage: `model <name|default> [${CODEX_EFFORTS.join("|")}]`, description: "Codex's model and reasoning effort, as /model in Codex" },
    { name: "permissions", usage: `permissions ${CODEX_PRESETS.join("|")}`, description: "what Codex may do, as /permissions in Codex" },
  ],
};

// ------------------------------------------------------------------ tokens
interface Token {
  text: string;
  start: number;
  end: number;
}

/** Words split on whitespace; "double" or 'single' quotes keep a path with spaces in one word. */
export function tokenize(input: string): Token[] {
  const out: Token[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(input); m; m = re.exec(input)) out.push({ text: m[1] ?? m[2] ?? m[3]!, start: m.index, end: m.index + m[0].length });
  return out;
}

const FLAGS = new Set(["--save", "--yes"]);
const usage = (text: string): ParsedInput => ({ kind: "usage", text });
const settingUsage = (backend: Backend, name?: string): string => {
  const list = SETTINGS[backend].filter((s) => !name || s.name === name);
  return list.length === 1 ? `usage: /settings ${backend} ${list[0]!.usage}` : `usage: /settings ${backend} ${SETTINGS[backend].map((s) => s.name).join("|")} …`;
};
const isOneOf = <T extends string>(value: string | undefined, list: readonly T[]): value is T => value !== undefined && (list as readonly string[]).includes(value);
const modelValue = (value: string) => (value === "default" ? null : value);

/**
 * The setting `words` name, or null when they do not have its shape (then the words are a question, not a setting).
 * --save and --yes count only once the rest fits.
 */
function settingOf(backend: Backend, name: string, words: Token[]): ParsedInput | null {
  const save = words.some((w) => w.text === "--save");
  const yes = words.some((w) => w.text === "--yes");
  const args = words.filter((w) => !FLAGS.has(w.text)).map((w) => w.text);
  const setting = (s: SettingCommand): ParsedInput => ({ kind: "setting", setting: s, save, yes });
  if (backend === "claude") {
    switch (name) {
      case "model":
        if (args.length === 0) return setting({ target: "claude.model" });
        return args.length === 1 ? setting({ target: "claude.model", model: modelValue(args[0]!) }) : null;
      case "effort":
        if (args.length === 0) return setting({ target: "claude.effort" });
        return args.length === 1 && isOneOf(args[0], [...CLAUDE_EFFORTS, "default"]) ? setting({ target: "claude.effort", effort: modelValue(args[0]!) }) : null;
      case "permissions":
        if (args.length === 0) return setting({ target: "claude.permissions" });
        return args.length >= 2 && isOneOf(args[0], RULE_KINDS) ? setting({ target: "claude.permissions", rule: { kind: args[0], rule: args.slice(1).join(" ") } }) : null;
      case "add-dir":
        if (args.length === 0) return setting({ target: "claude.add-dir" });
        return args.length === 1 ? setting({ target: "claude.add-dir", dir: args[0]! }) : null;
    }
    return null;
  }
  switch (name) {
    case "model":
      if (args.length === 0) return setting({ target: "codex.model" });
      if (args.length === 1) return setting({ target: "codex.model", model: modelValue(args[0]!), effort: null });
      return args.length === 2 && isOneOf(args[1], CODEX_EFFORTS) ? setting({ target: "codex.model", model: modelValue(args[0]!), effort: args[1] }) : null;
    case "permissions":
      if (args.length === 0) return setting({ target: "codex.permissions" });
      return args.length === 1 && isOneOf(args[0], CODEX_PRESETS) ? setting({ target: "codex.permissions", preset: args[0] }) : null;
  }
  return null;
}

/** /claude … and /codex …: a question, unless the words have exactly the shape of one of the agent's settings. */
function agentCommand(backend: Backend, rest: string): ParsedInput {
  if (!rest) return { kind: "recipient", backend };
  const words = tokenize(rest);
  if (words[0]!.text === "--" && rest.startsWith("--")) {
    const question = rest.slice(2).trim();
    return question ? { kind: "ask", backend, text: question, hint: null } : { kind: "recipient", backend };
  }
  const name = words[0]!.text;
  if (!SETTINGS[backend].some((s) => s.name === name)) return { kind: "ask", backend, text: rest, hint: null };
  const setting = settingOf(backend, name, words.slice(1));
  if (setting) return setting;
  return {
    kind: "ask", backend, text: rest,
    hint: `Sent to ${AGENT_NAMES[backend]} as a question. To change the setting instead: /settings ${backend} ${SETTINGS[backend].find((s) => s.name === name)!.usage}`,
  };
}

/** /settings <agent> <setting> …: the canonical form, so a mistake gets the usage rather than becoming a question. */
function settingsCommand(rest: string): ParsedInput {
  const words = tokenize(rest);
  const [target, name] = words;
  if (!target) return { kind: "command", name: "config", arg: "" };
  if (target.text === "edits") return editsCommand(rest.slice(target.end).trim());
  if (target.text !== "claude" && target.text !== "codex") return usage("usage: /settings claude|codex <setting> … (or /settings edits auto|ask)");
  const backend = target.text;
  if (!name || !SETTINGS[backend].some((s) => s.name === name.text)) return usage(settingUsage(backend));
  return settingOf(backend, name.text, words.slice(2)) ?? usage(settingUsage(backend, name.text));
}

function editsCommand(rest: string): ParsedInput {
  const words = tokenize(rest);
  const args = words.filter((w) => !FLAGS.has(w.text));
  const save = words.some((w) => w.text === "--save");
  if (!args.length) return { kind: "setting", setting: { target: "edits" }, save, yes: false };
  if (args.length === 1 && isOneOf(args[0]!.text, ["auto", "ask"] as const)) {
    return { kind: "setting", setting: { target: "edits", mode: args[0]!.text as EditMode }, save, yes: false };
  }
  return usage("usage: /edits auto|ask");
}

const SIMPLE: Record<string, ChatCommand> = {
  help: "help", plan: "plan", diff: "diff", status: "status", usage: "usage", resume: "resume", new: "new", quit: "quit", exit: "quit", config: "config",
  attachments: "attachments",
};

/**
 * One path as a POSIX shell reads one word, without running anything: 'single quotes' keep everything as it is;
 * "double quotes" keep everything but \" \\ \$ \`; outside quotes a backslash keeps the next character (an escaped
 * space, as a terminal writes a dropped file). Quoted and unquoted parts join ('it'"'"'s' is it's; 'it''s' is its).
 * Unlike a shell, a path that starts with ~ or ~/ means the home directory inside quotes too ("~/My notes.pdf"), as
 * people write it; \~ or ./~ names a directory called ~. No ~user, no globs, no variables. The text is not normalized.
 */
export function parsePathArg(input: string): { path: string; home: boolean } | { error: string } {
  const s = input.trim();
  let out = "";
  /** The path starts with an escaped character (\~): it is only itself. */
  let escapedFirst = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return { error: "a ' is not closed" };
      out += s.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === "\\" && j + 1 < s.length && '"\\$`'.includes(s[j + 1]!)) j++;
        out += s[j];
      }
      if (j >= s.length) return { error: 'a " is not closed' };
      i = j;
    } else if (c === "\\") {
      if (i + 1 < s.length) {
        if (!out) escapedFirst = true;
        out += s[++i];
      }
    } else if (/\s/.test(c)) {
      return { error: "one path at a time: put it in quotes, or escape its spaces with \\" };
    } else out += c;
  }
  if (!out) return { error: "no path" };
  return !escapedFirst && (out === "~" || out.startsWith("~/")) ? { path: out.slice(1), home: true } : { path: out, home: false };
}

const ATTACH_USAGE = 'usage: /attach <path>, e.g. /attach screenshots/bug.png or /attach "~/Desktop/My notes.pdf" (one file at a time)';

/** What a line typed in the chat asks for. */
export function parseInput(raw: string): ParsedInput {
  const text = raw.trim();
  if (!text) return { kind: "empty" };
  if (!text.startsWith("/")) return { kind: "message", text };
  const m = /^\/(\S*)\s*([\s\S]*)$/.exec(text)!;
  const name = m[1]!;
  const rest = m[2]!;
  switch (name) {
    case "claude":
    case "codex":
      return agentCommand(name, rest);
    case "pipeline":
      return rest ? { kind: "pipeline", task: rest } : usage("usage: /pipeline <task>, e.g. /pipeline Add JWT auth");
    case "discuss":
      return rest ? { kind: "discuss", question: rest } : usage("usage: /discuss <question>, e.g. /discuss Redis or Postgres for the job queue?");
    case "settings":
      return settingsCommand(rest);
    case "edits":
      return editsCommand(rest);
    case "attach": {
      if (!rest) return usage(ATTACH_USAGE);
      const parsed = parsePathArg(rest);
      return "error" in parsed ? usage(`${parsed.error}. ${ATTACH_USAGE}`) : { kind: "attach", ...parsed };
    }
    case "detach":
      return rest && !/\s/.test(rest) ? { kind: "detach", target: rest } : usage("usage: /detach <n|all>: n as /attachments numbers the files");
  }
  const simple = SIMPLE[name];
  return simple ? { kind: "command", name: simple, arg: rest } : { kind: "unknown", name: `/${name}` };
}

// ------------------------------------------------------------------ help
/** /help: every command and setting, one per line, the usage padded so the descriptions of each section line up. */
export function helpText(): string {
  const sections: Array<{ title: string[]; rows: Array<[string, string]> }> = [
    {
      title: [
        "Type a message and press Enter: it goes to the agent named below the input (Codex at first; /claude or /codex switches).",
        "With /pipeline <task> both take the task on: Codex plans and reviews it, Claude critiques the plan and implements it.",
        "With /discuss <question> that agent answers, the other reviews it until they agree, and Codex sums the discussion up as the answer.",
      ],
      rows: COMMANDS.map((c) => [c.usage, c.description]),
    },
    {
      title: ["Settings (this chat only; add --save to write one to .agentduo/config.yaml)"],
      rows: [
        ...(["claude", "codex"] as const).flatMap((backend) => SETTINGS[backend].map((s): [string, string] => [`/settings ${backend} ${s.usage}`, s.description])),
        ["/claude model …, /codex permissions …", "shortcuts for /settings, taken as a setting only when the words fit it exactly"],
        ["/claude -- <question>", "always a question, even when it starts with a setting's name"],
      ],
    },
    {
      title: ["Keys"],
      rows: [
        ["Shift+Tab", "switch Claude's edits between ask and auto"],
        ["Esc", "stop what is running: an answer, or the pipeline's current step (/resume continues it)"],
        ["Ctrl-C twice", "leave"],
      ],
    },
  ];
  return sections.map(({ title, rows }) => {
    // A usage longer than the column keeps its description on its own line, two spaces after it.
    const width = Math.min(40, Math.max(...rows.map((r) => r[0].length))) + 2;
    return [...title, ...rows.map(([usage, what]) => `  ${usage.length >= width ? `${usage}  ` : usage.padEnd(width)}${what}`)].join("\n");
  }).join("\n\n");
}

// ------------------------------------------------------------------ completion
export interface Completion {
  /** The whole input once this is picked; null for a hint that only says what to type. */
  insert: string | null;
  label: string;
  description: string;
}

const ALIAS_NOTE = "a setting only when the words fit it exactly; anything else goes to the agent as a question";

/** What to suggest for `input` while it is typed: commands, then their words. Empty when there is nothing to say. */
export function complete(input: string): Completion[] {
  if (!input.startsWith("/") || input.includes("\n")) return [];
  const parts = input.slice(1).split(" ");
  const word = parts.at(-1)!;
  const before = parts.slice(0, -1);
  const head = `/${before.join(" ")}${before.length ? " " : ""}`;
  const pick = (items: Array<{ word: string; description: string; more?: boolean }>): Completion[] =>
    items.filter((i) => i.word.startsWith(word)).map((i) => ({ insert: `${head}${i.word}${i.more ? " " : ""}`, label: i.word, description: i.description }));
  const hint = (label: string, description: string): Completion[] => (word ? [] : [{ insert: null, label, description }]);

  if (!before.length) {
    return COMMANDS.filter((c) => c.name.startsWith(`/${word}`)).map((c) => ({ insert: `${c.name}${c.args ? " " : ""}`, label: c.usage, description: c.description }));
  }
  const [cmd, ...args] = before;
  const settingWords = (backend: Backend, alias: boolean) => SETTINGS[backend].map((s) => ({
    word: s.name, more: true, description: `${s.usage} — ${s.description}${alias ? `; ${ALIAS_NOTE}` : ""}`,
  }));
  const settingValues = (backend: Backend, name: string, values: string[]): Completion[] => {
    if (backend === "claude" && name === "effort" && !values.length) return pick([...CLAUDE_EFFORTS, "default"].map((e) => ({ word: e, description: e === "default" ? "Claude Code's own default" : `effort ${e}` })));
    if (backend === "claude" && name === "permissions" && !values.length) {
      return pick([
        { word: "allow", more: true, description: "allow <rule>: let Claude use a tool without asking, e.g. Bash(npm test:*)" },
        { word: "deny", more: true, description: "deny <rule>: never let Claude use it" },
        { word: "remove", more: true, description: "remove <rule>: drop an allow or deny rule" },
      ]);
    }
    if (backend === "claude" && name === "permissions") return hint("<rule>", "a Claude Code permission rule, e.g. Bash(npm test:*) or Edit(src/**)");
    if (backend === "claude" && name === "model" && !values.length) return [...hint("<name>", "a model or alias Claude Code knows (opus, sonnet, haiku, a full name)"), ...pick([{ word: "default", description: "leave it to Claude Code's own settings" }])];
    if (backend === "claude" && name === "add-dir" && !values.length) return hint("<path>", "a directory, quoted if it has spaces");
    if (backend === "codex" && name === "model" && !values.length) return [...hint("<name>", "a model Codex knows, optionally followed by a reasoning effort"), ...pick([{ word: "default", description: "leave it to ~/.codex/config.toml", more: true }])];
    if (backend === "codex" && name === "model" && values.length === 1) return pick(CODEX_EFFORTS.map((e) => ({ word: e, description: `reasoning effort ${e}` })));
    if (backend === "codex" && name === "permissions" && !values.length) {
      return pick([
        { word: "read-only", description: "Codex may read, not change, files" },
        { word: "auto", description: "Codex may change files in the workspace" },
        { word: "full-access", description: "Codex may change any file and use the network (needs --yes)" },
        { word: "default", description: "leave it to ~/.codex/config.toml" },
      ]);
    }
    return [];
  };

  if (cmd === "claude" || cmd === "codex") {
    if (!args.length) {
      return [
        ...hint("<question>", `ask ${AGENT_NAMES[cmd]}; Enter on /${cmd} alone sends your next messages to ${AGENT_NAMES[cmd]}`),
        ...pick([{ word: "--", more: true, description: "the rest is a question, even if it starts with a setting's name" }]),
        ...pick(settingWords(cmd, true)),
      ];
    }
    const name = args[0]!;
    return SETTINGS[cmd].some((s) => s.name === name) ? settingValues(cmd, name, args.slice(1)) : [];
  }
  if (cmd === "settings") {
    if (!args.length) {
      return pick([
        { word: "claude", more: true, description: "Claude's model, effort, permissions and extra directories" },
        { word: "codex", more: true, description: "Codex's model, reasoning effort and permissions" },
        { word: "edits", more: true, description: "edits auto|ask: whether Claude edits files without asking" },
      ]);
    }
    const target = args[0]!;
    if (target === "edits" && args.length === 1) return editsValues(pick);
    if (target !== "claude" && target !== "codex") return [];
    if (args.length === 1) return pick(settingWords(target, false));
    return settingValues(target, args[1]!, args.slice(2));
  }
  if (cmd === "edits" && !args.length) return editsValues(pick);
  if (cmd === "pipeline" && !args.length) return hint("<task>", "what both agents should do, e.g. Add JWT auth");
  if (cmd === "discuss" && !args.length) return hint("<question>", "what the agents should discuss until they agree");
  if (cmd === "resume" && !args.length) return hint("[note | run id]", "a note for the agents, or the id of another run to continue");
  if (cmd === "attach" && !args.length) return hint("<path>", "a file to send with your next message; quote it if it has spaces (~/ is your home, quoted or not)");
  if (cmd === "detach" && !args.length) return [...hint("<n>", "the number /attachments gives the file"), ...pick([{ word: "all", description: "remove every waiting file" }])];
  return [];
}

function editsValues(pick: (items: Array<{ word: string; description: string }>) => Completion[]): Completion[] {
  return pick([
    { word: "auto", description: "Claude edits files without asking (acceptEdits)" },
    { word: "ask", description: "Claude asks before it edits a file" },
  ]);
}
