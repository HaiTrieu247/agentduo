import { randomBytes } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ATTACHMENT_LIMITS, formatBytes, isAttachmentId, type Attachment, type ImageFormat } from "./attachment-types.js";
import { atomicWrite } from "./state.js";

export class AttachmentError extends Error {
  override name = "AttachmentError";
}

/** How much of a file is read to tell what it is (a JPEG's size can come after a long EXIF block). */
const HEAD_BYTES = 512 * 1024;
const PENDING = "pending.json";
const PARTIAL = ".partial-";

const u16be = (b: Buffer, at: number) => (at + 2 <= b.length ? b.readUInt16BE(at) : null);
const u16le = (b: Buffer, at: number) => (at + 2 <= b.length ? b.readUInt16LE(at) : null);
const u24le = (b: Buffer, at: number) => (at + 3 <= b.length ? b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) : null);
const u32be = (b: Buffer, at: number) => (at + 4 <= b.length ? b.readUInt32BE(at) : null);
const starts = (b: Buffer, bytes: number[], at = 0) => b.length >= at + bytes.length && bytes.every((x, i) => b[at + i] === x);
const ascii = (b: Buffer, text: string, at = 0) => b.length >= at + text.length && b.toString("latin1", at, at + text.length) === text;

function jpegSize(b: Buffer): { width: number; height: number } | null {
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1]!;
    if (marker === 0xff) {
      at++; // fill byte
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    const length = u16be(b, at + 2);
    if (length === null || length < 2) return null;
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC): precision, then height and width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = u16be(b, at + 5);
      const width = u16be(b, at + 7);
      return height && width ? { width, height } : null;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // the image data starts before any frame header
    at += 2 + length;
  }
  return null;
}

function webpSize(b: Buffer): { width: number; height: number } | null {
  if (ascii(b, "VP8X", 12)) {
    const w = u24le(b, 24);
    const h = u24le(b, 27);
    return w === null || h === null ? null : { width: w + 1, height: h + 1 };
  }
  if (ascii(b, "VP8L", 12)) {
    if (b[20] !== 0x2f || b.length < 25) return null;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, "VP8 ", 12)) {
    if (!starts(b, [0x9d, 0x01, 0x2a], 23)) return null;
    const w = u16le(b, 26);
    const h = u16le(b, 28);
    return w === null || h === null ? null : { width: w & 0x3fff, height: h & 0x3fff };
  }
  return null;
}

/** The format and size a raster image's header gives, or null when `head` is not one (or is cut short). */
export function imageInfo(head: Buffer): { format: ImageFormat; width: number; height: number } | null {
  let size: { width: number; height: number } | null = null;
  let format: ImageFormat | null = null;
  if (starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) && ascii(head, "IHDR", 12)) {
    format = "png";
    const width = u32be(head, 16);
    const height = u32be(head, 20);
    size = width && height ? { width, height } : null;
  } else if (ascii(head, "GIF87a") || ascii(head, "GIF89a")) {
    format = "gif";
    const width = u16le(head, 6);
    const height = u16le(head, 8);
    size = width && height ? { width, height } : null;
  } else if (starts(head, [0xff, 0xd8, 0xff])) {
    format = "jpeg";
    size = jpegSize(head);
  } else if (ascii(head, "RIFF") && ascii(head, "WEBP", 8)) {
    format = "webp";
    size = webpSize(head);
  }
  return format && size && size.width > 0 && size.height > 0 ? { format, ...size } : null;
}

const BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff", ".heic": "image/heic", ".ico": "image/x-icon",
  ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown", ".csv": "text/csv", ".tsv": "text/tab-separated-values",
  ".json": "application/json", ".jsonl": "application/jsonl", ".yaml": "application/yaml", ".yml": "application/yaml", ".toml": "application/toml",
  ".xml": "application/xml", ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".cjs": "text/javascript", ".ts": "text/x-typescript", ".tsx": "text/x-typescript", ".jsx": "text/javascript", ".py": "text/x-python",
  ".zip": "application/zip", ".gz": "application/gzip", ".tar": "application/x-tar", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword", ".xls": "application/vnd.ms-excel", ".ppt": "application/vnd.ms-powerpoint",
};

