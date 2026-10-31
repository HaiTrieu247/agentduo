// The desktop's own state in userData: its preferences, the projects it knows (most recent first), the conversation
// each was on, and half-typed drafts. Written atomically; a file that cannot be read gives the defaults (and is kept
// aside, never overwritten silently). No Electron import, so it is tested as is.
import { existsSync, readFileSync, renameSync } from "node:fs";
import { atomicWrite } from "../../../../src/core/state.js";
import { DEFAULT_PREFERENCES, parsePreferences, type Preferences } from "../shared/protocol.js";

export interface KnownProject {
  path: string;
  /** The conversation its view was on last. */
  conversation: string | null;
  openedAt: string;
}

interface Stored {
  version: 1;
  prefs: Preferences;
  projects: KnownProject[];
  /** The project shown last, by path. */
  active: string | null;
  /** Last conversation outside a project. */
  conversation: string | null;
  /** Drafts by "<project path>\n<conversation>", kept small. */
  drafts: Record<string, string>;
}

const MAX_PROJECTS = 30;
const MAX_DRAFTS = 100;

function fresh(): Stored {
  return { version: 1, prefs: { ...DEFAULT_PREFERENCES }, projects: [], active: null, conversation: null, drafts: {} };
}

/** Whatever a stored file holds, as far as it is valid: a bad preference falls back to its default, alone. */
function sanitize(raw: unknown): Stored {
  const out = fresh();
  if (typeof raw !== "object" || raw === null) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.prefs === "object" && r.prefs !== null) {
    for (const [key, value] of Object.entries(r.prefs)) {
      try {
        Object.assign(out.prefs, parsePreferences({ [key]: value }));
      } catch {
        // one bad value: its default stays
      }
    }
  }
  if (Array.isArray(r.projects)) {
    for (const p of r.projects) {
      if (typeof p?.path !== "string" || !p.path || out.projects.some((x) => x.path === p.path)) continue;
      out.projects.push({ path: p.path, conversation: typeof p.conversation === "string" ? p.conversation : null, openedAt: typeof p.openedAt === "string" ? p.openedAt : new Date(0).toISOString() });
    }
    out.projects = out.projects.slice(0, MAX_PROJECTS);
  }
  if (typeof r.conversation === "string") out.conversation = r.conversation;
  if (typeof r.active === "string" && out.projects.some((p) => p.path === r.active)) out.active = r.active;
  if (typeof r.drafts === "object" && r.drafts !== null) {
    for (const [k, v] of Object.entries(r.drafts).slice(-MAX_DRAFTS)) if (typeof v === "string" && v) out.drafts[k] = v;
  }
  return out;
}

export class PreferencesStore {
  private state: Stored;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {
    this.state = fresh();
    if (!existsSync(file)) return;
    try {
      this.state = sanitize(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      // Not JSON (a crash mid-write cannot cause it: writes are atomic): kept aside for the user, defaults meanwhile.
      try {
        renameSync(file, `${file}.unreadable`);
      } catch {
        // read-only: the defaults still apply
      }
    }
  }

  get prefs(): Preferences {
    return { ...this.state.prefs };
  }

  get projects(): KnownProject[] {
    return this.state.projects.map((p) => ({ ...p }));
  }

  get active(): string | null {
    return this.state.active;
  }

  get conversation(): string | null {
    return this.state.conversation;
  }

  setGeneralConversation(conversation: string | null): void {
    this.state.conversation = conversation;
    this.save();
  }

  setPrefs(patch: Partial<Preferences>): Preferences {
    this.state.prefs = { ...this.state.prefs, ...parsePreferences(patch) };
    this.save();
    return this.prefs;
  }

  /** A project opened: it goes first in the list, and becomes the active one. */
  remember(path: string): void {
    const known = this.state.projects.find((p) => p.path === path);
    this.state.projects = [{ path, conversation: known?.conversation ?? null, openedAt: new Date().toISOString() }, ...this.state.projects.filter((p) => p.path !== path)].slice(0, MAX_PROJECTS);
    this.state.active = path;
    this.save();
  }

  forget(path: string): void {
    this.state.projects = this.state.projects.filter((p) => p.path !== path);
    if (this.state.active === path) this.state.active = this.state.projects[0]?.path ?? null;
    for (const key of Object.keys(this.state.drafts)) if (key.startsWith(`${path}\n`)) delete this.state.drafts[key];
    this.save();
  }

  setActive(path: string | null): void {
    if (path !== null && !this.state.projects.some((p) => p.path === path)) return;
    this.state.active = path;
    this.save();
  }

  setConversation(path: string, conversation: string | null): void {
    const p = this.state.projects.find((x) => x.path === path);
    if (!p || p.conversation === conversation) return;
    p.conversation = conversation;
    this.save();
  }

  draft(path: string, conversation: string): string {
    return this.state.drafts[`${path}\n${conversation}`] ?? "";
  }

  setDraft(path: string, conversation: string, text: string): void {
    const key = `${path}\n${conversation}`;
    if ((this.state.drafts[key] ?? "") === text) return;
    delete this.state.drafts[key];
    if (text) this.state.drafts[key] = text;
    const keys = Object.keys(this.state.drafts);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_DRAFTS))) delete this.state.drafts[k];
    // Typing changes a draft at every key: it is written a moment after the typing stops (and at quit).
    this.timer ??= setTimeout(() => this.save(), 600);
  }

  /** Writes what waits to be written (the drafts), as the app quits. */
  flush(): void {
    if (this.timer) this.save();
  }

  private save(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    atomicWrite(this.file, `${JSON.stringify(this.state, null, 2)}\n`);
  }
}
