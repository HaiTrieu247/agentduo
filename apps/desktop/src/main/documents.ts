// "Mở": the file service of the desktop's main process (design docs/superpowers/specs/2026-11-18-desktop-open-markdown-design.md).
// It owns what the renderer must never hold: the target of every link of the chat, the real path of every opened file
// and its sessions. The renderer names a link by an id main granted and a document by an id main gave; it never sends a
// path, and nothing here reads or writes a file by a path that came from a request. There is no general file API: a
// file is opened by `open` (a link id) and written only by `save` (a document id), into the file that was opened.
// No Electron import and no shell: files are read and written through `FileOps` (node's fs), tested with real files.
import { createHash, randomBytes } from "node:crypto";
import { constants, promises as fsp } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { TimelineItem } from "@agentduo/host/viewState";
import {
  DOCUMENT_FORMATS, DocumentLinkTable, decodeUtf8Strict, documentError, documentLinkSites, encodeUtf8, formatForPath, isWritableText, linkTarget,
  type DocumentError, type DocumentFormat, type DocumentInfo, type DocumentOpened, type DocumentSaved, type LinkTarget,
} from "../shared/documents.js";
import type { DesktopEvent } from "../shared/protocol.js";

/**
 * A format's bytes ↔ text and its save rules (the "codec" of the design's section 5), keyed by `DocumentFormat.id`. The
 * service knows nothing else about a format: a new type is its entry in `DOCUMENT_FORMATS`, a codec here (or passed in)
 * and a viewer in the renderer. `decode` returns null for bytes that are not the format's text; `encode` returns null
 * for text that would not be written back as it is.
 */
export interface FormatCodec {
  readonly id: string;
  decode(bytes: Uint8Array): string | null;
  encode(text: string): Uint8Array | null;
}

/** Strict UTF-8 as stored: a BOM stays as U+FEFF and line endings are untouched (it is the text, not decoded away). */
export const utf8Codec = (id: string): FormatCodec => ({
  id,
  decode: decodeUtf8Strict,
  encode: (text) => (isWritableText(text) ? encodeUtf8(text) : null),
});

export const DEFAULT_CODECS: readonly FormatCodec[] = [utf8Codec("markdown")];

/** The file system calls the service makes, so a test can make one of them fail (the same way on every OS). */
export type FileOps = Pick<typeof fsp, "realpath" | "stat" | "lstat" | "open" | "rename" | "rm" | "access" | "chmod">;

export interface DocumentServiceOptions {
  /** Where `documentLinks` and `documentClosed` go: the renderer (a window posts them). */
  post(event: DesktopEvent): void;
  codecs?: readonly FormatCodec[];
  /** The formats that open; the default is the contract's registry. */
  formats?: readonly DocumentFormat[];
  ops?: Partial<FileOps>;
  platform?: NodeJS.Platform;
  log?(line: string): void;
}

/** What a request to open needs from the conversation: its identity and the view the page was shown by, and its workspace. */
export interface OpenRequest {
  projectId: string;
  conversationId: string;
  view: number;
  linkId: string;
  /** The conversation's own workspace folder (`ViewState.workspace`, else its project's folder); null for none. */
  workspace: string | null;
}

interface Session {
  id: string;
  format: DocumentFormat;
  /** Resolved with the native realpath at open: the only path the session ever reads or writes. */
  real: string;
  key: string;
  name: string;
  text: string;
  revision: string;
  dirty: boolean;
  save: DocumentInfo["save"];
  origin: { projectId: string; conversationId: string };
  /** Every conversation that opened it (`<project>/<conversation>`): the first one is its origin. */
  owners: Set<string>;
  /** Saves and reloads of one session run one after the other. */
  queue: Promise<unknown>;
}

