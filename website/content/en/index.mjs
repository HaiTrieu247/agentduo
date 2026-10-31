// English: the interface words and one module per page id (content/navigation.mjs lists the ids).
import about from "./pages/about.mjs";
import download from "./pages/download.mjs";
import faq from "./pages/faq.mjs";
import home from "./pages/home.mjs";
import notFound from "./pages/not-found.mjs";
import releases from "./pages/releases.mjs";
import search from "./pages/search.mjs";
import troubleshooting from "./pages/troubleshooting.mjs";
import learn from "./learn/index.mjs";
import learnPrerequisites from "./learn/prerequisites.mjs";
import learnDesktop from "./learn/desktop.mjs";
import learnCli from "./learn/cli.mjs";
import learnVscode from "./learn/vscode.mjs";
import learnFirstTask from "./learn/first-task.mjs";
import docs from "./docs/index.mjs";
import concepts from "./docs/concepts.mjs";
import conversations from "./docs/conversations.mjs";
import discuss from "./docs/discuss.mjs";
import pipeline from "./docs/pipeline.mjs";
import decisionsResume from "./docs/decisions-resume.mjs";
import attachments from "./docs/attachments.mjs";
import configuration from "./docs/configuration.mjs";
import permissions from "./docs/permissions.mjs";
import accountsUsage from "./docs/accounts-usage.mjs";
import desktopUpdates from "./docs/desktop-updates.mjs";
import dataDiagnostics from "./docs/data-diagnostics.mjs";
import cli from "./docs/cli.mjs";
import slashCommands from "./docs/slash-commands.mjs";
import configReference from "./docs/config-reference.mjs";
import contributing from "./docs/contributing.mjs";

const ARCH = { arm64: "Apple silicon", x64: "Intel" };
const OS = { mac: "macOS", windows: "Windows", linux: "Linux" };
const ARCH_NAMES = { mac: { arm64: "Apple silicon (arm64)", x64: "Intel (x64)" }, windows: { x64: "x64", arm64: "Arm64" }, linux: { x64: "x86_64 (amd64)", arm64: "arm64" } };

export default {
  locale: "en",
  strings: {
    logoAlt: "The AgentDuo mark: a teal and an orange dot on one loop",
    skip: "Skip to content",
    mainNav: "Main",
    menu: "Menu",
    nav: { home: "Home", learn: "Learn", docs: "Docs", download: "Download", about: "About", releases: "Releases", faq: "FAQ" },
    short: {
      learn: "Start here",
      "learn/prerequisites": "What you need",
      "learn/desktop": "Desktop app",
      "learn/cli": "Terminal (duo)",
      "learn/vscode": "VS Code extension",
      "learn/first-task": "Your first task",
      docs: "Overview",
      "docs/concepts": "How it works",
      "docs/conversations": "Conversations",
      "docs/discuss": "Discussions",
      "docs/pipeline": "The pipeline",
      "docs/decisions-resume": "Decisions, stop and resume",
      "docs/attachments": "Files and images",
      "docs/configuration": "Configuration",
      "docs/permissions": "Permissions",
      "docs/accounts-usage": "Account & Usage",
      "docs/desktop-updates": "Desktop updates",
      "docs/data-diagnostics": "Data, logs, diagnostics",
      "docs/cli": "duo commands",
      "docs/slash-commands": "Slash commands",
      "docs/config-reference": "config.yaml keys",
      troubleshooting: "Troubleshooting",
      "docs/contributing": "Build and contribute",
    },
    groups: { start: "Get started", overview: "Overview", using: "Using AgentDuo", configure: "Configure", reference: "Reference", help: "Help" },
    sectionNav: { learn: "Learn", docs: "Documentation" },
    browse: { learn: "All Learn pages", docs: "All documentation pages" },
    breadcrumb: "Breadcrumb",
    toc: "On this page",
    pager: { label: "Previous and next page", prev: "Previous", next: "Next" },
    related: "Related pages",
    nextStep: "Next step",
    callout: { note: "Note", warning: "Warning", tip: "Tip" },
    search: {
      label: "Search the site", placeholder: "Search", button: "Search",
      dialog: {
        placeholder: "Search the docs, tutorials and pages",
        cancel: "Cancel",
        close: "Close search",
        results: "Search results",
        recent: "Recent searches",
        clear: "Clear",
        loading: "Loading the search index…",
        error: "The search index could not be loaded. Press Enter to open the search page.",
        none: "Nothing matches “{q}”. Check the spelling or try fewer words.",
        one: "1 result",
        many: "{n} results",
        all: "See all {n} results",
        move: "move", open: "open", dismiss: "close",
      },
    },
    theme: { label: "Theme", system: "System theme", light: "Light", dark: "Dark" },
    copy: { button: "Copy", label: "Copy this code", copied: "Copied", failed: "Copy failed: the code is selected, so press Ctrl+C (⌘C on a Mac)" },
    footer: {
      label: "Footer",
      columns: { product: "Product", learn: "Learn", help: "Help", project: "Project" },
      about: "Codex and Claude Code on one loop: one plans and reviews, the other critiques and builds, and you make the calls.",
      source: "Source on GitHub",
      report: "Report an issue",
      pulls: "Pull requests",
      license: "MIT license",
      npm: "npm package",
      marketplace: "VS Code Marketplace",
      legal: "AgentDuo is open source under the MIT license. It is not affiliated with Anthropic or OpenAI: Claude Code and Codex are their products, used with your own accounts.",
      privacy: "This site sets no cookies and has no analytics or tracking. Your theme choice and recent searches stay in your browser.",
    },
    downloads: {
      kinds: { dmg: "Disk image (.dmg)", nsis: "Installer (.exe)", appimage: "AppImage", deb: "Debian package (.deb)" },
      arch: ARCH_NAMES,
      download: (kind, arch) => ({
        dmg: `Download for ${ARCH[arch]}`,
        nsis: "Download the installer",
        appimage: "Download the AppImage",
        deb: "Download the .deb",
      })[kind],
      checksum: "SHA-256 checksum",
      unavailable: (os, arch) => `No ${OS[os]} build for ${ARCH_NAMES[os][arch]} is published.`,
    },
  },
  pages: {
    home, about, download, releases, faq, troubleshooting, search, "not-found": notFound,
    learn, "learn/prerequisites": learnPrerequisites, "learn/desktop": learnDesktop, "learn/cli": learnCli, "learn/vscode": learnVscode,
    "learn/first-task": learnFirstTask,
    docs, "docs/concepts": concepts, "docs/conversations": conversations, "docs/discuss": discuss, "docs/pipeline": pipeline,
    "docs/decisions-resume": decisionsResume, "docs/attachments": attachments, "docs/configuration": configuration,
    "docs/permissions": permissions, "docs/accounts-usage": accountsUsage, "docs/desktop-updates": desktopUpdates,
    "docs/data-diagnostics": dataDiagnostics, "docs/cli": cli, "docs/slash-commands": slashCommands,
    "docs/config-reference": configReference, "docs/contributing": contributing,
  },
};
