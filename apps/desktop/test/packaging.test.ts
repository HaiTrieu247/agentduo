// The package's shape, as electron-builder reads it: only the build output goes in, the runtime goes outside the
// ASAR archive, the targets of each OS, the fuse profiles; and the desktop stays a private package next to agentduo.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
// @ts-expect-error a plain ES module script, without types
import { fuseConfig, fuseProfile } from "../scripts/fuses.mjs";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const root = join(desktop, "..", "..");
const json = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
const builder = parse(readFileSync(join(desktop, "electron-builder.yml"), "utf8")) as Record<string, any>;

const targets = (platform: Record<string, any>) => Object.fromEntries((platform.target as Array<{ target: string; arch: string[] }>).map((t) => [t.target, t.arch]));

describe("electron-builder.yml", () => {
  it("packages the build output only", () => {
    const files = builder.files as string[];
    expect(files).toEqual(expect.arrayContaining(["package.json", "dist/main/**", "dist/preload/**", "dist/renderer/**"]));
    expect(files.some((f) => /node_modules|src\//.test(f) && !f.startsWith("!"))).toBe(false);
    expect(builder.asar).toBe(true);
  });

  it("puts the engine's runtime outside the ASAR archive", () => {
    expect(builder.extraResources).toEqual(expect.arrayContaining([{ from: "dist/runtime", to: "runtime" }]));
    expect(builder.afterPack).toBe("./scripts/fuses.mjs");
  });

  it("builds dmg and zip for both Mac architectures, ad-hoc signed by default", () => {
    expect(targets(builder.mac)).toEqual({ dmg: ["arm64", "x64"], zip: ["arm64", "x64"] });
    expect(builder.mac.identity).toBe("-");
    expect(builder.mac.hardenedRuntime).toBe(true);
    expect(builder.mac.notarize).toBe(false);
    expect(readFileSync(join(desktop, builder.mac.entitlements), "utf8")).toContain("com.apple.security.cs.disable-library-validation");
  });

  it("builds an NSIS installer for Windows x64", () => {
    expect(targets(builder.win)).toEqual({ nsis: ["x64"] });
  });

  it("builds an AppImage and a deb for Linux x64, the deb with its AppArmor profile", () => {
    expect(targets(builder.linux)).toEqual({ AppImage: ["x64"], deb: ["x64"] });
    const profile = readFileSync(join(desktop, builder.deb.appArmorProfile), "utf8");
    expect(profile).toContain("userns,");
    expect(profile).toContain("/opt/AgentDuo/agentduo");
  });

  it("makes every platform's icon from one 1024 px PNG, rendered from its SVG", () => {
    expect(builder.icon).toBe("resources/icon.png");
    const png = readFileSync(join(desktop, builder.icon));
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1024, 1024]);
    expect(readFileSync(join(desktop, "resources", "icon.svg"), "utf8")).toContain('viewBox="0 0 1024 1024"');
  });

  it("points installed apps at this repository's GitHub Releases, and never uploads by itself", () => {
    expect(builder.publish).toEqual({ provider: "github", owner: "HaiTrieu247", repo: "agentduo" });
    // Update feeds come from the zip (macOS), the NSIS installer and the AppImage/deb; a dmg is for a first install.
    expect(builder.dmg.writeUpdateInfo).toBe(false);
    expect(readFileSync(join(desktop, "scripts", "package.mjs"), "utf8")).toContain('"--publish", "never"');
  });

  it("never turns Chromium's sandbox off for the app", () => {
    expect(JSON.stringify(builder)).not.toContain("no-sandbox");
  });
});

describe("fuses", () => {
  // FuseV1Options: 0 RunAsNode, 1 cookie encryption, 2 NODE_OPTIONS, 3 CLI inspector, 4 ASAR integrity, 5 only ASAR.
  it("keeps RunAsNode on and NODE_OPTIONS and the inspector off in a release", () => {
    const c = fuseConfig("release");
    expect([c[0], c[1], c[2], c[3], c[5]]).toEqual([true, true, false, false, true]);
  });

  it("turns the inspector on only in the test profile", () => {
    const c = fuseConfig("test");
    expect([c[0], c[2], c[3]]).toEqual([true, false, true]);
    expect(fuseProfile({})).toBe("release");
    expect(fuseProfile({ AGENTDUO_FUSES: "test" })).toBe("test");
  });
});

describe("the desktop package", () => {
  const pkg = json(join(desktop, "package.json"));
  const rootPkg = json(join(root, "package.json"));

  it("has agentduo's version, also in its lockfile", () => {
    expect(pkg.version).toBe(rootPkg.version);
    const lock = json(join(desktop, "package-lock.json"));
    expect(lock.version).toBe(rootPkg.version);
    expect(lock.packages[""].version).toBe(rootPkg.version);
  });

  it("is private, with no runtime dependencies, and the build tools it was allowed (electron-updater is bundled into main)", () => {
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies).toBeUndefined();
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(["@electron/fuses", "electron", "electron-builder", "electron-updater", "playwright"]);
  });

  it("leaves agentduo's five runtime dependencies as they are", () => {
    expect(Object.keys(rootPkg.dependencies).sort()).toEqual(["ajv", "commander", "ink", "react", "yaml"]);
    expect(rootPkg.files).not.toContain("apps");
  });
});

describe("the release workflow", () => {
  const wf = parse(readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8")) as Record<string, any>;

  it("runs on a v* tag, packages each OS into a draft, and publishes it only after every OS uploaded its feed", () => {
    expect(wf.on).toEqual({ push: { tags: ["v*"] } });
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(wf.jobs.build.needs).toBe("draft");
    expect(wf.jobs.publish.needs).toBe("build");
    expect(wf.jobs.build.strategy.matrix.include.map((m: { target: string }) => m.target).sort()).toEqual(["linux", "mac", "win"]);
    const build = JSON.stringify(wf.jobs.build.steps);
    expect(build).toContain("package:${{ matrix.target }}");
    expect(build).toContain("test:pack");
    // The installers, their blockmaps and the feeds; never builder-debug.yml.
    expect(build).toContain("*.dmg *.zip *.exe *.AppImage *.deb *.blockmap latest*.yml");
    const publish = JSON.stringify(wf.jobs.publish.steps);
    for (const feed of ["latest.yml", "latest-mac.yml", "latest-linux.yml"]) expect(publish).toContain(feed);
    expect(publish).toContain("--draft=false");
  });
});
