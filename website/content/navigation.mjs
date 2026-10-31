// The route registry, shared by every language: each page's id, path and layout, the order of Learn and Docs, and
// the header and footer links. A language supplies the words (content/<locale>/index.mjs) and one module per page.
// Navigation, breadcrumbs, Previous/Next, the sitemap and the search index all come from here.

/** Every page. `section` puts it in a sidebar; `noindex` keeps it out of the sitemap and the search index. */
export const PAGES = [
  { id: "home", path: "/", layout: "home" },
  { id: "about", path: "/about/", layout: "page" },
  { id: "download", path: "/download/", layout: "download" },
  { id: "releases", path: "/releases/", layout: "page" },
  { id: "faq", path: "/faq/", layout: "page" },
  { id: "learn", path: "/learn/", layout: "doc", section: "learn" },
  { id: "learn/prerequisites", path: "/learn/prerequisites/", layout: "doc", section: "learn" },
  { id: "learn/desktop", path: "/learn/desktop/", layout: "doc", section: "learn" },
  { id: "learn/cli", path: "/learn/cli/", layout: "doc", section: "learn" },
  { id: "learn/vscode", path: "/learn/vscode/", layout: "doc", section: "learn" },
  { id: "learn/first-task", path: "/learn/first-task/", layout: "doc", section: "learn" },
  { id: "docs", path: "/docs/", layout: "doc", section: "docs" },
  { id: "docs/concepts", path: "/docs/concepts/", layout: "doc", section: "docs" },
  { id: "docs/conversations", path: "/docs/conversations/", layout: "doc", section: "docs" },
  { id: "docs/discuss", path: "/docs/discuss/", layout: "doc", section: "docs" },
  { id: "docs/pipeline", path: "/docs/pipeline/", layout: "doc", section: "docs" },
  { id: "docs/decisions-resume", path: "/docs/decisions-resume/", layout: "doc", section: "docs" },
  { id: "docs/attachments", path: "/docs/attachments/", layout: "doc", section: "docs" },
  { id: "docs/configuration", path: "/docs/configuration/", layout: "doc", section: "docs" },
  { id: "docs/permissions", path: "/docs/permissions/", layout: "doc", section: "docs" },
  { id: "docs/accounts-usage", path: "/docs/accounts-usage/", layout: "doc", section: "docs" },
  { id: "docs/desktop-updates", path: "/docs/desktop-updates/", layout: "doc", section: "docs" },
  { id: "docs/data-diagnostics", path: "/docs/data-diagnostics/", layout: "doc", section: "docs" },
  { id: "docs/cli", path: "/docs/cli/", layout: "doc", section: "docs" },
  { id: "docs/slash-commands", path: "/docs/slash-commands/", layout: "doc", section: "docs" },
  { id: "docs/config-reference", path: "/docs/config-reference/", layout: "doc", section: "docs" },
  { id: "troubleshooting", path: "/troubleshooting/", layout: "doc", section: "docs" },
  { id: "docs/contributing", path: "/docs/contributing/", layout: "doc", section: "docs" },
  { id: "search", path: "/search/", layout: "search", noindex: true },
  { id: "not-found", path: "/404.html", layout: "page", noindex: true },
];

/** The sidebars: groups of page ids, in reading order. Previous/Next follow this order within a section. */
export const SECTIONS = {
  learn: [
    { key: "start", pages: ["learn", "learn/prerequisites", "learn/desktop", "learn/cli", "learn/vscode", "learn/first-task"] },
  ],
  docs: [
    { key: "overview", pages: ["docs", "docs/concepts"] },
    { key: "using", pages: ["docs/conversations", "docs/discuss", "docs/pipeline", "docs/decisions-resume", "docs/attachments"] },
    { key: "configure", pages: ["docs/configuration", "docs/permissions", "docs/accounts-usage", "docs/desktop-updates", "docs/data-diagnostics"] },
    { key: "reference", pages: ["docs/cli", "docs/slash-commands", "docs/config-reference"] },
    { key: "help", pages: ["troubleshooting", "docs/contributing"] },
  ],
};

/** The header's main links, in order. */
export const HEADER_NAV = ["learn", "docs", "download", "about", "releases", "faq"];

/** The footer's columns of site links; each language adds its labels and the external links. */
export const FOOTER_NAV = [
  { key: "product", pages: ["home", "about", "download", "releases"] },
  { key: "learn", pages: ["learn", "learn/first-task", "docs", "docs/cli"] },
  { key: "help", pages: ["faq", "troubleshooting", "docs/contributing", "search"] },
];

export const pageById = new Map(PAGES.map((p) => [p.id, p]));
