// Settings → Team's Roles panel: every role the team has (agentduo's own and yours) with its kind, what it does (its
// description, which every team prompt shows beside its members) and who has it. One form adds a role or changes one
// (its kind and description; a role's name stays once made), every role can be removed (its members with it, asked
// first by the page), and its IDENTITY.md opens from its row. Members pick their role from this list.
import type { TeamEdit } from "@agentduo/engine/config/configuration";
import { memberNames, type RoleKind, type TeamRole } from "@agentduo/engine/team/config";
import type { TeamPanels } from "../shared/protocol.js";
import { button, el, icon } from "./bridge.js";
import { input, segmented } from "./form-controls.js";

export const KINDS: readonly RoleKind[] = ["pm", "lead", "worker", "checker"];
export const KIND_TAG: Record<RoleKind, string> = { pm: "PM", lead: "Lead", worker: "Dev", checker: "Test" };
export const KIND_WORD: Record<RoleKind, string> = { pm: "talks with you", lead: "plans, reviews and merges", worker: "takes tasks", checker: "tests tasks" };
/** A name that goes into paths and git refs: a role's, a level's, a group's or a member's. */
export const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const NAME_RULE = "lowercase letters, digits, '-' or '_', starting with a letter or digit";
/** The longest description a role may have (the configuration's own limit). */
export const DESCRIPTION_MAX = 300;
/** What a role without a description shows. */
export const NO_DESCRIPTION = "No description: the techlead sees only its name.";

/** The team as Settings → Team edits it: the roles it has (none null; `rolesToWrite` adds the ones it dropped). */
export type TeamDraft = Omit<TeamEdit, "roles"> & { roles: Record<string, TeamRole> };

/** What the role form holds: `role` null adds the role named `name`; else it changes `role`. */
export interface RoleForm {
  role: string | null;
  name: string;
  kind: RoleKind;
  description: string;
  /** Add (or Update) was pressed once: what is wrong is shown as an error from then on. */
  tried: boolean;
}

/** What is wrong with the role the form describes, in words to show; null: it can be added or changed. */
export function roleProblem(f: RoleForm, roles: Record<string, TeamRole>): string | null {
  if (f.role === null) {
    const name = f.name.trim();
    if (!name) return "Give the role a name (designer, security…).";
    if (!NAME.test(name)) return `A role's name is ${NAME_RULE}.`;
    if (roles[name]) return `There is a role ${name} already: change that one.`;
  }
  const description = f.description.trim();
  if (description.length > DESCRIPTION_MAX || /[\r\n]/.test(description)) return `What a role does is one line of at most ${DESCRIPTION_MAX} characters.`;
  return null;
}

/** The members who have `role`, named as the team names them. */
export function roleUsers(team: Pick<TeamDraft, "roles" | "members">, role: string): string[] {
  const names = memberNames(team);
  return team.members.flatMap((m, i) => (m.role === role ? names[i]! : []));
}

/** The team without `role`, and without every member who has it. */
export function withoutRole<T extends Pick<TeamDraft, "roles" | "members">>(team: T, role: string): T {
  const roles = { ...team.roles };
  delete roles[role];
  return { ...team, roles, members: team.members.filter((m) => m.role !== role) };
}

/** The panels shown once `clicked`'s button is pressed: it hides that panel, or shows it again; the last one shown stays. */
export function nextPanels(now: TeamPanels, clicked: "team" | "roles"): TeamPanels {
  if (now === "both") return clicked === "team" ? "roles" : "team";
  return now === clicked ? now : "both";
}

/** The roles in the order the panel lists them: by kind (as the team runs), then as the configuration has them. */
export const roleOrder = (roles: Record<string, TeamRole>): string[] =>
  Object.keys(roles).map((r, i) => ({ r, i })).sort((a, b) => KINDS.indexOf(roles[a.r]!.kind) - KINDS.indexOf(roles[b.r]!.kind) || a.i - b.i).map((x) => x.r);

/** What the panel needs of the page: the team, its form and identity state, and what each action does. */
export interface RolesPanelOptions {
  team: TeamDraft;
  form: RoleForm | null;
  /** The role whose IDENTITY.md is open under its row. */
  identityOf: string | null;
  openForm(role: string | null): void;
  closeForm(): void;
  /** The form passed its checks: the role is added or changed in the team. */
  apply(f: RoleForm): void;
  remove(role: string): void;
  toggleIdentity(role: string): void;
  /** The editor of `role`'s IDENTITY.md. */
  identity(role: string): HTMLElement;
  /** Marks the members who have `role` in the Team panel (null: none). */
  highlight(role: string | null): void;
}

