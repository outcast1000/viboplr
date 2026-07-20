var SEARCH_TIMEOUT = 15000;
var CAPTCHA_TIMEOUT = 180000; // 3 minutes once user is solving
var SETTLE_DELAY = 3000;
var POLL_INTERVAL = 500;
// Anti-captcha tuning. Google throws its "unusual traffic" wall when a fresh
// cookie jar hits a search deep-link, or when searches arrive in a burst. We
// (1) warm up a real browsing session once per app run, (2) auto-dismiss the
// GDPR consent wall so it never reaches the user, and (3) serialize searches
// with a small gap so a library scan doesn't read like a bot.
var WARMUP_URL = "https://www.google.com/ncr"; // ncr = no country redirect
var WARMUP_SETTLE = 2500;
var WARMUP_TIMEOUT = 12000;
var CONSENT_EXTEND = 10000; // give the page time to redirect after auto-consent
var MIN_GAP = 700;          // floor between consecutive Google page loads (ms)
var GAP_JITTER = 900;       // + random 0..GAP_JITTER, so the cadence isn't robotic
var suffixes = { artist: "musician", album: "album cover", tag: "music genre" };

// Probes the page for a consent wall, a captcha, or a usable image result.
// Sends one message per poll: "consent", "captcha", "image-result", or "none".
// Consent (GDPR) and captcha (reCAPTCHA) are distinct: consent is dismissible
// in JS without a human; only a real captcha gets surfaced to the user.
var PROBE_SCRIPT =
  '(function() {' +
  '  try {' +
  '    var url = location.href || "";' +
  '    var body = (document.body && document.body.innerText) || "";' +
  '    var isConsent = url.indexOf("consent.google.com") !== -1' +
  '      || !!document.getElementById("L2AGLb") || !!document.getElementById("W0wltc")' +
  '      || /before you continue/i.test(body);' +
  '    if (isConsent) { window.__viboplr.send("consent", { url: url }); return; }' +
  '    var isCaptcha = url.indexOf("/sorry/") !== -1' +
  '      || !!document.querySelector("form#captcha-form, iframe[src*=\\"recaptcha\\"], iframe[src*=\\"/sorry/\\"], #recaptcha")' +
  '      || /unusual traffic|automated queries/i.test(body);' +
  '    if (isCaptcha) { window.__viboplr.send("captcha", { url: url }); return; }' +
  '    var imgs = document.querySelectorAll("img");' +
  '    for (var i = 0; i < imgs.length; i++) {' +
  '      var src = imgs[i].src || "";' +
  '      if (src.indexOf("data:image") !== 0) continue;' +
  '      var w = imgs[i].naturalWidth || imgs[i].width || 0;' +
  '      var h = imgs[i].naturalHeight || imgs[i].height || 0;' +
  '      if (w < 150 || h < 150) continue;' +
  '      window.__viboplr.send("image-result", { src: src, w: w, h: h });' +
  '      return;' +
  '    }' +
  '    window.__viboplr.send("none", null);' +
  '  } catch (e) {' +
  '    window.__viboplr.send("none", null);' +
  '  }' +
  '})();';

// Injects a top banner explaining why the window appeared and what to do.
// Idempotent: re-running it just updates the existing banner.
var BANNER_SCRIPT =
  '(function() {' +
  '  var ID = "__viboplr_captcha_banner";' +
  '  var existing = document.getElementById(ID);' +
  '  if (existing) return;' +
  '  var bar = document.createElement("div");' +
  '  bar.id = ID;' +
  '  bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
  '    background:#1a73e8;color:#fff;font-family:-apple-system,system-ui,sans-serif;' +
  '    padding:12px 16px;font-size:14px;line-height:1.4;box-shadow:0 2px 6px rgba(0,0,0,.25);";' +
  '  bar.innerHTML = "<b>Viboplr — Google asked us to verify you\'re human.</b>' +
  '    <br/>Please complete the check below. This window will close automatically' +
  '    once Google lets the search through. You usually only need to do this once.";' +
  '  document.documentElement.appendChild(bar);' +
  '  document.body && (document.body.style.paddingTop = (bar.offsetHeight + 8) + "px");' +
  '})();';

