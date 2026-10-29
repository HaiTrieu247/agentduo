// Files the user attaches to a message: what agentduo keeps of each, and which of them reach an agent's CLI as images.
// Pure (no Node), so the terminal chat, the extension worker and the conversation tab's webview share it.
import type { Backend } from "./commands.js";

export type ImageFormat = "png" | "jpeg" | "gif" | "webp";

export interface Attachment {
  /** agentduo's id for the file; also the name of the directory its copy is in. */
  id: string;
  /** The file's name as the user had it: shown, never used as a path. */
  name: string;
  mediaType: string;
  size: number;
  /** A raster image whose header agentduo read; null for anything else, also an image it could not read. */
  image: { format: ImageFormat; width: number; height: number } | null;
  /** The copy, relative to the runs directory: "conversations/<id>/attachments/<id>/<name>", or "<run>/attachments/…". */
  path: string;
}

/** What one message may carry: files, bytes per file, bytes in all. */
export const ATTACHMENT_LIMITS = { files: 20, fileBytes: 20 * 1024 * 1024, submissionBytes: 50 * 1024 * 1024 } as const;

/**
 * Which images one agent call sends as images, rather than as a path the agent reads. Claude's limits are those of
 * the Messages API, kept whatever Claude Code does on its own (2.1.311 rescales larger images); null: no such limit.
 * Codex reads the files itself, so only the formats and the count are checked for it.
 */
export interface NativeBudget {
  formats: readonly ImageFormat[];
  maxImages: number;
  /** Base64 bytes of one image. */
  maxEncodedBytes: number | null;
  /** Pixels on either side. */
  maxSide: number | null;
  /** Base64 bytes of every image of the call. */
  maxTotalEncodedBytes: number | null;
}

const RASTER: readonly ImageFormat[] = ["png", "jpeg", "gif", "webp"];

export const NATIVE_BUDGETS: Record<Backend, NativeBudget> = {
  claude: { formats: RASTER, maxImages: 20, maxEncodedBytes: 5_000_000, maxSide: 8000, maxTotalEncodedBytes: 20_000_000 },
  codex: { formats: RASTER, maxImages: 20, maxEncodedBytes: null, maxSide: null, maxTotalEncodedBytes: null },
};

export const IMAGE_MEDIA_TYPES: Record<ImageFormat, string> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** An attachment id: agentduo's own, safe as a directory name. */
export const isAttachmentId = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(v);

/** Bytes of `bytes` once base64-encoded. */
export const base64Size = (bytes: number): number => 4 * Math.ceil(bytes / 3);

/** "512 B", "12 KB", "1.2 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  const mb = n / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** What the file is, in a few words: "PNG 1280×720, 245 KB", "application/pdf, 1.2 MB". */
export function attachmentDetail(a: Pick<Attachment, "mediaType" | "size" | "image">): string {
  const kind = a.image ? `${a.image.format.toUpperCase()} ${a.image.width}×${a.image.height}` : a.mediaType;
  return `${kind}, ${formatBytes(a.size)}`;
}

/** "a.png (PNG 64×64, 178 B) · notes.md (text/markdown, 2 KB)". */
export const attachmentsText = (list: Attachment[]): string => list.map((a) => `${a.name} (${attachmentDetail(a)})`).join(" · ");

/**
 * The attachments one call to `backend` sends as images, in the order they were attached, within its budget; the
 * other images go as paths only, each with the reason. Files that are not images are neither.
 */
export function selectNative(backend: Backend, list: Attachment[]): { native: Attachment[]; fallback: Array<{ attachment: Attachment; reason: string }> } {
  const budget = NATIVE_BUDGETS[backend];
  const native: Attachment[] = [];
  const fallback: Array<{ attachment: Attachment; reason: string }> = [];
  let total = 0;
  for (const a of list) {
    if (!a.mediaType.startsWith("image/")) continue;
    const reason = ((): string | null => {
      const image = a.image;
      if (!image) return a.mediaType === "image/svg+xml" ? "it is not a raster image" : "agentduo could not read its format and size";
      if (!budget.formats.includes(image.format)) return `the CLI takes no ${image.format.toUpperCase()} images`;
      if (budget.maxSide && (image.width > budget.maxSide || image.height > budget.maxSide)) return `it is larger than ${budget.maxSide} pixels on a side`;
      const encoded = base64Size(a.size);
      if (budget.maxEncodedBytes && encoded > budget.maxEncodedBytes) return `it is over ${formatBytes(budget.maxEncodedBytes)} once encoded`;
      if (native.length >= budget.maxImages) return `a call takes at most ${budget.maxImages} images`;
      if (budget.maxTotalEncodedBytes && total + encoded > budget.maxTotalEncodedBytes) return `the images of a call take at most ${formatBytes(budget.maxTotalEncodedBytes)} once encoded`;
      total += encoded;
      return null;
    })();
    if (reason) fallback.push({ attachment: a, reason });
    else native.push(a);
  }
  return { native, fallback };
}
