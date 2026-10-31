// The Activity Bar's Account & Usage view: both agents' accounts and limits, which the host looks up and sends whole.
// Every string goes in as a text node; its two buttons only name what they want (refresh, details).
import type { AccountHostMessage, AccountViewMessage, AccountViewState } from "../src/protocol.js";
import { accountRows, updatedText, type AccountRow } from "./account.js";
import { h, icon, providerMark } from "./dom.js";
import type { Agent } from "../../../src/events.js";

declare function acquireVsCodeApi(): { postMessage(message: AccountViewMessage): void };

const vscode = acquireVsCodeApi();
const app = document.getElementById("app")!;
let state: AccountViewState | null = null;

function row(agent: Agent, r: AccountRow): HTMLElement {
  const value = r.value ? h("span", { class: "value", title: r.value }, r.value) : null;
  switch (r.kind) {
    case "agent":
      return h("div", { class: "row agent", role: "heading", attrs: { "aria-level": "2" } }, providerMark(agent), h("span", { class: "label" }, r.text), value);
    case "field":
    case "limit":
      return h("div", { class: `row ${r.kind}` }, h("span", { class: "label", title: r.text }, r.text), value);
    case "bar": {
      const percent = r.percent ?? 0;
      const fill = h("span", { class: `fill${percent >= 90 ? " full" : percent >= 70 ? " high" : ""}` });
      // Through the CSSOM: the page's policy allows no inline style attribute.
      fill.style.width = `${percent}%`;
      return h("div", { class: "meter", role: "meter", label: r.text, attrs: { "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(percent) } }, fill);
    }
    case "error":
      return h("div", { class: "error" }, icon("error"), h("span", {}, r.text));
    default:
      return h("div", { class: r.kind }, r.text);
  }
}

function render(): void {
  if (!state) return;
  const { usage, refreshing, problem, updatedAt } = state;
  const parts: HTMLElement[] = [];
  if (problem) parts.push(h("div", { class: "error problem", role: "alert" }, icon("error"), h("span", {}, problem)));
  // Before the first answer, both agents say they are loading; a lookup that could not run at all only says why.
  if (usage || refreshing) {
    for (const agent of ["claude", "codex"] as const) {
      parts.push(h("section", { class: "agent-part", label: `${agent === "claude" ? "Claude Code" : "Codex"} account and usage` },
        ...accountRows(agent, usage?.[agent] ?? null).map((r) => row(agent, r))));
    }
  }
  const updated = updatedText(updatedAt, Date.now());
  const details = h("button", { class: "link", attrs: { type: "button" } }, "View details");
  details.addEventListener("click", () => vscode.postMessage({ type: "details" }));
  const foot = h("footer", { class: "foot" },
    refreshing ? icon("sync codicon-modifier-spin") : null,
    h("span", {}, refreshing ? (usage ? "Updating…" : "Looking up…") : updated),
    usage ? h("span", { attrs: { "aria-hidden": "true" } }, "·") : null,
    usage ? details : null);
  if (refreshing || updated || usage) parts.push(foot);
  app.replaceChildren(...parts);
  app.setAttribute("aria-busy", String(refreshing));
}

window.addEventListener("message", (e: MessageEvent<AccountHostMessage>) => {
  if (e.data?.type !== "account") return;
  state = e.data.state;
  render();
});

// "Updated 3 min ago" keeps its age.
setInterval(render, 30_000);
vscode.postMessage({ type: "ready" });
