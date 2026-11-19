// "Mở" when main must close something (design section 8, `docs/superpowers/specs/2026-11-18-desktop-open-markdown-design.md`):
// quitting, closing the window and restarting into an update first ask the page about the documents it said hold
// unsaved edits, and go only on its answer. No Electron here: index.ts wires it to the window and the app.
import type { DesktopEvent, DocumentCloseOutcome, DocumentCloseReason } from "../shared/protocol.js";

type CloseRequest = Extract<DesktopEvent, { type: "documentCloseRequest" }>;

export interface CloseGuardOptions {
  /** The sessions the page said hold unsaved edits (`DocumentService.dirtyIds`). */
  dirtyIds(): string[];
  /** Main's own record of one session, checked after the page answers: nothing is lost on a page's word. */
  isDirty(documentId: string): boolean;
  /** Posts the request to a page that can answer it (and shows the window); false when there is none. */
  ask(request: CloseRequest): boolean;
  /** Brings the window forward: someone closes or quits while a request waits. */
  focus(): void;
  log?(line: string): void;
}

interface Waiting {
  requestId: string;
  documentIds: string[];
  resolve(go: boolean): void;
}

export class DocumentCloseGuard {
  private counter = 0;
  private waiting: Waiting | null = null;

  constructor(private readonly o: CloseGuardOptions) {}

  /**
   * May main close the window or quit now? `true`: no document holds unsaved edits, go at once. `false`: a request
   * already waits for the page (the window comes forward), so this close stays. Otherwise the page's decision: true to
   * go, false to stay. Every call asks anew: a decision covers the close that asked for it, never a later one.
   */
  check(reason: DocumentCloseReason): boolean | Promise<boolean> {
    if (this.waiting) {
      this.o.focus();
      return false;
    }
    const documentIds = this.o.dirtyIds();
    if (!documentIds.length) return true;
    const requestId = `q${++this.counter}`;
    return new Promise<boolean>((resolve) => {
      this.waiting = { requestId, documentIds, resolve };
      if (!this.o.ask({ type: "documentCloseRequest", requestId, reason, documentIds })) {
        this.o.log?.(`documents: nobody can answer for ${documentIds.length} with unsaved edits; the ${reason} goes on`);
        this.finish(true);
      }
    });
  }

  /**
   * The page's answer (`document.closeResponse`). False for a request it does not know or answered already. `settled`
   * goes only if main's record agrees that no listed document still holds unsaved edits.
   */
  respond(requestId: string, outcome: DocumentCloseOutcome): boolean {
    const w = this.waiting;
    if (!w || w.requestId !== requestId) return false;
    const left = outcome === "settled" ? w.documentIds.filter((id) => this.o.isDirty(id)) : [];
    if (left.length) this.o.log?.(`documents: the page settled ${requestId}, but ${left.join(", ")} still holds unsaved edits; staying`);
    this.finish(outcome === "settled" && !left.length);
    return true;
  }

  /** The page went while it was asked (the window closed, its renderer crashed): nobody can answer, so main goes. */
  pageGone(): void {
    if (this.waiting) this.finish(true);
  }

  private finish(go: boolean): void {
    const w = this.waiting;
    this.waiting = null;
    w?.resolve(go);
  }
}
