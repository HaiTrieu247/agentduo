// "Mở" (Open): the page's side of opening a document from a link in the chat (design docs/superpowers/specs/
// 2026-11-18-desktop-open-markdown-design.md, sections 5, 6 and 8). It names a link by the id main granted and a
// document by the id main gave its session; it never sends a path.
//
//  - `DocumentController` holds the open document and every decision about it, with no DOM: opening (a link id), the
//    unsaved state (`dirty`, told to main with `document.dirty`), saving (only when the user asks; a later answer never
//    marks clean what was typed meanwhile, and a failure keeps the text), and leaving it (the one question with three
//    answers, Save, Discard or Keep editing, for every way out: closing it, another document, another conversation or
//    project, a page over it, quitting or closing the window).
//  - `DocumentLayer` draws it in the middle of the window over the chat: the feature's name, the file's name and where it
//    is, its state, Save and Close, what went wrong, and the format's viewer.
//  - The viewer is picked by the document's format (`VIEWERS`): a new type is one more entry, and a format with none is
//    shown as an error, never a blank page. Nothing else here knows a format.
import { formatById, type DocumentError, type DocumentErrorCode, type DocumentInfo, type DocumentOpened, type DocumentSaved } from "../shared/documents.js";
import type { DesktopEvent, DesktopRequest, DesktopResults } from "../shared/protocol.js";
import { createMarkdownViewer, type DocumentViewer, type ViewerContext } from "./markdown-editor.js";

export type ViewerFactory = (ctx: ViewerContext) => DocumentViewer;

/** Each format's viewer, keyed by `DocumentFormat.id` (shared/documents.ts). */
export const VIEWERS: Readonly<Record<string, ViewerFactory>> = { markdown: createMarkdownViewer };

/** The three answers to leaving a document with unsaved edits. */
export type LeaveChoice = "save" | "discard" | "keep";
/** Why the page asks: the user leaves it, or main is about to quit or close the window. */
export type LeaveReason = "leave" | "quit" | "window";

export type SaveStatus = "clean" | "dirty" | "saving" | "saved" | "error" | "read-only";

/** What went wrong with the open document, and what the user can do about it. */
/**
 * A problem the page shows: main's errors, and the page's own `reload-superseded` (a reload answered after the user typed
 * again: the page keeps what they typed and nothing is replaced).
 */
export type PageError = Omit<DocumentError, "code"> & { code: DocumentErrorCode | "reload-superseded" };

export interface Problem {
  error: PageError;
  /** The model's reasons, one per line, when the text could not be written safely. */
  details: string[];
  actions: Array<"retry" | "reload" | "overwrite">;
  /** What failed: saving or reading the open document, or opening another one (the open one is untouched). */
  context: "save" | "reload" | "open";
}

export interface OpenLink {
  projectId: string;
  conversationId: string;
  view: number;
  linkId: string;
  /** The link's text, shown while it opens and when it cannot. */
  label: string;
}

type Request = <R extends DesktopRequest>(request: R) => Promise<DesktopResults[R["method"]]>;

export interface ControllerDeps {
  request: Request;
  /** The Save / Discard / Keep editing question. */
  ask(question: { name: string; reason: LeaveReason }): Promise<LeaveChoice>;
  /** A yes or no before something that loses work (reload over edits, overwrite what is on disk). */
  confirm(question: { title: string; message: string; confirm: string; destructive: boolean }): Promise<boolean>;
  viewers?: Readonly<Record<string, ViewerFactory>>;
  doc?: Document;
}

