import { SECTIONS } from "../../navigation.mjs";

export default ({ link, p, esc }, d) => {
  const groups = Object.entries(SECTIONS).flatMap(([, gs]) => gs);
  const LABELS = { start: "Learn", overview: "Overview", using: "Using AgentDuo", configure: "Configure", reference: "Reference", help: "Help" };
  return {
    title: "Search",
    description: "Search the AgentDuo documentation, tutorials and product pages by title and content, in English. Works on this site’s own index, with no search service.",
    noToc: true,
    top: `<div class="search-page" data-search-page data-index="/search-index.json"
 data-empty="Type a word or two, for example pipeline, gates or resume."
 data-loading="Loading the search index…"
 data-none="Nothing matches “{q}”. Try fewer or other words, or browse the pages below."
 data-one="1 result for “{q}”"
 data-many="{n} results for “{q}”"
 data-error="The search index could not be loaded. Browse the pages below instead.">
<form class="search-page-form" role="search" action="/search/" method="get">
<label class="visually-hidden" for="search-page-input">Search the site</label>
<input id="search-page-input" type="search" name="q" autocomplete="off" spellcheck="false" data-search-input>
<button type="submit">Search</button>
</form>
<p class="search-status" role="status" data-search-status></p>
<ol class="search-results" data-search-results></ol>
<noscript><p>Search needs JavaScript, which is off in this browser. Every page is listed below.</p></noscript>
<div data-search-fallback hidden><p>Every page is listed below.</p></div>
</div>`,
    sections: [
      {
        id: "browse",
        title: "Browse instead",
        html: `${groups.map((g) => `<h3>${esc(LABELS[g.key])}</h3><ul>${g.pages.map((id) => `<li>${link(id, d.titles?.[id] ?? id)}</li>`).join("")}</ul>`).join("")}
<h3>Product</h3><ul><li>${link("home", "Home")}</li><li>${link("about", "About AgentDuo")}</li><li>${link("download", "Download AgentDuo")}</li><li>${link("releases", "Releases")}</li><li>${link("faq", "Frequently asked questions")}</li></ul>`,
      },
    ],
    scripts: ["search.js"],
  };
};
