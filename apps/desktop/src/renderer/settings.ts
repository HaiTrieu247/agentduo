import { CONVERSATIONS_PROJECT_ID } from "../shared/protocol.js";
// Settings: the desktop's own preferences (theme, font size, who a message goes to), both CLIs' state, agentduo's
// configuration by layer (user config, the project's file, this session) with where each value comes from and when
// a change applies, where data lives (read-only), and diagnostics. Every change goes through main, which uses the
// same configuration code as the CLI; nothing here writes a file.
import type { ConfigEntry, ConfigurationView } from "../../../../src/core/configuration.js";
import { CLAUDE_MODELS, type ModelChoice } from "../../../../src/core/commands.js";
import type { AppSnapshot, CliStatus, ConfigScope, LauncherInfo, Preferences, UpdateState } from "../shared/protocol.js";
import { busy, button, call, el, errorText, icon, meter } from "./bridge.js";
import { FONT_RANGE } from "./theme.js";
import { commitOnChange, optionsEditor } from "./argumentOptions.js";
import { limitRows, updatedText, type AccountRow } from "../../../../extensions/vscode/webview/account.js";
import { providerMark } from "../../../../extensions/vscode/webview/dom.js";
import type { UsageState } from "../../../../src/core/usage.js";
import { updateAction, updateLine } from "./update.js";
import { USAGE_PERIOD_MS, USAGE_STALE_MS, type UsageStore } from "./usage.js";

export type SettingsSection = "general" | "agents" | "configuration" | "storage" | "diagnostics";
const SECTIONS: Array<[SettingsSection, string]> = [
  ["general", "General"], ["agents", "Claude & Codex"], ["configuration", "Configuration"], ["storage", "Data & storage"], ["diagnostics", "Diagnostics"],
];

export interface SettingsHost {
  snapshot(): AppSnapshot | null;
  setPrefs(patch: Partial<Preferences>): Promise<void>;
  /** Codex's models, as a chat's worker listed them (codex debug models); null until one has. */
  codexModels(): readonly ModelChoice[] | null;
  /** Both agents' accounts and limits, shared with the sidebar's Account & Usage box. */
  usage: UsageStore;
  /** The app's own update, as main last said it; checking, restarting into it, or downloading it from the release page. */
  update(): UpdateState;
  checkUpdate(): Promise<void>;
  installUpdate(): void;
  downloadUpdate(): void;
  close(): void;
}

const STATE_WORD: Record<CliStatus["state"], string> = {
  missing: "Not found", installed: "Installed", "signed-in": "Signed in", "signed-out": "Signed out", unknown: "Status unknown", error: "Error",
};
const STATE_CLASS: Record<CliStatus["state"], string> = { missing: "bad", installed: "ok", "signed-in": "ok", "signed-out": "warn", unknown: "warn", error: "bad" };

/** Who a CLI signs in as: its plan and email, as the usage lookup says them once it answered, else as its sign-in check did. */
export function cliAccount(c: Pick<CliStatus, "auth">, usage?: UsageState): { plan: string | null; email: string | null } {
  const u = usage?.status === "ready" ? usage.usage : null;
  return { plan: u?.account ?? c.auth?.plan ?? null, email: u?.email ?? c.auth?.email ?? null };
}

/** What a CLI's pill says: the email it signs in with (its kind of account until that is known), API, or its state. */
export function cliStateWord(c: Pick<CliStatus, "backend" | "state" | "auth">, usage?: UsageState): string {
  if (c.state !== "signed-in") return STATE_WORD[c.state];
  if (c.auth?.kind === "api") return "API";
  const { email } = cliAccount(c, usage);
  if (email) return email;
  if (!c.auth) return STATE_WORD[c.state];
  return c.backend === "claude" ? "Claude account" : "ChatGPT account";
}

/** A signed-in CLI's limits, as the VS Code extension's Account & Usage view shows them: a meter each, and when it resets. */
export function usageSection(usage: UsageState): HTMLElement {
  const rows: Node[] = usage.status === "loading" ? [el("p", { class: "muted small", text: "Loading usage…" })]
    : usage.status === "error" ? [el("p", { class: "small error", text: usage.error })]
    : limitRows(usage.usage).map(usageRow);
  if (!rows.length) rows.push(el("p", { class: "muted small", text: "No limits to show." }));
  return el("section", { class: "cli-usage", attrs: { "aria-label": "Usage" } }, el("h4", { class: "cli-usage-title", text: "Usage" }), ...rows);
}

function usageRow(r: AccountRow): HTMLElement {
  switch (r.kind) {
    case "limit":
      return el("div", { class: "usage-limit" }, el("span", { class: "usage-label", text: r.text, title: r.text }), el("span", { class: "usage-value", text: r.value ?? "" }));
    case "bar":
      return meter(r.text, r.percent ?? 0);
    case "group":
      return el("div", { class: "usage-group", text: r.text });
    case "error":
      return el("p", { class: "small error", text: r.text });
    case "text":
      return el("p", { class: "usage-note", text: r.text });
    default:
      return el("div", { class: "usage-resets", text: r.text });
  }
}

