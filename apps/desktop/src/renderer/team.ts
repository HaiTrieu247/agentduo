// Settings → Team: one list of who is in the team, grouped as the team runs (the head PM, then each group), with what
// each member runs on; one form adds or changes a member (its role, level, CLI, model, group and how many), and makes a
// new role, level or group on the way; each member's row opens its role's, its level's and its own identity text.
// Everything is saved through main, which checks the team can start before it writes the configuration, and names
// identity files by kind and name only.
import { CLAUDE_EFFORTS, CLAUDE_MODELS, CODEX_EFFORTS, type ModelChoice } from "@agentduo/engine/chat/commands";
import type { TeamEdit } from "@agentduo/engine/config/configuration";
import { memberNames, TEAM_DEFAULTS, teamConfigErrors, type RoleKind } from "@agentduo/engine/team/config";
import type { TeamIdentityFile } from "@agentduo/engine/team/model";
import { busy, button, call, el, icon } from "./bridge.js";

type Scope = "global" | "project";
type Entry = TeamEdit["members"][number];
type Cli = Entry["cli"];
type IdentityKind = TeamIdentityFile["kind"];

const KINDS: readonly RoleKind[] = ["pm", "lead", "worker", "checker"];
const KIND_TAG: Record<RoleKind, string> = { pm: "PM", lead: "Lead", worker: "Dev", checker: "Test" };
const KIND_WORD: Record<RoleKind, string> = { pm: "talks with you", lead: "plans, reviews and merges", worker: "takes tasks", checker: "tests tasks" };
const CLI_WORD: Record<Cli, string> = { claude: "Claude", codex: "Codex" };
const SCOPE_WORD: Record<Scope, string> = { global: "Every project", project: "This project" };
const SOURCE_WORD: Record<string, string> = {
  project: "this project's file", global: "your file for every project", default: "agentduo's text (no file yet)", none: "empty (no file yet)",
};
const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const NAME_RULE = "lowercase letters, digits, '-' or '_', starting with a letter or digit";
/** The value of a menu's "New …" option: never a name, which starts with a letter or digit. */
const NEW = "+new";
/** The model menu's "Other model…": never a model name, which has no control characters. */
const OTHER_MODEL = "\u0000other";
const effortsOf = (cli: Cli): readonly string[] => (cli === "codex" ? CODEX_EFFORTS : CLAUDE_EFFORTS);
const joinAnd = (xs: string[]): string => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

function select(options: Array<[string, string]>, value: string, onChange: (v: string) => void, label: string, cls?: string): HTMLSelectElement {
  const s = el("select", { class: cls, attrs: { "aria-label": label } }, ...options.map(([v, text]) => {
    const o = el("option", { text, attrs: { value: v } });
    o.selected = v === value;
    return o;
  }));
  s.addEventListener("change", () => onChange(s.value));
  return s;
}

function input(value: string, onChange: (v: string) => void, label: string, o: { placeholder?: string; type?: string; class?: string } = {}): HTMLInputElement {
  const i = el("input", { class: o.class, attrs: { type: o.type ?? "text", "aria-label": label, placeholder: o.placeholder ?? "" } });
  i.value = value;
  i.addEventListener("input", () => onChange(i.value));
  return i;
}

function checkbox(checked: boolean, onChange: (v: boolean) => void, label: string, text: string): HTMLLabelElement {
  const box = el("input", { attrs: { type: "checkbox", "aria-label": label } });
  box.checked = checked;
  box.addEventListener("change", () => onChange(box.checked));
  return el("label", { class: "check-label" }, box, el("span", { text }));
}

function segmented(options: Array<[string, string]>, value: string, onChange: (v: string) => void, label: string): HTMLElement {
  return el("div", { class: "segmented", attrs: { role: "radiogroup", "aria-label": label } }, ...options.map(([v, text]) => {
    const b = el("button", { class: `seg${v === value ? " active" : ""}`, text, attrs: { type: "button", role: "radio", "aria-checked": String(v === value) } });
    b.addEventListener("click", () => onChange(v));
    return b;
  }));
}

/** What the form holds while a member is added or changed; `index` null: a new member. */
interface Form {
  index: number | null;
  role: string;
  newRole: string;
  newKind: RoleKind;
  level: string;
  newLevel: string;
  /** The level's "reviews others' code" (the level's own, shared by everyone at it). */
  reviews: boolean;
  cli: Cli;
  /** "": the level's model (else the CLI's own). */
  model: string;
  /** The model is typed in ("Other model…"), not picked from what the CLI lists. */
  customModel: boolean;
  effort: string;
  /** "": no group; NEW: the one named in newGroup. */
  group: string;
  newGroup: string;
  count: string;
  name: string;
  /** Add was pressed once: what is wrong is shown as an error from then on. */
  tried: boolean;
}