/** An error the user reads, thrown inside the service and turned into a result at its edge. */
class Failure extends Error {
  constructor(readonly error: DocumentError) {
    super(error.message);
  }
}

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const code = (e: unknown): string => String((e as NodeJS.ErrnoException)?.code ?? "");
const detailOf = (e: unknown): string => ((e as Error)?.message ?? String(e)).replace(/\s+/g, " ").slice(0, 300);
const lastName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** What the system said about a file, in the contract's codes (`subject` names the file for the user). */
export function fileFailure(e: unknown, subject: string): Failure {
  switch (code(e)) {
    case "ENOENT":
    case "ENOTDIR":
      return new Failure(documentError("not-found", subject));
    case "EISDIR":
      return new Failure(documentError("not-a-file", subject));
    case "EACCES":
    case "EPERM":
      return new Failure(documentError("unreadable", subject, "permission denied"));
    default:
      return new Failure(documentError("unreadable", subject, detailOf(e)));
  }
}

/** Every byte of `bytes` at `position` on: a write may take fewer than asked, and one that takes none is a failure. */
async function writeAll(fh: { write(b: Buffer, off: number, len: number, pos: number): Promise<{ bytesWritten: number }> }, bytes: Buffer, position: number): Promise<void> {
  let done = 0;
  while (done < bytes.length) {
    const { bytesWritten } = await fh.write(bytes, done, bytes.length - done, position + done);
    if (!(bytesWritten > 0)) throw new Error("the write made no progress");
    done += bytesWritten;
  }
}

