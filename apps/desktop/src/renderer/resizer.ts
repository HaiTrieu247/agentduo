// Separators the user drags (or moves with the arrow keys, Home and End), and puts back with a double-click: the
// conversations sidebar's right edge (its width in pixels) and the divider between Settings → Team's two panels (the
// Team column's share, in percents). A value is shown while it moves and saved once it stops.
import { SIDEBAR_WIDTHS, TEAM_SPLIT } from "../shared/protocol.js";

/** What the chat keeps at the least beside the sidebar. */
const CHAT_MIN = 360;

/** The width to show for `want` in a window `windowWidth` wide: within the limits, and narrower if the chat needs the room. */
export function sidebarWidth(want: number, windowWidth: number): number {
  if (!Number.isFinite(want)) return SIDEBAR_WIDTHS.default;
  const max = Math.min(SIDEBAR_WIDTHS.max, windowWidth - CHAT_MIN);
  return Math.round(Math.max(SIDEBAR_WIDTHS.min, Math.min(max, want)));
}

/** The Team column's share (%) to show for `want`: whole, and within the limits. */
export function teamSplit(want: number): number {
  if (!Number.isFinite(want)) return TEAM_SPLIT.default;
  return Math.round(Math.max(TEAM_SPLIT.min, Math.min(TEAM_SPLIT.max, want)));
}

/** The share a drag that began at `start` (%) reaches once moved `dx` pixels across two panels `width` wide. */
export function splitDragged(start: number, dx: number, width: number): number {
  return width > 0 ? start + (dx / width) * 100 : start;
}

/** How one separator turns the user's gestures into a value. */
interface SeparatorOptions {
  label: string;
  title: string;
  min: number;
  max: number;
  step: number;
  reset: number;
  /** The value shown now. */
  shown(): number;
  /** Shows the value for `want` (within the limits) while it moves. */
  show(want: number): void;
  /** The value a drag that began at `start` reaches once the pointer moved `dx` pixels. */
  dragged(start: number, dx: number): number;
  /** The user chose what is shown: saved when it is new. */
  chosen(): void;
}

/** Makes `edge` a vertical separator: dragged, moved with the keys (Shift: three steps), reset with a double-click. */
function separator(edge: HTMLElement, o: SeparatorOptions, doc: Document): { dragging(): boolean } {
  let drag: { x: number; start: number; pointer: number } | null = null;
  edge.setAttribute("role", "separator");
  edge.setAttribute("aria-orientation", "vertical");
  edge.setAttribute("aria-label", o.label);
  edge.setAttribute("aria-valuemin", String(o.min));
  edge.setAttribute("aria-valuemax", String(o.max));
  edge.title = o.title;
  edge.tabIndex = 0;
  const choose = (want: number) => {
    o.show(want);
    o.chosen();
  };
  edge.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = { x: e.clientX, start: o.shown(), pointer: e.pointerId };
    edge.setPointerCapture(e.pointerId);
    doc.body.classList.add("resizing");
  });
  edge.addEventListener("pointermove", (e) => {
    if (drag?.pointer === e.pointerId) o.show(o.dragged(drag.start, e.clientX - drag.x));
  });
  const stop = (e: PointerEvent) => {
    if (drag?.pointer !== e.pointerId) return;
    drag = null;
    doc.body.classList.remove("resizing");
    o.chosen();
  };
  edge.addEventListener("pointerup", stop);
  edge.addEventListener("pointercancel", stop);
  edge.addEventListener("dblclick", () => choose(o.reset));
  edge.addEventListener("keydown", (e) => {
    const by = e.shiftKey ? o.step * 3 : o.step;
    const now = o.shown();
    const next = e.key === "ArrowLeft" ? now - by : e.key === "ArrowRight" ? now + by : e.key === "Home" ? o.min : e.key === "End" ? o.max : null;
    if (next === null) return;
    e.preventDefault();
    choose(next);
  });
  return { dragging: () => drag !== null };
}

export interface SidebarResizer {
  /** The width the preferences say (a new snapshot): shown unless the edge is being dragged. */
  set(width: number): void;
  /** The window changed size: the width is fitted to it again (nothing is saved). */
  fit(): void;
  /** The width shown now, in pixels. */
  width(): number;
}

/** Makes `edge` the separator that sets the CSS variable `--sidebar-w` on `doc`'s root; `save` keeps a width the user chose. */
export function sidebarResizer(edge: HTMLElement, save: (width: number) => void, doc: Document = document): SidebarResizer {
  const win = doc.defaultView!;
  let wanted: number = SIDEBAR_WIDTHS.default;
  let shown = 0;
  const show = (width: number) => {
    shown = sidebarWidth(width, win.innerWidth);
    doc.documentElement.style.setProperty("--sidebar-w", `${shown}px`);
    edge.setAttribute("aria-valuenow", String(shown));
  };
  const sep = separator(edge, {
    label: "Sidebar width", title: "Drag to resize the sidebar; double-click to reset",
    min: SIDEBAR_WIDTHS.min, max: SIDEBAR_WIDTHS.max, step: SIDEBAR_WIDTHS.step, reset: SIDEBAR_WIDTHS.default,
    shown: () => shown, show, dragged: (start, dx) => start + dx,
    chosen: () => {
      if (shown === wanted) return;
      wanted = shown;
      save(shown);
    },
  }, doc);
  show(wanted);
  return {
    set(width: number): void {
      wanted = width;
      if (!sep.dragging()) show(width);
    },
    fit: () => {
      if (!sep.dragging()) show(wanted);
    },
    width: () => shown,
  };
}

/**
 * Makes `edge` the divider between Settings → Team's two panels in `columns`: it sets the columns' `--team-left` and
 * `--team-right` (fractions of the two), starting from `start` (%); `save` keeps a share the user chose.
 */
export function teamSplitter(edge: HTMLElement, columns: HTMLElement, start: number, save: (split: number) => void, doc: Document = document): void {
  let wanted = teamSplit(start);
  let shown = 0;
  const show = (want: number) => {
    shown = teamSplit(want);
    columns.style.setProperty("--team-left", `${shown}fr`);
    columns.style.setProperty("--team-right", `${100 - shown}fr`);
    edge.setAttribute("aria-valuenow", String(shown));
    edge.setAttribute("aria-valuetext", `Team ${shown}%, Roles ${100 - shown}%`);
  };
  separator(edge, {
    label: "Team and Roles widths", title: "Drag to resize Team and Roles; double-click to reset",
    min: TEAM_SPLIT.min, max: TEAM_SPLIT.max, step: TEAM_SPLIT.step, reset: TEAM_SPLIT.default,
    shown: () => shown,
    show,
    // The two panels share the columns' width but the divider's own.
    dragged: (from, dx) => splitDragged(from, dx, columns.getBoundingClientRect().width - edge.getBoundingClientRect().width),
    chosen: () => {
      if (shown === wanted) return;
      wanted = shown;
      save(shown);
    },
  }, doc);
  show(wanted);
}
