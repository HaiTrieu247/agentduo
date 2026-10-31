import { releaseNotesHtml, untaggedBase } from "../../../lib/release-notes.mjs";

export default ({ c, link, ext, p, ul, table, date }, d) => {
  const ch = d.channels;
  const pub = d.releases.releases;
  const releaseBlock = (r) => {
    const base = untaggedBase(r, pub);
    const installers = r.assets.filter((a) => /\.(dmg|exe|AppImage|deb)$/.test(a.name)).length;
    return `<article class="release" aria-labelledby="release-${r.version.replace(/\./g, "-")}">
<h3 id="release-${r.version.replace(/\./g, "-")}">${r.name}</h3>
<p>Published ${date(r.publishedAt)}${r.prerelease ? " as a pre-release" : ""}, with ${installers} installer${installers === 1 ? "" : "s"} among ${r.assets.length} files. ${ext(r.url, `See ${r.tag} on GitHub`)}.</p>
<div class="release-notes"><p class="release-notes-title">Release notes, as published:</p>${releaseNotesHtml(r.notes)}</div>
${base ? p(`The notes compare against ${c(base)}, which has no public release on GitHub. A comparison link does not mean that version was released.`) : ""}
</article>`;
  };
  return {
    title: "Releases",
    description: "Published versions of the AgentDuo desktop app on GitHub Releases, the agentduo npm package and the VS Code extension, from each channel's public data.",
    lead: p(`What each channel has published, read from its public API on ${date(ch.checkedAt)}. The desktop app, the npm package and the VS Code extension are released separately, so their versions can differ.`),
    sections: [
      {
        id: "latest",
        title: "Latest versions",
        html: table({
          caption: "Latest version per channel",
          head: ["Channel", "Version", "Published", "Where"],
          rows: [
            ["Desktop app", ch.github.version ?? "none published", ch.github.publishedAt ? date(ch.github.publishedAt) : "–", ext(ch.github.url, "GitHub Releases")],
            [`${c("agentduo")} on npm`, ch.npm.version ?? "unverified", ch.npm.publishedAt ? date(ch.npm.publishedAt) : "–", ext(ch.npm.url, "npm")],
            ["VS Code extension", ch.marketplace.version ?? "unverified", ch.marketplace.publishedAt ? date(ch.marketplace.publishedAt) : "–", ext(ch.marketplace.url, "Visual Studio Marketplace")],
          ],
        }),
      },
      {
        id: "desktop",
        title: "Desktop app on GitHub Releases",
        html: `${pub.length ? pub.map(releaseBlock).join("\n") : p("No release of the desktop app is public yet.")}
${p("Drafts are not listed: a release becomes public only once the release workflow has built the installers for all three systems. " + ext(d.site.links.releases, "All releases on GitHub") + ".")}`,
      },
      {
        id: "npm",
        title: "The agentduo package on npm",
        html: `${p(`Versions of ${c("agentduo")} in the npm registry, newest first, with the time npm recorded for each.`)}
${table({
  caption: "npm versions",
  head: ["Version", "Published"],
  rows: (ch.npm.history ?? []).map((v) => [v.version, date(v.publishedAt)]),
})}`,
      },
      {
        id: "vscode",
        title: "The VS Code extension",
        html: p(`The Marketplace lists ${c(ch.marketplace.id)} at version ${ch.marketplace.version ?? "unverified"}${ch.marketplace.publishedAt ? `, updated ${date(ch.marketplace.publishedAt)}` : ""}. Its version history is on the ${ext(ch.marketplace.url, "Marketplace page")}.`),
      },
      {
        id: "how-releases-work",
        title: "How a release is made",
        html: `${ul([
  `Pushing a ${c("v*")} tag (made by ${c("npm version")}) starts the repository’s release workflow. It checks that the tag matches the version of the npm package and of the desktop app.`,
  "The workflow creates a draft release, builds and tests the installers on macOS, Windows and Linux, and uploads them with their update metadata.",
  "Once every system has uploaded, it publishes the release. Installed desktop apps see it at their next update check. If one system fails, the release stays a draft.",
  "The npm package and the VS Code extension are published by hand, outside that workflow.",
])}
${p(link("docs/desktop-updates", "Desktop updates") + " explains what an installed app does with a new release.")}`,
      },
    ],
    related: ["download", "docs/desktop-updates", "docs/contributing"],
    next: p(link("download", "Download the latest version") + "."),
  };
};
