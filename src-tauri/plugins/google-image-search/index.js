var SEARCH_TIMEOUT = 15000;
var SETTLE_DELAY = 3000;
var POLL_INTERVAL = 500;
var showDebugWindow = false;
var debugMode = false;
var suffixes = { artist: "musician", album: "album cover", tag: "music genre" };
var testQuery = "";
var testState = { status: "idle", steps: [], images: [] };

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

var EXTRACT_HTML_SCRIPT =
  '(function() {' +
  '  window.__viboplr.send("page-html", document.documentElement.outerHTML);' +
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

function sanitizeFilename(str) {
  return str.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 100);
}

function searchGoogleImages(api, name, entity, keepOpen) {
  var searchUrl = buildSearchUrl(name, entity);

  return api.network
    .openBrowseWindow(searchUrl, {
      visible: showDebugWindow || keepOpen,
      width: 1024,
      height: 768,
    })
    .then(function (handle) {
      return new Promise(function (resolve) {
        var settled = false;
        var finalResult = null;
        var pollTimer = null;
        var deadline = null;

        function closeAndResolve() {
          if (!keepOpen) handle.close().catch(console.error);
          resolve(finalResult);
        }

        function finish(result) {
          if (settled) return;
          settled = true;
          finalResult = result;
          if (pollTimer) clearInterval(pollTimer);
          if (deadline) clearTimeout(deadline);
          if (debugMode) {
            handle.eval(EXTRACT_HTML_SCRIPT).catch(function () { closeAndResolve(); });
          } else {
            closeAndResolve();
          }
        }

        handle.onMessage(function (msg) {
          if (msg.type === "image-result") {
            finish(msg.data);
          } else if (msg.type === "page-html" && msg.data) {
            var suffix = finalResult ? "success" : "fail";
            var filename = sanitizeFilename(name) + "-" + suffix + ".html";
            api.storage.files.writeText(["debug", filename], msg.data).catch(console.error);
            closeAndResolve();
          }
        });

        // Wait for page to settle before polling for images
        setTimeout(function () {
          pollTimer = setInterval(function () {
            handle.eval(EXTRACT_SCRIPT).catch(function () {
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
    return searchGoogleImages(api, searchName, entity, showDebugWindow)
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
  api.storage.get("showDebugWindow").then(function (val) {
    if (val != null) showDebugWindow = !!val;
    return api.storage.get("debugMode");
  }).then(function (val) {
    if (val != null) debugMode = !!val;
    return api.storage.get("suffixes");
  }).then(function (val) {
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

  api.ui.onAction("gis-toggle-debug", function (payload) {
    showDebugWindow = !!(payload && payload.value);
    api.storage.set("showDebugWindow", showDebugWindow).catch(console.error);
    renderSettings();
  });

  api.ui.onAction("gis-toggle-debug-mode", function (payload) {
    debugMode = !!(payload && payload.value);
    api.storage.set("debugMode", debugMode).catch(console.error);
    renderSettings();
  });

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

  api.ui.onAction("gis-test-query", function (data) {
    if (data && data.value !== undefined) testQuery = data.value;
  });

  api.ui.onAction("gis-test-search", runTestSearch);

  renderSettings();

  // --- Test ---

  function runTestSearch() {
    var query = testQuery.trim();
    if (!query) {
      testState = { status: "done", steps: ["Enter a search query."], images: [] };
      renderSettings();
      return;
    }

    var searchUrl = "https://www.google.com/search?udm=2&q=" + encodeURIComponent(query);
    var steps = [
      "Query: <b>" + query + "</b>",
      "URL: <code style=\"font-size:var(--fs-2xs);word-break:break-all\">" + searchUrl + "</code>",
      "Opening Google Images window" + (showDebugWindow ? " (visible)..." : " (hidden)..."),
    ];
    testState = { status: "searching", steps: steps, images: [] };
    renderSettings();

    api.network
      .openBrowseWindow(searchUrl, { visible: true, width: 1024, height: 768 })
      .then(function (handle) {
        return new Promise(function (resolve) {
          var settled = false;
          var pollTimer = null;
          var deadline = null;

          function finish(results) {
            if (settled) return;
            settled = true;
            if (pollTimer) clearInterval(pollTimer);
            if (deadline) clearTimeout(deadline);
            handle.close().catch(console.error);
            resolve(results);
          }

          handle.onMessage(function (msg) {
            if (msg.type === "image-results") {
              finish(msg.data || []);
            }
          });

          // Wait for page to settle before polling for images
          setTimeout(function () {
            pollTimer = setInterval(function () {
              handle.eval(EXTRACT_ALL_SCRIPT).catch(function () {
                finish([]);
              });
            }, POLL_INTERVAL);
          }, SETTLE_DELAY);

          deadline = setTimeout(function () {
            finish([]);
          }, SEARCH_TIMEOUT);
        });
      })
      .then(function (results) {
        if (!results || results.length === 0) {
          steps.push("No images found — page may not have loaded or no data:image imgs matched.");
          testState = { status: "done", steps: steps, images: [] };
          renderSettings();
          return;
        }

        steps.push("Found <b>" + results.length + "</b> image(s)");
        testState = { status: "done", steps: steps, images: results };
        renderSettings();
      })
      .catch(function (e) {
        console.error("Test search failed:", e);
        steps.push("Error: " + e);
        testState = { status: "done", steps: steps, images: [] };
        renderSettings();
      });
  }

  // --- Render ---

  function renderSettings() {
    var busy = testState.status === "searching";

    var testRows = [
      {
        type: "layout", direction: "horizontal", style: { gap: "8px", "align-items": "center" },
        children: [
          { type: "text-input", placeholder: "Search query (e.g. rock music genre)", action: "gis-test-query", value: testQuery, style: { flex: "1" } },
          { type: "button", label: busy ? "Searching..." : "Test", action: "gis-test-search", disabled: busy, variant: "accent", style: { padding: "3px 14px" } },
        ],
      },
    ];

    if (testState.steps.length > 0) {
      var log = testState.steps.map(function (s) {
        return "<p style=\"margin:2px 0;font-size:var(--fs-xs)\">" + s + "</p>";
      }).join("");
      testRows.push({ type: "text", content: log });
    }

    if (testState.images.length > 0) {
      var gallery = testState.images.map(function (img, i) {
        return "<div style=\"display:inline-block;margin:4px;text-align:center\">" +
          "<img src=\"" + img.src + "\" style=\"max-width:140px;max-height:140px;border-radius:var(--ds-radius-card);border:1px solid var(--border)\" />" +
          "<div style=\"font-size:var(--fs-2xs);color:var(--text-secondary);margin-top:2px\">" + img.w + "×" + img.h + "</div>" +
          "</div>";
      }).join("");
      testRows.push({
        type: "text",
        content: "<div style=\"margin-top:8px;display:flex;flex-wrap:wrap;gap:4px\">" + gallery + "</div>",
      });
    }

    api.ui.setViewData("google-image-search-settings", {
      type: "layout",
      direction: "vertical",
      children: [
        {
          type: "section",
          title: "Test",
          children: testRows,
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
        },
        {
          type: "section",
          title: "Options",
          children: [
            {
              type: "toggle",
              label: "Always show scraping window",
              checked: showDebugWindow,
              action: "gis-toggle-debug",
            },
            {
              type: "toggle",
              label: "Debug mode (save HTML pages)",
              checked: debugMode,
              action: "gis-toggle-debug-mode",
            }
          ]
        }
      ]
    });
  }
}

function deactivate() {
  showDebugWindow = false;
  debugMode = false;
  suffixes = { artist: "musician", album: "album cover", tag: "music genre" };
  testQuery = "";
  testState = { status: "idle", steps: [], images: [] };
}

return { activate: activate, deactivate: deactivate };
