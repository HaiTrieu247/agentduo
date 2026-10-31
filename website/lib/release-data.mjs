// The release snapshots (data/releases.json, data/channels.json): their shape, how a release asset is classified, and
// which release is the latest stable one. The build reads only these files; scripts/update-releases.mjs writes them.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export const REPOSITORY = "HaiTrieu247/agentduo";
const DOWNLOAD_PREFIX = `https://github.com/${REPOSITORY}/releases/download/`;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * The installers people download, by exact asset name (electron-builder's artifactName in
 * apps/desktop/electron-builder.yml). Everything else in a release is an update payload, update metadata or other.
 */
const INSTALLERS = [
  { re: /^AgentDuo-(.+)-mac-arm64\.dmg$/, os: "mac", arch: "arm64", kind: "dmg" },
  { re: /^AgentDuo-(.+)-mac-x64\.dmg$/, os: "mac", arch: "x64", kind: "dmg" },
  { re: /^AgentDuo-(.+)-win-x64\.exe$/, os: "windows", arch: "x64", kind: "nsis" },
  { re: /^AgentDuo-(.+)-win-arm64\.exe$/, os: "windows", arch: "arm64", kind: "nsis" },
  { re: /^AgentDuo-(.+)-linux-x86_64\.AppImage$/, os: "linux", arch: "x64", kind: "appimage" },
  { re: /^AgentDuo-(.+)-linux-arm64\.AppImage$/, os: "linux", arch: "arm64", kind: "appimage" },
  { re: /^AgentDuo-(.+)-linux-amd64\.deb$/, os: "linux", arch: "x64", kind: "deb" },
  { re: /^AgentDuo-(.+)-linux-arm64\.deb$/, os: "linux", arch: "arm64", kind: "deb" },
];

/** Every OS and architecture the download page has a row for, in display order. */
export const PLATFORMS = [
  { os: "mac", arch: "arm64" }, { os: "mac", arch: "x64" },
  { os: "windows", arch: "x64" }, { os: "windows", arch: "arm64" },
  { os: "linux", arch: "x64" }, { os: "linux", arch: "arm64" },
];

/**
 * What an asset is: an installer (with OS, architecture and package kind), an update payload (the Mac zip the updater
 * downloads), update metadata (blockmaps, latest*.yml feeds) or other. Only installers are offered as downloads.
 */
export function classifyAsset(name, version) {
  for (const i of INSTALLERS) {
    const m = i.re.exec(name);
    if (m && (!version || m[1] === version)) return { role: "installer", os: i.os, arch: i.arch, kind: i.kind };
  }
  if (/^AgentDuo-.+-mac-(arm64|x64)\.zip$/.test(name)) return { role: "update-payload", os: "mac", arch: name.includes("arm64") ? "arm64" : "x64", kind: "zip" };
  if (/\.blockmap$/.test(name) || /^latest(-mac|-linux)?\.yml$/.test(name)) return { role: "update-metadata" };
  return { role: "other" };
}

export function parseVersion(v) {
  const m = SEMVER.exec(String(v));
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null } : null;
}

export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

const isIso = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v);
const isHttps = (v, host) => {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && (!host || u.hostname === host);
  } catch {
    return false;
  }
};

/**
 * GitHub's releases API answer as the snapshot keeps it: public (not draft) releases only, each with its assets.
 * Throws when the answer does not have the expected shape, so a broken response never replaces a good snapshot.
 */
