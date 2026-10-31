// What the website says about the project itself: names, repository links and the languages it is written in.
// The public origin is not here: it comes from SITE_URL (or Netlify's URL) at build time, see lib/urls.mjs.
const github = "https://github.com/HaiTrieu247/agentduo";

export default {
  name: "AgentDuo",
  repository: "HaiTrieu247/agentduo",
  links: {
    github,
    issues: `${github}/issues`,
    newIssue: `${github}/issues/new`,
    pulls: `${github}/pulls`,
    releases: `${github}/releases`,
    license: `${github}/blob/main/LICENSE`,
    readme: `${github}/blob/main/README.md`,
    desktopReadme: `${github}/blob/main/apps/desktop/README.md`,
    desktopVerification: `${github}/blob/main/apps/desktop/VERIFICATION.md`,
    extensionReadme: `${github}/blob/main/extensions/vscode/README.md`,
    agents: `${github}/blob/main/AGENTS.md`,
    npm: "https://www.npmjs.com/package/agentduo",
    marketplace: "https://marketplace.visualstudio.com/items?itemName=HaiTrieuThinh.agentduo-vscode",
    claudeCode: "https://code.claude.com/docs/en/overview",
    claudeCodeSetup: "https://code.claude.com/docs/en/setup",
    codexCli: "https://developers.openai.com/codex/cli/",
    nodeDownload: "https://nodejs.org/en/download",
  },
  marketplaceId: "HaiTrieuThinh.agentduo-vscode",
  npmPackage: "agentduo",
  locales: ["en", "vi"],
  defaultLocale: "en",
  // The page a visitor lands on in each language; the routes themselves are in content/navigation.mjs.
  localeNames: { en: "English", vi: "Tiếng Việt" },
  htmlLang: { en: "en", vi: "vi" },
  ogLocale: { en: "en_US", vi: "vi_VN" },
};
