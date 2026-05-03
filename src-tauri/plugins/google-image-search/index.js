var SEARCH_TIMEOUT = 15000;
var POLL_INTERVAL = 500;
var showDebugWindow = false;
var testTag = "";
var testState = { status: "idle", steps: [], imageUrl: null };

// Finds the first <img> with a data:image src that meets minimum size
var EXTRACT_SCRIPT =
  '(function() {' +
  '  var imgs = document.querySelectorAll("img");' +
  '  for (var i = 0; i < imgs.length; i++) {' +
  '    var src = imgs[i].src || "";' +
  '    if (src.indexOf("data:image") !== 0) continue;' +
  '    var w = imgs[i].naturalWidth || imgs[i].width || 0;' +
  '    var h = imgs[i].naturalHeight || imgs[i].height || 0;' +
  '    if (w < 80 || h < 80) continue;' +
  '    window.__viboplr.send("image-result", { src: src, w: w, h: h });' +
  '    return;' +
  '  }' +
  '  window.__viboplr.send("image-result", null);' +
  '})();';

function buildSearchUrl(tagName) {
  return "https://www.google.com/search?udm=2&q=" +
    encodeURIComponent(tagName + " music genre");
}

function stripDataUriPrefix(dataUri) {
  var idx = dataUri.indexOf(",");
  if (idx === -1) return dataUri;
  return dataUri.substring(idx + 1);
}

function searchGoogleImages(api, tagName, keepOpen) {
  var searchUrl = buildSearchUrl(tagName);

  return api.network
    .openBrowseWindow(searchUrl, {
      visible: showDebugWindow || keepOpen,
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
          if (!keepOpen) {
            handle.close().catch(console.error);
          }
          resolve(result);
        }

        handle.onMessage(function (msg) {
          if (msg.type === "image-result") {
            finish(msg.data);
          }
        });

        pollTimer = setInterval(function () {
          handle.eval(EXTRACT_SCRIPT).catch(function () {
            finish(null);
          });
        }, POLL_INTERVAL);

        deadline = setTimeout(function () {
          finish(null);
        }, SEARCH_TIMEOUT);
      });
    });
}

function activate(api) {
  api.storage.get("showDebugWindow").then(function (val) {
    if (val != null) showDebugWindow = !!val;
    renderSettings();
  }).catch(console.error);

  api.imageProviders.onFetch("tag", function (tagName) {
    return searchGoogleImages(api, tagName, showDebugWindow)
      .then(function (result) {
        if (!result || !result.src) {
          return { status: "not_found" };
        }
        return { status: "ok", data: stripDataUriPrefix(result.src) };
      })
      .catch(function (e) {
        api.log("warn", "Google image search failed: " + e);
        return { status: "error", message: String(e) };
      });
  });

  // --- Settings actions ---

  api.ui.onAction("gis-toggle-debug", function (payload) {
    showDebugWindow = !!(payload && payload.value);
    api.storage.set("showDebugWindow", showDebugWindow).catch(console.error);
    renderSettings();
  });

  api.ui.onAction("gis-test-tag", function (data) {
    if (data && data.value !== undefined) testTag = data.value;
  });

  api.ui.onAction("gis-test-search", runTestSearch);

  renderSettings();

  // --- Test ---

  function runTestSearch() {
    var tag = testTag.trim();
    if (!tag) {
      testState = { status: "done", steps: ["Enter a tag name."], imageUrl: null };
      renderSettings();
      return;
    }

    var searchUrl = buildSearchUrl(tag);
    var steps = [
      "Tag: <b>" + tag + "</b>",
      "Query URL: <code style=\"font-size:var(--fs-2xs);word-break:break-all\">" + searchUrl + "</code>",
      "Opening Google Images window" + (showDebugWindow ? " (visible)..." : " (hidden)..."),
    ];
    testState = { status: "searching", steps: steps, imageUrl: null };
    renderSettings();

    searchGoogleImages(api, tag, true)
      .then(function (result) {
        if (!result || !result.src) {
          steps.push("No images found — page may not have loaded or no data:image imgs matched.");
          testState = { status: "done", steps: steps, imageUrl: null };
          renderSettings();
          return;
        }

        var prefix = result.src.substring(0, Math.min(result.src.length, 40));
        var dataLen = stripDataUriPrefix(result.src).length;
        steps.push("Found image: <b>" + result.w + "×" + result.h + "</b>");
        steps.push("Data URI prefix: <code style=\"font-size:var(--fs-2xs)\">" + prefix + "...</code>");
        steps.push("Base64 payload: <b>" + dataLen + "</b> chars (~" + Math.round(dataLen * 3 / 4 / 1024) + " KB)");

        testState = { status: "done", steps: steps, imageUrl: result.src };
        renderSettings();
      })
      .catch(function (e) {
        console.error("Test search failed:", e);
        steps.push("Error: " + e);
        testState = { status: "done", steps: steps, imageUrl: null };
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
          { type: "text-input", placeholder: "Tag name (e.g. rock, jazz)", action: "gis-test-tag", value: testTag, style: { flex: "1" } },
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

    if (testState.imageUrl) {
      testRows.push({
        type: "text",
        content: "<div style=\"margin-top:8px\"><img src=\"" + testState.imageUrl +
          "\" style=\"max-width:200px;max-height:200px;border-radius:var(--ds-radius-card);border:1px solid var(--border)\" /></div>",
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
          title: "Options",
          children: [
            {
              type: "toggle",
              label: "Always show scraping window",
              checked: showDebugWindow,
              action: "gis-toggle-debug",
            }
          ]
        }
      ]
    });
  }
}

function deactivate() {
  showDebugWindow = false;
  testTag = "";
  testState = { status: "idle", steps: [], imageUrl: null };
}

return { activate: activate, deactivate: deactivate };
