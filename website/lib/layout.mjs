// Page shells: the head (title, description, social and alternate-language metadata), the header and footer every
// page shares, and the home, document and plain page layouts. Everything here is a function of the page's content,
// its language bundle and the route registry; nothing reads the clock, so two builds write the same bytes.
import site from "../site.config.mjs";
import { FOOTER_NAV, HEADER_NAV, SECTIONS, pageById } from "../content/navigation.mjs";
import { esc } from "./render.mjs";
import { absoluteUrl, assetRoute } from "./urls.mjs";

/** AgentDuo's mark: Codex (teal) and Claude Code (orange) on one loop, each handing its work to the other. */
export function logoSvg(className = "logo") {
  return `<svg class="${className}" viewBox="226 226 572 572" width="28" height="28" aria-hidden="true" focusable="false">` +
    `<g fill="none" stroke-width="56" stroke-linecap="round"><path class="logo-codex" d="M342 342H578A104 104 0 0 1 682 446V538"/>` +
    `<path class="logo-claude" d="M682 682H446A104 104 0 0 1 342 578V486"/></g>` +
    `<circle class="logo-codex-dot" cx="342" cy="342" r="100"/><circle class="logo-claude-dot" cx="682" cy="682" r="100"/></svg>`;
}

const attr = (name, value) => (value ? ` ${name}="${esc(value)}"` : "");

function head(ctx) {
  const { mod, locale, route, origin, page, alternates } = ctx;
  const title = page.id === "home" ? mod.htmlTitle ?? `${site.name}: ${mod.title}` : `${mod.title} | ${site.name}`;
  const abs = absoluteUrl(origin, route);
  const lines = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(mod.description)}">`,
    `<meta name="color-scheme" content="light dark">`,
    `<meta name="theme-color" content="#f3f5f8" media="(prefers-color-scheme: light)">`,
    `<meta name="theme-color" content="#0b1118" media="(prefers-color-scheme: dark)">`,
  ];
  if (page.noindex) lines.push(`<meta name="robots" content="noindex">`);
  if (abs && !page.noindex) {
    lines.push(`<link rel="canonical" href="${esc(abs)}">`);
    for (const [loc, r] of alternates) lines.push(`<link rel="alternate" hreflang="${site.htmlLang[loc]}" href="${esc(absoluteUrl(origin, r))}">`);
    lines.push(`<link rel="alternate" hreflang="x-default" href="${esc(absoluteUrl(origin, alternates.get(site.defaultLocale)))}">`);
  }
  lines.push(
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${site.name}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(mod.description)}">`,
    `<meta property="og:locale" content="${site.ogLocale[locale]}">`,
    ...site.locales.filter((l) => l !== locale).map((l) => `<meta property="og:locale:alternate" content="${site.ogLocale[l]}">`),
  );
  if (abs) {
    lines.push(`<meta property="og:url" content="${esc(abs)}">`, `<meta property="og:image" content="${esc(absoluteUrl(origin, assetRoute("icon.png")))}">`,
      `<meta property="og:image:alt" content="${esc(ctx.L.strings.logoAlt)}">`);
  }
  lines.push(
    `<meta name="twitter:card" content="summary">`,
    `<link rel="icon" href="${assetRoute("favicon.svg")}" type="image/svg+xml">`,
    `<link rel="apple-touch-icon" href="${assetRoute("icon.png")}">`,
    // The regular weight of the subsets every page of the language needs, so body text is not drawn twice.
    ...(locale === "vi" ? ["latin", "vietnamese"] : ["latin"]).map((subset) =>
      `<link rel="preload" href="${assetRoute(`fonts/be-vietnam-pro-${subset}-400-normal.woff2`)}" as="font" type="font/woff2" crossorigin>`),
    `<link rel="stylesheet" href="${assetRoute("styles.css")}">`,
    `<script src="${assetRoute("theme-init.js")}"></script>`,
    `<script src="${assetRoute("site.js")}" defer></script>`,
    `<script type="module" src="${assetRoute("search-dialog.js")}"></script>`,
  );
  for (const script of ctx.scripts ?? []) lines.push(`<script type="module" src="${assetRoute(script)}"></script>`);
  return lines.join("\n");
}

