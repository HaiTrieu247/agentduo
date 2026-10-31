// Runs in <head> before the page is painted: applies the theme saved by site.js ("light" or "dark"); with none, or
// "system", the stylesheet follows the system setting. Storage can be blocked, so every access is guarded.
(function () {
  try {
    var theme = window.localStorage.getItem("agentduo-theme");
    if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
  } catch (e) {
    /* storage blocked: follow the system */
  }
})();
