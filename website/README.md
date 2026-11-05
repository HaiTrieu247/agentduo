# AgentDuo website

The AgentDuo website: product pages, Learn tutorials, Docs and downloads, in English (default, at `/`) and
Vietnamese (at `/vi/`). It is a static site: `npm run build` writes plain HTML, CSS and JavaScript into `dist/`, and any
static host can serve that folder. There is no framework, no server code, no database, no API key and no analytics.

The site is a package of its own (`website/package.json`) with **no dependencies**: every script uses only Node's
standard library. It needs Node ≥ 22.12. Nothing here changes the `agentduo` package at the repository root.

## Commands

Run them in `website/`:

| Command | What it does |
| --- | --- |
| `npm run build` | Builds every page in every language into `dist/` (cleaned first). Reads only local files, so it works offline. |
| `npm run build:netlify` | What Netlify runs: `update:releases` (a failure only warns), then `build`, so a deploy shows the versions published at that moment. |
| `npm run preview` | Serves `dist/` at <http://127.0.0.1:4173/> like a static host: `/docs` redirects to `/docs/`, a missing path answers 404 with the 404 page. `--port N` picks another port. |
| `npm run check` | Checks the build: every local link, asset and `#fragment`, unique ids, titles, descriptions, `lang`, language links, the search indexes, the download links against the release snapshot, and the hosting files. |
| `npm test` | The website's tests (`node:test`): release data, search, URL and SEO rules, the whole build, the preview server and the tutorial/config examples. |
| `npm run update:releases` | Refreshes `data/releases.json` and `data/channels.json` from GitHub, npm and the Marketplace (network). |
| `npm run browser-check` | Drives the built site in Electron (from `apps/desktop`): widths, themes, search, menu, copy, keyboard, no-JS. |
| `node scripts/check-page.mjs <id>…` | Checks some pages in both languages without a full build, while you write them. |

`npm test` includes `test/examples.test.mjs`, which validates every config example with the repository's own
`duo doctor`. It needs the CLI built at the root first (`npm ci && npm run build` in the repository root); without
`../dist/cli.js` those two tests are skipped and say why. `npm run browser-check` needs `npm ci --prefix apps/desktop`.

To look at the site locally:

```sh
cd website
npm run build
npm run preview
# open http://127.0.0.1:4173/ (English) or http://127.0.0.1:4173/vi/ (Tiếng Việt)
```

## Where things are

| Path | What |
| --- | --- |
| `content/navigation.mjs` | Every page: its id, route and layout; the Learn and Docs sidebars (groups and order, which also give Previous/Next); header and footer links. |
| `content/en/`, `content/vi/` | One module per page and language (`pages/`, `learn/`, `docs/`), plus `index.mjs` with the language's interface words. |
| `examples/` | Files shown on the pages and run by the tests: the first-task project (`first-task/initial`, `first-task/solution`) and complete `config/*.yaml` examples. |
| `lib/` | The generator: helpers given to content modules (`content.mjs`), page shells (`layout.mjs`), URLs and origin rules (`urls.mjs`), release data (`release-data.mjs`), the download table, search index, workflow figure. |
| `assets/` | CSS, the small scripts (theme, menu, copy, search page, search dialog, download filter), logos and icons (from `apps/vscode/media` and `apps/desktop/resources`), and the Be Vietnam Pro fonts (`fonts/`, from `@fontsource/be-vietnam-pro` 5.3.0, with their license). |
| `data/` | `releases.json` (public GitHub Releases and assets), `channels.json` (version per channel), `signing.json` (signing evidence, by hand). |
| `scripts/` | `build`, `preview`, `check`, `check-page`, `update-releases`, `browser-check`. |
| `SOURCES.md`, `DESIGN.md`, `VERIFICATION.md` | Where each fact comes from, the design decisions, and what was tested. |

## Writing content

A page module exports a function that gets the helpers and the site data, and returns the page:

```js
export default ({ c, code, ex, link, ext, table, note, p, ul, steps, h3 }, d) => ({
  title: "Page title",
  description: "One or two plain sentences, 50 to 220 characters, used for search engines and link previews.",
  lead: p("The opening paragraph."),
  sections: [
    { id: "first-part", title: "First part", html: p("Text with " + c("code") + " and " + link("docs/cli#exit-codes", "a link") + ".") },
  ],
  related: ["docs/pipeline", "troubleshooting#cli-not-found"],
  next: p(link("learn/first-task", "Your first task")),
});
```

- Write HTML for prose; use `code()` / `ex()` for code (escaped, highlighted by its `lang`: `sh`, `yaml`, `json`, `js`, `diff`, or none for chat input; with a copy button), `table()` for tables (they scroll
  in their own box) and `link("page-id#fragment", …)` for internal links: the build fails on an unknown page id, and
  `npm run check` on a fragment that names nothing.
- `d` holds the site data: `d.release` (latest stable release), `d.channels`, `d.signing`, `d.sourceVersion`, `d.dl`
  (download table helpers) and `d.titles`.
- The build refuses a page with a missing or too long description, an id used twice, an empty link or placeholder text.

### Adding a page

1. Add it to `PAGES` in `content/navigation.mjs` (id, path ending in `/`, layout) and, for Learn or Docs, to a group in
   `SECTIONS`.
2. Write `content/en/<…>.mjs` and `content/vi/<…>.mjs`, import both in their language's `index.mjs`, add them to
   `pages`, and give the page a short name under `strings.short` in each language.
