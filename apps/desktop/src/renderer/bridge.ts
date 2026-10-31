/// <reference path="./global.d.ts" />
// The page's side of the preload: a typed request that throws on a refusal (so callers show it where they asked), and
// a few DOM helpers. Text always goes in as text (textContent), never as markup.
import { meterLevel } from "../../../../extensions/vscode/webview/account.js";
import type { DesktopEvent, DesktopRequest, DesktopResults } from "../shared/protocol.js";

export class RequestError extends Error {
  override name = "RequestError";
}

export async function call<R extends DesktopRequest>(request: R): Promise<DesktopResults[R["method"]]> {
  const answer = await window.agentduo.invoke(request);
  if (!answer.ok) throw new RequestError(answer.error);
  return answer.result as DesktopResults[R["method"]];
}

export function onEvent(listener: (event: DesktopEvent) => void): () => void {
  return window.agentduo.onEvent(listener);
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type Child = Node | string | number | null | undefined | false;

export interface Props {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string | null | undefined | false>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (e: HTMLElementEventMap[K]) => void }>;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.title) node.title = props.title;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  for (const [k, fn] of Object.entries(props.on ?? {})) node.addEventListener(k, fn as EventListener);
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(typeof c === "number" ? String(c) : c);
  return node;
}

export function icon(name: string): HTMLElement {
  return el("span", { class: `codicon codicon-${name}`, attrs: { "aria-hidden": "true" } });
}

export function button(label: string, onClick: () => void, o: { class?: string; icon?: string; title?: string; disabled?: boolean } = {}): HTMLButtonElement {
  const b = el("button", { class: `btn ${o.class ?? ""}`.trim(), title: o.title, attrs: { type: "button" } }, o.icon ? icon(o.icon) : null, label ? el("span", { text: label }) : null);
  if (!label && o.title) b.setAttribute("aria-label", o.title);
  b.disabled = !!o.disabled;
  b.addEventListener("click", onClick);
  return b;
}

/** A limit's thin meter, filled to `percent` (0 to 100): warning colour from 70%, full from 90%. */
export function meter(label: string, percent: number): HTMLElement {
  const level = meterLevel(percent);
  const fill = el("span", { class: level ? `fill ${level}` : "fill" });
  // Through the CSSOM: the page's policy allows no inline style attribute.
  fill.style.width = `${percent}%`;
  return el("div", { class: "meter", attrs: { role: "meter", "aria-label": label, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(percent) } }, fill);
}

/** Runs `work` with the button disabled, and shows a failure in `status` (when given). */
export async function busy(b: HTMLButtonElement | null, status: HTMLElement | null, work: () => Promise<void>): Promise<void> {
  if (b) b.disabled = true;
  if (status) {
    status.textContent = "";
    status.classList.remove("error");
  }
  try {
    await work();
  } catch (e) {
    if (status) {
      status.textContent = errorText(e);
      status.classList.add("error");
    }
  } finally {
    if (b) b.disabled = false;
  }
}

export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