/** What a file is, by its first bytes, then by its name; text that is no known kind is text/plain. */
export function mediaTypeOf(name: string, head: Buffer): string {
  const image = imageInfo(head);
  if (image) return `image/${image.format}`;
  if (ascii(head, "%PDF-")) return "application/pdf";
  const known = BY_EXTENSION[extname(name).toLowerCase()];
  if (known) return known;
  // No NUL byte in what was read, and it decodes as UTF-8: text (a source file, a log, a config…).
  // (`stream` leaves a character cut at the end of the sample undecoded rather than invalid.)
  const sample = head.subarray(0, 8192);
  if (!sample.includes(0) && !new TextDecoder("utf-8").decode(sample, { stream: true }).includes("�")) return "text/plain";
  return "application/octet-stream";
}

/**
 * The name the copy gets: the user's name without directories, control characters or characters some systems refuse,
 * at most 120 characters (the extension kept). Unicode is left as it is (no normalization).
 */
export function safeFileName(name: string): string {
  let s = basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_").trim();
  if (!s || s === "." || s === "..") s = "file";
  if (s.length > 120) {
    const ext = extname(s).slice(0, 20);
    s = `${s.slice(0, 120 - ext.length)}${ext}`;
  }
  return s;
}

/** The name shown for a file: its own, without control characters, at most 255 characters. */
export function displayName(name: string): string {
  const s = basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (s || "file").slice(0, 255);
}

let counter = 0;

export function newAttachmentId(): string {
  return `${Date.now().toString(36)}-${(++counter).toString(36)}${randomBytes(4).toString("hex")}`;
}

/** Where an attachment's copy is: an absolute path inside the runs directory, or null when its reference leaves it. */
export function attachmentFile(runsDir: string, a: Pick<Attachment, "path">): string | null {
  if (typeof a.path !== "string" || !a.path || isAbsolute(a.path) || a.path.split(/[\\/]/).some((p) => p === ".." || p === "")) return null;
  const root = resolve(runsDir);
  const file = resolve(root, a.path);
  const rel = relative(root, file);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? file : null;
}

/** The copy of `a`, checked: it must still be a file where agentduo put it. */
export function existingAttachmentFile(runsDir: string, a: Attachment): string {
  const file = attachmentFile(runsDir, a);
  if (!file) throw new AttachmentError(`${a.name}: its reference (${a.path}) is not inside ${runsDir}`);
  try {
    if (statSync(file).isFile()) return file;
  } catch {
    // reported below
  }
  throw new AttachmentError(`${a.name} is no longer where agentduo kept it (${file}); attach it again`);
}

