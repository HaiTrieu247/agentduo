// The release snapshots: how GitHub's answer becomes data/releases.json, which assets count as installers, and that a
// failed refresh leaves the committed snapshots alone.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  PLATFORMS, classifyAsset, compareVersions, downloadsOf, latestStable, readJson, releasesFromApi, validateChannels, validateReleases,
} from "../lib/release-data.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtures = join(root, "test", "fixtures", "releases");
const api = () => JSON.parse(readFileSync(join(fixtures, "github.json"), "utf8"));
const NOW = "2026-11-03T00:00:00.000Z";

test("drafts are left out, pre-releases kept but never the latest stable", () => {
  const snap = validateReleases(releasesFromApi(api(), NOW));
  assert.deepEqual(snap.releases.map((r) => r.tag), ["v0.9.0-beta.1", "v0.8.2"]);
  assert.equal(latestStable(snap).tag, "v0.8.2");
});

test("only real installers are downloads; blockmaps, feeds and the Mac zip are not", () => {
  const release = latestStable(releasesFromApi(api(), NOW));
  const { installers, byPlatform, other } = downloadsOf(release);
  assert.deepEqual(installers.map((i) => i.name).sort(), [
    "AgentDuo-0.8.2-linux-amd64.deb", "AgentDuo-0.8.2-linux-x86_64.AppImage", "AgentDuo-0.8.2-mac-arm64.dmg", "AgentDuo-0.8.2-win-x64.exe",
  ]);
  assert.deepEqual(other.map((o) => [o.name, o.role]).sort(), [
    ["AgentDuo-0.8.2-mac-arm64.dmg.blockmap", "update-metadata"],
    ["AgentDuo-0.8.2-mac-arm64.zip", "update-payload"],
    ["latest-mac.yml", "update-metadata"],
    ["latest.yml", "update-metadata"],
  ]);
  assert.equal(byPlatform.get("mac-x64").length, 0, "an architecture without an asset has no download");
  assert.equal(byPlatform.get("windows-arm64").length, 0);
  assert.equal(byPlatform.size, PLATFORMS.length);
  assert.equal(installers.find((i) => i.kind === "dmg").sha256, "1".repeat(64));
});

test("an asset of another version is not an installer of this one", () => {
  assert.equal(classifyAsset("AgentDuo-0.8.0-mac-arm64.dmg", "0.8.2").role, "other");
  assert.equal(classifyAsset("AgentDuo-0.8.2-linux-amd64.deb", "0.8.2").kind, "deb");
});

test("an unexpected answer is rejected rather than half used", () => {
  assert.throws(() => releasesFromApi({ message: "rate limited" }, NOW), /expected a list/);
  const dup = api();
  dup.push(structuredClone(dup[2]));
  assert.throws(() => releasesFromApi(dup, NOW), /duplicate tag/);
  const foreign = api();
  foreign[2].assets[0].browser_download_url = "https://example.org/AgentDuo-0.8.2-mac-arm64.dmg";
  assert.throws(() => releasesFromApi(foreign, NOW), /unexpected URL/);
  const partial = api();
  partial[2].assets[0].state = "starter";
  assert.throws(() => releasesFromApi(partial, NOW), /not fully uploaded/);
});

test("versions compare as semver, a pre-release below its release", () => {
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.ok(compareVersions("0.9.0-beta.1", "0.9.0") < 0);
  assert.equal(compareVersions("0.8.2", "0.8.2"), 0);
});

test("the committed snapshots are valid, and every listed installer is a GitHub release download", () => {
  const snap = validateReleases(readJson(join(root, "data", "releases.json")));
  const channels = validateChannels(readJson(join(root, "data", "channels.json")));
  const latest = latestStable(snap);
  assert.ok(latest, "a public stable release");
  assert.equal(channels.github.tag, latest.tag);
  for (const i of downloadsOf(latest).installers) assert.match(i.url, /^https:\/\/github\.com\/HaiTrieu247\/agentduo\/releases\/download\//);
  assert.ok(snap.releases.every((r) => r.tag !== "v0.8.0"), "v0.8.0 was only ever a draft");
});

test("a failed refresh exits 1 and keeps the last good snapshots", () => {
  const before = ["releases.json", "channels.json"].map((f) => readFileSync(join(root, "data", f), "utf8"));
  const r = spawnSync(process.execPath, [join(root, "scripts", "update-releases.mjs"), "--import", join(fixtures, "broken")], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /expected a list/);
  assert.match(r.stderr, /were kept/);
  const after = ["releases.json", "channels.json"].map((f) => readFileSync(join(root, "data", f), "utf8"));
  assert.deepEqual(after, before);
});

test("a deploy's refresh that fails only warns, so the build goes on with the committed snapshots", () => {
  const before = ["releases.json", "channels.json"].map((f) => readFileSync(join(root, "data", f), "utf8"));
  const r = spawnSync(process.execPath, [join(root, "scripts", "update-releases.mjs"), "--import", join(fixtures, "broken"), "--keep-on-failure"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /expected a list/);
  assert.match(r.stderr, /warning: the committed data\/releases.json and data\/channels.json are used as they are/);
  const after = ["releases.json", "channels.json"].map((f) => readFileSync(join(root, "data", f), "utf8"));
  assert.deepEqual(after, before);
});

test("the Netlify build refreshes the release data first, and never fails on it", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["build:netlify"], "node scripts/update-releases.mjs --keep-on-failure && node scripts/build.mjs");
  assert.match(readFileSync(join(root, "netlify.toml"), "utf8"), /^\s*command = "npm run build:netlify"$/m);
});
