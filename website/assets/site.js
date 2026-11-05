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

  // ---------------------------------------------------------------- pipeline figure
  // A dot carries the work through the figure in the order a run takes it: Plan, Critique, back to Plan once,
  // Critique, Finalize, the handoff, Implement, Verify, Review, back to Implement once, Verify, Review, done; then
  // again. It passes under each step's circle, which lights while that step works, and takes the colour of the agent
  // whose work it carries. The route is measured from the figure as it is laid out (side by side, stacked or
  // vertical), so the dot keeps to the drawn lines. Reduced motion keeps the figure still; the button pauses it (and
  // the choice is remembered), and it does not run while off screen or in a hidden tab.
  var MOTION_KEY = "agentduo-flow-motion";
  var INTRO_MS = 1300; // the steps' own entrance (styles.css) is over by then
  var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
  if (reducedMotion && window.requestAnimationFrame) document.querySelectorAll(".flow").forEach(flowMotion);

  function flowMotion(fig) {
    var steps = fig.querySelectorAll(".flow-step");
    var backs = fig.querySelectorAll(".flow-back");
    var handoff = fig.querySelector(".flow-handoff");
    var done = fig.querySelector(".flow-done");
    if (steps.length !== 6 || backs.length !== 2 || !handoff || !done) return;
    var agents = Array.prototype.map.call(steps, function (step) {
      var m = /\bagent-(\w+)/.exec(step.className);
      return m ? "agent-" + m[1] : "";
    });

    var token = document.createElement("span");
    token.className = "flow-token";
    token.setAttribute("aria-hidden", "true");
    var button = document.createElement("button");
    button.type = "button";
    button.className = "flow-motion";
    fig.insertBefore(button, fig.firstChild);
    fig.appendChild(token);

    var paused = false;
    try {
      paused = window.localStorage.getItem(MOTION_KEY) === "paused";
    } catch (e) {
      /* storage blocked: it runs */
    }
    var onScreen = true;
    var route = null;
    var clock = 0;
    var last = 0;
    var raf = 0;
    var lit = null;
    var tint = "";

    function label() {
      var text = paused ? fig.dataset.play : fig.dataset.pause;
      button.setAttribute("aria-label", text);
      button.title = text;
      button.toggleAttribute("data-paused", paused);
    }

    // ---- the route: a list of stays (at a point, lighting an element) and moves (along points, at a steady pace)
    function measure() {
      var box = fig.getBoundingClientRect();
      var ox = box.left + fig.clientLeft;
      var oy = box.top + fig.clientTop;
      var pt = function (x, y) {
        return { x: x - ox, y: y - oy };
      };
      // A step's circle is its ::before: on top and centred, or (vertical steps) on the left and centred.
      var circles = Array.prototype.map.call(steps, function (step, i) {
        var r = step.getBoundingClientRect();
        var size = parseFloat(getComputedStyle(step, "::before").width) || 0;
        var other = steps[i % 3 === 2 ? i - 1 : i + 1].getBoundingClientRect();
        var p = Math.abs(other.left - r.left) < 1 ? pt(r.left + size / 2, r.top + r.height / 2) : pt(r.left + r.width / 2, r.top + size / 2);
        p.r = size / 2;
        return p;
      });
      // The way back is drawn as the box's sides and rounded bottom; where it is only text (phones) there is none.
      function loop(back) {
        var cs = getComputedStyle(back);
        var w = parseFloat(cs.borderBottomWidth) || 0;
        if (cs.borderBottomStyle === "none" || !w) return null;
        var r = back.getBoundingClientRect();
        var left = r.left + w / 2;
        var right = r.right - w / 2;
        var bottom = r.bottom - w / 2;
        var rad = Math.max(0, Math.min(parseFloat(cs.borderBottomRightRadius) || 0, r.height) - w / 2);
        var points = [pt(right, r.top)];
        for (var a = 0; a <= 6; a++) points.push(pt(right - rad + rad * Math.cos((a / 12) * Math.PI), bottom - rad + rad * Math.sin((a / 12) * Math.PI)));
        for (var b = 6; b <= 12; b++) points.push(pt(left + rad + rad * Math.cos((b / 12) * Math.PI), bottom - rad + rad * Math.sin((b / 12) * Math.PI)));
        points.push(pt(left, r.top + 2));
        return points;
      }
      // The handoff's line, when it is drawn across its whole box (side by side, or phones).
      function handoffLine() {
        var cs = getComputedStyle(handoff, "::before");
        if (cs.position !== "absolute") return null;
        var r = handoff.getBoundingClientRect();
        var x = r.left + (parseFloat(cs.left) || 0);
        var y = r.top + (parseFloat(cs.top) || 0);
        var w = parseFloat(cs.width) || 0;
        var h = parseFloat(cs.height) || 0;
        return h > w ? [pt(x + w / 2, y), pt(x + w / 2, y + h)] : [pt(x, y + h / 2), pt(x + w, y + h / 2)];
      }

      var ops = [];
      var tintNow = "";
      var stay = function (i, ms, el) {
        tintNow = agents[i];
        ops.push({ points: [circles[i]], ms: ms, el: el || steps[i], tint: tintNow });
      };
      var move = function (points, el, fade) {
        var lengths = [0];
        for (var k = 1; k < points.length; k++) lengths.push(lengths[k - 1] + Math.hypot(points[k].x - points[k - 1].x, points[k].y - points[k - 1].y));
        var length = lengths[lengths.length - 1];
        ops.push({ points: points, lengths: lengths, ms: 300 + length / 0.3, el: el || null, tint: tintNow, fade: fade });
      };
      // From one circle to another, edge to edge: under a circle the dot is hidden, so it shows the whole way.
      var hop = function (from, to, el) {
        var a = circles[from];
        var b = circles[to];
        var d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        var ux = (b.x - a.x) / d;
        var uy = (b.y - a.y) / d;
        move([{ x: a.x + ux * a.r, y: a.y + uy * a.r }, { x: b.x - ux * b.r, y: b.y - uy * b.r }], el);
      };
      var back = function (from, to, i) {
        var drawn = loop(backs[i]);
        if (drawn) move(drawn, backs[i], true);
        else hop(from, to, backs[i]);
      };
      stay(0, 1100);
      hop(0, 1);
      stay(1, 1100);
      back(1, 0, 0);
      stay(0, 800);
      hop(0, 1);
      stay(1, 800);
      hop(1, 2);
      stay(2, 1000);
      var line = handoffLine();
      if (Math.abs(circles[2].y - circles[3].y) < 2 && line && line[0].y === line[1].y) hop(2, 3, handoff);
      else if (line) move(line, handoff, true);
      else ops.push({ points: [circles[2]], ms: 900, el: handoff, tint: tintNow });
      stay(3, 1100);
      hop(3, 4);
      stay(4, 900);
      hop(4, 5);
      stay(5, 1100);
      back(5, 3, 1);
      stay(3, 800);
      hop(3, 4);
      stay(4, 700);
      hop(4, 5);
      stay(5, 900);
      ops.push({ points: [circles[5]], ms: 2400, el: done, tint: tintNow });
      var start = 0;
      ops.forEach(function (op) {
        op.start = start;
        start += op.ms;
      });
      return { ops: ops, total: start };
    }

    function along(op, f) {
      var points = op.points;
      if (points.length === 1) return points[0];
      var d = f * op.lengths[op.lengths.length - 1];
      var k = 1;
      while (k < points.length - 1 && op.lengths[k] < d) k++;
      var span = op.lengths[k] - op.lengths[k - 1] || 1;
      var g = Math.min(1, Math.max(0, (d - op.lengths[k - 1]) / span));
      return { x: points[k - 1].x + (points[k].x - points[k - 1].x) * g, y: points[k - 1].y + (points[k].y - points[k - 1].y) * g };
    }

    function light(el) {
      if (el === lit) return;
      if (lit) lit.classList.remove("is-active");
      if (el) el.classList.add("is-active");
      lit = el;
    }

    function render() {
      if (!route) route = measure();
      if (clock >= route.total) {
        clock %= route.total;
        route = measure();
      }
      var op = route.ops[0];
      for (var i = route.ops.length - 1; i >= 0; i--) {
        if (route.ops[i].start <= clock) {
          op = route.ops[i];
          break;
        }
      }
      var t = clock - op.start;
      var f = Math.min(1, t / op.ms);
      var p = along(op, 0.5 - Math.cos(Math.PI * f) / 2);
      token.style.transform = "translate(" + p.x.toFixed(1) + "px, " + p.y.toFixed(1) + "px)";
      token.style.opacity = op.fade ? String(Math.max(0, Math.min(1, t / 160, (op.ms - t) / 160))) : "1";
      if (op.tint !== tint) {
        if (tint) token.classList.remove(tint);
        if (op.tint) token.classList.add(op.tint);
        tint = op.tint;
      }
      light(op.el);
    }

    function frame(now) {
      raf = 0;
      if (!running()) return;
      raf = window.requestAnimationFrame(frame);
      if (now < INTRO_MS) return;
      // Time counts only while it runs, so a hidden tab or a pause picks up where it left off.
      clock += last ? Math.min(now - last, 100) : 0;
      last = now;
      render();
    }

    function running() {
      return !paused && onScreen && !reducedMotion.matches;
    }

    function update() {
      var still = reducedMotion.matches;
      button.hidden = still;
      token.hidden = still;
      if (still) light(null);
      if (running()) {
        if (!raf) raf = window.requestAnimationFrame(frame);
      } else {
        if (raf) window.cancelAnimationFrame(raf);
        raf = 0;
        last = 0;
      }
    }

    button.addEventListener("click", function () {
      paused = !paused;
      try {
        if (paused) window.localStorage.setItem(MOTION_KEY, "paused");
        else window.localStorage.removeItem(MOTION_KEY);
      } catch (e) {
        /* storage blocked: the choice lasts for this page only */
      }
      label();
      update();
    });
    if (reducedMotion.addEventListener) reducedMotion.addEventListener("change", update);
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        onScreen = entries[entries.length - 1].isIntersecting;
        update();
      }).observe(fig);
    }
    if ("ResizeObserver" in window) {
      new ResizeObserver(function () {
        route = null;
        // Paused, it stays where it was on the new layout.
        if (!raf && !reducedMotion.matches && (clock > 0 || paused)) render();
      }).observe(fig);
    }
    label();
    update();
  }
})();
