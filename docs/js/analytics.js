// Site analytics: self-hosted Umami at stats.viboplr.com (deploy/umami/).
//
// Cookieless and anonymous: Umami stores no IP address and sets no cookie, and
// a browser sending Do Not Track is not counted at all. Page views, referrers,
// UTM tags, country and device come from the tracker itself; this file adds
// the handful of events that tell us what the site is for — which persona
// pages lead to a download.
//
// Every page loads this one file, so adding an event means editing here, not
// 25 HTML files. Pages call window.viboplrTrack(name, data) for anything a
// click listener can't see (the install pages' automatic download).
(function () {
  // Must match WEBSITE_ID in deploy/umami/setup.sh.
  var WEBSITE_ID = "550ff719-a783-4049-b3f9-2d30c76fea8b";
  var SCRIPT = "https://stats.viboplr.com/script.js";
  // Only the real site counts: not localhost, not a preview, not a mirror.
  var HOSTS = ["viboplr.com", "www.viboplr.com"];

  var queue = [];
  function send(name, data) {
    if (window.umami && typeof window.umami.track === "function") window.umami.track(name, data);
    else queue.push([name, data]);
  }
  window.viboplrTrack = function (name, data) {
    if (HOSTS.indexOf(location.hostname) >= 0) send(name, data);
  };
  if (HOSTS.indexOf(location.hostname) < 0) return;

  var s = document.createElement("script");
  s.defer = true;
  s.src = SCRIPT;
  s.setAttribute("data-website-id", WEBSITE_ID);
  s.setAttribute("data-do-not-track", "true");
  s.onload = function () {
    var pending = queue.splice(0);
    for (var i = 0; i < pending.length; i++) send(pending[i][0], pending[i][1]);
  };
  document.head.appendChild(s);

  function fileOf(href) {
    return (href.split("#")[0].split("?")[0].split("/").pop() || "index.html").replace(/\.html$/, "");
  }

  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href");
    var page = fileOf(location.pathname);

    if (a.classList.contains("persona-card")) {
      send("persona-card", { persona: fileOf(href) });
    } else if (a.classList.contains("nav-cta")) {
      send("get-viboplr", { from: page });
    } else if (/install-(mac|windows)\.html/.test(href)) {
      send("download-choice", { platform: /mac/.test(href) ? "mac" : "windows", from: page });
    } else if (a.id === "dl-link") {
      send("download-manual", { platform: /\.dmg/i.test(a.href) ? "mac" : "windows" });
    } else if (a.host && a.host !== location.host) {
      send("outbound", { host: a.host, from: page });
    }
  }, true);
})();
