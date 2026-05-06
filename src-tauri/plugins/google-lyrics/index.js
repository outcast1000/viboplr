function activate(api) {
  var SEARCH_TIMEOUT = 10000;
  var POLL_INTERVAL = 500;

  var blacklist = [];
  var searchSuffix = "lyrics";
  var showBrowser = false;
  var debugDirPath = "";
  var domainStats = {};
  var testArtist = "Τρύπες";
  var testTitle = "Παράξενη Πόλη";
  var testState = { status: "idle", steps: [] };

  var MIN_WORD_COUNT = 20;

  // --- Debug helpers ---

  function resolveDebugDir() {
    return api.storage.files.getPath(["debug"]).then(function (p) {
      debugDirPath = p;
    }).catch(console.error);
  }

  function dumpDebug(domain, url, html, lyrics) {
    if (!showBrowser) return Promise.resolve(null);
    var ts = Date.now();
    var base = domain.replace(/\./g, "_") + "_" + ts;
    var htmlFile = base + ".html";
    var lyricsFile = base + "_lyrics.txt";
    var htmlPromise = api.storage.files.writeText(["debug", htmlFile], "<!-- " + url + " -->\n" + html).catch(console.error);
    var lyricsPromise = lyrics
      ? api.storage.files.writeText(["debug", lyricsFile], "<!-- " + url + " -->\n" + lyrics).catch(console.error)
      : Promise.resolve();
    return Promise.all([htmlPromise, lyricsPromise]).then(function () {
      return api.storage.files.getPath(["debug", htmlFile]);
    }).then(function (path) {
      api.log("info", "Debug dump: " + path, "google-lyrics");
      return path;
    }).catch(function (e) {
      console.error("Failed to write debug files:", e);
      return null;
    });
  }

  // --- Domain statistics ---

  function loadStats() {
    return api.storage.get("domain_stats").then(function (saved) {
      domainStats = saved || {};
    });
  }

  function saveStats() {
    return api.storage.set("domain_stats", domainStats);
  }

  function recordStat(domain, success) {
    if (!domainStats[domain]) {
      domainStats[domain] = { ok: 0, fail: 0, lastOk: null, lastFail: null };
    }
    if (success) {
      domainStats[domain].ok++;
      domainStats[domain].lastOk = new Date().toISOString();
    } else {
      domainStats[domain].fail++;
      domainStats[domain].lastFail = new Date().toISOString();
    }
    saveStats().catch(console.error);
  }

  function formatStatsTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    var now = Date.now();
    var diff = now - d.getTime();
    if (diff < 60000) return "just now";
    if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
    if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
    return Math.floor(diff / 86400000) + "d ago";
  }

  // --- Settings ---

  function loadSettings() {
    return api.storage.get("blacklist").then(function (saved) {
      if (Array.isArray(saved)) blacklist = saved;
    }).then(function () {
      return api.storage.get("search_suffix").then(function (val) {
        if (typeof val === "string") searchSuffix = val;
      });
    }).then(function () {
      return api.storage.get("show_browser").then(function (val) {
        if (val !== null && val !== undefined) showBrowser = !!val;
      });
    }).then(loadStats);
  }

  function saveSettings() {
    return api.storage.set("blacklist", blacklist).then(function () {
      return api.storage.set("search_suffix", searchSuffix);
    }).then(function () {
      return api.storage.set("show_browser", showBrowser);
    });
  }

  function isBlacklisted(url) {
    var lower = url.toLowerCase();
    for (var i = 0; i < blacklist.length; i++) {
      if (blacklist[i] && lower.indexOf(blacklist[i].toLowerCase()) !== -1) return true;
    }
    return false;
  }

  function domainFromUrl(url) {
    var m = url.match(/^https?:\/\/(?:www\.)?([^\/]+)/);
    return m ? m[1] : url;
  }

  function renderSettings() {
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

    var searchChildren = [
      { type: "text", content: "<span style=\"font-size:var(--fs-xs);color:var(--text-secondary)\">Extra keywords appended to every Google search (e.g. \"lyrics\", \"στίχοι\", \"lyrics στίχοι\").</span>" },
      { type: "text-input", placeholder: "lyrics", action: "update-suffix", value: searchSuffix },
    ];

    var blacklistChildren = [
      { type: "text", content: "<span style=\"font-size:var(--fs-xs);color:var(--text-secondary)\">One domain per line. Search results matching these domains will be skipped.</span>" },
      { type: "text-input", placeholder: "example.com", action: "update-blacklist", value: blacklist.join("\n"), multiline: true, rows: 4 },
    ];

    var advancedChildren = [
      { type: "toggle", label: "Show browser window while scraping", checked: showBrowser, action: "toggle-show-browser" },
    ];
    if (showBrowser && debugDirPath) {
      advancedChildren.push({ type: "text", content: "<span style=\"font-size:var(--fs-xs);color:var(--text-secondary)\">Debug pages saved to: " + debugDirPath + "</span>" });
    }

    var statsRows = [];
    var hasSomeStats = false;
    var allStatDomains = Object.keys(domainStats);
    for (var s = 0; s < allStatDomains.length; s++) {
      var sd = allStatDomains[s];
      var st = domainStats[sd];
      if (st && (st.ok > 0 || st.fail > 0)) {
        hasSomeStats = true;
        var rate = st.ok + st.fail > 0 ? Math.round(st.ok / (st.ok + st.fail) * 100) : 0;
        statsRows.push({
          type: "text",
          content: "<div style=\"font-size:var(--fs-xs);padding:2px 0\">"
            + "<b>" + sd + "</b> — "
            + "<span style=\"color:var(--success)\">" + st.ok + " ok</span> / "
            + "<span style=\"color:var(--error)\">" + st.fail + " fail</span>"
            + " (" + rate + "%)"
            + (st.lastOk ? " · last ok " + formatStatsTime(st.lastOk) : "")
            + (st.lastFail ? " · last fail " + formatStatsTime(st.lastFail) : "")
            + "</div>",
        });
      }
    }
    if (!hasSomeStats) {
      statsRows.push({ type: "text", content: "<span style=\"font-size:var(--fs-xs);color:var(--text-secondary)\">No data yet</span>" });
    } else {
      statsRows.push({ type: "button", label: "Reset Statistics", action: "reset-stats", variant: "secondary", style: { padding: "3px 14px", "margin-top": "4px" } });
    }

    api.ui.setViewData("google-lyrics-settings", {
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
          title: "Search Keywords",
          children: searchChildren,
        },
        {
          type: "section",
          title: "Blacklisted Domains",
          children: blacklistChildren,
        },
        {
          type: "section",
          title: "Statistics",
          children: statsRows,
        },
        {
          type: "section",
          title: "Advanced",
          children: advancedChildren,
        },
      ],
    });
  }

  api.ui.onAction("update-suffix", function (data) {
    if (data && data.value !== undefined) {
      searchSuffix = data.value;
      saveSettings();
    }
  });

  api.ui.onAction("update-blacklist", function (data) {
    if (data && data.value !== undefined) {
      blacklist = data.value.split("\n").map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
      saveSettings();
    }
  });

  api.ui.onAction("reset-stats", function () {
    domainStats = {};
    saveStats().then(renderSettings);
  });

  api.ui.onAction("toggle-show-browser", function () {
    showBrowser = !showBrowser;
    saveSettings();
    if (showBrowser && !debugDirPath) {
      resolveDebugDir().then(renderSettings);
    } else {
      renderSettings();
    }
  });

  api.ui.onAction("test-artist", function (data) {
    if (data && data.value !== undefined) testArtist = data.value;
  });
  api.ui.onAction("test-title", function (data) {
    if (data && data.value !== undefined) testTitle = data.value;
  });

  function buildQuery(artist, title) {
    var q = "";
    if (artist) q += artist + " ";
    if (title) q += title + " ";
    if (searchSuffix) q += searchSuffix;
    return q.trim();
  }

  function runTestSearch() {
    var artist = testArtist.trim();
    var title = testTitle.trim();
    if (!artist && !title) {
      testState = { status: "done", steps: ["Enter an artist and/or title."] };
      renderSettings();
      return;
    }

    var query = buildQuery(artist, title);
    var steps = ["Query: <b>" + query + "</b>", showBrowser ? "Opening Google window..." : "Opening hidden Google window..."];
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
      if (blacklist.length > 0) steps.push("Blacklist: " + blacklist.join(", "));

      var candidates = filterResults(results);
      if (candidates.length === 0) {
        steps.push("All results were blacklisted or no results found.");
        closeScrapeWindow();
        testState = { status: "done", steps: steps };
        renderSettings();
        return;
      }
      steps.push(candidates.length + " candidate(s) after filtering.");

      function tryCandidate(idx) {
        if (idx >= candidates.length) {
          steps.push("All " + candidates.length + " candidate(s) failed.");
          closeScrapeWindow();
          testState = { status: "done", steps: steps };
          renderSettings();
          return;
        }

        var found = candidates[idx];
        steps.push((idx > 0 ? "Fallback " + (idx + 1) + ": " : "") + "Scraping <b>" + found.domain + "</b>: " + found.url);
        testState = { status: "fetching", steps: steps };
        renderSettings();

        return scrapeLyrics(found.url).then(function (result) {
          if (!result || !result.text) {
            steps.push("No lyrics found (score: " + (result ? result.score : 0) + ", need " + MIN_WORD_COUNT + "+ words).");
            if (result && result.html) dumpDebug(found.domain, found.url, result.html, null);
            if (idx < candidates.length - 1) {
              steps.push("Trying next candidate...");
              renderSettings();
              return tryCandidate(idx + 1);
            }
          } else {
            var preview = result.text.length > 200 ? result.text.substring(0, 200) + "..." : result.text;
            steps.push("Found " + result.text.length + " chars (" + result.words + " words, score: " + Math.round(result.score) + ").");
            steps.push("<i>" + preview.replace(/\n/g, " / ") + "</i>");
            dumpDebug(found.domain, found.url, result.html || "", result.text).then(function (path) {
              if (path) steps.push("Saved debug dump: " + path);
              closeScrapeWindow();
              testState = { status: "done", steps: steps };
              renderSettings();
            });
            return;
          }
          closeScrapeWindow();
          testState = { status: "done", steps: steps };
          renderSettings();
        }).catch(function (e) {
          console.error("Scrape failed for " + found.domain + ":", e);
          steps.push("Error scraping " + found.domain + ": " + e + ", trying next...");
          renderSettings();
          return tryCandidate(idx + 1);
        });
      }

      return tryCandidate(0);
    }).catch(function (e) {
      console.error("Test search failed:", e);
      steps.push("Error: " + e);
      testState = { status: "done", steps: steps };
      renderSettings();
    });
  }

  api.ui.onAction("test-search", runTestSearch);

  loadSettings().then(function () {
    return resolveDebugDir();
  }).then(function () {
    renderSettings();
  });

  // --- Browse window scraping ---

  var SCRAPE_TIMEOUT = 15000;
  var SCRAPE_NAV_DELAY = 1000;

  var GOOGLE_EXTRACT_SCRIPT =
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

  var LYRICS_EXTRACT_SCRIPT =
    '(function() {' +
    '  if (document.readyState !== "complete") return;' +
    '  var MIN = ' + MIN_WORD_COUNT + ';' +
    '  var MAX_LINE = 150;' +
    '  var skip = {SCRIPT:1,STYLE:1,NOSCRIPT:1,IFRAME:1,SVG:1,IMG:1,INPUT:1,BUTTON:1,SELECT:1,TEXTAREA:1,VIDEO:1,AUDIO:1,CANVAS:1,OBJECT:1,EMBED:1};' +
    '  var inline = {A:1,B:1,I:1,EM:1,STRONG:1,SPAN:1,U:1,SMALL:1,SUP:1,SUB:1,FONT:1,RUBY:1,RT:1,RP:1,WBR:1,MARK:1,S:1,ABBR:1,CITE:1,BR:1};' +
    '  var best = null;' +
    '  var bestScore = 0;' +
    '  function score(text) {' +
    '    text = text.replace(/^[ \\t]+$/gm, "").replace(/\\n{3,}/g, "\\n\\n").trim();' +
    '    if (!text) return;' +
    '    var lines = text.split(/\\n/);' +
    '    var nonEmpty = lines.filter(function(l){return l.trim().length>0;});' +
    '    if (nonEmpty.length < 3) return;' +
    '    var allShort = true;' +
    '    for (var k = 0; k < nonEmpty.length; k++) {' +
    '      if (nonEmpty[k].trim().length > MAX_LINE) { allShort = false; break; }' +
    '    }' +
    '    if (!allShort) return;' +
    '    var words = text.split(/\\s+/).filter(function(w){return w.length>0;});' +
    '    if (words.length < MIN) return;' +
    '    var s = words.length + nonEmpty.length;' +
    '    if (s > bestScore) { bestScore = s; best = text; }' +
    '  }' +
    '  var els = document.body.querySelectorAll("*");' +
    '  for (var i = 0; i < els.length; i++) {' +
    '    var el = els[i];' +
    '    if (skip[el.tagName]) continue;' +
    '    var st = window.getComputedStyle(el);' +
    '    if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") continue;' +
    '    var children = el.childNodes;' +
    '    var hasBr = false;' +
    '    var hasBlock = false;' +
    '    for (var c = 0; c < children.length; c++) {' +
    '      var ch = children[c];' +
    '      if (ch.nodeType === 1) {' +
    '        if (ch.tagName === "BR") { hasBr = true; }' +
    '        else if (!inline[ch.tagName]) { hasBlock = true; }' +
    '      }' +
    '    }' +
    '    if (!hasBr) continue;' +
    '    if (!hasBlock) {' +
    '      score(el.innerText);' +
    '    } else {' +
    '      var buf = "";' +
    '      for (var c2 = 0; c2 < children.length; c2++) {' +
    '        var n = children[c2];' +
    '        if (n.nodeType === 3) { buf += n.textContent; }' +
    '        else if (n.nodeType === 1 && n.tagName === "BR") { buf += "\\n"; }' +
    '        else if (n.nodeType === 1 && inline[n.tagName]) { buf += n.innerText || ""; }' +
    '        else {' +
    '          score(buf); buf = "";' +
    '        }' +
    '      }' +
    '      score(buf);' +
    '    }' +
    '  }' +
    '  var html = document.documentElement.outerHTML;' +
    '  window.__viboplr.send("lyrics-result", best ? {text: best, score: bestScore, words: best.split(/\\s+/).length, html: html} : {text: null, html: html});' +
    '})();';

  var scrapeHandle = null;

  function searchGoogle(query) {
    var searchUrl = "https://www.google.com/search?q=" + encodeURIComponent(query);

    if (scrapeHandle) {
      scrapeHandle.close().catch(console.error);
      scrapeHandle = null;
    }

    var windowTitle = showBrowser ? "Google Lyrics Debug" + (debugDirPath ? " — " + debugDirPath : "") : undefined;

    return api.network.openBrowseWindow(searchUrl, {
      visible: showBrowser,
      title: windowTitle,
      width: 800,
      height: 600,
    }).then(function (handle) {
      scrapeHandle = handle;

      return new Promise(function (resolve) {
        var settled = false;
        var pollTimer = null;
        var deadline = null;

        function finish(urls) {
          if (settled) return;
          settled = true;
          if (pollTimer) clearInterval(pollTimer);
          if (deadline) clearTimeout(deadline);
          resolve(urls);
        }

        handle.onMessage(function (msg) {
          if (msg.type === "search-results" && Array.isArray(msg.data)) {
            finish(msg.data);
          }
        });

        pollTimer = setInterval(function () {
          handle.eval(GOOGLE_EXTRACT_SCRIPT).catch(function () {
            finish([]);
          });
        }, POLL_INTERVAL);

        deadline = setTimeout(function () {
          finish([]);
        }, SEARCH_TIMEOUT);
      });
    });
  }

  function scrapeLyrics(url) {
    if (!scrapeHandle) return Promise.resolve(null);

    return new Promise(function (resolve) {
      var settled = false;
      var pollTimer = null;
      var deadline = null;
      var unsub = null;

      function finish(result) {
        if (settled) return;
        settled = true;
        if (pollTimer) clearInterval(pollTimer);
        if (deadline) clearTimeout(deadline);
        if (unsub) unsub();
        resolve(result);
      }

      unsub = scrapeHandle.onMessage(function (msg) {
        if (msg.type === "lyrics-result") {
          finish(msg.data);
        }
      });

      var escaped = url.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      scrapeHandle.eval("window.location.href = '" + escaped + "'").catch(function () {
        finish(null);
      });

      setTimeout(function () {
        if (settled) return;
        pollTimer = setInterval(function () {
          if (settled) return;
          scrapeHandle.eval(LYRICS_EXTRACT_SCRIPT).catch(function () {});
        }, POLL_INTERVAL);
      }, SCRAPE_NAV_DELAY);

      deadline = setTimeout(function () {
        finish(null);
      }, SCRAPE_TIMEOUT);
    });
  }

  function closeScrapeWindow() {
    if (!scrapeHandle) return;
    if (!showBrowser) {
      scrapeHandle.close().catch(console.error);
    }
    scrapeHandle = null;
  }

  function filterResults(results) {
    var found = [];
    for (var i = 0; i < results.length; i++) {
      var url = results[i];
      if (!isBlacklisted(url)) {
        found.push({ url: url, domain: domainFromUrl(url) });
      }
    }
    return found;
  }

  // --- Scrape & extract ---

  function fetchAndExtract(url, domain) {
    return scrapeLyrics(url).then(function (result) {
      if (!result || !result.text) {
        if (result && result.html) dumpDebug(domain, url, result.html, null);
        recordStat(domain, false);
        return null;
      }
      dumpDebug(domain, url, result.html || "", result.text);
      recordStat(domain, true);
      return result.text;
    }).catch(function (e) {
      recordStat(domain, false);
      throw e;
    });
  }

  // --- onFetch handler ---

  api.informationTypes.onFetch("lyrics", function (entity) {
    if (!entity.name || !entity.artistName) {
      return Promise.resolve({ status: "not_found" });
    }

    var query = buildQuery(entity.artistName, entity.name);

    return searchGoogle(query).then(function (results) {
      var candidates = filterResults(results);
      if (candidates.length === 0) {
        closeScrapeWindow();
        return { status: "not_found" };
      }

      function tryNext(index) {
        if (index >= candidates.length) {
          closeScrapeWindow();
          return { status: "not_found" };
        }
        var c = candidates[index];
        return fetchAndExtract(c.url, c.domain).then(function (text) {
          if (text) {
            closeScrapeWindow();
            return { status: "ok", value: { text: text, kind: "plain" } };
          }
          return tryNext(index + 1);
        }).catch(function (e) {
          console.error("Failed to scrape " + c.domain + ":", e);
          return tryNext(index + 1);
        });
      }

      return tryNext(0);
    }).catch(function (e) {
      console.error("Failed to search lyrics:", e);
      closeScrapeWindow();
      return { status: "error" };
    });
  });
}

function deactivate() {}

return { activate: activate, deactivate: deactivate };
