export default ({ c, link, ext, code, p, ul, steps, note, date, table }, d) => {
  const r = d.release;
  const s = d.signing;
  const ch = d.channels;
  const runLink = s ? ext(s.evidence, "the release workflow’s log") : "";
  const signed = (os) => {
    if (!s) return p(`How the ${r ? r.tag : "latest"} installers were signed has not been checked yet.`);
    if (os === "mac") {
      return p(`The ${r.tag} Mac app is <strong>ad-hoc signed</strong>, not signed with an Apple Developer ID, and <strong>not notarized</strong> (${runLink}, checked ${date(s.checkedAt)}).`);
    }
    if (os === "windows") return p(`The ${r.tag} installer is <strong>not code-signed</strong> (${runLink}, checked ${date(s.checkedAt)}).`);
    return p(`The ${r.tag} AppImage and .deb are <strong>not signed</strong>; electron-builder signs no Linux package (${runLink}, checked ${date(s.checkedAt)}).`);
  };
  const picker = `<div class="os-picker" hidden data-os-picker>
<p id="os-picker-label">Show the installers for:</p>
<div class="os-picker-buttons" role="group" aria-labelledby="os-picker-label">
<button type="button" data-os="mac" aria-pressed="false">macOS</button><button type="button" data-os="windows" aria-pressed="false">Windows</button><button type="button" data-os="linux" aria-pressed="false">Linux</button><button type="button" data-os="all" aria-pressed="false">All systems</button>
</div>
<p class="os-suggestion" hidden data-os-suggestion data-template="Showing {os}, the system this browser reports. Pick another one if that is wrong; the right architecture is yours to choose."></p>
</div>`;
  const panel = (os, name, body) => `<section class="os-panel" id="${os}" data-os-panel="${os}" aria-labelledby="${os}-title"><h3 id="${os}-title">${name}</h3>${d.dl.forOs(os)}<div class="panel-text">${body}</div></section>`;
  return {
    title: "Download AgentDuo",
    description: "Download the AgentDuo desktop app for macOS, Windows or Linux from GitHub Releases, install the duo command from npm, or add the VS Code extension.",
    lead: p(r
      ? `The desktop app ${r.version} was published on GitHub on ${date(r.publishedAt)}. The command-line package and the VS Code extension are published separately; each version below comes from its own channel, checked ${date(ch.checkedAt)}.`
      : `No desktop release is published on GitHub yet. The command-line package and the VS Code extension are published separately; their versions below were checked ${date(ch.checkedAt)}.`),
    top: `<div class="channels">
<div class="channel"><h2 class="visually-hidden">Versions by channel</h2><h3>Desktop app</h3><p class="version">${ch.github.version ?? "none"}</p><p class="meta">GitHub Releases${ch.github.publishedAt ? `, ${date(ch.github.publishedAt)}` : ""}</p></div>
<div class="channel"><h3>${c("duo")} on npm</h3><p class="version">${ch.npm.version ?? "unverified"}</p><p class="meta">package ${c("agentduo")}${ch.npm.publishedAt ? `, ${date(ch.npm.publishedAt)}` : ""}</p></div>
<div class="channel"><h3>VS Code extension</h3><p class="version">${ch.marketplace.version ?? "unverified"}</p><p class="meta">Visual Studio Marketplace${ch.marketplace.publishedAt ? `, ${date(ch.marketplace.publishedAt)}` : ""}</p></div>
</div>
${d.sourceVersion ? p(`The repository’s source code is at version ${d.sourceVersion}. A version in the source is not a release until a channel publishes it.`) : ""}`,
    sections: [
      {
        id: "desktop",
        title: "Desktop app",
        html: `${p("The installers come straight from the project’s " + ext(r ? r.url : d.site.links.releases, "GitHub release") + "; this site does not host them. The app needs Claude Code and Codex installed and signed in, and no Node.js of its own.")}
${picker}
${panel("mac", "macOS", `${p("<strong>Which one?</strong> Open the Apple menu, then <em>About This Mac</em>. If it lists a <em>Chip</em> such as Apple M1 or later, download the Apple silicon build. If it lists a <em>Processor</em> made by Intel, download the Intel build.")}
${steps([
  ["Install", p("Open the .dmg, drag AgentDuo into Applications, then open it from Applications.")],
  ["Open it the first time", `${signed("mac")}${p("Gatekeeper therefore stops the first launch. Open <em>System Settings → Privacy &amp; Security</em>, find the message about AgentDuo and choose <em>Open Anyway</em>, then confirm. Do this only for a file you downloaded from the project’s GitHub release.")}`],
  ["Updates", p("A Mac app without a Developer ID signature cannot replace itself. AgentDuo checks GitHub and tells you when a new version is out (<em>Get AgentDuo x.y.z</em> in the sidebar and in Settings → General); download the new .dmg and replace the app. Your settings and conversations are not inside the app, so they stay. " + link("docs/desktop-updates", "How updates work") + ".")],
])}`)}
${panel("windows", "Windows", `${p("The installer is an assisted NSIS setup rather than a one-click one: it lets you choose who it installs for and in which folder.")}
${steps([
  ["Install", p("Run the .exe and follow the setup. AgentDuo appears in the Start menu.")],
  ["If SmartScreen warns", `${signed("windows")}${p("Microsoft Defender SmartScreen can therefore show <em>Windows protected your PC</em>. Choose <em>More info</em>, check that the file is the one you downloaded from the project’s GitHub release, then <em>Run anyway</em>.")}`],
  ["Updates", p("The installed app downloads a new version in the background, checks its checksum, and installs it when you choose <em>Restart to update</em> or quit. " + link("docs/desktop-updates", "How updates work") + ".")],
])}`)}
${panel("linux", "Linux", `${p("Two packages for x86_64: an AppImage that runs from any folder, and a .deb for Debian, Ubuntu and their derivatives. " + (s ? signed("linux").replace(/^<p>|<\/p>$/g, "") : ""))}
${steps([
  ["AppImage", `${p("Make the file executable, then run it:")}${code(r ? `chmod +x AgentDuo-${r.version}-linux-x86_64.AppImage\n./AgentDuo-${r.version}-linux-x86_64.AppImage` : "chmod +x AgentDuo-*-linux-x86_64.AppImage\n./AgentDuo-*-linux-x86_64.AppImage", { lang: "sh", label: "Terminal" })}${p("On Ubuntu 24.04 and later, which restrict unprivileged user namespaces, an AppImage cannot start Chromium’s sandbox. Install the .deb instead, or add an AppArmor profile for the AppImage’s path. AgentDuo never turns its sandbox off by itself. " + link("troubleshooting#linux-sandbox", "Linux sandbox errors") + ".")}`],
  [".deb", `${code(r ? `sudo apt install ./AgentDuo-${r.version}-linux-amd64.deb` : "sudo apt install ./AgentDuo-*-linux-amd64.deb", { lang: "sh", label: "Terminal" })}${p("The package installs to " + c("/opt/AgentDuo") + " with an AppArmor profile, so the sandbox works on Ubuntu 24.04 and later. Start AgentDuo from your applications menu.")}`],
  ["Updates", p("The AppImage downloads a new version in the background and installs it when you restart into it or quit. The .deb downloads it too, but installs it only when you choose <em>Restart to update</em>, through " + c("pkexec") + ", which asks for your password. " + link("docs/desktop-updates", "How updates work") + ".")],
])}`)}
${note(p("Builds for Windows on Arm and for Linux on arm64 are not published. Build from source on those systems: " + link("docs/contributing#desktop", "build the desktop app") + "."))}`,
      },
      {
        id: "cli",
        title: "Command line (npm)",
        html: `${p(`The ${c("agentduo")} package installs the ${c("duo")} command (and ${c("agentduo")}, the same command). The latest version on npm is ${ch.npm.version ?? "unverified"}${ch.npm.publishedAt ? `, published ${date(ch.npm.publishedAt)}` : ""}.`)}
${code("npm i -g agentduo\nduo --version", { lang: "sh", label: "Terminal" })}
${ul([
  `Node.js 22.12 or later and npm (${ext(d.site.links.nodeDownload, "nodejs.org")}). Git for pipeline runs.`,
  `Claude Code and Codex CLI installed and signed in. ${c("duo doctor")} checks both without calling a model.`,
  `Update with the same command; ${c("npm i -g agentduo@latest")} picks the newest version.`,
])}
${p(link("learn/cli", "Get started in the terminal") + " or see the " + ext(d.site.links.npm, "package on npm") + ".")}`,
      },
      {
        id: "vscode",
        title: "VS Code extension",
        html: `${p(`The extension is ${c(d.site.marketplaceId)} on the Visual Studio Marketplace, version ${ch.marketplace.version ?? "unverified"}${ch.marketplace.publishedAt ? `, updated ${date(ch.marketplace.publishedAt)}` : ""}. Install it from the ${ext(d.site.links.marketplace, "Marketplace page")}, from the Extensions view (search for agentduo), or from a terminal:`)}
${code(`code --install-extension ${d.site.marketplaceId}`, { lang: "sh", label: "Terminal" })}
${ul([
  "VS Code desktop 1.95 or later, with a local folder or none. Remote SSH, WSL, containers and the web build are not supported.",
  `Node.js 22.12 or later on the ${c("PATH")} VS Code sees, or set ${c("agentduo.nodePath")}. The extension carries its own engine; the npm package is not needed.`,
])}
${p(link("learn/vscode", "Get started in VS Code") + ".")}`,
      },
      {
        id: "verify",
        title: "Check a download",
        html: `${p("Each installer above lists the SHA-256 checksum GitHub recorded for the uploaded file. Compute the checksum of your download and compare:")}
${table({
  caption: "Commands that print a SHA-256 checksum",
  head: ["System", "Command"],
  rows: [
    ["macOS", c("shasum -a 256 ~/Downloads/AgentDuo-*.dmg")],
    ["Windows (PowerShell)", c("Get-FileHash $HOME\\Downloads\\AgentDuo-*.exe -Algorithm SHA256")],
    ["Linux", c("sha256sum AgentDuo-*")],
  ],
})}
${p("A matching checksum shows the file is the one uploaded to the release. It does not replace a code signature: see the signing notes for your system above.")}`,
      },
      {
        id: "other-files",
        title: "Other files in a release",
        html: `${p("A release also holds files that are not installers. They are listed on the " + ext(d.site.links.releases, "GitHub Releases page") + " but not offered above:")}
${ul([
  `${c("AgentDuo-<version>-mac-<arch>.zip")}: the Mac app the updater downloads. Use the .dmg to install.`,
  `${c(".blockmap")} files and ${c("latest.yml")}, ${c("latest-mac.yml")}, ${c("latest-linux.yml")}: update metadata the installed app reads.`,
])}
${p(link("releases", "Releases") + " lists every published version with its notes.")}`,
      },
    ],
    scripts: ["download.js"],
    related: ["learn/prerequisites", "learn/desktop", "docs/desktop-updates", "troubleshooting"],
    next: p(link("learn/prerequisites", "Check what you need") + " before the first run: both CLIs, signed in."),
  };
};
