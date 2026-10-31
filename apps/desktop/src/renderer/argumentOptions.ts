import { CLAUDE_EFFORTS, CODEX_EFFORTS, MODE_INFO, PERMISSION_MODES } from "../../../../src/core/commands.js";
import { button, el, errorText, icon } from "./bridge.js";

/** A CLI option Settings offers by name: the flags it is written with, and what its value takes. */
export interface OptionSpec {
  id: string;
  label: string;
  /** What it does, in the add menu and under its row. */
  description: string;
  flags: string[];
  /** It takes no value: being in the list is the setting. */
  switch?: boolean;
  choices?: readonly string[];
  labels?: Record<string, string>;
  prefix?: string;
  placeholder?: string;
  /** It may be in the list more than once (a tool rule, a folder). */
  repeatable?: boolean;
}

/** The options each CLI is offered with, as agentduo's chat settings and README name them. Unknown tokens stay intact. */
export function argumentOptions(backend: string): OptionSpec[] {
  const folder: OptionSpec = { id: "directory", label: "Additional folder", description: "Another folder the agent may read and edit.", flags: ["--add-dir"], placeholder: "Folder path", repeatable: true };
  return backend === "claude" ? [
    { id: "effort", label: "Reasoning effort", description: "How much Claude thinks before it answers.", flags: ["--effort"], choices: CLAUDE_EFFORTS },
    {
      id: "permissions", label: "Permission mode", description: "What Claude may do without asking first.", flags: ["--permission-mode"],
      choices: ["default", ...PERMISSION_MODES.filter((m) => m !== "manual")], labels: { default: "Manual", ...Object.fromEntries(PERMISSION_MODES.map((m) => [m, MODE_INFO[m].label])) },
    },
    { id: "allow", label: "Allowed tool", description: "A tool or rule Claude may use without asking.", flags: ["--allowedTools", "--allowed-tools"], placeholder: "e.g. Read or Bash(npm test:*)", repeatable: true },
    { id: "deny", label: "Denied tool", description: "A tool or rule Claude must not use.", flags: ["--disallowedTools", "--disallowed-tools"], placeholder: "e.g. Bash(rm:*)", repeatable: true },
    folder,
    { id: "no-mcp", label: "Skip MCP servers", description: "Loads none of your MCP servers, which makes each call cheaper.", flags: ["--strict-mcp-config"], switch: true },
    { id: "no-sessions", label: "Don't save sessions", description: "Claude Code keeps no session history of AgentDuo's calls.", flags: ["--no-session-persistence"], switch: true },
  ] : [
    { id: "effort", label: "Reasoning effort", description: "How much Codex reasons before it answers.", flags: ["-c", "--config"], prefix: "model_reasoning_effort=", choices: CODEX_EFFORTS },
    {
      id: "permissions", label: "Sandbox", description: "What Codex's commands may touch.", flags: ["--sandbox", "-s"], choices: ["read-only", "workspace-write", "danger-full-access"],
      labels: { "read-only": "Read only", "workspace-write": "Workspace access", "danger-full-access": "Full access" },
    },
    folder,
    { id: "ephemeral", label: "Don't save sessions", description: "Codex keeps no session files of AgentDuo's calls.", flags: ["--ephemeral"], switch: true },
  ];
}

export interface ArgumentRow {
  /** The option's id; null: a flag Settings does not know, kept as it is written. */
  option: string | null;
  value: string;
  /** An unknown option's flag; its value, when it has one, is `value`. */
  flag?: string;
  /** What the row read from the config, written back as it was while the row is unchanged. */
  original?: { flag?: string; value: string; tokens: string[] };
}

const isFlag = (token: string) => token.startsWith("-");

export function argumentRows(args: string[], backend: string): ArgumentRow[] {
  const specs = argumentOptions(backend);
  const rows: ArgumentRow[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const toggle = specs.find((s) => s.switch && s.flags.includes(token));
    if (toggle) {
      rows.push({ option: toggle.id, value: "", original: { value: "", tokens: [token] } });
      continue;
    }
    const equals = token.indexOf("=");
    const flag = equals < 0 ? token : token.slice(0, equals);
    const value = equals < 0 ? args[i + 1] : token.slice(equals + 1);
    const spec = specs.find((s) => !s.switch && s.flags.includes(flag) && value !== undefined && (!s.prefix || value.startsWith(s.prefix)));
    if (!spec) {
      // An unknown flag and the word after it (when that is no flag itself) show as one option; the tokens stay as they are.
      const next = args[i + 1];
      const paired = isFlag(token) && equals < 0 && next !== undefined && !isFlag(next);
      const tokens = paired ? [token, args[++i]!] : [token];
      rows.push({ option: null, flag: token, value: paired ? next! : "", original: { flag: token, value: paired ? next! : "", tokens } });
      continue;
    }
    const shown = value!.slice(spec.prefix?.length ?? 0);
    const tokens = equals < 0 ? [token, args[++i]!] : [token];
    rows.push({ option: spec.id, value: shown, original: { value: shown, tokens } });
  }
  return rows;
}