interface Open {
  info: DocumentInfo;
  revision: string;
  viewer: DocumentViewer | null;
  /** Edits the viewer reported; `savedAt` is how many there were when the last successful save took its text. */
  edits: number;
  savedAt: number | null;
  saving: Promise<boolean> | null;
  problem: Problem | null;
  /** What main was last told about unsaved edits. */
  told: boolean;
  /** The format has no viewer here. */
  unsupported: boolean;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The life of the requests that open a document and of the sessions they get from main, in one place:
 *  - Every click on a link is a generation (`opening`). Only the latest one may show its document, and it checks that
 *    after every wait (main's answer, the question when it replaces a document with unsaved edits). A way out of the
 *    document that the user takes (closing it, another conversation, project or page: `leave`) starts a generation of
 *    its own, so an open asked before it never shows afterwards. The open that replaces a document leaves it from the
 *    inside (`leave(…, internal)`), which does not end its own generation.
 *  - Main gives one session per file (R39), so two opens may hold the same `documentId`. A session nobody shows any more
 *    is not closed at once: it is `abandoned`, and closed (`sweep`) only when no open is still waiting for main (any of
 *    them may come back with it) and neither the shown document nor an open about to show one (`candidates`) holds it.
 *    Once every request has ended, every abandoned session has been closed.
 */
export class DocumentController {
  private current: Open | null = null;
  private opening = 0;
  /** Opens sent to main and not answered yet, by generation. */
  private readonly inflight = new Set<number>();
  /** Opens answered and about to show their session, once the shown document is left, by generation. */
  private readonly candidates = new Map<number, string>();
  /** Sessions nothing shows any more, to close once nothing may still hold them. */
  private readonly abandoned = new Set<string>();
  /** A link being opened (no document shown yet), and why the last one could not be. */
  loading: { label: string } | null = null;
  openError: { error: DocumentError; retry: (() => void) | null } | null = null;
  private listeners = new Set<() => void>();

  constructor(private readonly deps: ControllerDeps) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  get document(): DocumentInfo | null {
    return this.current?.info ?? null;
  }

  get viewer(): DocumentViewer | null {
    return this.current?.viewer ?? null;
  }

  get problem(): Problem | null {
    return this.current?.problem ?? null;
  }

  get unsupported(): boolean {
    return this.current?.unsupported ?? false;
  }

  /** The layer shows something: a document, one being opened, or why it could not be. */
  get shown(): boolean {
    return !!(this.current || this.loading || this.openError);
  }

  /** The page holds edits the file does not have. */
  dirty(): boolean {
    const o = this.current;
    if (!o?.viewer) return false;
    return o.savedAt === null ? o.viewer.edited() : o.edits !== o.savedAt;
  }

  get status(): SaveStatus {
    const o = this.current;
    if (!o) return "clean";
    if (o.saving) return "saving";
    if (o.problem && o.problem.context !== "open" && o.problem.error.code !== "reload-superseded") return "error";
    if (!o.info.save.allowed) return "read-only";
    if (this.dirty()) return "dirty";
    return o.savedAt !== null ? "saved" : "clean";
  }

  get canSave(): boolean {
    const o = this.current;
    return !!o?.viewer && o.info.save.allowed && !o.saving && (this.dirty() || o.problem !== null);
  }

  /** The user clicked a link in the chat. */
  async openLink(link: OpenLink): Promise<void> {
    const token = ++this.opening;
    const live = () => token === this.opening;
    if (!this.current) {
      this.loading = { label: link.label };
      this.openError = null;
      this.emit();
    }
    this.inflight.add(token);
    let r: DocumentOpened;
    try {
      r = await this.deps.request({ method: "document.open", projectId: link.projectId, conversationId: link.conversationId, view: link.view, linkId: link.linkId });
    } catch (e) {
      r = { ok: false, error: { code: "unreadable", retryable: true, message: `Không mở được “${link.label}”: ${errorText(e)}` } };
    } finally {
      this.inflight.delete(token);
    }
    if (!live()) {
      // A later click, or the user leaving, won: the session this answer holds may be another's too (one per file).
      if (r.ok) this.abandon(r.document.documentId);
      else this.sweep();
      return;
    }
    this.loading = null;
    if (!r.ok) {
      const retry = r.error.retryable ? () => void this.openLink(link) : null;
      if (this.current) this.current.problem = { error: r.error, details: [], actions: [], context: "open" };
      else this.openError = { error: r.error, retry };
      this.emit();
      return this.sweep();
    }
    const id = r.document.documentId;
    if (this.current?.info.documentId === id) {
      // The same file: it stays as it is, with its edits.
      this.emit();
      this.current.viewer?.reveal(r.document.position, r.document.anchor);
      return this.sweep();
    }
    if (this.current) {
      // The shown document is left first (asked when it has unsaved edits); this session waits, held, meanwhile.
      this.candidates.set(token, id);
      let left = false;
      try {
        left = await this.leave("leave", true);
      } finally {
        this.candidates.delete(token);
      }
      if (!left || !live() || this.current) return this.abandon(id);
    }
    this.show(r.document);
    this.sweep();
  }

  /** A session nothing shows any more: closed once nothing may still hold it. */
  private abandon(documentId: string): void {
    this.abandoned.add(documentId);
    this.sweep();
  }

  /** Closes the abandoned sessions, once no open is waiting for main, but never the shown one or a candidate's. */
  private sweep(): void {
    if (this.inflight.size > 0) return;
    const held = new Set(this.candidates.values());
    if (this.current) held.add(this.current.info.documentId);
    for (const id of Array.from(this.abandoned)) {
      this.abandoned.delete(id);
      if (!held.has(id)) void this.endSession(id);
    }
  }

  private show(info: DocumentInfo): void {
    this.openError = null;
    this.loading = null;
    const factory = (this.deps.viewers ?? VIEWERS)[info.format];
    const o: Open = { info, revision: info.revision, viewer: null, edits: 0, savedAt: null, saving: null, problem: null, told: false, unsupported: !factory };
    this.current = o;
    if (factory) {
      o.viewer = factory({ info, readOnly: !info.save.allowed, doc: this.deps.doc, changed: () => this.edited(o) });
    } else {
      const label = formatById(info.format)?.label ?? info.format;
      o.problem = { error: { code: "format-unsupported", retryable: false, message: `${info.name} là ${label}, loại tài liệu mà “Mở” chưa hiển thị được.` }, details: [], actions: [], context: "open" };
    }
    this.emit();
    o.viewer?.reveal(info.position, info.anchor);
  }

  private edited(o: Open): void {
    if (this.current !== o) return;
    o.edits++;
    this.tell(o);
    this.emit();
  }

  /** Main learns whether the page holds unsaved edits (so quitting asks only then). */
  private tell(o: Open): void {
    const dirty = this.current === o && this.dirty();
    if (dirty === o.told) return;
    o.told = dirty;
    void this.deps.request({ method: "document.dirty", documentId: o.info.documentId, dirty }).catch(() => undefined);
  }

  dismissProblem(): void {
    if (this.current) this.current.problem = null;
    this.openError = null;
    this.emit();
  }

  /** Writes the text into the file, only now (the user asked). True when it is on disk. */
  async save(overwrite = false): Promise<boolean> {
    const o = this.current;
    if (!o?.viewer) return false;
    if (o.saving) {
      await o.saving;
      if (this.current !== o || !this.dirty()) return this.current === o;
    }
    if (!o.info.save.allowed) {
      o.problem = { error: { code: "save-failed", retryable: false, message: `${o.info.name} chỉ mở để đọc: ${o.info.save.reason}` }, details: [], actions: [], context: "save" };
      this.emit();
      return false;
    }
    const text = o.viewer.text();
    if (!text.ok) {
      // AC5: nothing is written; the edits stay; the reasons are shown.
      o.problem = {
        error: { code: "unsafe-to-save", retryable: false, message: `${o.info.name} chưa được lưu: ghi lúc này sẽ làm đổi hoặc mất nội dung. File trên đĩa không bị đổi và nội dung bạn sửa vẫn còn; hãy hoàn tác thay đổi ở chỗ được nêu dưới đây.` },
        details: text.reasons,
        actions: [],
        context: "save",
      };
      this.emit();
      return false;
    }
    const at = o.edits;
    o.problem = null;
    const run = (async (): Promise<boolean> => {
      let r: DocumentSaved;
      try {
        r = await this.deps.request({ method: "document.save", documentId: o.info.documentId, revision: o.revision, text: text.text, overwrite });
      } catch (e) {
        r = { ok: false, error: { code: "save-failed", retryable: true, message: `Không lưu được ${o.info.name}: ${errorText(e)}. Nội dung bạn sửa vẫn còn: hãy thử lại.` } };
      }
      // An answer for a document that was closed or opened again meanwhile changes nothing.
      if (this.current !== o) return r.ok;
      if (r.ok) {
        o.revision = r.revision;
        o.savedAt = at;
      } else {
        const actions: Problem["actions"] = r.error.code === "changed-on-disk" ? ["reload", "overwrite"] : r.error.retryable ? ["retry"] : [];
        o.problem = { error: r.error, details: [], actions, context: "save" };
      }
      return r.ok;
    })();
    o.saving = run;
    this.emit();
    const ok = await run;
    if (o.saving === run) o.saving = null;
    this.tell(o);
    this.emit();
    return ok;
  }

  /** Replaces what is on disk now (after `changed-on-disk`), once the user says so. */
  async overwrite(): Promise<boolean> {
    const o = this.current;
    if (!o) return false;
    const yes = await this.deps.confirm({
      title: `Ghi đè ${o.info.name}?`,
      message: "File trên đĩa đã đổi sau khi bạn mở. Ghi đè sẽ thay nội dung đó bằng bản bạn đang sửa.",
      confirm: "Ghi đè",
      destructive: true,
    });
    return yes && this.current === o ? this.save(true) : false;
  }

  /** Reads the file again, dropping the edits (asked first when there are some). */
  async reload(): Promise<boolean> {
    const o = this.current;
    if (!o) return false;
    if (this.dirty()) {
      const yes = await this.deps.confirm({
        title: `Tải lại ${o.info.name} từ đĩa?`,
        message: "Những thay đổi chưa lưu sẽ bị bỏ.",
        confirm: "Bỏ thay đổi và tải lại",
        destructive: true,
      });
      if (!yes || this.current !== o) return false;
    }
    // The user agreed to drop the edits made until now, not those typed while the file is read: the answer replaces the
    // page only if nothing was edited since (`edits` counts every change, undo included).
    const at = o.edits;
    let r: DocumentOpened;
    try {
      r = await this.deps.request({ method: "document.reload", documentId: o.info.documentId });
    } catch (e) {
      r = { ok: false, error: { code: "unreadable", retryable: true, message: `Không đọc lại được ${o.info.name}: ${errorText(e)}` } };
    }
    if (this.current !== o) return false;
    if (o.edits !== at) {
      // Kept as typed, and still unsaved: the user decides again (reload once more, or save over the disk's text, which
      // the revision this page was opened at protects).
      o.problem = {
        error: { code: "reload-superseded", retryable: true, message: `${o.info.name} chưa được tải lại: bạn đã sửa thêm trong lúc đọc file. Nội dung đang sửa vẫn giữ nguyên; bấm “Tải lại từ đĩa” nếu vẫn muốn bỏ nó.` },
        details: [],
        actions: ["reload"],
        context: "reload",
      };
      this.emit();
      return false;
    }
    if (!r.ok) {
      o.problem = { error: r.error, details: [], actions: r.error.retryable ? ["reload"] : [], context: "reload" };
      this.emit();
      return false;
    }
    o.viewer?.destroy();
    this.current = null;
    if (o.told) void this.deps.request({ method: "document.dirty", documentId: o.info.documentId, dirty: false }).catch(() => undefined);
    this.show(r.document);
    return true;
  }

  /**
   * Leaves the document (closing it, another document, conversation or project, a page over it): with unsaved edits the
   * user chooses Save, Discard or Keep editing. True when it is closed; false when it stays (Keep editing, a failed save),
   * with its edits. A way out the user takes (`internal` false) also ends every open asked before it, so none shows a
   * document afterwards; `openLink` leaves the shown document from the inside, which keeps its own open going.
   */
  async leave(reason: LeaveReason = "leave", internal = false): Promise<boolean> {
    if (!internal) this.opening++;
    const o = this.current;
    if (!o) {
      if (this.loading || this.openError) {
        this.loading = null;
        this.openError = null;
        this.emit();
      }
      return true;
    }
    if (o.saving) await o.saving;
    if (this.current !== o) return true;
    if (this.dirty()) {
      const choice = await this.deps.ask({ name: o.info.name, reason });
      if (this.current !== o) return true;
      if (choice === "keep") {
        o.viewer?.focus();
        return false;
      }
      if (choice === "save" && (!(await this.save()) || this.dirty())) return false;
      if (this.current !== o) return true;
    }
    this.close(o);
    return true;
  }

  /** The document goes: its session is let go (closed in main once no open may still hold it). */
  private close(o: Open): void {
    if (this.current !== o) return;
    this.current = null;
    o.viewer?.destroy();
    this.emit();
    this.abandon(o.info.documentId);
  }

  private async endSession(documentId: string): Promise<void> {
    await this.deps.request({ method: "document.close", documentId }).catch(() => undefined);
  }

  /** Main is about to quit or close the window: the documents it names are settled, and main is answered. */
  async closeRequest(e: Extract<DesktopEvent, { type: "documentCloseRequest" }>): Promise<void> {
    const o = this.current && e.documentIds.includes(this.current.info.documentId) ? this.current : null;
    // The page holds no edits of the others (it was reloaded since they were opened): main may end them.
    const others = e.documentIds.filter((id) => id !== o?.info.documentId);
    await Promise.all(others.map((documentId) => this.deps.request({ method: "document.dirty", documentId, dirty: false }).catch(() => undefined)));
    let outcome: "settled" | "cancelled" = "settled";
    if (o) {
      if (o.saving) await o.saving;
      if (this.current === o && this.dirty()) {
        const choice = await this.deps.ask({ name: o.info.name, reason: e.reason });
        if (choice === "keep") outcome = "cancelled";
        else if (choice === "save") outcome = (await this.save()) && !this.dirty() ? "settled" : "cancelled";
        if (outcome === "cancelled") o.viewer?.focus();
      }
      if (outcome === "settled" && this.current === o) {
        // Saved or discarded: main is told before it is answered, and checks it.
        o.told = false;
        await this.deps.request({ method: "document.dirty", documentId: o.info.documentId, dirty: false }).catch(() => undefined);
      }
    }
    // Settled: the window or the app is going, so an open asked before shows nothing now (main ends its sessions).
    if (outcome === "settled") this.opening++;
    await this.deps.request({ method: "document.closeResponse", requestId: e.requestId, outcome }).catch(() => undefined);
  }

  /** Main ended a session (it settled a close request, or the project went). */
  closedByMain(documentId: string): void {
    const o = this.current;
    if (!o || o.info.documentId !== documentId) return;
    const lost = this.dirty();
    this.current = null;
    o.viewer?.destroy();
    if (lost) this.openError = { error: { code: "session-unknown", retryable: false, message: `${o.info.name} đã được đóng và không còn mở để lưu.` }, retry: null };
    this.emit();
  }
}

// ------------------------------------------------------------------ the layer
const STATUS_TEXT: Record<SaveStatus, string> = {
  clean: "",
  dirty: "Chưa lưu",
  saving: "Đang lưu…",
  saved: "Đã lưu",
  error: "Có lỗi",
  "read-only": "Chỉ đọc",
};

export interface LayerHooks {
  /** The layer is shown or gone: the chat beneath is hidden or shown again. */
  shown(visible: boolean): void;
  /** The layer went: focus goes back to what opened it, else here. */
  restoreFocus(): void;
}

/** "Mở": the document over the chat, with its name, its state, Save and Close. */
export class DocumentLayer {
  private readonly head: HTMLElement;
  private readonly name: HTMLElement;
  private readonly location: HTMLElement;
  private readonly locationText: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly saveBtn: HTMLButtonElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly banner: HTMLElement;
  private readonly notices: HTMLElement;
  private readonly body: HTMLElement;
  private shownViewer: DocumentViewer | null = null;
  private shownDoc: string | null = null;
  private wasShown = false;
  private noticeFor: string | null = null;

  constructor(private readonly root: HTMLElement, private readonly c: DocumentController, private readonly hooks: LayerHooks, private readonly doc: Document = document) {
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
      const n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      return n;
    };
    root.classList.add("doc-view");
    root.setAttribute("aria-labelledby", "doc-name");
    root.hidden = true;
    const feature = make("span", "doc-feature");
    feature.append(this.icon("go-to-file"), make("span", undefined, "Mở"));
    this.name = make("h2", "doc-name");
    this.name.id = "doc-name";
    this.name.tabIndex = -1;
    this.location = make("div", "doc-location");
    this.locationText = make("span", "doc-location-text");
    this.locationText.dir = "ltr";
    this.location.append(this.locationText);
    const titles = make("div", "doc-titles");
    titles.append(this.name, this.location);
    this.statusEl = make("span", "doc-status");
    this.statusEl.setAttribute("role", "status");
    this.statusEl.setAttribute("aria-live", "polite");
    this.saveBtn = make("button", "btn primary doc-save");
    this.saveBtn.type = "button";
    this.saveBtn.append(this.icon("save"), make("span", undefined, "Lưu"));
    this.saveBtn.setAttribute("aria-keyshortcuts", "Control+S Meta+S");
    this.saveBtn.addEventListener("click", () => void c.save());
    this.closeBtn = make("button", "icon-btn doc-close");
    this.closeBtn.type = "button";
    this.closeBtn.title = "Đóng tài liệu";
    this.closeBtn.setAttribute("aria-label", "Đóng tài liệu");
    this.closeBtn.append(this.icon("close"));
    this.closeBtn.addEventListener("click", () => void c.leave("leave"));
    this.head = make("header", "doc-head");
    this.head.append(feature, titles, this.statusEl, this.saveBtn, this.closeBtn);
    this.banner = make("div", "doc-banner");
    this.notices = make("div", "doc-notices");
    this.body = make("div", "doc-body");
    root.replaceChildren(this.head, this.banner, this.notices, this.body);
    root.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (c.canSave) void c.save();
      }
    });
    c.onChange(() => this.draw());
    this.draw();
  }

  private icon(name: string): HTMLElement {
    const s = this.doc.createElement("span");
    s.className = `codicon codicon-${name}`;
    s.setAttribute("aria-hidden", "true");
    return s;
  }

  private draw(): void {
    const c = this.c;
    const visible = c.shown;
    if (visible !== this.wasShown) {
      this.root.hidden = !visible;
      this.hooks.shown(visible);
    }
    const info = c.document;
    // The name and where the file is.
    if (info) {
      this.name.textContent = info.name;
      this.locationText.textContent = info.location;
      this.location.title = info.location;
      this.location.hidden = false;
    } else {
      this.name.textContent = c.loading ? c.loading.label : "Không mở được tài liệu";
      this.location.hidden = true;
      this.locationText.textContent = "";
    }
    const status = c.status;
    this.statusEl.textContent = info ? STATUS_TEXT[status] : "";
    this.statusEl.className = `doc-status status-${status}`;
    this.statusEl.hidden = !info || STATUS_TEXT[status] === "";
    this.saveBtn.hidden = !info || c.unsupported;
    this.saveBtn.disabled = !c.canSave;
    this.saveBtn.title = info && !info.save.allowed ? info.save.reason : "Lưu vào file (Ctrl/⌘+S)";
    const label = this.saveBtn.querySelector("span:not(.codicon)");
    if (label) label.textContent = status === "saving" ? "Đang lưu…" : "Lưu";
    this.root.setAttribute("aria-busy", String(!!c.loading || status === "saving"));
    this.drawBanner();
    this.drawNotices();
    this.drawBody();
    if (visible && !this.wasShown) this.name.focus({ preventScroll: true });
    if (!visible && this.wasShown) this.hooks.restoreFocus();
    this.wasShown = visible;
  }

  private drawBanner(): void {
    const c = this.c;
    const p: Problem | null = c.problem ?? (c.document ? null : c.openError ? { error: c.openError.error, details: [], actions: [], context: "open" } : null);
    const info = c.document;
    if (!p) {
      this.banner.hidden = true;
      this.banner.replaceChildren();
      this.banner.removeAttribute("role");
      return;
    }
    const d = this.doc;
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
      const n = d.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      return n;
    };
    const title = !info ? "Không mở được tài liệu"
      : c.unsupported ? "Không hiển thị được tài liệu này"
        : p.context === "open" ? "Không mở được tài liệu khác (tài liệu này vẫn giữ nguyên)"
          : p.error.code === "reload-superseded" ? "Chưa tải lại: bạn đã sửa thêm trong lúc đọc file"
            : p.context === "reload" ? "Không đọc lại được file"
            : p.error.code === "unsafe-to-save" ? "Chưa lưu: có phần không thể ghi an toàn"
              : p.error.code === "changed-on-disk" ? "File đã đổi trên đĩa"
                : "Không lưu được";
    const text = make("div", "doc-banner-text");
    text.append(make("strong", "doc-banner-title", title), make("p", "doc-banner-message", p.error.message));
    if (p.details.length) {
      const list = make("ul", "doc-banner-details");
      for (const line of p.details) list.append(make("li", undefined, line));
      text.append(list);
    }
    const actions = make("div", "doc-banner-actions");
    const action = (label: string, fn: () => void, primary = false) => {
      const b = make("button", `btn small${primary ? " primary" : ""}`, label);
      b.type = "button";
      b.addEventListener("click", fn);
      actions.append(b);
    };
    if (!info && c.openError?.retry) action("Thử lại", c.openError.retry, true);
    if (p.actions.includes("retry")) action("Thử lưu lại", () => void c.save(), true);
    if (p.actions.includes("reload")) action("Tải lại từ đĩa", () => void c.reload());
    if (p.actions.includes("overwrite")) action("Ghi đè", () => void c.overwrite());
    if (info) action("Ẩn", () => c.dismissProblem());
    else action("Đóng", () => void c.leave("leave"));
    const warn = p.error.code === "changed-on-disk" || p.error.code === "reload-superseded";
    this.banner.replaceChildren(this.icon(info && warn ? "warning" : "error"), text, actions);
    this.banner.className = `doc-banner ${warn ? "tone-warn" : "tone-err"}`;
    this.banner.setAttribute("role", "alert");
    this.banner.hidden = false;
  }

  private drawNotices(): void {
    const v = this.c.viewer;
    const info = this.c.document;
    const key = info ? `${info.documentId}@${info.revision}` : null;
    if (key === this.noticeFor) return;
    this.noticeFor = key;
    const list = v?.notices() ?? [];
    if (!v || !list.length) {
      this.notices.hidden = true;
      this.notices.replaceChildren();
      return;
    }
    const d = this.doc;
    const details = d.createElement("details");
    details.className = "doc-notice";
    const summary = d.createElement("summary");
    summary.append(this.icon("info"), d.createTextNode(` ${list.length} phần được giữ nguyên: hiển thị như trong file, không sửa ở đây và được lưu lại y nguyên.`));
    const ul = d.createElement("ul");
    for (const line of list) {
      const li = d.createElement("li");
      li.textContent = line;
      ul.append(li);
    }
    details.append(summary, ul);
    this.notices.replaceChildren(details);
    this.notices.setAttribute("role", "note");
    this.notices.hidden = false;
  }

  private drawBody(): void {
    const c = this.c;
    const v = c.viewer;
    const id = c.document?.documentId ?? null;
    if (v && (v !== this.shownViewer || id !== this.shownDoc)) {
      this.body.replaceChildren(v.element);
      this.shownViewer = v;
      this.shownDoc = id;
      return;
    }
    if (v) return;
    this.shownViewer = null;
    this.shownDoc = null;
    const d = this.doc;
    if (c.loading) {
      const box = d.createElement("div");
      box.className = "doc-loading";
      const spin = this.icon("loading");
      spin.classList.add("codicon-modifier-spin");
      box.append(spin, d.createTextNode(` Đang mở “${c.loading.label}”…`));
      this.body.replaceChildren(box);
    } else this.body.replaceChildren();
  }
}

/** The question asked before leaving a document with unsaved edits, by why it is left. */
export function leaveQuestion(name: string, reason: LeaveReason): { title: string; message: string } {
  const when = reason === "quit" ? "trước khi thoát AgentDuo" : reason === "window" ? "trước khi đóng cửa sổ" : "trước khi rời tài liệu";
  return {
    title: `Lưu thay đổi của ${name}?`,
    message: `${name} có thay đổi chưa lưu. Lưu chúng vào file ${when}, bỏ chúng, hoặc tiếp tục chỉnh sửa.`,
  };
}
