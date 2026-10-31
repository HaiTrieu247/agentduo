// What the renderer may load: the app's own files (agentduo://app/<name>, a fixed list of names in one directory), and
// previews of attached images by token (agentduo://resource/<token>). A token names one file main checked: inside
// its conversation's attachment directory (after symlinks are resolved), a regular file, a raster image by its bytes.
// Tokens belong to a conversation's view and are dropped with it. No Electron import, so it is tested as is.
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative } from "node:path";

/** The page's policy: our own scripts, styles and font; images from our resources; nothing remote, no frames. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' agentduo://resource data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml",
};

/** A file of the app's renderer directory by its URL path; null for anything else (a subdirectory, `..`, a dotfile). */
export function appFile(dir: string, urlPath: string): { file: string; type: string } | null {
  let name: string;
  try {
    name = decodeURIComponent(urlPath.replace(/^\//, "")) || "index.html";
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..")) return null;
  const type = TYPES[extname(name).toLowerCase()];
  if (!type) return null;
  const file = join(dir, name);
  try {
    if (!statSync(file).isFile()) return null;
    const real = realpathSync(file);
    const rel = relative(realpathSync(dir), real);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    return { file: real, type };
  } catch {
    return null;
  }
}

const RASTER: Array<[string, (b: Buffer) => boolean]> = [
  ["image/png", (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/gif", (b) => b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a"],
  ["image/webp", (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
];

/** The raster type the file's first bytes say (never its name: an SVG or HTML named .png is not an image here). */
export function rasterType(file: string): string | null {
  const head = Buffer.alloc(16);
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const n = readSync(fd, head, 0, 16, 0);
    return RASTER.find(([, is]) => is(head.subarray(0, n)))?.[0] ?? null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** `file` resolved, inside `root` resolved, and a regular file: what a symlink points to counts, not its name. */
export function insideRoot(root: string, file: string): string | null {
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(file);
    const rel = relative(realRoot, real);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

interface Grant {
  owner: string;
  view: number;
  root: string;
  file: string;
}

const MAX_TOKENS = 2000;

/** The previews the renderer was given, by token; each is checked again when it is loaded. */
export class ResourceTokens {
  private readonly grants = new Map<string, Grant>();

  /** A token URL for `file`, the attachment of `owner` ("<project>/<conversation>") shown by view `view`; null if it is not one. */
  grant(o: Grant): string | null {
    if (!insideRoot(o.root, o.file) || !rasterType(o.file)) return null;
    for (const [token, g] of this.grants) if (g.owner === o.owner && g.view === o.view && g.file === o.file) return `agentduo://resource/${token}`;
    const token = randomBytes(16).toString("hex");
    this.grants.set(token, { ...o });
    while (this.grants.size > MAX_TOKENS) this.grants.delete(this.grants.keys().next().value!);
    return `agentduo://resource/${token}`;
  }

  /** The file a token names, checked now (it may have been replaced by a symlink since); null otherwise. */
  resolve(token: string): { file: string; type: string } | null {
    if (!/^[a-f0-9]{32}$/.test(token)) return null;
    const g = this.grants.get(token);
    if (!g) return null;
    const file = insideRoot(g.root, g.file);
    const type = file ? rasterType(file) : null;
    return file && type ? { file, type } : null;
  }

  /** A conversation's view went (it was closed, its project restarted): its tokens go too; all of them without `view`. */
  revoke(owner: string, view?: number): void {
    for (const [token, g] of this.grants) if (g.owner === owner && (view === undefined || g.view === view)) this.grants.delete(token);
  }

  /** Every token of a project (`<project>/` owners). */
  revokeProject(projectId: string): void {
    for (const [token, g] of this.grants) if (g.owner.startsWith(`${projectId}/`)) this.grants.delete(token);
  }

  get size(): number {
    return this.grants.size;
  }
}