function navLinks(ctx, listClass) {
  const { L, routeOf, page } = ctx;
  const items = HEADER_NAV.map((id) => {
    const current = page.id === id;
    const inSection = !current && (pageById.get(page.id)?.section === id || (id === "docs" && page.id === "troubleshooting"));
    return `<li><a href="${routeOf(id)}"${current ? ` aria-current="page"` : ""}${inSection ? ` class="is-active"` : ""}>${esc(L.strings.nav[id])}</a></li>`;
  });
  return `<ul class="${listClass}">${items.join("")}</ul>`;
}

const SEARCH_ICON = `<svg class="search-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">` +
  `<circle cx="8.5" cy="8.5" r="5.75" fill="none" stroke="currentColor" stroke-width="1.8"/>` +
  `<path d="M13 13l4.25 4.25" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;

/**
 * The header's search: a form that goes to the search page, and a button that opens the search dialog instead.
 * search-dialog.js shows the button and hides the form; without JavaScript the form is what you get.
 */
function searchForm(ctx, id) {
  const s = ctx.L.strings.search;
  const button = `<button type="button" class="search-trigger" hidden data-search-open aria-haspopup="dialog" aria-label="${esc(s.label)}"` +
    ` aria-keyshortcuts="Control+K Meta+K">${SEARCH_ICON}<span class="search-trigger-label">${esc(s.placeholder)}</span>` +
    `<kbd class="search-shortcut" hidden data-search-shortcut>Ctrl K</kbd></button>`;
  return `${button}<form class="search-form" role="search" action="${ctx.routeOf("search")}" method="get" data-search-form>` +
    `<label class="visually-hidden" for="${id}">${esc(s.label)}</label>` +
    `<input id="${id}" class="search-input" type="search" name="q" placeholder="${esc(s.placeholder)}" autocomplete="off" spellcheck="false" data-search-input>` +
    `<kbd class="search-shortcut" hidden data-search-shortcut>Ctrl K</kbd>` +
    `<button class="search-submit" type="submit">${esc(s.button)}</button></form>`;
}

function langSwitch(ctx) {
  const { alternates, locale } = ctx;
  return site.locales.filter((l) => l !== locale).map((l) =>
    `<a class="lang-link" href="${alternates.get(l)}" hreflang="${site.htmlLang[l]}" lang="${site.htmlLang[l]}">${esc(site.localeNames[l])}</a>`).join("");
}

function themeControl(ctx, id) {
  const t = ctx.L.strings.theme;
  // Hidden until site.js runs: without JavaScript the site follows the system theme and shows no dead control.
  return `<div class="theme-control" hidden data-theme-control><label class="visually-hidden" for="${id}">${esc(t.label)}</label>` +
    `<select id="${id}" class="theme-select" data-theme-select><option value="system">${esc(t.system)}</option>` +
    `<option value="light">${esc(t.light)}</option><option value="dark">${esc(t.dark)}</option></select></div>`;
}

function header(ctx) {
  const { L, routeOf } = ctx;
  return `<a class="skip-link" href="#main">${esc(L.strings.skip)}</a>