export interface CliCardOptions {
  pick(): void;
  install(): void;
  /** The usage lookup's answer for this CLI; absent: not looked up, so the card shows only what the check said. */
  usage?: UsageState;
  /** Its limits too (Settings), not only who it signs in as (the first run). */
  limits?: boolean;
}

export function cliCard(c: CliStatus, o: CliCardOptions): HTMLElement {
  const name = c.backend === "claude" ? "Claude Code" : "Codex";
  const signedIn = c.state === "signed-in";
  const who = cliAccount(c, o.usage);
  const plan = signedIn ? who.plan : null;
  return el("div", { class: "cli-card", attrs: { "data-backend": c.backend } },
    el("div", { class: "cli-head" },
      el("strong", { class: "cli-name" }, providerMark(c.backend), name),
      // Signed in: the email plainly, in the text colour; any other state is a coloured pill with its mark.
      el("span", { class: signedIn ? "pill account" : `pill ${STATE_CLASS[c.state]}`, text: cliStateWord(c, o.usage), title: (signedIn && who.email) || undefined })),
    el("dl", { class: "facts" },
      plan ? el("dt", { text: c.auth?.kind === "api" ? "Signs in with" : "Plan" }) : null, plan ? el("dd", { text: plan }) : null,
      el("dt", { text: "Binary" }), el("dd", {}, el("code", { text: c.configured }), el("span", { class: "muted", text: ` (${c.source})` })),
      el("dt", { text: "Found at" }), el("dd", {}, c.path ? el("code", { text: c.path }) : el("span", { class: "muted", text: "not found" })),
      el("dt", { text: "Version" }), el("dd", { text: c.version ?? "—" })),
    c.detail ? el("p", { class: `small ${STATE_CLASS[c.state]}-text`, text: c.detail }) : null,
    signedIn && o.limits && o.usage ? usageSection(o.usage) : null,
    el("div", { class: "row-actions" },
      button("Choose binary…", o.pick, { class: "small", icon: "file-binary" }),
      c.state === "missing" ? button("How to install", o.install, { class: "small", icon: "link-external" }) : null));
}

export function launcherNote(l: LauncherInfo): HTMLElement {
  return el("p", { class: "muted small" }, `PATH for the agents: ${l.entries} entries, from ${l.sources.join(", ") || "the app's own"}.`,
    l.shellProblem ? el("span", { class: "warn-text", text: ` The login shell did not answer: ${l.shellProblem}` }) : null);
}

export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.length ? v.join(" ") : "(none)";
  if (typeof v === "boolean") return v ? "on" : "off";
  return String(v);
}

export type EditorKind = "number" | "list" | "text" | "choice";

/** The values a choice setting takes, as config validation allows them. */
export const CHOICES: Partial<Record<ConfigEntry["kind"], readonly string[]>> = { prompts: ["ask", "deny"], backend: ["codex", "claude"] };

/** What an entry's editor holds, as the value to save, by the editor its kind has; empty is null where null is allowed. */
export function parseEditorValue(kind: EditorKind, raw: string, nullable: boolean): unknown {
  if (kind === "list") return raw.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!raw.trim() && nullable) return null;
  if (kind === "number") {
    const n = Number(raw);
    if (!raw.trim() || !Number.isFinite(n)) throw new Error("not a number");
    return n;
  }
  return raw;
}

/** The editor of an entry, by what its value is (never by the value it has now: a budget is null until it is set). */
export function editorKind(e: Pick<ConfigEntry, "kind">): EditorKind {
  switch (e.kind) {
    case "args":
      return "list";
    case "budget":
    case "positive":
    case "count":
      return "number";
    case "prompts":
    case "backend":
      return "choice";
    case "bin":
    case "model":
      return "text";
  }
}

export function groupOf(key: string): string {
  const head = key.split(".")[0]!;
  return ["claude", "codex", "agents", "limits"].includes(head) ? head : "other";
}

/** Labels describe tasks; config keys remain available in the label's tooltip. */
export function settingLabel(key: string): string {
  const parts = key.split(".");
  if (parts[1] === "role_args") return `${words(parts[2]!)} options`;
  if (parts[0] === "agents") return words(parts[1]!);
  const labels: Record<string, string> = {
    bin: "CLI executable", model: "Model", args: "Options", max_budget_usd: "Budget per call", permission_prompts: "Permission requests",
    max_planning_rounds: "Planning rounds", max_review_rounds: "Review rounds", max_discussion_rounds: "Discussion rounds",
    max_retries: "Retries", max_consecutive_gate_failures: "Failed checks in a row", agent_timeout_sec: "Agent timeout",
    agent_idle_timeout_sec: "Idle timeout", gate_timeout_sec: "Check timeout", max_diff_chars: "Diff size", max_gate_output_chars: "Check output size",
  };
  return labels[parts[1]!] ?? words(parts.at(-1)!);
}

