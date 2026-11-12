// The conversations sidebar's width: its right edge is a separator the user drags (or moves with the arrow keys, Home
// and End), and a double-click puts it back. The width is shown while it moves and saved once it stops.
import { SIDEBAR_WIDTHS } from "../shared/protocol.js";

/** What the chat keeps at the least beside the sidebar. */
const CHAT_MIN = 360;

/** The width to show for `want` in a window `windowWidth` wide: within the limits, and narrower if the chat needs the room. */
export function sidebarWidth(want: number, windowWidth: number): number {
  if (!Number.isFinite(want)) return SIDEBAR_WIDTHS.default;
  const max = Math.min(SIDEBAR_WIDTHS.max, windowWidth - CHAT_MIN);
  return Math.round(Math.max(SIDEBAR_WIDTHS.min, Math.min(max, want)));
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
  let drag: { x: number; width: number; pointer: number } | null = null;
  edge.setAttribute("role", "separator");
  edge.setAttribute("aria-orientation", "vertical");
  edge.setAttribute("aria-label", "Sidebar width");
  edge.setAttribute("aria-valuemin", String(SIDEBAR_WIDTHS.min));
  edge.setAttribute("aria-valuemax", String(SIDEBAR_WIDTHS.max));
  edge.title = "Drag to resize the sidebar; double-click to reset";
  edge.tabIndex = 0;

  const show = (width: number) => {
    shown = sidebarWidth(width, win.innerWidth);
    doc.documentElement.style.setProperty("--sidebar-w", `${shown}px`);
    edge.setAttribute("aria-valuenow", String(shown));
  };
  /** The user chose `width`: shown, and saved when it is new. */
  const choose = (width: number) => {
    show(width);
    if (shown === wanted) return;
    wanted = shown;
    save(shown);
  };

  edge.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = { x: e.clientX, width: shown, pointer: e.pointerId };
    edge.setPointerCapture(e.pointerId);
    doc.body.classList.add("resizing");
  });
  edge.addEventListener("pointermove", (e) => {
    if (drag?.pointer === e.pointerId) show(drag.width + e.clientX - drag.x);
  });
  const stop = (e: PointerEvent) => {
    if (drag?.pointer !== e.pointerId) return;
    drag = null;
    doc.body.classList.remove("resizing");
    choose(shown);
  };
  edge.addEventListener("pointerup", stop);
  edge.addEventListener("pointercancel", stop);
  edge.addEventListener("dblclick", () => choose(SIDEBAR_WIDTHS.default));
  edge.addEventListener("keydown", (e) => {
    const by = e.shiftKey ? SIDEBAR_WIDTHS.step * 3 : SIDEBAR_WIDTHS.step;
    const next = e.key === "ArrowLeft" ? shown - by : e.key === "ArrowRight" ? shown + by : e.key === "Home" ? SIDEBAR_WIDTHS.min : e.key === "End" ? SIDEBAR_WIDTHS.max : null;
    if (next === null) return;
    e.preventDefault();
    choose(next);
  });

  show(wanted);
  return {
    set(width: number): void {
      wanted = width;
      if (!drag) show(width);
    },
    fit: () => {
      if (!drag) show(wanted);
    },
    width: () => shown,
  };
}