export function rolesPanel(o: RolesPanelOptions): HTMLElement {
  const adding = o.form && o.form.role === null ? o.form : null;
  const rows = roleOrder(o.team.roles).map((role) => (o.form?.role === role ? roleFormView(o, o.form) : roleRow(o, role)));
  const list = rows.length || adding
    ? el("div", { class: "team-list role-list" }, ...(adding ? [roleFormView(o, adding)] : []), ...rows)
    : el("div", { class: "team-empty" }, icon("tag"), el("strong", { text: "No role yet" }),
      el("p", { class: "muted", text: "Add a role, say what it does, then give it to members." }));
  return el("section", { class: "roles-panel", attrs: { "aria-label": "Roles" } },
    el("div", { class: "panel-head" }, el("h4", { text: "Roles" }),
      adding ? null : button("Add a role", () => o.openForm(null), { class: "small", icon: "add" })),
    list);
}

function roleRow(o: RolesPanelOptions, role: string): HTMLElement {
  const r = o.team.roles[role]!;
  const users = roleUsers(o.team, role);
  const row = el("div", { class: `role-row${o.identityOf === role ? " open" : ""}`, attrs: { "data-role": role } },
    el("span", { class: `kind-tag kind-${r.kind}`, text: KIND_TAG[r.kind], title: `${role}: ${KIND_WORD[r.kind]}` }),
    el("div", { class: "member-text" },
      el("div", { class: "member-name" }, el("span", { text: role }),
        el("span", { class: "muted small", text: users.length ? `· ${users.length} member${users.length > 1 ? "s" : ""}` : "· no member", title: users.join(", ") })),
      el("div", { class: `member-meta role-desc${r.description ? "" : " none"}`, text: r.description ?? NO_DESCRIPTION })),
    el("div", { class: "member-actions" },
      button("", () => o.toggleIdentity(role), { class: "ghost small", icon: "note", title: `Identity of the role ${role}` }),
      button("", () => o.openForm(role), { class: "ghost small", icon: "edit", title: `Edit the role ${role}` }),
      button("", () => o.remove(role), { class: "ghost small", icon: "trash", title: `Remove the role ${role}` })));
  row.addEventListener("mouseenter", () => o.highlight(role));
  row.addEventListener("mouseleave", () => o.highlight(null));
  return o.identityOf === role ? el("div", { class: "member-block" }, row, o.identity(role)) : row;
}

function roleFormView(o: RolesPanelOptions, f: RoleForm): HTMLElement {
  const adding = f.role === null;
  const preview = el("div", { class: "team-preview", attrs: { "aria-live": "polite" } });
  const counter = el("span", { class: "counter" });
  const show = () => {
    counter.textContent = `${f.description.trim().length} / ${DESCRIPTION_MAX}`;
    const problem = roleProblem(f, o.team.roles);
    preview.classList.toggle("error", !!problem && f.tried);
    preview.classList.toggle("pending", !!problem && !f.tried);
    if (problem) {
      preview.replaceChildren(icon(f.tried ? "error" : "info"), el("span", { text: problem }));
      return;
    }
    preview.replaceChildren(icon("tag"), el("div", {},
      el("div", {}, el("strong", { text: (f.role ?? f.name).trim() }), el("span", { class: "muted", text: ` · ${KIND_WORD[f.kind]}` })),
      el("div", { class: "what", text: f.description.trim() || NO_DESCRIPTION })));
  };
  const submit = () => {
    f.tried = true;
    if (roleProblem(f, o.team.roles)) {
      show();
      return;
    }
    o.apply(f);
  };
  const field = (label: string, control: Node) => [el("span", { class: "form-label", text: label }), control];
  const name = adding
    ? input(f.name, (v) => {
      f.name = v;
      show();
    }, "New role's name", { placeholder: "designer", class: "grow" })
    : el("span", {}, el("strong", { text: f.role! }), el("span", { class: "muted small", text: "  (a role's name stays once it is made)" }));
  let box: HTMLElement;
  const kind = segmented(KINDS.map((k): [string, string] => [k, KIND_TAG[k]]), f.kind, (v) => {
    f.kind = v as RoleKind;
    const next = roleFormView(o, f);
    box.replaceWith(next);
    next.querySelector<HTMLElement>('[aria-label="Role\'s kind"] .seg.active')?.focus();
  }, "Role's kind");
  const does = el("div", { class: "form-line" },
    input(f.description, (v) => {
      f.description = v;
      show();
    }, "What the role does", { placeholder: "designs and builds the UI: layout, styles, components", class: "grow" }), counter);
  box = el("div", { class: "team-form role-form", attrs: { role: "group", "aria-label": adding ? "Add a role" : `Edit the role ${f.role}` } },
    el("h4", { text: adding ? "Add a role" : `Edit the role ${f.role}` }),
    el("div", { class: "form-grid" }, ...field("Name", name), ...field("Kind", kind), ...field("What it does", does)),
    preview,
    el("div", { class: "form-buttons" }, button("Cancel", () => o.closeForm(), { class: "small" }),
      button(adding ? "Add the role" : "Update the role", submit, { class: "primary small", icon: adding ? "add" : "check" })));
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); o.closeForm(); }
    else if (e.key === "Enter" && e.target instanceof HTMLInputElement) submit();
  });
  show();
  return box;
}