3. Both languages must have the same section ids and sub-heading ids (the build checks it), so a link to
   `docs/x#part` works in each language. Translate the words; keep commands, flags, config keys and UI labels as they are.
4. `node scripts/check-page.mjs <id>`, then `npm run build && npm run check`.

### Adding a language

Add the locale to `locales`, `localeNames`, `htmlLang` and `ogLocale` in `site.config.mjs`, create
`content/<locale>/` with every page, and the build writes it under `/<locale>/` with its own search index and 404 page.

## Release data

The download page and the Releases page read `data/releases.json` and `data/channels.json`, so a visitor never waits
on GitHub's API: every download button is a plain link to the installer on GitHub Releases. The site never hosts
installers.

The versions follow releases by themselves. `npm version patch` (or `minor`) in the repository root bumps the source;
nothing is published yet, so the site keeps offering the last published release (its download page says which version
the source is at). Once the release workflow has published the GitHub Release, it calls the Netlify build hook
(`NETLIFY_BUILD_HOOK`, see [Deploying to Netlify](#deploying-to-netlify)), and the deploy's `build:netlify` reads the
published versions from GitHub, npm and the Marketplace before it builds. Without the hook, the next deploy picks the
release up. Should the refresh fail during a deploy (rate limit, an API down), the deploy warns and builds from the
committed snapshots.

The committed snapshots are what `npm run build` uses offline and what a deploy falls back on. Refresh them now and then
(after a release, say) and commit them:

```sh
cd website
npm run update:releases          # GITHUB_TOKEN=… is optional (higher rate limit); never printed or saved
```

- Drafts are dropped, pre-releases are listed but never "latest", and each asset keeps its exact name, size, SHA-256
  and download URL. Only installers (`.dmg`, `.exe`, `.AppImage`, `.deb` with the release's version) are offered;
  `.blockmap`, `latest*.yml` and the Mac `.zip` update payload are not.
- `channels.json` records the latest version on GitHub, npm and the Marketplace separately, each from its own source,
  with the date it was checked. They are not assumed to be equal.
- If a source cannot be reached or answers something unexpected, nothing is written: the previous snapshots stay and
  the script exits with 1. You can save the answers yourself and import them:
  `node scripts/update-releases.mjs --import DIR` with `DIR/github.json` (the releases API list), `DIR/npm.json` (the
  registry document) and `DIR/marketplace.json` (the extensionquery answer).
- `data/signing.json` is kept by hand: for each release, how the installers were signed, with the release workflow's
  log lines as evidence. A newer release without an entry is shown as "not checked" (its versions and downloads are
  still shown). Read the macOS and Windows jobs' logs of the release run (`signing file=…`, `skipped macOS
  notarization`, `signing is skipped`) and add the entry.

Then `npm run build && npm run check && npm test`.

## The public address (SITE_URL)

The site lives at <https://agentduo.netlify.app/>, but no address is written into the code. The build takes the
public origin from `SITE_URL`, else from Netlify's `URL` (set during Netlify builds). `DEPLOY_PRIME_URL` and the preview server are never used.

- The origin must be `https://host` or `http://host` with no path, query, fragment, user name or loopback address. The
  site is built for the root of its host; serving it from a sub-folder is not supported.
- With an origin, pages get canonical URLs, `og:url`/`og:image` and `hreflang` alternates, `sitemap.xml` is written
  (without the search and 404 pages) and `robots.txt` names it.
- Without one, the build still works and every page and link is fine, but those absolute URLs and the sitemap are left
  out, and the build prints a warning. Every link the site writes is root-relative (`/docs/cli/`), so the pages work on
  any host and the 404 page works at any depth.

```sh
SITE_URL=https://agentduo.example npm run build      # your real domain
```

## Deploying to Netlify

Nothing is deployed by this repository. Two ways:

**Git integration (recommended).** In Netlify, add a site from the GitHub repository and set **Base directory** to
`website`. `website/netlify.toml` gives the build command (`npm run build:netlify`), the publish folder (`dist`) and
Node 22. Netlify sets `URL` to the site's main address (<https://agentduo.netlify.app/>), so canonical URLs and the
sitemap use it; set `SITE_URL` in the site's environment variables when you add a custom domain. No Netlify file is
needed at the repository root.

So that a release shows on the site as soon as it is published:

1. In Netlify, *Site configuration → Build & deploy → Build hooks*: add a hook for the `main` branch and copy its URL.
2. In GitHub, *Settings → Secrets and variables → Actions*: add it as the secret `NETLIFY_BUILD_HOOK`. The release
   workflow calls it after publishing; without it, it says so and the release waits for the next deploy.
3. Optional: a `GITHUB_TOKEN` environment variable in Netlify (a fine-grained token with read-only access to public
   repositories) raises GitHub's rate limit, which Netlify's shared build machines can hit.

**Drag and drop.** Build locally with the real address, then drag the `website/dist` folder onto Netlify's deploy
page (its contents become the site's root). A drag-and-drop deploy is not rebuilt by the hook: refresh the release
data first.

```sh
cd website
npm run update:releases
SITE_URL=https://agentduo.netlify.app npm run build
npm run check
```

A drag-and-drop deploy ignores `netlify.toml`, so everything the host needs is in `dist/`: `_headers` (security headers,
no third-party resources), `_redirects` (missing paths under `/vi/` get the Vietnamese 404 page with status 404) and
`404.html`. There is no catch-all rewrite: an unknown URL is a real 404, never the home page with 200.
