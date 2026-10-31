export default ({ link, p, ul }, d) => ({
  title: "Page not found",
  description: "This address has no page on the AgentDuo website. Find what you were looking for from the home page, the documentation, the downloads or search.",
  noToc: true,
  lead: p("There is no page at this address. It may have moved, or the link may have a typo."),
  top: `<form class="search-page-form" role="search" action="/search/" method="get">
<label class="visually-hidden" for="not-found-search">Search the site</label>
<input id="not-found-search" type="search" name="q" autocomplete="off" placeholder="Search the documentation" data-search-input>
<button type="submit">Search</button>
</form>`,
  sections: [
    {
      id: "where-to-go",
      title: "Where to go from here",
      html: ul([
        `${link("home", "Home")}: what AgentDuo is and how it works.`,
        `${link("docs", d.titles?.docs ?? "Documentation")}: every topic, from conversations to the configuration reference.`,
        `${link("learn", d.titles?.learn ?? "Learn")}: install AgentDuo and run your first task.`,
        `${link("download", "Download")}: the desktop app, the ${"<code>duo</code>"} command and the VS Code extension.`,
        `${link("troubleshooting", "Troubleshooting")}: fixes for common problems.`,
      ]),
    },
    {
      id: "report",
      title: "Report a broken link",
      html: p(`If a link on this site brought you here, please <a href="${d.site.links.newIssue}" rel="noopener">open an issue</a> with the page you came from.`),
    },
  ],
});
