// Refreshes the release snapshots the site is built from: data/releases.json (public GitHub Releases and their
// assets) and data/channels.json (the latest version on GitHub, npm and the VS Code Marketplace, each from its own
// source). Run it by hand (npm run update:releases); the build never calls it, so a build needs no network.
//
//   node scripts/update-releases.mjs                 fetch from the public APIs (GITHUB_TOKEN, if set, raises GitHub's rate limit)
//   node scripts/update-releases.mjs --import DIR    use saved answers instead: DIR/github.json, DIR/npm.json, DIR/marketplace.json
//
// Every answer is validated before anything is written; on any failure the last good snapshots stay as they are and
// the script exits with 1 and says what failed. GITHUB_TOKEN is sent only to api.github.com and never printed or saved.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPOSITORY, compareVersions, latestStable, releasesFromApi, validateChannels, validateReleases, writeJsonAtomic } from "../lib/release-data.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const TIMEOUT_MS = 15_000;
const NPM_PACKAGE = "agentduo";
const MARKETPLACE_ID = "HaiTrieuThinh.agentduo-vscode";
const SOURCES = {
  github: `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`,
  npm: `https://registry.npmjs.org/${NPM_PACKAGE}`,
  marketplace: "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery",
};

async function fetchJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}`);
  return res.json();
}

/** GitHub's releases, from the API; `gh api` (read only) when the API cannot be reached without it. */
async function githubReleases() {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "agentduo-website" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    return await fetchJson(SOURCES.github, { headers });
  } catch (e) {
    try {
      const out = execFileSync("gh", ["api", `repos/${REPOSITORY}/releases?per_page=100`], { encoding: "utf8", timeout: TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
      console.log(`github: the API failed (${e.message}); used gh api instead`);
      return JSON.parse(out);
    } catch {
      throw new Error(`GitHub releases: ${e.message} (and gh api was not available)`);
    }
  }
}

async function npmPackument() {
  return fetchJson(SOURCES.npm, { headers: { Accept: "application/json" } });
}

async function marketplaceQuery() {
  return fetchJson(SOURCES.marketplace, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json;api-version=7.2-preview.1" },
    body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: MARKETPLACE_ID }] }], flags: 914 }),
  });
}

function npmChannel(doc) {
  const version = doc?.["dist-tags"]?.latest;
  if (typeof version !== "string") throw new Error("npm: no latest dist-tag");
  const publishedAt = doc.time?.[version];
  if (!publishedAt) throw new Error(`npm: no publication time for ${version}`);
  const history = Object.entries(doc.time ?? {})
    .filter(([v]) => v !== "created" && v !== "modified" && doc.versions?.[v] && !/-/.test(v))
    .map(([v, at]) => ({ version: v, publishedAt: at }))
    .sort((a, b) => compareVersions(b.version, a.version));
  return { package: NPM_PACKAGE, version, publishedAt, url: `https://www.npmjs.com/package/${NPM_PACKAGE}`, source: SOURCES.npm, history };
}

function marketplaceChannel(answer) {
  const ext = answer?.results?.[0]?.extensions?.[0];
  if (!ext) throw new Error(`Marketplace: ${MARKETPLACE_ID} not found`);
  const [publisher, name] = MARKETPLACE_ID.split(".");
  if (ext.publisher?.publisherName !== publisher || ext.extensionName !== name) throw new Error("Marketplace: answered for another extension");
  const latest = ext.versions?.[0];
  if (typeof latest?.version !== "string") throw new Error("Marketplace: no version");
  return {
    id: MARKETPLACE_ID, version: latest.version, publishedAt: latest.lastUpdated,
    url: `https://marketplace.visualstudio.com/items?itemName=${MARKETPLACE_ID}`, source: SOURCES.marketplace,
  };
}

function githubChannel(snapshot) {
  const latest = latestStable(snapshot);
  return {
    version: latest?.version ?? null, publishedAt: latest?.publishedAt ?? null, tag: latest?.tag ?? null,
    url: latest?.url ?? `https://github.com/${REPOSITORY}/releases`, source: SOURCES.github.replace(/\?.*$/, ""),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const importDir = args[0] === "--import" ? args[1] : null;
  if (args.length && !importDir) {
    console.error("usage: node scripts/update-releases.mjs [--import DIR]");
    process.exit(2);
  }
  const checkedAt = new Date().toISOString();
  let github, npm, marketplace;
  if (importDir) {
    const read = (name) => {
      const path = join(importDir, name);
      if (!existsSync(path)) throw new Error(`${path} is missing`);
      return JSON.parse(readFileSync(path, "utf8"));
    };
    [github, npm, marketplace] = [read("github.json"), read("npm.json"), read("marketplace.json")];
  } else {
    [github, npm, marketplace] = await Promise.all([githubReleases(), npmPackument(), marketplaceQuery()]);
  }
  const releases = validateReleases(releasesFromApi(github, checkedAt));
  const channels = validateChannels({ schema: 1, checkedAt, github: githubChannel(releases), npm: npmChannel(npm), marketplace: marketplaceChannel(marketplace) });
  writeJsonAtomic(join(root, "data", "releases.json"), releases);
  writeJsonAtomic(join(root, "data", "channels.json"), channels);
  const latest = latestStable(releases);
  console.log(`releases: ${releases.releases.length} public release(s); latest stable ${latest ? latest.tag : "none"} with ${latest?.assets.length ?? 0} asset(s)`);
  console.log(`channels: GitHub ${channels.github.version ?? "none"}, npm ${channels.npm.version}, Marketplace ${channels.marketplace.version}`);
  console.log("signing evidence is kept by hand in data/signing.json; check it covers the latest release (see README).");
}

main().catch((e) => {
  console.error(`update-releases: ${e.message}`);
  console.error("The previous data/releases.json and data/channels.json were kept. Fix the cause, or save the API answers and use --import.");
  process.exit(1);
});