<header class="site-header">
<div class="header-inner">
<a class="brand" href="${routeOf("home")}">${logoSvg()}<span class="brand-name">${site.name}</span></a>
<nav class="primary-nav" aria-label="${esc(L.strings.mainNav)}">${navLinks(ctx, "nav-list")}</nav>
<div class="header-tools">
${searchForm(ctx, "site-search")}
${langSwitch(ctx)}
${themeControl(ctx, "theme-select")}
<a class="github-link" href="${site.links.github}" rel="noopener">GitHub</a>
</div>
<details class="mobile-menu" data-mobile-menu>
<summary class="mobile-menu-button"><span class="menu-icon" aria-hidden="true"></span><span>${esc(L.strings.menu)}</span></summary>
<div class="mobile-menu-panel">
${searchForm(ctx, "mobile-search")}
<nav aria-label="${esc(L.strings.mainNav)}">${navLinks(ctx, "mobile-nav-list")}</nav>
<div class="mobile-menu-tools">${langSwitch(ctx)}${themeControl(ctx, "mobile-theme-select")}<a class="github-link" href="${site.links.github}" rel="noopener">GitHub</a></div>
</div>
</details>
</div>
</header>`;
}

function footer(ctx) {
  const { L, routeOf, titleOf } = ctx;
  const f = L.strings.footer;
  const cols = FOOTER_NAV.map((col) => `<div class="footer-col"><h2 class="footer-heading">${esc(f.columns[col.key])}</h2><ul>` +
    col.pages.map((id) => `<li><a href="${routeOf(id)}">${esc(L.strings.nav[id] ?? titleOf(id))}</a></li>`).join("") + `</ul></div>`);
  const project = [
    [site.links.github, f.source], [site.links.newIssue, f.report], [site.links.pulls, f.pulls],
    [site.links.license, f.license], [site.links.npm, f.npm], [site.links.marketplace, f.marketplace],
  ];
  cols.push(`<div class="footer-col"><h2 class="footer-heading">${esc(f.columns.project)}</h2><ul>` +
    project.map(([href, label]) => `<li><a href="${href}" rel="noopener">${esc(label)}</a></li>`).join("") + `</ul></div>`);
  return `<footer class="site-footer">
<div class="footer-inner">
<div class="footer-brand"><a class="brand" href="${routeOf("home")}">${logoSvg()}<span class="brand-name">${site.name}</span></a><p>${f.about}</p></div>
<nav class="footer-nav" aria-label="${esc(f.label)}">${cols.join("")}</nav>
</div>
<div class="footer-meta"><p>${f.legal}</p><p>${f.privacy}</p><p class="footer-langs">${langSwitch(ctx)}</p></div>
</footer>`;
}

/**
 * The search dialog, opened by search-dialog.js. A closed <dialog> is not shown, so without JavaScript it is never
 * seen. Its words come from the language bundle; the script fills the list from this language's index.
 */
function searchDialog(ctx) {
  const { L, routeOf } = ctx;
  const s = L.strings.search;
  const t = s.dialog;
  const data = { index: `${routeOf("home")}search-index.json`, loading: t.loading, error: t.error, none: t.none, one: t.one, many: t.many, all: t.all };
  const attrs = Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join("");
  return `<dialog class="search-dialog" aria-label="${esc(s.label)}" data-search-dialog${attrs}>
<div class="search-dialog-panel">
<form class="search-dialog-form" role="search" action="${routeOf("search")}" method="get">
${SEARCH_ICON}<label class="visually-hidden" for="search-dialog-input">${esc(s.label)}</label>
<input id="search-dialog-input" class="search-dialog-input" type="search" name="q" placeholder="${esc(t.placeholder)}" autocomplete="off" spellcheck="false" enterkeyhint="search" role="combobox" aria-expanded="false" aria-controls="search-dialog-options" aria-autocomplete="list">
<button type="button" class="search-dialog-close" aria-label="${esc(t.close)}" data-search-close><kbd>Esc</kbd><span>${esc(t.cancel)}</span></button>
</form>
<div class="search-dialog-body" data-search-body>
<p class="search-dialog-heading" data-search-recent hidden><span>${esc(t.recent)}</span><button type="button" class="search-dialog-clear" data-search-recent-clear>${esc(t.clear)}</button></p>
<ul class="search-dialog-options" id="search-dialog-options" role="listbox" aria-label="${esc(t.results)}" data-search-options></ul>
<p class="search-dialog-status" role="status" data-search-dialog-status></p>
</div>
<div class="search-dialog-footer"><a class="search-dialog-all" href="${routeOf("search")}" data-search-all hidden></a>` +
    `<p class="search-dialog-keys" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> ${esc(t.move)}</span><span><kbd>↵</kbd> ${esc(t.open)}</span><span><kbd>Esc</kbd> ${esc(t.dismiss)}</span></p></div>