// Finds the first <img> with a data:image src that meets minimum size
var EXTRACT_SCRIPT =
  '(function() {' +
  '  var imgs = document.querySelectorAll("img");' +
  '  for (var i = 0; i < imgs.length; i++) {' +
  '    var src = imgs[i].src || "";' +
  '    if (src.indexOf("data:image") !== 0) continue;' +
  '    var w = imgs[i].naturalWidth || imgs[i].width || 0;' +
  '    var h = imgs[i].naturalHeight || imgs[i].height || 0;' +
  '    if (w < 150 || h < 150) continue;' +
  '    window.__viboplr.send("image-result", { src: src, w: w, h: h });' +
  '    return;' +
  '  }' +
  '  window.__viboplr.send("image-result", null);' +
  '})();';

// Collects all qualifying images for the test/debug view
var EXTRACT_ALL_SCRIPT =
  '(function() {' +
  '  var results = [];' +
  '  var imgs = document.querySelectorAll("img");' +
  '  for (var i = 0; i < imgs.length; i++) {' +
  '    var src = imgs[i].src || "";' +
  '    if (src.indexOf("data:image") !== 0) continue;' +
  '    var w = imgs[i].naturalWidth || imgs[i].width || 0;' +
  '    var h = imgs[i].naturalHeight || imgs[i].height || 0;' +
  '    if (w < 150 || h < 150) continue;' +
  '    results.push({ src: src, w: w, h: h });' +
  '  }' +
  '  window.__viboplr.send("image-results", results);' +
  '})();';

function buildSearchUrl(name, entity) {
  var suffix = (suffixes[entity] || "").trim();
  var q = suffix ? name + " " + suffix : name;
  return "https://www.google.com/search?udm=2&q=" + encodeURIComponent(q);
}