export function releasesFromApi(api, checkedAt) {
  if (!Array.isArray(api)) throw new Error("GitHub releases: expected a list");
  const releases = [];
  const tags = new Set();
  for (const r of api) {
    if (!r || typeof r !== "object") throw new Error("GitHub releases: an entry is not an object");
    if (r.draft === true) continue; // a draft is not public, whatever the API shows to someone with access
    if (typeof r.tag_name !== "string" || !/^v/.test(r.tag_name)) throw new Error(`GitHub releases: unexpected tag '${r.tag_name}'`);
    if (tags.has(r.tag_name)) throw new Error(`GitHub releases: duplicate tag ${r.tag_name}`);
    tags.add(r.tag_name);
    const version = r.tag_name.slice(1);
    if (!parseVersion(version)) throw new Error(`GitHub releases: tag ${r.tag_name} is not a version`);
    if (!isIso(r.published_at)) throw new Error(`GitHub releases: ${r.tag_name} has no publication date`);
    if (!isHttps(r.html_url, "github.com")) throw new Error(`GitHub releases: ${r.tag_name} has an unexpected page URL`);
    if (!Array.isArray(r.assets)) throw new Error(`GitHub releases: ${r.tag_name} has no asset list`);
    const names = new Set();
    const assets = r.assets.map((a) => {
      if (typeof a?.name !== "string" || !a.name) throw new Error(`GitHub releases: ${r.tag_name} has an asset without a name`);
      if (names.has(a.name)) throw new Error(`GitHub releases: ${r.tag_name} lists ${a.name} twice`);
      names.add(a.name);
      if (!Number.isInteger(a.size) || a.size < 0) throw new Error(`GitHub releases: ${a.name} has no size`);
      const expected = `${DOWNLOAD_PREFIX}${encodeURIComponent(r.tag_name)}/${encodeURIComponent(a.name)}`;
      if (a.browser_download_url !== expected) throw new Error(`GitHub releases: ${a.name} downloads from an unexpected URL: ${a.browser_download_url}`);
      if (a.state !== undefined && a.state !== "uploaded") throw new Error(`GitHub releases: ${a.name} is not fully uploaded (${a.state})`);
      const digest = typeof a.digest === "string" && /^sha256:[0-9a-f]{64}$/.test(a.digest) ? a.digest : null;
      return { name: a.name, size: a.size, url: a.browser_download_url, sha256: digest ? digest.slice(7) : null, contentType: a.content_type ?? null };
    });
    releases.push({
      tag: r.tag_name, version, name: typeof r.name === "string" && r.name ? r.name : r.tag_name, prerelease: r.prerelease === true,
      publishedAt: r.published_at, url: r.html_url, notes: typeof r.body === "string" ? r.body : "", assets,
    });
  }
  releases.sort((a, b) => compareVersions(b.version, a.version));
  return { schema: 1, repository: REPOSITORY, source: `https://api.github.com/repos/${REPOSITORY}/releases`, checkedAt, releases };
}

/** Throws unless `snap` is a releases snapshot this build can use. */
export function validateReleases(snap) {
  if (!snap || snap.schema !== 1 || snap.repository !== REPOSITORY) throw new Error("releases.json: not a schema 1 snapshot of this repository");
  if (!isIso(snap.checkedAt)) throw new Error("releases.json: checkedAt is not a date");
  if (!Array.isArray(snap.releases)) throw new Error("releases.json: releases is not a list");
  const tags = new Set();
  for (const r of snap.releases) {
    if (tags.has(r.tag)) throw new Error(`releases.json: duplicate tag ${r.tag}`);
    tags.add(r.tag);
    if (`v${r.version}` !== r.tag || !parseVersion(r.version)) throw new Error(`releases.json: tag ${r.tag} and version ${r.version} disagree`);
    if (!isIso(r.publishedAt) || !isHttps(r.url, "github.com")) throw new Error(`releases.json: ${r.tag} lacks a date or page`);
    for (const a of r.assets) {
      if (a.url !== `${DOWNLOAD_PREFIX}${encodeURIComponent(r.tag)}/${encodeURIComponent(a.name)}`) throw new Error(`releases.json: ${a.name} has an unexpected URL`);
      if (!Number.isInteger(a.size)) throw new Error(`releases.json: ${a.name} has no size`);
      if (a.sha256 !== null && !/^[0-9a-f]{64}$/.test(a.sha256)) throw new Error(`releases.json: ${a.name} has a malformed checksum`);
    }
  }
  return snap;
}

/** The newest public release that is not a pre-release, or null. */
export function latestStable(snap) {
  return snap.releases.filter((r) => !r.prerelease).sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
}

/** A release's assets grouped for the download page: installers per platform, and everything else by role. */
export function downloadsOf(release) {
  if (!release) return { installers: [], byPlatform: new Map(), other: [] };
  const installers = [];
  const other = [];
  for (const a of release.assets) {
    const kind = classifyAsset(a.name, release.version);
    if (kind.role === "installer") installers.push({ ...a, ...kind });
    else other.push({ ...a, ...kind });
  }
  const byPlatform = new Map(PLATFORMS.map((p) => [`${p.os}-${p.arch}`, installers.filter((i) => i.os === p.os && i.arch === p.arch)]));
  return { installers, byPlatform, other };
}

/** Throws unless `ch` is a channels snapshot: each channel has a version (or null, unverified) and where it came from. */
export function validateChannels(ch) {
  if (!ch || ch.schema !== 1 || !isIso(ch.checkedAt)) throw new Error("channels.json: not a schema 1 snapshot");
  for (const key of ["github", "npm", "marketplace"]) {
    const c = ch[key];
    if (!c || typeof c !== "object") throw new Error(`channels.json: ${key} is missing`);
    if (c.version !== null && !parseVersion(c.version)) throw new Error(`channels.json: ${key}.version is not a version`);
    if (!isHttps(c.source) || !isHttps(c.url)) throw new Error(`channels.json: ${key} lacks its source or page`);
    if (c.version !== null && !isIso(c.publishedAt)) throw new Error(`channels.json: ${key}.publishedAt is not a date`);
  }
  return ch;
}

export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** Writes JSON through a temporary file and a rename, so a reader never sees half a snapshot. */
export function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}