</div>
</dialog>`;
}

/** A content section: an h2 that links to itself, then its HTML. */
export function sectionHtml(s, level = 2) {
  return `<section class="doc-section" aria-labelledby="${esc(s.id)}"><h${level} id="${esc(s.id)}"><a class="heading-link" href="#${esc(s.id)}">${s.title}</a></h${level}>${s.html}</section>`;
}

function toc(ctx, variant) {
  const { mod, L } = ctx;
  const items = mod.sections.map((s) => `<li><a href="#${esc(s.id)}">${s.title}</a></li>`).join("");
  if (variant === "compact") {
    return `<details class="toc-compact"><summary>${esc(L.strings.toc)}</summary><nav aria-label="${esc(L.strings.toc)}"><ul>${items}</ul></nav></details>`;
  }
  return `<aside class="doc-toc"><nav aria-label="${esc(L.strings.toc)}"><p class="toc-title">${esc(L.strings.toc)}</p><ul data-toc>${items}</ul></nav></aside>`;
}

function sectionOf(pageId) {
  for (const [key, groups] of Object.entries(SECTIONS)) {
    for (const g of groups) if (g.pages.includes(pageId)) return { key, group: g, order: groups.flatMap((x) => x.pages) };
  }
  return null;
}

function sidebar(ctx) {
  const { L, routeOf, titleOf, page } = ctx;
  const sec = sectionOf(page.id);
  const groups = SECTIONS[sec.key].map((g) => `<div class="doc-nav-group"><h2 class="doc-nav-heading">${esc(L.strings.groups[g.key])}</h2><ul>` +
    g.pages.map((id) => `<li><a href="${routeOf(id)}"${id === page.id ? ` aria-current="page"` : ""}>${esc(L.strings.short?.[id] ?? titleOf(id))}</a></li>`).join("") +
    `</ul></div>`).join("");
  return `<nav class="doc-nav" id="doc-nav" aria-label="${esc(L.strings.sectionNav[sec.key])}">${groups}</nav>`;
}

function breadcrumbs(ctx) {
  const { L, routeOf, titleOf, page } = ctx;
  const sec = sectionOf(page.id);
  if (!sec) return "";
  const crumbs = [`<li><a href="${routeOf(sec.key)}">${esc(L.strings.nav[sec.key])}</a></li>`];
  if (page.id !== sec.key) crumbs.push(`<li>${esc(L.strings.groups[sec.group.key])}</li>`);
  crumbs.push(`<li><span aria-current="page">${esc(titleOf(page.id))}</span></li>`);
  return `<nav class="breadcrumbs" aria-label="${esc(L.strings.breadcrumb)}"><ol>${crumbs.join("")}</ol></nav>`;
}

function pager(ctx) {
  const { L, routeOf, titleOf, page } = ctx;
  const sec = sectionOf(page.id);
  if (!sec) return "";
  const i = sec.order.indexOf(page.id);
  const prev = sec.order[i - 1];
  const next = sec.order[i + 1];
  const link = (id, rel, label) => `<a class="pager-${rel}" href="${routeOf(id)}" rel="${rel}"><span class="pager-label">${esc(label)}</span><span class="pager-title">${esc(titleOf(id))}</span></a>`;
  return `<nav class="pager" aria-label="${esc(L.strings.pager.label)}">${prev ? link(prev, "prev", L.strings.pager.prev) : "<span></span>"}${next ? link(next, "next", L.strings.pager.next) : ""}</nav>`;
}

function related(ctx) {
  const { mod, L, routeOf, titleOf } = ctx;
  if (!mod.related?.length) return "";
  return `<aside class="related" aria-labelledby="related-pages"><h2 id="related-pages">${esc(L.strings.related)}</h2><ul>` +
    mod.related.map((target) => {
      const [id, fragment] = target.split("#");
      return `<li><a href="${routeOf(id)}${fragment ? `#${fragment}` : ""}">${esc(titleOf(id))}</a></li>`;
    }).join("") + `</ul></aside>`;
}

function nextStep(ctx) {
  const { mod, L } = ctx;
  if (!mod.next) return "";
  return `<aside class="next-step" aria-labelledby="next-step"><h2 id="next-step">${esc(L.strings.nextStep)}</h2>${mod.next}</aside>`;
}

function docBody(ctx) {
  const { mod, L } = ctx;
  const sec = sectionOf(ctx.page.id);
  return `<div class="doc-shell">
