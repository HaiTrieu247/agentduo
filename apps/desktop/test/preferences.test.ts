import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PreferencesStore } from "../src/main/preferences.js";
import { DEFAULT_PREFERENCES } from "../src/shared/protocol.js";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "agentduo-desktop-prefs-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("PreferencesStore", () => {
  it("starts from the defaults and keeps what is set, atomically", () => {
    const file = join(dir, "p.json");
    const s = new PreferencesStore(file);
    expect(s.prefs).toEqual(DEFAULT_PREFERENCES);
    expect(s.prefs.autoUpdate).toBe(true);
    s.setPrefs({ theme: "light", fontSize: 15, autoUpdate: false });
    s.remember("/a");
    s.remember("/b");
    s.setConversation("/a", "20261031-120000-tab-abcd1234");
    s.setDraft("/a", "20261031-120000-tab-abcd1234", "half typed");
    s.flush();
    const again = new PreferencesStore(file);
    expect(again.prefs).toMatchObject({ theme: "light", fontSize: 15, autoUpdate: false });
    expect(again.projects.map((p) => p.path)).toEqual(["/b", "/a"]);
    expect(again.active).toBe("/b");
    expect(again.draft("/a", "20261031-120000-tab-abcd1234")).toBe("half typed");
    again.forget("/b");
    expect(again.active).toBe("/a");
  });

  it("keeps a file it cannot read aside and falls back to the defaults, and drops bad values alone", () => {
    const file = join(dir, "p.json");
    writeFileSync(file, "{not json");
    expect(new PreferencesStore(file).prefs).toEqual(DEFAULT_PREFERENCES);
    expect(readFileSync(`${file}.unreadable`, "utf8")).toBe("{not json");
    writeFileSync(file, JSON.stringify({ version: 1, prefs: { theme: "neon", fontSize: 16, autoUpdate: "sometimes" }, projects: [], active: null, drafts: {} }));
    expect(new PreferencesStore(file).prefs).toMatchObject({ theme: "system", fontSize: 16, autoUpdate: true });
    expect(existsSync(file)).toBe(true);
  });

  it("refuses a preference that is not one", () => {
    const s = new PreferencesStore(join(dir, "p.json"));
    expect(() => s.setPrefs({ sandbox: false } as never)).toThrow();
  });
});
