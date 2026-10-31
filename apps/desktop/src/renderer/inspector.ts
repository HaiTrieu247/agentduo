// The right column: the active conversation's run, read through main by name (never a path). Plan and Report are
// its artifacts; Changes lists what the run changed and shows one file's line diff between the two snapshots that
// list named (so it keeps showing those after the run takes a newer one); Checks shows the run and its gates.
import type { ViewState } from "../../../../extensions/vscode/webview/state.js";
import type { ArtifactName, ChangeFile, ChangeListView } from "../shared/protocol.js";
import { button, call, el, errorText, icon } from "./bridge.js";
import { diffStats, lineDiff } from "./diff.js";

export type InspectorTab = "plan" | "changes" | "checks" | "report";
const TABS: Array<[InspectorTab, string]> = [["plan", "Plan"], ["changes", "Changes"], ["checks", "Checks"], ["report", "Report"]];

export interface InspectorContext {
  projectId: string | null;
  conversationId: string | null;
  /** The active chat's state, for the gates it saw. */
  state: ViewState | null;
}

export class Inspector {
  private tab: InspectorTab = "plan";
  private readonly tabs = el("div", { class: "tabs", attrs: { role: "tablist", "aria-label": "Inspector" } });
  private readonly body = el("div", { class: "inspector-body", attrs: { role: "tabpanel" } });
  private list: ChangeListView | null = null;
  private openFile: number | null = null;
  private seq = 0;

  constructor(private readonly root: HTMLElement, private readonly ctx: () => InspectorContext, private readonly onClose: () => void) {
    const head = el("header", { class: "inspector-head" }, this.tabs, el("span", { class: "spacer" }),
      button("", () => void this.refresh(), { class: "icon-btn", icon: "refresh", title: "Refresh" }),
      button("", onClose, { class: "icon-btn", icon: "layout-sidebar-right-off", title: "Hide the panel" }));
    root.replaceChildren(head, this.body);
    this.drawTabs();
  }

  private drawTabs(): void {
    this.tabs.replaceChildren(...TABS.map(([id, label]) => {
      const b = el("button", { class: `tab${id === this.tab ? " active" : ""}`, text: label, attrs: { type: "button", role: "tab", "aria-selected": String(id === this.tab) } });
      b.addEventListener("click", () => this.show(id));
      return b;
    }));
  }

  show(tab: InspectorTab, artifact?: ArtifactName): void {
    this.tab = tab;
    this.drawTabs();
    void this.refresh(artifact);
  }

  /** The conversation changed: what was listed belongs to another run. */
  reset(): void {
    this.list = null;
    this.openFile = null;
    void this.refresh();
  }

  async refresh(focus?: ArtifactName): Promise<void> {
    const seq = ++this.seq;
    const { projectId, conversationId } = this.ctx();
    if (!projectId) {
      this.body.replaceChildren(el("p", { class: "muted pad", text: "Open a project to see its runs." }));
      return;
    }
    this.body.replaceChildren(el("p", { class: "muted pad", text: "Loading…" }));
    const stale = () => seq !== this.seq;
    try {
      let nodes: Node[];
      switch (this.tab) {
        case "plan":
          nodes = await this.artifacts(projectId, conversationId, ["plan"]);
          break;
        case "report":
          nodes = await this.artifacts(projectId, conversationId, focus && focus !== "plan" ? [focus, ...(["report", "review", "feedback"] as const).filter((a) => a !== focus)] : ["report", "review", "feedback"]);
          break;
        case "changes":
          nodes = await this.changes(projectId, conversationId);
          break;
        case "checks":
          nodes = await this.checks(projectId, conversationId);
          break;
      }
      if (!stale()) this.body.replaceChildren(...nodes);
    } catch (e) {
      if (!stale()) this.body.replaceChildren(el("p", { class: "muted pad", text: errorText(e) }));
    }
  }

  private async artifacts(projectId: string, conversationId: string | null, names: readonly ArtifactName[]): Promise<Node[]> {
    const out: Node[] = [];
    for (const artifact of names) {
      try {
        const a = await call({ method: "artifact.read", projectId, conversationId, artifact });
        out.push(el("section", { class: "artifact" }, el("h3", { text: `${artifact[0]!.toUpperCase()}${artifact.slice(1)} · ${a.runId}` }), el("pre", { class: "doc", text: a.text })));
      } catch (e) {
        out.push(el("section", { class: "artifact" }, el("h3", { text: `${artifact[0]!.toUpperCase()}${artifact.slice(1)}` }), el("p", { class: "muted", text: errorText(e) })));
      }
    }
    return out;
  }

  private async changes(projectId: string, conversationId: string | null): Promise<Node[]> {
    // The list shown stays the one compared, until Refresh asks for the newest.
    const list = this.list ?? (this.list = await call({ method: "changes.list", projectId, conversationId }));
    if (!list.hasSnapshots) return [el("p", { class: "muted pad", text: `Run ${list.runId}: nothing to compare until the implementer has run once.` })];
    const head = el("p", { class: "muted small pad", text: `Run ${list.runId} · ${list.base?.slice(0, 8) ?? "?"} → ${list.snapshot?.slice(0, 8) ?? "?"} · ${list.changes.length} file(s)` });
    const files = el("ul", { class: "change-list", attrs: { role: "list" } });
    const detail = el("div", { class: "change-detail" });
    list.changes.forEach((c, index) => {
      const b = el("button", { class: `change${this.openFile === index ? " active" : ""}`, title: c.path, attrs: { type: "button" } },
        el("span", { class: `status st-${c.status.toLowerCase()}`, text: c.status }), el("span", { class: "path", text: c.path }));
      b.addEventListener("click", () => {
        this.openFile = index;
        for (const x of files.querySelectorAll(".change")) x.classList.toggle("active", x === b);
        void this.file(projectId, list.listId, index, detail);
      });
      files.append(el("li", {}, b));
    });
    if (!list.changes.length) files.append(el("li", { class: "muted", text: "No changes." }));
    const reload = button("Newest changes", () => {
      this.list = null;
      this.openFile = null;
      void this.refresh();
    }, { class: "small", icon: "refresh" });
    if (this.openFile !== null && this.openFile < list.changes.length) void this.file(projectId, list.listId, this.openFile, detail);
    return [head, el("div", { class: "pad" }, reload), files, detail];
  }

