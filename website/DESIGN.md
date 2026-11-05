# Design

## Structure

Like a runtime's own website, the site has a few product pages and two reading areas:

- **Home**: what AgentDuo is, the workflow figure, the three interfaces, examples, Download and Get started.
- **Download**: every published installer as a plain link, grouped by OS and architecture, with versions per channel,
  requirements, signing status and first-launch steps. JavaScript only suggests the visitor's OS and filters; it never
  guesses an architecture the browser does not report.
- **Learn**: six tutorials in order, ending with a complete first task.
- **Docs**: sixteen topic pages in five groups (Overview, Using AgentDuo, Configure, Reference, Help).
- **About, Releases, FAQ, Search, 404.**

Learn and Docs pages share one layout: grouped sidebar with the current page marked, breadcrumb, a table of contents
(compact at the top on small screens, sticky on the right on wide ones), heading anchors, related pages, a next step
and Previous/Next. On small screens the sidebar is reachable from a "browse" link and a native `<details>` menu, so it
works without JavaScript.

## Identity

- The AgentDuo loop logo and app icon, taken from `extensions/vscode/media` and `apps/desktop/resources`.
- Two accents, one per agent: teal for Codex, orange for Claude Code, used in the workflow figure, role tables and the
  focus ring. Text and links use darker or lighter variants chosen for contrast (≥ 4.5:1 for body text in both themes).
- Cool ink neutrals, so the two agent colours are the only hues. Light: background `#f3f5f8`, surface `#ffffff`, text
  `#111a24`, secondary text `#46525f`. Dark: background `#0b1118`, surface `#141d27`, text `#eef3f8`, secondary text
  `#b3bfcb`. Text is 7:1 or more in both themes and controls' borders about 3:1 (`--control-line`). The dark theme
  separates its layers with visible borders and a top edge highlight, and its code blocks are a well darker than the
  page with a border; in the light theme they are deep ink.
- The top of each page has a texture: a faint dot grid and a light from the top, fading out before the reading text
  (over the hero on the home page, above the first section elsewhere). It scrolls away with the page, and
  `prefers-contrast: more` and forced colours turn it off. The workflow figure is the one raised surface.
- Be Vietnam Pro (400, 400 italic, 500, 600, 700; SIL Open Font License, `assets/fonts/OFL.txt`) for all text, chosen
  for its Vietnamese diacritics, and the system monospace for code. The fonts are served from the site itself, split
  into Latin, Latin Extended and Vietnamese subsets, so a page downloads only what its text uses and nothing is
  fetched from another host (`font-src 'self'`). A major-third heading scale on a 16.5px body, headings at 600–700
  and never heavier, a reading width of about 75 characters, and looser heading leading for Vietnamese.
- Home: the headline and its explanation share the first row, and the workflow figure runs the full width under them.
  Below, text sections put their heading in a column beside the text; the interfaces and the session example are
  wide and put it on top.
- The workflow figure (Plan → Critique → Finalize → Implement → Verify → Review, numbered, with the two loops back) is
  the one distinctive visual: the two stages side by side on wide screens with the handoff as the arrow between
  them, stacked on tablets, vertical on phones. Its steps light up in order once when the page loads; then a dot
  carries the work through it in a run's order (Plan, Critique, back to Plan once, Critique, Finalize, the handoff,
  Implement, Verify, Review, back to Implement once, Verify, Review, done) and starts again. The dot keeps to the
  drawn lines of each layout, passes under each step's circle, which lights while that step works, and takes the
  colour of the agent whose work it carries (`site.js` measures the route from the layout). A button in the figure's
  corner pauses it, and the pause is remembered; it does not run off screen or in a hidden tab. That is the only
  animation: `prefers-reduced-motion` keeps the figure still, with no dot and no button, as does JavaScript being
  off. No stock illustrations, no testimonial or logo walls.

## Behaviour

- Theme: System / Light / Dark, saved in `localStorage` and applied before first paint; the control appears only when
  JavaScript runs. System follows `prefers-color-scheme` live.
- Code blocks are highlighted at build time (`lib/highlight.mjs`), as classed spans, so no script runs and the CSP
  needs no inline styles: in shell and chat input the command each line runs is the strongest mark (sky blue, bold),
  then flags and variables (lilac), strings (green) and comments (grey); YAML keys, JSON, JavaScript and diffs get the
  same few colours. Teal and orange stay the agents' colours and are not used. A here-document's body, command
  output and the live view stay plain. Highlighting only wraps text: the copied text and the search index are
  unchanged, and a test checks that for every block of the site.
- Copy buttons appear only with JavaScript; they copy the code's text, announce "Copied", and select the code when the
  clipboard is refused.
- Search: a static index per language, accent-insensitive (đ matches d), with highlighted snippets. With JavaScript the
  header's search is a button that opens a search dialog (a native `<dialog>`), as does `Ctrl+K`/`⌘K` unless you are
  typing elsewhere: up to 8 results as you type, ↑/↓ to pick, Enter to open, Esc or a click outside to close (focus
  goes back where it was), and a link to all results on the search page. The index is fetched the first time the
  dialog opens, never with the page. Before you type it lists your recent searches (up to 5 per language, kept in
  `localStorage` and only for searches that opened a result or the search page, with a Clear button), and nothing
  when there are none. The page under the dialog does not scroll. Without JavaScript or `<dialog>`, the header is a
  form to the search page, which lists every page when JavaScript is off.
- The header is fixed, not sticky. With the page's `scroll-padding-top` (so a linked heading lands below it), a sticky
  header's search box sits inside the padded area, and browsers scroll the page up at every key to bring the caret
  "into view"; a fixed box is never scrolled to.
- Language switch on every page links to the same page in the other language.
