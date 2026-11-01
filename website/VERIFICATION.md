# Verification

What was checked on 2026-11-01 (macOS, Node 24.20.0), and what was not. Nothing was committed, pushed or deployed.

## Routes

30 pages per language, 60 in all. English at the root, Vietnamese under `/vi/` (same path after the prefix):

- Product: `/`, `/about/`, `/download/`, `/releases/`, `/faq/`, `/search/`, `/404.html`
- Learn: `/learn/`, `/learn/prerequisites/`, `/learn/desktop/`, `/learn/cli/`, `/learn/vscode/`, `/learn/first-task/`
- Docs: `/docs/`, `/docs/concepts/`, `/docs/conversations/`, `/docs/discuss/`, `/docs/pipeline/`,
  `/docs/decisions-resume/`, `/docs/attachments/`, `/docs/configuration/`, `/docs/permissions/`,
  `/docs/accounts-usage/`, `/docs/desktop-updates/`, `/docs/data-diagnostics/`, `/docs/cli/`,
  `/docs/slash-commands/`, `/docs/config-reference/`, `/troubleshooting/`, `/docs/contributing/`

Plus `search-index.json` and `vi/search-index.json`, `robots.txt`, `_headers`, `_redirects`, and `sitemap.xml` when
built with `SITE_URL`.

## Results

| Check | Result |
| --- | --- |
| `npm run build` (no origin, no network needed) | 60 pages; warns that SITE_URL is unset; no sitemap, no absolute SEO URLs. |
| `npm run check` | 60 pages: every local link, asset and fragment resolves; ids unique; lang, title, description, favicon, skip link, language link on each page; search indexes point at real sections and each page loads its own language's index; every installer of v0.8.2 offered, no update file offered; no 200 rewrite; robots/sitemap agree. |
| `npm test` (website, `node:test`) | 26 passed: release data (drafts dropped, pre-release never latest, installer classification, rejected answers, failed refresh keeps snapshots), search (accents, đ → d, ranking, snippets, empty), URL/SEO (SITE_URL > URL, DEPLOY_PRIME_URL ignored, bad origins rejected, with/without origin builds), both languages, root-relative 404, preview server (200, 301, 404 per language, no traversal), examples. |
| Examples | The first-task project fails `npm test` (1h 62m 05s) before the fix and passes after it, in a temporary Git repository; the tutorial's setup script recreates exactly those files; all 7 `examples/config/*.yaml` pass the config check of the repository's `duo doctor` (built `dist/cli.js`, isolated user config); a deliberately wrong gate is reported (`gates[0] needs 'name' and 'command'`). No model-calling pipeline was run. |
| `npm run browser-check` (Electron 41 and Playwright from `apps/desktop`, isolated profile) | 13 passed: no horizontal overflow at 375/768/1440 px in light and dark; System/Light/Dark persist across pages and reloads; search in English and unaccented Vietnamese with snippets and a no-result state; Ctrl/⌘+K; copy by click puts the code on the clipboard; mobile menu opens, closes with Escape and returns focus; language switch; skip link first with visible focus; long code and tables scroll in their own box at 375 px; deep missing paths answer 404 with styled pages in their language; download page suggests an OS and can show all; reduced motion; JavaScript off: content, downloads and navigation work, no theme or copy controls shown. |
| Screenshots | 40 (home, docs/configuration, download, search, 404 at three widths, both themes), looked at by hand: layout, contrast and the workflow figure are correct. |
| Root `npm run typecheck` | Passed. |
| Root `npm test` | 42 files, 530 tests passed. Desktop suites not run: no desktop source changed. |

Two problems were found and fixed during these checks: the Vietnamese search page loaded the English index (now
`/vi/search-index.json`, and `npm run check` rejects a mismatch), and the keyboard browser check started without
window focus.

## Not verified

- No deploy to Netlify was made, so `netlify.toml`, `_headers` and `_redirects` were checked by content and through the
  local preview server, not on Netlify itself.
- Browser checks ran in Electron's Chromium on macOS only: not Safari, Firefox, or real phones and tablets.
- No screen reader was used; accessibility checks are structural (landmarks, labels, focus, skip link).
- Vietnamese pages were translated from the English ones and checked for structure and parity, not proofread by a
  native speaker.
- Installers were not downloaded or installed by these checks; download links are checked against the release
  snapshot of 2026-10-31T16:32Z, not fetched.
- Statements marked in SOURCES.md as observations (the 0.8.0 → 0.8.1 notify-only update on macOS) come from the
  maintainer, not from these checks.
