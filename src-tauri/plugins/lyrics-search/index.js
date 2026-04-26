function activate(api) {
  var SEARCH_TIMEOUT = 10000;
  var POLL_INTERVAL = 500;

  var domainEnabled = {};
  var testArtist = "";
  var testTitle = "";
  var testState = { status: "idle", steps: [] };

  // --- HTML helpers ---

  function decodeEntities(str) {
    return str
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&#8211;/g, "\u2013")
      .replace(/&#8217;/g, "\u2019")
      .replace(/&#x2019;/g, "\u2019")
      .replace(/&nbsp;/g, " ");
  }

  function stripTags(html) {
    return html.replace(/<[^>]+>/g, "");
  }

  function brToNewline(html) {
    return html.replace(/<br\s*\/?>/gi, "\n");
  }

  function cleanLyrics(html) {
    var text = brToNewline(html);
    text = stripTags(text);
    text = decodeEntities(text);
    text = text.replace(/^[ \t]+$/gm, "");
    text = text.replace(/\n{3,}/g, "\n\n");
    return text.trim();
  }

  // --- Site-specific extractors ---
  // Each returns lyrics text or null from full page HTML.

  var extractors = {
    "stixoi.info": function (html) {
      // Mobile endpoint: <div class=moblyrics>...</div>
      var m = html.match(/class=moblyrics>([\s\S]*?)<\/div>/);
      if (!m) return null;
      return cleanLyrics(m[1]);
    },

    "stixoi.gr": function (html) {
      // WordPress/Elementor: theme-post-content widget
      var m = html.match(/data-widget_type="theme-post-content[^"]*"[\s\S]*?<div[^>]*class="elementor-widget-container"[^>]*>([\s\S]*?)<\/div>/);
      if (!m) return null;
      var text = cleanLyrics(m[1]);
      // Remove trailing metadata (starts with "Στοιχεία Τραγουδιού" or "Καλλιτέχνες:")
      text = text.replace(/\n\s*(Στοιχεία Τραγουδιού|Καλλιτέχνες:)[\s\S]*$/, "");
      return text || null;
    },

    "stichoi.gr": function (html) {
      // WordPress: <div class="entry-content">
      var m = html.match(/class="entry-content"[^>]*>([\s\S]*?)<\/div>/);
      if (!m) return null;
      var text = cleanLyrics(m[1]);
      // Remove header line "ΣΤΙΧΟΙ ..." and trailing metadata
      text = text.replace(/^ΣΤΙΧΟΙ\s[^\n]*\n/, "");
      text = text.replace(/\(adsbygoogle[\s\S]*?\)\s*;?\s*/g, "");
      text = text.replace(/\n\s*Στίχοι για το τραγούδι[\s\S]*$/, "");
      text = text.replace(/\n\s*Του ίδιου καλλιτέχνη[\s\S]*$/, "");
      return text.trim() || null;
    },

    "lyricstranslate.com": function (html) {
      // Lyric lines in div.ll-N-N elements inside translate__text
      var m = html.match(/class="translate__text[^"]*">([\s\S]*?)<\/div>\s*(?:<div class="translate__|<\/div>)/);
      if (!m) return null;
      return cleanLyrics(m[1]);
    },

    "songlyrics.com": function (html) {
      // <p id="songLyricsDiv">
      var m = html.match(/id="songLyricsDiv"[^>]*>([\s\S]*?)<\/p>/);
      if (!m) return null;
      return cleanLyrics(m[1]);
    },

    "azlyrics.com": function (html) {
      // Lyrics in a div after <!-- Usage of azlyrics.com content... --> comment
      var m = html.match(/<!-- Usage of azlyrics[\s\S]*?-->\s*<div>([\s\S]*?)<\/div>/);
      if (!m) return null;
      return cleanLyrics(m[1]);
    },

    "lyrics.com": function (html) {
      // <pre id="lyric-body-text">
      var m = html.match(/id="lyric-body-text"[^>]*>([\s\S]*?)<\/pre>/);
      if (!m) return null;
      return cleanLyrics(m[1]);
    },

    "greeklyrics.gr": function (html) {
      var m = html.match(/class="entry-content"[^>]*>([\s\S]*?)<\/div>/);
      if (!m) return null;
      return cleanLyrics(m[1]);
    },

    "greekstixoi.gr": function (html) {
      var m = html.match(/class="entry-content"[^>]*>([\s\S]*?)<\/div>/);
      if (!m) return null;
      var text = cleanLyrics(m[1]);
      text = text.replace(/\n\s*Στίχοι για το τραγούδι[\s\S]*$/, "");
      return text.trim() || null;
    }
  };

  // Build domain list from extractor keys
  var allDomains = Object.keys(extractors);

  // --- Settings ---

  function loadSettings() {
    return api.storage.get("domain_settings").then(function (saved) {
      // Default: all domains enabled
      for (var i = 0; i < allDomains.length; i++) {
        domainEnabled[allDomains[i]] = true;
      }
      // Apply saved overrides
      if (saved) {
        for (var domain in saved) {
          if (saved.hasOwnProperty(domain) && domainEnabled.hasOwnProperty(domain)) {
            domainEnabled[domain] = saved[domain];
          }
        }
      }
    });
  }

  function saveSettings() {
    return api.storage.set("domain_settings", domainEnabled);
  }

  function renderSettings() {
    var rows = [];
    for (var i = 0; i < allDomains.length; i++) {
      var domain = allDomains[i];
      rows.push({
        type: "toggle",
        label: domain,
        checked: !!domainEnabled[domain],
        action: "toggle-domain:" + domain,
      });
    }

    var busy = testState.status === "searching" || testState.status === "fetching";
    var testRows = [
      {
        type: "layout", direction: "horizontal", style: { gap: "8px", "align-items": "center" },
        children: [
          { type: "text-input", placeholder: "Artist", action: "test-artist", value: testArtist, style: { flex: "1" } },
          { type: "text-input", placeholder: "Title", action: "test-title", value: testTitle, style: { flex: "1" } },
          { type: "button", label: busy ? "Searching..." : "Test", action: "test-search", disabled: busy, variant: "accent", style: { padding: "3px 14px" } },
        ],
      },
    ];
    if (testState.steps.length > 0) {
      var log = testState.steps.map(function (s) { return "<p style=\"margin:2px 0;font-size:var(--fs-xs)\">" + s + "</p>"; }).join("");
      testRows.push({ type: "text", content: log });
    }

    api.ui.setViewData("lyrics-search-settings", {
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
          title: "Whitelisted Domains",
          children: rows,
        },
      ],
    });
  }

  // Register a toggle action handler for each domain
  function makeToggleHandler(domain) {
    return function (data) {
      domainEnabled[domain] = !!(data && data.value);
      saveSettings();
      renderSettings();
    };
  }
  for (var i = 0; i < allDomains.length; i++) {
    api.ui.onAction("toggle-domain:" + allDomains[i], makeToggleHandler(allDomains[i]));
  }

  api.ui.onAction("test-artist", function (data) {
    if (data && data.value !== undefined) testArtist = data.value;
  });
  api.ui.onAction("test-title", function (data) {
    if (data && data.value !== undefined) testTitle = data.value;
  });

  function runTestSearch() {
    var artist = testArtist.trim();
    var title = testTitle.trim();
    if (!artist && !title) {
      testState = { status: "done", steps: ["Enter an artist and/or title."] };
      renderSettings();
      return;
    }

    var query = (artist ? artist + " " : "") + (title ? title + " " : "") + "στίχοι lyrics";
    var steps = ["Query: <b>" + query + "</b>", "Opening hidden Google window..."];
    testState = { status: "searching", steps: steps };
    renderSettings();

    searchGoogle(query).then(function (results) {
      if (results.length === 0) {
        steps.push("Google returned 0 URLs (timeout or page did not load).");
        testState = { status: "done", steps: steps };
        renderSettings();
        return;
      }

      steps.push("Google returned " + results.length + " URL(s).");
      var enabledDomains = allDomains.filter(function (d) { return domainEnabled[d]; });
      steps.push("Enabled domains: " + enabledDomains.join(", "));

      var matched = [];
      for (var i = 0; i < results.length; i++) {
        for (var j = 0; j < allDomains.length; j++) {
          if (results[i].indexOf(allDomains[j]) !== -1) {
            var enabled = domainEnabled[allDomains[j]];
            matched.push(allDomains[j] + (enabled ? "" : " (disabled)") + ": " + results[i]);
            break;
          }
        }
      }
      if (matched.length > 0) {
        steps.push("Whitelisted matches: " + matched.join(", "));
      } else {
        var sample = results.slice(0, 5).join(", ");
        steps.push("No whitelisted domains found in results. Top URLs: " + sample);
        testState = { status: "done", steps: steps };
        renderSettings();
        return;
      }

      var found = findWhitelistedUrl(results);
      if (!found) {
        steps.push("All matching domains are disabled.");
        testState = { status: "done", steps: steps };
        renderSettings();
        return;
      }

      steps.push("Fetching lyrics from <b>" + found.domain + "</b>: " + found.url);
      testState = { status: "fetching", steps: steps };
      renderSettings();

      var fetchUrl = rewriteUrl(found.url);
      if (fetchUrl !== found.url) {
        steps.push("Rewrote URL: " + fetchUrl);
      }
      return api.network.fetch(fetchUrl).then(function (resp) {
        steps.push("HTTP " + resp.status + " from " + found.domain);
        if (resp.status !== 200) {
          testState = { status: "done", steps: steps };
          renderSettings();
          return;
        }
        return resp.text().then(function (html) {
          steps.push("Response body: " + html.length + " chars");
          var extractor = extractors[found.domain];
          if (!extractor) {
            steps.push("No extractor registered for " + found.domain + ".");
            testState = { status: "done", steps: steps };
            renderSettings();
            return;
          }
          var text = extractor(html);
          if (!text) {
            var snippet = html.substring(0, 500).replace(/</g, "&lt;").replace(/>/g, "&gt;");
            steps.push("Extractor returned null — regex did not match page structure.");
            steps.push("First 500 chars of HTML: <code style=\"font-size:var(--fs-2xs);word-break:break-all\">" + snippet + "</code>");
          } else {
            var preview = text.length > 200 ? text.substring(0, 200) + "..." : text;
            steps.push("Found " + text.length + " chars of lyrics.");
            steps.push("<i>" + preview.replace(/\n/g, " / ") + "</i>");
          }
          testState = { status: "done", steps: steps };
          renderSettings();
        });
      });
    }).catch(function (e) {
      console.error("Test search failed:", e);
      steps.push("Error: " + e);
      testState = { status: "done", steps: steps };
      renderSettings();
    });
  }

  api.ui.onAction("test-search", runTestSearch);

  loadSettings().then(function () {
    renderSettings();
  });

  // --- URL rewriting for better scraping ---

  function rewriteUrl(url) {
    // stixoi.info: rewrite desktop to mobile endpoint for cleaner HTML
    if (url.indexOf("stixoi.info") !== -1 && url.indexOf("act=details") !== -1) {
      return url.replace("act=details", "act=mobdetails");
    }
    return url;
  }

  // --- Search via hidden Google webview ---

  var EXTRACT_SCRIPT =
    '(function() {' +
    '  var container = document.getElementById("search") || document.getElementById("rso");' +
    '  if (!container) return;' +
    '  var links = container.querySelectorAll("a[href]");' +
    '  var seen = {};' +
    '  var urls = [];' +
    '  var skip = /google\\.|gstatic\\.|googleapis\\.|youtube\\.|schema\\.org/;' +
    '  for (var i = 0; i < links.length; i++) {' +
    '    var href = links[i].href;' +
    '    if (!href) continue;' +
    '    if (href.indexOf("/url?") !== -1) {' +
    '      var m = href.match(/[?&]q=([^&]+)/);' +
    '      if (m) { try { href = decodeURIComponent(m[1]); } catch(e) { continue; } }' +
    '      else { continue; }' +
    '    }' +
    '    if (href.indexOf("http") !== 0) continue;' +
    '    if (skip.test(href)) continue;' +
    '    if (seen[href]) continue;' +
    '    seen[href] = true;' +
    '    urls.push(href);' +
    '  }' +
    '  if (urls.length > 0) window.__viboplr.send("search-results", urls);' +
    '})();';

  var activeSearchHandle = null;

  function searchGoogle(query) {
    var searchUrl = "https://www.google.com/search?q=" + encodeURIComponent(query);

    if (activeSearchHandle) {
      activeSearchHandle.close().catch(console.error);
      activeSearchHandle = null;
    }

    return api.network.openBrowseWindow(searchUrl, {
      visible: false,
      width: 800,
      height: 600,
    }).then(function (handle) {
      activeSearchHandle = handle;

      return new Promise(function (resolve) {
        var settled = false;
        var pollTimer = null;
        var deadline = null;

        function finish(urls) {
          if (settled) return;
          settled = true;
          if (pollTimer) clearInterval(pollTimer);
          if (deadline) clearTimeout(deadline);
          activeSearchHandle = null;
          handle.close().catch(console.error);
          resolve(urls);
        }

        handle.onMessage(function (msg) {
          if (msg.type === "search-results" && Array.isArray(msg.data)) {
            finish(msg.data);
          }
        });

        pollTimer = setInterval(function () {
          handle.eval(EXTRACT_SCRIPT).catch(function () {
            finish([]);
          });
        }, POLL_INTERVAL);

        deadline = setTimeout(function () {
          finish([]);
        }, SEARCH_TIMEOUT);
      });
    });
  }

  function findWhitelistedUrl(results) {
    for (var i = 0; i < results.length; i++) {
      var url = results[i];
      for (var j = 0; j < allDomains.length; j++) {
        var domain = allDomains[j];
        if (domainEnabled[domain] && url.indexOf(domain) !== -1) {
          return { url: url, domain: domain };
        }
      }
    }
    return null;
  }

  // --- Fetch & extract ---

  function fetchAndExtract(url, domain) {
    var fetchUrl = rewriteUrl(url);
    return api.network.fetch(fetchUrl).then(function (resp) {
      if (resp.status !== 200) return null;
      return resp.text().then(function (html) {
        var extractor = extractors[domain];
        if (!extractor) return null;
        return extractor(html);
      });
    });
  }

  // --- onFetch handler ---

  api.informationTypes.onFetch("lyrics", function (entity) {
    if (!entity.name || !entity.artistName) {
      return Promise.resolve({ status: "not_found" });
    }

    var query = entity.artistName + " " + entity.name + " στίχοι lyrics";

    return searchGoogle(query).then(function (results) {
      var found = findWhitelistedUrl(results);
      if (!found) return { status: "not_found" };

      return fetchAndExtract(found.url, found.domain).then(function (text) {
        if (!text) return { status: "not_found" };
        return {
          status: "ok",
          value: { text: text, kind: "plain" },
        };
      });
    }).catch(function (e) {
      console.error("Failed to search lyrics:", e);
      return { status: "error" };
    });
  });
}

function deactivate() {}

return { activate: activate, deactivate: deactivate };
