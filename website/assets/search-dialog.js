// The search dialog: the header's search button or Ctrl K / ⌘K opens it, results come as you type, ↑ ↓ pick one and
// Enter opens it. This language's static index is fetched the first time the dialog opens, never with the page.
// Before you type, it lists your recent searches: the ones that opened a result or the search page, kept in this
// browser only. Results are built as DOM text, never as HTML. Without JavaScript, or in a browser without <dialog>,
// the header keeps its form to the search page, and site.js handles the shortcut.
import { normalize, search, snippet } from "./search-core.js";

const LIMIT = 8;
const RECENT_MAX = 5;
const RECENT_KEY = `agentduo-recent-searches:${document.documentElement.lang}`;

const dialog = document.querySelector("[data-search-dialog]");
if (dialog && typeof dialog.showModal === "function") init(dialog);

function readRecent() {
  try {
    const items = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(items) ? items.filter((q) => typeof q === "string" && q.trim()).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function writeRecent(items) {
  try {
    if (items.length) window.localStorage.setItem(RECENT_KEY, JSON.stringify(items));
    else window.localStorage.removeItem(RECENT_KEY);
  } catch {
    /* storage blocked: nothing is remembered */
  }
}

/** The query first, without an earlier copy of it (ignoring case and accents), and at most RECENT_MAX in all. */
function remember(query) {
  const q = query.trim();
  if (!q) return;
  writeRecent([q, ...readRecent().filter((r) => normalize(r) !== normalize(q))].slice(0, RECENT_MAX));
}

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? ""));