/** What a setting does, under its label. */
export function settingHelp(key: string): string {
  const [head, name, role] = key.split(".") as [string, string, string | undefined];
  const cli = head === "claude" ? "Claude Code" : "Codex";
  if (name === "role_args") return `Added after the options above when ${cli} is the ${words(role!).toLowerCase()}.`;
  const help: Record<string, string> = {
    "claude.model": "Default leaves it to Claude Code's own setting.",
    "codex.model": "Default leaves it to Codex's own setting (~/.codex/config.toml).",
    "claude.permission_prompts": "When Claude needs approval for a tool: ask you in the chat, or deny it.",
    "claude.max_budget_usd": "The most one Claude call may spend. Empty: no limit.",
    "agents.planner": "Writes the plan.",
    "agents.plan_reviewer": "Critiques the plan.",
    "agents.implementer": "Makes the changes.",
    "agents.code_reviewer": "Reviews the changes.",
    "limits.max_planning_rounds": "Plan and critique rounds before the run asks you.",
    "limits.max_review_rounds": "Fix and review rounds before the run asks you.",
    "limits.max_discussion_rounds": "Reviews in a /discuss before Codex sums it up.",
    "limits.max_retries": "Retries of an agent call that failed.",
    "limits.max_consecutive_gate_failures": "Rounds with failing checks before the run asks you.",
    "limits.agent_timeout_sec": "The longest one agent call may take.",
    "limits.agent_idle_timeout_sec": "Stops an agent that prints nothing for this long. 0: never.",
    "limits.gate_timeout_sec": "The longest one check may take.",
    "limits.max_diff_chars": "How much of the diff a reviewer is shown.",
    "limits.max_gate_output_chars": "How much of a check's output the agents are shown.",
  };
  if (name === "bin") return `The command or path AgentDuo runs for ${cli}.`;
  if (name === "args") return `Added to every ${cli} call. Pick them from the list; AgentDuo writes the flags.`;
  return help[key] ?? "";
}

/** The unit after a number's field. */
export function settingUnit(key: string): string {
  if (key.endsWith("_sec")) return "seconds";
  if (key.endsWith("_chars")) return "characters";
  if (key.endsWith("_usd")) return "USD";
  return "";
}

/** Where the value in effect comes from, in words; null for a default. */
export function sourceText(e: Pick<ConfigEntry, "source" | "projectOverridesGlobal">, scope: ConfigScope): { text: string; warn: boolean } | null {
  if (scope === "global" && e.projectOverridesGlobal && e.source === "project") return { text: "This project sets its own value, which wins here.", warn: true };
  const from: Record<ConfigEntry["source"], string | null> = { default: null, global: "Set for all projects", project: "Set for this project", session: "Set until the app closes" };
  const text = from[e.source];
  return text ? { text, warn: false } : null;
}

/** A model picker's choices: Default, the models the CLI lists, and the model set now even when it is not among them. */
export function modelChoices(listed: readonly ModelChoice[], current: string | null): Array<{ value: string; label: string }> {
  return [
    { value: DEFAULT_MODEL, label: "Default" },
    ...(current && !listed.some((m) => m.id === current) ? [{ value: current, label: current }] : []),
    ...listed.map((m) => ({ value: m.id, label: m.label })),
    { value: OTHER_MODEL, label: "Other model…" },
  ];
}
const DEFAULT_MODEL = "";
const OTHER_MODEL = "\u0000other";

function words(value: string): string {
  const text = value.replaceAll("_", " ");
  return text[0]!.toUpperCase() + text.slice(1);
}

const controlId = (key: string) => `cfg-${key.replace(/[^a-z0-9]/gi, "-")}`;

const GROUPS: Array<{ id: string; title: string; description: string; cards: Array<{ title: string | null; keys: string[] }> }> = [
  {
    id: "claude", title: "Claude Code", description: "How AgentDuo runs Claude Code. A change reaches its next call, also in a pipeline that is running.",
    cards: [{ title: null, keys: ["claude.model", "claude.permission_prompts", "claude.max_budget_usd"] }, { title: null, keys: ["claude.args"] }],
  },
  {
    id: "codex", title: "Codex", description: "How AgentDuo runs Codex. A change reaches its next call, also in a pipeline that is running.",
    cards: [{ title: null, keys: ["codex.model"] }, { title: null, keys: ["codex.args"] }],
  },
  { id: "agents", title: "Workflow roles", description: "Who handles each step of a pipeline. A change applies to new runs and discussions.", cards: [{ title: null, keys: [] }] },
  {
    id: "limits", title: "Rounds & limits", description: "How many rounds the agents take and how long they may work. A change applies to new work.",
    cards: [
      { title: "Rounds", keys: ["limits.max_planning_rounds", "limits.max_review_rounds", "limits.max_discussion_rounds", "limits.max_retries", "limits.max_consecutive_gate_failures"] },
      { title: "Time", keys: ["limits.agent_timeout_sec", "limits.agent_idle_timeout_sec", "limits.gate_timeout_sec"] },
      { title: "Size", keys: ["limits.max_diff_chars", "limits.max_gate_output_chars"] },
    ],
  },
];

const SCOPE_HELP: Record<ConfigScope, string> = {
  global: "Your defaults for every project and for conversations outside one.",
  project: "Only this project; its values win over your all-project defaults.",
  session: "Only this project's open conversations, until the app closes.",
};

