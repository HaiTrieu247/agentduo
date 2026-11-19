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
  /** The file system identity (device and inode) of the file as read through the handle at open, reload or the last save. */
  identity: string;
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
/** A file's identity on its device, from a stat (bigint stats keep every digit of an inode). */
const identityOf = (st: { dev: number | bigint; ino: number | bigint }): string => `${st.dev}:${st.ino}`;
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

/** The whole content of an open handle from its start, or null when it is longer than `max` bytes. */
async function readHandle(fh: { read(b: Buffer, off: number, len: number, pos: number): Promise<{ bytesRead: number }> }, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const buf = Buffer.alloc(Math.min(65536, max + 1 - total));
    const { bytesRead } = await fh.read(buf, 0, buf.length, total);
    if (bytesRead === 0) return Buffer.concat(chunks);
    chunks.push(buf.subarray(0, bytesRead));
    total += bytesRead;
    if (total > max) return null;
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
    const { bytes, identity } = await this.readFile(real, realFormat.maxBytes, shown);
    const text = codec.decode(bytes);
    if (text === null) throw new Failure(documentError("not-text", shown));
    const save = await this.saveAllowance(real);
    // Another click may have opened it while the file was read: one session per real file. Nothing is awaited between
    // this check and the registration, so two opens that overlap end with one session (the later one is `existing`).
    const again = this.byKey(key);
    if (again) return this.reopened(again, owner, target);
    const session: Session = {
      id: `d${++this.counter}`, format: realFormat, real, key, name: shown, text, revision: digest(bytes), identity, dirty: false,
      save, origin, owners: new Set([owner]), queue: Promise.resolve(),
    };
    this.sessions.set(session.id, session);
    return { ok: true, document: this.info(session, target), existing: false };
  }

  private async reopened(s: Session, owner: string, target: LinkTarget): Promise<DocumentOpened> {
    const save = await this.saveAllowance(s.real);
    // The session may have ended while its allowance was read: it is not given to a new owner then.
    if (this.sessions.get(s.id) !== s) throw new Failure(documentError("session-unknown", s.name));
    s.owners.add(owner);
    s.save = save;
    return { ok: true, document: this.info(s, target), existing: true };
  }

  /** Reads the session's file again (the user's choice to start from what is on disk): the revision is new. */
  reload(documentId: string): Promise<DocumentOpened> {
    return this.exclusive(documentId, async (s) => {
      const codec = this.codecs.get(s.format.id)!;
      await this.ensureSamePlace(s);
      const { bytes, identity } = await this.readFile(s.real, s.format.maxBytes, s.name);
      const text = codec.decode(bytes);
      if (text === null) throw new Failure(documentError("not-text", s.name));
      s.text = text;
      s.revision = digest(bytes);
      // The user chose to start from what is on disk now, so the file read through this handle is the one that counts.
      s.identity = identity;
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
      const check = (): Promise<{ mode: number }> => this.verify(s, revision, overwrite);
      const first = await check();
      let identity: string;
      try {
        identity = await this.write(s, Buffer.from(bytes), first, check, revision, overwrite);
      } catch (e) {
        if (e instanceof Failure) throw e;
        throw new Failure(documentError("save-failed", s.name, detailOf(e)));
      }
      s.text = text;
      s.revision = digest(bytes);
      s.identity = identity;
      return { ok: true as const, revision: s.revision };
    });
  }

  /**
   * The file is where the session opened it, still a regular file, the very file the session read (the identity of the
   * handle it is read through, so a replacement with the same bytes is another file), and (unless `overwrite`) its content
   * still is the session's revision and the page's. Throws the error the user reads; returns the mode it found.
   */
  private async verify(s: Session, revision: string, overwrite: boolean): Promise<{ mode: number }> {
    await this.ensureSamePlace(s);
    let mode: number;
    let current: { bytes: Buffer | null; identity: string };
    try {
      const st = await this.ops.stat(s.real);
      if (!st.isFile()) throw new Failure(documentError("not-a-file", s.name));
      mode = st.mode;
      current = await this.readCurrent(s);
    } catch (e) {
      if (e instanceof Failure) throw e;
      throw fileFailure(e, s.name);
    }
    if (current.identity !== s.identity) throw new Failure(documentError("changed-on-disk", s.name));
    if (!overwrite && (revision !== s.revision || current.bytes === null || digest(current.bytes) !== s.revision)) throw new Failure(documentError("changed-on-disk", s.name));
    return { mode };
  }

  /**
   * The folder allowed a temporary file: write it whole, flush it, give it the old mode, check again, then rename it over
   * the file. Returns the identity of the file now at the session's path: the one of the handle that wrote the temporary
   * file, confirmed by a read of the path after the rename (a different file there is a conflict, not a new identity), or
   * the handle written in place.
   */
  private async write(s: Session, bytes: Buffer, found: { mode: number }, check: () => Promise<unknown>, revision: string, overwrite: boolean): Promise<string> {
    const real = s.real;
    const tmp = join(dirname(real), `.${basename(real)}.${randomBytes(6).toString("hex")}.agentduo-tmp`);
    let fh: Awaited<ReturnType<FileOps["open"]>>;
    try {
      fh = await this.ops.open(tmp, "wx", found.mode & 0o777);
    } catch (e) {
      // A folder that cannot be written to: the file itself is written in place (the one case with no temporary file).
      if (["EACCES", "EPERM", "EROFS"].includes(code(e))) return this.writeInPlace(s, bytes, revision, overwrite);
      throw e;
    }
    let written: string;
    try {
      try {
        await writeAll(fh, bytes, 0);
        await fh.sync();
        // The identity of the file that is about to take the path: the handle that wrote it, not whatever lies there later.
        written = identityOf(await fh.stat({ bigint: true }));
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
    // What now lies at the path is read back through its own handle: it must be the very file that was written (the
    // identity of the temporary file's handle) and hold what was written. Another process may have replaced it in the
    // moment after the rename; the session then keeps its old identity, so no later save goes into that file.
    let now: { bytes: Buffer; identity: string };
    try {
      now = await this.readFile(real, s.format.maxBytes, s.name);
    } catch (e) {
      throw new Failure(documentError("save-failed", s.name, `the file was written, but could not be checked afterwards (${e instanceof Failure ? e.error.message : detailOf(e)})`));
    }
    if (now.identity !== written) throw new Failure(documentError("changed-on-disk", s.name));
    if (!now.bytes.equals(bytes)) throw new Failure(documentError("save-failed", s.name, "the file was changed by another program just after it was saved; reload it to see what is on disk"));
    return now.identity;
  }

  /**
   * In place: the new bytes first (all of them), then the length, so a failure never leaves a truncated file; a half
   * write is put back. What is checked is the handle that will be written: it is a regular file, it is the file now at
   * the session's path and the one the session read (same device and inode), and its own content (read through it) is
   * the revision, unless `overwrite`. The whole content it had is read first, because it is what puts the file back if
   * the write fails: a file too long to be held is refused before the first byte is written, `overwrite` or not.
   */
  private async writeInPlace(s: Session, bytes: Buffer, revision: string, overwrite: boolean): Promise<string> {
    const fh = await this.ops.open(s.real, "r+");
    try {
      let original: Buffer | null;
      let own: string;
      try {
        const st = await fh.stat({ bigint: true });
        if (!st.isFile()) throw new Failure(documentError("not-a-file", s.name));
        own = identityOf(st);
        await this.ensureSamePlace(s);
        const there = await this.ops.stat(s.real, { bigint: true });
        if (!there.isFile() || identityOf(there) !== own || own !== s.identity) throw new Failure(documentError("changed-on-disk", s.name));
        original = await readHandle(fh, s.format.maxBytes);
      } catch (e) {
        if (e instanceof Failure) throw e;
        throw fileFailure(e, s.name);
      }
      if (original === null) {
        throw new Failure(overwrite
          ? documentError("save-failed", s.name, `the file on disk is longer than ${s.format.maxBytes} bytes, so it could not be put back if the write failed; nothing was written`)
          : documentError("changed-on-disk", s.name));
      }
      if (!overwrite && (revision !== s.revision || digest(original) !== s.revision)) throw new Failure(documentError("changed-on-disk", s.name));
      try {
        await writeAll(fh, bytes, 0);
        await fh.truncate(bytes.length);
        await fh.sync();
      } catch (e) {
        try {
          await writeAll(fh, original, 0);
          await fh.truncate(original.length);
        } catch {
          // the original could not be put back: the error below says the save failed
        }
        throw e;
      }
      return own;
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
  private async readFile(path: string, maxBytes: number, subject: string): Promise<{ bytes: Buffer; identity: string }> {
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
      const own = await fh.stat({ bigint: true });
      if (!own.isFile()) throw new Failure(documentError("not-a-file", subject));
      const bytes = await fh.readFile();
      if (bytes.length > maxBytes) throw new Failure(documentError("too-large", subject, `more than ${maxBytes} bytes`));
      return { bytes, identity: identityOf(own) };
    } catch (e) {
      throw e instanceof Failure ? e : fileFailure(e, subject);
    } finally {
      await fh?.close().catch(() => undefined);
    }
  }

  /** The content now and the identity of the file it was read from; null bytes when it is over the limit (so it cannot be what was opened). */
  private async readCurrent(s: Session): Promise<{ bytes: Buffer | null; identity: string }> {
    try {
      return await this.readFile(s.real, s.format.maxBytes, s.name);
    } catch (e) {
      if (e instanceof Failure && e.error.code === "too-large") return { bytes: null, identity: await this.identityNow(s) };
      throw e;
    }
  }

  /** The identity of the file at the session's path, through a handle (for a file too long to be read). */
  private async identityNow(s: Session): Promise<string> {
    let fh: Awaited<ReturnType<FileOps["open"]>> | null = null;
    try {
      fh = await this.ops.open(s.real, "r");
      const own = await fh.stat({ bigint: true });
      if (!own.isFile()) throw new Failure(documentError("not-a-file", s.name));
      return identityOf(own);
    } catch (e) {
      throw e instanceof Failure ? e : fileFailure(e, s.name);
    } finally {
      await fh?.close().catch(() => undefined);
    }
  }
}

/** The format ids the service has a codec for among the registered formats (for a check at wiring time). */
export function missingCodecs(formats: readonly DocumentFormat[], codecs: readonly FormatCodec[]): string[] {
  return formats.filter((f) => !codecs.some((c) => c.id === f.id)).map((f) => f.id);
}
