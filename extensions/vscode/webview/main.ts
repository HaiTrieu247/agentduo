import type { HostMessage, WebviewMessage } from "../src/protocol.js";
import { createUi } from "./render.js";
import { reduce, type ViewState } from "./state.js";

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void; getState(): unknown; setState(state: unknown): void };

const vscode = acquireVsCodeApi();
const saved = vscode.getState() as { draft?: string } | undefined;
let state: ViewState | null = null;
let frame = 0;

const ui = createUi(document.getElementById("app")!, {
  submit: (text) => vscode.postMessage({ type: "submit", text }),
  interrupt: () => vscode.postMessage({ type: "interrupt" }),
  toggleEdits: () => vscode.postMessage({ type: "toggleEdits" }),
  decide: (id, decision, note) => state && vscode.postMessage({ type: "decision", generation: state.generation, id, decision, note }),
  permit: (id, answer) => state && vscode.postMessage({ type: "permission", generation: state.generation, id, answer }),
  command: (name) => vscode.postMessage({ type: "command", name }),
  // The webview is recreated whenever the sidebar is shown again; a half-typed message survives that.
  draft: (text) => vscode.setState({ draft: text }),
}, saved?.draft ?? "");

function schedule(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (state) ui.update(state);
  });
}

window.addEventListener("message", (e: MessageEvent<HostMessage>) => {
  const m = e.data;
  if (!m || typeof m !== "object") return;
  if (m.type === "snapshot") state = m.state;
  else if (m.type === "actions" && state) for (const action of m.actions) state = reduce(state, action);
  else if (m.type === "focusComposer") ui.focusComposer();
  schedule();
});

// VS Code focuses the webview, not an element in it (Open Chat, the activity bar, a view shortcut), so typing would go
// nowhere: the composer takes that focus. A click is left alone; it focuses what it lands on.
let pointerDown = false;
window.addEventListener("pointerdown", () => (pointerDown = true), true);
window.addEventListener("pointerup", () => (pointerDown = false), true);
window.addEventListener("blur", () => (pointerDown = false)); // a press released outside the webview
window.addEventListener("focus", () => {
  if (!pointerDown && document.activeElement === document.body) ui.focusComposer();
});

setInterval(() => ui.tick(), 1000);
vscode.postMessage({ type: "ready" });