export function argumentTokens(rows: ArgumentRow[], backend: string): string[] {
  return rows.flatMap((row) => {
    if (row.original && row.original.value === row.value && row.original.flag === row.flag) return row.original.tokens;
    if (!row.option) {
      const flag = row.flag?.trim() ?? "";
      if (!flag) throw new Error("Enter the flag, e.g. --verbose.");
      return row.value.trim() ? [flag, row.value.trim()] : [flag];
    }
    const spec = argumentOptions(backend).find((s) => s.id === row.option);
    if (!spec) throw new Error("Unknown option");
    if (spec.switch) return [spec.flags[0]!];
    if (!row.value.trim()) throw new Error(`Enter a value for ${spec.label.toLowerCase()}.`);
    return [spec.flags[0]!, `${spec.prefix ?? ""}${row.value.trim()}`];
  });
}

/** The options still offered in the add menu: each one-off option once, the repeatable ones always. */
export function addableOptions(rows: ArgumentRow[], backend: string): OptionSpec[] {
  return argumentOptions(backend).filter((s) => s.repeatable || !rows.some((r) => r.option === s.id));
}

/** Calls `commit` with the input's value on Enter or when it loses focus, once per new value; Escape puts it back. */
export function commitOnChange(input: HTMLInputElement, commit: (value: string) => void): void {
  let last = input.value;
  const go = () => {
    if (input.value === last) return;
    last = input.value;
    commit(input.value);
  };
  input.addEventListener("change", go);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      go();
    } else if (e.key === "Escape" && input.value !== last) {
      e.stopPropagation();
      input.value = last;
    }
  });
}

function choiceSelect(spec: OptionSpec, value: string, id: string): HTMLSelectElement {
  const select = el("select", { attrs: { id } }, ...[...new Set([...spec.choices!, ...(value ? [value] : [])])].map((v) => el("option", { text: spec.labels?.[v] ?? v, attrs: { value: v } })));
  select.value = value || spec.choices![0]!;
  return select;
}

export interface OptionsEditorOptions {
  args: string[];
  backend: string;
  /** The add button's id, so the row's label points at it. */
  id: string;
  /** What the list says when it is empty. */
  empty: string;
  /** Saves the list as argv tokens; the page draws the list again from what was saved. */
  save(tokens: string[]): Promise<void>;
  /** Where a list that cannot be saved says why. */
  status: HTMLElement;
}

/**
 * The options a CLI gets, one row each: picked from a menu of the options agentduo knows (with "Other flag…" for the
 * rest), each edited with a control of its own. A change saves the list at once. Values are separate argv tokens,
 * never shell-split.
 */