export class SettingsPanel {
  private section: SettingsSection = "general";
  private scope: ConfigScope = "global";
  private configGroup = "claude";
  private advancedOpen = false;
  private view: ConfigurationView | null = null;
  private updateCard: HTMLElement | null = null;
  private readonly nav = el("nav", { class: "settings-nav", attrs: { "aria-label": "Settings sections" } });
  private readonly body = el("div", { class: "settings-body" });
  private readonly notices = el("div", { class: "notices" });

  constructor(private readonly root: HTMLElement, private readonly host: SettingsHost) {
    const side = el("aside", { class: "settings-side" }, el("div", { class: "settings-drag" }), el("h2", { class: "settings-title", text: "Settings" }), this.nav);
    const head = el("header", { class: "settings-head" }, el("span", { class: "spacer" }), button("Done", () => host.close(), { class: "primary small", icon: "check" }));
    root.replaceChildren(el("div", { class: "settings-main" }, side, el("div", { class: "settings-pane" }, head, this.body)));
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") host.close();
    });
  }

  private projectId(): string | null {
    const id = this.host.snapshot()?.active.projectId ?? null;
    return id === CONVERSATIONS_PROJECT_ID ? null : id;
  }

  open(section: SettingsSection = this.section): void {
    this.section = section;
    if (!this.projectId() && this.scope !== "global") this.scope = "global";
    this.nav.replaceChildren(...SECTIONS.map(([id, label]) => {
      const b = el("button", { class: `settings-tab${id === this.section ? " active" : ""}`, text: label, attrs: { type: "button", "aria-current": id === this.section ? "page" : null } });
      b.addEventListener("click", () => this.open(id));
      return b;
    }));
    void this.draw();
  }

  private page(nodes: Node[]): HTMLElement {
    const title = SECTIONS.find(([id]) => id === this.section)![1];
    return el("div", { class: "settings-page" }, el("h1", { class: "page-title", text: title }), ...nodes);
  }

  private async draw(): Promise<void> {
    this.body.replaceChildren(this.page([el("p", { class: "muted", text: "Loading…" })]));
    try {
      const nodes = await this[this.section]();
      this.body.replaceChildren(this.page(nodes));
    } catch (e) {
      this.body.replaceChildren(this.page([el("p", { class: "error", text: errorText(e) })]));
    }
  }

  // ------------------------------------------------------------------ general
  private async general(): Promise<Node[]> {
    const prefs = this.host.snapshot()?.prefs;
    if (!prefs) return [el("p", { class: "muted", text: "Loading…" })];
    const status = el("p", { class: "small status-line", attrs: { role: "status" } });
    const theme = el("select", { attrs: { id: "pref-theme" } }, ...(["system", "light", "dark"] as const).map((t) => {
      const o = el("option", { text: t === "system" ? "As the system" : t === "light" ? "Light" : "Dark", attrs: { value: t } });
      o.selected = prefs.theme === t;
      return o;
    }));
    theme.addEventListener("change", () => void busy(null, status, () => this.host.setPrefs({ theme: theme.value as Preferences["theme"] })));
    const size = el("input", { attrs: { id: "pref-font", type: "range", min: String(FONT_RANGE.min), max: String(FONT_RANGE.max), step: "1" } });
    size.value = String(prefs.fontSize);
    const sizeLabel = el("span", { class: "muted", text: `${prefs.fontSize}px` });
    size.addEventListener("input", () => (sizeLabel.textContent = `${size.value}px`));
    size.addEventListener("change", () => void busy(null, status, () => this.host.setPrefs({ fontSize: Number(size.value) })));
    const recipient = el("select", { attrs: { id: "pref-recipient" } }, ...(["codex", "claude"] as const).map((b) => {
      const o = el("option", { text: b === "codex" ? "Codex" : "Claude Code", attrs: { value: b } });
      o.selected = prefs.defaultRecipient === b;
      return o;
    }));
    recipient.addEventListener("change", () => void busy(null, status, () => this.host.setPrefs({ defaultRecipient: recipient.value as Preferences["defaultRecipient"] })));
    this.updateCard = card(this.updateRows());
    return [
      el("h3", { text: "Appearance" }),
      card([row("Theme", "pref-theme", theme), row("Font size", "pref-font", el("span", { class: "inline" }, size, sizeLabel))]),
      el("h3", { text: "Conversations" }),
      card([row("New messages go to", "pref-recipient", recipient, "Who answers a new conversation's messages. Who plans, implements and reviews is under Configuration → Workflow roles.")]),
      el("p", { class: "muted small", text: "Each conversation's model, effort and Claude's permission mode are also in its chat: the gear above the composer (as /claude, /codex and /mode)." }),
      el("h3", { text: "Updates" }),
      this.updateCard,
      status,
    ];
  }

  /** The Updates card, drawn again at each step main says (checking, downloading, ready…) while it is in the page. */
  updateChanged(): void {
    if (this.updateCard?.isConnected) this.updateCard.replaceChildren(...this.updateRows());
  }

  private updateRows(): HTMLElement[] {
    const s = this.host.update();
    const prefs = this.host.snapshot()?.prefs;
    let control: HTMLElement = el("span");
    switch (updateAction(s)) {
      case "install":
        control = button("Restart to update", () => this.host.installUpdate(), { class: "primary small", icon: "debug-restart" });
        break;
      case "download":
        control = button("Download", () => this.host.downloadUpdate(), { class: "primary small", icon: "cloud-download" });
        break;
      case "check": {
        const b = button("Check now", () => {
          b.disabled = true;
          void this.host.checkUpdate().finally(() => (b.disabled = false));
        }, { class: "small", icon: "refresh", disabled: s.status === "checking" || s.status === "downloading" });
        control = b;
        break;
      }
    }
    // Not a <label for> the button: the button keeps its own name (Check now, Download, Restart to update).
    const version = el("div", { class: "setting-row update-row", attrs: { "data-status": s.status } },
      el("div", { class: "setting-text" }, el("span", { class: "setting-label", text: `AgentDuo ${this.host.snapshot()?.versions.app ?? ""}`.trim() }),
        el("p", { class: "setting-help", text: updateLine(s), attrs: { role: "status" } })),
      el("div", { class: "setting-control" }, control));
    if (s.status === "off" || !prefs) return [version];
    const auto = el("input", { attrs: { id: "pref-auto-update", type: "checkbox" } });
    auto.checked = prefs.autoUpdate;
    auto.addEventListener("change", () => void this.host.setPrefs({ autoUpdate: auto.checked }).catch(() => (auto.checked = !auto.checked)));
    return [version, row("Check for updates automatically", "pref-auto-update", auto, "When AgentDuo starts, then every few hours.")];
  }

  // ------------------------------------------------------------------ agents
  /** Both agents' cards, with their accounts and limits as this project's config (the user config with none) finds them. */
  private async agents(): Promise<Node[]> {
    const projectId = this.projectId();
    const store = this.host.usage;
    const out = el("div", { class: "cli-grid" });
    const status = el("p", { class: "small status-line", attrs: { role: "status" } });
    const updated = el("span", { class: "muted small" });
    let r: { clis: CliStatus[]; launcher: LauncherInfo } | null = null;
    const draw = () => {
      if (!r) return;
      const usage = store.of(projectId);
      const looking = store.looking(projectId);
      out.replaceChildren(...r.clis.map((c) => cliCard(c, {
        pick: () => void busy(null, status, async () => {
          const next = await call({ method: "cli.pick", backend: c.backend });
          if (next) r = next;
          draw();
        }),
        install: () => void call({ method: "link.open", link: c.backend === "claude" ? "claude-install" : "codex-install" }).catch(() => undefined),
        usage: usage?.value[c.backend] ?? { status: "loading" }, limits: true,
      })), launcherNote(r.launcher));
      updated.textContent = looking ? (usage ? "Updating usage…" : "Looking up usage…") : usage ? updatedText(usage.at, Date.now()) : "";
    };
    r = await call({ method: "cli.status", projectId });
    // A lookup from here or from the sidebar draws the cards again while they are in the page.
    const off = store.subscribe(() => {
      if (out.isConnected) draw();
    });
    void store.ensure(projectId, USAGE_STALE_MS);
    draw();
    // While the page shows: "Updated 3 min ago" keeps its age, and the numbers are looked up again every 5 minutes.
    const tick = window.setInterval(() => {
      if (!updated.isConnected) {
        off();
        return window.clearInterval(tick);
      }
      if (!this.root.hidden && !document.hidden) void store.ensure(projectId, USAGE_PERIOD_MS);
      draw();
    }, 30_000);
    const recheck = button("Recheck", () => void busy(recheck, status, async () => {
      const [next] = await Promise.all([call({ method: "cli.status", projectId }), store.refresh(projectId)]);
      r = next;
      draw();
    }), { class: "small", icon: "refresh" });
    return [
      el("p", { class: "muted", text: "AgentDuo runs both CLIs you installed and signed in to. Signing in happens in a terminal: run `claude` and type /login, and run `codex login`." }),
      out, el("div", { class: "row-actions" }, recheck, updated), status,
    ];
  }

  // ------------------------------------------------------------------ configuration
  private async configuration(): Promise<Node[]> {
    this.view = await call({ method: "settings.read", projectId: this.projectId() });
    return this.drawConfiguration();
  }

  private drawConfiguration(): Node[] {
    const view = this.view!;
    const projectId = this.projectId();
    const scopes = el("div", { class: "segmented", attrs: { role: "radiogroup", "aria-label": "Where a change is saved" } });
    for (const [s, label, enabled] of [["global", "All projects", true], ["project", "This project", !!projectId], ["session", "Until app closes", !!projectId]] as const) {
      const b = el("button", { class: `seg${this.scope === s ? " active" : ""}`, text: label, attrs: { type: "button", role: "radio", "aria-checked": String(this.scope === s) } });
      b.disabled = !enabled;
      if (!enabled) b.title = "Open a project first";
      b.addEventListener("click", () => {
        this.scope = s;
        this.redraw();
      });
      scopes.append(b);
    }
    const scopeCard = el("div", { class: "scope-card" },
      el("div", { class: "scope-text" }, el("strong", { text: "Apply changes to" }), el("p", { class: "muted small", text: SCOPE_HELP[this.scope] })), scopes);
    this.drawNotices();

    const groups = GROUPS.filter((g) => view.entries.some((e) => groupOf(e.key) === g.id));
    if (!groups.some((g) => g.id === this.configGroup)) this.configGroup = groups[0]?.id ?? "claude";
    const tabs = el("div", { class: "config-tabs", attrs: { role: "tablist", "aria-label": "Configuration groups" } }, ...groups.map((g) => {
      const tab = el("button", { class: `config-tab${this.configGroup === g.id ? " active" : ""}`, text: g.title, attrs: { type: "button", role: "tab", "aria-selected": String(this.configGroup === g.id) } });
      tab.addEventListener("click", () => {
        this.configGroup = g.id;
        this.redraw();
      });
      return tab;
    }));
    const files = view.files.map((f) => el("div", { class: `setting-row file-row${f.error ? " bad" : ""}` },
      el("div", { class: "setting-text" },
        el("span", { class: "setting-label", text: f.scope === "global" ? "All projects (user config)" : "This project" }),
        el("code", { class: "setting-help", text: `${f.path}${f.exists ? "" : " (not created yet)"}` })),
      el("div", { class: "setting-control" }, button("Open file", () => void call({ method: "settings.openFile", projectId, scope: f.scope }).catch(() => undefined), { class: "small", icon: "go-to-file" }))));
    return [
      el("p", { class: "muted", text: "How AgentDuo runs Claude Code and Codex, and how a pipeline goes. Every change saves at once." }),
      scopeCard, this.notices, tabs, this.groupContent(), el("h3", { text: "Configuration files" }), card(files),
    ];
  }

  /** The configuration page drawn again (another scope, another group), where it was scrolled to. */
  private redraw(): void {
    const top = this.body.scrollTop;
    this.body.replaceChildren(this.page(this.drawConfiguration()));
    this.body.scrollTop = top;
  }

  private drawNotices(): void {
    const view = this.view!;
    const nodes: Node[] = [];
    if (view.lockedBy) nodes.push(el("p", { class: "notice warn-text", text: `Process ${view.lockedBy} holds this workspace; it reads changes after it restarts.` }));
    for (const f of view.files) {
      if (f.error) nodes.push(el("p", { class: "notice error", text: `${f.path} is not valid YAML${f.error.line ? ` at line ${f.error.line}${f.error.col ? `, column ${f.error.col}` : ""}` : ""}: ${f.error.message}. Settings leaves it alone; fix it in the file, then reopen this section.` }));
    }
    for (const e of view.errors.filter((x) => !view.entries.some((entry) => entry.errors.includes(x)))) nodes.push(el("p", { class: "error small", text: e }));
    for (const w of view.warnings) nodes.push(el("p", { class: "warn-text small", text: w }));
    this.notices.replaceChildren(...nodes);
  }

  private groupContent(): HTMLElement {
    const view = this.view!;
    const group = GROUPS.find((g) => g.id === this.configGroup)!;
    const entries = view.entries.filter((e) => groupOf(e.key) === group.id);
    const placed = new Set(group.cards.flatMap((c) => c.keys));
    const advanced = entries.filter((e) => e.kind === "bin" || e.key.includes(".role_args."));
    const rest = entries.filter((e) => !placed.has(e.key) && !advanced.includes(e));
    const cards = group.cards.map((c, i) => {
      const keys = [...c.keys, ...(i === group.cards.length - 1 ? rest.map((e) => e.key) : [])];
      const rows = keys.map((k) => entries.find((e) => e.key === k)).filter((e): e is ConfigEntry => !!e).map((e) => this.settingRow(e));
      return rows.length ? [c.title ? el("h3", { text: c.title }) : null, card(rows)] : [];
    }).flat().filter((n): n is HTMLElement => !!n);
    const nodes: Node[] = [el("p", { class: "muted small group-lead", text: group.description }), ...cards];
    if (advanced.length) {
      const details = el("details", { class: "advanced" }, el("summary", { text: "Advanced: executable and options by role" }), card(advanced.map((e) => this.settingRow(e))));
      details.open = this.advancedOpen;
      details.addEventListener("toggle", () => (this.advancedOpen = details.open));
      nodes.push(details);
    }
    return el("section", { class: "config-content", attrs: { role: "tabpanel" } }, ...nodes);
  }

  private settingRow(e: ConfigEntry): HTMLElement {
    const projectId = this.projectId();
    const scope = this.scope;
    const id = controlId(e.key);
    const own = e[scope];
    const current = own ? own.value : e.effective;
    const status = el("p", { class: "small setting-status", attrs: { role: "status" } });
    const save = (value: unknown) => void this.change(e.key, status, () => call({ method: "settings.update", projectId, scope, key: e.key, value }));
    const reset = own ? button("Reset", () => void this.change(e.key, status, () => call({ method: "settings.clear", projectId, scope, key: e.key })), {
      class: "small ghost reset", icon: "discard", title: scope === "session" ? "Drop this session's own value" : "Remove it here and inherit again",
    }) : null;
    const wide = e.kind === "args";
    const help = settingHelp(e.key);
    const source = sourceText(e, scope);
    const control = wide
      ? optionsEditor({
        args: Array.isArray(current) ? (current as string[]) : [], backend: e.key.split(".")[0]!, id, status,
        empty: e.key.includes(".role_args.") ? "No options of its own." : "No options added: the CLI uses its own defaults.",
        save: async (tokens) => save(tokens),
      })
      : this.control(e, id, current, save, status);
    return el("div", { class: `setting-row${wide ? " wide" : ""}${e.errors.length ? " bad" : ""}`, attrs: { "data-key": e.key } },
      el("div", { class: "setting-text" },
        el("label", { class: "setting-label", text: settingLabel(e.key), title: e.key, attrs: { for: id } }),
        help ? el("p", { class: "setting-help", text: help }) : null,
        source ? el("p", { class: `setting-source${source.warn ? " warn-text" : ""}`, text: source.text }) : null),
      ...(wide ? [el("div", { class: "setting-actions" }, reset), el("div", { class: "setting-control" }, control)] : [el("div", { class: "setting-control" }, control, reset)]),
      ...e.errors.map((x) => el("p", { class: "error small setting-error", text: x })),
      status);
  }

  private control(e: ConfigEntry, id: string, current: unknown, save: (value: unknown) => void, status: HTMLElement): HTMLElement {
    const kind = editorKind(e);
    const nullable = e.defaultValue === null || e.removable;
    const fail = (x: unknown) => {
      status.textContent = errorText(x);
      status.classList.add("error");
    };
    if (e.kind === "model") return this.modelControl(e, id, typeof current === "string" ? current : null, save);
    if (kind === "choice") {
      const words: Record<string, string> = { ask: "Ask me", deny: "Deny automatically", claude: "Claude Code", codex: "Codex" };
      const select = el("select", { attrs: { id } }, ...(CHOICES[e.kind] ?? []).map((c) => el("option", { text: words[c] ?? c, attrs: { value: c } })));
      select.value = String(current);
      select.addEventListener("change", () => save(select.value));
      return select;
    }
    const input = el("input", {
      class: kind === "number" ? "num" : "text", attrs: {
        id, type: kind === "number" ? "number" : "text", spellcheck: "false", placeholder: e.kind === "budget" ? "No limit" : nullable ? "(none)" : "",
        ...(kind === "number" ? { step: e.kind === "budget" ? "any" : "1", min: e.kind === "positive" ? "1" : "0" } : {}),
      },
    });
    input.value = current === null || current === undefined ? "" : String(current);
    commitOnChange(input, (raw) => {
      try {
        save(parseEditorValue(kind, raw, nullable));
      } catch (x) {
        fail(x);
      }
    });
    const unit = settingUnit(e.key);
    return unit ? el("span", { class: "inline" }, input, el("span", { class: "muted small", text: unit })) : input;
  }

  private modelControl(e: ConfigEntry, id: string, current: string | null, save: (value: unknown) => void): HTMLElement {
    const backend = e.key.split(".")[0];
    const listed = backend === "claude" ? CLAUDE_MODELS : this.host.codexModels() ?? [];
    const select = el("select", { attrs: { id } }, ...modelChoices(listed, current).map((c) => el("option", { text: c.label, attrs: { value: c.value } })));
    select.value = current ?? DEFAULT_MODEL;
    const custom = el("input", { class: "text", attrs: { id: `${id}-custom`, type: "text", spellcheck: "false", placeholder: "Model name", "aria-label": "Model name" } });
    custom.hidden = true;
    commitOnChange(custom, (v) => {
      if (v.trim()) save(v.trim());
    });
    select.addEventListener("change", () => {
      if (select.value === OTHER_MODEL) {
        custom.hidden = false;
        custom.focus();
        return;
      }
      custom.hidden = true;
      save(select.value === DEFAULT_MODEL ? null : select.value);
    });
    const note = backend === "codex" && !listed.length ? el("span", { class: "muted small", text: "Codex's models show here once a chat has listed them." }) : null;
    return el("span", { class: "model-picker" }, select, custom, note);
  }

  /** Saves a change, then draws that setting's row again from what was saved; focus stays where it was. */
  private async change(key: string, status: HTMLElement, work: () => Promise<ConfigurationView>): Promise<void> {
    status.textContent = "";
    status.classList.remove("error");
    try {
      this.view = await work();
    } catch (e) {
      status.textContent = errorText(e);
      status.classList.add("error");
      return;
    }
    const old = this.body.querySelector<HTMLElement>(`.setting-row[data-key="${CSS.escape(key)}"]`);
    const entry = this.view.entries.find((e) => e.key === key);
    this.drawNotices();
    if (!old || !entry) return;
    const focused = old.contains(document.activeElement) ? document.activeElement?.id || null : null;
    const next = this.settingRow(entry);
    old.replaceWith(next);
    const saved = next.querySelector<HTMLElement>(".setting-status")!;
    saved.textContent = "Saved";
    saved.classList.add("ok-text");
    setTimeout(() => {
      if (saved.textContent === "Saved") saved.textContent = "";
    }, 1800);
    (focused ? next.querySelector<HTMLElement>(`#${CSS.escape(focused)}`) : null)?.focus();
  }

  // ------------------------------------------------------------------ storage
  private async storage(): Promise<Node[]> {
    const projectId = this.projectId();
    const snap = this.host.snapshot();
    const view = await call({ method: "settings.read", projectId }).catch(() => null);
    const status = el("p", { class: "small status-line", attrs: { role: "status" } });
    const open = (folder: "runs" | "userData" | "logs" | "project") => () => void busy(null, status, async () => void (await call({ method: "folder.open", projectId, folder })));
    return [
      el("h3", { text: "Where data lives" }),
      el("dl", { class: "facts" },
        el("dt", { text: "Runs and conversations" }), el("dd", {}, el("code", { text: view?.storage.runsDir ?? (projectId ? "unknown" : "open a project") }),
          view ? el("span", { class: "muted", text: ` (paths.runs_dir = ${view.storage.value}, from ${view.storage.source})` }) : null),
        el("dt", { text: "Desktop data" }), el("dd", {}, el("code", { text: snap?.userData ?? "" }))),
      el("div", { class: "row-actions" },
        button("Open runs folder", open("runs"), { class: "small", icon: "folder-opened", disabled: !projectId }),
        button("Open desktop data", open("userData"), { class: "small", icon: "folder-opened" }),
        button("Open logs", open("logs"), { class: "small", icon: "output" })),
      el("p", { class: "muted small", text: "The runs folder also holds the workspace lock, so it is not changed from here. To move it, close agentduo (and any duo in that folder), set paths.runs_dir in the project's .agentduo/config.yaml, and open the project again." }),
      status,
    ];
  }

  // ------------------------------------------------------------------ diagnostics
  private async diagnostics(): Promise<Node[]> {
    const projectId = this.projectId();
    const status = el("p", { class: "small status-line", attrs: { role: "status" } });
    const checks = el("ul", { class: "checks", attrs: { role: "list" } });
    const doctor = button("Run checks", () => void busy(doctor, status, async () => {
      if (!projectId) throw new Error("Open a project to check it.");
      const r = await call({ method: "doctor.run", projectId });
      checks.replaceChildren(...r.checks.map((c) => el("li", { class: c.ok ? "ok-text" : c.required ? "error" : "warn-text" },
        icon(c.ok ? "pass" : c.required ? "error" : "warning"), el("span", { text: ` ${c.ok ? "OK" : c.required ? "Failed" : "Warning"}: ${c.message}` }))));
    }), { class: "small", icon: "checklist", disabled: !projectId });
    const usage = el("div", { class: "usage-box small" });
    const usageBtn = button("Account & usage", () => void busy(usageBtn, status, async () => {
      const u = await call({ method: "account.usage", projectId });
      usage.replaceChildren(...(["claude", "codex"] as const).map((b) => {
        const s = u[b];
        const text = s.status === "ready" ? JSON.stringify(s.usage, null, 2) : s.status === "error" ? `error: ${s.error}` : "loading";
        return el("div", {}, el("strong", { text: b === "claude" ? "Claude Code" : "Codex" }), el("pre", { class: "doc", text }));
      }));
    }), { class: "small", icon: "account" });
    const preview = el("pre", { class: "doc diag", text: "" });
    const collect = button("Preview diagnostics", () => void busy(collect, status, async () => {
      preview.textContent = (await call({ method: "diagnostics.collect", projectId })).text;
    }), { class: "small", icon: "eye" });
    const exportBtn = button("Export…", () => void busy(exportBtn, status, async () => {
      const r = await call({ method: "diagnostics.export", projectId });
      if (r) status.textContent = `Saved ${r.file}`;
    }), { class: "small", icon: "save" });
    return [
      el("h3", { text: "Checks" }), el("p", { class: "muted small", text: "duo doctor for the active project: both CLIs, their flags, git. No model is called." }), doctor, checks,
      el("h3", { text: "Accounts" }), usageBtn, usage,
      el("h3", { text: "Diagnostics" }),
      el("p", { class: "muted small", text: "What the export holds is shown first: versions, paths, the CLI checks and the app's log. No credentials, prompts or attachments." }),
      el("div", { class: "row-actions" }, collect, exportBtn), preview, status,
    ];
  }
}

/** Settings rows in one bordered group. */
function card(rows: HTMLElement[]): HTMLElement {
  return el("div", { class: "settings-card" }, ...rows);
}

function row(label: string, id: string, control: HTMLElement, help?: string): HTMLElement {
  return el("div", { class: "setting-row" },
    el("div", { class: "setting-text" }, el("label", { class: "setting-label", text: label, attrs: { for: id } }), help ? el("p", { class: "setting-help", text: help }) : null),
    el("div", { class: "setting-control" }, control));
}