function readHead(file: string): Buffer {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/**
 * The copies of the files attached in one place (a conversation, or a run): `<owner>/attachments/<id>/<name>`, each
 * the bytes as they were. A conversation also lists there the files waiting to be sent (pending.json), so the next
 * time it opens it can remove those a crash left behind without touching any that were sent.
 */
export class AttachmentStore {
  readonly root: string;

  constructor(private readonly runsDir: string, ownerDir: string) {
    this.root = join(ownerDir, "attachments");
  }

  /** A copy of the regular file at `source` (a symlink to one is copied as a file), named `name` (default: its own). */
  importFile(source: string, name = basename(source)): Attachment {
    let size: number;
    try {
      const st = statSync(source);
      if (st.isDirectory()) throw new AttachmentError(`${source} is a directory: attach the files in it one by one`);
      if (!st.isFile()) throw new AttachmentError(`${source} is not a regular file`);
      size = st.size;
    } catch (e) {
      if (e instanceof AttachmentError) throw e;
      throw new AttachmentError(`cannot read ${source}: ${(e as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : (e as Error).message}`);
    }
    this.checkSize(name, size);
    return this.write(name, (tmp) => copyFileSync(source, tmp));
  }

  /** A copy of `data`, as a file named `name`. */
  importBytes(name: string, data: Buffer): Attachment {
    this.checkSize(name, data.length);
    return this.write(name, (tmp) => writeFileSync(tmp, data));
  }

  /**
   * A copy here of an attachment kept elsewhere in the runs directory (a conversation's file going with a pipeline
   * task), under the same id; one already copied is kept as it is.
   */
  adopt(a: Attachment): Attachment {
    if (!isAttachmentId(a.id)) throw new AttachmentError(`${a.name}: not an attachment of agentduo's`);
    const target = join(this.root, a.id, safeFileName(a.name));
    const ref = { ...a, path: this.ref(target) };
    if (existsSync(target) && statSync(target).size === a.size) return ref;
    const source = existingAttachmentFile(this.runsDir, a);
    mkdirSync(join(this.root, a.id), { recursive: true });
    const tmp = join(this.root, a.id, `${PARTIAL}${randomBytes(4).toString("hex")}`);
    try {
      copyFileSync(source, tmp);
      renameSync(tmp, target);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw new AttachmentError(`cannot copy ${a.name}: ${(e as Error).message}`);
    }
    return ref;
  }

  /** Removes the copy of attachment `id`. */
  remove(id: string): void {
    if (isAttachmentId(id)) rmSync(join(this.root, id), { recursive: true, force: true });
  }

  /** The ids of the files waiting to be sent, as last saved. */
  pending(): string[] {
    try {
      const ids = JSON.parse(readFileSync(join(this.root, PENDING), "utf8")) as unknown;
      return Array.isArray(ids) ? ids.filter(isAttachmentId) : [];
    } catch {
      return [];
    }
  }

  setPending(ids: string[]): void {
    if (!ids.length && !existsSync(join(this.root, PENDING))) return;
    atomicWrite(join(this.root, PENDING), `${JSON.stringify(ids)}\n`);
  }

  /**
   * What an earlier process left behind: the files it had waiting (never sent), and copies it did not finish. Files
   * that were sent stay. Returns how many it removed.
   */
  recover(): number {
    if (!existsSync(this.root)) return 0;
    let removed = 0;
    for (const id of this.pending()) {
      if (existsSync(join(this.root, id))) removed++;
      this.remove(id);
    }
    this.setPending([]);
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isAttachmentId(entry.name)) continue;
      const dir = join(this.root, entry.name);
      const files = readdirSync(dir);
      for (const f of files.filter((f) => f.startsWith(PARTIAL))) rmSync(join(dir, f), { force: true });
      if (!files.some((f) => !f.startsWith(PARTIAL))) {
        rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }

  private ref(file: string): string {
    return relative(resolve(this.runsDir), resolve(file)).split(sep).join("/");
  }

  private checkSize(name: string, size: number): void {
    if (size > ATTACHMENT_LIMITS.fileBytes) {
      throw new AttachmentError(`${displayName(name)} is ${formatBytes(size)}; a file can be at most ${formatBytes(ATTACHMENT_LIMITS.fileBytes)}`);
    }
  }

  /** Writes the copy under a temporary name, then gives it its own: a crash never leaves a half copy under a real name. */
  private write(name: string, fill: (tmp: string) => void): Attachment {
    const id = newAttachmentId();
    const dir = join(this.root, id);
    const target = join(dir, safeFileName(name));
    const tmp = join(dir, `${PARTIAL}${randomBytes(4).toString("hex")}`);
    try {
      mkdirSync(dir, { recursive: true });
      fill(tmp);
      const size = statSync(tmp).size;
      this.checkSize(name, size);
      renameSync(tmp, target);
      const head = readHead(target);
      return { id, name: displayName(name), mediaType: mediaTypeOf(name, head), size, image: imageInfo(head), path: this.ref(target) };
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      if (e instanceof AttachmentError) throw e;
      throw new AttachmentError(`cannot copy ${displayName(name)}: ${(e as Error).message}`);
    }
  }
}
