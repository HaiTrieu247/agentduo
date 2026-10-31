// Small HTML helpers shared by the layout, the content helpers and the search index.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text as HTML text or an attribute value. */
export const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

/** The text of an HTML fragment: tags dropped, entities decoded, whitespace collapsed. */
export function textOf(html) {
  return String(html)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|li|h[1-6]|pre|tr|td|th|dt|dd|div|figcaption|caption)>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, name) => {
      if (name[0] === "#") return String.fromCodePoint(name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10));
      return ENTITIES[name] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** A section or heading id: lowercase ASCII words joined by hyphens. */
export const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function assertId(id, where) {
  if (!ID_PATTERN.test(id)) throw new Error(`${where}: '${id}' is not a valid id (lowercase letters, digits and hyphens)`);
  return id;
}

/** Every id="…" in an HTML fragment, in order. */
export function idsIn(html) {
  return [...String(html).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
}

/** "120090681" → "115 MB" (binary megabytes, as most download pages and file managers show them). */
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
