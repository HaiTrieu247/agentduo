// The small controls Settings → Team's forms are made of (a member's, a role's): each calls back with what changed.
import { el } from "./bridge.js";

export function select(options: Array<[string, string]>, value: string, onChange: (v: string) => void, label: string, cls?: string): HTMLSelectElement {
  const s = el("select", { class: cls, attrs: { "aria-label": label } }, ...options.map(([v, text]) => {
    const o = el("option", { text, attrs: { value: v } });
    o.selected = v === value;
    return o;
  }));
  s.addEventListener("change", () => onChange(s.value));
  return s;
}

export function input(value: string, onChange: (v: string) => void, label: string, o: { placeholder?: string; type?: string; class?: string } = {}): HTMLInputElement {
  const i = el("input", { class: o.class, attrs: { type: o.type ?? "text", "aria-label": label, placeholder: o.placeholder ?? "" } });
  i.value = value;
  i.addEventListener("input", () => onChange(i.value));
  return i;
}

export function checkbox(checked: boolean, onChange: (v: boolean) => void, label: string, text: string): HTMLLabelElement {
  const box = el("input", { attrs: { type: "checkbox", "aria-label": label } });
  box.checked = checked;
  box.addEventListener("change", () => onChange(box.checked));
  return el("label", { class: "check-label" }, box, el("span", { text }));
}

export function segmented(options: Array<[string, string]>, value: string, onChange: (v: string) => void, label: string): HTMLElement {
  return el("div", { class: "segmented", attrs: { role: "radiogroup", "aria-label": label } }, ...options.map(([v, text]) => {
    const b = el("button", { class: `seg${v === value ? " active" : ""}`, text, attrs: { type: "button", role: "radio", "aria-checked": String(v === value) } });
    b.addEventListener("click", () => onChange(v));
    return b;
  }));
}
