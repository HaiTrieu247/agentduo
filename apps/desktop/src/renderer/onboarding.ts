// The first run: both CLIs found and signed in (checked without a model call), how to install or sign in to the one
// that is not, then a project. Finishing (or skipping) it once is a desktop preference; Settings has the same checks.
import type { AccountUsage } from "../../../../extensions/vscode/src/protocol.js";
import type { CliStatus, LauncherInfo } from "../shared/protocol.js";
import { busy, button, call, el, errorText } from "./bridge.js";
import { cliCard, launcherNote } from "./settings.js";
import type { UsageStore } from "./usage.js";

export interface OnboardingHost {
  openProject(): Promise<boolean>;
  done(): Promise<void>;
  /** Both agents' accounts, shared with the sidebar's Account & Usage box. */
  usage: UsageStore;
}

export function needsSignIn(c: CliStatus): boolean {
  return c.state === "signed-out" || c.state === "unknown";
}

export function readyToGo(clis: CliStatus[]): boolean {
  return clis.length > 0 && clis.every((c) => c.state === "signed-in" || c.state === "installed" || c.state === "unknown");
}

export class Onboarding {
  /** Who each CLI signs in as, once the usage lookup answered (`codex login status` does not say its email). */
  private usage: AccountUsage | null = null;
  /** The cards drawn last, with what the check said. */
  private cards: { grid: HTMLElement; status: HTMLElement; r: { clis: CliStatus[]; launcher: LauncherInfo } } | null = null;

  constructor(private readonly root: HTMLElement, private readonly host: OnboardingHost) {}

  async open(): Promise<void> {
    this.root.replaceChildren(el("div", { class: "onboard-card" }, el("p", { class: "muted", text: "Checking Claude Code and Codex…" })));
    let r: { clis: CliStatus[]; launcher: LauncherInfo } | null = null;
    let error: string | null = null;
    try {
      r = await call({ method: "cli.status", projectId: null });
    } catch (e) {
      error = errorText(e);
    }
    this.draw(r, error);
    if (r?.clis.some((c) => c.state === "signed-in")) {
      void this.host.usage.refresh(null).then(() => {
        this.usage = this.host.usage.of(null)?.value ?? null;
        this.drawCards();
      });
    }
  }

  /** The CLI cards alone, so the email that comes later does not redraw (and refocus) the whole page. */
  private drawCards(): void {
    if (!this.cards?.grid.isConnected) return;
    const { grid, status, r } = this.cards;
    grid.replaceChildren(...r.clis.map((c) => cliCard(c, {
      pick: () => void busy(null, status, async () => {
        const next = await call({ method: "cli.pick", backend: c.backend });
        if (next) this.draw(next, null);
      }),
      install: () => void call({ method: "link.open", link: c.backend === "claude" ? "claude-install" : "codex-install" }).catch(() => undefined),
      ...(this.usage ? { usage: this.usage[c.backend] } : {}),
    })), launcherNote(r.launcher));
  }

  private draw(r: { clis: CliStatus[]; launcher: LauncherInfo } | null, error: string | null): void {
    const status = el("p", { class: "small status-line", attrs: { role: "status" } });
    const recheck = button("Recheck", () => void busy(recheck, status, () => this.open()), { class: "small", icon: "refresh" });
    const clis = el("div", { class: "cli-grid" });
    this.cards = r ? { grid: clis, status, r } : null;
    const signIn = r?.clis.filter(needsSignIn) ?? [];
    const steps: Node[] = [
      el("div", { class: "onboard-brand" }, el("span", { class: "brand-mark big", attrs: { "aria-hidden": "true" } }, el("span", { class: "dot dot-codex" }), el("span", { class: "dot dot-claude" })),
        el("h1", { text: "Welcome to AgentDuo" })),
      el("p", { class: "muted", text: "Codex plans and reviews; Claude Code critiques and implements. Both run on this computer as the CLIs you installed, signed in with your own accounts." }),
      el("h2", { text: "1. Claude Code and Codex" }),
      error ? el("p", { class: "error", text: error }) : clis,
      el("div", { class: "row-actions" }, recheck,
        button("Install Claude Code", () => void call({ method: "link.open", link: "claude-install" }).catch(() => undefined), { class: "small ghost", icon: "link-external" }),
        button("Install Codex", () => void call({ method: "link.open", link: "codex-install" }).catch(() => undefined), { class: "small ghost", icon: "link-external" })),
      el("h2", { text: "2. Sign in" }),
      el("p", { class: signIn.length ? "warn-text" : "muted", text: signIn.length
        ? `${signIn.map((c) => (c.backend === "claude" ? "Claude Code" : "Codex")).join(" and ")} may not be signed in.`
        : "Both CLIs say they are signed in (or AgentDuo could not tell)." }),
      el("ul", { class: "small" },
        el("li", {}, "Claude Code: in a terminal run ", el("code", { text: "claude" }), " and type ", el("code", { text: "/login" }), "."),
        el("li", {}, "Codex: in a terminal run ", el("code", { text: "codex login" }), ".")),
      el("h2", { text: "3. Start chatting" }),
      el("p", { class: "muted small", text: "Chat and /discuss work without a project. Open a project whenever you need to work on code; a pipeline needs a git repository." }),
    ];
    const pick = button("Open project…", () => void busy(pick, status, async () => {
      if (await this.host.openProject()) await this.host.done();
    }), { class: "primary", icon: "folder-opened" });
    const skip = button(r && readyToGo(r.clis) ? "Continue without a project" : "Skip for now", () => void busy(skip, status, () => this.host.done()), { class: "ghost" });
    steps.push(el("div", { class: "row-actions" }, pick, skip), status);
    this.root.replaceChildren(el("div", { class: "onboard-card", attrs: { role: "dialog", "aria-label": "Set up AgentDuo" } }, ...steps));
    this.drawCards();
    pick.focus();
  }
}
