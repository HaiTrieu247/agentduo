// Progressive enhancements for every page. Without this script the site still reads and navigates: the theme
// follows the system, code can be selected by hand, the mobile menu is a native <details>, and search is a form.
(function () {
  "use strict";
  var root = document.documentElement;
  var body = document.body;
  var announcer = document.querySelector("[data-announcer]");
  var KEY = "agentduo-theme";

  function announce(text) {
    if (!announcer) return;
    announcer.textContent = "";
    window.setTimeout(function () {
      announcer.textContent = text;
    }, 30);
  }

  // ---------------------------------------------------------------- theme
  function savedTheme() {
    try {
      var t = window.localStorage.getItem(KEY);
      return t === "light" || t === "dark" ? t : "system";
    } catch (e) {
      return "system";
    }
  }

  function applyTheme(theme) {
    if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
    else root.removeAttribute("data-theme");
    try {
      if (theme === "system") window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, theme);
    } catch (e) {
      /* storage blocked: the choice lasts for this page only */
    }
  }

  var selects = document.querySelectorAll("[data-theme-select]");
  var current = savedTheme();
  selects.forEach(function (select) {
    select.value = current;
    select.addEventListener("change", function () {
      applyTheme(select.value);
      selects.forEach(function (other) {
        other.value = select.value;
      });
    });
  });
  document.querySelectorAll("[data-theme-control]").forEach(function (el) {
    el.hidden = false;
  });

  // ---------------------------------------------------------------- copy buttons
  function selectText(el) {
    var range = document.createRange();
    range.selectNodeContents(el);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function copied(button) {
    button.textContent = body.dataset.copied;
    announce(body.dataset.copied);
    window.setTimeout(function () {
      button.textContent = body.dataset.copy;
    }, 2000);
  }

  document.querySelectorAll(".code").forEach(function (block) {
    var code = block.querySelector("pre code");
    if (!code) return;
    var button = document.createElement("button");
    button.type = "button";
    button.className = "copy-button";
    button.textContent = body.dataset.copy;
    button.setAttribute("aria-label", body.dataset.copyLabel);
    button.addEventListener("click", function () {
      var text = code.textContent;
      var fail = function () {
        selectText(code);
        announce(body.dataset.copyFailed);
        button.textContent = body.dataset.copyFailed.split(":")[0];
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(function () {
          copied(button);
        }, fail);
      } else {
        fail();
      }
    });
    block.appendChild(button);
    block.classList.add("has-copy");
  });

  // ---------------------------------------------------------------- mobile menu
  var menu = document.querySelector("[data-mobile-menu]");
  if (menu) {
    var summary = menu.querySelector("summary");
    menu.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && menu.open) {
        menu.open = false;
        summary.focus();
      }
    });
    menu.addEventListener("toggle", function () {
      if (menu.open) {
        // The first control that shows: the search button once search-dialog.js runs, else the search box.
        var controls = menu.querySelectorAll(".mobile-menu-panel input, .mobile-menu-panel button, .mobile-menu-panel a");
        var first = null;
        for (var i = 0; i < controls.length && !first; i++) if (controls[i].offsetParent !== null) first = controls[i];
        if (first && window.matchMedia("(pointer: fine)").matches) first.focus();
      }
    });
    document.addEventListener("click", function (e) {
      if (menu.open && !menu.contains(e.target)) menu.open = false;
    });
  }

  // ---------------------------------------------------------------- search shortcut
  var isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  document.querySelectorAll("[data-search-shortcut]").forEach(function (el) {
    el.textContent = isMac ? "⌘K" : "Ctrl K";
    el.hidden = false;
  });
  // Without search-dialog.js (no modules, no <dialog>), the shortcut focuses the search box instead.
  document.addEventListener("keydown", function (e) {
    if (root.hasAttribute("data-search-dialog-ready")) return;
    if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    var active = document.activeElement;
    var typing = active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
    if (typing && !active.hasAttribute("data-search-input")) return;
    var inputs = Array.prototype.filter.call(document.querySelectorAll("[data-search-input]"), function (input) {
      return input.offsetParent !== null;
    });
    var target = inputs[0];
    if (!target && menu) {
      menu.open = true;
      target = menu.querySelector("[data-search-input]");
    }
    if (!target) return;
    e.preventDefault();
    target.focus();
    target.select();
  });

  // ---------------------------------------------------------------- table of contents
  var toc = document.querySelector("[data-toc]");
  if (toc && "IntersectionObserver" in window) {
    var links = {};
    toc.querySelectorAll("a").forEach(function (a) {
      links[decodeURIComponent(a.hash.slice(1))] = a;
    });
    var visible = {};
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        visible[entry.target.getAttribute("data-toc-id")] = entry.isIntersecting;
      });
      var currentId = null;
      Object.keys(links).some(function (id) {
        if (visible[id]) {
          currentId = id;
          return true;
        }
        return false;
      });
      if (!currentId) return;
      Object.keys(links).forEach(function (id) {
        links[id].classList.toggle("is-current", id === currentId);
      });
    }, { rootMargin: "-64px 0px -55% 0px" });
    Object.keys(links).forEach(function (id) {
      var heading = document.getElementById(id);
      if (!heading) return;
      var target = heading.closest("section") || heading;
      target.setAttribute("data-toc-id", id);
      observer.observe(target);
    });
  }
})();
