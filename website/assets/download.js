// The download page's system picker. Without it every system's installers show, one after another. With it, the
// page suggests the visitor's operating system (never the architecture: browsers do not say it reliably), and the
// buttons switch between systems or show them all. Every installer stays a plain link either way.
(function () {
  "use strict";
  var picker = document.querySelector("[data-os-picker]");
  if (!picker) return;
  var panels = document.querySelectorAll("[data-os-panel]");
  var buttons = picker.querySelectorAll("button[data-os]");
  var suggestion = picker.querySelector("[data-os-suggestion]");

  function detect() {
    var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    var ua = navigator.userAgent || "";
    if (/android|iphone|ipad|ipod/i.test(ua)) return null;
    if (/mac/i.test(platform) || /Macintosh/.test(ua)) return "mac";
    if (/win/i.test(platform) || /Windows/.test(ua)) return "windows";
    if (/linux|x11/i.test(platform) || /Linux|X11/.test(ua)) return "linux";
    return null;
  }

  function show(os) {
    panels.forEach(function (panel) {
      panel.hidden = os !== "all" && panel.getAttribute("data-os-panel") !== os;
    });
    buttons.forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-os") === os));
    });
  }

  buttons.forEach(function (b) {
    b.addEventListener("click", function () {
      show(b.getAttribute("data-os"));
    });
  });

  var os = detect();
  if (os && document.querySelector('[data-os-panel="' + os + '"]')) {
    var name = picker.querySelector('button[data-os="' + os + '"]').textContent;
    suggestion.textContent = suggestion.getAttribute("data-template").replace("{os}", name);
    suggestion.hidden = false;
    show(os);
  } else {
    show("all");
  }
  picker.hidden = false;
})();
