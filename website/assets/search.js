// The search page: reads ?q=, loads this language's static index once, and lists the matching sections with a
// passage around the match. Results are built as DOM text, never as HTML, so nothing in the index can inject markup.
import { search, snippet } from "./search-core.js";

const box = document.querySelector("[data-search-page]");
const form = box?.querySelector("form");
const input = box?.querySelector("input[name=q]");
const status = box?.querySelector("[data-search-status]");
const list = box?.querySelector("[data-search-results]");
let records = null;

const say = (text) => {
  status.textContent = text;
};

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, k) => values[k] ?? "");

function render(query) {
  list.replaceChildren();
  const q = query.trim();
  if (!q) {
    say(box.dataset.empty);
    return;
  }
  const found = search(records, q);
  if (!found.length) {
    say(fill(box.dataset.none, { q }));
    return;
  }
  say(fill(found.length === 1 ? box.dataset.one : box.dataset.many, { n: String(found.length), q }));
  for (const r of found) {
    const li = document.createElement("li");
    if (r.s) {
      const page = document.createElement("p");
      page.className = "result-page";
      page.textContent = r.p;
      li.append(page);
    }
    const a = document.createElement("a");
    a.href = r.u;
    a.textContent = r.s || r.p;
    li.append(a);
    const p = document.createElement("p");
    p.className = "result-snippet";
    for (const part of snippet(r, q)) {
      if (part.match) {
        const mark = document.createElement("mark");
        mark.textContent = part.text;
        p.append(mark);
      } else p.append(document.createTextNode(part.text));
    }
    li.append(p);
    list.append(li);
  }
}

async function load() {
  if (records) return records;
  const res = await fetch(box.dataset.index, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  records = await res.json();
  return records;
}

async function run(query, push) {
  if (push) {
    const url = new URL(window.location.href);
    if (query.trim()) url.searchParams.set("q", query.trim());
    else url.searchParams.delete("q");
    window.history.replaceState(null, "", url);
  }
  if (!records) say(box.dataset.loading);
  try {
    await load();
  } catch {
    say(box.dataset.error);
    box.querySelector("[data-search-fallback]").hidden = false;
    return;
  }
  render(query);
}

if (box) {
  const q = new URL(window.location.href).searchParams.get("q") ?? "";
  input.value = q;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    run(input.value, true);
  });
  let timer = 0;
  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => run(input.value, true), 180);
  });
  run(q, false);
  if (!q) input.focus();
}
