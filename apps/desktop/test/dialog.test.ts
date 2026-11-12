// The confirmation dialog (renderer/dialog.ts) on a small fake document: its labels, the button focused first, Tab
// kept inside, Escape and a click outside cancelling, the page inert while it is open, and focus given back.
import { describe, expect, it } from "vitest";
import { confirmDialog, trapIndex } from "../src/renderer/dialog.js";

type Listener = (e: FakeEvent) => void;
interface FakeEvent { type: string; key?: string; shiftKey?: boolean; target: FakeElement | null; defaultPrevented: boolean; preventDefault(): void; stopPropagation(): void }

class FakeElement {
  className = "";
  textContent = "";
  id = "";
  parent: FakeElement | null = null;
  children: FakeElement[] = [];
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Listener[]>();
  constructor(readonly tagName: string, readonly doc: FakeDocument) {}
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  hasAttribute(k: string) { return this.attrs.has(k); }
  removeAttribute(k: string) { this.attrs.delete(k); }
  append(...nodes: FakeElement[]) {
    for (const n of nodes) {
      n.remove();
      n.parent = this;
      this.children.push(n);
    }
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  get isConnected(): boolean {
    let n: FakeElement | null = this;
    while (n) {
      if (n === this.doc.body) return true;
      n = n.parent;
    }
    return false;
  }
  addEventListener(type: string, fn: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  focus() { this.doc.activeElement = this; }
  /** A click as the browser makes it: the press, then the click, on this element and up through its parents. */
  click() {
    for (const type of ["mousedown", "click"]) {
      const e = event(type, this);
      for (let n: FakeElement | null = this; n; n = n.parent) for (const fn of n.listeners.get(type) ?? []) fn(e);
    }
  }
  find(cls: string): FakeElement | undefined {
    for (const c of this.children) {
      if (c.className.split(" ").includes(cls)) return c;
      const deeper = c.find(cls);
      if (deeper) return deeper;
    }
    return undefined;
  }
}

function event(type: string, target: FakeElement | null, more: Partial<FakeEvent> = {}): FakeEvent {
  const e: FakeEvent = { type, target, defaultPrevented: false, preventDefault: () => (e.defaultPrevented = true), stopPropagation: () => {}, ...more };
  return e;
}

class FakeDocument {
  activeElement: FakeElement | null = null;
  readonly body: FakeElement;
  private keyListeners: Listener[] = [];
  constructor() {
    this.body = new FakeElement("body", this);
  }
  createElement(tag: string) { return new FakeElement(tag, this); }
  addEventListener(type: string, fn: Listener) { if (type === "keydown") this.keyListeners.push(fn); }
  removeEventListener(type: string, fn: Listener) { if (type === "keydown") this.keyListeners = this.keyListeners.filter((f) => f !== fn); }
  key(key: string, shiftKey = false): FakeEvent {
    const e = event("keydown", this.activeElement, { key, shiftKey });
    for (const fn of [...this.keyListeners]) fn(e);
    return e;
  }
}

/** A page with the app's root and a button that opens the dialog (focused, as a click leaves it). */
function page() {
  const doc = new FakeDocument();
  const root = doc.createElement("div");
  const opener = doc.createElement("button");
  root.append(opener);
  doc.body.append(root);
  opener.focus();
  return { doc, root, opener, asDoc: doc as unknown as Document };
}

const parts = (doc: FakeDocument) => {
  const scrim = doc.body.find("dialog-scrim");
  return { scrim, box: scrim?.find("dialog"), cancel: scrim?.find("dialog-cancel"), confirm: scrim?.find("dialog-confirm"), title: scrim?.find("dialog-title"), message: scrim?.find("dialog-message") };
};

describe("trapIndex", () => {
  it("goes forward and back, wrapping at both ends, and starts at an end when focus is outside", () => {
    expect([0, 1, 2].map((i) => trapIndex(3, i, false))).toEqual([1, 2, 0]);
    expect([0, 1, 2].map((i) => trapIndex(3, i, true))).toEqual([2, 0, 1]);
    expect(trapIndex(3, -1, false)).toBe(0);
    expect(trapIndex(3, -1, true)).toBe(2);
    expect(trapIndex(0, 0, false)).toBe(-1);
  });
});

describe("confirmDialog", () => {
  it("is an alertdialog named by its title and described by its message, with both buttons' words", () => {
    const { doc, asDoc } = page();
    void confirmDialog({ title: "Delete «Plan»?", message: "This cannot be undone.", confirm: "Delete", destructive: true }, asDoc);
    const { box, title, message, cancel, confirm } = parts(doc);
    expect(box!.getAttribute("role")).toBe("alertdialog");
    expect(box!.getAttribute("aria-modal")).toBe("true");
    expect(box!.getAttribute("aria-labelledby")).toBe(title!.id);
    expect(box!.getAttribute("aria-describedby")).toBe(message!.id);
    expect(title!.textContent).toBe("Delete «Plan»?");
    expect(message!.textContent).toBe("This cannot be undone.");
    expect(cancel!.textContent).toBe("Cancel");
    expect(cancel!.getAttribute("type")).toBe("button");
    expect(confirm!.textContent).toBe("Delete");
    expect(confirm!.className.split(" ")).toContain("danger");
    doc.key("Escape");
  });

  it("names nothing it does not have: no message, no aria-describedby; not destructive, a primary button", () => {
    const { doc, asDoc } = page();
    void confirmDialog({ title: "Remove?", confirm: "Remove", cancel: "Keep" }, asDoc);
    const { box, message, cancel, confirm } = parts(doc);
    expect(message).toBeUndefined();
    expect(box!.hasAttribute("aria-describedby")).toBe(false);
    expect(cancel!.textContent).toBe("Keep");
    expect(confirm!.className.split(" ")).toContain("primary");
    doc.key("Escape");
  });

  it("focuses the cancelling button first, or the confirming one when asked", () => {
    const a = page();
    void confirmDialog({ title: "?", confirm: "Yes" }, a.asDoc);
    expect(a.doc.activeElement).toBe(parts(a.doc).cancel);
    a.doc.key("Escape");
    const b = page();
    void confirmDialog({ title: "?", confirm: "Yes", initial: "confirm" }, b.asDoc);
    expect(b.doc.activeElement).toBe(parts(b.doc).confirm);
    b.doc.key("Escape");
  });

  it("confirms: resolves true, leaves the page as it was, and gives focus back to what opened it", async () => {
    const { doc, root, opener, asDoc } = page();
    const answer = confirmDialog({ title: "Remove?", confirm: "Remove" }, asDoc);
    expect(root.hasAttribute("inert")).toBe(true);
    parts(doc).confirm!.click();
    await expect(answer).resolves.toBe(true);
    expect(parts(doc).scrim).toBeUndefined();
    expect(root.hasAttribute("inert")).toBe(false);
    expect(doc.activeElement).toBe(opener);
  });

  it.each([
    ["the cancelling button", (doc: FakeDocument) => parts(doc).cancel!.click()],
    ["Escape", (doc: FakeDocument) => expect(doc.key("Escape").defaultPrevented).toBe(true)],
    ["a click outside the box", (doc: FakeDocument) => parts(doc).scrim!.click()],
  ])("cancels with %s: resolves false and gives focus back", async (_, how) => {
    const { doc, opener, asDoc } = page();
    const answer = confirmDialog({ title: "Delete?", confirm: "Delete", destructive: true }, asDoc);
    how(doc);
    await expect(answer).resolves.toBe(false);
    expect(parts(doc).scrim).toBeUndefined();
    expect(doc.activeElement).toBe(opener);
  });

  it("stays open on a click inside the box, and on keys other than Escape and Tab", async () => {
    const { doc, asDoc } = page();
    let settled = false;
    const answer = confirmDialog({ title: "Delete?", message: "Sure?", confirm: "Delete" }, asDoc).then((r) => ((settled = true), r));
    parts(doc).message!.click();
    parts(doc).box!.click();
    doc.key("a");
    doc.key("Enter");
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(parts(doc).scrim).toBeDefined();
    doc.key("Escape");
    await expect(answer).resolves.toBe(false);
  });

  it("keeps Tab and Shift+Tab inside the dialog", () => {
    const { doc, asDoc } = page();
    void confirmDialog({ title: "?", confirm: "Yes" }, asDoc);
    const { cancel, confirm } = parts(doc);
    expect(doc.key("Tab").defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(confirm);
    doc.key("Tab");
    expect(doc.activeElement).toBe(cancel);
    doc.key("Tab", true);
    expect(doc.activeElement).toBe(confirm);
    // Focus somewhere else (the window lost it): Tab comes back to the first button.
    doc.activeElement = null;
    doc.key("Tab");
    expect(doc.activeElement).toBe(cancel);
    doc.key("Escape");
  });

  it("leaves inert what was inert before it opened", async () => {
    const { doc, root, asDoc } = page();
    const other = doc.createElement("section");
    other.setAttribute("inert", "");
    doc.body.append(other);
    const answer = confirmDialog({ title: "?", confirm: "Yes" }, asDoc);
    doc.key("Escape");
    await answer;
    expect(other.hasAttribute("inert")).toBe(true);
    expect(root.hasAttribute("inert")).toBe(false);
  });

  it("one at a time: a new dialog cancels the open one, and only the new one is left", async () => {
    const { doc, asDoc } = page();
    const first = confirmDialog({ title: "First?", confirm: "Yes" }, asDoc);
    const second = confirmDialog({ title: "Second?", confirm: "Yes" }, asDoc);
    await expect(first).resolves.toBe(false);
    expect(doc.body.children.filter((c) => c.className === "dialog-scrim")).toHaveLength(1);
    expect(parts(doc).title!.textContent).toBe("Second?");
    parts(doc).confirm!.click();
    await expect(second).resolves.toBe(true);
    expect(doc.body.children.some((c) => c.hasAttribute("inert"))).toBe(false);
  });

  it("does not give focus back to an opener that left the page meanwhile (a list drawn again)", async () => {
    const { doc, opener, asDoc } = page();
    const answer = confirmDialog({ title: "Delete?", confirm: "Delete" }, asDoc);
    opener.remove();
    parts(doc).confirm!.click();
    await expect(answer).resolves.toBe(true);
    expect(doc.activeElement).not.toBe(opener);
  });
});
