function activate(api) {
  var SEARCH_TIMEOUT = 10000;
  var POLL_INTERVAL = 500;

  var blacklist = ["chatzi.org"];
  var preferred = ["stixoi.info", "genius.com"];
  var searchSuffix = "lyrics";
  var domainStats = {};
  var testArtist = "Τρύπες";
  var testTitle = "Παράξενη Πόλη";
  var testState = { status: "idle", steps: [] };

  // Step-by-step debugger state
  var dbgTest = {
    status: "idle", // idle | searching | results | scraping | done
    handle: null,
    results: [],
    selectedUrl: "",
    scrapeResult: null,
  };

  var MIN_WORD_COUNT = 20;

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
      return api.storage.get("preferred").then(function (saved) {
        if (Array.isArray(saved)) preferred = saved;
      });
    }).then(function () {
      return api.storage.get("search_suffix").then(function (val) {
        if (typeof val === "string") searchSuffix = val;
      });
    }).then(loadStats);
  }

  function saveSettings() {
    return api.storage.set("blacklist", blacklist).then(function () {
      return api.storage.set("preferred", preferred);
    }).then(function () {
      return api.storage.set("search_suffix", searchSuffix);
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

    var preferredChildren = [
      { type: "text", content: "<span style=\"font-size:var(--fs-xs);color:var(--text-secondary)\">One domain per line. Results matching these domains are tried first.</span>" },
      { type: "text-input", placeholder: "genius.com", action: "update-preferred", value: preferred.join("\n"), multiline: true, rows: 3 },
    ];

    var blacklistChildren = [
      { type: "text", content: "<span style=\"font-size:var(--fs-xs);color:var(--text-secondary)\">One domain per line. Search results matching these domains will be skipped.</span>" },
      { type: "text-input", placeholder: "example.com", action: "update-blacklist", value: blacklist.join("\n"), multiline: true, rows: 4 },
    ];

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
        buildDebugTestSection(),
        {
          type: "section",
          title: "Test (auto)",
          children: testRows,
        },
        {
          type: "section",
          title: "Search Keywords",
          children: searchChildren,
        },
        {
          type: "section",
          title: "Preferred Sites",
          children: preferredChildren,
        },
        {
          type: "section",
          title: "Blocked Domains",
          children: blacklistChildren,
        },
        {
          type: "section",
          title: "Statistics",
          children: statsRows,
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

  api.ui.onAction("update-preferred", function (data) {
    if (data && data.value !== undefined) {
      preferred = data.value.split("\n").map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
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
    var steps = ["Query: <b>" + query + "</b>", "Searching..."];
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
            if (idx < candidates.length - 1) {
              steps.push("Trying next candidate...");
              renderSettings();
              return tryCandidate(idx + 1);
            }
          } else {
            var preview = result.text.length > 200 ? result.text.substring(0, 200) + "..." : result.text;
            steps.push("Found " + result.text.length + " chars (" + result.words + " words, score: " + Math.round(result.score) + ").");
            steps.push("<i>" + preview.replace(/\n/g, " / ") + "</i>");
            closeScrapeWindow();
            testState = { status: "done", steps: steps };
            renderSettings();
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

  // --- Step-by-step debugger ---

  function dbgStart() {
    var artist = testArtist.trim();
    var title = testTitle.trim();
    if (!artist && !title) return;

    var query = buildQuery(artist, title);
    var searchUrl = "https://www.google.com/search?q=" + encodeURIComponent(query);

    dbgTest.status = "searching";
    dbgTest.results = [];
    dbgTest.selectedUrl = "";
    dbgTest.scrapeResult = null;
    renderSettings();

    api.network.openBrowseWindow(searchUrl, {
      visible: true,
      title: "Google Lyrics Debug",
      width: 900,
      height: 700,
    }).then(function (handle) {
      dbgTest.handle = handle;
      renderSettings();

      var settled = false;
      var pollTimer = null;
      var deadline = null;

      function finish(urls) {
        if (settled) return;
        settled = true;
        if (pollTimer) clearInterval(pollTimer);
        if (deadline) clearTimeout(deadline);
        dbgTest.results = filterResults(urls || []);
        dbgTest.status = "results";
        if (dbgTest.results.length > 0) dbgTest.selectedUrl = dbgTest.results[0].url;
        renderSettings();
      }

      handle.onMessage(function (msg) {
        if (msg.type === "search-results" && Array.isArray(msg.data)) {
          finish(msg.data);
        }
        if (msg.type === "lyrics-result" && dbgTest.status === "scraping") {
          dbgTest.scrapeResult = msg.data;
          dbgTest.status = "done";
          renderSettings();
        }
      });

      pollTimer = setInterval(function () {
        handle.eval(GOOGLE_EXTRACT_SCRIPT).catch(function () {});
      }, POLL_INTERVAL);

      deadline = setTimeout(function () { finish([]); }, SEARCH_TIMEOUT);
    }).catch(function (e) {
      console.error("Debugger failed to open window:", e);
      dbgTest.status = "idle";
      renderSettings();
    });
  }

  function dbgScrapeUrl(url) {
    if (!dbgTest.handle || !url) return;
    dbgTest.status = "scraping";
    dbgTest.scrapeResult = null;
    renderSettings();

    var escaped = url.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    dbgTest.handle.eval("window.location.href = '" + escaped + "'").catch(function () {
      dbgTest.status = "done";
      dbgTest.scrapeResult = { text: null };
      renderSettings();
    });

    setTimeout(function () {
      if (dbgTest.status !== "scraping") return;
      var pollTimer = setInterval(function () {
        if (dbgTest.status !== "scraping") { clearInterval(pollTimer); return; }
        dbgTest.handle.eval(LYRICS_EXTRACT_SCRIPT).catch(function () {});
      }, POLL_INTERVAL);
      setTimeout(function () {
        clearInterval(pollTimer);
        if (dbgTest.status === "scraping") {
          dbgTest.status = "done";
          dbgTest.scrapeResult = { text: null, timeout: true };
          renderSettings();
        }
      }, SCRAPE_TIMEOUT);
    }, SCRAPE_NAV_DELAY);
  }

  function dbgStop() {
    if (dbgTest.handle) {
      dbgTest.handle.close().catch(console.error);
      dbgTest.handle = null;
    }
    dbgTest.status = "idle";
    dbgTest.results = [];
    dbgTest.scrapeResult = null;
    renderSettings();
  }

  function buildDebugTestSection() {
    var children = [];
    var idle = dbgTest.status === "idle";
    var searching = dbgTest.status === "searching";
    var hasHandle = !!dbgTest.handle;

    // Input + Start/Stop + DevTools
    var buttons = [];
    if (idle || dbgTest.status === "done") {
      buttons.push({ type: "button", label: "Start", action: "dbg-start", variant: "accent", style: { padding: "3px 14px" } });
    }
    if (!idle) {
      buttons.push({ type: "button", label: "Reset", action: "dbg-stop", variant: "secondary", style: { padding: "3px 10px" } });
    }
    if (hasHandle) {
      buttons.push({ type: "button", label: "DevTools", action: "dbg-devtools", variant: "secondary", style: { padding: "3px 10px" } });
    }

    children.push({
      type: "layout", direction: "horizontal", style: { gap: "8px", "align-items": "center" },
      children: [
        { type: "text-input", placeholder: "Artist", action: "test-artist", value: testArtist, style: { flex: "1" }, disabled: !idle },
        { type: "text-input", placeholder: "Title", action: "test-title", value: testTitle, style: { flex: "1" }, disabled: !idle },
      ].concat(buttons),
    });

    // Status
    if (searching) {
      children.push({ type: "text", content: "<p style=\"font-size:var(--fs-xs)\">Searching Google (visible window)...</p>" });
    }

    // Step 2: Show results as clickable links
    if (dbgTest.status === "results" || dbgTest.status === "scraping" || dbgTest.status === "done") {
      if (dbgTest.results.length === 0) {
        children.push({ type: "text", content: "<p style=\"font-size:var(--fs-xs);color:var(--error)\">No results found from Google.</p>" });
      } else {
        children.push({ type: "text", content: "<p style=\"font-size:var(--fs-xs)\"><b>Search results (" + dbgTest.results.length + "):</b></p>" });
        var resultOptions = dbgTest.results.map(function (r) { return { value: r.url, label: r.domain + " — " + r.url.substring(0, 60) }; });
        children.push({
          type: "select", options: resultOptions, value: dbgTest.selectedUrl, action: "dbg-select-url",
        });
        if (dbgTest.status === "results") {
          children.push({
            type: "button", label: "Scrape Lyrics", action: "dbg-scrape", variant: "accent", style: { padding: "3px 14px", "margin-top": "4px" },
          });
        }
      }
    }

    // Step 3: Scrape status
    if (dbgTest.status === "scraping") {
      children.push({ type: "text", content: "<p style=\"font-size:var(--fs-xs)\">Navigating and extracting lyrics...</p>" });
    }

    // Step 4: Result
    if (dbgTest.status === "done" && dbgTest.scrapeResult) {
      var res = dbgTest.scrapeResult;
      if (res.text) {
        children.push({ type: "text", content: "<p style=\"font-size:var(--fs-xs);color:var(--success)\"><b>Lyrics found!</b> " + res.words + " words, score: " + Math.round(res.score) + "</p>" });
        children.push({ type: "text", content: "<pre style=\"font-size:var(--fs-2xs);max-height:400px;overflow:auto;white-space:pre-wrap;padding:8px;background:var(--bg-tertiary);border-radius:var(--ds-radius)\">" + res.text.replace(/</g, "&lt;") + "</pre>" });
      } else if (res.timeout) {
        children.push({ type: "text", content: "<p style=\"font-size:var(--fs-xs);color:var(--error)\">Timeout — no lyrics extracted within " + (SCRAPE_TIMEOUT / 1000) + "s.</p>" });
      } else {
        children.push({ type: "text", content: "<p style=\"font-size:var(--fs-xs);color:var(--error)\">No lyrics found on this page (below " + MIN_WORD_COUNT + " word threshold).</p>" });
      }
      // Allow trying another URL + domain actions
      var currentDomain = dbgTest.selectedUrl ? domainFromUrl(dbgTest.selectedUrl) : "";
      if (dbgTest.results.length > 0) {
        children.push({
          type: "layout", direction: "horizontal", style: { gap: "8px", "align-items": "center", "margin-top": "4px" },
          children: [
            { type: "button", label: "Try Another URL", action: "dbg-retry", variant: "secondary", style: { padding: "3px 14px" } },
            { type: "button", label: "Add \"" + currentDomain + "\" to Preferred", action: "dbg-add-preferred", variant: "secondary", style: { padding: "3px 10px", "font-size": "var(--fs-2xs)" } },
            { type: "button", label: "Add \"" + currentDomain + "\" to Blocked", action: "dbg-add-blacklist", variant: "secondary", style: { padding: "3px 10px", "font-size": "var(--fs-2xs)" } },
          ],
        });
      }
    }

    // Also show domain action buttons when viewing results (before scraping)
    if (dbgTest.status === "results" && dbgTest.selectedUrl) {
      var selDomain = domainFromUrl(dbgTest.selectedUrl);
      children.push({
        type: "layout", direction: "horizontal", style: { gap: "8px", "align-items": "center", "margin-top": "4px" },
        children: [
          { type: "button", label: "Add \"" + selDomain + "\" to Preferred", action: "dbg-add-preferred", variant: "secondary", style: { padding: "3px 10px", "font-size": "var(--fs-2xs)" } },
          { type: "button", label: "Add \"" + selDomain + "\" to Blocked", action: "dbg-add-blacklist", variant: "secondary", style: { padding: "3px 10px", "font-size": "var(--fs-2xs)" } },
        ],
      });
    }

    return { type: "section", title: "Step-by-Step Debugger", children: children };
  }

  api.ui.onAction("dbg-start", dbgStart);
  api.ui.onAction("dbg-stop", dbgStop);

  api.ui.onAction("dbg-devtools", function () {
    if (dbgTest.handle && dbgTest.handle.devtools) {
      dbgTest.handle.devtools().catch(console.error);
    }
  });

  api.ui.onAction("dbg-select-url", function (data) {
    if (data && data.value !== undefined) {
      dbgTest.selectedUrl = data.value;
      renderSettings();
    }
  });

  api.ui.onAction("dbg-scrape", function () {
    dbgScrapeUrl(dbgTest.selectedUrl);
  });

  api.ui.onAction("dbg-retry", function () {
    dbgTest.status = "results";
    dbgTest.scrapeResult = null;
    renderSettings();
  });

  api.ui.onAction("dbg-add-preferred", function () {
    if (!dbgTest.selectedUrl) return;
    var domain = domainFromUrl(dbgTest.selectedUrl);
    if (!domain) return;
    for (var i = 0; i < preferred.length; i++) {
      if (preferred[i].toLowerCase() === domain.toLowerCase()) {
        api.log("info", "Domain already in preferred: " + domain, "google-lyrics");
        return;
      }
    }
    preferred.push(domain);
    api.log("info", "Added to preferred: " + domain, "google-lyrics");
    saveSettings().then(renderSettings);
  });

  api.ui.onAction("dbg-add-blacklist", function () {
    if (!dbgTest.selectedUrl) return;
    var domain = domainFromUrl(dbgTest.selectedUrl);
    if (!domain) return;
    for (var i = 0; i < blacklist.length; i++) {
      if (blacklist[i].toLowerCase() === domain.toLowerCase()) {
        api.log("info", "Domain already in blacklist: " + domain, "google-lyrics");
        return;
      }
    }
    blacklist.push(domain);
    api.log("info", "Added to blacklist: " + domain, "google-lyrics");
    saveSettings().then(renderSettings);
  });

  loadSettings().then(renderSettings);

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

    return api.network.openBrowseWindow(searchUrl, {
      visible: false,
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
    scrapeHandle.close().catch(console.error);
    scrapeHandle = null;
  }

  function isPreferred(url) {
    var lower = url.toLowerCase();
    for (var i = 0; i < preferred.length; i++) {
      if (preferred[i] && lower.indexOf(preferred[i].toLowerCase()) !== -1) return true;
    }
    return false;
  }

  function filterResults(results) {
    var preferredList = [];
    var otherList = [];
    var seen = {};
    for (var i = 0; i < results.length; i++) {
      var url = results[i].split("#")[0];
      if (!url || seen[url] || isBlacklisted(url)) continue;
      seen[url] = true;
      var entry = { url: url, domain: domainFromUrl(url) };
      if (isPreferred(url)) {
        preferredList.push(entry);
      } else {
        otherList.push(entry);
      }
    }
    return preferredList.concat(otherList);
  }

  // --- Scrape & extract ---

  function fetchAndExtract(url, domain) {
    return scrapeLyrics(url).then(function (result) {
      if (!result || !result.text) {
        recordStat(domain, false);
        return null;
      }
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
