var SEARCH_TIMEOUT = 15000;
var SETTLE_DELAY = 3000;
var POLL_INTERVAL = 500;
var suffixes = { artist: "musician", album: "album cover", tag: "music genre" };

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

function searchGoogleImages(api, name, entity) {
  var searchUrl = buildSearchUrl(name, entity);

  return api.network
    .openBrowseWindow(searchUrl, {
      visible: false,
      width: 1024,
      height: 768,
    })
    .then(function (handle) {
      return new Promise(function (resolve) {
        var settled = false;
        var pollTimer = null;
        var deadline = null;

        function finish(result) {
          if (settled) return;
          settled = true;
          if (pollTimer) clearInterval(pollTimer);
          if (deadline) clearTimeout(deadline);
          handle.close().catch(console.error);
          resolve(result);
        }

        handle.onMessage(function (msg) {
          if (msg.type === "image-result") {
            finish(msg.data);
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