function init(dialog) {
  const t = dialog.dataset;
  const form = dialog.querySelector("form");
  const input = dialog.querySelector("input");
  const body = dialog.querySelector("[data-search-body]");
  const list = dialog.querySelector("[data-search-options]");
  const recentHeading = dialog.querySelector("[data-search-recent]");
  const status = dialog.querySelector("[data-search-dialog-status]");
  const all = dialog.querySelector("[data-search-all]");
  let records = null;
  let loading = null;
  let failed = false;
  let options = [];
  let active = -1;
  let returnTo = null;

  // From here the button replaces the header's form, and site.js leaves the shortcut to this script.
  document.documentElement.setAttribute("data-search-dialog-ready", "");
  document.querySelectorAll("[data-search-form]").forEach((f) => {
    f.hidden = true;
  });
  document.querySelectorAll("[data-search-open]").forEach((button) => {
    button.hidden = false;
    button.addEventListener("click", open);
  });

  const searchUrl = (q) => {
    const url = new URL(form.action);
    url.searchParams.set("q", q);
    return url.pathname + url.search;
  };

  function load() {
    if (records || loading) return;
    failed = false;
    loading = fetch(t.index, { headers: { Accept: "application/json" } })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        records = data;
      }, () => {
        failed = true;
      })
      .finally(() => {
        loading = null;
        if (dialog.open) update();
      });
  }

  function open() {
    if (dialog.open) {
      input.focus();
      input.select();
      return;
    }
    // The mobile menu closes behind the dialog, so focus comes back to its button rather than to a hidden one.
    const from = document.activeElement;
    const menu = from?.closest?.("details[data-mobile-menu]");
    returnTo = menu ? menu.querySelector("summary") : from;
    if (menu) menu.open = false;
    document.documentElement.classList.add("has-dialog");
    dialog.showModal();
    input.focus();
    input.select();
    update();
    load();
  }

  // Focus goes back at once when this script closes the dialog; the "close" event, which comes a moment later, covers
  // the browser closing it itself.
  function restore() {
    document.documentElement.classList.remove("has-dialog");
    if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
    returnTo = null;
  }

  function close() {
    if (!dialog.open) return;
    dialog.close();
    restore();
  }

  dialog.addEventListener("close", restore);

  // A click on the backdrop lands on the <dialog> itself; the panel fills the rest of it.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) close();
  });
  dialog.querySelector("[data-search-close]").addEventListener("click", close);
  all.addEventListener("click", () => remember(input.value));
  dialog.querySelector("[data-search-recent-clear]").addEventListener("click", () => {
    writeRecent([]);
    update();
    input.focus();
  });

  function say(text, quiet = false) {
    status.textContent = text;
    status.classList.toggle("visually-hidden", quiet);
  }

  function setActive(i) {
    active = i;
    options.forEach((o, k) => o.el.setAttribute("aria-selected", String(k === i)));
    input.setAttribute("aria-expanded", String(options.length > 0));
    if (i < 0) {
      input.removeAttribute("aria-activedescendant");
      return;
    }
    const el = options[i].el;
    input.setAttribute("aria-activedescendant", el.id);
    // Keep the active option in view by scrolling the list only, never the page under the dialog.
    if (el.offsetTop < body.scrollTop) body.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > body.scrollTop + body.clientHeight) body.scrollTop = el.offsetTop + el.offsetHeight - body.clientHeight;
  }

  function move(step) {
    if (!options.length) return;
    const next = active < 0 ? (step > 0 ? 0 : options.length - 1) : (active + step + options.length) % options.length;
    setActive(next);
  }

  function addOption(option, build) {
    const index = options.length;
    const li = document.createElement("li");
    li.id = `search-dialog-option-${index}`;
    li.className = `search-dialog-option is-${option.kind}`;
    li.setAttribute("role", "option");
    build(li);
    li.addEventListener("mousemove", () => {
      if (active !== index) setActive(index);
    });
    list.append(li);
    options.push({ ...option, el: li });
  }

  function addResult(record, q) {
    addOption({ kind: "result", href: record.u }, (li) => {
      const a = document.createElement("a");
      a.href = record.u;
      a.tabIndex = -1;
      const title = document.createElement("span");
      title.className = "search-dialog-title";
      if (record.s) {
        const page = document.createElement("span");
        page.className = "search-dialog-page";
        page.textContent = record.p;
        title.append(page, document.createTextNode(" › "));
      }
      const name = document.createElement("strong");
      name.textContent = record.s || record.p;
      title.append(name);
      const text = document.createElement("span");
      text.className = "search-dialog-snippet";
      for (const part of snippet(record, q, 140)) {
        if (part.match) {
          const mark = document.createElement("mark");
          mark.textContent = part.text;
          text.append(mark);
        } else text.append(document.createTextNode(part.text));
      }
      a.append(title, text);
      // A plain click opens the result here; with a modifier it opens elsewhere and the dialog stays.
      a.addEventListener("click", (e) => {
        remember(q);
        if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) close();
      });
      li.append(a);
    });
  }

  function addRecent(query) {
    addOption({ kind: "recent", query }, (li) => {
      li.textContent = query;
      li.addEventListener("click", () => choose(options.findIndex((o) => o.el === li)));
    });
  }

  function update() {
    const q = input.value.trim();
    options = [];
    list.replaceChildren();
    recentHeading.hidden = true;
    all.hidden = true;
    body.scrollTop = 0;
    if (!q) {
      const recent = readRecent();
      recentHeading.hidden = recent.length === 0;
      recent.forEach(addRecent);
      say("", true);
      setActive(-1);
      return;
    }
    if (!records) {
      say(failed ? t.error : t.loading);
      setActive(-1);
      return;
    }
    const found = search(records, q);
    found.slice(0, LIMIT).forEach((r) => addResult(r, q));
    if (found.length) {
      say(fill(found.length === 1 ? t.one : t.many, { n: found.length }), true);
      all.hidden = false;
      all.href = searchUrl(q);
      all.textContent = fill(t.all, { n: found.length });
    } else say(fill(t.none, { q }));
    setActive(options.length ? 0 : -1);
  }

  /** Enter or a click: a recent search fills the box, a result opens, and with neither the search page opens. */
  function choose(i) {
    const option = options[i];
    const q = input.value.trim();
    if (option?.kind === "recent") {
      input.value = option.query;
      update();
      input.focus();
      return;
    }
    const href = option?.kind === "result" ? option.href : q ? searchUrl(q) : null;
    if (!href) return;
    remember(q);
    close();
    window.location.href = href;
  }

  input.addEventListener("input", update);
  input.addEventListener("keydown", (e) => {
    // Vietnamese and other input methods use Enter and the arrows while composing a word.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    choose(active);
  });

  document.addEventListener("keydown", (e) => {
    if ((e.key ?? "").toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    const el = document.activeElement;
    const typing = el && el !== input && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) && !el.hasAttribute("data-search-input");
    if (typing) return;
    e.preventDefault();
    open();
  });
}