/** A member as the team names it, for the checks of what the team still needs. */
interface Placed {
  name: string;
  kind: RoleKind | undefined;
  group: string | null;
}

interface Readiness {
  ready: boolean;
  /** What to do, in words; the configuration's own messages when nothing else explains them. */
  messages: string[];
  /** Each group's needs, shown at its heading. */
  groups: Map<string, string[]>;
}

/**
 * The Team page of Settings, for the project open (or the user config with none). `codexModels`: Codex's models as a
 * chat's worker listed them (null until one has); Claude's are its aliases.
 */
export async function teamPage(projectId: string | null, o: { codexModels(): readonly ModelChoice[] | null } = { codexModels: () => null }): Promise<Node[]> {
  let info = await call({ method: "team.read", projectId });
  /** The list starts as the saved team; with none saved it is empty (agentduo's own team runs until one is). */
  const startDraft = (): TeamEdit => {
    const d = structuredClone(info.config);
    if (!info.membersFrom) d.members = [];
    return d;
  };
  let draft = startDraft();
  let scope: Scope = info.membersFrom ?? (projectId ? "project" : "global");
  let form: Form | null = null;
  let formEl: HTMLElement | null = null;
  /** The row whose identity texts are open. */
  let identityOf: number | null = null;
  const body = el("div", { class: "team-page" });
  const status = el("p", { class: "small status-line", attrs: { role: "status" } });
  const unsaved = el("span", { class: "unsaved" });

  const roleNames = () => Object.keys(draft.roles);
  const levelNames = () => Object.keys(draft.levels);
  const kindOf = (role: string): RoleKind | undefined => draft.roles[role]?.kind;
  const groupNames = () => [...new Set(draft.members.flatMap((m) => (m.group ? [m.group] : [])))];
  const placed = (): Placed[] => {
    const names = memberNames(draft);
    return draft.members.flatMap((m, i) => names[i]!.map((name) => ({ name, kind: kindOf(m.role), group: m.group ?? null })));
  };

  /** Custom roles and levels nobody is at any more are left out; agentduo's own always hold (they are the defaults). */
  const pruned = (d: TeamEdit): TeamEdit => {
    const roles = new Set(d.members.map((m) => m.role));
    const levels = new Set(d.members.map((m) => m.level));
    return {
      members: structuredClone(d.members),
      roles: Object.fromEntries(Object.entries(d.roles).filter(([r]) => r in TEAM_DEFAULTS.roles || roles.has(r))),
      levels: Object.fromEntries(Object.entries(d.levels).filter(([l]) => l in TEAM_DEFAULTS.levels || levels.has(l))),
      max_parallel: d.max_parallel,
    };
  };
  const dirty = () => JSON.stringify(pruned(draft)) !== JSON.stringify(pruned(startDraft()));
  const markDirty = () => (unsaved.textContent = dirty() ? "Unsaved changes" : "");

  function readiness(): Readiness {
    const all = placed();
    const groups = groupNames();
    const list = (xs: Placed[]) => xs.map((p) => p.name).join(", ");
    const messages: string[] = [];
    const perGroup = new Map<string, string[]>();
    const needs = (xs: Placed[]): string[] => [
      ...(xs.some((p) => p.kind === "lead") ? [] : ["a techlead"]),
      ...(xs.some((p) => p.kind === "worker") ? [] : ["someone who takes tasks (a dev)"]),
      ...(xs.some((p) => p.kind === "checker") ? [] : ["someone who tests (a QA)"]),
    ];
    const heads = all.filter((p) => p.kind === "pm" && !p.group);
    if (!heads.length) messages.push(groups.length ? "Add a PM in no group: the head PM, the one who talks with you." : "Add a PM: the one who talks with you.");
    else if (heads.length > 1) messages.push(`Only one PM can be in no group (now ${list(heads)}): put the others in a group, as its PM.`);
    if (!groups.length) {
      const rest = all.filter((p) => p.kind !== "pm");
      const missing = needs(rest);
      if (missing.length) messages.push(`Add ${joinAnd(missing)}.`);
      const leads = rest.filter((p) => p.kind === "lead");
      if (leads.length > 1) messages.push(`A team has one techlead (now ${list(leads)}). For more, put each techlead and its members in a group.`);
    } else {
      const loose = all.filter((p) => !p.group && p.kind !== "pm");
      if (loose.length) messages.push(`Put ${list(loose)} in a group: with groups, only the head PM is in none.`);
      for (const g of groups) {
        const inGroup = all.filter((p) => p.group === g);
        const leads = inGroup.filter((p) => p.kind === "lead");
        const pms = inGroup.filter((p) => p.kind === "pm");
        const missing = needs(inGroup);
        const out = missing.length ? [`needs ${joinAnd(missing)}`] : [];
        if (leads.length > 1) out.push(`has ${leads.length} techleads (${list(leads)}): one only`);
        if (pms.length > 1) out.push(`has ${pms.length} PMs (${list(pms)}): one at most`);
        if (out.length) {
          perGroup.set(g, out);
          messages.push(`Group ${g} ${joinAnd(out)}.`);
        }
      }
    }
    const errors = teamConfigErrors({ ...structuredClone(TEAM_DEFAULTS), ...draft });
    if (!messages.length) messages.push(...errors);
    return { ready: !errors.length, messages, groups: perGroup };
  }

  // ------------------------------------------------------------------ the list

  function sections(): Array<{ title: string; group: string | null; entries: number[] }> {
    const kind = (i: number) => kindOf(draft.members[i]!.role);
    const ordered = (xs: number[]) => xs.sort((a, b) => KINDS.indexOf(kind(a)!) - KINDS.indexOf(kind(b)!) || a - b);
    const all = draft.members.map((_, i) => i);
    const groups = groupNames();
    const out: Array<{ title: string; group: string | null; entries: number[] }> = [
      { title: "Talks with you", group: null, entries: all.filter((i) => kind(i) === "pm" && !draft.members[i]!.group) },
    ];
    if (groups.length) {
      for (const g of groups) out.push({ title: g, group: g, entries: ordered(all.filter((i) => draft.members[i]!.group === g)) });
      out.push({ title: "Not in a group", group: null, entries: ordered(all.filter((i) => !draft.members[i]!.group && kind(i) !== "pm")) });
    } else {
      out.push({ title: "The team", group: null, entries: ordered(all.filter((i) => kind(i) !== "pm")) });
    }
    return out.filter((s) => s.entries.length);
  }

  /** What a member runs on: its CLI, then its model and effort (its own, else its level's). */
  const runsOn = (e: Entry): string => {
    const cli = draft.levels[e.level]?.[e.cli] ?? {};
    return [CLI_WORD[e.cli], e.model ?? cli.model, e.effort ?? cli.effort].filter(Boolean).join(" · ");
  };

  function memberRow(i: number, names: string[]): HTMLElement {
    const e = draft.members[i]!;
    const kind = kindOf(e.role) ?? "worker";
    const reviews = draft.levels[e.level]?.can_review === true && (kind === "worker" || kind === "checker");
    const who = names.join(", ");
    const remove = () => {
      draft.members.splice(i, 1);
      identityOf = null;
      if (form?.index === i) form = null;
      else if (form?.index != null && form.index > i) form.index--;
      status.textContent = `${who} is out of the list. Save the team to keep it.`;
      draw();
    };
    const row = el("div", { class: `team-member${identityOf === i ? " open" : ""}`, attrs: { "data-member": names[0] ?? "" } },
      el("span", { class: `kind-tag kind-${kind}`, text: KIND_TAG[kind], title: `${e.role}: ${KIND_WORD[kind]}` }),
      el("div", { class: "member-text" },
        el("div", { class: "member-name" }, el("span", { text: who }), (e.count ?? 1) > 1 ? el("span", { class: "tag count", text: `×${e.count}` }) : null),
        el("div", { class: "member-meta", text: [`${e.role} · ${e.level}`, runsOn(e), reviews ? "reviews others' code" : ""].filter(Boolean).join(" · ") })),
      el("div", { class: "member-actions" },
        button("", () => {
          identityOf = identityOf === i ? null : i;
          draw();
        }, { class: "ghost small", icon: "note", title: `Identity of ${who}` }),
        button("", () => openForm(i), { class: "ghost small", icon: "edit", title: `Edit ${who}` }),
        button("", remove, { class: "ghost small", icon: "trash", title: `Remove ${who}` })));
    return identityOf === i ? el("div", { class: "member-block" }, row, identityPanel(e, names)) : row;
  }

  function list(r: Readiness): HTMLElement {
    const names = memberNames(draft);
    return el("div", { class: "team-list" }, ...sections().map((s) => {
      const needs = s.group ? r.groups.get(s.group) : s.title === "Not in a group" ? ["put them in a group"] : undefined;
      return el("section", { class: "team-section", attrs: { "aria-label": s.title } },
        el("div", { class: "team-section-title" }, s.group ? icon("folder") : null, el("span", { text: s.title }),
          needs?.length ? el("span", { class: "warn-text", text: `· ${joinAnd(needs)}` }) : null),
        ...s.entries.map((i) => {
          if (form?.index === i) return (formEl = formView(form));
          return memberRow(i, names[i]!);
        }));
    }));
  }

  function strip(r: Readiness): HTMLElement {
    const parallel = el("label", { class: "inline parallel" }, el("span", { class: "muted small", text: "At most at once" }),
      input(String(draft.max_parallel), (v) => {
        const n = Number(v);
        if (Number.isInteger(n) && n >= 1) draft.max_parallel = n;
        markDirty();
      }, "How many members work at once", { type: "number", class: "w-num" }));
    if (r.ready) {
      const people = placed().length;
      const groups = groupNames().length;
      const summary = groups ? `the head PM, ${groups} group${groups > 1 ? "s" : ""}, ${people} members` : `${people} members`;
      return el("div", { class: "team-strip ok", attrs: { role: "status" } }, icon("check"), el("span", { class: "grow", text: `Ready: ${summary}.` }), parallel);
    }
    return el("div", { class: "team-strip warn", attrs: { role: "status" } }, icon("warning"),
      el("div", { class: "grow" }, el("strong", { text: "Not ready yet: /team does not start with this team." }),
        el("ul", {}, ...r.messages.map((m) => el("li", { text: m })))),
      parallel);
  }

  function emptyState(): HTMLElement {
    return el("div", { class: "team-empty" }, icon("organization"),
      el("strong", { text: "No one in the team yet" }),
      el("p", { class: "muted", text: "Add the members one by one, or start from agentduo's team (a PM, a techlead, two devs and a QA) and change it." +
        (info.membersFrom ? "" : " Until you save a team, /team runs agentduo's.") }),
      form ? null : el("div", { class: "row-actions" },
        button("Add a member", () => openForm(null), { class: "primary", icon: "person-add" }),
        button("Start from agentduo's team", () => {
          draft.members = structuredClone(TEAM_DEFAULTS.members);
          status.textContent = "agentduo's team is in the list: change it, then save it.";
          draw();
        }, { icon: "copy" })));
  }

  // ------------------------------------------------------------------ identities

  function identityPanel(e: Entry, names: string[]): HTMLElement {
    const choices: Array<{ kind: IdentityKind; name: string; label: string; help: string }> = [
      { kind: "role", name: e.role, label: `Role: ${e.role}`, help: `The role's IDENTITY.md, shared by every ${e.role}.` },
      { kind: "level", name: e.level, label: `Level: ${e.level}`, help: `The level's IDENTITY.md, shared by every member at ${e.level}.` },
      ...names.map((n) => ({ kind: "agent" as const, name: n, label: n, help: `${n}'s own AGENT.md, read after the role's and the level's.` })),
    ];
    let chosen = choices[0]!;
    const tabs = el("div", { class: "segmented", attrs: { role: "tablist", "aria-label": `Identity of ${names.join(", ")}` } });
    const host = el("div");
    const show = () => {
      tabs.replaceChildren(...choices.map((c) => {
        const b = el("button", { class: `seg${c === chosen ? " active" : ""}`, text: c.label, attrs: { type: "button", role: "tab", "aria-selected": String(c === chosen) } });
        b.addEventListener("click", () => {
          chosen = c;
          show();
        });
        return b;
      }));
      host.replaceChildren(identityEditor(chosen.kind, chosen.name, chosen.help));
    };
    show();
    return el("div", { class: "identity-panel" }, tabs, host);
  }

  function identityEditor(kind: IdentityKind, name: string, help: string): HTMLElement {
    const box = el("div", { class: "identity-editor" }, el("p", { class: "muted small", text: help }));
    // Main opens only what the saved team has, so a member or role that is new in the list waits for Save.
    if (!info.identities.some((x) => x.kind === kind && x.name === name)) {
      box.append(el("p", { class: "muted small", text: "Save the team first: then this text can be written." }));
      return box;
    }
    let editScope: Scope = projectId ? "project" : "global";
    const said = el("p", { class: "small status-line", attrs: { role: "status" } });
    const text = el("textarea", { class: "identity-text", attrs: { rows: "12", "aria-label": `${kind} ${name}: text` } });
    const source = el("p", { class: "muted small" });
    const ref = () => ({ projectId, scope: editScope, kind, name });
    const shown = (r: { text: string; source: string }, words = "") => {
      text.value = r.text;
      source.textContent = `Shown: ${SOURCE_WORD[r.source]}.`;
      said.textContent = words;
    };
    const load = () => busy(null, said, async () => shown(await call({ method: "team.identity.read", ...ref() })));
    box.append(
      el("div", { class: "row-actions" },
        projectId ? select([["project", SCOPE_WORD.project], ["global", SCOPE_WORD.global]], editScope, (v) => {
          editScope = v as Scope;
          void load();
        }, "Where it is saved") : el("span", { class: "muted small", text: SCOPE_WORD.global }),
        button("Save", () => void busy(null, said, async () => shown(await call({ method: "team.identity.write", ...ref(), text: text.value }), "Saved.")),
          { class: "primary small", icon: "save" }),
        button("Back to the default", () => void busy(null, said, async () => shown(await call({ method: "team.identity.reset", ...ref() }),
          "The file is removed: the text it falls back to holds again.")), { class: "small", icon: "discard" }),
        button("Open in editor", () => void busy(null, said, async () => void (await call({ method: "team.openIdentity", ...ref() }))),
          { class: "small", icon: "go-to-file" })),
      source, text, said);
    void load();
    return box;
  }

  // ------------------------------------------------------------------ the form

  const blank = (o: Pick<Form, "index" | "role" | "level" | "cli" | "group">): Form => ({
    ...o, newRole: "", newKind: "worker", newLevel: "", reviews: draft.levels[o.level]?.can_review === true,
    model: "", customModel: false, effort: "", newGroup: "", count: "1", name: "", tried: false,
  });

  /** A new member's form, set to what the team still needs: its head PM, then each group's techlead, devs and QA. */
  function suggested(): Form {
    const all = placed();
    const roleOf = (k: RoleKind) => roleNames().find((r) => draft.roles[r]!.kind === k) ?? roleNames()[0]!;
    const levels = levelNames();
    const top = levels.at(-1)!;
    const middle = levels.includes("mid") ? "mid" : levels[Math.floor((levels.length - 1) / 2)]!;
    if (!all.some((p) => p.kind === "pm" && !p.group)) return blank({ index: null, role: roleOf("pm"), level: top, cli: "codex", group: "" });
    const target = groupNames().at(-1) ?? null;
    const inTarget = all.filter((p) => p.group === target && p.kind !== "pm");
    const kind: RoleKind = !inTarget.some((p) => p.kind === "lead") ? "lead"
      : !inTarget.some((p) => p.kind === "worker") ? "worker"
      : !inTarget.some((p) => p.kind === "checker") ? "checker" : "worker";
    return blank({ index: null, role: roleOf(kind), level: kind === "lead" ? top : middle, cli: kind === "lead" ? "codex" : "claude", group: target ?? "" });
  }

  function formFor(i: number): Form {
    const e = draft.members[i]!;
    return { ...blank({ index: i, role: e.role, level: e.level, cli: e.cli, group: e.group ?? "" }), model: e.model ?? "", effort: e.effort ?? "",
      count: String(e.count ?? 1), name: e.name ?? "" };
  }

  function openForm(index: number | null): void {
    form = index === null ? suggested() : formFor(index);
    identityOf = null;
    status.textContent = "";
    draw();
    formEl?.scrollIntoView({ block: "nearest" });
    formEl?.querySelector<HTMLElement>("select")?.focus();
  }

  /** The member the form describes, with the list it makes and its names; or what is wrong with it. */
  function candidate(f: Form): { entry: Entry; members: Entry[]; names: string[] } | { error: string } {
    const role = f.role === NEW ? f.newRole.trim() : f.role;
    if (f.role === NEW) {
      if (!role) return { error: "Give the new role a name (security, designer…)." };
      if (!NAME.test(role)) return { error: `A role's name is ${NAME_RULE}.` };
      if (draft.roles[role]) return { error: `There is a role ${role} already: pick it in the menu.` };
    }
    const level = f.level === NEW ? f.newLevel.trim() : f.level;
    if (f.level === NEW) {
      if (!level) return { error: "Give the new level a name (staff, principal…)." };
      if (!NAME.test(level)) return { error: `A level's name is ${NAME_RULE}.` };
      if (draft.levels[level]) return { error: `There is a level ${level} already: pick it in the menu.` };
    }
    const group = f.group === NEW ? f.newGroup.trim() : f.group;
    if (f.group === NEW && !group) return { error: "Give the new group a name (frontend, backend…)." };
    if (group && !NAME.test(group)) return { error: `A group's name is ${NAME_RULE}.` };
    const count = Number(f.count);
    if (!Number.isInteger(count) || count < 1 || count > 20) return { error: "How many: a whole number from 1 to 20." };
    const name = f.name.trim();
    if (name && !NAME.test(name)) return { error: `A member's name is ${NAME_RULE}.` };
    if (name && count > 1) return { error: "A name is for one member: set how many to 1, or leave the name empty." };
    const model = f.model.trim();
    if (f.customModel && !model) return { error: "Write the model's name as its CLI takes it, or pick one in the menu." };
    if (model && (/\s/.test(model) || model.length > 200)) return { error: "A model is one word, as its CLI takes it (opus, gpt-5…)." };
    const levelCli = draft.levels[level]?.[f.cli] ?? {};
    const old = f.index === null ? null : draft.members[f.index]!;
    const entry: Entry = { role, level, cli: f.cli };
    if (group) entry.group = group;
    if (count > 1) entry.count = count;
    if (name) entry.name = name;
    // Only what differs from the level is the member's own: a change of the level reaches it then.
    if (model && model !== (levelCli.model ?? "")) entry.model = model;
    if (f.effort && f.effort !== (levelCli.effort ?? "")) entry.effort = f.effort;
    if (old?.args) entry.args = [...old.args];
    const members = [...draft.members];
    if (f.index === null) members.push(entry);
    else members[f.index] = entry;
    const at = f.index ?? members.length - 1;
    const roles = f.role === NEW ? { ...draft.roles, [role]: { kind: f.newKind } } : draft.roles;
    const all = memberNames({ roles, members });
    const taken = new Set(all.flatMap((n, i) => (i === at ? [] : n)));
    const clash = all[at]!.find((n) => taken.has(n));
    if (clash) {
      const kind = roles[role]?.kind;
      return { error: kind === "pm" || kind === "lead"
        ? `${clash} is in the team already: a PM or techlead is named after its role and group. Put this one in another group, or give it a name.`
        : `${clash} is in the team already: give this member a name of its own.` };
    }
    return { entry, members, names: all[at]! };
  }

  /** What the member will do in the team, in a sentence. */
  function duty(kind: RoleKind, group: string): string {
    if (kind === "pm") return group ? `The PM of ${group}: checks its techlead's plan and answers its questions.` : "The head PM: talks with you, writes the brief, checks the plan and the result.";
    if (kind === "lead") return group ? `Plans the ${group} work, assigns it, reviews and merges it.` : "Plans the work, assigns it, reviews and merges it.";
    if (kind === "worker") return group ? `Takes the ${group} tasks its techlead assigns.` : "Takes the tasks the techlead assigns.";
    return group ? `Writes and runs the tests of the ${group} tasks.` : "Writes and runs the tests of every task.";
  }

  function formView(f: Form): HTMLElement {
    const again = (focus?: string) => {
      if (!formEl) return;
      const next = formView(f);
      formEl.replaceWith(next);
      formEl = next;
      if (focus) next.querySelector<HTMLElement>(`[aria-label="${focus}"]`)?.focus();
    };
    const preview = el("div", { class: "team-preview", attrs: { "aria-live": "polite" } });
    const showPreview = () => {
      const c = candidate(f);
      preview.classList.toggle("error", "error" in c && f.tried);
      preview.classList.toggle("pending", "error" in c && !f.tried);
      if ("error" in c) {
        preview.replaceChildren(icon(f.tried ? "error" : "info"), el("span", { text: c.error }));
        return;
      }
      const kind = f.role === NEW ? f.newKind : kindOf(c.entry.role) ?? "worker";
      const reviews = f.reviews && (kind === "worker" || kind === "checker");
      preview.replaceChildren(icon("person-add"), el("div", {},
        el("div", {}, el("span", { text: f.index === null ? "Adds " : "Becomes " }), el("strong", { text: c.names.join(", ") }),
          el("span", { class: "muted", text: ` · ${c.entry.role} · ${c.entry.level} · ${runsOn(c.entry)}${reviews ? " · reviews others' code" : ""}` })),
        el("div", { class: "what", text: duty(kind, c.entry.group ?? "") })));
    };
    const field = (label: string, control: Node) => [el("span", { class: "form-label", text: label }), control];
    const byKind = (a: string, b: string) => KINDS.indexOf(kindOf(a)!) - KINDS.indexOf(kindOf(b)!);

    const role = el("div", { class: "form-line" },
      select([...[...roleNames()].sort(byKind).map((r): [string, string] => [r, `${r} — ${KIND_WORD[kindOf(r)!]}`]), [NEW, "New role…"]], f.role, (v) => {
        f.role = v;
        again("Role");
      }, "Role", "grow"),
      f.role === NEW ? input(f.newRole, (v) => {
        f.newRole = v;
        showPreview();
      }, "New role's name", { placeholder: "security", class: "w-name" }) : null,
      f.role === NEW ? select(KINDS.map((k): [string, string] => [k, KIND_WORD[k]]), f.newKind, (v) => {
        f.newKind = v as RoleKind;
        again("New role's kind");
      }, "New role's kind") : null);

    const level = el("div", { class: "form-line" },
      select([...levelNames().map((l): [string, string] => [l, l]), [NEW, "New level…"]], f.level, (v) => {
        f.level = v;
        f.reviews = v !== NEW && draft.levels[v]?.can_review === true;
        again("Level");
      }, "Level", "grow"),
      f.level === NEW ? input(f.newLevel, (v) => {
        f.newLevel = v;
        showPreview();
      }, "New level's name", { placeholder: "staff", class: "w-name" }) : null,
      checkbox(f.reviews, (v) => {
        f.reviews = v;
        showPreview();
      }, "Reviews others' code", f.level === NEW ? "reviews others' code (goes above every level)" : `every ${f.level} reviews others' code`));

    const cli = segmented([["claude", "Claude"], ["codex", "Codex"]], f.cli, (v) => {
      if (v === f.cli) return;
      // A model is one CLI's: the other CLI starts from its level's.
      f.cli = v as Cli;
      f.model = "";
      f.customModel = false;
      if (f.effort && !effortsOf(f.cli).includes(f.effort)) f.effort = "";
      again();
    }, "CLI");

    const fromLevel = f.level === NEW ? {} : draft.levels[f.level]?.[f.cli] ?? {};
    const levelWord = f.level === NEW ? "the new level's" : `${f.level}'s`;
    const listed = f.cli === "claude" ? CLAUDE_MODELS : o.codexModels() ?? [];
    const labelOf = (id: string) => listed.find((m) => m.id === id)?.label ?? id;
    const model = el("div", { class: "form-line" },
      select([
        ["", fromLevel.model ? `${labelOf(fromLevel.model)} (${levelWord})` : "The CLI's own model"],
        ...(f.model && !f.customModel && !listed.some((m) => m.id === f.model) ? [[f.model, f.model] as [string, string]] : []),
        ...listed.map((m): [string, string] => [m.id, m.label]),
        [OTHER_MODEL, "Other model…"],
      ], f.customModel ? OTHER_MODEL : f.model, (v) => {
        f.customModel = v === OTHER_MODEL;
        if (!f.customModel) f.model = v;
        again(f.customModel ? "Model name" : "Model");
      }, "Model", "grow"),
      f.customModel ? input(f.model, (v) => {
        f.model = v;
        showPreview();
      }, "Model name", { placeholder: "as the CLI takes it", class: "w-name" }) : null,
      f.cli === "codex" && !listed.length ? el("span", { class: "muted small", text: "Codex's models show here once a chat has listed them." }) : null);
    // Codex says which efforts each of its models takes; otherwise every effort the CLI takes.
    const picked = f.model.trim() || fromLevel.model || null;
    const modelEfforts = f.cli === "codex" && picked ? listed.find((m) => m.id === picked)?.efforts ?? null : null;
    const efforts: readonly string[] = modelEfforts?.length ? modelEfforts : effortsOf(f.cli);
    const effort = select([
      ["", fromLevel.effort ? `${fromLevel.effort} (${levelWord})` : "The CLI's own effort"],
      ...(f.effort && !efforts.includes(f.effort) ? [[f.effort, f.effort] as [string, string]] : []),
      ...efforts.map((e): [string, string] => [e, e]),
    ], f.effort, (v) => {
      f.effort = v;
      showPreview();
    }, "Effort", "w-effort");

    const group = el("div", { class: "form-line" },
      select([["", "No group"], ...groupNames().map((g): [string, string] => [g, g]), [NEW, "New group…"]], f.group, (v) => {
        f.group = v;
        again("Group");
      }, "Group", "grow"),
      f.group === NEW ? input(f.newGroup, (v) => {
        f.newGroup = v;
        showPreview();
      }, "New group's name", { placeholder: "frontend", class: "w-name" }) : null);

    const name = input(f.name, (v) => {
      f.name = v;
      showPreview();
    }, "Name", { placeholder: "a name of its own (optional, for one)", class: "grow" });
    name.disabled = Number(f.count) > 1;
    const count = el("div", { class: "form-line" },
      input(f.count, (v) => {
        f.count = v;
        name.disabled = Number(v) > 1;
        showPreview();
      }, "How many", { type: "number", class: "w-num" }), name);

    const submit = () => {
      f.tried = true;
      const c = candidate(f);
      if ("error" in c) {
        showPreview();
        return;
      }
      if (f.role === NEW) draft.roles[c.entry.role] = { kind: f.newKind };
      if (f.level === NEW) draft.levels[c.entry.level] = { can_review: f.reviews };
      else if ((draft.levels[c.entry.level]!.can_review === true) !== f.reviews) draft.levels[c.entry.level]!.can_review = f.reviews;
      draft.members = c.members;
      form = null;
      status.textContent = `${f.index === null ? "Added" : "Changed"} ${c.names.join(", ")}. Save the team to keep it.`;
      draw();
    };
    const cancel = () => {
      form = null;
      draw();
    };

    const box = el("div", { class: "team-form", attrs: { role: "group", "aria-label": f.index === null ? "Add a member" : "Edit a member" } },
      el("h4", { text: f.index === null ? "Add a member" : "Edit the member" }),
      el("div", { class: "form-grid" }, ...field("Role", role), ...field("Level", level), ...field("CLI", cli), ...field("Model", model), ...field("Effort", effort),
        ...field("Group", group), ...field("How many", count)),
      preview,
      el("div", { class: "form-buttons" }, button("Cancel", cancel, { class: "small" }),
        button(f.index === null ? "Add to the team" : "Update the member", submit, { class: "primary small", icon: f.index === null ? "add" : "check" })));
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape") cancel();
      else if (e.key === "Enter" && e.target instanceof HTMLInputElement && e.target.type !== "checkbox") submit();
    });
    showPreview();
    return box;
  }

  // ------------------------------------------------------------------ the page

  const save = button("Save the team", () => void busy(save, status, async () => {
    if (!readiness().ready) throw new Error("Not saved: the team is not ready yet (what it needs is above).");
    const at = scope;
    info = await call({ method: "team.save", projectId, scope: at, team: pruned(draft) });
    draft = startDraft();
    form = null;
    identityOf = null;
    status.textContent = at === "global" && info.membersFrom === "project"
      ? "Saved for every project. This project has a team of its own, which it keeps: that is the team shown."
      : `Saved in ${at === "global" ? "your user config (every project)" : "this project's .agentduo/config.yaml"}; the next team run uses it.`;
    draw();
  }), { class: "primary", icon: "save" });
  const where = projectId ? select([["project", SCOPE_WORD.project], ["global", SCOPE_WORD.global]], scope, (v) => (scope = v as Scope), "Where the team is saved")
    : el("span", { class: "muted small", text: SCOPE_WORD.global });

  function draw(): void {
    formEl = null;
    const r = readiness();
    const parts: Node[] = [];
    if (!draft.members.length) parts.push(emptyState());
    else parts.push(strip(r), list(r));
    if (form && form.index === null) parts.push((formEl = formView(form)));
    if (draft.members.length && !(form && form.index === null)) {
      parts.push(el("div", { class: "row-actions" }, button("Add a member", () => openForm(null), { icon: "person-add" })));
    }
    const from = info.membersFrom === "project" ? "this project's team" : info.membersFrom === "global" ? "your team for every project" : "agentduo's team (none saved yet)";
    parts.push(el("div", { class: "team-save" }, el("span", { class: "muted small from", text: `/team runs ${from}.` }),
      el("span", { class: "muted small", text: "Save in" }), where, unsaved, save), status);
    body.replaceChildren(...parts);
    markDirty();
  }

  draw();
  return [
    el("p", { class: "muted", text: "In a chat, /team <request> (or Team in the composer's menu) hands the request to this team: you talk to the PM only. The PM writes the brief, " +
      "the techleads plan and assign, the members work in parallel and the testers check every task; you approve the brief, the plan and the result." }),
    body,
    el("h3", { text: "Identities" }),
    el("p", { class: "muted small", text: "A member's prompt has its role's IDENTITY.md, its level's, then its own AGENT.md: open them with the note button on its row. " +
      "Each starts as agentduo's text: add to it or rewrite it, for every project or this one (this project's file wins). A change applies to the next team run." }),
    el("div", { class: "row-actions" }, button("Write the default files into this project", () => void busy(null, status, async () => {
      const r = await call({ method: "team.identity.defaults", projectId: projectId! });
      info = await call({ method: "team.read", projectId });
      status.textContent = r.written ? `${r.written} IDENTITY.md file(s) written into .agentduo/team.` : "Every file is there already.";
    }), { class: "small", icon: "new-file", disabled: !projectId })),
  ];
}