  private async file(projectId: string, listId: string, index: number, into: HTMLElement): Promise<void> {
    into.replaceChildren(el("p", { class: "muted pad", text: "Loading…" }));
    try {
      into.replaceChildren(renderChange(await call({ method: "changes.file", projectId, listId, index })));
    } catch (e) {
      into.replaceChildren(el("p", { class: "muted pad", text: errorText(e) }));
    }
  }

  private async checks(projectId: string, conversationId: string | null): Promise<Node[]> {
    const out: Node[] = [];
    const run = await call({ method: "run.inspect", projectId, conversationId });
    if (!run) out.push(el("p", { class: "muted pad", text: "This conversation has no run yet. Start one with Pipeline (or /pipeline <task>)." }));
    else {
      out.push(el("dl", { class: "facts" },
        el("dt", { text: "Run" }), el("dd", { text: run.runId }),
        el("dt", { text: "Task" }), el("dd", { text: run.task }),
        el("dt", { text: "Phase" }), el("dd", { text: run.phase }),
        el("dt", { text: "Artifacts" }), el("dd", { text: run.artifacts.join(", ") || "none yet" }),
        el("dt", { text: "Snapshots" }), el("dd", { text: run.hasSnapshots ? "yes" : "not yet" })));
    }
    const gates = gateActivities(this.ctx().state);
    out.push(el("h3", { class: "pad", text: "Gates" }));
    if (!gates.length) out.push(el("p", { class: "muted pad", text: "No gate has run in this conversation's view." }));
    const list = el("ul", { class: "gates", attrs: { role: "list" } });
    for (const g of gates) {
      const word = g.status === "running" ? "running" : g.status === "ok" ? "passed" : g.status === "error" ? "failed" : g.status;
      list.append(el("li", { class: `gate g-${g.status}` }, icon(g.status === "ok" ? "pass" : g.status === "error" ? "error" : "loading"),
        el("span", { class: "gate-word", text: word }), el("code", { text: g.label.replace(/^gate\s+/, "") }),
        g.exitCode !== undefined ? el("span", { class: "muted", text: `exit ${g.exitCode}` }) : null));
    }
    out.push(list);
    return out;
  }
}

interface GateRow {
  label: string;
  status: string;
  exitCode?: number;
}

/** The gates a chat's view saw, latest result of each, in the order they first ran. */
export function gateActivities(s: ViewState | null): GateRow[] {
  if (!s) return [];
  const byId = new Map<string, GateRow>();
  const steps = [...s.timeline.flatMap((t) => (t.kind === "step" ? [t.step] : [])), ...(s.current ? [s.current] : [])];
  for (const step of steps) for (const a of step.activities) if (a.id.startsWith("gate-")) byId.set(a.id, { label: a.label, status: a.status, exitCode: a.exitCode });
  return [...byId.values()];
}

function renderChange(f: ChangeFile): HTMLElement {
  const wrap = el("div", { class: "diff-wrap" });
  wrap.append(el("div", { class: "diff-title" }, el("span", { class: "status", text: f.status }), el("code", { text: f.path })));
  const sideNote = (side: string, s: ChangeFile["before"]) =>
    s.missing ? `${side}: no file` : s.binary ? `${side}: binary file` : s.tooLarge ? `${side}: too large to show` : null;
  const notes = [sideNote("Before", f.before), sideNote("After", f.after)].filter((n): n is string => !!n && !n.endsWith("no file"));
  if (notes.length) {
    wrap.append(el("p", { class: "muted pad", text: notes.join(" · ") }));
    return wrap;
  }
  const d = lineDiff(f.before.missing ? "" : (f.before.text ?? ""), f.after.missing ? "" : (f.after.text ?? ""));
  if (d.tooLarge) {
    wrap.append(el("p", { class: "muted pad", text: "Too large to compare here; both sides follow." }),
      el("h4", { text: "Before" }), el("pre", { class: "doc", text: f.before.text ?? "" }), el("h4", { text: "After" }), el("pre", { class: "doc", text: f.after.text ?? "" }));
    return wrap;
  }
  const stats = diffStats(d);
  wrap.append(el("p", { class: "muted small pad", text: `+${stats.added} −${stats.removed}${d.truncated ? " · shortened" : ""}` }));
  const table = el("table", { class: "diff", attrs: { "aria-label": `Changes in ${f.path}` } });
  const body = el("tbody");
  for (const r of d.rows) {
    const mark = r.kind === "add" ? "+" : r.kind === "del" ? "−" : " ";
    body.append(el("tr", { class: `d-${r.kind}` },
      el("td", { class: "ln", text: r.oldNo === null ? "" : String(r.oldNo) }),
      el("td", { class: "ln", text: r.newNo === null ? "" : String(r.newNo) }),
      el("td", { class: "mk", text: mark, attrs: { "aria-label": r.kind === "add" ? "added" : r.kind === "del" ? "deleted" : null } }),
      el("td", { class: "tx", text: r.text })));
  }
  table.append(body);
  wrap.append(table);
  return wrap;
}