function stripDataUriPrefix(dataUri) {
  var idx = dataUri.indexOf(",");
  if (idx === -1) return dataUri;
  return dataUri.substring(idx + 1);
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Clicks past Google's GDPR consent interstitial. Reject-all is preferred
// (privacy) but either button sets the SOCS cookie and lets the search through.
var CONSENT_DISMISS_SCRIPT =
  '(function() {' +
  '  try {' +
  '    var ids = ["W0wltc", "L2AGLb"];' + // Reject all, then Accept all
  '    for (var i = 0; i < ids.length; i++) {' +
  '      var b = document.getElementById(ids[i]);' +
  '      if (b) { b.click(); window.__viboplr.send("consent-clicked", { id: ids[i] }); return; }' +
  '    }' +
  '    var re = /^(reject all|accept all|i agree|agree|accept the use of cookies)$/i;' +
  '    var btns = document.querySelectorAll("button, input[type=submit], [role=button]");' +
  '    for (var j = 0; j < btns.length; j++) {' +
  '      var t = ((btns[j].innerText || btns[j].value || "") + "").trim();' +
  '      if (re.test(t)) { btns[j].click(); window.__viboplr.send("consent-clicked", { text: t }); return; }' +
  '    }' +
  '    window.__viboplr.send("consent-none", null);' +
  '  } catch (e) { window.__viboplr.send("consent-none", null); }' +
  '})();';

// Warm up a real Google session ONCE per app run: load the homepage (not a
// search), accept/reject the consent wall, and let cookies (NID/SOCS/CONSENT)
// settle into the shared WKWebView store. Later search windows inherit them, so
// the first *search* no longer looks like a cold, cookie-less bot hit — which
// is what triggers the "verify you're human" wall in the first place.
var warmupPromise = null;
function ensureWarmedUp(api) {
  if (warmupPromise) return warmupPromise;
  warmupPromise = new Promise(function (resolve) {
    api.network
      .openBrowseWindow(WARMUP_URL, {
        visible: false,
        title: "Viboplr — Google verification",
        width: 1024,
        height: 768,
      })
      .then(function (handle) {
        var done = false;
        var settleTimer = null;
        var deadline = null;
        function finish() {
          if (done) return;
          done = true;
          if (settleTimer) clearTimeout(settleTimer);
          if (deadline) clearTimeout(deadline);
          handle.close().catch(console.error);
          resolve();
        }
        handle.onMessage(function (msg) {
          // Consent handled — give the redirect a moment, then we're warm.
          if (msg.type === "consent-clicked") setTimeout(finish, 1200);
        });
        settleTimer = setTimeout(function () {
          // Whether or not a consent wall is present, cookies are seeded by now.
          handle.eval(CONSENT_DISMISS_SCRIPT).catch(console.error);
          setTimeout(finish, 2000);
        }, WARMUP_SETTLE);
        deadline = setTimeout(finish, WARMUP_TIMEOUT);
      })
      .catch(function (e) {
        api.log("warn", "Google warm-up failed: " + e);
        resolve(); // Never block searches on a warm-up failure.
      });
  });
  return warmupPromise;
}

// Serialize every Google search and space them out. Bursts of concurrent
// searches are the fastest way to trip the abuse wall; one-at-a-time with a
// jittered gap reads as human. (Google is the last-resort image provider, so
// serial resolution is an acceptable trade for not getting captcha-walled.) A
// search showing a captcha holds the chain until the user clears it, so no
// other window pops in the meantime.
var searchChain = Promise.resolve();
var lastLoadAt = 0;
function noop() {}

function searchGoogleImages(api, name, entity) {
  var run = searchChain.then(function () {
    return ensureWarmedUp(api).then(function () {
      var now = Date.now();
      var wait = Math.max(0, lastLoadAt + MIN_GAP + Math.random() * GAP_JITTER - now);
      return delay(wait).then(function () {
        lastLoadAt = Date.now();
        return runOneSearch(api, name, entity);
      });
    });
  });
  // Keep the chain alive even if this search rejects.
  searchChain = run.then(noop, noop);
  return run;
}

function runOneSearch(api, name, entity) {
  var searchUrl = buildSearchUrl(name, entity);
  return api.network
    .openBrowseWindow(searchUrl, {
      visible: false,
      title: "Viboplr — Google verification",
      width: 1024,
      height: 768,
    })
    .then(function (handle) {
      return new Promise(function (resolve) {
        var settled = false;
        var pollTimer = null;
        var deadline = null;
        var captchaShown = false;
        var consentClicked = false;

        function finish(result) {
          if (settled) return;
          settled = true;
          if (pollTimer) clearInterval(pollTimer);
          if (deadline) clearTimeout(deadline);
          handle.close().catch(console.error);
          resolve(result);
        }

        function extendDeadline(ms) {
          if (deadline) clearTimeout(deadline);
          deadline = setTimeout(function () { finish(null); }, ms);
        }

        handle.onMessage(function (msg) {
          if (msg.type === "image-result") {
            finish(msg.data);
          } else if (msg.type === "consent" && !consentClicked) {
            // GDPR wall — dismiss it silently and keep polling. Never surfaced.
            consentClicked = true;
            handle.eval(CONSENT_DISMISS_SCRIPT).catch(console.error);
            extendDeadline(CONSENT_EXTEND);
          } else if (msg.type === "captcha" && !captchaShown) {
            // Genuine reCAPTCHA — only a human can clear it. Surface the window.
            captchaShown = true;
            api.log("info", "Google asked for captcha verification; surfacing browse window");
            handle.eval(BANNER_SCRIPT).catch(console.error);
            handle.show().catch(console.error);
            extendDeadline(CAPTCHA_TIMEOUT);
          }
        });

        // Wait for page to settle before polling
        setTimeout(function () {
          pollTimer = setInterval(function () {
            handle.eval(PROBE_SCRIPT).catch(function () {
              finish(null);
            });
          }, POLL_INTERVAL);
        }, SETTLE_DELAY);

        deadline = setTimeout(function () {
          finish(null);
        }, SEARCH_TIMEOUT);
      });
    });
}

function handleImageFetch(api, entity) {
  return function (name, artistName) {
    var searchName = name;
    if (entity === "album" && artistName) {
      searchName = artistName + " " + name;
    }
    return searchGoogleImages(api, searchName, entity)
      .then(function (result) {
        if (!result || !result.src) {
          return { status: "not_found" };
        }
        return { status: "ok", data: stripDataUriPrefix(result.src) };
      })
      .catch(function (e) {
        api.log("warn", "Google image search failed for " + entity + ": " + e);
        return { status: "error", message: String(e) };
      });
  };
}

function activate(api) {
  // Step-by-step debugger state
  var dbgTest = {
    status: "idle", // idle | searching | done
    handle: null,
    query: "",
    entity: "artist",
    images: [],
  };

  api.storage.get("suffixes").then(function (val) {
    if (val != null && typeof val === "object") {
      if (val.artist !== undefined) suffixes.artist = String(val.artist);
      if (val.album !== undefined) suffixes.album = String(val.album);
      if (val.tag !== undefined) suffixes.tag = String(val.tag);
    }
    renderSettings();
  }).catch(console.error);

  api.imageProviders.onFetch("artist", handleImageFetch(api, "artist"));
  api.imageProviders.onFetch("album", handleImageFetch(api, "album"));
  api.imageProviders.onFetch("tag", handleImageFetch(api, "tag"));

  // --- Settings actions ---

  api.ui.onAction("gis-suffix-artist", function (data) {
    if (data && data.value !== undefined) {
      suffixes.artist = data.value;
      api.storage.set("suffixes", suffixes).catch(console.error);
    }
  });

  api.ui.onAction("gis-suffix-album", function (data) {
    if (data && data.value !== undefined) {
      suffixes.album = data.value;
      api.storage.set("suffixes", suffixes).catch(console.error);
    }
  });

  api.ui.onAction("gis-suffix-tag", function (data) {
    if (data && data.value !== undefined) {
      suffixes.tag = data.value;
      api.storage.set("suffixes", suffixes).catch(console.error);
    }
  });

  // --- Step-by-step debugger ---

  api.ui.onAction("gis-dbg-query", function (data) {
    if (data && data.value !== undefined) dbgTest.query = data.value;
  });

  api.ui.onAction("gis-dbg-entity", function (data) {
    if (data && data.value !== undefined) {
      dbgTest.entity = data.value;
      renderSettings();
    }
  });

  api.ui.onAction("gis-dbg-start", function () {
    dbgStart();
  });

  api.ui.onAction("gis-dbg-stop", function () {
    dbgStop();
  });

  api.ui.onAction("gis-dbg-devtools", function () {
    if (dbgTest.handle && dbgTest.handle.devtools) {
      dbgTest.handle.devtools().catch(console.error);
    }
  });

  function dbgStart() {
    var query = dbgTest.query.trim();
    if (!query) return;

    var searchUrl = buildSearchUrl(query, dbgTest.entity);
    dbgTest.status = "searching";
    dbgTest.images = [];
    renderSettings();

    api.network.openBrowseWindow(searchUrl, {
      visible: true,
      title: "Google Images Debug",
      width: 1024,
      height: 768,
    }).then(function (handle) {
      dbgTest.handle = handle;
      renderSettings();

      var settled = false;
      var pollTimer = null;
      var deadline = null;

      function finish(results) {
        if (settled) return;
        settled = true;
        if (pollTimer) clearInterval(pollTimer);
        if (deadline) clearTimeout(deadline);
        dbgTest.images = results || [];
        dbgTest.status = "done";
        renderSettings();
      }

      handle.onMessage(function (msg) {
        if (msg.type === "image-results") {
          finish(msg.data || []);
        }
      });

      setTimeout(function () {
        pollTimer = setInterval(function () {
          handle.eval(EXTRACT_ALL_SCRIPT).catch(function () {});
        }, POLL_INTERVAL);
      }, SETTLE_DELAY);

      deadline = setTimeout(function () { finish([]); }, SEARCH_TIMEOUT);
    }).catch(function (e) {
      console.error("Debugger failed:", e);
      dbgTest.status = "idle";
      renderSettings();
    });
  }

  function dbgStop() {
    if (dbgTest.handle) {
      dbgTest.handle.close().catch(console.error);
      dbgTest.handle = null;
    }
    dbgTest.status = "idle";
    dbgTest.images = [];
    renderSettings();
  }

  // --- Render ---

  function renderSettings() {
    var idle = dbgTest.status === "idle";
    var searching = dbgTest.status === "searching";
    var done = dbgTest.status === "done";
    var hasHandle = !!dbgTest.handle;

    // Debugger section
    var dbgChildren = [];

    var buttons = [];
    if (idle || done) {
      buttons.push({ type: "button", label: "Start", action: "gis-dbg-start", variant: "accent", style: { padding: "3px 14px" } });
    }
    if (!idle) {
      buttons.push({ type: "button", label: "Reset", action: "gis-dbg-stop", variant: "secondary", style: { padding: "3px 10px" } });
    }
    if (hasHandle) {
      buttons.push({ type: "button", label: "DevTools", action: "gis-dbg-devtools", variant: "secondary", style: { padding: "3px 10px" } });
    }

    dbgChildren.push({
      type: "layout", direction: "horizontal", style: { gap: "8px", "align-items": "center" },
      children: [
        { type: "text-input", placeholder: "Search query (e.g. Radiohead)", action: "gis-dbg-query", value: dbgTest.query, style: { flex: "1" }, disabled: searching },
        { type: "select", options: [
          { value: "artist", label: "Artist" },
          { value: "album", label: "Album" },
          { value: "tag", label: "Tag" },
        ], value: dbgTest.entity, action: "gis-dbg-entity" },
      ].concat(buttons),
    });

    if (searching) {
      dbgChildren.push({ type: "text", content: "<p style=\"font-size:var(--fs-xs)\">Searching Google Images (visible window)...</p>" });
    }

    if (done) {
      if (dbgTest.images.length === 0) {
        dbgChildren.push({ type: "text", content: "<p style=\"font-size:var(--fs-xs);color:var(--error)\">No images found — page may not have loaded or no data:image imgs >= 150px matched.</p>" });
      } else {
        dbgChildren.push({ type: "text", content: "<p style=\"font-size:var(--fs-xs);color:var(--success)\"><b>Found " + dbgTest.images.length + " image(s)</b></p>" });
        var gallery = dbgTest.images.map(function (img) {
          return "<div style=\"display:inline-block;margin:4px;text-align:center\">" +
            "<img src=\"" + img.src + "\" style=\"max-width:160px;max-height:160px;border-radius:var(--ds-radius-card);border:1px solid var(--border)\" />" +
            "<div style=\"font-size:var(--fs-2xs);color:var(--text-secondary);margin-top:2px\">" + img.w + "×" + img.h + "</div>" +
            "</div>";
        }).join("");
        dbgChildren.push({ type: "text", content: "<div style=\"margin-top:8px;display:flex;flex-wrap:wrap;gap:4px\">" + gallery + "</div>" });
      }
    }

    api.ui.setViewData("google-image-search-settings", {
      type: "layout",
      direction: "vertical",
      children: [
        {
          type: "section",
          title: "Step-by-Step Debugger",
          children: dbgChildren,
        },
        {
          type: "section",
          title: "Search Suffixes",
          children: [
            {
              type: "settings-row",
              label: "Artist suffix",
              description: "Appended to artist name (e.g. \"Radiohead musician\")",
              control: { type: "text-input", placeholder: "musician", action: "gis-suffix-artist", value: suffixes.artist }
            },
            {
              type: "settings-row",
              label: "Album suffix",
              description: "Appended to album title (e.g. \"OK Computer album cover\")",
              control: { type: "text-input", placeholder: "album cover", action: "gis-suffix-album", value: suffixes.album }
            },
            {
              type: "settings-row",
              label: "Tag suffix",
              description: "Appended to tag name (e.g. \"rock music genre\")",
              control: { type: "text-input", placeholder: "music genre", action: "gis-suffix-tag", value: suffixes.tag }
            }
          ]
        }
      ]
    });
  }
}

function deactivate() {
  suffixes = { artist: "musician", album: "album cover", tag: "music genre" };
}

return { activate: activate, deactivate: deactivate };
