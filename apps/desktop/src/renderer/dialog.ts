// The desktop's confirmation dialog, in place of the browser's confirm(): drawn with the app's theme, labelled for a
// screen reader (an alertdialog named by its title, described by its message), modal (the rest of the page is inert
// while it is open), focus on the safer button first, Tab and Shift+Tab kept inside it, Escape or a click outside
// cancels, and focus goes back to what opened it. One at a time: a new one cancels the one open.
// It names the DOM it uses (`doc`), so its tests drive it on a small fake document.

export interface ConfirmOptions {
  /** The question, as the dialog's title: "Delete «Plan»?" */
  title: string;
  /** What happens, in a sentence or two. */
  message?: string;
  /** The confirming button's word: "Delete", "Remove", "Restart". */
  confirm: string;
  /** The cancelling button's word: "Cancel" by default. */
  cancel?: string;
  /** The action destroys something or stops work: the confirming button says so in the error colour. */
  destructive?: boolean;
  /** The button focused first: the cancelling one by default, so Enter alone never confirms by accident. */
  initial?: "confirm" | "cancel";
}

/** Where Tab goes from `index` among `count` controls (Shift+Tab backwards), wrapping at both ends. */
export function trapIndex(count: number, index: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (index < 0) return backwards ? count - 1 : 0;
  return (index + (backwards ? count - 1 : 1)) % count;
}

let open: { close(result: boolean): void } | null = null;
let ids = 0;

/** Where `node` is in the page: its index among its parent's children, at each level from the root. */
function pathOf(node: Element): number[] {
  const path: number[] = [];
  for (let n: Element = node; n.parentElement; n = n.parentElement) path.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
  return path;
}

/** What names a control for the user: a redrawn copy of it says the same. */
const nameOf = (e: Element) => `${e.tagName} ${e.getAttribute("title") ?? ""} ${e.getAttribute("aria-label") ?? ""} ${e.textContent ?? ""}`;

/**
 * Remembers the control that has focus now (what opens a dialog or a page) and returns what gives focus back to it:
 * to it, or, when a redraw replaced it meanwhile (the sidebar is drawn again whole on each change), to its copy at the
 * same place.
 */
export function rememberFocus(doc: Document = document): () => void {
  const active = doc.activeElement as HTMLElement | null;
  const opener = active && active !== doc.body ? active : null;
  let path: number[] | null = null;
  try {
    if (opener) path = pathOf(opener);
  } catch {
    path = null;
  }
  return () => focusTarget(doc, opener, path)?.focus();
}

function focusTarget(doc: Document, opener: HTMLElement | null, path: number[] | null): HTMLElement | null {
  if (!opener) return null;
  if (opener.isConnected) return opener;
  if (!path) return null;
  let n: Element | undefined = doc.documentElement;
  for (const i of path) {
    n = n?.children[i];
    if (!n) return null;
  }
  return n && nameOf(n) === nameOf(opener) ? (n as HTMLElement) : null;
}

/** Asks `o.title`; resolves true when confirmed, false when cancelled (button, Escape, a click outside, or another dialog). */
export function confirmDialog(o: ConfirmOptions, doc: Document = document): Promise<boolean> {
  open?.close(false);
  const id = `dialog-${++ids}`;
  const giveFocusBack = rememberFocus(doc);
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const scrim = make("div", "dialog-scrim");
  const box = make("div", "dialog");
  box.setAttribute("role", "alertdialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-labelledby", `${id}-title`);
  const title = make("h2", "dialog-title", o.title);
  title.id = `${id}-title`;
  box.append(title);
  if (o.message) {
    const message = make("p", "dialog-message", o.message);
    message.id = `${id}-message`;
    box.setAttribute("aria-describedby", message.id);
    box.append(message);
  }
  const cancel = make("button", "btn dialog-cancel", o.cancel ?? "Cancel");
  const confirm = make("button", `btn ${o.destructive ? "danger" : "primary"} dialog-confirm`, o.confirm);
  cancel.setAttribute("type", "button");
  confirm.setAttribute("type", "button");
  const actions = make("div", "dialog-actions");
  actions.append(cancel, confirm);
  box.append(actions);
  scrim.append(box);

  // The rest of the page is inert while the dialog is open (no click, no focus, hidden from a screen reader); what
  // was inert already stays so afterwards.
  const madeInert: Element[] = [];
  for (const child of Array.from(doc.body.children)) {
    if (child.hasAttribute("inert")) continue;
    child.setAttribute("inert", "");
    madeInert.push(child);
  }
  doc.body.append(scrim);

  const controls = [cancel, confirm];
  return new Promise<boolean>((resolve) => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(false);
      } else if (e.key === "Tab") {
        e.preventDefault();
        controls[trapIndex(controls.length, controls.indexOf(doc.activeElement as HTMLButtonElement), e.shiftKey)]?.focus();
      }
    };
    // Outside the box: a press that starts and ends on the scrim (not a drag out of the box) cancels.
    let downOnScrim = false;
    const onDown = (e: MouseEvent) => (downOnScrim = e.target === scrim);
    const onClick = (e: MouseEvent) => {
      if (downOnScrim && e.target === scrim) close(false);
      downOnScrim = false;
    };
    const close = (result: boolean) => {
      if (open !== handle) return;
      open = null;
      doc.removeEventListener("keydown", onKey, true);
      scrim.remove();
      for (const node of madeInert) node.removeAttribute("inert");
      giveFocusBack();
      resolve(result);
    };
    const handle = { close };
    open = handle;
    // Capturing, so the chat's own keys (Escape stops a run) never see a key meant for the dialog.
    doc.addEventListener("keydown", onKey, true);
    scrim.addEventListener("mousedown", onDown);
    scrim.addEventListener("click", onClick);
    cancel.addEventListener("click", () => close(false));
    confirm.addEventListener("click", () => close(true));
    ((o.initial ?? "cancel") === "confirm" ? confirm : cancel).focus();
  });
}
