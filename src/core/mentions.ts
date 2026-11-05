// The workspace's files and folders for @ mentions: listed (as git sees them in a repository, by walking the folder
// outside one), ranked for what is typed, and the paths a message tags, for its prompt. The text side is in mention-text.ts.
import { readdirSync, statSync, type Dirent } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { isWithin } from "../paths.js";
import { Git } from "./git.js";
import { mentionedPaths, rankPaths, MENTION_LIMITS, type PathEntry } from "./mention-text.js";

export interface PathListing {
  entries: PathEntry[];
  /** There were more than `max`: the rest is left out. */
  truncated: boolean;
}

/** The most entries a listing keeps (files and folders). */
export const MAX_LISTED = 20_000;
/** Never walked into outside a repository: git's own folder and installed packages. */
const SKIPPED = new Set([".git", "node_modules"]);

const posixPath = (p: string) => (sep === "/" ? p : p.split(sep).join("/"));

/** `path` is one of `exclude` (workspace-relative, with `/`) or inside one. */
const excluded = (path: string, exclude: string[]) => exclude.some((x) => path === x || path.startsWith(`${x}/`));

/** The files git knows in `dir` (tracked and not ignored), relative to it; null outside a repository or without git. */
async function gitFiles(dir: string): Promise<string[] | null> {
  const repo = new Git(dir);
  try {
    const [all, deleted] = await Promise.all([
      repo.run(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { check: false }),
      repo.run(["ls-files", "-z", "--deleted"], { check: false }),
    ]);
    if (all.code !== 0) return null;
    const gone = new Set(deleted.code === 0 ? deleted.stdout.split("\0") : []);
    return [...new Set(all.stdout.split("\0"))].filter((p) => p && !gone.has(p));
  } catch {
    return null; // no git
  }
}

/** A repository's files and every folder they are in; folders are all kept, files up to what `max` leaves room for. */
function fromFiles(files: string[], exclude: string[], max: number): PathListing {
  const folders = new Set<string>();
  const kept: string[] = [];
  for (const file of files) {
    if (excluded(file, exclude)) continue;
    kept.push(file);
    for (let at = file.indexOf("/"); at !== -1; at = file.indexOf("/", at + 1)) folders.add(file.slice(0, at + 1));
  }
  const room = Math.max(0, max - folders.size);
  const entries: PathEntry[] = [...folders].slice(0, max).map((path) => ({ path, kind: "folder" }));
  entries.push(...kept.slice(0, room).map((path): PathEntry => ({ path, kind: "file" })));
  return { entries, truncated: folders.size > max || kept.length > room };
}

/** A folder with no repository, level by level (so the top comes first), up to `max` entries. */
function walk(dir: string, exclude: string[], max: number): PathListing {
  const entries: PathEntry[] = [];
  let queue = [""];
  while (queue.length) {
    const next: string[] = [];
    for (const rel of queue) {
      let list: Dirent[];
      try {
        list = readdirSync(rel ? resolve(dir, rel) : dir, { withFileTypes: true });
      } catch {
        continue; // unreadable: left out
      }
      list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const d of list) {
        if (SKIPPED.has(d.name)) continue;
        const path = `${rel}${d.name}`;
        if (excluded(path, exclude)) continue;
        if (entries.length >= max) return { entries, truncated: true };
        // A link is listed as what it points to, but never walked into.
        const folder = d.isDirectory() || (d.isSymbolicLink() && isFolder(resolve(dir, path)));
        entries.push(folder ? { path: `${path}/`, kind: "folder" } : { path, kind: "file" });
        if (d.isDirectory()) next.push(`${path}/`);
      }
    }
    queue = next;
  }
  return { entries, truncated: false };
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The files and folders of `workspace` a mention can name. In a repository, what git lists there (tracked, and
 * untracked unless ignored); elsewhere, the folder walked without `.git` and `node_modules`. `exclude`: workspace-
 * relative paths left out with what they hold (agentduo's runs).
 */
export async function listWorkspacePaths(workspace: string, o: { exclude?: string[]; max?: number } = {}): Promise<PathListing> {
  const exclude = (o.exclude ?? []).map((x) => posixPath(x).replace(/\/+$/, "")).filter(Boolean);
  const max = o.max ?? MAX_LISTED;
  const files = await gitFiles(workspace);
  return files ? fromFiles(files, exclude, max) : walk(workspace, exclude, max);
}

/** The folders of `dirs` inside `workspace` (not the workspace itself), relative to it with `/`: what a listing leaves out. */
export function workspaceExcludes(workspace: string, dirs: string[]): string[] {
  return dirs.flatMap((dir) => {
    const rel = posixPath(relative(resolve(workspace), resolve(dir)));
    return rel && isWithin(dir, workspace) ? [rel] : [];
  });
}

/** The workspace's paths for one chat: listed once, and again for a query once the list is older than `maxAgeMs`. */
export class WorkspacePaths {
  private cached: { at: number; listing: Promise<PathListing> } | null = null;

  constructor(readonly workspace: string, private readonly o: { exclude?: string[]; maxAgeMs?: number; max?: number; now?: () => number } = {}) {}

  list(): Promise<PathListing> {
    const now = (this.o.now ?? Date.now)();
    if (!this.cached || now - this.cached.at > (this.o.maxAgeMs ?? 10_000)) {
      this.cached = { at: now, listing: listWorkspacePaths(this.workspace, { exclude: this.o.exclude, max: this.o.max }) };
    }
    return this.cached.listing;
  }

  async find(query: string, limit = MENTION_LIMITS.results): Promise<PathEntry[]> {
    return rankPaths(query, (await this.list()).entries, limit);
  }
}

/** The most tagged paths one text lists in a prompt. */
const MAX_TAGGED = 50;
/** Punctuation that ends a sentence after a mention (`see @a.ts.`), tried without when the path is not found with it. */
const TRAILING = /[.,;:!?)\]}>'"`]+$/;

/**
 * The files and folders of `workspace` that `text` tags with @, each once, in order: only paths that exist inside it
 * (the workspace itself and anything outside it are left out).
 */
export function taggedPaths(text: string, workspace: string): PathEntry[] {
  const out = new Map<string, PathEntry>();
  for (const raw of mentionedPaths(text)) {
    for (const candidate of new Set([raw, raw.replace(TRAILING, "")])) {
      if (!candidate) continue;
      const full = resolve(workspace, candidate);
      const rel = posixPath(relative(resolve(workspace), full));
      if (!rel || !isWithin(full, workspace)) continue;
      let folder: boolean;
      try {
        folder = statSync(full).isDirectory();
      } catch {
        continue;
      }
      const entry: PathEntry = folder ? { path: `${rel}/`, kind: "folder" } : { path: rel, kind: "file" };
      out.set(entry.path, entry);
      break;
    }
    if (out.size >= MAX_TAGGED) break;
  }
  return [...out.values()];
}