export function optionsEditor(o: OptionsEditorOptions): HTMLElement {
  const rows = argumentRows(o.args, o.backend);
  const specs = argumentOptions(o.backend);
  const list = el("div", { class: "option-list" });
  const addWrap = el("div", { class: "option-add" });
  const node = el("div", { class: "options-editor" }, list, addWrap);
  let draft: ArgumentRow | null = null;
  let closeMenu: (() => void) | null = null;

  const fail = (e: unknown) => {
    o.status.textContent = errorText(e);
    o.status.classList.add("error");
  };
  const commit = (next: ArgumentRow[]) => {
    let tokens: string[];
    try {
      tokens = argumentTokens(next, o.backend);
    } catch (e) {
      fail(e);
      return;
    }
    void o.save(tokens).catch(fail);
  };

  /** A row's control; `onChange` null: a draft's, which takes what is typed as it is typed (Add saves it). */
  const control = (row: ArgumentRow, controlId: string, onChange: (() => void) | null): HTMLElement => {
    const spec = specs.find((s) => s.id === row.option);
    const text = (input: HTMLInputElement, set: (v: string) => void) => {
      if (onChange) {
        commitOnChange(input, (v) => {
          set(v);
          onChange();
        });
      } else {
        input.addEventListener("input", () => set(input.value));
      }
    };
    if (spec?.switch) return el("span", { class: "option-on muted small", text: "On" });
    if (spec?.choices) {
      const select = choiceSelect(spec, row.value, controlId);
      row.value = select.value;
      select.addEventListener("change", () => {
        row.value = select.value;
        onChange?.();
      });
      return select;
    }
    if (spec) {
      const input = el("input", { attrs: { id: controlId, type: "text", spellcheck: "false", placeholder: spec.placeholder ?? "" } });
      input.value = row.value;
      text(input, (v) => (row.value = v));
      return input;
    }
    const flag = el("input", { class: "flag", attrs: { id: controlId, type: "text", spellcheck: "false", placeholder: "--flag", "aria-label": "Flag" } });
    const value = el("input", { attrs: { type: "text", spellcheck: "false", placeholder: "value", "aria-label": "Value (optional)" } });
    flag.value = row.flag ?? "";
    value.value = row.value;
    text(flag, (v) => (row.flag = v));
    text(value, (v) => (row.value = v));
    return el("span", { class: "flag-pair" }, flag, value);
  };

  const rowText = (row: ArgumentRow) => {
    const spec = specs.find((s) => s.id === row.option);
    return el("div", { class: "option-text" },
      el("span", { class: "option-label", text: spec?.label ?? "Other flag" }),
      el("span", { class: "option-desc", text: spec?.description ?? "Passed to the CLI as written." }));
  };

  const draw = () => {
    list.replaceChildren(...rows.map((row, index) => {
      const spec = specs.find((s) => s.id === row.option);
      const label = spec?.label ?? "Other flag";
      return el("div", { class: "option-row" }, rowText(row),
        el("div", { class: "option-control" }, control(row, `${o.id}-option-${index}`, () => commit(rows))),
        button("", () => commit(rows.filter((r) => r !== row)), { class: "icon-btn", icon: "close", title: `Remove ${label.toLowerCase()}` }));
    }));
    if (draft) {
      const row = draft;
      const controlId = `${o.id}-draft`;
      const add = () => commit([...rows, row]);
      const cancel = () => {
        draft = null;
        draw();
        node.querySelector<HTMLElement>(`#${o.id}`)?.focus();
      };
      const c = control(row, controlId, null);
      const draftRow = el("div", { class: "option-row draft" }, rowText(row), el("div", { class: "option-control" }, c),
        el("span", { class: "draft-actions" }, button("Add", add, { class: "small primary" }), button("Cancel", cancel, { class: "small ghost" })));
      draftRow.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          cancel();
        } else if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
          e.preventDefault();
          add();
        }
      });
      list.append(draftRow);
    } else if (!rows.length) {
      list.append(el("p", { class: "option-empty", text: o.empty }));
    }
    drawAdd();
  };

  const start = (spec: OptionSpec | null) => {
    closeMenu?.();
    if (spec?.switch) {
      commit([...rows, { option: spec.id, value: "" }]);
      return;
    }
    draft = spec ? { option: spec.id, value: spec.choices?.[0] ?? "" } : { option: null, flag: "", value: "" };
    draw();
    node.querySelector<HTMLElement>(`#${o.id}-draft`)?.focus();
  };

  const drawAdd = () => {
    const toggle = el("button", { class: "btn small add-toggle", attrs: { id: o.id, type: "button", "aria-haspopup": "menu", "aria-expanded": "false" } }, icon("add"), el("span", { text: "Add option" }));
    toggle.disabled = !!draft;
    const menu = el("div", { class: "add-menu", attrs: { role: "menu", "aria-label": "Options to add" } });
    menu.hidden = true;
    const items = [...addableOptions(rows, o.backend).map((s) => [s, s.label, s.description] as const), [null, "Other flag…", "Any other flag of the CLI, with its value if it takes one."] as const];
    for (const [spec, label, description] of items) {
      const item = el("button", { class: "add-item", attrs: { type: "button", role: "menuitem" } }, el("span", { class: "add-label", text: label }), el("span", { class: "add-desc", text: description }));
      item.addEventListener("click", () => start(spec));
      if (!spec) menu.append(el("div", { class: "add-sep", attrs: { role: "separator" } }));
      menu.append(item);
    }
    const outside = (e: MouseEvent) => {
      if (!addWrap.contains(e.target as Node)) close();
    };
    const close = () => {
      menu.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      document.removeEventListener("mousedown", outside, true);
      closeMenu = null;
    };
    const open = () => {
      menu.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      document.addEventListener("mousedown", outside, true);
      closeMenu = close;
      // Near the bottom of the page the menu opens upwards, when there is more room above.
      menu.classList.remove("up");
      const box = toggle.getBoundingClientRect();
      if (box.bottom + menu.offsetHeight + 8 > window.innerHeight && box.top > window.innerHeight - box.bottom) menu.classList.add("up");
      menu.querySelector<HTMLElement>(".add-item")?.focus({ preventScroll: true });
    };
    toggle.addEventListener("click", () => (menu.hidden ? open() : close()));
    menu.addEventListener("keydown", (e) => {
      const all = [...menu.querySelectorAll<HTMLElement>(".add-item")];
      const at = all.indexOf(document.activeElement as HTMLElement);
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        toggle.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        all[(at + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
      }
    });
    addWrap.replaceChildren(toggle, menu);
  };

  draw();
  return node;
}