<main id="main" class="doc-main" tabindex="-1">
<article class="doc">
<header class="doc-header">
${breadcrumbs(ctx)}
<a class="browse-link" href="#doc-nav">${esc(L.strings.browse[sec.key])}</a>
<h1>${mod.title}</h1>
${mod.lead ? `<div class="lead">${mod.lead}</div>` : ""}
${mod.sections.length > 1 ? toc(ctx, "compact") : ""}
</header>
${mod.sections.map((s) => sectionHtml(s)).join("\n")}
${nextStep(ctx)}
${related(ctx)}
${pager(ctx)}
</article>
</main>
${sidebar(ctx)}
${mod.sections.length > 1 ? toc(ctx, "full") : ""}
</div>`;
}

function pageBody(ctx) {
  const { mod } = ctx;
  const withToc = mod.sections.length >= 3 && !mod.noToc;
  return `<div class="page-shell${withToc ? " has-toc" : ""}">
<main id="main" class="page-main" tabindex="-1">
<header class="page-header">
<h1>${mod.title}</h1>
${mod.lead ? `<div class="lead">${mod.lead}</div>` : ""}
${withToc ? toc(ctx, "compact") : ""}
</header>
${mod.top ?? ""}
${mod.sections.map((s) => sectionHtml(s)).join("\n")}
${nextStep(ctx)}
${related(ctx)}
</main>
${withToc ? toc(ctx, "full") : ""}
</div>`;
}

function homeBody(ctx) {
  const { mod } = ctx;
  return `<main id="main" class="home" tabindex="-1">
<section class="hero" aria-labelledby="hero-title">
<div class="hero-text">
<h1 id="hero-title">${mod.title}</h1>
<div class="hero-side">
${mod.lead}
${mod.actions}
</div>
</div>
<div class="hero-visual">${mod.visual}</div>
</section>
${mod.sections.map((s) => `<section class="band${s.className ? ` ${s.className}` : ""}" aria-labelledby="${esc(s.id)}"><div class="band-inner"><div class="band-head"><h2 id="${esc(s.id)}"><a class="heading-link" href="#${esc(s.id)}">${s.title}</a></h2></div><div class="band-body">${s.html}</div></div></section>`).join("\n")}
</main>`;
}

/** The whole page. */
export function renderPage(ctx) {
  const { L, locale, page } = ctx;
  const body = page.layout === "home" ? homeBody(ctx) : page.layout === "doc" ? docBody(ctx) : pageBody(ctx);
  const s = L.strings;
  return `<!doctype html>
<html lang="${site.htmlLang[locale]}">
<head>
${head(ctx)}
</head>
<body class="layout-${page.layout}" data-copy="${esc(s.copy.button)}" data-copy-label="${esc(s.copy.label)}" data-copied="${esc(s.copy.copied)}" data-copy-failed="${esc(s.copy.failed)}">
${header(ctx)}
${body}
${footer(ctx)}
${searchDialog(ctx)}
<div class="visually-hidden" aria-live="polite" data-announcer></div>
</body>
</html>
`;
}