export class DocumentService {
  readonly links = new DocumentLinkTable();
  private readonly sessions = new Map<string, Session>();
  private counter = 0;
  private readonly ops: FileOps;
  private readonly formats: readonly DocumentFormat[];
  private readonly codecs: ReadonlyMap<string, FormatCodec>;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly o: DocumentServiceOptions) {
    this.ops = { ...fsp, ...o.ops } as FileOps;
    this.formats = o.formats ?? DOCUMENT_FORMATS;
    this.codecs = new Map((o.codecs ?? DEFAULT_CODECS).map((c) => [c.id, c]));
    this.platform = o.platform ?? process.platform;
  }

  // ------------------------------------------------------------------ links
  /**
   * Brings the ids of a conversation's links in line with its timeline and tells the page what changed. The links are
   * found by the contract's own functions (the chat's parser, the same numbering the renderer draws), never by a second
   * reading of the text. `fresh`: the page has just been given the whole state, so it is told every live id again.
   */
  syncLinks(projectId: string, conversationId: string, view: number, timeline: readonly TimelineItem[], fresh: boolean): void {
    const sites = documentLinkSites(timeline, this.formats);
    const { grants, revoked } = this.links.sync(`${projectId}/${conversationId}`, view, sites, fresh);
    if (!fresh && !grants.length && !revoked.length) return;
    this.o.post({ type: "documentLinks", projectId, conversationId, view, links: grants, revoked });
  }

  /** The conversation's view went (attached again): its ids are dropped; the new view's own sync grants new ones. */
  revokeConversation(projectId: string, conversationId: string): string[] {
    return this.links.revoke(`${projectId}/${conversationId}`);
  }

  /** A project's conversations are gone (restarted or forgotten): every id of them is dropped. */
  revokeProject(projectId: string): string[] {
    return this.links.revokeProject(projectId);
  }

  // ------------------------------------------------------------------ open
  async open(r: OpenRequest): Promise<DocumentOpened> {
    try {
      const href = this.links.href(`${r.projectId}/${r.conversationId}`, r.view, r.linkId);
      if (href === null) throw new Failure(documentError("link-stale", ""));
      const t = linkTarget(href, { workspace: r.workspace });
      if (!t.ok) throw new Failure(t.error);
      return await this.openTarget(t.value, href, { projectId: r.projectId, conversationId: r.conversationId });
    } catch (e) {
      return this.failed(e);
    }
  }

  private async openTarget(target: LinkTarget, href: string, origin: Session["origin"]): Promise<DocumentOpened> {
    const shown = lastName(target.path);
    const linkFormat = formatForPath(target.path, this.formats);
    if (!linkFormat) throw new Failure(documentError("format-unsupported", href));
    // The rules read the shape of the path, not the OS: a Windows path on another OS (or the reverse) is not a file here.
    if ((target.style === "windows") !== (this.platform === "win32")) throw new Failure(documentError("not-found", shown, "that path is not on this computer"));
    // The native realpath, on the path as the link wrote it: `..` is resolved by the file system, after symlinks.
    let real: string;
    try {
      real = await this.ops.realpath(target.path);
    } catch (e) {
      throw fileFailure(e, shown);
    }
    // Both names must be the same registered format: a `notes.md` that is a link to another kind of file does not open.
    const realFormat = formatForPath(real, this.formats);
    if (!realFormat || realFormat.id !== linkFormat.id) throw new Failure(documentError("format-unsupported", href));
    const codec = this.codecs.get(realFormat.id);
    if (!codec) throw new Failure(documentError("format-unsupported", href));
    const owner = `${origin.projectId}/${origin.conversationId}`;
    const key = this.keyOf(real);
    const held = this.byKey(key);
    if (held) return this.reopened(held, owner, target);
    const bytes = await this.readFile(real, realFormat.maxBytes, shown);
    const text = codec.decode(bytes);
    if (text === null) throw new Failure(documentError("not-text", shown));
    // Another click may have opened it while the file was read: one session per real file.
    const again = this.byKey(key);
    if (again) return this.reopened(again, owner, target);
    const session: Session = {
      id: `d${++this.counter}`, format: realFormat, real, key, name: shown, text, revision: digest(bytes), dirty: false,
      save: await this.saveAllowance(real), origin, owners: new Set([owner]), queue: Promise.resolve(),
    };
    this.sessions.set(session.id, session);
    return { ok: true, document: this.info(session, target), existing: false };
  }

  private async reopened(s: Session, owner: string, target: LinkTarget): Promise<DocumentOpened> {
    s.owners.add(owner);
    s.save = await this.saveAllowance(s.real);
    return { ok: true, document: this.info(s, target), existing: true };
  }

  /** Reads the session's file again (the user's choice to start from what is on disk): the revision is new. */
  reload(documentId: string): Promise<DocumentOpened> {
    return this.exclusive(documentId, async (s) => {
      const codec = this.codecs.get(s.format.id)!;
      await this.ensureSamePlace(s);
      const bytes = await this.readFile(s.real, s.format.maxBytes, s.name);
      const text = codec.decode(bytes);
      if (text === null) throw new Failure(documentError("not-text", s.name));
      s.text = text;
      s.revision = digest(bytes);
      s.save = await this.saveAllowance(s.real);
      return { ok: true as const, document: this.info(s, null), existing: true };
    });
  }

  // ------------------------------------------------------------------ save
  /**
   * Writes `text` into the file the session opened, only if its content is still `revision` (unless the user chose to
   * `overwrite`). The path is the session's own; the request never names one. Nothing is written before this is called.
   */
  save(documentId: string, revision: string, text: string, overwrite: boolean): Promise<DocumentSaved> {
    return this.exclusive(documentId, async (s) => {
      if (!s.owners.size) throw new Failure(documentError("session-unknown", "This document"));
      if (!s.save.allowed) throw new Failure(documentError("save-failed", s.name, s.save.reason));
      const codec = this.codecs.get(s.format.id)!;
      const bytes = codec.encode(text);
      if (!bytes) throw new Failure(documentError("save-failed", s.name, "the text cannot be written as it is (NUL or a broken character)"));
      if (bytes.length > s.format.maxBytes) throw new Failure(documentError("save-failed", s.name, `the text is larger than ${s.format.maxBytes} bytes`));
      // Checked now and again right before the file is replaced: what lies between (a temporary file, a flush) takes time.
      const check = (): Promise<{ mode: number; current: Buffer | null }> => this.verify(s, revision, overwrite);
      const first = await check();
      try {
        await this.write(s.real, Buffer.from(bytes), first, check);
      } catch (e) {
        if (e instanceof Failure) throw e;
        throw new Failure(documentError("save-failed", s.name, detailOf(e)));
      }
      s.text = text;
      s.revision = digest(bytes);
      return { ok: true as const, revision: s.revision };
    });
  }

  /**
   * The file is where the session opened it, still a regular file, and (unless `overwrite`) its content still is the
   * session's revision and the page's. Throws the error the user reads; returns the mode and the bytes it found.
   */
  private async verify(s: Session, revision: string, overwrite: boolean): Promise<{ mode: number; current: Buffer | null }> {
    await this.ensureSamePlace(s);
    let mode: number;
    let current: Buffer | null;
    try {
      const st = await this.ops.stat(s.real);
      if (!st.isFile()) throw new Failure(documentError("not-a-file", s.name));
      mode = st.mode;
      current = await this.readCurrent(s);
    } catch (e) {
      if (e instanceof Failure) throw e;
      throw fileFailure(e, s.name);
    }
    if (!overwrite && (revision !== s.revision || current === null || digest(current) !== s.revision)) throw new Failure(documentError("changed-on-disk", s.name));
    return { mode, current };
  }

  /** The folder allowed a temporary file: write it whole, flush it, give it the old mode, check again, then rename it over the file. */
  private async write(real: string, bytes: Buffer, found: { mode: number; current: Buffer | null }, check: () => Promise<{ current: Buffer | null }>): Promise<void> {
    const tmp = join(dirname(real), `.${basename(real)}.${randomBytes(6).toString("hex")}.agentduo-tmp`);
    let fh: Awaited<ReturnType<FileOps["open"]>>;
    try {
      fh = await this.ops.open(tmp, "wx", found.mode & 0o777);
    } catch (e) {
      // A folder that cannot be written to: the file itself is written in place (the one case with no temporary file).
      if (["EACCES", "EPERM", "EROFS"].includes(code(e))) return this.writeInPlace(real, bytes, check);
      throw e;
    }
    try {
      try {
        await writeAll(fh, bytes, 0);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await this.ops.chmod(tmp, found.mode & 0o7777).catch(() => undefined);
      // The file may have changed or gone while the temporary file was written: nothing is replaced then.
      await check();
      await this.ops.rename(tmp, real);
    } catch (e) {
      await this.ops.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  /** In place: the new bytes first (all of them), then the length, so a failure never leaves a truncated file; a half write is put back. */
  private async writeInPlace(real: string, bytes: Buffer, check: () => Promise<{ current: Buffer | null }>): Promise<void> {
    const fh = await this.ops.open(real, "r+");
    try {
      // Checked with the file open, right before the first byte goes in; what that read is what is put back on a failure.
      const { current: original } = await check();
      try {
        await writeAll(fh, bytes, 0);
        await fh.truncate(bytes.length);
        await fh.sync();
      } catch (e) {
        if (original) {
          try {
            await writeAll(fh, original, 0);
            await fh.truncate(original.length);
          } catch {
            // the original could not be put back: the error below says the save failed
          }
        }
        throw e;
      }
    } finally {
      await fh.close().catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------ the sessions' state
  /** The page's word about unsaved edits (main keeps only the flag, never the text). */
  setDirty(documentId: string, dirty: boolean): void {
    const s = this.sessions.get(documentId);
    if (s) s.dirty = dirty;
  }

  /** Ends a session (idempotent). Returns whether there was one. */
  close(documentId: string): boolean {
    return this.sessions.delete(documentId);
  }

  /** Sessions the page said hold unsaved edits (what quitting asks about). */
  dirtyIds(): string[] {
    return [...this.sessions.values()].filter((s) => s.dirty).map((s) => s.id);
  }

  isDirty(documentId: string): boolean {
    return this.sessions.get(documentId)?.dirty ?? false;
  }

  ids(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * A project's data went (it was forgotten): the sessions only its conversations opened end, and the page is told. A
   * file opened from another project's conversation stays.
   */
  closeProject(projectId: string): string[] {
    const ended: string[] = [];
    const prefix = `${projectId}/`;
    for (const s of [...this.sessions.values()]) {
      for (const owner of [...s.owners]) if (owner.startsWith(prefix)) s.owners.delete(owner);
      if (s.owners.size) continue;
      this.sessions.delete(s.id);
      ended.push(s.id);
      this.o.post({ type: "documentClosed", documentId: s.id });
    }
    return ended;
  }

  /** Every session ends (quit): nothing is posted. */
  dispose(): void {
    this.sessions.clear();
  }

  // ------------------------------------------------------------------ helpers
  private failed(e: unknown): { ok: false; error: DocumentError } {
    if (e instanceof Failure) return { ok: false, error: e.error };
    this.o.log?.(`document request failed: ${detailOf(e)}`);
    return { ok: false, error: documentError("unreadable", "the file", detailOf(e)) };
  }

  /** Runs `work` on the session after the earlier requests about it; a failure becomes a result and the session stays. */
  private exclusive<T extends object>(documentId: string, work: (s: Session) => Promise<T>): Promise<T | { ok: false; error: DocumentError }> {
    const s = this.sessions.get(documentId);
    if (!s) return Promise.resolve({ ok: false as const, error: documentError("session-unknown", "This document") });
    const run = s.queue.then(async () => {
      if (this.sessions.get(documentId) !== s) return { ok: false as const, error: documentError("session-unknown", s.name) };
      try {
        return await work(s);
      } catch (e) {
        return this.failed(e);
      }
    });
    s.queue = run.catch(() => undefined);
    return run;
  }

  private keyOf(real: string): string {
    return this.platform === "win32" ? real.toLowerCase() : real;
  }

  private byKey(key: string): Session | undefined {
    for (const s of this.sessions.values()) if (s.key === key) return s;
    return undefined;
  }

  private info(s: Session, target: LinkTarget | null): DocumentInfo {
    return {
      documentId: s.id, format: s.format.id, name: s.name, location: s.real, revision: s.revision, text: s.text,
      position: target?.position ?? null, anchor: target?.anchor ?? null, save: s.save, origin: s.origin,
    };
  }

  private async saveAllowance(real: string): Promise<DocumentInfo["save"]> {
    try {
      await this.ops.access(real, constants.W_OK);
      return { allowed: true };
    } catch {
      return { allowed: false, reason: "the file is read-only or cannot be written by this app" };
    }
  }

  /** The folders on the way to the file still lead to it, and it is still a file of its own, not a link now. */
  private async ensureSamePlace(s: Session): Promise<void> {
    let now: string;
    try {
      const link = await this.ops.lstat(s.real);
      if (link.isSymbolicLink()) throw new Failure(documentError("changed-on-disk", s.name));
      now = await this.ops.realpath(s.real);
    } catch (e) {
      if (e instanceof Failure) throw e;
      throw fileFailure(e, s.name);
    }
    if (this.keyOf(now) !== s.key) throw new Failure(documentError("changed-on-disk", s.name));
  }

  /** The file's bytes through one handle (checked a regular file there too, so a swap in between is seen), within the limit. */
  private async readFile(path: string, maxBytes: number, subject: string): Promise<Buffer> {
    let size: number;
    try {
      const st = await this.ops.stat(path);
      if (!st.isFile()) throw new Failure(documentError("not-a-file", subject));
      size = st.size;
    } catch (e) {
      throw e instanceof Failure ? e : fileFailure(e, subject);
    }
    if (size > maxBytes) throw new Failure(documentError("too-large", subject, `${size} bytes; the limit is ${maxBytes}`));
    let fh: Awaited<ReturnType<FileOps["open"]>> | null = null;
    try {
      fh = await this.ops.open(path, "r");
      if (!(await fh.stat()).isFile()) throw new Failure(documentError("not-a-file", subject));
      const bytes = await fh.readFile();
      if (bytes.length > maxBytes) throw new Failure(documentError("too-large", subject, `more than ${maxBytes} bytes`));
      return bytes;
    } catch (e) {
      throw e instanceof Failure ? e : fileFailure(e, subject);
    } finally {
      await fh?.close().catch(() => undefined);
    }
  }

  /** The content now, or null when it is over the limit (so it cannot be what was opened). */
  private async readCurrent(s: Session): Promise<Buffer | null> {
    try {
      return await this.readFile(s.real, s.format.maxBytes, s.name);
    } catch (e) {
      if (e instanceof Failure && e.error.code === "too-large") return null;
      throw e;
    }
  }
}

/** The format ids the service has a codec for among the registered formats (for a check at wiring time). */
export function missingCodecs(formats: readonly DocumentFormat[], codecs: readonly FormatCodec[]): string[] {
  return formats.filter((f) => !codecs.some((c) => c.id === f.id)).map((f) => f.id);
}
