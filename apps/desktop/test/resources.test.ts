import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appFile, insideRoot, ResourceTokens } from "../src/main/resources.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentduo-desktop-res-"));
  mkdirSync(join(dir, "renderer"));
  writeFileSync(join(dir, "renderer", "index.html"), "<html></html>");
  writeFileSync(join(dir, "renderer", "main.js"), "1");
  writeFileSync(join(dir, "secret.txt"), "secret");
  mkdirSync(join(dir, "att"));
  writeFileSync(join(dir, "att", "a.png"), PNG);
  writeFileSync(join(dir, "att", "fake.png"), "<svg onload=alert(1)>");
  writeFileSync(join(dir, "outside.png"), PNG);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("appFile", () => {
  it("serves flat renderer files and nothing else", () => {
    expect(appFile(join(dir, "renderer"), "/")?.type).toMatch(/text\/html/);
    expect(appFile(join(dir, "renderer"), "/main.js")?.type).toMatch(/javascript/);
    for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/sub/x.js", "/.hidden.js", "/main.exe", "/%E0%A4%A"]) expect(appFile(join(dir, "renderer"), p), p).toBeNull();
  });

  it("refuses a renderer file that is a symlink out of the directory", () => {
    symlinkSync(join(dir, "secret.txt"), join(dir, "renderer", "leak.txt"));
    expect(appFile(join(dir, "renderer"), "/leak.txt")).toBeNull();
  });
});

describe("ResourceTokens", () => {
  it("grants raster images inside the root only, and checks again on load", () => {
    const tokens = new ResourceTokens();
    const url = tokens.grant({ owner: "p/c", view: 1, root: join(dir, "att"), file: join(dir, "att", "a.png") });
    expect(url).toMatch(/^agentduo:\/\/resource\/[a-f0-9]{32}$/);
    const token = url!.split("/").pop()!;
    expect(tokens.resolve(token)?.type).toBe("image/png");
    expect(tokens.grant({ owner: "p/c", view: 1, root: join(dir, "att"), file: join(dir, "att", "fake.png") })).toBeNull();
    expect(tokens.grant({ owner: "p/c", view: 1, root: join(dir, "att"), file: join(dir, "outside.png") })).toBeNull();
    expect(tokens.grant({ owner: "p/c", view: 1, root: join(dir, "att"), file: join(dir, "att", "..", "outside.png") })).toBeNull();
    // Replaced by a symlink out of the root after it was granted: refused when loaded.
    rmSync(join(dir, "att", "a.png"));
    symlinkSync(join(dir, "outside.png"), join(dir, "att", "a.png"));
    expect(tokens.resolve(token)).toBeNull();
    expect(tokens.resolve("../../etc/passwd")).toBeNull();
  });

  it("drops a view's tokens, and a project's", () => {
    const tokens = new ResourceTokens();
    const a = tokens.grant({ owner: "p1/c", view: 1, root: join(dir, "att"), file: join(dir, "att", "a.png") })!.split("/").pop()!;
    const b = tokens.grant({ owner: "p1/c", view: 2, root: join(dir, "att"), file: join(dir, "att", "a.png") })!.split("/").pop()!;
    const c = tokens.grant({ owner: "p2/c", view: 3, root: join(dir, "att"), file: join(dir, "att", "a.png") })!.split("/").pop()!;
    tokens.revoke("p1/c", 1);
    expect(tokens.resolve(a)).toBeNull();
    expect(tokens.resolve(b)).not.toBeNull();
    tokens.revokeProject("p1");
    expect(tokens.resolve(b)).toBeNull();
    expect(tokens.resolve(c)).not.toBeNull();
  });

  it("insideRoot resolves symlinks before it compares", () => {
    symlinkSync(join(dir, "outside.png"), join(dir, "att", "link.png"));
    expect(insideRoot(join(dir, "att"), join(dir, "att", "link.png"))).toBeNull();
  });
});
