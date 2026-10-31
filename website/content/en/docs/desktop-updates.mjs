export default ({ c, link, date, p, ul, table, note, h3 }) => ({
  title: "Desktop app updates",
  description: "How the AgentDuo desktop app finds and installs new versions from GitHub Releases on Windows, macOS and Linux, when it only tells you, and what has been tested.",
  lead: p("An installed AgentDuo desktop app looks for new versions on the project’s published GitHub Releases. Where the build can replace itself it downloads the update in the background and installs it when you restart; where it cannot, it tells you a new version is out."),
  sections: [
    {
      id: "when",
      title: "When it checks",
      html: `${ul([
  "15 seconds after the app starts, then every 4 hours, while <em>Check for updates automatically</em> is on (Settings → General).",
  "<em>Check now</em> in Settings → General, or <em>Check for Updates…</em> (the AgentDuo menu on macOS, Help on Windows and Linux), checks at once either way.",
  "It reads the release’s feed (" + c("latest.yml") + ", " + c("latest-mac.yml") + ", " + c("latest-linux.yml") + ") and compares versions. It never downgrades, and a stable version skips pre-releases.",
  "Settings → General shows the app’s version and where its update is: up to date, downloading, ready, out but to be downloaded, or why it could not check.",
])}
${p("Until a release is published, a check says <em>No AgentDuo release is published on GitHub yet.</em>")}`,
    },
    {
      id: "platforms",
      title: "What each build does",
      html: `${table({
  caption: "How each kind of build updates",
  head: ["Build", "What happens"],
  rows: [
    ["Windows (NSIS installer), Linux AppImage", "Downloads in the background (its checksum checked), then the sidebar shows <em>Restart to update</em>. Quitting without restarting installs it too."],
    ["Linux " + c(".deb"), "Downloads the same way, but installs only on <em>Restart to update</em>, through " + c("pkexec") + ", which may ask for your password; never as a surprise when you quit."],
    ["macOS, signed with a Developer ID", "Updates like Windows."],
    ["macOS, ad-hoc signed", "Only tells: Squirrel.Mac installs only an update signed with the same Developer ID as the running app. <em>Get AgentDuo x.y.z</em> opens the release page to download the dmg."],
    ["Development build (" + c("npm run dev") + ")", "Never checks."],
  ],
})}
${h3("restart", "Restart to update")}
${p("Restarting quits as <em>Quit</em> does: open questions are answered, runs stopped and locks freed (a stopped pipeline stays resumable). Then the installer puts the new version in place and starts it. The app asks first when an agent is working.")}`,
    },
    {
      id: "test-profiles",
      title: "Test profiles",
      html: `${p("An app started with a profile of its own (" + c("AGENTDUO_DESKTOP_USER_DATA") + ", as every test does) never checks GitHub. It checks only a feed named by " + c("AGENTDUO_DESKTOP_UPDATE_CONFIG") + " (an " + c("app-update.yml") + ", for example electron-updater’s " + c("generic") + " provider on a local server) and installs nothing: it only says a newer version is out. Without that variable, updates are off.")}`,
    },
    {
      id: "releases",
      title: "Where updates come from",
      html: `${p("A " + c("v*") + " tag runs " + c(".github/workflows/release.yml") + ":")}
${ul([
  "it checks the tag against the package versions and creates a draft release (a pre-release when the version has a " + c("-") + ");",
  "macOS, Windows and Linux each build, test and upload their installers and update feed to the draft;",
  "the release is published only once all three have uploaded. Should one fail, it stays a draft, and installed apps see nothing.",
])}
${p("Without a Developer ID certificate the Mac app is ad-hoc signed, so it cannot update itself; without a Windows certificate the installer is unsigned and SmartScreen warns. Download links: " + link("download", "Download") + ".")}`,
    },
    {
      id: "tested",
      title: "What has been tested",
      html: `${note(p("No installer update path has been verified end to end, except one: an ad-hoc signed macOS copy of 0.8.0 found 0.8.1 and showed the notify-only message (observed by the project owner on " + date("2026-10-31") + "). Installing an update on Windows, from an AppImage, from a " + c(".deb") + " or on a Developer ID Mac build has not been verified yet."), "warning")}
${p("The automated tests check the update logic itself and, in the desktop E2E, a newer version on a local feed with a test profile, which only tells.")}
${p("When a check or a download fails, the app says why in Settings → General, and the updater’s log lines go to the app’s log: " + link("docs/data-diagnostics#desktop", "Diagnostics") + ".")}`,
    },
  ],
  related: ["learn/desktop", "docs/data-diagnostics", "docs/accounts-usage"],
});
